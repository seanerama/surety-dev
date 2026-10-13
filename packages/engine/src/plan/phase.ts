// Phase verification and completion (D6 §5.6, §5.8; K5; B06; F §3.10.4;
// SEAM.md §352): one step at every tick, from durable state, for the
// project's open plan once its authoring is ready.
//
// - At T1, with every stage `integrated`, the engine nominates the
//   integration head once (`engine_cadence`); at T2 and T3 the stages
//   nominate per integration and the phase waits for every stage `verified`.
// - On the phase's candidate (T1: the one it nominated; T2, T3: the newest),
//   the phase scope's checks are registered (the phase-only checks and the
//   regression set; trigger (`phase`, <plan>, <generation>)) and run.
// - With them recorded, the `phase` gate is evaluated (the main thread reads
//   its facts first, scheduler/tick.ts). At T2 and T3, `phase_verification`
//   work asks a Verifier for the phase sign-off, bound to the candidate's
//   acceptance hash, the protected version, the spec revision and the
//   plan's generation; at T1 none is needed.
// - Satisfied (and signed off where needed): `completed_at`,
//   `completion_binding`, every stage `verified`, `baseline.phase_complete`
//   and `phase.completion_bound`, once for the binding; and one `replan`
//   from (`phase_complete`, <plan>, 1) when the roadmap has a next phase.
// Phase completion establishes nothing about deployment.

import { alphaBarrier, conformanceNominationDue, conformancePhaseComplete } from '../adopt/conformance.js';
import { isAdopted } from '../adopt/records.js';
import { parseJson } from '../store/transitions/common.js';
import { type CandidateRow, type CheckRow, TIER_RANK, contentHash, getCandidate, markStale, requiredSet } from '../store/transitions/evidence.js';
import { coverageMissing } from '../checks/scope.js';
import type { ScopeObligation } from './check.js';
import { activeStages } from './replace.js';
import { registerExecutions } from '../store/transitions/checks.js';
import { effectiveVersion } from '../store/transitions/protected.js';
import { integrationRef, registryRow, projectRepoRow } from '../store/transitions/repo.js';
import type { Tx } from '../store/transitions/tx.js';
import { getWorkItem, observeTrigger, transitionWork } from '../store/transitions/work.js';

type Db = Tx['db'];

interface PlanRow {
  id: string;
  project: string;
  phase_number: number;
  generation: number;
  authoring_ready_at: string | null;
  completed_at: string | null;
  verification: string | null;
}

export interface PhaseStepResult {
  // The `phase` gate the main thread is to evaluate now.
  evaluate: { candidate: string; phase_plan: string } | null;
  completed: string | null;
}

const NONE: PhaseStepResult = { evaluate: null, completed: null };

function openPlan(db: Db, project: string): PlanRow | undefined {
  return db
    .prepare(`SELECT * FROM "phase_plans" WHERE "project" = ? AND "status" = 'published' AND "active" = 1 AND "authoring_ready_at" IS NOT NULL AND "completed_at" IS NULL ORDER BY "created_at" DESC LIMIT 1`)
    .get(project) as PlanRow | undefined;
}

// The candidate the phase is verified on: at T1 the one its own nomination
// made (once every stage is integrated); at T2 and T3 the newest, once every
// stage is verified. null while the phase is not there yet.
function phaseCandidate(tx: Tx, plan: PlanRow, tier: string): CandidateRow | null {
  const stages = activeStages<{ status: string }>(tx.db, plan.id);
  if (stages.length === 0) return null;
  if (tier === 'T1') {
    if (!stages.every((s) => s.status === 'integrated' || s.status === 'verified')) return null;
    const v = parseJson<{ nominated_revision?: string }>(plan.verification) ?? {};
    if (!v.nominated_revision) {
      // The phase nominates the integration head, once (B06; E11).
      const p = projectRepoRow(tx, plan.project);
      const head = registryRow(tx, plan.project, integrationRef(p.integration_branch))?.expected_oid ?? null;
      if (head === null) return null;
      const due = (tx.db.prepare('SELECT "nomination_due" FROM "projects" WHERE "id" = ?').get(plan.project) as { nomination_due: string | null }).nomination_due;
      const existing = tx.db.prepare('SELECT "id" FROM "candidates" WHERE "project" = ? AND "revision" = ?').get(plan.project, head) as { id: string } | undefined;
      // Another revision's nomination is due: the head is recorded only once
      // something will nominate it (the 31b review's M8), so the phase never
      // waits on a revision nobody nominates; a later tick asks again.
      if (!existing && due !== null && parseJson<{ revision?: string }>(due)?.revision !== head) return null;
      if (due === null && !existing) {
        tx.db.prepare('UPDATE "projects" SET "nomination_due" = ? WHERE "id" = ?').run(JSON.stringify({ revision: head, by: 'engine_cadence', chain: 0 }), plan.project);
      }
      tx.db.prepare('UPDATE "phase_plans" SET "verification" = ? WHERE "id" = ?').run(JSON.stringify({ nominated_revision: head, at: tx.at }), plan.id);
      return null;
    }
    const c = tx.db.prepare('SELECT "id" FROM "candidates" WHERE "project" = ? AND "revision" = ? ORDER BY "seq" DESC LIMIT 1').get(plan.project, v.nominated_revision) as { id: string } | undefined;
    return c ? (getCandidate(tx.db, c.id) ?? null) : null;
  }
  if (!stages.every((s) => s.status === 'verified')) return null;
  const c = tx.db.prepare('SELECT "id" FROM "candidates" WHERE "project" = ? AND "superseded_by" IS NULL ORDER BY "seq" DESC LIMIT 1').get(plan.project) as { id: string } | undefined;
  return c ? (getCandidate(tx.db, c.id) ?? null) : null;
}

