// Work items (D1 §3.2, §4.3, §8.2; build spec §6 correction 11): the one
// work-item transition function, trigger observation, plan registration and
// Resume. Every status change goes through transitionWork, which checks the
// table in work-table.ts and writes exactly one work.* event.

import { Refusal } from '../../refusal.js';
import { illegal, nextSeq, notFound } from './common.js';
import type { EventType, Tx } from './tx.js';
import {
  DISPATCHABLE,
  type WorkKind,
  type WorkStatus,
  isLegalWorkEdge,
  isWorkKind,
  isWorkStatus,
} from './work-table.js';

export interface WorkRow {
  id: string;
  project: string;
  seq: number;
  kind: WorkKind;
  subject: string;
  status: WorkStatus;
  blocker: string | null;
  depends_on: string | null;
  trigger_source: string;
  trigger_id: string;
  trigger_generation: number;
  repair_attempts: number;
  preflight_refusals: number;
  prior_status: WorkStatus | null;
  dispatch_hold: number;
  continuation: WorkStatus | null;
  repair_due: number;
}

export function getWorkItem(tx: Tx, id: string): WorkRow | undefined {
  return tx.db.prepare('SELECT * FROM "work_items" WHERE "id" = ?').get(id) as WorkRow | undefined;
}

// Which A.6 event carries a change of status (D1 §4.3).
function eventFor(from: WorkStatus, to: WorkStatus): EventType {
  switch (to) {
    case 'claimed':
      return 'work.claimed';
    case 'integrated':
      return 'work.integrated';
    case 'complete':
      return 'work.complete';
    case 'held':
      return 'work.held';
    case 'parked':
      return 'work.parked';
    case 'cancelled':
      return 'work.cancelled';
    case 'eligible':
      return from === 'held' || from === 'parked' ? 'work.resumed' : 'work.advanced';
    default:
      return 'work.advanced';
  }
}

// Columns a transition may set together with the status.
export interface WorkChanges {
  blocker?: string | null;
  dispatch_hold?: 0 | 1;
  prior_status?: WorkStatus | null;
  repair_attempts?: number;
  preflight_refusals?: number;
  repair_due?: 0 | 1;
}

// The work-item transition function. Refuses with illegal_transition, and
// changes nothing, unless the table allows the item's kind to go from its
// current status to `to` (and, out of awaiting_decision, to its stored
// continuation). Entering awaiting_decision stores the status left.
export function transitionWork(tx: Tx, item: WorkRow, to: WorkStatus, changes: WorkChanges = {}, payload: Record<string, unknown> = {}): WorkRow {
  const from = item.status;
  if (!isLegalWorkEdge(item.kind, from, to, item.continuation)) {
    throw illegal(`${item.kind} ${from} → ${to}`, { work_item: item.id, kind: item.kind, from, to });
  }
  let continuation: WorkStatus | null = item.continuation;
  if (to === 'awaiting_decision') continuation = from;
  else if (from === 'awaiting_decision') continuation = null;
  const next: WorkRow = { ...item, ...changes, status: to, continuation } as WorkRow;
  tx.db
    .prepare(
      `UPDATE "work_items" SET "status" = ?, "continuation" = ?, "blocker" = ?, "dispatch_hold" = ?, "prior_status" = ?,
         "repair_attempts" = ?, "preflight_refusals" = ?, "repair_due" = ? WHERE "id" = ?`,
    )
    .run(next.status, next.continuation, next.blocker, next.dispatch_hold, next.prior_status, next.repair_attempts, next.preflight_refusals, next.repair_due, item.id);
  tx.emit(eventFor(from, to), { project: item.project, work_item: item.id }, { ...payload, from, to });
  return next;
}

// POST /v1/harness/work/:w/transition applies this directly (SEAM.md §15): the
// table and the stored continuation only; nothing is launched or ended.
export function applyWorkTransition(tx: Tx, args: { workItem: string; to: unknown }): { work_item: { id: string; status: WorkStatus } } {
  const item = getWorkItem(tx, args.workItem);
  if (!item) throw notFound('work_item', args.workItem);
  if (!isWorkStatus(args.to)) {
    throw new Refusal(400, 'invalid_value', '"to" must be a work-item status.', 'Send one of the WorkItemStatus values.', { field: 'to' });
  }
  const next = transitionWork(tx, item, args.to);
  return { work_item: { id: next.id, status: next.status } };
}

export interface TriggerInput {
  project: string;
  kind: unknown;
  trigger_source: string;
  trigger_id: string;
  trigger_generation: number;
  subject?: Record<string, unknown>;
  depends_on?: string[];
}

const SUBJECT_KEYS = ['stage', 'candidate', 'finding', 'decision', 'proposal', 'operation'];

