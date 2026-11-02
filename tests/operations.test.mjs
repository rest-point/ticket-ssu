import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp, startServer } from '../server.mjs';
import { Store, validateAdminCredentials } from '../lib/store.mjs';
import { ModelStore } from '../lib/model-store.mjs';
import { HttpBoundary } from '../lib/http-boundary.mjs';
import { backupDatabase, restoreDatabase, verifyBackup } from '../db/backup.mjs';
import { tlsProxy } from './helpers/tls-proxy.mjs';

const now = 1800000000000, email = 'operator@example.test', password = 'TestOnlyOperator123!';
const credentials = { adminEmail: email, adminPassword: password };
const payload = hold => ({ holdId: hold.id, buyerName: '가상회원', buyerPhone: '01012345678', delivery: 'mobile', agreed: true, paymentMethod: 'demo' });
async function directory(t, cleanup = async () => {}) {
  const dir = await mkdtemp(join(tmpdir(), 'temp-ops-'));
  t.after(async () => { await cleanup(); assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep + 'temp-ops-')); await rm(dir, { recursive: true, force: true }); });
  return dir;
}
async function deployed(t, schema, limits = {}) {
  let app, edge;
  const token = randomBytes(32).toString('hex');
  const dir = await directory(t, async () => { await edge?.close(); await app?.shutdown(100); });
  edge = await tlsProxy(dir, token);
  const options = { schema, dbPath: join(dir, 'source.sqlite'), demo: false, secureCookies: true, now: () => now, ...credentials,
    boundaryOptions: { publicOrigin: edge.origin, proxyToken: token }, limitOptions: limits };
  app = await createApp(options); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); edge.setBackend(app.server.address().port);
  return { app, edge, options, dir, token, setApp: value => { app = value; edge.setBackend(app.server.address().port); } };
}
const identity = response => ({ Cookie: response.headers['set-cookie'][0].split(';')[0], 'X-CSRF-Token': response.body.csrf });
const dump = store => Object.fromEntries(store.all("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .map(({ name }) => [name, store.all(`SELECT * FROM ${name}`).map(row => JSON.stringify(row)).sort()]));

test('관리자 설정은 완전한 이메일/비밀번호 쌍과 길이를 검사한다', () => {
  assert.equal(validateAdminCredentials(), null);
  assert.equal(validateAdminCredentials(' OPERATOR@example.test ', password).email, email);
  for (const pair of [[email], [undefined, password], ['', ''], ['invalid', password], [email, 'short'], [email, 'x'.repeat(129)]]) assert.throws(() => validateAdminCredentials(...pair));
});
test('공개 프록시는 정확한 출처·loopback·비밀 토큰·단일 IP 형식만 수용한다', () => {
  const token = randomBytes(32).toString('hex');
  const boundary = new HttpBoundary({ publicOrigin: 'https://tickets.example.test', proxyToken: token });
  const request = (headers = {}, peer = '127.0.0.1') => ({ socket: { remoteAddress: peer }, headers: { host: 'tickets.example.test', 'x-temp-proxy-token': token, 'x-temp-client-ip': '192.0.2.1', ...headers } });
  assert.equal(boundary.clientIp(request()), '192.0.2.1');
  assert.equal(boundary.clientIp(request({}, '::ffff:127.0.0.1')), '192.0.2.1');
  for (const headers of [{ 'x-temp-proxy-token': 'x'.repeat(64) }, { 'x-temp-proxy-token': '가'.repeat(64) }, { 'x-temp-client-ip': '192.0.2.1, 192.0.2.2' }, { 'x-temp-client-ip': ['192.0.2.1'] }, { host: 'evil.example' }]) assert.throws(() => boundary.clientIp(request(headers)), { status: 403 });
  assert.throws(() => boundary.clientIp(request({}, '192.0.2.2')), { status: 403 });
  assert.equal(boundary.allowsOrigin('https://tickets.example.test'), true);
  assert.equal(boundary.allowsOrigin('http://tickets.example.test'), false);
  assert.equal(boundary.allowsOrigin('null'), false);
  for (const publicOrigin of ['http://tickets.example.test', 'https://tickets.example.test/', 'https://tickets.example.test/path', 'https://user@tickets.example.test']) assert.throws(() => new HttpBoundary({ publicOrigin, proxyToken: token }));
  assert.throws(() => new HttpBoundary({ proxyToken: token }));
  assert.throws(() => new HttpBoundary({ publicOrigin: 'https://tickets.example.test', proxyToken: token, proxyIp: '0.0.0.0' }));
});
test('잘못된 관리자/공개 설정과 공개 API 바인딩은 DB 생성 전에 거부한다', async t => {
  const dir = await directory(t), dbPath = join(dir, 'never.sqlite');
  await assert.rejects(createApp({ dbPath, adminEmail: email, adminPassword: 'short' }));
  await assert.rejects(createApp({ dbPath, boundaryOptions: { publicOrigin: 'https://tickets.example.test', proxyToken: '' } }));
  await assert.rejects(startServer({ runtimeEnv: { HOST: '0.0.0.0' }, appOptions: { dbPath, boundaryOptions: { publicOrigin: 'https://tickets.example.test' } } }), /loopback/);
  await assert.rejects(access(dbPath), { code: 'ENOENT' });
  const boundaryOptions = { publicOrigin: 'https://tickets.example.test', proxyToken: randomBytes(32).toString('hex') };
  await assert.rejects(createApp({ dbPath, demo: true, secureCookies: true, boundaryOptions }), /DEMO_MODE=false/);
  await assert.rejects(access(dbPath), { code: 'ENOENT' });
  await assert.rejects(createApp({ dbPath, demo: false, secureCookies: false, boundaryOptions }), /Secure/);
  await assert.rejects(access(dbPath), { code: 'ENOENT' });
  await assert.rejects(createApp({ dbPath: join(dir, 'no-admin.sqlite'), demo: false, secureCookies: true, boundaryOptions }), /초기 관리자/);
});

for (const schema of ['legacy', 'model']) {
  test(`[${schema}] 인증서 검증 HTTPS에서 관리자·Secure 쿠키·Origin/CSRF·선점/확정/취소를 검증한다`, async t => {
    const f = await deployed(t, schema), send = f.edge.send;
    assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM users').n, 1);
    const login = await send('POST', '/api/auth/login', { body: { email, password }, headers: { Origin: f.edge.origin } });
    assert.equal(login.status, 200); assert.equal(login.body.user.role, 'admin');
    assert.match(login.headers['set-cookie'][0], /HttpOnly/); assert.match(login.headers['set-cookie'][0], /SameSite=Lax/); assert.match(login.headers['set-cookie'][0], /; Secure/);
    const auth = identity(login);
    assert.equal((await send('GET', '/api/admin/summary', { headers: auth })).status, 200);
    for (const Origin of ['https://evil.example', f.edge.origin.replace('https:', 'http:'), 'null']) assert.equal((await send('POST', '/api/auth/logout', { headers: { ...auth, Origin } })).status, 403);
    assert.equal((await send('POST', '/api/auth/logout', { headers: { Cookie: auth.Cookie, Origin: f.edge.origin } })).status, 403);
    const signup = await send('POST', '/api/auth/signup', { body: { email: 'buyer@example.test', name: '가상회원', phone: '01012345678', password: 'TestBuyer123!', terms: true, ageConfirmed: true, role: 'admin' }, headers: { Origin: f.edge.origin } });
    assert.equal(signup.status, 201); assert.equal(signup.body.user.role, 'user');
    const buyer = { ...identity(signup), Origin: f.edge.origin };
    const pid = (await send('GET', '/api/concerts')).body.concerts[0].performances[0].id;
    const queue = await send('POST', `/api/v1/performances/${pid}/queue`, { body: {}, headers: buyer });
    buyer['X-Admission-Token'] = queue.body.admission_token;
    const held = await send('PUT', `/api/performances/${pid}/hold`, { body: { seatIds: ['A-01'] }, headers: buyer }); assert.equal(held.status, 200);
    const booked = await send('POST', '/api/bookings', { body: payload(held.body.hold), headers: buyer }); assert.equal(booked.status, 201);
    assert.equal((await send('GET', '/api/bookings', { headers: buyer })).body.bookings[0].id, booked.body.booking.id);
    assert.equal((await send('POST', `/api/bookings/${booked.body.booking.id}/cancel`, { headers: buyer })).body.booking.status, 'cancelled');
    const logout = await send('POST', '/api/auth/logout', { headers: buyer }); assert.equal(logout.status, 200); assert.match(logout.headers['set-cookie'][0], /Max-Age=0; Secure/);
    assert.equal((await send('GET', '/api/bookings', { headers: buyer })).status, 401);
    for (const path of ['/.env.tunnel', '/source.sqlite', '/data/temp.sqlite', '/scripts/external-smoke.mjs', '/test.key']) assert.equal((await send('GET', path)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${f.app.server.address().port}/api/concerts`)).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${f.app.server.address().port}/api/v1/readiness`)).status, 200);
  });
  test(`[${schema}] HTTPS 프록시는 전달 헤더 위조를 제거하고 실제 TLS 소켓별 요청/인증 예산을 분리한다`, async t => {
    const f = await deployed(t, schema, { ipBurst: 4, ipPerSecond: 1, authAttempts: 1, authWindowMs: 600000, monotonic: () => 0 });
    for (let i = 0; i < 4; i++) assert.equal((await f.edge.send('GET', '/api/session', { headers: { 'X-Forwarded-For': `192.0.2.${i}`, 'X-Temp-Client-IP': `192.0.2.${i}`, 'X-Temp-Proxy-Token': 'fake' } })).status, 200);
    assert.equal((await f.edge.send('GET', '/api/session')).status, 429);
    assert.equal((await f.edge.send('POST', '/api/auth/login', { localAddress: '127.0.0.2', body: { email, password: 'incorrect' } })).status, 401);
    const limited = await f.edge.send('POST', '/api/auth/login', { localAddress: '127.0.0.2', body: { email, password } }); assert.equal(limited.status, 429); assert.equal(limited.headers['retry-after'], '600');
    assert.equal((await f.edge.send('POST', '/api/auth/login', { localAddress: '127.0.0.3', body: { email, password } })).status, 200);
  });
  test(`[${schema}] 관리자 재시작은 기존 암호/역할을 보존하고 일반 회원 충돌·공개 데모 DB를 거부한다`, async t => {
    let store;
    const dir = await directory(t, async () => store?.db.isOpen && store.close()), dbPath = join(dir, 'admin.sqlite');
    const Class = schema === 'model' ? ModelStore : Store; store = new Class(dbPath, { now: () => now });
    await store.seed({ demo: false, ...credentials }); const user = store.get('SELECT * FROM users WHERE email=?', email);
    await store.seed({ demo: false, adminEmail: ` ${email.toUpperCase()} `, adminPassword: 'AnotherPassword123!' });
    assert.equal(store.get('SELECT * FROM users WHERE id=?', user.id).password_hash, user.password_hash);
    await assert.rejects(store.authenticate(email, 'AnotherPassword123!'), { status: 401 }); assert.equal((await store.authenticate(email, password)).id, user.id);
    await store.register({ email: 'member@example.test', password, name: '가상회원', phone: '01012345678', terms: true, ageConfirmed: true });
    await assert.rejects(store.seed({ demo: false, adminEmail: 'member@example.test', adminPassword: password }), { status: 409 });
    assert.equal(store.get("SELECT role FROM users WHERE email='member@example.test'").role, 'user');
    await store.seed({ demo: true }); const before = dump(store); store.close();
    const opts = { publicOrigin: 'https://tickets.example.test', proxyToken: randomBytes(32).toString('hex') };
    await assert.rejects(createApp({ dbPath, schema, demo: false, secureCookies: true, boundaryOptions: opts, ...credentials }), /공개 데모 계정/);
    store = new Class(dbPath, { now: () => now }); assert.deepEqual(dump(store), before);
  });
  test(`[${schema}] WAL 백업/새 복구 후보는 예매 이력·금액·선점·세션을 보존하고 HTTP로 복구한다`, async t => {
    const f = await deployed(t, schema), s = f.app.store, pid = s.concerts()[0].performances[0].id;
    const uid = s.get('SELECT id FROM users WHERE email=?', email).id;
    const first = s.checkout(uid, payload(s.setHold(uid, pid, ['A-01']).hold)); s.cancel(uid, first.id);
    s.checkout(uid, payload(s.setHold(uid, pid, ['A-02']).hold)); const hold = s.setHold(uid, pid, ['A-03']).hold;
    const login = await f.edge.send('POST', '/api/auth/login', { body: { email, password } }), auth = identity(login);
    s.db.exec('PRAGMA wal_autocheckpoint=0'); s.run("UPDATE users SET name='복구확인' WHERE id=?", uid);
    const expected = dump(s), backup = join(f.dir, 'backup.sqlite'), candidate = join(f.dir, 'candidate.sqlite');
    s.db.exec('BEGIN IMMEDIATE');
    try { s.run("UPDATE users SET name='미커밋' WHERE id=?", uid); const result = backupDatabase(f.options.dbPath, backup); assert.equal(result.schema, schema); assert.match(result.sha256, /^[a-f0-9]{64}$/); }
    finally { s.db.exec('ROLLBACK'); }
    assert.equal(verifyBackup(backup).schema, schema); assert.equal(restoreDatabase(backup, candidate).restored, true);
    await f.app.shutdown(100);
    const restored = await createApp({ ...f.options, dbPath: candidate, adminEmail: undefined, adminPassword: undefined });
    restored.server.listen(0, '127.0.0.1'); await once(restored.server, 'listening'); f.setApp(restored);
    assert.deepEqual(dump(restored.store), expected);
    assert.equal((await f.edge.send('GET', '/api/session', { headers: auth })).body.user.name, '복구확인');
    const q = await f.edge.send('POST', `/api/v1/performances/${pid}/queue`, { body: { resumeHoldId: hold.id }, headers: auth }); assert.equal(q.status, 200); assert.equal(q.body.mode, 'hold-recovery');
    const confirmed = await f.edge.send('POST', '/api/bookings', { body: payload(hold), headers: { ...auth, 'X-Admission-Token': q.body.admission_token } }); assert.equal(confirmed.status, 201);
    assert.equal((await f.edge.send('POST', `/api/bookings/${confirmed.body.booking.id}/cancel`, { headers: auth })).status, 200);
    const bytes = await readFile(backup);
    assert.throws(() => restoreDatabase(backup, candidate), /already exists/); assert.throws(() => backupDatabase(candidate, backup), /already exists/);
    assert.deepEqual(await readFile(backup), bytes); assert.throws(() => restoreDatabase(backup, resolve('data/temp.sqlite')), /protected|already exists/);
    assert.throws(() => restoreDatabase(backup, resolve('public/exposed.sqlite')), /tracked/);
    const cli = await promisify(execFile)(process.execPath, ['db/backup-cli.mjs', 'verify', backup], { windowsHide: true }); assert.equal(JSON.parse(cli.stdout).schema, schema);
  });
}
test('손상/지원하지 않는 백업의 실패는 원본을 보존하고 이 실행의 새 후보만 정리한다', async t => {
  const dir = await directory(t), bad = join(dir, 'bad.sqlite'), dest = join(dir, 'candidate.sqlite');
  await writeFile(bad, 'not a SQLite database'); const bytes = await readFile(bad);
  assert.throws(() => restoreDatabase(bad, dest)); await assert.rejects(access(dest), { code: 'ENOENT' }); assert.deepEqual(await readFile(bad), bytes);
  const s = new Store(join(dir, 'unsupported.sqlite')); s.db.exec('PRAGMA user_version=999'); s.close();
  assert.throws(() => restoreDatabase(join(dir, 'unsupported.sqlite'), dest)); await assert.rejects(access(dest), { code: 'ENOENT' });
});
