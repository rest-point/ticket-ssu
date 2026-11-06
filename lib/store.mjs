import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { applySchema, configure, validateModel, enableAccountWithdrawal } from '../db/model.mjs';
import { LEGACY_DEMO_ACCOUNTS, LEGACY_VENUE_NAMES } from './project-identity.mjs';
const scrypt = promisify(scryptCallback);
const digest = value => createHash('sha256').update(value).digest('hex');
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
        validateModel(this.db); // Startup only. Request methods validate affected rows.
        enableAccountWithdrawal(this.db);
        if (!Number.isSafeInteger(holdMs) || holdMs <= 0) throw new Error('holdMs는 양의 안전 정수여야 합니다.');
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
      if (this.schema === 'model') this.run('DELETE FROM current_holds WHERE hold_id IN (SELECT id FROM holds WHERE user_id=?)', userId);
      else this.run('UPDATE seats SET hold_id=NULL WHERE hold_id IN (SELECT id FROM holds WHERE user_id=?)', userId);
      this.run("UPDATE holds SET status='released' WHERE user_id=? AND status='active'", userId);
      this.run('DELETE FROM sessions WHERE user_id=?', userId);
      this.run("UPDATE users SET email=?,name='탈퇴회원',phone='01000000000',password_hash=? WHERE id=?",
        `withdrawn-${randomUUID()}@account.invalid`, WITHDRAWN_PASSWORD_HASH, userId);
      this.run("UPDATE bookings SET buyer_name='탈퇴회원',buyer_phone='01000000000' WHERE hold_id IN (SELECT id FROM holds WHERE user_id=?)", userId);
      return { ok: true };
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
    const p = this.get('SELECT p.*,c.title,c.venue FROM performances p JOIN concerts c ON c.id=p.concert_id WHERE p.id=?', id);
    fail(p, 404, '공연 회차를 찾을 수 없습니다.');
    return p;
  }
  openPerformance(id) {
    const p = this.performance(id);
    fail(p.starts_at > this.now(), 409, '예매 및 취소가 마감된 회차입니다.');
    return p;
  }
  concerts() {
    return this.readSnapshot(() => {
      const cutoff = this.now();
      return this.all('SELECT * FROM concerts ORDER BY created_at,id').map(c => ({
      ...c,
      performances: this.all(`SELECT p.*,
      (SELECT COUNT(*) FROM seats s WHERE s.performance_id=p.id AND s.blocked=0 AND s.booking_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM holds h WHERE h.id=s.hold_id AND h.status='active' AND h.expires_at>?)) AS available,
      (SELECT MIN(price) FROM seats s WHERE s.performance_id=p.id) AS min_price
      FROM performances p WHERE concert_id=? ORDER BY starts_at`, cutoff, c.id)
      }));
    });
  }
  seatMap(performanceId, userId) {
    return this.readSnapshot(() => {
      const cutoff = this.now();
      const performance = this.performance(performanceId);
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
  setHold(userId, performanceId, ids, { authorize } = {}) {
    fail(Array.isArray(ids) && ids.length <= 4 && ids.every(s => typeof s === 'string') && new Set(ids).size === ids.length, 400, '좌석은 중복 없이 최대 4석까지 선택해 주세요.');
    return this.transaction(() => {
      this.expire();
      this.openPerformance(performanceId);
      let hold = this.get("SELECT * FROM holds WHERE user_id=? AND performance_id=? AND status='active'", userId, performanceId);
      const count = this.get("SELECT COUNT(*) AS n FROM booking_seats bs JOIN bookings b ON b.id=bs.booking_id WHERE b.user_id=? AND b.performance_id=? AND b.status='confirmed'", userId, performanceId).n;
      fail(count + ids.length <= 4, 409, '이미 예매한 좌석을 포함하여 회차당 최대 4매까지 예매할 수 있습니다.');
      const seats = ids.map(id => this.get('SELECT * FROM seats WHERE performance_id=? AND id=?', performanceId, id));
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
      fail(hold.status === 'active' && hold.expires_at > this.now(), 409, '좌석 선점 시간이 만료되었습니다. 다시 선택해 주세요.');
      this.openPerformance(hold.performance_id);
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
      this.openPerformance(b.performance_id);
      this.run("UPDATE bookings SET status='cancelled',cancelled_at=? WHERE id=?", this.now(), id);
      this.run('UPDATE seats SET booking_id=NULL WHERE booking_id=?', id);
      return this.booking(id, userId);
    });
  }
  requireAdmin(userId) {
    fail(this.get('SELECT role FROM users WHERE id=?', userId)?.role === 'admin', 403, '관리자 권한이 필요합니다.');
  }
  blockSeats(userId, performanceId, ids, blocked) {
    this.requireAdmin(userId);
    fail(Array.isArray(ids) && ids.length > 0 && ids.length <= 96 && new Set(ids).size === ids.length && ids.every(id => typeof id === 'string') && typeof blocked === 'boolean', 400, '좌석과 차단 상태를 확인해 주세요.');
    return this.transaction(() => {
      this.expire();
      this.openPerformance(performanceId);
      for (const id of ids) {
        const s = this.get('SELECT * FROM seats WHERE performance_id=? AND id=?', performanceId, id);
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
    const dates = data.dates.map(s => typeof s === 'string' && /[+-]\d{2}:\d{2}$|Z$/.test(s) ? Date.parse(s) : NaN);
    fail(dates.every(d => Number.isFinite(d) && d > this.now()) && new Set(dates).size === dates.length, 400, '서로 다른 미래 공연 일시를 입력해 주세요.');
    const price = Number(data.basePrice);
    fail(Number.isInteger(price) && price >= 1000 && price <= 1000000, 400, 'S석 가격은 1,000~1,000,000원으로 입력해 주세요.');
    return this.transaction(() => {
      const id = randomUUID();
      this.insertConcert({
        ...data,
        id,
        theme: 'teal',
        duration: 120,
        age: '8세 이상'
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
  insertConcert(c, dates, basePrice) {
    this.run('INSERT INTO concerts VALUES(?,?,?,?,?,?,?,?,?)', c.id, c.title.trim(), c.artist.trim(), c.venue.trim(), c.description.trim(), c.theme, c.duration, c.age, this.now());
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
      performances: this.all(`SELECT p.id,p.starts_at,c.title,COUNT(*) AS total,
        SUM(CASE WHEN s.blocked=1 THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN s.booking_id IS NOT NULL THEN 1 ELSE 0 END) AS booked,
        SUM(CASE WHEN h.status='active' AND h.expires_at>? THEN 1 ELSE 0 END) AS held
        FROM performances p JOIN concerts c ON c.id=p.concert_id JOIN seats s ON s.performance_id=p.id
        LEFT JOIN holds h ON h.id=s.hold_id GROUP BY p.id ORDER BY starts_at`, cutoff),
      audit: this.all('SELECT a.action,a.detail,a.created_at,u.name FROM audit a JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 15')
      };
    });
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
