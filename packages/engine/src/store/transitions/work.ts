// Work items (D1 §3.2, §4.3, §8.2; build spec §6 correction 11): the one
// work-item transition function, trigger observation, plan registration and
// Resume. Every status change goes through transitionWork, which checks the
// table in work-table.ts and writes exactly one work.* event.

import { recordMetMilestones } from '../../scheduler/milestones.js';
import { bindConformanceStage } from '../../adopt/conformance.js';
import { type Replaces, subjectWorkOf, swapGeneration } from '../../plan/replace.js';
import { authoringShortfall, stageScopeGaps } from '../../plan/phase.js';
import { effectiveVersion } from './protected.js';
import { Refusal } from '../../refusal.js';
import { illegal, nextSeq, notFound } from './common.js';
import { raiseQuestion } from './queue.js';
import { designPolicyOf, holdsBeforeBuild, isUiStage } from '../../design/policy.js';
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
  no_progress_count: number;
  progress_key: string | null;
  chain: number;
  profile?: string | null;
  continue_from: string | null;
}

// The work item of a run that must have one (every one-shot path): a
// session run has none (D6 §2.1), and reaching here with one is a fault
// named, never a null read as absence.
export function workItemOfRun(tx: Tx, run: { id: string; work_item: string | null }): WorkRow {
  if (run.work_item === null) throw illegal('a work item of a session run', { run: run.id });
  const item = getWorkItem(tx, run.work_item);
  if (!item) throw notFound('work_item', run.work_item);
  return item;
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
  no_progress_count?: number;
  progress_key?: string | null;
  continue_from?: string | null;
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
         "repair_attempts" = ?, "preflight_refusals" = ?, "repair_due" = ?, "no_progress_count" = ?, "progress_key" = ?, "continue_from" = ? WHERE "id" = ?`,
    )
    .run(
      next.status,
      next.continuation,
      next.blocker,
      next.dispatch_hold,
      next.prior_status,
      next.repair_attempts,
      next.preflight_refusals,
      next.repair_due,
      next.no_progress_count,
      next.progress_key,
      next.continue_from,
      item.id,
    );
  tx.emit(eventFor(from, to), { project: item.project, work_item: item.id }, { ...payload, from, to });
  // A hold ends when its item leaves `eligible` (N01; SEAM.md §431).
  if (from === 'eligible' && to !== 'eligible') setHold(tx, next, null);
  return next;
}

// Why an eligible item waits (N01 HoldReason; the driver's ruling Q3): one
// interval per hold in `held_intervals` ([{from, to?, reason}]), opened with
// `work.hold_began` and closed with `work.hold_ended` when the reason changes
// or the item leaves `eligible`; `held` is the reason now. No status
// changes. D1's `work.held` (a Stop's status change) is another thing.
export type HoldReason = 'resource_envelope' | 'chain_boundary' | 'depends_on' | 'authoring_readiness' | 'open_decision' | 'session_busy' | 'prerequisite_results' | 'design_pending' | 'design_stale';
// A hold may name what it waits on (M543: a replan's prerequisite results,
// each by its check, candidate and execution): kept on its interval, every
// result named while it lasted, and on its events.
export interface HoldDetail {
  pending?: { phase: number; key: string; candidate: string; execution: string; status: string }[];
}
export function setHold(tx: Tx, item: Pick<WorkRow, 'id' | 'project' | 'status'>, reason: HoldReason | null, detail: HoldDetail | null = null): void {
  const row = tx.db.prepare('SELECT "held", "held_intervals" FROM "work_items" WHERE "id" = ?').get(item.id) as { held: string | null; held_intervals: string | null } | undefined;
  if (!row) return;
  let intervals: { from: string; to?: string; reason: string; pending?: NonNullable<HoldDetail['pending']> }[] = [];
  try {
    intervals = row.held_intervals ? (JSON.parse(row.held_intervals) as typeof intervals) : [];
  } catch {
    intervals = [];
  }
  const open = intervals.length > 0 && intervals[intervals.length - 1]!.to === undefined ? intervals[intervals.length - 1]! : null;
  // The same hold goes on; a result it now waits on that its interval does
  // not name yet is added to it: what it waited on, not only its first.
  if ((open?.reason ?? null) === reason) {
    const seen = new Set((open?.pending ?? []).map((r) => r.execution));
    const added = (detail?.pending ?? []).filter((r) => !seen.has(r.execution));
    if (open && added.length > 0) {
      open.pending = [...(open.pending ?? []), ...added];
      tx.db.prepare('UPDATE "work_items" SET "held" = ?, "held_intervals" = ? WHERE "id" = ?').run(reason, JSON.stringify(intervals), item.id);
      return;
    }
    if (row.held !== reason) tx.db.prepare('UPDATE "work_items" SET "held" = ? WHERE "id" = ?').run(reason, item.id);
    return;
  }
  if (open) {
    open.to = tx.at;
    tx.emit('work.hold_ended', { project: item.project, work_item: item.id }, { reason: open.reason, status: item.status, from: open.from });
  }
  if (reason !== null) {
    intervals.push({ from: tx.at, reason, ...(detail?.pending ? { pending: detail.pending } : {}) });
    tx.emit('work.hold_began', { project: item.project, work_item: item.id }, { reason, status: item.status, ...(detail?.pending ? { pending: detail.pending } : {}) });
  }
  tx.db.prepare('UPDATE "work_items" SET "held" = ?, "held_intervals" = ? WHERE "id" = ?').run(reason, JSON.stringify(intervals), item.id);
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

// The two dependency milestones of a stage's work (D6 §6.4; B07, B08; SEAM.md §347).
export type Milestone =
  | { milestone: 'authoring_ready'; phase_plan: string }
  | { milestone: 'stage_code'; stage: string }
  // D6 §8.3 (B10): a retrofit replan waits for the owner's decision on the
  // requests for criteria its refused result made.
  | { milestone: 'spec_change_requests'; requests: string[] }
  // D7 §8.2, G6: a UI stage's design readiness under before_build or both.
  | { milestone: 'design_ready'; stage: string };

export interface TriggerInput {
  project: string;
  kind: unknown;
  trigger_source: string;
  trigger_id: string;
  trigger_generation: number;
  subject?: Record<string, unknown>;
  depends_on?: (string | Milestone)[];
  // The number of roles of the chain whose outcome created the work (D1-34;
  // E24 item 1): 0 for work a person or a fixture created.
  chain?: number;
  // The sandbox profile its runs are dispatched under (D2 §§2.8, 3.8); null
  // for `role`.
  profile?: 'role' | 'probe' | null;
  // Work the engine itself raises of a kind it never dispatches: only
  // `spec_change`, from D3 §5 X2's `change_spec` answer, which is recorded
  // and waits; and `deploy`, from an issued deployment authorization (D4
  // §4.1), which the Release Operator (engine code, D4 §8.1) takes on. The
  // API still refuses both kinds, and the scheduler never runs either.
  engineRaised?: boolean;
  // D6 §5.7: an early replan's triggering evidence (the generation it
  // replaces, the evidence, what became stale), kept beside the subject.
  trigger_evidence?: Record<string, unknown>;
  // D6 §6.5 (K3; N02): the trigger of the chain's first item, for work a
  // run's outcome created (chain > 0); work at chain 0 is its own origin.
  chain_origin?: ChainOrigin | null;
}

// The identity of a chain's origin (SEAM.md §429).
export interface ChainOrigin {
  trigger_source: string;
  trigger_id: string;
  trigger_generation: number;
}

// The origin of the chain a work item belongs to: recorded on it, or its own
// trigger (an item written before slice 37 began its own chain).
export function originOfItem(db: Tx['db'], id: string): ChainOrigin | null {
  const row = db.prepare('SELECT "chain_origin", "trigger_source", "trigger_id", "trigger_generation" FROM "work_items" WHERE "id" = ?').get(id) as
    | { chain_origin: string | null; trigger_source: string; trigger_id: string; trigger_generation: number }
    | undefined;
  if (!row) return null;
  if (row.chain_origin !== null) {
    try {
      return JSON.parse(row.chain_origin) as ChainOrigin;
    } catch {
      // unreadable: the item's own trigger, below
    }
  }
  return { trigger_source: row.trigger_source, trigger_id: row.trigger_id, trigger_generation: row.trigger_generation };
}

// The origin of the chain of a run's work item; null for a run with none.
export function originOfRun(db: Tx['db'], run: string): ChainOrigin | null {
  const r = db.prepare('SELECT "work_item" FROM "runs" WHERE "id" = ?').get(run) as { work_item: string | null } | undefined;
  return r?.work_item ? originOfItem(db, r.work_item) : null;
}

// D7 §6.5 (SEAM.md §487): an `asset_updated` fix names its cause, slot, versions and bindings.
const SUBJECT_KEYS = ['stage', 'candidate', 'finding', 'decision', 'proposal', 'operation', 'environment', 'authorization', 'phase_plan', 'request', 'cause', 'slot', 'from_version', 'to_version', 'bindings'];

// Observe a trigger (D1 §8.2): create-or-return across every status, terminal
// included. Re-observing an identity creates nothing and raises nothing.
// `label` is added to the work.created payload.
export function observeTrigger(tx: Tx, input: TriggerInput, label: Record<string, unknown>): { work_item: { id: string }; created: boolean } {
  const project = tx.db.prepare('SELECT "id" FROM "projects" WHERE "id" = ?').get(input.project);
  if (!project) throw notFound('project', input.project);
  if (!isWorkKind(input.kind)) {
    throw new Refusal(400, 'invalid_value', `"${String(input.kind)}" is not a work-item kind.`, 'Send one of the WorkItemKind values.', { field: 'kind' });
  }
  if (!DISPATCHABLE.includes(input.kind) && !(input.engineRaised === true && (input.kind === 'spec_change' || input.kind === 'deploy'))) {
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
    // D6 §6.4 (B08; SEAM.md §347): a milestone object is checked at dispatch
    // (runs.ts); a work id must be the project's.
    if (typeof dep !== 'string') continue;
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
         "trigger_source", "trigger_id", "trigger_generation", "repair_attempts", "no_progress_count", "preflight_refusals", "dispatch_hold", "chain", "profile", "trigger_evidence", "chain_origin")
       VALUES (?, ?, ?, ?, ?, ?, 'eligible', ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?)`,
    )
    .run(
      id,
      tx.at,
      input.project,
      seq,
      input.kind,
      JSON.stringify(subject),
      JSON.stringify(dependsOn),
      input.trigger_source,
      input.trigger_id,
      input.trigger_generation,
      input.chain ?? 0,
      input.profile ?? null,
      input.trigger_evidence ? JSON.stringify(input.trigger_evidence) : null,
      // A chain's origin (K3): inherited by work a run's outcome created, a
      // fresh trigger (chain 0) its own.
      JSON.stringify(
        (input.chain ?? 0) > 0 && input.chain_origin
          ? input.chain_origin
          : { trigger_source: input.trigger_source, trigger_id: input.trigger_id, trigger_generation: input.trigger_generation },
      ),
    );
  tx.emit('work.created', { project: input.project, work_item: id }, { ...label, to: 'eligible', kind: input.kind, seq });
  return { work_item: { id }, created: true };
}

