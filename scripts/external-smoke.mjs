import { request } from 'node:https';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

class SmokeError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
const check = (condition, code) => { if (!condition) throw new SmokeError(code); };
export function smokeOptionsFromEnv(env = process.env) {
  const number = (name, fallback, max) => {
    const value = env[name] ?? String(fallback);
    check(/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= max, `INVALID_${name}`);
    return Number(value);
  };
  return validateOptions({ origin: env.SMOKE_ORIGIN, email: env.SMOKE_EMAIL, password: env.SMOKE_PASSWORD,
    performanceId: env.SMOKE_PERFORMANCE_ID, seatId: env.SMOKE_SEAT_ID, allowWrite: env.SMOKE_ALLOW_WRITE,
    networkLabel: env.SMOKE_NETWORK_LABEL || 'unspecified', caFile: env.SMOKE_CA_FILE,
    timeoutMs: number('SMOKE_TIMEOUT_MS', 10000, 30000), waitMs: number('SMOKE_WAIT_MS', 30000, 120000), pollMs: 3000 });
}
function validateOptions(options) {
  let url;
  try { url = new URL(options.origin); } catch { throw new SmokeError('INVALID_SMOKE_ORIGIN'); }
  check(url.protocol === 'https:' && url.origin === options.origin && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'INVALID_SMOKE_ORIGIN');
  check(typeof options.email === 'string' && options.email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.email), 'INVALID_SMOKE_EMAIL');
  check(typeof options.password === 'string' && options.password.length >= 10 && options.password.length <= 128, 'INVALID_SMOKE_PASSWORD');
  check(typeof options.performanceId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(options.performanceId), 'INVALID_SMOKE_PERFORMANCE_ID');
  check(typeof options.seatId === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(options.seatId), 'INVALID_SMOKE_SEAT_ID');
  check(options.allowWrite === 'demo-staging', 'SMOKE_WRITE_TARGET_REQUIRED');
  check(/^[A-Za-z0-9_-]{1,40}$/.test(options.networkLabel), 'INVALID_SMOKE_NETWORK_LABEL');
  for (const [key, max] of [['timeoutMs', 30000], ['waitMs', 120000], ['pollMs', 5000]]) check(Number.isSafeInteger(options[key]) && options[key] > 0 && options[key] <= max, 'INVALID_SMOKE_TIMING');
  return options;
}
function scope(address = '') {
  const ip = address.replace(/^::ffff:/, '');
  if (ip === '::1' || ip.startsWith('127.')) return 'loopback';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|f[cd]|fe80:)/i.test(ip)) return 'private';
  return ip ? 'other' : 'unknown';
}
const sleep = ms => new Promise(done => setTimeout(done, ms));
export async function runExternalSmoke(input) {
  const config = validateOptions(input);
  const ca = config.ca ?? (config.caFile ? await readFile(config.caFile) : undefined);
  const report = { passed: false, origin: config.origin, networkLabel: config.networkLabel, externalNetworkVerified: false,
    networkEvidence: 'operator verification required', tlsTrust: ca ? 'custom-ca' : 'system', connectionScope: 'unknown',
    startedAt: new Date().toISOString(), steps: [], cleanup: [] };
  let cookie = '', csrf = '', stage = 'health', entered = false, holdId, bookingId, checkoutAttempted = false, holdAttempted = false;
  let primary;
  const seatsPath = `/api/performances/${config.performanceId}/seats`, holdPath = `/api/performances/${config.performanceId}/hold`, queuePath = `/api/v1/performances/${config.performanceId}/queue`;
  const call = (method, path, body, extra = {}) => new Promise((resolveCall, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(new URL(path, config.origin), { method, ca, rejectUnauthorized: true, agent: false,
      headers: { Origin: config.origin, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }), ...extra } }, res => {
      report.connectionScope = scope(req.socket.remoteAddress);
      let size = 0; const chunks = [];
      res.on('data', data => { size += data.length; if (size > 1024 * 1024) req.destroy(new SmokeError('RESPONSE_TOO_LARGE')); else chunks.push(data); });
      res.on('error', () => { clearTimeout(timer); reject(new SmokeError('NETWORK_OR_TLS_FAILED')); });
      res.on('end', () => {
        clearTimeout(timer);
        if (res.statusCode >= 300 && res.statusCode < 400) return reject(new SmokeError('REDIRECT_REFUSED', res.statusCode));
        try {
          check(res.headers['cache-control'] === 'no-store' && /^application\/json/.test(res.headers['content-type'] ?? ''), 'INVALID_RESPONSE_HEADERS');
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolveCall({ status: res.statusCode, data, headers: res.headers });
        } catch { reject(new SmokeError('INVALID_RESPONSE')); }
      });
    });
    const timer = setTimeout(() => req.destroy(new SmokeError('REQUEST_TIMEOUT')), config.timeoutMs); timer.unref();
    req.on('error', error => { clearTimeout(timer); reject(error instanceof SmokeError ? error : new SmokeError('NETWORK_OR_TLS_FAILED')); });
    req.end(payload);
  });
  const expected = async (method, path, status = 200, body, headers) => {
    const response = await call(method, path, body, headers);
    if (response.status !== status) throw new SmokeError('UNEXPECTED_STATUS', response.status);
    return response;
  };
  const step = async (name, action) => {
    stage = name; const began = performance.now();
    const value = await action(); report.steps.push({ name, passed: true, durationMs: Math.round(performance.now() - began) }); return value;
  };
  const clean = async (name, action) => {
    try { await action(); report.cleanup.push({ name, passed: true }); }
    catch { report.cleanup.push({ name, passed: false }); }
  };
  try {
    await step('health', async () => check((await expected('GET', '/api/v1/health')).data.status === 'ok', 'HEALTH_FAILED'));
    await step('readiness', async () => { const r = (await expected('GET', '/api/v1/readiness')).data; check(r.status === 'ready' && [0, 1].includes(r.schema_version), 'NOT_READY'); });
    await step('demo-disabled', async () => { const r = (await expected('GET', '/api/session')).data; check(r.demo === false && r.user === null, 'DEDICATED_STAGING_REQUIRED'); });
    await step('login', async () => {
      const r = await expected('POST', '/api/auth/login', 200, { email: config.email, password: config.password });
      const header = r.headers['set-cookie']?.find(value => value.startsWith('temp_session='));
      // Keep an owned session for logout even if a later cookie assertion fails.
      if (header && /^temp_session=[a-f0-9]{64};/.test(header)) cookie = header.split(';')[0];
      if (typeof r.data.csrf === 'string') csrf = r.data.csrf;
      check(cookie && csrf && /;\s*Secure(?:;|$)/i.test(header) && /;\s*HttpOnly(?:;|$)/i.test(header) && /;\s*SameSite=Lax(?:;|$)/i.test(header) && /;\s*Path=\/(?:;|$)/i.test(header) && !/;\s*Domain=/i.test(header), 'INVALID_SESSION_COOKIE');
      check(r.data.user?.role === 'user', 'DEDICATED_MEMBER_REQUIRED');
    });
    const seat = await step('preflight', async () => {
      const map = (await expected('GET', seatsPath)).data;
      check(map.performance?.id === config.performanceId && map.performance.starts_at > map.server_now, 'PERFORMANCE_NOT_OPEN');
      check(map.hold === null, 'EXISTING_HOLD_REFUSED');
      const rows = (await expected('GET', '/api/bookings')).data.bookings;
      check(Array.isArray(rows) && !rows.some(b => b.performance_id === config.performanceId && b.status === 'confirmed'), 'EXISTING_BOOKING_REFUSED');
      const queue = await call('GET', queuePath);
      check(queue.status === 404, 'EXISTING_QUEUE_REFUSED');
      const selected = map.seats?.find(s => s.id === config.seatId);
      check(selected?.state === 'available' && Number.isSafeInteger(selected.price), 'SEAT_NOT_AVAILABLE');
      return selected;
    });
    const admission = await step('queue', async () => {
      entered = true;
      let r = (await expected('POST', queuePath, 200, {})).data;
      const deadline = performance.now() + config.waitMs;
      while (r.state === 'waiting') {
        const remaining = deadline - performance.now(); check(remaining > 0, 'QUEUE_WAIT_TIMEOUT');
        await sleep(Math.min(config.pollMs, remaining));
        if (performance.now() >= deadline) throw new SmokeError('QUEUE_WAIT_TIMEOUT');
        r = (await expected('GET', queuePath)).data;
      }
      check(r.state === 'admitted' && r.mode === 'general' && typeof r.admission_token === 'string', 'GENERAL_ADMISSION_REQUIRED');
      return r.admission_token;
    });
    await step('hold', async () => {
      holdAttempted = true;
      const r = (await expected('PUT', holdPath, 200, { seatIds: [config.seatId] }, { 'X-Admission-Token': admission })).data;
      if (typeof r.hold?.id === 'string') holdId = r.hold.id;
      check(holdId, 'HOLD_MISMATCH');
      const map = (await expected('GET', seatsPath)).data;
      check(map.hold?.id === holdId && map.seats?.filter(s => s.state === 'selected').length === 1 && map.seats.some(s => s.id === config.seatId && s.state === 'selected'), 'HOLD_MISMATCH');
    });
    await step('checkout', async () => {
      checkoutAttempted = true;
      const b = (await expected('POST', '/api/bookings', 201, { holdId, buyerName: '외부검증', buyerPhone: '01000000000', delivery: 'mobile', agreed: true, paymentMethod: 'demo' }, { 'X-Admission-Token': admission })).data.booking;
      if (typeof b?.id === 'string' && b.hold_id === holdId) bookingId = b.id;
      check(bookingId && b.status === 'confirmed' && b.fee === 2000 && b.ticket_total === seat.price && b.total === seat.price + 2000 && b.seats?.length === 1 && b.seats[0].seat_id === config.seatId, 'BOOKING_MISMATCH');
    });
    await step('booking-query', async () => check((await expected('GET', '/api/bookings')).data.bookings.some(b => b.id === bookingId && b.hold_id === holdId && b.status === 'confirmed'), 'BOOKING_QUERY_MISMATCH'));
    await step('cancel', async () => {
      const b = (await expected('POST', `/api/bookings/${encodeURIComponent(bookingId)}/cancel`)).data.booking;
      check(b.id === bookingId && b.status === 'cancelled' && b.total === seat.price + 2000, 'CANCEL_MISMATCH');
    });
    await step('history-and-seat', async () => {
      check((await expected('GET', '/api/bookings')).data.bookings.some(b => b.id === bookingId && b.status === 'cancelled'), 'CANCEL_HISTORY_MISSING');
      const map = (await expected('GET', seatsPath)).data;
      check(map.hold === null && map.seats.some(s => s.id === config.seatId && s.state === 'available'), 'SEAT_NOT_RELEASED');
    });
  } catch (error) {
    primary = { stage, code: error instanceof SmokeError ? error.code : 'VALIDATION_FAILED', ...(Number.isInteger(error.status) ? { status: error.status } : {}) };
  } finally {
    if (cookie && !csrf) report.cleanup.push({ name: 'logout', passed: false });
    if (cookie && csrf) {
      if (checkoutAttempted) await clean('owned-booking', async () => {
        const rows = (await expected('GET', '/api/bookings')).data.bookings;
        check(Array.isArray(rows), 'CLEANUP_QUERY_FAILED');
        const own = rows.filter(b => b.hold_id === holdId);
        check(own.length <= 1, 'AMBIGUOUS_BOOKING');
        if (own[0]?.status === 'confirmed') check((await expected('POST', `/api/bookings/${encodeURIComponent(own[0].id)}/cancel`)).data.booking.status === 'cancelled', 'CLEANUP_CANCEL_FAILED');
      });
      if (holdAttempted) await clean('owned-hold', async () => {
        const current = (await expected('GET', seatsPath)).data.hold;
        if (!current) return;
        check(holdId && current.id === holdId, 'UNKNOWN_HOLD_REQUIRES_REVIEW');
        check((await expected('PUT', holdPath, 200, { seatIds: [] })).data.hold === null, 'CLEANUP_HOLD_FAILED');
      });
      if (entered) await clean('queue-leave', async () => { await expected('DELETE', queuePath); });
      await clean('logout', async () => {
        const r = await expected('POST', '/api/auth/logout');
        check(r.headers['set-cookie']?.some(h => /Max-Age=0/.test(h) && /;\s*Secure(?:;|$)/i.test(h)), 'LOGOUT_COOKIE_FAILED');
        check((await expected('GET', '/api/session')).data.user === null, 'SESSION_NOT_REVOKED');
      });
    }
  }
  report.passed = !primary && report.cleanup.every(r => r.passed);
  if (primary) report.failure = primary;
  if (report.cleanup.some(r => !r.passed)) report.manualReviewRequired = true;
  report.finishedAt = new Date().toISOString();
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const report = await runExternalSmoke(smokeOptionsFromEnv()); console.log(JSON.stringify(report, null, 2)); process.exitCode = report.passed ? 0 : 1; }
  catch (error) { console.log(JSON.stringify({ passed: false, externalNetworkVerified: false, failure: { stage: 'configuration', code: error instanceof SmokeError ? error.code : 'CONFIGURATION_OR_CA_FAILED' } })); process.exitCode = 1; }
}
