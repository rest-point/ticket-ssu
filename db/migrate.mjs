import { DatabaseSync } from 'node:sqlite';
import { realpathSync } from 'node:fs';
import { configure, destinationPath, validateModel, modelTransaction, withNewDatabase, hasAdminBookingCancellations, validateAdminBookingCancellations, validateMemberBookingRestrictions, validatePerformanceSales } from './model.mjs';

const legacyColumns = {
  users: 'id email name phone password_hash role created_at',
  sessions: 'token_hash user_id csrf expires_at',
  concerts: 'id title artist venue description theme duration age created_at',
  performances: 'id concert_id starts_at',
  holds: 'id user_id performance_id expires_at status',
  bookings: 'id user_id performance_id hold_id status ticket_total fee total buyer_name buyer_phone delivery created_at cancelled_at',
  seats: 'performance_id id row_label number grade price blocked hold_id booking_id',
  booking_seats: 'booking_id seat_id grade price',
  audit: 'id user_id action detail created_at'
};
const optionalLegacyColumns = { concerts: 'booking_opens_at' };

export function insertRow(db, table, row) {
  // Identifiers are code-owned, never request input.
  if (!/^[a-z_]+$/.test(table) || !Object.keys(row).every(k => /^[a-z_]+$/.test(k))) throw new Error('invalid internal identifier');
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...Object.values(row));
}
const selectFields = (row, fields) => Object.fromEntries(fields.split(' ').map(k => [k, row[k]]));
const reject = message => { throw new Error(`legacy preflight failed: ${message}`); };

export function readLegacy(db) {
  if (db.prepare('PRAGMA user_version').get().user_version !== 0) reject('unsupported source version');
  const actual = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
  const columnsByTable = { ...legacyColumns };
  if (hasAdminBookingCancellations(db)) columnsByTable.admin_booking_cancellations = 'booking_id admin_id reason created_at';
  if (actual.includes('member_booking_restrictions')) columnsByTable.member_booking_restrictions = 'member_id revision admin_id restricted reason created_at';
  if (actual.includes('performance_sales_events')) columnsByTable.performance_sales_events = 'performance_id revision admin_id state reason created_at';
  if (actual.includes('performance_cancelled_bookings')) columnsByTable.performance_cancelled_bookings = 'booking_id performance_id revision';
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(columnsByTable).sort())) reject('unknown source tables');
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type IN ('view','trigger') LIMIT 1").get()) reject('custom source view/trigger requires review');
  const indexes = db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL").all();
  if (indexes.some(r => !['one_active_hold', 'seats_hold', 'bookings_user'].includes(r.name))) reject('custom source index requires review');
  const payload = {};
  for (const [table, columns] of Object.entries(columnsByTable)) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all();
    const layout = info.map(c => c.name).join(' ');
    if (layout !== columns && !(optionalLegacyColumns[table] && layout === `${columns} ${optionalLegacyColumns[table]}`)) reject('unexpected source column layout');
    const integers = new Set('created_at expires_at starts_at cancelled_at ticket_total fee total number price blocked duration revision restricted booking_opens_at'.split(' '));
    if (info.some(c => c.type !== (integers.has(c.name) || (table === 'audit' && c.name === 'id') ? 'INTEGER' : 'TEXT'))) reject('unexpected source declared type');
    payload[table] = db.prepare(`SELECT * FROM ${table}`).all();
    for (const row of payload[table]) for (const col of info) {
      if (row[col.name] === null) { if (col.notnull || col.pk) reject('null source key/required field'); continue; }
      if (col.type === 'INTEGER' ? !Number.isSafeInteger(row[col.name]) : typeof row[col.name] !== 'string') reject('source storage type/range');
    }
  }
  if (db.prepare('PRAGMA integrity_check').all().some(r => r.integrity_check !== 'ok') || db.prepare('PRAGMA foreign_key_check').all().length) reject('source integrity');
  validateAdminBookingCancellations(db);
  validateMemberBookingRestrictions(db);
  validatePerformanceSales(db);
  const forbid = (query, message) => { if (db.prepare(query).get()) reject(message); };
  forbid(`SELECT 1 FROM bookings b JOIN holds h ON h.id=b.hold_id WHERE b.user_id!=h.user_id OR b.performance_id!=h.performance_id OR h.status!='converted' LIMIT 1`, 'booking owner/performance/hold');
  forbid(`SELECT 1 FROM bookings b LEFT JOIN booking_seats s ON s.booking_id=b.id GROUP BY b.id
    HAVING COUNT(s.seat_id) NOT BETWEEN 1 AND 4 OR b.ticket_total!=SUM(s.price) OR b.fee!=COUNT(s.seat_id)*2000 OR b.total!=b.ticket_total+b.fee LIMIT 1`, 'booking totals; refusing recalculation');
  forbid(`SELECT 1 FROM booking_seats bi JOIN bookings b ON b.id=bi.booking_id LEFT JOIN seats s ON s.performance_id=b.performance_id AND s.id=bi.seat_id WHERE s.id IS NULL LIMIT 1`, 'missing historical inventory');
  return payload;
}

