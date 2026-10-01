// Toolchain check for the scaffold. It proves the build output loads, the bin
// refuses honestly, and the pinned SQLite driver accepts the durability
// settings D1 §6.1 requires. It is not an acceptance test and claims nothing
// about the engine.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');

test('built entry point exports a version', async () => {
  const engine = await import(join(dist, 'index.js'));
  assert.match(engine.ENGINE_VERSION, /^\d+\.\d+\.\d+$/);
});

test('bin reports its version and refuses an unknown command', () => {
  const cli = join(dist, 'cli.js');
  assert.match(execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }), /^\d+\.\d+\.\d+\n$/);
  const unknown = spawnSync(process.execPath, [cli, 'no-such-command'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /no-such-command/);
});

test('pinned SQLite driver accepts WAL, synchronous=FULL and foreign keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'surety-toolchain-'));
  try {
    const db = new Database(join(dir, 'probe.db'));
    assert.equal(db.pragma('journal_mode = WAL', { simple: true }), 'wal');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    assert.equal(db.pragma('synchronous', { simple: true }), 2);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
