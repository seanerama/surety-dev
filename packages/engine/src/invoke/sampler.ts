// The host's samples of a canary domain's processes (D2 §7.2; the M2 plan's
// M136 (c): "no second backend process ever appears in `cgroup.procs`
// sampled from the host"). Reads only: `cgroup.procs` of the domain, and for
// each member the file its `/proc/<pid>/exe` names (compared with the
// qualified binary by device and inode, which a read-only bind keeps) or,
// where that is refused (a non-dumpable process, such as the domain init),
// the first word of its command line. It signals, moves and writes nothing.

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

import { readProcs } from '../boundary/cgroup.js';
import type { BackendSampling } from './adapters/claude.js';

export interface Sampler {
  sample(): void;
  stop(): BackendSampling;
}

export function startBackendSampler(cgroupPath: string, binaryPath: string, everyMs = 250): Sampler {
  let target: { dev: number; ino: number } | null = null;
  try {
    const st = statSync(binaryPath);
    target = { dev: st.dev, ino: st.ino };
  } catch {
    target = null;
  }
  const report: BackendSampling = { samples: 0, max_backend: 0, max_members: 0, unclassified: 0, backend_cmdlines: [] };
  const sample = () => {
    const pids = readProcs(cgroupPath);
    if (pids === null || target === null) return;
    report.samples++;
    report.max_members = Math.max(report.max_members, pids.length);
    let backends = 0;
    let unclassified = 0;
    for (const pid of pids) {
      const v = isBackend(pid, target, binaryPath);
      if (v === true) {
        backends++;
        const line = cmdline(pid);
        if (line !== null && report.backend_cmdlines.length < 16 && !report.backend_cmdlines.includes(line)) report.backend_cmdlines.push(line);
      }
      else if (v === null) unclassified++;
    }
    report.max_backend = Math.max(report.max_backend, backends);
    report.unclassified = Math.max(report.unclassified, unclassified);
  };
  const timer = setInterval(sample, everyMs);
  timer.unref();
  return {
    sample,
    stop: () => {
      clearInterval(timer);
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
    const argv0 = readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0')[0] ?? '';
    if (argv0 === '') return null;
    return argv0 === binaryPath || basename(argv0) === basename(binaryPath);
  } catch {
    return null;
  }
}

function cmdline(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter((x) => x !== '').join(' ').slice(0, 256);
  } catch {
    return null;
  }
}
