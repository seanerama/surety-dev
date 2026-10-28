// The prototype iteration reads (Rapid prototype, slice E1; the owner's
// rulings R7 and R9 of 2026-10-28). A projection of rows that exist, in one
// snapshot: it writes nothing, appends no event and calls no adapter.
//
//   GET /v1/projects/:p/iterations                 every iteration, oldest first
//   GET /v1/projects/:p/iterations/:i              one, with its usage, limits and Alpha
//   GET /v1/projects/:p/iterations/:i/receipt.json the same, as a downloadable receipt
//
// What belongs to an iteration is what was attributed to it when it
// happened (runs.iteration, fixed at dispatch; the iteration's own candidate
// and deployment request, fixed at Alpha), never a time window. Unknown is
// never zero: a figure the ledger does not know is null, with what says why
// beside it, and usage still arriving is `pending`. The usage is the
// ledger's own (store/transitions/ledger.ts: fold, observedSoFar,
// outstandingReservation); intervals are pace's (plan/pace.ts: between).

import type { Database } from 'better-sqlite3';

import { nowIso, nowMs } from '../clock.js';
import { PROTOTYPE_LIMIT_KEYS } from '../config/schema.js';
import { between } from '../plan/pace.js';
import { notFound, parseJson } from '../store/transitions/common.js';
import { type Account, type Amounts, type LedgerRow, billable, fold, observedSoFar, outstandingReservation } from '../store/transitions/ledger.js';
import { projectNotFound } from '../store/transitions/project.js';
import { ENFORCEMENT, OPEN_ITERATION_STATUSES, currentDeploymentRequest, currentIteration, effectiveAllowanceOf, iterationAccount, iterationControls, iterationVerdict, receiptAllowance, unknownAccountingText } from '../store/transitions/prototype.js';
import { projectPolicy } from '../store/transitions/settings.js';
import { redactValue } from '../records/redact.js';

type Db = Database;

const envelope = (db: Db) => ({
  served_at: nowIso(),
  snapshot_seq: (db.prepare('SELECT COALESCE(MAX("seq"), 0) AS n FROM "events"').get() as { n: number }).n,
});

interface IterationRow {
  id: string;
  created_at: string;
  project: string;
  seq: number;
  predecessor: string | null;
  mode: string;
  status: string;
  brief_spec_revision: string | null;
  brief_decision: string | null;
  plan_bundle: string | null;
  phase_plan: string | null;
  candidate: string | null;
  deployment_request: string | null;
  limits_json: string;
  outcome_reason: string | null;
  next_step: string | null;
  approved_at: string | null;
  alpha_at: string | null;
  ended_at: string | null;
  brief_record: string | null;
  brief_json: string | null;
  change_text: string | null;
}

// The providers whose normalized categories are mutually exclusive, so that
// billable_in + cached_in + out counts no token twice (R9; ledger.ts):
//   scripted  input_tokens, cache_read_tokens and output_tokens as reported;
//   claude    billable_in = input + cache creation, cached_in = cache reads,
//             out = output (cache writes inside billable_in);
//   codex     billable_in = input - cached input, cached_in = cached input,
//             out = output, reasoning included in output by the provider and
//             kept only in the raw usage, never added again.
// Any other provider's total is not stated.
const EXCLUSIVE_CATEGORIES: Record<string, string> = {
  scripted: 'scripted-1: input, cache reads and output as reported, each counted once',
  claude: 'claude-stream-json-1: billable_in = input + cache creation (cache writes inside it), cached_in = cache reads, out = output',
  codex: 'codex-exec-json-2: billable_in = input - cached input, cached_in = cached input, out = output (reasoning tokens included in output by the provider, kept in raw_categories, never added again)',
};

// Work kinds that prepare a brief (slice E3 adds the run; until then no row
// has one, and the preparation subtotal counts no row).
const PREPARATION_WORK_KINDS = ['brief_preparation'];

const mustProject = (db: Db, project: string): void => {
  if (!db.prepare('SELECT 1 FROM "projects" WHERE "id" = ?').get(project)) throw projectNotFound(project);
};

