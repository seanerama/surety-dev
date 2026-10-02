// Developer tests for E37 item 4: a backup is labeled complete only if every
// commit its manifest lists is in its project's repository when it is taken.
// The store is a scratch one, migrated, with one project whose registered
// refs name the commits the backup lists.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(pkg, 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { backupStore } = await import(join(dist, 'store', 'backup.js'));

const MISSING = '1234567890123456789012345678901234567890';

function fixture(t, { repoPath, oids }) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'u', GIT_AUTHOR_EMAIL: 'u@x', GIT_COMMITTER_NAME: 'u', GIT_COMMITTER_EMAIL: 'u@x' };
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  execFileSync('git', ['-C', repo, 'add', 'a.txt'], { env });
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'one'], { env });
  const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { env, encoding: 'utf8' }).trim();
  const home = join(dir, 'home');
  mkdirSync(home);
  const db = new Database(join(home, 'store.db'));
  migrate(db, join(pkg, 'migrations'));
  db.pragma('foreign_keys = OFF');
  db.prepare(
    `INSERT INTO "projects" ("id", "created_at", "name", "tier", "dev_repo_path", "integration_branch", "baseline_state", "registration_state", "management")
     VALUES ('proj_U', '2026-01-01T00:00:00Z', 'u', 'T1', ?, 'main', 'idea', 'registered', 'managed')`,
  ).run(repoPath ?? repo);
  (oids ?? [head]).forEach((oid, i) => {
    db.prepare(`INSERT INTO "ref_registry" ("id", "created_at", "project", "ref", "kind", "expected_oid", "immutable") VALUES (?, '2026-01-01T00:00:00Z', 'proj_U', ?, 'keep', ?, 1)`).run(
      `ref_${i}`,
      `refs/surety/keep/${i}`,
      oid === 'HEAD' ? head : oid,
    );
  });
  db.close();
  return home;
}

const manifestOf = (done) => JSON.parse(readFileSync(join(done.backup, 'manifest.json'), 'utf8'));

test('every listed commit present: complete', async (t) => {
  const home = fixture(t, {});
  const done = await backupStore(home, { databaseOnly: false });
  assert.equal(done.label, 'complete');
  assert.equal(manifestOf(done).label, 'complete');
});

test('a listed commit gone from the repository: incomplete for recovery', async (t) => {
  const home = fixture(t, { oids: ['HEAD', MISSING] });
  const done = await backupStore(home, { databaseOnly: false });
  assert.equal(done.label, 'incomplete_for_recovery');
  const manifest = manifestOf(done);
  assert.equal(manifest.label, 'incomplete_for_recovery');
  assert.ok(manifest.git[0].objects.includes(MISSING), 'the manifest still lists what the store refers to');
});

test('a repository that cannot be read: incomplete for recovery', async (t) => {
  const home = fixture(t, { repoPath: '/nonexistent/surety-unit-repo' });
  const done = await backupStore(home, { databaseOnly: false });
  assert.equal(done.label, 'incomplete_for_recovery');
});
