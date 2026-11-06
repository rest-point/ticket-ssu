import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../lib/store.mjs';
import { applySchema, configure, validateModel, modelTransaction, withNewDatabase, destinationPath } from '../db/model.mjs';
import { migrateLegacy, snapshotDatabase, insertRow } from '../db/migrate.mjs';
import { seedDemo } from '../db/seeds/demo.mjs';

const now = 1800000000000;
const hash = 'a'.repeat(64);
const scalar = (db, sql, ...args) => Object.values(db.prepare(sql).get(...args))[0];
function model(t) {
  const db = applySchema(new DatabaseSync(':memory:'));
  seedDemo(db, { now });
  t.after(() => db.close());
  return db;
}
async function directory(t) {
  const base = resolve(tmpdir());
  const dir = await mkdtemp(join(base, 'ticket-ssu-model-'));
  t.after(async () => {
    assert.ok(resolve(dir).startsWith(base + sep) && resolve(dir).slice(base.length + 1).startsWith('ticket-ssu-model-'));
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
function hold(db, id, user, seats, performance = 'seed-performance-1') {
  insertRow(db, 'holds', { id, user_id: user, performance_id: performance, expires_at: now + 420000, status: 'active' });
  for (const inv of seats) insertRow(db, 'current_holds', { inventory_id: inv, hold_id: id });
}
function confirm(db, id, user, seats) {
  hold(db, `h:${id}`, user, seats);
  db.prepare('DELETE FROM current_holds WHERE hold_id=?').run(`h:${id}`);
  db.prepare("UPDATE holds SET status='converted' WHERE id=?").run(`h:${id}`);
  insertRow(db, 'bookings', { id, hold_id: `h:${id}`, status: 'confirmed', fee: seats.length * 2000, buyer_name: '가상예매자', buyer_phone: '01012345678', delivery: 'mobile', created_at: now, cancelled_at: null });
  for (const inv of seats) {
    const s = db.prepare('SELECT * FROM inventory WHERE id=?').get(inv);
    insertRow(db, 'booking_items', { booking_id: id, inventory_id: inv, grade_snapshot: s.grade, price_snapshot: s.price });
    insertRow(db, 'current_bookings', { inventory_id: inv, booking_id: id });
  }
  const amount = scalar(db, 'SELECT total FROM booking_totals WHERE id=?', id);
  insertRow(db, 'payment_attempts', { id: `p:${id}`, hold_id: `h:${id}`, request_key: `key:${id}`, body_hash: hash, result: 'succeeded', amount, booking_id: id, failure_code: null, attempted_at: now });
}

test('새 STRICT DDL은 논리 속성·복합 FK·필수 키와 실제 PRAGMA를 갖는다', async t => {
  const db = model(t);
  const logical = await readFile(new URL('../docs/data-model/logical.md', import.meta.url), 'utf8');
  for (const [, table, cols] of logical.matchAll(/^([a-z_]+)\(([a-z_, ]+)\)$/gm)) {
    assert.deepEqual(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name), cols.split(', '));
  }
  assert.equal(db.prepare('PRAGMA table_list').all().filter(r => r.schema === 'main' && r.type === 'table' && !r.name.startsWith('sqlite_')).filter(r => r.strict === 1).length, 15);
  assert.equal(scalar(db, 'PRAGMA foreign_keys'), 1);
  assert.equal(scalar(db, 'PRAGMA busy_timeout'), 5000);
  assert.equal(scalar(db, 'SELECT COUNT(*) FROM physical_seats'), 192);
  assert.equal(scalar(db, 'SELECT COUNT(*) FROM inventory'), 288);
  assert.throws(() => db.prepare("UPDATE inventory SET blocked='invalid'").run(), /datatype|INT/);
  assert.throws(() => db.prepare('UPDATE users SET id=NULL').run(), /NOT NULL/);
  const malformedHash = 'a'.repeat(32) + ':' + 'b'.repeat(63) + ':' + 'c'.repeat(64);
  assert.throws(() => db.prepare("UPDATE users SET password_hash=? WHERE id='seed-user'").run(malformedHash), /CHECK/);
  assert.throws(() => seedDemo(db, { now }), /empty/);
});

test('공연장 불일치·다른 회차 연결·부모 식별 변경을 거부한다', t => {
  const db = model(t);
  assert.throws(() => insertRow(db, 'inventory', { id: 'bad', performance_id: 'seed-performance-1', physical_seat_id: 'south:A-01', grade: 'VIP', price: 90000, blocked: 0 }), /venue mismatch/);
  assert.throws(() => db.prepare("UPDATE performances SET venue_id='seed-south' WHERE id='seed-performance-1'").run(), /immutable/);
  assert.throws(() => db.prepare("UPDATE physical_seats SET seat_code='changed' WHERE id='north:A-01'").run(), /immutable/);
  assert.throws(() => modelTransaction(db, () => hold(db, 'bad-hold', 'seed-user', ['seed:3:A-01'])), /invalid current hold/);
  assert.equal(scalar(db, "SELECT COUNT(*) FROM holds WHERE id='bad-hold'"), 0);
});

test('다중 선점 충돌은 전체 롤백하고 차단·4매 제한·만료 연장을 막는다', t => {
  const db = model(t);
  modelTransaction(db, () => hold(db, 'one', 'seed-user', ['seed:1:A-01']));
  assert.throws(() => modelTransaction(db, () => hold(db, 'two', 'seed-admin', ['seed:1:A-02', 'seed:1:A-01'])), /UNIQUE/);
  assert.equal(scalar(db, "SELECT COUNT(*) FROM current_holds WHERE inventory_id='seed:1:A-02'"), 0);
  assert.throws(() => db.prepare("UPDATE inventory SET blocked=1 WHERE id='seed:1:A-01'").run(), /occupied/);
  assert.throws(() => db.prepare("UPDATE holds SET expires_at=expires_at+1 WHERE id='one'").run(), /immutable/);
  assert.throws(() => modelTransaction(db, () => hold(db, 'duplicate', 'seed-user', ['seed:1:A-02'])), /UNIQUE/);
  assert.throws(() => modelTransaction(db, () => hold(db, 'too-many', 'seed-admin', ['seed:1:B-01', 'seed:1:B-02', 'seed:1:B-03', 'seed:1:B-04', 'seed:1:B-05'])), /ticket limit/);
  assert.throws(() => modelTransaction(db, () => hold(db, 'empty', 'seed-admin', [])), /cardinality/);
});

test('신규 예매는 실제 항목·성공 시도·금액·원본 선점 일치가 필요하다', t => {
  const db = model(t);
  modelTransaction(db, () => confirm(db, 'b1', 'seed-user', ['seed:1:A-01', 'seed:1:A-02']));
  assert.equal(scalar(db, "SELECT total FROM booking_totals WHERE id='b1'"), 184000);
  assert.throws(() => insertRow(db, 'current_bookings', { inventory_id: 'seed:1:B-01', booking_id: 'b1' }), /FOREIGN KEY/);
  assert.throws(() => insertRow(db, 'booking_items', { booking_id: 'b1', inventory_id: 'seed:3:A-01', grade_snapshot: 'VIP', price_snapshot: 90000 }), /performance mismatch/);
  assert.throws(() => modelTransaction(db, () => confirm(db, 'too-many', 'seed-user', ['seed:1:B-01', 'seed:1:B-02', 'seed:1:B-03'])), /user ticket limit/);
  assert.throws(() => modelTransaction(db, () => {
    confirm(db, 'b2', 'seed-admin', ['seed:1:B-01']);
    // Cannot turn the second attempt into a receipt for another hold/booking.
    insertRow(db, 'payment_attempts', { id: 'bad-pay', hold_id: 'h:b2', request_key: 'different', body_hash: hash, result: 'succeeded', amount: 184000, booking_id: 'b1', failure_code: null, attempted_at: now });
  }), /mismatch/);
  assert.equal(scalar(db, "SELECT COUNT(*) FROM bookings WHERE id='b2'"), 0);
  assert.throws(() => db.prepare("DELETE FROM payment_attempts WHERE id='p:b1'").run(), /immutable/);
});

test('취소 후 재판매는 이전 스냅샷·금액·항목 이력을 보존한다', t => {
  const db = model(t);
  modelTransaction(db, () => confirm(db, 'old', 'seed-user', ['seed:1:A-01']));
  const before = { ...db.prepare("SELECT * FROM booking_totals WHERE id='old'").get() };
  modelTransaction(db, () => {
    db.prepare("DELETE FROM current_bookings WHERE booking_id='old'").run();
    db.prepare("UPDATE bookings SET status='cancelled',cancelled_at=? WHERE id='old'").run(now + 10);
    db.prepare("UPDATE inventory SET price=95000 WHERE id='seed:1:A-01'").run();
    confirm(db, 'new', 'seed-admin', ['seed:1:A-01']);
  });
  assert.equal(scalar(db, "SELECT COUNT(*) FROM booking_items WHERE inventory_id='seed:1:A-01'"), 2);
  assert.equal(scalar(db, "SELECT total FROM booking_totals WHERE id='old'"), before.total);
  assert.equal(scalar(db, "SELECT total FROM booking_totals WHERE id='new'"), 97000);
  assert.throws(() => db.prepare("DELETE FROM booking_items WHERE booking_id='old'").run(), /immutable/);
  assert.throws(() => db.prepare("UPDATE bookings SET status='confirmed',cancelled_at=NULL WHERE id='old'").run(), /mutation/);
});

test('문장별 제약을 통과해도 불완전 신규 예매는 검증 후 커밋하지 않는다', t => {
  const db = model(t);
  assert.throws(() => modelTransaction(db, () => {
    insertRow(db, 'holds', { id: 'incomplete-h', user_id: 'seed-user', performance_id: 'seed-performance-1', expires_at: now + 1, status: 'converted' });
    insertRow(db, 'bookings', { id: 'incomplete', hold_id: 'incomplete-h', status: 'confirmed', fee: 2000, buyer_name: '가상예매자', buyer_phone: '01012345678', delivery: 'mobile', created_at: now, cancelled_at: null });
    insertRow(db, 'booking_items', { booking_id: 'incomplete', inventory_id: 'seed:1:A-01', grade_snapshot: 'VIP', price_snapshot: 90000 });
    insertRow(db, 'current_bookings', { booking_id: 'incomplete', inventory_id: 'seed:1:A-01' });
  }), /without successful demo attempt/);
  assert.equal(scalar(db, "SELECT COUNT(*) FROM bookings WHERE id='incomplete'"), 0);
});

async function legacy(t) {
  const dir = await directory(t), source = join(dir, 'legacy.sqlite');
  const store = new Store(source, { now: () => now });
  await store.seed();
  const user = await store.authenticate('demo@ticket-ssu.local', 'TicketSsuDemo123!');
  const admin = await store.authenticate('admin@ticket-ssu.local', 'TicketSsuAdmin123!');
  const p = store.concerts()[0].performances[0].id;
  const checkout = who => store.checkout(who.id, { holdId: store.setHold(who.id, p, ['A-01']).hold.id, buyerName: '가상예매자', buyerPhone: '01012345678', delivery: 'mobile', paymentMethod: 'demo', agreed: true });
  const cancelled = checkout(user); store.cancel(user.id, cancelled.id);
  checkout(admin);
  store.setHold(user.id, p, ['A-02']);
  store.createSession(user.id);
  store.blockSeats(admin.id, p, ['A-03'], true);
  store.close();
  return { dir, source, target: join(dir, 'normalized.sqlite') };
}
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');

test('기존 파일을 읽기 전용 이관하고 계정·세션·취소·재판매·금액을 보존한다', async t => {
  const { source, target } = await legacy(t);
  const before = await digest(source);
  const original = new DatabaseSync(source, { readOnly: true });
  let expected;
  try { expected = Object.fromEntries(['users', 'sessions', 'holds', 'audit'].map(table => [table, original.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()])); } finally { original.close(); }
  assert.equal(migrateLegacy(source, target).bookings, 2);
  assert.equal(await digest(source), before);
  const db = configure(new DatabaseSync(target));
  try {
    for (const table of ['users', 'sessions', 'holds', 'audit']) assert.deepEqual(db.prepare(`SELECT * FROM ${table === 'audit' ? 'audit_events' : table} ORDER BY 1`).all(), expected[table]);
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM payment_attempts'), 0);
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM legacy_booking_imports'), 2);
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM current_holds'), 1);
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM current_bookings'), 1);
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM venues'), 8);
    assert.equal(scalar(db, 'PRAGMA journal_mode'), 'wal');
    validateModel(db);
  } finally { db.close(); }
  assert.throws(() => migrateLegacy(source, target), /already exists/);
  const size = (await stat(target)).size;
  assert.throws(() => new Store(target), /기존 스키마 전용/);
  assert.equal((await stat(target)).size, size);
});

test('원본 금액 불일치는 재계산하지 않고 이관을 중단한다', async t => {
  const { source, target } = await legacy(t);
  const bad = new DatabaseSync(source);
  bad.exec('UPDATE bookings SET total=total+1'); bad.close();
  const before = await digest(source);
  assert.throws(() => migrateLegacy(source, target), /refusing recalculation/);
  assert.equal(existsSync(target), false);
  assert.equal(await digest(source), before);
});

test('이관 도중 새 도메인 위반이 나면 새 대상만 정리하고 원본을 보존한다', async t => {
  const { source, target } = await legacy(t);
  const bad = new DatabaseSync(source);
  bad.exec("UPDATE users SET phone='invalid'"); bad.close();
  const before = await digest(source);
  assert.throws(() => migrateLegacy(source, target), /CHECK/);
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(target + '-wal'), false);
  assert.equal(await digest(source), before);
});

test('VACUUM INTO 스냅샷을 다시 열어 검증하고 복구 입력으로 사용할 수 있다', async t => {
  const { dir, source } = await legacy(t), backup = join(dir, 'backup.sqlite'), recovered = join(dir, 'recovered.sqlite');
  const writer = configure(new DatabaseSync(source));
  try {
    // Leave a committed change in WAL while this connection remains open.
    writer.prepare("UPDATE users SET name='스냅샷회원' WHERE email='demo@ticket-ssu.local'").run();
    const before = await digest(source);
    assert.equal(snapshotDatabase(source, backup).verified, true);
    assert.equal(await digest(source), before);
    const restored = new DatabaseSync(backup, { readOnly: true });
    try { assert.equal(scalar(restored, "SELECT name FROM users WHERE email='demo@ticket-ssu.local'"), '스냅샷회원'); }
    finally { restored.close(); }
  } finally { writer.close(); }
  assert.equal(migrateLegacy(backup, recovered).bookings, 2);
  assert.throws(() => snapshotDatabase(source, backup), /already exists/);
});

test('원본 경로·기존 파일을 덮어쓰지 않고 재초기화를 거부한다', async t => {
  const dir = await directory(t), file = join(dir, 'existing.sqlite');
  await writeFile(file, 'user-owned');
  assert.throws(() => withNewDatabase(file, () => {}), /already exists/);
  assert.equal(await readFile(file, 'utf8'), 'user-owned');
  assert.throws(() => destinationPath(resolve('data/ticket-ssu.sqlite')), /protected/);
  assert.throws(() => destinationPath(resolve('public/exposed.sqlite')), /tracked/);
  const db = model(t);
  assert.throws(() => applySchema(db), /empty/);
  assert.equal(scalar(db, 'SELECT COUNT(*) FROM inventory'), 288);
});
