import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { buildTeamCollection, buildTeamEnvironment, checkTeamCollection } from '../team-build.mjs';
import { startPostmanTeamServer } from '../../scripts/postman-team-server.mjs';
import { runPostmanCollection } from '../../scripts/postman.mjs';
import { validateModel } from '../../db/model.mjs';

const set = (env, key, value) => { env.values.find(v => v.key === key).value = value; };
test('사용자 원본의 평면 형식이 현재 명세 전체를 포함한다', async () => {
  assert.deepEqual(await checkTeamCollection(), { currentOperations: 25, requests: 25, folders: 0, status: 'passed' });
});

test('평면 요청의 실제 쿠키·CSRF·입장권 연결과 예매·취소·탈퇴·관리자 기능을 검증한다', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ticket-ssu-team-postman-'));
  const app = await startPostmanTeamServer({ dbPath: join(directory, 'fixture.sqlite'), port: 0, log() {} });
  t.after(async () => {
    await app.shutdown(1000);
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'ticket-ssu-team-postman-'));
    await rm(directory, { recursive: true, force: true });
  });
  const store = app.store, performanceId = store.concerts()[0].performances[0].id;
  const foreign = await store.register({ email: 'existing-member@example.test', password: 'ExistingMember123!', name: '기존회원', phone: '01000000000', terms: true, ageConfirmed: true });
  const hold = store.setHold(foreign.id, performanceId, ['A-01']).hold;
  store.checkout(foreign.id, { holdId: hold.id, buyerName: '기존예매자', buyerPhone: '01000000000', delivery: 'mobile', agreed: true, paymentMethod: 'demo' });
  const original = store.bookings(foreign.id), concertsBefore = store.concerts().length;
  for (let i = 0; i < 2; i++) {
    const environment = buildTeamEnvironment();
    set(environment, 'baseUrl', `http://127.0.0.1:${app.server.address().port}`);
    set(environment, 'email', `flat-${i}@example.test`); set(environment, 'password', 'PostmanFixture123!');
    const opening = i === 0 ? '' : new Date(Date.now() + 3600000).toISOString();
    if (opening) set(environment, 'bookingOpensAt', opening);
    set(environment, 'restrictionEmail', 'existing-member@example.test'); set(environment, 'restrictionReason', '평면 컬렉션 검증');
    const collection = buildTeamCollection(), pick = name => structuredClone(collection.item.find(item => item.name === name));
    // GUI users choose Send order. Only this test arranges the flat requests into a workflow.
    const adminLogin = pick('login'); adminLogin.request.body.raw = JSON.stringify({ email: 'admin@ticket-ssu.local', password: 'TicketSsuAdmin123!' });
    const unblock = pick('seat block'); unblock.request.body.raw = JSON.stringify({ seatIds: ['A-03'], blocked: false });
    const occupant = pick('admin seat occupant');
    occupant.request.url.raw = occupant.request.url.raw.replace('{{seatId}}', 'A-01');
    occupant.request.url.query[0].value = 'A-01';
    const restore = pick('admin member restriction');
    restore.name = 'admin member restriction restore';
    restore.request.body.raw = JSON.stringify({ ...JSON.parse(restore.request.body.raw), restricted: false });
    collection.item = [
      ...['process alive','server ready','login state','signup','login','concert list','seat search','queue enter','queue state',
        'seat preempt','booking confirm','booking list','booking cancel','queue out','logout','login','account delete','login state'].map(pick),
      adminLogin, pick('admin search'), occupant, ...['admin member lookup','admin member restriction'].map(pick), restore,
      ...['concert add','concert list','seat block','seat search'].map(pick), unblock, pick('logout')
    ];
    const report = await runPostmanCollection({ collection, environment });
    assert.equal(report.passed, true, JSON.stringify(report));
    assert.equal(report.requests, collection.item.length); assert.equal(report.assertions, 2 * collection.item.length);
    assert.deepEqual(store.bookings(foreign.id), original);
    assert.equal(store.get('SELECT restricted FROM member_booking_restrictions WHERE member_id=? ORDER BY revision DESC LIMIT 1', foreign.id).restricted, 0);
    assert.equal(store.get("SELECT COUNT(*) AS n FROM bookings WHERE status='confirmed'").n, 1);
    assert.equal(store.get("SELECT COUNT(*) AS n FROM holds WHERE status='active'").n, 0);
    assert.equal(store.get('SELECT COUNT(*) AS n FROM sessions').n, 0);
    assert.equal(store.get('SELECT name FROM users WHERE id=?', foreign.id).name, '기존회원');
    if (opening) assert.ok(store.concerts().some(concert => concert.booking_opens_at === Date.parse(opening)));
    assert.equal(store.concerts().length, concertsBefore + i + 1); validateModel(store.db);
    t.diagnostic(`Flat collection run ${i + 1}: requests=${report.requests}; assertions=${report.assertions}`);
  }
});

test('잘못된 원격 주소는 보내지 않으며 로컬 공개 조회는 관리자 입력 없이 실행한다', async t => {
  const remote = buildTeamEnvironment(); set(remote, 'baseUrl', 'https://unexpected.example.invalid');
  const report = await runPostmanCollection({ collection: buildTeamCollection(), environment: remote });
  assert.equal(report.passed, false); assert.equal(report.requests, 0);
  const app = await startPostmanTeamServer({ dbPath: ':memory:', port: 0, log() {} });
  t.after(() => app.shutdown(1000));
  const local = buildTeamEnvironment(); set(local, 'baseUrl', `http://127.0.0.1:${app.server.address().port}`);
  const collection = buildTeamCollection(); collection.item = [collection.item.find(item => item.name === 'process alive')];
  const result = await runPostmanCollection({ collection, environment: local });
  assert.equal(result.passed, true); assert.equal(result.requests, 1);
});
