// Developer tests for the engine's git layer (src/git/): a constructed
// environment, worktrees added and removed with the probe deciding the
// outcome, and an unreadable branch read as unknown, not as a commit.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { configureGit, repoContext } = await import(join(dist, 'git', 'exec.js'));
const { addWorktree, branchHead, probeWorktree, removeWorktree } = await import(join(dist, 'git', 'worktree.js'));

function scratchRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-git-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'u', GIT_AUTHOR_EMAIL: 'u@x', GIT_COMMITTER_NAME: 'u', GIT_COMMITTER_EMAIL: 'u@x' };
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  execFileSync('git', ['-C', repo, 'add', 'a.txt'], { env });
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'one'], { env });
  configureGit({ deadlineSeconds: 30, outputCap: 1 << 20, home: dir });
  return { dir, repo, head: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { env, encoding: 'utf8' }).trim() };
}

test('a branch head is read; a missing or option-shaped branch is unknown', async (t) => {
  const { repo, head } = scratchRepo(t);
  const ctx = repoContext(repo);
  assert.equal(await branchHead(ctx, 'main'), head);
  assert.equal(await branchHead(ctx, 'nope'), null);
  assert.equal(await branchHead(ctx, '--output=x'), null);
});

test('a worktree is added detached at the base, probed, and removed with its files', async (t) => {
  const { dir, repo, head } = scratchRepo(t);
  const ctx = repoContext(repo);
  const ws = join(dir, 'ws-1');
  assert.equal(await probeWorktree(ctx, ws), 'absent');
  assert.equal(await addWorktree(ctx, ws, head), 'present');
  assert.equal(await probeWorktree(ctx, ws, head), 'present');
  writeFileSync(join(ws, 'untracked.txt'), 'x');
  assert.equal(await removeWorktree(ctx, ws), 'absent');
  assert.equal(existsSync(ws), false);
});

test('a base that is not a full commit id is refused without running git', async (t) => {
  const { dir, repo } = scratchRepo(t);
  assert.equal(await addWorktree(repoContext(repo), join(dir, 'ws-2'), 'main'), 'absent');
  assert.equal(existsSync(join(dir, 'ws-2')), false);
});
