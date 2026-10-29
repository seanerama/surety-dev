// A process that writes to a SQLite database through the pinned driver and
// then stays alive with the database open, so that a test can cut power
// under it (M67-power-loss-shim-is-faithful.test.mjs).
//
// usage: node sqlite-child.mjs <database file> <step>...
//   full:<key>   insert <key> in a transaction committed under synchronous=FULL
//   off:<key>    insert <key> in a transaction committed under synchronous=OFF
// The database is in WAL mode, as the engine's store is (D1 §6.1). When every
// step is done the process writes "ready" and waits to be killed, holding the
// connection open.

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
// The wait refers to the connection, so the connection stays reachable and
// open until the cut. A Database nothing refers to may be collected, and the
// driver closes it when it is: the close checkpoints the WAL into the
// database file (unsynced under synchronous=OFF) and removes the WAL, before
// the cut. Node v26.7.0 often collects it within milliseconds of "ready"
// (mini-hp01, 2026-10-28: "no such table: kept"); Node v22 later than the
// cut, which hid it.
setInterval(() => db.open, 1 << 30);
