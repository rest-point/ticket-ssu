import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createApp } from '../../server.mjs';
import { buildCollection, checkCollection } from '../build.mjs';
import { runIsolatedPostman, runPostmanCollection } from '../../scripts/postman.mjs';

const environment = values => ({ values: Object.entries(values).map(([key, value]) => ({ key, value, enabled: true })) });
const guardValues = { baseUrl: 'http://127.0.0.1:3100', mode: 'local', allowWrite: 'dedicated-demo', memberEmail: 'fixture@example.test',
  memberPassword: 'FixtureOnly123!', performanceId: 'fixture-performance', seatId: 'A-01' };
function smokeCollection() { const c = buildCollection(); c.item = [c.item[0]]; return c; }
async function fixture(t, { specialPassword = false } = {}) {
  const nonce = randomBytes(5).toString('hex'), email = `fixture-${nonce}@example.test`;
  const password = specialPassword ? 'Fixture"Quote\\Slash+유니코드123!' : randomBytes(24).toString('base64url');
  const app = await createApp({ dbPath: ':memory:', schema: 'model', demo: false, secureCookies: false,
    adminEmail: `operator-${nonce}@example.test`, adminPassword: randomBytes(24).toString('base64url'), boundaryOptions: {},
    queueOptions: { admitPerSecond: 1000 }, limitOptions: { ipBurst: 120 } });
  t.after(() => app.shutdown(100));
  const member = await app.store.register({ email, password, name: '가상회원', phone: '01000000000', terms: true, ageConfirmed: true });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const pid = app.store.concerts()[0].performances[0].id;
  return { app, member, pid, password, email, env: environment({ ...guardValues, baseUrl: `http://127.0.0.1:${app.server.address().port}`,
    memberEmail: email, memberPassword: password, performanceId: pid }) };
}

test('Postman 산출물은 현재 OpenAPI18개와 생성 원본에 일치한다', async () => {
  assert.deepEqual(await checkCollection(), { currentOperations: 18, requests: 37, status: 'passed' });
});
for (const schema of ['legacy', 'model']) {
  test(`[${schema}] 실제 Newman 전체37요청·131assertion·18작업과 임시 DB 정리`, async t => {
    const report = await runIsolatedPostman(schema);
    assert.equal(report.passed, true, JSON.stringify(report));
    assert.equal(report.requests, 37); assert.equal(report.assertions, 131); assert.equal(report.currentOperationsCovered, 18);
    assert.equal(report.confirmedBookings, 0); assert.equal(report.activeHolds, 0); assert.equal(report.sessions, 0); assert.equal(report.cleanupPassed, true);
    t.diagnostic(`Newman ${schema}: requests=${report.requests}; assertions=${report.assertions}; operations=${report.currentOperationsCovered}`);
  });
}
test('명시한 동의/대상 설정이 없거나 HTTP 원격이면 요청 전 중단한다', async () => {
  for (const change of [{ allowWrite: '' }, { mode: 'staging', baseUrl: 'http://unwanted.example.invalid' },
    { baseUrl: 'http://127.0.0.1:99999' }, { performanceId: '../other' }]) {
    const report = await runPostmanCollection({ collection: smokeCollection(), environment: environment({ ...guardValues, ...change }) });
    assert.equal(report.passed, false); assert.equal(report.requests, 0); assert.ok(report.failures.length > 0);
  }
});
test('staging에서 local 관리자 폴더를 선택하면 네트워크 요청을 보내지 않는다', async () => {
  const c = buildCollection(); c.item = [c.item[1]];
  const report = await runPostmanCollection({ collection: c, environment: environment({ ...guardValues, mode: 'staging', baseUrl: 'https://unwanted.example.invalid' }) });
  assert.equal(report.requests, 0); assert.equal(report.passed, false);
});
test('기존 선점은 사전 중단하고 만료·ID·좌석을 보존한다', async t => {
  const f = await fixture(t), hold = f.app.store.setHold(f.member.id, f.pid, ['A-01']).hold;
  const report = await runPostmanCollection({ collection: smokeCollection(), environment: f.env });
  assert.equal(report.passed, false); assert.equal(report.executions.at(-1).name, '12 seat preflight');
  assert.equal(f.app.store.liveHolds(f.member.id, f.pid)[0].id, hold.id);
  assert.equal(f.app.store.liveHolds(f.member.id, f.pid)[0].expires_at, hold.expires_at);
  assert.equal(f.app.store.bookings(f.member.id).length, 0);
});
test('기존 확정 예매는 사전 중단하고 취소/삭제하지 않는다', async t => {
  const f = await fixture(t), hold = f.app.store.setHold(f.member.id, f.pid, ['A-02']).hold;
  const booked = f.app.store.checkout(f.member.id, { holdId: hold.id, buyerName: '가상회원', buyerPhone: '01000000000', delivery: 'mobile', agreed: true, paymentMethod: 'demo' });
  const report = await runPostmanCollection({ collection: smokeCollection(), environment: f.env });
  assert.equal(report.passed, false); assert.equal(report.executions.at(-1).name, '13 booking preflight');
  assert.equal(f.app.store.bookings(f.member.id)[0].id, booked.id); assert.equal(f.app.store.bookings(f.member.id)[0].status, 'confirmed');
});
test('응답 스키마 오류 뒤에는 선점/확정 쓰기를 진행하지 않는다', async t => {
  const f = await fixture(t), original = f.app.store.seatMap.bind(f.app.store);
  f.app.store.seatMap = (...args) => { const map = original(...args); map.seats[0].price = -1; return map; };
  const report = await runPostmanCollection({ collection: smokeCollection(), environment: f.env });
  assert.equal(report.passed, false); assert.ok(report.failures.some(row => row.assertion === 'OpenAPI response schema'));
  assert.equal(f.app.store.liveHolds(f.member.id, f.pid).length, 0); assert.equal(f.app.store.bookings(f.member.id).length, 0);
});
test('기존 큐 항목은 재진입/이탈하지 않고 선점 전에 중단한다', async t => {
  const f = await fixture(t), options = { sessionKey: 'preexisting-fixture-session' };
  const before = f.app.queue.enter(f.pid, f.member.id, options);
  const report = await runPostmanCollection({ collection: smokeCollection(), environment: f.env });
  assert.equal(report.passed, false); assert.equal(report.executions.at(-1).name, '14 queue preflight');
  const after = f.app.queue.status(f.pid, f.member.id, options);
  assert.equal(after.state, before.state); assert.equal(after.admission_token, before.admission_token);
  assert.equal(f.app.store.liveHolds(f.member.id, f.pid).length, 0);
});
test('특수문자 암호를 JSON으로 직렬화하고 Cookie Jar를 유지하며 보고서를 정제한다', async t => {
  const f = await fixture(t, { specialPassword: true }), c = smokeCollection(); c.item[0].item = c.item[0].item.slice(0, 8);
  const report = await runPostmanCollection({ collection: c, environment: f.env });
  assert.equal(report.passed, true, JSON.stringify(report)); assert.equal(report.executions.at(-1).status, 200);
  for (const secret of [f.email, f.password, f.member.id]) assert.ok(!JSON.stringify(report).includes(secret));
});