function importLegacy(db, data) {
  for (const row of data.users) insertRow(db, 'users', row);
  for (const row of data.sessions) insertRow(db, 'sessions', row);
  for (const row of data.concerts) insertRow(db, 'concerts', { ...selectFields(row, 'id title artist description theme duration age created_at'), booking_opens_at: row.booking_opens_at ?? null });
  const concerts = new Map(data.concerts.map(c => [c.id, c]));
  // Conservative mapping: no automatic merging of similarly named venues/layouts.
  for (const p of data.performances) {
    const venue = `legacy-venue:${p.id}`;
    insertRow(db, 'venues', { id: venue, name: concerts.get(p.concert_id).venue, region: null });
    insertRow(db, 'performances', { ...p, venue_id: venue });
  }
  const inventory = new Map();
  for (const s of data.seats) {
    const key = JSON.stringify([s.performance_id, s.id]);
    const seat = `legacy-seat:${key}`, inv = `legacy-inventory:${key}`;
    insertRow(db, 'physical_seats', { id: seat, venue_id: `legacy-venue:${s.performance_id}`, seat_code: s.id, row_label: s.row_label, number: s.number });
    insertRow(db, 'inventory', { id: inv, performance_id: s.performance_id, physical_seat_id: seat, grade: s.grade, price: s.price, blocked: s.blocked });
    inventory.set(key, inv);
  }
  for (const row of data.holds) insertRow(db, 'holds', row);
  for (const row of data.bookings) {
    insertRow(db, 'bookings', selectFields(row, 'id hold_id status fee buyer_name buyer_phone delivery created_at cancelled_at'));
    insertRow(db, 'legacy_booking_imports', { booking_id: row.id });
  }
  const bookings = new Map(data.bookings.map(b => [b.id, b]));
  for (const bi of data.booking_seats) {
    const pid = bookings.get(bi.booking_id).performance_id;
    insertRow(db, 'booking_items', { booking_id: bi.booking_id, inventory_id: inventory.get(JSON.stringify([pid, bi.seat_id])), grade_snapshot: bi.grade, price_snapshot: bi.price });
  }
  for (const s of data.seats) {
    const inv = inventory.get(JSON.stringify([s.performance_id, s.id]));
    if (s.hold_id) insertRow(db, 'current_holds', { inventory_id: inv, hold_id: s.hold_id });
    if (s.booking_id) insertRow(db, 'current_bookings', { inventory_id: inv, booking_id: s.booking_id });
  }
  for (const row of data.audit) insertRow(db, 'audit_events', row);
  for (const row of data.admin_booking_cancellations ?? []) insertRow(db, 'admin_booking_cancellations', row);
  for (const row of data.member_booking_restrictions ?? []) insertRow(db, 'member_booking_restrictions', row);
  for (const row of data.performance_sales_events ?? []) insertRow(db, 'performance_sales_events', row);
  for (const row of data.performance_cancelled_bookings ?? []) insertRow(db, 'performance_cancelled_bookings', row);
  // Compare exact values, not just row counts. No real data is printed on failure.
  for (const original of data.bookings) {
    const migrated = db.prepare('SELECT * FROM booking_totals WHERE id=?').get(original.id);
    for (const key of Object.keys(original)) if (migrated[key] !== original[key]) throw new Error('post-migration booking value mismatch');
  }
}

export function migrateLegacy(sourceFile, destinationFile) {
  destinationPath(destinationFile); // Refuse existing/protected targets before opening a source.
  const source = configure(new DatabaseSync(realpathSync(sourceFile), { readOnly: true }), { readOnly: true });
  try {
    source.exec('BEGIN'); // All source reads belong to a single snapshot.
    const data = readLegacy(source);
    const result = withNewDatabase(destinationFile, db => {
      modelTransaction(db, () => importLegacy(db, data));
      return { ...validateModel(db), migrated: true, users: data.users.length, bookings: data.bookings.length, seats: data.seats.length };
    });
    source.exec('ROLLBACK'); // End read snapshot; never write to source.
    return result;
  } finally {
    if (source.isTransaction) source.exec('ROLLBACK');
    source.close();
  }
}

export function snapshotDatabase(sourceFile, destinationFile, { verify = () => ({}) } = {}) {
  // VACUUM INTO accepts a new/empty file. Reserve exclusively to forbid overwrite.
  destinationPath(destinationFile);
  const source = configure(new DatabaseSync(realpathSync(sourceFile), { readOnly: true }), { readOnly: true });
  try {
    return withNewDatabase(destinationFile, (_reserved, target) => {
      // The reserved connection is empty and idle; only VACUUM writes the output.
      source.prepare('VACUUM INTO ?').run(target);
      if (_reserved.prepare('PRAGMA integrity_check').all().some(r => r.integrity_check !== 'ok') || _reserved.prepare('PRAGMA foreign_key_check').all().length) throw new Error('snapshot verification failed');
      return { snapshot: true, verified: true, ...verify(_reserved) };
    }, { initialize: false });
  } finally { source.close(); }
}
