import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(workerData.dbPath);
db.exec('PRAGMA busy_timeout=1000');
parentPort.postMessage({ type: 'ready' });
parentPort.on('message', message => {
  if (message === 'stop') { db.close(); parentPort.close(); return; }
  try {
    db.exec('BEGIN IMMEDIATE'); parentPort.postMessage({ type: 'locked' });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
    db.exec('COMMIT'); parentPort.postMessage({ type: 'released' });
  } catch { if (db.isTransaction) db.exec('ROLLBACK'); parentPort.postMessage({ type: 'lock-failed' }); }
});
