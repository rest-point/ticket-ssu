import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, link, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createServer as httpsServer, request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createQuickTunnel, createTunnelBridge, tunnelOptionsFromEnv } from '../lib/quick-tunnel.mjs';
import { launchCloudflared, quickTunnelOrigin } from '../lib/cloudflared.mjs';
import { createTestCertificate } from './helpers/tls-proxy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const origin = 'https://unit-test-ticket.trycloudflare.com';
const adminPassword = 'OperatorTestOnly123!';
const environment = path => ({ NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0', TUNNEL_PORT: '0', DB_PATH: path, DB_SCHEMA: 'model', DEMO_MODE: 'false',
  TEMP_ADMIN_EMAIL: 'operator@example.test', TEMP_ADMIN_PASSWORD: adminPassword, SHUTDOWN_TIMEOUT_MS: '100' });
async function temporary(t, close = async () => {}) {
  const dir = await mkdtemp(join(tmpdir(), 'temp-quick-test-'));
  t.after(async () => { await close(); assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep + 'temp-quick-test-')); await rm(dir, { recursive: true, force: true }); });
  return dir;
}
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
async function close(server) { if (!server) return; await new Promise(resolveClose => { server.close(resolveClose); server.closeAllConnections(); }); }
function send(port, method = 'GET', path = '/api/concerts', { headers = {}, body, tls } = {}) {
  return new Promise((resolveResponse, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const req = (tls ? httpsRequest : request)({ host: '127.0.0.1', port, method, path, agent: false,
      ...(tls ? { ca: tls, servername: 'localhost', rejectUnauthorized: true } : {}),
      headers: { ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }), ...headers } }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', part => { raw += part; });
      res.on('end', () => { let body; try { body = JSON.parse(raw); } catch { body = raw; } resolveResponse({ status: res.statusCode, body, headers: res.headers }); });
      res.on('error', reject);
    });
    req.setTimeout(3000, () => req.destroy(new Error('test request timeout'))); req.on('error', reject); req.end(text);
  });
}
function fakeProcess(mode = 'ready', inspect = () => {}) {
  return (executable, args, options) => {
    inspect(executable, args, options);
    return spawn(process.execPath, [fileURLToPath(new URL('./helpers/fake-cloudflared.mjs', import.meta.url)), mode], options);
  };
}
async function fakeLaunch(options) { return launchCloudflared({ ...options, spawnProcess: fakeProcess() }); }

test('Quick Tunnel 출처는 단일 trycloudflare HTTPS 출처로 제한한다', () => {
  assert.equal(quickTunnelOrigin(origin), origin);
  for (const bad of ['http://a.trycloudflare.com', 'https://trycloudflare.com', `${origin}/`, `${origin}:443`, `${origin}/path`, `${origin}@evil.test`,
    'https://a.trycloudflare.com.evil.test', 'https://-bad.trycloudflare.com', 'https://UPPER.trycloudflare.com', 'https://127.0.0.1']) assert.throws(() => quickTunnelOrigin(bad));
});

test('위험 설정은 DB/네트워크를 열기 전에 거부한다', async t => {
  const dir = await temporary(t), path = join(dir, 'never.sqlite'), env = environment(path);
  for (const change of [{ NODE_ENV: 'development' }, { DEMO_MODE: 'true' }, { HOST: '0.0.0.0' }, { PROXY_IP: '::1' }, { PUBLIC_ORIGIN: origin },
    { PROXY_TOKEN: 'a'.repeat(64) }, { DB_PATH: 'data/temp.sqlite' }, { DB_PATH: 'public/exposed.sqlite' }, { DB_PATH: ':memory:' }, { DB_SCHEMA: 'wrong' },
    { TEMP_ADMIN_PASSWORD: '' }, { TEMP_ADMIN_EMAIL: 'admin@temp.local' }, { TUNNEL_PORT: '3', PORT: '3' }, { TUNNEL_PROTOCOL: 'invalid' },
    { TUNNEL_TIMEOUT_MS: '999999' }, { LIMIT_IP_BURST: '0' }, { QUEUE_ACTIVE_LIMIT: '0' }]) {
    let verified = false;
    assert.throws(() => createQuickTunnel({ env: { ...env, ...change }, verify: async () => { verified = true; } }));
    assert.equal(verified, false); assert.equal(existsSync(path), false);
  }
});

