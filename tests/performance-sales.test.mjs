import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { validateModel } from '../db/model.mjs';

for (const schema of ['legacy', 'model']) {
  test(`[${schema}] 회차 판매 재개와 최종 취소는 예매 이력 및 다른 회차를 보호한다`, async t => {
    const now = 1800000000000;
    const app = await createApp({ schema, dbPath: ':memory:', demo: true, now: () => now, queueOptions: { admitPerSecond: 1000 } });
    const { store, server, queue } = app;
    t.after(() => app.shutdown(1000));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const admin = store.get("SELECT id FROM users WHERE role='admin'");
    const member = store.get("SELECT id FROM users WHERE role='user'");
    const auth = id => {
      const { token, csrf } = store.createSession(id);
      return { cookie: `ticket_ssu_session=${token}`, 'X-CSRF-Token': csrf };
    };
    const adminAuth = auth(admin.id), memberAuth = auth(member.id);
    const request = async (method, path, headers = {}, body) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined
      });
      return { status: response.status, data: await response.json() };
    };
    const concert = { title: '회차 관리 테스트', artist: '가상 밴드', venue: '가상 공연장', description: '공연 취소 검증', basePrice: 50000,
      dates: [new Date(now + 2 * 86400000).toISOString(), new Date(now + 3 * 86400000).toISOString()] };
    const original = store.createConcert(admin.id, concert);
    const [first, second] = store.concerts().find(c => c.id === original.id).performances;
    const payload = hold => ({ holdId: hold.id, buyerName: '가상 회원', buyerPhone: '01000000000', delivery: 'mobile', paymentMethod: 'demo', agreed: true });
    const book = seatIds => store.checkout(member.id, payload(store.setHold(member.id, first.id, seatIds).hold));
    const confirmed = book(['A-01', 'A-02']);
    const selfCancelled = store.cancel(member.id, book(['A-03']).id);
    const oldHold = store.setHold(member.id, first.id, ['A-04']).hold;
    const otherHold = store.setHold(member.id, second.id, ['A-05']).hold;
    const queuePath = id => `/api/v1/performances/${id}/queue`;
    const seatsPath = id => `/api/performances/${id}/seats`;
    const target = (id, revision, booking_count) => ({ performance_id: id, revision, booking_count });
    const changePath = '/api/admin/performance-sales';
    const reason = '공연장 사정으로 회차 취소';
    const change = (action, targets, headers = adminAuth) => request('POST', changePath, headers, { action, targets, reason });
    assert.equal((await request('POST', queuePath(first.id), memberAuth, {})).status, 200);
    assert.equal((await request('POST', queuePath(second.id), memberAuth, {})).status, 200);
    assert.equal((await change('pause', [target(first.id, 0, 1)], memberAuth)).status, 403);
    assert.equal((await change('pause', [target(first.id, 0, 1)], { cookie: adminAuth.cookie })).status, 403);
    assert.equal((await change('pause', [target(first.id, 0, 1)])).data.state, 'paused');
    assert.equal(queue.stats().entries, 1);
    const paused = store.concerts().find(c => c.id === original.id).performances[0];
    assert.equal(paused.sale_state, 'paused');
    assert.equal(paused.available, 0);
    assert.equal((await request('GET', queuePath(first.id), memberAuth)).data.code, 'PERFORMANCE_UNAVAILABLE');
    assert.equal((await request('POST', '/api/bookings', memberAuth, payload(oldHold))).status, 409);
    assert.equal((await request('PUT', `/api/performances/${first.id}/hold`, memberAuth, { seatIds: ['A-04'] })).status, 409);
    assert.equal(store.booking(confirmed.id, member.id).status, 'confirmed');
    assert.deepEqual(store.liveHolds(member.id).map(h => h.id), [otherHold.id]);

    assert.equal((await change('resume', [target(first.id, 1, 1)])).data.state, 'open');
    assert.equal((await request('POST', queuePath(first.id), memberAuth, {})).status, 200);
    store.setHold(member.id, first.id, ['A-06']);
    assert.equal((await change('cancel', [target(first.id, 2, 0)])).status, 409);
    const batch = { action: 'cancel', targets: [target(second.id, 0, 0), target(first.id, 2, 1)], reason };
    store.db.exec(`CREATE TEMP TRIGGER fail_cancellation_log BEFORE INSERT ON performance_cancelled_bookings
      BEGIN SELECT RAISE(ABORT, 'simulated cancellation log failure'); END`);
    assert.throws(() => store.changePerformanceSales(admin.id, batch), /simulated cancellation log failure/);
    store.db.exec('DROP TRIGGER fail_cancellation_log');
    assert.equal(store.performanceSale(second.id).state, 'open');
    assert.equal(store.performanceSale(first.id).state, 'open');
    assert.equal(store.booking(confirmed.id, member.id).status, 'confirmed');
    assert.equal(store.liveHolds(member.id).length, 2);
    assert.equal(queue.stats().entries, 2);

    const result = await change('cancel', [target(first.id, 2, 1)]);
    assert.deepEqual(result, { status: 200, data: { state: 'cancelled', performance_ids: [first.id], cancelled_bookings: 1 } });
    assert.equal((await request('GET', seatsPath(first.id), memberAuth)).status, 404);
    assert.equal((await request('GET', seatsPath(first.id), adminAuth)).status, 200);
    assert.equal((await request('POST', queuePath(first.id), memberAuth, {})).status, 409);
    assert.equal((await request('GET', queuePath(second.id), memberAuth)).status, 200);
    assert.deepEqual(store.concerts().find(c => c.id === original.id).performances.map(p => p.id), [second.id]);
    const bookingList = (await request('GET', '/api/bookings', memberAuth)).data.bookings;
    assert.deepEqual(bookingList.find(b => b.id === confirmed.id),
      JSON.parse(JSON.stringify({ ...confirmed, status: 'cancelled', cancelled_at: now, performance_cancel_reason: reason })));
    assert.equal(bookingList.find(b => b.id === selfCancelled.id).performance_cancel_reason, undefined);
    assert.equal((await change('resume', [target(first.id, 3, 0)])).status, 409);
    assert.throws(() => store.createConcert(admin.id, concert), { status: 409 });
    assert.equal((await change('cancel', [target(second.id, 0, 0)])).data.state, 'cancelled');
    assert.equal(queue.stats().entries, 0);
    assert.ok(!store.concerts().some(c => c.id === original.id));
    assert.notEqual(store.createConcert(admin.id, concert).id, original.id);
    assert.equal(store.booking(confirmed.id, member.id).status, 'cancelled');
    if (schema === 'model') validateModel(store.db);
  });
}
