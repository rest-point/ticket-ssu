import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../lib/store.mjs';
import { ModelStore } from '../lib/model-store.mjs';
import { validateModel } from '../db/model.mjs';
import { createApp } from '../server.mjs';
import { admissionHeaders } from './helpers/admission.mjs';
import { currentSpec, validateValue } from '../scripts/check-api.mjs';

const initialTime = 1800000000000;
const duration = 7 * 60 * 1000;
async function fixture(t, schema) {
  let now = initialTime;
  const store = new (schema === 'model' ? ModelStore : Store)(':memory:', { now: () => now });
  t.after(() => store.close());
  await store.seed();
  const user = await store.authenticate('demo@ticket-ssu.local', 'TicketSsuDemo123!');
  const other = await store.authenticate('admin@ticket-ssu.local', 'TicketSsuAdmin123!');
  const performances = store.concerts()[0].performances;
  const order = hold => ({ holdId: hold.id, buyerName: '가상예매자', buyerPhone: '01012345678', delivery: 'mobile', agreed: true, paymentMethod: 'demo', total: 1 });
  return { store, user, other, pid: performances[0].id, secondPid: performances[1].id,
    time: value => { now = value; }, order,
    checkout: (who, hold) => store.checkout(who.id, order(hold)),
    verify: () => { if (schema === 'model') validateModel(store.db); } };
}
function fingerprint(store) {
  const tables = store.all("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const data = tables.map(({ name }) => [name, store.all(`SELECT * FROM ${name} ORDER BY rowid`)]);
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
function withHoldGuardDisabled(store, schema, fn) {
  if (schema === 'legacy') return fn();
  // Fault injection in this isolated test only. Runtime INSERT guard is restored.
  const sql = store.get("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='current_hold_insert'").sql;
  store.db.exec('DROP TRIGGER current_hold_insert');
  try { return fn(); } finally { store.db.exec(sql); }
}

for (const schema of ['legacy', 'model']) {
  test(`[${schema}] 기본 7분의 직전 확정과 정확한 만료 시각 거부를 구분한다`, async t => {
    const f = await fixture(t, schema), { store, user, other, pid } = f;
    const first = store.setHold(user.id, pid, ['A-01']).hold;
    const second = store.setHold(other.id, pid, ['A-02']).hold;
    assert.equal(first.expires_at, initialTime + duration);
    assert.equal(second.expires_at, first.expires_at);
    f.time(first.expires_at - 1);
    assert.equal(f.checkout(user, first).status, 'confirmed');
    const changed = store.setHold(other.id, pid, ['A-03']).hold;
    assert.notEqual(changed.id, second.id);
    assert.equal(changed.expires_at, second.expires_at);
    f.time(changed.expires_at);
    const before = fingerprint(store);
    assert.throws(() => f.checkout(other, changed), e => e.status === 409 && e.message.includes('만료'));
    assert.equal(fingerprint(store), before, 'failed checkout must roll back expiry changes too');
    const map = store.seatMap(pid, other.id);
    assert.equal(map.hold, null);
    assert.equal(map.seats.find(s => s.id === 'A-03').state, 'available');
    f.verify();
  });

  test(`[${schema}] 유효 hold라도 공연 시작 시각부터 신규 확정·취소·차단을 거부한다`, async t => {
    const f = await fixture(t, schema), { store, user, other } = f;
    const starts = initialTime + 60000;
    const { id } = store.createConcert(other.id, { title: '마감 경계 공연', artist: '가상 밴드', venue: '가상 공연장', description: '경계 검증', basePrice: 50000, dates: [new Date(starts).toISOString()] });
    const pid = store.concerts().find(c => c.id === id).performances[0].id;
    const early = f.checkout(user, store.setHold(user.id, pid, ['A-01']).hold);
    const otherBooking = f.checkout(other, store.setHold(other.id, pid, ['A-03']).hold);
    const held = store.setHold(user.id, pid, ['A-02']).hold;
    f.time(starts - 1);
    const last = f.checkout(user, held);
    assert.equal(store.cancel(user.id, early.id).status, 'cancelled');
    const after = store.setHold(user.id, pid, ['A-04']).hold;
    assert.ok(after.expires_at > starts, 'this case must test show closure, not hold expiry');
    f.time(starts);
    const before = fingerprint(store);
    for (const request of [() => f.checkout(user, after), () => store.cancel(other.id, otherBooking.id), () => store.setHold(other.id, pid, ['A-05']), () => store.blockSeats(other.id, pid, ['A-06'], true)]) {
      assert.throws(request, e => e.status === 409 && e.message.includes('마감'));
      assert.equal(fingerprint(store), before);
    }
    assert.equal(f.checkout(user, held).id, last.id, 'completed checkout replay still returns existing result');
    assert.equal(store.cancel(user.id, early.id).status, 'cancelled', 'completed cancellation replay remains allowed');
    f.verify();
  });

  test(`[${schema}] 확정·선점 합산 4매와 다른 회차·취소 복원·스냅샷을 구분한다`, async t => {
    const f = await fixture(t, schema), { store, user, other, pid, secondPid } = f;
    const first = f.checkout(user, store.setHold(user.id, pid, ['A-01', 'A-02']).hold);
    const selected = store.setHold(user.id, pid, ['B-01', 'B-02']).hold;
    const before = fingerprint(store);
    assert.throws(() => store.setHold(user.id, pid, ['B-01', 'B-02', 'B-03']), { status: 409 });
    assert.equal(fingerprint(store), before, 'rejected expansion must preserve the original selection');
    store.setHold(user.id, secondPid, ['C-01', 'C-02', 'C-03', 'C-04']);
    f.checkout(user, selected);
    assert.throws(() => store.setHold(user.id, pid, ['C-01']), { status: 409 });
    store.cancel(user.id, first.id);
    // Synthetic price change on available inventory; no pricing API is implied.
    if (schema === 'legacy') store.run('UPDATE seats SET price=99000 WHERE performance_id=? AND id=?', pid, 'A-01');
    else store.run(`UPDATE inventory SET price=99000 WHERE performance_id=? AND physical_seat_id IN
      (SELECT id FROM physical_seats WHERE seat_code='A-01')`, pid);
    const resale = f.checkout(other, store.setHold(other.id, pid, ['A-01']).hold);
    assert.equal(resale.total, 101000);
    store.setHold(user.id, pid, ['D-01', 'D-02']);
    const history = store.booking(first.id, user.id);
    assert.equal(history.status, 'cancelled');
    assert.equal(history.total, first.total);
    assert.equal(history.fee, 4000);
    assert.deepEqual(history.seats.map(s => s.price), [130000, 130000]);
    assert.equal(store.adminSummary(other.id).stats.revenue, 365000, 'cancelled original amount is excluded from sales');
    f.verify();
  });

  test(`[${schema}] 외부 변경으로 한도를 넘긴 선점은 확정 직전에 다시 거부한다`, async t => {
    const f = await fixture(t, schema), { store, user, pid } = f;
    f.checkout(user, store.setHold(user.id, pid, ['A-01', 'A-02', 'A-03']).hold);
    const hold = { id: 'fault-over-limit', expires_at: initialTime + duration };
    store.run("INSERT INTO holds VALUES(?,?,?,?,'active')", hold.id, user.id, pid, hold.expires_at);
    withHoldGuardDisabled(store, schema, () => {
      if (schema === 'legacy') store.run("UPDATE seats SET hold_id=? WHERE performance_id=? AND id IN ('B-01','B-02')", hold.id, pid);
      else for (const code of ['B-01', 'B-02']) store.run('INSERT INTO current_holds VALUES(?,?)', store.seat(pid, code).id, hold.id);
    });
    const before = fingerprint(store);
    assert.throws(() => f.checkout(user, hold), { status: 409 });
    assert.equal(fingerprint(store), before);
    store.setHold(user.id, pid, []); // Repair the intentionally invalid fixture.
    f.verify();
  });

  test(`[${schema}] 외부 변경으로 다른 회차에 연결된 선점은 확정하지 않는다`, async t => {
    const f = await fixture(t, schema), { store, user, pid, secondPid } = f;
    const hold = store.setHold(user.id, pid, ['A-01']).hold;
    withHoldGuardDisabled(store, schema, () => {
      if (schema === 'legacy') {
        store.run('UPDATE seats SET hold_id=NULL WHERE hold_id=?', hold.id);
        store.run("UPDATE seats SET hold_id=? WHERE performance_id=? AND id='A-01'", hold.id, secondPid);
      } else {
        store.run('DELETE FROM current_holds WHERE hold_id=?', hold.id);
        store.run('INSERT INTO current_holds VALUES(?,?)', store.seat(secondPid, 'A-01').id, hold.id);
      }
    });
    const before = fingerprint(store);
    assert.throws(() => f.checkout(user, hold), { status: 409 });
    assert.equal(fingerprint(store), before);
    store.setHold(user.id, pid, []);
    assert.equal(store.seatMap(secondPid).seats[0].state, 'available');
    f.verify();
  });
}

for (const schema of ['legacy', 'model']) {
  test(`[${schema}] HTTP는 역할/소유권/세션 만료를 본문·CSRF와 구분한다`, async t => {
    let now = initialTime;
    const { server, store } = await createApp({ schema, dbPath: ':memory:', demo: true, now: () => now, secureCookies: false, queueOptions: { admitPerSecond: 1000 } });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => new Promise(r => server.close(r)));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(method, path, { body, identity, csrf, expected = 200, responseSchema } = {}) {
      const headers = await admissionHeaders(store, base, { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(identity ? { Cookie: identity.cookie, 'X-CSRF-Token': csrf ?? identity.csrf } : {}) }, method, path, body);
      const response = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      assert.equal(response.status, expected, `${method} ${path}`);
      const data = await response.json();
      validateValue(currentSpec, currentSpec.components.schemas[expected >= 400 ? 'Error' : responseSchema], data);
      return { data, cookie: response.headers.get('set-cookie')?.split(';')[0], csrf: data.csrf };
    }
    const owner = await request('POST', '/api/auth/signup', { expected: 201, responseSchema: 'AuthResult', body: { email: 'policy@ticket-ssu.local', name: '가상회원', phone: '01012345678', password: 'PolicyDemo123!', terms: true, ageConfirmed: true, role: 'admin' } });
    assert.equal(owner.data.user.role, 'user');
    const admin = await request('POST', '/api/auth/login', { responseSchema: 'AuthResult', body: { email: 'admin@ticket-ssu.local', password: 'TicketSsuAdmin123!' } });
    const pid = (await request('GET', '/api/concerts', { responseSchema: 'ConcertList' })).data.concerts[0].performances[0].id;
    const held = await request('PUT', `/api/performances/${pid}/hold`, { identity: owner, responseSchema: 'HoldResult', body: { seatIds: ['H-12'] } });
    const order = { holdId: held.data.hold.id, buyerName: '가상예매자', buyerPhone: '01012345678', delivery: 'mobile', agreed: true, paymentMethod: 'demo', total: 1, fee: 0, user_id: admin.data.user.id, performanceId: 'forged' };
    await request('POST', '/api/bookings', { identity: admin, expected: 404, body: order });
    await request('POST', '/api/bookings', { identity: owner, csrf: admin.csrf, expected: 403, body: order });
    await request('POST', '/api/admin/concerts', { identity: owner, expected: 403, body: {} });
    await request('PATCH', `/api/admin/performances/${pid}/seats`, { identity: owner, expected: 403, body: { seatIds: ['A-01'], blocked: true } });
    const booking = (await request('POST', '/api/bookings', { identity: owner, expected: 201, responseSchema: 'BookingResult', body: order })).data.booking;
    assert.equal(booking.total, 92000);
    assert.equal(booking.user_id, owner.data.user.id);
    assert.equal(booking.performance_id, pid);
    await request('POST', `/api/bookings/${booking.id}/cancel`, { identity: admin, expected: 404 });
    assert.equal((await request('GET', '/api/bookings', { identity: admin, responseSchema: 'BookingList' })).data.bookings.length, 0);
    await request('POST', `/api/bookings/${booking.id}/cancel`, { identity: owner, responseSchema: 'BookingResult' });
    await request('PUT', `/api/performances/${pid}/hold`, { identity: owner, responseSchema: 'HoldResult', body: { seatIds: ['H-11'] } });
    await request('POST', '/api/auth/logout', { identity: owner, responseSchema: 'Ok' });
    const anonymousMap = (await request('GET', `/api/performances/${pid}/seats`, { identity: owner, responseSchema: 'SeatMap' })).data;
    assert.equal(anonymousMap.hold, null);
    assert.equal(anonymousMap.seats.find(s => s.id === 'H-11').state, 'held');
    await request('GET', '/api/bookings', { identity: owner, expected: 401 });
    now += 7 * 86400000; // Session expiry is inclusive at the exact boundary.
    assert.equal((await request('GET', '/api/session', { identity: admin, responseSchema: 'Session' })).data.user, null);
    await request('PATCH', `/api/admin/performances/${pid}/seats`, { identity: admin, expected: 401, body: { seatIds: ['A-01'], blocked: true } });
  });
}
