// The artifact (D4 §3.1; E117): a directory tree the engine projects from the
// candidate's revision in the object store (never through a work tree, so
// attributes, filters and hooks never touch its bytes), exactly the tracked
// files minus `.surety/` and minus `artifact.exclude`. Its digest is sha256
// of the canonical manifest, the complete sorted list of [path, type, mode,
// size, sha256(content)], the mode a canonical class (`100644`, `100755`),
// serialized as JSON with no whitespace (SEAM.md §260).
//
// Bounded preparation (D4 §3.1; E117; BS4 §11.3 as approved, E121 item 3).
// Before anything is written: the entry count against `artifact_max_entries`
// and the bytes (read from the object store's sizes, before any blob is
// read) against `artifact_max_bytes`, each inclusive; then, for a digest not
// yet recorded, the retained total of every `artifacts` row of the home plus
// the new one against `artifacts_max_bytes`, and the engine home's free bytes
// less the new artifact against `host_reserve_disk`. `artifact_prepare_
// deadline` is measured on the engine's clock from the start of the
// request's preparation, at every step and after the staging is written. A
// refusal names its bound (`ArtifactRefusal`) and removes the request's
// staging only; a sealed artifact is never evicted. Writing and hashing yield
// to the event loop, so the API and the tick keep answering.
//
// Sealing: written into a staging directory `$SURETY_HOME/artifacts/.staging-
// <16 hex>`, write permission removed from every file (the executable class
// kept), renamed to `artifacts/<project>/<digest hex>`. A digest already
// sealed is rehashed and its bytes reused; the staging copy is never made.
// The rehash reads the sealed copy back and compares it with the manifest; an
// extra, missing or changed entry, a link or a special file (never opened)
// is `corrupt`, never omitted.
//
// Removal sites here, each checked by its real path and its name before
// anything is removed: (1) a staging directory, `artifacts/.staging-<16 hex>`
// (or one of slice 23's, `artifacts/<project>/.staging-<16 hex>`); (2) a
// sealed directory `artifacts/<project>/<64 hex>` that no `artifacts` row
// records, only when the caller has established that no row records it (the
// request that made it, under its project's lock, or the start sweep before
// the API serves); (3) a project directory left empty by (2) with no row of
// the project. A recorded sealed artifact is never removed.

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statfsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { readFileSync } from 'node:fs';

import { nowMs } from '../clock.js';
import { git, repoContext } from '../git/exec.js';
import { ENGINE_VERSION } from '../index.js';
import { Refusal } from '../refusal.js';
import type { SealedArtifact } from '../store/transitions/deploy.js';
import { pausePoint } from '../testing/seam.js';

export type ManifestEntry = [path: string, type: 'file', mode: '100644' | '100755', size: number, sha256: string];
export type ArtifactRefusal = 'symlink' | 'submodule' | 'special_file' | 'too_many' | 'too_large' | 'retention_full' | 'disk_reserve' | 'prepare_deadline';

// The artifacts directory under the home's real path (the slice-24 review,
// S1): a home spelled through a link and its real path name the same
// directory, so a recorded artifact's path never depends on the spelling.
export const artifactsDir = (home: string): string => {
  let real = home;
  try {
    real = realpathSync(home);
  } catch {
    // judged as given
  }
  return join(real, 'artifacts');
};
export const BUILDER = `engine-projection@${ENGINE_VERSION}`;
export const PROJECT_ID = /^proj_[0-9A-HJKMNP-TV-Z]{26}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const DIGEST_DIR = /^[0-9a-f]{64}$/;
export const STAGING = /^\.staging-[0-9a-f]{16}$/;

export class ArtifactRefused extends Refusal {
  constructor(
    readonly refusal: ArtifactRefusal | 'unreadable',
    why: string,
    readonly bound: Record<string, unknown> = {},
  ) {
    super(422, 'artifact_refused', `The artifact cannot be built: ${why}.`, 'Nothing was authorized. Change the revision or the configuration, and request the deployment again.', { refusal, ...bound });
  }
}

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

// The canonical manifest's digest (SEAM.md §260).
export const digestOfManifest = (manifest: ManifestEntry[]): string => `sha256:${sha(JSON.stringify(manifest))}`;

const byPath = (a: ManifestEntry, b: ManifestEntry): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

