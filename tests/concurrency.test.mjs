import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import { request } from 'node:http';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { validateModel } from '../db/model.mjs';
import { isDatabaseBusy, retryDatabase } from '../lib/db-retry.mjs';
import { validateResponse, currentSpec } from '../scripts/check-api.mjs';
import { admissionHeaders } from './helpers/admission.mjs';

const initialTime = 1800000000000;
const workers = new WeakMap();
const order = hold => ({ holdId: hold.id, buyerName: '가상예매자', buyerPhone: '01012345678', delivery: 'mobile', paymentMethod: 'demo', agreed: true });
async function fixture(t, schema) {
  workers.set(t, new Set());
  const dir = await mkdtemp(join(tmpdir(), 'temp-concurrency-'));
  const path = join(dir, 'test.sqlite');
  let now = initialTime, app;
  const start = async () => {
    app = await createApp({ dbPath: path, schema, now: () => now, queueOptions: { admitPerSecond: 1000 } });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    return app;
  };
  const stop = async () => {
    if (!app) return;
    if (app.server.listening) await new Promise((ok, fail) => app.server.close(e => e ? fail(e) : ok()));
    else if (app.store.db.isOpen) await new Promise(ok => app.server.close(ok));
  };
  t.after(async () => {
    for (const worker of workers.get(t)) if (worker.threadId !== -1) await worker.terminate();
    await stop();
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep + 'temp-concurrency-'));
    await rm(dir, { recursive: true });
  });
  await start();
  const users = ['demo@temp.local', 'admin@temp.local'].map(email => {
    const user = app.store.get('SELECT id FROM users WHERE email=?', email);
    const session = app.store.createSession(user.id);
    return { id: user.id, cookie: `temp_session=${session.token}`, csrf: session.csrf };
  });
  const api = async (method, url, user, body, extra = {}) => {
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const headers = await admissionHeaders(app.store, base, { ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(user ? { cookie: user.cookie, 'x-csrf-token': user.csrf } : {}), ...extra }, method, url, body);
    const response = await fetch(base + url, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000)
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const pid = app.store.concerts()[0].performances[0].id;
  for (const user of users) await api('POST', `/api/v1/performances/${pid}/queue`, user, {});
  return { get app() { return app; }, users, pid, path, api, stop, start,
    time: value => { now = value; },
    verify: () => {
      assert.equal(app.store.db.isTransaction, false);
      assert.deepEqual(app.store.all('PRAGMA foreign_key_check'), []);
      assert.equal(app.store.get('PRAGMA integrity_check').integrity_check, 'ok');
      if (schema === 'model') validateModel(app.store.db);
    } };
}
async function lock(t, path) {
  const worker = new Worker(new URL('./helpers/sqlite-lock-worker.mjs', import.meta.url), { workerData: { path } });
  workers.get(t).add(worker);
  const exited = once(worker, 'exit');
  t.after(async () => { if (worker.threadId !== -1) await worker.terminate(); });
  assert.deepEqual(await once(worker, 'message'), ['locked']);
  return async () => {
    const released = once(worker, 'message');
    worker.postMessage('release');
    assert.deepEqual(await released, ['released']);
    await exited;
  };
}
function countBusy(store) {
  const original = store.transaction;
  let n = 0, notify;
  const first = new Promise(ok => { notify = ok; });
  store.transaction = function (action) {
    try { return original.call(this, action); }
    catch (error) { if (isDatabaseBusy(error)) { n++; notify(); } throw error; }
  };
  return { first, get n() { return n; }, restore: () => { store.transaction = original; } };
}

