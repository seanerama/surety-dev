// Developer tests for the lock judgment and the migration runner, against
// scratch files.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { judgeOwner, processStartTime, readBootId } = await import(join(dist, 'lock.js'));
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { ulid } = await import(join(dist, 'ids.js'));

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('ulids are 26 Crockford characters and strictly ordered within a millisecond', () => {
  const ids = Array.from({ length: 50 }, () => ulid(1_700_000_000_000));
  for (const id of ids) assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  for (let i = 1; i < ids.length; i++) assert.ok(ids[i] > ids[i - 1]);
});

test('lock judgment: live, reused pid, other boot, and unreadable records', (t) => {
  const boot = readBootId();
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  const start = processStartTime(child.pid);
  const lock = (fields) => JSON.stringify({ incarnation_id: 'inc_X', pid: child.pid, pid_start_time: start, host_boot_id: boot, ...fields });
  assert.equal(judgeOwner(lock({}), boot).live, true);
  assert.equal(judgeOwner(lock({ pid_start_time: '1' }), boot).live, false);
  assert.equal(judgeOwner(lock({ host_boot_id: 'other' }), boot).live, false);
  assert.equal(judgeOwner(lock({ pid: 2 ** 22 + 7 }), boot).live, false);
  // What cannot be judged is not taken over.
  assert.equal(judgeOwner('{not json', boot).live, true);
  assert.equal(judgeOwner(JSON.stringify({ incarnation_id: 'inc_X' }), boot).live, true);
});

test('migrations: applied once in order; a failure leaves nothing; a changed file is refused', (t) => {
  const dir = scratch(t);
  const migrations = join(dir, 'migrations');
  mkdirSync(migrations);
  const write = (name, sql) => writeFileSync(join(migrations, name), sql);
  write('0001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
  write('0002_b.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY);');
  write('notes.txt', 'ignored');
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());

  assert.deepEqual(migrate(db, migrations).applied, ['0001_a.sql', '0002_b.sql']);
  assert.deepEqual(migrate(db, migrations).applied, []);

  write('0003_bad.sql', 'CREATE TABLE c (id INTEGER PRIMARY KEY); NOT SQL;');
  assert.throws(() => migrate(db, migrations), (e) => e.code === 'migration_failed' && e.subject.migration === '0003_bad.sql');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'c'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 2);
  rmSync(join(migrations, '0003_bad.sql'));

  write('0001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY); -- edited');
  assert.throws(() => migrate(db, migrations), (e) => e.code === 'migration_checksum_mismatch' && e.subject.migration === '0001_a.sql');
  assert.throws(() => db.prepare('DELETE FROM schema_migrations').run(), (e) => e.code.startsWith('SQLITE_CONSTRAINT'));
});
