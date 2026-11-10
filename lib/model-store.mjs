import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { Store, AppError, normalizeCheckout, WITHDRAWN_PASSWORD_HASH } from './store.mjs';

const fail = (condition, status, message) => { if (!condition) throw new AppError(status, message); };
const changed = (result, expected) => { if (result.changes !== expected) throw new Error('예상한 DB 변경 행 수와 다릅니다.'); };
const checkoutFailures = {
  HOLD_EXPIRED: '좌석 선점 시간이 만료되었습니다. 다시 선택해 주세요.',
  PERFORMANCE_CLOSED: '예매 및 취소가 마감된 회차입니다.',
  SEAT_CONFLICT: '좌석 상태가 변경되었습니다. 다시 선택해 주세요.',
  TICKET_LIMIT: '이미 예매한 좌석을 포함하여 회차당 최대 4매까지 예매할 수 있습니다.',
  AMOUNT_RANGE: '금액 범위를 확인해 주세요.'
};
const checkoutError = code => Object.assign(new AppError(409, checkoutFailures[code]), { code });
const checkoutCheck = (condition, code) => {
  if (!condition) throw Object.assign(checkoutError(code), { recordable: true });
};
const checkoutHash = ({ holdId, buyerName, buyerPhone, delivery }) => createHash('sha256')
  .update(JSON.stringify([holdId, buyerName, buyerPhone, delivery, 'demo', true])).digest('hex');
const keyConflict = () => new AppError(409, '같은 선점의 멱등성 키 또는 기존 예매와 요청 내용이 다릅니다.');

// Same public methods/JSON as Store; normalized persistence is explicit opt-in.
export class ModelStore extends Store {
  constructor(path, options = {}) { super(path, { ...options, schema: 'model' }); }

  expire(cutoff = this.now()) {
    const cleanup = () => {
      this.run("DELETE FROM current_holds WHERE hold_id IN (SELECT id FROM holds WHERE status!='active' OR expires_at<=?)", cutoff);
      this.run("UPDATE holds SET status='expired' WHERE status='active' AND expires_at<=?", cutoff);
    };
    return this.inTransaction ? cleanup() : this.transaction(cleanup);
  }

  performance(id) {
    const p = this.get(`SELECT p.id,p.concert_id,p.starts_at,c.title,v.name AS venue,c.booking_opens_at
      FROM performances p JOIN concerts c ON c.id=p.concert_id JOIN venues v ON v.id=p.venue_id WHERE p.id=?`, id);
    fail(p, 404, '공연 회차를 찾을 수 없습니다.');
    return p;
  }
  openPerformance(id, cutoff = this.now()) {
    const p = this.performance(id);
    fail(p.starts_at > cutoff, 409, '예매 및 취소가 마감된 회차입니다.');
    return p;
  }

  concerts() {
    return this.readSnapshot(() => {
      const cutoff = this.now();
      return this.all('SELECT * FROM concerts ORDER BY created_at,id').map(c => {
        const rows = this.all(`SELECT p.id,p.concert_id,p.starts_at,v.name AS venue,
          (SELECT COUNT(*) FROM inventory i WHERE i.performance_id=p.id AND i.blocked=0
            AND NOT EXISTS(SELECT 1 FROM current_holds ch JOIN holds h ON h.id=ch.hold_id
              WHERE ch.inventory_id=i.id AND h.status='active' AND h.expires_at>?)
            AND NOT EXISTS(SELECT 1 FROM current_bookings cb WHERE cb.inventory_id=i.id)) AS available,
          (SELECT MIN(price) FROM inventory i WHERE i.performance_id=p.id) AS min_price
          FROM performances p JOIN venues v ON v.id=p.venue_id WHERE p.concert_id=? ORDER BY p.starts_at,p.id`, cutoff, c.id);
        return { ...c, venue: [...new Set(rows.map(p => p.venue))].join(' / '),
          performances: rows.map(({ venue, ...p }) => p) };
      });
    });
  }

