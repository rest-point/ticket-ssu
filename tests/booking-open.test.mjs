import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Store } from '../lib/store.mjs';
import { ModelStore } from '../lib/model-store.mjs';
import { DatabaseSync } from 'node:sqlite';
import { validateModel, enableBookingOpening } from '../db/model.mjs';
import { migrateLegacy } from '../db/migrate.mjs';
import { createApp } from '../server.mjs';
import { currentSpec, validateResponse, validateValue } from '../scripts/check-api.mjs';

const initialTime = 1800000000000;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const iso = ms => new Date(ms).toISOString();
const concertBody = (overrides = {}) => ({
  title: '오픈 시각 검증 공연', artist: '가상 밴드', venue: '가상 공연장', description: '예매 오픈 검증',
  basePrice: 50000, dates: [iso(initialTime + 10 * DAY), iso(initialTime + 11 * DAY)], ...overrides
});
const StoreFor = schema => schema === 'model' ? ModelStore : Store;

async function fixture(t, schema) {
  let now = initialTime;
  const store = new (StoreFor(schema))(':memory:', { now: () => now });
  t.after(() => store.close());
  await store.seed();
  const user = await store.authenticate('demo@ticket-ssu.local', 'TicketSsuDemo123!');
  const admin = await store.authenticate('admin@ticket-ssu.local', 'TicketSsuAdmin123!');
  const create = overrides => {
    const { id } = store.createConcert(admin.id, concertBody(overrides));
    const concert = store.concerts().find(c => c.id === id);
    return { concert, pid: concert.performances[0].id };
  };
  return { store, user, admin, create, setTime: value => { now = value; },
    verify: () => { if (schema === 'model') validateModel(store.db); } };
}