test('DB의 기존 하드 링크·보호 파일의 심볼릭 링크 경로를 거부한다', async t => {
  const dir = await temporary(t), original = join(dir, 'source.sqlite'), alias = join(dir, 'alias.sqlite');
  await writeFile(original, 'owned test bytes'); await link(original, alias);
  assert.throws(() => tunnelOptionsFromEnv(environment(alias)), /TUNNEL_DB_PROTECTED/);
  // Use a directory junction on Windows: creating a file symlink can require admin.
  const linked = join(dir, 'project-data');
  await symlink(resolve(root, 'data'), linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => tunnelOptionsFromEnv(environment(join(linked, 'temp.sqlite'))), /TUNNEL_DB_PROTECTED/);
  assert.equal(await readFile(original, 'utf8'), 'owned test bytes');
});

test('대상이 없는 디렉터리 링크를 새 DB 경로로 해석하지 않는다', async t => {
  const dir = await temporary(t), missing = join(dir, 'missing-target'), alias = join(dir, 'dangling-data');
  await symlink(missing, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => tunnelOptionsFromEnv(environment(join(alias, 'future.sqlite'))), /TUNNEL_DB_PROTECTED/);
  assert.equal(existsSync(missing), false);
});

test('실행 파일 검증 실패는 중계/자식/DB를 만들지 않고 출력에서 비밀값을 제외한다', async t => {
  const dir = await temporary(t), path = join(dir, 'never.sqlite'), logs = []; let launched = false;
  const tunnel = createQuickTunnel({ env: environment(path), verify: async () => { throw new Error(adminPassword); }, launch: async () => { launched = true; }, log: value => logs.push(value) });
  await assert.rejects(tunnel.ready, /TUNNEL_START_FAILED/); await tunnel.stop();
  assert.equal(launched, false); assert.equal(existsSync(path), false); assert.equal(tunnel.bridgePort, undefined);
  assert.ok(!JSON.stringify(logs).includes(adminPassword)); assert.equal((await tunnel.closed).cleanupPassed, true);
});

test('cloudflared는 분할 로그의 URL과 등록을 모두 기다리고 비밀 환경/기존 설정을 넘기지 않는다', async t => {
  let child, directory;
  t.after(() => child?.stop());
  child = await launchCloudflared({ port: 3001, timeoutMs: 2000, spawnProcess: fakeProcess('ready', (_exe, args, options) => {
    directory = options.cwd;
    assert.ok(args.includes('--no-autoupdate')); assert.ok(args.includes('--config')); assert.ok(args.includes('127.0.0.1:0'));
    assert.equal(options.env.TEMP_ADMIN_PASSWORD, undefined); assert.equal(options.env.TUNNEL_TOKEN, undefined);
    assert.equal(options.env.HOME, directory); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.ok(!JSON.stringify(args).includes(adminPassword));
  }) });
  assert.equal(await child.ready, origin); assert.equal(await readFile(join(directory, 'config.yml'), 'utf8'), '{}\n');
  await child.stop(); await child.stop(); assert.equal(existsSync(directory), false);
});
for (const [mode, code] of [['url-only', 'TUNNEL_START_TIMEOUT'], ['exit', 'TUNNEL_PROCESS_EXITED'], ['large', 'TUNNEL_LOG_LIMIT']]) {
  test(`cloudflared ${mode}는 실패하고 자식/설정을 정리한다`, async t => {
    let directory; const failures = [];
    const child = await launchCloudflared({ port: 3001, timeoutMs: 500, onFailure: code => failures.push(code),
      spawnProcess: fakeProcess(mode, (_exe, _args, options) => { directory = options.cwd; }) });
    t.after(() => child.stop());
    await assert.rejects(child.ready, new RegExp(code)); await child.stop();
    assert.deepEqual(failures, [code]); assert.equal(existsSync(directory), false);
  });
}
for (const [mode, code] of [['changed', 'TUNNEL_ORIGIN_CHANGED'], ['disconnect', 'TUNNEL_CONNECTION_FAILED']]) {
  test(`준비 후 ${mode} 때 기존 출처를 유지하지 않고 자식을 종료한다`, async t => {
    let failed, processChild; const failures = [], failure = new Promise(resolveFailure => { failed = resolveFailure; });
    const child = await launchCloudflared({ port: 3001, timeoutMs: 2000, onFailure: code => { failures.push(code); failed(code); },
      spawnProcess: (...args) => { processChild = fakeProcess(mode)(...args); return processChild; } });
    t.after(() => child.stop()); assert.equal(await child.ready, origin);
    processChild.stderr.emit('data', Buffer.from(JSON.stringify({ level: 'error', message: 'Request failed', error: 'context canceled by visitor' }) + '\n'));
    assert.deepEqual(failures, [], 'a visitor request error must not terminate the tunnel');
    assert.equal(await failure, code); await child.stop();
  });
}