  seatMap(performanceId, userId) {
    return this.readSnapshot(() => {
      const cutoff = this.now();
      const performance = this.performance(performanceId);
      const hold = userId ? this.get("SELECT id,expires_at FROM holds WHERE user_id=? AND performance_id=? AND status='active' AND expires_at>?", userId, performanceId, cutoff) : null;
      const seats = this.all(`SELECT s.seat_code AS id,s.row_label AS row,s.number,i.grade,i.price,i.blocked,ch.hold_id,cb.booking_id
        FROM inventory i JOIN physical_seats s ON s.id=i.physical_seat_id
        LEFT JOIN current_holds ch ON ch.inventory_id=i.id AND EXISTS(SELECT 1 FROM holds h
          WHERE h.id=ch.hold_id AND h.status='active' AND h.expires_at>?)
        LEFT JOIN current_bookings cb ON cb.inventory_id=i.id
        WHERE i.performance_id=? ORDER BY s.row_label,s.number`, cutoff, performanceId).map(s => ({
        id: s.id, row: s.row, number: s.number, grade: s.grade, price: s.price,
        state: s.blocked ? 'blocked' : s.booking_id ? 'booked' : s.hold_id ? s.hold_id === hold?.id ? 'selected' : 'held' : 'available'
      }));
      return { performance, seats, hold: hold ?? null, server_now: cutoff, max_tickets: 4 };
    });
  }

  confirmedCount(userId, performanceId) {
    return this.get(`SELECT COUNT(*) AS n FROM booking_items bi JOIN bookings b ON b.id=bi.booking_id
      JOIN holds h ON h.id=b.hold_id WHERE h.user_id=? AND h.performance_id=? AND b.status='confirmed'`, userId, performanceId).n;
  }
  seat(performanceId, code) {
    return this.get(`SELECT i.*,ch.hold_id,cb.booking_id FROM inventory i JOIN physical_seats s ON s.id=i.physical_seat_id
      LEFT JOIN current_holds ch ON ch.inventory_id=i.id LEFT JOIN current_bookings cb ON cb.inventory_id=i.id
      WHERE i.performance_id=? AND s.seat_code=?`, performanceId, code);
  }

  setHold(userId, performanceId, ids, { authorize } = {}) {
    fail(Array.isArray(ids) && ids.length <= 4 && ids.every(s => typeof s === 'string') && new Set(ids).size === ids.length, 400, '좌석은 중복 없이 최대 4석까지 선택해 주세요.');
    return this.transaction(() => {
      const cutoff = this.now();
      this.expire(cutoff);
      this.sellablePerformance(performanceId, cutoff);
      const old =this.get("SELECT * FROM holds WHERE user_id=? AND performance_id=? AND status='active'", userId, performanceId);
      fail(this.confirmedCount(userId, performanceId) + ids.length <= 4, 409, '이미 예매한 좌석을 포함하여 회차당 최대 4매까지 예매할 수 있습니다.');
      const seats = ids.map(id => this.seat(performanceId, id));
      fail(seats.every(s => s && !s.blocked && !s.booking_id && (!s.hold_id || s.hold_id === old?.id)), 409, '다른 고객이 선택했거나 판매할 수 없는 좌석입니다. 좌석 현황을 다시 확인해 주세요.');
      if (ids.length) authorize?.();
      const expiresAt = old?.expires_at ?? cutoff + this.holdMs;
      if (old) {
        this.run('DELETE FROM current_holds WHERE hold_id=?', old.id);
        changed(this.run("UPDATE holds SET status='released' WHERE id=? AND status='active'", old.id), 1);
      }
      if (!ids.length) return { hold: null, server_now: cutoff };
      const id = randomUUID();
      changed(this.run("INSERT INTO holds VALUES(?,?,?,?,'active')", id, userId, performanceId, expiresAt), 1);
      for (const s of seats) changed(this.run('INSERT INTO current_holds VALUES(?,?)', s.id, id), 1);
      fail(this.get('SELECT COUNT(*) AS n FROM current_holds WHERE hold_id=?', id).n === ids.length, 409, '좌석 상태가 변경되었습니다.');
      return { hold: { id, expires_at: expiresAt }, server_now: cutoff };
    });
  }