for (const schema of ['legacy', 'model']) {
  test(`[${schema}] 별도 세션의 묶음 좌석 경합은 한 명만 성공하고 패자의 기존 선점을 보존한다`, async t => {
    const f = await fixture(t, schema), { store } = f.app;
    const original = f.users.map((u, i) => store.setHold(u.id, f.pid, [`B-0${i + 1}`]).hold);
    const responses = await Promise.all(f.users.map(u => f.api('PUT', `/api/performances/${f.pid}/hold`, u, { seatIds: ['A-01', 'A-02'] })));
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
    const loser = responses.findIndex(r => r.status === 409), winner = 1 - loser;
    assert.equal(store.seatMap(f.pid, f.users[loser].id).hold.id, original[loser].id);
    const checkout = order(responses[winner].body.hold);
    const duplicates = await Promise.all(Array.from({ length: 8 }, () => f.api('POST', '/api/bookings', f.users[winner], checkout)));
    assert.ok(duplicates.every(r => r.status === 201));
    assert.equal(new Set(duplicates.map(r => r.body.booking.id)).size, 1);
    assert.equal(store.get('SELECT COUNT(*) AS n FROM bookings').n, 1);
    assert.equal(duplicates[0].body.booking.seats.length, 2);
    if (schema === 'legacy') assert.equal((await f.api('POST', '/api/bookings', f.users[winner], checkout, { 'Idempotency-Key': 'unsupported-key' })).status, 400);
    // Competing full replacements by the same member cannot accumulate 8 seats.
    const replacements = await Promise.all(['C', 'D'].map(row => f.api('PUT', `/api/performances/${f.pid}/hold`, f.users[loser], { seatIds: [1, 2, 3, 4].map(i => `${row}-0${i}`) })));
    assert.ok(replacements.every(r => r.status === 200));
    const map = store.seatMap(f.pid, f.users[loser].id);
    assert.equal(map.seats.filter(s => s.state === 'selected').length, 4);
    assert.equal(store.get("SELECT COUNT(*) AS n FROM holds WHERE user_id=? AND performance_id=? AND status='active'", f.users[loser].id, f.pid).n, 1);
    f.verify();
  });

  test(`[${schema}] 반복 취소와 재판매 경합에서 이력은 남고 새 점유는 하나다`, async t => {
    const f = await fixture(t, schema), { store } = f.app, [a, b] = f.users;
    const hold = store.setHold(a.id, f.pid, ['A-01', 'A-02']).hold;
    const booking = store.checkout(a.id, order(hold));
    const results = await Promise.all([
      ...Array.from({ length: 6 }, () => f.api('POST', `/api/bookings/${booking.id}/cancel`, a)),
      f.api('PUT', `/api/performances/${f.pid}/hold`, b, { seatIds: ['A-01', 'A-02'] })
    ]);
    assert.ok(results.slice(0, 6).every(r => r.status === 200 && r.body.booking.status === 'cancelled'));
    assert.ok([200, 409].includes(results[6].status));
    const resale = await f.api('PUT', `/api/performances/${f.pid}/hold`, b, { seatIds: ['A-01', 'A-02'] });
    assert.equal(resale.status, 200);
    const confirmed = await f.api('POST', '/api/bookings', b, order(resale.body.hold));
    assert.equal(confirmed.status, 201);
    assert.notEqual(confirmed.body.booking.id, booking.id);
    assert.equal(store.booking(booking.id, a.id).seats.length, 2);
    assert.equal(store.booking(booking.id, a.id).status, 'cancelled');
    f.verify();
  });

  test(`[${schema}] 실제 writer 잠금은 제한된 재시도 후 503/Retry-After이며 읽기 요청은 대기 중 진행된다`, async t => {
    const f = await fixture(t, schema), { store } = f.app, [a] = f.users;
    assert.equal(store.get('PRAGMA journal_mode').journal_mode, 'wal');
    assert.equal(store.get('PRAGMA busy_timeout').timeout, 25);
    const release = await lock(t, f.path), busy = countBusy(store);
    t.after(busy.restore);
    const started = performance.now();
    let completed = false;
    const blocked = f.api('PUT', `/api/performances/${f.pid}/hold`, a, { seatIds: ['A-01'] }).then(r => { completed = true; return r; });
    await busy.first;
    const read = await f.api('GET', '/api/session', a);
    assert.equal(read.status, 200);
    assert.equal(completed, false, 'WAL session read should complete during async backoff');
    const result = await blocked;
    const elapsed = performance.now() - started;
    assert.equal(result.status, 503);
    assert.equal(result.headers.get('retry-after'), '1');
    validateResponse(currentSpec, currentSpec.paths['/api/performances/{performanceId}/hold'].put, result.status, result.body);
    assert.ok(busy.n >= 2 && busy.n <= 4, `bounded attempts: ${busy.n}`);
    assert.ok(elapsed < 2000, `bounded wall time: ${elapsed}ms`);
    assert.equal(store.get('SELECT COUNT(*) AS n FROM holds').n, 0);
    t.diagnostic(`native busy=${busy.n}; request=${elapsed.toFixed(1)}ms; WAL session read completed before 503`);
    await release();
    f.verify();
  });

  test(`[${schema}] 잠금 해제 뒤 최신 만료·세션을 재검증하고 오래된 요청을 거부한다`, async t => {
    const f = await fixture(t, schema), { store } = f.app, [a, b] = f.users;
    const old = store.setHold(a.id, f.pid, ['A-01', 'A-02']).hold;
    let release = await lock(t, f.path), busy = countBusy(store);
    const checkout = f.api('POST', '/api/bookings', a, order(old));
    await busy.first;
    f.time(old.expires_at);
    await release();
    assert.equal((await checkout).status, 409);
    busy.restore();
    const race = await Promise.all([
      f.api('POST', '/api/bookings', a, order(old)),
      f.api('PUT', `/api/performances/${f.pid}/hold`, b, { seatIds: ['A-01', 'A-02'] })
    ]);
    assert.equal(race[0].status, 409);
    assert.equal(race[1].status, 200);
    assert.equal(store.get('SELECT COUNT(*) AS n FROM bookings').n, 0);
    // Expiry while retrying must not leave authorization captured before await.
    store.run('UPDATE sessions SET expires_at=? WHERE user_id=?', old.expires_at + 1, a.id);
    release = await lock(t, f.path);
    busy = countBusy(store);
    const stale = f.api('PUT', `/api/performances/${f.pid}/hold`, a, { seatIds: ['B-01'] });
    await busy.first;
    f.time(old.expires_at + 1);
    await release();
    assert.equal((await stale).status, 401);
    busy.restore();
    assert.equal(store.seatMap(f.pid, a.id).hold, null);
    f.verify();
  });

  test(`[${schema}] 짧은 실제 잠금 해제 후 재시도가 성공하며 중간 좌석 변경은 없다`, async t => {
    const f = await fixture(t, schema), { store } = f.app, [a] = f.users;
    const release = await lock(t, f.path), busy = countBusy(store);
    const pending = f.api('PUT', `/api/performances/${f.pid}/hold`, a, { seatIds: ['A-01', 'A-02'] });
    await busy.first;
    assert.equal(store.get('SELECT COUNT(*) AS n FROM holds').n, 0);
    await release();
    const result = await pending;
    assert.equal(result.status, 200);
    assert.ok(busy.n >= 1 && busy.n < 4);
    busy.restore();
    assert.equal(store.seatMap(f.pid, a.id).seats.filter(s => s.state === 'selected').length, 2);
    f.verify();
  });
}

