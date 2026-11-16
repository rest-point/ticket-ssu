import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { admissionHeaders } from './helpers/admission.mjs';
import { currentSpec, operations, validateResponse, validateValue } from '../scripts/check-api.mjs';

const now = 1800000000000;
async function client(t, schema) {
  let clock = now;
  const { server, store } = await createApp({ dbPath: ':memory:', schema, demo: true, now: () => clock, secureCookies: false, queueOptions: { admitPerSecond: 1000 } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '', csrf = '';
  const covered = new Set();
  const byId = Object.fromEntries(operations(currentSpec).map(x => [x.operation.operationId, x]));
  async function send(id, { pathParams = {}, query, body, raw, headers = {}, anonymous = false, csrfMissing = false, status = 200 } = {}) {
    const { path, method, operation } = byId[id];
    const url = path.replace(/\{([^}]+)\}/g, (_, key) => encodeURIComponent(pathParams[key]));
    if (body !== undefined) validateValue(currentSpec, operation.requestBody.content['application/json'].schema, body);
    const reqHeaders = await admissionHeaders(store, base, { ...(cookie && !anonymous ? { cookie } : {}), ...(csrf && !anonymous && !csrfMissing ? { 'X-CSRF-Token': csrf } : {}), ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, method, url, body);
    const response = await fetch(base + url + (query ? `?${new URLSearchParams(query)}` : ''), { method: method.toUpperCase(), headers: reqHeaders, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
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
  return { send, covered, base, advance: ms => { clock += ms; }, unsupported: async (path, method) => {
    const response = await fetch(base + path, { method: method.toUpperCase(), headers: { ...(cookie ? { cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) } });
    assert.equal(response.status, 404, 'unsupported alias must return 404');
    const error = await response.json();
    validateValue(currentSpec, currentSpec.components.schemas.QueueError, error);
    assert.equal(error.code, 'QUEUE_NOT_FOUND');
  } };
}

for (const schema of ['legacy', 'model']) {
test(`[${schema}] 현재 API의 실제 성공 응답이 OpenAPI와 일치하고 미지원 v1 별칭은 404다`, async t => {
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
  const adminTargetHold = (await c.send('replaceHold', { pathParams, body: { seatIds: ['A-01', 'A-02'] } })).hold;
  const target = (await c.send('createBooking', { status: 201, body: { ...order, holdId: adminTargetHold.id } })).booking;
  const pending = (await c.send('replaceHold', { pathParams, body: { seatIds: ['A-04'] } })).hold;
  const seatOptions = seatId => ({ pathParams, query: { seatId } });
  await c.send('adminGetSeatOccupant', { ...seatOptions('A-01'), anonymous: true, status: 401 });
  await c.send('adminGetSeatOccupant', { ...seatOptions('A-01'), status: 403 });
  const adminParams = { bookingId: target.id }, adminBody = { reason: 'customer_request', confirmed: true };
  await c.send('adminGetBooking', { pathParams: adminParams, status: 403 });
  await c.send('adminCancelBooking', { pathParams: adminParams, body: adminBody, status: 403 });
  await c.send('logout');
  await c.send('login', { anonymous: true, body: { email: 'admin@ticket-ssu.local', password: 'TicketSsuAdmin123!' } });
  await c.send('adminGetSeatOccupant', { pathParams, status: 400 });
  await c.send('adminGetSeatOccupant', { ...seatOptions('missing'), status: 404 });
  const occupant = await c.send('adminGetSeatOccupant', seatOptions('A-01'));
  assert.deepEqual(occupant, { seat_id: 'A-01', state: 'booked', member: { name: '티켓회원', email: 'demo@ticket-ssu.local' }, booking_id: target.id });
  assert.deepEqual(await c.send('adminGetSeatOccupant', seatOptions('A-04')),
    { seat_id: 'A-04', state: 'held', member: occupant.member, hold_expires_at: pending.expires_at });
  const found = (await c.send('adminGetBooking', { pathParams: adminParams })).booking;
  assert.equal(found.can_cancel, true);
  assert.deepEqual(found.seats, target.seats);
  assert.equal(found.buyer_phone, undefined);
  await c.send('cancelBooking', { pathParams: adminParams, status: 404 });
  await c.send('adminCancelBooking', { pathParams: adminParams, body: adminBody, csrfMissing: true, status: 403 });
  await c.send('adminCancelBooking', { pathParams: adminParams, raw: '{"reason":"customer_request","confirmed":false}', status: 400 });
  const result = await c.send('adminCancelBooking', { pathParams: adminParams, body: adminBody });
  assert.deepEqual(result.booking, { ...found, status: 'cancelled', can_cancel: false, cancelled_at: now, admin_cancel_reason: 'customer_request' });
  assert.deepEqual(await c.send('adminCancelBooking', { pathParams: adminParams, body: adminBody }), result);
  const mapAfterCancel = await c.send('getSeats', { pathParams });
  assert.deepEqual(mapAfterCancel.seats.filter(s => ['A-01', 'A-02'].includes(s.id)).map(s => s.state), ['available', 'available']);
  assert.deepEqual(await c.send('adminGetSeatOccupant', seatOptions('A-01')), { seat_id: 'A-01', state: 'available', member: null });
  await c.send('adminSummary');
  const dateOne = now + 86400000, dateTwo = now + 2 * 86400000;
  const concert = { title: '가상 계약 공연', artist: '가상 밴드', venue: '가상 공연장', description: '계약 검증용', basePrice: 50000,
    dates: [new Date(dateOne).toISOString(), new Date(dateTwo).toISOString()] };
  const beforeConcert = await c.send('adminSummary');
  for (const start of [now - 1, now, dateOne - 1]) {
    const rejected = await c.send('createConcert', { status: 400, body: { ...concert, dates: [concert.dates[1], new Date(start).toISOString()] } });
    assert.match(rejected.error, /24시간/);
  }
  assert.deepEqual(await c.send('adminSummary'), beforeConcert);
  await c.send('createConcert', { status: 201, body: concert });
  const afterFirst = await c.send('adminSummary');
  await c.send('createConcert', { status: 409, body: concert });
  const equivalentDate = new Date(dateTwo + 9 * 3600000).toISOString().replace('Z', '+09:00');
  await c.send('createConcert', { status: 409, body: { ...concert, title: ` ${concert.title} `, dates: [equivalentDate, concert.dates[0]] } });
  assert.deepEqual(await c.send('adminSummary'), afterFirst);
  await c.send('createConcert', { status: 201, body: { ...concert, dates: [concert.dates[0]] } });
  await c.send('createConcert', { status: 201, body: { ...concert, basePrice: 51000 } });
  await c.send('blockSeats', { pathParams, body: { seatIds: ['A-03'], blocked: true } });
  assert.equal((await c.send('getSeats', { pathParams })).seats.find(s => s.id === 'A-03').state, 'blocked');
  assert.deepEqual(await c.send('adminGetSeatOccupant', seatOptions('A-03')), { seat_id: 'A-03', state: 'blocked', member: null });
  c.advance(7 * 60 * 1000);
  assert.deepEqual(await c.send('adminGetSeatOccupant', seatOptions('A-04')), { seat_id: 'A-04', state: 'available', member: null });
  const { member } = await c.send('adminLookupMemberRestriction', { body: { email: 'demo@ticket-ssu.local' } });
  const restriction = await c.send('adminSetMemberRestriction', { body: { member_id: member.member_id, revision: member.revision, restricted: true, reason: '계약 검증용 제한' } });
  assert.equal(restriction.member.restricted, true);
  const salesTarget = { performance_id: pid, revision: 0, booking_count: 0 };
  const paused = await c.send('adminChangePerformanceSales', { body: { action: 'pause', targets: [salesTarget], reason: '계약 검증용 판매 중단' } });
  assert.equal(paused.state, 'paused');
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