  checkout(userId, data, { idempotencyKey, authorize } = {}) {
    const normalized = normalizeCheckout(data);
    const { holdId, buyerName, buyerPhone, delivery } = normalized;
    const keyed = idempotencyKey !== undefined;
    fail(!keyed || (typeof idempotencyKey === 'string' && /^[\x21-\x7e]{1,128}$/.test(idempotencyKey) && idempotencyKey !== 'legacy-checkout'), 400, 'Idempotency-Key는 공백 없는 ASCII 1~128자여야 하며 legacy-checkout은 예약 키입니다.');
    const bodyHash = checkoutHash(normalized);
    const replay = attempt => {
      if (attempt.body_hash !== bodyHash) throw keyConflict();
      if (attempt.result === 'failed') throw checkoutError(attempt.failure_code);
      return this.booking(attempt.booking_id, userId);
    };
    try { return this.transaction(() => {
      const cutoff = this.now();
      const hold = this.get('SELECT * FROM holds WHERE id=? AND user_id=?', String(holdId ?? ''), userId);
      fail(hold, 404, '선택한 좌석 정보를 찾을 수 없습니다.');
      if (keyed) {
        const attempt = this.get('SELECT * FROM payment_attempts WHERE hold_id=? AND request_key=?', hold.id, idempotencyKey);
        if (attempt) return replay(attempt);
      }
      const existing = this.get('SELECT id FROM bookings WHERE hold_id=?', hold.id);
      if (existing) {
        const booking = this.booking(existing.id, userId);
        if (keyed) {
          const success = this.get("SELECT body_hash FROM payment_attempts WHERE booking_id=? AND result='succeeded'", booking.id);
          const originalHash = success?.body_hash ?? checkoutHash({ holdId: hold.id, buyerName: booking.buyer_name, buyerPhone: booking.buyer_phone, delivery: booking.delivery });
          if (bodyHash !== originalHash) throw keyConflict();
        }
        return booking; // Header-free callers retain the existing /api behavior.
      }
      this.expire(cutoff);
      checkoutCheck(hold.status === 'active' && hold.expires_at > cutoff, 'HOLD_EXPIRED');
      checkoutCheck(this.performance(hold.performance_id).starts_at > cutoff, 'PERFORMANCE_CLOSED');
      const seats = this.all(`SELECT i.*,cb.booking_id FROM current_holds ch JOIN inventory i ON i.id=ch.inventory_id
        LEFT JOIN current_bookings cb ON cb.inventory_id=i.id WHERE ch.hold_id=?`, hold.id);
      checkoutCheck(seats.length > 0 && seats.length <= 4 && seats.every(s => s.performance_id === hold.performance_id && !s.blocked && !s.booking_id), 'SEAT_CONFLICT');
      checkoutCheck(this.confirmedCount(userId, hold.performance_id) + seats.length <= 4, 'TICKET_LIMIT');
      const ticketTotal = seats.reduce((n, s) => n + s.price, 0), fee = seats.length * 2000;
      checkoutCheck(Number.isSafeInteger(ticketTotal + fee), 'AMOUNT_RANGE');
      authorize?.(hold);
      changed(this.run('DELETE FROM current_holds WHERE hold_id=?', hold.id), seats.length);
      changed(this.run("UPDATE holds SET status='converted' WHERE id=? AND status='active'", hold.id), 1);
      const id = 'T' + randomBytes(6).toString('hex').toUpperCase();
      changed(this.run("INSERT INTO bookings VALUES(?,?,'confirmed',?,?,?,?,?,NULL)", id, hold.id, fee, buyerName, buyerPhone, delivery, cutoff), 1);
      for (const s of seats) {
        changed(this.run('INSERT INTO booking_items VALUES(?,?,?,?)', id, s.id, s.grade, s.price), 1);
        changed(this.run('INSERT INTO current_bookings VALUES(?,?)', s.id, id), 1);
      }
      changed(this.run("INSERT INTO payment_attempts VALUES(?,?,?,?, 'succeeded',?, ?,NULL,?)",
        randomUUID(), hold.id, keyed ? idempotencyKey : 'legacy-checkout', bodyHash, ticketTotal + fee, id, cutoff), 1);
      const totals = this.get('SELECT ticket_count,total FROM booking_totals WHERE id=?', id);
      if (totals.ticket_count !== seats.length || totals.total !== ticketTotal + fee || this.get('SELECT COUNT(*) AS n FROM current_bookings WHERE booking_id=?', id).n !== seats.length) throw new Error('예매 완료 상태 검증에 실패했습니다.');
      return this.booking(id, userId);
    }); } catch (error) {
      if (!keyed || !error.recordable) throw error;
      // The booking transaction has rolled back. A terminal business failure is
      // recorded separately; auth/input/DB failures never become payment history.
      const attempt = this.transaction(() => {
        const previous = this.get('SELECT * FROM payment_attempts WHERE hold_id=? AND request_key=?', holdId, idempotencyKey);
        if (previous) return previous;
        changed(this.run("INSERT INTO payment_attempts VALUES(?,?,?,?,'failed',NULL,NULL,?,?)",
          randomUUID(), holdId, idempotencyKey, bodyHash, error.code, this.now()), 1);
        return this.get('SELECT * FROM payment_attempts WHERE hold_id=? AND request_key=?', holdId, idempotencyKey);
      });
      return replay(attempt);
    }
  }

