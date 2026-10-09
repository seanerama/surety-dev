// The artifact (D4 §3.1; E117): a directory tree the engine projects from the
// candidate's revision in the object store (never through a work tree, so
// attributes, filters and hooks never touch its bytes), exactly the tracked
// files minus `.surety/` and minus `artifact.exclude`. Its digest is sha256
// of the canonical manifest, the complete sorted list of [path, type, mode,
// size, sha256(content)], the mode a canonical class (`100644`, `100755`).
//
// Sealing: written into a staging directory under `$SURETY_HOME/artifacts/
// <project>/`, write permission removed from every file (the executable
// class kept), renamed to its digest's name. A digest already sealed is
// rehashed and its bytes reused. The rehash reads the sealed copy back and
// compares it with the manifest; an extra, missing or changed entry is
// `corrupt`, never omitted.
//
// Slice 23 builds the projection and the seal; the bounds of D4 §3.1 and
// their refusals are slice 24's (E121 decision 1). Main thread only.
//
// The one removal site here: a staging directory this module created, under
// `$SURETY_HOME/artifacts/<project>/.staging-<16 hex>`, checked by its real
// path before anything is removed. A sealed artifact is never removed.

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { git, repoContext } from '../git/exec.js';
import { Refusal } from '../refusal.js';
import { canonical } from '../store/transitions/common.js';
import type { SealedArtifact } from '../store/transitions/deploy.js';
import { ENGINE_VERSION } from '../index.js';

export type ManifestEntry = [path: string, type: 'file', mode: '100644' | '100755', size: number, sha256: string];

export const artifactsDir = (home: string): string => join(home, 'artifacts');
export const BUILDER = `engine-projection@${ENGINE_VERSION}`;
const PROJECT_ID = /^proj_[0-9A-Z]{26}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const STAGING = /^\.staging-[0-9a-f]{16}$/;

const refuse = (refusal: string, why: string): Refusal =>
  new Refusal(422, 'artifact_refused', `The artifact cannot be built: ${why}.`, 'Nothing was authorized. Remove it from the revision or exclude it, and request the deployment again.', { refusal });

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

export const digestOfManifest = (manifest: ManifestEntry[]): string => `sha256:${sha(canonical(manifest))}`;

// The artifact specification's fingerprint (the mapping's).
export const specFingerprint = (exclude: string[]): string => `sha256:${sha(canonical({ exclude: [...exclude].sort(), protected: '.surety/' }))}`;

// Is a path of the revision outside the projection?
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
}

// The revision's projection, read from the object store.
async function project(repo: string, revision: string, exclude: string[]): Promise<{ blobs: Blob[]; bytes: Map<string, Buffer> }> {
  const ctx = repoContext(repo);
  const listed = await git(ctx, ['ls-tree', '-r', '-z', '--full-tree', revision]);
  if (listed.code !== 0) throw refuse('unreadable', `the revision ${revision} cannot be read (${listed.timedOut ? 'deadline' : 'git failed'})`);
  const blobs: Blob[] = [];
  for (const record of listed.stdout.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const [mode, type, oid] = record.slice(0, tab).split(' ') as [string, string, string];
    const path = record.slice(tab + 1);
    if (excluded(path, exclude)) continue;
    if (type === 'commit') throw refuse('submodule', `${path} is a submodule`);
    if (mode === '120000') throw refuse('symlink', `${path} is a symbolic link`);
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) throw refuse('special_file', `${path} is not a regular file`);
    blobs.push({ path, mode, oid });
  }
  const bytes = new Map<string, Buffer>();
  const unique = [...new Set(blobs.map((b) => b.oid))];
  for (let i = 0; i < unique.length; i += 500) {
    const batch = unique.slice(i, i + 500);
    const r = await git(ctx, ['cat-file', '--batch'], { input: `${batch.join('\n')}\n`, outputCap: 1 << 30 });
    if (r.code !== 0) throw refuse('unreadable', `the revision's blobs cannot be read (${r.timedOut ? 'deadline' : 'git failed'})`);
    let at = 0;
    for (const oid of batch) {
      const nl = r.bytes.indexOf(0x0a, at);
      const header = nl < 0 ? [] : r.bytes.subarray(at, nl).toString('utf8').split(' ');
      if (header[0] !== oid || header[1] !== 'blob') throw refuse('unreadable', `git did not give the blob ${oid}`);
      const size = Number(header[2]);
      bytes.set(oid, Buffer.from(r.bytes.subarray(nl + 1, nl + 1 + size)));
      at = nl + 1 + size + 1;
    }
  }
  return { blobs, bytes };
}

