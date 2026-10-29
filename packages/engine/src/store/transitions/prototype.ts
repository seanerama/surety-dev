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
import { raisePreparation } from '../../prototype/brief.js';
import { Refusal } from '../../refusal.js';
import { resumeWork } from './work.js';

type Db = Tx['db'];

export const ITERATION_STATUSES = ['preparing', 'awaiting_brief_approval', 'building', 'awaiting_owner', 'alpha_ready', 'failed', 'stopped', 'limit_reached', 'discarded'] as const;
export type IterationStatus = (typeof ITERATION_STATUSES)[number];
// An open iteration is one whose work is not over: a run dispatched while
// it is open is the iteration's.
export const OPEN_ITERATION_STATUSES: readonly IterationStatus[] = ['preparing', 'awaiting_brief_approval', 'building', 'awaiting_owner'];
// Slice E3: a failed iteration (a work item of it parked) is ended until the
// owner's retry returns the work (prototype/brief.ts syncIterationStatuses);
// what is dispatched for it meanwhile (the retried work) is still its own,
// and is checked against its limits as an open iteration's is.
export const ATTRIBUTABLE_STATUSES: readonly IterationStatus[] = [...OPEN_ITERATION_STATUSES, 'failed'];

// The five limit keys of a policy, as the iteration snapshots them (R4).
export function limitsOf(policy: Policy): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of PROTOTYPE_LIMIT_KEYS) out[key] = policy[key] as number;
  // And the per-run limit each dispatch reserves against the token
  // allowance (slice E3: the preset sets it so that the allowance admits
  // several runs), for the brief and the read.
  out.budget_run_billable_tokens = policy.budget_run_billable_tokens as number;
  return out;
}

// A new iteration of a rapid_prototype project, `preparing`, its seq the
// project's next, its limits the effective policy's now.
// Slice E4 (R7, R8): an Iterate gives the predecessor and the owner's short
// change request (kept as typed, NULL when none was given).
export function createIteration(tx: Tx, args: { project: string; limits: Record<string, number>; predecessor?: string | null; change?: string | null }): string {
  const id = tx.newId('it_');
  const { n } = tx.db.prepare('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "prototype_iterations" WHERE "project" = ?').get(args.project) as { n: number };
  tx.db
    .prepare(
      `INSERT INTO "prototype_iterations" ("id", "created_at", "project", "seq", "predecessor", "mode", "status", "limits_json", "change_text")
       VALUES (?, ?, ?, ?, ?, 'rapid_prototype', 'preparing', ?, ?)`,
    )
    .run(id, tx.at, args.project, n, args.predecessor ?? null, JSON.stringify(args.limits), args.change ?? null);
  tx.emit('prototype.iteration_created', { project: args.project, iteration: id }, { seq: n, predecessor: args.predecessor ?? null, limits: args.limits, ...(args.predecessor ? { change: args.change ?? null } : {}) });
  // Slice E3 (R5): the owner is asked at once to authorize the one run that
  // prepares the iteration's brief; nothing is dispatched before the answer.
  const asked = raisePreparation(tx, { project: args.project, iteration: id });
  // An Iterate on a project paused (by a Stop of the predecessor): nothing
  // is dispatched until the owner resumes it, and the next step says so. (A
  // new prototype is created unpaused by the new-app route, slice E5's S1:
  // its first iteration's question is all there is until it is answered.)
  const paused = !!args.predecessor && (tx.db.prepare('SELECT "paused" FROM "projects" WHERE "id" = ?').get(args.project) as { paused: number } | undefined)?.paused === 1;
  const next = asked ? 'approve preparation or discard' : 'request preparation or discard';
  tx.db.prepare('UPDATE "prototype_iterations" SET "next_step" = ? WHERE "id" = ?').run(paused ? `resume the project (it is paused), then ${next}` : next, id);
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
  return it !== null && ATTRIBUTABLE_STATUSES.includes(it.status) ? it.id : null;
}

