import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { PerformanceQueue, QUEUE_DEFAULTS, queueOptionsFromEnv } from '../lib/performance-queue.mjs';
import { createApp } from '../server.mjs';

const initialWall = 1800000000000;
function fixture(t, options = {}) {
  let mono = 0, wall = initialWall;
  const queue = new PerformanceQueue({ now: () => wall, monotonic: () => mono, ...options });
  t.after(() => queue.close());
  return { queue, advance: ms => { mono += ms; wall += ms; },
    wall: value => { wall = value; }, mono: value => { mono = value; } };
}

test('FIFO는 중복 진입·상태 재조회에도 entry와 순서를 유지하며 앞선 회원부터 입장시킨다', t => {
  const f = fixture(t, { activeLimit: 1, admitPerSecond: 2 }), q = f.queue;
  const first = q.enter('show', 'a'), second = q.enter('show', 'b'), third = q.enter('show', 'c');
  assert.equal(first.state, 'admitted');
  assert.equal(first.position, 0);
  assert.equal(second.position, 1);
  assert.equal(second.ahead, 0);
  assert.equal(third.position, 2);
  assert.equal(third.ahead, 1);
  assert.equal(third.estimated_wait_ms, null);
  f.advance(100);
  const reconnect = q.enter('show', 'b');
  assert.equal(reconnect.entry_id, second.entry_id);
  assert.equal(reconnect.sequence, second.sequence);
  assert.equal(reconnect.position, 1);
  assert.equal(q.status('show', 'c').entry_id, third.entry_id);
  q.leave('show', 'a');
  assert.equal(q.status('show', 'b').state, 'admitted');
  assert.equal(q.status('show', 'c').position, 1);
  q.leave('show', 'b');
  assert.equal(q.status('show', 'c').state, 'waiting', 'capacity alone must not bypass the rolling rate');
  f.advance(900);
  assert.equal(q.status('show', 'c').state, 'admitted');
  assert.deepEqual(q.stats(), { performances: 1, entries: 1, waiting: 0, admitted: 1 });
});

test('최근 1초 입장률은 경계 직전의 요청·반복 tick으로 늘어나지 않는다', t => {
  const f = fixture(t, { activeLimit: 10, admitPerSecond: 2 }), q = f.queue;
  const arrivals = ['a', 'b', 'c', 'd', 'e'].map(u => q.enter('show', u));
  assert.deepEqual(arrivals.map(e => e.state), ['admitted', 'admitted', 'waiting', 'waiting', 'waiting']);
  f.advance(999);
  for (let i = 0; i < 10; i++) q.tick();
  assert.equal(q.stats().admitted, 2);
  assert.equal(q.status('show', 'c').state, 'waiting');
  f.advance(1);
  q.tick();
  assert.equal(q.stats().admitted, 4);
  assert.equal(q.status('show', 'e').state, 'waiting');
  f.advance(999);
  q.tick();
  assert.equal(q.stats().admitted, 4);
  f.advance(1);
  q.tick();
  assert.equal(q.stats().admitted, 5);
});

test('빈 큐에 재진입해도 소비한 입장률을 초기화하지 않고 순번도 재사용하지 않는다', t => {
  const f = fixture(t, { activeLimit: 1, admitPerSecond: 1 }), q = f.queue;
  const first = q.enter('show', 'a');
  q.leave('show', 'a');
  assert.equal(q.stats().entries, 0);
  const second = q.enter('show', 'b');
  assert.equal(second.state, 'waiting');
  assert.ok(second.sequence > first.sequence);
  q.leave('show', 'b');
  f.advance(1000);
  q.tick();
  assert.equal(q.stats().performances, 0);
  const next = q.enter('show', 'a');
  assert.equal(next.state, 'admitted');
  assert.ok(next.sequence > second.sequence);
  assert.notEqual(next.entry_id, first.entry_id);
});

