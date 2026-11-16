import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { applySchema, configure, validateModel, enableAccountWithdrawal, enableAdminBookingCancellations, enableMemberBookingRestrictions, enablePerformanceSales, enableBookingOpening } from '../db/model.mjs';
import { LEGACY_DEMO_ACCOUNTS, LEGACY_VENUE_NAMES } from './project-identity.mjs';
const scrypt = promisify(scryptCallback);
const digest = value => createHash('sha256').update(value).digest('hex');
const MIN_CONCERT_LEAD_MS = 24 * 60 * 60 * 1000;
const OPENING_GRACE_MS = 60 * 1000;
function parseZonedTime(value) {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.exec(value);
  if (!match) return NaN;
  const calendarDate = match[1];
  // Check the input calendar day before applying the timezone offset.
  const day = new Date(`${calendarDate}T00:00:00Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === calendarDate ? Date.parse(value) : NaN;
}
// Both schemas use p for the performance and sale for its latest event.
export const latestPerformanceSaleJoin = `LEFT JOIN performance_sales_events sale ON sale.performance_id=p.id
  AND sale.revision=(SELECT MAX(revision) FROM performance_sales_events WHERE performance_id=p.id)`;
// Reserved, schema-compatible tombstone. Never accepted for login/session creation.
export const WITHDRAWN_PASSWORD_HASH = '0'.repeat(32) + ':' + '0'.repeat(128);
export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (test, status, message) => {
  if (!test) throw new AppError(status, message);
};
export function validateAdminCredentials(adminEmail, adminPassword) {
  if (adminEmail === undefined && adminPassword === undefined) return null;
  fail(typeof adminEmail === 'string' && typeof adminPassword === 'string', 400, '초기 관리자 이메일과 비밀번호를 함께 설정해 주세요.');
  const email = adminEmail.trim().toLowerCase();
  fail(email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 400, '초기 관리자 이메일 형식을 확인해 주세요.');
  fail(adminPassword.length >= 10 && adminPassword.length <= 128, 400, '초기 관리자 비밀번호는 10~128자여야 합니다.');
  return { email, password: adminPassword };
}
async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}
async function verifyPassword(password, hash) {
  const [salt, encoded] = hash.split(':');
  const key = await scrypt(password, salt, 64);
  return timingSafeEqual(key, Buffer.from(encoded, 'hex'));
}
export function normalizeCheckout({ holdId, buyerName, buyerPhone, delivery, agreed, paymentMethod }) {
  fail(agreed === true && paymentMethod === 'demo', 400, '예매 안내에 동의하고 데모 결제를 선택해 주세요.');
  fail(typeof buyerName === 'string' && buyerName.trim().length >= 2 && buyerName.length <= 40, 400, '예매자 이름을 확인해 주세요.');
  buyerPhone = String(buyerPhone ?? '').replace(/[-\s]/g, '');
  fail(/^01[016789]\d{7,8}$/.test(buyerPhone), 400, '예매자 휴대폰 번호를 확인해 주세요.');
  fail(['mobile', 'onsite'].includes(delivery), 400, '티켓 수령 방법을 선택해 주세요.');
  return { holdId, buyerName: buyerName.trim(), buyerPhone, delivery };
}
function adminBookingResult(booking, now) {
  const { id, performance_id, title, starts_at, status, total, seats, cancelled_at, admin_cancel_reason } = booking;
  return { id, performance_id, title, starts_at, status, total, seats, cancelled_at,
    can_cancel: status === 'confirmed' && starts_at > now,
    ...(admin_cancel_reason ? { admin_cancel_reason } : {}) };
}
export class Store {
  constructor(path, {
    now = Date.now,
    holdMs = 7 * 60 * 1000,
    schema = 'legacy'
  } = {}) {
    if (!['legacy', 'model'].includes(schema) || (schema === 'model' && new.target === Store)) throw new Error('model 스키마는 ModelStore로 열어 주세요.');
    if (path !== ':memory:') mkdirSync(dirname(path), {
      recursive: true
    });
    this.db = new DatabaseSync(path);
    this.now = now;
    this.holdMs = holdMs;
    this.schema = schema;
    if (schema === 'model') {
      try {
        const version = this.db.prepare('PRAGMA user_version').get().user_version;
        const tables = this.db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get().n;
        if (version === 0 && tables === 0) applySchema(this.db);
        else if (version !== 1) throw new Error('model 모드는 새 DB 또는 명시적으로 이관한 v1 DB만 지원합니다. 자동 이관하지 않습니다.');
        configure(this.db);
        enableBookingOpening(this.db);
        validateModel(this.db); // Startup only. Request methods validate affected rows.
        enableAccountWithdrawal(this.db);
        if (!Number.isSafeInteger(holdMs) || holdMs <= 0) throw new Error('holdMs는 양의 안전 정수여야 합니다.');
        enableAdminBookingCancellations(this.db);
        enableMemberBookingRestrictions(this.db);
        enablePerformanceSales(this.db);
      } catch (error) {
        this.db.close();
        throw error;
      }
      return;
    }
    if (schema !== 'legacy') {
      this.db.close();
      throw new Error('지원하지 않는 DB 스키마 모드입니다.');
    }
    if (this.db.prepare('PRAGMA user_version').get().user_version !== 0) {
      this.db.close();
      throw new Error('이 Store는 기존 스키마 전용입니다. 새 모델 DB는 아직 앱에 연결할 수 없습니다.');
    }
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, phone TEXT NOT NULL,
        password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')), created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS concerts (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL, venue TEXT NOT NULL,
        description TEXT NOT NULL, theme TEXT NOT NULL, duration INTEGER NOT NULL, age TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS performances (
        id TEXT PRIMARY KEY, concert_id TEXT NOT NULL REFERENCES concerts(id), starts_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS holds (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), performance_id TEXT NOT NULL REFERENCES performances(id),
        expires_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','expired','released','converted'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_hold ON holds(user_id,performance_id) WHERE status='active';
      CREATE TABLE IF NOT EXISTS bookings (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), performance_id TEXT NOT NULL REFERENCES performances(id),
        hold_id TEXT NOT NULL UNIQUE REFERENCES holds(id), status TEXT NOT NULL CHECK(status IN ('confirmed','cancelled')),
        ticket_total INTEGER NOT NULL, fee INTEGER NOT NULL, total INTEGER NOT NULL, buyer_name TEXT NOT NULL,
        buyer_phone TEXT NOT NULL, delivery TEXT NOT NULL, created_at INTEGER NOT NULL, cancelled_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS seats (
        performance_id TEXT NOT NULL REFERENCES performances(id), id TEXT NOT NULL, row_label TEXT NOT NULL, number INTEGER NOT NULL,
        grade TEXT NOT NULL, price INTEGER NOT NULL, blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)),
        hold_id TEXT REFERENCES holds(id), booking_id TEXT REFERENCES bookings(id),
        CHECK(NOT(hold_id IS NOT NULL AND booking_id IS NOT NULL)),
        CHECK(blocked=0 OR (hold_id IS NULL AND booking_id IS NULL)), PRIMARY KEY(performance_id,id)
      );
      CREATE TABLE IF NOT EXISTS booking_seats (
        booking_id TEXT NOT NULL REFERENCES bookings(id), seat_id TEXT NOT NULL, grade TEXT NOT NULL, price INTEGER NOT NULL,
        PRIMARY KEY(booking_id,seat_id)
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS seats_hold ON seats(hold_id);
      CREATE INDEX IF NOT EXISTS bookings_user ON bookings(user_id);
    `);
    enableAdminBookingCancellations(this.db);
    enableMemberBookingRestrictions(this.db);
    enablePerformanceSales(this.db);
    enableBookingOpening(this.db);
  }
  get(sql, ...args) {
    return this.db.prepare(sql).get(...args);
  }
  all(sql, ...args) {
    return this.db.prepare(sql).all(...args);
  }
  run(sql, ...args) {
    return this.db.prepare(sql).run(...args);
  }
  recordAudit(userId, action, detail, at = this.now()) {
    this.run('INSERT INTO audit(user_id,action,detail,created_at) VALUES(?,?,?,?)', userId, action, JSON.stringify(detail), at);
  }
  transaction(fn) {
    return this.#transact(fn, 'BEGIN IMMEDIATE');
  }
  readSnapshot(fn) {
    return this.inTransaction ? fn() : this.#transact(fn, 'BEGIN');
  }
  readiness() {
    return this.readSnapshot(() => {
      const version = this.get('PRAGMA user_version').user_version;
      if (version !== (this.schema === 'model' ? 1 : 0) || this.get('PRAGMA foreign_keys').foreign_keys !== 1) {
        throw new Error('database not ready');
      }
      this.get('SELECT id FROM users LIMIT 1');
      return { status: 'ready', schema_version: version };
    });
  }
  #transact(fn, begin) {
    this.db.exec(begin);
    this.inTransaction = true;
    try {
      const result = fn();
      if (result?.then) throw new TypeError('transaction callback must be synchronous');
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }
  expire() {
    // 두 UPDATE에 동일한 기준 시각을 적용하고 하나의 트랜잭션으로 처리한다.
    const cutoff = this.now();
    const cleanup = () => {
      this.run("UPDATE seats SET hold_id=NULL WHERE hold_id IN (SELECT id FROM holds WHERE status!='active' OR expires_at<=?)", cutoff);
      this.run("UPDATE holds SET status='expired' WHERE status='active' AND expires_at<=?", cutoff);
    };
    return this.inTransaction ? cleanup() : this.transaction(cleanup);
  }
  publicUser(user) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      phone: user.phone,
      role: user.role
    };
  }
  async register({
    email,
    name,
    phone,
    password,
    terms,
    ageConfirmed
  }) {
    email = String(email ?? '').trim().toLowerCase();
    name = String(name ?? '').trim();
    phone = String(phone ?? '').replace(/[-\s]/g, '');
    fail(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254, 400, '올바른 이메일을 입력해 주세요.');
    fail(name.length >= 2 && name.length <= 40, 400, '이름은 2~40자로 입력해 주세요.');
    fail(/^01[016789]\d{7,8}$/.test(phone), 400, '올바른 휴대폰 번호를 입력해 주세요.');
    fail(typeof password === 'string' && password.length >= 10 && password.length <= 128, 400, '비밀번호는 10~128자로 입력해 주세요.');
    fail(terms === true && ageConfirmed === true, 400, '필수 약관 및 만 14세 이상 확인이 필요합니다.');
    fail(!this.get('SELECT id FROM users WHERE email=?', email), 409, '이미 가입된 이메일입니다.');
    const passwordHash = await hashPassword(password);
    const id = randomUUID();
    try {
      this.run('INSERT INTO users VALUES(?,?,?,?,?,?,?)', id, email, name, phone, passwordHash, 'user', this.now());
    } catch (e) {
      if (String(e.code).includes('CONSTRAINT') || String(e.message).includes('UNIQUE')) throw new AppError(409, '이미 가입된 이메일입니다.');
      throw e;
    }
    return this.publicUser(this.get('SELECT * FROM users WHERE id=?', id));
  }
  async authenticate(email, password) {
    const user = this.get('SELECT * FROM users WHERE email=?', String(email ?? '').trim().toLowerCase());
    // 없는 계정도 키를 유도해 빠른 응답으로 계정 존재 여부가 드러나지 않게 한다.
    const fallback = '00000000000000000000000000000000:' + '00'.repeat(64);
    const valid = await verifyPassword(typeof password === 'string' ? password.slice(0, 128) : '', user?.password_hash ?? fallback);
    fail(user && user.password_hash !== WITHDRAWN_PASSWORD_HASH && valid && typeof password === 'string' && password.length <= 128, 401, '이메일 또는 비밀번호가 올바르지 않습니다.');
    return this.publicUser(user);
  }
  createSession(userId) {
    // Authentication performs async scrypt; withdrawal may commit while it yields.
    const user = this.get('SELECT password_hash FROM users WHERE id=?', userId);
    fail(user && user.password_hash !== WITHDRAWN_PASSWORD_HASH, 401, '로그인 후 이용해 주세요.');
    const token = randomBytes(32).toString('hex'),
      csrf = randomBytes(24).toString('hex');
    this.run('DELETE FROM sessions WHERE expires_at<=?', this.now());
    this.run('INSERT INTO sessions VALUES(?,?,?,?)', digest(token), userId, csrf, this.now() + 7 * 86400000);
    return {
      token,
      csrf
    };
  }
  session(token) {
    if (!token) return null;
    const row = this.get('SELECT u.*,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=? AND expires_at>?', digest(token), this.now());
    return row ? {
      user: this.publicUser(row),
      csrf: row.csrf
    } : null;
  }
  logout(token) {
    if (token) this.run('DELETE FROM sessions WHERE token_hash=?', digest(token));
  }
  async verifyWithdrawal(userId, { password, confirmed, ...extra }) {
    fail(confirmed === true && Object.keys(extra).length === 0, 400, '회원 탈퇴 안내에 동의해 주세요.');
    fail(typeof password === 'string' && password.length >= 10 && password.length <= 128, 400, '현재 비밀번호를 입력해 주세요.');
    const user = this.get('SELECT password_hash FROM users WHERE id=?', userId);
    fail(user && user.password_hash !== WITHDRAWN_PASSWORD_HASH && await verifyPassword(password, user.password_hash), 401, '현재 비밀번호가 올바르지 않습니다.');
    return user.password_hash;
  }
  withdrawAccount(userId, verifiedHash) {
    return this.transaction(() => {
      const user = this.get('SELECT * FROM users WHERE id=?', userId);
      fail(user && user.password_hash !== WITHDRAWN_PASSWORD_HASH && user.password_hash === verifiedHash, 401, '로그인 후 다시 시도해 주세요.');
      fail(user.role !== 'admin', 403, '관리자 계정은 회원 탈퇴할 수 없습니다.');
      const upcoming = this.get(`SELECT 1 FROM bookings b JOIN holds h ON h.id=b.hold_id
        JOIN performances p ON p.id=h.performance_id
        WHERE h.user_id=? AND b.status='confirmed' AND p.starts_at>? LIMIT 1`, userId, this.now());
      fail(!upcoming, 409, '공연 시작 전 확정 예매를 먼저 취소해 주세요.');
      this.#releaseMemberHolds(userId);
      this.run('DELETE FROM sessions WHERE user_id=?', userId);
      this.run("UPDATE users SET email=?,name='탈퇴회원',phone='01000000000',password_hash=? WHERE id=?",
        `withdrawn-${randomUUID()}@account.invalid`, WITHDRAWN_PASSWORD_HASH, userId);
      this.run("UPDATE bookings SET buyer_name='탈퇴회원',buyer_phone='01000000000' WHERE hold_id IN (SELECT id FROM holds WHERE user_id=?)", userId);
      return { ok: true };
    });
  }
  #releaseMemberHolds(userId) {
    if (this.schema === 'model') this.run('DELETE FROM current_holds WHERE hold_id IN (SELECT id FROM holds WHERE user_id=?)', userId);
    else this.run('UPDATE seats SET hold_id=NULL WHERE hold_id IN (SELECT id FROM holds WHERE user_id=?)', userId);
    this.run("UPDATE holds SET status='released' WHERE user_id=? AND status='active'", userId);
  }
  #memberRestriction(userId) {
    return this.get('SELECT revision,restricted,reason,created_at FROM member_booking_restrictions WHERE member_id=? ORDER BY revision DESC LIMIT 1', userId);
  }
  requireBookingAllowed(userId) {
    if (!this.#memberRestriction(userId)?.restricted) return;
    const error = new AppError(403, '이 계정은 새 예매 이용이 제한되었습니다. 기존 예매는 나의 티켓에서 확인할 수 있습니다.');
    error.code = 'BOOKING_RESTRICTED';
    throw error;
  }
  #memberRestrictionResult(member, event = this.#memberRestriction(member.id)) {
    return { member_id: member.id, email: member.email, name: member.name, restricted: Boolean(event?.restricted),
      revision: event?.revision ?? 0, reason: event?.reason ?? null, changed_at: event?.created_at ?? null };
  }
  adminGetMemberRestriction(adminId, { email, ...extra }) {
    return this.readSnapshot(() => {
      this.requireAdmin(adminId);
      const address = typeof email === 'string' ? email.trim().toLowerCase() : '';
      fail(address.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) && Object.keys(extra).length === 0, 400, '회원 이메일을 확인해 주세요.');
      const member = this.get("SELECT id,email,name FROM users WHERE email=? AND role='user' AND password_hash<>?", address, WITHDRAWN_PASSWORD_HASH);
      fail(member, 404, '일반 회원을 찾을 수 없습니다.');
      return this.#memberRestrictionResult(member);
    });
  }
  adminSetMemberRestriction(adminId, { member_id, restricted, revision, reason, ...extra }) {
    return this.transaction(() => {
      this.requireAdmin(adminId);
      const note = typeof reason === 'string' ? reason.trim() : '';
      fail(typeof member_id === 'string' && member_id.length > 0 && typeof restricted === 'boolean' &&
        Number.isSafeInteger(revision) && revision >= 0 && note.length > 0 && note.length <= 200 &&
        !/[\u0000-\u001f\u007f]/.test(note) && Object.keys(extra).length === 0, 400, '회원, 제한 여부, 처리 사유를 확인해 주세요.');
      const member = this.get("SELECT id,email,name FROM users WHERE id=? AND role='user' AND password_hash<>?", member_id, WITHDRAWN_PASSWORD_HASH);
      fail(member, 404, '일반 회원을 찾을 수 없습니다.');
      const previous = this.#memberRestriction(member_id);
      if (Boolean(previous?.restricted) === restricted) return this.#memberRestrictionResult(member, previous);
      fail(revision === (previous?.revision ?? 0), 409, '처리 상태가 바뀌었습니다. 회원을 다시 조회해 주세요.');
      const event = { revision: (previous?.revision ?? 0) + 1, restricted: Number(restricted), reason: note, created_at: this.now() };
      this.run('INSERT INTO member_booking_restrictions VALUES(?,?,?,?,?,?)', member_id, event.revision, adminId, event.restricted, note, event.created_at);
      if (restricted) this.#releaseMemberHolds(member_id);
      return this.#memberRestrictionResult(member, event);
    });
  }
  liveHolds(userId, performanceId) {
    const cutoff = this.now();
    const occupied = this.schema === 'model' ? 'SELECT 1 FROM current_holds s WHERE s.hold_id=h.id' : 'SELECT 1 FROM seats s WHERE s.hold_id=h.id';
    return this.all(`SELECT h.id,h.user_id,h.performance_id,MIN(h.expires_at,p.starts_at) AS expires_at
      FROM holds h JOIN performances p ON p.id=h.performance_id
      WHERE h.status='active' AND h.expires_at>? AND p.starts_at>? AND EXISTS(${occupied})
      ${userId === undefined ? '' : 'AND h.user_id=?'} ${performanceId === undefined ? '' : 'AND h.performance_id=?'}`,
      cutoff, cutoff, ...(userId === undefined ? [] : [userId]), ...(performanceId === undefined ? [] : [performanceId]));
  }
  performance(id) {
    const p = this.get('SELECT p.*,c.title,c.venue,c.booking_opens_at FROM performances p JOIN concerts c ON c.id=p.concert_id WHERE p.id=?', id);
    fail(p, 404, '공연 회차를 찾을 수 없습니다.');
    return p;
  }
  openPerformance(id, cutoff = this.now()) {
    const p = this.performance(id);
    fail(p.starts_at > cutoff, 409, '예매 및 취소가 마감된 회차입니다.');
    return p;
  }
  performanceSale(id) {
    return this.get('SELECT state,revision FROM performance_sales_events WHERE performance_id=? ORDER BY revision DESC LIMIT 1', id)
      ?? { state: 'open', revision: 0 };
  }
  requirePerformanceSale(id) {
    const { state } = this.performanceSale(id);
    if (state === 'open') return;
    const error = new AppError(409, state === 'paused' ? '이 회차는 판매가 중단되었습니다.' : '취소된 공연 회차입니다.');
    error.code = 'PERFORMANCE_UNAVAILABLE';
    throw error;
  }
  requireBookingOpening(performance, cutoff) {
    if (performance.booking_opens_at === null || performance.booking_opens_at <= cutoff) return;
    const error = new AppError(409, '아직 예매가 열리지 않았습니다. 예매 오픈 시각 이후 다시 시도해 주세요.');
    error.code = 'BOOKING_NOT_OPEN';
    throw error;
  }
  sellablePerformance(id, cutoff = this.now()) {
    const performance = this.openPerformance(id, cutoff);
    this.requirePerformanceSale(id);
    this.requireBookingOpening(performance, cutoff);
    return performance;
  }
  assertSeatMapVisible(id, includeCancelled) {
    fail(includeCancelled || this.performanceSale(id).state !== 'cancelled', 404, '공연 회차를 찾을 수 없습니다.');
  }
  concerts() {
    return this.readSnapshot(() => {
      const cutoff = this.now();
      return this.all('SELECT * FROM concerts ORDER BY created_at,id').map(c => ({
      ...c,
      performances: this.all(`SELECT p.*,COALESCE(sale.state,'open') AS sale_state,
      CASE WHEN sale.state='paused' THEN 0 ELSE (SELECT COUNT(*) FROM seats s WHERE s.performance_id=p.id AND s.blocked=0 AND s.booking_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM holds h WHERE h.id=s.hold_id AND h.status='active' AND h.expires_at>?)) END AS available,
      (SELECT MIN(price) FROM seats s WHERE s.performance_id=p.id) AS min_price
      FROM performances p ${latestPerformanceSaleJoin}
      WHERE p.concert_id=? AND sale.state IS NOT 'cancelled' ORDER BY starts_at`, cutoff, c.id)
      })).filter(concert => concert.performances.length);
    });
  }
  seatMap(performanceId, userId, { includeCancelled = false } = {}) {
    return this.readSnapshot(() => {
      const cutoff = this.now();
      const performance = this.performance(performanceId);
      this.assertSeatMapVisible(performanceId, includeCancelled);
      const hold = userId ? this.get("SELECT * FROM holds WHERE user_id=? AND performance_id=? AND status='active' AND expires_at>?", userId, performanceId, cutoff) : null;
      const seats = this.all(`SELECT s.*,h.status AS hold_status,h.expires_at AS hold_expires_at FROM seats s
        LEFT JOIN holds h ON h.id=s.hold_id WHERE s.performance_id=? ORDER BY s.row_label,s.number`, performanceId).map(s => ({
        id: s.id,
        row: s.row_label,
        number: s.number,
        grade: s.grade,
        price: s.price,
        state: s.blocked ? 'blocked' : s.booking_id ? 'booked' : s.hold_id && s.hold_status === 'active' && s.hold_expires_at > cutoff ? s.hold_id === hold?.id ? 'selected' : 'held' : 'available'
      }));
      return {
        performance,
        seats,
        hold: hold ? {
          id: hold.id,
          expires_at: hold.expires_at
        } : null,
        server_now: cutoff,
        max_tickets: 4
      };
    });
  }
  seat(performanceId, code) {
    return this.get('SELECT * FROM seats WHERE performance_id=? AND id=?', performanceId, code);
  }
  adminSeatOccupant(adminId, performanceId, seatId) {
    return this.readSnapshot(() => {
      this.requireAdmin(adminId);
      fail(typeof seatId === 'string' && seatId.length > 0, 400, '조회할 좌석을 지정해 주세요.');
      const seat = this.seat(performanceId, seatId);
      fail(seat, 404, '회차 또는 좌석을 찾을 수 없습니다.');
      const result = { seat_id: seatId, state: seat.blocked ? 'blocked' : 'available', member: null };
      if (seat.blocked) return result;

      if (seat.booking_id) {
        const booking = this.get(`SELECT b.id,u.name,u.email FROM bookings b JOIN holds h ON h.id=b.hold_id
          LEFT JOIN users u ON u.id=h.user_id AND u.password_hash<>?
          WHERE b.id=? AND b.status='confirmed' AND h.performance_id=?`, WITHDRAWN_PASSWORD_HASH, seat.booking_id, performanceId);
        if (booking) return { ...result, state: 'booked', booking_id: booking.id,
          member: booking.email === null ? null : { name: booking.name, email: booking.email } };
      }
      if (seat.hold_id) {
        const cutoff = this.now();
        const hold = this.get(`SELECT MIN(h.expires_at,p.starts_at) AS expires_at,u.name,u.email FROM holds h
          JOIN performances p ON p.id=h.performance_id LEFT JOIN users u ON u.id=h.user_id AND u.password_hash<>?
          WHERE h.id=? AND h.performance_id=? AND h.status='active' AND h.expires_at>? AND p.starts_at>?`,
          WITHDRAWN_PASSWORD_HASH, seat.hold_id, performanceId, cutoff, cutoff);
        if (hold) return { ...result, state: 'held', hold_expires_at: hold.expires_at,
          member: hold.email === null ? null : { name: hold.name, email: hold.email } };
      }
      return result;
    });
  }
  setHold(userId, performanceId, ids, { authorize } = {}) {
    fail(Array.isArray(ids) && ids.length <= 4 && ids.every(s => typeof s === 'string') && new Set(ids).size === ids.length, 400, '좌석은 중복 없이 최대 4석까지 선택해 주세요.');
    return this.transaction(() => {
      if (ids.length) this.requireBookingAllowed(userId);
      this.expire();
      if (ids.length) this.sellablePerformance(performanceId);
      else this.openPerformance(performanceId);
      let hold = this.get("SELECT * FROM holds WHERE user_id=? AND performance_id=? AND status='active'", userId, performanceId);
      const count = this.get("SELECT COUNT(*) AS n FROM booking_seats bs JOIN bookings b ON b.id=bs.booking_id WHERE b.user_id=? AND b.performance_id=? AND b.status='confirmed'", userId, performanceId).n;
      fail(count + ids.length <= 4, 409, '이미 예매한 좌석을 포함하여 회차당 최대 4매까지 예매할 수 있습니다.');
      const seats = ids.map(id => this.seat(performanceId, id));
      fail(seats.every(s => s && !s.blocked && !s.booking_id && (!s.hold_id || s.hold_id === hold?.id)), 409, '다른 고객이 선택했거나 판매할 수 없는 좌석입니다. 좌석 현황을 다시 확인해 주세요.');
      if (ids.length) authorize?.();
      const expiresAt = hold?.expires_at ?? this.now() + this.holdMs;
      // 다른 탭의 선택 변경으로 이전 주문의 좌석이 바뀌지 않도록 선점 ID를 교체한다.
      if (hold) {
        this.run('UPDATE seats SET hold_id=NULL WHERE hold_id=?', hold.id);
        this.run("UPDATE holds SET status='released' WHERE id=?", hold.id);
      }
      if (!ids.length) return {
        hold: null,
        server_now: this.now()
      };
      hold = {
        id: randomUUID(),
        expires_at: expiresAt
      };
      this.run("INSERT INTO holds VALUES(?,?,?,?,'active')", hold.id, userId, performanceId, hold.expires_at);
      for (const id of ids) this.run('UPDATE seats SET hold_id=? WHERE performance_id=? AND id=?', hold.id, performanceId, id);
      return {
        hold: {
          id: hold.id,
          expires_at: hold.expires_at
        },
        server_now: this.now()
      };
    });
  }
  checkout(userId, data, { idempotencyKey, authorize } = {}) {
    if (idempotencyKey !== undefined) throw new AppError(400, 'Idempotency-Key는 model 모드에서 지원합니다.');
    const { holdId, buyerName, buyerPhone, delivery } = normalizeCheckout(data);
    return this.transaction(() => {
      this.expire();
      const hold = this.get('SELECT * FROM holds WHERE id=? AND user_id=?', String(holdId ?? ''), userId);
      fail(hold, 404, '선택한 좌석 정보를 찾을 수 없습니다.');
      const existing = this.get('SELECT id FROM bookings WHERE hold_id=? AND user_id=?', hold.id, userId);
      if (existing) return this.booking(existing.id, userId);
      this.requireBookingAllowed(userId);
      this.requirePerformanceSale(hold.performance_id);
      fail(hold.status === 'active' && hold.expires_at > this.now(), 409, '좌석 선점 시간이 만료되었습니다. 다시 선택해 주세요.');
      const cutoff = this.now();
      this.requireBookingOpening(this.openPerformance(hold.performance_id, cutoff), cutoff);
      const seats = this.all('SELECT * FROM seats WHERE hold_id=?', hold.id);
      fail(seats.length > 0 && seats.length <= 4 && seats.every(s => s.performance_id === hold.performance_id && !s.blocked && !s.booking_id), 409, '좌석 상태가 변경되었습니다. 다시 선택해 주세요.');
      const confirmed = this.get(`SELECT COUNT(*) AS n FROM booking_seats bs JOIN bookings b ON b.id=bs.booking_id
        WHERE b.user_id=? AND b.performance_id=? AND b.status='confirmed'`, userId, hold.performance_id).n;
      fail(confirmed + seats.length <= 4, 409, '이미 예매한 좌석을 포함하여 회차당 최대 4매까지 예매할 수 있습니다.');
      authorize?.(hold);
      const id = 'T' + randomBytes(6).toString('hex').toUpperCase();
      const ticketTotal = seats.reduce((n, s) => n + s.price, 0),
        fee = seats.length * 2000;
      this.run("INSERT INTO bookings VALUES(?,?,?,?,'confirmed',?,?,?,?,?,?,?,NULL)", id, userId, hold.performance_id, hold.id, ticketTotal, fee, ticketTotal + fee, buyerName.trim(), buyerPhone, delivery, this.now());
      for (const s of seats) this.run('INSERT INTO booking_seats VALUES(?,?,?,?)', id, s.id, s.grade, s.price);
      this.run('UPDATE seats SET hold_id=NULL,booking_id=? WHERE hold_id=?', id, hold.id);
      this.run("UPDATE holds SET status='converted' WHERE id=?", hold.id);
      return this.booking(id, userId);
    });
  }
  booking(id, userId) {
    const b = this.get(`SELECT b.*,p.starts_at,c.title,c.artist,c.venue,c.theme FROM bookings b
      JOIN performances p ON p.id=b.performance_id JOIN concerts c ON c.id=p.concert_id WHERE b.id=? AND b.user_id=?`, id, userId);
    fail(b, 404, '예매 내역을 찾을 수 없습니다.');
    return {
      ...b,
      ...this.cancellationDetails(b),
      seats: this.all('SELECT seat_id,grade,price FROM booking_seats WHERE booking_id=? ORDER BY seat_id', id)
    };
  }
  bookings(userId) {
    return this.all('SELECT id FROM bookings WHERE user_id=? ORDER BY created_at DESC', userId).map(b => this.booking(b.id, userId));
  }
  cancel(userId, id) {
    return this.transaction(() => {
      const b = this.booking(id, userId);
      if (b.status === 'cancelled') return b;
      this.#cancelBooking(b, this.now());
      return this.booking(id, userId);
    });
  }
  #cancelBooking(booking, cutoff) {
    this.openPerformance(booking.performance_id, cutoff);
    this.releaseBookedSeats(booking.id, booking.seats.length);
    const result = this.run("UPDATE bookings SET status='cancelled',cancelled_at=? WHERE id=? AND status='confirmed'", cutoff, booking.id);
    if (result.changes !== 1) throw new Error('예매 취소 상태 검증에 실패했습니다.');
  }
  releaseBookedSeats(id, count) {
    const result = this.run('UPDATE seats SET booking_id=NULL WHERE booking_id=?', id);
    if (result.changes !== count) throw new Error('예매 좌석 해제 검증에 실패했습니다.');
  }
  cancellationDetails(booking) {
    if (booking.status !== 'cancelled') return undefined;
    return this.get(`SELECT reason AS performance_cancel_reason FROM performance_cancelled_bookings c
      JOIN performance_sales_events e ON e.performance_id=c.performance_id AND e.revision=c.revision WHERE c.booking_id=?`, booking.id)
      ?? this.get('SELECT reason AS admin_cancel_reason FROM admin_booking_cancellations WHERE booking_id=?', booking.id);
  }
  #bookingForAdmin(id) {
    const owner = this.get('SELECT h.user_id FROM bookings b JOIN holds h ON h.id=b.hold_id WHERE b.id=?', id);
    fail(owner, 404, '예매 내역을 찾을 수 없습니다.');
    return this.booking(id, owner.user_id);
  }
  adminBooking(adminId, id) {
    return this.readSnapshot(() => {
      this.requireAdmin(adminId);
      return adminBookingResult(this.#bookingForAdmin(id), this.now());
    });
  }
  cancelAsAdmin(adminId, id, { reason, confirmed, ...extra }) {
    return this.transaction(() => {
      this.requireAdmin(adminId);
      fail(reason === 'customer_request' && confirmed === true && Object.keys(extra).length === 0, 400, '고객 요청 사유와 예매 전체 취소 확인이 필요합니다.');
      const booking = this.#bookingForAdmin(id);
      const cutoff = this.now();
      if (booking.status === 'cancelled') return adminBookingResult(booking, cutoff);
      this.#cancelBooking(booking, cutoff);
      this.run('INSERT INTO admin_booking_cancellations(booking_id,admin_id,reason,created_at) VALUES(?,?,?,?)', id, adminId, reason, cutoff);
      return adminBookingResult(this.booking(id, booking.user_id), cutoff);
    });
  }
  requireAdmin(userId) {
    fail(this.get('SELECT role FROM users WHERE id=?', userId)?.role === 'admin', 403, '관리자 권한이 필요합니다.');
  }
  changePerformanceSales(adminId, { action, targets, reason, ...extra }) {
    const states = { pause: 'paused', resume: 'open', cancel: 'cancelled' };
    const allowed = { pause: ['open'], resume: ['paused'], cancel: ['open', 'paused'] };
    const note = typeof reason === 'string' ? reason.trim() : '';
    fail(typeof action === 'string' && Object.hasOwn(states, action) && note.length > 0 && note.length <= 200 &&
      !/[\u0000-\u001f\u007f]/.test(note) && !Object.keys(extra).length && Array.isArray(targets) &&
      targets.length > 0 && targets.length <= 50 && targets.every(target => target && typeof target.performance_id === 'string' &&
        target.performance_id.length > 0 && Number.isSafeInteger(target.revision) && target.revision >= 0 &&
        Number.isSafeInteger(target.booking_count) && target.booking_count >= 0 && Object.keys(target).length === 3) &&
      new Set(targets.map(target => target.performance_id)).size === targets.length, 400, '회차, 처리 방식, 사유를 확인해 주세요.');
    return this.transaction(() => {
      this.requireAdmin(adminId);
      const cutoff = this.now();
      const nextState = states[action];
      const performances = targets.map(target => {
        const id = target.performance_id;
        this.openPerformance(id, cutoff);
        const current = this.performanceSale(id);
        fail(current.revision === target.revision && allowed[action].includes(current.state), 409, '회차 상태가 바뀌었습니다. 새로고침 후 다시 확인해 주세요.');
        const bookings = action === 'cancel' ? this.all(`SELECT b.id,h.user_id FROM bookings b JOIN holds h ON h.id=b.hold_id
          WHERE h.performance_id=? AND b.status='confirmed'`, id) : [];
        fail(action !== 'cancel' || bookings.length === target.booking_count, 409, '확정 예매 건수가 바뀌었습니다. 새로고침 후 다시 확인해 주세요.');
        return { id, revision: current.revision + 1, bookings };
      });
      let cancelledBookings = 0;
      for (const { id, revision, bookings } of performances) {
        this.run('INSERT INTO performance_sales_events VALUES(?,?,?,?,?,?)', id, revision, adminId, nextState, note, cutoff);
        if (action !== 'resume') this.#releasePerformanceHolds(id);
        for (const booking of bookings) {
          this.#cancelBooking(this.booking(booking.id, booking.user_id), cutoff);
          this.run('INSERT INTO performance_cancelled_bookings VALUES(?,?,?)', booking.id, id, revision);
        }
        cancelledBookings += bookings.length;
      }
      return { state: nextState, performance_ids: performances.map(({ id }) => id), cancelled_bookings: cancelledBookings };
    });
  }
  #releasePerformanceHolds(id) {
    if (this.schema === 'model') this.run('DELETE FROM current_holds WHERE hold_id IN (SELECT id FROM holds WHERE performance_id=?)', id);
    else this.run('UPDATE seats SET hold_id=NULL WHERE performance_id=? AND hold_id IS NOT NULL', id);
    this.run("UPDATE holds SET status='released' WHERE performance_id=? AND status='active'", id);
  }
  blockSeats(userId, performanceId, ids, blocked) {
    this.requireAdmin(userId);
    fail(Array.isArray(ids) && ids.length > 0 && ids.length <= 96 && new Set(ids).size === ids.length && ids.every(id => typeof id === 'string') && typeof blocked === 'boolean', 400, '좌석과 차단 상태를 확인해 주세요.');
    return this.transaction(() => {
      this.expire();
      this.openPerformance(performanceId);
      for (const id of ids) {
        const s = this.seat(performanceId, id);
        fail(s && !s.hold_id && !s.booking_id, 409, '선점 또는 예매된 좌석은 변경할 수 없습니다.');
      }
      for (const id of ids) this.run('UPDATE seats SET blocked=? WHERE performance_id=? AND id=?', Number(blocked), performanceId, id);
      this.recordAudit(userId, blocked ? 'block' : 'unblock', {
        performanceId,
        ids
      });
      return {
        updated: ids.length
      };
    });
  }
  createConcert(userId, data) {
    this.requireAdmin(userId);
    for (const key of ['title', 'artist', 'venue', 'description']) fail(typeof data[key] === 'string' && data[key].trim().length > 0 && data[key].length <= (key === 'description' ? 2000 : 120), 400, '공연명, 아티스트, 장소, 소개를 입력해 주세요.');
    fail(Array.isArray(data.dates) && data.dates.length > 0 && data.dates.length <= 10, 400, '1~10개의 회차를 등록해 주세요.');
    const dates = data.dates.map(parseZonedTime);
    fail(dates.every(Number.isFinite) && new Set(dates).size === dates.length, 400, '시간대가 포함된 서로 다른 공연 일시를 입력해 주세요.');
    const price = Number(data.basePrice);
    fail(Number.isInteger(price) && price >= 1000 && price <= 1000000, 400, 'S석 가격은 1,000~1,000,000원으로 입력해 주세요.');
    return this.transaction(() => {
      const now = this.now();
      const earliestStart = now + MIN_CONCERT_LEAD_MS;
      fail(dates.every(date => date >= earliestStart), 400, '모든 회차는 등록 시점부터 최소 24시간 뒤에 시작해야 합니다.');
      const requested = data.bookingOpensAt == null ? now : parseZonedTime(data.bookingOpensAt);
      fail(Number.isFinite(requested) && requested >= now - OPENING_GRACE_MS && requested < Math.min(...dates),
        400, '예매 오픈 일시는 현재 이후, 첫 회차 시작 전으로 입력해 주세요.');
      fail(!this.#hasIdenticalConcert(data, dates, price), 409, '공연 정보와 회차가 모두 같은 공연이 이미 등록되어 있습니다.');
      const id = randomUUID();
      this.insertConcert({
        ...data,
        id,
        theme: 'teal',
        duration: 120,
        age: '8세 이상',
        bookingOpensAt: Math.max(requested, now)
      }, dates, price);
      this.recordAudit(userId, 'create-concert', {
        id,
        title: data.title
      });
      return {
        id
      };
    });
  }
  #hasIdenticalConcert({ title, artist, venue, description }, dates, price) {
    const model = this.schema === 'model';
    const venueJoin = model ? 'JOIN venues v ON v.id=p.venue_id' : '';
    const venueName = model ? 'v.name' : 'c.venue';
    const seatTable = model ? 'inventory' : 'seats';
    return Boolean(this.get(`SELECT c.id FROM concerts c
      JOIN performances p ON p.concert_id=c.id ${venueJoin} ${latestPerformanceSaleJoin}
      WHERE c.title=? AND c.artist=? AND c.description=?
      GROUP BY c.id
      HAVING COUNT(*)=? AND COUNT(CASE WHEN sale.state IS NOT 'cancelled' THEN 1 END)>0
        AND COUNT(DISTINCT CASE WHEN ${venueName}=?
        AND p.starts_at IN (SELECT value FROM json_each(?))
        AND (SELECT CASE WHEN MIN(s.price)=MAX(s.price) THEN MIN(s.price) END
          FROM ${seatTable} s WHERE s.performance_id=p.id AND s.grade='S')=?
        THEN p.starts_at END)=?
      LIMIT 1`, title.trim(), artist.trim(), description.trim(), dates.length, venue.trim(), JSON.stringify(dates), price, dates.length));
  }
  insertConcert(c, dates, basePrice) {
    this.run('INSERT INTO concerts(id,title,artist,venue,description,theme,duration,age,created_at,booking_opens_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      c.id, c.title.trim(), c.artist.trim(), c.venue.trim(), c.description.trim(), c.theme, c.duration, c.age, this.now(), c.bookingOpensAt ?? null);
    for (const starts of dates) {
      const pid = randomUUID();
      this.run('INSERT INTO performances VALUES(?,?,?)', pid, c.id, starts);
      for (let row = 0; row < 8; row++) for (let n = 1; n <= 12; n++) {
        const label = String.fromCharCode(65 + row),
          grade = row < 2 ? 'VIP' : row < 5 ? 'R' : 'S';
        const price = basePrice + (grade === 'VIP' ? 40000 : grade === 'R' ? 20000 : 0);
        this.run('INSERT INTO seats(performance_id,id,row_label,number,grade,price) VALUES(?,?,?,?,?,?)', pid, `${label}-${String(n).padStart(2, '0')}`, label, n, grade, price);
      }
    }
  }
  adminSummary(userId) {
    this.requireAdmin(userId);
    return this.readSnapshot(() => {
      const cutoff = this.now();
      return {
      stats: this.get("SELECT COUNT(*) AS bookings,COALESCE(SUM(total),0) AS revenue FROM bookings WHERE status='confirmed'"),
      users: this.get('SELECT COUNT(*) AS count FROM users WHERE password_hash<>?', WITHDRAWN_PASSWORD_HASH).count,
      performances: this.all(`SELECT p.id,p.concert_id,p.starts_at,c.title,COUNT(*) AS total,
        COALESCE(sale.state,'open') AS sale_state,COALESCE(sale.revision,0) AS sale_revision,
        COUNT(DISTINCT s.booking_id) AS booking_count,
        SUM(CASE WHEN s.blocked=1 THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN s.booking_id IS NOT NULL THEN 1 ELSE 0 END) AS booked,
        SUM(CASE WHEN h.status='active' AND h.expires_at>? THEN 1 ELSE 0 END) AS held
        FROM performances p JOIN concerts c ON c.id=p.concert_id JOIN seats s ON s.performance_id=p.id
        LEFT JOIN holds h ON h.id=s.hold_id ${latestPerformanceSaleJoin} GROUP BY p.id ORDER BY starts_at`, cutoff),
      audit: this.recentAudit()
      };
    });
  }
  recentAudit() {
    const table = this.schema === 'model' ? 'audit_events' : 'audit';
    return this.all(`SELECT action,detail,created_at,name FROM (
      SELECT a.action,a.detail,a.created_at,u.name,a.id AS event_id,NULL AS subject_id
      FROM ${table} a JOIN users u ON u.id=a.user_id
      UNION ALL
      SELECT 'cancel-booking',json_object('bookingId',c.booking_id,'reason',c.reason),c.created_at,u.name,NULL,c.booking_id
      FROM admin_booking_cancellations c JOIN users u ON u.id=c.admin_id
      UNION ALL
      SELECT CASE WHEN m.restricted=1 THEN 'restrict-member' ELSE 'restore-member' END,
        json_object('memberId',m.member_id,'reason',m.reason),m.created_at,u.name,m.revision,m.member_id
      FROM member_booking_restrictions m JOIN users u ON u.id=m.admin_id
      UNION ALL
      SELECT CASE e.state WHEN 'open' THEN 'resume-performance' WHEN 'paused' THEN 'pause-performance' ELSE 'cancel-performance' END,
        json_object('performanceId',e.performance_id,'reason',e.reason),e.created_at,u.name,e.revision,e.performance_id
      FROM performance_sales_events e JOIN users u ON u.id=e.admin_id
    ) ORDER BY created_at DESC,event_id DESC,subject_id DESC LIMIT 15`);
  }
  async migrateBranding({ demo = false } = {}) {
    const accounts = [];
    if (demo) for (const old of LEGACY_DEMO_ACCOUNTS) {
      const user = this.get('SELECT * FROM users WHERE email=?', old.email);
      if (!user) continue;
      fail(user.role === old.role && !this.get('SELECT id FROM users WHERE email=?', old.nextEmail), 409,
        '프로젝트명 변경 중 데모 계정이 충돌했습니다. 기존 회원을 병합하지 않고 보존합니다.');
      const passwordHash = await verifyPassword(old.password, user.password_hash)
        ? await hashPassword(old.nextPassword) : user.password_hash;
      accounts.push({ old, user, passwordHash });
    }
    const table = this.schema === 'model' ? 'venues' : 'concerts', column = this.schema === 'model' ? 'name' : 'venue';
    const venues = LEGACY_VENUE_NAMES.filter(([old]) => this.get(`SELECT 1 FROM ${table} WHERE ${column}=? LIMIT 1`, old));
    if (!accounts.length && !venues.length) return;
    this.transaction(() => {
      for (const { old, user, passwordHash } of accounts) {
        const current = this.get('SELECT * FROM users WHERE id=?', user.id);
        fail(current?.email === old.email && current.password_hash === user.password_hash && current.role === old.role
          && !this.get('SELECT id FROM users WHERE email=?', old.nextEmail), 409, '데모 계정 상태가 변경되었습니다. 다시 실행해 주세요.');
        this.run('UPDATE users SET email=?,name=?,password_hash=? WHERE id=?', old.nextEmail,
          user.name === old.name ? old.nextName : user.name, passwordHash, user.id);
      }
      for (const [old, next] of venues) this.run(`UPDATE ${table} SET ${column}=? WHERE ${column}=?`, next, old);
    });
  }
  async seed({
    demo = true,
    adminEmail,
    adminPassword
  } = {}) {
    const admin = validateAdminCredentials(adminEmail, adminPassword);
    await this.migrateBranding({ demo });
    if (admin) {
      const existing = this.get('SELECT role FROM users WHERE email=?', admin.email);
      fail(!existing || existing.role === 'admin', 409, '초기 관리자 이메일이 일반 회원과 충돌합니다. 다른 이메일을 사용해 주세요.');
    }
    if (!this.get('SELECT id FROM concerts LIMIT 1')) this.transaction(() => {
      const day = new Date(this.now());
      day.setUTCDate(day.getUTCDate() + 21);
      day.setUTCHours(10, 0, 0, 0);
      const shows = [['aurora', 'AURORA : THE LIVE', '오로라', 'ticket-ssu 아레나 · 서울', '빛과 음악이 만나는 밤. 오로라의 새로운 라이브 무대를 함께하세요.', 'teal', 90000], ['midnight', 'MIDNIGHT GROOVE', '미드나잇 밴드', '블루 스테이지 · 서울', '도시의 밤을 채우는 리듬. 가장 가까이에서 만나는 밴드 사운드.', 'purple', 70000], ['mellow', 'A LITTLE MELLOW', '서윤', '온유 아트홀 · 부산', '조금 느려도 괜찮은 하루. 따뜻한 목소리와 함께하는 어쿠스틱 콘서트.', 'orange', 60000], ['orbit', 'ORBIT : NEXT CHAPTER', '오르빗', 'ticket-ssu 아레나 · 인천', '새로운 궤도 위에서 만나는 우리. 오르빗의 두 번째 단독 콘서트.', 'blue', 100000]];
      shows.forEach(([id, title, artist, venue, description, theme, price], i) => this.insertConcert({
        id,
        title,
        artist,
        venue,
        description,
        theme,
        duration: 120,
        age: '8세 이상'
      }, [day.getTime() + i * 86400000, day.getTime() + (i + 1) * 86400000], price));
    });
    const accounts = demo ? [['demo@ticket-ssu.local', 'TicketSsuDemo123!', '티켓회원', 'user'], ['admin@ticket-ssu.local', 'TicketSsuAdmin123!', '운영자', 'admin']] : [];
    if (admin) accounts.push([admin.email, admin.password, '운영자', 'admin']);
    for (const [email, password, name, role] of accounts) if (!this.get('SELECT id FROM users WHERE email=?', email.toLowerCase())) {
      fail(password.length >= 10, 400, '초기 관리자 비밀번호는 10자 이상이어야 합니다.');
      this.run('INSERT INTO users VALUES(?,?,?,?,?,?,?)', randomUUID(), email.toLowerCase(), name, '01012345678', await hashPassword(password), role, this.now());
    }
  }
  close() {
    this.db.close();
  }
}