// The artifact specification's fingerprint (the mapping's).
export const specFingerprint = (exclude: string[]): string => `sha256:${sha(JSON.stringify({ exclude: [...exclude].sort(), protected: '.surety/' }))}`;

// Is a path of the revision outside the projection? An exclude names a file,
// or a directory and everything under it, with or without a final `/`.
export function excluded(path: string, exclude: string[]): boolean {
  if (path === '.surety' || path.startsWith('.surety/')) return true;
  return exclude.some((e) => {
    const p = e.endsWith('/') ? e.slice(0, -1) : e;
    return path === p || path.startsWith(`${p}/`);
  });
}

interface Blob {
  path: string;
  mode: '100644' | '100755';
  oid: string;
  size: number;
}

export interface PrepareBounds {
  maxEntries: number;
  maxBytes: number;
  totalMax: number;
  reserveDisk: number;
  deadlineSeconds: number;
  // The engine clock's milliseconds when the request's preparation began.
  startedMs: number;
  // The engine home's free bytes, or null when they cannot be read.
  freeBytes: () => number | null;
  // For a digest: whether an `artifacts` row of the project records it, and
  // the bytes every row of the home records.
  admission: (digest: string) => Promise<{ recorded: boolean; total: number }>;
  // The listed paths of the projection, before any blob is read: the
  // caller's checks of the configuration against them (M312's entry point).
  inspect?: (paths: Set<string>) => void;
}

function checkDeadline(b: PrepareBounds, at: string): number {
  const left = b.startedMs + b.deadlineSeconds * 1000 - nowMs();
  if (left < 0) throw new ArtifactRefused('prepare_deadline', `its preparation passed artifact_prepare_deadline (${b.deadlineSeconds} s) ${at}`, { bound: 'artifact_prepare_deadline', limit: b.deadlineSeconds });
  return left;
}

// Seconds a git call may take within the preparation's deadline (and git's own).
const gitSeconds = (leftMs: number): number => Math.max(1, Math.ceil(leftMs / 1000));

const yieldNow = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// The revision's projection, listed and bounded from the object store.
async function list(repo: string, revision: string, exclude: string[], b: PrepareBounds): Promise<Blob[]> {
  const ctx = repoContext(repo);
  const listed = await git(ctx, ['ls-tree', '-r', '-z', '--full-tree', revision], { deadlineSeconds: gitSeconds(checkDeadline(b, 'before the listing')) });
  checkDeadline(b, 'while listing the revision');
  if (listed.code !== 0) throw new ArtifactRefused('unreadable', `the revision ${revision} cannot be read (${listed.timedOut ? 'deadline' : 'git failed'})`);
  const found: Omit<Blob, 'size'>[] = [];
  for (const record of listed.stdout.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const [mode, type, oid] = record.slice(0, tab).split(' ') as [string, string, string];
    const path = record.slice(tab + 1);
    // A path the object store can hold but a directory cannot (an empty,
    // `.` or `..` segment, or an absolute path) is never written.
    if (path === '' || path.startsWith('/') || path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) throw new ArtifactRefused('special_file', `${JSON.stringify(path)} is not a path inside the tree`);
    if (excluded(path, exclude)) continue;
    if (type === 'commit') throw new ArtifactRefused('submodule', `${path} is a submodule`);
    if (mode === '120000') throw new ArtifactRefused('symlink', `${path} is a symbolic link`);
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) throw new ArtifactRefused('special_file', `${path} is not a regular file`);
    found.push({ path, mode, oid });
    if (found.length > b.maxEntries) {
      throw new ArtifactRefused('too_many', `the projection has more than artifact_max_entries (${b.maxEntries}) entries`, { bound: 'artifact_max_entries', limit: b.maxEntries });
    }
  }
  b.inspect?.(new Set(found.map((f) => f.path)));
  // The sizes, from the object store, before any blob is read.
  const unique = [...new Set(found.map((f) => f.oid))];
  const sizes = new Map<string, number>();
  for (let i = 0; i < unique.length; i += 2000) {
    const batch = unique.slice(i, i + 2000);
    const r = await git(ctx, ['cat-file', '--batch-check'], { input: `${batch.join('\n')}\n`, deadlineSeconds: gitSeconds(checkDeadline(b, 'while reading sizes')) });
    if (r.code !== 0) throw new ArtifactRefused('unreadable', `the revision's blob sizes cannot be read (${r.timedOut ? 'deadline' : 'git failed'})`);
    const lines = r.stdout.split('\n').filter((l) => l !== '');
    batch.forEach((oid, k) => {
      const [o, t, s] = (lines[k] ?? '').split(' ');
      if (o !== oid || t !== 'blob' || !/^\d+$/.test(s ?? '')) throw new ArtifactRefused('unreadable', `git did not give the size of ${oid}`);
      sizes.set(oid, Number(s));
    });
  }
  const blobs = found.map((f) => ({ ...f, size: sizes.get(f.oid)! }));
  const total = blobs.reduce((n, x) => n + x.size, 0);
  if (total > b.maxBytes) throw new ArtifactRefused('too_large', `the projection holds ${total} bytes, more than artifact_max_bytes (${b.maxBytes})`, { bound: 'artifact_max_bytes', limit: b.maxBytes, value: total });
  return blobs;
}