test('model 키는 동시 재요청·본문 충돌·취소 결과·실패 이력을 영속 보존한다', async t => {
  const f = await fixture(t, 'model'), { store } = f.app, [a, b] = f.users;
  const hold = store.setHold(a.id, f.pid, ['A-01', 'A-02']).hold, body = order(hold), key = { 'Idempotency-Key': 'synthetic-order-1' };
  const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => f.api('POST', '/api/bookings', a,
    i % 2 ? { ...body, buyerName: ' 가상예매자 ', buyerPhone: '010-1234-5678' } : body, key)));
  assert.ok(responses.every(r => r.status === 201));
  const booking = responses[0].body.booking;
  assert.equal(new Set(responses.map(r => r.body.booking.id)).size, 1);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM payment_attempts').n, 1);
  assert.equal((await f.api('POST', '/api/bookings', a, { ...body, delivery: 'onsite' }, key)).status, 409);
  assert.equal((await f.api('POST', '/api/bookings', b, body, key)).status, 404);
  assert.equal((await f.api('POST', '/api/bookings', a, body, { 'Idempotency-Key': 'another-key' })).body.booking.id, booking.id);
  assert.equal((await f.api('POST', '/api/bookings', a, { ...body, buyerName: '다른예매자' }, { 'Idempotency-Key': 'different-body' })).status, 409);
  store.cancel(a.id, booking.id);
  assert.equal((await f.api('POST', '/api/bookings', a, body, key)).body.booking.status, 'cancelled');
  const expired = store.setHold(a.id, f.pid, ['B-01']).hold;
  f.time(expired.expires_at);
  const failureKey = { 'Idempotency-Key': 'expired-order' };
  const first = await f.api('POST', '/api/bookings', a, order(expired), failureKey);
  assert.equal(first.status, 409);
  assert.equal(store.get("SELECT failure_code FROM payment_attempts WHERE request_key='expired-order'").failure_code, 'HOLD_EXPIRED');
  store.seatMap(f.pid, a.id); // Commit expiry cleanup independently.
  store.setHold(b.id, f.pid, ['B-01']);
  const replay = await f.api('POST', '/api/bookings', a, order(expired), failureKey);
  assert.deepEqual(replay.body, first.body);
  assert.equal((await f.api('POST', '/api/bookings', a, { ...order(expired), delivery: 'onsite' }, failureKey)).status, 409);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM payment_attempts').n, 2);
  for (const invalid of ['', 'legacy-checkout', 'x'.repeat(129), 'has space']) {
    assert.equal((await f.api('POST', '/api/bookings', a, body, { 'Idempotency-Key': invalid })).status, 400);
  }
  assert.equal((await f.api('POST', '/api/bookings', a, { ...body, agreed: false }, { 'Idempotency-Key': 'invalid-input' })).status, 400);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM payment_attempts').n, 2, 'input errors must not be durable payment attempts');
  f.verify();
  await f.stop();
  await f.start();
  assert.deepEqual((await f.api('POST', '/api/bookings', a, order(expired), failureKey)).body, first.body);
  assert.equal((await f.api('POST', '/api/bookings', a, body, key)).body.booking.status, 'cancelled');
  f.verify();
});