test('대기 중 본인의 heartbeat만 비활성 기한을 갱신하고 만료 후 진입은 맨 뒤다', t => {
  const f = fixture(t, { activeLimit: 1, admitPerSecond: 10, waitIdleMs: 1000, admissionMs: 100000 }), q = f.queue;
  q.enter('show', 'a');
  const previous = q.enter('show', 'b');
  q.enter('show', 'c');
  f.advance(900);
  assert.equal(q.status('show', 'b').entry_expires_at, initialWall + 1900);
  f.advance(100);
  q.tick();
  assert.throws(() => q.status('show', 'c'), { status: 404 });
  assert.equal(q.status('show', 'b').position, 1); // Refresh b to t=2000.
  const d = q.enter('show', 'd');
  f.advance(1000);
  assert.throws(() => q.status('show', 'b'), { status: 404 });
  assert.throws(() => q.status('show', 'd'), { status: 404 });
  q.enter('show', 'e');
  const after = q.enter('show', 'b');
  assert.notEqual(after.entry_id, previous.entry_id);
  assert.ok(after.sequence > d.sequence);
  assert.equal(after.position, 2);
});

test('활성 입장 정원은 heartbeat로 연장하지 않으며 정확한 만료 시각에 반환한다', t => {
  const f = fixture(t, { activeLimit: 1, admitPerSecond: 10, admissionMs: 1000 }), q = f.queue;
  const first = q.enter('show', 'a');
  const waiter = q.enter('show', 'b');
  assert.equal(first.entry_expires_at, initialWall + 1000);
  f.advance(999);
  assert.equal(q.enter('show', 'a').entry_expires_at, first.entry_expires_at);
  assert.equal(q.status('show', 'a').entry_expires_at, first.entry_expires_at);
  f.advance(1);
  q.tick();
  assert.throws(() => q.status('show', 'a'), { status: 404 });
  assert.equal(q.status('show', 'b').entry_id, waiter.entry_id);
  assert.equal(q.status('show', 'b').state, 'admitted');
  assert.equal(q.stats().admitted, 1);
});

test('회차별 정원·입장률·동일 회원 항목은 서로 독립적이다', t => {
  const f = fixture(t, { activeLimit: 1, admitPerSecond: 1 }), q = f.queue;
  assert.equal(q.enter('p1', 'same-user').state, 'admitted');
  assert.equal(q.enter('p2', 'same-user').state, 'admitted');
  const one = q.enter('p1', 'waiter'), two = q.enter('p2', 'waiter');
  assert.notEqual(one.entry_id, two.entry_id);
  q.leave('p1', 'same-user');
  f.advance(1000);
  q.tick();
  assert.equal(q.status('p1', 'waiter').state, 'admitted');
  assert.equal(q.status('p2', 'waiter').state, 'waiting');
  q.leave('p2', 'same-user');
  assert.equal(q.status('p2', 'waiter').state, 'admitted');
});

test('연속 신규/중복 호출은 같은 회원을 한 번만 세고 신규 회원도 기존 대기자를 앞서지 않는다', t => {
  const f = fixture(t, { activeLimit: 3, admitPerSecond: 2 }), q = f.queue;
  const arrivals = Array.from({ length: 100 }, (_, i) => q.enter('show', `u${i}`));
  for (let i = 0; i < 50; i++) assert.equal(q.enter('show', 'u0').entry_id, arrivals[0].entry_id);
  assert.deepEqual(q.stats(), { performances: 1, entries: 100, waiting: 98, admitted: 2 });
  assert.equal(new Set(arrivals.map(e => e.entry_id)).size, 100);
  assert.equal(new Set(arrivals.map(e => e.sequence)).size, 100);
  f.advance(1000);
  q.tick();
  assert.equal(q.stats().admitted, 3);
  assert.equal(q.status('show', 'u2').state, 'admitted');
  q.leave('show', 'u0');
  assert.equal(q.status('show', 'u3').state, 'admitted');
  const newcomer = q.enter('show', 'newcomer');
  assert.equal(q.stats().admitted, 3);
  assert.equal(newcomer.state, 'waiting');
  assert.equal(q.status('show', 'u4').position, 1);
  assert.equal(newcomer.position, 97);
});