// The blobs' bytes, from the object store, in bounded batches.
async function readBlobs(repo: string, blobs: Blob[], b: PrepareBounds): Promise<Map<string, Buffer>> {
  const ctx = repoContext(repo);
  const bytes = new Map<string, Buffer>();
  const unique = [...new Map(blobs.map((x) => [x.oid, x.size])).entries()];
  let at = 0;
  while (at < unique.length) {
    // Batches of at most 500 blobs or 64 MiB.
    const batch: [string, number][] = [];
    let held = 0;
    while (at < unique.length && batch.length < 500 && (batch.length === 0 || held + unique[at]![1] <= 64 * 1024 * 1024)) {
      batch.push(unique[at]!);
      held += unique[at]![1];
      at++;
    }
    const cap = held + batch.length * 128 + 1024;
    const r = await git(ctx, ['cat-file', '--batch'], { input: `${batch.map(([o]) => o).join('\n')}\n`, outputCap: cap, deadlineSeconds: gitSeconds(checkDeadline(b, 'while reading blobs')) });
    if (r.code !== 0) throw new ArtifactRefused('unreadable', `the revision's blobs cannot be read (${r.timedOut ? 'deadline' : 'git failed'})`);
    let pos = 0;
    for (const [oid] of batch) {
      const nl = r.bytes.indexOf(0x0a, pos);
      const header = nl < 0 ? [] : r.bytes.subarray(pos, nl).toString('utf8').split(' ');
      if (header[0] !== oid || header[1] !== 'blob') throw new ArtifactRefused('unreadable', `git did not give the blob ${oid}`);
      const size = Number(header[2]);
      bytes.set(oid, Buffer.from(r.bytes.subarray(nl + 1, nl + 1 + size)));
      pos = nl + 1 + size + 1;
    }
    await yieldNow();
  }
  return bytes;
}

const manifestOf = (blobs: Blob[], bytes: Map<string, Buffer>): ManifestEntry[] =>
  blobs.map((b): ManifestEntry => [b.path, 'file', b.mode, bytes.get(b.oid)!.length, sha(bytes.get(b.oid)!)]).sort(byPath);

export function sealedPath(home: string, projectId: string, digest: string): string {
  if (!PROJECT_ID.test(projectId) || !DIGEST.test(digest)) throw new Error(`not an artifact's name: ${projectId}/${digest}`);
  return join(artifactsDir(home), projectId, digest.slice('sha256:'.length));
}

// Write permission back on a tree this module sealed, so it can be removed.
function unseal(d: string): void {
  chmodSync(d, 0o700);
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    const st = lstatSync(p);
    if (st.isDirectory()) unseal(p);
    else if (!st.isSymbolicLink()) chmodSync(p, 0o600);
  }
}

// The real path of `dir`, if it is exactly `<real artifacts dir>/<rel>`
// with each component matching its pattern; otherwise null.
function ownedPath(home: string, dir: string, patterns: RegExp[]): string | null {
  let real: string;
  let base: string;
  try {
    real = realpathSync(dir);
    base = realpathSync(artifactsDir(home));
  } catch {
    return null;
  }
  const parts = relative(base, real).split(sep);
  if (parts.length !== patterns.length || parts.some((p, i) => p === '' || p === '..' || !patterns[i]!.test(p))) return null;
  if (!lstatSync(real).isDirectory()) return null;
  return real;
}

