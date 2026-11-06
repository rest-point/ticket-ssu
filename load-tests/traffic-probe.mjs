// Bounded local diagnostics, not a k6 capacity certification. Never opens the
// project DB. HTTP clients and one API share this Node process/event loop.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, platform, release, arch } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { PerformanceQueue } from '../lib/performance-queue.mjs';
import { RequestLimiter } from '../lib/request-limiter.mjs';
import { validateModel } from '../db/model.mjs';

if (typeof global.gc !== 'function') throw new Error('Run node --expose-gc load-tests/traffic-probe.mjs');
const rounded = value => Math.round(value * 1000) / 1000;
const memory = () => { global.gc(); const m = process.memoryUsage(); return { heap: m.heapUsed, rss: m.rss }; };
const delta = (after, before) => ({ heap_bytes: after.heap - before.heap, rss_bytes: after.rss - before.rss });
const percentile = (values, p) => values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
function coreProbe() {
  let mono = 0;
  const baseline = memory(), cpu = process.cpuUsage(), started = performance.now();
  const queue = new PerformanceQueue({ now: () => 1800000000000 + mono, monotonic: () => mono,
    activeLimit: 1, admitPerSecond: 1, maxWaiting: 9999, maxTotal: 10000 });
  for (let i = 0; i < 10000; i++) queue.enter('synthetic-performance', `synthetic-user-${i}`);
  const fillMs = performance.now() - started, full = memory(), fullStats = queue.stats();
  assert.deepEqual(fullStats, { performances: 1, entries: 10000, waiting: 9999, admitted: 1 });
  assert.throws(() => queue.enter('synthetic-performance', 'overflow'), { status: 429 });
  const polls = [];
  for (let i = 0; i < 200; i++) {
    const before = performance.now(); const status = queue.status('synthetic-performance', 'synthetic-user-9999');
    assert.equal(status.position, 9999); polls.push(performance.now() - before);
  }
  polls.sort((a, b) => a - b);
  const sweepStart = performance.now(); mono = 150000; queue.tick();
  const sweepMs = performance.now() - sweepStart;
  assert.equal(queue.stats().entries, 0);
  const empty = memory(), usage = process.cpuUsage(cpu);
  queue.close();
  const limiterBaseline = memory(); mono = 0;
  const limiter = new RequestLimiter({ monotonic: () => mono });
  const limiterStart = performance.now();
  for (let i = 0; i < 10000; i++) { limiter.ip(`synthetic-ip-${i}`); limiter.user(`synthetic-user-${i}`); limiter.auth(`synthetic-ip-${i}`); }
  const limiterFull = memory(); let rejected = 0;
  for (let i = 10000; i < 12000; i++) for (const method of ['ip', 'user', 'auth']) {
    try { limiter[method](`synthetic-new-${i}`); } catch (e) { assert.equal(e.status, 429); rejected++; }
  }
  const limiterFullStats = limiter.stats();
  assert.deepEqual(limiterFullStats, { ips: 10000, users: 10000, authIps: 10000 });
  const afterChurn = memory(); mono = 600001; limiter.sweep();
  assert.deepEqual(limiter.stats(), { ips: 0, users: 0, authIps: 0 });
  const limiterEmpty = memory(); limiter.close();
  return { kind: 'synchronous-core-diagnostic', queue: { entries: 10000, fill_ms: rounded(fillMs),
    tail_poll_p95_ms: rounded(percentile(polls, .95)), tail_poll_p99_ms: rounded(percentile(polls, .99)),
    expiry_sweep_ms: rounded(sweepMs), full: fullStats, after_sweep: { entries: 0 },
    full_memory_delta: delta(full, baseline), after_sweep_memory_delta: delta(empty, baseline),
    cpu_user_ms: rounded(usage.user / 1000), cpu_system_ms: rounded(usage.system / 1000) },
    limiter: { full: limiterFullStats, rejected_new_keys: rejected, elapsed_ms: rounded(performance.now() - limiterStart),
      full_memory_delta: delta(limiterFull, limiterBaseline), churn_memory_delta: delta(afterChurn, limiterFull),
      after_sweep_memory_delta: delta(limiterEmpty, limiterBaseline), after_sweep: { ips: 0, users: 0, authIps: 0 } } };
}
async function httpProbe(schema, kind) {
  const dir = await mkdtemp(join(tmpdir(), 'ticket-ssu-traffic-probe-'));
  let app;
  try {
    let wall = 1800000000000;
    app = await createApp({ schema, dbPath: join(dir, 'test.sqlite'), now: () => wall, holdMs: 1000,
      queueOptions: { activeLimit: 10, admitPerSecond: 1000 },
      limitOptions: kind === 'limited-burst' ? { ipBurst: 20, ipPerSecond: 1, monotonic: () => 0 } :
        { ipBurst: 1000000, ipPerSecond: 1000000, userBurst: 1000000, userPerSecond: 1000000 } });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const base = `http://127.0.0.1:${app.server.address().port}`, store = app.store;
    const pid = store.concerts()[0].performances[0].id;
    const password = store.get('SELECT password_hash FROM users LIMIT 1').password_hash;
    const clients = [];
    if (kind !== 'limited-burst') {
      for (let i = 0; i < 16; i++) {
        const id = `synthetic-probe-${i}`;
        store.run('INSERT INTO users VALUES(?,?,?,?,?,?,?)', id, `probe${i}@ticket-ssu.local`, '가상부하회원', '01012345678', password, 'user', wall);
        const session = store.createSession(id);
        clients.push({ Cookie: `ticket_ssu_session=${session.token}`, 'X-CSRF-Token': session.csrf });
      }
      store.setHold('synthetic-probe-0', pid, ['A-01']); wall += 1000;
      for (const headers of clients) {
        const res = await fetch(`${base}/api/v1/performances/${pid}/queue`, { method: 'POST', headers });
        assert.equal(res.status, 200); await res.json();
      }
    }
    const seatMap = store.seatMap.bind(store);
    if (kind === 'control-expire-on-read') store.seatMap = (...args) => store.transaction(() => { store.expire(); return seatMap(...args); });
    let writes = 0, dml = 0;
    const exec = store.db.exec, run = store.run;
    store.db.exec = function (sql) { if (/^BEGIN IMMEDIATE/.test(sql)) writes++; return exec.call(this, sql); };
    store.run = function (...args) { dml++; return run.apply(this, args); };
    const path = kind === 'queue-poll' ? `/api/v1/performances/${pid}/queue` : kind === 'limited-burst' ? '/api/session' : `/api/performances/${pid}/seats`;
    const count = kind === 'limited-burst' ? 100 : 600;
    let next = 0, peakHeap = 0, peakRss = 0;
    const beforeMemory = memory(), beforeCpu = process.cpuUsage(), beforeElu = performance.eventLoopUtilization();
    peakHeap = beforeMemory.heap; peakRss = beforeMemory.rss;
    const eventLoop = monitorEventLoopDelay({ resolution: 10 }); eventLoop.enable();
    const sampleMemory = setInterval(() => { const m = process.memoryUsage(); peakHeap = Math.max(peakHeap, m.heapUsed); peakRss = Math.max(peakRss, m.rss); }, 20);
    const latencies = [], statuses = {};
    const started = performance.now();
    try {
      await Promise.all(Array.from({ length: 16 }, (_, worker) => (async () => {
        while (next < count) {
          const index = next++, before = performance.now();
          const response = await fetch(base + path, { headers: clients.length ? clients[worker] : {}, signal: AbortSignal.timeout(10000) });
          const body = await response.json();
          latencies.push(performance.now() - before); statuses[response.status] = (statuses[response.status] ?? 0) + 1;
          if (body.seats) assert.equal(body.seats[0].state, 'available');
          if (response.status === 429) assert.ok(Number(response.headers.get('retry-after')) >= 1);
          assert.ok(response.status === 200 || kind === 'limited-burst' && response.status === 429, `unexpected status ${response.status}, request ${index}`);
        }
      })()));
    } finally { clearInterval(sampleMemory); }
    const duration = performance.now() - started, usage = process.cpuUsage(beforeCpu), elu = performance.eventLoopUtilization(beforeElu);
    await delay(20); eventLoop.disable();
    latencies.sort((a, b) => a - b);
    if (kind === 'limited-burst') assert.deepEqual(statuses, { 200: 20, 429: 80 });
    else assert.equal(statuses[200], count);
    if (kind === 'control-expire-on-read') assert.ok(writes >= count);
    else assert.ok(writes <= Math.ceil(duration / 5000), 'only periodic expiry may write during reads');
    const heldStatus = kind === 'limited-burst' ? null : store.get("SELECT status FROM holds WHERE user_id='synthetic-probe-0'").status;
    store.db.exec = exec; store.run = run;
    const report = { schema, kind, clients: 16, requests: count, duration_ms: rounded(duration), requests_per_second: rounded(count * 1000 / duration),
      p95_ms: rounded(percentile(latencies, .95)), p99_ms: rounded(percentile(latencies, .99)), statuses,
      immediate_write_transactions: writes, dml_statements: dml, expired_hold_physical_status: heldStatus,
      cpu_user_ms: rounded(usage.user / 1000), cpu_system_ms: rounded(usage.system / 1000), event_loop_utilization: rounded(elu.utilization),
      event_loop_p95_ms: rounded(eventLoop.percentile(95) / 1e6), event_loop_max_ms: rounded(eventLoop.max / 1e6),
      observed_peak_heap_delta_bytes: peakHeap - beforeMemory.heap, observed_peak_rss_delta_bytes: peakRss - beforeMemory.rss,
      limiter_keys: app.limiter.stats(), sqlite: store.get('SELECT sqlite_version() AS v').v };
    store.expire(); if (schema === 'model') validateModel(store.db);
    return report;
  } finally {
    if (app?.store.db.isOpen) await new Promise(ok => app.server.close(ok));
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep + 'ticket-ssu-traffic-probe-'));
    await rm(dir, { recursive: true });
  }
}
const report = { measured_at_utc: new Date().toISOString(), environment: { node: process.version, os: `${platform()} ${release()}`, arch: arch(), cpu: cpus()[0].model,
  logical_cpus: cpus().length, total_memory_bytes: totalmem() }, scope: 'bounded local diagnostic; same-process HTTP driver; not k6 or production capacity', core: coreProbe(), http: [] };
for (const schema of ['legacy', 'model']) for (const kind of ['control-expire-on-read', 'read-only', 'queue-poll', 'limited-burst']) {
  report.http.push(await httpProbe(schema, kind));
  console.log(`completed ${schema}/${kind}`);
}
const directory = new URL('../test-results/traffic/', import.meta.url);
await mkdir(directory, { recursive: true });
const output = new URL(`traffic-probe-${Date.now()}.json`, directory);
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
