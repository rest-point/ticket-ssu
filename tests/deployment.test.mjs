import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { request } from 'node:http';
import { Worker } from 'node:worker_threads';
import { createApp, startServer } from '../server.mjs';
import { runtimeOptionsFromEnv } from '../lib/runtime.mjs';
import { checkReadiness } from '../scripts/status.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function temporary(t, close = async () => {}) {
  const dir = await mkdtemp(join(tmpdir(), 'temp-deploy-'));
  t.after(async () => {
    await close();
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep + 'temp-deploy-'));
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
async function fixture(t, schema, options = {}) {
  const app = await createApp({ dbPath: ':memory:', demo: true, schema, ...options });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.shutdown(100));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = async path => {
    const response = await fetch(base + path, { headers: { Cookie: `temp_session=${'a'.repeat(64)}` }, signal: AbortSignal.timeout(3000) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  return { ...app, base, get };
}
test('실행 옵션은 기본 loopback·포트·종료 예산과 경계/오류를 검증한다', () => {
  assert.deepEqual(runtimeOptionsFromEnv({}), { host: '127.0.0.1', port: 3000, shutdownMs: 10000 });
  assert.deepEqual(runtimeOptionsFromEnv({ HOST: '::1', PORT: '0', SHUTDOWN_TIMEOUT_MS: '1' }), { host: '::1', port: 0, shutdownMs: 1 });
  assert.equal(runtimeOptionsFromEnv({ PORT: '65535', SHUTDOWN_TIMEOUT_MS: '60000' }).port, 65535);
  for (const PORT of ['', '-1', '65536', '3.5', 'NaN', ' 3000', '1e3']) assert.throws(() => runtimeOptionsFromEnv({ PORT }));
  for (const HOST of ['', ' localhost', 'http://localhost', 'a b']) assert.throws(() => runtimeOptionsFromEnv({ HOST }));
  for (const SHUTDOWN_TIMEOUT_MS of ['0', '60001', 'Infinity']) assert.throws(() => runtimeOptionsFromEnv({ SHUTDOWN_TIMEOUT_MS }));
});
test('잘못된 실행 옵션은 DB 파일 생성 전에 거부한다', async t => {
  const dir = await temporary(t), dbPath = join(dir, 'never.sqlite');
  await assert.rejects(startServer({ runtimeEnv: { PORT: '65536' }, appOptions: { dbPath } }), /PORT/);
  await assert.rejects(access(dbPath), { code: 'ENOENT' });
});
test('포트 바인딩 실패는 생성한 Store와 타이머를 정리한다', async t => {
  const occupied = await fixture(t, 'legacy');
  const dir = await temporary(t), signals = new EventEmitter();
  await assert.rejects(startServer({ runtimeEnv: { PORT: String(occupied.server.address().port) },
    appOptions: { dbPath: join(dir, 'bind-failed.sqlite'), demo: false }, signalSource: signals, log: () => {} }), { code: 'EADDRINUSE' });
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

for (const schema of ['legacy', 'model']) {
  const version = schema === 'model' ? 1 : 0;
  test(`[${schema}] probes는 쿠키·회원/IP 예산·DB 쓰기를 사용하지 않고 최소 JSON만 반환한다`, async t => {
    const f = await fixture(t, schema, { limitOptions: { ipBurst: 1, ipPerSecond: 1, monotonic: () => 0 } });
    assert.equal((await f.get('/api/session')).status, 200);
    assert.equal((await f.get('/api/session')).status, 429);
    f.store.session = () => { throw new Error('probe must not read sessions'); };
    const prepare = f.store.db.prepare.bind(f.store.db), exec = f.store.db.exec.bind(f.store.db), sql = [];
    f.store.db.prepare = query => { sql.push(query); return prepare(query); };
    f.store.db.exec = query => { sql.push(query); return exec(query); };
    const changes = prepare('SELECT total_changes() AS n').get().n;
    const health = await f.get('/api/v1/health');
    assert.deepEqual(health.body, { status: 'ok' }); assert.equal(health.status, 200); assert.equal(sql.length, 0);
    for (let i = 0; i < 5; i++) {
      const ready = await f.get('/api/v1/readiness');
      assert.equal(ready.status, 200); assert.deepEqual(ready.body, { status: 'ready', schema_version: version });
      assert.equal(ready.headers.get('cache-control'), 'no-store'); assert.equal(ready.headers.get('set-cookie'), null);
    }
    assert.equal(prepare('SELECT total_changes() AS n').get().n, changes);
    assert.ok(!sql.some(query => /INSERT|UPDATE|DELETE|IMMEDIATE|integrity_check|foreign_key_check/i.test(query)));
    assert.equal(f.store.db.isTransaction, false);
    assert.deepEqual(await checkReadiness(f.base), { status: 'ready', schema_version: version });
  });
  test(`[${schema}] readiness는 버전·FK·읽기 실패에 상세 정보 없는 503을 반환하고 health는 DB와 독립적이다`, async t => {
    const f = await fixture(t, schema);
    const notReady = async () => {
      const r = await f.get('/api/v1/readiness');
      assert.equal(r.status, 503); assert.equal(r.body.code, 'NOT_READY'); assert.equal(r.headers.get('retry-after'), '1');
      assert.deepEqual(Object.keys(r.body).sort(), ['code', 'error']);
      assert.equal((await f.get('/api/v1/health')).status, 200);
      await assert.rejects(checkReadiness(f.base));
    };
    f.store.db.exec('PRAGMA user_version=999'); await notReady();
    f.store.db.exec(`PRAGMA user_version=${version}; PRAGMA foreign_keys=OFF`); await notReady();
    f.store.db.exec('PRAGMA foreign_keys=ON'); assert.equal((await f.get('/api/v1/readiness')).status, 200);
    f.store.close(); await notReady();
  });
  test(`[${schema}] WAL writer 잠금 중 readiness는 무쓰기 읽기를 수행한다`, async t => {
    let f, worker;
    const dir = await temporary(t, async () => {
      if (worker && worker.threadId !== -1) await worker.terminate();
      await f?.shutdown(100);
    });
    f = await fixture(t, schema, { dbPath: join(dir, 'locked.sqlite') });
    worker = new Worker(new URL('./helpers/sqlite-lock-worker.mjs', import.meta.url), { workerData: { path: join(dir, 'locked.sqlite') } });
    assert.deepEqual(await once(worker, 'message'), ['locked']);
    const before = f.store.get('SELECT total_changes() AS n').n;
    assert.equal((await f.get('/api/v1/readiness')).status, 200);
    assert.equal(f.store.get('SELECT total_changes() AS n').n, before);
    const exited = once(worker, 'exit'); worker.postMessage('release'); await exited;
  });
  test(`[${schema}] 종료 중 수락된 probe는 503이고 shutdown 반복 호출은 같은 완료를 기다린다`, async t => {
    const f = await fixture(t, schema);
    let closing;
    f.server.prependOnceListener('request', () => { closing = f.shutdown(1000); });
    const response = await f.get('/api/v1/readiness');
    assert.equal(response.status, 503); assert.equal(response.body.code, 'NOT_READY');
    assert.equal(f.shutdown(), closing); await closing;
    assert.equal(f.store.db.isOpen, false); assert.equal(f.server.listening, false);
    assert.equal(f.limiter.stats().ips, 0);
  });
  test(`[${schema}] 끝나지 않은 요청은 종료 예산 뒤 연결을 닫고 DB를 해제한다`, async t => {
    const f = await fixture(t, schema);
    const socket = createConnection({ host: '127.0.0.1', port: f.server.address().port });
    socket.on('error', () => {}); t.after(() => socket.destroy());
    await once(socket, 'connect');
    const requested = once(f.server, 'request');
    socket.write('POST /api/auth/login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 999\r\n\r\n{');
    await requested;
    const began = performance.now(); await f.shutdown(80);
    assert.ok(performance.now() - began < 2500); assert.equal(f.store.db.isOpen, false);
  });
  test(`[${schema}] 수락된 로그인은 종료 예산 안에서 완료한 뒤 DB를 닫는다`, async t => {
    const f = await fixture(t, schema);
    const body = JSON.stringify({ email: 'demo@temp.local', password: 'TempDemo123!' });
    const accepted = once(f.server, 'request');
    const pending = request(f.base + '/api/auth/login', { method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
    const response = once(pending, 'response'); pending.flushHeaders(); await accepted;
    const closing = f.shutdown(2000); pending.end(body);
    const [res] = await response; assert.equal(res.statusCode, 200);
    assert.match(res.headers['set-cookie'][0], /temp_session=/); res.resume(); await once(res, 'end');
    await closing; assert.equal(f.store.db.isOpen, false);
  });
  test(`[${schema}] SIGINT/SIGTERM 경로는 수신 종료와 시그널 리스너 정리를 수행한다`, async t => {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const signals = new EventEmitter();
      const app = await startServer({ runtimeEnv: { PORT: '0' }, appOptions: { dbPath: ':memory:', schema, demo: true }, signalSource: signals, log: () => {} });
      t.after(() => app.shutdown(100));
      const closed = once(app.server, 'close'); signals.emit(signal); await closed;
      assert.equal(app.store.db.isOpen, false); assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0);
    }
  });
  test(`[${schema}] 실제 자식 프로세스는 환경 파일로 실행하고 종료/재시작 후 DB·세션을 보존한다`, async t => {
    let child;
    const dir = await temporary(t, async () => {
      if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    }), dbPath = join(dir, 'persistent.sqlite'), envFile = join(dir, 'team.env');
    const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
    await writeFile(envFile, template.replace('PORT=3000', 'PORT=0').replace('DB_SCHEMA=model', `DB_SCHEMA=${schema}`).replace('DB_PATH=data/team-local.sqlite', `DB_PATH="${dbPath.replaceAll('\\', '/')}"`));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:HOST|PORT|NODE_ENV|DB_PATH|DB_SCHEMA|DEMO_MODE|PUBLIC_ORIGIN|PROXY_.+|SHUTDOWN_TIMEOUT_MS|TEMP_ADMIN_.+|QUEUE_.+|LIMIT_.+)$/i.test(key)));
    const start = async () => {
      child = fork(new URL('./helpers/runtime-child.mjs', import.meta.url), [], { cwd: root, env, execArgv: [`--env-file=${envFile}`], silent: true });
      let error = ''; child.stderr.on('data', data => { error += data; });
      const result = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(`child exited: ${error}`); })]);
      return `http://127.0.0.1:${result[0].port}`;
    };
    const stop = async signal => { const exited = once(child, 'exit'); child.send(signal); assert.deepEqual(await exited, [0, null]); };
    let base = await start();
    assert.equal((await checkReadiness(base)).schema_version, version);
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'demo@temp.local', password: 'TempDemo123!' }) });
    assert.equal(login.status, 200); const data = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0];
    await stop('SIGTERM'); base = await start();
    const session = await (await fetch(base + '/api/session', { headers: { Cookie: cookie } })).json();
    assert.equal(session.user.id, data.user.id); assert.equal(session.csrf, data.csrf);
    const status = spawn(process.execPath, ['scripts/status.mjs', base], { cwd: root, env });
    let out = ''; status.stdout.on('data', chunk => { out += chunk; });
    assert.deepEqual(await once(status, 'exit'), [0, null]); assert.equal(JSON.parse(out).status, 'ready');
    for (const path of ['/.env', '/.env.example', '/data/team-local.sqlite', '/data/temp.sqlite', '/package.json']) assert.equal((await fetch(base + path)).status, 404);
    await stop('SIGINT');
  });
}

test('상태 확인은 자격증명·잘못된 프로토콜·경로가 있는 주소를 거부한다', async () => {
  for (const base of ['file:///tmp/test', 'http://user:secret@localhost', 'http://localhost/other', 'http://localhost/?x=1']) await assert.rejects(checkReadiness(base));
});
