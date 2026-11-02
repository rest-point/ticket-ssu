import { createServer, request } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync, statSync, lstatSync } from 'node:fs';
import { resolve, dirname, basename, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';
import { validateAdminCredentials } from './store.mjs';
import { runtimeOptionsFromEnv } from './runtime.mjs';
import { PerformanceQueue, queueOptionsFromEnv } from './performance-queue.mjs';
import { RequestLimiter, limitOptionsFromEnv } from './request-limiter.mjs';
import { launchCloudflared, verifyCloudflared, quickTunnelOrigin } from './cloudflared.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const normal = value => process.platform === 'win32' ? value.toLowerCase() : value;
function canonical(value) {
  let path = resolve(value); const tail = [];
  while (!existsSync(path)) {
    // existsSync follows links; a dangling link must not become a new lexical path.
    try { if (lstatSync(path).isSymbolicLink()) throw new Error('TUNNEL_DB_PROTECTED'); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    const parent = dirname(path);
    if (parent === path) throw new Error('TUNNEL_DB_PATH');
    tail.unshift(basename(path)); path = parent;
  }
  return resolve(realpathSync(path), ...tail);
}
const within = (parent, child) => { const part = relative(normal(parent), normal(child)); return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part)); };
export function tunnelOptionsFromEnv(env = process.env) {
  const runtime = runtimeOptionsFromEnv(env);
  if (env.NODE_ENV !== 'production' || env.DEMO_MODE !== 'false' || runtime.host !== '127.0.0.1' ||
      (env.PROXY_IP && env.PROXY_IP !== '127.0.0.1') || env.PUBLIC_ORIGIN || env.PROXY_TOKEN) throw new Error('TUNNEL_ENV_BOUNDARY');
  if (!env.DB_PATH || !env.DB_PATH.endsWith('.sqlite') || /^(?:\\\\|\/\/)/.test(env.DB_PATH)) throw new Error('TUNNEL_DB_PATH');
  const dbPath = canonical(env.DB_PATH), project = canonical(root), protectedDb = canonical(resolve(root, 'data/temp.sqlite'));
  if (normal(dbPath) === normal(protectedDb) || (within(project, dbPath) && !within(resolve(project, 'data'), dbPath)) ||
      (existsSync(dbPath) && (!statSync(dbPath).isFile() || statSync(dbPath).nlink > 1))) throw new Error('TUNNEL_DB_PROTECTED');
  if (!['legacy', 'model'].includes(env.DB_SCHEMA)) throw new Error('TUNNEL_DB_SCHEMA');
  if (!validateAdminCredentials(env.TEMP_ADMIN_EMAIL, env.TEMP_ADMIN_PASSWORD)) throw new Error('TUNNEL_ADMIN_REQUIRED');
  if (['demo@temp.local', 'admin@temp.local'].includes(env.TEMP_ADMIN_EMAIL.trim().toLowerCase())) throw new Error('TUNNEL_ADMIN_PUBLIC');
  const integer = (key, fallback, min, max) => {
    const raw = env[key] ?? String(fallback);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) throw new Error('TUNNEL_ENV_RANGE');
    return Number(raw);
  };
  const bridgePort = integer('TUNNEL_PORT', 3001, 0, 65535);
  if (bridgePort && bridgePort === runtime.port) throw new Error('TUNNEL_PORT_CONFLICT');
  const timeoutMs = integer('TUNNEL_TIMEOUT_MS', 30000, 100, 120000), protocol = env.TUNNEL_PROTOCOL ?? 'auto';
  if (!['auto', 'quic', 'http2'].includes(protocol)) throw new Error('TUNNEL_PROTOCOL');
  const queueOptions = queueOptionsFromEnv(env), limitOptions = limitOptionsFromEnv(env);
  new PerformanceQueue(queueOptions).close(); new RequestLimiter(limitOptions).close();
  return { runtime, dbPath, bridgePort, timeoutMs, protocol, appOptions: {
    dbPath, schema: env.DB_SCHEMA, demo: false, secureCookies: true,
    adminEmail: env.TEMP_ADMIN_EMAIL, adminPassword: env.TEMP_ADMIN_PASSWORD, queueOptions, limitOptions
  } };
}

