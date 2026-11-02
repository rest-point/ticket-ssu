import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createApp } from '../server.mjs';
import { Store } from '../lib/store.mjs';
import { ModelStore } from '../lib/model-store.mjs';
import { isDatabaseBusy } from '../lib/db-retry.mjs';
import { validateModel } from '../db/model.mjs';
import { currentSpec, validateResponse } from '../scripts/check-api.mjs';

const initialTime = 1800000000000;
const order = hold => ({ holdId: hold.id, buyerName: '가상예매자', buyerPhone: '01012345678', delivery: 'mobile', paymentMethod: 'demo', agreed: true });
async function fixture(t, schema, { file = false, queueOptions = {}, setup } = {}) {
  let now = initialTime, mono = 0, app, worker;
  const dir = file ? await mkdtemp(join(tmpdir(), 'temp-admission-')) : null;
  const path = dir ? join(dir, 'test.sqlite') : ':memory:';
  const stop = async () => {
    if (app?.store.db.isOpen) await new Promise(ok => app.server.close(ok));
  };
  t.after(async () => {
    if (worker?.threadId !== undefined && worker.threadId !== -1) await worker.terminate();
    await stop();
    if (dir) {
      assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep + 'temp-admission-'));
      await rm(dir, { recursive: true });
    }
  });
  if (setup) {
    const store = new (schema === 'model' ? ModelStore : Store)(path, { now: () => now });
    try { await store.seed(); await setup(store); } finally { store.close(); }
  }
  const start = async (overrides = {}) => {
    app = await createApp({ dbPath: path, schema, now: () => now, queueOptions: { activeLimit: 1, admitPerSecond: 100, admissionMs: 1000, waitIdleMs: 10000, monotonic: () => mono, ...queueOptions, ...overrides } });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
  };
  await start();
  const identity = userId => {
    const session = app.store.createSession(userId);
    return { id: userId, cookie: `temp_session=${session.token}`, csrf: session.csrf };
  };
  const users = ['demo@temp.local', 'admin@temp.local'].map(email => identity(app.store.get('SELECT id FROM users WHERE email=?', email).id));
  const pid = app.store.concerts()[0].performances[0].id;
  const api = async (method, url, user, body, token, extra = {}) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${url}`, {
      method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(user ? { cookie: user.cookie, 'x-csrf-token': user.csrf } : {}),
        ...(token === undefined ? {} : { 'X-Admission-Token': token }), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000)
    });
    const result = { status: response.status, body: await response.json(), headers: response.headers };
    if (url.endsWith('/queue')) validateResponse(currentSpec, currentSpec.paths['/api/v1/performances/{performanceId}/queue'][method.toLowerCase()], result.status, result.body);
    return result;
  };
  const queuePath = (p = pid) => `/api/v1/performances/${p}/queue`;
  return { get app() { return app; }, pid, path, users, identity, api, queuePath, start, stop,
    join: (user, body = {}, p = pid) => api('POST', queuePath(p), user, body),
    hold: (user, ids, token, p = pid) => api('PUT', `/api/performances/${p}/hold`, user, { seatIds: ids }, token),
    advance: ms => { now += ms; mono += ms; },
    verify: () => {
      assert.equal(app.store.db.isTransaction, false);
      assert.deepEqual(app.store.all('PRAGMA foreign_key_check'), []);
      if (schema === 'model') validateModel(app.store.db);
    },
    lock: async () => {
      worker = new Worker(new URL('./helpers/sqlite-lock-worker.mjs', import.meta.url), { workerData: { path } });
      const exited = once(worker, 'exit');
      assert.deepEqual(await once(worker, 'message'), ['locked']);
      return async () => { const released = once(worker, 'message'); worker.postMessage('release'); await released; await exited; };
    }
  };
}

for (const schema of ['legacy', 'model']) {
  test(`[${schema}] 큐 인증·입력·CSRF와 입장권 없는 기존 경로의 직접 호출을 거부한다`, async t => {
    const f = await fixture(t, schema), [a, b] = f.users;
    assert.equal((await f.api('POST', f.queuePath(), null, {})).status, 401);
    assert.equal((await f.api('POST', f.queuePath(), a, {}, undefined, { 'x-csrf-token': 'forged' })).status, 403);
    assert.equal((await f.api('POST', f.queuePath(), a, {}, undefined, { Origin: 'https://invalid.example' })).status, 403);
    assert.equal((await f.join(a, { userId: b.id })).status, 400);
    assert.equal((await f.join(a, { resumeHoldId: 'missing' })).status, 409);
    assert.equal((await f.join(a, {}, 'missing')).status, 404);
    assert.equal((await f.hold(a, ['A-01'])).status, 403);
    assert.equal((await f.hold(a, ['A-01'], 'f'.repeat(64))).status, 403);
    const entered = await f.api('POST', f.queuePath(), a);
    assert.equal(entered.status, 200);
    assert.equal((await f.api('POST', f.queuePath(), a, undefined, undefined, { 'Content-Type': 'application/json' })).body.entry_id, entered.body.entry_id);
    assert.match(entered.body.admission_token, /^[a-f0-9]{64}$/);
    const second = f.app.store.concerts()[0].performances[1].id;
    assert.equal((await f.hold(a, ['A-01'], entered.body.admission_token, second)).status, 403);
    assert.equal((await f.hold(b, ['A-01'], entered.body.admission_token)).status, 403);
    assert.equal((await f.api('PUT', `/api/v1/performances/${f.pid}/hold`, a, { seatIds: ['A-01'] }, entered.body.admission_token)).status, 404);
    assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM holds').n, 0);
    f.verify();
  });

  test(`[${schema}] 실제 중복 큐 HTTP 요청은 한 항목이며 대기자는 보호 API를 우회하지 못한다`, async t => {
    const f = await fixture(t, schema), [a, b] = f.users;
    const joined = await Promise.all(Array.from({ length: 8 }, () => f.join(a)));
    assert.ok(joined.every(r => r.status === 200 && r.body.state === 'admitted'));
    assert.equal(new Set(joined.map(r => r.body.entry_id)).size, 1);
    assert.equal(new Set(joined.map(r => r.body.admission_token)).size, 1);
    const waiting = (await f.join(b)).body;
    assert.equal(waiting.state, 'waiting');
    assert.equal(waiting.admission_token, null);
    assert.equal(waiting.position, 1);
    assert.equal((await f.hold(b, ['A-01'], joined[0].body.admission_token)).status, 403);
    assert.equal((await f.api('GET', f.queuePath(), b)).body.entry_id, waiting.entry_id);
    await f.api('DELETE', f.queuePath(), a);
    const admitted = (await f.api('GET', f.queuePath(), b)).body;
    assert.equal(admitted.state, 'admitted');
    assert.equal(admitted.entry_id, waiting.entry_id);
    assert.equal((await f.hold(a, ['A-01'], joined[0].body.admission_token)).status, 403);
    assert.equal((await f.hold(b, ['A-01'], admitted.admission_token)).status, 200);
    assert.equal(f.app.queue.stats().admitted, 1);
    f.verify();
  });

  test(`[${schema}] 같은 회원의 새 세션 재접속은 순서/정원을 유지하고 이전 입장권을 무효화한다`, async t => {
    const f = await fixture(t, schema), [a] = f.users;
    const original = (await f.join(a)).body;
    const otherSession = f.identity(a.id);
    assert.equal((await f.hold(otherSession, ['A-01'], original.admission_token)).status, 403);
    assert.equal((await f.api('GET', f.queuePath(), otherSession)).status, 403);
    const reconnected = (await f.join(otherSession)).body;
    assert.equal(reconnected.entry_id, original.entry_id);
    assert.equal(reconnected.sequence, original.sequence);
    assert.equal(reconnected.admission_expires_at, original.admission_expires_at);
    assert.notEqual(reconnected.admission_token, original.admission_token);
    assert.equal((await f.hold(a, ['A-01'], original.admission_token)).status, 403);
    assert.equal((await f.hold(otherSession, ['A-01'], reconnected.admission_token)).status, 200);
    await f.api('POST', '/api/auth/logout', otherSession);
    assert.equal((await f.hold(otherSession, ['A-02'], reconnected.admission_token)).status, 401);
    assert.equal(f.app.queue.stats().admitted, 1, 'live hold must continue consuming capacity after logout');
    assert.equal((await f.join(a)).body.mode, 'hold-recovery');
    f.verify();
  });

  test(`[${schema}] 일반 입장 만료 후 유효 선점은 정원을 유지하며 해당 hold 확정만 허용한다`, async t => {
    const f = await fixture(t, schema), [a, b] = f.users;
    const token = (await f.join(a)).body.admission_token;
    const first = (await f.hold(a, ['A-01'], token)).body.hold;
    f.advance(100);
    const replaced = (await f.hold(a, ['A-01', 'A-02'], token)).body.hold;
    assert.notEqual(replaced.id, first.id);
    assert.equal(replaced.expires_at, first.expires_at);
    f.advance(900);
    const restricted = (await f.api('GET', f.queuePath(), a)).body;
    assert.equal(restricted.mode, 'hold-recovery');
    assert.equal(restricted.admission_expires_at, replaced.expires_at);
    assert.equal((await f.join(b)).body.state, 'waiting');
    assert.equal((await f.hold(a, ['A-01', 'A-02', 'A-03'], token)).status, 403);
    assert.equal((await f.api('POST', '/api/bookings', a, order(first), token)).status, 409);
    assert.equal((await f.api('POST', '/api/bookings', a, order(replaced))).status, 403);
    const confirmed = await f.api('POST', '/api/bookings', a, order(replaced), token);
    assert.equal(confirmed.status, 201);
    assert.equal(confirmed.body.booking.seats.length, 2);
    assert.equal((await f.api('GET', f.queuePath(), b)).body.state, 'admitted');
    f.verify();
  });

  test(`[${schema}] 선점 없는 입장권 만료와 선점 자체의 만료 경계를 구분한다`, async t => {
    const f = await fixture(t, schema), [a, b] = f.users;
    const expired = (await f.join(a)).body.admission_token;
    f.advance(1000);
    assert.equal((await f.hold(a, ['A-01'], expired)).status, 403);
    assert.equal((await f.api('GET', f.queuePath(), a)).status, 404);
    const token = (await f.join(b)).body.admission_token;
    const hold = (await f.hold(b, ['A-01'], token)).body.hold;
    f.advance(7 * 60 * 1000);
    assert.equal((await f.api('POST', '/api/bookings', b, order(hold), token)).status, 409);
    const next = (await f.join(a)).body;
    assert.equal(next.state, 'admitted');
    assert.equal((await f.hold(a, ['A-01'], next.admission_token)).status, 200);
    f.verify();
  });

  test(`[${schema}] 큐 이탈·전체 해제·조회·취소·완료 재요청은 좌석/이력 정책을 보존한다`, async t => {
    const f = await fixture(t, schema), [a, admin] = f.users;
    const token = (await f.join(a)).body.admission_token;
    const hold = (await f.hold(a, ['A-01'], token)).body.hold;
    await f.api('DELETE', f.queuePath(), a);
    assert.equal((await f.api('GET', `/api/performances/${f.pid}/seats`, a)).body.hold.id, hold.id);
    assert.equal((await f.join(admin)).body.state, 'waiting');
    const recovered = (await f.join(a, { resumeHoldId: hold.id })).body;
    assert.equal(recovered.mode, 'hold-recovery');
    assert.equal((await f.hold(a, ['A-02'], recovered.admission_token)).status, 403);
    const booking = (await f.api('POST', '/api/bookings', a, order(hold), recovered.admission_token)).body.booking;
    assert.equal((await f.api('POST', '/api/bookings', a, order(hold))).body.booking.id, booking.id);
    assert.equal((await f.api('POST', `/api/bookings/${booking.id}/cancel`, a)).status, 200);
    assert.equal((await f.api('GET', '/api/bookings', a)).body.bookings[0].status, 'cancelled');
    assert.equal((await f.api('PATCH', `/api/admin/performances/${f.pid}/seats`, admin, { seatIds: ['B-01'], blocked: true })).status, 200);
    // A new hold can be released without any admission header after its lease ends.
    const adminToken = (await f.api('GET', f.queuePath(), admin)).body.admission_token;
    await f.hold(admin, ['A-02'], adminToken);
    f.advance(1000);
    assert.equal((await f.hold(admin, [])).status, 200);
    assert.equal(f.app.store.liveHolds(admin.id, f.pid).length, 0);
    f.verify();
  });

  test(`[${schema}] 과거 예매 재요청이 같은 회차의 새 선점 정원을 반환하지 않는다`, async t => {
    const f = await fixture(t, schema), [a, b] = f.users;
    let token = (await f.join(a)).body.admission_token;
    const old = (await f.hold(a, ['A-01'], token)).body.hold;
    const booking = (await f.api('POST', '/api/bookings', a, order(old), token)).body.booking;
    token = (await f.join(a)).body.admission_token;
    const current = (await f.hold(a, ['A-02'], token)).body.hold;
    assert.equal((await f.api('POST', '/api/bookings', a, order(old))).body.booking.id, booking.id);
    assert.equal((await f.join(b)).body.state, 'waiting');
    f.advance(1000);
    assert.equal((await f.api('POST', '/api/bookings', a, order(current), token)).status, 201);
    assert.equal((await f.api('GET', f.queuePath(), b)).body.state, 'admitted');
    f.verify();
  });

  test(`[${schema}] 재시작한 유효 선점은 정원을 먼저 차지하고 복구권으로 새 선택을 허용하지 않는다`, async t => {
    let users, pid;
    const f = await fixture(t, schema, { file: true, setup: store => {
      users = store.all('SELECT id FROM users ORDER BY id'); pid = store.concerts()[0].performances[0].id;
      users.forEach((u, i) => store.setHold(u.id, pid, [`A-0${i + 1}`]));
    } });
    const [a, b] = f.users;
    assert.equal(f.app.queue.stats().admitted, 2, 'restored occupants may exceed the new activeLimit=1');
    const hold = f.app.store.liveHolds(a.id, pid)[0];
    const before = (await f.join(a, { resumeHoldId: hold.id })).body;
    assert.equal(before.mode, 'hold-recovery');
    const other = await f.app.store.register({ email: 'wait@temp.local', name: '대기회원', phone: '01012345678', password: 'AdmissionDemo123!', terms: true, ageConfirmed: true });
    const c = f.identity(other.id);
    assert.equal((await f.join(c)).body.state, 'waiting');
    assert.equal((await f.hold(a, ['B-01'], before.admission_token)).status, 403);
    await f.stop(); await f.start();
    assert.equal(f.app.queue.stats().admitted, 2);
    assert.equal((await f.hold(a, ['B-01'], before.admission_token)).status, 403);
    const resumed = (await f.join(a, { resumeHoldId: hold.id })).body;
    assert.notEqual(resumed.restart_epoch, before.restart_epoch);
    assert.notEqual(resumed.admission_token, before.admission_token);
    assert.equal((await f.hold(a, [])).status, 200);
    assert.equal((await f.join(c)).body.state, 'waiting');
    const bHold = f.app.store.liveHolds(b.id, pid)[0];
    const bToken = (await f.join(b, { resumeHoldId: bHold.id })).body.admission_token;
    assert.equal((await f.api('POST', '/api/bookings', b, order(bHold), bToken)).status, 201);
    assert.equal((await f.api('GET', f.queuePath(), c)).body.state, 'admitted');
    f.verify();
  });

  test(`[${schema}] 실제 DB 잠금 뒤 재시도는 그때 만료된 입장권으로 선점하지 않는다`, async t => {
    const f = await fixture(t, schema, { file: true }), [a] = f.users;
    const token = (await f.join(a)).body.admission_token;
    const release = await f.lock();
    const original = f.app.store.transaction;
    let notify;
    const busy = new Promise(ok => { notify = ok; });
    f.app.store.transaction = function (fn) { try { return original.call(this, fn); } catch (e) { if (isDatabaseBusy(e)) notify(); throw e; } };
    const pending = f.hold(a, ['A-01'], token);
    await busy;
    f.advance(1000);
    await release();
    assert.equal((await pending).status, 403);
    f.app.store.transaction = original;
    assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM holds').n, 0);
    f.verify();
  });

  test(`[${schema}] 큐 상태 조회는 DB 만료 쓰기 없이 본인만 반환하고 상한은 신규만 거부한다`, async t => {
    const f = await fixture(t, schema, { queueOptions: { maxWaiting: 1, maxTotal: 2 } }), [a, b] = f.users;
    const other = await f.app.store.register({ email: 'limit@temp.local', name: '대기상한', phone: '01012345678', password: 'AdmissionDemo123!', terms: true, ageConfirmed: true });
    const c = f.identity(other.id);
    const first = (await f.join(a)).body;
    const waiting = (await f.join(b)).body;
    const limited = await f.join(c);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '1');
    assert.equal((await f.join(b)).body.entry_id, waiting.entry_id);
    const changes = f.app.store.get('SELECT total_changes() AS n').n;
    const expire = f.app.store.expire;
    f.app.store.expire = () => { throw new Error('queue poll must not expire SQLite holds'); };
    try {
      const results = await Promise.all(Array.from({ length: 8 }, () => f.api('GET', f.queuePath(), b)));
      for (const result of results) {
        assert.equal(result.status, 200);
        assert.equal(result.body.entry_id, waiting.entry_id);
        assert.ok(!JSON.stringify(result.body).includes(first.entry_id));
        assert.ok(!JSON.stringify(result.body).includes(first.admission_token));
      }
    } finally { f.app.store.expire = expire; }
    assert.equal(f.app.store.get('SELECT total_changes() AS n').n, changes);
    f.verify();
  });

  test(`[${schema}] 공연 시작은 일반 입장/유효 선점보다 먼저 마감하며 새 확정을 막는다`, async t => {
    const f = await fixture(t, schema, { queueOptions: { admissionMs: 100000 } }), [a, admin] = f.users;
    const concert = f.app.store.createConcert(admin.id, { title: '입장 마감 경계', artist: '가상 밴드', venue: '가상 공연장', description: '마감 검증', basePrice: 50000, dates: [new Date(initialTime + 1000).toISOString()] });
    const pid = f.app.store.concerts().find(c => c.id === concert.id).performances[0].id;
    const status = (await f.join(a, {}, pid)).body;
    assert.equal(status.admission_expires_at, initialTime + 1000);
    const hold = (await f.hold(a, ['A-01'], status.admission_token, pid)).body.hold;
    assert.ok(hold.expires_at > initialTime + 1000);
    f.advance(1000);
    assert.equal((await f.api('GET', f.queuePath(pid), a)).status, 404);
    assert.equal((await f.api('POST', '/api/bookings', a, order(hold), status.admission_token)).status, 409);
    assert.equal((await f.join(a, {}, pid)).status, 409);
    assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM bookings').n, 0);
    f.verify();
  });

  test(`[${schema}] 복구 정원을 담지 못하는 설정은 선점을 버리지 않고 시작을 거부한다`, async t => {
    const f = await fixture(t, schema, { file: true, setup: store => {
      const pid = store.concerts()[0].performances[0].id;
      store.all('SELECT id FROM users').forEach((u, i) => store.setHold(u.id, pid, [`A-0${i + 1}`]));
    } });
    const before = f.app.store.liveHolds();
    await f.stop();
    await assert.rejects(f.start({ maxTotal: 1 }), e => e.status === 503);
    await f.start();
    assert.deepEqual(f.app.store.liveHolds(), before);
    assert.equal(f.app.queue.stats().admitted, 2);
    f.verify();
  });
}
