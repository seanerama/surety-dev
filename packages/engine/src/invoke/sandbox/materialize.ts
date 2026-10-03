// What a role left in its workspace reaches the checkout only after the
// domain's termination is established, and only through the secret screen
// (D2 §§2.3, 2.5; E58 item 1; row M121 (e)). The role wrote into the upper
// layer of an overlay on the domain's volatile filesystem, which the engine
// holds from outside (sandbox/volatile.ts). Here the engine reads which
// directories the role changed from the upper layer, what they hold now from
// the overlay as the role left it (so a removal and a removed-then-remade
// directory read as they are, without the overlay's own markers), screens
// every file and link it will write for each registered secret in its raw
// and escaped forms, and only then writes the changes into the run's own
// workspace under the engine home: never into a developer checkout, never
// through a symbolic link, never the workspace's own `.git`. A screen hit
// writes nothing. The snapshot of D1 §7.3 then admits it as before (M19's
// validation unchanged).

import { closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeSync } from 'node:fs';
import { join, sep } from 'node:path';

import { scanBytes } from '../../records/redact.js';
import type { VolatileHold } from './volatile.js';

type Action =
  | { kind: 'delete'; path: string }
  | { kind: 'dir'; path: string; mode: number }
  | { kind: 'file'; path: string; source: string; mode: number }
  | { kind: 'link'; path: string; target: string };

export type MaterializeResult =
  | { state: 'materialized'; written: string[]; removed: string[]; skipped: { path: string; why: string }[] }
  | { state: 'refused'; reason: 'secret' | 'workspace' | 'unreadable' | 'caps'; path: string | null; detail: string };

// The snapshot's caps (D1 §7.3; M19: `snapshot_max_files`,
// `snapshot_max_bytes`, `snapshot_max_file_bytes`), applied to what would be
// materialized before anything is written: what the snapshot would refuse is
// never copied into the checkout, and the copy is bounded by them.
export interface MaterializeCaps {
  files: number;
  bytes: number;
  fileBytes: number;
}

class OverCaps extends Error {}

// The run's own workspace, and nothing else: a real directory directly
// under `<home>/workspaces/`, reached without a link.
export function verifyWorkspace(home: string, workspace: string): string | null {
  let root: string;
  let real: string;
  try {
    root = realpathSync(join(home, 'workspaces'));
    real = realpathSync(workspace);
  } catch {
    return 'the workspace cannot be resolved';
  }
  if (!real.startsWith(`${root}${sep}`) || real.slice(root.length + 1).includes(sep)) return `${workspace} is not a workspace under the engine home`;
  try {
    if (!lstatSync(workspace).isDirectory()) return `${workspace} is not a directory`;
  } catch {
    return `${workspace} cannot be read`;
  }
  return null;
}

const SCAN_WHOLE = 32 * 1024 * 1024;
const CHUNK = 8 * 1024 * 1024;
const OVERLAP = 64 * 1024;

// Does the file at `path` (read without following a link) hold a registered
// secret? Large files are scanned in overlapping windows.
function fileHasSecret(path: string): boolean {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const size = lstatSync(path).size;
    if (size <= SCAN_WHOLE) {
      const buf = Buffer.alloc(size);
      let got = 0;
      while (got < size) {
        const n = readSync(fd, buf, got, size - got, got);
        if (n === 0) break;
        got += n;
      }
      return scanBytes(buf.subarray(0, got)).hit;
    }
    let tail = Buffer.alloc(0);
    for (let pos = 0; ; ) {
      const buf = Buffer.alloc(CHUNK);
      const n = readSync(fd, buf, 0, CHUNK, pos);
      if (n === 0) return false;
      pos += n;
      const window = Buffer.concat([tail, buf.subarray(0, n)]);
      if (scanBytes(window).hit) return true;
      tail = window.subarray(Math.max(0, window.length - OVERLAP));
    }
  } finally {
    closeSync(fd);
  }
}

function kindOf(path: string): 'dir' | 'file' | 'link' | 'other' | 'absent' {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return 'link';
    if (st.isDirectory()) return 'dir';
    if (st.isFile()) return 'file';
    return 'other';
  } catch {
    return 'absent';
  }
}

