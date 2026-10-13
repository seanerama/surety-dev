// Early replanning (F §3.10.7; D6 §5.7; B08; D6-F04): the triggers that
// create `replan` work against the open plan, each with its evidence and
// what it made stale, and the replacement's compare-and-swap on the active
// plan generation, the one route exempt from §5.2's second-plan refusal.
//
// The swap (registerPlan's publication authority with `replaces`, in the
// authorized finalizer's one transaction): the generation it names is the
// active one, or the publication is `plan_generation_stale`; the old row
// becomes `replaced`; the stages `integrated` or `verified` (their work
// neither parked nor waiting on a decision) are kept, re-pointed to the new
// generation with their ids, revisions, work and findings; a `building`
// stage is retained only when every execution and acceptance input is
// unchanged (its execution-inputs digest, and each stage it depends on kept
// or retained under its identity); every other stage is superseded: a
// `planned` one `cancelled` with its work, any other `cancelled_at` with
// its idle work cancelled and a running one finishing as history (its late
// integration fulfils no replacement work, finalize.ts). Only the remainder
// is registered. Filing alone triggers nothing.

import { parseJson } from '../store/transitions/common.js';
import { type DecisionRow, invalidateDecision } from '../store/transitions/decisions.js';
import type { Tx } from '../store/transitions/tx.js';
import { type WorkRow, getWorkItem, observeTrigger, transitionWork } from '../store/transitions/work.js';

type Db = Tx['db'];

// D6 A.2 ReplanTrigger, the early ones (phase_complete is §5.6's).
export const EARLY_TRIGGERS = ['spec_change', 'blocker_replan', 'objection_upheld', 'contract_conflict'] as const;
export type EarlyTrigger = (typeof EARLY_TRIGGERS)[number];

export interface ReplacementTarget {
  phase_plan: string;
  generation: number;
}

// What a replacement records (phase_plans.replacement; plan_bundles.replaces).
export interface Replaces extends ReplacementTarget {
  trigger: { source: string; id: string; generation: number } | null;
  evidence: unknown;
  stale: unknown;
}

// The project's open plan: published, active, not complete.
export function activePlan(db: Db, project: string): { id: string; phase_number: number; generation: number } | undefined {
  return db.prepare(`SELECT "id", "phase_number", "generation" FROM "phase_plans" WHERE "project" = ? AND "status" = 'published' AND "active" = 1 AND "completed_at" IS NULL ORDER BY "created_at" DESC LIMIT 1`).get(project) as
    | { id: string; phase_number: number; generation: number }
    | undefined;
}

// The generation an early replan names: recorded on its subject when the
// trigger made it (the plan open then and its generation). null for a
// replan that replaces nothing (§5.6's, or one made while no plan was open).
export function replacementOf(db: Db, item: { trigger_source: string; trigger_id: string; trigger_generation: number; subject: string; trigger_evidence?: string | null }): Replaces | null {
  if (!(EARLY_TRIGGERS as readonly string[]).includes(item.trigger_source)) return null;
  // The trigger's evidence names the plan and generation; a spec change's
  // made before it was recorded (slice 31) names the plan on its subject.
  const s = { ...(parseJson<{ phase_plan?: string }>(item.subject) ?? {}), ...(parseJson<{ phase_plan?: string; generation?: number; evidence?: unknown; stale?: unknown }>(item.trigger_evidence ?? null) ?? {}) } as { phase_plan?: string; generation?: number; evidence?: unknown; stale?: unknown };
  if (typeof s.phase_plan !== 'string') return null;
  // A subject made before the generation was recorded (slice 31's spec
  // change) names the plan's generation of its creation: its first.
  let generation = s.generation;
  if (typeof generation !== 'number') generation = (db.prepare('SELECT "generation" FROM "phase_plans" WHERE "id" = ?').get(s.phase_plan) as { generation: number } | undefined)?.generation ?? 1;
  return { phase_plan: s.phase_plan, generation, trigger: { source: item.trigger_source, id: item.trigger_id, generation: item.trigger_generation }, evidence: s.evidence ?? null, stale: s.stale ?? null };
}