export interface PlanStageInput {
  number: number;
  goal: string;
  // The requirements the stage implements (ids), from an approved baseline.
  implements?: string[];
  // The modules it lists (ids; D3 §4.1): its stage scope's modules.
  modules?: string[];
  // D6 K4 (A.3): the plan's own fields.
  tasks?: string[];
  // The numbers of the stages of this plan it depends on (D6 §6.4).
  depends_on?: number[];
  validation?: { criteria: string[]; kinds: string[]; sensitive_areas: string[] };
  integration_obligations?: string[];
  adrs?: string[];
  conformance?: boolean;
  execution_inputs_digest?: string | null;
}

// Who authorizes a plan's registration (D6 §5.5; B02; the driver's ruling:
// the production registerPlan requires an authority argument):
// - `publication`: the authorized finalizer of a bundle (plan/bundle.ts),
//   by the owner's consolidated approval (`human`) or §5.4's routing
//   (`engine:plan_check`, slice 35). Only it is held to §5.2's rules (the
//   next phase, one open plan), registers the milestones of §6.4 and the
//   phase's `check_authoring`, and emits `plan.published`.
// - `architect_integration`: what an Architect's one-shot integration
//   commits, registered as D1 §7.8 built it until slice 35 routes a replan
//   through the check and the publication (store/transitions/finalize.ts).
// - `fixture`: the labelled test fixture (src/testing/fixtures.ts; K4; M74),
//   `approved_by` `test fixture`, the label on its rows' events.
export type PlanAuthority =
  | { kind: 'publication'; by: 'human' | 'engine:plan_check'; bundle: string; check: string | null; routing: 'human' | 'registered'; replaces?: Replaces | null }
  | { kind: 'architect_integration' }
  | { kind: 'fixture' };