function iterationRow(db: Db, project: string, iteration: string): IterationRow {
  mustProject(db, project);
  const row = db.prepare('SELECT * FROM "prototype_iterations" WHERE "id" = ? AND "project" = ?').get(iteration, project) as IterationRow | undefined;
  if (!row) throw notFound('iteration', iteration);
  return row;
}

function briefVersion(r: IterationRow): number | null {
  const b = parseJson<{ version?: unknown }>(r.brief_json);
  return typeof b?.version === 'number' ? b.version : null;
}

// The owner's approvals of the iteration's work (R5: the initial paid flow
// has three: preparation, brief and check), by stable relationship, never a
// time window: a decision about the iteration itself, about one of its runs,
// or about a protected proposal one of its runs made; consumed with
// `approve`. Plans published by the prototype policy are no approval.
function ownerApprovals(db: Db, it: IterationRow) {
  const rows = db
    .prepare(
      `SELECT d."id", d."kind", d."consumed_at", d."answer" FROM "decisions" d
       WHERE d."project" = ? AND d."status" = 'consumed' AND (
         (d."subject_type" = 'prototype_iteration' AND d."subject_id" = ?)
         OR (d."subject_type" = 'run' AND d."subject_id" IN (SELECT "id" FROM "runs" WHERE "iteration" = ?))
         OR (d."kind" LIKE 'check_correction_%' AND d."subject_id" IN (SELECT p."id" FROM "protected_proposals" p JOIN "runs" r ON r."id" = p."run" WHERE r."iteration" = ?)))
       ORDER BY d."seq"`,
    )
    .all(it.project, it.id, it.id, it.id) as { id: string; kind: string; consumed_at: string | null; answer: string | null }[];
  const approved = rows.filter((r) => parseJson<{ option?: unknown }>(r.answer)?.option === 'approve');
  const byKind: Record<string, number> = {};
  for (const r of approved) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  return { count: approved.length, by_kind: byKind, decisions: approved.map((r) => ({ id: r.id, kind: r.kind, consumed_at: r.consumed_at })) };
}

// Approval of each preparation to its run's end (R5), summed over the
// preparations whose run ended; null while none has.
function preparationSeconds(db: Db, it: IterationRow): number | null {
  const rows = db
    .prepare(
      `SELECT d."consumed_at", r."finished_at" FROM "decisions" d
       JOIN "work_items" w ON w."kind" = 'brief_preparation' AND json_extract(w."subject", '$.decision') = d."id"
       JOIN "runs" r ON r."work_item" = w."id"
       WHERE d."kind" = 'prototype_preparation_approval' AND d."subject_id" = ? AND d."status" = 'consumed' AND r."finished_at" IS NOT NULL
       ORDER BY r."seq"`,
    )
    .all(it.id) as { consumed_at: string | null; finished_at: string }[];
  let total: number | null = null;
  for (const r of rows) {
    const s = between(r.consumed_at, r.finished_at, ['the preparation authorized', 'its run ended']);
    if (typeof s === 'number') total = (total ?? 0) + s;
  }
  return total;
}

function summaryOf(r: IterationRow) {
  return {
    id: r.id,
    seq: r.seq,
    mode: r.mode,
    status: r.status,
    predecessor: r.predecessor,
    // Slice E4: the owner's change request an Iterate gave (null for a
    // first iteration or none given).
    change: r.change_text,
    brief: { spec_revision: r.brief_spec_revision, decision: r.brief_decision, record: r.brief_record, version: briefVersion(r) },
    next_step: r.next_step,
    created_at: r.created_at,
    approved_at: r.approved_at,
    alpha_at: r.alpha_at,
    ended_at: r.ended_at,
  };
}

// GET /v1/projects/:p/iterations
export function listIterations(db: Db, args: { project: string }) {
  mustProject(db, args.project);
  const head = envelope(db);
  const rows = db.prepare('SELECT * FROM "prototype_iterations" WHERE "project" = ? ORDER BY "seq"').all(args.project) as IterationRow[];
  return { ...head, iterations: rows.map(summaryOf) };
}

const addKnown = (a: number | null, b: number | null): number | null => (b === null ? a : a === null ? b : a + b);
const money = (v: number): number => Math.round(v * 1e9) / 1e9;

type UsageState = 'complete' | 'pending' | 'incomplete' | 'not_launched';

