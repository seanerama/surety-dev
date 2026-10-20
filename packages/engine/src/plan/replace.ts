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
// or retained under its identity); a kept stage is carried only while each
// stage it depends on is kept, transitively, and one built on a superseded
// stage is superseded with it and registered fresh from its own inputs
// against the new dependency, unless the replacement lists it (E172 item 7
// S2, Sean's ruling "cascade"); every other stage is superseded: a
// `planned` one `cancelled` with its work, any other `cancelled_at` with
// its idle work cancelled and a running one finishing as history (its late
// integration fulfils no replacement work, finalize.ts). Only the remainder
// is registered. Filing alone triggers nothing.

import { parseJson } from '../store/transitions/common.js';
import { activeStages as activeStagesOf, dependsOnEntries, dependsOnNumbers } from './active.js';
import { type DecisionRow, invalidateDecision } from '../store/transitions/decisions.js';
import type { Tx } from '../store/transitions/tx.js';
import { type WorkRow, getWorkItem, observeTrigger, transitionWork } from '../store/transitions/work.js';
import { raiseQuestion } from '../store/transitions/queue.js';
import type { PlanStageInput } from '../store/transitions/work.js';

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
  // What the check counted of the generation's active stages, by id (the
  // review's S1; countStages): compared again at publication.
  counted?: Record<string, string>;
}