// (1) Remove a staging directory this engine made, and nothing else.
export function removeStaging(home: string, dir: string): void {
  if (!existsSync(dir)) return;
  const real = ownedPath(home, dir, [STAGING]) ?? ownedPath(home, dir, [PROJECT_ID, STAGING]);
  if (real === null) throw new Error(`refused to remove ${dir}: not a staging directory of this engine home`);
  unseal(real);
  rmSync(real, { recursive: true, force: true });
}

// (2) and (3): a sealed directory no `artifacts` row records, which the
// caller established; then its project directory if it is left empty and
// `projectRecorded` is false.
export function removeUnrecorded(home: string, dir: string, projectRecorded: boolean): void {
  if (existsSync(dir)) {
    const real = ownedPath(home, dir, [PROJECT_ID, DIGEST_DIR]);
    if (real === null) throw new Error(`refused to remove ${dir}: not a sealed directory of this engine home`);
    unseal(real);
    rmSync(real, { recursive: true, force: true });
  }
  if (!projectRecorded) removeEmptyProjectDir(home, dirname(dir));
}

export function removeEmptyProjectDir(home: string, dir: string): void {
  const real = existsSync(dir) ? ownedPath(home, dir, [PROJECT_ID]) : null;
  if (real === null) return;
  try {
    rmdirSync(real);
  } catch {
    // not empty: something else is there
  }
}

// Write permission removed below `dir`; `dir` itself is sealed by the
// caller once it has been renamed into place (a directory moved to another
// parent must be writable while it moves).
function sealTree(dir: string, top = true): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) sealTree(p, false);
    else chmodSync(p, st.mode & 0o111 ? 0o555 : 0o444);
  }
  if (!top) chmodSync(dir, 0o555);
}

// The sealed copy read back against its manifest: `ok`, `corrupt` (an
// extra, missing or changed entry, a link or a special file, a changed
// class, a write bit), or `unread` when it cannot be read at all. A link or
// a special file is never followed or opened.
export function rehash(path: string, manifest: ManifestEntry[]): 'ok' | 'corrupt' | 'unread' {
  if (!existsSync(path)) return 'unread';
  const found: ManifestEntry[] = [];
  let corrupt = false;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      if (!st.isFile()) {
        corrupt = true;
        continue;
      }
      if (st.mode & 0o222) corrupt = true;
      const content = readFileSync(p);
      found.push([relative(path, p).split(sep).join('/'), 'file', st.mode & 0o111 ? '100755' : '100644', content.length, sha(content)]);
    }
  };
  try {
    walk(path);
  } catch {
    return 'unread';
  }
  found.sort(byPath);
  if (corrupt) return 'corrupt';
  return JSON.stringify(found) === JSON.stringify(manifest) ? 'ok' : 'corrupt';
}

