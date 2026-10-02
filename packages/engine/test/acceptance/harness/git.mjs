// Real git repositories for fixtures (Plan §2, resource G). Test-side git runs
// with a constructed environment so the developer's configuration never leaks in.

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
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

// Plant a hook in a repository, as a role that runs as the engine's user
// could (E25 item 3). Each time git runs it, the hook appends one line to
// `evidence`, a file outside the repository. `where` is 'hooks' (the
// repository's own hooks directory) or 'hooksPath' (a directory `dir`
// outside the repository, which the repository's configuration names as
// core.hooksPath).
export function plantHook(repo, name, evidence, { where = 'hooks', dir } = {}) {
  if (!['hooks', 'hooksPath'].includes(where)) throw new Error(`unknown hook place ${where}`);
  const hooks = where === 'hooks' ? join(repo, '.git', 'hooks') : dir;
  mkdirSync(hooks, { recursive: true });
  const file = join(hooks, name);
  writeFileSync(file, `#!/bin/sh\necho "${name} ran: pid $$ in $(pwd) with HOME=$HOME" >> '${evidence}'\n`);
  chmodSync(file, 0o755);
  if (where === 'hooksPath') git(repo, ['config', 'core.hooksPath', hooks]);
  return file;
}

// Name a program in the repository's own configuration as `core.fsmonitor`,
// as a role that runs as the engine's user could through its linked worktree
// (E27 item 4). Git runs such a program, with a version and a token, whenever
// it refreshes an index of that repository: a checkout into a new worktree
// does. The program is written into `dir`, outside the repository. Each time
// git runs it, it appends one line to `evidence`, which names the git command
// that ran it, and answers as the hook protocol (version 2) asks: a token,
// then "/", which git takes as "everything may have changed". Returns the
// program's path.
export function plantFsmonitor(repo, evidence, { dir }) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'fsmonitor');
  writeFileSync(
    file,
    `#!/bin/sh\necho "fsmonitor ran: pid $$ in $(pwd) with HOME=$HOME, run by: $(tr '\\0' ' ' < /proc/$PPID/cmdline)" >> '${evidence}'\nprintf 'fixture-token\\0/\\0'\n`,
  );
  chmodSync(file, 0o755);
  git(repo, ['config', 'core.fsmonitor', file]);
  return file;
}
