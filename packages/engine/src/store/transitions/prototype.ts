// Rapid prototype to Alpha, slice E1 (the owner's rulings R4, R7, R9 of
// 2026-10-28; migration 0044): the prototype iteration, the durable identity
// to which a prototype's runs, usage and deployment are attributed through
// stable relationships recorded when each happens, never through time
// windows; and the Alpha it reached kept apart, as history, from whether
// that Alpha is available now.

import { nowMs } from '../../clock.js';
import { PROTOTYPE_LIMIT_KEYS } from '../../config/schema.js';
import type { Policy } from '../../config/project-policy.js';
import { type LedgerRow, billable, fold, observedSoFar, outstandingReservation, runBudgetOf } from './ledger.js';
import { projectPolicy } from './settings.js';
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

// ---- slice E2: bounded execution (the owner's rulings R4 and R8 of 2026-10-28) ----
//
// The iteration's limits are dispatch limits and an estimated-cost
// threshold, enforced by a check at each dispatch of a run attributed to the
// iteration (runs.ts dispatchBlocker, in the claim transaction; the session
// opening, sessions/session.ts). Soft, never a billing cap (D2 §4.2 forbids
// claiming a hard one): a run already running is not ended by any of them;
// it ends at its own run limit and deadline, through the existing
// termination and accounting machinery, so the overshoot is at most what the
// running runs may still spend under their own limits.

export const ENFORCEMENT = { enforced: true, enforcement: 'dispatch_check', overshoot: 'running runs end at their own limits and deadlines' } as const;

// The statuses of a project's current iteration in which nothing more of the
// project is dispatched: ended by a limit, by Stop or by Discard. Until the
// owner raises a limit (limitsChanged, below) or discards it.
export const HOLDING_STATUSES: readonly IterationStatus[] = ['limit_reached', 'stopped', 'discarded'];

// The blocker a limit gives (final: the iteration is limit_reached, or is
// made so by the transaction that meets it), and the hold while what passes
// the token limit is only the outstanding reservations of runs still under
// way (settling: they may end below their limits; held, `depends_on`, as the
// scheduler's other waits on running work are).
export const PROTOTYPE_LIMIT = 'prototype limit';
export const PROTOTYPE_SETTLING = 'depends on the runs under way of prototype iteration';

const LIMIT_NEXT_STEP = 'raise the limit or discard';
const STOP_NEXT_STEP = 'resume by raising a limit / iterate / discard';
const DISCARD_NEXT_STEP = 'iterate';

interface IterationRowLite {
  id: string;
  project: string;
  seq: number;
  status: IterationStatus;
  limits_json: string;
  approved_at: string | null;
  deployment_request: string | null;
  outcome_reason: string | null;
  next_step: string | null;
}

const iterationById = (db: Db, id: string): IterationRowLite | undefined => db.prepare('SELECT * FROM "prototype_iterations" WHERE "id" = ?').get(id) as IterationRowLite | undefined;
const currentRow = (db: Db, project: string): IterationRowLite | undefined =>
  db.prepare('SELECT * FROM "prototype_iterations" WHERE "project" = ? ORDER BY "seq" DESC LIMIT 1').get(project) as IterationRowLite | undefined;
const limitsOfRow = (it: IterationRowLite): Record<string, number> => {
  try {
    return JSON.parse(it.limits_json) as Record<string, number>;
  } catch {
    return {};
  }
};
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const money = (v: number): number => Math.round(v * 1e9) / 1e9;

// The iteration's account (R4, R9): what its attributed runs' invocations
// have committed of its allowance, as the ledger counts a day at a dispatch
// (ledger.ts daySpend): each charged invocation its billable tokens and its
// unknown allowance in force; each invocation under way what it has
// observed and what it still reserves (outstandingReservation, the ledger's
// one rule); a refused one nothing. The one function both the iteration read
// (`remaining`) and the dispatch check use, so that they cannot disagree.
// A charged invocation whose billable tokens are unknown and which carries
// no allowance makes the committed figure unknown (counted, never 0).
export interface IterationAccount {
  settled_tokens: number;
  unknown_allowance_tokens: number;
  under_way_observed_tokens: number;
  outstanding_reservation_tokens: number;
  committed_tokens: number;
  unknown_billable_invocations: number;
  under_way_invocations: number;
  reported_usd: number | null;
  estimated_usd: number | null;
  unknown_cost_invocations: number;
  repairs_used: number;
}

