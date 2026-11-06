import { randomBytes, scryptSync } from 'node:crypto';
import { modelTransaction } from '../model.mjs';
import { insertRow } from '../migrate.mjs';

// Synthetic data for the standalone target schema, never the existing Store DB.
export function seedDemo(db, { now = Date.now() } = {}) {
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - 30 * 86400000) throw new Error('invalid seed time');
  if (db.prepare('SELECT 1 FROM users UNION ALL SELECT 1 FROM concerts UNION ALL SELECT 1 FROM venues LIMIT 1').get()) throw new Error('seed requires an empty model database');
  const salt = randomBytes(16).toString('hex');
  const password = `${salt}:${scryptSync('ModelDemo123!', salt, 64).toString('hex')}`;
  return modelTransaction(db, () => {
    for (const role of ['user', 'admin']) insertRow(db, 'users', { id: `seed-${role}`, email: `model-${role}@ticket-ssu.local`, name: role === 'admin' ? '가상관리자' : '가상회원', phone: '01012345678', password_hash: password, role, created_at: now });
    insertRow(db, 'concerts', { id: 'seed-concert', title: '가상 모델 검증 공연', artist: '가상 밴드', description: '실제 예매와 무관한 검증용 데이터', theme: 'teal', duration: 120, age: '8세 이상', created_at: now });
    for (const venue of ['north', 'south']) {
      insertRow(db, 'venues', { id: `seed-${venue}`, name: `가상 ${venue} 공연장`, region: null });
      for (let r = 0; r < 8; r++) for (let n = 1; n <= 12; n++) {
        const row = String.fromCharCode(65 + r), code = `${row}-${String(n).padStart(2, '0')}`;
        insertRow(db, 'physical_seats', { id: `${venue}:${code}`, venue_id: `seed-${venue}`, seat_code: code, row_label: row, number: n });
      }
    }
    for (let p = 1; p <= 3; p++) {
      const venue = p === 3 ? 'south' : 'north';
      insertRow(db, 'performances', { id: `seed-performance-${p}`, concert_id: 'seed-concert', venue_id: `seed-${venue}`, starts_at: now + (20 + p) * 86400000 });
      const seats = db.prepare('SELECT * FROM physical_seats WHERE venue_id=? ORDER BY row_label,number').all(`seed-${venue}`);
      for (const s of seats) {
        const grade = s.row_label < 'C' ? 'VIP' : s.row_label < 'F' ? 'R' : 'S';
        insertRow(db, 'inventory', { id: `seed:${p}:${s.seat_code}`, performance_id: `seed-performance-${p}`, physical_seat_id: s.id, grade, price: 50000 + (grade === 'VIP' ? 40000 : grade === 'R' ? 20000 : 0), blocked: 0 });
      }
    }
    return { seeded: true, users: 2, venues: 2, performances: 3, physicalSeats: 192, inventory: 288 };
  });
}
