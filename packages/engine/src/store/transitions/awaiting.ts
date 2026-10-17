// No work item awaits a decision without something it waits on (the
// driver's rulings on M401's T1 runs, slice 37; ruling 2 and the
// correction wedge). Checked at the end of every transaction that moves a
// work item, for each item it left `awaiting_decision`:
//
// - an open decision that blocks it (a `blocker` about it, or one whose
//   `blocked_while_open` lists it) is what it waits on;
// - a correction or authoring waiting on its protected proposal
//   (`correction_proposed`) waits on that proposal's course: captured and
//   not yet classified (the next tick classifies it and raises its
//   question), its question open, or approved with its application under way
//   (an intent pending or executing, or a Reviewer's approval the ticks
//   apply). A proposal decided while the item waited ends the wait here; a
//   proposal classified with no open question has it raised;
// - an item put there by the bare `block` template (no blocker recorded) is
//   given the D1 blocker route in the same transaction: a blocker
//   `{reason: 'block'}` and its question (resume to the continuation, or
//   cancel); the driver's ruling on M09/M234, slice 37;
// - a design batch held behind a pending correction (`design_batch_deferred`,
//   objection 166) waits on that correction's application, and is raised
//   once none is pending;
// - anything else has its `blocker` question raised. With nothing to ask,
//   the item cannot be left waiting on nothing: the transaction is refused
//   (illegal_transition), so a new path that would wedge an item fails where
//   it is made, not later in a stall.

import type { DecisionKind } from './decisions.js';
import { illegal } from './common.js';
import type { Tx } from './tx.js';
import { getWorkItem } from './work.js';

// Bound at registration (store/worker.ts), so this module imports nothing
// that imports the transaction module back.
export interface AwaitingDeps {
  raiseQuestion: (tx: Tx, args: { project: string; kind: DecisionKind; subjectType: string; subjectId: string }) => { id: string } | null;
  correctionKind: (changeKind: string | null) => DecisionKind | undefined;
  proposalDecided: (tx: Tx, args: { proposal: string; applied: boolean }) => void;
  // Invalidates the open blocker question about the item, if one stands.
  dropBlocker: (tx: Tx, item: string) => void;
  // A design batch held behind a pending correction (objection 166): true
  // while a correction is pending, or once the batch is raised.
  deferredBatch?: (tx: Tx, item: string) => boolean;
}

let deps: AwaitingDeps | null = null;
export function registerAwaiting(d: AwaitingDeps): void {
  deps = d;
}

const openBlocking = (tx: Tx, item: string): boolean =>
  tx.db
    .prepare(
      `SELECT 1 FROM "decisions" d WHERE d."status" = 'open' AND (
         (d."subject_type" = 'work_item' AND d."subject_id" = ?)
         OR EXISTS (SELECT 1 FROM json_each(json_extract(d."blocked_while_open", '$.work_items')) w WHERE w."value" = ?))
       LIMIT 1`,
    )
    .get(item, item) !== undefined;