// The changes, directory by directory, from the upper layer's directories
// and the overlay's final contents.
function plan(hold: VolatileHold, workspace: string, caps: MaterializeCaps): { actions: Action[]; skipped: { path: string; why: string }[] } {
  const upper = join(hold.vol, 'upper');
  const merged = hold.merged!;
  const actions: Action[] = [];
  const skipped: { path: string; why: string }[] = [];
  let changed = 0;
  let bytes = 0;
  // Counted as the walk goes, so that a role that left more than the caps
  // allow is refused without the walk reading all of it.
  const count = (path: string, size: number) => {
    changed++;
    bytes += size;
    if (changed > caps.files) throw new OverCaps(`the role changed more than snapshot_max_files (${caps.files}) entries`);
    if (size > caps.fileBytes) throw new OverCaps(`${path} is ${size} bytes, more than snapshot_max_file_bytes (${caps.fileBytes})`);
    if (bytes > caps.bytes) throw new OverCaps(`the role changed more than snapshot_max_bytes (${caps.bytes}) bytes`);
  };
  const walk = (rel: string): void => {
    const now = new Set(readdirSync(join(merged, rel)));
    const ws = kindOf(join(workspace, rel)) === 'dir' ? readdirSync(join(workspace, rel)) : [];
    for (const name of ws) {
      if (rel === '' && name === '.git') continue;
      if (!now.has(name)) {
        count(join(rel, name), 0);
        actions.push({ kind: 'delete', path: join(rel, name) });
      }
    }
    for (const name of [...now].sort()) {
      if (rel === '' && name === '.git') continue;
      const p = join(rel, name);
      // Not in the upper layer: as the checkout has it.
      if (kindOf(join(upper, p)) === 'absent') continue;
      const st = lstatSync(join(merged, p));
      if (st.isDirectory()) {
        actions.push({ kind: 'dir', path: p, mode: st.mode & 0o777 });
        if (kindOf(join(upper, p)) === 'dir') walk(p);
      } else if (st.isFile()) {
        count(p, st.size);
        actions.push({ kind: 'file', path: p, source: join(merged, p), mode: st.mode & 0o777 });
      } else if (st.isSymbolicLink()) {
        const target = readlinkSync(join(merged, p));
        count(p, Buffer.byteLength(target));
        actions.push({ kind: 'link', path: p, target });
      }
      else skipped.push({ path: p, why: 'not a regular file, directory or link' });
    }
  };
  walk('');
  return { actions, skipped };
}

// Every component of `rel` under the workspace is a real directory (made if
// absent), never a link; the last component is cleared if it is in the way.
function prepareParent(workspace: string, rel: string): void {
  const parts = rel.split('/');
  let at = workspace;
  for (const part of parts.slice(0, -1)) {
    at = join(at, part);
    const k = kindOf(at);
    if (k === 'dir') continue;
    if (k !== 'absent') removeInside(workspace, at);
    mkdirSync(at, { mode: 0o755 });
  }
}

// Remove `path`, which must be inside the workspace (a recursive removal
// never follows a link; it unlinks one).
function removeInside(workspace: string, path: string): void {
  if (!path.startsWith(`${workspace}${sep}`) || path.split(sep).includes('..')) throw new Error(`${path} is not inside the workspace ${workspace}`);
  const k = kindOf(path);
  if (k === 'absent') return;
  if (k === 'dir') rmSync(path, { recursive: true, force: true });
  else unlinkSync(path);
}

function copyInto(source: string, target: string, mode: number): void {
  const src = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const dst = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, mode);
    try {
      const buf = Buffer.alloc(1024 * 1024);
      for (let pos = 0; ; ) {
        const n = readSync(src, buf, 0, buf.length, pos);
        if (n === 0) break;
        let off = 0;
        while (off < n) off += writeSync(dst, buf, off, n - off);
        pos += n;
      }
      fchmodSync(dst, mode);
    } finally {
      closeSync(dst);
    }
  } finally {
    closeSync(src);
  }
}

export function materialize(args: { hold: VolatileHold; home: string; workspace: string; caps: MaterializeCaps }): MaterializeResult {
  const { hold, workspace } = args;
  const bad = verifyWorkspace(args.home, workspace);
  if (bad !== null) return { state: 'refused', reason: 'workspace', path: workspace, detail: bad };
  if (hold.merged === null) return { state: 'refused', reason: 'unreadable', path: null, detail: "the workspace's overlay is not held" };
  let planned: ReturnType<typeof plan>;
  try {
    planned = plan(hold, workspace, args.caps);
  } catch (err) {
    if (err instanceof OverCaps) return { state: 'refused', reason: 'caps', path: null, detail: err.message };
    return { state: 'refused', reason: 'unreadable', path: null, detail: `what the role left could not be read: ${(err as Error).message}` };
  }
  // The secret screen (D2 §2.5): before anything is written, every name the
  // materialization would write or remove (each component of its path) and
  // every content and link target. A hit anywhere refuses all of it.
  for (const a of planned.actions) {
    if (scanBytes(Buffer.from(a.path)).hit) return { state: 'refused', reason: 'secret', path: null, detail: `a path the role left names a registered secret (a ${a.kind === 'dir' ? 'directory' : a.kind === 'delete' ? 'removal' : a.kind})` };
  }
  for (const a of planned.actions) {
    if (a.kind === 'file' && fileHasSecret(a.source)) return { state: 'refused', reason: 'secret', path: a.path, detail: `${a.path} holds a registered secret` };
    if (a.kind === 'link' && scanBytes(Buffer.from(a.target)).hit) return { state: 'refused', reason: 'secret', path: a.path, detail: `the link ${a.path} names a registered secret` };
  }
  const written: string[] = [];
  const removed: string[] = [];
  for (const a of planned.actions) {
    const target = join(workspace, a.path);
    if (a.kind === 'delete') {
      removeInside(workspace, target);
      removed.push(a.path);
      continue;
    }
    prepareParent(workspace, a.path);
    if (a.kind === 'dir') {
      if (kindOf(target) !== 'dir') {
        removeInside(workspace, target);
        mkdirSync(target, { mode: a.mode });
      }
      continue;
    }
    if (a.kind === 'file') {
      if (kindOf(target) !== 'file' && kindOf(target) !== 'absent') removeInside(workspace, target);
      copyInto(a.source, target, a.mode);
      written.push(a.path);
      continue;
    }
    removeInside(workspace, target);
    symlinkSync(a.target, target);
    written.push(a.path);
  }
  return { state: 'materialized', written, removed, skipped: planned.skipped };
}
