// The host's samples of a canary domain's processes (D2 §7.2; the M2 plan's
// M136 (c): "no second backend process ever appears in `cgroup.procs`
// sampled from the host"). Reads only: `cgroup.procs` of the domain, and for
// each member the file its `/proc/<pid>/exe` names (compared with the
// qualified binary by device and inode, which a read-only bind keeps) or,
// where that is refused (a non-dumpable process, such as the domain init),
// the first word of its command line. It signals, moves and writes nothing.

import { closeSync, constants, openSync, readSync, statSync } from 'node:fs';
import { basename } from 'node:path';

import { readProcs } from '../boundary/cgroup.js';
import type { BackendSampling } from './adapters/claude.js';

export interface Sampler {
  sample(): void;
  stop(): BackendSampling;
}

// What counts as a backend process (SEAM.md §172; the dress rehearsal's
// second engine finding): a member running the qualified binary, except a
// fork of it that has not exec'd (the kernel's PF_FORKNOEXEC) and is younger
// than FORK_GRACE_MS by its start time. A process starts a program by
// forking a child that is its own image until the child's exec; Claude Code
// does so for every command it runs, and such a child caught before its exec
// is not a second backend. One that stays unexec'd past the bound runs the
// backend's own code, and is one. A flag or age that cannot be read counts
// the member as a backend.
export const FORK_GRACE_MS = 1000;

export type MemberClass = 'backend' | 'fork' | 'other';

// What the sampler reads; the host's /proc and cgroup by default.
export interface SamplerIo {
  procs(): number[] | null;
  // null: neither its executable nor its command line could be read.
  classify(pid: number): MemberClass | null;
  cmdline(pid: number): string | null;
}

export function startBackendSampler(cgroupPath: string, binaryPath: string, everyMs = 250, io?: SamplerIo): Sampler {
  let target: { dev: number; ino: number } | null = null;
  if (io === undefined) {
    try {
      const st = statSync(binaryPath);
      target = { dev: st.dev, ino: st.ino };
    } catch {
      target = null;
    }
  }
  const read: SamplerIo = io ?? {
    procs: () => readProcs(cgroupPath),
    classify: (pid) => (target === null ? null : classifyMember(pid, target, binaryPath)),
    cmdline,
  };
  const known = io !== undefined || target !== null;
  const report: BackendSampling = { samples: 0, max_backend: 0, max_members: 0, unclassified: 0, backend_cmdlines: [], transient_backend: 0 };
  const forks = new Set<number>();
  let gone = 0;
  let timer: NodeJS.Timeout | null = null;
  const sample = () => {
    const pids = read.procs();
    if (pids === null || !known) {
      // The domain's directory is gone (terminated and removed): nothing is
      // left to sample, and the timer stops by itself (E74 item 3).
      if (pids === null && ++gone >= 3 && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      return;
    }
    gone = 0;
    report.samples++;
    report.max_members = Math.max(report.max_members, pids.length);
    let backends = 0;
    let unclassified = 0;
    for (const pid of pids) {
      const v = read.classify(pid);
      if (v === 'backend') {
        backends++;
        const line = read.cmdline(pid);
        if (line !== null && report.backend_cmdlines.length < 16 && !report.backend_cmdlines.includes(line)) report.backend_cmdlines.push(line);
      } else if (v === 'fork') {
        // Each distinct fork once, however many samples caught it.
        if (forks.size < 4096) forks.add(pid);
      } else if (v === null) unclassified++;
    }
    report.max_backend = Math.max(report.max_backend, backends);
    report.unclassified = Math.max(report.unclassified, unclassified);
    report.transient_backend = forks.size;
  };
  if (everyMs > 0) {
    timer = setInterval(sample, everyMs);
    timer.unref();
  }
  return {
    sample,
    stop: () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
      return { ...report, backend_cmdlines: [...report.backend_cmdlines] };
    },
  };
}

// The kernel's PF_FORKNOEXEC (include/linux/sched.h): forked, not exec'd.
const PF_FORKNOEXEC = 0x40;
// USER_HZ, the unit of /proc/<pid>/stat's start time: 100 on every
// architecture this engine runs on (Linux exports it fixed to userspace).
const USER_HZ = 100;

// A member running the binary: a fork before its exec younger than the
// bound, or a backend. Fields of /proc/<pid>/stat are counted after the
// command's closing parenthesis (the command may hold spaces and
// parentheses): field 9 the flags, field 22 the start time in ticks since
// boot.
export function forkState(statText: string | null, uptimeSeconds: number | null): 'fork' | 'backend' {
  if (statText === null || uptimeSeconds === null) return 'backend';
  const close = statText.lastIndexOf(')');
  if (close < 0) return 'backend';
  const fields = statText.slice(close + 2).trim().split(/\s+/);
  const flags = Number(fields[9 - 3]);
  const start = Number(fields[22 - 3]);
  if (!Number.isSafeInteger(flags) || !Number.isSafeInteger(start) || flags < 0 || start < 0) return 'backend';
  if ((flags & PF_FORKNOEXEC) === 0) return 'backend';
  const ageMs = uptimeSeconds * 1000 - (start * 1000) / USER_HZ;
  return ageMs >= 0 && ageMs < FORK_GRACE_MS ? 'fork' : 'backend';
}

function uptime(): number | null {
  const text = readBounded('/proc/uptime');
  const n = text === null ? NaN : Number(text.split(/\s+/)[0]);
  return Number.isFinite(n) ? n : null;
}

function classifyMember(pid: number, target: { dev: number; ino: number }, binaryPath: string): MemberClass | null {
  const v = isBackend(pid, target, binaryPath);
  if (v !== true) return v === null ? null : 'other';
  return forkState(readBounded(`/proc/${pid}/stat`), uptime());
}

// true: the member runs the qualified binary; false: it does not; null:
// neither its executable nor its command line could be read (it has gone).
function isBackend(pid: number, target: { dev: number; ino: number }, binaryPath: string): boolean | null {
  try {
    const st = statSync(`/proc/${pid}/exe`);
    return st.dev === target.dev && st.ino === target.ino;
  } catch {
    // refused or gone: the command line, which the kernel lets the owner read
  }
  try {
    const argv0 = (readBounded(`/proc/${pid}/cmdline`) ?? '').split('\0')[0] ?? '';
    if (argv0 === '') return null;
    return argv0 === binaryPath || basename(argv0) === basename(binaryPath);
  } catch {
    return null;
  }
}

function cmdline(pid: number): string | null {
  const text = readBounded(`/proc/${pid}/cmdline`);
  return text === null ? null : text.split('\0').filter((x) => x !== '').join(' ').slice(0, 256);
}

// At most CMDLINE_MAX bytes of a /proc file, never more (E74 item 3): a
// member's command line is the role's to make as long as it likes.
const CMDLINE_MAX = 4096;
function readBounded(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(CMDLINE_MAX);
    const n = readSync(fd, buf, 0, CMDLINE_MAX, null);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
