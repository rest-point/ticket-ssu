import { createApp } from '../server.mjs';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { resolve, join, sep } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { validateModel } from '../db/model.mjs';
import { setTimeout as delay } from 'node:timers/promises';

export const LOAD_PROFILES = ['race', 'ticket-cap', 'queue', 'read-control', 'read-current', 'mixed-default', 'busy'];
export function validateLoadSelection(schema, profile, env = process.env) {
  if (!['legacy', 'model'].includes(schema) || !LOAD_PROFILES.includes(profile) || env.NODE_ENV === 'production' || env.PUBLIC_ORIGIN || env.PROXY_TOKEN) throw new Error('LOAD_LOCAL_SCOPE_REQUIRED');
}
export function inspectLoadDatabase(store) {
  const model = store.schema === 'model';
  const duplicateSales = store.all(model ? `SELECT bi.inventory_id FROM booking_items bi JOIN bookings b ON b.id=bi.booking_id WHERE b.status='confirmed' GROUP BY bi.inventory_id HAVING COUNT(*)>1` :
    `SELECT b.performance_id,bs.seat_id FROM booking_seats bs JOIN bookings b ON b.id=bs.booking_id WHERE b.status='confirmed' GROUP BY b.performance_id,bs.seat_id HAVING COUNT(*)>1`).length;
  const confirmed = model ? `SELECT h.user_id,h.performance_id,COUNT(*) n FROM booking_items bi JOIN bookings b ON b.id=bi.booking_id JOIN holds h ON h.id=b.hold_id WHERE b.status='confirmed' GROUP BY h.user_id,h.performance_id` :
    `SELECT b.user_id,b.performance_id,COUNT(*) n FROM booking_seats bs JOIN bookings b ON b.id=bs.booking_id WHERE b.status='confirmed' GROUP BY b.user_id,b.performance_id`;
  const held = model ? `SELECT h.user_id,h.performance_id,COUNT(*) n FROM current_holds ch JOIN holds h ON h.id=ch.hold_id WHERE h.status='active' AND h.expires_at>? GROUP BY h.user_id,h.performance_id` :
    `SELECT h.user_id,h.performance_id,COUNT(*) n FROM seats s JOIN holds h ON h.id=s.hold_id WHERE h.status='active' AND h.expires_at>? GROUP BY h.user_id,h.performance_id`;
  const quantities = new Map();
  for (const row of [...store.all(confirmed), ...store.all(held, Date.now())]) {
    const key = JSON.stringify([row.user_id, row.performance_id]); quantities.set(key, (quantities.get(key) ?? 0) + row.n);
  }
  const maxTicketsPerUserPerformance = Math.max(0, ...quantities.values());
  const integrity = store.get('PRAGMA integrity_check').integrity_check === 'ok';
  const foreignKeyViolations = store.all('PRAGMA foreign_key_check').length;
  if (model) validateModel(store.db);
  return { duplicateCurrentSales: duplicateSales, maxTicketsPerUserPerformance, integrity, foreignKeyViolations,
    confirmedBookings: store.get("SELECT COUNT(*) AS n FROM bookings WHERE status='confirmed'").n,
    activeHolds: store.get("SELECT COUNT(*) AS n FROM holds WHERE status='active' AND expires_at>?", Date.now()).n,
    passed: duplicateSales === 0 && maxTicketsPerUserPerformance <= 4 && integrity && foreignKeyViolations === 0 };
}
export async function createLoadFixture(schema, profile) {
  validateLoadSelection(schema, profile);
  const directory = await mkdtemp(join(tmpdir(), 'ticket-ssu-k6-'));
  let app;
  const close = async () => {
    await app?.shutdown(1000);
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep + 'ticket-ssu-k6-')) throw new Error('LOAD_CLEANUP_PATH');
    await rm(directory, { recursive: true, force: true });
  };
  try {
    let offset = profile.startsWith('read-') ? -420001 : 0;
    const count = ['race', 'queue'].includes(profile) ? 8 : profile === 'ticket-cap' ? 1 : profile === 'busy' ? 4 : 16;
    const queueOptions = profile === 'queue' ? { activeLimit: 2, admitPerSecond: 2 } : {};
    const limitOptions = profile.startsWith('read-') || ['busy', 'queue'].includes(profile) ? { ipBurst: 240, ipPerSecond: 120 } : {};
    const dbPath = join(directory, 'fixture.sqlite');
    app = await createApp({ dbPath, schema, demo: false, secureCookies: false, now: () => Date.now() + offset,
      adminEmail: `load-operator-${randomBytes(5).toString('hex')}@example.test`, adminPassword: randomBytes(24).toString('base64url'), boundaryOptions: {}, queueOptions, limitOptions });
    const pid = app.store.concerts()[0].performances[0].id, users = [];
    for (let i = 0; i < count; i++) {
      const member = await app.store.register({ email: `load-${randomBytes(6).toString('hex')}@example.test`, password: randomBytes(24).toString('base64url'), name: '가상부하회원', phone: '01000000000', terms: true, ageConfirmed: true });
      const session = app.store.createSession(member.id), seat = `${i < 12 ? 'A' : 'B'}-${String(i % 12 + 1).padStart(2, '0')}`;
      users.push({ userId: member.id, cookie: `ticket_ssu_session=${session.token}`, csrf: session.csrf, seat, price: app.store.seatMap(pid).seats.find(s => s.id === seat).price });
    }
    if (profile.startsWith('read-')) { app.store.setHold(users[0].userId, pid, ['H-12']); offset = 0; }
    if (profile === 'ticket-cap') {
      const hold = app.store.setHold(users[0].userId, pid, ['A-01', 'A-02']).hold;
      app.store.checkout(users[0].userId, { holdId: hold.id, buyerName: '가상부하회원', buyerPhone: '01000000000', delivery: 'mobile', agreed: true, paymentMethod: 'demo' });
    }
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const base = `http://127.0.0.1:${app.server.address().port}`;
    if (['race', 'ticket-cap', 'busy'].includes(profile)) {
      for (const user of users) {
        const response = await fetch(`${base}/api/v1/performances/${pid}/queue`, { method: 'POST', headers: { Cookie: user.cookie, 'X-CSRF-Token': user.csrf, 'Content-Type': 'application/json', Origin: base }, body: '{}' });
        let body = await response.json(); const began = Date.now();
        while (response.status === 200 && body.state === 'waiting' && Date.now() - began < 5000) {
          await delay(250);
          const polled = await fetch(`${base}/api/v1/performances/${pid}/queue`, { headers: { Cookie: user.cookie } });
          if (polled.status !== 200) throw new Error('LOAD_FIXTURE_ADMISSION'); body = await polled.json();
        }
        if (response.status !== 200 || body.state !== 'admitted') throw new Error('LOAD_FIXTURE_ADMISSION'); user.admission = body.admission_token;
      }
    }
    if (profile === 'read-control') { const original = app.store.seatMap.bind(app.store); app.store.seatMap = (...args) => app.store.transaction(() => { app.store.expire(); return original(...args); }); }
    return { app, directory, dbPath, users, queueOptions: app.queue.config, limitOptions: app.limiter.config, close,
      fixture: { scope: 'isolated-new-database', base, profile, performanceId: pid, users: users.map(({ userId, ...user }) => user) } };
  } catch (error) { await close(); throw error; }
}
