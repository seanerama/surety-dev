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
import { rebaseTree } from '../git/rebase.js';
import { isAncestor } from '../git/repo.js';
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

// The tree a proposal is classified from (the driver's ruling on loop run 1,
// M444 #19 and L1-2, option (ii)). A proposal is the change from its base to
// its tree. Where its base holds the effective version (the effective
// revision is the base or an ancestor of it), that is its own tree. Where
// it does not (another proposal was applied after its base was taken), its
// own changes are rebased three-way onto the effective revision
// (git/rebase.ts, the application's own rebase): classified on its own
// tree, it would read as removing what the other added. A path the
// effective version changed another way is a conflict: the proposal is
// refused for repair. null: git could not answer, and nothing is decided.
export async function classifiedTree(
  repo: string,
  proposal: { base_revision: string; tree_id: string },
  effectiveRevision: string,
  scratch: string,
): Promise<{ tree: string } | { conflict: string } | null> {
  if (proposal.base_revision === effectiveRevision) return { tree: proposal.tree_id };
  const holds = await isAncestor(repoContext(repo), effectiveRevision, proposal.base_revision);
  if (holds === null) return null;
  if (holds) return { tree: proposal.tree_id };
  const rebased = await rebaseTree(repo, proposal.base_revision, proposal.tree_id, effectiveRevision, scratch);
  if (rebased === 'unknown') return null;
  return rebased.conflict !== null ? { conflict: rebased.conflict } : { tree: rebased.tree };
}
