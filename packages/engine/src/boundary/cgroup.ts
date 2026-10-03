// The cgroup v2 side of the execution boundary (D2 §§3.1 to 3.4, 3.7): the
// files of the delegated subtree the engine reads and writes. Nothing here
// starts a process; the scope itself is created in boundary/scope.ts.
//
// Every observation distinguishes what the file says from what could not be
// read: an unreadable `cgroup.events` is never taken for `populated 0`, and an
// absent directory is reported as absent, for the caller to judge against the
// verified hierarchy (D2 §3.3).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const CGROUP_ROOT = '/sys/fs/cgroup';

// The leaf the engine (and every launcher before its placement) lives in.
export const SUPERVISOR_LEAF = 'supervisor';

// The scope unit's name for an engine home and an incarnation (D2 §3.1):
// `surety-<home>-<incarnation>.scope`, `<home>` the first sixteen hex digits
// of the SHA-256 of $SURETY_HOME's resolved path (SEAM.md §124).
export function homeHash(home: string): string {
  let real = home;
  try {
    real = realpathSync(home);
  } catch {
    // judged as given
  }
  return createHash('sha256').update(real).digest('hex').slice(0, 16);
}

export function scopeUnit(home: string, incarnation: string): string {
  return `surety-${homeHash(home)}-${incarnation}.scope`;
}

// The cgroup of this process, as a filesystem path under CGROUP_ROOT, from
// /proc/self/cgroup's unified line; null if it cannot be read.
export function ownCgroup(pid: number | 'self' = 'self'): string | null {
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('0::'));
    if (!line) return null;
    return join(CGROUP_ROOT, line.slice(3));
  } catch {
    return null;
  }
}

export type Populated = { state: 'populated'; value: 0 | 1 } | { state: 'absent' } | { state: 'unreadable'; detail: string };