const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function cleanHeaders(headers) {
  const blocked = new Set([...hop, ...String(headers.connection ?? '').toLowerCase().split(',').map(v => v.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key) && !/^(?:forwarded$|x-forwarded-|x-temp-|cf-)/.test(key)));
}
export function createTunnelBridge() {
  let target, stopping;
  const upstreams = new Set();
  const server = createServer((req, res) => {
    const end = status => { res.writeHead(status, { 'Cache-Control': 'no-store', Connection: 'close' }); res.end(); };
    if (!target) { end(503); return; }
    if (!/^\/(?!\/)/.test(req.url) || /[\\#\x00-\x20]/.test(req.url) || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) { end(400); return; }
    const headers = cleanHeaders(req.headers);
    Object.assign(headers, { host: new URL(target.origin).host, 'x-temp-proxy-token': target.token, 'x-temp-client-ip': '127.0.0.1' });
    const upstream = request({ host: '127.0.0.1', port: target.port, path: req.url, method: req.method, headers, agent: false }, response => {
      res.writeHead(response.statusCode, cleanHeaders(response.headers)); response.pipe(res);
      response.on('error', () => res.destroy());
    });
    upstreams.add(upstream); upstream.on('close', () => upstreams.delete(upstream));
    upstream.on('error', () => { if (!res.headersSent && !res.destroyed) end(502); else res.destroy(); });
    upstream.setTimeout(15000, () => upstream.destroy());
    req.on('aborted', () => upstream.destroy()); req.on('error', () => upstream.destroy());
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.on('connect', (_req, socket) => socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n', () => socket.destroy()));
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n', () => socket.destroy()));
  const gate = () => { target = undefined; };
  return { server, gate,
    activate({ origin, port, token }) {
      quickTunnelOrigin(origin);
      if (stopping || !Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{64}$/.test(token)) throw new Error('TUNNEL_BRIDGE_TARGET');
      target = Object.freeze({ origin, port, token });
    },
    stop() {
      gate();
      return stopping ??= new Promise((resolveClose, reject) => {
        for (const upstream of upstreams) upstream.destroy();
        server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolveClose());
        server.closeAllConnections();
      });
    }
  };
}

// Factories are injected only by tests; CLI always uses the checksum-pinned tool.
export function createQuickTunnel({ env = process.env, verify = verifyCloudflared, launch = launchCloudflared, signalSource = process, log = console.log } = {}) {
  const options = tunnelOptionsFromEnv(env), bridge = createTunnelBridge();
  let app, child, reason = 'stopped', aborted = false, cleanupPromise, stopPromise, resolveClosed;
  const closed = new Promise(resolveValue => { resolveClosed = resolveValue; });
  const check = () => { if (aborted) throw new Error('TUNNEL_STOPPED'); };
  const cleanup = () => cleanupPromise ??= (async () => {
    bridge.gate();
    const results = await Promise.allSettled([bridge.stop(), child?.stop(), app?.shutdown(options.runtime.shutdownMs)]);
    for (const signal of ['SIGINT', 'SIGTERM']) signalSource.off(signal, onSignal);
    const report = { event: 'tunnel-stopped', reason, cleanupPassed: results.every(value => value.status === 'fulfilled'), databasePreserved: true };
    log(report); resolveClosed(report);
    if (!report.cleanupPassed) throw new Error('TUNNEL_CLEANUP_FAILED');
  })();
  const onSignal = () => { void stop('signal').catch(() => {}); };
  for (const signal of ['SIGINT', 'SIGTERM']) signalSource.on(signal, onSignal);
  const fail = () => { void stop('tunnel-failed').catch(() => {}); };
  bridge.server.on('error', fail);
  const startup = (async () => {
    await verify(); check();
    bridge.server.listen(options.bridgePort, '127.0.0.1'); await once(bridge.server, 'listening'); check();
    child = await launch({ port: bridge.server.address().port, timeoutMs: options.timeoutMs, protocol: options.protocol, onFailure: fail }); check();
    const origin = quickTunnelOrigin(await child.ready); check();
    // Recheck path aliases immediately before opening the dedicated database.
    if (tunnelOptionsFromEnv(env).dbPath !== options.dbPath) throw new Error('TUNNEL_DB_CHANGED');
    const token = randomBytes(32).toString('hex');
    app = await startServer({ runtimeEnv: { HOST: '127.0.0.1', PORT: String(options.runtime.port), SHUTDOWN_TIMEOUT_MS: String(options.runtime.shutdownMs) },
      appOptions: { ...options.appOptions, boundaryOptions: { publicOrigin: origin, proxyToken: token, proxyIp: '127.0.0.1' } },
      signalSource: new EventEmitter(), log: () => {} }); check();
    app.server.on('error', fail);
    bridge.activate({ origin, port: app.server.address().port, token });
    const report = { event: 'tunnel-ready', origin, clientIpPolicy: 'shared-loopback-budget', externalNetworkVerified: false };
    log(report); return report;
  })();
  const ready = startup.catch(async () => { aborted = true; if (reason === 'stopped') reason = 'start-failed'; await cleanup(); throw new Error('TUNNEL_START_FAILED'); });
  ready.catch(() => {});
  function stop(cause = 'stopped') {
    if (stopPromise) return stopPromise;
    reason = cause; aborted = true; bridge.gate();
    // Interrupt a pending child.ready before waiting for startup to settle.
    const interrupt = child?.stop();
    stopPromise = (async () => { await Promise.allSettled([startup, interrupt]); await cleanup(); })();
    return stopPromise;
  }
  return { ready, stop, closed, get apiPort() { return app?.server.address()?.port; }, get bridgePort() { return bridge.server.address()?.port; } };
}
