// Developer tests for how the running engine's backup confirms the commits
// it lists (src/store/backup.ts `unconfirmedCommit`; E42 items 2 and 3): by
// engine git, within the git deadline. A good commit is confirmed; a commit
// whose object is corrupt is not; a repository whose configuration is a pipe
// nobody writes to is not confirmed either, and the check ends within the
// deadline instead of waiting.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { configureGit } = await import(join(dist, 'git', 'exec.js'));
const { unconfirmedCommit } = await import(join(dist, 'store', 'backup.js'));

const env = { PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }).trim();

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'surety-unit-confirm-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  execFileSync('mkdir', ['-p', home]);
  configureGit({ deadlineSeconds: 2, outputCap: 1 << 20, home, incarnation: 'inc_unit' });
  const repo = join(root, 'repo');
  git(root, 'init', '-q', '-b', 'main', repo);
  writeFileSync(join(repo, 'f.txt'), 'a\n');
  git(repo, 'add', 'f.txt');
  git(repo, 'commit', '-q', '-m', 'one');
  const commit = git(repo, 'rev-parse', 'HEAD');
  const closure = { git: [{ project: 'proj_a', objects: [commit] }], repos: new Map([['proj_a', repo]]) };
  return { repo, commit, closure };
}

test('a commit git confirms is confirmed', async (t) => {
  const { closure } = scratch(t);
  assert.equal(await unconfirmedCommit(closure), null);
});

test('a commit whose loose object is corrupt is not confirmed', async (t) => {
  const { repo, commit, closure } = scratch(t);
  const loose = join(repo, '.git', 'objects', commit.slice(0, 2), commit.slice(2));
  chmodSync(loose, 0o644);
  writeFileSync(loose, deflateSync(Buffer.from('commit 9999\0not the commit at all')));
  const found = await unconfirmedCommit(closure);
  assert.equal(found?.object, commit);
});

test('a repository whose git is held up is not confirmed, and the check ends within the git deadline', async (t) => {
  const { repo, commit, closure } = scratch(t);
  const config = join(repo, '.git', 'config');
  rmSync(config);
  execFileSync('mkfifo', [config]);
  const started = performance.now();
  const found = await unconfirmedCommit(closure);
  const took = performance.now() - started;
  assert.equal(found?.object, commit);
  assert.match(found.reason, /deadline/);
  assert.ok(took < 10_000, `the check ended in ${Math.round(took)} ms`);
});
