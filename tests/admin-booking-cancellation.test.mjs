import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';
import { ModelStore } from '../lib/model-store.mjs';
import { validateModel } from '../db/model.mjs';

const request = { reason: 'customer_request', confirmed: true };

for (const Storage of [Store, ModelStore]) {
  test(`${Storage.name}: 관리자 취소는 좌석·예매 상태·처리 기록을 함께 저장한다`, async t => {
    let now = 1800000000000;
    const store = new Storage(':memory:', { now: () => now });
    t.after(() => store.close());
    await store.seed();
    const admin = store.get("SELECT id FROM users WHERE role='admin'").id;
    const member = store.get("SELECT id FROM users WHERE role='user'").id;
    const [first, second] = store.concerts()[0].performances;
    const book = (performance, seats) => store.checkout(member, {
      holdId: store.setHold(member, performance.id, seats).hold.id,
      buyerName: '가상 예매자', buyerPhone: '01000000000', delivery: 'mobile', agreed: true, paymentMethod: 'demo'
    });
    const target = book(first, ['A-01', 'A-02']);
    const selfCancelled = book(first, ['A-03']);
    const later = book(second, ['A-01']);
    store.cancel(member, selfCancelled.id);
    assert.equal(store.cancelAsAdmin(admin, selfCancelled.id, request).admin_cancel_reason, undefined);
    assert.throws(() => store.adminBooking(member, target.id), { status: 403 });
    assert.throws(() => store.cancelAsAdmin(member, target.id, request), { status: 403 });
    assert.throws(() => store.cancelAsAdmin(admin, target.id, { ...request, confirmed: false }), { status: 400 });
    assert.throws(() => store.cancelAsAdmin(admin, 'missing', request), { status: 404 });

    store.db.exec(`CREATE TEMP TRIGGER simulate_audit_error BEFORE INSERT ON admin_booking_cancellations
      BEGIN SELECT RAISE(ABORT, 'simulated audit failure'); END`);
    assert.throws(() => store.cancelAsAdmin(admin, target.id, request), /simulated audit failure/);
    assert.deepEqual(store.booking(target.id, member), target);
    const seatStates = () => store.seatMap(first.id).seats.slice(0, 2).map(seat => seat.state);
    assert.deepEqual(seatStates(), ['booked', 'booked']);
    store.db.exec('DROP TRIGGER simulate_audit_error');

    const cancelled = store.cancelAsAdmin(admin, target.id, request);
    assert.deepEqual(seatStates(), ['available', 'available']);
    assert.deepEqual(store.booking(target.id, member), {
      ...target, status: 'cancelled', cancelled_at: now, admin_cancel_reason: 'customer_request'
    });
    assert.deepEqual(store.booking(later.id, member), later);
    assert.deepEqual(store.cancelAsAdmin(admin, target.id, request), cancelled);
    assert.deepEqual(store.all('SELECT * FROM admin_booking_cancellations').map(row => ({ ...row })), [
      { booking_id: target.id, admin_id: admin, reason: 'customer_request', created_at: now }
    ]);
    const event = store.adminSummary(admin).audit.find(audit => audit.action === 'cancel-booking');
    assert.deepEqual(JSON.parse(event.detail), { bookingId: target.id, reason: 'customer_request' });

    now = later.starts_at;
    assert.equal(store.adminBooking(admin, later.id).can_cancel, false);
    assert.throws(() => store.cancelAsAdmin(admin, later.id, request), { status: 409 });
    assert.deepEqual(store.booking(later.id, member), later);
    if (store.schema === 'model') validateModel(store.db);
  });
}