// The project's open plan: published, active, not complete.
export function activePlan(db: Db, project: string): { id: string; phase_number: number; generation: number } | undefined {
  return db.prepare(`SELECT "id", "phase_number", "generation" FROM "phase_plans" WHERE "project" = ? AND "status" = 'published' AND "active" = 1 AND "completed_at" IS NULL ORDER BY rowid DESC LIMIT 1`).get(project) as
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

export { ACTIVE_STAGES, activeStages } from './active.js';
const stagesOf = (db: Db, plan: string): StageRow[] => activeStagesOf<StageRow>(db, plan);

// The work a replacement's trigger is about (D6 §5.7; the review's M4): a
// stage's work parked or waiting on a decision whose owner answered
// `replan`. Only that stage, if integrated, is superseded by the swap, with
// the kept stages built on it (the cascade, keptAndRebuilt).
export function subjectWorkOf(r: { trigger?: { source: string; id: string } | null; evidence?: unknown } | null | undefined): string | null {
  if (!r?.trigger) return null;
  if (r.trigger.source !== 'blocker_replan' && r.trigger.source !== 'objection_upheld') return null;
  const w = (r.evidence as { work_item?: unknown } | null | undefined)?.work_item;
  return typeof w === 'string' ? w : r.trigger.source === 'blocker_replan' ? r.trigger.id : null;
}

// Kept: `integrated` or `verified`, whatever its work's state (parked or
// waiting on a decision included, its open decision standing), unless it is
// the replan trigger's own subject (the review's M4).
function isKept(s: StageRow, subjectWork: string | null): boolean {
  if (s.status !== 'integrated' && s.status !== 'verified') return false;
  return s.work_item === null || s.work_item !== subjectWork;
}

// The cascade (E172 item 7 S2; Sean's ruling of 2026-10-20, "cascade";
// SEAM.md §556): of the stages isKept names, one stays kept only while every
// stage it depends on stays kept, to a fixpoint. The others (`rebuilt`) were
// built on a stage the swap supersedes (the trigger's own subject, or one
// rebuilt itself): the swap supersedes them too, and the replacement
// registers each fresh against its new dependency, from the replacement's
// entry when it lists the number, otherwise from its own inputs as built
// (rebuiltInput), as it already does for a building stage (classifyStages).
// A stage is never `building` once integrated, so a kept stage's dependency
// is itself kept or superseded: the split needs no digests.
function keptAndRebuilt(stages: StageRow[], subjectWork: string | null): { kept: StageRow[]; rebuilt: StageRow[] } {
  const base = stages.filter((s) => isKept(s, subjectWork));
  let kept = base;
  for (let shrank = true; shrank; ) {
    const ids = new Set(kept.map((s) => s.id));
    const next = kept.filter((s) => dependsOnEntries(s.depends_on).every((d) => typeof d === 'string' && ids.has(d)));
    shrank = next.length !== kept.length;
    kept = next;
  }
  const keptIds = new Set(kept.map((s) => s.id));
  return { kept, rebuilt: base.filter((s) => !keptIds.has(s.id)) };
}

// The kept stages of a plan, for the check (BundleBaseline.kept): numbers,
// digests and the requirement keys they implement.
// `validated`: the criteria its validation named when it was built.
// `rebuilt` (the cascade): superseded with its dependency and registered
// fresh, under its number; `depends_on` its dependencies' numbers, which an
// omitted rebuilt stage needs the replacement to hold.
export function keptOf(
  db: Db,
  plan: string,
  subjectWork: string | null = null,
): { number: number; digest: string | null; implements: string[]; validated: string[]; rebuilt?: true; depends_on?: number[] }[] {
  const keyOf = (r: string) => (db.prepare('SELECT "key" FROM "requirements" WHERE "id" = ?').get(r) as { key: string } | undefined)?.key ?? r;
  const stages = stagesOf(db, plan);
  const { rebuilt } = keptAndRebuilt(stages, subjectWork);
  const again = new Set(rebuilt.map((s) => s.id));
  return stages
    .filter((s) => isKept(s, subjectWork))
    .map((s) => ({
      number: s.number,
      digest: s.execution_inputs_digest,
      implements: (parseJson<string[]>(s.implements) ?? []).map(keyOf),
      validated: parseJson<{ criteria?: string[] }>((s as StageRow & { validation?: string | null }).validation ?? null)?.criteria ?? [],
      ...(again.has(s.id) ? { rebuilt: true as const, depends_on: dependsOnNumbers(db, s.depends_on).filter((d): d is number => typeof d === 'number') } : {}),
    }));
}

// A rebuilt stage registered from its own inputs as built (the cascade):
// the row's fields, its dependencies by number (each read back from the id
// it stored; one that resolves to no stage is passed on as stored, so the
// registration refuses it, never drops it).
export function rebuiltInput(db: Db, id: string): PlanStageInput {
  const s = db.prepare('SELECT * FROM "stages" WHERE "id" = ?').get(id) as StageRow & {
    goal: string;
    modules: string | null;
    adrs: string | null;
    tasks: string | null;
    validation: string | null;
    integration_obligations: string | null;
    screens: string | null;
  };
  const screens = parseJson<string[]>(s.screens);
  return {
    number: s.number,
    goal: s.goal,
    implements: parseJson<string[]>(s.implements) ?? [],
    modules: parseJson<string[]>(s.modules) ?? [],
    tasks: parseJson<string[]>(s.tasks) ?? [],
    depends_on: dependsOnNumbers(db, s.depends_on) as number[],
    validation: parseJson<{ criteria: string[]; kinds: string[]; sensitive_areas: string[] }>(s.validation) ?? { criteria: [], kinds: [], sensitive_areas: [] },
    integration_obligations: parseJson<string[]>(s.integration_obligations) ?? [],
    adrs: parseJson<string[]>(s.adrs) ?? [],
    conformance: s.conformance === 1,
    execution_inputs_digest: s.execution_inputs_digest,
    ...(Array.isArray(screens) ? { screens } : {}),
  };
}


export type StageClass = 'kept' | 'retained' | 'superseded' | 'cancelled';

// What the swap does with each active stage of a generation, given the new
// plan's execution-inputs digests by number: kept (and not rebuilt by the
// cascade, which supersedes it); retained (building, its
// run live or due, the digest unchanged, every stage it depends on carried,
// to a fixpoint); otherwise cancelled (no code and no live run) or
// superseded. The check counts it, and publication compares it again
// (the review's S1).
export function classifyStages(db: Db, plan: string, digests: Map<number, string | null>, subjectWork: string | null): Map<string, StageClass> {
  const stages = stagesOf(db, plan);
  const { kept } = keptAndRebuilt(stages, subjectWork);
  let retained = stages.filter((s) => {
    if (s.status !== 'building' || isKept(s, subjectWork)) return false;
    const w = workStatus(db, s.work_item);
    if (w === null || w === 'parked' || w === 'awaiting_decision' || w === 'cancelled' || w === 'complete') return false;
    const digest = digests.get(s.number);
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
  const out = new Map<string, StageClass>();
  for (const s of kept) out.set(s.id, 'kept');
  for (const s of retained) out.set(s.id, 'retained');
  for (const s of stages) {
    if (out.has(s.id)) continue;
    const running = RUNNING.includes(workStatus(db, s.work_item) ?? '');
    out.set(s.id, s.status === 'planned' || (s.status === 'building' && !running) ? 'cancelled' : 'superseded');
  }
  return out;
}

// What a check counts of a generation's active stages, by id (the review's
// S1): what the swap would do with each, and the stage's state then
// (`<class>|<status>|<work status>`).
export function countStages(db: Db, plan: string, digests: Map<number, string | null>, subjectWork: string | null): Record<string, string> {
  const classes = classifyStages(db, plan, digests, subjectWork);
  const out: Record<string, string> = {};
  for (const s of stagesOf(db, plan)) out[s.id] = `${classes.get(s.id) ?? 'superseded'}|${s.status}|${workStatus(db, s.work_item) ?? 'none'}`;
  return out;
}

// The difference between what a check counted and what publication would do
// now that changes what the replacement holds, named; null when none (the
// review's S1). It differs when a stage counted carried (kept or retained)
// is no longer carried, or the reverse, unless it is carried now and the
// replacement lists it unchanged; and when a stage the replacement lists
// under its number, not carried now, has moved since the check (its status
// or its work's), since the swap would drop it for a fresh one.
export function classesDiffer(counted: Record<string, string> | null | undefined, now: Record<string, string>, listed: Map<string, 'same' | 'changed' | 'absent'> = new Map()): string | null {
  if (!counted) return null;
  const carried = (c: string | undefined) => c === 'kept' || c === 'retained';
  const diffs: string[] = [];
  for (const [id, state] of Object.entries(now)) {
    const was = counted[id];
    const [cls] = state.split('|');
    const [wasCls] = (was ?? '').split('|');
    const list = listed.get(id) ?? 'absent';
    if (carried(cls) && list === 'same') continue;
    if (carried(cls) !== carried(wasCls) || (list !== 'absent' && was !== state)) diffs.push(`${id} counted ${was ?? 'absent'}, now ${state}`);
  }
  for (const id of Object.keys(counted)) if (!(id in now) && carried(counted[id]!.split('|')[0])) diffs.push(`${id} counted ${counted[id]}, now not active`);
  return diffs.length === 0 ? null : diffs.join('; ');
}

// How the replacement lists each active stage: under its number with the
// same execution inputs, with others, or not at all.
export function listedSame(db: Db, plan: string, digests: Map<number, string | null>): Map<string, 'same' | 'changed' | 'absent'> {
  return new Map(stagesOf(db, plan).map((s) => [s.id, !digests.has(s.number) ? 'absent' : digests.get(s.number) === s.execution_inputs_digest ? 'same' : 'changed']));
}

export interface SwapResult {
  // number → the stage id the new generation holds without a new row: kept
  // and retained stages stay on their own plan's row, active through the
  // generation chain (activeStages).
  carried: Map<number, string>;
  kept: string[];
  retained: string[];
  cancelled: string[];
  superseded: string[];
  // Of the superseded, the kept stages the cascade rebuilds (E172 item 7
  // S2): registerPlan registers each fresh the replacement does not list.
  rebuilt: string[];
}

// The swap (B08): the CAS on the named generation, then each stage of the
// replaced generation kept, retained or superseded as classifyStages says.
// Returns null when the named generation is no longer the active one (the
// caller refuses `plan_generation_stale`).
export function swapGeneration(tx: Tx, args: { project: string; replaces: ReplacementTarget; plan: string; generation: number; digests: Map<number, string | null>; subjectWork: string | null }): SwapResult | null {
  const classes = classifyStages(tx.db, args.replaces.phase_plan, args.digests, args.subjectWork);
  const rebuilt = keptAndRebuilt(stagesOf(tx.db, args.replaces.phase_plan), args.subjectWork).rebuilt.map((s) => s.id);
  const changed = tx.db
    .prepare(`UPDATE "phase_plans" SET "active" = 0, "status" = 'replaced', "replaced_by" = ? WHERE "id" = ? AND "project" = ? AND "active" = 1 AND "status" = 'published' AND "generation" = ? AND "completed_at" IS NULL`)
    .run(args.plan, args.replaces.phase_plan, args.project, args.replaces.generation).changes;
  if (changed !== 1) return null;
  const stages = stagesOf(tx.db, args.replaces.phase_plan);
  const out: SwapResult = { carried: new Map(), kept: [], retained: [], cancelled: [], superseded: [], rebuilt: rebuilt.filter((id) => classes.get(id) === 'superseded') };
  for (const s of stages) {
    const cls = classes.get(s.id) ?? 'superseded';
    if (cls === 'kept' || cls === 'retained') {
      out.carried.set(s.number, s.id);
      (cls === 'kept' ? out.kept : out.retained).push(s.id);
      // Its work follows the active generation's authoring readiness (the
      // review's S2): a kept stage repaired after the swap is dispatched again.
      const w = s.work_item ? getWorkItem(tx, s.work_item) : undefined;
      if (w) {
        const deps = (parseJson<{ milestone?: string; phase_plan?: string }[]>(w.depends_on) ?? []).map((m) => (m.milestone === 'authoring_ready' ? { ...m, phase_plan: args.plan } : m));
        tx.db.prepare('UPDATE "work_items" SET "depends_on" = ? WHERE "id" = ?').run(JSON.stringify(deps), w.id);
      }
      continue;
    }
    // Superseded: a stage with no code and no live run is `cancelled` with
    // its work; one whose Builder still runs finishes it as history (its
    // status left to the integration); the trigger's own integrated stage,
    // and each the cascade rebuilds, keeps its integration as history. Each
    // has `cancelled_at`.
    if (cls === 'cancelled') {
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
  tx.db.prepare(`UPDATE "work_items" SET "end_cause" = 'plan_replaced' WHERE "id" = ?`).run(w.id);
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
// (A list of what became stale: `stage <n>`, `task:<text>`, `check:<id>`,
// `finding:<id>`; D6 §5.7 "which tasks, assumptions and checks".)
export function blockerStale(tx: Tx, item: WorkRow): string[] {
  const stage = parseJson<{ stage?: string }>(item.subject)?.stage ?? null;
  const row = stage ? (tx.db.prepare('SELECT "number", "tasks" FROM "stages" WHERE "id" = ?').get(stage) as { number: number; tasks: string } | undefined) : undefined;
  const b = parseJson<{ checks?: string[]; findings?: string[] }>(item.blocker) ?? {};
  return [
    ...(row ? [`stage ${row.number}`, ...(parseJson<string[]>(row.tasks) ?? []).map((t) => `task:${t}`)] : []),
    ...(b.checks ?? []).map((c) => `check:${c}`),
    ...(b.findings ?? []).map((f) => `finding:${f}`),
  ];
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
  if (!stage || !stageInActiveSet(db, stage)) return false;
  const own = db.prepare(`SELECT p."bundle" FROM "stages" s JOIN "phase_plans" p ON p."id" = s."phase_plan" WHERE s."id" = ?`).get(stage) as { bundle: string | null } | undefined;
  if (!own || own.bundle === null) return false;
  return db.prepare('SELECT 1 FROM "roadmap_revisions" WHERE "project" = ? LIMIT 1').get(item.project) !== undefined;
}

// Whether a stage is in its phase's active obligation set (D6 §5.7): not
// cancelled or superseded, on a plan that is, or was replaced into, the
// active generation (the review's M1, M3).
export function stageInActiveSet(db: Db, stage: string): boolean {
  const s = db.prepare('SELECT "phase_plan", "cancelled_at" FROM "stages" WHERE "id" = ?').get(stage) as { phase_plan: string; cancelled_at: string | null } | undefined;
  if (!s || s.cancelled_at !== null) return false;
  let plan = db.prepare('SELECT "active", "status", "replaced_by" FROM "phase_plans" WHERE "id" = ?').get(s.phase_plan) as { active: number; status: string; replaced_by: string | null } | undefined;
  for (let hops = 0; plan && plan.status === 'replaced' && plan.replaced_by && hops < 64; hops++) {
    plan = db.prepare('SELECT "active", "status", "replaced_by" FROM "phase_plans" WHERE "id" = ?').get(plan.replaced_by) as typeof plan;
  }
  return plan !== undefined && plan.active === 1 && (plan.status === 'published' || plan.status === 'completed');
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
export function answerReplan(tx: Tx, item: WorkRow, decision: string, source: 'blocker_replan' | 'objection_upheld', evidence: Record<string, unknown>, id: string = item.id): string {
  const stale = blockerStale(tx, item);
  const replan = requestEarlyReplan(tx, { project: item.project, source, id, evidence: { work_item: item.id, decision, blocker: parseJson<unknown>(item.blocker), ...evidence }, stale, label: { decision } });
  const blocker = parseJson<Record<string, unknown>>(item.blocker) ?? {};
  tx.db.prepare('UPDATE "work_items" SET "blocker" = ? WHERE "id" = ?').run(JSON.stringify({ ...blocker, decision: null, replan }), item.id);
  const stage = parseJson<{ stage?: string }>(item.subject)?.stage;
  if (stage) tx.db.prepare('UPDATE "stages" SET "parked_at" = COALESCE("parked_at", ?) WHERE "id" = ?').run(tx.at, stage);
  return replan;
}


// Whether every generation of an early replan's trigger has ended without a
// publication: refused, parked, cancelled or stale, none still running or
// awaiting the owner (the review's M3). Unknown is never "published".
export function replanAbandoned(db: Db, project: string, source: string, id: string): boolean {
  const items = db.prepare('SELECT "id", "status" FROM "work_items" WHERE "project" = ? AND "kind" = \'replan\' AND "trigger_source" = ? AND "trigger_id" = ?').all(project, source, id) as { id: string; status: string }[];
  if (items.length === 0) return false;
  for (const w of items) {
    const bundles = db.prepare(`SELECT b."status" FROM "plan_bundles" b JOIN "runs" r ON r."id" = b."run" WHERE r."work_item" = ?`).all(w.id) as { status: string }[];
    if (bundles.some((b) => b.status === 'published' || b.status === 'proposed')) return false;
    if (!['complete', 'cancelled', 'parked'].includes(w.status)) return false;
  }
  return true;
}

// Each tick, before dispatch: what an early replacement left behind is
// settled from durable rows (D6 §5.7; the review's M3 and N2).
// - A superseded stage's work that is idle (its run ended without
//   integrating, or it was never run again) is cancelled `superseded`: no
//   orphan eligible or parked item.
// - A stage's blocker answered `replan` whose replan never publishes is
//   raised again for the owner.
// - A Reviewer's plan-targeted `fix` whose replan never publishes is opened
//   again to the owner as a proposed disposition.
export function settleReplacements(tx: Tx, project: string): void {
  const orphans = tx.db
    .prepare(
      `SELECT w."id" FROM "work_items" w JOIN "stages" s ON s."id" = json_extract(w."subject", '$.stage')
       WHERE w."project" = ? AND w."kind" = 'stage_build' AND s."cancelled_at" IS NOT NULL AND w."status" IN ('eligible', 'held', 'parked', 'awaiting_decision')`,
    )
    .all(project) as { id: string }[];
  for (const o of orphans) {
    const w = getWorkItem(tx, o.id);
    if (!w) continue;
    transitionWork(tx, w, 'cancelled', { blocker: null }, { cause: 'superseded' });
    tx.db.prepare(`UPDATE "work_items" SET "end_cause" = 'superseded' WHERE "id" = ?`).run(w.id);
    for (const d of tx.db.prepare(`SELECT * FROM "decisions" WHERE "subject_type" = 'work_item' AND "subject_id" = ? AND "status" = 'open'`).all(w.id) as DecisionRow[]) {
      invalidateDecision(tx, d, 'the stage was superseded by an early replacement');
    }
  }
  const waiting = tx.db
    .prepare(`SELECT * FROM "work_items" WHERE "project" = ? AND "status" IN ('parked', 'awaiting_decision') AND json_extract("blocker", '$.replan') IS NOT NULL`)
    .all(project) as WorkRow[];
  for (const w of waiting) {
    const blocker = parseJson<Record<string, unknown>>(w.blocker) ?? {};
    const replan = tx.db.prepare('SELECT "trigger_source", "trigger_id" FROM "work_items" WHERE "id" = ?').get(String(blocker.replan)) as { trigger_source: string; trigger_id: string } | undefined;
    if (replan && !replanAbandoned(tx.db, project, replan.trigger_source, replan.trigger_id)) continue;
    const { replan: _gone, ...rest } = blocker;
    void _gone;
    tx.db.prepare('UPDATE "work_items" SET "blocker" = ? WHERE "id" = ?').run(JSON.stringify({ ...rest, decision: null }), w.id);
    raiseQuestion(tx, { project, kind: 'blocker', subjectType: 'work_item', subjectId: w.id });
  }
  const conflicts = tx.db
    .prepare(`SELECT DISTINCT "trigger_id" FROM "work_items" WHERE "project" = ? AND "kind" = 'replan' AND "trigger_source" = 'contract_conflict'`)
    .all(project) as { trigger_id: string }[];
  for (const { trigger_id: finding } of conflicts) {
    const f = tx.db.prepare(`SELECT "id", "status", "disposition", "proposed_disposition" FROM "findings" WHERE "id" = ? AND "project" = ?`).get(finding, project) as
      | { id: string; status: string; disposition: string | null; proposed_disposition: string | null }
      | undefined;
    if (!f || f.status !== 'dispositioned' || f.disposition !== 'fix') continue;
    if (!replanAbandoned(tx.db, project, 'contract_conflict', finding)) continue;
    const ev = tx.db
      .prepare(`SELECT "trigger_evidence" FROM "work_items" WHERE "project" = ? AND "kind" = 'replan' AND "trigger_source" = 'contract_conflict' AND "trigger_id" = ? ORDER BY "trigger_generation" LIMIT 1`)
      .get(project, finding) as { trigger_evidence: string | null };
    const by = (parseJson<{ evidence?: { run?: string } }>(ev.trigger_evidence)?.evidence?.run as string | undefined) ?? 'engine';
    tx.db
      .prepare(`UPDATE "findings" SET "status" = 'open', "disposition" = NULL, "disposition_authority" = NULL, "disposition_by" = NULL, "disposition_at" = NULL, "disposition_seq" = NULL, "proposed_disposition" = ? WHERE "id" = ?`)
      .run(JSON.stringify({ disposition: 'fix', linked_issue: null, defer_target: null, run: by }), f.id);
    raiseQuestion(tx, { project, kind: 'finding_disposition', subjectType: 'finding', subjectId: f.id });
  }
  restaleSpecChanges(tx, project);
}

// A spec change's replan whose proposal went stale (E171 item 5 H4; Sean's
// ruling of 2026-10-19; SEAM.md §554): a competing replacement published,
// or the specification, architecture or roadmap moved, while the plan of
// its phase is still open. Every generation of the trigger ended without a
// publication and the latest completed with its last proposal `stale`: the
// spec change is registered again as the next generation of its trigger,
// against the active generation (as requestEarlyReplan takes it), carrying
// the original evidence and stale list; it routes normally (the owner's
// `plan_approval` included) and holds completion while pending
// (pendingReplacement). Once per active generation: a second staleness
// against the same active generation registers the next generation parked
// with a blocker for the owner (retry or cancel; a cancel holds nothing).
// The review's S1 re-raise (nextReplanGeneration, the stages changed) is
// not this one and does not count. The cause is recorded in
// `trigger_evidence.restaled: {why, from_work_item, bundle}`, beside the
// original `stale` list, which it never overwrites.
export const RESTALE_PARK_REASON = 'replan_restale_max';

function restaleSpecChanges(tx: Tx, project: string): void {
  const open = activePlan(tx.db, project);
  if (!open) return;
  const triggers = tx.db.prepare(`SELECT DISTINCT "trigger_id" FROM "work_items" WHERE "project" = ? AND "kind" = 'replan' AND "trigger_source" = 'spec_change'`).all(project) as { trigger_id: string }[];
  for (const { trigger_id } of triggers) {
    if (!replanAbandoned(tx.db, project, 'spec_change', trigger_id)) continue;
    const items = tx.db
      .prepare(`SELECT * FROM "work_items" WHERE "project" = ? AND "kind" = 'replan' AND "trigger_source" = 'spec_change' AND "trigger_id" = ? ORDER BY "trigger_generation"`)
      .all(project, trigger_id) as (WorkRow & { trigger_evidence: string | null })[];
    const latest = items[items.length - 1];
    if (!latest || latest.status !== 'complete') continue;
    const bundle = tx.db
      .prepare(`SELECT b."id", b."status", b."stale_reason" FROM "plan_bundles" b JOIN "runs" r ON r."id" = b."run" WHERE r."work_item" = ? ORDER BY b.rowid DESC LIMIT 1`)
      .get(latest.id) as { id: string; status: string; stale_reason: string | null } | undefined;
    if (!bundle || bundle.status !== 'stale') continue;
    // The plan still open: the active generation is of the phase the stale
    // replan replaced (a phase since completed is planned by §5.6's replan).
    const target = replacementOf(tx.db, latest);
    if (!target) continue;
    const phase = (tx.db.prepare('SELECT "phase_number" FROM "phase_plans" WHERE "id" = ?').get(target.phase_plan) as { phase_number: number } | undefined)?.phase_number;
    if (phase !== open.phase_number) continue;
    const prior = parseJson<Record<string, unknown>>(latest.trigger_evidence ?? null) ?? {};
    const restaled = { why: bundle.stale_reason ?? 'the proposal is stale', from_work_item: latest.id, bundle: bundle.id };
    // The cap: one automatic re-raise against this active generation.
    const capped = items.some((w) => {
      const ev = parseJson<{ restaled?: unknown; phase_plan?: string; generation?: number }>(w.trigger_evidence ?? null);
      return ev?.restaled !== undefined && ev.phase_plan === open.id && ev.generation === open.generation;
    });
    const trigger_evidence = { ...prior, phase_plan: open.id, generation: open.generation, from_work_item: latest.id, restaled };
    const subject = { ...(parseJson<Record<string, unknown>>(latest.subject) ?? {}), phase_plan: open.id };
    const made = observeTrigger(
      tx,
      { project, kind: 'replan', trigger_source: 'spec_change', trigger_id, trigger_generation: latest.trigger_generation + 1, subject, trigger_evidence, chain: 0 },
      { restaled: { from_work_item: latest.id, bundle: bundle.id }, ...(capped ? { parked: RESTALE_PARK_REASON } : {}) },
    );
    if (!capped || !made.created) continue;
    // Parked at registration (the table's park_at_registration, replan only;
    // E172): the owner retries it against the active generation or cancels
    // it, which holds nothing.
    const item = getWorkItem(tx, made.work_item.id)!;
    const blocker = JSON.stringify({ reason: RESTALE_PARK_REASON, raised_at: tx.at, decision: null });
    transitionWork(tx, item, 'parked', { blocker }, { reason: RESTALE_PARK_REASON, restaled });
    raiseQuestion(tx, { project, kind: 'blocker', subjectType: 'work_item', subjectId: item.id });
  }
}

// What holds an open plan generation's completion (the driver's ruling on
// the M442 (c) intermittent, under Sean's delegation; to be recorded as an
// erratum): a replacement of that generation, or of any generation of its
// phase it replaced (transitively), still pending. Pending: its
// `replan` item not yet ended (eligible, held, claimed, executing,
// integrating, awaiting a decision, or parked with its blocker for the
// owner, E162), or a proposal it made still `proposed` (awaiting the
// owner's approval or its publication). A replacement retired (its item
// cancelled, the owner's `cancel` on its blocker included), refused with no
// further generation, or published (its item complete, its proposal
// published) holds nothing. The first pending one, by seq, with the open
// question that accounts for it, if any.
export interface PendingReplacement {
  work_item: string;
  status: string;
  trigger: { source: string; id: string; generation: number };
  bundle: string | null;
  question: string | null;
}

export function pendingReplacement(db: Db, project: string, plan: { id: string; generation: number }): PendingReplacement | null {
  const items = db
    .prepare(
      `SELECT "id", "status", "trigger_source", "trigger_id", "trigger_generation", "subject", "trigger_evidence" FROM "work_items"
       WHERE "project" = ? AND "kind" = 'replan' AND "trigger_source" IN (SELECT value FROM json_each(?)) ORDER BY "seq"`,
    )
    .all(project, JSON.stringify(EARLY_TRIGGERS)) as { id: string; status: string; trigger_source: string; trigger_id: string; trigger_generation: number; subject: string; trigger_evidence: string | null }[];
  // The open generation and every generation of its phase it replaced,
  // transitively (the driver's ruling on the Reviewer's should-fix 1): a
  // replan aimed at an earlier generation is still pending against the
  // phase until it ends, whatever the compare-and-swap later does with it.
  const chain = new Map(
    (
      db
        .prepare(`WITH RECURSIVE "gen"("id") AS (SELECT ? UNION SELECT p."id" FROM "phase_plans" p JOIN "gen" g ON p."replaced_by" = g."id") SELECT p."id", p."generation" FROM "phase_plans" p JOIN "gen" g ON p."id" = g."id"`)
        .all(plan.id) as { id: string; generation: number }[]
    ).map((r) => [r.id, r.generation]),
  );
  chain.set(plan.id, plan.generation);
  for (const w of items) {
    const target = replacementOf(db, w);
    if (!target || chain.get(target.phase_plan) !== target.generation) continue;
    const proposed = db
      .prepare(`SELECT b."id" FROM "plan_bundles" b JOIN "runs" r ON r."id" = b."run" WHERE r."work_item" = ? AND b."status" = 'proposed' ORDER BY b.rowid DESC LIMIT 1`)
      .get(w.id) as { id: string } | undefined;
    if (!proposed && (w.status === 'complete' || w.status === 'cancelled')) continue;
    const question = proposed
      ? ((db.prepare(`SELECT "id" FROM "decisions" WHERE "kind" IN ('plan_approval', 'architecture_approval') AND "scope" = ? AND "status" = 'open' ORDER BY rowid LIMIT 1`).get(proposed.id) as { id: string } | undefined)?.id ?? null)
      : ((db.prepare(`SELECT "id" FROM "decisions" WHERE "subject_type" = 'work_item' AND "subject_id" = ? AND "status" = 'open' ORDER BY rowid LIMIT 1`).get(w.id) as { id: string } | undefined)?.id ?? null);
    return { work_item: w.id, status: w.status, trigger: { source: w.trigger_source, id: w.trigger_id, generation: w.trigger_generation }, bundle: proposed?.id ?? null, question };
  }
  return null;
}
