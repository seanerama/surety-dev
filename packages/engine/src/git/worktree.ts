// Run workspaces as detached worktrees (D1 §7.3), and the probes the
// journal uses for the two worktree journal kinds (D1 §7.10; correction 14;
// SEAM.md §45). A probe reads the repository's worktree metadata and the
// owned path directly, because `git worktree list` leaves out, without an
// error, a worktree whose metadata it cannot read; and it makes one git call
// first, so that a repository that does not answer is `unknown`, never
// "nothing there".

import { lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';

import { readRegular } from '../invoke/sandbox/volatile.js';
import { basename, dirname, join, resolve } from 'node:path';

import { syncDirectory, syncTree } from '../durable.js';
import { type GitContext, SHA, git, gitOk, repoContext, worktreeContext } from './exec.js';
import { listWorktrees, readHeadFile } from './repo.js';

export type ProbeOutcome = 'absent' | 'applied' | 'partial' | 'conflicting' | 'unknown';

const SAFE_BRANCH = /^[^\0\n]+$/;

// The commit a branch points at, or null if it cannot be read.
export async function branchHead(ctx: GitContext, branch: string): Promise<string | null> {
  if (!SAFE_BRANCH.test(branch)) return null;
  const r = await git(ctx, ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${branch}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && SHA.test(sha) ? sha : null;
}

// A path with its symbolic links resolved, as git prints a worktree. The part
// that does not exist (a removed worktree) is kept as given, under its
// nearest existing ancestor resolved. null if no ancestor can be resolved.
export function canonicalPath(path: string): string | null {
  let head = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return null;
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

const samePath = (a: string, b: string): boolean => a === b || (canonicalPath(a) ?? a) === (canonicalPath(b) ?? b);

// The repository's metadata directory for a worktree at `path`: the entry
// under .git/worktrees whose `gitdir` file names `<path>/.git`. null if there
// is none; 'unknown' if the metadata cannot be read.
export function worktreeMetadata(repo: string, path: string): string | null | 'unknown' {
  const dir = join(repo, '.git', 'worktrees');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unknown';
  }
  for (const name of names) {
    const file = join(dir, name, 'gitdir');
    let text: string;
    try {
      const st = lstatSync(file);
      if (!st.isFile()) continue;
      text = readSmall(file).trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return 'unknown';
    }
    if (samePath(dirname(text), path)) return join(dir, name);
  }
  return null;
}

// What is at the owned path: nothing; a directory whose .git file links it to
// `metadata` (or into the repository's worktrees directory, when `metadata`
// is null); something else; or unreadable.
type Occupant = 'none' | 'linked' | 'foreign' | 'unknown';

function occupant(repo: string, path: string, metadata: string | null): Occupant {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'none' : 'unknown';
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return 'foreign';
  const dotGit = join(path, '.git');
  let text: string;
  try {
    const g = lstatSync(dotGit);
    if (!g.isFile()) return 'foreign';
    text = readSmall(dotGit).trim();
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'foreign' : 'unknown';
  }
  if (!text.startsWith('gitdir: ')) return 'foreign';
  const link = text.slice('gitdir: '.length).trim();
  if (metadata !== null) return samePath(link, metadata) ? 'linked' : 'foreign';
  return samePath(dirname(link), join(repo, '.git', 'worktrees')) ? 'linked' : 'foreign';
}

// Is the worktree's checkout whole: HEAD detached at `base`, every tracked
// file there and unmodified? null if that cannot be read.
async function checkoutComplete(repo: string, metadata: string, path: string, base: string): Promise<boolean | null> {
  const head = readHeadFile(metadata);
  if (head === null) return null;
  if (!('detached' in head) || head.detached !== base) return false;
  const status = await git(worktreeContext(repo, metadata, path), ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=all']);
  if (status.code !== 0) return status.timedOut ? null : false;
  return status.stdout === '';
}

// The repository answers: one git call that reads its configuration.
async function answers(repo: string): Promise<boolean> {
  return (await listWorktrees(repoContext(repo))) !== null;
}

// The probe of a `worktree_add` (contract `probe.kinds.worktree_add`).
export async function probeAdd(repo: string, path: string, base: string): Promise<ProbeOutcome> {
  if (!(await answers(repo))) return 'unknown';
  const metadata = worktreeMetadata(repo, path);
  if (metadata === 'unknown') return 'unknown';
  const here = occupant(repo, path, metadata);
  if (here === 'unknown') return 'unknown';
  if (here === 'foreign') return 'conflicting';
  if (here === 'none') return metadata === null ? 'absent' : 'partial';
  if (metadata === null) return 'partial';
  const whole = await checkoutComplete(repo, metadata, path, base);
  if (whole === null) return 'unknown';
  return whole ? 'applied' : 'partial';
}

// The probe of a `worktree_remove` (contract `probe.kinds.worktree_remove`).
export async function probeRemove(repo: string, path: string): Promise<ProbeOutcome> {
  if (!(await answers(repo))) return 'unknown';
  const metadata = worktreeMetadata(repo, path);
  if (metadata === 'unknown') return 'unknown';
  const here = occupant(repo, path, metadata);
  if (here === 'unknown') return 'unknown';
  if (here === 'foreign') return 'conflicting';
  if (here === 'none') return metadata === null ? 'applied' : 'partial';
  return metadata === null ? 'partial' : 'absent';
}

// `git worktree add --detach <path> <base>`, in the two steps git itself
// takes: the worktree is registered with no checkout, which runs nothing a
// repository could name, and then checked out by `reset --hard` in it, as
// `worktree add` does in its own child, with every filter driver git reports
// for that worktree switched off (exec.ts). Returns whether both reported
// success, or 'timeout' when one was killed at its deadline.
export async function addWorktree(repo: string, path: string, base: string, operation: string): Promise<'ok' | 'failed' | 'timeout'> {
  if (!SHA.test(base) || !path.startsWith('/')) return 'failed';
  const r = await git(repoContext(repo), ['worktree', 'add', '--no-checkout', '--detach', '--', path, base], { operation });
  if (r.timedOut) return 'timeout';
  if (r.code !== 0) return 'failed';
  const metadata = worktreeMetadata(repo, path);
  if (typeof metadata !== 'string') return 'failed';
  const checkout = await git(worktreeContext(repo, metadata, path), ['reset', '--hard', '--quiet', '--no-recurse-submodules'], { operation });
  if (checkout.timedOut) return 'timeout';
  if (checkout.code !== 0) return 'failed';
  // git syncs none of what `worktree add` writes: the checked-out files, the
  // workspace's .git file, the worktree's metadata (SEAM.md §60). The engine
  // syncs them before the journal records the effect, so that a workspace
  // the store says exists survives a power loss as git made it. A sync that
  // fails throws: whether the effect is durable is then unknown, and the
  // journal treats the attempt as ambiguous.
  syncTree(path);
  syncTree(metadata);
  syncDirectory(dirname(metadata));
  syncDirectory(dirname(path));
  return 'ok';
}

// `git worktree remove --force --force <path>`: the run's files go with it
// (D1 §4.5 step 6).
export async function removeWorktree(repo: string, path: string, operation: string): Promise<'ok' | 'failed' | 'timeout'> {
  if (!path.startsWith('/')) return 'failed';
  const r = await git(repoContext(repo), ['worktree', 'remove', '--force', '--force', '--', path], { operation });
  if (r.timedOut) return 'timeout';
  return r.code === 0 ? 'ok' : 'failed';
}

// Remove what is verifiably the operation's own residue at `path`: the
// repository's metadata for that path, and a directory there whose .git file
// links it into the repository's worktrees. Nothing else is touched.
export function removeResidue(repo: string, path: string): 'ok' | 'unknown' | 'foreign' {
  const metadata = worktreeMetadata(repo, path);
  if (metadata === 'unknown') return 'unknown';
  const here = occupant(repo, path, metadata);
  if (here === 'unknown') return 'unknown';
  if (here === 'foreign') return 'foreign';
  try {
    if (here === 'linked') rmSync(path, { recursive: true, force: true });
    if (metadata !== null) rmSync(metadata, { recursive: true, force: true });
  } catch {
    return 'unknown';
  }
  return 'ok';
}

// The worktree's own metadata directory and .git link, as the engine finds
// them right after it has added the worktree.
export function workspaceLink(repo: string, path: string): { adminDir: string; gitlink: string } | null {
  const metadata = worktreeMetadata(repo, path);
  if (metadata === null || metadata === 'unknown') return null;
  try {
    return { adminDir: metadata, gitlink: readSmall(join(path, '.git')) };
  } catch {
    return null;
  }
}

export { gitOk };

// A small file a role's workspace holds (its .git link, a worktree's gitdir),
// read never through a link, only a regular file, at most 64 KiB; throws
// ENOENT when absent and an error otherwise, as readFileSync would.
function readSmall(path: string): string {
  const r = readRegular(dirname(path), basename(path), 64 * 1024);
  if (r.state === 'read') return r.bytes.toString('utf8');
  if (r.state === 'absent') throw Object.assign(new Error(`${path}: absent`), { code: 'ENOENT' });
  throw Object.assign(new Error(`${path}: ${r.detail}`), { code: 'EINVAL' });
}
