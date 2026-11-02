import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

const db = new DatabaseSync(workerData.path);
db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
parentPort.postMessage('locked');
parentPort.once('message', () => {
  db.exec('ROLLBACK');
  db.close();
  parentPort.postMessage('released');
  parentPort.close();
});