export function iterationAccount(db: Db, project: string, iteration: string): IterationAccount {
  const receipts = db
    .prepare(`SELECT i."id" FROM "invocation_receipts" i JOIN "runs" r ON r."id" = i."run" WHERE r."iteration" = ? ORDER BY r."seq", i.rowid`)
    .all(iteration) as { id: string }[];
  const a: IterationAccount = {
    settled_tokens: 0,
    unknown_allowance_tokens: 0,
    under_way_observed_tokens: 0,
    outstanding_reservation_tokens: 0,
    committed_tokens: 0,
    unknown_billable_invocations: 0,
    under_way_invocations: 0,
    reported_usd: null,
    estimated_usd: null,
    unknown_cost_invocations: 0,
    repairs_used: 0,
  };
  for (const { id } of receipts) {
    const rows = db.prepare('SELECT * FROM "ledger_rows" WHERE "invocation" = ? ORDER BY rowid').all(id) as LedgerRow[];
    if (rows.some((r) => r.corrects === null)) {
      const acc = fold(rows);
      const b = billable(acc);
      if (b === null && acc.unknown_allowance_tokens === null) a.unknown_billable_invocations += 1;
      a.settled_tokens += b ?? 0;
      a.unknown_allowance_tokens += acc.unknown_allowance_tokens ?? 0;
      if ((acc.cost_status === 'reported' || acc.cost_status === 'measured_zero') && acc.cost_usd !== null) a.reported_usd = (a.reported_usd ?? 0) + acc.cost_usd;
      if (acc.cost_status === 'estimated' && acc.cost_usd !== null) a.estimated_usd = (a.estimated_usd ?? 0) + acc.cost_usd;
      if (acc.cost_status === 'unknown') a.unknown_cost_invocations += 1;
      continue;
    }
    const status = (db.prepare('SELECT "status" FROM "invocation_status_observations" WHERE "invocation" = ? ORDER BY rowid DESC LIMIT 1').get(id) as { status: string } | undefined)?.status;
    // Refused before launch: charged nothing, reserves nothing (runs.ts finishRun).
    if (status === 'refused') continue;
    const so = observedSoFar(db, id);
    a.under_way_invocations += 1;
    a.under_way_observed_tokens += billable(so) ?? 0;
    a.outstanding_reservation_tokens += outstandingReservation(db, id, project, so);
  }
  a.committed_tokens = a.settled_tokens + a.unknown_allowance_tokens + a.under_way_observed_tokens + a.outstanding_reservation_tokens;
  if (a.reported_usd !== null) a.reported_usd = money(a.reported_usd);
  if (a.estimated_usd !== null) a.estimated_usd = money(a.estimated_usd);
  // The engine's own repair counter of the iteration's work items (D1 §4.3).
  a.repairs_used = (
    db
      .prepare(`SELECT COALESCE(SUM(w."repair_attempts"), 0) AS n FROM "work_items" w WHERE w."id" IN (SELECT DISTINCT "work_item" FROM "runs" WHERE "iteration" = ? AND "work_item" IS NOT NULL)`)
      .get(iteration) as { n: number }
  ).n;
  return a;
}

// What a dispatch asks of the iteration: the run's reservation (its run
// limit: `budget_run_billable_tokens`, or a Designer session's own budget,
// ledger.ts runBudgetOf), and whether it is a repair, with the work item's
// repairs so far.
export interface DispatchAsk {
  reservation: number;
  repair: boolean;
  item_repairs: number;
  work_item: string | null;
}

export type LimitName = 'runtime' | 'repairs_per_stage' | 'repairs_per_iteration' | 'usd_estimated' | 'tokens';

export interface IterationVerdict {
  // final: the iteration cannot admit this dispatch whatever its running
  // runs do; settling: it may, once they have ended.
  kind: 'final' | 'settling';
  limit: LimitName;
  reason: string;
  facts: Record<string, unknown>;
}