// What the item waits on, made so if it can be; false: nothing.
export function settleAwaitingItem(tx: Tx, id: string): boolean {
  const item = getWorkItem(tx, id);
  if (!item || item.status !== 'awaiting_decision') return true;
  if (openBlocking(tx, item.id)) return true;
  let blocker: { reason?: string; proposal?: string } | null = null;
  try {
    blocker = item.blocker ? (JSON.parse(item.blocker) as { reason?: string; proposal?: string }) : null;
  } catch {
    blocker = null;
  }
  if (blocker === null) {
    blocker = { reason: 'block' };
    tx.db.prepare('UPDATE "work_items" SET "blocker" = ? WHERE "id" = ?').run(JSON.stringify({ reason: 'block', raised_at: tx.at, decision: null }), item.id);
  }
  if (blocker?.reason === 'correction_proposed' && typeof blocker.proposal === 'string') {
    const p = tx.db.prepare('SELECT "id", "project", "status", "classified_change_kind", "approver_authority" FROM "protected_proposals" WHERE "id" = ?').get(blocker.proposal) as
      | { id: string; project: string; status: string; classified_change_kind: string | null; approver_authority: string | null }
      | undefined;
    if (!p) return false;
    if (p.status === 'applied' || p.status === 'rejected') {
      deps?.proposalDecided(tx, { proposal: p.id, applied: p.status === 'applied' });
      return getWorkItem(tx, id)?.status !== 'awaiting_decision' || openBlocking(tx, id);
    }
    if (p.status === 'captured' && p.classified_change_kind === null) return true;
    const open = tx.db.prepare(`SELECT 1 FROM "decisions" WHERE "subject_type" = 'protected_proposal' AND "subject_id" = ? AND "status" = 'open' LIMIT 1`).get(p.id) !== undefined;
    if (open) return true;
    if (p.status === 'approved') {
      if (p.approver_authority === 'reviewer') return true;
      const intent = tx.db.prepare(`SELECT 1 FROM "effect_intents" WHERE json_extract("plan", '$.proposal') = ? AND "status" IN ('pending', 'executing') LIMIT 1`).get(p.id);
      if (intent !== undefined) return true;
    }
    const kind = deps?.correctionKind(p.classified_change_kind);
    if (kind && deps?.raiseQuestion(tx, { project: p.project, kind, subjectType: 'protected_proposal', subjectId: p.id })) return true;
    return false;
  }
  // A design batch held back while an approved correction of the protected
  // checks is not applied (objection 166): it waits on that application,
  // and is raised once none is pending.
  if (blocker?.reason === 'design_batch_deferred' && deps?.deferredBatch) {
    if (deps.deferredBatch(tx, item.id)) return true;
  }
  return deps?.raiseQuestion(tx, { project: item.project, kind: 'blocker', subjectType: 'work_item', subjectId: item.id }) != null;
}

// At the end of a transaction: every item it moved that is left awaiting.
export function settleAwaiting(tx: Tx): void {
  if (deps === null) return;
  const moved = new Set<string>();
  const left = new Set<string>();
  for (const ref of tx.events) {
    if (!ref.type.startsWith('work.')) continue;
    const row = tx.db.prepare('SELECT json_extract("subject", \'$.work_item\') AS w, json_extract("payload", \'$.to\') AS t, json_extract("payload", \'$.from\') AS f FROM "events" WHERE "id" = ?').get(ref.id) as { w: string | null; t: string | null; f: string | null } | undefined;
    if (row?.w && row.t === 'awaiting_decision') moved.add(row.w);
    if (row?.w && row.f === 'awaiting_decision' && row.t !== 'awaiting_decision') left.add(row.w);
  }
  // An item the bare `block` put there that left by another route: its
  // blocker and its question no longer stand.
  for (const id of left) {
    const item = getWorkItem(tx, id);
    if (!item || item.status === 'awaiting_decision' || item.blocker === null) continue;
    let reason: string | undefined;
    try {
      reason = (JSON.parse(item.blocker) as { reason?: string }).reason;
    } catch {
      reason = undefined;
    }
    if (reason !== 'block') continue;
    tx.db.prepare('UPDATE "work_items" SET "blocker" = NULL WHERE "id" = ?').run(id);
    deps.dropBlocker(tx, id);
  }
  for (const id of moved) {
    if (!settleAwaitingItem(tx, id)) throw illegal(`work item ${id} left awaiting_decision with no decision it waits on`, { work_item: id });
  }
}

// The tick's sweep (the "stays" half): every item of the project awaiting a
// decision is given what it waits on, if it has lost it. Returns how many
// were settled; one with nothing to ask is left for the log, never thrown.
export function sweepAwaiting(tx: Tx, args: { project: string }): { settled: number; unexplained: string[] } {
  const rows = tx.db.prepare(`SELECT "id" FROM "work_items" WHERE "project" = ? AND "status" = 'awaiting_decision' ORDER BY "seq"`).all(args.project) as { id: string }[];
  const unexplained: string[] = [];
  let settled = 0;
  for (const r of rows) {
    if (settleAwaitingItem(tx, r.id)) settled++;
    else unexplained.push(r.id);
  }
  return { settled, unexplained };
}
