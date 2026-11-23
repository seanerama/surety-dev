// Rapid prototype to Alpha, slice E4 (the owner's rulings R7 and R8 of
// 2026-10-28; migration 0046): Iterate.
//
//   POST /v1/projects/:p/iterations/:i/iterate   {change?: "<the owner's short change request>"}
//
// On the project's current iteration once it has ended (alpha_ready,
// failed, stopped, limit_reached or discarded), a new iteration is created
// with seq + 1 and `predecessor` = i, `preparing`, its limits snapshotted from
// the policy in force now, and the owner is asked at once to authorize its
// brief preparation (prototype/brief.ts PROTOTYPE_PREPARATION_APPROVAL, whose
// question names the iteration it continues and the change). Its preparation
// reads the latest approved brief of its predecessors and the change, and
// its brief, approved, is a new spec revision.
//
// The predecessor is history: its receipt, runs, ledger rows, Alpha outcome
// and alpha_at are not touched, and its Alpha stays deployed until the new
// iteration's own deployment replaces it (Discard's rules protect it; a
// predecessor's candidate never satisfies the new iteration's Alpha:
// store/transitions/prototype.ts recordIterationAlpha).
//
// What the predecessor left unfinished is not carried into the new
// iteration: every work item of the project not complete or cancelled was
// registered while an earlier iteration was the project's current one, so
// it is cancelled (cause `iterated`), and the owner's open questions about
// that work, the predecessor's runs and the predecessor itself are
// invalidated; otherwise the next dispatch would attribute that work to the
// new iteration. Iterate is refused while a one-shot run of the project is
// under way or a deployment or teardown of its environments is in flight
// (wait, or Stop the iteration first).
//
// The predecessor's open plan is closed with its work (the defect observed
// on 2026-11-23: an iteration that ended limit_reached, stopped or failed
// left its phase plan `published` and active, and the new iteration's first
// plan, checked and passed, was refused `plan_generation_stale` by D6 §5.2's
// one-open-plan rule, leaving it `building` with nothing dispatchable). Not
// through §5.7's early replacement: that swap keeps a predecessor's
// `integrated` stages, whose work Iterate has just cancelled, so no stage
// depending on them could ever dispatch (their stage-code milestone needs
// the work not cancelled, store/transitions/runs.ts), and they would count
// toward the prototype's two stages (R1, S4) while carrying no work of the
// new brief. The plan becomes `replaced`, inactive, with no `replaced_by`
// (no later generation inherits its stages); each active stage of it is
// ended as the swap ends a superseded one: `planned` or `building` (no run
// can be under way: Iterate is refused then) `cancelled` with
// `cancelled_at`, an integrated or verified one keeping its status and its
// integration as history with `cancelled_at` (its code stays on the branch,
// and its modules in the phase scope: evidence.ts). Its record is on the
// plan's `replacement`: {closed_by: 'iterated', iteration, successor,
// cancelled, superseded}. A completed plan is history already and is not
// touched. The new iteration's first plan is then the project's next plan,
// published under the prototype policy as any first plan.

import { activeStages } from '../plan/active.js';
import { Refusal } from '../refusal.js';
import { type DecisionRow, invalidateDecision } from '../store/transitions/decisions.js';
import type { CommandResult } from '../store/transitions/control.js';
import { createIteration, currentIteration, limitsOf } from '../store/transitions/prototype.js';
import { projectPolicy } from '../store/transitions/settings.js';
import type { Tx } from '../store/transitions/tx.js';
import { type WorkRow, transitionWork } from '../store/transitions/work.js';

// The statuses from which an iteration can be iterated: it has ended.
export const ITERABLE_STATUSES = ['alpha_ready', 'failed', 'stopped', 'limit_reached', 'discarded'] as const;
export const CHANGE_MAX = 4000;

interface IterRow {
  id: string;
  project: string;
  seq: number;
  status: string;
  plan_bundle: string | null;
}