// The check at a dispatch (R4), against the iteration's limits as recorded
// on it, in this order: the runtime (approval to Alpha, wall clock, once the
// brief is approved), the repairs of the work item and of the iteration, the
// estimated cost settled, and the tokens committed plus this run's
// reservation. null: admitted.
export function iterationVerdict(db: Db, it: IterationRowLite, ask: DispatchAsk, account: IterationAccount = iterationAccount(db, it.project, it.id)): IterationVerdict | null {
  const limits = limitsOfRow(it);
  const runtime = num(limits.prototype_runtime_seconds);
  // The runtime limit refuses new dispatch only; a run already running is
  // not ended by it (it continues to its own deadline and ends through the
  // existing termination and accounting machinery).
  if (runtime !== null && it.approved_at !== null) {
    const since = (nowMs() - Date.parse(it.approved_at)) / 1000;
    if (Number.isFinite(since) && since > runtime) {
      return {
        kind: 'final',
        limit: 'runtime',
        reason: `runtime: prototype_runtime_seconds ${runtime} passed (${Math.floor(since)} s since the brief was approved at ${it.approved_at}); no new run is dispatched, and runs already running continue to their own deadlines`,
        facts: { value: runtime, elapsed_seconds: Math.floor(since), approved_at: it.approved_at },
      };
    }
  }
  const perStage = num(limits.prototype_repairs_per_stage);
  if (ask.repair && perStage !== null && ask.item_repairs + 1 > perStage) {
    return {
      kind: 'final',
      limit: 'repairs_per_stage',
      reason: `repairs_per_stage: prototype_repairs_per_stage ${perStage} reached: work item ${ask.work_item ?? '(none)'} has had ${ask.item_repairs} repair(s), and this dispatch would be repair ${ask.item_repairs + 1}`,
      facts: { value: perStage, work_item: ask.work_item, repairs: ask.item_repairs },
    };
  }
  const perIteration = num(limits.prototype_repairs_per_iteration);
  if (ask.repair && perIteration !== null && account.repairs_used + 1 > perIteration) {
    return {
      kind: 'final',
      limit: 'repairs_per_iteration',
      reason: `repairs_per_iteration: prototype_repairs_per_iteration ${perIteration} reached: the iteration's work items have had ${account.repairs_used} repair(s), and this dispatch would be repair ${account.repairs_used + 1}`,
      facts: { value: perIteration, repairs: account.repairs_used },
    };
  }
  // Estimated cost: settled reported and estimated cost only, a threshold,
  // never a billing cap. An invocation of unknown cost is never counted as
  // 0: while any has one (or any is under way, not yet costed), the cost
  // check cannot pass on its own, and the dispatch passes only if the token
  // check does (below), which bounds what those invocations used.
  const usdLimit = num(limits.prototype_budget_usd_estimated);
  const spent = money((account.reported_usd ?? 0) + (account.estimated_usd ?? 0));
  const usdUnknown = account.unknown_cost_invocations + account.under_way_invocations;
  const usdNote =
    usdUnknown === 0
      ? ''
      : `; the estimated-cost check cannot pass on its own: ${account.unknown_cost_invocations} invocation(s) of unknown cost and ${account.under_way_invocations} under way not yet costed are not counted as 0, so the token check decides`;
  if (usdLimit !== null && spent >= usdLimit) {
    return {
      kind: 'final',
      limit: 'usd_estimated',
      reason: `usd_estimated: prototype_budget_usd_estimated ${usdLimit} reached: settled reported ${account.reported_usd ?? 0} + estimated ${account.estimated_usd ?? 0} = ${spent} USD (a threshold on estimated spend, not a billing cap)${usdUnknown > 0 ? `; ${usdUnknown} invocation(s) not costed are not counted, so the spend is at least this` : ''}`,
      facts: { value: usdLimit, reported_usd: account.reported_usd, estimated_usd: account.estimated_usd, unknown_cost_invocations: account.unknown_cost_invocations, under_way_invocations: account.under_way_invocations },
    };
  }
  const tokens = num(limits.prototype_budget_tokens);
  if (tokens !== null) {
    if (account.unknown_billable_invocations > 0) {
      return {
        kind: 'final',
        limit: 'tokens',
        reason: `tokens: prototype_budget_tokens ${tokens}: ${account.unknown_billable_invocations} charged invocation(s) have unknown billable tokens and no unknown allowance, so what the iteration committed is unknown and this run's reservation of ${ask.reservation} cannot be shown to fit${usdNote}`,
        facts: { value: tokens, unknown_billable_invocations: account.unknown_billable_invocations, reservation: ask.reservation },
      };
    }
    const after = account.committed_tokens + ask.reservation;
    if (after > tokens) {
      const ended = account.committed_tokens - account.outstanding_reservation_tokens;
      const facts = {
        value: tokens,
        committed: account.committed_tokens,
        settled: account.settled_tokens,
        unknown_allowances: account.unknown_allowance_tokens,
        under_way_observed: account.under_way_observed_tokens,
        under_way_reserved: account.outstanding_reservation_tokens,
        reservation: ask.reservation,
      };
      const text = `tokens: prototype_budget_tokens ${tokens}: committed ${account.committed_tokens} (settled ${account.settled_tokens}, unknown allowances ${account.unknown_allowance_tokens}, under way ${account.under_way_observed_tokens} observed + ${account.outstanding_reservation_tokens} reserved) + this run's reservation ${ask.reservation} = ${after} exceeds it${usdNote}`;
      return { kind: ended + ask.reservation > tokens ? 'final' : 'settling', limit: 'tokens', reason: text, facts };
    }
  }
  return null;
}

