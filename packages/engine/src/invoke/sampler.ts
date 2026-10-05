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

// How long a member must be seen running the backend's binary before it
// counts as a backend (the dress rehearsal's second engine finding, SEAM
// §171). A process the backend forks runs the backend's binary until it
// calls exec, and Claude Code forks a child for every command it runs: one
// caught in that moment is not a second backend. A second backend is one
// that is still the binary at a later look, at least this long after it
// was first seen; one that has exec'd something else or gone by then was a
// fork. Below a sample's interval, so every look after the first decides.
export const PERSIST_MS = 200;

// What the sampler reads; the host's /proc and cgroup by default.
export interface SamplerIo {
  procs(): number[] | null;
  classify(pid: number): boolean | null;
  cmdline(pid: number): string | null;
  now(): number;
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
    classify: (pid) => (target === null ? null : isBackend(pid, target, binaryPath)),
    cmdline,
    now: () => performance.now(),
  };
  const known = io !== undefined || target !== null;
  const report: BackendSampling = { samples: 0, max_backend: 0, max_members: 0, unclassified: 0, backend_cmdlines: [], transient_backend: 0 };
  // Members seen running the binary: those that have persisted, and those
  // seen first at `since` and not yet looked at again late enough to say,
  // with whether another backend was there when they were first seen.
  let established = new Set<number>();
  let pending = new Map<number, { since: number; beside: boolean }>();
  // The last look's members, if the domain could be read.
  let lastReadable = false;
  let gone = 0;
  let timer: NodeJS.Timeout | null = null;
  const sample = () => {
    const pids = read.procs();
    if (pids === null || !known) {
      // The domain's directory is gone (terminated and removed): nothing is
      // left to sample, and the timer stops by itself (E74 item 3).
      lastReadable = false;
      if (pids === null && ++gone >= 3 && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      return;
    }
    gone = 0;
    lastReadable = true;
    const at = read.now();
    report.samples++;
    report.max_members = Math.max(report.max_members, pids.length);
    const backends: number[] = [];
    let unclassified = 0;
    for (const pid of pids) {
      const v = read.classify(pid);
      if (v === true) {
        backends.push(pid);
        const line = read.cmdline(pid);
        if (line !== null && report.backend_cmdlines.length < 16 && !report.backend_cmdlines.includes(line)) report.backend_cmdlines.push(line);
      } else if (v === null) unclassified++;
    }
    const nextEstablished = new Set<number>();
    const nextPending = new Map<number, { since: number; beside: boolean }>();
    for (const pid of backends) {
      const first = pending.get(pid);
      if (established.has(pid) || (first !== undefined && at - first.since >= PERSIST_MS)) nextEstablished.add(pid);
      else nextPending.set(pid, first ?? { since: at, beside: backends.length > 1 });
    }
    // A member first seen beside another backend that is no longer the
    // binary: a fork caught before its exec.
    for (const [pid, p] of pending) if (!nextEstablished.has(pid) && !nextPending.has(pid) && p.beside) report.transient_backend++;
    established = nextEstablished;
    pending = nextPending;
    // At once: every member that has persisted; while none has, the one
    // being seen (the backend at its start), so a backend is identified
    // from its first sample.
    const atOnce = established.size + (established.size === 0 && pending.size > 0 ? 1 : 0);
    report.max_backend = Math.max(report.max_backend, atOnce);
    report.unclassified = Math.max(report.unclassified, unclassified);
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
      if (lastReadable) {
        // Still in a live domain at the last look, and not yet looked at
        // late enough to tell: not known to be a fork, so counted.
        report.max_backend = Math.max(report.max_backend, established.size + pending.size);
      } else {
        // The domain ended before a later look: what was pending did not
        // outlive it, and nothing showed it was more than a fork.
        for (const p of pending.values()) if (p.beside) report.transient_backend++;
      }
      pending = new Map();
      return { ...report, backend_cmdlines: [...report.backend_cmdlines] };
    },
  };
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
