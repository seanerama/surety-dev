// What the classifier reads (D3 §3.1): the discovery of the effective
// version's tree (P0) and of the proposal's tree (P1), and the entries of
// both trees under the roots of either, so that a file under a root one of
// them removes or adds is compared as the same path. Engine git only
// (`ls-tree`, `cat-file`), which runs no repository code and contacts no
// remote (E25 item 3, E29 item 1, E37 item 1).
//
// Main thread only: this reads git. The classification itself is the store
// transaction's (store/transitions/classification.ts), against the index as
// it stands when it commits.

import { repoContext } from '../git/exec.js';
import { protectedManifest } from '../protected/set.js';
import type { ClassifySide } from './classify.js';
import { discover } from './discovery.js';

export interface ClassifyInputs {
  p0: ClassifySide;
  p1: ClassifySide;
}

// null when git cannot read either tree: an unread tree is never an empty
// one, and nothing is classified from it.
export async function classificationInputs(repo: string, effectiveRevision: string, proposalTree: string): Promise<ClassifyInputs | null> {
  const d0 = await discover(repo, effectiveRevision);
  if (d0 === null) return null;
  const d1 = await discover(repo, proposalTree);
  if (d1 === null) return null;
  const roots = [...new Set([...d0.governed.protected_paths, ...d1.governed.protected_paths])].sort();
  const ctx = repoContext(repo);
  const e0 = await protectedManifest(ctx, effectiveRevision, roots);
  if (e0 === null) return null;
  const e1 = await protectedManifest(ctx, proposalTree, roots);
  if (e1 === null) return null;
  return { p0: { discovery: d0, entries: e0 }, p1: { discovery: d1, entries: e1 } };
}
