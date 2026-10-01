// The engine lock (D1 §1.3, SEAM.md §3). One live incarnation per engine home.
//
// engine.lock is a JSON record naming its owner's incarnation, pid, process
// start time and boot id. An existing lock is held by a live owner when the
// boot id is the current one and a process with that pid exists with that
// start time; otherwise it is stale and is taken over without signalling
// anything. Reading, judging and replacing the lock happens inside a critical
// section held as an exclusive SQLite lock on engine.lock.guard, which the
// kernel releases if this process dies, so simultaneous starts produce exactly
// one owner whether or not a stale lock exists.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';

import Database from 'better-sqlite3';

import { nowIso } from './clock.js';
import { newId } from './ids.js';
import { homePaths } from './paths.js';
import { Refusal } from './refusal.js';

export interface LockRecord {
  incarnation_id: string;
  pid: number;
  pid_start_time: string;
  started_at: string;
  host_boot_id: string;
}

const GUARD_WAIT_MS = 10_000;

export const readBootId = (): string => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();

// Field 22 of /proc/<pid>/stat: start time in clock ticks since boot. The
// command name (field 2) may contain spaces and parentheses, so fields are
// counted from the last ')'. Returns null when no such process exists.
export function processStartTime(pid: number): string | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ESRCH') return null;
    throw err;
  }
  const value = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  if (value === undefined || !/^\d+$/.test(value)) throw new Error(`unparseable /proc/${pid}/stat`);
  return value;
}

export type OwnerJudgment = { live: true; incarnation: string | null; why: string } | { live: false };

// Whether an existing lock names a live owner. Anything that cannot be
// established (an unreadable record, an unreadable /proc) counts as live:
// taking over a lock whose owner might be running would allow two writers.
export function judgeOwner(text: string, currentBootId: string): OwnerJudgment {
  let lock: Partial<LockRecord>;
  try {
    lock = JSON.parse(text) as Partial<LockRecord>;
  } catch {
    return { live: true, incarnation: null, why: 'engine.lock is not a readable lock record' };
  }
  const incarnation = typeof lock.incarnation_id === 'string' ? lock.incarnation_id : null;
  if (
    typeof lock.host_boot_id !== 'string' ||
    typeof lock.pid !== 'number' ||
    !Number.isInteger(lock.pid) ||
    typeof lock.pid_start_time !== 'string'
  ) {
    return { live: true, incarnation, why: 'engine.lock lacks the owner identity needed to judge it stale' };
  }
  if (lock.host_boot_id !== currentBootId) return { live: false };
  let startTime: string | null;
  try {
    startTime = processStartTime(lock.pid);
  } catch (err) {
    return { live: true, incarnation, why: `the owner's process identity could not be read (${(err as Error).message})` };
  }
  if (startTime === null || startTime !== lock.pid_start_time) return { live: false };
  return { live: true, incarnation, why: `process ${lock.pid} holding engine.lock is running` };
}

function lockedRefusal(incarnation: string | null, why: string): Refusal {
  return new Refusal(
    409,
    'engine_locked',
    `Another engine incarnation holds this engine home: ${why}.`,
    'Use the running engine, or stop it before starting another. If no engine is running, inspect engine.lock before removing it.',
    { incarnation_id: incarnation },
  );
}

// Take the lock or throw engine_locked. Writes nothing but the guard file and
// the lock record, and nothing at all when the lock is held by a live owner.
export function acquireLock(home: string): LockRecord {
  const paths = homePaths(home);
  const bootId = readBootId();
  const ownStart = processStartTime(process.pid);
  if (ownStart === null) throw new Error('cannot read this process start time from /proc');

  const guard = new Database(paths.lockGuard, { timeout: GUARD_WAIT_MS });
  try {
    guard.exec('BEGIN EXCLUSIVE');
    try {
      let existing: string | null = null;
      try {
        existing = readFileSync(paths.lock, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (existing !== null) {
        const owner = judgeOwner(existing, bootId);
        if (owner.live) throw lockedRefusal(owner.incarnation, owner.why);
      }
      const record: LockRecord = {
        incarnation_id: newId('inc_'),
        pid: process.pid,
        pid_start_time: ownStart,
        started_at: nowIso(),
        host_boot_id: bootId,
      };
      const temp = `${paths.lock}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      renameSync(temp, paths.lock);
      return record;
    } finally {
      guard.exec('ROLLBACK');
    }
  } finally {
    guard.close();
  }
}