interface InvocationView {
  id: string;
  turn: string | null;
  status: string | null;
  usage: { state: UsageState; billable_in: number | null; cached_in: number | null; out: number | null; normalization_version: string | null; raw_categories: Record<string, unknown> | null; corrections: number };
  cost: { status: string; usd: number | null; pricing_basis: string | null };
  unknown_allowance_tokens: number | null;
  // What a pending invocation still reserves beyond what it observed (the
  // ledger's outstanding reservation); null once it is charged.
  reserved_tokens: number | null;
  model_requested: string;
  model_observed: string | null;
  provider: string;
  // Slice E5 (S5): the effective allowance fixed on the receipt at dispatch,
  // the lower of the per-run limit and what the iteration had left (for a
  // session turn, the session's cumulative bound), and which one limited it;
  // null on a receipt that fixed none.
  effective_limit_tokens: number | null;
  limited_by: 'run' | 'iteration' | null;
  run_limit_tokens: number | null;
}

// One invocation as the ledger knows it: its rows folded (ledger.ts fold)
// once charged; what it observed so far while under way (`pending`); and
// `not_launched` when it was refused before launch, which the ledger charges
// nothing and records no row for (runs.ts finishRun).
function invocationOf(db: Db, project: string, receipt: { id: string; turn: string | null; provider: string; model_requested: string }): InvocationView {
  const statusRow = db.prepare('SELECT "status" FROM "invocation_status_observations" WHERE "invocation" = ? ORDER BY rowid DESC LIMIT 1').get(receipt.id) as { status: string } | undefined;
  const status = statusRow?.status ?? null;
  const rows = db.prepare('SELECT * FROM "ledger_rows" WHERE "invocation" = ? ORDER BY rowid').all(receipt.id) as LedgerRow[];
  const original = rows.find((r) => r.corrects === null);
  const allowance = receiptAllowance(db, receipt.id);
  const base = {
    id: receipt.id,
    turn: receipt.turn,
    status,
    model_requested: receipt.model_requested,
    provider: receipt.provider,
    effective_limit_tokens: allowance?.effective_limit_tokens ?? null,
    limited_by: allowance?.limited_by ?? null,
    run_limit_tokens: allowance?.run_limit_tokens ?? null,
  };
  if (original) {
    const a: Account = fold(rows);
    const estimated = a.cost_status === 'estimated';
    const plus = original.normalization_version.indexOf('+');
    return {
      ...base,
      usage: {
        state: a.usage_complete ? 'complete' : 'incomplete',
        billable_in: a.billable_in,
        cached_in: a.cached_in,
        out: a.out,
        normalization_version: original.normalization_version,
        raw_categories: parseJson<Record<string, unknown>>(original.raw_usage),
        corrections: rows.length - 1,
      },
      cost: { status: a.cost_status, usd: a.cost_usd, pricing_basis: estimated ? (plus >= 0 ? original.normalization_version.slice(plus + 1) : original.normalization_version) : null },
      unknown_allowance_tokens: a.unknown_allowance_tokens,
      reserved_tokens: null,
      model_observed: rows.at(-1)!.model_observed ?? original.model_observed,
    };
  }
  if (status === 'refused') {
    return {
      ...base,
      usage: { state: 'not_launched', billable_in: null, cached_in: null, out: null, normalization_version: null, raw_categories: null, corrections: 0 },
      cost: { status: 'not_launched', usd: null, pricing_basis: null },
      unknown_allowance_tokens: null,
      reserved_tokens: null,
      model_observed: null,
    };
  }
  // Under way: what it observed so far, a lower bound; its cost unknown
  // until charged (only a reported figure is shown as it arrives, as the
  // day check counts it).
  const so = observedSoFar(db, receipt.id);
  const raw = (db.prepare('SELECT "semantics", "raw" FROM "usage_observations" WHERE "invocation" = ? ORDER BY "seq"').all(receipt.id) as { semantics: string; raw: string }[]).length;
  return {
    ...base,
    usage: { state: 'pending', billable_in: so.billable_in, cached_in: so.cached_in, out: so.out, normalization_version: raw === 0 ? null : so.normalization_version, raw_categories: null, corrections: 0 },
    cost: so.cost_status === 'reported' ? { status: 'reported', usd: so.cost_usd, pricing_basis: null } : { status: 'unknown', usd: null, pricing_basis: null },
    unknown_allowance_tokens: null,
    reserved_tokens: outstandingReservation(db, receipt.id, project, so),
    model_observed: so.model_observed,
  };
}

