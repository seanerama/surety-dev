// Developer tests for the commit-presence check the running engine's backup
// makes without git (src/store/objects.ts): loose and packed commits are
// found, deltified ones through their base, a blob is not a commit, a pruned
// commit is gone, and a repository whose configuration is a pipe nobody
// writes to does not hold the check up.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { commitPresent } = await import(join(dist, 'store', 'objects.js'));

const env = { PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }).trim();

function repoWithCommits(t, n) {
  const repo = mkdtempSync(join(tmpdir(), 'surety-unit-objects-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q', '-b', 'main');
  const commits = [];
  for (let i = 0; i < n; i++) {
    writeFileSync(join(repo, 'file.txt'), `${'line\n'.repeat(200)}${i}\n`);
    git(repo, 'add', 'file.txt');
    git(repo, 'commit', '-q', '-m', `commit ${i} ${'x'.repeat(400)}`);
    commits.push(git(repo, 'rev-parse', 'HEAD'));
  }
  return { repo, commits };
}

test('loose commits are found; a blob, an unknown id and a malformed id are not commits', (t) => {
  const { repo, commits } = repoWithCommits(t, 2);
  for (const c of commits) assert.equal(commitPresent(repo, c), true);
  const blob = git(repo, 'rev-parse', 'HEAD:file.txt');
  assert.equal(commitPresent(repo, blob), false);
  assert.equal(commitPresent(repo, 'f'.repeat(40)), false);
  assert.equal(commitPresent(repo, 'not-an-id'), false);
});

test('packed commits, deltified ones included, are found through the pack index', (t) => {
  const { repo, commits } = repoWithCommits(t, 30);
  git(repo, 'gc', '-q', '--aggressive', '--prune=now');
  assert.equal(git(repo, 'count-objects', '-v').includes('count: 0'), true, 'everything is packed');
  for (const c of commits) assert.equal(commitPresent(repo, c), true, c);
  assert.equal(commitPresent(repo, git(repo, 'rev-parse', 'HEAD:file.txt')), false);
});

test('a pruned commit is gone, and a held configuration does not hold the check up', (t) => {
  const { repo, commits } = repoWithCommits(t, 2);
  git(repo, 'reset', '-q', '--hard', commits[0]);
  git(repo, 'reflog', 'expire', '--expire=now', '--all');
  git(repo, 'prune', '--expire=now');
  assert.equal(commitPresent(repo, commits[1]), false);
  rmSync(join(repo, '.git', 'config'));
  execFileSync('mkfifo', [join(repo, '.git', 'config')]);
  assert.equal(commitPresent(repo, commits[0]), true);
});
