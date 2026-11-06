import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { ModelStore } from '../lib/model-store.mjs';
import { Store } from '../lib/store.mjs';
import { createApp } from '../server.mjs';
import { admissionHeaders } from './helpers/admission.mjs';
import { migrateLegacy } from '../db/migrate.mjs';
import { validateModel } from '../db/model.mjs';
import { validateValue, currentSpec } from '../scripts/check-api.mjs';

async function fixture(t) {
  let now = 1800000000000;
  const store = new ModelStore(':memory:', { now: () => now, holdMs: 1000 });
  t.after(() => { try { validateModel(store.db); } finally { store.close(); } });
  await store.seed();
  const user = await store.authenticate('demo@ticket-ssu.local', 'TicketSsuDemo123!');
  const admin = await store.authenticate('admin@ticket-ssu.local', 'TicketSsuAdmin123!');
  const pid = store.concerts()[0].performances[0].id;
  const checkout = (id, hold) => store.checkout(id, { holdId: hold.id, buyerName: '가상예매자', buyerPhone: '01012345678', delivery: 'mobile', agreed: true, paymentMethod: 'demo', total: 1 });
  return { store, user, admin, pid, checkout, advance: n => { now += n; } };
}

test('모델 Store는 변경/만료/옛 hold ID를 동일 정책으로 처리한다', async t => {
  const { store, user, pid, checkout, advance } = await fixture(t);
  const first = store.setHold(user.id, pid, ['A-01']).hold;
  advance(100);
  const second = store.setHold(user.id, pid, ['A-02']).hold;
  assert.notEqual(first.id, second.id);
  assert.equal(first.expires_at, second.expires_at);
  assert.throws(() => checkout(user.id, first), { status: 409 });
  advance(901);
  assert.equal(store.seatMap(pid, user.id).hold, null);
  assert.throws(() => checkout(user.id, second), { status: 409 });
  const next = store.setHold(user.id, pid, ['A-01']).hold;
  let reads = 0;
  store.now = () => next.expires_at - 1 + reads++;
  store.expire();
  assert.equal(reads, 1);
  assert.equal(store.get('SELECT status FROM holds WHERE id=?', next.id).status, 'active');
  store.expire();
  assert.equal(store.get('SELECT status FROM holds WHERE id=?', next.id).status, 'expired');
});

test('모델 Store의 소유권·4매·서버 금액·재시도·취소 이력이 유지된다', async t => {
  const { store, user, admin, pid, checkout } = await fixture(t);
  const hold = store.setHold(user.id, pid, ['A-01', 'A-02', 'A-03', 'A-04']).hold;
  assert.throws(() => checkout(admin.id, hold), { status: 404 });
  const booking = checkout(user.id, hold);
  assert.equal(booking.total, 528000);
  assert.equal(checkout(user.id, hold).id, booking.id);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM payment_attempts').n, 1);
  assert.throws(() => store.setHold(user.id, pid, ['B-01']), { status: 409 });
  assert.throws(() => store.cancel(admin.id, booking.id), { status: 404 });
  assert.equal(store.cancel(user.id, booking.id).status, 'cancelled');
  const cancelledAt = store.booking(booking.id, user.id).cancelled_at;
  assert.equal(store.cancel(user.id, booking.id).cancelled_at, cancelledAt);
  assert.equal(checkout(user.id, hold).status, 'cancelled');
  checkout(admin.id, store.setHold(admin.id, pid, ['A-01']).hold);
  assert.equal(store.booking(booking.id, user.id).seats.length, 4);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM booking_items').n, 5);
});

test('모델 확정/취소 중간 실패는 점유·이력·시도를 함께 롤백한다', async t => {
  const { store, user, pid, checkout } = await fixture(t);
  const hold = store.setHold(user.id, pid, ['A-01', 'A-02']).hold;
  store.db.exec(`CREATE TRIGGER reject_second_item BEFORE INSERT ON booking_items
    WHEN (SELECT s.seat_code FROM inventory i JOIN physical_seats s ON s.id=i.physical_seat_id WHERE i.id=NEW.inventory_id)='A-02'
    BEGIN SELECT RAISE(ABORT,'injected item failure'); END;`);
  assert.throws(() => checkout(user.id, hold), /injected item failure/);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM bookings').n, 0);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM payment_attempts').n, 0);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM current_holds WHERE hold_id=?', hold.id).n, 2);
  assert.equal(store.get('SELECT status FROM holds WHERE id=?', hold.id).status, 'active');
  store.db.exec('DROP TRIGGER reject_second_item');
  const booking = checkout(user.id, hold);
  store.db.exec("CREATE TRIGGER reject_cancel BEFORE UPDATE OF status ON bookings WHEN NEW.status='cancelled' BEGIN SELECT RAISE(ABORT,'injected cancel failure'); END;");
  assert.throws(() => store.cancel(user.id, booking.id), /injected cancel failure/);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM current_bookings WHERE booking_id=?', booking.id).n, 2);
  assert.equal(store.booking(booking.id, user.id).status, 'confirmed');
  store.db.exec('DROP TRIGGER reject_cancel');
  store.cancel(user.id, booking.id);
});

