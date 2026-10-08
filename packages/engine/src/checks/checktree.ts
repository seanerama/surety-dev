// The check tree (D3 §2.4): what an execution's workspace is made from, for
// one (project, source revision, protected version), under
// `$SURETY_HOME/checktrees/<project>/<tree>/`, engine-owned and never named
// by policy.
//
//   src/        the candidate-source projection: every tracked file of the
//               revision but those under the version's roots and the
//               governed file, wherever it lies; the overlay's lower layer.
//   inputs/<m>/ the projection of one input manifest, exactly its members
//               at their paths (B01; D3 §§1.3, 2.2): one directory per
//               distinct manifest of the version's checks, named by the
//               manifest's hash; the `check` profile mounts it read-only.
//
// Modes (E89 item 2; the driver's ruling 1 for slice 17): the source keeps
// its git modes (0644, 0755), so that a check may overwrite an existing
// source file in its discarded overlay, the overlay checking the lower
// file's mode with the check's own credentials; the tree is reachable only
// by the engine and, in a domain, only as that overlay's lower layer, which
// is never written. Each projection is read-only: files 0444 or 0555,
// directories 0555.
//
// With engine git only (`ls-tree`, `cat-file`): every file is its blob's
// bytes exactly, whatever any attributes or configuration say; nothing writes
// a `.git`, runs repository code or contacts a remote. A tree is built in a
// private staging directory and becomes visible only once complete; a failed
// build removes its partial state. It is shared by the executions of its
// triple and removed when none still needs it.
//
// Bounds (D3 §2.4; T17): entries (`checktree_max_entries`), bytes per tree
// (`checktree_max_bytes`) and bytes of all trees on the host
// (`checktrees_max_bytes`), each admitted from the blobs' sizes before
// anything is written; git's own deadlines. Main thread only.

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { git, repoContext } from '../git/exec.js';
import { checkLimits } from './limits.js';
import { GOVERNED_FILE, type ManifestEntry, isProtectedPath } from './schema.js';

export interface CheckTree {
  root: string;
  src: string;
  // The projection directory of each manifest, by its key.
  inputs: string;
}

// The name of a manifest's projection directory.
export const manifestKey = (manifest: readonly ManifestEntry[]): string => createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 32);
export const projectionOf = (tree: CheckTree, manifest: readonly ManifestEntry[]): string => join(tree.inputs, manifestKey(manifest));

const PROJECT_ID = /^proj_[0-9A-Z]{26}$/;
const TREE_NAME = /^[0-9a-f]{40}-pv_[0-9A-Z]{26}$/;

export const checktreesDir = (home: string): string => join(home, 'checktrees');

export class MaterializationFailed extends Error {}

function treePath(home: string, project: string, revision: string, version: string): string {
  const name = `${revision}-${version}`;
  if (!PROJECT_ID.test(project) || !TREE_NAME.test(name)) throw new MaterializationFailed(`not a check tree's name: ${project}/${name}`);
  return join(checktreesDir(home), project, name);
}

// A projection read-only (B01): files 0444 or 0555, directories 0555. The
// source half keeps its modes (the head of this file).
function sealProjection(dir: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) sealProjection(p);
    else chmodSync(p, st.mode & 0o111 ? 0o555 : 0o444);
  }
  chmodSync(dir, 0o555);
}

function unseal(dir: string): void {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return;
  }
  if (!st.isDirectory() || st.isSymbolicLink()) return;
  chmodSync(dir, 0o755);
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = lstatSync(p);
    if (s.isDirectory()) unseal(p);
    else if (!s.isSymbolicLink()) chmodSync(p, 0o644);
  }
}

// Remove a directory of the engine's own under `checktrees/`, never anything
// else: the path must resolve inside this home's `checktrees/` and be a
// project's tree or a staging directory.
export function removeTreeDir(home: string, dir: string): void {
  const base = realpathSync(checktreesDir(home));
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return;
  }
  const rel = relative(base, real);
  const parts = rel.split(sep);
  if (rel.startsWith('..') || parts.length !== 2 || !PROJECT_ID.test(parts[0]!) || !(TREE_NAME.test(parts[1]!) || /^\.staging-[0-9a-f]{16}$/.test(parts[1]!))) {
    throw new Error(`refused to remove ${dir}: not a check tree of this engine home`);
  }
  unseal(real);
  rmSync(real, { recursive: true, force: true });
  treeSizes.delete(real);
}

// ---- the bound for all trees (`checktrees_max_bytes`) ------------------------------------

// Bytes of each complete tree, by its real path, counted once (file sizes);
// and bytes reserved by builds in progress, by their staging directory.
const treeSizes = new Map<string, number>();
const reserved = new Map<string, number>();

