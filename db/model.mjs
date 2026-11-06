import { DatabaseSync } from 'node:sqlite';
import { readFileSync, openSync, closeSync, realpathSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDefaultDatabasePath } from '../lib/project-identity.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const sql = name => readFileSync(new URL(`migrations/${name}`, import.meta.url), 'utf8');
export const MODEL_VERSION = 1;
export function configure(db, { readOnly = false } = {}) {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  if (!readOnly) db.exec('PRAGMA journal_mode=WAL;');
  if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1) throw new Error('foreign keys unavailable');
  return db;
}

// Replace only the shipped v1 guard; never overwrite a custom database trigger.
export function enableAccountWithdrawal(db) {
  const original = sql('001_guards.sql').match(/CREATE TRIGGER booking_immutable[\s\S]*?END;/)[0];
  const revision = sql('002_withdrawal_guard.sql');
  const updated = revision.slice(revision.indexOf('CREATE TRIGGER'));
  const normalize = value => value.trim().replace(/;$/, '').replace(/\s+/g, ' ');
  const current = db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='booking_immutable'").get()?.sql;
  if (current && normalize(current) === normalize(updated)) return;
  if (!current || normalize(current) !== normalize(original)) throw new Error('unrecognized booking guard; explicit review required');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(revision);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

export function applySchema(db) {
  if (db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get().n !== 0 || db.prepare('PRAGMA user_version').get().user_version !== 0) {
    throw new Error('schema initialization requires an empty database');
  }
  configure(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(sql('001_model.sql'));
    db.exec(sql('001_guards.sql'));
    db.exec(sql('002_withdrawal_guard.sql'));
    db.exec(`PRAGMA user_version=${MODEL_VERSION}; COMMIT;`);
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  return db;
}

export function validateModel(db) {
  const failIf = (query, code) => {
    if (db.prepare(query).get()) throw new Error(`model invariant failed: ${code}`);
  };
  if (db.prepare('PRAGMA user_version').get().user_version !== MODEL_VERSION) throw new Error('unsupported model version');
  if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1) throw new Error('foreign keys must be enabled');
  if (db.prepare('PRAGMA integrity_check').all().some(r => r.integrity_check !== 'ok') || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('database integrity check failed');
  failIf(`SELECT 1 FROM inventory i JOIN performances p ON p.id=i.performance_id JOIN physical_seats s ON s.id=i.physical_seat_id WHERE p.venue_id!=s.venue_id LIMIT 1`, 'inventory venue');
  failIf(`SELECT 1 FROM concerts c WHERE NOT EXISTS(SELECT 1 FROM performances p WHERE p.concert_id=c.id) LIMIT 1`, 'concert without performance');
  failIf(`SELECT 1 FROM performances p WHERE NOT EXISTS(SELECT 1 FROM inventory i WHERE i.performance_id=p.id) LIMIT 1`, 'performance without inventory');
  failIf(`SELECT 1 FROM current_holds ch JOIN inventory i ON i.id=ch.inventory_id JOIN holds h ON h.id=ch.hold_id
    WHERE i.blocked!=0 OR h.status!='active' OR h.performance_id!=i.performance_id OR EXISTS(SELECT 1 FROM current_bookings cb WHERE cb.inventory_id=i.id) LIMIT 1`, 'current hold');
  failIf(`SELECT 1 FROM holds h LEFT JOIN current_holds ch ON ch.hold_id=h.id GROUP BY h.id
    HAVING (h.status='active' AND COUNT(ch.inventory_id) NOT BETWEEN 1 AND 4) OR (h.status!='active' AND COUNT(ch.inventory_id)!=0) LIMIT 1`, 'hold cardinality');
  failIf(`SELECT 1 FROM holds h LEFT JOIN bookings b ON b.hold_id=h.id WHERE (h.status='converted') != (b.id IS NOT NULL) LIMIT 1`, 'hold conversion');
  failIf(`SELECT 1 FROM booking_items bi JOIN bookings b ON b.id=bi.booking_id JOIN holds h ON h.id=b.hold_id JOIN inventory i ON i.id=bi.inventory_id WHERE h.performance_id!=i.performance_id LIMIT 1`, 'item performance');
  failIf(`SELECT 1 FROM booking_totals WHERE ticket_count NOT BETWEEN 1 AND 4 OR fee!=ticket_count*2000 OR ticket_total IS NULL OR total>9007199254740991 LIMIT 1`, 'booking amounts/cardinality');
  failIf(`SELECT 1 FROM current_bookings cb JOIN bookings b ON b.id=cb.booking_id JOIN inventory i ON i.id=cb.inventory_id WHERE b.status!='confirmed' OR i.blocked!=0 LIMIT 1`, 'current booking');
  failIf(`SELECT 1 FROM booking_items bi JOIN bookings b ON b.id=bi.booking_id LEFT JOIN current_bookings cb ON cb.booking_id=b.id AND cb.inventory_id=bi.inventory_id
    WHERE (b.status='confirmed' AND cb.inventory_id IS NULL) OR (b.status='cancelled' AND cb.inventory_id IS NOT NULL) LIMIT 1`, 'booking occupancy');
  failIf(`WITH counts AS (
    SELECT h.user_id,h.performance_id,COUNT(*) AS n FROM booking_items bi JOIN bookings b ON b.id=bi.booking_id JOIN holds h ON h.id=b.hold_id WHERE b.status='confirmed' GROUP BY h.user_id,h.performance_id
    UNION ALL SELECT h.user_id,h.performance_id,COUNT(*) FROM current_holds ch JOIN holds h ON h.id=ch.hold_id GROUP BY h.user_id,h.performance_id
  ) SELECT 1 FROM counts GROUP BY user_id,performance_id HAVING SUM(n)>4 LIMIT 1`, 'user ticket limit');
  failIf(`SELECT 1 FROM payment_attempts a LEFT JOIN booking_totals b ON b.id=a.booking_id WHERE a.result='succeeded' AND (b.id IS NULL OR b.hold_id!=a.hold_id OR b.total!=a.amount) LIMIT 1`, 'payment amount/hold');
  failIf(`SELECT 1 FROM bookings b LEFT JOIN legacy_booking_imports l ON l.booking_id=b.id WHERE l.booking_id IS NULL AND NOT EXISTS(SELECT 1 FROM payment_attempts a WHERE a.booking_id=b.id AND a.result='succeeded') LIMIT 1`, 'new booking without successful demo attempt');
  // Full email syntax remains shared with the legacy API, not approximated by GLOB.
  if (db.prepare('SELECT email FROM users').all().some(r => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email))) throw new Error('model invariant failed: email syntax');
  return { version: MODEL_VERSION, sqlite: db.prepare('SELECT sqlite_version() AS version').get().version,
    tables: db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n };
}

// Offline construction/import helper. Full scans are not a serving-path design.
export function modelTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    if (result?.then) throw new Error('model transaction callback must be synchronous');
    validateModel(db);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

const inside = (base, file) => { const rel = relative(base, file); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
export function destinationPath(file) {
  if (extname(file).toLowerCase() !== '.sqlite') throw new Error('destination must use .sqlite');
  const requested = resolve(file);
  const lexicalRoot = resolve(project);
  if (isDefaultDatabasePath(lexicalRoot, requested)) throw new Error('project database is protected');
  if (inside(lexicalRoot, requested) && !['data', 'test-results'].some(dir => inside(resolve(lexicalRoot, dir), requested))) {
    throw new Error('database output must stay outside tracked/static/document paths');
  }
  const path = resolve(realpathSync(dirname(requested)), requested.split(/[\\/]/).at(-1));
  const root = realpathSync(project);
  const allowed = ['data', 'test-results'].some(dir => inside(resolve(root, dir), path));
  if (inside(root, path) && !allowed) throw new Error('database output must stay outside tracked/static/document paths');
  if (isDefaultDatabasePath(root, path)) throw new Error('project database is protected');
  if (existsSync(path)) throw new Error('destination already exists; refusing overwrite');
  // Also reject file aliases by exclusive creation; parent symlinks were resolved above.
  return path;
}

export function withNewDatabase(file, fn, { initialize = true } = {}) {
  const path = destinationPath(file);
  const descriptor = openSync(path, 'wx', 0o600);
  const owned = statSync(path);
  closeSync(descriptor);
  let db;
  try {
    db = configure(new DatabaseSync(path), { readOnly: !initialize });
    if (initialize) applySchema(db);
    const result = fn(db, path);
    if (result?.then) throw new Error('new database callback must be synchronous');
    db.close();
    db = undefined;
    return result;
  } catch (error) {
    db?.close();
    const actual = existsSync(path) ? statSync(path) : null;
    if (actual && actual.dev === owned.dev && actual.ino === owned.ino) {
      for (const suffix of ['', '-wal', '-shm']) if (existsSync(path + suffix)) unlinkSync(path + suffix);
    }
    throw error;
  }
}

export const queries = {
  seatMap: `SELECT i.id,s.seat_code,i.grade,i.price,i.blocked,ch.hold_id,cb.booking_id FROM inventory i JOIN physical_seats s ON s.id=i.physical_seat_id LEFT JOIN current_holds ch ON ch.inventory_id=i.id LEFT JOIN current_bookings cb ON cb.inventory_id=i.id WHERE i.performance_id=? ORDER BY s.row_label,s.number`,
  userBookings: `SELECT b.id FROM holds h JOIN bookings b ON b.hold_id=h.id WHERE h.user_id=? AND h.performance_id=?`,
  expiredHolds: `SELECT id FROM holds WHERE status='active' AND expires_at<=?`,
  holdSeats: `SELECT inventory_id FROM current_holds WHERE hold_id=?`
};