const manifestOf = (blobs: Blob[], bytes: Map<string, Buffer>): ManifestEntry[] =>
  blobs
    .map((b): ManifestEntry => [b.path, 'file', b.mode, bytes.get(b.oid)!.length, sha(bytes.get(b.oid)!)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

function sealedPath(home: string, projectId: string, digest: string): string {
  if (!PROJECT_ID.test(projectId) || !DIGEST.test(digest)) throw new Error(`not an artifact's name: ${projectId}/${digest}`);
  return join(artifactsDir(home), projectId, digest.slice('sha256:'.length));
}

// Remove a staging directory this module made, and nothing else.
function removeStaging(home: string, projectId: string, dir: string): void {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return;
  }
  const base = realpathSync(join(artifactsDir(home), projectId));
  const rel = relative(base, real);
  if (rel.startsWith('..') || rel.includes(sep) || !STAGING.test(rel)) throw new Error(`refused to remove ${dir}: not a staging directory of this engine home`);
  const unseal = (d: string) => {
    chmodSync(d, 0o755);
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) unseal(p);
      else if (!st.isSymbolicLink()) chmodSync(p, 0o644);
    }
  };
  unseal(real);
  rmSync(real, { recursive: true, force: true });
}

function sealTree(dir: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) sealTree(p);
    else chmodSync(p, st.mode & 0o111 ? 0o555 : 0o444);
  }
  chmodSync(dir, 0o555);
}

// The sealed copy read back against its manifest: `ok`, `corrupt` (an
// extra, missing or changed entry, a link or a special file, a changed
// class, a write bit), or `unread` when it cannot be read at all.
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
  found.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (corrupt) return 'corrupt';
  return canonical(found) === canonical(manifest) ? 'ok' : 'corrupt';
}

// Project and seal the candidate's revision under the configuration's
// excludes (D4 §3.1).
export async function sealArtifact(args: { home: string; project: string; repo: string; revision: string; exclude: string[] }): Promise<SealedArtifact & { spec: string }> {
  const { blobs, bytes } = await project(args.repo, args.revision, args.exclude);
  const manifest = manifestOf(blobs, bytes);
  const digest = digestOfManifest(manifest);
  const total = manifest.reduce((n, e) => n + e[3], 0);
  const spec = specFingerprint(args.exclude);
  const target = sealedPath(args.home, args.project, digest);
  if (existsSync(target)) {
    // Reuse: the sealed copy rehashed first; the staging copy never made.
    const r = rehash(target, manifest);
    return { digest, manifest, path: target, bytes: total, entries: manifest.length, reused: r === 'ok' ? 'ok' : 'corrupt', spec };
  }
  const parent = join(artifactsDir(args.home), args.project);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = join(parent, `.staging-${randomBytes(8).toString('hex')}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    for (const b of blobs) {
      const p = join(staging, ...b.path.split('/'));
      mkdirSync(dirname(p), { recursive: true, mode: 0o755 });
      writeFileSync(p, bytes.get(b.oid)!, { mode: b.mode === '100755' ? 0o755 : 0o644, flag: 'wx' });
      chmodSync(p, b.mode === '100755' ? 0o755 : 0o644);
    }
    chmodSync(staging, 0o755);
    sealTree(staging);
    try {
      renameSync(staging, target);
    } catch (err) {
      // Another request sealed the same digest meanwhile: the same bytes.
      if (!existsSync(target)) throw err;
      removeStaging(args.home, args.project, staging);
      const r = rehash(target, manifest);
      return { digest, manifest, path: target, bytes: total, entries: manifest.length, reused: r === 'ok' ? 'ok' : 'corrupt', spec };
    }
    return { digest, manifest, path: target, bytes: total, entries: manifest.length, reused: 'new', spec };
  } catch (err) {
    try {
      removeStaging(args.home, args.project, staging);
    } catch {
      // nothing more to remove
    }
    throw err;
  }
}
