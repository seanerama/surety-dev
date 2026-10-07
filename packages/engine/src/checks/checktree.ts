// The check tree (D3 §2.4): what an execution's workspace is made from, for
// one (project, source revision, protected version), under
// `$SURETY_HOME/checktrees/<project>/<tree>/`, engine-owned and never named
// by policy.
//
//   src/        the candidate-source projection: every tracked file of the
//               revision but those under the version's roots and the
//               governed file, wherever it lies; the overlay's lower layer.
//   protected/  the protected inputs of the version's checks, by the object
//               ids of their input manifests; each execution binds only its
//               own check's manifest from here.
//
// With engine git only (`ls-tree`, `cat-file`): every file is its blob's
// bytes exactly, whatever any attributes or configuration say; nothing writes
// a `.git`, runs repository code or contacts a remote. A tree is built in a private staging directory, made
// read-only, and becomes visible only once complete; a failed build removes
// its partial state. It is shared by the executions of its triple and
// removed when none still needs it. Main thread only.

import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { git, repoContext } from '../git/exec.js';
import { GOVERNED_FILE, type ManifestEntry, isProtectedPath } from './schema.js';

export interface CheckTree {
  root: string;
  src: string;
  protected: string;
}

const PROJECT_ID = /^proj_[0-9A-Z]{26}$/;
const TREE_NAME = /^[0-9a-f]{40}-pv_[0-9A-Z]{26}$/;

export const checktreesDir = (home: string): string => join(home, 'checktrees');

export class MaterializationFailed extends Error {}

function treePath(home: string, project: string, revision: string, version: string): string {
  const name = `${revision}-${version}`;
  if (!PROJECT_ID.test(project) || !TREE_NAME.test(name)) throw new MaterializationFailed(`not a check tree's name: ${project}/${name}`);
  return join(checktreesDir(home), project, name);
}

// Its files read-only, as a tree's are (D3 §2.4), keeping their execute
// bit. Directories stay writable by the engine alone (the tree lies under the
// engine home): the workspace overlay above them must let a check create
// files, whose writes are discarded with the domain (E89 item 2).
function seal(dir: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) seal(p);
    else chmodSync(p, st.mode & 0o111 ? 0o555 : 0o444);
  }
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
}

interface BlobEntry {
  mode: string;
  oid: string;
  path: string;
}

// Each entry written at <prefix>/<path> with exactly its blob's bytes (a
// symlink, 120000, as a link whose target is the blob): read from the object
// store with `cat-file`, never through `checkout-index`, so no attributes
// file of the work tree, of `.git/info`, or of the revision itself, and no
// configuration (`core.autocrlf`, `core.eol`), converts anything. No path
// component is followed through a link, and nothing is created outside
// `prefix`. Returns the bytes written.
async function writeBlobs(repo: string, entries: BlobEntry[], prefix: string, maxBytes: number): Promise<number> {
  mkdirSync(prefix, { recursive: true, mode: 0o700 });
  if (entries.length === 0) return 0;
  const ctx = repoContext(repo);
  const unique = [...new Set(entries.map((e) => e.oid))];
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
  let total = 0;
  for (const e of entries) {
    const size = sizes.get(e.oid);
    if (size === undefined) throw new MaterializationFailed(`the blob ${e.oid} of ${e.path} cannot be read`);
    total += size;
  }
  if (total > maxBytes) throw new MaterializationFailed(`the tree holds ${total} bytes, more than checktree_max_bytes (${maxBytes})`);
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
  return total;
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
// `manifests` are the input manifests the protected half must hold.
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
}): Promise<CheckTree> {
  const root = treePath(args.home, args.project, args.revision, args.version);
  const made = { root, src: join(root, 'src'), protected: join(root, 'protected') };
  if (existsSync(join(root, 'src')) && existsSync(join(root, 'protected'))) return made;
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
    const written = await writeBlobs(args.repo, source, join(staging, 'src'), args.maxBytes);
    const inputs = new Map<string, ManifestEntry>();
    for (const m of args.manifests) for (const e of m) inputs.set(e[0], e);
    await writeBlobs(
      args.repo,
      [...inputs.values()].map(([path, , mode, oid]) => ({ mode, oid, path })),
      join(staging, 'protected'),
      args.maxBytes - written,
    );
    seal(staging);
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
    return made;
  } catch (err) {
    try {
      removeTreeDir(args.home, staging);
    } catch {
      // nothing more to remove
    }
    if (err instanceof MaterializationFailed) throw err;
    throw new MaterializationFailed((err as Error).message);
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
// nomination supersedes it and no execution holds it (slice 16), and slice
// 17's `checktrees_max_bytes` admission must be able to remove trees no live
// execution holds (`releaseTree`) to make room.
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