// POST /v1/projects/:p/iterations/:i/iterate.
export function iterate(tx: Tx, args: { project: string; iteration: string; change: string | null }): CommandResult {
  const project = tx.db.prepare('SELECT "id", "mode", "paused" FROM "projects" WHERE "id" = ?').get(args.project) as { id: string; mode: string; paused: number } | undefined;
  if (!project) throw new Refusal(404, 'not_found', `No project "${args.project}" exists here.`, 'Check the project id in the path.', { project: args.project });
  const it = tx.db.prepare('SELECT "id", "project", "seq", "status", "plan_bundle" FROM "prototype_iterations" WHERE "id" = ? AND "project" = ?').get(args.iteration, args.project) as IterRow | undefined;
  if (!it) throw new Refusal(404, 'not_found', `Iteration ${args.iteration} of project ${args.project} does not exist.`, 'Read GET /v1/projects/:p/iterations.', { iteration: args.iteration });
  if (project.mode !== 'rapid_prototype') throw new Refusal(409, 'illegal_transition', `Project ${args.project} is not a rapid prototype.`, 'Only a rapid prototype iterates.', { project: args.project, mode: project.mode });
  const current = currentIteration(tx.db, args.project);
  if (current?.id !== it.id) {
    throw new Refusal(409, 'illegal_transition', `Iteration ${it.seq} is not the project's current iteration.`, 'Iterate from the current iteration (the last of GET /v1/projects/:p/iterations).', { iteration: it.id, current: current?.id ?? null });
  }
  if (!(ITERABLE_STATUSES as readonly string[]).includes(it.status)) {
    throw new Refusal(409, 'illegal_transition', `Iteration ${it.seq} is ${it.status}: an iteration is iterated once it has ended (${ITERABLE_STATUSES.join(', ')}).`, 'Wait for it to end, or Stop or Discard it first.', { iteration: it.id, status: it.status });
  }
  const running = tx.db.prepare(`SELECT "id" FROM "runs" WHERE "project" = ? AND "kind" = 'one_shot' AND "state" <> 'ended' ORDER BY "seq"`).all(args.project) as { id: string }[];
  if (running.length > 0) {
    throw new Refusal(409, 'illegal_transition', `${running.length} run(s) of the project are under way (${running.map((r) => r.id).join(', ')}): their work would be cancelled underneath them.`, 'Wait for them to end, or Stop the iteration, then iterate.', { iteration: it.id, runs: running.map((r) => r.id) });
  }
  const inFlight = tx.db
    .prepare(
      `SELECT o."id", o."kind" FROM "operations" o JOIN "environments" e ON e."id" = json_extract(o."target", '$.environment')
       WHERE e."project" = ? AND o."kind" IN ('deploy', 'teardown') AND o."orchestration_stage" IS NOT NULL AND o."orchestration_stage" <> 'ended' ORDER BY o."seq" LIMIT 1`,
    )
    .get(args.project) as { id: string; kind: string } | undefined;
  if (inFlight) {
    throw new Refusal(409, 'illegal_transition', `A ${inFlight.kind} (operation ${inFlight.id}) of the project's environment is under way: what runs there is not settled.`, 'Wait for it to end, then iterate.', { iteration: it.id, operation: inFlight.id });
  }

  // What the predecessor left unfinished: cancelled, with the owner's open
  // questions about it.
  const items = tx.db.prepare(`SELECT * FROM "work_items" WHERE "project" = ? AND "status" NOT IN ('complete', 'cancelled') ORDER BY "seq"`).all(args.project) as WorkRow[];
  for (const item of items) transitionWork(tx, item, 'cancelled', {}, { cause: 'iterated', iteration: it.id });
  const cancelled = items.map((w) => w.id);
  const runs = (tx.db.prepare('SELECT "id" FROM "runs" WHERE "iteration" = ?').all(it.id) as { id: string }[]).map((r) => r.id);
  const open = tx.db.prepare(`SELECT * FROM "decisions" WHERE "project" = ? AND "status" = 'open' ORDER BY "seq"`).all(args.project) as DecisionRow[];
  const proposalsOfRuns = new Set(
    runs.length === 0 ? [] : (tx.db.prepare(`SELECT "id" FROM "protected_proposals" WHERE "run" IN (${runs.map(() => '?').join(', ')})`).all(...runs) as { id: string }[]).map((p) => p.id),
  );
  const about = (d: DecisionRow): boolean =>
    ((d.subject_type === 'prototype_iteration' || d.subject_type === 'iteration') && d.subject_id === it.id) ||
    (d.subject_type === 'run' && runs.includes(d.subject_id)) ||
    (d.subject_type === 'work_item' && cancelled.includes(d.subject_id)) ||
    (d.subject_type === 'protected_proposal' && proposalsOfRuns.has(d.subject_id)) ||
    (d.subject_type === 'plan_bundle' && it.plan_bundle !== null && d.subject_id === it.plan_bundle);
  const invalidated: string[] = [];
  for (const d of open.filter(about)) {
    invalidateDecision(tx, d, `iteration ${it.seq} was iterated: its work is not carried into iteration ${it.seq + 1}`);
    invalidated.push(d.id);
  }

  const limits = limitsOf(projectPolicy(tx.db, args.project));
  const id = createIteration(tx, { project: args.project, limits, predecessor: it.id, change: args.change });
  const closed = closeOpenPlans(tx, { project: args.project, iteration: it.id, successor: id });
  const made = tx.db.prepare('SELECT "seq", "status", "next_step" FROM "prototype_iterations" WHERE "id" = ?').get(id) as { seq: number; status: string; next_step: string | null };
  const decision = tx.db.prepare(`SELECT "id", "kind", "status", "preview_hash" FROM "decisions" WHERE "kind" = 'prototype_preparation_approval' AND "subject_id" = ? AND "status" = 'open' ORDER BY "seq" DESC LIMIT 1`).get(id) as
    | { id: string; kind: string; status: string; preview_hash: string }
    | undefined;
  tx.emit('prototype.iteration_iterated', { project: args.project, iteration: id }, { predecessor: it.id, predecessor_seq: it.seq, predecessor_status: it.status, seq: made.seq, change: args.change, cancelled_work: cancelled, invalidated_decisions: invalidated, closed_plans: closed, project_paused: project.paused === 1 });
  return {
    status: 201,
    body: {
      iteration: { id, seq: made.seq, status: made.status, predecessor: it.id, change: args.change, limits, next_step: made.next_step },
      predecessor: { id: it.id, seq: it.seq, status: it.status },
      cancelled_work: cancelled,
      invalidated_decisions: invalidated,
      closed_plans: closed,
      project_paused: project.paused === 1,
      decision: decision ?? null,
    },
    effects: [{ kind: 'tick' }],
  };
}

