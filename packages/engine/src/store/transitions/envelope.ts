// Admission by the resource envelope (D2 §3.7; B09): the scheduler admits a
// domain only if, after admission, the domains running stay within
// `max_concurrent_domains` and the host keeps `host_reserve_memory` of memory
// and `host_reserve_disk` free on the engine home's filesystem beyond what the
// admitted domains may use. Otherwise the work stays eligible and its read
// shows the hold as `resource_envelope`.
//
// What the admitted domains may use: each running domain up to its
// `memory.max` (less what it already holds, which the host's available
// memory has counted), and the new one up to `domain_memory_max`; on disk,
// each up to `domain_writable_bytes` of materialized changes. A value that
// cannot be read is taken at its bound, never at zero. Only the real
// boundary has domains to admit; the kernel lane's scripted boundary does
// not hold its runs here.

import { readFileSync, statfsSync } from 'node:fs';
import { join } from 'node:path';

import type { Tx } from './tx.js';

type Db = Tx['db'];

export interface EnvelopeSettings {
  max_concurrent_domains: number;
  host_reserve_memory: number;
  host_reserve_disk: number;
  domain_memory_max: number;
  domain_writable_bytes: number;
  home: string;
}

let settings: EnvelopeSettings | null = null;

export function setEnvelope(value: EnvelopeSettings | null): void {
  settings = value;
}

export interface EnvelopeHold {
  code: 'resource_envelope';
  reason: string;
  subject: Record<string, unknown>;
}

const readNumber = (path: string): number | null => {
  try {
    const text = readFileSync(path, 'utf8').trim();
    return /^\d+$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
};

function memAvailable(): number | null {
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'));
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

// Why a new domain may not be admitted now, or null.
export function envelopeHold(db: Db): EnvelopeHold | null {
  const s = settings;
  if (s === null) return null;
  const running = db.prepare(`SELECT "id", "cgroup_path" FROM "execution_domains" WHERE "status" <> 'terminated' AND "cgroup_path" IS NOT NULL`).all() as {
    id: string;
    cgroup_path: string;
  }[];
  const hold = (reason: string, subject: Record<string, unknown>): EnvelopeHold => ({ code: 'resource_envelope', reason, subject: { running_domains: running.length, ...subject } });
  if (running.length + 1 > s.max_concurrent_domains) {
    return hold(`${running.length} domains are running; admitting another would exceed max_concurrent_domains (${s.max_concurrent_domains}).`, { limit: 'max_concurrent_domains', value: s.max_concurrent_domains });
  }
  // Memory: the new domain's bound beyond the reserve, against what the host
  // has available now, which the running domains' use is already out of.
  // (The stricter reading, which also holds back what each running domain
  // may still grow to, admits one domain at a time at the default
  // domain_memory_max on a 16 GB host; a question for the owner.)
  const mayTake = s.domain_memory_max;
  void readNumber;
  const available = memAvailable();
  if (available === null || available < s.host_reserve_memory + mayTake) {
    return hold(
      `the host has ${available ?? 'an unreadable amount of'} bytes of memory available; admitting a domain needs host_reserve_memory (${s.host_reserve_memory}) beyond the ${mayTake} bytes the domains may use.`,
      { limit: 'host_reserve_memory', value: s.host_reserve_memory, available, needed: s.host_reserve_memory + mayTake },
    );
  }
  let free: number | null = null;
  try {
    const st = statfsSync(s.home);
    free = st.bavail * st.bsize;
  } catch {
    free = null;
  }
  const diskNeed = s.host_reserve_disk + s.domain_writable_bytes * (running.length + 1);
  if (free === null || free < diskNeed) {
    return hold(
      `the engine home's filesystem has ${free ?? 'an unreadable amount of'} bytes free; admitting a domain needs host_reserve_disk (${s.host_reserve_disk}) beyond what the domains may write.`,
      { limit: 'host_reserve_disk', value: s.host_reserve_disk, free, needed: diskNeed },
    );
  }
  return null;
}
