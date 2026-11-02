import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestLimiter, limitOptionsFromEnv } from '../lib/request-limiter.mjs';
import { pollDelay } from '../public/polling.mjs';

function fixture(options = {}) {
  let now = 0;
  return { limiter: new RequestLimiter({ monotonic: () => now, ...options }), time: ms => { now = ms; } };
}
test('IP 토큰 버킷은 burst·정확한 충전 경계와 Retry-After를 적용한다', () => {
  const { limiter: l, time } = fixture({ ipBurst: 2, ipPerSecond: 1 });
  l.ip('a'); l.ip('a');
  assert.throws(() => l.ip('a'), e => e.status === 429 && e.retryAfter === '1' && e.code === 'RATE_LIMITED');
  time(999); assert.throws(() => l.ip('a'), { status: 429 });
  time(1000); l.ip('a');
  assert.throws(() => l.ip('a'), { status: 429 });
  l.ip('b');
});
test('회원 버킷은 다른 회원/IP와 분리하고 시계 후퇴가 충전을 늘리지 않는다', () => {
  const { limiter: l, time } = fixture({ userBurst: 1, userPerSecond: 1 });
  l.user('a'); l.user('b'); l.ip('same-ip');
  time(999); assert.throws(() => l.user('a'), { status: 429 });
  time(0); assert.throws(() => l.user('a'), { status: 429 });
  time(1000); l.user('a');
});
test('인증 고정 창의 거부는 종료 시각을 연장하지 않으며 경계에서 초기화한다', () => {
  const { limiter: l, time } = fixture({ authAttempts: 2, authWindowMs: 2000 });
  l.auth('a'); l.auth('a');
  assert.throws(() => l.auth('a'), e => e.retryAfter === '2');
  time(1999); assert.throws(() => l.auth('a'), e => e.retryAfter === '1');
  time(2000); l.auth('a'); l.auth('a');
  assert.throws(() => l.auth('a'), { status: 429 });
});
test('세 종류의 키 상한은 기존 키를 축출하지 않고 안전한 만료 뒤 회수한다', () => {
  const { limiter: l, time } = fixture({ ipBurst: 2, userBurst: 2, maxIps: 1, maxUsers: 1, maxAuthIps: 1, idleMs: 1000, authWindowMs: 1000 });
  l.ip('a'); l.user('a'); l.auth('a');
  for (const method of ['ip', 'user', 'auth']) assert.throws(() => l[method]('b'), e => e.code === 'LIMITER_CAPACITY');
  l.ip('a'); l.user('a');
  assert.deepEqual(l.stats(), { ips: 1, users: 1, authIps: 1 });
  time(1000); l.sweep();
  assert.deepEqual(l.stats(), { ips: 0, users: 0, authIps: 0 });
  l.ip('b'); l.user('b'); l.auth('b');
});
test('짧은 idle TTL로 소진된 버킷을 버려 새 burst를 얻을 수 없다', () => {
  const { limiter: l, time } = fixture({ ipBurst: 2, ipPerSecond: 1, maxIps: 1, idleMs: 1 });
  l.ip('a'); l.ip('a');
  time(1000); l.sweep();
  assert.equal(l.stats().ips, 1, 'one credit is not a fully restored bucket');
  assert.throws(() => l.ip('b'), { status: 429 });
  time(2000); l.sweep(); l.ip('b');
  assert.equal(l.stats().ips, 1);
});
test('거부된 새 키가 많아도 Map 상한과 기존 회원 예산을 유지한다', () => {
  const { limiter: l } = fixture({ maxIps: 64, maxUsers: 64, maxAuthIps: 64 });
  for (let i = 0; i < 64; i++) { l.ip(`i${i}`); l.user(`u${i}`); l.auth(`i${i}`); }
  for (let i = 64; i < 1000; i++) for (const method of ['ip', 'user', 'auth']) assert.throws(() => l[method](`new${i}`), { status: 429 });
  assert.deepEqual(l.stats(), { ips: 64, users: 64, authIps: 64 });
  l.user('u0'); l.close();
  assert.deepEqual(l.stats(), { ips: 0, users: 0, authIps: 0 });
});
test('제한 설정·키·환경변수는 잘못된 값과 임의 옵션을 거부한다', () => {
  for (const options of [{ ipBurst: 0 }, { maxUsers: 100001 }, { userPerSecond: 1.5 }, { idleMs: Infinity }, { extra: 1 }]) assert.throws(() => new RequestLimiter(options));
  const { limiter: l } = fixture();
  for (const key of ['', null, 'x'.repeat(257)]) assert.throws(() => l.ip(key));
  assert.throws(() => { l.config.ipBurst = 1; }, TypeError);
  assert.throws(() => { l.config = {}; }, TypeError);
  assert.deepEqual(limitOptionsFromEnv({ LIMIT_IP_BURST: '2', LIMIT_MAX_USERS: '10' }), { ipBurst: 2, maxUsers: 10 });
  for (const value of ['0', '', ' 2', '2.5', '1e3']) assert.throws(() => limitOptionsFromEnv({ LIMIT_IP_BURST: value }));
});
test('새 limiter는 재시작 시 예산을 새로 만들며 이전 상태를 공유하지 않는다', () => {
  const first = fixture({ ipBurst: 1 }).limiter;
  first.ip('a'); assert.throws(() => first.ip('a'), { status: 429 });
  fixture({ ipBurst: 1 }).limiter.ip('a');
});
test('폴링은 jitter·최대 백오프·서버가 지정한 더 긴 Retry-After를 지킨다', () => {
  assert.equal(pollDelay(0, 0, () => 0), 2700);
  assert.equal(pollDelay(0, 0, () => 1), 3300);
  assert.equal(pollDelay(1, 0, () => 0.5), 6000);
  assert.equal(pollDelay(100, 0, () => 1), 30000);
  assert.equal(pollDelay(2, 60, () => 0), 60000);
  assert.ok(pollDelay(0, NaN) <= 3300);
});