// Observe a trigger (D1 §8.2): create-or-return across every status, terminal
// included. Re-observing an identity creates nothing and raises nothing.
// `label` is added to the work.created payload.
export function observeTrigger(tx: Tx, input: TriggerInput, label: Record<string, unknown>): { work_item: { id: string }; created: boolean } {
  const project = tx.db.prepare('SELECT "id" FROM "projects" WHERE "id" = ?').get(input.project);
  if (!project) throw notFound('project', input.project);
  if (!isWorkKind(input.kind)) {
    throw new Refusal(400, 'invalid_value', `"${String(input.kind)}" is not a work-item kind.`, 'Send one of the WorkItemKind values.', { field: 'kind' });
  }
  if (!DISPATCHABLE.includes(input.kind)) {
    throw new Refusal(
      501,
      'unsupported',
      `Work of kind "${input.kind}" is outside milestone M1 and cannot become work in this engine.`,
      'Nothing was created. This kind needs a later design and milestone.',
      { kind: input.kind },
    );
  }
  const subject = input.subject ?? {};
  for (const key of Object.keys(subject)) {
    if (!SUBJECT_KEYS.includes(key)) throw new Refusal(400, 'unknown_field', `"subject.${key}" is not a work-item subject key.`, 'Send only D1 A.3 subject keys.', { field: `subject.${key}` });
  }
  const dependsOn = input.depends_on ?? [];
  for (const dep of dependsOn) {
    const row = tx.db.prepare('SELECT "project" FROM "work_items" WHERE "id" = ?').get(dep) as { project: string } | undefined;
    if (!row || row.project !== input.project) throw notFound('work_item', dep);
  }
  const existing = tx.db
    .prepare('SELECT "id" FROM "work_items" WHERE "project" = ? AND "trigger_source" = ? AND "trigger_id" = ? AND "trigger_generation" = ?')
    .get(input.project, input.trigger_source, input.trigger_id, input.trigger_generation) as { id: string } | undefined;
  if (existing) return { work_item: { id: existing.id }, created: false };

  const id = tx.newId('wi_');
  const seq = nextSeq(tx, input.project, 'work_items');
  tx.db
    .prepare(
      `INSERT INTO "work_items" ("id", "created_at", "project", "seq", "kind", "subject", "status", "depends_on",
         "trigger_source", "trigger_id", "trigger_generation", "repair_attempts", "no_progress_count", "preflight_refusals", "dispatch_hold")
       VALUES (?, ?, ?, ?, ?, ?, 'eligible', ?, ?, ?, ?, 0, 0, 0, 0)`,
    )
    .run(id, tx.at, input.project, seq, input.kind, JSON.stringify(subject), JSON.stringify(dependsOn), input.trigger_source, input.trigger_id, input.trigger_generation);
  tx.emit('work.created', { project: input.project, work_item: id }, { ...label, to: 'eligible', kind: input.kind, seq });
  return { work_item: { id }, created: true };
}

export interface PlanStageInput {
  number: number;
  goal: string;
}

// Register a phase plan's stages and the stage_build work of each (D1 §7.8:
// a registered plan is schedulable by construction). Each stage's work comes
// from the trigger ("plan", <stage id>, 1).
export function registerPlan(
  tx: Tx,
  args: { project: string; baseRevision: string; approvedBy: string; stages: PlanStageInput[] },
  label: Record<string, unknown>,
): { plan: { id: string }; stages: { id: string; number: number; work_item: string }[] } {
  if (!tx.db.prepare('SELECT "id" FROM "projects" WHERE "id" = ?').get(args.project)) throw notFound('project', args.project);
  const plan = tx.newId('plan_');
  tx.db
    .prepare(
      `INSERT INTO "phase_plans" ("id", "created_at", "project", "phase_number", "prepared_against_revision", "git_path", "approved_by", "approved_at")
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
    )
    .run(plan, tx.at, args.project, args.baseRevision, '.surety/phases/phase-1.md', args.approvedBy, tx.at);
  const out = [];
  for (const stage of args.stages) {
    const id = tx.newId('stage_');
    tx.db
      .prepare(
        `INSERT INTO "stages" ("id", "created_at", "project", "phase_plan", "number", "goal", "modules", "requirement_ids", "implements", "status")
         VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', '[]', 'planned')`,
      )
      .run(id, tx.at, args.project, plan, stage.number, stage.goal);
    const made = observeTrigger(
      tx,
      { project: args.project, kind: 'stage_build', trigger_source: 'plan', trigger_id: id, trigger_generation: 1, subject: { stage: id } },
      label,
    );
    tx.db.prepare('UPDATE "stages" SET "work_item" = ? WHERE "id" = ?').run(made.work_item.id, id);
    out.push({ id, number: stage.number, work_item: made.work_item.id });
  }
  return { plan: { id: plan }, stages: out };
}

// POST /v1/projects/:p/work/:w/resume (D1 §8.4, §15.3): held work becomes
// eligible; a dispatch hold is cleared. The next dispatch is a new run.
export function resumeWork(tx: Tx, args: { project: string; workItem: string }) {
  const item = getWorkItem(tx, args.workItem);
  if (!item || item.project !== args.project) throw notFound('work_item', args.workItem);
  let next = item;
  if (item.status === 'held') {
    next = transitionWork(tx, item, 'eligible', { dispatch_hold: 0, repair_due: 0 }, { cause: 'resume' });
  } else if (item.status === 'eligible' && item.dispatch_hold === 1) {
    tx.db.prepare('UPDATE "work_items" SET "dispatch_hold" = 0 WHERE "id" = ?').run(item.id);
    next = { ...item, dispatch_hold: 0 };
  } else {
    throw illegal(`Resume of a ${item.status} item`, { work_item: item.id, status: item.status, dispatch_hold: item.dispatch_hold });
  }
  return { work_item: { id: next.id, status: next.status, dispatch_hold: next.dispatch_hold } };
}
