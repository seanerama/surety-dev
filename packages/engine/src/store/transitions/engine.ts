// Engine incarnation and startup transitions (D1 §1.3–1.4).

import type { LockRecord } from '../../lock.js';
import { lapseEarlierQualifications } from './trust.js';
import type { Tx } from './tx.js';

// A start records its incarnation, and a host qualification of an earlier
// one stops being current (D2 §§4.1, 7.1): only this start's checks can
// qualify the host again.
// `scope` is the incarnation scope's cgroup directory (D2 §3.1, A.3), null
// when the engine runs without one (H3 failed, or the kernel lane).
export function recordIncarnation(tx: Tx, lock: LockRecord, scope: string | null = null): void {
  tx.db
    .prepare('INSERT INTO "engine_incarnations" ("id", "created_at", "pid", "started_at", "host_boot_id", "scope_cgroup") VALUES (?, ?, ?, ?, ?, ?)')
    .run(lock.incarnation_id, tx.at, lock.pid, lock.started_at, lock.host_boot_id, scope);
  lapseEarlierQualifications(tx, lock.incarnation_id);
}

export function liftToFull(tx: Tx, incarnation: string): void {
  tx.emit('engine.mode_changed', { incarnation }, { from: 'restricted', to: 'full' });
}

export function schedulerStarted(tx: Tx, incarnation: string): void {
  tx.emit('engine.started', { incarnation }, {});
}

// The heartbeat that ends every tick (D1 §8.1 step 10), written after
// everything else the tick wrote.
export function recordTick(tx: Tx, args: { incarnation: string; dispatched: number }): { seq: number } {
  const ref = tx.emit('engine.tick', { incarnation: args.incarnation }, { dispatched: args.dispatched });
  return { seq: ref.seq };
}

// A backup of the running engine's home has ended, with its label: the
// directory it left, or null (D1 §6.5; SEAM.md §93).
export function recordBackup(tx: Tx, args: { backup: string | null; label: 'complete' | 'incomplete_for_recovery' }): void {
  tx.emit('engine.backup', {}, { backup: args.backup, label: args.label });
}