// Why a candidate is not the iteration's own (null when it is): the
// iteration has no approved brief, the candidate was nominated on an
// earlier spec revision than the brief's (or on none), or an earlier
// iteration recorded it as its Alpha.
export function alphaNotOwn(db: Db, iteration: string, candidate: string): string | null {
  const it = db.prepare('SELECT "seq", "project", "brief_spec_revision" FROM "prototype_iterations" WHERE "id" = ?').get(iteration) as { seq: number; project: string; brief_spec_revision: string | null } | undefined;
  if (!it) return 'the iteration is not recorded';
  const earlier = db.prepare('SELECT "seq" FROM "prototype_iterations" WHERE "project" = ? AND "candidate" = ? AND "seq" < ? ORDER BY "seq" DESC LIMIT 1').get(it.project, candidate, it.seq) as { seq: number } | undefined;
  if (earlier) return `candidate ${candidate} is iteration ${earlier.seq}'s Alpha, not iteration ${it.seq}'s`;
  if (it.brief_spec_revision === null) return `iteration ${it.seq} has no approved brief: no candidate is its own yet`;
  const version = (rev: string | null) => (rev === null ? null : ((db.prepare('SELECT "version" FROM "spec_revisions" WHERE "id" = ?').get(rev) as { version: number } | undefined)?.version ?? null));
  const c = db.prepare('SELECT "spec_revision" FROM "candidates" WHERE "id" = ?').get(candidate) as { spec_revision: string | null } | undefined;
  const brief = version(it.brief_spec_revision);
  const own = version(c?.spec_revision ?? null);
  if (brief === null || own === null || own < brief) {
    return `candidate ${candidate} was nominated on spec version ${own ?? 'unknown'}, before iteration ${it.seq}'s approved brief (spec version ${brief ?? 'unknown'})`;
  }
  return null;
}

// alpha_complete satisfied for a candidate of a rapid_prototype project
// (deploy.ts afterCompletion): the iteration open now records the candidate,
// the deployment request the operation served, when Alpha was reached, and
// its owner-facing outcome `alpha_ready`. History: kept as recorded whatever
// later happens to the deployment (a teardown makes `alpha.current` null in
// the read, never this).
//
// Slice E4 (R7, R8): only a candidate of the iteration's own approved brief
// satisfies its Alpha: one nominated on the brief's approved spec revision
// or a later one of the project, and no earlier iteration's recorded
// candidate. A predecessor's candidate (its deployment completing late, or
// deployed again) is never the new iteration's Alpha: the refusal is an
// event, and the iteration is unchanged.
export function recordIterationAlpha(tx: Tx, args: { project: string; candidate: string; request: string | null; operation: string }): void {
  const id = iterationForDispatch(tx.db, args.project);
  if (id === null) return;
  const why = alphaNotOwn(tx.db, id, args.candidate);
  if (why !== null) {
    tx.emit('prototype.alpha_not_attributed', { project: args.project, iteration: id }, { candidate: args.candidate, deployment_request: args.request, operation: args.operation, reason: why });
    return;
  }
  tx.db
    .prepare(
      `UPDATE "prototype_iterations" SET "status" = 'alpha_ready', "candidate" = ?, "deployment_request" = ?, "alpha_at" = ?, "ended_at" = ?,
         "outcome_reason" = 'alpha_complete', "next_step" = 'open_alpha' WHERE "id" = ?`,
    )
    .run(args.candidate, args.request, tx.at, tx.at, id);
  tx.emit('prototype.iteration_alpha_ready', { project: args.project, iteration: id }, { candidate: args.candidate, deployment_request: args.request, operation: args.operation });
}

// A finalized teardown of an environment (deploy.ts finalizeDeploy): each
// candidate whose Alpha deployment request to that environment was
// deployed, and which is still `alpha_deployed`, is set back to
// `developing`, for nothing it deployed runs there now (ENGINE §6: the label
// was never reset). Scoped to the environment's deployments.
//
// Slice E5 (the owner's ruling S3 of 2026-10-28: "Make current Alpha
// availability consistent across modes. Teardown must remove any claim that
// the Alpha is currently available. Preserve the historical deployment
// record."): every mode, a planned project's candidates as a prototype's.
// `candidates.progress` is the current claim; the history is kept apart and
// untouched: the deployment requests and their outcome, the operations and
// their journal, the deployment verifications, the observation history, the
// gate evaluation that satisfied alpha_complete, the `candidate.advanced`
// event, and an iteration's `alpha_at`.
export function withdrawAlpha(tx: Tx, args: { project: string; environment: string; operation: string }): string[] {
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
// Slice E5 (S2): a limit reached because what the iteration committed is
// unknown offers only what works: raising a limit cannot resolve an unknown
// total, and a preparation would be one more dispatch against it.
export const UNKNOWN_NEXT_STEP = "iterate (a new iteration, whose own totals exclude this one's; the app's totals keep this unknown) or discard";
// Slice E5 (gap 4): a Stop is undone only by a deliberate resume, never by
// raising a limit.
export const STOP_NEXT_STEP = 'resume (POST …/resume), iterate or discard';
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
  // Slice E5 (S2): each charged invocation whose billable tokens are unknown
  // and which carries no allowance, with its run, so that what is unknown is
  // named, never only counted.
  unknown_billable: { invocation: string; run: string; role: string; work_kind: string | null }[];
}