test('모델 관리자 등록은 공유 물리 좌석·96석/회차를 만들고 실패 시 모두 롤백한다', async t => {
  const { store, user, admin, advance } = await fixture(t);
  const data = { title: '가상 공연', artist: '가상 밴드', venue: '가상 공연장', description: '검증용', basePrice: 50000,
    dates: [new Date(1800000000000 + 86400000).toISOString(), new Date(1800000000000 + 2 * 86400000).toISOString()] };
  assert.throws(() => store.createConcert(user.id, data), { status: 403 });
  const tables = ['concerts', 'venues', 'physical_seats', 'performances', 'inventory', 'audit_events'];
  const counts = () => tables.map(table => store.get(`SELECT COUNT(*) AS n FROM ${table}`).n);
  const before = counts();
  store.db.exec("CREATE TRIGGER reject_new_inventory BEFORE INSERT ON inventory BEGIN SELECT RAISE(ABORT,'injected registration failure'); END;");
  assert.throws(() => store.createConcert(admin.id, data), /injected registration failure/);
  assert.deepEqual(counts(), before);
  store.db.exec('DROP TRIGGER reject_new_inventory');
  const { id } = store.createConcert(admin.id, data);
  const concert = store.concerts().find(c => c.id === id);
  const after = counts();
  assert.deepEqual(after.map((n, i) => n - before[i]), [1, 1, 96, 2, 192, 1]);
  assert.equal(store.seatMap(concert.performances[0].id).seats[0].price, 90000);
  const pid = concert.performances[0].id;
  const booking = store.checkout(user.id, { holdId: store.setHold(user.id, pid, ['A-01']).hold.id, buyerName: '가상예매자', buyerPhone: '01012345678', delivery: 'mobile', agreed: true, paymentMethod: 'demo' });
  advance(86400001);
  assert.throws(() => store.cancel(user.id, booking.id), { status: 409 });
  assert.throws(() => store.setHold(user.id, pid, ['A-02']), { status: 409 });
});

test('모델 요청 경로는 오프라인 전체 무결성 스캔을 호출하지 않는다', async t => {
  const { store, user, pid, checkout } = await fixture(t);
  const prepare = store.db.prepare;
  store.db.prepare = function (sql) {
    assert.ok(!/integrity_check|foreign_key_check|SELECT email FROM users/.test(sql), 'offline full validation in request');
    return prepare.call(this, sql);
  };
  try {
    store.concerts();
    const b = checkout(user.id, store.setHold(user.id, pid, ['A-01']).hold);
    store.seatMap(pid, user.id);
    store.bookings(user.id);
    store.cancel(user.id, b.id);
  } finally { store.db.prepare = prepare; }
});

