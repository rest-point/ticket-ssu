import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server.mjs';

for (const schema of ['legacy', 'model']) {
  test(`[${schema}] 회원 제한은 새 예매만 막고 선점·큐를 정리하며 해제할 수 있다`, async t => {
    const app = await createApp({ dbPath: ':memory:', schema, demo: true, queueOptions: { admitPerSecond: 1000 } });
    const { store, server } = app;
    t.after(() => app.shutdown(1000));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const member = store.get("SELECT id,email FROM users WHERE role='user'");
    const admin = store.get("SELECT id,email FROM users WHERE role='admin'");
    const headersFor = id => {
      const { token, csrf } = store.createSession(id);
      return { cookie: `ticket_ssu_session=${token}`, 'X-CSRF-Token': csrf };
    };
    const adminHeaders = headersFor(admin.id), memberHeaders = headersFor(member.id);
    const alternateSession = headersFor(member.id);
    const send = async (method, path, headers = {}, body) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined
      });
      return { status: response.status, data: await response.json() };
    };
    const [p, otherPerformance] = store.concerts()[0].performances;
    const queue = `/api/v1/performances/${p.id}/queue`;
    const holdPath = `/api/performances/${p.id}/hold`;
    const changePath = '/api/admin/member-restrictions', lookupPath = `${changePath}/lookup`;
    const payload = holdId => ({ holdId, buyerName: '테스트 회원', buyerPhone: '01000000000', delivery: 'mobile', agreed: true, paymentMethod: 'demo' });
    const original = store.checkout(member.id, payload(store.setHold(member.id, p.id, ['A-01']).hold.id));
    const beforeRestriction = await send('GET', '/api/bookings', alternateSession);
    assert.equal(beforeRestriction.data.bookings[0].id, original.id);
    const pending = store.setHold(member.id, p.id, ['A-02']).hold;
    store.setHold(member.id, otherPerformance.id, ['A-03']);
    const unrelated = store.setHold(admin.id, p.id, ['A-04']).hold;
    const entered = await send('POST', queue, memberHeaders, {});
    assert.equal(entered.status, 200);
    const admissionHeaders = { ...memberHeaders, 'X-Admission-Token': entered.data.admission_token };

    assert.equal((await send('POST', lookupPath, memberHeaders, { email: member.email })).status, 403);
    assert.equal((await send('POST', lookupPath, adminHeaders, { email: admin.email })).status, 404);
    const initial = await send('POST', lookupPath, adminHeaders, { email: member.email.toUpperCase() });
    assert.equal(initial.data.member.revision, 0);
    const restrict = { member_id: member.id, revision: 0, restricted: true, reason: '테스트 운영 정책 위반' };
    assert.equal((await send('PUT', changePath, {}, restrict)).status, 401);
    assert.equal((await send('PUT', changePath, memberHeaders, restrict)).status, 403);
    assert.equal((await send('PUT', changePath, { cookie: adminHeaders.cookie }, restrict)).status, 403);
    assert.equal((await send('PUT', changePath, adminHeaders, { ...restrict, member_id: admin.id })).status, 404);
    assert.equal((await send('PUT', changePath, adminHeaders, { ...restrict, reason: ' ' })).status, 400);

    const applied = await send('PUT', changePath, adminHeaders, restrict);
    assert.equal(applied.status, 200);
    assert.equal(applied.data.member.restricted, true);
    assert.deepEqual(await send('PUT', changePath, adminHeaders, restrict), applied);
    assert.equal(app.queue.stats().entries, 0);
    assert.equal(store.liveHolds(member.id).length, 0);
    assert.equal(store.seatMap(p.id).seats.find(s => s.id === 'A-02').state, 'available');
    assert.equal(store.liveHolds(admin.id)[0].id, unrelated.id);

    for (const attempt of [await send('GET', queue, alternateSession), await send('POST', queue, memberHeaders, {})]) {
      assert.equal(attempt.status, 403);
      assert.equal(attempt.data.code, 'BOOKING_RESTRICTED');
      assert.doesNotMatch(JSON.stringify(attempt.data), /테스트 운영 정책 위반/);
    }
    assert.equal((await send('PUT', holdPath, admissionHeaders, { seatIds: ['A-02'] })).status, 403);
    assert.equal((await send('POST', '/api/bookings', admissionHeaders, payload(pending.id))).status, 403);
    assert.equal((await send('POST', '/api/bookings', memberHeaders, payload(original.hold_id))).data.booking.id, original.id);
    assert.deepEqual(await send('GET', '/api/bookings', alternateSession), beforeRestriction);
    assert.equal((await send('POST', `/api/bookings/${original.id}/cancel`, memberHeaders)).status, 200);

    const restore = { ...restrict, restricted: false, revision: 1, reason: '검토 완료' };
    assert.equal((await send('PUT', changePath, adminHeaders, { ...restore, revision: 0 })).status, 409);
    const restored = await send('PUT', changePath, adminHeaders, restore);
    assert.equal(restored.data.member.restricted, false);
    assert.equal((await send('PUT', changePath, adminHeaders, restrict)).status, 409);
    assert.equal((await send('GET', queue, memberHeaders)).status, 404);
    assert.equal((await send('POST', queue, memberHeaders, {})).status, 200);
    assert.deepEqual(store.adminSummary(admin.id).audit.filter(a => a.action.endsWith('-member')).map(a => a.action), ['restore-member', 'restrict-member']);
  });
}
