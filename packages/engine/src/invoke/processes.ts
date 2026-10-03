// Finding and signalling the processes of an execution domain (D1 §2.7,
// §4.5 step 2, §16.1). These are aids for reaching processes, never proof
// that a domain is empty: termination is established only by the execution
// boundary (build spec §6 correction 1).
//
// Only "no such process" means a process is gone. A /proc file that exists
// but cannot be read says nothing about whether the process lives, so it is
// reported as unreadable, never as gone.

import { readFileSync, readdirSync } from 'node:fs';

import { processStartTime } from '../lock.js';

export const DOMAIN_MARKER = 'SURETY_DOMAIN';
export const INVOCATION_MARKER = 'SURETY_INVOCATION';

export interface ProcessIdentity {
  pid: number;
  startTime: string;
}

// The errors that mean the process (or its /proc entry) no longer exists.
const GONE_CODES = new Set(['ENOENT', 'ESRCH']);
const isGone = (err: unknown): boolean => GONE_CODES.has((err as NodeJS.ErrnoException)?.code ?? '');

// What /proc says of a recorded process: `same` while that pid is a live
// process (not a zombie) with that start time; `gone` when no such process
// exists, it is a zombie, or the pid now names another process; `unreadable`
// when its stat file exists but cannot be read.
export type ProcessState = 'same' | 'gone' | 'unreadable';

export function processState(pid: number, startTime: string): ProcessState {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (err) {
    return isGone(err) ? 'gone' : 'unreadable';
  }
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return rest[0] !== 'Z' && rest[19] === startTime ? 'same' : 'gone';
}

// Is this pid a live process (not a zombie) with this start time?
export function isSameLiveProcess(pid: number, startTime: string): boolean {
  return processState(pid, startTime) === 'same';
}

// Every live process found carrying the domain's marker, in one pass over
// /proc, as /proc/<pid>/environ shows it. null when /proc itself cannot be
// listed. A process whose environment or start time cannot be read is not
// counted: whether it is a member cannot be told from here (SEAM.md §14,
// "What `auto` does not see").
export function markedProcesses(domain: string): ProcessIdentity[] | null {
  const marker = `${DOMAIN_MARKER}=${domain}`;
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return null;
  }
  const members: ProcessIdentity[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    let environ: string;
    try {
      environ = readFileSync(`/proc/${name}/environ`, 'latin1');
    } catch {
      continue;
    }
    if (!environ.split('\0').includes(marker)) continue;
    let startTime: string | null;
    try {
      startTime = processStartTime(pid);
    } catch {
      continue;
    }
    if (startTime !== null && processState(pid, startTime) === 'same') members.push({ pid, startTime });
  }
  return members;
}

// Signal a process group whose leader is the recorded process, but only while
// that pid still names the recorded process: a pid whose start time differs
// belongs to someone else and is never signalled (D1 §16.1).
export function signalRecordedGroup(pid: number, pgid: number, startTime: string, signal: NodeJS.Signals): boolean {
  // Only the group the recorded process leads (the engine spawned it into a
  // new group whose id is its pid): a recorded pgid that is anything else, 0
  // or 1 above all, would signal processes the engine never started.
  if (!Number.isInteger(pid) || pid <= 1 || pgid !== pid || pid === process.pid) return false;
  if (!isSameLiveProcess(pid, startTime)) return false;
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

// Signal one process found by its marker, after checking it is still the
// process that was found.
export function signalFound(p: ProcessIdentity, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(p.pid) || p.pid <= 1 || p.pid === process.pid) return false;
  if (!isSameLiveProcess(p.pid, p.startTime)) return false;
  try {
    process.kill(p.pid, signal);
    return true;
  } catch {
    return false;
  }
}

// The environment of a process, or null if it cannot be read.
export function environOf(pid: number): Map<string, string> | null {
  let environ: string;
  try {
    environ = readFileSync(`/proc/${pid}/environ`, 'latin1');
  } catch {
    return null;
  }
  const out = new Map<string, string>();
  for (const entry of environ.split('\0')) {
    const at = entry.indexOf('=');
    if (at > 0) out.set(entry.slice(0, at), entry.slice(at + 1));
  }
  return out;
}

// Every live process whose environment carries the variable `name`, with any
// value. null when /proc itself cannot be listed.
export function processesWithMarker(name: string): ProcessIdentity[] | null {
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return null;
  }
  const found: ProcessIdentity[] = [];
  const prefix = `${name}=`;
  for (const entry of names) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let environ: string;
    try {
      environ = readFileSync(`/proc/${entry}/environ`, 'latin1');
    } catch {
      continue;
    }
    if (!environ.split('\0').some((e) => e.startsWith(prefix))) continue;
    let startTime: string | null;
    try {
      startTime = processStartTime(pid);
    } catch {
      continue;
    }
    if (startTime !== null && processState(pid, startTime) === 'same') found.push({ pid, startTime });
  }
  return found;
}
