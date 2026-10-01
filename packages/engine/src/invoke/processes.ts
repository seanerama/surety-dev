// Finding and signalling the processes of an execution domain (D1 §2.7,
// §4.5 step 2, §16.1). These are aids for reaching processes, never proof
// that a domain is empty: termination is established only by the execution
// boundary (build spec §6 correction 1).

import { readFileSync, readdirSync } from 'node:fs';

import { processStartTime } from '../lock.js';

export const DOMAIN_MARKER = 'SURETY_DOMAIN';
export const INVOCATION_MARKER = 'SURETY_INVOCATION';

export interface ProcessIdentity {
  pid: number;
  startTime: string;
}

// Is this pid a live process (not a zombie) with this start time?
export function isSameLiveProcess(pid: number, startTime: string): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return rest[0] !== 'Z' && rest[19] === startTime;
  } catch {
    return false;
  }
}

// Every live process whose environment carries SURETY_DOMAIN=<domain>, as
// /proc/<pid>/environ shows it. null when /proc itself cannot be read.
export function markedProcesses(domain: string): ProcessIdentity[] | null {
  const marker = `${DOMAIN_MARKER}=${domain}`;
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return null;
  }
  const found: ProcessIdentity[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    let environ: string;
    try {
      environ = readFileSync(`/proc/${name}/environ`, 'latin1');
    } catch {
      continue; // gone, or not ours to read
    }
    if (!environ.split('\0').includes(marker)) continue;
    let startTime: string | null;
    try {
      startTime = processStartTime(pid);
    } catch {
      continue;
    }
    if (startTime !== null && isSameLiveProcess(pid, startTime)) found.push({ pid, startTime });
  }
  return found;
}

// Signal a process group whose leader is the recorded process, but only while
// that pid still names the recorded process: a pid whose start time differs
// belongs to someone else and is never signalled (D1 §16.1).
export function signalRecordedGroup(pid: number, pgid: number, startTime: string, signal: NodeJS.Signals): boolean {
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
  if (!isSameLiveProcess(p.pid, p.startTime)) return false;
  try {
    process.kill(p.pid, signal);
    return true;
  } catch {
    return false;
  }
}
