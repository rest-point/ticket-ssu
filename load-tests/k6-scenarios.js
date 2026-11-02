import http from 'k6/http';
import { sleep } from 'k6';
import execution from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';

const fixture = JSON.parse(open(__ENV.TEMP_K6_FIXTURE));
if (fixture.scope !== 'isolated-new-database' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(fixture.base) ||
    !['race', 'ticket-cap', 'queue', 'read-control', 'read-current', 'mixed-default', 'busy'].includes(fixture.profile)) throw new Error('K6_LOCAL_FIXTURE_REQUIRED');
const profile = fixture.profile, base = fixture.base, pid = fixture.performanceId;
const unexpected = new Rate('unexpected_status'), conflicts = new Counter('expected_409'), limited = new Counter('expected_429');
const busy = new Counter('expected_503'), business = new Counter('completed_bookings'), admissionWait = new Trend('admission_wait_ms', true);
const holdWins = new Counter('successful_holds'), retryAfterMissing = new Rate('retry_after_missing');
const successfulLatency = new Trend('successful_request_ms', true);
const recoveries = new Counter('client_hold_recoveries');
const scenario = ['race', 'ticket-cap'].includes(profile) ? { executor: 'per-vu-iterations', vus: 8, iterations: 1, maxDuration: '10s' } :
  ['busy', 'queue'].includes(profile) ? { executor: 'constant-vus', vus: profile === 'busy' ? 4 : 8, duration: profile === 'busy' ? '6s' : '8s', gracefulStop: '5s' } :
    { executor: 'ramping-vus', startVUs: 0, stages: profile.startsWith('read-') ?
      [{ duration: '4s', target: 2 }, { duration: '6s', target: 8 }, { duration: '6s', target: 16 }, { duration: '4s', target: 0 }] :
      [{ duration: '5s', target: 2 }, { duration: '10s', target: 8 }, { duration: '10s', target: 16 }, { duration: '5s', target: 0 }], gracefulRampDown: '10s', gracefulStop: '15s' };
