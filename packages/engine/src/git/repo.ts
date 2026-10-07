// Reads of a repository that the journal's probes, integrity, validation and
// integration share (D1 §§7.2, 7.6, 7.10). Every read says when it could not
// be made: `unknown` is a value, never taken for "absent" or "clean".

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readlinkSync, rmSync } from 'node:fs';

import { readRegular } from '../invoke/sandbox/volatile.js';

const METADATA_FILE_MAX = 64 * 1024 * 1024;
import { basename, dirname, join } from 'node:path';

import { type GitContext, SHA, git, gitOk } from './exec.js';

export type RefRead = { state: 'ok'; oid: string } | { state: 'missing' } | { state: 'unknown' };

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

// Every ref of the repository with its object, or null if they cannot be read.
export async function readAllRefs(ctx: GitContext): Promise<Map<string, string> | null> {
  const out = await gitOk(ctx, ['for-each-ref', '--format=%(refname)%00%(objectname)']);
  if (out === null) return null;
  const refs = new Map<string, string>();
  for (const line of out.split('\n')) {
    if (line === '') continue;
    const at = line.indexOf('\0');
    if (at < 0) continue;
    refs.set(line.slice(0, at), line.slice(at + 1));
  }
  return refs;
}

// One ref: its object, verified absent, or unknown. `for-each-ref` skips a
// broken or unreadable loose ref and still exits 0, so a ref missing from
// the listing is `missing` only when its absence is verified (refAbsent);
// otherwise it is unknown, never taken for deleted (D3 §5 X1, N02).
export async function readRef(ctx: GitContext, ref: string): Promise<RefRead> {
  return (await readRefs(ctx, [ref]))?.get(ref) ?? { state: 'unknown' };
}

// The named refs, each read as readRef reads one, from one listing; null
// when the listing itself could not be made.
export async function readRefs(ctx: GitContext, names: string[]): Promise<Map<string, RefRead> | null> {
  const refs = await readAllRefs(ctx);
  if (refs === null) return null;
  const out = new Map<string, RefRead>();
  for (const name of names) {
    const oid = refs.get(name);
    if (oid !== undefined) out.set(name, { state: 'ok', oid });
    else out.set(name, (await refAbsent(ctx, name)) ? { state: 'missing' } : { state: 'unknown' });
  }
  return out;
}

const REF_FILE_MAX = 64 * 1024;
const PACKED_REFS_MAX = 64 * 1024 * 1024;

