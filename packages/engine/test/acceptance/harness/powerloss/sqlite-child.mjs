// A process that writes to a SQLite database through the pinned driver and
// then stays alive with the database open, so that a test can cut power
// under it (M67-power-loss-shim-is-faithful.test.mjs).
//
// usage: node sqlite-child.mjs <database file> <step>...
//   full:<key>   insert <key> in a transaction committed under synchronous=FULL
//   off:<key>    insert <key> in a transaction committed under synchronous=OFF
// The database is in WAL mode, as the engine's store is (D1 §6.1). When every
// step is done the process writes "ready" and waits to be killed.

import Database from 'better-sqlite3';

const [file, ...steps] = process.argv.slice(2);
const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.exec('CREATE TABLE IF NOT EXISTS "kept" ("key" TEXT PRIMARY KEY)');
for (const step of steps) {
  const [mode, key] = step.split(':');
  db.pragma(`synchronous = ${mode === 'full' ? 'FULL' : 'OFF'}`);
  db.prepare('INSERT INTO "kept" ("key") VALUES (?)').run(key);
}
process.stdout.write('ready\n');
setInterval(() => {}, 1 << 30);