// The bytes of the files under `dir`, or why they cannot be counted: an
// entry that cannot be read is never counted as nothing (unknown is a value).
type Count = { bytes: number } | { unknown: string };

function bytesUnder(dir: string): Count {
  let total = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    return { unknown: `${dir} cannot be listed: ${(err as Error).message}` };
  }
  for (const name of names) {
    const p = join(dir, name);
    let st;
    try {
      st = lstatSync(p);
    } catch (err) {
      return { unknown: `${p} cannot be read: ${(err as Error).message}` };
    }
    if (st.isDirectory()) {
      const below = bytesUnder(p);
      if ('unknown' in below) return below;
      total += below.bytes;
    } else if (st.isFile()) total += st.size;
  }
  return { bytes: total };
}

// What the trees of this home hold, and what builds in progress will add;
// unknown when any of it cannot be read. A tree's count is kept once known.
export function checktreeBytesInUse(home: string): Count {
  let total = 0;
  let projects: string[];
  try {
    projects = readdirSync(checktreesDir(home)).filter((p) => PROJECT_ID.test(p));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { unknown: `${checktreesDir(home)} cannot be listed: ${(err as Error).message}` };
    projects = [];
  }
  for (const p of projects) {
    let names: string[];
    try {
      names = readdirSync(join(checktreesDir(home), p));
    } catch (err) {
      return { unknown: `${join(checktreesDir(home), p)} cannot be listed: ${(err as Error).message}` };
    }
    for (const name of names) {
      if (!TREE_NAME.test(name)) continue;
      const root = join(checktreesDir(home), p, name);
      let size = treeSizes.get(root);
      if (size === undefined) {
        const counted = bytesUnder(root);
        if ('unknown' in counted) return counted;
        size = counted.bytes;
        treeSizes.set(root, size);
      }
      total += size;
    }
  }
  for (const n of reserved.values()) total += n;
  return { bytes: total };
}

interface BlobEntry {
  mode: string;
  oid: string;
  path: string;
}

// The size of each blob, with `cat-file --batch-check`; a blob that cannot be
// read refuses the build.
async function measure(repo: string, oids: string[]): Promise<Map<string, number>> {
  const ctx = repoContext(repo);
  const unique = [...new Set(oids)];
  const sizes = new Map<string, number>();
  for (let i = 0; i < unique.length; i += 1000) {
    const batch = unique.slice(i, i + 1000);
    const r = await git(ctx, ['cat-file', '--batch-check'], { input: `${batch.join('\n')}\n` });
    if (r.code !== 0) throw new MaterializationFailed(`git cat-file --batch-check: ${r.stderr.trim().slice(0, 300) || (r.timedOut ? 'deadline' : 'failed')}`);
    for (const line of r.stdout.split('\n')) {
      const [oid, type, size] = line.split(' ');
      if (oid && type === 'blob' && size !== undefined) sizes.set(oid, Number(size));
    }
  }
  for (const oid of unique) if (!sizes.has(oid)) throw new MaterializationFailed(`the blob ${oid} cannot be read`);
  return sizes;
}

const bytesOf = (entries: BlobEntry[], sizes: Map<string, number>): number => entries.reduce((n, e) => n + sizes.get(e.oid)!, 0);

// Each entry written at <prefix>/<path> with exactly its blob's bytes (a
// symlink, 120000, as a link whose target is the blob): read from the object
// store with `cat-file`, never through `checkout-index`, so no attributes
// file of the work tree, of `.git/info`, or of the revision itself, and no
// configuration (`core.autocrlf`, `core.eol`), converts anything. No path
// component is followed through a link, and nothing is created outside
// `prefix`. `sizes` are the blobs' as measured.
async function writeBlobs(repo: string, entries: BlobEntry[], prefix: string, sizes: Map<string, number>): Promise<void> {
  mkdirSync(prefix, { recursive: true, mode: 0o755 });
  if (entries.length === 0) return;
  const ctx = repoContext(repo);
  const unique = [...new Set(entries.map((e) => e.oid))];
  const cap = 8 * 1024 * 1024;
  const bytes = new Map<string, Buffer>();
  const batches: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const oid of unique) {
    const size = sizes.get(oid)!;
    if (current.length > 0 && currentBytes + size > cap) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(oid);
    currentBytes += size;
  }
  if (current.length > 0) batches.push(current);
  const write = async (batch: string[]) => {
    const want = batch.reduce((n, o) => n + sizes.get(o)! + 128, 0);
    const r = await git(ctx, ['cat-file', '--batch'], { input: `${batch.join('\n')}\n`, outputCap: want });
    if (r.code !== 0) throw new MaterializationFailed(`git cat-file --batch: ${r.stderr.trim().slice(0, 300) || (r.timedOut ? 'deadline' : 'failed')}`);
    let at = 0;
    for (const oid of batch) {
      const nl = r.bytes.indexOf(0x0a, at);
      const header = nl < 0 ? [] : r.bytes.subarray(at, nl).toString('utf8').split(' ');
      if (header[0] !== oid || header[1] !== 'blob') throw new MaterializationFailed(`git cat-file did not give the blob ${oid}`);
      const size = Number(header[2]);
      bytes.set(oid, Buffer.from(r.bytes.subarray(nl + 1, nl + 1 + size)));
      at = nl + 1 + size + 1;
    }
    for (const e of entries) {
      const content = bytes.get(e.oid);
      if (content === undefined) continue;
      placeEntry(prefix, e, content);
    }
    for (const oid of batch) bytes.delete(oid);
  };
  for (const batch of batches) await write(batch);
}