export function iterationAccount(db: Db, project: string, iteration: string): IterationAccount {
  const receipts = db
    .prepare(
      `SELECT i."id", i."run", r."role", w."kind" AS "work_kind" FROM "invocation_receipts" i JOIN "runs" r ON r."id" = i."run" LEFT JOIN "work_items" w ON w."id" = r."work_item"
       WHERE r."iteration" = ? ORDER BY r."seq", i.rowid`,
    )
    .all(iteration) as { id: string; run: string; role: string; work_kind: string | null }[];
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
    unknown_billable: [],
  };
  for (const { id, run, role, work_kind } of receipts) {
    const rows = db.prepare('SELECT * FROM "ledger_rows" WHERE "invocation" = ? ORDER BY rowid').all(id) as LedgerRow[];
    if (rows.some((r) => r.corrects === null)) {
      const acc = fold(rows);
      const b = billable(acc);
      if (b === null && acc.unknown_allowance_tokens === null) {
        a.unknown_billable_invocations += 1;
        a.unknown_billable.push({ invocation: id, run, role, work_kind });
      }
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

// What the iteration's committed figure being unknown means, in words: the
// invocations, each with its run, and what is unknown of them (S2). null
// when nothing is unknown.
export function unknownAccountingText(a: IterationAccount): string | null {
  if (a.unknown_billable_invocations === 0) return null;
  const which = a.unknown_billable.map((u) => `invocation ${u.invocation} of run ${u.run} (${u.role}${u.work_kind ? `, ${u.work_kind}` : ''})`).join('; ');
  return `${a.unknown_billable_invocations} charged invocation(s) have unknown billable tokens and no unknown allowance (${which}): each was settled with no usage reported and no allowance charged for it, so what it used, and so what the iteration committed, is unknown, never 0. Raising a limit cannot resolve an unknown total`;
}

// The iteration's accounting unresolved (S2): its committed tokens unknown.
// null when they are known (or the iteration has no token allowance).
export function unresolvedAccounting(db: Db, project: string, iteration: string): { text: string; invocations: string[]; runs: string[] } | null {
  const it = iterationById(db, iteration);
  if (!it || num(limitsOfRow(it).prototype_budget_tokens) === null) return null;
  const a = iterationAccount(db, project, iteration);
  const text = unknownAccountingText(a);
  return text === null ? null : { text, invocations: a.unknown_billable.map((u) => u.invocation), runs: [...new Set(a.unknown_billable.map((u) => u.run))] };
}

// ---- slice E5: the effective allowance of a run (the owner's ruling S5 of 2026-10-28) ----
//
// "Cap each run's effective allowance at the available iteration budget,
// accounting for other active reservations, and show that effective limit
// clearly." A run of a prototype iteration is admitted with the lower of
// its per-run limit (`budget_run_billable_tokens`) and what the iteration
// has left of its token allowance after its settled usage, its unknown
// allowances and what the other runs under way observed and still reserve.
// That effective allowance is fixed on the run's receipt at dispatch
// (ledger.ts runLimit reads it): it is the run's reservation, the bound of
// its unknown allowance, and the limit its own mid-run budget check stops it
// at (ledger.ts budgetCheck). A run that cannot get a positive one is not
// dispatched (iterationVerdict).

export interface EffectiveAllowance {
  iteration: string;
  // The per-run limit asked (the policy's run budget).
  run_limit_tokens: number;
  // What the iteration has left now; null when it has no token allowance.
  available_tokens: number | null;
  effective_limit_tokens: number;
  limited_by: 'run' | 'iteration';
}

// The effective allowance of a run asking `runLimit` of the iteration now;
// null when none is positive or the committed figure is unknown.
export function effectiveAllowanceOf(db: Db, it: IterationRowLite, runLimit: number, account: IterationAccount = iterationAccount(db, it.project, it.id)): EffectiveAllowance | null {
  const tokens = num(limitsOfRow(it).prototype_budget_tokens);
  if (tokens === null) return { iteration: it.id, run_limit_tokens: runLimit, available_tokens: null, effective_limit_tokens: runLimit, limited_by: 'run' };
  if (account.unknown_billable_invocations > 0) return null;
  const available = tokens - account.committed_tokens;
  if (available <= 0) return null;
  return available < runLimit
    ? { iteration: it.id, run_limit_tokens: runLimit, available_tokens: available, effective_limit_tokens: available, limited_by: 'iteration' }
    : { iteration: it.id, run_limit_tokens: runLimit, available_tokens: available, effective_limit_tokens: runLimit, limited_by: 'run' };
}

// The effective allowance of a run of the project dispatched now:
// `undefined` when no iteration admits it (a planned project, or no
// attributable iteration), null when the iteration has none to give.
export function dispatchAllowance(db: Db, project: string, runLimit: number): EffectiveAllowance | null | undefined {
  const mode = (db.prepare('SELECT "mode" FROM "projects" WHERE "id" = ?').get(project) as { mode: string } | undefined)?.mode;
  if (mode !== 'rapid_prototype') return undefined;
  const it = currentRow(db, project);
  if (!it || !ATTRIBUTABLE_STATUSES.includes(it.status)) return undefined;
  return effectiveAllowanceOf(db, it, runLimit);
}

// A session turn's (S5, as a one-shot's): the session's cumulative bound,
// what its earlier turns were charged (`spent`) plus the lower of what the
// session has left of its run budget and what the iteration has left. The
// iteration's account already counts the earlier turns. `undefined` when no
// iteration admits it; null when the iteration has none to give.
export function sessionTurnAllowance(db: Db, run: { project: string; iteration: string | null }, runLimit: number, spent: number): EffectiveAllowance | null | undefined {
  if (run.iteration === null) return undefined;
  const it = iterationById(db, run.iteration);
  if (!it || !ATTRIBUTABLE_STATUSES.includes(it.status) || currentRow(db, run.project)?.id !== it.id) return undefined;
  const own = Math.max(0, runLimit - spent);
  const e = effectiveAllowanceOf(db, it, own);
  if (e === null || own <= 0) return null;
  return { ...e, run_limit_tokens: runLimit, effective_limit_tokens: spent + e.effective_limit_tokens };
}

// The allowance a receipt fixed (its budget snapshot's `prototype_allowance`),
// or null for a receipt that has none.
export function receiptAllowance(db: Db, invocation: string): EffectiveAllowance | null {
  const row = db.prepare('SELECT "budget_snapshot" FROM "invocation_receipts" WHERE "id" = ?').get(invocation) as { budget_snapshot: string } | undefined;
  try {
    const v = row ? (JSON.parse(row.budget_snapshot) as { prototype_allowance?: EffectiveAllowance }).prototype_allowance : undefined;
    return v && typeof v.effective_limit_tokens === 'number' ? v : null;
  } catch {
    return null;
  }
}

// What a dispatch asks of the iteration: the run's reservation (its run
// limit: `budget_run_billable_tokens`, or a Designer session's own budget,
// ledger.ts runBudgetOf), and whether it is a repair, with the work item's
// repairs so far. Slice E5 (S5): the reservation is the per-run limit
// asked; what the run is given is its effective allowance, the lower of it
// and what the iteration has left (effectiveAllowanceOf).
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
    // S2: an unknown committed figure is never read as 0, and no run is
    // dispatched against it; what is unknown is named.
    const unknown = unknownAccountingText(account);
    if (unknown !== null) {
      return {
        kind: 'final',
        limit: 'tokens',
        reason: `tokens: prototype_budget_tokens ${tokens}: what the iteration committed is unknown: ${unknown}; no run is dispatched against an unknown total`,
        facts: { value: tokens, unknown: true, unknown_billable_invocations: account.unknown_billable_invocations, invocations: account.unknown_billable.map((u) => u.invocation), runs: [...new Set(account.unknown_billable.map((u) => u.run))], reservation: ask.reservation },
      };
    }
    // S5: the run is given the lower of its per-run limit and what the
    // iteration has left; refused only when nothing is left.
    const available = tokens - account.committed_tokens;
    if (available <= 0) {
      const ended = account.committed_tokens - account.outstanding_reservation_tokens;
      const facts = {
        value: tokens,
        committed: account.committed_tokens,
        settled: account.settled_tokens,
        unknown_allowances: account.unknown_allowance_tokens,
        under_way_observed: account.under_way_observed_tokens,
        under_way_reserved: account.outstanding_reservation_tokens,
        available: Math.max(0, available),
        reservation: ask.reservation,
      };
      const text = `tokens: prototype_budget_tokens ${tokens}: committed ${account.committed_tokens} (settled ${account.settled_tokens}, unknown allowances ${account.unknown_allowance_tokens}, under way ${account.under_way_observed_tokens} observed + ${account.outstanding_reservation_tokens} reserved) leaves ${Math.max(0, available)}: a run would get no positive allowance (its per-run limit ${ask.reservation}, capped at what the iteration has left)${usdNote}`;
      return { kind: tokens - ended > 0 ? 'settling' : 'final', limit: 'tokens', reason: text, facts };
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
  if (!ATTRIBUTABLE_STATUSES.includes(it.status)) return null;
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
  if (!it || !ATTRIBUTABLE_STATUSES.includes(it.status)) return false;
  const v = iterationVerdict(tx.db, it, ask);
  if (v === null || v.kind !== 'final') return false;
  endIteration(tx, it, 'limit_reached', v.reason, v.facts.unknown === true ? UNKNOWN_NEXT_STEP : LIMIT_NEXT_STEP, 'prototype.iteration_limit_reached', { limit: v.limit, ...v.facts });
  return true;
}

// At each tick (scheduler/holds.ts): an open iteration whose runtime has
// passed is limit_reached though no dispatch was asked of it, so that its
// state says what the next dispatch would meet. Only the runtime is
// independent of a dispatch's ask; nothing running is touched.
// Slice E5 (S2): so is an unknown committed figure (whatever a dispatch
// asks, it is refused), at any open status: a preparing iteration's too, so
// that its next step never offers a preparation that would be refused.
export function settleIterationRuntime(tx: Tx): number {
  const rows = tx.db
    .prepare(`SELECT * FROM "prototype_iterations" WHERE "status" IN (${OPEN_ITERATION_STATUSES.map(() => '?').join(', ')})`)
    .all(...OPEN_ITERATION_STATUSES) as IterationRowLite[];
  let n = 0;
  for (const it of rows) {
    if (currentRow(tx.db, it.project)?.id !== it.id) continue;
    const v = iterationVerdict(tx.db, it, { reservation: 0, repair: false, item_repairs: 0, work_item: null });
    if (v === null || !(v.limit === 'runtime' || (v.limit === 'tokens' && v.facts.unknown === true))) continue;
    endIteration(tx, it, 'limit_reached', v.reason, v.facts.unknown === true ? UNKNOWN_NEXT_STEP : LIMIT_NEXT_STEP, 'prototype.iteration_limit_reached', { limit: v.limit, ...v.facts });
    n++;
  }
  return n;
}

// Why raising a limit does not reopen the current iteration now (S2; gap
// 4), or null when it would: a Stop is undone only by a deliberate resume,
// and a committed figure that is unknown is not resolved by any limit.
export function noReopenBecause(db: Db, it: IterationRowLite): string | null {
  if (it.status === 'stopped') return `iteration ${it.seq} was stopped by the owner: raising a limit does not undo a Stop; resume it deliberately (POST /v1/projects/${it.project}/iterations/${it.id}/resume)`;
  if (it.status === 'limit_reached') {
    const u = unresolvedAccounting(db, it.project, it.id);
    if (u !== null) return `iteration ${it.seq}'s accounting is unresolved: ${u.text}. Next: ${UNKNOWN_NEXT_STEP}`;
  }
  return null;
}

// What a policy submission that raises a prototype limit does to the
// current iteration, for the submission's response (S2: "the policy
// change's response says why"): null when it raises none, or the iteration
// is neither limit_reached nor stopped.
export function raiseEffect(db: Db, project: string, change: Record<string, unknown>): { iteration: string; seq: number; status: IterationStatus; raises: string[]; reopens: boolean; reason: string } | null {
  const mode = (db.prepare('SELECT "mode" FROM "projects" WHERE "id" = ?').get(project) as { mode: string } | undefined)?.mode;
  if (mode !== 'rapid_prototype') return null;
  const it = currentRow(db, project);
  if (!it || !(it.status === 'limit_reached' || it.status === 'stopped')) return null;
  const from = limitsOfRow(it);
  const raises = PROTOTYPE_LIMIT_KEYS.filter((k) => typeof change[k] === 'number' && (typeof from[k] !== 'number' || (change[k] as number) > from[k]!));
  if (raises.length === 0) return null;
  const why = noReopenBecause(db, it);
  return why !== null
    ? { iteration: it.id, seq: it.seq, status: it.status, raises, reopens: false, reason: why }
    : { iteration: it.id, seq: it.seq, status: it.status, raises, reopens: true, reason: `iteration ${it.seq} reached a limit; it is open again once the raised limit is committed, and its next dispatch is checked against the new limits` };
}

// A policy revision recorded (finalize.ts, the policy finalizer): the
// current iteration's limits follow the project's editable keys. A raised
// limit is the way back from `limit_reached` (its next step): such an
// iteration is open again, `building` once its brief is approved, else
// `preparing`; the next dispatch is checked against the new limits.
// Slice E5: never from `stopped` (gap 4: a Stop is undone only by the
// owner's deliberate resume), and never while the committed figure is
// unknown (S2): the limits follow, the iteration stays as it is, and the
// event says why.
export function limitsChanged(tx: Tx, project: string): void {
  const it = currentRow(tx.db, project);
  if (!it || it.status === 'discarded' || !(ATTRIBUTABLE_STATUSES.includes(it.status) || HOLDING_STATUSES.includes(it.status))) return;
  const from = limitsOfRow(it);
  const to = limitsOf(projectPolicy(tx.db, project));
  const changed = PROTOTYPE_LIMIT_KEYS.filter((k) => from[k] !== to[k]);
  if (changed.length === 0) return;
  const raised = changed.filter((k) => typeof from[k] !== 'number' || to[k]! > from[k]!);
  const notBecause = raised.length > 0 ? noReopenBecause(tx.db, it) : null;
  const reopen = raised.length > 0 && it.status === 'limit_reached' && notBecause === null;
  const status: IterationStatus = reopen ? (it.approved_at !== null ? 'building' : 'preparing') : it.status;
  tx.db.prepare('UPDATE "prototype_iterations" SET "limits_json" = ? WHERE "id" = ?').run(JSON.stringify(to), it.id);
  if (reopen) tx.db.prepare('UPDATE "prototype_iterations" SET "status" = ?, "outcome_reason" = NULL, "next_step" = NULL, "ended_at" = NULL WHERE "id" = ?').run(status, it.id);
  tx.emit('prototype.iteration_limits_changed', { project, iteration: it.id }, { from, to, raised, reopened: reopen, status, ...(notBecause !== null ? { not_reopened_because: notBecause } : {}) });
}

// ---- slice E5: Resume (gap 4: "resumption needs a deliberate action") ----
//
//   POST /v1/projects/:p/iterations/:i/resume
//
// On the project's current iteration while it is `stopped`: the project is
// unpaused and the iteration open again, `building` once its brief is
// approved (the tick then sets awaiting_owner while one of the owner's
// questions about its work is open: prototype/brief.ts
// syncIterationStatuses), else `preparing`; the work the Stop held (each
// held work item whose last run is the iteration's) is resumed with it, as
// POST …/work/:w/resume does. Refused while a limit would refuse its next
// dispatch whatever runs do (the runtime passed, the allowance spent, or the
// committed figure unknown): raise the limit first, or iterate or discard.
export function resumeBlocker(db: Db, it: IterationRowLite): string | null {
  if (currentRow(db, it.project)?.id !== it.id) return `iteration ${it.seq} is not the project's current iteration`;
  if (it.status !== 'stopped') return `iteration ${it.seq} is ${it.status}: only a stopped iteration is resumed`;
  const u = unresolvedAccounting(db, it.project, it.id);
  if (u !== null) return `iteration ${it.seq}'s accounting is unresolved: ${u.text}. Next: ${UNKNOWN_NEXT_STEP}`;
  const v = iterationVerdict(db, it, askOfItem(db, { id: '', project: it.project, repair_due: 0, repair_attempts: 0 }));
  if (v !== null && v.kind === 'final') return `${v.reason}; raise the limit, then resume`;
  return null;
}

export function resumeIteration(tx: Tx, args: { project: string; iteration: string }): { status: number; body: Record<string, unknown>; effects: { kind: 'tick' }[] } {
  const it = iterationById(tx.db, args.iteration);
  if (!it || it.project !== args.project) throw new Refusal(404, 'not_found', `Iteration ${args.iteration} of project ${args.project} does not exist.`, 'Read GET /v1/projects/:p/iterations.', { iteration: args.iteration });
  const why = resumeBlocker(tx.db, it);
  if (why !== null) throw new Refusal(409, 'illegal_transition', `Iteration ${it.seq} cannot be resumed: ${why}.`, 'Read the iteration; its next step and controls say what is possible.', { iteration: it.id, status: it.status });
  // The status the iteration's own state gives: building once its brief is
  // approved; awaiting its brief's approval while that question is open;
  // else preparing, its next step whether a preparation question is open.
  const row = tx.db.prepare('SELECT "brief_decision" FROM "prototype_iterations" WHERE "id" = ?').get(it.id) as { brief_decision: string | null };
  const openQuestion = (id: string | null) => id !== null && tx.db.prepare(`SELECT 1 FROM "decisions" WHERE "id" = ? AND "status" = 'open'`).get(id) !== undefined;
  const preparationOpen = tx.db.prepare(`SELECT 1 FROM "decisions" WHERE "kind" = 'prototype_preparation_approval' AND "subject_id" = ? AND "status" = 'open'`).get(it.id) !== undefined;
  const [status, next]: [IterationStatus, string] =
    it.approved_at !== null
      ? ['building', 'none: building']
      : openQuestion(row.brief_decision)
        ? ['awaiting_brief_approval', 'approve the brief, or prepare again, or discard']
        : ['preparing', preparationOpen ? 'approve preparation or discard' : 'request preparation or discard'];
  tx.db.prepare('UPDATE "prototype_iterations" SET "status" = ?, "outcome_reason" = NULL, "next_step" = ?, "ended_at" = NULL WHERE "id" = ?').run(status, next, it.id);
  const paused = (tx.db.prepare('SELECT "paused" FROM "projects" WHERE "id" = ?').get(it.project) as { paused: number }).paused === 1;
  if (paused) {
    tx.db.prepare('UPDATE "projects" SET "paused" = 0 WHERE "id" = ?').run(it.project);
    tx.emit('project.resumed', { project: it.project }, {});
  }
  const held = heldByIteration(tx.db, it);
  for (const w of held) resumeWork(tx, { project: it.project, workItem: w });
  tx.emit('prototype.iteration_resumed', { project: it.project, iteration: it.id }, { from: 'stopped', to: status, project_unpaused: paused, resumed_work: held });
  return { status: 200, body: { iteration: { id: it.id, seq: it.seq, status, next_step: next }, project_unpaused: paused, resumed_work: held }, effects: [{ kind: 'tick' }] };
}

// The held work items whose last run is the iteration's (what its Stop held).
function heldByIteration(db: Db, it: IterationRowLite): string[] {
  return (
    db
      .prepare(
        `SELECT w."id" FROM "work_items" w WHERE w."project" = ? AND w."status" = 'held'
           AND (SELECT r."iteration" FROM "runs" r WHERE r."work_item" = w."id" ORDER BY r."seq" DESC LIMIT 1) = ? ORDER BY w."seq"`,
      )
      .all(it.project, it.id) as { id: string }[]
  ).map((w) => w.id);
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
  // Slice E5 (gap 4): the deliberate way back from a Stop.
  resume: { available: boolean; reason: string };
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
  const resumeWhy = resumeBlocker(db, it);
  const resume = resumeWhy === null
    ? { available: true, reason: `unpauses the project, opens the iteration again (${it.approved_at !== null ? 'building' : 'preparing or awaiting its brief\'s approval'}) and resumes the ${heldByIteration(db, it).length} work item(s) its Stop held; checked against its limits at the next dispatch` }
    : { available: false, reason: resumeWhy };
  return { stop, discard, resume };
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