// The ask of a one-shot work item's dispatch: its run limit, and a repair
// when the item is re-dispatched after a failed run (runs.ts claimDispatch
// counts it).
export function askOfItem(db: Db, item: { id: string; project: string; repair_due: number; repair_attempts: number }): DispatchAsk {
  return { reservation: projectPolicy(db, item.project).budget_run_billable_tokens!, repair: item.repair_due === 1, item_repairs: item.repair_attempts, work_item: item.id };
}

// The ask of a session's opening: the session's own run budget, no repair.
export function askOfSession(db: Db, project: string, role: string): DispatchAsk {
  return { reservation: runBudgetOf(db, { project, kind: 'session', role }).limit, repair: false, item_repairs: 0, work_item: null };
}

// The blocker of a dispatch of the project by the iteration (null for a
// planned project, a project with no iteration, or an iteration that is
// neither open nor holding). A read: the transaction that meets a final
// verdict records it (enforceIterationLimit).
export function prototypeBlocker(db: Db, project: string, ask: DispatchAsk): string | null {
  const mode = (db.prepare('SELECT "mode" FROM "projects" WHERE "id" = ?').get(project) as { mode: string } | undefined)?.mode;
  if (mode !== 'rapid_prototype') return null;
  const it = currentRow(db, project);
  if (!it) return null;
  if (HOLDING_STATUSES.includes(it.status)) {
    return `${PROTOTYPE_LIMIT}: iteration ${it.seq} is ${it.status}${it.outcome_reason ? ` (${it.outcome_reason})` : ''}; next: ${it.next_step ?? 'none'}`;
  }
  if (!OPEN_ITERATION_STATUSES.includes(it.status)) return null;
  const v = iterationVerdict(db, it, ask);
  if (v === null) return null;
  return v.kind === 'final' ? `${PROTOTYPE_LIMIT}: ${v.reason}` : `${PROTOTYPE_SETTLING} ${it.seq}: ${v.reason}`;
}

function endIteration(tx: Tx, it: IterationRowLite, status: 'limit_reached' | 'stopped' | 'discarded', reason: string, next: string, event: 'prototype.iteration_limit_reached' | 'prototype.iteration_stopped' | 'prototype.iteration_discarded', payload: Record<string, unknown>): void {
  tx.db.prepare('UPDATE "prototype_iterations" SET "status" = ?, "outcome_reason" = ?, "next_step" = ?, "ended_at" = ? WHERE "id" = ?').run(status, reason, next, tx.at, it.id);
  tx.emit(event, { project: it.project, iteration: it.id }, { from: it.status, reason, next_step: next, ...payload });
}

// The transaction that met the limit records it (R4): the project's open
// iteration becomes `limit_reached`, its reason naming the limit and the
// numbers, its next step "raise the limit or discard". The verdict is taken
// again here, never from the caller. Returns whether it was recorded.
export function enforceIterationLimit(tx: Tx, project: string, ask: DispatchAsk): boolean {
  const it = currentRow(tx.db, project);
  if (!it || !OPEN_ITERATION_STATUSES.includes(it.status)) return false;
  const v = iterationVerdict(tx.db, it, ask);
  if (v === null || v.kind !== 'final') return false;
  endIteration(tx, it, 'limit_reached', v.reason, LIMIT_NEXT_STEP, 'prototype.iteration_limit_reached', { limit: v.limit, ...v.facts });
  return true;
}

