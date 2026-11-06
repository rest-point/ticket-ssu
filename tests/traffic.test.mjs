import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createApp } from '../server.mjs';
import { Store } from '../lib/store.mjs';
import { ModelStore } from '../lib/model-store.mjs';
import { validateModel } from '../db/model.mjs';
import { currentSpec, validateResponse } from '../scripts/check-api.mjs';

const initialTime = 1800000000000;
async function fixture(t, schema, { file = false, limits = {}, holdMs = 1000 } = {}) {
  let wall = initialTime, mono = 0, app, worker;
  const dir = file ? await mkdtemp(join(tmpdir(), 'ticket-ssu-traffic-')) : null;
  const path = dir ? join(dir, 'test.sqlite') : ':memory:';
  const stop = async () => { if (app?.store.db.isOpen) await new Promise(ok => app.server.close(ok)); };
  t.after(async () => {
    if (worker && worker.threadId !== -1) await worker.terminate();
    await stop();
    if (dir) { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep + 'ticket-ssu-traffic-')); await rm(dir, { recursive: true }); }
  });
  const start = async () => {
    app = await createApp({ schema, dbPath: path, now: () => wall, holdMs,
      queueOptions: { activeLimit: 10, admitPerSecond: 1000, admissionMs: 10000, monotonic: () => mono },
      limitOptions: { ipBurst: 1000, ipPerSecond: 1000, userBurst: 1000, userPerSecond: 1000, monotonic: () => mono, ...limits } });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  };
  await start();
  const identity = id => { const session = app.store.createSession(id); return { id, cookie: `ticket_ssu_session=${session.token}`, csrf: session.csrf }; };
  const users = ['demo@ticket-ssu.local', 'admin@ticket-ssu.local'].map(email => identity(app.store.get('SELECT id FROM users WHERE email=?', email).id));
  const pid = app.store.concerts()[0].performances[0].id;
  const api = async (method, url, user, body, extra = {}) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${url}`, { method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(user ? { Cookie: user.cookie, 'X-CSRF-Token': user.csrf } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const qpath = `/api/v1/performances/${pid}/queue`;
  return { get app() { return app; }, users, identity, pid, path, api, qpath, start, stop,
    advance: ms => { wall += ms; mono += ms; },
    verify: () => { assert.equal(app.store.db.isTransaction, false); assert.deepEqual(app.store.all('PRAGMA foreign_key_check'), []); if (schema === 'model') validateModel(app.store.db); },
    lock: async () => {
      worker = new Worker(new URL('./helpers/sqlite-lock-worker.mjs', import.meta.url), { workerData: { path } });
      const exited = once(worker, 'exit'); assert.deepEqual(await once(worker, 'message'), ['locked']);
      return async () => { const released = once(worker, 'message'); worker.postMessage('release'); await released; await exited; };
    }
  };
}

for (const schema of ['legacy', 'model']) {
  test(`[${schema}] IP 제한은 DB 세션 조회보다 먼저 적용하고 전달 IP/쿠키/경로로 우회하지 못한다`, async t => {
    const f = await fixture(t, schema, { limits: { ipBurst: 2, ipPerSecond: 1 } });
    assert.equal((await f.api('GET', '/api/session')).status, 200);
    assert.equal((await f.api('GET', '/api/concerts')).status, 200);
    const original = f.app.store.session;
    let queries = 0;
    f.app.store.session = function (...args) { queries++; return original.apply(this, args); };
    try {
      for (let i = 0; i < 3; i++) {
        const result = await f.api('GET', i % 2 ? '/api/session?different=1' : '/api/concerts', f.users[0], undefined,
          { 'X-Forwarded-For': `198.51.100.${i}`, Forwarded: `for=198.51.100.${i}` });
        assert.equal(result.status, 429); assert.equal(result.headers.get('retry-after'), '1');
        validateResponse(currentSpec, currentSpec.paths['/api/concerts'].get, result.status, result.body);
      }
      assert.equal(queries, 0);
    } finally { f.app.store.session = original; }
    assert.deepEqual(f.app.limiter.stats(), { ips: 1, users: 0, authIps: 0 });
    f.advance(1000); assert.equal((await f.api('GET', '/api/session')).status, 200);
    const staticResponse = await fetch(`http://127.0.0.1:${f.app.server.address().port}/polling.mjs`);
    assert.equal(staticResponse.status, 200); assert.match(staticResponse.headers.get('content-type'), /javascript/); await staticResponse.text();
  });

  test(`[${schema}] 회원 제한은 세션/요청 경로를 합산하고 다른 회원의 예산은 분리한다`, async t => {
    const f = await fixture(t, schema, { limits: { userBurst: 1, userPerSecond: 1 } }), [a, b] = f.users;
    const sameUserSession = f.identity(a.id);
    assert.equal((await f.api('GET', '/api/session', a)).status, 200);
    const denied = await f.api('POST', f.qpath, sameUserSession, {});
    assert.equal(denied.status, 429); assert.equal(denied.body.code, 'RATE_LIMITED');
    validateResponse(currentSpec, currentSpec.paths['/api/v1/performances/{performanceId}/queue'].post, denied.status, denied.body);
    assert.equal((await f.api('GET', '/api/session', b)).status, 200);
    f.advance(1000); assert.equal((await f.api('GET', '/api/session', sameUserSession)).status, 200);
    assert.equal(f.app.limiter.stats().users, 2);
  });

  test(`[${schema}] 잘못된 인증 본문도 고정 창에 포함하고 Retry-After 뒤 새 창을 연다`, async t => {
    const f = await fixture(t, schema, { limits: { authAttempts: 3, authWindowMs: 1000 } });
    for (let i = 0; i < 3; i++) assert.equal((await f.api('POST', '/api/auth/login', null, {}, { 'Content-Type': 'text/plain' })).status, 415);
    const denied = await f.api('POST', '/api/auth/signup', null, {});
    assert.equal(denied.status, 429); assert.equal(denied.headers.get('retry-after'), '1');
    f.advance(999); assert.equal((await f.api('POST', '/api/auth/login', null, {})).status, 429);
    f.advance(1); assert.equal((await f.api('POST', '/api/auth/login', null, {}, { 'Content-Type': 'text/plain' })).status, 415);
  });

  test(`[${schema}] 폴링은 만료를 논리 반영하며 별도 writer 잠금 중에도 쓰기 없이 응답한다`, async t => {
    const f = await fixture(t, schema, { file: true }), [a, admin] = f.users, { store } = f.app;
    const token = (await f.api('POST', f.qpath, a, {})).body.admission_token;
    const hold = (await f.api('PUT', `/api/performances/${f.pid}/hold`, a, { seatIds: ['A-01'] }, { 'X-Admission-Token': token })).body.hold;
    const changes = store.get('SELECT total_changes() AS n').n;
    const expire = store.expire;
    store.expire = () => { throw new Error('polling must not run expiry writes'); };
    let release;
    try {
      const before = await f.api('GET', `/api/performances/${f.pid}/seats`, a);
      assert.equal(before.body.seats[0].state, 'selected');
      f.advance(1000);
      release = await f.lock();
      const results = await Promise.all([
        f.api('GET', `/api/performances/${f.pid}/seats`, a),
        f.api('GET', '/api/concerts'), f.api('GET', '/api/admin/summary', admin)
      ]);
      assert.ok(results.every(r => r.status === 200));
      assert.equal(results[0].body.hold, null); assert.equal(results[0].body.seats[0].state, 'available');
      assert.equal(results[1].body.concerts.flatMap(c => c.performances).find(p => p.id === f.pid).available, 96);
      assert.equal(results[2].body.performances.find(p => p.id === f.pid).held, 0);
      assert.equal(store.get('SELECT status FROM holds WHERE id=?', hold.id).status, 'active', 'physical cleanup is deferred');
      assert.equal(store.get('SELECT total_changes() AS n').n, changes);
      assert.throws(() => store.seatMap('missing'), { status: 404 });
      assert.equal(store.db.isTransaction, false);
    } finally { store.expire = expire; if (release) await release(); }
    const otherToken = (await f.api('POST', f.qpath, admin, {})).body.admission_token;
    assert.equal((await f.api('PUT', `/api/performances/${f.pid}/hold`, admin, { seatIds: ['A-01'] }, { 'X-Admission-Token': otherToken })).status, 200);
    assert.equal(store.get('SELECT status FROM holds WHERE id=?', hold.id).status, 'expired');
    assert.equal((await f.api('POST', '/api/bookings', a, { holdId: hold.id, buyerName: '가상예매자', buyerPhone: '01012345678', delivery: 'mobile', agreed: true, paymentMethod: 'demo' }, { 'X-Admission-Token': token })).status, 409);
    f.verify();
  });

  test(`[${schema}] 반복 읽기 스냅샷은 외부 연결의 커밋을 다음 조회에 반영하고 DB를 변경하지 않는다`, async t => {
    const f = await fixture(t, schema, { file: true }), [a, admin] = f.users, { store } = f.app;
    const start = store.get('SELECT total_changes() AS n').n;
    let writes = 0;
    const run = store.run;
    store.run = function (...args) { writes++; return run.apply(this, args); };
    try {
      for (let i = 0; i < 8; i++) { store.seatMap(f.pid, a.id); store.concerts(); store.adminSummary(admin.id); }
      assert.equal(writes, 0); assert.equal(store.get('SELECT total_changes() AS n').n, start);
    } finally { store.run = run; }
    const external = new (schema === 'model' ? ModelStore : Store)(f.path, { now: () => initialTime });
    try { external.blockSeats(admin.id, f.pid, ['A-01'], true); } finally { external.close(); }
    assert.equal(store.seatMap(f.pid, a.id).seats[0].state, 'blocked');
    assert.equal(store.concerts()[0].performances.find(p => p.id === f.pid).available, 95);
    assert.equal(store.adminSummary(admin.id).performances.find(p => p.id === f.pid).blocked, 1);
    f.verify();
  });

  test(`[${schema}] 재시작은 제한 예산을 초기화하지만 기존 선점은 복구 전용으로 보존한다`, async t => {
    const f = await fixture(t, schema, { file: true, holdMs: 10000, limits: { ipBurst: 2, ipPerSecond: 2 } }), [a] = f.users;
    const token = (await f.api('POST', f.qpath, a, {})).body.admission_token;
    const hold = (await f.api('PUT', `/api/performances/${f.pid}/hold`, a, { seatIds: ['A-01'] }, { 'X-Admission-Token': token })).body.hold;
    assert.equal((await f.api('GET', '/api/session', a)).status, 429);
    await f.stop(); await f.start();
    assert.deepEqual(f.app.limiter.stats(), { ips: 0, users: 0, authIps: 0 });
    assert.equal((await f.api('GET', '/api/session', a)).status, 200);
    const recovered = (await f.api('POST', f.qpath, a, { resumeHoldId: hold.id })).body;
    assert.equal(recovered.mode, 'hold-recovery');
    f.advance(1000);
    const body = { holdId: hold.id, buyerName: '가상예매자', buyerPhone: '01012345678', delivery: 'mobile', agreed: true, paymentMethod: 'demo' };
    assert.equal((await f.api('POST', '/api/bookings', a, body, { 'X-Admission-Token': token })).status, 403);
    assert.equal((await f.api('POST', '/api/bookings', a, body, { 'X-Admission-Token': recovered.admission_token })).status, 201);
    f.verify();
  });
}

test('잘못된 요청 제한 설정은 DB를 생성하기 전에 거부한다', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ticket-ssu-limit-config-'));
  t.after(async () => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep + 'ticket-ssu-limit-config-')); await rm(dir, { recursive: true }); });
  const path = join(dir, 'never-created.sqlite');
  await assert.rejects(createApp({ dbPath: path, limitOptions: { maxIps: 0 } }), /maxIps/);
  await assert.rejects(access(path), { code: 'ENOENT' });
});
