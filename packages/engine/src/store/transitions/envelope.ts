// Admission by the resource envelope (D2 §3.7; B09): the scheduler admits a
// domain only if, after admission, the domains running stay within
// `max_concurrent_domains` and the host keeps `host_reserve_memory` of memory
// and `host_reserve_disk` free on the engine home's filesystem. Otherwise the
// work stays eligible and its read shows the hold as `resource_envelope`.
//
// Memory, as Sean decided it (E75 item 3: option B of E71 item 6): every
// admitted domain may grow to its configured `domain_memory_max`, so
// admission keeps room for each of them, the new one included, at that
// maximum (not at what it uses now), beyond `host_reserve_memory`. The room
// is what the host has available now (`MemAvailable`) plus what the running
// domains already hold (each one's `memory.current`, which `MemAvailable`
// has left out), so a domain's present use is counted once, inside its
// maximum. Further work is held (`dispatch_hold` `resource_envelope`) when
// the room is short; the single-run setting stays, and the per-domain limit
// is not lowered (lower concurrency is the accepted trade-off). For disk it
// counts `domain_writable_bytes` for every running domain and the new one,
// beyond `host_reserve_disk`. A value that cannot be read holds the
// dispatch, never counts as zero. Only the real boundary has domains to
// admit; the kernel lane's scripted boundary does not hold its runs here.

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
  // Memory (option B, above): every admitted domain at its maximum, the new
  // one included, beyond the reserve, against the room the host has.
  const admitted = running.length + 1;
  const needed = s.host_reserve_memory + s.domain_memory_max * admitted;
  const available = memAvailable();
  const held = running.map((d) => readNumber(join(d.cgroup_path, 'memory.current')));
  const unread = held.some((v) => v === null);
  const room = available === null || unread ? null : available + (held as number[]).reduce((a, b) => a + b, 0);
  if (room === null || room < needed) {
    return hold(
      room === null
        ? `the room for another domain cannot be read (${available === null ? 'MemAvailable' : "a running domain's memory.current"} unreadable); admission waits.`
        : `admitting a domain needs host_reserve_memory (${s.host_reserve_memory}) beyond domain_memory_max (${s.domain_memory_max}) for each of the ${admitted} admitted domains, ${needed} bytes; the host has ${room} (${available} available and ${room - available!} held by the running domains).`,
      { limit: 'host_reserve_memory', value: s.host_reserve_memory, available, held_by_running: room === null ? null : room - available!, needed, domain_memory_max: s.domain_memory_max, admitted },
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
