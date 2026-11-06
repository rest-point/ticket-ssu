import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { admissionHeaders } from './helpers/admission.mjs';
import { currentSpec, operations, validateResponse, validateValue } from '../scripts/check-api.mjs';

const now = 1800000000000;
async function client(t, schema) {
  const { server, store } = await createApp({ dbPath: ':memory:', schema, demo: true, now: () => now, secureCookies: false, queueOptions: { admitPerSecond: 1000 } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '', csrf = '';
  const covered = new Set();
  const byId = Object.fromEntries(operations(currentSpec).map(x => [x.operation.operationId, x]));
  async function send(id, { pathParams = {}, body, raw, headers = {}, anonymous = false, csrfMissing = false, status = 200 } = {}) {
    const { path, method, operation } = byId[id];
    const url = path.replace(/\{([^}]+)\}/g, (_, key) => encodeURIComponent(pathParams[key]));
    if (body !== undefined) validateValue(currentSpec, operation.requestBody.content['application/json'].schema, body);
    const reqHeaders = await admissionHeaders(store, base, { ...(cookie && !anonymous ? { cookie } : {}), ...(csrf && !anonymous && !csrfMissing ? { 'X-CSRF-Token': csrf } : {}), ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, method, url, body);
    const response = await fetch(base + url, { method: method.toUpperCase(), headers: reqHeaders, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    assert.equal(response.status, status, `${id}: status`);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json();
    validateResponse(currentSpec, operation, response.status, data);
    if (response.headers.has('set-cookie')) {
      assert.match(response.headers.get('set-cookie'), /HttpOnly/);
      assert.match(response.headers.get('set-cookie'), /SameSite=Lax/);
      cookie = response.headers.get('set-cookie').split(';')[0];
      if (['logout', 'withdrawAccount'].includes(id)) { cookie = ''; csrf = ''; }
    }
    if (data.csrf) csrf = data.csrf;
    if (status < 400) covered.add(id);
    return data;
  }
  return { send, covered, base, unsupported: async (path, method) => {
    const response = await fetch(base + path, { method: method.toUpperCase(), headers: { ...(cookie ? { cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) } });
    assert.equal(response.status, 404, 'unsupported alias must return 404');
    const error = await response.json();
    validateValue(currentSpec, currentSpec.components.schemas.QueueError, error);
    assert.equal(error.code, 'QUEUE_NOT_FOUND');
  } };
}

for (const schema of ['legacy', 'model']) {
test(`[${schema}] 현재 19개 API의 실제 성공 응답이 OpenAPI와 일치하고 미지원 v1 별칭은 404다`, async t => {
  const c = await client(t, schema);
  assert.equal((await c.send('getSession')).user, null);
  assert.deepEqual(await c.send('health'), { status: 'ok' });
  assert.equal((await c.send('readiness')).schema_version, schema === 'model' ? 1 : 0);
  await c.send('signup', { anonymous: true, status: 201, body: { email: 'contract@ticket-ssu.local', name: '가상계약회원', phone: '010-1234-5678', password: 'ContractDemo123!', terms: true, ageConfirmed: true } });
  const concerts = await c.send('listConcerts');
  const pid = concerts.concerts[0].performances[0].id, pathParams = { performanceId: pid };
  const seats = await c.send('getSeats', { pathParams });
  await c.send('enterQueue', { pathParams, body: {} });
  await c.send('getQueue', { pathParams });
  await c.send('leaveQueue', { pathParams });
  const price = seats.seats.find(s => s.id === 'A-01').price;
  const { hold } = await c.send('replaceHold', { pathParams, body: { seatIds: ['A-01'] } });
  const order = { holdId: hold.id, buyerName: '가상예매자', buyerPhone: '01012345678', delivery: 'mobile', paymentMethod: 'demo', agreed: true, total: 1 };
  const { booking } = await c.send('createBooking', { status: 201, body: order });
  assert.equal(booking.total, price + 2000);
  assert.equal((await c.send('createBooking', { status: 201, body: order })).booking.id, booking.id);
  assert.equal((await c.send('listBookings')).bookings.length, 1);
  assert.equal((await c.send('cancelBooking', { pathParams: { bookingId: booking.id } })).booking.status, 'cancelled');
  await c.send('withdrawAccount', { body: { password: 'ContractDemo123!', confirmed: true } });
  await c.send('login', { anonymous: true, body: { email: 'demo@ticket-ssu.local', password: 'TicketSsuDemo123!' } });
  await c.send('logout');
  await c.send('login', { anonymous: true, body: { email: 'admin@ticket-ssu.local', password: 'TicketSsuAdmin123!' } });
  await c.send('adminSummary');
  await c.send('createConcert', { status: 201, body: { title: '가상 계약 공연', artist: '가상 밴드', venue: '가상 공연장', description: '계약 검증용', basePrice: 50000, dates: [new Date(now + 86400000).toISOString()] } });
  await c.send('blockSeats', { pathParams, body: { seatIds: ['A-03'], blocked: true } });
  assert.equal((await c.send('getSeats', { pathParams })).seats.find(s => s.id === 'A-03').state, 'blocked');
  assert.deepEqual([...c.covered].sort(), operations(currentSpec).map(x => x.operation.operationId).sort());
  for (const { path, method, operation } of operations(currentSpec)) if (operation['x-implementation'] === 'implemented-legacy') await c.unsupported(path.replace(/^\/api\//, '/api/v1/').replace('{performanceId}', pid).replace('{bookingId}', booking.id), method);
});

test(`[${schema}] 현재 인증·출처·CSRF·입력·충돌·요청 제한 오류가 명세의 상태/형식과 일치한다`, async t => {
  const c = await client(t, schema);
  await c.send('listBookings', { anonymous: true, status: 401 });
  await c.send('login', { anonymous: true, status: 401, body: { email: 'demo@ticket-ssu.local', password: 'incorrect' } });
  await c.send('login', { anonymous: true, status: 403, headers: { Origin: 'https://invalid.example' }, body: { email: 'demo@ticket-ssu.local', password: 'TicketSsuDemo123!' } });
  await c.send('login', { anonymous: true, body: { email: 'demo@ticket-ssu.local', password: 'TicketSsuDemo123!' } });
  await c.send('logout', { csrfMissing: true, status: 403 });
  await c.send('adminSummary', { status: 403 });
  await c.send('getSeats', { pathParams: { performanceId: 'missing' }, status: 404 });
  const pid = (await c.send('listConcerts')).concerts[0].performances[0].id, pathParams = { performanceId: pid };
  await c.send('replaceHold', { pathParams, raw: '{', status: 400 });
  await c.send('replaceHold', { pathParams, raw: '{}', headers: { 'Content-Type': 'text/plain' }, status: 415 });
  await c.send('replaceHold', { pathParams, raw: JSON.stringify({ extra: 'x'.repeat(17000) }), status: 413 });
  await c.send('replaceHold', { pathParams, body: { seatIds: ['Z-99'] }, status: 409 });
  await c.send('cancelBooking', { pathParams: { bookingId: 'missing' }, status: 404 });
  let limited = false;
  for (let n = 0; n < 32; n++) {
    const response = await fetch(c.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.ok([415, 429].includes(response.status));
    validateResponse(currentSpec, currentSpec.paths['/api/auth/login'].post, response.status, await response.json());
    if (response.status === 429) { limited = true; break; }
  }
  assert.ok(limited, 'IP auth limit should be reached');
});
}
