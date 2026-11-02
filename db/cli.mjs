import { DatabaseSync } from 'node:sqlite';
import { configure, withNewDatabase, validateModel } from './model.mjs';
import { migrateLegacy, snapshotDatabase } from './migrate.mjs';
import { seedDemo } from './seeds/demo.mjs';

const [command, ...args] = process.argv.slice(2);
try {
  let result;
  if (command === 'init' && args.length === 1) result = withNewDatabase(args[0], validateModel);
  else if (command === 'seed' && args.length === 1) result = withNewDatabase(args[0], db => seedDemo(db));
  else if (command === 'migrate' && args.length === 2) result = migrateLegacy(args[0], args[1]);
  else if (command === 'snapshot' && args.length === 2) result = snapshotDatabase(args[0], args[1]);
  else if (command === 'verify' && args.length === 1) {
    const db = configure(new DatabaseSync(args[0], { readOnly: true }), { readOnly: true });
    try { result = validateModel(db); } finally { db.close(); }
  } else throw new Error('usage: node db/cli.mjs init|seed|verify <file.sqlite> OR migrate|snapshot <source.sqlite> <new.sqlite>');
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