// At each tick (scheduler/holds.ts): an open iteration whose runtime has
// passed is limit_reached though no dispatch was asked of it, so that its
// state says what the next dispatch would meet. Only the runtime is
// independent of a dispatch's ask; nothing running is touched.
export function settleIterationRuntime(tx: Tx): number {
  const rows = tx.db
    .prepare(`SELECT * FROM "prototype_iterations" WHERE "approved_at" IS NOT NULL AND "status" IN (${OPEN_ITERATION_STATUSES.map(() => '?').join(', ')})`)
    .all(...OPEN_ITERATION_STATUSES) as IterationRowLite[];
  let n = 0;
  for (const it of rows) {
    if (currentRow(tx.db, it.project)?.id !== it.id) continue;
    const v = iterationVerdict(tx.db, it, { reservation: 0, repair: false, item_repairs: 0, work_item: null });
    if (v === null || v.limit !== 'runtime') continue;
    endIteration(tx, it, 'limit_reached', v.reason, LIMIT_NEXT_STEP, 'prototype.iteration_limit_reached', { limit: v.limit, ...v.facts });
    n++;
  }
  return n;
}

// A policy revision recorded (finalize.ts, the policy finalizer): the
// current iteration's limits follow the project's editable keys. A raised
// limit is the way back from `limit_reached` and from `stopped` (their next
// step): such an iteration is open again, `building` once its brief is
// approved, else `preparing`; the next dispatch is checked against the new
// limits (a stopped project stays paused until the owner resumes it).
export function limitsChanged(tx: Tx, project: string): void {
  const it = currentRow(tx.db, project);
  if (!it || it.status === 'discarded' || !(OPEN_ITERATION_STATUSES.includes(it.status) || HOLDING_STATUSES.includes(it.status))) return;
  const from = limitsOfRow(it);
  const to = limitsOf(projectPolicy(tx.db, project));
  const changed = PROTOTYPE_LIMIT_KEYS.filter((k) => from[k] !== to[k]);
  if (changed.length === 0) return;
  const raised = changed.filter((k) => typeof from[k] !== 'number' || to[k]! > from[k]!);
  const reopen = raised.length > 0 && (it.status === 'limit_reached' || it.status === 'stopped');
  const status: IterationStatus = reopen ? (it.approved_at !== null ? 'building' : 'preparing') : it.status;
  tx.db.prepare('UPDATE "prototype_iterations" SET "limits_json" = ? WHERE "id" = ?').run(JSON.stringify(to), it.id);
  if (reopen) tx.db.prepare('UPDATE "prototype_iterations" SET "status" = ?, "outcome_reason" = NULL, "next_step" = NULL, "ended_at" = NULL WHERE "id" = ?').run(status, it.id);
  tx.emit('prototype.iteration_limits_changed', { project, iteration: it.id }, { from, to, raised, reopened: reopen, status });
}

// ---- Stop and Discard (R4, R8): what each would do, for the confirmation and the read ----

// The deployment request whose deployment runs in the environment now: the
// newest deployed request's operation, unless a teardown of the environment
// finalized after it; null when none.
export function currentDeploymentRequest(db: Db, environment: string): string | null {
  const deployed = db
    .prepare(
      `SELECT d."id", o."seq" FROM "deployment_requests" d JOIN "operations" o ON o."authorization" = d."authorization"
       WHERE d."environment" = ? AND d."outcome" = 'deployed' AND o."kind" = 'deploy' ORDER BY o."seq" DESC LIMIT 1`,
    )
    .get(environment) as { id: string; seq: number } | undefined;
  if (!deployed) return null;
  const torn = db
    .prepare(
      `SELECT o."seq" FROM "operations" o JOIN "deploy_journal_state" s ON s."operation" = o."id"
       WHERE o."kind" = 'teardown' AND json_extract(o."target", '$.environment') = ? AND s."state" = 'finalized' ORDER BY o."seq" DESC LIMIT 1`,
    )
    .get(environment) as { seq: number } | undefined;
  return torn && torn.seq > deployed.seq ? null : deployed.id;
}

