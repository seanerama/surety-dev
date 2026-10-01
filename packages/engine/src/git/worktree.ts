// Run workspaces as detached worktrees (D1 §7.3) and the probe of the
// worktree list that the journal uses to confirm an effect (D1 §7.10).

import { type GitContext, git } from './exec.js';

const SHA = /^[0-9a-f]{40}$/;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

// The commit a branch points at, or null if it cannot be read.
export async function branchHead(ctx: GitContext, branch: string): Promise<string | null> {
  if (!SAFE_BRANCH.test(branch) || branch.includes('..')) return null;
  const r = await git(ctx, ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${branch}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && SHA.test(sha) ? sha : null;
}

export interface WorktreeEntry {
  path: string;
  head: string | null;
  detached: boolean;
}

// Every registered worktree, or null if the list cannot be read.
export async function listWorktrees(ctx: GitContext): Promise<WorktreeEntry[] | null> {
  const r = await git(ctx, ['worktree', 'list', '--porcelain']);
  if (r.code !== 0) return null;
  const out: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), head: null, detached: false };
      out.push(current);
    } else if (current && line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (current && line === 'detached') current.detached = true;
  }
  return out;
}

export type EffectProbe = 'present' | 'absent' | 'ambiguous';

// Is a worktree registered at this path (at this base, when given)?
export async function probeWorktree(ctx: GitContext, path: string, base?: string): Promise<EffectProbe> {
  const list = await listWorktrees(ctx);
  if (list === null) return 'ambiguous';
  const entry = list.find((w) => w.path === path);
  if (!entry) return 'absent';
  if (base !== undefined && (entry.head !== base || !entry.detached)) return 'ambiguous';
  return 'present';
}

// `git worktree add --detach <path> <base>`; then the probe decides.
export async function addWorktree(ctx: GitContext, path: string, base: string): Promise<EffectProbe> {
  if (!SHA.test(base) || !path.startsWith('/')) return 'absent';
  const r = await git(ctx, ['worktree', 'add', '--detach', path, base]);
  if (r.timedOut) return 'ambiguous';
  return probeWorktree(ctx, path, base);
}

// `git worktree remove --force <path>`; then the probe decides. The run's
// files go with it: this is the discard of an abandoned run (D1 §4.5 step 6).
export async function removeWorktree(ctx: GitContext, path: string): Promise<EffectProbe> {
  if (!path.startsWith('/')) return 'ambiguous';
  const r = await git(ctx, ['worktree', 'remove', '--force', '--force', path]);
  if (r.timedOut) return 'ambiguous';
  const probe = await probeWorktree(ctx, path);
  // For a removal, `absent` is the effect having happened.
  return probe;
}