  booking(id, userId) {
    const b = this.get(`SELECT b.id,b.user_id,b.performance_id,b.hold_id,b.status,b.ticket_total,b.fee,b.total,
      b.buyer_name,b.buyer_phone,b.delivery,b.created_at,b.cancelled_at,p.starts_at,c.title,c.artist,v.name AS venue,c.theme
      FROM booking_totals b JOIN performances p ON p.id=b.performance_id JOIN concerts c ON c.id=p.concert_id
      JOIN venues v ON v.id=p.venue_id WHERE b.id=? AND b.user_id=?`, id, userId);
    fail(b, 404, '예매 내역을 찾을 수 없습니다.');
    return { ...b, seats: this.all(`SELECT s.seat_code AS seat_id,bi.grade_snapshot AS grade,bi.price_snapshot AS price
      FROM booking_items bi JOIN inventory i ON i.id=bi.inventory_id JOIN physical_seats s ON s.id=i.physical_seat_id
      WHERE bi.booking_id=? ORDER BY s.seat_code`, id) };
  }
  bookings(userId) {
    return this.all(`SELECT b.id FROM holds h JOIN bookings b ON b.hold_id=h.id
      WHERE h.user_id=? ORDER BY b.created_at DESC,b.id`, userId).map(b => this.booking(b.id, userId));
  }
  cancel(userId, id) {
    return this.transaction(() => {
      const b = this.booking(id, userId);
      if (b.status === 'cancelled') return b;
      const cutoff = this.now();
      this.openPerformance(b.performance_id, cutoff);
      changed(this.run('DELETE FROM current_bookings WHERE booking_id=?', id), b.seats.length);
      changed(this.run("UPDATE bookings SET status='cancelled',cancelled_at=? WHERE id=? AND status='confirmed'", cutoff, id), 1);
      return this.booking(id, userId);
    });
  }

