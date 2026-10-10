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

import { projectPolicy } from './settings.js';
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

// The runner self-test's boxes running now (checks/selftest.ts; review m6):
// domains of the engine's own that are no store rows, each counted like a
// running domain, at its own memory cap and writable bytes, so that a domain
// admitted beside them still leaves the host its reserves. The main thread
// sets the list before a box's cgroup is made and clears it once removed.
export interface SelfTestBox {
  cgroup: string;
  memoryMax: number;
  writableBytes: number;
}

let selfTestBoxes: SelfTestBox[] = [];

export function setSelfTestBoxes(boxes: SelfTestBox[]): void {
  selfTestBoxes = boxes.filter((b) => typeof b.cgroup === 'string' && Number.isInteger(b.memoryMax) && b.memoryMax > 0 && Number.isInteger(b.writableBytes) && b.writableBytes >= 0);
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

// What is being admitted: a role or probe domain (the default), a check
// domain, or a service domain with its own memory and writable bytes.
// A check bound to a deployment verification (`bound`) may use the check
// capacity kept free while a service runs; any other check is admitted only
// beside it, as a role is (the slice-25 design Q5).
export type Admitting = { kind: 'role' } | { kind: 'check'; bound?: boolean } | { kind: 'service'; memory: number; writable: number };

// Why a new domain may not be admitted now, or null.
//
// Service domains (D4 §§4.7, 9.2; E115): a running service is counted at its
// own reservation's memory (`service_memory_max`) and its project's
// `service_writable_bytes`, never at `domain_memory_max`, and takes no slot
// of `max_concurrent_domains`, which bounds the engine's concurrently
// launched role and check domains. While any service runs, or one is being
// admitted, the envelope keeps the capacity of one check domain (one slot,
// `domain_memory_max`, `domain_writable_bytes`) free for post-deploy checks,
// which run serially: a check is admitted into that capacity, and any other
// domain only beside it. So no running service's reservation makes its
// mandatory verification impossible (CH 6), and one fewer role run fits
// beside a running service.
export function envelopeHold(db: Db, admitting: Admitting = { kind: 'role' }): EnvelopeHold | null {
  const s = settings;
  if (s === null) return null;
  // Every live domain with a cgroup, and every service domain not
  // terminated, placed or not: a service holds its reservation from its
  // admission (the slice-24 review, m4).
  const all = db
    .prepare(
      `SELECT d."id", d."cgroup_path", d."profile", d."reservation", d."project", (x."deployment" IS NOT NULL) AS "bound"
       FROM "execution_domains" d LEFT JOIN "check_executions" x ON x."id" = d."check_execution"
       WHERE d."status" <> 'terminated' AND (d."cgroup_path" IS NOT NULL OR d."profile" = 'service')`,
    )
    .all() as {
    id: string;
    cgroup_path: string | null;
    profile: string;
    reservation: string | null;
    project: string;
    bound: number;
  }[];
  const services = all.filter((d) => d.profile === 'service');
  const running = all.filter((d) => d.profile !== 'service');
  const serviceMemory = services.reduce((n, d) => {
    let m = 0;
    try {
      m = Number((JSON.parse(d.reservation ?? '{}') as { memory?: number }).memory ?? 0);
    } catch {
      m = 0;
    }
    return n + (Number.isFinite(m) ? m : 0);
  }, 0);
  const serviceWritable = services.reduce((n, d) => n + (projectPolicy(db, d.project).service_writable_bytes ?? 0), 0);
  const newService = admitting.kind === 'service' ? admitting : null;
  // The check capacity kept free for post-deploy checks: while a service runs
  // (or is admitted), unless a deployment verification's check domain already
  // holds it or the domain admitted is such a check itself (Q5).
  const admittingBound = admitting.kind === 'check' && admitting.bound === true;
  const reserveCheck = (services.length > 0 || newService !== null) && !admittingBound && !running.some((d) => d.profile === 'check' && d.bound === 1);
  const newDomains = admitting.kind === 'service' ? 0 : 1;
  const boxes = selfTestBoxes;
  const hold = (reason: string, subject: Record<string, unknown>): EnvelopeHold => ({
    code: 'resource_envelope',
    reason,
    subject: { running_domains: running.length, ...(services.length > 0 ? { service_domains: services.length } : {}), ...(boxes.length > 0 ? { self_test_boxes: boxes.length } : {}), ...subject },
  });
  const domains = running.length + boxes.length + (reserveCheck ? 1 : 0);
  if (domains + newDomains > s.max_concurrent_domains) {
    return hold(
      `${running.length + boxes.length} domains are running${reserveCheck ? ', and one check domain is kept for post-deploy verification' : ''}; admitting another would exceed max_concurrent_domains (${s.max_concurrent_domains}).`,
      { limit: 'max_concurrent_domains', value: s.max_concurrent_domains },
    );
  }
  // Memory (option B, above): every admitted domain at its maximum, the new
  // one included, beyond the reserve, against the room the host has; a
  // self-test box at its own cap; a service at its own reservation.
  const admitted = running.length + newDomains + (reserveCheck ? 1 : 0);
  const needed = s.host_reserve_memory + s.domain_memory_max * admitted + boxes.reduce((n, b) => n + b.memoryMax, 0) + serviceMemory + (newService?.memory ?? 0);
  const available = memAvailable();
  const held = [...all.map((d) => d.cgroup_path).filter((p): p is string => p !== null), ...boxes.map((b) => b.cgroup)].map((path) => readNumber(join(path, 'memory.current')));
  const unread = held.some((v) => v === null);
  const room = available === null || unread ? null : available + (held as number[]).reduce((a, b) => a + b, 0);
  if (room === null || room < needed) {
    return hold(
      room === null
        ? `the room for another domain cannot be read (${available === null ? 'MemAvailable' : "a running domain's memory.current"} unreadable); admission waits.`
        : `admitting a domain needs host_reserve_memory (${s.host_reserve_memory}) beyond domain_memory_max (${s.domain_memory_max}) for each of the ${admitted} admitted domains${services.length > 0 || newService ? ` and ${serviceMemory + (newService?.memory ?? 0)} for the services` : ''}, ${needed} bytes; the host has ${room} (${available} available and ${room - available!} held by the running domains).`,
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
  const diskNeed = s.host_reserve_disk + s.domain_writable_bytes * admitted + boxes.reduce((n, b) => n + b.writableBytes, 0) + serviceWritable + (newService?.writable ?? 0);
  if (free === null || free < diskNeed) {
    return hold(
      `the engine home's filesystem has ${free ?? 'an unreadable amount of'} bytes free; admitting a domain needs host_reserve_disk (${s.host_reserve_disk}) beyond what the domains may write.`,
      { limit: 'host_reserve_disk', value: s.host_reserve_disk, free, needed: diskNeed },
    );
  }
  return null;
}

// Admission of a service domain for a project (D4 §4.7): `granted`, or held
// with why. Outside an engine with an envelope (the kernel lane), granted.
export function serviceAdmissionHold(db: Db, args: { project: string }): { admission: 'granted' | 'held'; hold: EnvelopeHold | null } {
  const p = projectPolicy(db, args.project);
  const h = envelopeHold(db, { kind: 'service', memory: p.service_memory_max!, writable: p.service_writable_bytes! });
  return { admission: h === null ? 'granted' : 'held', hold: h };
}