export const options = {
  scenarios: { workload: scenario }, summaryTrendStats: ['avg', 'min', 'max', 'p(95)', 'p(99)'],
  systemTags: ['status', 'method', 'name', 'scenario', 'expected_response'],
  thresholds: { unexpected_status: ['rate==0'], retry_after_missing: ['rate==0'],
    ...(profile === 'race' ? { successful_holds: ['count==1'], expected_409: ['count==7'], completed_bookings: ['count==1'] } : {}),
    ...(profile === 'mixed-default' ? { completed_bookings: ['count>0'] } : {}),
    ...(profile === 'busy' ? { expected_503: ['count>0'] } : {}) }
};
http.setResponseCallback(http.expectedStatuses(200, 201, 409, 429, 503));
function call(user, method, path, body, name, accepted, token) {
  const headers = { Cookie: user.cookie, 'X-CSRF-Token': user.csrf, Origin: base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(token ? { 'X-Admission-Token': token } : {}) };
  const response = http.request(method, base + path, body === undefined ? null : JSON.stringify(body), { headers, redirects: 0, timeout: '5s', tags: { name } });
  const expected = accepted.includes(response.status); unexpected.add(!expected);
  if (response.status >= 200 && response.status < 300) successfulLatency.add(response.timings.duration);
  if (response.status === 409) conflicts.add(1);
  if (response.status === 429) { limited.add(1); retryAfterMissing.add(!(Number(response.headers['Retry-After']) >= 1)); }
  else if (response.status === 503) { busy.add(1); retryAfterMissing.add(!(Number(response.headers['Retry-After']) >= 1)); }
  else retryAfterMissing.add(false);
  return response;
}
function json(response) { try { return response.json(); } catch { unexpected.add(true); return {}; } }
let queueSince;
export default function () {
  const index = execution.vu.idInTest - 1, user = fixture.users[profile === 'ticket-cap' ? 0 : index];
  const holdPath = `/api/performances/${pid}/hold`, queuePath = `/api/v1/performances/${pid}/queue`;
  if (profile === 'race' || profile === 'ticket-cap') {
    const seats = profile === 'race' ? ['A-01', 'A-02'] : [`C-${String(index + 1).padStart(2, '0')}`, `D-${String(index + 1).padStart(2, '0')}`];
    const r = call(user, 'PUT', holdPath, { seatIds: seats }, 'contended-hold', [200, 409], user.admission);
    if (r.status === 200) {
      holdWins.add(1);
      if (profile === 'race') {
        const hold = json(r).hold;
        const booked = call(user, 'POST', '/api/bookings', { holdId: hold?.id, buyerName: '가상부하회원', buyerPhone: '01000000000', delivery: 'mobile', agreed: true, paymentMethod: 'demo' }, 'contended-checkout', [201], user.admission);
        if (booked.status === 201) business.add(1);
      }
    }
    return;
  }
  if (profile.startsWith('read-')) { call(user, 'GET', `/api/performances/${pid}/seats`, undefined, 'seat-poll', [200]); sleep(0.25); return; }
  if (profile === 'queue') {
    if (!queueSince) queueSince = Date.now();
    const r = call(user, 'POST', queuePath, {}, 'bounded-queue-enter', [200]);
    if (json(r).state === 'admitted') { admissionWait.add(Date.now() - queueSince); sleep(0.4); call(user, 'DELETE', queuePath, undefined, 'bounded-queue-leave', [200]); queueSince = undefined; }
    else sleep(0.25);
    return;
  }
  if (profile === 'busy') {
    call(user, 'PUT', holdPath, { seatIds: [user.seat] }, 'locked-hold', [200, 503], user.admission); sleep(0.1); return;
  }
  if (execution.vu.iterationInScenario % 3 === 0) {
    call(user, 'GET', `/api/performances/${pid}/seats`, undefined, 'seat-poll', [200, 429]); sleep(0.3); return;
  }
  let holdId, bookingId, entered = false;
  try {
    let r = call(user, 'POST', queuePath, {}, 'queue-enter', [200, 429]);
    if (r.status !== 200) { sleep(Math.max(1, Number(r.headers['Retry-After']) || 1)); return; }
    entered = true; let status = json(r), waited = false; const began = Date.now();
    while (status.state === 'waiting' && Date.now() - began < 10000) {
      waited = true; sleep(0.5);
      r = call(user, 'GET', queuePath, undefined, 'queue-poll', [200, 429]);
      if (r.status === 429) { sleep(Math.max(1, Number(r.headers['Retry-After']) || 1)); continue; }
      status = json(r);
    }
    if (status.state !== 'admitted') return;
    admissionWait.add(waited ? Date.now() - began : 0);
    // A previous cleanup may have received 429. Recovery admission permits
    // releasing that owned hold, not making a fresh seat selection.
    if (status.mode === 'hold-recovery') {
      recoveries.add(1);
      call(user, 'PUT', holdPath, { seatIds: [] }, 'recovery-release', [200, 429]);
      return;
    }
    r = call(user, 'PUT', holdPath, { seatIds: [user.seat] }, 'hold', [200, 409, 429], status.admission_token);
    if (r.status !== 200) return;
    holdId = json(r).hold?.id;
    r = call(user, 'POST', '/api/bookings', { holdId, buyerName: '가상부하회원', buyerPhone: '01000000000', delivery: 'mobile', agreed: true, paymentMethod: 'demo' },
      'checkout', [201, 409, 429], status.admission_token);
    if (r.status === 201) {
      const b = json(r).booking; bookingId = b?.id;
      if (!b || b.fee !== 2000 || b.ticket_total !== user.price || b.total !== user.price + 2000) unexpected.add(true);
      else business.add(1);
      call(user, 'GET', '/api/bookings', undefined, 'booking-query', [200, 429]);
    }
  } finally {
    if (bookingId) call(user, 'POST', `/api/bookings/${bookingId}/cancel`, undefined, 'cancel', [200, 429]);
    else if (holdId) call(user, 'PUT', holdPath, { seatIds: [] }, 'release-hold', [200, 429]);
    if (entered) call(user, 'DELETE', queuePath, undefined, 'queue-leave', [200, 429]);
    sleep(0.3);
  }
}
export function handleSummary(data) { return { [__ENV.TEMP_K6_SUMMARY]: JSON.stringify({ metrics: data.metrics }) }; }