// Is the ref verifiably absent? Only if git resolves it to nothing, cleanly
// (`rev-parse --verify --quiet` exits 1 with nothing on its error stream),
// there is no loose file at its path in the common directory (no component
// of the path refused: a link, a non-directory, an unreadable entry), no
// packed-refs line names it, and the repository keeps no reftable. Any doubt
// is false: the ref's state is then unknown.
export async function refAbsent(ctx: GitContext, ref: string): Promise<boolean> {
  if (!/^refs\/[^\0\s]+$/.test(ref) || ref.split('/').some((p) => p === '' || p === '.' || p === '..')) return false;
  const r = await git(ctx, ['rev-parse', '--verify', '--quiet', '--end-of-options', ref]);
  if (r.code !== 1 || r.stderr.trim() !== '' || r.stdout.trim() !== '') return false;
  try {
    lstatSync(join(ctx.commonDir, 'reftable'));
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  if (readRegular(ctx.commonDir, ref, REF_FILE_MAX).state !== 'absent') return false;
  const packed = readRegular(ctx.commonDir, 'packed-refs', PACKED_REFS_MAX);
  if (packed.state === 'absent') return true;
  if (packed.state !== 'read') return false;
  for (const line of packed.bytes.toString('utf8').split('\n')) {
    if (line.startsWith('#') || line.startsWith('^')) continue;
    if (line.slice(line.indexOf(' ') + 1) === ref) return false;
  }
  return true;
}

// Does the object exist? null when the object store cannot be read. A
// missing object is told from an unreadable store by reading one that must
// exist (`known`) as well.
export async function objectExists(ctx: GitContext, oid: string, known?: string): Promise<boolean | null> {
  const r = await git(ctx, ['cat-file', '-e', oid]);
  if (r.code === 0) return true;
  if (r.code !== 1) return null;
  if (known !== undefined) {
    const k = await git(ctx, ['cat-file', '-e', known]);
    if (k.code !== 0) return null;
  }
  return false;
}

export async function treeOf(ctx: GitContext, rev: string): Promise<string | null> {
  const out = await gitOk(ctx, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{tree}`]);
  const t = out?.trim() ?? '';
  return SHA.test(t) ? t : null;
}

// Is `ancestor` an ancestor of (or equal to) `descendant`? null if unknown.
export async function isAncestor(ctx: GitContext, ancestor: string, descendant: string): Promise<boolean | null> {
  const r = await git(ctx, ['merge-base', '--is-ancestor', ancestor, descendant]);
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  return null;
}

export async function mergeBase(ctx: GitContext, a: string, b: string): Promise<string | null> {
  const out = await gitOk(ctx, ['merge-base', a, b]);
  const t = out?.trim() ?? '';
  return SHA.test(t) ? t : null;
}

export interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  path: string;
}

// Every entry of a tree, recursively: {path: entry}.
export async function listTree(ctx: GitContext, tree: string): Promise<Map<string, TreeEntry> | null> {
  const out = await gitOk(ctx, ['ls-tree', '-r', '-z', '--full-tree', tree]);
  if (out === null) return null;
  const entries = new Map<string, TreeEntry>();
  for (const record of out.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    entries.set(path, { mode: mode!, type: type!, oid: oid!, path });
  }
  return entries;
}

export interface Change {
  status: string;
  path: string;
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
}

// What changed between two trees, renames as a deletion and an addition.
export async function diffTrees(ctx: GitContext, from: string, to: string): Promise<Change[] | null> {
  const out = await gitOk(ctx, ['diff-tree', '-r', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--raw', '--full-index', from, to]);
  if (out === null) return null;
  const fields = out.split('\0');
  const changes: Change[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i]!;
    if (!meta.startsWith(':')) continue;
    const [oldMode, newMode, oldOid, newOid, status] = meta.slice(1).split(' ');
    changes.push({ status: status!, path: fields[i + 1]!, oldMode: oldMode!, newMode: newMode!, oldOid: oldOid!, newOid: newOid! });
  }
  return changes;
}

// The sizes of blobs, by object id.
export async function blobSizes(ctx: GitContext, oids: string[]): Promise<Map<string, number> | null> {
  if (oids.length === 0) return new Map();
  const out = await gitOk(ctx, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], { input: `${oids.join('\n')}\n` });
  if (out === null) return null;
  const sizes = new Map<string, number>();
  for (const line of out.split('\n')) {
    const [oid, size] = line.split(' ');
    if (oid && size && /^\d+$/.test(size)) sizes.set(oid, Number(size));
  }
  return sizes;
}

export async function catBlob(ctx: GitContext, rev: string, path: string): Promise<string | null> {
  return gitOk(ctx, ['cat-file', 'blob', `${rev}:${path}`]);
}

// A blob written to the object store from `content`.
export async function writeBlob(ctx: GitContext, content: string): Promise<string | null> {
  const out = await gitOk(ctx, ['hash-object', '-w', '--stdin'], { input: content });
  const t = out?.trim() ?? '';
  return SHA.test(t) ? t : null;
}

export interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  prunable: boolean;
}

// Every worktree the repository lists, its own work tree included, or null
// if the list cannot be read. A worktree whose metadata cannot be read is
// silently left out by git: this list is never evidence that one is absent.
export async function listWorktrees(ctx: GitContext): Promise<WorktreeEntry[] | null> {
  const out = await gitOk(ctx, ['worktree', 'list', '--porcelain']);
  if (out === null) return null;
  const list: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), head: null, branch: null, detached: false, prunable: false };
      list.push(current);
    } else if (current && line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (current && line.startsWith('branch ')) current.branch = line.slice(7);
    else if (current && line === 'detached') current.detached = true;
    else if (current && line.startsWith('prunable')) current.prunable = true;
  }
  return list;
}

// The baseline of a checkout (D1 §7.6): its HEAD, its index's content (the
// staged entries, not their stat data) and the tree of its tracked content:
// what `git commit -a` would commit (SEAM.md §111), every path the index
// lists refreshed from the work tree, so a staged addition is in it, a staged
// version superseded on disk gives way to the disk's, a tracked file deleted
// from disk is not, and an untracked file is not. Computed on a copy of the
// checkout's index: the checkout's own index is not written. null when any
// of it cannot be read.
export interface Baseline {
  head: string;
  index_hash: string;
  tracked_tree_hash: string;
}

export async function checkoutBaseline(ctx: GitContext, scratch: string): Promise<Baseline | null> {
  const headRaw = await gitOk(ctx, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const head = headRaw?.trim() ?? '';
  if (!SHA.test(head)) return null;
  const staged = await gitOk(ctx, ['ls-files', '--stage', '-z']);
  if (staged === null) return null;
  // The tracked content as `git commit -a` would take it: a scratch index
  // holding the real index's entries with no stat data, so that every path
  // it lists is hashed again from the work tree. A copy that kept the stat
  // data would trust a file rewritten within the same second at the same
  // size, which git itself judges by the real index's own timestamp.
  const index = join(scratch, `baseline-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    // Where the checkout's index is, as git resolves it (a linked worktree's
    // `.git` may be a file naming its metadata directory). A checkout with no
    // index file yet holds what HEAD holds.
    const at = (await gitOk(ctx, ['rev-parse', '--path-format=absolute', '--git-path', 'index']))?.trim() ?? '';
    if (at === '') return null;
    let present: boolean;
    try {
      lstatSync(at);
      present = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      present = false;
    }
    if (!present) {
      if ((await gitOk(ctx, ['read-tree', 'HEAD'], { env })) === null) return null;
    } else if (staged !== '' && (await gitOk(ctx, ['update-index', '-z', '--index-info'], { env, input: staged })) === null) return null;
    if ((await gitOk(ctx, ['add', '-u', '--', '.'], { env })) === null) return null;
    const tree = (await gitOk(ctx, ['write-tree'], { env }))?.trim() ?? '';
    if (!SHA.test(tree)) return null;
    return { head, index_hash: sha256(staged), tracked_tree_hash: tree };
  } finally {
    rmSync(index, { force: true });
  }
}

// The index hash (as checkoutBaseline computes it) an index read from `tree`
// has, computed on an index of its own: nothing of the checkout is written.
export async function treeIndexHash(ctx: GitContext, tree: string, scratch: string): Promise<string | null> {
  const index = join(scratch, `tree-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    if ((await gitOk(ctx, ['read-tree', tree], { env })) === null) return null;
    const staged = await gitOk(ctx, ['ls-files', '--stage', '-z'], { env });
    return staged === null ? null : sha256(staged);
  } finally {
    rmSync(index, { force: true });
  }
}

// What a worktree's HEAD file says: a detached commit, a branch, or null if
// it cannot be read.
export function readHeadFile(gitDir: string): { detached: string } | { branch: string } | null {
  try {
    const head = readRegular(gitDir, 'HEAD', 64 * 1024);
    if (head.state !== 'read') return null;
    const text = head.bytes.toString('utf8').trim();
    if (SHA.test(text)) return { detached: text };
    if (text.startsWith('ref: ')) return { branch: text.slice(5).trim() };
    return null;
  } catch {
    return null;
  }
}

// The hash of a file's bytes, or of what a directory holds (names and file
// contents), for the "git metadata" a role must leave alone (correction 15).
// null: absent. A read that fails for another reason is 'unreadable'.
export function contentHash(path: string): string | null {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return `link:${readlinkSync(path)}`;
    if (st.isFile()) {
      // Never through a link, a regular file only, bounded (the review's S3).
      const r = readRegular(dirname(path), basename(path), METADATA_FILE_MAX);
      if (r.state === 'read') return sha256(r.bytes);
      return `unhashed:${r.state === 'refused' ? r.reason : r.state}:${st.size}`;
    }
    if (st.isDirectory()) {
      const parts = readdirSync(path)
        .sort()
        .map((name) => `${name}:${contentHash(join(path, name)) ?? 'none'}`);
      return sha256(parts.join('\n'));
    }
    return `kind:${st.mode}`;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable';
  }
}