test('model은 커밋 뒤 응답 소켓 유실·재시작 후 같은 키로 하나의 예매를 돌려준다', async t => {
  const f = await fixture(t, 'model'), { store, server } = f.app, [a] = f.users;
  const hold = store.setHold(a.id, f.pid, ['A-01']).hold, body = order(hold);
  const original = store.checkout;
  let socket, committed;
  const capture = req => { socket = req.socket; };
  server.prependListener('request', capture);
  store.checkout = function (...args) {
    committed = original.apply(this, args);
    socket.destroy(); // Simulate response loss only after the transaction committed.
    return committed;
  };
  const admitted = await admissionHeaders(store, `http://127.0.0.1:${server.address().port}`, { cookie: a.cookie, 'x-csrf-token': a.csrf }, 'POST', '/api/bookings', body);
  const failed = new Promise(ok => {
    const req = request(`http://127.0.0.1:${server.address().port}/api/bookings`, { method: 'POST', headers: {
      ...admitted, 'content-type': 'application/json', 'Idempotency-Key': 'lost-response'
    } });
    req.once('error', ok);
    req.once('response', () => ok(new Error('unexpected response')));
    req.end(JSON.stringify(body));
  });
  assert.equal((await failed).code, 'ECONNRESET');
  assert.ok(committed?.id);
  store.checkout = original;
  server.off('request', capture);
  await f.stop();
  await f.start();
  const result = await f.api('POST', '/api/bookings', a, body, { 'Idempotency-Key': 'lost-response' });
  assert.equal(result.status, 201);
  assert.equal(result.body.booking.id, committed.id);
  assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM bookings').n, 1);
  assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM payment_attempts').n, 1);
  f.verify();
});