test('중계는 준비 전503·고정 대상·헤더 제거·Secure 쿠키 전달을 적용한다', async t => {
  const bridge = createTunnelBridge(); let backend, received;
  t.after(async () => { await bridge.stop(); await close(backend); });
  const port = await listen(bridge.server); assert.equal((await send(port)).status, 503);
  backend = createServer((req, res) => { received = req.headers; res.writeHead(200, { 'set-cookie': 'temp_session=test; Secure; HttpOnly; SameSite=Lax', 'x-temp-proxy-token': 'hidden' }); res.end('ok'); });
  const backendPort = await listen(backend), token = 'a'.repeat(64);
  bridge.activate({ origin, port: backendPort, token });
  const reply = await send(port, 'POST', '/api/auth/login', { body: {}, headers: { host: 'evil.test', origin, cookie: 'example=one', 'x-csrf-token': 'preserved',
    forwarded: 'for=1.2.3.4', 'x-forwarded-for': '5.6.7.8', 'cf-connecting-ip': '9.10.11.12', 'x-temp-client-ip': '9.9.9.9', 'x-temp-proxy-token': 'forged',
    connection: 'x-remove-me', 'x-remove-me': 'private' } });
  assert.equal(reply.status, 200); assert.equal(received.host, new URL(origin).host);
  assert.equal(received['x-temp-client-ip'], '127.0.0.1'); assert.equal(received['x-temp-proxy-token'], token);
  assert.equal(received.origin, origin); assert.equal(received['x-csrf-token'], 'preserved'); assert.equal(received.cookie, 'example=one');
  for (const name of ['forwarded', 'x-forwarded-for', 'cf-connecting-ip', 'x-remove-me']) assert.equal(received[name], undefined);
  assert.match(reply.headers['set-cookie'][0], /Secure/); assert.equal(reply.headers['x-temp-proxy-token'], undefined);
  for (const path of ['http://evil.test/api', '//evil.test/api', '/\\evil']) assert.equal((await send(port, 'GET', path)).status, 400);
  assert.equal((await send(port, 'TRACE')).status, 400);
  bridge.gate(); assert.equal((await send(port)).status, 503);
});

