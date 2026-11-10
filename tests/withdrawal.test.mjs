import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createApp } from '../server.mjs';
import { Store, WITHDRAWN_PASSWORD_HASH } from '../lib/store.mjs';
import { ModelStore } from '../lib/model-store.mjs';
import { validateModel } from '../db/model.mjs';
import { currentSpec, validateResponse } from '../scripts/check-api.mjs';

const password = 'WithdrawalOnly123!';
const body = { password, confirmed: true };
const email = 'withdrawal@example.test';
const operation = currentSpec.paths['/api/auth/account'].delete;
const checkout = hold => ({ holdId: hold.id, buyerName: '탈퇴검증회원', buyerPhone: '01098765432', delivery: 'mobile', paymentMethod: 'demo', agreed: true });

async function fixture(t, schema) {
  let now = 1800000000000;
  const app = await createApp({ dbPath: ':memory:', schema, now: () => now, secureCookies: true,
    queueOptions: { activeLimit: 1, admitPerSecond: 1000 } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.shutdown(100));
  const identity = id => {
    const s = app.store.createSession(id);
    return { cookie: `ticket_ssu_session=${s.token}`, 'x-csrf-token': s.csrf };
  };
  const user = await app.store.register({ email, name: '탈퇴검증회원', phone: '01098765432', password, terms: true, ageConfirmed: true });
  const auth = identity(user.id);
  const pids = app.store.concerts().flatMap(c => c.performances.map(p => p.id));
  const send = async (method, path, headers = {}, data) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {
      method, headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    const result = { status: response.status, data: await response.json(), headers: response.headers };
    if (path === '/api/auth/account') validateResponse(currentSpec, operation, result.status, result.data);
    return result;
  };
  return { app, user, auth, pids, identity, send, advance: time => { now = time; },
    withdraw: (data = body, headers = auth) => send('DELETE', '/api/auth/account', headers, data),
    verify: () => { assert.deepEqual(app.store.all('PRAGMA foreign_key_check'), []); if (schema === 'model') validateModel(app.store.db); } };
}

for (const schema of ['legacy', 'model']) {
  test(`[${schema}] 탈퇴는 세션·출처·CSRF·현재 암호·명시적 동의를 검사하고 관리자를 보호한다`, async t => {
    const f = await fixture(t, schema), before = f.app.store.get('SELECT * FROM users WHERE id=?', f.user.id);
    assert.equal((await f.withdraw(body, {})).status, 401);
    assert.equal((await f.withdraw(body, { ...f.auth, 'x-csrf-token': 'invalid' })).status, 403);
    assert.equal((await f.withdraw(body, { ...f.auth, Origin: 'https://wrong.example' })).status, 403);
    for (const invalid of [{ password }, { password, confirmed: 'true' }, { ...body, userId: 'someone-else' }, { password: '', confirmed: true }]) {
      assert.equal((await f.withdraw(invalid)).status, 400);
    }
    assert.equal((await f.withdraw({ ...body, password: 'IncorrectPassword123!' })).status, 401);
    const admin = f.app.store.get("SELECT id FROM users WHERE role='admin'");
    assert.equal((await f.withdraw({ password: 'TicketSsuAdmin123!', confirmed: true }, f.identity(admin.id))).status, 403);
    assert.deepEqual(f.app.store.get('SELECT * FROM users WHERE id=?', f.user.id), before);
    assert.ok(f.app.store.session(f.auth.cookie.split('=')[1])); f.verify();
  });

  test(`[${schema}] 탈퇴는 모든 회차의 선점·대기·세션을 해제하고 다른 회원과 재가입을 분리한다`, async t => {
    const f = await fixture(t, schema), store = f.app.store;
    const secondSession = f.identity(f.user.id);
    const other = store.get("SELECT * FROM users WHERE email='demo@ticket-ssu.local'");
    const queuePath = pid => `/api/v1/performances/${pid}/queue`;
    for (const pid of f.pids.slice(0, 2)) {
      const entry = await f.send('POST', queuePath(pid), f.auth, {});
      assert.equal(entry.status, 200);
      assert.equal((await f.send('PUT', `/api/performances/${pid}/hold`, { ...f.auth, 'x-admission-token': entry.data.admission_token }, { seatIds: ['A-01'] })).status, 200);
    }
    assert.equal((await f.send('POST', queuePath(f.pids[2]), f.identity(other.id), {})).data.state, 'admitted');
    assert.equal((await f.send('POST', queuePath(f.pids[2]), f.auth, {})).data.state, 'waiting');
    assert.equal(f.app.queue.stats().entries, 4);
    const usersBefore = store.adminSummary(store.get("SELECT id FROM users WHERE role='admin'").id).users;
    const result = await f.withdraw();
    assert.equal(result.status, 200); assert.deepEqual(result.data, { ok: true });
    assert.match(result.headers.get('set-cookie'), /Max-Age=0; Secure/);
    assert.equal(f.app.queue.stats().entries, 1);
    assert.equal(store.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?', f.user.id).n, 0);
    assert.equal(store.liveHolds(f.user.id).length, 0);
    for (const pid of f.pids.slice(0, 2)) assert.equal(store.seatMap(pid).seats.find(s => s.id === 'A-01').state, 'available');
    for (const auth of [f.auth, secondSession]) assert.equal((await f.send('GET', '/api/bookings', auth)).status, 401);
    assert.throws(() => store.createSession(f.user.id), e => e.status === 401);
    assert.equal((await f.send('POST', '/api/auth/login', {}, { email, password })).status, 401);
    const erased = store.get('SELECT * FROM users WHERE id=?', f.user.id);
    assert.equal(erased.name, '탈퇴회원'); assert.equal(erased.phone, '01000000000'); assert.equal(erased.password_hash, WITHDRAWN_PASSWORD_HASH);
    assert.notEqual(erased.email, email);
    assert.deepEqual(store.get('SELECT * FROM users WHERE id=?', other.id), other);
    assert.equal(store.adminSummary(store.get("SELECT id FROM users WHERE role='admin'").id).users, usersBefore - 1);
    const rejoined = await f.send('POST', '/api/auth/signup', {}, { email, name: '재가입회원', phone: '01000000000', password, terms: true, ageConfirmed: true });
    assert.equal(rejoined.status, 201); assert.notEqual(rejoined.data.user.id, f.user.id);
    assert.deepEqual(store.bookings(rejoined.data.user.id), []); f.verify();
  });

  test(`[${schema}] 미래 확정 예매는 탈퇴를 막고 취소 후 예매·결제 이력을 보존하며 예매자만 비식별화한다`, async t => {
    const f = await fixture(t, schema), store = f.app.store;
    const booked = store.checkout(f.user.id, checkout(store.setHold(f.user.id, f.pids[0], ['A-01']).hold));
    const otherId = store.get("SELECT id FROM users WHERE email='demo@ticket-ssu.local'").id;
    const other = store.checkout(otherId, checkout(store.setHold(otherId, f.pids[0], ['A-02']).hold));
    const hold = store.setHold(f.user.id, f.pids[1], ['A-03']).hold;
    const snapshot = store.get('SELECT * FROM users WHERE id=?', f.user.id);
    assert.equal((await f.withdraw()).status, 409);
    assert.deepEqual(store.get('SELECT * FROM users WHERE id=?', f.user.id), snapshot);
    assert.equal(store.liveHolds(f.user.id)[0].id, hold.id);
    assert.equal(store.bookings(f.user.id)[0].status, 'confirmed');
    assert.equal((await f.send('POST', `/api/bookings/${booked.id}/cancel`, f.auth)).status, 200);
    const previous = store.bookings(f.user.id)[0];
    const payments = schema === 'model' ? store.all('SELECT * FROM payment_attempts ORDER BY id') : null;
    const items = store.all(schema === 'model' ? 'SELECT * FROM booking_items ORDER BY booking_id' : 'SELECT * FROM booking_seats ORDER BY booking_id');
    if (schema === 'model') assert.throws(() => store.run("UPDATE bookings SET buyer_name='임의수정' WHERE id=?", booked.id));
    assert.equal((await f.withdraw()).status, 200);
    assert.deepEqual(store.bookings(f.user.id)[0], { ...previous, buyer_name: '탈퇴회원', buyer_phone: '01000000000' });
    assert.deepEqual(store.bookings(otherId)[0], other);
    assert.deepEqual(store.all(schema === 'model' ? 'SELECT * FROM booking_items ORDER BY booking_id' : 'SELECT * FROM booking_seats ORDER BY booking_id'), items);
    if (schema === 'model') {
      assert.deepEqual(store.all('SELECT * FROM payment_attempts ORDER BY id'), payments);
      assert.throws(() => store.run("UPDATE bookings SET buyer_name='임의수정' WHERE id=?", booked.id));
      assert.throws(() => store.run('UPDATE bookings SET fee=4000 WHERE id=?', booked.id));
    }
    f.verify();
  });

  test(`[${schema}] 이미 시작한 공연의 확정 이력은 탈퇴 후에도 판매·좌석·금액을 보존한다`, async t => {
    const f = await fixture(t, schema), store = f.app.store;
    const booked = store.checkout(f.user.id, checkout(store.setHold(f.user.id, f.pids[0], ['A-01']).hold));
    f.advance(booked.starts_at);
    Object.assign(f.auth, f.identity(f.user.id));
    assert.equal((await f.withdraw()).status, 200);
    const retained = store.bookings(f.user.id)[0];
    assert.equal(retained.status, 'confirmed'); assert.equal(retained.total, booked.total);
    assert.equal(retained.buyer_name, '탈퇴회원');
    assert.equal(store.seatMap(f.pids[0]).seats.find(s => s.id === 'A-01').state, 'booked'); f.verify();
  });

  test(`[${schema}] 비식별화 도중 DB 오류는 회원·예매·선점·세션 전체를 롤백한다`, async t => {
    const f = await fixture(t, schema), store = f.app.store;
    const booked = store.checkout(f.user.id, checkout(store.setHold(f.user.id, f.pids[0], ['A-01']).hold));
    store.cancel(f.user.id, booked.id);
    const hold = store.setHold(f.user.id, f.pids[1], ['A-03']).hold;
    const before = store.get('SELECT * FROM users WHERE id=?', f.user.id), history = store.bookings(f.user.id);
    store.db.exec("CREATE TRIGGER withdrawal_failure BEFORE UPDATE OF buyer_name ON bookings BEGIN SELECT RAISE(ABORT,'injected withdrawal failure'); END");
    assert.throws(() => store.withdrawAccount(f.user.id, before.password_hash), /injected withdrawal failure/);
    assert.deepEqual(store.get('SELECT * FROM users WHERE id=?', f.user.id), before);
    assert.deepEqual(store.bookings(f.user.id), history);
    assert.equal(store.liveHolds(f.user.id)[0].id, hold.id);
    assert.ok(store.session(f.auth.cookie.split('=')[1])); f.verify();
  });

  test(`[${schema}] 탈퇴와 겹친 비동기 로그인은 세션을 되살리지 않는다`, async t => {
    const f = await fixture(t, schema);
    let notify, resume;
    const entered = new Promise(ok => { notify = ok; }), gate = new Promise(ok => { resume = ok; });
    const authenticate = f.app.store.authenticate.bind(f.app.store);
    f.app.store.authenticate = async (...args) => { const result = await authenticate(...args); notify(); await gate; return result; };
    const login = f.send('POST', '/api/auth/login', {}, { email, password });
    try { await entered; assert.equal((await f.withdraw()).status, 200); } finally { resume(); }
    assert.equal((await login).status, 401);
    assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?', f.user.id).n, 0); f.verify();
  });
}

test('기존 model v1 파일은 기능용 DDL만 적용하고 예매·탈퇴 상태를 재시작에도 유지한다', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ticket-ssu-withdrawal-')), file = join(directory, 'fixture.sqlite');
  let store;
  t.after(async () => {
    if (store?.db.isOpen) store.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'ticket-ssu-withdrawal-'));
    await rm(directory, { recursive: true });
  });
  store = new ModelStore(file); await store.seed();
  const user = await store.register({ email, name: '탈퇴검증회원', phone: '01098765432', password, terms: true, ageConfirmed: true });
  const pid = store.concerts()[0].performances[0].id;
  const booked = store.checkout(user.id, checkout(store.setHold(user.id, pid, ['A-01']).hold));
  const cancelled = store.cancel(user.id, booked.id);
  const original = (await readFile(new URL('../db/migrations/001_guards.sql', import.meta.url), 'utf8')).match(/CREATE TRIGGER booking_immutable[\s\S]*?END;/)[0];
  store.db.exec(`DROP TRIGGER booking_immutable; DROP TABLE admin_booking_cancellations; DROP TABLE member_booking_restrictions;
    DROP TABLE performance_cancelled_bookings; DROP TABLE performance_sales_events`);
  store.db.exec(original); store.close();
  store = new ModelStore(file);
  assert.deepEqual(store.bookings(user.id)[0], cancelled);
  assert.equal(store.get('PRAGMA user_version').user_version, 1);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM admin_booking_cancellations').n, 0);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM member_booking_restrictions').n, 0);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM performance_sales_events').n, 0);
  store.withdrawAccount(user.id, await store.verifyWithdrawal(user.id, body)); store.close();
  store = new ModelStore(file);
  assert.equal(store.bookings(user.id)[0].buyer_name, '탈퇴회원');
  await assert.rejects(store.authenticate(email, password), e => e.status === 401);
  validateModel(store.db);
});