interface RunRow {
  id: string;
  role: string;
  kind: string;
  work_item: string | null;
  work_kind: string | null;
  outcome: string | null;
  reason_class: string | null;
  started_at: string | null;
  finished_at: string | null;
}

const durationMs = (from: string | null, to: string | null): number | null => {
  const s = between(from, to, ['the run started', 'the run finished']);
  return typeof s === 'number' ? Math.round(s * 1000) : null;
};

function tokenTotals(invs: InvocationView[]) {
  let billableIn: number | null = null;
  let cachedIn: number | null = null;
  let out: number | null = null;
  for (const i of invs) {
    billableIn = addKnown(billableIn, i.usage.billable_in);
    cachedIn = addKnown(cachedIn, i.usage.cached_in);
    out = addKnown(out, i.usage.out);
  }
  const counted = invs.filter((i) => i.usage.state !== 'not_launched');
  const providers = [...new Set(counted.map((i) => i.provider))].sort();
  const notExclusive = providers.filter((p) => !EXCLUSIVE_CATEGORIES[p]);
  const partial = counted.filter((i) => i.usage.state !== 'complete').length;
  let total: number | null = null;
  let totalReason: string | null = null;
  if (notExclusive.length > 0) totalReason = `the categories of ${notExclusive.join(', ')} are not known to be mutually exclusive, so no total is stated`;
  else if (billableIn === null && cachedIn === null && out === null) totalReason = counted.length === 0 ? 'no invocation has run' : 'no token count of any invocation is known';
  else if (billableIn === null || cachedIn === null || out === null) totalReason = 'a category is known for no invocation, so its part of the total is not known';
  else total = billableIn + cachedIn + out;
  return {
    billable_in: billableIn,
    cached_in: cachedIn,
    out,
    // billable_in + cached_in + out, only where every provider's categories
    // are mutually exclusive (R9); a lower bound while any invocation is
    // pending or incomplete (its unknown allowance is apart, below).
    total,
    total_reason: totalReason,
    total_is: total === null ? null : partial > 0 ? 'lower_bound' : 'complete',
    normalization: Object.fromEntries(providers.filter((p) => EXCLUSIVE_CATEGORIES[p]).map((p) => [p, EXCLUSIVE_CATEGORIES[p]])),
  };
}

function costTotals(invs: InvocationView[]) {
  let reported: number | null = null;
  let estimated: number | null = null;
  for (const i of invs) {
    if ((i.cost.status === 'reported' || i.cost.status === 'measured_zero') && i.usage.state !== 'pending') reported = addKnown(reported, i.cost.usd);
    if (i.cost.status === 'estimated') estimated = addKnown(estimated, i.cost.usd);
  }
  return {
    reported_usd: reported === null ? null : money(reported),
    estimated_usd: estimated === null ? null : money(estimated),
    unknown_invocations: invs.filter((i) => i.usage.state !== 'pending' && i.cost.status === 'unknown').length,
    pending_invocations: invs.filter((i) => i.usage.state === 'pending').length,
    pricing_bases: [...new Set(invs.map((i) => i.cost.pricing_basis).filter((b): b is string => b !== null))].sort(),
  };
}