for (const schema of ['legacy', 'model']) {
  test(`[${schema}] 예매 오픈 일시를 저장하고 공연·좌석 조회에 노출한다`, async t => {
    const f = await fixture(t, schema);
    const opensAt = initialTime + 2 * DAY;
    const { concert, pid } = f.create({ bookingOpensAt: iso(opensAt) });
    assert.equal(concert.booking_opens_at, opensAt);
    validateValue(currentSpec, currentSpec.components.schemas.Concert, concert);
    const map = f.store.seatMap(pid, f.user.id);
    assert.equal(map.performance.booking_opens_at, opensAt);
    validateValue(currentSpec, currentSpec.components.schemas.SeatMap, map);
    f.verify();
  });

  test(`[${schema}] 오픈 일시를 생략하면 등록 시각에 즉시 오픈한다`, async t => {
    const f = await fixture(t, schema);
    const { concert, pid } = f.create();
    assert.equal(concert.booking_opens_at, initialTime);
    assert.ok(f.store.setHold(f.user.id, pid, ['A-01']).hold);
    f.verify();
  });

  test(`[${schema}] 분 단위 입력으로 생긴 60초 이내의 과거 오픈 일시는 등록 시각으로 맞춘다`, async t => {
    const f = await fixture(t, schema);
    const { concert, pid } = f.create({ bookingOpensAt: iso(initialTime - 59000) });
    assert.equal(concert.booking_opens_at, initialTime);
    assert.ok(f.store.setHold(f.user.id, pid, ['A-01']).hold);
    f.verify();
  });

  test(`[${schema}] 잘못된 오픈 일시는 아무것도 만들지 않고 400으로 거부한다`, async t => {
    const f = await fixture(t, schema);
    const before = f.store.concerts().length;
    const firstStart = initialTime + 10 * DAY;
    for (const bookingOpensAt of [
      iso(initialTime - 60001),            // 허용 오차(60초)를 넘는 과거
      iso(firstStart),                     // 첫 회차 시작과 같음
      iso(firstStart + HOUR),              // 첫 회차 시작 이후
      '2027-01-01T19:00:00',               // 시간대 없음
      'not-a-date',
      initialTime + DAY,                   // 문자열 아님
      ''
    ]) {
      assert.throws(() => f.store.createConcert(f.admin.id, concertBody({ bookingOpensAt })), e => e.status === 400, String(bookingOpensAt));
    }
    assert.equal(f.store.concerts().length, before);
    f.verify();
  });

  test(`[${schema}] 존재하지 않는 공연일과 오픈일을 거부하고 유효한 윤일과 시간대를 허용한다`, async t => {
    const f = await fixture(t, schema);
    const before = f.store.concerts().length;
    for (const invalid of ['2027-02-29T19:00:00+09:00', '2027-02-30T19:00:00+09:00', '2027-04-31T00:30:00Z']) {
      assert.throws(() => f.create({ dates: [invalid] }), { status: 400 });
      assert.throws(() => f.create({ dates: ['2027-05-02T19:00:00+09:00'], bookingOpensAt: invalid }), { status: 400 });
    }
    assert.equal(f.store.concerts().length, before);

    const { concert } = f.create({ dates: ['2028-03-01T23:15-05:00'], bookingOpensAt: '2028-02-29T00:30:00.125+09:00' });
    assert.equal(concert.performances[0].starts_at, Date.UTC(2028, 2, 2, 4, 15));
    assert.equal(concert.booking_opens_at, Date.UTC(2028, 1, 28, 15, 30, 0, 125));
    f.verify();
  });

  test(`[${schema}] 오픈 전에는 좌석을 선점할 수 없고 오픈 시각부터 가능하다`, async t => {
    const f = await fixture(t, schema);
    const opensAt = initialTime + HOUR;
    const { pid } = f.create({ bookingOpensAt: iso(opensAt) });
    const target = revision => ({ performance_id: pid, revision, booking_count: 0 });
    f.store.changePerformanceSales(f.admin.id, { action: 'pause', targets: [target(0)], reason: '통합 검증' });
    f.store.changePerformanceSales(f.admin.id, { action: 'resume', targets: [target(1)], reason: '통합 검증' });
    f.setTime(opensAt - 1);
    assert.throws(() => f.store.setHold(f.user.id, pid, ['A-01']), e => e.status === 409 && e.code === 'BOOKING_NOT_OPEN');
    assert.equal(f.store.seatMap(pid, f.user.id).hold, null);
    f.setTime(opensAt);
    assert.ok(f.store.setHold(f.user.id, pid, ['A-01']).hold);
    f.verify();
  });

  test(`[${schema}] 관리자는 오픈 전에도 좌석 차단을 관리할 수 있다`, async t => {
    const f = await fixture(t, schema);
    const { pid } = f.create({ bookingOpensAt: iso(initialTime + DAY) });
    assert.deepEqual(f.store.blockSeats(f.admin.id, pid, ['A-01'], true), { updated: 1 });
    assert.equal(f.store.seatMap(pid).seats.find(s => s.id === 'A-01').state, 'blocked');
    f.verify();
  });

  test(`[${schema}] 오픈 전 대기열 진입은 409 BOOKING_NOT_OPEN, 오픈 후에는 입장한다`, async t => {
    let now = initialTime;
    const app = await createApp({ dbPath: ':memory:', schema, now: () => now,
      queueOptions: { activeLimit: 10, admitPerSecond: 100, admissionMs: 60000, waitIdleMs: 60000, monotonic: () => now } });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    t.after(() => new Promise(ok => app.server.close(ok)));
    const userId = app.store.get('SELECT id FROM users WHERE email=?', 'demo@ticket-ssu.local').id;
    const adminId = app.store.get('SELECT id FROM users WHERE email=?', 'admin@ticket-ssu.local').id;
    const opensAt = initialTime + HOUR;
    const { id } = app.store.createConcert(adminId, concertBody({ bookingOpensAt: iso(opensAt) }));
    const pid = app.store.concerts().find(c => c.id === id).performances[0].id;
    const session = app.store.createSession(userId);
    const path = `/api/v1/performances/${pid}/queue`;
    const join = async () => {
      const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {
        method: 'POST', body: '{}',
        headers: { 'content-type': 'application/json', cookie: `ticket_ssu_session=${session.token}`, 'x-csrf-token': session.csrf }
      });
      const result = { status: response.status, body: await response.json() };
      validateResponse(currentSpec, currentSpec.paths['/api/v1/performances/{performanceId}/queue'].post, result.status, result.body);
      return result;
    };
    const early = await join();
    assert.equal(early.status, 409);
    assert.equal(early.body.code, 'BOOKING_NOT_OPEN');
    now = opensAt;
    const opened = await join();
    assert.equal(opened.status, 200);
  });

  test(`[${schema}] 오픈 일시 컬럼이 없는 기존 DB는 시작 시 보강되고 기존 공연은 바로 예매된다`, async t => {
    const root = resolve(tmpdir()), dir = await mkdtemp(join(root, 'ticket-ssu-opening-'));
    t.after(async () => {
      assert.ok(resolve(dir).startsWith(root + sep + 'ticket-ssu-opening-'));
      await rm(dir, { recursive: true, force: true });
    });
    const file = join(dir, `${schema}.sqlite`);
    const first = new (StoreFor(schema))(file, { now: () => initialTime });
    await first.seed();
    first.db.exec('ALTER TABLE concerts DROP COLUMN booking_opens_at');
    first.close();
    const reopened = new (StoreFor(schema))(file, { now: () => initialTime });
    try {
      const user = await reopened.authenticate('demo@ticket-ssu.local', 'TicketSsuDemo123!');
      const concert = reopened.concerts()[0];
      assert.equal(concert.booking_opens_at, null);
      validateValue(currentSpec, currentSpec.components.schemas.Concert, concert);
      assert.ok(reopened.setHold(user.id, concert.performances[0].id, ['A-01']).hold);
      if (schema === 'model') validateModel(reopened.db);
    } finally { reopened.close(); }
  });
}