test('model 키의 실제 BUSY는 결제 실패 이력으로 남지 않고 해제 뒤 같은 키로 성공한다', async t => {
  const f = await fixture(t, 'model'), { store } = f.app, [a] = f.users;
  const hold = store.setHold(a.id, f.pid, ['A-01']).hold, body = order(hold), key = { 'Idempotency-Key': 'busy-key' };
  const release = await lock(t, f.path);
  const blocked = await f.api('POST', '/api/bookings', a, body, key);
  assert.equal(blocked.status, 503);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM payment_attempts').n, 0);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM bookings').n, 0);
  assert.equal(store.get('SELECT status FROM holds WHERE id=?', hold.id).status, 'active');
  await release();
  assert.equal((await f.api('POST', '/api/bookings', a, body, key)).status, 201);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM payment_attempts').n, 1);
  f.verify();
});

test('model 같은 새 키에 서로 다른 본문이 동시 도착하면 한 본문만 확정한다', async t => {
  const f = await fixture(t, 'model'), { store } = f.app, [a, b] = f.users;
  const hold = store.setHold(a.id, f.pid, ['A-01']).hold;
  const responses = await Promise.all(['mobile', 'onsite'].map(delivery => f.api('POST', '/api/bookings', a,
    { ...order(hold), delivery }, { 'Idempotency-Key': 'competing-body' })));
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM bookings').n, 1);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM payment_attempts').n, 1);
  const other = store.setHold(b.id, f.pid, ['B-01']).hold;
  assert.equal((await f.api('POST', '/api/bookings', b, order(other), { 'Idempotency-Key': 'competing-body' })).status, 201, 'key scope is per hold, not global');
  f.verify();
});

test('BUSY 백오프 중 연결을 끊으면 나중에 좌석을 선점하지 않는다', async t => {
  const f = await fixture(t, 'model'), { store, server } = f.app, [a] = f.users;
  const release = await lock(t, f.path), busy = countBusy(store);
  const admitted = await admissionHeaders(store, `http://127.0.0.1:${server.address().port}`, { cookie: a.cookie, 'x-csrf-token': a.csrf }, 'PUT', `/api/performances/${f.pid}/hold`, { seatIds: ['A-01'] });
  const closed = new Promise(ok => server.once('request', (req, res) => res.once('close', ok)));
  const req = request(`http://127.0.0.1:${server.address().port}/api/performances/${f.pid}/hold`, { method: 'PUT', headers: {
    ...admitted, 'content-type': 'application/json'
  } });
  const disconnected = new Promise(ok => req.once('error', ok));
  req.end(JSON.stringify({ seatIds: ['A-01'] }));
  await busy.first;
  req.destroy();
  await disconnected;
  await closed;
  const attempts = busy.n;
  await release();
  await delay(100); // Give an uncancelled retry enough time to expose a late write.
  assert.equal(busy.n, attempts);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM holds').n, 0);
  busy.restore();
  f.verify();
});

test('재시도는 BUSY만 대상으로 하고 제약/업무 오류는 즉시 전파한다', async () => {
  for (const error of [Object.assign(new Error('constraint'), { code: 'ERR_SQLITE_ERROR', errcode: 2067 }), Object.assign(new Error('locked'), { code: 'ERR_SQLITE_ERROR', errcode: 6 }), Object.assign(new Error('business'), { status: 409 })]) {
    let calls = 0;
    await assert.rejects(retryDatabase(() => { calls++; throw error; }), e => e === error);
    assert.equal(calls, 1);
  }
});