// Whether an Alpha deployment is available now (R7): the iteration's
// candidate still `alpha_deployed`, the deployment running in the
// environment now its candidate's (slice E5: a later iteration's deployment
// that replaced it, or a teardown, leaves no claim), and the newest
// installed observation of its environment taken of the environment's
// current generation within the project's freshness bound. Otherwise null:
// never inferred from the historical outcome.
function alphaNow(db: Db, project: string, it: IterationRow, environment: string | null) {
  if (it.candidate === null || environment === null) return null;
  const c = db.prepare('SELECT "progress" FROM "candidates" WHERE "id" = ?').get(it.candidate) as { progress: string } | undefined;
  if (c?.progress !== 'alpha_deployed') return null;
  const running = currentDeploymentRequest(db, environment);
  const runningCandidate = running === null ? null : ((db.prepare('SELECT "candidate" FROM "deployment_requests" WHERE "id" = ?').get(running) as { candidate: string } | undefined)?.candidate ?? null);
  if (runningCandidate !== it.candidate) return null;
  const env = db.prepare('SELECT "current_generation" FROM "environments" WHERE "id" = ?').get(environment) as { current_generation: number | null } | undefined;
  const obs = db
    .prepare('SELECT "observed_at", "condition", "deployment_generation" FROM "observation_history" WHERE "environment" = ? AND "installed" = 1 ORDER BY "observed_at" DESC, rowid DESC LIMIT 1')
    .get(environment) as { observed_at: string; condition: string; deployment_generation: number | null } | undefined;
  if (!obs || !env || obs.deployment_generation === null || obs.deployment_generation !== env.current_generation) return null;
  const age = nowMs() - Date.parse(obs.observed_at);
  const bound = projectPolicy(db, project).observation_freshness_bound! * 1000;
  if (!Number.isFinite(age) || age < 0 || age > bound) return null;
  return { observed_at: obs.observed_at, healthy: obs.condition === 'healthy', condition: obs.condition };
}

// The statement served with `app_totals` (slice E4; R7, R9): what is summed
// and how, so that nothing is read as more than it is.
export const CUMULATIVE_RULE =
  "The app's totals: every run attributed to any iteration of this project (runs.iteration, fixed when each run was dispatched), each counted once, whatever the iteration's status; the categories, the token total, the cost statuses and the unknown allowances by the same rules as one iteration's totals (a total only where every provider's categories are mutually exclusive, a lower bound while any invocation's usage is pending or incomplete; unknown never 0). A run dispatched while no iteration was open is in no iteration and not counted. Each iteration's own totals exclude its predecessors.";

// The app's totals over every iteration of the project (slice E4): the
// project's attributed runs' invocations, each once.
function appTotals(db: Db, project: string) {
  const runRows = db
    .prepare(`SELECT r."id", r."role" FROM "runs" r JOIN "prototype_iterations" p ON p."id" = r."iteration" WHERE p."project" = ? ORDER BY r."seq"`)
    .all(project) as { id: string; role: string }[];
  const all: InvocationView[] = [];
  for (const r of runRows) {
    const receipts = db.prepare('SELECT "id", "turn", "provider", "model_requested" FROM "invocation_receipts" WHERE "run" = ? ORDER BY rowid').all(r.id) as { id: string; turn: string | null; provider: string; model_requested: string }[];
    for (const x of receipts) all.push(invocationOf(db, project, x));
  }
  const roles: string[] = [];
  for (const r of runRows) if (!roles.includes(r.role)) roles.push(r.role);
  const completeness = { complete: 0, pending: 0, incomplete: 0, not_launched: 0 };
  for (const i of all) completeness[i.usage.state] += 1;
  const cost = costTotals(all);
  const iterations = (db.prepare('SELECT COUNT(*) AS n FROM "prototype_iterations" WHERE "project" = ?').get(project) as { n: number }).n;
  return {
    iterations,
    agent_runs: runRows.length,
    roles_used: roles,
    invocations: all.length,
    tokens: tokenTotals(all),
    completeness,
    cost: { reported_usd: cost.reported_usd, estimated_usd: cost.estimated_usd, unknown_invocations: cost.unknown_invocations, pending_invocations: cost.pending_invocations, pricing_bases: cost.pricing_bases },
    unknown_allowance_tokens: all.reduce<number | null>((s, i) => addKnown(s, i.unknown_allowance_tokens), null),
    cumulative_rule: CUMULATIVE_RULE,
  };
}