test('전체·회차별 대기 상한에서 신규 진입만 거부하고 기존 회원 재접속은 보존한다', t => {
  const f = fixture(t, { activeLimit: 1, admitPerSecond: 1, maxWaiting: 1, maxTotal: 2 }), q = f.queue;
  q.enter('show', 'a');
  const second = q.enter('show', 'b');
  for (const [pid, uid] of [['show', 'c'], ['other', 'c']]) assert.throws(() => q.enter(pid, uid), e => e.status === 429 && e.retryAfter === '1');
  assert.equal(q.enter('show', 'b').entry_id, second.entry_id);
  assert.deepEqual(q.stats(), { performances: 1, entries: 2, waiting: 1, admitted: 1 });
  q.leave('show', 'b');
  assert.equal(q.enter('show', 'c').position, 1);
  assert.equal(q.stats().entries, 2);
});

test('회차 버킷 상한은 빈 큐의 최근 입장 이력까지 포함하고 만료 후 회수한다', t => {
  const f = fixture(t, { activeLimit: 1, admitPerSecond: 1, maxPerformances: 1 }), q = f.queue;
  q.enter('p1', 'a');
  q.leave('p1', 'a');
  assert.throws(() => q.enter('p2', 'a'), { status: 429 });
  f.advance(999);
  assert.throws(() => q.enter('p2', 'a'), { status: 429 });
  f.advance(1);
  assert.equal(q.enter('p2', 'a').state, 'admitted');
  assert.equal(q.stats().performances, 1);
});

test('전체 상한에 닿아도 다른 회차의 만료 항목을 회수한 뒤 새 진입을 허용한다', t => {
  const f = fixture(t, { activeLimit: 1, admitPerSecond: 1, maxTotal: 2, admissionMs: 50 }), q = f.queue;
  q.enter('p1', 'a');
  q.enter('p2', 'b');
  f.advance(50);
  assert.equal(q.enter('p3', 'c').state, 'admitted');
  assert.equal(q.stats().entries, 1);
  assert.throws(() => q.status('p1', 'a'), { status: 404 });
});

test('시스템 시각 보정은 입장률/만료를 바꾸지 않고 응답 객체 수정도 내부 상태에 영향이 없다', t => {
  const f = fixture(t, { activeLimit: 1, admitPerSecond: 1, admissionMs: 5000 }), q = f.queue;
  const first = q.enter('show', 'a');
  first.state = 'waiting'; first.sequence = -1;
  f.wall(initialWall + 3600000);
  f.mono(999);
  assert.equal(q.status('show', 'a').state, 'admitted');
  assert.ok(q.status('show', 'a').sequence > 0);
  q.leave('show', 'a');
  assert.equal(q.enter('show', 'b').state, 'waiting');
  f.wall(initialWall - 3600000);
  f.mono(0); // Defend against a faulty injected clock regressing too.
  assert.equal(q.status('show', 'b').state, 'waiting');
  f.mono(1000);
  assert.equal(q.status('show', 'b').state, 'admitted');
});

test('반복 이탈·없는 상태·잘못된 입력은 정원 중복 반환이나 유령 항목을 만들지 않는다', t => {
  const { queue: q } = fixture(t);
  for (const value of ['', ' ', 'x'.repeat(129), null, 1]) assert.throws(() => q.enter('show', value), { status: 400 });
  assert.throws(() => q.status('unknown', 'a'), { status: 404 });
  assert.deepEqual(q.leave('unknown', 'a'), { ok: true });
  q.enter('show', 'a');
  q.leave('show', 'a');
  q.leave('show', 'a');
  assert.equal(q.stats().entries, 0);
  assert.equal(q.stats().admitted, 0);
  assert.equal(q.stats().waiting, 0);
});