test('이관한 파일의 원래 쿠키·CSRF·공개 ID·선점·예매를 HTTP에서 이어 쓴다', async t => {
  const root = resolve(tmpdir()), dir = await mkdtemp(join(root, 'ticket-ssu-integration-'));
  let serving;
  t.after(async () => {
    if (serving) await new Promise(r => serving.close(r));
    assert.ok(resolve(dir).startsWith(root + sep) && resolve(dir).slice(root.length + 1).startsWith('ticket-ssu-integration-'));
    await rm(dir, { recursive: true, force: true });
  });
  const source = join(dir, 'legacy.sqlite'), target = join(dir, 'model.sqlite'), now = 1800000000000;
  const legacy = new Store(source, { now: () => now });
  let user, pid, held, session, before;
  try {
    await legacy.seed();
    user = await legacy.authenticate('demo@ticket-ssu.local', 'TicketSsuDemo123!');
    pid = legacy.concerts()[0].performances[0].id;
    const old = legacy.checkout(user.id, { holdId: legacy.setHold(user.id, pid, ['A-01']).hold.id, buyerName: '가상예매자', buyerPhone: '01012345678', delivery: 'mobile', agreed: true, paymentMethod: 'demo' });
    legacy.cancel(user.id, old.id);
    held = legacy.setHold(user.id, pid, ['A-02']).hold;
    session = legacy.createSession(user.id);
    before = JSON.parse(JSON.stringify(legacy.bookings(user.id)));
  } finally { legacy.close(); }
  const hash = async () => createHash('sha256').update(await readFile(source)).digest('hex');
  const originalHash = await hash();
  await assert.rejects(createApp({ dbPath: source, schema: 'model', demo: false, now: () => now }), /자동 이관하지 않습니다/);
  assert.equal(await hash(), originalHash);
  migrateLegacy(source, target);
  const { server, store } = await createApp({ dbPath: target, schema: 'model', demo: false, now: () => now, secureCookies: false, queueOptions: { admitPerSecond: 1000 } });
  serving = server;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Cookie: `ticket_ssu_session=${session.token}`, 'X-CSRF-Token': session.csrf };
  const request = async (method, path, body, expected, schema) => {
    const admitted = await admissionHeaders(store, base, { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, method, path, body);
    const response = await fetch(base + path, { method, headers: admitted, body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.status, expected);
    const data = await response.json(); validateValue(currentSpec, currentSpec.components.schemas[schema], data); return data;
  };
  assert.equal((await request('GET', '/api/session', null, 200, 'Session')).csrf, session.csrf);
  assert.deepEqual((await request('GET', '/api/bookings', null, 200, 'BookingList')).bookings, before);
  const imported = before[0];
  const importedBody = { holdId: imported.hold_id, buyerName: imported.buyer_name, buyerPhone: imported.buyer_phone, delivery: imported.delivery, agreed: true, paymentMethod: 'demo' };
  const retryImported = async body => {
    const response = await fetch(base + '/api/bookings', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': 'imported-replay' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const importedReplay = await retryImported(importedBody);
  assert.equal(importedReplay.status, 201);
  assert.deepEqual(importedReplay.body.booking, imported);
  assert.equal((await retryImported({ ...importedBody, delivery: imported.delivery === 'mobile' ? 'onsite' : 'mobile' })).status, 409);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM payment_attempts').n, 0, 'imported retry must not fabricate a past payment attempt');
  const map = await request('GET', `/api/performances/${pid}/seats`, null, 200, 'SeatMap');
  assert.equal(map.hold.id, held.id);
  assert.equal(map.seats.find(s => s.id === 'A-02').state, 'selected');
  await request('PUT', `/api/performances/${pid}/hold`, { seatIds: ['A-02', 'A-03'] }, 403, 'Error');
  await request('PUT', `/api/performances/${pid}/hold`, { seatIds: [] }, 200, 'HoldResult');
  const { hold } = await request('PUT', `/api/performances/${pid}/hold`, { seatIds: ['A-02', 'A-03'] }, 200, 'HoldResult');
  assert.equal(hold.expires_at, held.expires_at);
  const { booking } = await request('POST', '/api/bookings', { holdId: hold.id, buyerName: '가상예매자', buyerPhone: '01012345678', delivery: 'mobile', agreed: true, paymentMethod: 'demo' }, 201, 'BookingResult');
  assert.equal(booking.user_id, user.id);
  assert.equal(booking.performance_id, pid);
  assert.deepEqual(booking.seats.map(s => s.seat_id), ['A-02', 'A-03']);
  assert.equal(booking.total, 264000);
  await request('POST', `/api/bookings/${booking.id}/cancel`, null, 200, 'BookingResult');
  assert.equal(store.get('SELECT COUNT(*) AS n FROM payment_attempts').n, 1);
  validateModel(store.db);
  assert.equal(await hash(), originalHash);
});

test('model 모드는 기존 기본 DB·잘못된 모드·기존 스키마의 자동 전환을 거부한다', async () => {
  await assert.rejects(createApp({ schema: 'model', dbPath: resolve('data/ticket-ssu.sqlite'), demo: false }), /별도의 DB_PATH/);
  await assert.rejects(createApp({ schema: 'unknown', dbPath: ':memory:' }), /DB_SCHEMA/);
  assert.throws(() => new Store(':memory:', { schema: 'model' }), /ModelStore/);
});