// GET /v1/projects/:p/iterations/:i
export function readIteration(db: Db, args: { project: string; iteration: string }) {
  const it = iterationRow(db, args.project, args.iteration);
  const head = envelope(db);
  const limits = parseJson<Record<string, number>>(it.limits_json) ?? {};

  const runRows = db
    .prepare(
      `SELECT r."id", r."role", r."kind", r."work_item", w."kind" AS "work_kind", r."outcome", r."reason_class", r."started_at", r."finished_at"
       FROM "runs" r LEFT JOIN "work_items" w ON w."id" = r."work_item" WHERE r."iteration" = ? ORDER BY r."seq"`,
    )
    .all(it.id) as RunRow[];
  const all: InvocationView[] = [];
  const prep: InvocationView[] = [];
  const runs = runRows.map((r) => {
    const receipts = db.prepare('SELECT "id", "turn", "provider", "model_requested" FROM "invocation_receipts" WHERE "run" = ? ORDER BY rowid').all(r.id) as { id: string; turn: string | null; provider: string; model_requested: string }[];
    const invocations = receipts.map((x) => invocationOf(db, args.project, x));
    all.push(...invocations);
    if (r.work_kind !== null && PREPARATION_WORK_KINDS.includes(r.work_kind)) prep.push(...invocations);
    return {
      id: r.id,
      role: r.role,
      kind: r.kind,
      work_item: r.work_item,
      work_kind: r.work_kind,
      outcome: r.outcome,
      reason_class: r.reason_class,
      started_at: r.started_at,
      finished_at: r.finished_at,
      duration_ms: durationMs(r.started_at, r.finished_at),
      invocations,
    };
  });

  const roles: string[] = [];
  for (const r of runRows) if (!roles.includes(r.role)) roles.push(r.role);
  const completeness = { complete: 0, pending: 0, incomplete: 0, not_launched: 0 };
  for (const i of all) completeness[i.usage.state] += 1;
  const allowance = all.reduce<number | null>((s, i) => addKnown(s, i.unknown_allowance_tokens), null);
  const tokens = tokenTotals(all);
  const cost = costTotals(all);
  const prepRuns = runRows.filter((r) => r.work_kind !== null && PREPARATION_WORK_KINDS.includes(r.work_kind)).length;
  const prepTokens = tokenTotals(prep);
  const prepCost = costTotals(prep);

  // Remaining (R4): the limit less what the iteration committed, by the one
  // account the dispatch check uses (store/transitions/prototype.ts
  // iterationAccount): each charged invocation its billable tokens and its
  // unknown allowance in force; each invocation under way what it observed
  // plus what it still reserves (ledger.ts outstandingReservation). A
  // charged invocation whose billable tokens are unknown and carries no
  // allowance leaves the remainder unknown, never full.
  const account = iterationAccount(db, args.project, it.id);
  const spentUsd = money((account.reported_usd ?? 0) + (account.estimated_usd ?? 0));
  const now = nowIso();
  const runtimeEnd = it.alpha_at ?? it.ended_at ?? now;
  const runtimeUsed = it.approved_at === null ? null : between(it.approved_at, runtimeEnd, ['the brief approved', 'now']);
  const limit = (k: (typeof PROTOTYPE_LIMIT_KEYS)[number]) => (typeof limits[k] === 'number' ? limits[k]! : null);
  const tokensLimit = limit('prototype_budget_tokens');
  const usdLimit = limit('prototype_budget_usd_estimated');
  const runtimeLimit = limit('prototype_runtime_seconds');
  const repairsLimit = limit('prototype_repairs_per_iteration');
  const policy = projectPolicy(db, args.project);
  // What the next dispatch of a run would meet now (a one-shot's ask: its
  // run limit, no repair), only while the iteration is the project's current
  // and open one: the check itself (prototype.ts iterationVerdict).
  const current = currentIteration(db, args.project);
  const nextAsk = { reservation: policy.budget_run_billable_tokens!, repair: false, item_repairs: 0, work_item: null };
  const open = current?.id === it.id && OPEN_ITERATION_STATUSES.includes(current.status);
  const verdict = open ? iterationVerdict(db, it as Parameters<typeof iterationVerdict>[1], nextAsk, account) : null;
  // Slice E5 (S5): what a run dispatched now would be given.
  const nextAllowance = open ? effectiveAllowanceOf(db, it as Parameters<typeof effectiveAllowanceOf>[1], nextAsk.reservation, account) : null;
  const unknown = unknownAccountingText(account);
  const remaining = {
    tokens: tokensLimit === null ? null : unknown !== null ? null : tokensLimit - account.committed_tokens,
    // Slice E5 (S2): what is unknown, named.
    tokens_reason: unknown,
    // What the tokens remaining is the limit less: settled, the unknown
    // allowances apart, and what runs under way observed and still reserve.
    committed: {
      settled_tokens: account.settled_tokens,
      unknown_allowance_tokens: account.unknown_allowance_tokens,
      under_way_observed_tokens: account.under_way_observed_tokens,
      under_way_reserved_tokens: account.outstanding_reservation_tokens,
      total_tokens: account.unknown_billable_invocations > 0 ? null : account.committed_tokens,
    },
    // Slice E5 (S5): what a run dispatched now would be given and reserve
    // of it, its effective allowance (the lower of the per-run limit and
    // what the iteration has left); null when it would get none (or the
    // iteration is not open), next_dispatch saying why.
    next_run_reservation_tokens: nextAllowance?.effective_limit_tokens ?? null,
    next_run_limited_by: nextAllowance?.limited_by ?? null,
    run_limit_tokens: nextAsk.reservation,
    // Settled reported and estimated cost only: an invocation under way adds
    // what it costs once charged; one whose cost is unknown leaves the
    // remainder unknown. A threshold, never a billing cap.
    usd_estimated: usdLimit === null ? null : account.unknown_cost_invocations > 0 ? null : money(usdLimit - spentUsd),
    usd_reason: account.unknown_cost_invocations > 0 ? `${account.unknown_cost_invocations} invocation(s) have unknown cost` : account.under_way_invocations > 0 ? `${account.under_way_invocations} invocation(s) under way are not yet costed` : null,
    usd_label: 'an estimated-cost threshold checked at dispatch, not a billing cap',
    // Approval to Alpha, wall clock; the whole limit before the brief is
    // approved (the runtime has not started).
    runtime_seconds: runtimeLimit === null ? null : runtimeUsed === null ? runtimeLimit : typeof runtimeUsed === 'number' ? runtimeLimit - runtimeUsed : null,
    // The engine's own repair counter of the iteration's work items (D1 §4.3).
    repairs_iteration: repairsLimit === null ? null : repairsLimit - account.repairs_used,
    // Per work item: the lower of this and repair_attempts_max, the hard
    // per-item cap, applies.
    repairs_per_stage: limit('prototype_repairs_per_stage') === null ? null : Math.min(limit('prototype_repairs_per_stage')!, policy.repair_attempts_max!),
    // What the dispatch check says of the next run now: null when it is
    // admitted (or the iteration is not open); `settling` while only the
    // reservations of runs under way stand in its way.
    next_dispatch: verdict === null ? null : { kind: verdict.kind, limit: verdict.limit, reason: verdict.reason },
    ...ENFORCEMENT,
  };

  const request = it.deployment_request === null
    ? null
    : (db.prepare('SELECT d."id", d."environment", e."name" FROM "deployment_requests" d JOIN "environments" e ON e."id" = d."environment" WHERE d."id" = ?').get(it.deployment_request) as
        | { id: string; environment: string; name: string }
        | undefined);
  const interval = (a: string | null, b: string | null, what: [string, string]) => {
    const s = between(a, b, what);
    return typeof s === 'number' ? s : null;
  };

  return {
    ...head,
    iteration: { ...summaryOf(it), limits: { ...Object.fromEntries(PROTOTYPE_LIMIT_KEYS.map((k) => [k, limit(k)])), budget_run_billable_tokens: typeof limits.budget_run_billable_tokens === 'number' ? limits.budget_run_billable_tokens : null } },
    usage: {
      runs,
      totals: {
        agent_runs: runRows.length,
        roles_used: roles,
        invocations: all.length,
        tokens,
        completeness,
        cost: { reported_usd: cost.reported_usd, estimated_usd: cost.estimated_usd, unknown_invocations: cost.unknown_invocations, pending_invocations: cost.pending_invocations, pricing_bases: cost.pricing_bases },
        unknown_allowance_tokens: allowance,
        // Counts of rows: with no preparation run (none exists before slice
        // E3) nothing was spent preparing, which is 0 by count, not an
        // unknown usage shown as zero.
        preparation: prepRuns === 0 ? { runs: 0, tokens: 0, usd: 0 } : { runs: prepRuns, tokens: prepTokens.total, usd: prepCost.unknown_invocations > 0 || prepCost.pending_invocations > 0 ? null : money((prepCost.reported_usd ?? 0) + (prepCost.estimated_usd ?? 0)) },
        setup_qualification: { note: 'charged to the qualification fixture, not to this iteration' },
      },
    },
    remaining,
    // Slice E4: the whole app's totals, every iteration of the project once.
    app_totals: appTotals(db, args.project),
    // The first plan (R1): its bundle and how it was published.
    plan: planOf(db, it),
    owner_approvals: ownerApprovals(db, it),
    time: {
      preparation_seconds: preparationSeconds(db, it),
      approval_to_alpha_seconds: interval(it.approved_at, it.alpha_at, ['the brief approved', 'Alpha reached']),
      elapsed_seconds: interval(it.created_at, it.ended_at ?? now, ['the iteration created', 'now']),
      runtime_limit_seconds: runtimeLimit,
    },
    // Slice E4 (demonstration 9): the iteration's brief, whole, as prepared
    // (and approved, when approved_at is set); null before one is prepared.
    brief: parseJson<Record<string, unknown>>(it.brief_json),
    // What the receipt keeps of the prototype's limits, and what it never
    // claims: Alpha ready means the automated checks passed and the
    // deployment was verified by them; no person's acceptance of the
    // prototype (its use, its look) is recorded by the engine.
    limitations: {
      brief: briefList(it.brief_json, 'limitations'),
      left_out: briefList(it.brief_json, 'left_out'),
      mocked: briefList(it.brief_json, 'mocked'),
      human_acceptance: 'not_recorded',
      statement:
        'Surety records no human acceptance of this prototype. Alpha ready means its automated checks passed and its deployment was verified by them; whether the prototype is acceptable to use or to look at is the owner\'s judgement, not recorded here.',
    },
    outcome: { status: it.status, reason: it.outcome_reason, next_step: it.next_step },
    // What Stop and Discard would do now (slice E2; R4, R8): the console
    // shows these consequences, the confirmation's preview binds them.
    controls: iterationControls(db, it.id),
    alpha: {
      candidate: it.candidate,
      deployment_request: it.deployment_request,
      environment: request ? { id: request.environment, name: request.name } : null,
      deployed_at: it.alpha_at,
      current: alphaNow(db, args.project, it, request?.environment ?? null),
    },
  };
}

