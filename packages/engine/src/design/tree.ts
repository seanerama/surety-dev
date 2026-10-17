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
  return { files, blobs };
}

// The design tree's size in a git tree (D7 §5.5; SEAM.md §493): every blob
// under `.surety/design/` (inventory, placeholders and binary files
// included), counted and summed from git's own sizes; nothing is read
// from a workspace. null when git could not say.
export async function designTreeSize(repo: string, tree: string): Promise<{ files: number; bytes: number } | null> {
  const r = await git(repoContext(repo), ['ls-tree', '-r', '-l', '-z', '--full-tree', tree, '--', DESIGN_ROOT]);
  if (r.code !== 0) return null;
  let files = 0;
  let bytes = 0;
  for (const record of r.stdout.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const [, type, , size] = record.slice(0, tab).trim().split(/\s+/);
    if (type !== 'blob') continue;
    const n = Number(size);
    if (!Number.isSafeInteger(n) || n < 0) return null;
    files += 1;
    bytes += n;
  }
  return { files, bytes };
}

// One blob's bytes at a revision, or null.
export async function blobAt(repo: string, rev: string, path: string): Promise<Buffer | null> {
  const r = await git(repoContext(repo), ['cat-file', 'blob', `${rev}:${path}`]);
  return r.code === 0 ? r.bytes : null;
}