export function phaseStep(tx: Tx, args: { project: string }): PhaseStepResult {
  // An adopted project (K11; B11): the conformance stage's nomination once
  // its phase's authoring is ready, and the Alpha barrier before the
  // change-phase replan.
  conformanceNominationDue(tx, args);
  alphaBarrierStep(tx, args.project);
  const plan = openPlan(tx.db, args.project);
  if (!plan) return NONE;
  const tier = (tx.db.prepare('SELECT "tier" FROM "projects" WHERE "id" = ?').get(args.project) as { tier: string }).tier;
  const candidate = phaseCandidate(tx, plan, tier);
  if (!candidate) return NONE;
  const effective = effectiveVersion(tx.db, args.project);
  if (!effective) return NONE;
  // The phase scope's checks on this candidate (D6 §5.8): registered once
  // per candidate, plan and generation. At T1 the phase-only checks are
  // registered at the phase's own nomination, beside the held stages'
  // checks and before their verification (reading 8; B06); the regression
  // set (the checks listing `stage`) once the held stages' gates are
  // evaluated, so that no second registration of a stage's own check stands
  // in front of the result its stage gate reads.
  const set = requiredSet(tx.db, { project: args.project, candidate, kind: 'phase', stage: null, version: effective.id, phasePlan: plan.id });
  const trigger = { source: 'phase' as const, id: plan.id, generation: plan.generation };
  const phaseOnly = set.required.filter((c) => !(parseJson<string[]>(c.gate_kinds) ?? []).includes('stage'));
  registerExecutions(tx, { project: args.project, candidate, checks: phaseOnly, trigger });
  // At T1 the candidate's verification ends and the held stages' gates are
  // evaluated on it before the phase gate (§5.8: "dispatches verification
  // work, and then evaluates the stage gates of the held stages and the
  // phase gate"): satisfied or not, so a shortfall is named on the phase
  // gate too.
  const active = activeStages<{ id: string; work_item: string | null; conformance: number; conformance_state: string | null }>(tx.db, plan.id);
  if (tier === 'T1') {
    const verifying = tx.db
      .prepare(`SELECT 1 FROM "work_items" WHERE "project" = ? AND "kind" = 'verification' AND "trigger_source" = 'nomination' AND "trigger_id" = ? AND "status" NOT IN ('complete', 'cancelled')`)
      .get(args.project, candidate.id);
    if (verifying) return NONE;
    const unevaluated = active.some((st) => {
      if (st.conformance === 1 || !st.work_item) return false;
      const w = tx.db.prepare('SELECT "status" FROM "work_items" WHERE "id" = ?').get(st.work_item) as { status: string } | undefined;
      if (w?.status === 'complete') return false;
      return tx.db.prepare(`SELECT 1 FROM "gate_evaluations" WHERE "candidate" = ? AND "gate_kind" = 'stage' AND "stage" = ? AND "stale" = 0`).get(candidate.id, st.id) === undefined;
    });
    if (unevaluated) return NONE;
  }
  // A conformance stage completes only through its own lifecycle (K11): the
  // phase waits for it conformed, never for the absence of stage-build work.
  const unconformed = active.some((st) => st.conformance === 1 && st.conformance_state !== 'conformed');
  if (unconformed) return NONE;
  registerExecutions(tx, { project: args.project, candidate, checks: set.required, trigger });
  // Every one of them recorded on this candidate before the gate is read.
  const pending = tx.db
    .prepare(
      `SELECT 1 FROM "check_executions" WHERE "candidate" = ? AND "status" NOT IN ('recorded', 'cancelled', 'not_run', 'interrupted', 'quarantined')
       AND "check" IN (SELECT value FROM json_each(?)) LIMIT 1`,
    )
    .get(candidate.id, JSON.stringify(set.required.map((c) => c.id)));
  if (pending) return NONE;
  const evaluation = tx.db
    .prepare(`SELECT "id", "outcome", "stale" FROM "gate_evaluations" WHERE "candidate" = ? AND "gate_kind" = 'phase' AND "phase_plan" = ? AND "plan_generation" = ? ORDER BY rowid DESC LIMIT 1`)
    .get(candidate.id, plan.id, plan.generation) as { id: string; outcome: string; stale: number } | undefined;
  if (!evaluation || evaluation.stale === 1) return { evaluate: { candidate: candidate.id, phase_plan: plan.id }, completed: null };
  const spec = tx.db.prepare('SELECT "id" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(args.project) as { id: string } | undefined;
  const acceptance = contentHash(tx.db, args.project, candidate);
  // At T2 and T3 the Verifier's phase sign-off, bound to this candidate and
  // this generation (B06): a sign-off bound to another counts for nothing.
  if (tier !== 'T1') {
    // Bound to the whole binding as it is now (D6 §5.8; B06; the 31b
    // review's S3): a sign-off made before a spec change, a correction or a
    // new plan generation counts for nothing.
    const signoffs = tx.db.prepare(`SELECT "binding" FROM "signoffs" WHERE "candidate" = ? AND "scope" = 'phase' AND "phase_plan" = ?`).all(candidate.id, plan.id) as { binding: string | null }[];
    const bound = signoffs.some((s) => {
      const b = parseJson<{ plan_generation?: number; acceptance_hash?: string; protected_version?: string; spec_revision?: string | null }>(s.binding);
      return b !== null && b.plan_generation === plan.generation && b.acceptance_hash === acceptance && b.protected_version === effective.id && (b.spec_revision ?? null) === (spec?.id ?? null);
    });
    if (!bound) {
      // One phase_verification at a time per candidate; one whose sign-off
      // no longer binds is followed by the next generation, so a stale
      // sign-off is replaced, never waited on.
      const last = tx.db
        .prepare(`SELECT "status", "trigger_generation" FROM "work_items" WHERE "project" = ? AND "kind" = 'phase_verification' AND "trigger_source" = 'phase' AND "trigger_id" = ? ORDER BY "trigger_generation" DESC LIMIT 1`)
        .get(args.project, candidate.id) as { status: string; trigger_generation: number } | undefined;
      // A Verifier who signed nothing is not asked again by the engine.
      const stale = signoffs.length > 0 && last !== undefined && (last.status === 'complete' || last.status === 'cancelled');
      const generation = !last ? 1 : stale ? last.trigger_generation + 1 : last.trigger_generation;
      // Registered once the phase evaluation is recorded, satisfied or not
      // (§5.8: "when the phase checks have run"; the driver's ruling 3): the
      // Verifier reads the evaluation and the phase's findings.
      observeTrigger(tx, { project: args.project, kind: 'phase_verification', trigger_source: 'phase', trigger_id: candidate.id, trigger_generation: generation, subject: { candidate: candidate.id, phase_plan: plan.id }, chain: 0 }, { plan_generation: plan.generation });
      return NONE;
    }
  }
  if (evaluation.outcome !== 'satisfied') return NONE;
  const binding = { candidate: candidate.id, acceptance_hash: acceptance, protected_version: effective.id, spec_revision: spec?.id ?? null, generation: plan.generation, evaluation: evaluation.id };
  const changed = tx.db
    .prepare(`UPDATE "phase_plans" SET "completed_at" = ?, "completion_binding" = ?, "status" = 'completed' WHERE "id" = ? AND "completed_at" IS NULL`)
    .run(tx.at, JSON.stringify(binding), plan.id).changes;
  if (changed === 0) return NONE;
  for (const st of active) tx.db.prepare(`UPDATE "stages" SET "status" = 'verified' WHERE "id" = ?`).run(st.id);
  // At T1 the held stage work is complete with its stage gates; a stage work
  // still verifying completes with the phase.
  for (const { work_item } of active) {
    if (!work_item) continue;
    const w = getWorkItem(tx, work_item);
    if (w && w.status === 'verifying') transitionWork(tx, w, 'complete', {}, { phase_plan: plan.id, cause: 'phase_complete' });
  }
  tx.emit('phase.completion_bound', { project: args.project, phase_plan: plan.id, candidate: candidate.id }, binding);
  tx.emit('baseline.phase_complete', { project: args.project, phase_plan: plan.id }, { phase: plan.phase_number, generation: plan.generation, candidate: candidate.id, evaluation: evaluation.id });
  // An adopted project's requirements delivered by the completed phase
  // are recorded verified (D6 §8.1 steps 6, 7; SEAM.md §386).
  if (isAdopted(tx.db, args.project)) {
    const delivered = activeStages<{ implements: string }>(tx.db, plan.id);
    for (const s of delivered) for (const key of parseJson<string[]>(s.implements) ?? []) {
      tx.db.prepare(`UPDATE "requirements" SET "status" = 'verified' WHERE "project" = ? AND ("key" = ? OR "id" = ?) AND "status" = 'pending'`).run(args.project, key, key);
    }
  }
  // The Architect's re-entry (D6 §5.6), when the roadmap has a next phase.
  // In an adopted project the conformance phase's replan waits behind the
  // Alpha barrier (B11; alphaBarrierStep).
  if (!(isAdopted(tx.db, args.project) && plan.phase_number === 1)) replanAfter(tx, args.project, plan.id, plan.phase_number);
  markStale(tx, { project: args.project });
  return { evaluate: null, completed: plan.id };
}

// The replan of the phase after `plan`, once, when the roadmap has one.
function replanAfter(tx: Tx, project: string, plan: string, phase: number): string | null {
  const road = tx.db.prepare('SELECT "phases" FROM "roadmap_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(project) as { phases: string } | undefined;
  const phases = parseJson<{ number: number }[]>(road?.phases ?? null) ?? [];
  if (!phases.some((p) => p.number > phase)) return null;
  if (tx.db.prepare(`SELECT 1 FROM "work_items" WHERE "project" = ? AND "kind" = 'replan' AND "trigger_source" = 'phase_complete' AND "trigger_id" = ?`).get(project, plan)) return null;
  return observeTrigger(tx, { project, kind: 'replan', trigger_source: 'phase_complete', trigger_id: plan, trigger_generation: 1, subject: { phase_plan: plan }, chain: 0 }, {}).work_item.id;
}

// The Alpha barrier (D6 §8.1 step 6; B11; D6-R10): the conformance phase of
// an adopted project complete, the change-phase replan is created only once
// `alpha_complete` is satisfied for a candidate whose application source is
// A. Read from durable rows at every tick, so a restart changes nothing.
function alphaBarrierStep(tx: Tx, project: string): void {
  const done = conformancePhaseComplete(tx.db, project);
  if (!done) return;
  const barrier = alphaBarrier(tx.db, project);
  if (!barrier.open) return;
  const replan = replanAfter(tx, project, done.plan, done.phase);
  // Recorded once, when it opens (the slice-32 review's M5).
  if (replan !== null) tx.emit('conformance.alpha_barrier_opened', { project, phase_plan: done.plan }, { candidate: barrier.candidate, replan });
}

// Whether every phase of the current roadmap has a completed plan (the plan
// read's `build.complete`, SEAM.md §352).
export function buildComplete(db: Db, project: string): boolean {
  const road = db.prepare('SELECT "phases" FROM "roadmap_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(project) as { phases: string } | undefined;
  const phases = parseJson<{ number: number }[]>(road?.phases ?? null) ?? [];
  if (phases.length === 0) return false;
  return phases.every((ph) => db.prepare(`SELECT 1 FROM "phase_plans" WHERE "project" = ? AND "phase_number" = ? AND "completed_at" IS NOT NULL`).get(project, ph.number) !== undefined);
}

// ---- the `phase` gate's own reasons (D6 §5.8; A.4; K5; B07) ---------------------------------

// PLAN_REQUIREMENT_UNPLANNED on the gate: a requirement the current roadmap
// assigns to the plan's phase, not withdrawn and not descriptive, that no
// active stage of the plan implements (delivered or not, D3 §4.2 (b)).
export function unplannedRequirements(db: Db, planId: string): string[] {
  const plan = db.prepare('SELECT "project", "phase_number" FROM "phase_plans" WHERE "id" = ?').get(planId) as { project: string; phase_number: number } | undefined;
  if (!plan) return [];
  const implemented = new Set(
    activeStages<{ implements: string }>(db, planId).flatMap((s) => parseJson<string[]>(s.implements) ?? []),
  );
  return (
    db
      .prepare(`SELECT "id", "key" FROM "requirements" WHERE "project" = ? AND "assigned_phase" = ? AND "withdrawn_at" IS NULL AND "status" <> 'descriptive_unverified' ORDER BY "key"`)
      .all(plan.project, plan.phase_number) as { id: string; key: string }[]
  )
    .filter((r) => !implemented.has(r.id) && !implemented.has(r.key))
    .map((r) => `phase ${plan.phase_number}:${r.key}`);
}

// AUTHORING_INCOMPLETE on the gate (B07; D6-P04, D6-W04): the plan's
// recorded planned obligations, scope by scope, against the actual protected
// coverage of the effective version, through D3 §4.3's one primitive: a
// criterion no required acceptance-origin check of that gate kind covers, a
// kind of the scope's tier none supplies, an area no such floor check
// covers; and every unresolved deferred or pending authoring obligation.
// Subjects `stage <n>:<criterion>`, `stage <n>:kind:<k>`, `phase <n>:area:<a>`.
// A plan with no recorded check (a fixture's) has no planned obligations.
export function authoringShortfall(db: Db, planId: string, version: string): string[] {
  const row = db.prepare('SELECT p."project", c."obligations" FROM "phase_plans" p LEFT JOIN "plan_checks" c ON c."id" = p."check" WHERE p."id" = ?').get(planId) as
    | { project: string; obligations: string | null }
    | undefined;
  if (!row) return [];
  const planned = parseJson<ScopeObligation[]>(row.obligations) ?? [];
  const checks = (db.prepare('SELECT * FROM "checks" WHERE "protected_version" = ? AND "required" = 1').all(version) as CheckRow[]).filter((c) => (c.origin ?? 'acceptance') !== 'developer');
  const out: string[] = [];
  for (const o of planned) {
    const kinds = o.scope.kind === 'stage' ? ['stage'] : ['phase', 'stage'];
    const covering = checks.filter((c) => (parseJson<string[]>(c.gate_kinds) ?? []).some((k) => kinds.includes(k)) && (c.tier_floor === null || TIER_RANK[c.tier_floor]! <= TIER_RANK[o.tier]!));
    const missing = coverageMissing(
      { criteria: o.criteria, kinds: o.kinds, areas: o.sensitive_areas },
      {
        criteria: covering.flatMap((c) => parseJson<string[]>(c.criteria ?? null) ?? []),
        kinds: covering.map((c) => c.kind),
        areas: covering.filter((c) => c.kind === 'sensitivity_floor').flatMap((c) => parseJson<string[]>(c.sensitive_areas) ?? []),
      },
    );
    const at = `${o.scope.kind} ${o.scope.number}`;
    out.push(...missing.criteria.map((c) => `${at}:${c}`), ...missing.kinds.map((k) => `${at}:kind:${k}`), ...missing.areas.map((a) => `${at}:area:${a}`));
  }
  const owed = db
    .prepare(`SELECT "criteria" FROM "check_obligations" WHERE "project" = ? AND "resolved_at" IS NULL AND "reason" IN ('deferred_authoring', 'authoring_pending')`)
    .all(row.project) as { criteria: string }[];
  for (const o of owed) out.push(...(parseJson<string[]>(o.criteria) ?? []).map((c) => `deferred:${c}`));
  return [...new Set(out)];
}

// ---- the phase_verification package (D6 §5.8; M429 (a)) -----------------------------------

export interface PhaseVerificationFacts {
  phase_plan: { id: string; phase_number: number; generation: number; status: string };
  candidate: string;
  // The latest `phase` evaluation of this plan generation on the candidate,
  // with its reasons and per-check states; null when none is recorded.
  evaluation: { id: string; outcome: string; reasons: unknown; check_states: unknown; computed_at: string; stale: boolean } | null;
  // The phase's findings: raised since the plan was published, or open.
  findings: Record<string, unknown>[];
}

export function phaseVerificationFacts(db: Db, item: { kind: string; project: string; subject: string }): PhaseVerificationFacts | null {
  if (item.kind !== 'phase_verification') return null;
  const s = parseJson<{ candidate?: string; phase_plan?: string }>(item.subject) ?? {};
  if (!s.candidate || !s.phase_plan) return null;
  const plan = db.prepare('SELECT "id", "phase_number", "generation", "status", "published_at" FROM "phase_plans" WHERE "id" = ?').get(s.phase_plan) as
    | { id: string; phase_number: number; generation: number; status: string; published_at: string | null }
    | undefined;
  if (!plan) return null;
  const ev = db
    .prepare(`SELECT "id", "outcome", "reasons", "check_states", "computed_at", "stale" FROM "gate_evaluations" WHERE "candidate" = ? AND "gate_kind" = 'phase' AND "phase_plan" = ? AND "plan_generation" = ? ORDER BY rowid DESC LIMIT 1`)
    .get(s.candidate, plan.id, plan.generation) as { id: string; outcome: string; reasons: string; check_states: string; computed_at: string; stale: number } | undefined;
  const findings = db
    .prepare(
      `SELECT "id", "seq", "created_at", "scope", "candidate", "category", "effective_severity" AS "severity", "message", "check", "criterion", "sensitive_area", "status", "disposition"
       FROM "findings" WHERE "project" = ? AND ("created_at" >= ? OR "status" IN ('open', 'dispositioned')) ORDER BY "seq"`,
    )
    .all(item.project, plan.published_at ?? '') as Record<string, unknown>[];
  return {
    phase_plan: { id: plan.id, phase_number: plan.phase_number, generation: plan.generation, status: plan.status },
    candidate: s.candidate,
    evaluation: ev ? { id: ev.id, outcome: ev.outcome, reasons: parseJson(ev.reasons), check_states: parseJson(ev.check_states), computed_at: ev.computed_at, stale: ev.stale === 1 } : null,
    findings,
  };
}

// The phase's own T1 nomination (D6 §5.8; reading 8; the driver's ruling on
// M428 (a)): in the nomination's finalizer the phase scope's checks are
// registered on the candidate beside the held stages', before its
// verification work. Any other nomination registers none.
export function registerPhaseAtNomination(tx: Tx, args: { project: string; candidate: string }): void {
  const tier = (tx.db.prepare('SELECT "tier" FROM "projects" WHERE "id" = ?').get(args.project) as { tier: string } | undefined)?.tier;
  if (tier !== 'T1') return;
  const plan = openPlan(tx.db, args.project);
  const candidate = getCandidate(tx.db, args.candidate);
  if (!plan || !candidate) return;
  if (parseJson<{ nominated_revision?: string }>(plan.verification)?.nominated_revision !== candidate.revision) return;
  const effective = effectiveVersion(tx.db, args.project);
  if (!effective) return;
  const set = requiredSet(tx.db, { project: args.project, candidate, kind: 'phase', stage: null, version: effective.id, phasePlan: plan.id });
  // A conformance stage's gate reads its own checks' registrations on this
  // candidate (K11): the regression set, the same checks, follows its
  // conformance, as phaseStep registers it; the phase-only checks now.
  const conformance = activeStages<{ conformance: number }>(tx.db, plan.id).some((st) => st.conformance === 1);
  const checks = conformance ? set.required.filter((c) => !(parseJson<string[]>(c.gate_kinds) ?? []).includes('stage')) : set.required;
  registerExecutions(tx, { project: args.project, candidate, checks, trigger: { source: 'phase', id: plan.id, generation: plan.generation } });
}

// A protected application re-registers what the new version requires (D3
// §2.5, §3.5): on a candidate the phase step has registered its scope on,
// the phase scope's checks too, phase-only ones included, so an execution
// cancelled with the old version is not left without a successor.
export function registerPhaseAtApplication(tx: Tx, args: { project: string; proposal: string; version: string }): void {
  const plan = openPlan(tx.db, args.project);
  if (!plan) return;
  const rows = tx.db
    .prepare(`SELECT DISTINCT x."candidate" FROM "check_executions" x JOIN "candidates" c ON c."id" = x."candidate" WHERE x."project" = ? AND json_extract(x."trigger", '$.source') = 'phase' AND json_extract(x."trigger", '$.id') = ? AND c."superseded_by" IS NULL`)
    .all(args.project, plan.id) as { candidate: string }[];
  for (const r of rows) {
    const candidate = getCandidate(tx.db, r.candidate);
    if (!candidate) continue;
    const set = requiredSet(tx.db, { project: args.project, candidate, kind: 'phase', stage: null, version: args.version, phasePlan: plan.id });
    registerExecutions(tx, { project: args.project, candidate, checks: set.required, trigger: { source: 'protected_application', id: args.proposal, generation: 1 } });
  }
}