// `cgroup.events`'s `populated` line. A directory that does not exist is
// `absent`; a file that exists and cannot be read, or says nothing
// recognizable, is `unreadable` (D2 §3.4).
export function readPopulated(path: string): Populated {
  let text: string;
  try {
    text = readFileSync(join(path, 'cgroup.events'), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'error';
    if (code === 'ENOENT') {
      // The file is missing: the directory is gone, or this is not a cgroup.
      try {
        statSync(path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
        return { state: 'unreadable', detail: `${path}: ${(e as NodeJS.ErrnoException).code ?? 'error'}` };
      }
      return { state: 'unreadable', detail: `${path} holds no cgroup.events` };
    }
    return { state: 'unreadable', detail: `${join(path, 'cgroup.events')}: ${code}` };
  }
  const m = /^populated ([01])$/m.exec(text);
  if (!m) return { state: 'unreadable', detail: `${join(path, 'cgroup.events')} has no populated line` };
  return { state: 'populated', value: m[1] === '1' ? 1 : 0 };
}

// The members, by host pid, from `cgroup.procs`: for the operator and for
// signalling, never as the test of emptiness (D2 §3.2). null if unreadable.
export function readProcs(path: string): number[] | null {
  try {
    return readFileSync(join(path, 'cgroup.procs'), 'utf8')
      .split('\n')
      .filter((l) => /^\d+$/.test(l))
      .map(Number);
  } catch {
    return null;
  }
}

export type KillResult = { state: 'written' } | { state: 'absent' } | { state: 'refused'; detail: string };

// The last line of defence for every write that kills, moves or removes
// (D2 §§3.3, 3.4): a path the engine acts on is an engine scope of the form
// `surety-<16 hex>-inc_<ULID>.scope` under /sys/fs/cgroup, or one directory
// directly inside one (its supervisor leaf, a domain, a probe cgroup). An
// empty path, the scope's parent (`app.slice`), the user manager's own
// cgroup, or anything with `..` is never written, whatever the store says.
// The callers verify more first: that the scope is this home's and, for a
// domain, the one of the incarnation that owned it.
const ENGINE_SCOPE_PATH = /^\/sys\/fs\/cgroup(\/[^/]+)+\/surety-[0-9a-f]{16}-inc_[0-9A-HJKMNP-TV-Z]{26}\.scope(\/[A-Za-z0-9_]+)?$/;
export const isEngineScopePath = (path: string): boolean => typeof path === 'string' && !path.split('/').includes('..') && ENGINE_SCOPE_PATH.test(path);

// `cgroup.kill` (kernel 5.14): every process of the subtree is sent SIGKILL.
// Writing it is not termination; only a later `populated 0` is (D2 §3.2).
export function writeKill(path: string): KillResult {
  if (!isEngineScopePath(path)) return { state: 'refused', detail: `${path || '(empty)'} is not an engine scope's cgroup; nothing was written` };
  try {
    writeFileSync(join(path, 'cgroup.kill'), '1');
    return { state: 'written' };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'error';
    if (code === 'ENOENT') {
      try {
        statSync(path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
      }
    }
    return { state: 'refused', detail: `${join(path, 'cgroup.kill')}: ${code}` };
  }
}

// The directory's inode, which identifies one creation of a cgroup: a
// directory removed and made again at the same path has another (D2 §3.4,
// "a recreated directory never terminates"). null if it cannot be read.
export function cgroupInode(path: string): number | null {
  try {
    return statSync(path).ino;
  } catch {
    return null;
  }
}

export interface DomainLimits {
  memoryMax: number;
  tasksMax: number;
}

// A domain's cgroup (D2 §§3.1, 3.7): created by the engine, never by a
// launcher, with its limits: `memory.max`, `memory.swap.max` 0 (nothing of the
// domain, the volatile filesystem included, is swapped), `pids.max`. Returns
// the directory's inode. A limit that cannot be set is an error: a domain
// without its bounds is not launched.
export function createDomainCgroup(path: string, limits: DomainLimits): number {
  if (!isEngineScopePath(path)) throw new Error(`${path || '(empty)'} is not inside an engine scope`);
  mkdirSync(path);
  writeFileSync(join(path, 'memory.max'), String(limits.memoryMax));
  writeFileSync(join(path, 'memory.swap.max'), '0');
  writeFileSync(join(path, 'pids.max'), String(limits.tasksMax));
  const ino = cgroupInode(path);
  if (ino === null) throw new Error(`the cgroup ${path} could not be read back`);
  return ino;
}

// Remove an empty cgroup. Only after `terminated` is recorded (D2 §3.2).
export function removeCgroup(path: string): boolean {
  if (!isEngineScopePath(path)) return false;
  try {
    rmdirSync(path);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

// Move a process (all its threads) into a cgroup.
export function movePid(path: string, pid: number): void {
  if (!isEngineScopePath(path)) throw new Error(`${path || '(empty)'} is not an engine scope's cgroup`);
  writeFileSync(join(path, 'cgroup.procs'), String(pid));
}

export function readControllers(path: string, file: 'cgroup.controllers' | 'cgroup.subtree_control'): string[] | null {
  try {
    return readFileSync(join(path, file), 'utf8').trim().split(/\s+/).filter(Boolean);
  } catch {
    return null;
  }
}

export function listChildren(path: string): string[] | null {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return null;
  }
}

// ---- the verified hierarchy (D2 §3.3) -------------------------------------------------------

// The parent under which this home's scopes live: the user manager's
// `app.slice`, as the scope recorded it.
export function scopeParent(scopePath: string): string {
  return dirname(scopePath);
}

const SCOPE_NAME = /^surety-([0-9a-f]{16})-(inc_[0-9A-HJKMNP-TV-Z]{26})\.scope$/;

export interface PathVerdict {
  // `inside`: the recorded path is the domain's directory in a scope of this
  // home under the verified parent; `outside`: anything else.
  where: 'inside' | 'outside';
  detail: string;
}

// Is `recorded` the domain's own cgroup in a scope of this home, under the
// verified parent (`app.slice` of this user's manager)? A path that is not,
// whatever is there, is outside the verified hierarchy and its domain is
// `unknown` (D2 §§3.3, 3.4).
export function verifyDomainPath(recorded: string, args: { parent: string; home: string; domain: string; incarnation: string }): PathVerdict {
  if (dirname(dirname(recorded)) !== args.parent) return { where: 'outside', detail: `${recorded} is not under ${args.parent}` };
  if (basename(recorded) !== args.domain) return { where: 'outside', detail: `${recorded} is not the directory of ${args.domain}` };
  const m = SCOPE_NAME.exec(basename(dirname(recorded)));
  if (!m) return { where: 'outside', detail: `${dirname(recorded)} is not an engine scope` };
  if (m[1] !== homeHash(args.home)) return { where: 'outside', detail: `${dirname(recorded)} is a scope of another engine home` };
  if (m[2] !== args.incarnation) return { where: 'outside', detail: `${dirname(recorded)} is not the scope of incarnation ${args.incarnation}, which owned the domain` };
  return { where: 'inside', detail: recorded };
}

// Is `path` the scope of `incarnation` of this home, directly under the
// verified parent (D2 §3.3)?
export function isHomeScope(path: string, args: { parent: string; home: string; incarnation: string }): boolean {
  return dirname(path) === args.parent && basename(path) === scopeUnit(args.home, args.incarnation) && isEngineScopePath(path);
}

// The scopes of earlier incarnations of this home under the verified parent,
// by incarnation, read from the parent directory; null if it cannot be read.
export function homeScopes(parent: string, home: string): Map<string, string> | null {
  const children = listChildren(parent);
  if (children === null) return null;
  const out = new Map<string, string>();
  const hash = homeHash(home);
  for (const name of children) {
    const m = SCOPE_NAME.exec(name);
    if (m && m[1] === hash) out.set(m[2]!, join(parent, name));
  }
  return out;
}
