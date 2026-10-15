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
  // The integration leases an earlier incarnation held (D1 §7.5; K2): its
  // holders are gone with it (the engine lock), and the journal's recovery
  // takes their operations on; no execution authority survives a start.
  tx.db.prepare(`UPDATE "leases" SET "released_at" = ? WHERE "resource_kind" = 'integration' AND "released_at" IS NULL`).run(tx.at);
}

export function liftToFull(tx: Tx, incarnation: string): void {
  tx.emit('engine.mode_changed', { incarnation }, { from: 'restricted', to: 'full' });
}

// The scheduler starts (D1 §1.4 step 7). The engine's rules are an input of
// every gate evaluation (D1 §9.5, "evaluations that used something that
// changed are stale"; the driver's ruling on the real M443 run's restart):
// an engine started anew may evaluate by other rules, so every evaluation
// not satisfied ('not_satisfied', the one other outcome the schema allows)
// and not already stale, of any gate kind in every project, is marked stale
// here, in this transaction, and computed again when due. Staleness is not
// invalidation; a satisfied evaluation is untouched, so a completed stage,
// phase or Alpha gate never reopens. engine.started carries the count.
export function schedulerStarted(tx: Tx, incarnation: string): { stale_gate_evaluations: number } {
  const stale = staleUnsatisfiedAtStart(tx);
  tx.emit('engine.started', { incarnation }, { stale_gate_evaluations: stale });
  return { stale_gate_evaluations: stale };
}

export function staleUnsatisfiedAtStart(tx: Tx): number {
  return tx.db.prepare(`UPDATE "gate_evaluations" SET "stale" = 1 WHERE "outcome" <> 'satisfied' AND "stale" = 0`).run().changes;
}

// The heartbeat that ends every tick (D1 §8.1 step 10), written after
// everything else the tick wrote.
export function recordTick(tx: Tx, args: { incarnation: string; dispatched: number; requests?: number; steps?: string[] }): { seq: number } {
  // D6 K1 (SEAM.md §430): the requests coalesced into this tick, and the
  // steps it ran, in order.
  const ref = tx.emit('engine.tick', { incarnation: args.incarnation }, { dispatched: args.dispatched, requests: args.requests ?? 0, steps: args.steps ?? [] });
  return { seq: ref.seq };
}

// A backup of the running engine's home has ended, with its label: the
// directory it left, or null (D1 §6.5; SEAM.md §93).
export function recordBackup(tx: Tx, args: { backup: string | null; label: 'complete' | 'incomplete_for_recovery' }): void {
  tx.emit('engine.backup', {}, { backup: args.backup, label: args.label });
}