test('다른 프로세스가 먼저 컬럼을 추가해도 시작 보강은 실패하지 않는다', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE concerts (id TEXT PRIMARY KEY)');
    // Simulate the race: the pre-check sees no column, another writer adds it before our lock.
    const prepare = db.prepare.bind(db);
    let first = true;
    db.prepare = sql => {
      if (first && sql.startsWith('PRAGMA table_info')) {
        first = false;
        const stale = prepare(sql).all();
        db.exec('ALTER TABLE concerts ADD COLUMN booking_opens_at INTEGER');
        return { all: () => stale };
      }
      return prepare(sql);
    };
    assert.doesNotThrow(() => enableBookingOpening(db));
    assert.equal(db.isTransaction, false);
    assert.equal(prepare('PRAGMA table_info(concerts)').all().filter(c => c.name === 'booking_opens_at').length, 1);
  } finally { db.close(); }
});

test('legacy를 model로 이관할 때 예매 오픈 일시를 보존하고, 컬럼이 없던 legacy DB도 이관한다', async t => {
  const root = resolve(tmpdir()), dir = await mkdtemp(join(root, 'ticket-ssu-opening-'));
  t.after(async () => {
    assert.ok(resolve(dir).startsWith(root + sep + 'ticket-ssu-opening-'));
    await rm(dir, { recursive: true, force: true });
  });
  const opensAt = initialTime + HOUR;
  const current = join(dir, 'current.sqlite'), old = join(dir, 'old.sqlite');
  let concertId;
  for (const [file, dropColumn] of [[current, false], [old, true]]) {
    const legacy = new Store(file, { now: () => initialTime });
    await legacy.seed();
    const admin = await legacy.authenticate('admin@ticket-ssu.local', 'TicketSsuAdmin123!');
    if (!dropColumn) concertId = legacy.createConcert(admin.id, concertBody({ bookingOpensAt: iso(opensAt) })).id;
    if (dropColumn) legacy.db.exec('ALTER TABLE concerts DROP COLUMN booking_opens_at');
    legacy.close();
  }
  migrateLegacy(current, join(dir, 'current-model.sqlite'));
  migrateLegacy(old, join(dir, 'old-model.sqlite'));
  const migrated = new ModelStore(join(dir, 'current-model.sqlite'), { now: () => initialTime });
  try { assert.equal(migrated.concerts().find(c => c.id === concertId).booking_opens_at, opensAt); } finally { migrated.close(); }
  const migratedOld = new ModelStore(join(dir, 'old-model.sqlite'), { now: () => initialTime });
  try { assert.ok(migratedOld.concerts().every(c => c.booking_opens_at === null)); } finally { migratedOld.close(); }
});
