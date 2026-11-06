import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Store } from '../lib/store.mjs';
import { ModelStore } from '../lib/model-store.mjs';
import { createApp } from '../server.mjs';
import { defaultDatabasePath, isDefaultDatabasePath, DEFAULT_DATABASE_FILENAMES, LEGACY_DEMO_ACCOUNTS, LEGACY_VENUE_NAMES, PUBLIC_DEMO_EMAILS } from '../lib/project-identity.mjs';
import { destinationPath, validateModel } from '../db/model.mjs';
import { tunnelOptionsFromEnv } from '../lib/quick-tunnel.mjs';

const hash = password => {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
};
const order = hold => ({ holdId: hold.id, buyerName: '이력보존회원', buyerPhone: '01012345678', delivery: 'mobile', agreed: true, paymentMethod: 'demo' });
for (const schema of ['legacy', 'model']) {
  const fixture = async t => {
    const store = new (schema === 'model' ? ModelStore : Store)(':memory:');
    t.after(() => store.close()); await store.seed(); return store;
  };
  test(`[${schema}] 기존 이름을 바꿔도 데모 회원 ID·세션·예매/금액은 유지한다`, async t => {
    const store = await fixture(t);
    const user = await store.authenticate('demo@ticket-ssu.local', 'TicketSsuDemo123!');
    const session = store.createSession(user.id);
    const pid = store.concerts()[0].performances[0].id;
    const booking = store.checkout(user.id, order(store.setHold(user.id, pid, ['A-01']).hold));
    for (const old of LEGACY_DEMO_ACCOUNTS) store.run('UPDATE users SET email=?,name=?,password_hash=? WHERE email=?', old.email, old.name, hash(old.password), old.nextEmail);
    const table = schema === 'model' ? 'venues' : 'concerts', column = schema === 'model' ? 'name' : 'venue';
    for (const [old, next] of LEGACY_VENUE_NAMES) store.run(`UPDATE ${table} SET ${column}=? WHERE ${column}=?`, old, next);
    const payment = schema === 'model' ? store.all('SELECT * FROM payment_attempts') : null;
    await store.seed();
    assert.equal((await store.authenticate('demo@ticket-ssu.local', 'TicketSsuDemo123!')).id, user.id);
    assert.equal(store.session(session.token).user.id, user.id);
    assert.equal(store.session(session.token).user.name, '티켓회원');
    assert.deepEqual(store.bookings(user.id)[0], booking);
    for (const old of LEGACY_DEMO_ACCOUNTS) await assert.rejects(store.authenticate(old.email, old.password), e => e.status === 401);
    assert.equal(store.get('SELECT COUNT(*) AS n FROM users').n, 2);
    if (schema === 'model') { assert.deepEqual(store.all('SELECT * FROM payment_attempts'), payment); validateModel(store.db); }
  });
  test(`[${schema}] 이름 변경은 사용자 지정 관리자 암호·이름을 덮어쓰지 않는다`, async t => {
    const store = await fixture(t), old = LEGACY_DEMO_ACCOUNTS[1], customPassword = 'CustomOperatorOnly123!';
    const admin = store.get('SELECT * FROM users WHERE email=?', old.nextEmail), customHash = hash(customPassword);
    store.run('UPDATE users SET email=?,name=?,password_hash=? WHERE id=?', old.email, '담당운영자', customHash, admin.id);
    await store.seed();
    assert.equal((await store.authenticate(old.nextEmail, customPassword)).id, admin.id);
    assert.equal(store.get('SELECT name FROM users WHERE id=?', admin.id).name, '담당운영자');
    assert.equal(store.get('SELECT password_hash FROM users WHERE id=?', admin.id).password_hash, customHash);
    await assert.rejects(store.authenticate(old.nextEmail, old.nextPassword), e => e.status === 401);
  });
  test(`[${schema}] 이전/새 데모 주소 충돌은 계정을 병합하거나 수정하지 않는다`, async t => {
    const store = await fixture(t), old = LEGACY_DEMO_ACCOUNTS[0];
    await store.register({ email: old.email, password: 'CollisionOnly123!', name: '충돌확인회원', phone: '01000000000', terms: true, ageConfirmed: true });
    const before = store.all('SELECT * FROM users ORDER BY id');
    await assert.rejects(store.seed(), e => e.status === 409);
    assert.deepEqual(store.all('SELECT * FROM users ORDER BY id'), before);
  });
}

test('이전 기본 DB가 있으면 빈 DB로 바꾸지 않고 새/이전 기본 경로를 모두 보호한다', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ticket-ssu-identity-'));
  t.after(async () => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep + 'ticket-ssu-identity-')); await rm(dir, { recursive: true }); });
  assert.equal(defaultDatabasePath(dir), resolve(dir, 'data', DEFAULT_DATABASE_FILENAMES[0]));
  const { mkdir } = await import('node:fs/promises'); await mkdir(join(dir, 'data'));
  const old = resolve(dir, 'data', DEFAULT_DATABASE_FILENAMES[1]); await writeFile(old, 'fixture');
  assert.equal(defaultDatabasePath(dir), old);
  const root = fileURLToPath(new URL('../', import.meta.url));
  for (const name of DEFAULT_DATABASE_FILENAMES) {
    const path = resolve(root, 'data', name);
    assert.equal(isDefaultDatabasePath(root, path), true);
    assert.throws(() => destinationPath(path), /protected/);
  }
});

test('공개 터널은 이전/새 기본 DB와 이전/새 공개 데모 관리자를 모두 거부한다', () => {
  const env = { NODE_ENV: 'production', DEMO_MODE: 'false', HOST: '127.0.0.1', PORT: '3000', DB_PATH: 'data/identity-test.sqlite', DB_SCHEMA: 'model',
    TICKET_SSU_ADMIN_EMAIL: 'operator@example.test', TICKET_SSU_ADMIN_PASSWORD: 'OperatorOnly123!' };
  for (const name of DEFAULT_DATABASE_FILENAMES) assert.throws(() => tunnelOptionsFromEnv({ ...env, DB_PATH: `data/${name}` }), /TUNNEL_DB_PROTECTED/);
  for (const email of PUBLIC_DEMO_EMAILS) assert.throws(() => tunnelOptionsFromEnv({ ...env, TICKET_SSU_ADMIN_EMAIL: email }), /TUNNEL_ADMIN_PUBLIC/);
});

test('로컬 로그인은 새 데모 계정과 ticket_ssu_session 쿠키를 사용한다', async t => {
  const app = await createApp({ dbPath: ':memory:', schema: 'model', demo: true, secureCookies: false });
  t.after(() => app.shutdown(100)); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'demo@ticket-ssu.local', password: 'TicketSsuDemo123!' }) });
  assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /^ticket_ssu_session=/);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const session = await (await fetch(base + '/api/session', { headers: { Cookie: cookie } })).json();
  assert.equal(session.user.email, 'demo@ticket-ssu.local');
});
