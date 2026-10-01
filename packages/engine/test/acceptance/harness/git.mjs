// Real git repositories for fixtures (Plan §2, resource G). Test-side git runs
// with a constructed environment so the developer's configuration never leaks in.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function gitEnv(home) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Surety Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@surety.invalid',
    GIT_COMMITTER_NAME: 'Surety Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@surety.invalid',
    LANG: 'C',
  };
}

export function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { env: gitEnv(repo), encoding: 'utf8' }).trim();
}

// A repository with one commit on `branch`, nothing checked out elsewhere.
export function makeRepo(dir, { branch = 'main' } = {}) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', branch, dir], { env: gitEnv(dir) });
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'fixture: initial commit']);
  return { path: dir, branch, head: git(dir, ['rev-parse', 'HEAD']) };
}

// What a "no effect on the repository" assertion compares.
export function repoState(dir) {
  return {
    refs: git(dir, ['for-each-ref', '--format=%(refname) %(objectname)']),
    head: git(dir, ['rev-parse', 'HEAD']),
    status: git(dir, ['status', '--porcelain', '--untracked-files=all']),
    worktrees: git(dir, ['worktree', 'list', '--porcelain']),
  };
}
