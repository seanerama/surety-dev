// The containment canary's check, the engine's side (D2 §7.2; E86 item 2,
// Sean's decision): the engine, not the agent, has the probe program run in
// the agent's own domain while its backend is live there. The host reads
// the domain's cgroup until the backend is a member of it (the member whose
// pid in the sandbox's pid namespace is the one the domain init reported),
// then asks the init, on its own channel, for the check, and reads the
// cgroup again once the init reports the check ended. Reads only: it
// signals, moves and writes nothing.

import { readFileSync } from 'node:fs';

import { readProcs } from '../boundary/cgroup.js';

export interface MemberReader {
  procs(cgroupPath: string): number[] | null;
  // The pid of a host process in each pid namespace it is in, outermost
  // first (`NSpid` of /proc/<pid>/status); null if it cannot be read.
  nspid(hostPid: number): number[] | null;
}

export const hostReader: MemberReader = {
  procs: (cgroupPath) => readProcs(cgroupPath),
  nspid: (hostPid) => {
    try {
      const line = readFileSync(`/proc/${hostPid}/status`, 'utf8')
        .split('\n')
        .find((l) => l.startsWith('NSpid:'));
      if (!line) return null;
      const pids = line.slice(6).trim().split(/\s+/).map(Number);
      return pids.every((p) => Number.isSafeInteger(p) && p > 0) ? pids : null;
    } catch {
      return null;
    }
  },
};

// The host pid of the domain's member whose innermost pid is `nsPid` (the
// backend as the init reported it), or null if no member is.
export function findBackendMember(cgroupPath: string, nsPid: number, read: MemberReader = hostReader): number | null {
  if (!Number.isSafeInteger(nsPid) || nsPid <= 1) return null;
  const members = read.procs(cgroupPath);
  if (members === null) return null;
  for (const hostPid of members) {
    const ns = read.nspid(hostPid);
    // In the sandbox's pid namespace (not the host's own): at least two
    // levels, and the innermost is the backend's.
    if (ns !== null && ns.length >= 2 && ns[ns.length - 1] === nsPid) return hostPid;
  }
  return null;
}

// What the engine saw of the backend around the check, for the evidence.
export interface ContainmentWatch {
  ns_pid: number;
  seen: { host_pid: number; at: string } | null;
  requested_at: string | null;
  present_at_end: boolean | null;
  // When the host read the domain's cgroup again, after the check.
  ended_at: string | null;
  reason: string | null;
}

// The check, once: wait (at most `seenWithinMs`) until the backend is seen
// in the domain, then ask for the check and wait for its end (at most
// `checkMs`), then look for the backend again.
export async function watchContainment(args: {
  cgroupPath: string;
  nsPid: number;
  backendExited: () => boolean;
  request: (timeoutMs: number) => Promise<void>;
  seenWithinMs: number;
  checkMs: number;
  read?: MemberReader;
  pollMs?: number;
  // Kept current as the watch goes: what a reader sees before it ends.
  into?: ContainmentWatch;
}): Promise<ContainmentWatch> {
  const read = args.read ?? hostReader;
  const w: ContainmentWatch = args.into ?? { ns_pid: args.nsPid, seen: null, requested_at: null, present_at_end: null, ended_at: null, reason: null };
  w.reason = 'the check had not ended';
  const began = performance.now();
  for (;;) {
    const hostPid = findBackendMember(args.cgroupPath, args.nsPid, read);
    if (hostPid !== null) {
      w.seen = { host_pid: hostPid, at: new Date().toISOString() };
      w.reason = 'the check had not ended';
      break;
    }
    if (args.backendExited()) {
      w.reason = 'the backend exited before it was seen in the domain';
      return w;
    }
    if (performance.now() - began >= args.seenWithinMs) {
      w.reason = `the backend was not seen in the domain within ${args.seenWithinMs} ms`;
      return w;
    }
    await new Promise((r) => setTimeout(r, args.pollMs ?? 100));
  }
  w.requested_at = new Date().toISOString();
  await args.request(args.checkMs);
  w.present_at_end = findBackendMember(args.cgroupPath, args.nsPid, read) === w.seen.host_pid;
  w.ended_at = new Date().toISOString();
  w.reason = w.present_at_end ? null : 'the backend was not in the domain when the check ended';
  return w;
}
