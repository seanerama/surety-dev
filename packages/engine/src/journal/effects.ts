// The effect, the probe and the bounded remainder of each journal kind (D1
// §7.10; correction 14; ../contract/journal.json `kinds` and `probe`). The
// effect is the one git mutation the operation exists for; the probe says
// what git holds of it now, whether or not a receipt survived:
// absent, applied, partial, conflicting or unknown. A probe never takes a
// read it could not make for absence.

import { lstatSync } from 'node:fs';

import { SHA, ZERO_OID, git, gitOk, repoContext } from '../git/exec.js';
import { listWorktrees, objectExists, readRef } from '../git/repo.js';
import { addWorktree, canonicalPath, probeAdd, probeRemove, removeResidue, removeWorktree } from '../git/worktree.js';
import type { CommitInputs, RefInputs } from '../store/transitions/finalize.js';
import type { OpDetail, ProbeOutcome } from '../store/transitions/journal.js';

export type EffectResult = 'ok' | 'failed' | 'timeout';

export interface Refusal {
  reason: string;
  text: string;
  worktree?: string;
}

// The worktree, other than one the engine owns, that has `branch` checked
// out; null if none; 'unknown' if the list cannot be read. The engine owns
// the workspaces under its home (SEAM.md §30).
export async function branchCheckedOutAt(repo: string, branch: string, home: string): Promise<string | null | 'unknown'> {
  const list = await listWorktrees(repoContext(repo));
  if (list === null) return 'unknown';
  const owned = canonicalPath(`${home}/workspaces`) ?? `${home}/workspaces`;
  for (const w of list) {
    if (w.branch !== `refs/heads/${branch}`) continue;
    const at = canonicalPath(w.path) ?? w.path;
    if (at.startsWith(`${owned}/`)) continue;
    return w.path;
  }
  return null;
}

// What must hold immediately before the effect is attempted. A refusal is
// recorded as the operation failing before any effect.
export async function precondition(op: OpDetail, home: string): Promise<Refusal | null> {
  if (op.kind === 'worktree_add') {
    try {
      lstatSync(op.payload.path!);
      return { reason: 'occupied', text: `something is already at the workspace path ${op.payload.path}; it is not the engine's and is left alone` };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { reason: 'occupied', text: `the workspace path ${op.payload.path} cannot be examined` };
    }
    return null;
  }
  if (op.kind === 'ref_update') {
    const inputs = op.inputs as unknown as RefInputs;
    if (inputs.ref_kind !== 'integration') return null;
    const branch = op.payload.ref!.slice('refs/heads/'.length);
    const at = await branchCheckedOutAt(op.payload.repo, branch, home);
    if (at === 'unknown') return null; // the effect itself will meet what cannot be read
    if (at !== null) {
      return {
        reason: 'integration_branch_checked_out',
        worktree: at,
        text: `the integration branch ${branch} is checked out in the worktree ${at}, which the engine does not own; switch that worktree to another branch, or detach it`,
      };
    }
  }
  return null;
}

async function updateRef(repo: string, ref: string, next: string, old: string | null | undefined, operation: string): Promise<EffectResult> {
  const r = await git(repoContext(repo), ['update-ref', '-m', 'surety: journaled ref update', '--no-deref', ref, next, old ?? ZERO_OID], { operation });
  if (r.timedOut) return 'timeout';
  return r.code === 0 ? 'ok' : 'failed';
}

async function writeCommit(repo: string, inputs: CommitInputs & { content: string }, operation: string): Promise<EffectResult> {
  const r = await git(repoContext(repo), ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: inputs.content, operation });
  if (r.timedOut) return 'timeout';
  if (r.code !== 0 || r.stdout.trim() !== inputs.sha) return 'failed';
  return 'ok';
}

