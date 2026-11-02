import { backupDatabase, restoreDatabase, verifyBackup } from './backup.mjs';
const [command, ...args] = process.argv.slice(2);
try {
  let result;
  if (command === 'backup' && args.length === 2) result = backupDatabase(...args);
  else if (command === 'restore' && args.length === 2) result = restoreDatabase(...args);
  else if (command === 'verify' && args.length === 1) result = verifyBackup(args[0]);
  else throw new Error('usage: node db/backup-cli.mjs backup|restore <source.sqlite> <new.sqlite> OR verify <file.sqlite>');
  console.log(JSON.stringify(result));
} catch (error) { console.error(error.message); process.exitCode = 1; }