interface StageRow {
  id: string;
  number: number;
  status: string;
  implements: string;
  depends_on: string;
  execution_inputs_digest: string | null;
  work_item: string | null;
  cancelled_at: string | null;
  conformance: number;
}

const IDLE: readonly string[] = ['eligible', 'held', 'parked', 'awaiting_decision'];
const RUNNING: readonly string[] = ['claimed', 'executing', 'integrating'];

function workStatus(db: Db, id: string | null): string | null {
  if (!id) return null;
  return (db.prepare('SELECT "status" FROM "work_items" WHERE "id" = ?').get(id) as { status: string } | undefined)?.status ?? null;
}

const stagesOf = (db: Db, plan: string): StageRow[] => db.prepare('SELECT * FROM "stages" WHERE "phase_plan" = ? AND "cancelled_at" IS NULL ORDER BY "number"').all(plan) as StageRow[];

// Kept: `integrated` or `verified`, its work neither parked nor waiting on
// a decision (A.5: integrated → parked closes the stage; a parked stage is
// superseded, its integration history).
function isKept(db: Db, s: StageRow): boolean {
  if (s.status !== 'integrated' && s.status !== 'verified') return false;
  const w = workStatus(db, s.work_item);
  return w !== 'parked' && w !== 'awaiting_decision';
}

// The kept stages of a plan, for the check (BundleBaseline.kept): numbers,
// digests and the requirement keys they implement.
export function keptOf(db: Db, plan: string): { number: number; digest: string | null; implements: string[] }[] {
  const keyOf = (r: string) => (db.prepare('SELECT "key" FROM "requirements" WHERE "id" = ?').get(r) as { key: string } | undefined)?.key ?? r;
  return stagesOf(db, plan)
    .filter((s) => isKept(db, s))
    .map((s) => ({ number: s.number, digest: s.execution_inputs_digest, implements: (parseJson<string[]>(s.implements) ?? []).map(keyOf) }));
}

export interface SwapResult {
  // number → the stage id the new generation holds without a new row.
  carried: Map<number, string>;
  kept: string[];
  retained: string[];
  cancelled: string[];
  superseded: string[];
}

