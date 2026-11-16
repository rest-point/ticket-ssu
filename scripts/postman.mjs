import { createRequire } from 'node:module';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server.mjs';
import { validateModel } from '../db/model.mjs';
import { checkCollection } from '../postman/build.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../postman/runner/package.json', import.meta.url));
export async function runPostmanCollection({ collection, environment, folder }) {
  let newman;
  try { newman = require('newman'); } catch { throw new Error('POSTMAN_INSTALL_REQUIRED: npm ci --prefix postman/runner --ignore-scripts'); }
  const flatten = items => items.flatMap(item => item.item ? flatten(item.item) : [item]);
  const steps = flatten(collection.item);
  const names = new Set(steps.map(step => step.name));
  const assertions = new Set(steps.flatMap(item => (item.event ?? []).flatMap(event => [...event.script.exec.join('\n').matchAll(/verify\('([^']+)'/g)].map(match => match[1]))));
  return new Promise((resolveRun, reject) => {
    newman.run({ collection, environment, ...(folder ? { folder } : {}), reporters: [], bail: true, ignoreRedirects: true,
      timeout: 60000, timeoutRequest: 5000, timeoutScript: 5000, iterationCount: 1 }, (error, summary) => {
      if (error || !summary) { reject(new Error('POSTMAN_RUN_FAILED')); return; }
      const executions = summary.run.executions.map(row => ({ name: names.has(row.item.name) ? row.item.name : 'unknown-step', status: row.response?.code ?? null }));
      resolveRun({ passed: summary.run.failures.length === 0 && summary.run.stats.requests.failed === 0 && executions.length > 0,
        requests: executions.length, assertions: summary.run.stats.assertions.total, assertionFailures: summary.run.stats.assertions.failed,
        failures: summary.run.failures.map(row => ({ step: names.has(row.source?.name) ? row.source.name : 'collection-script',
          category: row.error?.test ? 'assertion' : 'runtime', ...(assertions.has(row.error?.test) ? { assertion: row.error.test } : {}) })), executions });
    });
  });
}

export async function runIsolatedPostman(schema) {
  if (!['legacy', 'model'].includes(schema) || process.env.NODE_ENV === 'production' || process.env.PUBLIC_ORIGIN || process.env.PROXY_TOKEN) throw new Error('POSTMAN_LOCAL_ENV_REFUSED');
  const { currentOperations } = await checkCollection();
  const collection = JSON.parse(await readFile(resolve(root, 'postman/ticket-ssu.postman_collection.json'), 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'ticket-ssu-postman-'));
  let app, report;
  try {
    const nonce = randomBytes(6).toString('hex'), password = () => randomBytes(24).toString('base64url');
    const memberEmail = `member-${nonce}@example.test`, memberPassword = password();
    const adminEmail = `operator-${nonce}@example.test`, adminPassword = password();
    app = await createApp({ dbPath: join(directory, 'fixture.sqlite'), schema, demo: false, secureCookies: false,
      adminEmail, adminPassword, boundaryOptions: {}, queueOptions: { admitPerSecond: 1000 },
      limitOptions: { ipBurst: 120, ipPerSecond: 30, authAttempts: 30 } });
    await app.store.register({ email: memberEmail, password: memberPassword, name: 'CLI검증회원', phone: '01000000000', terms: true, ageConfirmed: true });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const values = { baseUrl: `http://127.0.0.1:${app.server.address().port}`, mode: 'local', allowWrite: 'dedicated-demo',
      memberEmail, memberPassword, adminEmail, adminPassword, otherEmail: `other-${nonce}@example.test`, otherPassword: password(),
      performanceId: app.store.concerts()[0].performances[0].id, seatId: 'A-01' };
    report = { schema, ...await runPostmanCollection({ collection, environment: { values: Object.entries(values).map(([key, value]) => ({ key, value, enabled: true })) } }) };
    const covered = new Set(report.executions.filter(row => row.status < 400 && row.status !== null).map(row => JSON.parse(collection.variable.find(value => value.key === 'contracts').value)[row.name]?.id));
    const confirmed = app.store.get("SELECT COUNT(*) AS n FROM bookings WHERE status='confirmed'").n;
    const activeHolds = app.store.get("SELECT COUNT(*) AS n FROM holds WHERE status='active'").n;
    const sessions = app.store.get('SELECT COUNT(*) AS n FROM sessions').n;
    if (schema === 'model') validateModel(app.store.db);
    Object.assign(report, { currentOperationsCovered: covered.size, confirmedBookings: confirmed, activeHolds, sessions,
      temporaryDatabaseOnly: true, externalNetworkVerified: false });
    report.passed &&= covered.size === currentOperations && confirmed === 0 && activeHolds === 0 && sessions === 0;
  } finally {
    await app?.shutdown(1000);
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep + 'ticket-ssu-postman-')) throw new Error('POSTMAN_CLEANUP_PATH');
    await rm(directory, { recursive: true, force: true });
  }
  return { ...report, cleanupPassed: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const reports = [];
    for (const schema of ['legacy', 'model']) reports.push(await runIsolatedPostman(schema));
    console.log(JSON.stringify({ passed: reports.every(report => report.passed), reports: reports.map(({ executions, ...report }) => report) }, null, 2));
    if (reports.some(report => !report.passed)) process.exitCode = 1;
  } catch { console.error('Postman 로컬 검증 실패: 전용 도구 설치·컬렉션 검사·로컬 연결을 확인해 주세요.'); process.exitCode = 1; }
}
