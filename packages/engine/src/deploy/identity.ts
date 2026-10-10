// Identity from the target (D4 §3.4; RV1; E110; SEAM.md §§259, 262): what
// runs, read from the host's /proc and cgroup files, never asked of the
// application. Main thread, asynchronous reads, no process started: the
// unit's own state comes from the adapter's `systemctl show`
// (adapters/local-service.ts), which hands it in.
//
// The read binds the original application instance recorded at its launch
// and checks, as a stable snapshot: the unit's invocation and cgroup, the
// init's and the application's pid and start time (before and after); the
// application in the unit's cgroup, a child of the recorded init; its
// executable's bytes the configured runtime's; its arguments the start
// command; /surety/app a read-only bind of the sealed directory of the
// expected digest, with / and /surety read-only; and the tree at
// /proc/<pid>/root/surety/app, walked following no link and opening no
// special file, hashing to the digest with each file's mode class. A change
// between the snapshot's halves is `unread` (the process went) or `differs`
// (another was read), never a mixed `match`. Every read is bounded by the
// caller's signal (`adapter_read_deadline`) and by the manifest's entry
// count and bytes.

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { open, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';

import { pausePoint } from '../testing/seam.js';
import type { IdentityRead, Instance, TargetExpectation } from './adapter.js';

export interface UnitState {
  loaded: boolean;
  active: boolean;
  invocationId: string | null;
  mainPid: number | null;
  cgroup: string | null; // /sys/fs/cgroup + ControlGroup
}

export interface IdentityFaults {
  startTimeSkew?: boolean;
  procUnreadable?: boolean;
}

class Unread extends Error {
  constructor(readonly field: string, why: string) {
    super(why);
  }
}

class Differs extends Error {
  constructor(readonly field: string, readonly expected: unknown, readonly read: unknown) {
    super(`${field} differs`);
  }
}

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

// /proc/<pid>/stat field 22 and the parent, or null when the process is gone.
export function procStat(pid: number): { start_time: number; ppid: number; state: string } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { state: rest[0]!, ppid: Number(rest[1]), start_time: Number(rest[19]) };
  } catch {
    return null;
  }
}

// The innermost NSpid of a host pid, or null.
export function innerPid(pid: number): number | null {
  try {
    const line = readFileSync(`/proc/${pid}/status`, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('NSpid:'));
    const parts = line?.slice(6).trim().split(/\s+/).map(Number) ?? [];
    return parts.length > 0 ? parts[parts.length - 1]! : null;
  } catch {
    return null;
  }
}

// The cgroup a host process is in, as a path under /sys/fs/cgroup, or null.
export function cgroupOf(pid: number): string | null {
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('0::'));
    return line ? join('/sys/fs/cgroup', line.slice(3)) : null;
  } catch {
    return null;
  }
}

export function cmdlineOf(pid: number): string[] | null {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const parts = raw.split('\0');
    if (parts.at(-1) === '') parts.pop();
    return parts;
  } catch {
    return null;
  }
}

