// The adopted application-source projection (D6 §8.1 step 5; B11; A.3
// `conformance_source_digest`): a revision's tree outside `.surety/`, every
// entry by path, mode and object, hashed. Conformance is equality of this
// projection between A and the candidate, never equality of HEAD to A: the
// engine's own intent and protected commits live under `.surety/` and are
// the projection's only exclusion. A read that fails is null, never a digest
// (unknown is not equal to anything).

import { createHash } from 'node:crypto';

import { type GitContext, gitOk } from '../git/exec.js';

export const PROJECTION_EXCLUDED = '.surety/';

// The entries of `rev`'s tree outside `.surety/`, as `ls-tree -r -z` gives
// them ("<mode> <type> <oid>\t<path>"), sorted; null when unreadable.
export async function projectionEntries(ctx: GitContext, rev: string): Promise<string[] | null> {
  const out = await gitOk(ctx, ['ls-tree', '-r', '-z', '--full-tree', rev]);
  if (out === null) return null;
  const entries = out.split('\0').filter((e) => e.length > 0);
  for (const e of entries) if (!/^[0-7]{6} (blob|tree|commit) [0-9a-f]{40,64}\t/.test(e)) return null;
  return entries.filter((e) => !e.slice(e.indexOf('\t') + 1).startsWith(PROJECTION_EXCLUDED)).sort();
}

export const projectionDigestOf = (entries: readonly string[]): string => createHash('sha256').update(entries.join('\0')).digest('hex');

export async function projectionDigest(ctx: GitContext, rev: string): Promise<string | null> {
  const entries = await projectionEntries(ctx, rev);
  return entries === null ? null : projectionDigestOf(entries);
}
