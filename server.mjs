import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { Store, AppError, validateAdminCredentials } from './lib/store.mjs';
import { ModelStore } from './lib/model-store.mjs';
import { API_BUSY_TIMEOUT_MS, retryDatabase, isDatabaseBusy, DatabaseBusyError } from './lib/db-retry.mjs';
import { PerformanceQueue, queueOptionsFromEnv } from './lib/performance-queue.mjs';
import { AdmissionService } from './lib/admission-service.mjs';
import { createHash } from 'node:crypto';
import { RequestLimiter, limitOptionsFromEnv } from './lib/request-limiter.mjs';
import { runtimeOptionsFromEnv } from './lib/runtime.mjs';
import { once } from 'node:events';
import { HttpBoundary, boundaryOptionsFromEnv } from './lib/http-boundary.mjs';
import { defaultDatabasePath, isDefaultDatabasePath, PUBLIC_DEMO_EMAILS } from './lib/project-identity.mjs';
const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = resolve(root, 'public');
const mutating = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
};
const security = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
};
async function jsonBody(req, optional = false) {
  if (optional && !req.headers['content-type'] && !req.headers['transfer-encoding'] && (!req.headers['content-length'] || req.headers['content-length'] === '0')) return {};
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError(415, 'JSON 요청이 필요합니다.');
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 16384) throw new AppError(413, '요청이 너무 큽니다.');
    chunks.push(chunk);
  }
  if (optional && bytes === 0) return {};
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString());
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw 0;
    return result;
  } catch {
    throw new AppError(400, '요청 내용을 확인해 주세요.');
  }
}
const cookieToken = req => /(?:^|;\s*)ticket_ssu_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
function decodePathId(value, message = '예매번호를 확인해 주세요.') {
  try { return decodeURIComponent(value); }
  catch { throw new AppError(400, message); }
}
export async function createApp({
  dbPath = process.env.DB_PATH || defaultDatabasePath(root),
  demo = process.env.DEMO_MODE !== 'false',
  now,
  holdMs,
  schema = process.env.DB_SCHEMA || 'legacy',
  secureCookies = process.env.NODE_ENV === 'production',
  adminEmail = process.env.TICKET_SSU_ADMIN_EMAIL,
  adminPassword = process.env.TICKET_SSU_ADMIN_PASSWORD,
  boundaryOptions = boundaryOptionsFromEnv(),
  queueOptions = queueOptionsFromEnv(),
  limitOptions = limitOptionsFromEnv()
} = {}) {
  validateAdminCredentials(adminEmail, adminPassword);
  const boundary = new HttpBoundary(boundaryOptions);
  const deployed = boundary.deployed || process.env.NODE_ENV === 'production';
  if (boundary.deployed && (demo || !secureCookies)) throw new Error('공개 HTTPS 실행은 DEMO_MODE=false와 Secure 쿠키가 필요합니다.');
  if (process.env.NODE_ENV === 'production' && !boundary.deployed) throw new Error('운영 실행은 PUBLIC_ORIGIN과 인증된 로컬 프록시 설정이 필요합니다.');
  if (deployed && dbPath !== ':memory:' && isDefaultDatabasePath(root, dbPath)) throw new Error('운영 실행에는 별도 DB_PATH가 필요합니다.');
  if (process.env.NODE_ENV === 'production' && demo) throw new Error('운영 실행 시 DEMO_MODE=false 설정이 필요합니다.');
  if (!['legacy', 'model'].includes(schema)) throw new Error('DB_SCHEMA는 legacy 또는 model이어야 합니다.');
  if (schema === 'model' && dbPath !== ':memory:' && isDefaultDatabasePath(root, dbPath)) throw new Error('model 모드에는 별도의 DB_PATH가 필요합니다. 기존 기본 DB는 변경하지 않습니다.');
  const queue = new PerformanceQueue({ now, ...queueOptions });
  const limiter = new RequestLimiter(limitOptions);
  const store = new (schema === 'model' ? ModelStore : Store)(dbPath, {
    now,
    holdMs
  });
  let admission;
  try {
    if (deployed && store.get(`SELECT id FROM users WHERE email IN (${PUBLIC_DEMO_EMAILS.map(() => '?').join(',')})`, ...PUBLIC_DEMO_EMAILS)) throw new Error('공개 데모 계정 없는 별도 DB가 필요합니다.');
    await store.seed({
      demo,
      adminEmail,
      adminPassword
    });
    if (deployed && !store.get("SELECT id FROM users WHERE role='admin' LIMIT 1")) throw new Error('초기 관리자가 필요합니다.');
    admission = new AdmissionService(store, queue);
  } catch (error) {
    queue.close();
    limiter.close();
    store.close();
    throw error;
  }
  store.db.exec(`PRAGMA busy_timeout=${API_BUSY_TIMEOUT_MS}`);
  let draining = false, closing;
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnect);
    const respond = (status, data, headers = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        ...security,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...headers
      });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url, 'http://localhost'),
        path = url.pathname;
      // Probes deliberately bypass sessions and business request budgets.
      if (req.method === 'GET' && path === '/api/v1/health') return respond(200, { status: 'ok' });
      if (req.method === 'GET' && path === '/api/v1/readiness') {
        try {
          if (draining) throw new Error('draining');
          return respond(200, store.readiness());
        } catch {
          return respond(503, { error: '서비스를 준비 중입니다. 잠시 후 다시 확인해 주세요.', code: 'NOT_READY' }, { 'Retry-After': '1' });
        }
      }
      const clientIp = boundary.clientIp(req);
      if (path.startsWith('/api/')) {
        // Forwarded headers are ignored; deployed custom IP requires peer+token.
        limiter.ip(clientIp);
        // 로그인·회원가입을 포함한 교차 출처 변경 요청을 차단한다.
        if (mutating.has(req.method)) {
          const origin = req.headers.origin;
          if (!boundary.allowsOrigin(origin, req.headers.host)) throw new AppError(403, '허용되지 않은 요청 출처입니다.');
          if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, '허용되지 않은 요청입니다.');
        }
        const token = cookieToken(req);
        const sessionKey = token ? createHash('sha256').update(token).digest('hex') : null;
        let session;
        const refreshSession = () => {
          session = store.session(token);
          if (mutating.has(req.method) && session && req.headers['x-csrf-token'] !== session.csrf) throw new AppError(403, '세션을 새로고침한 후 다시 시도해 주세요.');
        };
        const runDb = action => retryDatabase(() => { refreshSession(); return action(); }, { signal: controller.signal });
        await runDb(() => {});
        if (session) limiter.user(session.user.id);
        const requireUser = () => {
          if (!session) throw new AppError(401, '로그인 후 이용해 주세요.');
          return session.user;
        };
        if (req.method === 'GET' && path === '/api/session') return respond(200, {
          user: session?.user ?? null,
          csrf: session?.csrf ?? null,
          demo
        });
        if (req.method === 'POST' && ['/api/auth/login', '/api/auth/signup'].includes(path)) {
          limiter.auth(clientIp);
          const data = await jsonBody(req);
          const user = path.endsWith('signup') ? await store.register(data) : await store.authenticate(data.email, data.password);
          const fresh = await runDb(() => store.transaction(() => {
            store.logout(token);
            return store.createSession(user.id);
          }));
          if (sessionKey) queue.revokeSession(sessionKey);
          return respond(path.endsWith('signup') ? 201 : 200, {
            user,
            csrf: fresh.csrf
          }, {
            'Set-Cookie': `ticket_ssu_session=${fresh.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secureCookies ? '; Secure' : ''}`
          });
        }
        if (req.method === 'DELETE' && path === '/api/auth/account') {
          const userId = requireUser().id;
          limiter.auth(clientIp);
          const body = await jsonBody(req);
          const verifiedHash = await store.verifyWithdrawal(userId, body);
          const result = await runDb(() => store.withdrawAccount(requireUser().id, verifiedHash));
          queue.removeUser(userId);
          return respond(200, result, {
            'Set-Cookie': `ticket_ssu_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookies ? '; Secure' : ''}`
          });
        }
        if (req.method === 'POST' && path === '/api/auth/logout') {
          await runDb(() => { requireUser(); store.logout(token); });
          queue.revokeSession(sessionKey);
          return respond(200, {
            ok: true
          }, {
            'Set-Cookie': `ticket_ssu_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookies ? '; Secure' : ''}`
          });
        }
        if (req.method === 'GET' && path === '/api/concerts') return respond(200, {
          concerts: await runDb(() => store.concerts())
        });
        const queueMatch = /^\/api\/v1\/performances\/([^/]+)\/queue$/.exec(path);
        if (req.method === 'POST' && queueMatch) {
          requireUser();
          const body = await jsonBody(req, true);
          return respond(200, await runDb(() => admission.enter(requireUser().id, queueMatch[1], sessionKey, body)));
        }
        if (req.method === 'GET' && queueMatch) return respond(200, await runDb(() => admission.status(requireUser().id, queueMatch[1], sessionKey)));
        if (req.method === 'DELETE' && queueMatch) return respond(200, await runDb(() => admission.leave(requireUser().id, queueMatch[1])));
        const seatsMatch = /^\/api\/performances\/([^/]+)\/seats$/.exec(path);
        if (req.method === 'GET' && seatsMatch) return respond(200, await runDb(() => store.seatMap(seatsMatch[1], session?.user.id,
          { includeCancelled: session?.user.role === 'admin' })));
        const holdMatch = /^\/api\/performances\/([^/]+)\/hold$/.exec(path);
        if (req.method === 'PUT' && holdMatch) {
          requireUser();
          const body = await jsonBody(req);
          return respond(200, await runDb(() => admission.setHold(requireUser().id, holdMatch[1], body.seatIds, sessionKey, req.headers['x-admission-token'])));
        }
        if (req.method === 'POST' && path === '/api/bookings') {
          requireUser();
          const body = await jsonBody(req);
          return respond(201, { booking: await runDb(() => admission.checkout(requireUser().id, body, sessionKey, req.headers['x-admission-token'], req.headers['idempotency-key'])) });
        }
        if (req.method === 'GET' && path === '/api/bookings') return respond(200, {
          bookings: await runDb(() => store.bookings(requireUser().id))
        });
        const cancelMatch = /^\/api\/bookings\/([^/]+)\/cancel$/.exec(path);
        if (req.method === 'POST' && cancelMatch) return respond(200, {
          booking: await runDb(() => store.cancel(requireUser().id, cancelMatch[1]))
        });
        if (path.startsWith('/api/admin/')) {
          const user = requireUser();
          store.requireAdmin(user.id);
          if (req.method === 'POST' && path === '/api/admin/member-restrictions/lookup') {
            const body = await jsonBody(req);
            return respond(200, { member: await runDb(() => store.adminGetMemberRestriction(requireUser().id, body)) });
          }
          if (req.method === 'PUT' && path === '/api/admin/member-restrictions') {
            const body = await jsonBody(req);
            const member = await runDb(() => {
              const result = store.adminSetMemberRestriction(requireUser().id, body);
              if (result.restricted) queue.removeUser(result.member_id);
              return result;
            });
            return respond(200, { member });
          }
          const adminBookingMatch = /^\/api\/admin\/bookings\/([^/]+)$/.exec(path);
          if (req.method === 'GET' && adminBookingMatch) return respond(200, {
            booking: await runDb(() => store.adminBooking(requireUser().id, decodePathId(adminBookingMatch[1])))
          });
          const adminCancelMatch = /^\/api\/admin\/bookings\/([^/]+)\/cancel$/.exec(path);
          if (req.method === 'POST' && adminCancelMatch) {
            const body = await jsonBody(req);
            return respond(200, { booking: await runDb(() => store.cancelAsAdmin(requireUser().id, decodePathId(adminCancelMatch[1]), body)) });
          }
          if (req.method === 'GET' && path === '/api/admin/summary') return respond(200, await runDb(() => store.adminSummary(requireUser().id)));
          if (req.method === 'POST' && path === '/api/admin/performance-sales') {
            const body = await jsonBody(req);
            return respond(200, await runDb(() => {
              const result = store.changePerformanceSales(requireUser().id, body);
              if (result.state !== 'open') for (const id of result.performance_ids) queue.removePerformance(id);
              return result;
            }));
          }
          if (req.method === 'POST' && path === '/api/admin/concerts') {
            const body = await jsonBody(req);
            return respond(201, await runDb(() => store.createConcert(requireUser().id, body)));
          }
          const adminSeats = /^\/api\/admin\/performances\/([^/]+)\/seats$/.exec(path);
          if (req.method === 'GET' && adminSeats) return respond(200,
            await runDb(() => store.adminSeatOccupant(requireUser().id, decodePathId(adminSeats[1], '회차를 확인해 주세요.'), url.searchParams.get('seatId'))));
          if (req.method === 'PATCH' && adminSeats) {
            const body = await jsonBody(req);
            return respond(200, await runDb(() => store.blockSeats(requireUser().id, adminSeats[1], body.seatIds, body.blocked)));
          }
        }
        throw new AppError(404, '요청한 API를 찾을 수 없습니다.');
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new AppError(405, '지원하지 않는 요청입니다.');
      const files = {
        '/': 'index.html',
        '/index.html': 'index.html',
        '/app.js': 'app.js',
        '/polling.mjs': 'polling.mjs',
        '/styles.css': 'styles.css',
        '/favicon.svg': 'favicon.svg'
      };
      if (!files[path]) throw new AppError(404, '페이지를 찾을 수 없습니다.');
      const file = resolve(publicDir, files[path]),
        contents = await readFile(file);
      res.writeHead(200, {
        ...security,
        'Content-Type': mime[extname(file)],
        'Cache-Control': 'no-cache'
      });
      res.end(req.method === 'HEAD' ? undefined : contents);
    } catch (error) {
      if (controller.signal.aborted || res.destroyed) return;
      if (isDatabaseBusy(error)) error = new DatabaseBusyError();
      if (!(error instanceof AppError)) console.error(error);
      respond(error.status ?? 500, {
        error: error instanceof AppError ? error.message : '처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.',
        ...(req.url.startsWith('/api/v1/') ? { code: error.code ?? ({ 400: 'INVALID_INPUT', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'QUEUE_NOT_FOUND', 409: 'QUEUE_CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE', 429: 'QUEUE_CAPACITY', 503: 'DB_BUSY' }[error.status] ?? 'INTERNAL_ERROR') } : {})
      }, error.retryAfter ? { 'Retry-After': error.retryAfter } : {});
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const cleanup = setInterval(() => {
    try {
      store.expire();
    } catch (e) {
      if (!isDatabaseBusy(e)) console.error(e); // Next sweep/request will recheck expiry.
    }
  }, 5000);
  cleanup.unref();
  const queueTick = setInterval(() => queue.tick(), 100);
  queueTick.unref();
  const limitCleanup = setInterval(() => limiter.sweep(), 1000);
  limitCleanup.unref();
  server.on('close', () => {
    clearInterval(cleanup);
    clearInterval(queueTick);
    clearInterval(limitCleanup);
    queue.close();
    limiter.close();
    if (store.db.isOpen) store.close();
  });
  const shutdown = (timeoutMs = 10000) => {
    if (closing) return closing;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('종료 대기시간은 1~60000ms여야 합니다.');
    draining = true;
    closing = new Promise((resolveClose, reject) => {
      const timer = setTimeout(() => server.closeAllConnections(), timeoutMs);
      timer.unref();
      server.close(error => {
        clearTimeout(timer);
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolveClose();
      });
    });
    return closing;
  };
  return {
    server,
    store,
    queue,
    limiter,
    shutdown
  };
}
export async function startServer({ runtimeEnv = process.env, appOptions, signalSource = process, log = console.log } = {}) {
  const { port, host, shutdownMs } = runtimeOptionsFromEnv(runtimeEnv);
  if ((appOptions?.boundaryOptions?.publicOrigin || process.env.PUBLIC_ORIGIN) && !['127.0.0.1', '::1'].includes(host)) throw new Error('프록시 뒤 API의 HOST는 loopback이어야 합니다.');
  const app = await createApp(appOptions);
  try {
    app.server.listen(port, host);
    await once(app.server, 'listening');
  } catch (error) {
    await app.shutdown(shutdownMs);
    throw error;
  }
  const stop = () => { app.shutdown(shutdownMs).catch(error => { console.error(error); process.exitCode = 1; }); };
  for (const signal of ['SIGINT', 'SIGTERM']) signalSource.on(signal, stop);
  app.server.once('close', () => { for (const signal of ['SIGINT', 'SIGTERM']) signalSource.off(signal, stop); });
  log(`ticket-ssu 실행 중: http://${host.includes(':') ? `[${host}]` : host}:${app.server.address().port}`);
  return app;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await startServer();