// What Iterate closed of the predecessor's open plan (above).
export interface ClosedPlan {
  phase_plan: string;
  phase: number;
  generation: number;
  cancelled: string[];
  superseded: string[];
}

function closeOpenPlans(tx: Tx, args: { project: string; iteration: string; successor: string }): ClosedPlan[] {
  const plans = tx.db
    .prepare(`SELECT "id", "phase_number", "generation" FROM "phase_plans" WHERE "project" = ? AND "status" = 'published' AND "active" = 1 AND "completed_at" IS NULL ORDER BY rowid`)
    .all(args.project) as { id: string; phase_number: number; generation: number }[];
  const out: ClosedPlan[] = [];
  for (const p of plans) {
    const stages = activeStages<{ id: string; status: string }>(tx.db, p.id);
    const cancelled: string[] = [];
    const superseded: string[] = [];
    for (const s of stages) {
      if (s.status === 'planned' || s.status === 'building') {
        tx.db.prepare(`UPDATE "stages" SET "status" = 'cancelled', "cancelled_at" = ? WHERE "id" = ?`).run(tx.at, s.id);
        cancelled.push(s.id);
      } else {
        tx.db.prepare('UPDATE "stages" SET "cancelled_at" = ? WHERE "id" = ?').run(tx.at, s.id);
        superseded.push(s.id);
      }
    }
    const record = { closed_by: 'iterated', iteration: args.iteration, successor: args.successor, cancelled, superseded };
    tx.db
      .prepare(`UPDATE "phase_plans" SET "active" = 0, "status" = 'replaced', "replacement" = ? WHERE "id" = ? AND "status" = 'published' AND "active" = 1 AND "completed_at" IS NULL`)
      .run(JSON.stringify(record), p.id);
    out.push({ phase_plan: p.id, phase: p.phase_number, generation: p.generation, cancelled, superseded });
  }
  return out;
}

// The change text of a request: absent or null is none; otherwise a
// non-empty string of at most CHANGE_MAX characters, kept as typed.
export function changeOf(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new Refusal(400, 'invalid_value', '"change" must be a string.', 'Send the change request as a string, or leave it out.', { field: 'change' });
  if (v.trim() === '') throw new Refusal(400, 'invalid_value', '"change" is empty.', 'Send the change request, or leave the field out.', { field: 'change' });
  if (v.length > CHANGE_MAX) throw new Refusal(400, 'invalid_value', `"change" has ${v.length} characters; at most ${CHANGE_MAX} are taken.`, 'Send a shorter change request.', { field: 'change', max: CHANGE_MAX });
  return v;
}