// SHA-256 of a host process's executable's bytes.
export async function exeSha(pid: number, signal?: AbortSignal): Promise<string | null> {
  try {
    const fh = await open(`/proc/${pid}/exe`, constants.O_RDONLY);
    try {
      const h = createHash('sha256');
      const buf = Buffer.alloc(1 << 20);
      for (;;) {
        if (signal?.aborted) return null;
        const { bytesRead } = await fh.read(buf, 0, buf.length, null);
        if (bytesRead === 0) break;
        h.update(buf.subarray(0, bytesRead));
      }
      return h.digest('hex');
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

// The mount table of a host process: [{point, root, dev, options, fstype, superopts}].
export function mountsOf(text: string): { point: string; root: string; dev: string; options: string[]; fstype: string; superopts: string[] }[] {
  const un = (p: string) => p.replace(/\\(\d{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
  return text
    .trim()
    .split('\n')
    .map((l) => {
      const parts = l.split(' ');
      const dash = parts.indexOf('-');
      return { dev: parts[2]!, root: un(parts[3]!), point: un(parts[4]!), options: parts[5]!.split(','), fstype: parts[dash + 1]!, superopts: (parts[dash + 3] ?? '').split(',') };
    });
}

const mountAt = (mounts: ReturnType<typeof mountsOf>, path: string) =>
  mounts.filter((m) => path === m.point || path.startsWith(m.point === '/' ? '/' : `${m.point}/`)).sort((a, b) => b.point.length - a.point.length)[0];

// Where a host path lies: its mount's device and the path within that
// mount's filesystem, as mountinfo writes a bind's root.
export function hostBindRoot(path: string): { dev: string; root: string } | null {
  try {
    const mounts = mountsOf(readFileSync('/proc/self/mountinfo', 'utf8'));
    const m = mountAt(mounts, path);
    if (!m) return null;
    const within = m.point === '/' ? path : path.slice(m.point.length) || '/';
    const root = m.root === '/' ? within : `${m.root}${within}`;
    return { dev: m.dev, root };
  } catch {
    return null;
  }
}

type Entry = [path: string, type: 'file', mode: '100644' | '100755', size: number, sha256: string];

// The tree at `root`, walked from the host: every regular file with its mode
// class and hash; a link, a special file or a write bit makes it `differs`;
// more entries or bytes than the manifest's make it `differs` at once.
// Synchronous system calls in bounded batches (the slice-24 measurement:
// one asynchronous call per lstat, open, stat, read and close made 20,000
// small files take 11 s, past adapter_read_deadline): the event loop gets
// a turn every `YIELD_ENTRIES` entries or `YIELD_BYTES` bytes, and the
// deadline is checked there and at every entry.
const YIELD_ENTRIES = 512;
const YIELD_BYTES = 16 * 1024 * 1024;
const CHUNK = 1024 * 1024;

export async function walkTree(root: string, limit: { entries: number; bytes: number }, signal: AbortSignal, procRead: (path: string) => void): Promise<{ entries: Entry[]; odd: string | null }> {
  const entries: Entry[] = [];
  let bytes = 0;
  let odd: string | null = null;
  let sinceYield = 0;
  let bytesSinceYield = 0;
  const buf = Buffer.alloc(CHUNK);
  const pause = async (): Promise<void> => {
    sinceYield = 0;
    bytesSinceYield = 0;
    await new Promise<void>((r) => setImmediate(r));
    if (signal.aborted) throw new Unread('tree', 'the read passed adapter_read_deadline');
  };
  // One regular file read and hashed, opened following no link and blocking
  // on no special file; null when it changed under the read.
  const hashFile = (full: string, ino: number): { size: number; hex: string } | null => {
    const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const fst = fstatSync(fd);
      if (!fst.isFile() || fst.ino !== ino) return null;
      const h = createHash('sha256');
      let size = 0;
      for (;;) {
        const n = readSync(fd, buf, 0, CHUNK, null);
        if (n === 0) break;
        h.update(buf.subarray(0, n));
        size += n;
        if (size > limit.bytes) break;
      }
      return { size, hex: h.digest('hex') };
    } finally {
      closeSync(fd);
    }
  };
  const visit = async (dir: string, rel: string): Promise<void> => {
    if (odd !== null) return;
    procRead(dir);
    const names = readdirSync(dir).sort();
    for (const name of names) {
      if (signal.aborted) throw new Unread('tree', 'the read passed adapter_read_deadline');
      const full = join(dir, name);
      const relPath = rel === '' ? name : `${rel}/${name}`;
      const st = lstatSync(full);
      if (st.isDirectory()) {
        await visit(full, relPath);
        if (odd !== null) return;
        continue;
      }
      if (!st.isFile()) {
        odd = `${relPath} is no regular file`;
        return;
      }
      // Presented read-only (D4 §3.1, §3.4): a write bit is `differs`.
      if (st.mode & 0o222) {
        odd = `${relPath} has a write bit`;
        return;
      }
      if (entries.length + 1 > limit.entries || bytes + st.size > limit.bytes) {
        odd = 'more entries or bytes than the manifest holds';
        return;
      }
      const got = hashFile(full, st.ino);
      if (got === null) {
        odd = `${relPath} changed while it was read`;
        return;
      }
      bytes += got.size;
      if (bytes > limit.bytes) {
        odd = 'more entries or bytes than the manifest holds';
        return;
      }
      entries.push([relPath, 'file', st.mode & 0o111 ? '100755' : '100644', got.size, got.hex]);
      sinceYield += 1;
      bytesSinceYield += got.size;
      if (sinceYield >= YIELD_ENTRIES || bytesSinceYield >= YIELD_BYTES) await pause();
    }
  };
  await visit(root, '');
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { entries, odd };
}

// One identity read of one target (D4 §3.4 step 4), given the unit's state
// read now (`readUnit`, called before and after). Never throws.
export async function readIdentity(args: {
  expect: TargetExpectation;
  readUnit: () => Promise<UnitState | null>;
  signal: AbortSignal;
  faults?: IdentityFaults;
}): Promise<IdentityRead> {
  const { expect: x, signal } = args;
  const started = performance.now();
  const at = new Date().toISOString();
  const base = { target: x.target, method: 'tree_digest', expected: x.digest, generation: x.generation ?? ('unread' as const), at };
  const app = x.instance;
  const done = (r: Omit<IdentityRead, 'target' | 'method' | 'expected' | 'generation' | 'at' | 'duration_ms'>): IdentityRead => ({ ...base, ...r, duration_ms: Math.round(performance.now() - started) });
  if (!app || !x.init || !x.cgroup) return done({ read: 'unread', match: 'unread', instance: 'unread', detail: { field: 'instance', why: 'no original application instance was recorded at its launch' } });
  // Every fact the read compares must be expected: a missing one is not a
  // check skipped but a read that cannot be made (the slice-24 review, m2).
  const missing = (['invocation_id', 'exe_sha256', 'argv', 'sealed_path', 'manifest'] as const).filter((k) => x[k] === null || x[k] === undefined || x[k] === '');
  if (missing.length > 0) return done({ read: 'unread', match: 'unread', instance: 'unread', detail: { field: missing[0]!, why: `nothing recorded to compare ${missing.join(', ')} with` } });
  const want = { invocation_id: x.invocation_id!, exe_sha256: x.exe_sha256!, argv: x.argv!, sealed_path: x.sealed_path!, manifest: x.manifest! };
  const procRead = (path: string) => {
    if (args.faults?.procUnreadable && path.startsWith(`/proc/${app.pid}/`)) {
      const err = new Error(`EACCES: permission denied, ${path}`) as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    }
  };
  const startOf = (pid: number): number | null => {
    if (pid === app.pid) procRead(`/proc/${pid}/stat`);
    const s = procStat(pid);
    if (s === null) return null;
    return pid === app.pid && args.faults?.startTimeSkew ? s.start_time + 1 : s.start_time;
  };
  // The snapshot's first half: the unit, the init, the application.
  const snapshot = async (): Promise<{ unit: UnitState | null; init: number | null; app: number | null }> => ({ unit: await args.readUnit(), init: startOf(x.init!.pid), app: startOf(app.pid) });
  try {
    const first = await snapshot();
    const check = (s: typeof first, half: string) => {
      if (s.unit === null) throw new Unread('unit', `the unit could not be read (${half})`);
      if (!s.unit.loaded || !s.unit.active) throw new Unread('unit', `the unit is not active (${half})`);
      if (s.unit.invocationId !== want.invocation_id) throw new Differs('invocation_id', want.invocation_id, s.unit.invocationId);
      if (s.unit.cgroup !== x.cgroup) throw new Differs('cgroup', x.cgroup, s.unit.cgroup);
      if (s.init === null) throw new Unread('init', `the recorded init ${x.init!.pid} is gone (${half})`);
      if (s.init !== x.init!.start_time) throw new Differs('init', x.init!.start_time, s.init);
      if (s.app === null) throw new Unread('instance', `the application ${app.pid} is gone (${half})`);
      if (s.app !== app.start_time) throw new Differs('start_time', app.start_time, s.app);
    };
    check(first, 'first half');
    await pausePoint('identity.between_halves');
    if (signal.aborted) throw new Unread('deadline', 'the read passed adapter_read_deadline');
    // The application in the unit's cgroup, a child of the recorded init.
    procRead(`/proc/${app.pid}/cgroup`);
    const cg = cgroupOf(app.pid);
    if (cg === null) throw new Unread('cgroup', 'the application\'s cgroup could not be read');
    if (cg !== x.cgroup && !cg.startsWith(`${x.cgroup}/`)) throw new Differs('cgroup', x.cgroup, cg);
    const parent = procStat(app.pid)?.ppid ?? null;
    if (parent === null) throw new Unread('instance', 'the application is gone');
    if (parent !== x.init.pid) throw new Differs('parent', x.init.pid, parent);
    // Its executable and arguments.
    procRead(`/proc/${app.pid}/exe`);
    const exe = await exeSha(app.pid, signal);
    if (exe === null) throw new Unread('exe', 'the executable could not be read');
    if (exe !== want.exe_sha256) throw new Differs('exe', want.exe_sha256, exe);
    procRead(`/proc/${app.pid}/cmdline`);
    const argv = cmdlineOf(app.pid);
    if (argv === null) throw new Unread('argv', 'the arguments could not be read');
    if (JSON.stringify(argv) !== JSON.stringify(want.argv)) throw new Differs('argv', want.argv, argv);
    // The mounts: /surety/app a read-only bind of the sealed directory; / and /surety read-only.
    procRead(`/proc/${app.pid}/mountinfo`);
    let mounts: ReturnType<typeof mountsOf>;
    try {
      mounts = mountsOf(await readFile(`/proc/${app.pid}/mountinfo`, 'utf8'));
    } catch {
      throw new Unread('mounts', 'the mount table could not be read');
    }
    const appMount = mountAt(mounts, '/surety/app');
    if (!appMount || appMount.point !== '/surety/app') throw new Differs('mounts', '/surety/app a mount of its own', appMount?.point ?? null);
    const ro = (m: (typeof mounts)[number] | undefined) => m !== undefined && (m.options.includes('ro') || m.superopts.includes('ro')) && !(m.fstype === 'overlay' && m.superopts.some((o) => o.startsWith('upperdir=')));
    for (const p of ['/', '/surety', '/surety/app']) if (!ro(mountAt(mounts, p))) throw new Differs('mounts', `${p} read-only`, mountAt(mounts, p)?.options ?? null);
    const bind = hostBindRoot(want.sealed_path);
    if (bind === null) throw new Unread('mounts', "the sealed directory's mount could not be read");
    if (appMount.dev !== bind.dev || appMount.root !== bind.root) throw new Differs('mounts', bind, { dev: appMount.dev, root: appMount.root });
    // The tree.
    const manifest = want.manifest as Entry[];
    const limit = { entries: manifest.length, bytes: manifest.reduce((n, e) => n + Number(e[3] ?? 0), 0) };
    const root = `/proc/${app.pid}/root/surety/app`;
    procRead(root);
    try {
      lstatSync(root);
    } catch {
      throw new Unread('tree', 'the tree could not be reached');
    }
    let walked: Awaited<ReturnType<typeof walkTree>>;
    try {
      walked = await walkTree(root, limit, signal, procRead);
    } catch (err) {
      if (err instanceof Unread || err instanceof Differs) throw err;
      throw new Unread('tree', `the tree could not be read: ${(err as Error).message}`);
    }
    // The snapshot's second half.
    const second = await snapshot();
    check(second, 'second half');
    if (second.unit!.mainPid !== first.unit!.mainPid) throw new Differs('unit', first.unit!.mainPid, second.unit!.mainPid);
    const instance: Instance & { invocation_id: string | null } = { invocation_id: second.unit!.invocationId, pid: app.pid, start_time: app.start_time };
    if (walked.odd !== null) return done({ read: 'unread', match: 'differs', instance, detail: { field: 'tree', why: walked.odd } });
    const digest = `sha256:${sha(JSON.stringify(walked.entries))}`;
    if (digest !== x.digest) return done({ read: digest, match: 'differs', instance, detail: { field: 'tree', expected: x.digest, read: digest } });
    return done({ read: digest, match: 'match', instance, detail: null });
  } catch (err) {
    if (err instanceof Differs) return done({ read: 'unread', match: 'differs', instance: { pid: app.pid, start_time: app.start_time }, detail: { field: err.field, expected: err.expected, read: err.read } });
    if (err instanceof Unread) return done({ read: 'unread', match: 'unread', instance: 'unread', detail: { field: err.field, why: err.message } });
    return done({ read: 'unread', match: 'unread', instance: 'unread', detail: { field: 'read', why: (err as Error).message } });
  }
}

// The host pid of a domain member whose innermost NSpid is `nsPid` and whose
// parent is `parent` (D4 §3.4 step 3): every such member of the cgroup.
export async function membersNamed(cgroup: string, nsPid: number, parent: number): Promise<number[]> {
  let procs: number[];
  try {
    procs = (await readFile(join(cgroup, 'cgroup.procs'), 'utf8'))
      .split('\n')
      .filter((l) => /^\d+$/.test(l))
      .map(Number);
  } catch {
    return [];
  }
  return procs.filter((p) => innerPid(p) === nsPid && procStat(p)?.ppid === parent);
}

export async function exeLink(pid: number): Promise<string | null> {
  try {
    return await readlink(`/proc/${pid}/exe`);
  } catch {
    return null;
  }
}
