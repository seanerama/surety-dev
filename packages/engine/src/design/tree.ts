// The design tree as git holds it at a revision (D7 §5.1): every blob under
// `.surety/design/`, its bytes and its blob id, read with git and never from
// a role's workspace or reply. Main thread only; no transaction is held.

import { git, repoContext } from '../git/exec.js';
import { listTree, treeOf } from '../git/repo.js';
import { DESIGN_ROOT } from './inventory.js';

export interface DesignTreeAt {
  // path relative to .surety/design/ → bytes, and → blob id.
  files: Map<string, Buffer>;
  blobs: Record<string, string>;
  // The git tree id of `.surety/design/` at the revision (D7 A.3
  // `design_revisions.tree_blob`; SEAM.md §501), null with no such tree.
  tree: string | null;
}

export async function designTreeAt(repo: string, rev: string): Promise<DesignTreeAt | null> {
  const ctx = repoContext(repo);
  const tree = await treeOf(ctx, rev);
  const entries = tree === null ? null : await listTree(ctx, tree);
  if (entries === null) return null;
  const files = new Map<string, Buffer>();
  const blobs: Record<string, string> = {};
  for (const e of [...entries.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    if (e.type !== 'blob' || !e.path.startsWith(DESIGN_ROOT)) continue;
    const r = await git(ctx, ['cat-file', 'blob', e.oid]);
    if (r.code !== 0) return null;
    const rel = e.path.slice(DESIGN_ROOT.length);
    files.set(rel, r.bytes);
    blobs[rel] = e.oid;
  }
  const t = await git(ctx, ['rev-parse', '--verify', '--quiet', `${rev}:${DESIGN_ROOT.replace(/\/$/, '')}`]);
  const designTree = t.code === 0 && /^[0-9a-f]{40}$/.test(t.stdout.trim()) ? t.stdout.trim() : null;
  return { files, blobs, tree: designTree };
}

// One blob's bytes at a revision, or null.
export async function blobAt(repo: string, rev: string, path: string): Promise<Buffer | null> {
  const r = await git(repoContext(repo), ['cat-file', 'blob', `${rev}:${path}`]);
  return r.code === 0 ? r.bytes : null;
}
