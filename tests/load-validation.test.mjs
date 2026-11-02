import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../lib/store.mjs';
import { ModelStore } from '../lib/model-store.mjs';
import { inspectLoadDatabase, validateLoadSelection } from '../load-tests/load-fixture.mjs';

async function fixture(t, schema) {
  const store = new (schema === 'model' ? ModelStore : Store)(':memory:'); t.after(() => store.close());
  await store.seed({ demo: false });
  const member = async () => store.register({ email: `${randomBytes(6).toString('hex')}@example.test`, password: randomBytes(20).toString('base64url'), name: '가상검증', phone: '01000000000', terms: true, ageConfirmed: true });
  const pid = store.concerts()[0].performances[0].id;
  const book = (userId, seats) => { const hold = store.setHold(userId, pid, seats).hold; return store.checkout(userId, { holdId: hold.id, buyerName: '가상검증', buyerPhone: '01000000000', delivery: 'mobile', agreed: true, paymentMethod: 'demo' }); };
  return { store, member, pid, book };
}
test('부하 선택은 production/공개 경계/알 수 없는 스키마와 프로필을 거부한다', () => {
  validateLoadSelection('model', 'race', {});
  for (const args of [['wrong', 'race', {}], ['model', 'unknown', {}], ['model', 'race', { NODE_ENV: 'production' }],
    ['model', 'race', { PUBLIC_ORIGIN: 'https://example.test' }], ['model', 'race', { PROXY_TOKEN: 'configured' }]]) assert.throws(() => validateLoadSelection(...args));
});
for (const schema of ['legacy', 'model']) {
  test(`[${schema}] 부하 후 판정은 확정2매와 활성 선점2매를 합산한다`, async t => {
    const f = await fixture(t, schema), user = await f.member();
    f.book(user.id, ['A-01', 'A-02']); f.store.setHold(user.id, f.pid, ['B-01', 'B-02']);
    const result = inspectLoadDatabase(f.store);
    assert.equal(result.passed, true); assert.equal(result.maxTicketsPerUserPerformance, 4); assert.equal(result.confirmedBookings, 1); assert.equal(result.activeHolds, 1);
  });
}
test('legacy의 현재 좌석 포인터만 정상이어도 중복 확정 이력을 찾아낸다', async t => {
  const f = await fixture(t, 'legacy'), one = await f.member(), two = await f.member();
  f.book(one.id, ['A-01']); const second = f.book(two.id, ['A-02']);
  f.store.run("UPDATE booking_seats SET seat_id='A-01' WHERE booking_id=?", second.id);
  const result = inspectLoadDatabase(f.store);
  assert.equal(result.duplicateCurrentSales, 1); assert.equal(result.passed, false);
});
test('legacy의 숨겨진 회원당 초과 예매를 합산해 실패로 판정한다', async t => {
  const f = await fixture(t, 'legacy'), one = await f.member(), two = await f.member();
  f.book(one.id, ['A-01', 'A-02', 'A-03']); const second = f.book(two.id, ['B-01', 'B-02', 'B-03']);
  f.store.run('UPDATE bookings SET user_id=? WHERE id=?', one.id, second.id);
  const result = inspectLoadDatabase(f.store);
  assert.equal(result.maxTicketsPerUserPerformance, 6); assert.equal(result.passed, false);
});
