// The probe suite's fixture repository (D2 A.6 P3 to P5, P19): a small
// repository the engine keeps under its own home, `<home>/sandbox/
// probe-fixture/`, with a linked worktree the probe sandbox's workspace is
// built on, a sentinel file the role reads as its control, and two protected
// roots (a directory and a file). Made once with engine git, checked at
// every start, and made again if anything of it is not as made. Nothing here
// touches a repository of the operator's.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { git, gitOk, repoContext } from '../../git/exec.js';
import { workspaceLink } from '../../git/worktree.js';

export interface ProbeFixture {
  dir: string;
  repo: string;
  worktree: string;
  adminDir: string;
  head: string;
  sentinel: { path: string; content: string };
  protectedRoots: string[];
  protectedFiles: string[];
}

const FIXTURE = 'probe-fixture';
const IDENTITY = { GIT_AUTHOR_NAME: 'surety', GIT_AUTHOR_EMAIL: 'surety@localhost', GIT_COMMITTER_NAME: 'surety', GIT_COMMITTER_EMAIL: 'surety@localhost' };

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

async function make(dir: string): Promise<ProbeFixture | null> {
  const repo = join(dir, 'repo');
  const worktree = join(dir, 'ws');
  mkdirSync(join(repo, '.surety', 'checks'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  const content = `surety probe sentinel ${randomBytes(12).toString('hex')}\n`;
  writeFileSync(join(repo, 'sentinel.txt'), content);
  writeFileSync(join(repo, 'PROTECTED.md'), 'a protected file of the probe fixture\n');
  writeFileSync(join(repo, '.surety', 'checks', 'protected-policy.json'), `${JSON.stringify({ protected_paths: ['.surety/checks/', 'PROTECTED.md'] }, null, 2)}\n`);
  writeFileSync(join(repo, '.surety', 'checks', 'check.txt'), 'a protected check of the probe fixture\n');
  writeFileSync(join(repo, 'src', 'source.txt'), 'a source file of the probe fixture\n');
  const ctx = repoContext(repo);
  if ((await git(ctx, ['init', '-q', '-b', 'main'])).code !== 0) return null;
  if ((await git(ctx, ['add', '-A'])).code !== 0) return null;
  if ((await git(ctx, ['commit', '-q', '-m', 'probe fixture'], { env: IDENTITY })).code !== 0) return null;
  const head = (await gitOk(ctx, ['rev-parse', 'HEAD']))?.trim();
  if (!head) return null;
  if ((await git(ctx, ['worktree', 'add', '--detach', worktree, head])).code !== 0) return null;
  writeFileSync(join(dir, 'fixture.json'), `${JSON.stringify({ head, sentinel: sha(content) })}\n`);
  return check(dir);
}

async function check(dir: string): Promise<ProbeFixture | null> {
  const repo = join(dir, 'repo');
  const worktree = join(dir, 'ws');
  let recorded: { head: string; sentinel: string };
  try {
    recorded = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8')) as typeof recorded;
  } catch {
    return null;
  }
  const link = workspaceLink(repo, worktree);
  if (link === null) return null;
  const head = (await gitOk(repoContext(repo), ['rev-parse', 'HEAD']))?.trim();
  if (head !== recorded.head) return null;
  let content: string;
  try {
    content = readFileSync(join(worktree, 'sentinel.txt'), 'utf8');
  } catch {
    return null;
  }
  if (sha(content) !== recorded.sentinel || !existsSync(join(worktree, 'PROTECTED.md')) || !existsSync(join(worktree, '.surety', 'checks', 'check.txt'))) return null;
  return {
    dir,
    repo,
    worktree,
    adminDir: link.adminDir,
    head,
    sentinel: { path: 'sentinel.txt', content },
    protectedRoots: ['.surety/checks/', 'PROTECTED.md'],
    protectedFiles: ['.surety/checks/check.txt', '.surety/checks/protected-policy.json', 'PROTECTED.md'],
  };
}

// The fixture, as made or checked now; null if it cannot be made.
export async function probeFixture(home: string): Promise<ProbeFixture | null> {
  const sandbox = join(home, 'sandbox');
  const dir = join(sandbox, FIXTURE);
  const found = existsSync(dir) ? await check(dir) : null;
  if (found) return found;
  // Not as made: removed and made again. The path is the engine home's own
  // `sandbox/probe-fixture`, built from constants.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return make(dir);
}
