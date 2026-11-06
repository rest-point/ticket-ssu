import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { cpus, totalmem, platform, release, arch } from 'node:os';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDatabaseBusy } from '../lib/db-retry.mjs';
import { createLoadFixture, inspectLoadDatabase, LOAD_PROFILES } from './load-fixture.mjs';
import { k6Path, k6Release, verifyK6 } from './k6-tool.mjs';

const rounded = value => Math.round(value * 1000) / 1000;
const quantile = (values, p) => { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return rounded(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]); };
export function observeLoad(app) {
  const counters = { nativeBusyErrors: 0, failedBusyCallMs: 0, immediateTransactions: 0, dmlStatements: 0, maxConcurrentHttpRequests: 0,
    maxQueueWaiting: 0, maxQueueAdmitted: 0, peakRssBytes: process.memoryUsage().rss, peakHeapBytes: process.memoryUsage().heapUsed };
  const beginTimes = [], original = [], statuses = {}; let pending = 0;
  const patch = (target, key, action) => {
    const fn = target[key]; original.push(() => { target[key] = fn; });
    target[key] = function (...args) { const started = performance.now(); action(args);
      try { return fn.apply(this, args); } catch (error) { if (isDatabaseBusy(error)) { counters.nativeBusyErrors++; counters.failedBusyCallMs += performance.now() - started; } throw error; }
      finally { if (key === 'exec' && /^BEGIN IMMEDIATE/.test(args[0])) beginTimes.push(performance.now() - started); }
    };
  };
  patch(app.store.db, 'exec', args => { if (/^BEGIN IMMEDIATE/.test(args[0])) counters.immediateTransactions++; });
  for (const key of ['get', 'all', 'run']) patch(app.store, key, () => { if (key === 'run') counters.dmlStatements++; });
  const onRequest = (_req, res) => {
    pending++; counters.maxConcurrentHttpRequests = Math.max(counters.maxConcurrentHttpRequests, pending);
    res.once('finish', () => { statuses[res.statusCode] = (statuses[res.statusCode] ?? 0) + 1; });
    res.once('close', () => { pending--; });
  };
  app.server.prependListener('request', onRequest);
  const cpu = process.cpuUsage(), baselineMemory = process.memoryUsage(), elu = performance.eventLoopUtilization(), began = performance.now();
  const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
  const sample = () => { const q = app.queue.stats(), m = process.memoryUsage(); counters.maxQueueWaiting = Math.max(counters.maxQueueWaiting, q.waiting); counters.maxQueueAdmitted = Math.max(counters.maxQueueAdmitted, q.admitted); counters.peakRssBytes = Math.max(counters.peakRssBytes, m.rss); counters.peakHeapBytes = Math.max(counters.peakHeapBytes, m.heapUsed); };
  sample(); const timer = setInterval(sample, 100);
  return () => {
    sample(); clearInterval(timer); lag.disable(); for (const restore of original.reverse()) restore(); app.server.off('request', onRequest);
    const elapsedMs = performance.now() - began, usage = process.cpuUsage(cpu), utilization = performance.eventLoopUtilization(elu).utilization;
    return { ...counters, failedBusyCallMs: rounded(counters.failedBusyCallMs), statuses, durationMs: rounded(elapsedMs),
      cpuUserMs: rounded(usage.user / 1000), cpuSystemMs: rounded(usage.system / 1000), cpuPercentOfOneCore: rounded((usage.user + usage.system) / elapsedMs / 10),
      baselineRssBytes: baselineMemory.rss, baselineHeapBytes: baselineMemory.heapUsed, eventLoopUtilization: rounded(utilization),
      eventLoopP95Ms: rounded(lag.percentile(95) / 1e6), eventLoopP99Ms: rounded(lag.percentile(99) / 1e6), eventLoopMaxMs: rounded(lag.max / 1e6),
      beginImmediateP95Ms: quantile(beginTimes, .95), beginImmediateP99Ms: quantile(beginTimes, .99) };
  };
}
async function startLockWorker(dbPath) {
  const worker = new Worker(new URL('./lock-worker.mjs', import.meta.url), { workerData: { dbPath } });
  await once(worker, 'message'); const events = [], began = performance.now();
  worker.on('message', message => { events.push({ type: message.type, elapsedMs: rounded(performance.now() - began) }); });
  worker.on('error', () => { events.push({ type: 'worker-error', elapsedMs: rounded(performance.now() - began) }); });
  const timer = setInterval(() => worker.postMessage('lock'), 2000);
  return { async stop() {
    clearInterval(timer);
    if (worker.threadId === -1) return events;
    worker.postMessage('stop'); let deadline;
    try { await Promise.race([once(worker, 'exit'), new Promise(resolveTimeout => { deadline = setTimeout(async () => { await worker.terminate(); resolveTimeout(); }, 2000); })]); }
    finally { clearTimeout(deadline); }
    return events;
  } };
}
export async function runK6Profile(schema, profile) {
  await verifyK6();
  let fixture, child, observer, locker, report, aborted = false;
  const signal = () => { aborted = true; child?.kill(); };
  for (const name of ['SIGINT', 'SIGTERM']) process.on(name, signal);
  try {
    fixture = await createLoadFixture(schema, profile);
    if (aborted) throw new Error('LOAD_ABORTED');
    const fixturePath = resolve(fixture.directory, 'fixture.json'), summaryPath = resolve(fixture.directory, 'summary.json'), configPath = resolve(fixture.directory, 'k6-config.json');
    await writeFile(fixturePath, JSON.stringify(fixture.fixture), { flag: 'wx' }); await writeFile(configPath, '{}', { flag: 'wx' });
    const env = { TICKET_SSU_K6_FIXTURE: fixturePath, TICKET_SSU_K6_SUMMARY: summaryPath, K6_NO_USAGE_REPORT: 'true', NO_COLOR: '1' };
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
    if (profile === 'busy') locker = await startLockWorker(fixture.dbPath);
    observer = observeLoad(fixture.app);
    child = spawn(k6Path, ['run', '--no-usage-report', '--quiet', '--config', configPath, fileURLToPath(new URL('./k6-scenarios.js', import.meta.url))],
      { env, cwd: fixture.directory, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    // Drain bounded diagnostics; never echo raw URLs, tokens, headers or response bodies.
    let diagnosticBytes = 0; for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { diagnosticBytes += value.length; });
    const deadline = setTimeout(() => child.kill(), 75000);
    let code;
    try { [code] = await once(child, 'close'); } finally { clearTimeout(deadline); }
    const telemetry = observer(); observer = undefined;
    const lockEvents = locker ? await locker.stop() : []; locker = undefined;
    const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
    const metrics = Object.fromEntries(Object.entries(summary.metrics).map(([name, metric]) => [name, metric.values]));
    const beforeCleanup = inspectLoadDatabase(fixture.app.store);
    let profilePassed = true;
    if (profile === 'race') profilePassed = beforeCleanup.confirmedBookings === 1 && beforeCleanup.activeHolds === 0;
    if (profile === 'ticket-cap') profilePassed = beforeCleanup.maxTicketsPerUserPerformance === 4;
    if (profile === 'queue') profilePassed = telemetry.maxQueueAdmitted <= 2 && telemetry.maxQueueWaiting > 0;
    if (profile === 'busy') profilePassed = telemetry.nativeBusyErrors > 0 && !lockEvents.some(event => ['worker-error', 'lock-failed'].includes(event.type));
    const passed = code === 0 && !aborted && beforeCleanup.passed && profilePassed;
    for (const user of fixture.users) {
      for (const booking of fixture.app.store.bookings(user.userId)) if (booking.status === 'confirmed') fixture.app.store.cancel(user.userId, booking.id);
      fixture.app.store.setHold(user.userId, fixture.fixture.performanceId, []);
    }
    const afterCleanup = inspectLoadDatabase(fixture.app.store);
    report = { schema, profile, passed: passed && afterCleanup.passed && afterCleanup.confirmedBookings === 0 && afterCleanup.activeHolds === 0,
      k6ExitCode: code, aborted, k6: metrics, api: telemetry, lockEvents, beforeCleanup, afterCleanup,
      queueConfiguration: fixture.queueOptions, limiterConfiguration: fixture.limitOptions, diagnosticsDiscardedBytes: diagnosticBytes };
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) { child.kill(); await once(child, 'close'); }
    observer?.(); await locker?.stop(); await fixture?.close();
    for (const name of ['SIGINT', 'SIGTERM']) process.off(name, signal);
  }
  return { ...report, cleanupPassed: true };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), schemaArg = args.indexOf('--schema'), profileArg = args.indexOf('--profile');
  const schemas = schemaArg < 0 ? ['legacy', 'model'] : [args[schemaArg + 1]], profiles = profileArg < 0 ? LOAD_PROFILES : [args[profileArg + 1]];
  try {
    if (schemas.some(s => !['legacy', 'model'].includes(s)) || profiles.some(p => !LOAD_PROFILES.includes(p))) throw new Error('LOAD_SELECTION');
    const report = { measuredAtUtc: new Date().toISOString(), scope: 'bounded same-host separate-k6-process; one Node API; not LAN/production capacity',
      k6Version: k6Release.version, environment: { node: process.version, os: `${platform()} ${release()}`, arch: arch(), cpu: cpus()[0].model, logicalCpus: cpus().length, totalMemoryBytes: totalmem() }, profiles: [] };
    profilesLoop: for (const schema of schemas) for (const profile of profiles) {
      const result = await runK6Profile(schema, profile); report.profiles.push(result);
      console.log(JSON.stringify({ schema, profile, passed: result.passed, httpRequests: result.k6.http_reqs?.count, httpP95Ms: result.k6.http_req_duration?.['p(95)'], unexpected: result.k6.unexpected_status?.rate }));
      if (result.aborted) break profilesLoop;
    }
    const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
    const directory = new URL('../test-results/k6/', import.meta.url);
    await mkdir(directory, { recursive: true });
    const output = new URL(`k6-${date}-${Date.now()}.json`, directory);
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ passed: report.profiles.every(profile => profile.passed), reportFile: fileURLToPath(output) }));
    if (report.profiles.some(profile => !profile.passed)) process.exitCode = 1;
  } catch { console.error('k6 로컬 검증 실패: 도구/선택/임시 fixture/요약/정리 결과를 확인해 주세요.'); process.exitCode = 1; }
}
