// The domain's volatile filesystem, held by the engine from outside the
// sandbox (D2 §§1.4, 2.3, 2.5, 4.3; E58 item 1). Every location a role can
// write is one tmpfs mounted in the sandbox's own mount namespace, and the
// workspace an overlay whose upper layer is on it. Nothing of either is on
// durable disk, and the host cannot reach them by path. While the setup stage
// still has both mounted, before the pivot, the engine opens a directory
// descriptor on each through /proc/<init>/root (the init is the engine's own
// helper, uid 1000 in a user namespace the engine's uid owns); the open
// descriptors keep both filesystems alive after the sandbox's processes and
// mount namespace are gone, so that what the role left can be screened and
// materialized, or collected, after termination is established, and only
// then. The engine drops them when the run ends; a crash drops them with the
// engine, and what they held is lost, never written to disk (D2 §8 class C).
//
// Every read through a hold names a path inside it and never follows a link:
// each component is checked with lstat, the last is opened with O_NOFOLLOW
// and checked again on the descriptor (D2 §1.4: "without following links,
// refusing anything but a regular file").

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';

export const TMPFS_MAGIC = 0x01021994;
export const OVERLAYFS_MAGIC = 0x794c7630;

// The domain init's host pid: the one child of the launcher (`unshare
// --fork`), which is process 1 of the sandbox's pid namespace (NSpid ends
// with 1). null if it cannot be established.
export function initHostPid(launcherPid: number): number | null {
  let kids: number[];
  try {
    kids = readFileSync(`/proc/${launcherPid}/task/${launcherPid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return null;
  }
  for (const pid of kids) {
    try {
      const line = readFileSync(`/proc/${pid}/status`, 'utf8')
        .split('\n')
        .find((l) => l.startsWith('NSpid:'));
      const ids = line ? line.slice(6).trim().split(/\s+/) : [];
      if (ids.length >= 2 && ids.at(-1) === '1') return pid;
    } catch {
      // gone meanwhile
    }
  }
  return null;
}

function openDir(path: string, magic: number, what: string): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const type = statfsSync(`/proc/self/fd/${fd}`).type;
    if (type !== magic) throw new Error(`${what} is not the filesystem the plan mounted (type 0x${type.toString(16)})`);
    return fd;
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

// A tmpfs mounted with `size=<bytes>,nr_inodes=<inodes>` reports, by statfs,
// whole pages covering the size and exactly the inode count. null when the
// filesystem at `path` is so bounded; otherwise what it reports.
export function volatileBoundsWrong(path: string, bounds: { bytes: number; inodes: number }): string | null {
  let st;
  try {
    st = statfsSync(path);
  } catch (err) {
    return `the volatile filesystem's bounds cannot be read (${(err as NodeJS.ErrnoException).code ?? 'error'})`;
  }
  const size = st.blocks * st.bsize;
  const pageUp = Math.ceil(bounds.bytes / st.bsize) * st.bsize;
  if (size !== pageUp) return `the volatile filesystem holds ${size} bytes, not the ${bounds.bytes} of domain_writable_bytes`;
  if (st.files !== bounds.inodes) return `the volatile filesystem holds ${st.files} inodes, not the ${bounds.inodes} of domain_writable_inodes`;
  return null;
}

export class VolatileHold {
  private open = true;

  private constructor(
    private readonly volFd: number,
    private readonly mergedFd: number | null,
  ) {}

  // Take hold of the volatile filesystem at `vol` and the workspace's overlay
  // at `merged` (host paths as the setup stage's mount namespace has them),
  // through the init's root. Throws if either is not what the plan mounted.
  static take(launcherPid: number, vol: string, merged: string | null, bounds?: { bytes: number; inodes: number }): VolatileHold {
    const init = initHostPid(launcherPid);
    if (init === null) throw new Error(`the domain init of launcher ${launcherPid} could not be found`);
    const root = `/proc/${init}/root`;
    const volFd = openDir(`${root}${vol}`, TMPFS_MAGIC, 'the volatile filesystem');
    let mergedFd: number | null = null;
    try {
      // The bounds are the mount's own options, read back from the kernel
      // before the role starts (D2 §§2.3, 3.7): a volatile filesystem that is
      // not as bounded as the plan says is never handed to a role.
      if (bounds) {
        const wrong = volatileBoundsWrong(`/proc/self/fd/${volFd}`, bounds);
        if (wrong !== null) throw new Error(wrong);
      }
      if (merged !== null) mergedFd = openDir(`${root}${merged}`, OVERLAYFS_MAGIC, "the workspace's overlay");
    } catch (err) {
      closeSync(volFd);
      throw err;
    }
    return new VolatileHold(volFd, mergedFd);
  }

  get held(): boolean {
    return this.open;
  }

  // The volatile filesystem's root and the workspace as the role left it,
  // as paths through this process's descriptors.
  get vol(): string {
    if (!this.open) throw new Error('the volatile filesystem is no longer held');
    return `/proc/self/fd/${this.volFd}`;
  }

  get merged(): string | null {
    if (!this.open) throw new Error('the volatile filesystem is no longer held');
    return this.mergedFd === null ? null : `/proc/self/fd/${this.mergedFd}`;
  }

  release(): void {
    if (!this.open) return;
    this.open = false;
    for (const fd of [this.volFd, this.mergedFd]) {
      if (fd === null) continue;
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

// A relative path's components, refused if it climbs or is absolute.
export function components(rel: string): string[] | null {
  if (rel.startsWith('/')) return null;
  const parts = rel.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  return parts;
}

export type RegularRead =
  | { state: 'read'; bytes: Buffer }
  | { state: 'absent' }
  | { state: 'refused'; reason: 'link' | 'fifo' | 'socket' | 'device' | 'directory' | 'oversize' | 'path' | 'unreadable'; detail: string };

// Read `rel` under `base` as a regular file of at most `maxBytes`, never
// following a link and never opening anything else (D2 §1.4, A.6 P18): a
// FIFO is never opened, so no writer waiting on it is released; a device is
// never read; a file over the bound is not read past it.
export function readRegular(base: string, rel: string, maxBytes: number): RegularRead {
  const parts = components(rel);
  if (parts === null || parts.length === 0) return { state: 'refused', reason: 'path', detail: `${rel} is not a path inside the volatile filesystem` };
  let at = base;
  for (let i = 0; i < parts.length; i++) {
    at = join(at, parts[i]!);
    let st;
    try {
      st = lstatSync(at);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
      return { state: 'refused', reason: 'unreadable', detail: `${parts.slice(0, i + 1).join('/')}: ${(err as NodeJS.ErrnoException).code ?? 'error'}` };
    }
    const last = i === parts.length - 1;
    if (st.isSymbolicLink()) return { state: 'refused', reason: 'link', detail: `${parts.slice(0, i + 1).join('/')} is a symbolic link` };
    if (!last) {
      if (!st.isDirectory()) return { state: 'refused', reason: 'path', detail: `${parts.slice(0, i + 1).join('/')} is not a directory` };
      continue;
    }
    if (st.isFIFO()) return { state: 'refused', reason: 'fifo', detail: `${rel} is a FIFO` };
    if (st.isSocket()) return { state: 'refused', reason: 'socket', detail: `${rel} is a socket` };
    if (st.isCharacterDevice() || st.isBlockDevice()) return { state: 'refused', reason: 'device', detail: `${rel} is a device` };
    if (st.isDirectory()) return { state: 'refused', reason: 'directory', detail: `${rel} is a directory` };
    if (!st.isFile()) return { state: 'refused', reason: 'unreadable', detail: `${rel} is not a regular file` };
    if (st.size > maxBytes) return { state: 'refused', reason: 'oversize', detail: `${rel} holds ${st.size} bytes, more than ${maxBytes}` };
  }
  let fd: number;
  try {
    fd = openSync(at, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    return { state: 'refused', reason: 'unreadable', detail: `${rel}: ${(err as NodeJS.ErrnoException).code ?? 'error'}` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { state: 'refused', reason: 'unreadable', detail: `${rel} changed into something other than a regular file` };
    const buf = Buffer.alloc(Math.min(maxBytes + 1, Math.max(st.size + 1, 1)));
    let got = 0;
    for (;;) {
      if (got === buf.length) break;
      const n = readSync(fd, buf, got, buf.length - got, null);
      if (n === 0) break;
      got += n;
    }
    if (got > maxBytes) return { state: 'refused', reason: 'oversize', detail: `${rel} holds more than ${maxBytes} bytes` };
    return { state: 'read', bytes: buf.subarray(0, got) };
  } finally {
    closeSync(fd);
  }
}

// The names in a directory under `base`, never through a link; null if it is
// not a directory reached without one.
export function listDir(base: string, rel: string): string[] | null {
  const parts = components(rel);
  if (parts === null) return null;
  let at = base;
  for (const p of parts) {
    at = join(at, p);
    try {
      if (!lstatSync(at).isDirectory()) return null;
    } catch {
      return null;
    }
  }
  try {
    return readdirSync(at);
  } catch {
    return null;
  }
}