async function fixture(t, schema, extra = {}) {
  let tunnel, edge;
  const dir = await temporary(t, async () => { await close(edge); await tunnel?.stop(); });
  const path = join(dir, 'demo.sqlite'), logs = [], signals = new EventEmitter();
  tunnel = createQuickTunnel({ env: { ...environment(path), DB_SCHEMA: schema, ...extra }, verify: async () => {}, launch: fakeLaunch, signalSource: signals, log: value => logs.push(value) });
  await tunnel.ready;
  const { key, cert } = await createTestCertificate(dir);
  edge = httpsServer({ key, cert }, (req, res) => {
    // Emulate cloudflared transport only: deliberately forward visitor metadata.
    const upstream = request({ host: '127.0.0.1', port: tunnel.bridgePort, method: req.method, path: req.url, headers: req.headers, agent: false }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  const port = await listen(edge);
  return { tunnel, dir, path, logs, signals, send: (method, path, options = {}) => send(port, method, path, { ...options, tls: cert }) };
}
for (const schema of ['legacy', 'model']) {
  test(`[${schema}] TLS→가짜 터널→중계→API의 회원/예매/취소와 Origin/CSRF·직접 우회 차단`, async t => {
    const f = await fixture(t, schema);
    assert.equal((await send(f.tunnel.apiPort)).status, 403);
    const signup = await f.send('POST', '/api/auth/signup', { headers: { origin }, body: {
      email: 'member@example.test', password: 'MemberTestOnly123!', name: '검증회원', phone: '01000000000', terms: true, ageConfirmed: true } });
    assert.equal(signup.status, 201); assert.match(signup.headers['set-cookie'][0], /Secure/);
    let cookie = signup.headers['set-cookie'][0].split(';')[0], csrf = signup.body.csrf;
    let headers = { origin, cookie, 'x-csrf-token': csrf };
    assert.equal((await f.send('POST', '/api/auth/logout', { headers: { ...headers, 'x-csrf-token': 'wrong' }, body: {} })).status, 403);
    assert.equal((await f.send('POST', '/api/auth/logout', { headers: { ...headers, origin: 'https://evil.test' }, body: {} })).status, 403);
    assert.equal((await f.send('POST', '/api/auth/logout', { headers, body: {} })).status, 200);
    const login = await f.send('POST', '/api/auth/login', { headers: { origin }, body: { email: 'member@example.test', password: 'MemberTestOnly123!' } });
    assert.equal(login.status, 200); cookie = login.headers['set-cookie'][0].split(';')[0]; csrf = login.body.csrf;
    headers = { origin, cookie, 'x-csrf-token': csrf, 'x-temp-proxy-token': 'forged', 'x-forwarded-for': '203.0.113.9' };
    const concerts = await f.send('GET', '/api/concerts', { headers }), pid = concerts.body.concerts[0].performances[0].id;
    const queue = await f.send('POST', `/api/v1/performances/${pid}/queue`, { headers, body: {} });
    assert.equal(queue.status, 200); headers['x-admission-token'] = queue.body.admission_token;
    const hold = await f.send('PUT', `/api/performances/${pid}/hold`, { headers, body: { seatIds: ['A-01'] } }); assert.equal(hold.status, 200);
    const booked = await f.send('POST', '/api/bookings', { headers, body: { holdId: hold.body.hold.id, buyerName: '검증회원', buyerPhone: '01000000000', delivery: 'mobile', agreed: true, paymentMethod: 'demo' } });
    assert.equal(booked.status, 201); const id = booked.body.booking.id;
    assert.equal((await f.send('GET', '/api/bookings', { headers })).body.bookings[0].id, id);
    assert.equal((await f.send('POST', `/api/bookings/${id}/cancel`, { headers, body: {} })).status, 200);
    assert.equal((await f.send('GET', '/api/bookings', { headers })).body.bookings[0].status, 'cancelled');
    assert.equal((await f.send('POST', '/api/auth/logout', { headers, body: {} })).status, 200);
    const apiPort = f.tunnel.apiPort, bridgePort = f.tunnel.bridgePort;
    f.signals.emit('SIGINT'); await f.tunnel.closed; await f.tunnel.stop();
    await assert.rejects(send(apiPort)); await assert.rejects(send(bridgePort)); assert.equal(existsSync(f.path), true);
    assert.equal(f.signals.listenerCount('SIGINT'), 0); assert.equal((await f.tunnel.closed).cleanupPassed, true);
    const log = JSON.stringify(f.logs); for (const secret of [adminPassword, csrf, cookie, id]) assert.ok(!log.includes(secret));
  });
}

test('위조 IP 헤더를 바꿔도 공유 로그인 예산429를 우회하지 못한다', async t => {
  const f = await fixture(t, 'model', { LIMIT_AUTH_ATTEMPTS: '2' });
  for (let i = 0; i < 3; i++) {
    const reply = await f.send('POST', '/api/auth/login', { headers: { origin, 'x-forwarded-for': `203.0.113.${i + 1}`, 'cf-connecting-ip': `192.0.2.${i + 1}` },
      body: { email: 'nobody@example.test', password: 'WrongPassword123!' } });
    assert.equal(reply.status, i === 2 ? 429 : 401); if (i === 2) assert.ok(Number(reply.headers['retry-after']) > 0);
  }
});

test('준비 중 Ctrl+C는 중계/자식을 정리하며 DB를 생성하지 않는다', async t => {
  const signals = new EventEmitter(), dir = await temporary(t), path = join(dir, 'never.sqlite'); let started;
  const launched = new Promise(resolveStarted => { started = resolveStarted; });
  const tunnel = createQuickTunnel({ env: environment(path), verify: async () => {}, signalSource: signals, log: () => {}, launch: async options => {
    const child = await launchCloudflared({ ...options, spawnProcess: fakeProcess('url-only') }); started(); return child;
  } });
  t.after(() => tunnel.stop()); await launched; signals.emit('SIGINT'); await assert.rejects(tunnel.ready);
  assert.equal((await tunnel.closed).cleanupPassed, true); assert.equal(existsSync(path), false); assert.equal(tunnel.bridgePort, undefined);
});

test('준비 후 URL 변경은 중계/API를 종료하고 DB를 보존한다', async t => {
  let tunnel, processChild;
  const dir = await temporary(t, () => tunnel?.stop()), path = join(dir, 'demo.sqlite');
  tunnel = createQuickTunnel({ env: environment(path), verify: async () => {}, log: () => {}, launch: options => launchCloudflared({ ...options,
    spawnProcess: (...args) => { processChild = fakeProcess()(...args); return processChild; } }) });
  await tunnel.ready; const port = tunnel.bridgePort;
  processChild.stderr.emit('data', Buffer.from(JSON.stringify({ message: 'https://changed-test-ticket.trycloudflare.com' }) + '\n'));
  const report = await tunnel.closed; assert.equal(report.reason, 'tunnel-failed'); assert.equal(report.cleanupPassed, true);
  await assert.rejects(send(port)); assert.equal(existsSync(path), true);
});

test('API 바인딩 실패는 터널/중계를 정리하고 전용 DB를 보존한다', async t => {
  const blocker = createServer((_req, res) => res.end()); const port = await listen(blocker);
  let tunnel; const dir = await temporary(t, async () => { await tunnel?.stop(); await close(blocker); });
  const path = join(dir, 'dedicated.sqlite');
  tunnel = createQuickTunnel({ env: { ...environment(path), PORT: String(port) }, verify: async () => {}, launch: fakeLaunch, log: () => {} });
  await assert.rejects(tunnel.ready); assert.equal((await tunnel.closed).cleanupPassed, true); assert.equal(tunnel.bridgePort, undefined); assert.equal(existsSync(path), true);
});

test('실행 파일 spawn 오류도 원시 경로를 노출하지 않고 설정을 정리한다', async t => {
  let directory;
  const child = await launchCloudflared({ port: 3001, timeoutMs: 2000, spawnProcess: (_exe, _args, options) => {
    directory = options.cwd; return spawn(join(directory, 'does-not-exist.exe'), [], options);
  } });
  t.after(() => child.stop()); await assert.rejects(child.ready, /TUNNEL_SPAWN_FAILED/); await child.stop(); assert.equal(existsSync(directory), false);
});

test('중계 종료는 대기 중 upstream과 CONNECT/Upgrade 소켓을 남기지 않는다', async t => {
  const bridge = createTunnelBridge(), backend = createServer(() => {});
  t.after(async () => { await bridge.stop(); await close(backend); });
  const backendPort = await listen(backend), port = await listen(bridge.server);
  bridge.activate({ origin, port: backendPort, token: 'a'.repeat(64) });
  for (const [method, expected] of [['CONNECT', 405], ['GET', 400]]) {
    const socket = connect(port, '127.0.0.1'); socket.setTimeout(2000, () => socket.destroy());
    await once(socket, 'connect'); let reply = '';
    socket.on('data', data => { reply += data; });
    socket.write(`${method} / HTTP/1.1\r\nHost: example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    await once(socket, 'close'); assert.match(reply, new RegExp(`HTTP/1.1 ${expected}`));
  }
  const pending = send(port); const result = pending.then(value => value.status, () => 'closed');
  await once(backend, 'request'); await bridge.stop(); assert.ok(['closed', 502].includes(await result));
});

for (const schema of ['legacy', 'model']) {
  test(`[${schema}] 여러 회원 로그인과 새 터널 재시작은 관리자 해시·세션·회원 ID를 보존한다`, async t => {
    let restarted; t.after(() => restarted?.stop());
    const f = await fixture(t, schema);
    const signups = await Promise.all([1, 2].map(i => f.send('POST', '/api/auth/signup', { headers: { origin }, body: {
      email: `restart${i}@example.test`, password: 'MemberTestOnly123!', name: '재시작회원', phone: '01000000000', terms: true, ageConfirmed: true } })));
    for (const member of signups) assert.equal(member.status, 201);
    const members = await Promise.all([1, 2].map(i => f.send('POST', '/api/auth/login', { headers: { origin }, body: {
      email: `restart${i}@example.test`, password: 'MemberTestOnly123!' } })));
    for (const member of members) assert.equal(member.status, 200);
    const readAdmin = () => { const db = new DatabaseSync(f.path, { readOnly: true }); try { return db.prepare("SELECT id,password_hash,role FROM users WHERE role='admin'").get(); } finally { db.close(); } };
    const before = readAdmin(); await f.tunnel.stop();
    let fail, stopped = false;
    const nextOrigin = 'https://restart-ticket.trycloudflare.com';
    // Lifecycle injection emulates the next independently assigned URL.
    restarted = createQuickTunnel({ env: { ...environment(f.path), DB_SCHEMA: schema }, verify: async () => {}, log: () => {}, launch: async options => {
      fail = options.onFailure; return { ready: Promise.resolve(nextOrigin), stop: async () => { stopped = true; } };
    } });
    await restarted.ready;
    assert.deepEqual(readAdmin(), before);
    for (const member of members) {
      const cookie = member.headers['set-cookie'][0].split(';')[0];
      const reply = await send(restarted.bridgePort, 'GET', '/api/session', { headers: { cookie } });
      assert.equal(reply.status, 200); assert.equal(reply.body.user.id, member.body.user.id);
      assert.equal((await send(restarted.bridgePort, 'POST', '/api/auth/logout', { headers: { cookie, origin, 'x-csrf-token': member.body.csrf }, body: {} })).status, 403);
    }
    fail('TUNNEL_PROCESS_EXITED'); await restarted.closed; assert.equal(stopped, true); assert.equal(existsSync(f.path), true);
  });
}
