// M5 slice 37: reads for rows M439 (the memory peak recorded) and M451 (the
// profile is part of the qualification). SEAM.md §443 Read only: the
// store, the events, and a domain's cgroup files from the host side.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { armFault } from '../engine.mjs';
import { withStore } from '../store.mjs';

export const MIB = 1024 * 1024;
export const GIB = 1024 * MIB;

const json = (v) => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

// One execution_domains row by id, JSON columns parsed.
export const domainById = (home, id) => {
  const row = withStore(home, (db) => db.prepare('SELECT * FROM "execution_domains" WHERE "id" = ?').get(id));
  return row ? { ...row, reservation: json(row.reservation) } : null;
};

// The events of `type` about a domain, in insertion order (seq; never by a
// wall-clock timestamp: this host's clock steps back).
export const domainEvents = (home, type, domain) =>
  withStore(home, (db) =>
    db
      .prepare(`SELECT "seq", "type", "subject", "payload" FROM "events" WHERE "type" = ? AND json_extract("subject", '$.domain') = ? ORDER BY "seq"`)
      .all(type, domain)
      .map((e) => ({ ...e, subject: json(e.subject), payload: json(e.payload) })),
  );

// A cgroup file of a live domain, read from the host; null when unreadable.
export function cgroupValue(dir, file) {
  try {
    return readFileSync(join(dir, file), 'utf8').trim();
  } catch {
    return null;
  }
}
export const hostMemoryMax = (dir) => cgroupValue(dir, 'memory.max');
export const hostMemoryPeak = (dir) => {
  const v = cgroupValue(dir, 'memory.peak');
  return v !== null && /^\d+$/.test(v) ? Number(v) : null;
};

// The one-shot `domain_peak` fault (SEAM.md §443): the next domain of
// `project` to terminate has its memory.peak unreadable, or read only after
// its cgroup was removed.
export const armPeakFault = (engine, project, mode) => armFault(engine, { point: 'domain_peak', mode, project });

// D6 §7.6's `unknown`: an object {unknown: "<reason>"}, never null and never zero.
export function assertUnknown(value, what) {
  assert.ok(value !== null && typeof value === 'object' && typeof value.unknown === 'string' && value.unknown.length > 0, `${what}: {unknown: <reason>}, never zero, null or a number (${JSON.stringify(value)})`);
}

// The domain's recorded peak and maximum, and its one `domain.peak_recorded`
// event bound to it, read before its cgroup was removed (`domain.terminated`,
// where the engine emits one for the domain, comes after it).
export function assertPeakRecorded(home, domainId, { memoryMax, atLeast, what }) {
  const row = domainById(home, domainId);
  assert.ok(row, `${what}: the domain row exists`);
  assert.ok(Number.isSafeInteger(row.memory_peak) && row.memory_peak > 0, `${what}: execution_domains.memory_peak is a positive integer of bytes (${JSON.stringify({ memory_peak: row.memory_peak, status: row.status })})`);
  assert.equal(row.memory_max, memoryMax, `${what}: execution_domains.memory_max is the maximum it was admitted at (${row.memory_max})`);
  if (atLeast !== undefined) assert.ok(row.memory_peak >= atLeast, `${what}: the recorded peak (${row.memory_peak}) is at least what the host read of its cgroup while it ran (${atLeast}): its own value`);
  const events = domainEvents(home, 'domain.peak_recorded', domainId);
  assert.equal(events.length, 1, `${what}: one domain.peak_recorded for the domain (${events.length})`);
  const [e] = events;
  assert.equal(e.payload?.memory_peak, row.memory_peak, `${what}: the event carries the recorded peak (${JSON.stringify(e.payload)})`);
  assert.ok(typeof e.payload?.observed_at === 'string' && !Number.isNaN(Date.parse(e.payload.observed_at)), `${what}: the event carries its observation time (${JSON.stringify(e.payload)})`);
  const terminated = domainEvents(home, 'domain.terminated', domainId);
  if (terminated.length > 0) assert.ok(e.seq < terminated[0].seq, `${what}: the peak was recorded before the domain's termination (seq ${e.seq} < ${terminated[0].seq})`);
  return row;
}

// ---- trust entries and their profile (M451) --------------------------------------------------

// The entry's recorded profile (SEAM.md §443): {memory_max, writable_bytes, writable_inodes, tasks_max}.
export function entryProfile(entry) {
  const p = json(entry?.profile);
  return p && typeof p === 'object' ? p : null;
}
