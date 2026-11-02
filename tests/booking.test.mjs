import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';
import { createApp } from '../server.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
async function fixture(t) {
  let time = Date.now();
  const store = new Store(':memory:', {
    now: () => time,
    holdMs: 1000
  });
  await store.seed();
  t.after(() => store.close());
  const user = await store.authenticate('demo@temp.local', 'TempDemo123!');
  const admin = await store.authenticate('admin@temp.local', 'TempAdmin123!');
  const other = await store.register({
    email: 'other@temp.local',
    name: '다른고객',
    phone: '01099998888',
    password: 'AnotherTest123!',
    terms: true,
    ageConfirmed: true
  });
  const pid = store.concerts()[0].performances[0].id;
  const checkout = (id, hold) => store.checkout(id, {
    holdId: hold.id,
    buyerName: '김고객',
    buyerPhone: '01012345678',
    delivery: 'mobile',
    paymentMethod: 'demo',
    agreed: true,
    total: 1
  });
  return {
    store,
    user,
    other,
    admin,
    pid,
    checkout,
    advance: n => {
      time += n;
    }
  };
}
test('서버 가격으로 결제하고 중복 요청은 동일 예매를 반환한다', async t => {
  const {
    store,
    user,
    pid,
    checkout
  } = await fixture(t);
  const {
    hold
  } = store.setHold(user.id, pid, ['A-01', 'A-02']);
  const b = checkout(user.id, hold);
  assert.equal(b.total, 264000);
  assert.equal(checkout(user.id, hold).id, b.id);
  assert.equal(store.bookings(user.id).length, 1);
  assert.equal(store.seatMap(pid, user.id).seats[0].state, 'booked');
});
test('경합·차단·유효하지 않은 좌석의 묶음 변경은 전체 롤백된다', async t => {
  const {
    store,
    user,
    other,
    admin,
    pid
  } = await fixture(t);
  store.setHold(user.id, pid, ['A-01']);
  store.setHold(other.id, pid, ['A-02']);
  assert.throws(() => store.setHold(user.id, pid, ['A-03', 'A-02']), {
    status: 409
  });
  assert.equal(store.seatMap(pid, user.id).seats[0].state, 'selected');
  assert.equal(store.seatMap(pid, user.id).seats[2].state, 'available');
  assert.throws(() => store.blockSeats(admin.id, pid, ['A-03', 'A-01'], true), {
    status: 409
  });
  assert.equal(store.seatMap(pid).seats[2].state, 'available');
  store.blockSeats(admin.id, pid, ['A-03'], true);
  assert.throws(() => store.setHold(user.id, pid, ['A-03']), {
    status: 409
  });
  assert.throws(() => store.setHold(user.id, pid, ['Z-99']), {
    status: 409
  });
  assert.throws(() => store.blockSeats(user.id, pid, ['A-03'], false), {
    status: 403
  });
});
test('시간 만료 후 좌석은 반환되며 만료된 선점으로 결제할 수 없다', async t => {
  const {
    store,
    user,
    other,
    pid,
    advance,
    checkout
  } = await fixture(t);
  const {
    hold
  } = store.setHold(user.id, pid, ['A-01']);
  advance(500);
  assert.equal(store.setHold(user.id, pid, ['A-01', 'A-02']).hold.expires_at, hold.expires_at);
  advance(501);
  assert.equal(store.seatMap(pid, user.id).seats[0].state, 'available');
  assert.throws(() => checkout(user.id, hold), {
    status: 409
  });
  assert.ok(store.setHold(other.id, pid, ['A-01']).hold);
});
test('회차별 4매 제한, 소유권 검증, 취소 시 재판매가 적용된다', async t => {
  const {
    store,
    user,
    other,
    pid,
    checkout
  } = await fixture(t);
  assert.throws(() => store.setHold(user.id, pid, ['A-01', 'A-01']), {
    status: 400
  });
  const {
    hold
  } = store.setHold(user.id, pid, ['A-01', 'A-02', 'A-03', 'A-04']);
  assert.throws(() => checkout(other.id, hold), {
    status: 404
  });
  const b = checkout(user.id, hold);
  assert.throws(() => store.setHold(user.id, pid, ['B-01']), {
    status: 409
  });
  assert.throws(() => store.cancel(other.id, b.id), {
    status: 404
  });
  assert.equal(store.cancel(user.id, b.id).status, 'cancelled');
  assert.equal(store.cancel(user.id, b.id).status, 'cancelled');
  assert.ok(store.setHold(other.id, pid, ['A-01']).hold);
  assert.equal(store.booking(b.id, user.id).seats.length, 4);
});
test('이메일 정규화·중복 가입과 잘못된 비밀번호를 검사한다', async t => {
  const {
    store
  } = await fixture(t);
  assert.equal((await store.authenticate(' DEMO@TEMP.LOCAL ', 'TempDemo123!')).role, 'user');
  await assert.rejects(store.authenticate('demo@temp.local', 'incorrect'), {
    status: 401
  });
  await assert.rejects(store.register({
    email: 'DEMO@temp.local',
    name: '김고객',
    phone: '01012345678',
    password: 'AnotherTest123!',
    terms: true,
    ageConfirmed: true
  }), {
    status: 409
  });
  await assert.rejects(store.register({
    email: 'new@temp.local',
    name: '김고객',
    phone: '01012345678',
    password: 'AnotherTest123!',
    terms: false,
    ageConfirmed: true
  }), {
    status: 400
  });
});
test('DB 재시작 후 예매와 좌석 상태가 유지된다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temp-ticket-'));
  const dbPath = join(dir, 'persist.sqlite');
  let store;
  try {
    store = new Store(dbPath);
    await store.seed();
    const user = await store.authenticate('demo@temp.local', 'TempDemo123!');
    const pid = store.concerts()[0].performances[0].id;
    const {
      hold
    } = store.setHold(user.id, pid, ['A-01']);
    store.checkout(user.id, {
      holdId: hold.id,
      buyerName: '김고객',
      buyerPhone: '01012345678',
      delivery: 'onsite',
      paymentMethod: 'demo',
      agreed: true
    });
    store.close();
    store = new Store(dbPath);
    assert.equal(store.bookings(user.id).length, 1);
    assert.equal(store.seatMap(pid, user.id).seats[0].state, 'booked');
  } finally {
    store?.close();
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});
test('HTTP에서 쿠키·CSRF·권한·로그아웃·교차 출처를 검사한다', async t => {
  const {
    server
  } = await createApp({
    dbPath: ':memory:'
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email: 'demo@temp.local',
      password: 'TempDemo123!'
    })
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  const cookie = login.headers.get('set-cookie').split(';')[0],
    {
      csrf
    } = await login.json();
  assert.equal((await fetch(base + '/api/admin/summary', {
    headers: {
      cookie
    }
  })).status, 403);
  assert.equal((await fetch(base + '/api/bookings')).status, 401);
  assert.equal((await fetch(base + '/api/auth/logout', {
    method: 'POST',
    headers: {
      cookie
    }
  })).status, 403);
  assert.equal((await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: {
      Origin: 'https://evil.example',
      'Content-Type': 'application/json'
    },
    body: '{}'
  })).status, 403);
  assert.equal((await fetch(base + '/api/auth/logout', {
    method: 'POST',
    headers: {
      cookie,
      'X-CSRF-Token': csrf
    }
  })).status, 200);
  assert.equal((await fetch(base + '/api/bookings', {
    headers: {
      cookie
    }
  })).status, 401);
});
test('서로 다른 DB 연결에서도 동일 좌석은 한 사람만 확보한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'temp-race-')),
    file = join(dir, 'race.sqlite');
  const one = new Store(file);
  let two;
  try {
    await one.seed();
    two = new Store(file);
    const user = await one.authenticate('demo@temp.local', 'TempDemo123!');
    const admin = await one.authenticate('admin@temp.local', 'TempAdmin123!');
    const pid = one.concerts()[0].performances[0].id;
    const results = await Promise.allSettled([Promise.resolve().then(() => one.setHold(user.id, pid, ['A-01'])), Promise.resolve().then(() => two.setHold(admin.id, pid, ['A-01']))]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  } finally {
    two?.close();
    one.close();
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});
test('운영자는 회차와 96개 좌석을 생성하며 입력 오류는 저장하지 않는다', async t => {
  const {
    store,
    user,
    admin
  } = await fixture(t);
  const data = {
    title: '테스트 공연',
    artist: '테스트 밴드',
    venue: '서울 테스트홀',
    description: '검증용 공연',
    basePrice: 50000,
    dates: [new Date(Date.now() + 86400000).toISOString()]
  };
  assert.throws(() => store.createConcert(user.id, data), {
    status: 403
  });
  const initial = store.concerts().length;
  assert.throws(() => store.createConcert(admin.id, {
    ...data,
    dates: ['invalid']
  }), {
    status: 400
  });
  assert.equal(store.concerts().length, initial);
  const {
    id
  } = store.createConcert(admin.id, data);
  const show = store.concerts().find(c => c.id === id),
    map = store.seatMap(show.performances[0].id);
  assert.equal(map.seats.length, 96);
  assert.equal(map.seats.filter(s => s.grade === 'VIP').length, 24);
  assert.equal(map.seats[0].price, 90000);
  assert.equal(store.adminSummary(admin.id).audit[0].action, 'create-concert');
});
test('공연 시작 이후 선점·결제·취소를 서버가 거부한다', async t => {
  const {
    store,
    user,
    other,
    pid,
    advance,
    checkout
  } = await fixture(t);
  const booking = checkout(user.id, store.setHold(user.id, pid, ['A-01']).hold);
  const otherHold = store.setHold(other.id, pid, ['A-02']).hold;
  advance(store.performance(pid).starts_at - Date.now() + 100000);
  assert.throws(() => store.cancel(user.id, booking.id), {
    status: 409
  });
  assert.throws(() => store.setHold(user.id, pid, ['A-03']), {
    status: 409
  });
  assert.throws(() => checkout(other.id, otherHold), {
    status: 409
  });
});
test('만료 경계에서 한 번 읽은 시각을 사용하고 남아 있던 만료 좌석도 반환한다', async t => {
  const {
    store,
    user,
    pid
  } = await fixture(t);
  const {
    hold
  } = store.setHold(user.id, pid, ['A-01']);
  let clockReads = 0;
  store.now = () => hold.expires_at - 1 + clockReads++;
  store.expire();
  assert.equal(clockReads, 1);
  assert.equal(store.get('SELECT status FROM holds WHERE id=?', hold.id).status, 'active');
  assert.equal(store.get('SELECT hold_id FROM seats WHERE performance_id=? AND id=?', pid, 'A-01').hold_id, hold.id);
  store.expire();
  assert.equal(store.get('SELECT status FROM holds WHERE id=?', hold.id).status, 'expired');
  assert.equal(store.get('SELECT hold_id FROM seats WHERE performance_id=? AND id=?', pid, 'A-01').hold_id, null);
  store.run('UPDATE seats SET hold_id=? WHERE performance_id=? AND id=?', hold.id, pid, 'A-01');
  store.expire();
  assert.equal(store.get('SELECT hold_id FROM seats WHERE performance_id=? AND id=?', pid, 'A-01').hold_id, null);
});
test('만료 처리 도중 실패하면 좌석과 선점 상태를 함께 롤백한다', async t => {
  const {
    store,
    user,
    pid,
    advance
  } = await fixture(t);
  const {
    hold
  } = store.setHold(user.id, pid, ['A-01']);
  advance(1001);
  store.db.exec("CREATE TRIGGER reject_expiry BEFORE UPDATE OF status ON holds WHEN NEW.status='expired' BEGIN SELECT RAISE(ABORT,'expiry failure'); END;");
  assert.throws(() => store.expire(), /expiry failure/);
  assert.equal(store.get('SELECT status FROM holds WHERE id=?', hold.id).status, 'active');
  assert.equal(store.get('SELECT hold_id FROM seats WHERE performance_id=? AND id=?', pid, 'A-01').hold_id, hold.id);
  store.db.exec('DROP TRIGGER reject_expiry');
  store.expire();
  assert.equal(store.seatMap(pid).seats[0].state, 'available');
});
test('다른 탭의 선택 변경 후 이전 주문은 거부하고 현재 주문 재시도는 중복 없이 처리한다', async t => {
  const {
    store,
    user,
    pid,
    checkout,
    advance
  } = await fixture(t);
  const first = store.setHold(user.id, pid, ['A-01']).hold;
  advance(100);
  const second = store.setHold(user.id, pid, ['H-12']).hold;
  assert.notEqual(second.id, first.id);
  assert.equal(second.expires_at, first.expires_at);
  assert.throws(() => checkout(user.id, first), {
    status: 409
  });
  assert.equal(store.bookings(user.id).length, 0);
  const booking = checkout(user.id, second);
  assert.equal(booking.total, 92000);
  assert.deepEqual(booking.seats.map(seat => seat.seat_id), ['H-12']);
  assert.equal(checkout(user.id, second).id, booking.id);
  store.cancel(user.id, booking.id);
  assert.equal(checkout(user.id, second).status, 'cancelled');
});
test('초기 데이터 생성을 반복해도 기존 계정·세션·공연·예매를 보존한다', async t => {
  const {
    store,
    user,
    admin,
    pid,
    checkout
  } = await fixture(t);
  const token = store.createSession(user.id).token;
  const booking = checkout(user.id, store.setHold(user.id, pid, ['A-01']).hold);
  const users = store.all('SELECT * FROM users ORDER BY id');
  const concerts = store.all('SELECT * FROM concerts ORDER BY id');
  await store.seed();
  assert.deepEqual(store.all('SELECT * FROM users ORDER BY id'), users);
  assert.deepEqual(store.all('SELECT * FROM concerts ORDER BY id'), concerts);
  assert.equal(store.session(token).user.id, user.id);
  assert.equal(store.booking(booking.id, user.id).status, 'confirmed');
  assert.equal((await store.authenticate('admin@temp.local', 'TempAdmin123!')).id, admin.id);
  assert.equal((await store.authenticate('demo@temp.local', 'TempDemo123!')).id, user.id);
});