// One list of the brief's (null when no brief, or the field is not a list).
function briefList(text: string | null, key: string): string[] | null {
  const b = parseJson<Record<string, unknown>>(text);
  const v = b?.[key];
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
}

// The iteration's first plan: its bundle, its phase plan, and who
// published it (`policy_authorized` by the prototype policy, or the owner's
// approval), as recorded.
function planOf(db: Db, it: IterationRow) {
  if (it.plan_bundle === null) return null;
  const b = db.prepare('SELECT "status", "approvals" FROM "plan_bundles" WHERE "id" = ?').get(it.plan_bundle) as { status: string; approvals: string } | undefined;
  const p = it.phase_plan === null ? undefined : (db.prepare('SELECT "routing", "approved_by" FROM "phase_plans" WHERE "id" = ?').get(it.phase_plan) as { routing: string | null; approved_by: string | null } | undefined);
  return { bundle: it.plan_bundle, bundle_status: b?.status ?? null, approvals: parseJson<Record<string, unknown>>(b?.approvals ?? null), phase_plan: it.phase_plan, routing: p?.routing ?? null, approved_by: p?.approved_by ?? null };
}

// GET /v1/projects/:p/iterations/:i/receipt.json: the iteration read with
// the receipt's own identity. It holds no credential: no key, reference,
// grant or budget snapshot is read into it (and the route redacts every
// secret the engine holds before it is sent).
export function iterationReceipt(db: Db, args: { project: string; iteration: string }) {
  const read = readIteration(db, args);
  return { receipt_version: 1, generated_at: read.served_at, project: args.project, iteration_id: args.iteration, ...read };
}

// The receipt route's answer (on the main thread, where the engine holds its
// secrets): every secret the engine holds redacted, whatever the receipt
// read (which reads none) would carry, and sent as a download.
export function receiptResponse(receipt: unknown, iteration: string): { status: number; body: unknown; headers: Record<string, string> } {
  const safe = iteration.replace(/[^A-Za-z0-9_-]/g, '_');
  return { status: 200, body: redactValue(receipt), headers: { 'content-disposition': `attachment; filename="surety-receipt-${safe}.json"` } };
}
