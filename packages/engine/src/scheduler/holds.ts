// Holds as intervals (D6 §7.6, A.2 HoldReason; N01; the driver's ruling Q3;
// SEAM.md §431): at each tick, after dispatch, every eligible work item is
// given the reason it waits, from the scheduler's own checks, and its
// interval is opened, changed or closed (work.ts setHold). Idle time is then
// the elapsed time of those intervals by reason, never a count of ticks. A
// wait the closed HoldReason does not name (a paused project, a day limit, a
// journal or an out-of-band hold) records no interval. Pure over the store
// but for the interval writes; no status changes.

import { CHAIN_BOUNDARY, PREREQUISITES_PENDING, dispatchBlocker, replanPendingPrerequisites } from '../store/transitions/runs.js';
import { envelopeHold } from '../store/transitions/envelope.js';
import type { Tx } from '../store/transitions/tx.js';
import { type HoldDetail, type HoldReason, type WorkRow, setHold } from '../store/transitions/work.js';
import { PROTOTYPE_LIMIT, askOfItem, enforceIterationLimit, settleIterationRuntime } from '../store/transitions/prototype.js';

// The HoldReason a dispatch blocker names, or null.
export function holdReasonOf(blocker: string): HoldReason | null {
  if (blocker === 'session_busy') return 'session_busy';
  // D7 §8.2: the third milestone unmet.
  if (blocker === 'design_pending') return 'design_pending';
  if (blocker === 'design_stale') return 'design_stale';
  // M543 (SEAM.md §474): a replan held for its prerequisite results.
  if (blocker.startsWith(PREREQUISITES_PENDING)) return 'prerequisite_results';
  if (blocker === CHAIN_BOUNDARY) return 'chain_boundary';
  if (blocker === 'held by an open decision' || blocker.startsWith("waits for the owner's decision")) return 'open_decision';
  if (blocker === 'authoring not ready' || blocker === 'plan not active') return 'authoring_readiness';
  if (blocker.startsWith('depends on') || blocker.startsWith('spec_change_pending')) return 'depends_on';
  return null;
}

export function markHolds(tx: Tx): number {
  const items = tx.db.prepare(`SELECT * FROM "work_items" WHERE "status" = 'eligible' OR "held" IS NOT NULL ORDER BY "project", "seq"`).all() as (WorkRow & { held: string | null })[];
  let changed = 0;
  // A rapid prototype's iteration whose runtime has passed is limit_reached
  // at the tick (R4; slice E2), whatever is eligible.
  settleIterationRuntime(tx);
  const envelope = new Map<string, boolean>();
  const envelopeHolds = (project: string): boolean => {
    if (!envelope.has(project)) envelope.set(project, envelopeHold(tx.db, { kind: 'role', project }) !== null);
    return envelope.get(project)!;
  };
  for (const item of items) {
    let reason: HoldReason | null = null;
    let detail: HoldDetail | null = null;
    if (item.status === 'eligible') {
      let blocker: string | null;
      try {
        blocker = dispatchBlocker(tx.db, item, { check: false });
      } catch {
        blocker = 'unreadable';
      }
      if (blocker !== null) reason = holdReasonOf(blocker);
      // An iteration limit an eligible item meets is recorded on the
      // iteration (R4; slice E2), as its claim would record it.
      if (blocker !== null && blocker.startsWith(PROTOTYPE_LIMIT)) enforceIterationLimit(tx, item.project, askOfItem(tx.db, item));
      // Dispatchable and still eligible after dispatch: the envelope held it.
      else if (envelopeHolds(item.project)) reason = 'resource_envelope';
      // A replan held for its prerequisite results names them (M543).
      if (blocker !== null && blocker.startsWith(PREREQUISITES_PENDING)) {
        const pending = replanPendingPrerequisites(tx.db, item);
        if (pending !== null) detail = { pending };
      }
    }
    if ((item.held ?? null) !== reason) changed++;
    setHold(tx, item, reason, detail);
  }
  return changed;
}
