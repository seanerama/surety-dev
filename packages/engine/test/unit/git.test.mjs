// Developer tests for the engine's git layer (src/git/): a constructed
// environment, worktrees added and removed with the probe deciding the
// outcome, and an unreadable branch read as unknown, not as a commit. Engine
// git runs no hook of the repository, and the probe recognises a worktree
// whose path is reached through a symbolic link.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { configureGit, repoContext } = await import(join(dist, 'git', 'exec.js'));

const { addWorktree, branchHead, probeAdd, probeRemove, removeWorktree } = await import(join(dist, 'git', 'worktree.js'));

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
  configureGit({ deadlineSeconds: 30, outputCap: 1 << 20, home: dir, incarnation: 'inc_unit' });
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
  const ws = join(dir, 'ws-1');
  assert.equal(await probeAdd(repo, ws, head), 'absent');
  assert.equal(await addWorktree(repo, ws, head, 'op_unit'), 'ok');
  assert.equal(await probeAdd(repo, ws, head), 'applied');
  assert.equal(await probeRemove(repo, ws), 'absent');
  writeFileSync(join(ws, 'untracked.txt'), 'x');
  assert.equal(await removeWorktree(repo, ws, 'op_unit'), 'ok');
  assert.equal(await probeRemove(repo, ws), 'applied');
  assert.equal(existsSync(ws), false);
});

test('a base that is not a full commit id is refused without running git', async (t) => {
  const { dir, repo } = scratchRepo(t);
  assert.equal(await addWorktree(repo, join(dir, 'ws-2'), 'main', 'op_unit'), 'failed');
  assert.equal(existsSync(join(dir, 'ws-2')), false);
});

test('something that is not the operation\'s at the owned path is conflicting, not absent', async (t) => {
  const { dir, repo, head } = scratchRepo(t);
  const ws = join(dir, 'ws-foreign');
  mkdirSync(ws);
  writeFileSync(join(ws, 'unrelated.txt'), 'not the engine\'s\n');
  assert.equal(await probeAdd(repo, ws, head), 'conflicting');
  assert.equal(await probeRemove(repo, ws), 'conflicting');
});

// A hook that records that it ran, in the repository's hooks directory and in
// a directory its configuration names as core.hooksPath.
function plantHooks(dir, repo, evidence) {
  const named = join(dir, 'named-hooks');
  mkdirSync(named);
  for (const hooks of [join(repo, '.git', 'hooks'), named]) {
    for (const hook of ['post-checkout', 'reference-transaction']) {
      writeFileSync(join(hooks, hook), `#!/bin/sh\necho "${hook} ran" >> '${evidence}'\n`);
      chmodSync(join(hooks, hook), 0o755);
    }
  }
  return named;
}

test('engine git runs no hook, in the hooks directory or in one core.hooksPath names', async (t) => {
  const { dir, repo, head } = scratchRepo(t);
  const evidence = join(dir, 'evidence.txt');
  const named = plantHooks(dir, repo, evidence);
  assert.equal(await addWorktree(repo, join(dir, 'ws-hooks-1'), head, 'op_unit'), 'ok');
  execFileSync('git', ['-C', repo, 'config', 'core.hooksPath', named]);
  assert.equal(await addWorktree(repo, join(dir, 'ws-hooks-2'), head, 'op_unit'), 'ok');
  assert.equal(await removeWorktree(repo, join(dir, 'ws-hooks-2'), 'op_unit'), 'ok');
  assert.equal(existsSync(evidence), false, 'no hook ran');
  // The hooks are live: git run the ordinary way executes them.
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '--detach', join(dir, 'ws-hooks-3'), head], { env: { PATH: process.env.PATH, HOME: dir } });
  assert.equal(existsSync(evidence), true);
});

test('engine git does not run the program the repository names as core.fsmonitor', async (t) => {
  const { dir, repo, head } = scratchRepo(t);
  const evidence = join(dir, 'fsmonitor-evidence.txt');
  const program = join(dir, 'fsmonitor');
  writeFileSync(program, `#!/bin/sh\necho ran >> '${evidence}'\nprintf 'token\\0/\\0'\n`);
  chmodSync(program, 0o755);
  execFileSync('git', ['-C', repo, 'config', 'core.fsmonitor', program]);
  assert.equal(await addWorktree(repo, join(dir, 'ws-fsm-1'), head, 'op_unit'), 'ok');
  assert.equal(await removeWorktree(repo, join(dir, 'ws-fsm-1'), 'op_unit'), 'ok');
  assert.equal(existsSync(evidence), false, 'the fsmonitor program did not run');
  // The program is live: git run the ordinary way executes it.
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '--detach', join(dir, 'ws-fsm-2'), head], { env: { PATH: process.env.PATH, HOME: dir } });
  assert.equal(existsSync(evidence), true);
});

test('a worktree under a symbolic link is probed applied when added and gone when removed', async (t) => {
  const { dir, repo, head } = scratchRepo(t);
  mkdirSync(join(dir, 'real'));
  symlinkSync(join(dir, 'real'), join(dir, 'link'));
  const ws = join(dir, 'link', 'ws');
  assert.equal(await addWorktree(repo, ws, head, 'op_unit'), 'ok');
  assert.equal(await probeAdd(repo, ws, head), 'applied');
  assert.equal(await probeAdd(repo, join(dir, 'real', 'ws'), head), 'applied');
  assert.equal(await removeWorktree(repo, ws, 'op_unit'), 'ok');
  assert.equal(await probeRemove(repo, ws), 'applied');
  assert.equal(existsSync(join(dir, 'real', 'ws')), false);
});