// One entry under `root`, its parents made directory by directory, none
// followed through a link: a component that exists as anything but a
// directory refuses the build.
export function placeEntry(root: string, e: BlobEntry, content: Buffer): void {
  const parts = e.path.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new MaterializationFailed(`the path ${e.path} is not a plain relative path`);
  let at = root;
  for (const part of parts.slice(0, -1)) {
    at = join(at, part);
    let st;
    try {
      st = lstatSync(at);
    } catch {
      mkdirSync(at, { mode: 0o755 });
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) throw new MaterializationFailed(`${e.path} lies under ${relative(root, at)}, which is not a directory`);
  }
  const target = join(at, parts.at(-1)!);
  if (e.mode === '120000') {
    symlinkSync(content.toString('utf8'), target);
    return;
  }
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, e.mode === '100755' ? 0o755 : 0o644);
  try {
    let off = 0;
    while (off < content.length) off += writeSync(fd, content, off, content.length - off);
  } finally {
    closeSync(fd);
  }
}

// The tree of (project, revision, version), built now or reused.
// `manifests` are the input manifests whose projections it must hold.
export async function materialize(args: {
  home: string;
  scratch: string;
  repo: string;
  project: string;
  revision: string;
  version: string;
  roots: string[];
  manifests: ManifestEntry[][];
  maxEntries: number;
  maxBytes: number;
  // checktrees_max_bytes; the engine's configured value when not given.
  maxAllBytes?: number;
  // Whether another execution of the triple has a domain that may hold its
  // tree; an earlier-layout tree is removed only when this says no.
  held?: () => Promise<boolean>;
}): Promise<CheckTree> {
  const maxAll = args.maxAllBytes ?? checkLimits().checktrees_max_bytes;
  const root = treePath(args.home, args.project, args.revision, args.version);
  const made: CheckTree = { root, src: join(root, 'src'), inputs: join(root, 'inputs') };
  const wanted = new Map<string, ManifestEntry[]>();
  for (const m of args.manifests) wanted.set(manifestKey(m), m);
  if (existsSync(made.src)) {
    if ([...wanted.keys()].every((k) => existsSync(join(made.inputs, k)))) return made;
    // A tree of an earlier layout (no projections) is built again, but never
    // removed before closure: only once no other execution of its triple
    // has a domain that may still hold it (running, collecting or
    // quarantined, D3 §2.4).
    if (!existsSync(made.inputs)) {
      if (args.held === undefined || (await args.held())) throw new MaterializationFailed(`the check tree ${args.revision}-${args.version} is of an earlier layout and may still be held by an execution whose domain is not closed`);
      removeTreeDir(args.home, root);
    } else throw new MaterializationFailed(`the check tree ${args.revision}-${args.version} has no projection of this check's inputs`);
  }
  const parent = join(checktreesDir(args.home), args.project);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = join(parent, `.staging-${randomBytes(8).toString('hex')}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    const ctx = repoContext(args.repo);
    const listed = await git(ctx, ['ls-tree', '-r', '-z', '--full-tree', args.revision]);
    if (listed.code !== 0) throw new MaterializationFailed(`the revision ${args.revision} cannot be read: ${listed.stderr.trim().slice(0, 200) || (listed.timedOut ? 'deadline' : 'failed')}`);
    const source: BlobEntry[] = [];
    let entries = 0;
    for (const record of listed.stdout.split('\0')) {
      if (record === '') continue;
      const tab = record.indexOf('\t');
      const [mode, type, oid] = record.slice(0, tab).split(' ') as [string, string, string];
      const path = record.slice(tab + 1);
      // Submodules stay unsupported (D2 Q4): never in the projection.
      if (type !== 'blob') continue;
      // The candidate's own copy of the protected paths is never mounted,
      // and the governed file is absent wherever it lies (D3 §1.5, B01).
      if (path === GOVERNED_FILE || path.endsWith(`/${GOVERNED_FILE}`) || isProtectedPath(path, args.roots)) continue;
      if (++entries > args.maxEntries) throw new MaterializationFailed(`the revision has more than checktree_max_entries (${args.maxEntries}) entries`);
      source.push({ mode, oid, path });
    }
    const projections = [...wanted].map(([key, m]) => ({ key, entries: m.map(([path, , mode, oid]) => ({ mode, oid, path })) }));
    // The projections' entries count toward the same bound as the source's.
    entries += projections.reduce((n, p) => n + p.entries.length, 0);
    if (entries > args.maxEntries) throw new MaterializationFailed(`the tree would hold ${entries} entries with its input projections, more than checktree_max_entries (${args.maxEntries})`);
    // The bounds, from the blobs' sizes, before anything is written.
    const sizes = await measure(args.repo, [...source.map((e) => e.oid), ...projections.flatMap((p) => p.entries.map((e) => e.oid))]);
    const total = bytesOf(source, sizes) + projections.reduce((n, p) => n + bytesOf(p.entries, sizes), 0);
    if (total > args.maxBytes) throw new MaterializationFailed(`the tree would hold ${total} bytes, more than checktree_max_bytes (${args.maxBytes})`);
    // Unknown counts as over the bound: never admitted on a guess.
    const inUse = checktreeBytesInUse(args.home);
    if ('unknown' in inUse) throw new MaterializationFailed(`the bytes the check trees hold cannot be counted, so checktrees_max_bytes (${maxAll}) cannot be shown to hold: ${inUse.unknown}`);
    if (inUse.bytes + total > maxAll) throw new MaterializationFailed(`the check trees would hold ${inUse.bytes + total} bytes, more than checktrees_max_bytes (${maxAll})`);
    reserved.set(staging, total);
    await writeBlobs(args.repo, source, join(staging, 'src'), sizes);
    mkdirSync(join(staging, 'inputs'), { mode: 0o755 });
    for (const p of projections) {
      const dir = join(staging, 'inputs', p.key);
      await writeBlobs(args.repo, p.entries, dir, sizes);
      sealProjection(dir);
    }
    chmodSync(join(staging, 'inputs'), 0o555);
    try {
      renameSync(staging, root);
    } catch (err) {
      // Another build of the same triple won: it is the same content.
      if (existsSync(join(root, 'src'))) {
        removeTreeDir(args.home, staging);
        return made;
      }
      throw err;
    }
    treeSizes.set(realpathSync(root), total);
    return made;
  } catch (err) {
    try {
      removeTreeDir(args.home, staging);
    } catch {
      // nothing more to remove
    }
    if (err instanceof MaterializationFailed) throw err;
    throw new MaterializationFailed((err as Error).message);
  } finally {
    reserved.delete(staging);
  }
}

// The tree goes once no execution of its triple still needs it.
export function releaseTree(home: string, project: string, revision: string, version: string): void {
  const root = treePath(home, project, revision, version);
  if (!existsSync(root)) return;
  removeTreeDir(home, root);
}

// The trees built for a project, by their triple.
export function listTrees(home: string, project: string): { revision: string; version: string }[] {
  if (!PROJECT_ID.test(project)) return [];
  let names: string[];
  try {
    names = readdirSync(join(checktreesDir(home), project));
  } catch {
    return [];
  }
  return names.filter((n) => TREE_NAME.test(n)).map((n) => ({ revision: n.slice(0, 40), version: n.slice(41) }));
}

// At start: a staging directory a build left when the engine stopped part
// way is never a tree, and goes (D3 §2.4). Retention of whole trees is the
// rule above (an execution live, or a current candidate at the revision
// under the version in effect); a candidate's tree goes once a later
// nomination supersedes it and no execution holds it (slice 16). Nothing is
// evicted to make room: `checktrees_max_bytes` admission refuses a tree that
// would take the trees past it (SEAM.md §200); whether trees no execution
// holds should be evicted under that bound is a later question.
export function removeStagingLeftovers(home: string): number {
  let projects: string[];
  try {
    projects = readdirSync(checktreesDir(home)).filter((p) => PROJECT_ID.test(p));
  } catch {
    return 0;
  }
  let removed = 0;
  for (const p of projects) {
    for (const name of readdirSync(join(checktreesDir(home), p))) {
      if (!/^\.staging-[0-9a-f]{16}$/.test(name)) continue;
      removeTreeDir(home, join(checktreesDir(home), p, name));
      removed++;
    }
  }
  return removed;
}