export interface AlphaDisposition {
  tears_down_alpha: boolean;
  environment: { id: string; name: string } | null;
  deployment_request: string | null;
  kept_because: string | null;
}

// What Discard does to the iteration's deployment (R8): its environment is
// torn down only when the deployment running there now is this iteration's;
// a newer iteration's deployment in the same environment is never touched.
export function alphaDisposition(db: Db, iteration: string): AlphaDisposition {
  const it = iterationById(db, iteration)!;
  if (it.deployment_request === null) return { tears_down_alpha: false, environment: null, deployment_request: null, kept_because: 'this iteration deployed nothing' };
  const req = db.prepare('SELECT d."environment", e."name", e."teardown_requested_at" FROM "deployment_requests" d JOIN "environments" e ON e."id" = d."environment" WHERE d."id" = ?').get(it.deployment_request) as
    | { environment: string; name: string; teardown_requested_at: string | null }
    | undefined;
  if (!req) return { tears_down_alpha: false, environment: null, deployment_request: it.deployment_request, kept_because: 'the deployment request is not recorded' };
  const environment = { id: req.environment, name: req.name };
  const base = { environment, deployment_request: it.deployment_request };
  const inFlight = db
    .prepare(
      `SELECT "id", "kind" FROM "operations" WHERE json_extract("target", '$.environment') = ? AND "kind" IN ('deploy', 'teardown')
         AND "orchestration_stage" IS NOT NULL AND "orchestration_stage" <> 'ended' ORDER BY "seq" DESC LIMIT 1`,
    )
    .get(req.environment) as { id: string; kind: string } | undefined;
  if (inFlight) return { ...base, tears_down_alpha: false, kept_because: `${inFlight.kind} operation ${inFlight.id} of environment ${req.name} is under way; what runs there is not settled` };
  if (req.teardown_requested_at !== null) return { ...base, tears_down_alpha: false, kept_because: `a teardown of environment ${req.name} is already requested` };
  const current = currentDeploymentRequest(db, req.environment);
  if (current === null) return { ...base, tears_down_alpha: false, kept_because: `nothing is deployed to environment ${req.name} now` };
  if (current === it.deployment_request) return { ...base, tears_down_alpha: true, kept_because: null };
  const holder = db.prepare('SELECT "seq" FROM "prototype_iterations" WHERE "project" = ? AND "deployment_request" = ? LIMIT 1').get(it.project, current) as { seq: number } | undefined;
  if (holder && holder.seq > it.seq) {
    return { ...base, tears_down_alpha: false, kept_because: `iteration ${holder.seq}, newer, holds environment ${req.name}: its deployment (request ${current}) is the one running there, and Discard never touches it` };
  }
  return { ...base, tears_down_alpha: false, kept_because: `the deployment running in environment ${req.name} is request ${current}, not this iteration's` };
}

export interface RunFate {
  run: string;
  role: string;
  kind: string;
  state: string;
  stoppable: boolean;
  fate: string;
}

// The iteration's runs that have not ended, each with what a Stop does to it.
export function runsUnderWay(db: Db, iteration: string): RunFate[] {
  const rows = db.prepare(`SELECT "id", "role", "kind", "state", "quarantined" FROM "runs" WHERE "iteration" = ? AND "state" <> 'ended' ORDER BY "seq"`).all(iteration) as {
    id: string;
    role: string;
    kind: string;
    state: string;
    quarantined: number;
  }[];
  return rows.map((r) => {
    const stoppable = r.quarantined === 0 && r.state !== 'finalizing';
    const fate = r.quarantined === 1
      ? 'quarantined: it ends only when its termination is observed; not stopped by this'
      : r.state === 'finalizing'
        ? 'already ending: its end stands'
        : 'stopped by its stop protocol (human_stop); what it observed is kept, its usage is charged with its unknown allowance, its workspace is retained and its work held';
    return { run: r.id, role: r.role, kind: r.kind, state: r.state, stoppable, fate };
  });
}

export interface IterationControls {
  stop: { available: boolean; reason: string };
  discard: { available: boolean; reason: string; tears_down_alpha: boolean; kept_because: string | null };
}

