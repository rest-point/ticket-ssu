import { DatabaseSync } from 'node:sqlite';
import { realpathSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { configure, validateModel } from './model.mjs';
import { readLegacy, snapshotDatabase } from './migrate.mjs';

function verifyHandle(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version === 1) validateModel(db);
  else if (version === 0) readLegacy(db);
  else throw new Error('unsupported backup schema');
  return { schema: version === 1 ? 'model' : 'legacy', version, verified: true };
}
export function verifyBackup(file) {
  const db = configure(new DatabaseSync(realpathSync(file), { readOnly: true }), { readOnly: true });
  try {
    db.exec('BEGIN');
    return verifyHandle(db);
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
}
export function backupDatabase(source, destination) {
  const result = snapshotDatabase(source, destination, { verify: verifyHandle });
  return { ...result, bytes: statSync(destination).size, sha256: createHash('sha256').update(readFileSync(destination)).digest('hex') };
}
export function restoreDatabase(source, newCandidate) {
  return { ...backupDatabase(source, newCandidate), restored: true };
}
