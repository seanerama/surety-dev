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

import { parseJson } from '../store/transitions/common.js';
import { type CandidateRow, contentHash, getCandidate, markStale, requiredSet } from '../store/transitions/evidence.js';
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
  const stages = tx.db.prepare(`SELECT "status" FROM "stages" WHERE "phase_plan" = ? AND "cancelled_at" IS NULL`).all(plan.id) as { status: string }[];
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
  const plan = openPlan(tx.db, args.project);
  if (!plan) return NONE;
  const tier = (tx.db.prepare('SELECT "tier" FROM "projects" WHERE "id" = ?').get(args.project) as { tier: string }).tier;
  const candidate = phaseCandidate(tx, plan, tier);
  if (!candidate) return NONE;
  const effective = effectiveVersion(tx.db, args.project);
  if (!effective) return NONE;
  // At T1 the held stages' gates are evaluated on the candidate first (their
  // verification and stage gates run as for any nomination).
  if (tier === 'T1') {
    const open = tx.db
      .prepare(`SELECT 1 FROM "stages" s JOIN "work_items" w ON w."id" = s."work_item" WHERE s."phase_plan" = ? AND s."cancelled_at" IS NULL AND w."status" <> 'complete'`)
      .get(plan.id);
    if (open) return NONE;
  }
  // The phase scope's checks on this candidate (D6 §5.8): registered once
  // per candidate, plan and generation.
  const set = requiredSet(tx.db, { project: args.project, candidate, kind: 'phase', stage: null, version: effective.id, phasePlan: plan.id });
  registerExecutions(tx, { project: args.project, candidate, checks: set.required, trigger: { source: 'phase', id: plan.id, generation: plan.generation } });
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
  if (evaluation.outcome !== 'satisfied') return NONE;
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
      observeTrigger(tx, { project: args.project, kind: 'phase_verification', trigger_source: 'phase', trigger_id: candidate.id, trigger_generation: generation, subject: { candidate: candidate.id, phase_plan: plan.id }, chain: 0 }, { plan_generation: plan.generation });
      return NONE;
    }
  }
  const binding = { candidate: candidate.id, acceptance_hash: acceptance, protected_version: effective.id, spec_revision: spec?.id ?? null, generation: plan.generation, evaluation: evaluation.id };
  const changed = tx.db
    .prepare(`UPDATE "phase_plans" SET "completed_at" = ?, "completion_binding" = ?, "status" = 'completed' WHERE "id" = ? AND "completed_at" IS NULL`)
    .run(tx.at, JSON.stringify(binding), plan.id).changes;
  if (changed === 0) return NONE;
  tx.db.prepare(`UPDATE "stages" SET "status" = 'verified' WHERE "phase_plan" = ? AND "cancelled_at" IS NULL`).run(plan.id);
  // At T1 the held stage work is complete with its stage gates; a stage work
  // still verifying completes with the phase.
  const items = tx.db.prepare(`SELECT "work_item" FROM "stages" WHERE "phase_plan" = ? AND "work_item" IS NOT NULL`).all(plan.id) as { work_item: string }[];
  for (const { work_item } of items) {
    const w = getWorkItem(tx, work_item);
    if (w && w.status === 'verifying') transitionWork(tx, w, 'complete', {}, { phase_plan: plan.id, cause: 'phase_complete' });
  }
  tx.emit('phase.completion_bound', { project: args.project, phase_plan: plan.id, candidate: candidate.id }, binding);
  tx.emit('baseline.phase_complete', { project: args.project, phase_plan: plan.id }, { phase: plan.phase_number, generation: plan.generation, candidate: candidate.id, evaluation: evaluation.id });
  // The Architect's re-entry (D6 §5.6), when the roadmap has a next phase.
  const road = tx.db.prepare('SELECT "phases" FROM "roadmap_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(args.project) as { phases: string } | undefined;
  const phases = parseJson<{ number: number }[]>(road?.phases ?? null) ?? [];
  if (phases.some((p) => p.number > plan.phase_number)) {
    observeTrigger(tx, { project: args.project, kind: 'replan', trigger_source: 'phase_complete', trigger_id: plan.id, trigger_generation: 1, subject: { phase_plan: plan.id }, chain: 0 }, {});
  }
  markStale(tx, { project: args.project });
  return { evaluate: null, completed: plan.id };
}

// Whether every phase of the current roadmap has a completed plan (the plan
// read's `build.complete`, SEAM.md §352).
export function buildComplete(db: Db, project: string): boolean {
  const road = db.prepare('SELECT "phases" FROM "roadmap_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(project) as { phases: string } | undefined;
  const phases = parseJson<{ number: number }[]>(road?.phases ?? null) ?? [];
  if (phases.length === 0) return false;
  return phases.every((ph) => db.prepare(`SELECT 1 FROM "phase_plans" WHERE "project" = ? AND "phase_number" = ? AND "completed_at" IS NOT NULL`).get(project, ph.number) !== undefined);
}