test('설정은 정수·상한·알려진 키를 검사하고 종료/새 인스턴스는 상태와 epoch를 구분한다', t => {
  const { queue: q } = fixture(t);
  assert.deepEqual(q.config, QUEUE_DEFAULTS);
  for (const options of [{ activeLimit: 0 }, { admitPerSecond: 1.5 }, { maxTotal: 100001 }, { maxWaiting: NaN }, { waitIdleMs: -1 }, { admissionMs: Infinity }, { unknown: 1 }]) assert.throws(() => new PerformanceQueue(options));
  assert.throws(() => { q.config.activeLimit = 100; }, TypeError);
  assert.throws(() => { q.config = {}; }, TypeError);
  assert.deepEqual(queueOptionsFromEnv({ QUEUE_ACTIVE_LIMIT: '2', QUEUE_MAX_TOTAL: '9' }), { activeLimit: 2, maxTotal: 9 });
  for (const raw of ['', '0', ' 2', '1e3', '2.5', '-1']) assert.throws(() => queueOptionsFromEnv({ QUEUE_ACTIVE_LIMIT: raw }));
  q.enter('show', 'a');
  q.close(); q.close();
  assert.equal(q.stats().entries, 0);
  assert.throws(() => q.enter('show', 'a'), { status: 503 });
  const next = fixture(t).queue;
  assert.notEqual(next.restartEpoch, q.restartEpoch);
  assert.throws(() => next.status('show', 'a'), { status: 404 });
});

for (const schema of ['legacy', 'model']) {
  test(`[${schema}] 앱의 내부 큐 타이머는 DB를 쓰지 않고 대기자를 승격하며 종료 시 정리된다`, async t => {
    let mono = 0, closed = false;
    const { server, store, queue } = await createApp({ dbPath: ':memory:', schema, now: () => initialWall,
      queueOptions: { activeLimit: 1, admitPerSecond: 1, monotonic: () => mono } });
    const close = async () => { if (!closed) { closed = true; await new Promise(ok => server.close(ok)); } };
    t.after(close);
    const pid = store.concerts()[0].performances[0].id;
    const [a, b] = store.all('SELECT id FROM users ORDER BY id');
    const changes = store.get('SELECT total_changes() AS n').n;
    const prepare = store.db.prepare;
    let calls = 0;
    store.db.prepare = function (...args) { calls++; return prepare.apply(this, args); };
    try {
      queue.enter(pid, a.id);
      queue.enter(pid, b.id);
      queue.leave(pid, a.id);
      mono = 1000;
      for (let i = 0; i < 10 && !queue.stats().admitted; i++) await delay(30);
      assert.equal(queue.stats().admitted, 1, 'background tick must promote without a status poll');
      assert.equal(queue.status(pid, b.id).state, 'admitted');
      assert.equal(calls, 0, 'core and tick must not query SQLite');
    } finally { store.db.prepare = prepare; }
    assert.equal(store.get('SELECT total_changes() AS n').n, changes);
    assert.equal(store.get('SELECT COUNT(*) AS n FROM holds').n, 0);
    await close();
    assert.equal(queue.stats().entries, 0);
    assert.throws(() => queue.enter(pid, a.id), { status: 503 });
    await delay(120); // A leaked interval would call the closed queue and fail this test.
  });
}

test('잘못된 앱 큐 설정은 DB 파일을 생성하기 전에 거부한다', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'temp-queue-config-'));
  t.after(async () => {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep + 'temp-queue-config-'));
    await rm(dir, { recursive: true });
  });
  const path = join(dir, 'never-created.sqlite');
  await assert.rejects(createApp({ dbPath: path, queueOptions: { activeLimit: 0 } }), /activeLimit/);
  await assert.rejects(access(path), { code: 'ENOENT' });
});
