// Child process for the concurrent-allocation case of row M02. Usage:
//   node concurrent-insert.mjs <store.db> <table> <row-json> <start-at>
// <start-at> is an instant of the monotonic clock in nanoseconds, as
// process.hrtime.bigint() gives it (concurrent.mjs). Waits until then so all
// children contend at once, inserts the row on its own connection, and
// prints {"ok":true} or {"ok":false,"code":...}.

import Database from 'better-sqlite3';

const [file, table, rowJson, startAt] = process.argv.slice(2);
const row = JSON.parse(rowJson);
const db = new Database(file, { fileMustExist: true });
db.pragma('busy_timeout = 10000');
db.pragma('foreign_keys = ON');
const cols = Object.keys(row);
const stmt = db.prepare(
  `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
);
const startAtNs = BigInt(startAt);
while (process.hrtime.bigint() < startAtNs) {
  // spin briefly so every child issues its write at nearly the same instant
}
try {
  stmt.run(...cols.map((c) => row[c]));
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
} catch (err) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: err.code ?? null, message: err.message })}\n`);
} finally {
  db.close();
}