// The swap (B08): the CAS on the named generation, then each stage of the
// replaced generation kept, retained or superseded. `digests` are the new
// plan's stages' execution-inputs digests by number. Returns null when the
// named generation is no longer the active one (the caller refuses
// `plan_generation_stale`).
export function swapGeneration(tx: Tx, args: { project: string; replaces: ReplacementTarget; plan: string; generation: number; digests: Map<number, string | null> }): SwapResult | null {
  const changed = tx.db
    .prepare(`UPDATE "phase_plans" SET "active" = 0, "status" = 'replaced', "replaced_by" = ? WHERE "id" = ? AND "project" = ? AND "active" = 1 AND "status" = 'published' AND "generation" = ? AND "completed_at" IS NULL`)
    .run(args.plan, args.replaces.phase_plan, args.project, args.replaces.generation).changes;
  if (changed !== 1) return null;
  const stages = stagesOf(tx.db, args.replaces.phase_plan);
  const kept = stages.filter((s) => isKept(tx.db, s));
  // Retained: building, its work not idle in a parked or decision state, the
  // digest unchanged, and every stage it depends on carried under its id;
  // to a fixpoint, since a dependency superseded changes its identity.
  let retained = stages.filter((s) => {
    if (s.status !== 'building' || isKept(tx.db, s)) return false;
    const w = workStatus(tx.db, s.work_item);
    if (w === null || w === 'parked' || w === 'awaiting_decision' || w === 'cancelled' || w === 'complete') return false;
    const digest = args.digests.get(s.number);
    return digest !== undefined && digest !== null && digest === s.execution_inputs_digest;
  });
  for (let grew = true; grew; ) {
    grew = false;
    const carried = new Set([...kept, ...retained].map((s) => s.id));
    const next = retained.filter((s) => (parseJson<string[]>(s.depends_on) ?? []).every((d) => carried.has(d)));
    if (next.length !== retained.length) {
      retained = next;
      grew = true;
    }
  }
  const carriedIds = new Set([...kept, ...retained].map((s) => s.id));
  const out: SwapResult = { carried: new Map(), kept: kept.map((s) => s.id), retained: retained.map((s) => s.id), cancelled: [], superseded: [] };
  for (const s of [...kept, ...retained]) {
    tx.db.prepare('UPDATE "stages" SET "phase_plan" = ?, "generation" = ? WHERE "id" = ?').run(args.plan, args.generation, s.id);
    out.carried.set(s.number, s.id);
  }
  // A retained stage's work, if it must be dispatched again, waits on the
  // new generation's authoring readiness.
  for (const s of retained) {
    const w = s.work_item ? getWorkItem(tx, s.work_item) : undefined;
    if (!w) continue;
    const deps = (parseJson<{ milestone?: string; phase_plan?: string }[]>(w.depends_on) ?? []).map((m) => (m.milestone === 'authoring_ready' ? { ...m, phase_plan: args.plan } : m));
    tx.db.prepare('UPDATE "work_items" SET "depends_on" = ? WHERE "id" = ?').run(JSON.stringify(deps), w.id);
  }
  for (const s of stages) {
    if (carriedIds.has(s.id)) continue;
    if (s.status === 'planned') {
      tx.db.prepare(`UPDATE "stages" SET "status" = 'cancelled', "cancelled_at" = ? WHERE "id" = ?`).run(tx.at, s.id);
      out.cancelled.push(s.id);
    } else {
      tx.db.prepare('UPDATE "stages" SET "cancelled_at" = ? WHERE "id" = ?').run(tx.at, s.id);
      out.superseded.push(s.id);
    }
    cancelIdle(tx, s.work_item, { stage: s.id, phase_plan: args.plan, cause: 'plan_replaced' });
  }
  // What else belonged to the replaced generation: its check authoring and
  // its phase verification, if idle (a running one ends as history).
  const own = tx.db
    .prepare(`SELECT "id" FROM "work_items" WHERE "project" = ? AND "kind" IN ('check_authoring', 'phase_verification') AND json_extract("subject", '$.phase_plan') = ?`)
    .all(args.project, args.replaces.phase_plan) as { id: string }[];
  for (const w of own) cancelIdle(tx, w.id, { phase_plan: args.plan, cause: 'plan_replaced' });
  return out;
}

function cancelIdle(tx: Tx, id: string | null, payload: Record<string, unknown>): void {
  if (!id) return;
  const w = getWorkItem(tx, id);
  if (!w || !IDLE.includes(w.status)) return;
  transitionWork(tx, w, 'cancelled', { blocker: null }, payload);
  const open = tx.db.prepare(`SELECT * FROM "decisions" WHERE "subject_type" = 'work_item' AND "subject_id" = ? AND "status" = 'open'`).all(w.id) as DecisionRow[];
  for (const d of open) invalidateDecision(tx, d, `the plan was replaced (${String(payload.phase_plan)})`);
}

// Whether a run's work is a stage the swap superseded while it ran: its
// integration is history and fulfils no replacement work (D6 §5.7).
export function supersededWhileRunning(db: Db, stage: string | null | undefined): boolean {
  if (!stage) return false;
  const s = db.prepare('SELECT "cancelled_at" FROM "stages" WHERE "id" = ?').get(stage) as { cancelled_at: string | null } | undefined;
  return s !== undefined && s.cancelled_at !== null;
}

// An early trigger's `replan` (D6 §5.7): against the open plan, naming its
// active generation, with the trigger's evidence and what it made stale.
// With no plan open the replan is §5.6's next plan, the evidence still on
// it. Repeated triggers of one identity take the next generation.
export function requestEarlyReplan(tx: Tx, args: { project: string; source: EarlyTrigger; id: string; evidence: unknown; stale: unknown; label?: Record<string, unknown> }): string {
  const open = activePlan(tx.db, args.project);
  const last = tx.db.prepare('SELECT MAX("trigger_generation") AS g FROM "work_items" WHERE "project" = ? AND "trigger_source" = ? AND "trigger_id" = ?').get(args.project, args.source, args.id) as { g: number | null };
  const trigger_evidence = { ...(open ? { phase_plan: open.id, generation: open.generation } : {}), evidence: args.evidence, stale: args.stale };
  return observeTrigger(
    tx,
    { project: args.project, kind: 'replan', trigger_source: args.source, trigger_id: args.id, trigger_generation: (last.g ?? 0) + 1, subject: open ? { phase_plan: open.id } : {}, trigger_evidence, chain: 0 },
    args.label ?? {},
  ).work_item.id;
}

