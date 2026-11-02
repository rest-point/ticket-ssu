// Manual browser fixture: no project DB, no public test-control endpoints.
// stdin: release / advance (lease expiry) / stop.
import { performance } from 'node:perf_hooks';
import { createApp } from '../../server.mjs';
let offset = 0;
const { server, store, queue } = await createApp({ dbPath: ':memory:', schema: 'model', now: () => Date.now() + offset,
  secureCookies: false, queueOptions: { activeLimit: 1, admitPerSecond: 100, admissionMs: 60000, monotonic: () => performance.now() + offset } });
const pid = store.concerts()[0].performances[0].id;
const blocker = store.get("SELECT id FROM users WHERE email='admin@temp.local'").id;
queue.enter(pid, blocker, { sessionKey: 'synthetic-browser-blocker' });
server.listen(0, '127.0.0.1', () => console.log(`BROWSER_FIXTURE http://127.0.0.1:${server.address().port}/#/book/${pid}`));
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  const command = chunk.trim();
  if (command === 'release') { queue.leave(pid, blocker); console.log('BLOCKER_RELEASED'); }
  if (command === 'advance') { offset += 61000; queue.tick(); console.log('LEASE_ADVANCED'); }
  if (command === 'stop') server.close(() => { process.stdin.pause(); process.exit(0); });
});
