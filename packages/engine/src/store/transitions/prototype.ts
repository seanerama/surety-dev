// Rapid prototype to Alpha, slice E1 (the owner's rulings R4, R7, R9 of
// 2026-10-28; migration 0044): the prototype iteration, the durable identity
// to which a prototype's runs, usage and deployment are attributed through
// stable relationships recorded when each happens, never through time
// windows; and the Alpha it reached kept apart, as history, from whether
// that Alpha is available now.

import { PROTOTYPE_LIMIT_KEYS } from '../../config/schema.js';
import type { Policy } from '../../config/project-policy.js';
import type { Tx } from './tx.js';

type Db = Tx['db'];

export const ITERATION_STATUSES = ['preparing', 'awaiting_brief_approval', 'building', 'awaiting_owner', 'alpha_ready', 'failed', 'stopped', 'limit_reached', 'discarded'] as const;
export type IterationStatus = (typeof ITERATION_STATUSES)[number];
// An open iteration is one whose work is not over: a run dispatched while
// it is open is the iteration's.
export const OPEN_ITERATION_STATUSES: readonly IterationStatus[] = ['preparing', 'awaiting_brief_approval', 'building', 'awaiting_owner'];

// The five limit keys of a policy, as the iteration snapshots them (R4).
export function limitsOf(policy: Policy): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of PROTOTYPE_LIMIT_KEYS) out[key] = policy[key] as number;
  return out;
}

// A new iteration of a rapid_prototype project, `preparing`, its seq the
// project's next, its limits the effective policy's now.
export function createIteration(tx: Tx, args: { project: string; limits: Record<string, number>; predecessor?: string | null }): string {
  const id = tx.newId('it_');
  const { n } = tx.db.prepare('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "prototype_iterations" WHERE "project" = ?').get(args.project) as { n: number };
  tx.db
    .prepare(
      `INSERT INTO "prototype_iterations" ("id", "created_at", "project", "seq", "predecessor", "mode", "status", "limits_json")
       VALUES (?, ?, ?, ?, ?, 'rapid_prototype', 'preparing', ?)`,
    )
    .run(id, tx.at, args.project, n, args.predecessor ?? null, JSON.stringify(args.limits));
  tx.emit('prototype.iteration_created', { project: args.project, iteration: id }, { seq: n, predecessor: args.predecessor ?? null, limits: args.limits });
  return id;
}

// The project's current iteration (its highest seq), whatever its status;
// null for a project that has none (every planned project).
export function currentIteration(db: Db, project: string): { id: string; status: IterationStatus } | null {
  return (db.prepare('SELECT "id", "status" FROM "prototype_iterations" WHERE "project" = ? ORDER BY "seq" DESC LIMIT 1').get(project) as { id: string; status: IterationStatus } | undefined) ?? null;
}

// The iteration a run dispatched now is attributed to: the project's
// current iteration while it is open, else none. Called by the two places
// that create a run (runs.ts claimDispatch; sessions/session.ts), in the
// transaction that creates it, so the attribution is fixed once, when the
// run exists.
export function iterationForDispatch(db: Db, project: string): string | null {
  const it = currentIteration(db, project);
  return it !== null && OPEN_ITERATION_STATUSES.includes(it.status) ? it.id : null;
}

// alpha_complete satisfied for a candidate of a rapid_prototype project
// (deploy.ts afterCompletion): the iteration open now records the candidate,
// the deployment request the operation served, when Alpha was reached, and
// its owner-facing outcome `alpha_ready`. History: kept as recorded whatever
// later happens to the deployment (a teardown makes `alpha.current` null in
// the read, never this).
export function recordIterationAlpha(tx: Tx, args: { project: string; candidate: string; request: string | null; operation: string }): void {
  const id = iterationForDispatch(tx.db, args.project);
  if (id === null) return;
  tx.db
    .prepare(
      `UPDATE "prototype_iterations" SET "status" = 'alpha_ready', "candidate" = ?, "deployment_request" = ?, "alpha_at" = ?, "ended_at" = ?,
         "outcome_reason" = 'alpha_complete', "next_step" = 'open_alpha' WHERE "id" = ?`,
    )
    .run(args.candidate, args.request, tx.at, tx.at, id);
  tx.emit('prototype.iteration_alpha_ready', { project: args.project, iteration: id }, { candidate: args.candidate, deployment_request: args.request, operation: args.operation });
}

// A finalized teardown of an environment of a rapid_prototype project
// (deploy.ts finalizeDeploy): each candidate whose Alpha deployment request
// to that environment was deployed, and which is still `alpha_deployed`, is
// set back to `developing`, for nothing it deployed runs there now (ENGINE
// §6: the label was never reset). Scoped to the environment's deployments;
// a planned project's candidates are not changed (a design decision for the
// owner, reported with slice E1). The iteration's `alpha_at` is unchanged.
export function withdrawAlpha(tx: Tx, args: { project: string; environment: string; operation: string }): string[] {
  const mode = (tx.db.prepare('SELECT "mode" FROM "projects" WHERE "id" = ?').get(args.project) as { mode: string } | undefined)?.mode;
  if (mode !== 'rapid_prototype') return [];
  const rows = tx.db
    .prepare(
      `SELECT DISTINCT c."id" FROM "candidates" c JOIN "deployment_requests" d ON d."candidate" = c."id"
       WHERE c."project" = ? AND c."progress" = 'alpha_deployed' AND d."environment" = ? AND d."outcome" = 'deployed' ORDER BY c."seq"`,
    )
    .all(args.project, args.environment) as { id: string }[];
  for (const { id } of rows) {
    tx.db.prepare(`UPDATE "candidates" SET "progress" = 'developing' WHERE "id" = ? AND "progress" = 'alpha_deployed'`).run(id);
    tx.emit('candidate.alpha_withdrawn', { project: args.project, candidate: id }, { from: 'alpha_deployed', to: 'developing', environment: args.environment, operation: args.operation });
  }
  return rows.map((r) => r.id);
}