export interface RegisterPlanArgs {
  project: string;
  baseRevision: string;
  authority: PlanAuthority;
  stages: PlanStageInput[];
  phase?: number;
  gitPath?: string;
  chain?: number;
  // `publication` only: what the plan was prepared against and its planned
  // obligations record (K4; A.3).
  prepared?: { spec: string | null; architecture: string | null; roadmap: string | null };
  plannedObligations?: string | null;
}

// Register a phase plan's stages and the work of each (D1 §7.8: a registered
// plan is schedulable by construction; D6 §5.5, K4). Each stage's
// `stage_build` comes from the trigger ("plan", <stage id>, 1). A
// publication's plan must be the next phase's (`phase_not_next`) with no
// other plan open (`plan_generation_stale`; early replacement, the one
// exemption, is slice 35's compare-and-swap); its stage work waits, at
// dispatch, on the two milestones of D6 §6.4 (runs.ts), and the phase's
// `check_authoring` comes from ("phase_plan", <plan id>, 1).
export function registerPlan(
  tx: Tx,
  args: RegisterPlanArgs,
  label: Record<string, unknown>,
): { plan: { id: string; phase: number; generation: number }; stages: { id: string; number: number; work_item: string }[]; check_authoring: string | null } {
  if (!tx.db.prepare('SELECT "id" FROM "projects" WHERE "id" = ?').get(args.project)) throw notFound('project', args.project);
  const phase = args.phase ?? 1;
  const authority = args.authority;
  const publication = authority.kind === 'publication' ? authority : null;
  if (publication) {
    const { done } = tx.db.prepare(`SELECT COALESCE(MAX("phase_number"), 0) AS done FROM "phase_plans" WHERE "project" = ? AND "status" = 'completed'`).get(args.project) as { done: number };
    if (phase !== done + 1) {
      throw new Refusal(409, 'phase_not_next', `Phase ${phase} is not the next phase of project ${args.project}: ${done === 0 ? 'no phase is complete' : `phase ${done} is the last complete`}, so the next plan is phase ${done + 1}'s.`, 'Plan the next phase only (F §3.10.1).', {
        project: args.project,
        phase,
        next: done + 1,
      });
    }
    const open = tx.db.prepare(`SELECT "id", "generation" FROM "phase_plans" WHERE "project" = ? AND "status" = 'published' AND "active" = 1 ORDER BY rowid DESC LIMIT 1`).get(args.project) as
      | { id: string; generation: number }
      | undefined;
    const replaces = publication.replaces ?? null;
    // Early replacement (D6 §5.7; B08): the one exemption, a compare-and-swap
    // on the active generation the replacement names.
    if (replaces && (!open || open.id !== replaces.phase_plan || open.generation !== replaces.generation)) {
      throw new Refusal(409, 'plan_generation_stale', `The replacement names generation ${replaces.generation} of plan ${replaces.phase_plan}, which is no longer the active one${open ? ` (${open.id}, generation ${open.generation})` : ''}.`, 'The proposal is stale, not current; a new replan proposes against the active generation.', {
        project: args.project,
        phase,
        phase_plan: replaces.phase_plan,
        named_generation: replaces.generation,
        active: open ? { phase_plan: open.id, generation: open.generation } : null,
      });
    }
    if (open && !replaces) {
      throw new Refusal(409, 'plan_generation_stale', `Project ${args.project} already has an open plan (${open.id}, generation ${open.generation}); a second plan is registered only by early replacement.`, 'Replace the open plan through the replacement route, or complete it.', {
        project: args.project,
        phase,
        phase_plan: open.id,
        active_generation: open.generation,
      });
    }
  }
  const replaces = publication?.replaces ?? null;
  const approvedBy = publication ? publication.by : authority.kind === 'fixture' ? 'test fixture' : null;
  const plan = tx.newId('plan_');
  const generation = replaces ? replaces.generation + 1 : 1;
  tx.db
    .prepare(
      `INSERT INTO "phase_plans" ("id", "created_at", "project", "phase_number", "prepared_against_revision", "git_path", "approved_by", "approved_at",
         "prepared_against_spec", "prepared_against_architecture", "prepared_against_roadmap", "roadmap_revision", "generation", "active", "bundle", "check", "routing", "status", "published_at", "planned_obligations")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'published', ?, ?)`,
    )
    .run(
      plan,
      tx.at,
      args.project,
      phase,
      args.baseRevision,
      args.gitPath ?? (publication ? `.surety/phases/phase-${phase}.json` : '.surety/phases/phase-1.md'),
      approvedBy,
      approvedBy === null ? null : tx.at,
      args.prepared?.spec ?? null,
      args.prepared?.architecture ?? null,
      args.prepared?.roadmap ?? null,
      args.prepared?.roadmap ?? null,
      generation,
      publication?.bundle ?? null,
      publication?.check ?? null,
      publication?.routing ?? null,
      publication ? tx.at : null,
      args.plannedObligations ?? null,
    );
  // The swap and the stages it carries (kept, retained) under their ids.
  const ids = new Map<number, string>();
  let swap: ReturnType<typeof swapGeneration> = null;
  if (replaces) {
    swap = swapGeneration(tx, { project: args.project, replaces, plan, generation, digests: new Map(args.stages.map((st) => [st.number, st.execution_inputs_digest ?? null])), subjectWork: subjectWorkOf(replaces) });
    if (swap === null) throw illegal('a replacement whose named generation is no longer active', { project: args.project, phase_plan: replaces.phase_plan, generation: replaces.generation });
    for (const [n, id] of swap.carried) ids.set(n, id);
    // A listed stage the swap carries under its number must be that stage
    // with its inputs: never a silent drop of the listed one (the review's
    // S1). Publication compares first; this refuses what it could not.
    for (const st of args.stages) {
      const carriedId = swap.carried.get(st.number);
      if (!carriedId) continue;
      const row = tx.db.prepare('SELECT "execution_inputs_digest" FROM "stages" WHERE "id" = ?').get(carriedId) as { execution_inputs_digest: string | null };
      if (row.execution_inputs_digest !== (st.execution_inputs_digest ?? null)) throw new Refusal(409, 'plan_generation_stale', `Stage ${st.number} is carried by the swap under other inputs than the replacement lists.`, 'The proposal is stale; the replan proposes again.', { project: args.project, stage: carriedId, number: st.number });
    }
    tx.db
      .prepare('UPDATE "phase_plans" SET "replacement" = ? WHERE "id" = ?')
      .run(
        JSON.stringify({ replaces: replaces.phase_plan, generation: replaces.generation, trigger: replaces.trigger, evidence: replaces.evidence, stale: replaces.stale, kept: swap.kept, retained: swap.retained, cancelled: swap.cancelled, superseded: swap.superseded }),
        plan,
      );
  }
  // A Reviewer's plan-targeted `fix` is resolved by the replacement its
  // replan publishes (D6 §5.7; the driver's ruling 2).
  if (replaces?.trigger?.source === 'contract_conflict') {
    const f = replaces.trigger.id;
    const open = tx.db.prepare(`SELECT 1 FROM "findings" WHERE "id" = ? AND "project" = ? AND "status" <> 'resolved'`).get(f, args.project);
    if (open) {
      tx.db.prepare(`UPDATE "findings" SET "status" = 'resolved', "resolution_verification" = ? WHERE "id" = ?`).run(JSON.stringify({ phase_plan: plan, generation, bundle: publication?.bundle ?? null }), f);
      tx.emit('finding.resolved', { project: args.project, finding: f }, { phase_plan: plan, generation, bundle: publication?.bundle ?? null });
    }
  }
  const carried = new Set(ids.keys());
  const fresh = args.stages.filter((st) => !carried.has(st.number));
  const seen = new Set<number>();
  for (const stage of fresh) {
    if (seen.has(stage.number)) throw illegal(`a plan with stage ${stage.number} twice`, { project: args.project, phase, stage: stage.number });
    seen.add(stage.number);
    ids.set(stage.number, tx.newId('stage_'));
  }
  const out: { id: string; number: number; work_item: string }[] = [];
  for (const stage of fresh) {
    const id = ids.get(stage.number)!;
    const deps = (stage.depends_on ?? []).map((n) => {
      const dep = ids.get(n);
      if (!dep) throw illegal(`stage ${stage.number} depends on stage ${n}, which the plan has not`, { project: args.project, phase, stage: stage.number, depends_on: n });
      return dep;
    });
    tx.db
      .prepare(
        `INSERT INTO "stages" ("id", "created_at", "project", "phase_plan", "number", "goal", "modules", "requirement_ids", "implements", "status", "adrs",
           "tasks", "depends_on", "validation", "integration_obligations", "generation", "execution_inputs_digest", "conformance")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        tx.at,
        args.project,
        plan,
        stage.number,
        stage.goal,
        JSON.stringify(stage.modules ?? []),
        JSON.stringify(stage.implements ?? []),
        JSON.stringify(stage.implements ?? []),
        JSON.stringify(stage.adrs ?? []),
        JSON.stringify(stage.tasks ?? []),
        JSON.stringify(deps),
        JSON.stringify(stage.validation ?? { criteria: [], kinds: [], sensitive_areas: [] }),
        JSON.stringify(stage.integration_obligations ?? []),
        generation,
        stage.execution_inputs_digest ?? null,
        stage.conformance === true ? 1 : 0,
      );
    // K11 (B11): a conformance stage has no stage_build at any point; its
    // lifecycle is its own (adopt/conformance.ts), its source bound to A here.
    if (stage.conformance === true && publication) {
      bindConformanceStage(tx, { project: args.project, stage: id, head: args.baseRevision });
      out.push({ id, number: stage.number, work_item: '' });
      continue;
    }
    // D6 §6.4 (B07, B08): a published stage's work waits on the phase's
    // authoring readiness and on the stage-code milestone of each stage it
    // depends on. A fixture's or an Architect integration's plan is as D1
    // built it: no milestone.
    const milestones: Milestone[] = publication ? [{ milestone: 'authoring_ready', phase_plan: plan }, ...deps.map((d) => ({ milestone: 'stage_code' as const, stage: d }))] : [];
    // D7 §8.2, G6: a UI stage under before_build or both waits on design too.
    if (publication && holdsBeforeBuild(designPolicyOf(tx.db, args.project)) && isUiStage(tx.db, args.project, { modules: JSON.stringify(stage.modules ?? []) })) milestones.push({ milestone: 'design_ready', stage: id });
    const made = observeTrigger(
      tx,
      { project: args.project, kind: 'stage_build', trigger_source: 'plan', trigger_id: id, trigger_generation: 1, subject: { stage: id }, chain: args.chain ?? 0, ...(milestones.length > 0 ? { depends_on: milestones } : {}) },
      label,
    );
    tx.db.prepare('UPDATE "stages" SET "work_item" = ? WHERE "id" = ?').run(made.work_item.id, id);
    out.push({ id, number: stage.number, work_item: made.work_item.id });
  }
  let authoring: string | null = null;
  // An early replacement whose planned obligations the effective protected
  // version already meets is ready as published: the authorized version
  // that establishes them is applied (D6 §6.2; B07), so no authoring is
  // owed; otherwise it registers its own, as any plan (the driver's ruling 8).
  let inherited = false;
  if (publication && replaces) {
    const effective = effectiveVersion(tx.db, args.project);
    // Ready as published only when the stages' own gate scopes are met too
    // (stageScopeGaps; the real M443 run's replacement inherited readiness
    // with stage 5 lacking its integration kind).
    if (effective && authoringShortfall(tx.db, plan, effective.id).length === 0 && stageScopeGaps(tx.db, plan, effective.id).length === 0) {
      tx.db.prepare('UPDATE "phase_plans" SET "authoring_ready_at" = ?, "authoring_ready_by" = ? WHERE "id" = ?').run(tx.at, effective.id, plan);
      tx.emit('phase.authoring_ready', { project: args.project, phase_plan: plan }, { protected_version: effective.id, inherited_from: replaces.phase_plan });
      inherited = true;
    }
  }
  if (publication) {
    // The phase's check authoring (D6 §6.2; K7), registered with the plan.
    if (!inherited) authoring = observeTrigger(tx, { project: args.project, kind: 'check_authoring', trigger_source: 'phase_plan', trigger_id: plan, trigger_generation: 1, subject: { phase_plan: plan }, chain: 0 }, label).work_item.id;
    if (authoring !== null) tx.db.prepare('UPDATE "phase_plans" SET "check_authoring" = ? WHERE "id" = ?').run(authoring, plan);
    tx.emit('plan.published', { project: args.project, phase_plan: plan }, {
      ...label,
      phase,
      generation,
      approved_by: publication.by,
      routing: publication.routing,
      stages: out.map((s) => s.id),
      check_authoring: authoring,
      bundle: publication.bundle,
      // An early replacement's swap (D6 §5.7): what it replaced, carried and
      // cancelled, and what became stale.
      ...(replaces && swap
        ? { replaces: { phase_plan: replaces.phase_plan, generation: replaces.generation }, trigger: replaces.trigger, stale: replaces.stale, kept: swap.kept, retained: swap.retained, cancelled: swap.cancelled, superseded: swap.superseded }
        : {}),
    });
  }
  // Milestones already met at publication (an inherited readiness, a
  // stage already integrated) are recorded now (D6 §6.4).
  if (publication) recordMetMilestones(tx, args.project);
  return { plan: { id: plan, phase, generation }, stages: out, check_authoring: authoring };
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
    // Lifting a hold changes no status and is still a domain event (D1 §4.3,
    // §12.1, §15.3): one work.resumed naming the status the item keeps, in
    // the transaction that clears the hold.
    tx.db.prepare('UPDATE "work_items" SET "dispatch_hold" = 0 WHERE "id" = ?').run(item.id);
    tx.emit('work.resumed', { project: item.project, work_item: item.id }, { cause: 'resume', from: item.status, to: item.status });
    next = { ...item, dispatch_hold: 0 };
  } else {
    throw illegal(`Resume of a ${item.status} item`, { work_item: item.id, status: item.status, dispatch_hold: item.dispatch_hold });
  }
  return { work_item: { id: next.id, status: next.status, dispatch_hold: next.dispatch_hold } };
}

// Work at its chaining boundary (D1 §8.1 step 8; D1-34; SEAM.md §40): it
// stays eligible, and the next step is a decision on it, raised once.
export function chainBoundary(tx: Tx, args: { workItem: string }): void {
  const item = getWorkItem(tx, args.workItem);
  if (!item || item.status !== 'eligible') return;
  if (item.blocker !== null) return;
  tx.db.prepare('UPDATE "work_items" SET "blocker" = ? WHERE "id" = ?').run(JSON.stringify({ reason: 'max_chained_roles', raised_at: tx.at, decision: null }), item.id);
  raiseQuestion(tx, { project: item.project, kind: 'blocker', subjectType: 'work_item', subjectId: item.id });
}