// What a stage's work, parked or waiting on a decision, makes stale when
// the owner answers `replan` (D6 §5.7: "the blocker's evidence"): its stage
// and the checks and findings its blocker names.
export function blockerStale(tx: Tx, item: WorkRow): { stages: number[]; checks: string[]; findings: string[]; tasks: string[] } {
  const stage = parseJson<{ stage?: string }>(item.subject)?.stage ?? null;
  const row = stage ? (tx.db.prepare('SELECT "number", "tasks" FROM "stages" WHERE "id" = ?').get(stage) as { number: number; tasks: string } | undefined) : undefined;
  const b = parseJson<{ checks?: string[]; findings?: string[] }>(item.blocker) ?? {};
  return { stages: row ? [row.number] : [], tasks: row ? (parseJson<string[]>(row.tasks) ?? []) : [], checks: b.checks ?? [], findings: b.findings ?? [] };
}

export const RUNNING_STATUSES = RUNNING;

// Whether a stage's blocker offers `replan` (D6 §5.7, A.2 BlockerOption):
// the item is the `stage_build` of a stage of a published plan (the
// authorized finalizer's, never a fixture's or an Architect integration's)
// that is the active generation, in a project with an approved roadmap to
// replan against. A plan installed with no roadmap has no phase for an
// Architect to replace, as a spec change before any roadmap touches none
// (spec/change.ts).
export function replanOffered(db: Db, item: Pick<WorkRow, 'kind' | 'subject' | 'project'>): boolean {
  if (item.kind !== 'stage_build') return false;
  const stage = parseJson<{ stage?: string }>(item.subject)?.stage;
  if (!stage) return false;
  const p = db
    .prepare(`SELECT p."id" FROM "stages" s JOIN "phase_plans" p ON p."id" = s."phase_plan" WHERE s."id" = ? AND s."cancelled_at" IS NULL AND p."active" = 1 AND p."status" = 'published' AND p."bundle" IS NOT NULL`)
    .get(stage) as { id: string } | undefined;
  if (!p) return false;
  return db.prepare('SELECT 1 FROM "roadmap_revisions" WHERE "project" = ? LIMIT 1').get(item.project) !== undefined;
}

export const REPLAN_OPTION = (item: { id: string }) => ({
  key: 'replan',
  label: 'Replan',
  consequence: "The Architect replans the open phase with this blocker's evidence; the replacement keeps what is integrated or verified and cancels what is not built. The item waits for it.",
  effect: { work_item: item.id, register: 'replan' },
});

// The owner's `replan` (D6 §5.7): an early replan from the blocker's
// evidence, recorded on the item, whose stage is parked (its stage-code
// milestone closed for later dispatch, D6 §6.6) until the replacement
// supersedes or keeps it. The item keeps its status; its question no longer
// stands.
export function answerReplan(tx: Tx, item: WorkRow, decision: string, source: 'blocker_replan' | 'objection_upheld', evidence: Record<string, unknown>): string {
  const stale = blockerStale(tx, item);
  const replan = requestEarlyReplan(tx, { project: item.project, source, id: item.id, evidence: { work_item: item.id, decision, blocker: parseJson<unknown>(item.blocker), ...evidence }, stale, label: { decision } });
  const blocker = parseJson<Record<string, unknown>>(item.blocker) ?? {};
  tx.db.prepare('UPDATE "work_items" SET "blocker" = ? WHERE "id" = ?').run(JSON.stringify({ ...blocker, decision: null, replan }), item.id);
  const stage = parseJson<{ stage?: string }>(item.subject)?.stage;
  if (stage) tx.db.prepare('UPDATE "stages" SET "parked_at" = COALESCE("parked_at", ?) WHERE "id" = ?').run(tx.at, stage);
  return replan;
}