  blockSeats(userId, performanceId, ids, blocked) {
    this.requireAdmin(userId);
    fail(Array.isArray(ids) && ids.length > 0 && ids.length <= 96 && new Set(ids).size === ids.length && ids.every(id => typeof id === 'string') && typeof blocked === 'boolean', 400, '좌석과 차단 상태를 확인해 주세요.');
    return this.transaction(() => {
      const cutoff = this.now();
      this.expire(cutoff);
      this.openPerformance(performanceId, cutoff);
      const seats = ids.map(id => this.seat(performanceId, id));
      fail(seats.every(s => s && !s.hold_id && !s.booking_id), 409, '선점 또는 예매된 좌석은 변경할 수 없습니다.');
      for (const s of seats) changed(this.run(`UPDATE inventory SET blocked=? WHERE id=?
        AND NOT EXISTS(SELECT 1 FROM current_holds WHERE inventory_id=inventory.id)
        AND NOT EXISTS(SELECT 1 FROM current_bookings WHERE inventory_id=inventory.id)`, Number(blocked), s.id), 1);
      this.recordAudit(userId, blocked ? 'block' : 'unblock', { performanceId, ids }, cutoff);
      return { updated: ids.length };
    });
  }

  insertConcert(c, dates, basePrice) {
    const venueId = randomUUID();
    this.run('INSERT INTO venues VALUES(?,?,NULL)', venueId, c.venue.trim());
    this.run('INSERT INTO concerts(id,title,artist,description,theme,duration,age,created_at,booking_opens_at) VALUES(?,?,?,?,?,?,?,?,?)',
      c.id, c.title.trim(), c.artist.trim(), c.description.trim(), c.theme, c.duration, c.age, this.now(), c.bookingOpensAt ?? null);
    const seats = [];
    for (let r = 0; r < 8; r++) for (let n = 1; n <= 12; n++) {
      const row = String.fromCharCode(65 + r), code = `${row}-${String(n).padStart(2, '0')}`, id = randomUUID();
      this.run('INSERT INTO physical_seats VALUES(?,?,?,?,?)', id, venueId, code, row, n);
      seats.push({ id, grade: r < 2 ? 'VIP' : r < 5 ? 'R' : 'S' });
    }
    for (const starts of dates) {
      const pid = randomUUID();
      this.run('INSERT INTO performances VALUES(?,?,?,?)', pid, c.id, venueId, starts);
      for (const s of seats) this.run('INSERT INTO inventory VALUES(?,?,?,?,?,0)', randomUUID(), pid, s.id, s.grade, basePrice + (s.grade === 'VIP' ? 40000 : s.grade === 'R' ? 20000 : 0));
    }
  }

  recordAudit(userId, action, detail, at = this.now()) {
    this.run('INSERT INTO audit_events(user_id,action,detail,created_at) VALUES(?,?,?,?)', userId, action, JSON.stringify(detail), at);
  }

  adminSummary(userId) {
    this.requireAdmin(userId);
    return this.readSnapshot(() => {
      const cutoff = this.now();
      return {
        stats: this.get("SELECT COUNT(*) AS bookings,COALESCE(SUM(total),0) AS revenue FROM booking_totals WHERE status='confirmed'"),
        users: this.get('SELECT COUNT(*) AS count FROM users WHERE password_hash<>?', WITHDRAWN_PASSWORD_HASH).count,
        performances: this.all(`SELECT p.id,p.starts_at,c.title,COUNT(*) AS total,SUM(i.blocked) AS blocked,
          COUNT(cb.inventory_id) AS booked,COUNT(ch.inventory_id) AS held FROM performances p
          JOIN concerts c ON c.id=p.concert_id JOIN inventory i ON i.performance_id=p.id
          LEFT JOIN current_holds ch ON ch.inventory_id=i.id AND EXISTS(SELECT 1 FROM holds h
            WHERE h.id=ch.hold_id AND h.status='active' AND h.expires_at>?)
          LEFT JOIN current_bookings cb ON cb.inventory_id=i.id
          GROUP BY p.id ORDER BY p.starts_at`, cutoff),
        audit: this.all('SELECT a.action,a.detail,a.created_at,u.name FROM audit_events a JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 15')
      };
    });
  }
}
