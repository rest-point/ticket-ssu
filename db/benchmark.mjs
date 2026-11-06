import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { cpus, platform, arch, totalmem } from 'node:os';
import { applySchema, modelTransaction, queries } from './model.mjs';
import { seedDemo } from './seeds/demo.mjs';
import { insertRow } from './migrate.mjs';

// SQL microbenchmark only: isolated memory DB, no HTTP/k6 throughput claim.
const db = applySchema(new DatabaseSync(':memory:'));
const now = 1800000000000, history = 3000, repeats = 200;
try {
  seedDemo(db, { now });
  modelTransaction(db, () => {
    for (let n = 0; n < history; n++) {
      const h = `bench-h:${n}`, b = `bench-b:${n}`, p = n % 3 + 1;
      insertRow(db, 'holds', { id: h, user_id: n % 2 ? 'seed-user' : 'seed-admin', performance_id: `seed-performance-${p}`, expires_at: now, status: 'converted' });
      insertRow(db, 'bookings', { id: b, hold_id: h, status: 'cancelled', fee: 2000, buyer_name: '가상예매자', buyer_phone: '01012345678', delivery: 'mobile', created_at: now, cancelled_at: now + 1 });
      insertRow(db, 'booking_items', { booking_id: b, inventory_id: `seed:${p}:A-01`, grade_snapshot: 'VIP', price_snapshot: 90000 });
      insertRow(db, 'payment_attempts', { id: `bench-pay:${n}`, hold_id: h, request_key: 'synthetic', body_hash: 'a'.repeat(64), result: 'succeeded', amount: 92000, booking_id: b, failure_code: null, attempted_at: now });
    }
    const template = db.prepare("SELECT * FROM users WHERE id='seed-user'").get();
    const seats = db.prepare("SELECT id FROM inventory WHERE performance_id='seed-performance-1' ORDER BY id").all();
    for (let n = 0; n < seats.length; n++) {
      const id = `bench-u:${n}`, h = `bench-active:${n}`;
      insertRow(db, 'users', { ...template, id, email: `bench-${n}@ticket-ssu.local` });
      insertRow(db, 'holds', { id: h, user_id: id, performance_id: 'seed-performance-1', expires_at: now + (n - 48) * 1000, status: 'active' });
      insertRow(db, 'current_holds', { inventory_id: seats[n].id, hold_id: h });
    }
  });
  const cases = [
    ['seatMap', ['seed-performance-1']],
    ['userBookings', ['seed-user', 'seed-performance-1']],
    ['expiredHolds', [now]],
    ['holdSeats', ['bench-active:0']]
  ];
  const measure = () => Object.fromEntries(cases.map(([name, params]) => {
    const query = queries[name];
    const plan = db.prepare('EXPLAIN QUERY PLAN ' + query).all(...params).map(r => r.detail);
    const stmt = db.prepare(query);
    for (let n = 0; n < 20; n++) stmt.all(...params);
    const start = performance.now();
    let rows = 0;
    for (let n = 0; n < repeats; n++) rows += stmt.all(...params).length;
    return [name, { plan, rowsPerQuery: rows / repeats, meanMs: Number(((performance.now() - start) / repeats).toFixed(6)) }];
  }));
  db.exec('ANALYZE');
  const indexed = measure();
  db.exec('DROP INDEX holds_user_performance; DROP INDEX holds_expiry; DROP INDEX current_holds_hold; ANALYZE;');
  const withoutSelectedIndexes = measure();
  console.log(JSON.stringify({ node: process.version, sqlite: db.prepare('SELECT sqlite_version() AS v').get().v,
    system: { platform: platform(), arch: arch(), cpu: cpus()[0].model, memoryGiB: Number((totalmem() / 1024 ** 3).toFixed(1)) },
    database: ':memory:', syntheticHistoricalBookings: history, activeHolds: 96, inventory: 288, repeats,
    indexed, withoutSelectedIndexes, scope: 'single connection SQL microbenchmark; warm cache; not API concurrency or load test' }, null, 2));
} finally { db.close(); }