// The whole effect of an operation.
export async function effect(op: OpDetail): Promise<EffectResult> {
  const { repo } = op.payload;
  switch (op.kind) {
    case 'worktree_add':
      return addWorktree(repo, op.payload.path!, op.payload.base!, op.id);
    case 'worktree_remove':
      return removeWorktree(repo, op.payload.path!, op.id);
    case 'commit_tree': {
      const inputs = op.inputs as unknown as CommitInputs & { content: string };
      const made = await writeCommit(repo, inputs, op.id);
      if (made !== 'ok') return made;
      return updateRef(repo, inputs.keep_ref, inputs.sha, null, op.id);
    }
    case 'ref_update':
      return updateRef(repo, op.payload.ref!, op.payload.new_oid!, op.payload.old_oid ?? null, op.id);
  }
}

// The bounded remainder of a partial effect (contract `complete`): a commit
// whose object exists is published under its keep ref; a removal finishes
// with the owned residue.
export async function completeRemainder(op: OpDetail): Promise<EffectResult> {
  if (op.kind === 'commit_tree') {
    const inputs = op.inputs as unknown as CommitInputs;
    return updateRef(op.payload.repo, inputs.keep_ref, inputs.sha, null, op.id);
  }
  if (op.kind === 'worktree_remove') {
    const done = removeResidue(op.payload.repo, op.payload.path!);
    return done === 'ok' ? 'ok' : 'failed';
  }
  return 'failed';
}

// What remains of a partial effect, declared (SEAM.md §44).
export function remainingScope(op: OpDetail): Record<string, unknown> {
  if (op.kind === 'commit_tree') return { publish: (op.inputs as unknown as CommitInputs).keep_ref, commit: (op.inputs as unknown as CommitInputs).sha };
  if (op.kind === 'worktree_remove') return { remove_residue: op.payload.path };
  return { remaining: 'declared' };
}

// The probe of each kind (contract `probe.kinds`).
export async function probe(op: OpDetail): Promise<ProbeOutcome> {
  const { repo } = op.payload;
  switch (op.kind) {
    case 'worktree_add':
      return probeAdd(repo, op.payload.path!, op.payload.base!);
    case 'worktree_remove':
      return probeRemove(repo, op.payload.path!);
    case 'ref_update': {
      const read = await readRef(repoContext(repo), op.payload.ref!);
      if (read.state === 'unknown') return 'unknown';
      const old = op.payload.old_oid ?? null;
      if (read.state === 'missing') return old === null ? 'absent' : 'conflicting';
      if (read.oid === op.payload.new_oid) return 'applied';
      if (read.oid === old) return 'absent';
      return 'conflicting';
    }
    case 'commit_tree': {
      const inputs = op.inputs as unknown as CommitInputs;
      const ctx = repoContext(repo);
      const keep = await readRef(ctx, inputs.keep_ref);
      if (keep.state === 'unknown') return 'unknown';
      const exists = await objectExists(ctx, inputs.sha, inputs.parent);
      if (exists === null) return 'unknown';
      if (keep.state === 'ok') return keep.oid === inputs.sha && exists ? 'applied' : 'conflicting';
      return exists ? 'partial' : 'absent';
    }
  }
}

// Where a ref is now: its commit, null if it is gone, 'unknown' if it cannot
// be read.
export async function refNow(op: OpDetail): Promise<string | null | 'unknown'> {
  const read = await readRef(repoContext(op.payload.repo), op.payload.ref!);
  if (read.state === 'unknown') return 'unknown';
  return read.state === 'missing' ? null : read.oid;
}

// What the probe read, for the attempt's record.
export function readDescription(op: OpDetail): string {
  switch (op.kind) {
    case 'ref_update':
      return `read ${op.payload.ref}`;
    case 'commit_tree':
      return `read the commit ${(op.inputs as unknown as CommitInputs).sha} and ${(op.inputs as unknown as CommitInputs).keep_ref}`;
    default:
      return `read the worktree metadata and ${op.payload.path}`;
  }
}

// The id a commit's frozen content has, as git computes it, without writing it.
export async function commitId(repo: string, content: string): Promise<string | null> {
  const out = await gitOk(repoContext(repo), ['hash-object', '-t', 'commit', '--stdin'], { input: content });
  const sha = out?.trim() ?? '';
  return SHA.test(sha) ? sha : null;
}
