// Engine incarnation and startup transitions (D1 §1.3–1.4).

import type { LockRecord } from '../../lock.js';
import type { Tx } from './tx.js';

export function recordIncarnation(tx: Tx, lock: LockRecord): void {
  tx.db
    .prepare('INSERT INTO "engine_incarnations" ("id", "created_at", "pid", "started_at", "host_boot_id") VALUES (?, ?, ?, ?, ?)')
    .run(lock.incarnation_id, tx.at, lock.pid, lock.started_at, lock.host_boot_id);
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