// The engine home's free bytes (statfs), or null.
export function homeFreeBytes(home: string): number | null {
  try {
    const st = statfsSync(home);
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}

export type Sealed = SealedArtifact & { spec: string; created: boolean };

// Project and seal the candidate's revision under the configuration's
// excludes (D4 §3.1). `created` is true when this call made the sealed
// directory: if the request then records no row, the caller removes it.
export async function sealArtifact(args: { home: string; project: string; repo: string; revision: string; exclude: string[]; bounds: PrepareBounds }): Promise<Sealed> {
  const b = args.bounds;
  const blobs = await list(args.repo, args.revision, args.exclude, b);
  const bytes = await readBlobs(args.repo, blobs, b);
  const manifest = manifestOf(blobs, bytes);
  const digest = digestOfManifest(manifest);
  const total = manifest.reduce((n, e) => n + e[3], 0);
  const spec = specFingerprint(args.exclude);
  const target = sealedPath(args.home, args.project, digest);
  const result = (reused: SealedArtifact['reused'], created: boolean): Sealed => ({ digest, manifest, path: target, bytes: total, entries: manifest.length, reused, spec, created });
  if (existsSync(target)) {
    // Reuse: the sealed copy rehashed first; the staging copy never made.
    return result(rehash(target, manifest) === 'ok' ? 'ok' : 'corrupt', false);
  }
  // Admission (D4 §3.1): a digest no row records adds its bytes to the
  // retained total, and is written only while the home keeps its reserve.
  const adm = await b.admission(digest);
  if (!adm.recorded) {
    if (adm.total + total > b.totalMax) {
      throw new ArtifactRefused('retention_full', `the retained artifacts hold ${adm.total} bytes, and ${total} more would pass artifacts_max_bytes (${b.totalMax}); no referenced artifact is evicted`, { bound: 'artifacts_max_bytes', limit: b.totalMax, value: adm.total + total });
    }
  }
  const free = b.freeBytes();
  if (free === null || free - total < b.reserveDisk) {
    throw new ArtifactRefused('disk_reserve', free === null ? "the engine home's free space cannot be read" : `writing ${total} bytes would leave less than host_reserve_disk (${b.reserveDisk}) free of ${free}`, { bound: 'host_reserve_disk', limit: b.reserveDisk, value: free });
  }
  checkDeadline(b, 'before staging');
  const root = artifactsDir(args.home);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const staging = join(root, `.staging-${randomBytes(8).toString('hex')}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    let n = 0;
    for (const x of blobs) {
      const p = join(staging, ...x.path.split('/'));
      const rel = relative(staging, p);
      if (rel === '' || rel.startsWith('..') || rel.startsWith(sep)) throw new ArtifactRefused('special_file', `${JSON.stringify(x.path)} is not a path inside the tree`);
      await mkdir(dirname(p), { recursive: true, mode: 0o755 });
      await writeFile(p, bytes.get(x.oid)!, { mode: x.mode === '100755' ? 0o755 : 0o644, flag: 'wx' });
      chmodSync(p, x.mode === '100755' ? 0o755 : 0o644);
      if (++n % 64 === 0) {
        checkDeadline(b, 'while writing the staging copy');
        await yieldNow();
      }
    }
    await pausePoint('artifact.staging_written');
    checkDeadline(b, 'after the staging copy was written');
    chmodSync(staging, 0o755);
    sealTree(staging);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    try {
      renameSync(staging, target);
      chmodSync(target, 0o555);
    } catch (err) {
      // Sealed by another meanwhile: the same bytes.
      if (!existsSync(target)) throw err;
      removeStaging(args.home, staging);
      return result(rehash(target, manifest) === 'ok' ? 'ok' : 'corrupt', false);
    }
    return result('new', true);
  } catch (err) {
    try {
      removeStaging(args.home, staging);
    } catch {
      // nothing more to remove
    }
    throw err;
  }
}

// At start, before the API serves (D4-I08; the slice-23 review's m5): every
// staging directory, every sealed directory no `artifacts` row records, and
// every project directory left with nothing recorded, removed by the guards
// above. A sealed directory is recorded when a row names its project and
// digest, or when its real path is the real path of any row's `path` (the
// slice-24 review, S1): however the home is spelled, a recorded artifact is
// never removed.
export function sweepArtifacts(home: string, rows: { project: string; digest: string; path: string }[]): { removed: string[]; refused: string[] } {
  const root = artifactsDir(home);
  const removed: string[] = [];
  const refused: string[] = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return { removed, refused };
  }
  const realOf = (p: string): string | null => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  const ids = new Set(rows.map((r) => `${r.project}/${r.digest.replace(/^sha256:/, '')}`));
  const projects = new Set(rows.map((r) => r.project));
  const reals = new Set(rows.map((r) => realOf(r.path)).filter((p): p is string => p !== null));
  const attempt = (path: string, fn: () => void) => {
    try {
      fn();
      removed.push(path);
    } catch {
      refused.push(path);
    }
  };
  for (const name of names) {
    const path = join(root, name);
    if (STAGING.test(name)) {
      attempt(path, () => removeStaging(home, path));
      continue;
    }
    if (!PROJECT_ID.test(name)) continue;
    let inner: string[];
    try {
      inner = readdirSync(path);
    } catch {
      continue;
    }
    for (const child of inner) {
      const p = join(path, child);
      if (STAGING.test(child)) attempt(p, () => removeStaging(home, p));
      else if (DIGEST_DIR.test(child)) {
        const real = realOf(p);
        if (ids.has(`${name}/${child}`) || (real !== null && reals.has(real))) continue;
        attempt(p, () => removeUnrecorded(home, p, true));
      }
    }
    if (!projects.has(name)) removeEmptyProjectDir(home, path);
  }
  return { removed, refused };
}
