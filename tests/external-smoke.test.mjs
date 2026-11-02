import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../server.mjs';
import { AppError } from '../lib/store.mjs';
import { runExternalSmoke, smokeOptionsFromEnv } from '../scripts/external-smoke.mjs';
import { tlsProxy } from './helpers/tls-proxy.mjs';

const email = 'smoke@example.test', password = 'SmokeTestOnly123!';
const baseEnv = { SMOKE_ORIGIN: 'https://tickets.example.test', SMOKE_EMAIL: email, SMOKE_PASSWORD: password,
  SMOKE_PERFORMANCE_ID: 'performance-1', SMOKE_SEAT_ID: 'A-01', SMOKE_ALLOW_WRITE: 'demo-staging', SMOKE_NETWORK_LABEL: 'local-test' };
const order = hold => ({ holdId: hold.id, buyerName: '검증회원', buyerPhone: '01000000000', delivery: 'mobile', agreed: true, paymentMethod: 'demo' });
async function fixture(t, schema, options = {}) {
  let edge, app;
  const dir = await mkdtemp(join(tmpdir(), 'temp-external-'));
  t.after(async () => {
    await edge?.close(); await app?.shutdown(100);
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep + 'temp-external-')); await rm(dir, { recursive: true, force: true });
  });
  const token = randomBytes(32).toString('hex'); edge = await tlsProxy(dir, token);
  app = await createApp({ dbPath: join(dir, 'smoke.sqlite'), schema, demo: false, secureCookies: true,
    adminEmail: 'operator@example.test', adminPassword: 'OperatorTestOnly123!', boundaryOptions: { publicOrigin: edge.origin, proxyToken: token }, ...options });
  const user = await app.store.register({ email, password, name: '검증회원', phone: '01000000000', terms: true, ageConfirmed: true });
  const pid = app.store.concerts()[0].performances[0].id;
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); edge.setBackend(app.server.address().port);
  return { dir, app, edge, user, pid, config: { ...smokeOptionsFromEnv({ ...baseEnv, SMOKE_ORIGIN: edge.origin, SMOKE_PERFORMANCE_ID: pid }), ca: edge.cert },
    verifyReport: report => {
      const json = JSON.stringify(report);
      for (const value of [email, password, token, user.id]) assert.ok(!json.includes(value), 'report must omit credentials/identity');
      assert.equal(report.externalNetworkVerified, false); assert.equal(report.connectionScope, 'loopback');
    } };
}
test('외부 smoke 설정은 HTTPS 출처·전용 대상·계정·ID·시간 제한을 검증한다', () => {
  assert.equal(smokeOptionsFromEnv(baseEnv).timeoutMs, 10000);
  for (const change of [{ SMOKE_ORIGIN: 'http://example.test' }, { SMOKE_ORIGIN: 'https://a:b@example.test' }, { SMOKE_ORIGIN: 'https://example.test/' },
    { SMOKE_ORIGIN: 'https://example.test/path' }, { SMOKE_EMAIL: '' }, { SMOKE_PASSWORD: '' }, { SMOKE_ALLOW_WRITE: '' },
    { SMOKE_PERFORMANCE_ID: '../admin' }, { SMOKE_SEAT_ID: 'A/01' }, { SMOKE_NETWORK_LABEL: 'private@email.test' },
    { SMOKE_TIMEOUT_MS: '30001' }, { SMOKE_WAIT_MS: '0' }]) assert.throws(() => smokeOptionsFromEnv({ ...baseEnv, ...change }));
});
for (const schema of ['legacy', 'model']) {
  test(`[${schema}] 전용 회원의 HTTPS smoke가 취소 이력·좌석/세션 정리와 비밀값 없는 결과를 남긴다`, async t => {
    const f = await fixture(t, schema), report = await runExternalSmoke(f.config);
    assert.equal(report.passed, true, JSON.stringify(report)); assert.equal(report.tlsTrust, 'custom-ca'); f.verifyReport(report);
    assert.equal(report.steps.length, 11); assert.ok(report.cleanup.every(row => row.passed));
    assert.equal(f.app.store.bookings(f.user.id).length, 1); assert.equal(f.app.store.bookings(f.user.id)[0].status, 'cancelled');
    assert.equal(f.app.store.liveHolds(f.user.id, f.pid).length, 0);
    assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?', f.user.id).n, 0);
    assert.equal(f.app.store.seatMap(f.pid, f.user.id).seats.find(s => s.id === 'A-01').state, 'available');
    for (const booking of f.app.store.bookings(f.user.id)) { assert.ok(!JSON.stringify(report).includes(booking.id)); assert.ok(!JSON.stringify(report).includes(booking.hold_id)); }
  });
  test(`[${schema}] 기존 선점·확정 예매가 있으면 보존하고 쓰기 전 중단한다`, async t => {
    const f = await fixture(t, schema), store = f.app.store;
    const first = store.setHold(f.user.id, f.pid, ['A-02']).hold;
    let report = await runExternalSmoke(f.config);
    assert.equal(report.failure.code, 'EXISTING_HOLD_REFUSED'); assert.equal(store.liveHolds(f.user.id, f.pid)[0].id, first.id);
    const booking = store.checkout(f.user.id, order(first));
    report = await runExternalSmoke(f.config);
    assert.equal(report.failure.code, 'EXISTING_BOOKING_REFUSED'); assert.equal(store.bookings(f.user.id)[0].id, booking.id); assert.equal(store.bookings(f.user.id)[0].status, 'confirmed');
    assert.ok(!report.cleanup.some(r => r.name === 'owned-booking' || r.name === 'owned-hold'));
  });
  test(`[${schema}] 기존 큐·차단 좌석도 쓰기 전에 거부하고 다른 상태를 변경하지 않는다`, async t => {
    const f = await fixture(t, schema);
    f.app.queue.enter(f.pid, f.user.id, { sessionKey: 'preexisting' });
    let report = await runExternalSmoke(f.config); assert.equal(report.failure.code, 'EXISTING_QUEUE_REFUSED');
    assert.equal(f.app.queue.status(f.pid, f.user.id, { sessionKey: 'preexisting' }).state, 'admitted');
    f.app.queue.leave(f.pid, f.user.id);
    const operator = f.app.store.get("SELECT id FROM users WHERE role='admin'").id;
    f.app.store.blockSeats(operator, f.pid, ['A-01'], true);
    report = await runExternalSmoke(f.config); assert.equal(report.failure.code, 'SEAT_NOT_AVAILABLE');
    assert.equal(f.app.store.seatMap(f.pid, f.user.id).seats.find(s => s.id === 'A-01').state, 'blocked');
  });
  test(`[${schema}] 선점 후 확정 실패는 알고 있는 본인 선점만 해제한다`, async t => {
    const f = await fixture(t, schema);
    f.app.store.checkout = () => { throw new AppError(409, 'private server detail'); };
    const report = await runExternalSmoke(f.config); assert.equal(report.failure.stage, 'checkout'); assert.equal(report.failure.status, 409); f.verifyReport(report);
    assert.equal(f.app.store.liveHolds(f.user.id, f.pid).length, 0); assert.equal(f.app.store.bookings(f.user.id).length, 0);
    assert.ok(report.cleanup.every(r => r.passed)); assert.ok(!JSON.stringify(report).includes('private server detail'));
  });
  test(`[${schema}] 커밋 뒤 오류 응답은 hold ID로 본인 새 예매를 찾아 취소한다`, async t => {
    const f = await fixture(t, schema), original = f.app.store.checkout.bind(f.app.store);
    f.app.store.checkout = (...args) => { original(...args); throw new AppError(503, 'private checkout detail'); };
    const report = await runExternalSmoke(f.config); assert.equal(report.failure.stage, 'checkout'); assert.equal(report.failure.status, 503);
    assert.equal(f.app.store.bookings(f.user.id).length, 1); assert.equal(f.app.store.bookings(f.user.id)[0].status, 'cancelled');
    assert.ok(report.cleanup.every(r => r.passed)); f.verifyReport(report);
  });
  test(`[${schema}] 취소 응답 오류는 정리에서 같은 본인 예매만 재확인/취소한다`, async t => {
    const f = await fixture(t, schema), original = f.app.store.cancel.bind(f.app.store); let first = true;
    f.app.store.cancel = (...args) => { if (first) { first = false; throw new AppError(503, 'retry cleanup'); } return original(...args); };
    const report = await runExternalSmoke(f.config); assert.equal(report.failure.stage, 'cancel'); assert.equal(report.manualReviewRequired, undefined);
    assert.equal(f.app.store.bookings(f.user.id)[0].status, 'cancelled'); assert.ok(report.cleanup.every(r => r.passed));
  });
  test(`[${schema}] 큐 대기는 기한 뒤 중단하고 본인 새 큐/세션만 정리한다`, async t => {
    const f = await fixture(t, schema, { queueOptions: { activeLimit: 1, admitPerSecond: 100 } });
    f.app.queue.enter(f.pid, 'another-member', { sessionKey: 'other' });
    const report = await runExternalSmoke({ ...f.config, waitMs: 40, pollMs: 10 }); assert.equal(report.failure.code, 'QUEUE_WAIT_TIMEOUT');
    assert.equal(f.app.store.bookings(f.user.id).length, 0); assert.ok(report.cleanup.every(r => r.passed));
    assert.equal(f.app.queue.status(f.pid, 'another-member', { sessionKey: 'other' }).state, 'admitted');
  });
  test(`[${schema}] 선점 응답 유실로 ID를 모르면 임의 해제하지 않고 수동 확인을 표시한다`, async t => {
    const f = await fixture(t, schema), original = f.app.store.setHold.bind(f.app.store);
    f.app.store.setHold = (...args) => { const result = original(...args); if (args[2].length) throw new AppError(503, 'lost hold response'); return result; };
    const report = await runExternalSmoke(f.config); assert.equal(report.failure.stage, 'hold'); assert.equal(report.manualReviewRequired, true);
    assert.equal(f.app.store.liveHolds(f.user.id, f.pid).length, 1);
    assert.deepEqual(report.cleanup.find(row => row.name === 'owned-hold'), { name: 'owned-hold', passed: false }); f.verifyReport(report);
  });
  test(`[${schema}] 취소가 계속 실패하면 확정 이력을 남기고 수동 확인을 표시한다`, async t => {
    const f = await fixture(t, schema); f.app.store.cancel = () => { throw new AppError(503, 'private cancel detail'); };
    const report = await runExternalSmoke(f.config); assert.equal(report.failure.stage, 'cancel'); assert.equal(report.manualReviewRequired, true);
    assert.equal(f.app.store.bookings(f.user.id)[0].status, 'confirmed');
    assert.deepEqual(report.cleanup.find(row => row.name === 'owned-booking'), { name: 'owned-booking', passed: false }); f.verifyReport(report);
  });
}
test('관리자 계정은 로그인 직후 중단하고 새 세션만 종료한다', async t => {
  const f = await fixture(t, 'model');
  const report = await runExternalSmoke({ ...f.config, email: 'operator@example.test', password: 'OperatorTestOnly123!' });
  assert.equal(report.failure.code, 'DEDICATED_MEMBER_REQUIRED'); assert.deepEqual(report.cleanup, [{ name: 'logout', passed: true }]);
  assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM bookings').n, 0);
});
test('신뢰하지 않는 인증서는 자격증명 전송 전에 거부한다', async t => {
  const f = await fixture(t, 'model'); const report = await runExternalSmoke({ ...f.config, ca: undefined });
  assert.equal(report.passed, false); assert.equal(report.failure.stage, 'health'); assert.equal(report.failure.code, 'NETWORK_OR_TLS_FAILED'); assert.equal(report.cleanup.length, 0);
  assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM sessions').n, 0);
});
test('쿠키를 받았지만 CSRF가 없으면 세션 정리를 완료했다고 표시하지 않는다', async t => {
  const f = await fixture(t, 'model'), original = f.app.store.createSession.bind(f.app.store);
  f.app.store.createSession = (...args) => ({ ...original(...args), csrf: '' });
  const report = await runExternalSmoke(f.config);
  assert.equal(report.failure.code, 'INVALID_SESSION_COOKIE'); assert.equal(report.manualReviewRequired, true);
  assert.deepEqual(report.cleanup, [{ name: 'logout', passed: false }]);
  assert.equal(f.app.store.bookings(f.user.id).length, 0); f.verifyReport(report);
});
test('리다이렉트와 과대 응답은 따라가지 않고 비밀값 없이 실패한다', async t => {
  const f = await fixture(t, 'model'); f.edge.server.removeAllListeners('request'); let calls = 0;
  f.edge.server.on('request', (_req, res) => { calls++; res.writeHead(302, { Location: 'https://elsewhere.invalid/private' }); res.end(); });
  let report = await runExternalSmoke(f.config); assert.equal(report.failure.code, 'REDIRECT_REFUSED'); assert.equal(calls, 1); assert.ok(!JSON.stringify(report).includes('elsewhere'));
  f.edge.server.removeAllListeners('request');
  f.edge.server.on('request', (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('x'.repeat(1024 * 1024 + 1)); });
  report = await runExternalSmoke(f.config); assert.equal(report.passed, false); assert.equal(report.failure.stage, 'health'); assert.equal(report.cleanup.length, 0);
});
test('CLI는 환경 파일로 실행해 redacted JSON과 종료코드 0을 제공한다', async t => {
  const f = await fixture(t, 'model'), envPath = join(f.dir, 'smoke.env'), caPath = join(f.dir, 'ca.pem');
  await writeFile(caPath, f.edge.cert);
  const env = { ...baseEnv, SMOKE_ORIGIN: f.edge.origin, SMOKE_PERFORMANCE_ID: f.pid, SMOKE_CA_FILE: caPath.replaceAll('\\', '/') };
  await writeFile(envPath, Object.entries(env).map(([key, value]) => `${key}="${value}"`).join('\n'));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SMOKE_')));
  const result = await promisify(execFile)(process.execPath, [`--env-file=${envPath}`, 'scripts/external-smoke.mjs'], { env: inherited, windowsHide: true, timeout: 10000 });
  const report = JSON.parse(result.stdout); assert.equal(report.passed, true); assert.equal(report.externalNetworkVerified, false); f.verifyReport(report);
});
