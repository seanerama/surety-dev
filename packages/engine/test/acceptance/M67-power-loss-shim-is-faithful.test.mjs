// M67, first group: the power-loss shim is faithful (slice 4). Plan §3.6 M67
// and §2 resource V; build spec §8; E31 item 5; SEAM.md §60.
//
// Row M67 cuts power with an unprivileged shim: a library loaded into the
// engine that records what each file held when it was last synced, so that a
// test can kill everything and put every file back to that. Nothing the
// shim reports about the engine means anything unless the shim itself tells
// synced from unsynced. These cases need no engine and pass today: with
// plain SQLite through the pinned driver, and with plain git, what was
// synced survives a cut and what was written and not synced does not.
// The engine under the shim is M67-power-loss-durability.test.mjs.
//
// A compiler that is missing, or a library that does not load, fails these
// cases: a missing V capability leaves the row unpassed (Plan M67).

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { makeTempDir, removeDir } from './harness/engine.mjs';
import { git, gitEnv, makeRepo } from './harness/git.mjs';
import { PowerLoss } from './harness/powerloss.mjs';

const SQLITE_CHILD = fileURLToPath(new URL('./harness/powerloss/sqlite-child.mjs', import.meta.url));
const SYNCED = ['-c', 'core.fsync=all', '-c', 'core.fsyncMethod=fsync'];
const UNSYNCED = ['-c', 'core.fsync=none'];

// A directory to cut power in, and the shim built for it.
function session(t, make) {
  const root = makeTempDir('powerloss');
  t.after(() => removeDir(root));
  const target = join(root, 'target');
  make(target);
  const power = new PowerLoss(join(root, 'shim'), [target]);
  power.baseline();
  return { root, target, power };
}

// Run the SQLite writer under the shim until it has done its steps, then cut power under it.
async function writeThenCut(t, steps) {
  const { target, power } = session(t, (dir) => mkdirSync(dir));
  const file = join(target, 'store.db');
  const child = spawn(process.execPath, [SQLITE_CHILD, file, ...steps], { env: { PATH: process.env.PATH, ...power.env() }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let out = '';
  let err = '';
  child.stderr.on('data', (c) => (err += c));
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (c) => (out += c) && out.includes('ready') && resolve());
    child.on('exit', (code, signal) => reject(new Error(`the SQLite writer ended before it was ready (code ${code}, signal ${signal})\n${err}`)));
  });
  assert.ok(power.loaded().some((p) => p.pid === child.pid), `the shim was loaded into the SQLite writer (loaded into: ${JSON.stringify(power.loaded())})`);
  await power.cut({ pids: [child.pid] });
  const db = new Database(file, { fileMustExist: true });
  try {
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok', 'the database is sound after the cut');
    return db.prepare('SELECT "key" FROM "kept" ORDER BY "key"').all().map((row) => row.key);
  } finally {
    db.close();
  }
}

// git, run under the shim with the test's own constructed environment.
function gitUnderShim(power, repo, args, input) {
  const done = spawnSync('git', ['-C', repo, ...args], { env: { ...gitEnv(repo), ...power.env() }, input, encoding: 'utf8' });
  assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`);
  return done.stdout.trim();
}

// A commit object and a branch that points at it, written by git under the shim.
function commitAndRef(power, repo, config, branch) {
  const commit = gitUnderShim(power, repo, [...config, 'commit-tree', `${git(repo, ['rev-parse', 'HEAD^{tree}'])}`, '-p', 'HEAD', '-m', `written with ${config.join(' ')}`]);
  gitUnderShim(power, repo, [...config, 'update-ref', `refs/heads/${branch}`, commit]);
  assert.equal(git(repo, ['rev-parse', `refs/heads/${branch}`]), commit, 'before the cut git reads the branch at the new commit');
  return commit;
}

const reads = (repo, args) => spawnSync('git', ['-C', repo, ...args], { env: gitEnv(repo), encoding: 'utf8' });

describe('M67 the power-loss shim tells synced from unsynced: SQLite through the pinned driver', () => {
  test('a transaction committed under synchronous=FULL survives a cut', async (t) => {
    assert.deepEqual(await writeThenCut(t, ['full:first', 'full:second']), ['first', 'second']);
  });

  test('a transaction committed without a sync does not survive a cut, and the synced one before it does', async (t) => {
    assert.deepEqual(await writeThenCut(t, ['full:synced', 'off:not-synced']), ['synced']);
  });
});

describe('M67 the power-loss shim tells synced from unsynced: git', () => {
  test('a commit and a branch written with core.fsync=all survive a cut', async (t) => {
    const { target: repo, power } = session(t, (dir) => makeRepo(dir));
    const commit = commitAndRef(power, repo, SYNCED, 'synced');
    assert.ok(power.loaded().some((p) => p.comm === 'git'), 'the shim was loaded into git');
    await power.cut();
    assert.equal(git(repo, ['rev-parse', 'refs/heads/synced']), commit, 'the branch is where git put it');
    assert.equal(git(repo, ['cat-file', '-t', commit]), 'commit', 'the commit object is readable');
    assert.equal(reads(repo, ['fsck', '--no-dangling']).status, 0, 'the repository is sound');
  });

  test('a commit and a branch written with core.fsync=none do not survive a cut', async (t) => {
    const { target: repo, power } = session(t, (dir) => makeRepo(dir));
    const kept = commitAndRef(power, repo, SYNCED, 'synced');
    const lost = commitAndRef(power, repo, UNSYNCED, 'not-synced');
    const changed = await power.cut();
    assert.notEqual(reads(repo, ['cat-file', '-p', lost]).status, 0, 'the commit object that was never synced is not readable');
    assert.notEqual(reads(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/not-synced']).status, 0, 'the branch that was never synced does not resolve');
    assert.ok(changed.emptied.length > 0, 'the cut emptied what was written and never synced');
    assert.equal(git(repo, ['rev-parse', 'refs/heads/synced']), kept, 'what was synced in the same session is kept');
    assert.equal(git(repo, ['cat-file', '-t', kept]), 'commit');
  });

  test('git started by a process under the shim, with an environment that process constructed, is under the shim too', async (t) => {
    const { target: repo, power } = session(t, (dir) => makeRepo(dir));
    // As the engine does: an argument array and a constructed environment that names neither the library nor the session.
    const program = `
      const { spawnSync } = require('node:child_process');
      const env = { PATH: process.env.PATH, HOME: ${JSON.stringify(repo)}, GIT_CONFIG_NOSYSTEM: '1' };
      const done = spawnSync('git', ['-C', ${JSON.stringify(repo)}, ${SYNCED.map((a) => JSON.stringify(a)).join(', ')}, 'hash-object', '-w', '--stdin'], { env, input: 'written by a grandchild\\n', encoding: 'utf8' });
      if (done.status !== 0) { process.stderr.write(String(done.stderr)); process.exit(1); }
      process.stdout.write(done.stdout);`;
    const parent = spawnSync(process.execPath, ['-e', program], { env: { PATH: process.env.PATH, ...power.env() }, encoding: 'utf8' });
    assert.equal(parent.status, 0, `the parent process: ${parent.stderr}`);
    const blob = parent.stdout.trim();
    assert.deepEqual([...new Set(power.loaded().map((p) => p.comm))].sort(), ['git', 'node'], 'the shim was loaded into the parent and into the git it started');
    await power.cut();
    assert.equal(git(repo, ['cat-file', '-p', blob]), 'written by a grandchild', 'what that git synced survives the cut');
  });
});