// What Stop and Discard would do now, for the iteration read and the
// confirmation's preview alike.
export function iterationControls(db: Db, iteration: string): IterationControls {
  const it = iterationById(db, iteration)!;
  const runs = runsUnderWay(db, iteration);
  const stoppable = runs.filter((r) => r.stoppable).length;
  const stopOk = OPEN_ITERATION_STATUSES.includes(it.status) || it.status === 'limit_reached';
  const stop = stopOk
    ? { available: true, reason: `pauses the project so that nothing else is dispatched, and stops ${stoppable} running run(s) of the iteration, each keeping its charge and its unknown allowance; nothing of the usage is erased` }
    : { available: false, reason: `the iteration is ${it.status}: nothing of it can be stopped` };
  const alpha = alphaDisposition(db, iteration);
  const discard =
    it.status === 'discarded'
      ? { available: false, reason: 'the iteration is already discarded', tears_down_alpha: false, kept_because: alpha.kept_because }
      : {
          available: true,
          reason: `stops ${stoppable} running run(s) of the iteration and ${alpha.tears_down_alpha ? `tears down its Alpha in environment ${alpha.environment!.name}` : 'leaves any Alpha in place'}; receipts, ledger rows, runs and records are kept`,
          tears_down_alpha: alpha.tears_down_alpha,
          kept_because: alpha.kept_because,
        };
  return { stop, discard };
}

export type IterationAction = 'stop' | 'discard';

// The confirmation's manifest for a Stop or a Discard of an iteration (a
// `stop_confirm` whose subject is the iteration and whose scope is the
// action): the run-control keys every stop_confirm carries, and what the
// action does to each running run, to the project and to the Alpha. null
// when the action is not available.
export function iterationControlManifest(db: Db, iteration: string, action: IterationAction): Record<string, unknown> | null {
  const it = iterationById(db, iteration);
  if (!it) return null;
  const controls = iterationControls(db, iteration);
  if (!controls[action].available) return null;
  const runs = runsUnderWay(db, iteration);
  const domains = runs.length === 0
    ? []
    : (db.prepare(`SELECT "id" FROM "execution_domains" WHERE "run" IN (${runs.map(() => '?').join(', ')}) AND "status" <> 'terminated' ORDER BY "id"`).all(...runs.map((r) => r.run)) as { id: string }[]).map((d) => d.id);
  return {
    run: null,
    stoppable: true,
    domains,
    lease_generation: null,
    workspace: null,
    workspace_snapshot: null,
    workspace_fate: 'retained',
    work_fate: { status: 'held' },
    iteration: it.id,
    iteration_seq: it.seq,
    iteration_status: it.status,
    action,
    runs,
    project_paused: action === 'stop',
    usage: 'kept: each stopped run keeps its charge and its unknown allowance; receipts, ledger rows, runs and records are kept',
    alpha: action === 'discard' ? alphaDisposition(db, iteration) : null,
    outcome: { status: action === 'stop' ? 'stopped' : 'discarded', next_step: action === 'stop' ? STOP_NEXT_STEP : DISCARD_NEXT_STEP },
  };
}

// The confirmed Stop's or Discard's record on the iteration (control.ts
// applies the rest: the pause, each run's stop, the teardown).
export function recordIterationControl(tx: Tx, args: { iteration: string; action: IterationAction; decision: string; stopped: string[]; teardown: { environment: string } | null }): void {
  const it = iterationById(tx.db, args.iteration)!;
  if (args.action === 'stop') {
    endIteration(tx, it, 'stopped', `stopped by the owner (decision ${args.decision}): the project paused, ${args.stopped.length} run(s) stopped, each keeping its charge`, STOP_NEXT_STEP, 'prototype.iteration_stopped', { decision: args.decision, runs: args.stopped });
  } else {
    endIteration(tx, it, 'discarded', `discarded by the owner (decision ${args.decision}): ${args.stopped.length} run(s) stopped; ${args.teardown ? `its Alpha's environment ${args.teardown.environment} torn down` : 'no Alpha torn down'}; receipts and accounting kept`, DISCARD_NEXT_STEP, 'prototype.iteration_discarded', {
      decision: args.decision,
      runs: args.stopped,
      teardown: args.teardown,
    });
  }
}
