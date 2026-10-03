// Developer tests for a checkout's tracked content (D1 §7.6; SEAM.md §111;
// the slice-2 review's S1 and S2): `checkoutBaseline` reads it as what
// `git commit -a` would commit, from a copy of the checkout's own index, and
// writes nothing of the checkout. Against a scratch repository and real git.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { configureGit, repoContext } = await import(join(dist, 'git', 'exec.js'));
const { checkoutBaseline } = await import(join(dist, 'git', 'repo.js'));

function scratchRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-git-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const scratch = join(dir, 'scratch');
  mkdirSync(repo);
  mkdirSync(scratch);
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'u', GIT_AUTHOR_EMAIL: 'u@x', GIT_COMMITTER_NAME: 'u', GIT_COMMITTER_EMAIL: 'u@x' };
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
  writeFileSync(join(repo, 'lib.js'), 'one\n');
  writeFileSync(join(repo, 'gone.js'), 'gone\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  configureGit({ deadlineSeconds: 30, outputCap: 1 << 20, home: dir, incarnation: 'inc_unit' });
  return { repo, scratch, git };
}

test('the tracked content is what git commit -a would commit: a staged addition in, a superseded staged version giving way to the disk, a deleted file out, an untracked file out; the checkout is not written', async (t) => {
  const { repo, scratch, git } = scratchRepo(t);
  writeFileSync(join(repo, 'new.js'), 'new\n');
  git('add', 'new.js');
  writeFileSync(join(repo, 'lib.js'), 'staged\n');
  git('add', 'lib.js');
  writeFileSync(join(repo, 'lib.js'), 'on disk\n');
  unlinkSync(join(repo, 'gone.js'));
  writeFileSync(join(repo, 'untracked.js'), 'untracked\n');
  const indexBefore = readFileSync(join(repo, '.git', 'index'));

  const read = await checkoutBaseline(repoContext(repo), scratch);
  // What git commit -a commits, computed by git on a copy of the index.
  const copy = join(scratch, 'expected-index');
  writeFileSync(copy, indexBefore);
  const env = { ...process.env, GIT_INDEX_FILE: copy };
  execFileSync('git', ['-C', repo, 'add', '-u'], { env });
  const expected = execFileSync('git', ['-C', repo, 'write-tree'], { env, encoding: 'utf8' }).trim();

  assert.equal(read.tracked_tree_hash, expected);
  assert.deepEqual(git('ls-tree', '--name-only', read.tracked_tree_hash).split('\n'), ['lib.js', 'new.js']);
  assert.equal(git('cat-file', 'blob', `${read.tracked_tree_hash}:lib.js`), 'on disk');
  assert.equal(read.head, git('rev-parse', 'HEAD'));
  assert.deepEqual(readFileSync(join(repo, '.git', 'index')), indexBefore, "the checkout's own index was not written");
});

test('a checkout with nothing changed reads as its HEAD’s tree', async (t) => {
  const { repo, scratch, git } = scratchRepo(t);
  const read = await checkoutBaseline(repoContext(repo), scratch);
  assert.equal(read.tracked_tree_hash, git('rev-parse', 'HEAD^{tree}'));
});

test('a linked worktree reached through its .git file is read from its own index', async (t) => {
  const { repo, scratch, git } = scratchRepo(t);
  const ws = join(dirname(repo), 'ws');
  git('worktree', 'add', '-q', '--detach', ws, 'HEAD');
  writeFileSync(join(ws, 'added.js'), 'added\n');
  execFileSync('git', ['-C', ws, 'add', 'added.js']);
  const read = await checkoutBaseline(repoContext(ws), scratch);
  assert.notEqual(read, null, 'a .git file is not an unreadable checkout');
  assert.deepEqual(git('ls-tree', '--name-only', read.tracked_tree_hash).split('\n'), ['added.js', 'gone.js', 'lib.js']);
});
