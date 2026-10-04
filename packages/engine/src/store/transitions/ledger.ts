// The ledger and budgets (D1 §§3.6, 13; E16b; Review N04; SEAM.md §§53-55).
//
// Usage arrives as observations; an invocation's observations fold key by
// key into one raw usage object, which the provider's normalization turns
// into the amounts of its one original ledger row. Unknown is null, never
// zero. A later correction is a delta row with a fixed identity, linked to
// the original. The fold of an invocation's rows gives its account, and the
// accounts give the totals and the budgets' spend.

import { nowIso } from '../../clock.js';
import { seamBudgetRead } from '../../testing/seam.js';
import { Refusal } from '../../refusal.js';
import { illegal, notFound } from './common.js';
import { projectPolicy } from './settings.js';
import type { Tx } from './tx.js';

type Db = Tx['db'];

export type CostStatus = 'reported' | 'estimated' | 'unknown' | 'measured_zero';

// ---- the scripted provider's normalization (SEAM.md §53) ------------------------

export const NORMALIZATION = 'scripted-1';

// The one labeled rule by which a cost that was not reported becomes an
// estimate: USD per million tokens, by model.
const PRICE_TABLE = { version: 'scripted-prices-1', models: { 'scripted-priced': { billable_in: 2, cached_in: 0.5, out: 8 } } as Record<string, { billable_in: number; cached_in: number; out: number }> };

export interface Amounts {
  billable_in: number | null;
  cached_in: number | null;
  out: number | null;
}

export interface Normalized extends Amounts {
  model_observed: string | null;
  cost_status: CostStatus;
  cost_usd: number | null;
  normalization_version: string;
}

const amount = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

// Money is summed in floating point; a total is rounded to a nanodollar so
// that a sum of two reported amounts reads as the amount stated.
const money = (v: number): number => Math.round(v * 1e9) / 1e9;

export function amountsOf(raw: Record<string, unknown>): Amounts {
  // Cache reads are never added to billable input (D1 §13.2).
  return { billable_in: amount(raw.input_tokens), cached_in: amount(raw.cache_read_tokens), out: amount(raw.output_tokens) };
}

export function normalize(raw: Record<string, unknown>): Normalized {
  const a = amountsOf(raw);
  const model = typeof raw.model === 'string' ? raw.model : null;
  const base = { ...a, model_observed: model, normalization_version: NORMALIZATION };
  if (typeof raw.cost_usd === 'number' && Number.isFinite(raw.cost_usd) && raw.cost_usd >= 0) {
    return raw.cost_usd > 0 ? { ...base, cost_status: 'reported', cost_usd: raw.cost_usd } : { ...base, cost_status: 'measured_zero', cost_usd: 0 };
  }
  const prices = model === null ? undefined : PRICE_TABLE.models[model];
  if (prices && a.billable_in !== null && a.cached_in !== null && a.out !== null) {
    const usd = (a.billable_in * prices.billable_in + a.cached_in * prices.cached_in + a.out * prices.out) / 1_000_000;
    return { ...base, cost_status: 'estimated', cost_usd: money(usd), normalization_version: `${NORMALIZATION}+${PRICE_TABLE.version}` };
  }
  return { ...base, cost_status: 'unknown', cost_usd: null };
}

// ---- Claude Code's normalization (D2 §§1.5, 4.5; invoke/adapters/claude.ts) ----------
//
// The adapter's observations keep the provider's own names: per API call,
// `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`
// (delta); at the end, the same with `output_tokens` and `total_cost_usd`
// (cumulative, replacing the increments in the fold) and `usage_final`.
// Billable input is input plus cache creation, both billed as input; cache
// reads are never billable (D1 §13.2). A count not reported is unknown, and
// so is a sum that needs it. The cost is `reported` when the backend gave
// `total_cost_usd` (D2 §4.5); with no price table for the provider it is
// otherwise unknown, never zero.
export const CLAUDE_NORMALIZATION = 'claude-stream-json-1';

// The price table for a cost Claude Code did not report (D1 §13.2, D2 C4;
// SEAM.md §161): USD per million tokens, by model, its version on every
// estimated row. The figures are Anthropic's first-party list rates as the
// Claude API reference gave them on 2026-09-25, pinned by the Verifier and
// pending Sean's confirmation on his console; billable input (input plus
// cache creation) at the input rate. An estimate is never a maximum.
// Cache writes at their own rate: 1.25 times the input rate (Anthropic's
// list multiplier for five-minute cache writes), labelled as derived, where
// the table gives none of its own (E74 item 3).
export const CLAUDE_PRICE_TABLE = {
  version: 'anthropic-list-2026-09-25-unconfirmed+cache-write-1.25x-input-derived',
  models: { 'claude-sonnet-5-5': { input: 2, cache_write: 2.5, cached_in: 0.2, out: 10 } } as Record<string, { input: number; cache_write?: number; cached_in: number; out: number }>,
};

function normalizeClaude(raw: Record<string, unknown>): Normalized {
  const input = amount(raw.input_tokens);
  const creation = amount(raw.cache_creation_input_tokens);
  const base = {
    billable_in: input === null || creation === null ? null : input + creation,
    cached_in: amount(raw.cache_read_input_tokens),
    out: amount(raw.output_tokens),
    model_observed: typeof raw.model === 'string' ? raw.model : null,
    normalization_version: CLAUDE_NORMALIZATION,
  };
  const cost = raw.total_cost_usd;
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) return cost > 0 ? { ...base, cost_status: 'reported', cost_usd: cost } : { ...base, cost_status: 'measured_zero', cost_usd: 0 };
  // Under the subscription token (E74 item 1) the figure Claude Code
  // reports is its own client-side estimate: recorded `estimated`, labelled.
  const estimate = raw.total_cost_usd_estimate;
  if (typeof estimate === 'number' && Number.isFinite(estimate) && estimate >= 0) {
    return { ...base, cost_status: 'estimated', cost_usd: estimate, normalization_version: `${CLAUDE_NORMALIZATION}+claude-code-total_cost_usd` };
  }
  // The price of the one model the invocation used, where the table has it
  // and the usage is final (a partial count, a per-call output count among
  // them, is a lower bound and never priced as the whole); cache writes at
  // their own rate.
  const prices = base.model_observed === null ? undefined : CLAUDE_PRICE_TABLE.models[base.model_observed];
  if (prices && raw.usage_final === true && input !== null && creation !== null && base.cached_in !== null && base.out !== null) {
    const usd = (input * prices.input + creation * (prices.cache_write ?? prices.input * 1.25) + base.cached_in * prices.cached_in + base.out * prices.out) / 1_000_000;
    return { ...base, cost_status: 'estimated', cost_usd: money(usd), normalization_version: `${CLAUDE_NORMALIZATION}+${CLAUDE_PRICE_TABLE.version}` };
  }
  return { ...base, cost_status: 'unknown', cost_usd: null };
}

// The most a qualification attempt's canaries can cost in billable tokens,
// as an estimate (D2 §7.2, Q7; SEAM.md §161): three canaries, each at the
// fixture project's run limit, priced at the model's output rate (the
// highest); null where the model has no price (never 0). An estimate, never
// a maximum: cache reads and the overshoot to each canary's deadline are
// outside it (D2 §4.2).
export function attemptSpendEstimate(provider: string, model: string, runLimitTokens: number): { usd: number; price_version: string } | null {
  const prices = provider === 'claude' ? CLAUDE_PRICE_TABLE.models[model] : undefined;
  if (!prices) return null;
  return { usd: money((3 * runLimitTokens * prices.out) / 1_000_000), price_version: CLAUDE_PRICE_TABLE.version };
}

// The provider's normalization; the scripted one for every provider without
// its own.
export function normalizeFor(provider: string, raw: Record<string, unknown>): Normalized {
  return provider === 'claude' ? normalizeClaude(raw) : normalize(raw);
}

// Whether an invocation's observations include its terminal usage: for
// Claude Code, the result's totals (`usage_final`); a stream that ended
// without them is incomplete whatever per-call usage it carried. Other
// providers as M1 had it.
export function terminalUsageObserved(provider: string, raw: Record<string, unknown>): boolean {
  return provider === 'claude' ? raw.usage_final === true : true;
}

const providerOf = (db: Db, invocation: string): string =>
  (db.prepare('SELECT "provider" FROM "invocation_receipts" WHERE "id" = ?').get(invocation) as { provider: string } | undefined)?.provider ?? 'scripted';

const NOTHING_OBSERVED: Normalized = { billable_in: null, cached_in: null, out: null, model_observed: null, cost_status: 'unknown', cost_usd: null, normalization_version: NORMALIZATION };

// An invocation's observations folded key by key: for cumulative ones the
// value of the latest observation that carries the key; for delta ones the
// sum of the numbers over those that carry it (SEAM.md §53).
// A null never replaces a count already known (the slice-14 review's S1):
// an observation that does not know a count says nothing of it.
export function foldObservations(observations: { semantics: string; raw: Record<string, unknown> }[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const o of observations) {
    for (const [key, value] of Object.entries(o.raw)) {
      if ((value === null || value === undefined) && typeof out[key] === 'number') continue;
      if (o.semantics === 'delta' && typeof value === 'number' && typeof out[key] === 'number') out[key] = (out[key] as number) + value;
      else out[key] = value;
    }
  }
  return out;
}

function observationsOf(db: Db, invocation: string): { semantics: string; raw: Record<string, unknown> }[] {
  return (db.prepare('SELECT "semantics", "raw" FROM "usage_observations" WHERE "invocation" = ? ORDER BY "seq"').all(invocation) as { semantics: string; raw: string }[]).map((o) => ({
    semantics: o.semantics,
    raw: JSON.parse(o.raw) as Record<string, unknown>,
  }));
}

// What the engine knows of an invocation under way, from its observations.
function observedSoFar(db: Db, invocation: string): Normalized {
  const obs = observationsOf(db, invocation);
  return obs.length === 0 ? NOTHING_OBSERVED : normalizeFor(providerOf(db, invocation), foldObservations(obs));
}

// ---- the original row (D1 §13.1; SEAM.md §53) ------------------------------------

// Outcomes in which the engine, not the role, ended the invocation: what was
// observed is kept, and the remainder is unknown.
const ENGINE_ENDED = ['stopped', 'timed_out', 'abandoned', 'recovered'];

export function chargeInvocation(
  tx: Tx,
  run: { id: string; project: string; role: string; backend: string; model_requested: string; outcome: string | null },
  receipt: { id: string; turn: string | null },
): void {
  const exists = tx.db.prepare('SELECT 1 FROM "ledger_rows" WHERE "invocation" = ? AND "corrects" IS NULL').get(receipt.id);
  if (exists) return;
  const obs = observationsOf(tx.db, receipt.id);
  const raw = foldObservations(obs);
  const n = obs.length === 0 ? NOTHING_OBSERVED : normalizeFor(run.backend, raw);
  const complete = obs.length > 0 && !ENGINE_ENDED.includes(run.outcome ?? '') && terminalUsageObserved(run.backend, raw) ? 1 : 0;
  const allowance = complete === 1 ? null : unknownAllowance(tx.db, receipt.id, run.project, n, obs.length, ENGINE_ENDED.includes(run.outcome ?? ''));
  const id = tx.newId('led_');
  tx.db
    .prepare(
      `INSERT INTO "ledger_rows" ("id", "created_at", "project", "invocation", "run", "turn", "role", "provider", "model_requested", "model_observed", "raw_usage",
         "normalization_version", "billable_in", "cached_in", "out", "usage_complete", "cost_status", "cost_usd", "day_utc", "unknown_allowance_tokens")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      tx.at,
      run.project,
      receipt.id,
      run.id,
      receipt.turn,
      run.role,
      run.backend,
      run.model_requested,
      n.model_observed,
      JSON.stringify(raw),
      n.normalization_version,
      n.billable_in,
      n.cached_in,
      n.out,
      complete,
      n.cost_status,
      n.cost_usd,
      tx.at.slice(0, 10),
      allowance,
    );
  tx.emit(
    'ledger.row',
    { project: run.project, run: run.id, invocation: receipt.id },
    { ledger_row: id, observations: obs.length, cost_status: n.cost_status, usage_complete: complete === 1, unknown_allowance_tokens: allowance },
  );
}

// The run's token limit as its receipt fixed it at dispatch, or the
// project's current one where the receipt holds none.
function runLimit(db: Db, invocation: string, project: string): number {
  const row = db.prepare('SELECT "budget_snapshot" FROM "invocation_receipts" WHERE "id" = ?').get(invocation) as { budget_snapshot: string } | undefined;
  const snapshot = row ? (JSON.parse(row.budget_snapshot) as { budget_run_billable_tokens?: unknown }) : {};
  return typeof snapshot.budget_run_billable_tokens === 'number' ? snapshot.budget_run_billable_tokens : projectPolicy(db, project).budget_run_billable_tokens!;
}

// C4's unknown allowance (D2 §§1.5, 5 C4; E58 item 9; SEAM.md §120 as
// amended by the slice-10 review's S2): an invocation whose usage is
// incomplete is charged, once, on its original row, the run's
// budget_run_billable_tokens less the billable tokens observed, not below
// zero. Every incomplete invocation of a trust entry's backend (or of a real
// backend's qualification canary) is charged,
// however it ended (a failure on its own with no usage event as much as a
// cancellation). One of the scripted provider is charged when the engine
// ended it after at least one observation: an M1 scripted role that reports
// none is a provider that said nothing, as M1 accepted.
function unknownAllowance(db: Db, invocation: string, project: string, n: Amounts, observations: number, engineEnded: boolean): number | null {
  const receipt = db.prepare('SELECT "trust_entry", "qualification_attempt", "provider" FROM "invocation_receipts" WHERE "id" = ?').get(invocation) as
    | { trust_entry: string | null; qualification_attempt: string | null; provider: string }
    | undefined;
  // A real backend's invocation: under a trust entry, or a canary of an
  // attempt for a backend other than the scripted one (D2 §7.2: a canary is
  // charged to the ordinary ledger, its incomplete usage as any other).
  const real = (receipt?.trust_entry ?? null) !== null || ((receipt?.qualification_attempt ?? null) !== null && receipt?.provider !== 'scripted');
  if (!real && (observations === 0 || !engineEnded)) return null;
  return Math.max(0, runLimit(db, invocation, project) - (billable(n) ?? 0));
}

// ---- corrections (SEAM.md §54) ---------------------------------------------------

export interface LedgerRow extends Amounts {
  unknown_allowance_tokens?: number | null;
  id: string;
  created_at: string;
  project: string;
  invocation: string;
  run: string;
  turn: string | null;
  role: string;
  provider: string;
  model_requested: string;
  model_observed: string | null;
  raw_usage: string;
  normalization_version: string;
  usage_complete: number;
  cost_status: CostStatus;
  cost_usd: number | null;
  day_utc: string;
  corrects: string | null;
  correction_seq: number | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// Append the correction (invocation, correction_seq) once. Sent again, with
// whatever body, it is the row that exists, and nothing is written.
export function appendCorrection(tx: Tx, args: { invocation: unknown; correction_seq: unknown; raw: unknown; usage_complete?: unknown }): { id: string; created: boolean } {
  const invalid = (field: string, what: string) => new Refusal(400, 'invalid_value', `"${field}" must be ${what}.`, 'Correct the request; nothing was written.', { field });
  if (typeof args.invocation !== 'string') throw invalid('invocation', 'an invocation id');
  if (typeof args.correction_seq !== 'number' || !Number.isInteger(args.correction_seq) || args.correction_seq < 1) throw invalid('correction_seq', 'a positive integer');
  if (!isObject(args.raw)) throw invalid('raw', 'an object');
  if (args.usage_complete !== undefined && typeof args.usage_complete !== 'boolean') throw invalid('usage_complete', 'a boolean');
  const existing = tx.db.prepare('SELECT "id" FROM "ledger_rows" WHERE "invocation" = ? AND "correction_seq" = ?').get(args.invocation, args.correction_seq) as { id: string } | undefined;
  if (existing) return { id: existing.id, created: false };
  const rows = tx.db.prepare('SELECT * FROM "ledger_rows" WHERE "invocation" = ? ORDER BY "correction_seq" IS NOT NULL, "correction_seq"').all(args.invocation) as LedgerRow[];
  const original = rows.find((r) => r.corrects === null);
  if (!original) throw notFound('charged invocation', args.invocation);
  const last = rows.at(-1)!;
  const next = (last.correction_seq ?? 0) + 1;
  if (args.correction_seq !== next) throw illegal(`Correction ${args.correction_seq} of an invocation whose next correction is ${next}`, { invocation: args.invocation, next });
  const raw = args.raw;
  const a = amountsOf(raw);
  const reported = typeof raw.cost_usd === 'number' && Number.isFinite(raw.cost_usd);
  const id = tx.newId('led_');
  tx.db
    .prepare(
      `INSERT INTO "ledger_rows" ("id", "created_at", "project", "invocation", "run", "turn", "role", "provider", "model_requested", "model_observed", "raw_usage",
         "normalization_version", "billable_in", "cached_in", "out", "usage_complete", "cost_status", "cost_usd", "day_utc", "corrects", "correction_seq")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      tx.at,
      original.project,
      original.invocation,
      original.run,
      original.turn,
      original.role,
      original.provider,
      original.model_requested,
      typeof raw.model === 'string' ? raw.model : null,
      JSON.stringify(raw),
      NORMALIZATION,
      a.billable_in,
      a.cached_in,
      a.out,
      args.usage_complete === undefined ? last.usage_complete : args.usage_complete ? 1 : 0,
      reported ? 'reported' : last.cost_status,
      reported ? (raw.cost_usd as number) : null,
      original.day_utc,
      original.id,
      args.correction_seq,
    );
  tx.emit('ledger.correction', { project: original.project, run: original.run, invocation: original.invocation }, { ledger_row: id, corrects: original.id, correction_seq: args.correction_seq });
  return { id, created: true };
}

// ---- the fold and the totals (SEAM.md §54) -----------------------------------------

export interface Account extends Amounts {
  invocation: string;
  role: string;
  day: string;
  cost_status: CostStatus;
  cost_usd: number | null;
  usage_complete: boolean;
  // The unknown allowance in force (C4): the original row's, reconciled by
  // the corrections since, without changing it. 0 once a correction says the
  // usage is complete; never below zero; null where none was charged.
  unknown_allowance_tokens: number | null;
}

const addKnown = (a: number | null, b: number | null): number | null => (b === null ? a : a === null ? b : a + b);

// One invocation's rows, original first and corrections in order: amounts
// summed over the rows that know them; status and completeness of the last.
export function fold(rows: LedgerRow[]): Account {
  const sorted = [...rows].sort((x, y) => (x.correction_seq ?? 0) - (y.correction_seq ?? 0));
  const original = sorted[0]!;
  const last = sorted.at(-1)!;
  let acc: Amounts & { cost_usd: number | null } = { billable_in: null, cached_in: null, out: null, cost_usd: null };
  for (const r of sorted) {
    acc = {
      billable_in: addKnown(acc.billable_in, r.billable_in),
      cached_in: addKnown(acc.cached_in, r.cached_in),
      out: addKnown(acc.out, r.out),
      cost_usd: addKnown(acc.cost_usd, r.cost_usd),
    };
  }
  // The allowance in force is the original row's until a correction says
  // the usage is complete, and 0 from then on (SEAM.md §120).
  let allowance: number | null = null;
  if (original.unknown_allowance_tokens !== null && original.unknown_allowance_tokens !== undefined) {
    allowance = sorted.slice(1).some((r) => r.usage_complete === 1) ? 0 : original.unknown_allowance_tokens;
  }
  return {
    invocation: original.invocation,
    role: original.role,
    day: original.day_utc,
    ...acc,
    cost_usd: acc.cost_usd === null ? null : money(acc.cost_usd),
    cost_status: last.cost_status,
    usage_complete: last.usage_complete === 1,
    unknown_allowance_tokens: allowance,
  };
}

function accountsOf(rows: LedgerRow[]): Account[] {
  const by = new Map<string, LedgerRow[]>();
  for (const r of rows) {
    const list = by.get(r.invocation) ?? [];
    list.push(r);
    by.set(r.invocation, list);
  }
  return [...by.values()].filter((list) => list.some((r) => r.corrects === null)).map(fold);
}

// The billable tokens of an account, as far as they are known.
const billable = (a: Amounts): number | null => addKnown(a.billable_in, a.out);

export function totalsOf(accounts: Account[]): Record<string, number | null> {
  const sum = (pick: (a: Account) => number | null, of: Account[] = accounts): number | null => of.reduce<number | null>((s, a) => addKnown(s, pick(a)), null);
  const verified = accounts.filter((a) => a.cost_status === 'reported' || a.cost_status === 'measured_zero');
  const estimated = accounts.filter((a) => a.cost_status === 'estimated');
  const unknown = accounts.filter((a) => a.cost_status === 'unknown');
  const usd = (of: Account[]) => {
    const s = sum((a) => a.cost_usd, of);
    return s === null ? null : money(s);
  };
  return {
    invocations: accounts.length,
    billable_in: sum((a) => a.billable_in),
    cached_in: sum((a) => a.cached_in),
    out: sum((a) => a.out),
    usage_incomplete: accounts.filter((a) => !a.usage_complete).length,
    reported_usd: usd(verified),
    estimated_usd: usd(estimated),
    unknown_cost_invocations: unknown.length,
    unknown_cost_tokens: sum(billable, unknown),
    // C4: the allowances in force (SEAM.md §120); null when none carries one.
    unknown_allowance_tokens: sum((a) => a.unknown_allowance_tokens),
  };
}

const ROW_FIELDS = [
  'id',
  'created_at',
  'invocation',
  'run',
  'turn',
  'role',
  'provider',
  'model_requested',
  'model_observed',
  'normalization_version',
  'billable_in',
  'cached_in',
  'out',
  'usage_complete',
  'cost_status',
  'cost_usd',
  'day_utc',
  'corrects',
  'correction_seq',
  'unknown_allowance_tokens',
] as const;

// GET /v1/projects/:p/ledger (D1 §11.3; SEAM.md §54). A read: it writes nothing.
export function ledgerView(db: Db, args: { project: string; day: string | null }) {
  if (!db.prepare('SELECT 1 FROM "projects" WHERE "id" = ?').get(args.project)) throw notFound('project', args.project);
  let rows = db.prepare('SELECT * FROM "ledger_rows" WHERE "project" = ? ORDER BY rowid').all(args.project) as LedgerRow[];
  if (args.day !== null) {
    const inDay = new Set(rows.filter((r) => r.corrects === null && r.day_utc === args.day).map((r) => r.invocation));
    rows = rows.filter((r) => inDay.has(r.invocation));
  }
  const accounts = accountsOf(rows);
  const byRole: Record<string, Record<string, number | null>> = {};
  for (const role of [...new Set(accounts.map((a) => a.role))].sort()) byRole[role] = totalsOf(accounts.filter((a) => a.role === role));
  return {
    day: args.day,
    rows: rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const key of ROW_FIELDS) out[key] = r[key];
      out.usage_complete = r.usage_complete === 1;
      return out;
    }),
    totals: totalsOf(accounts),
    by_role: byRole,
    budget: { exhausted: exhaustedLimits(db, args.project, { check: false }) },
    // What the project's current day counts against its two day limits (D2
    // §5 C4): reported and estimated cost apart, the estimate never called
    // verified; the unknown-cost tokens and the unknown allowances apart.
    budget_day: budgetDay(db, args.project),
  };
}

// ---- budgets (D1 §13.3; SEAM.md §55) ---------------------------------------------

const DAY_LIMITS = ['budget_day_unknown_tokens', 'budget_day_verified_usd'] as const;

const today = (): string => nowIso().slice(0, 10);

// A project's spend on the current UTC day of the engine's clock (D1 §13.3;
// SEAM.md §55; D2 §5 C4), the invocations under way included, from their
// observations as they arrive:
//   - cost: reported and estimated apart; both count against
//     budget_day_verified_usd, the estimate keeping its label;
//   - unknown tokens: the billable tokens of the invocations whose cost is
//     unknown, and the unknown allowance in force of each invocation whose
//     usage is incomplete; at a dispatch, also the remaining allowance of each
//     invocation under way, so that two dispatches cannot each pass against
//     the same remaining budget.
// `check`: this read is a budget check, and a store failure in it fails the
// check (D1 §6.6). `dispatch`: it is the check at a dispatch.
interface DaySpend {
  day: string;
  reportedUsd: number;
  estimatedUsd: number;
  unknownCostTokens: number;
  allowanceTokens: number;
  runningAllowanceTokens: number;
}

function daySpend(db: Db, project: string, opts: { check: boolean; dispatch?: boolean }): DaySpend {
  if (opts.check) seamBudgetRead(project);
  const day = today();
  const rows = db
    .prepare(
      `SELECT l.* FROM "ledger_rows" l WHERE l."project" = ?
       AND l."invocation" IN (SELECT "invocation" FROM "ledger_rows" WHERE "project" = ? AND "corrects" IS NULL AND "day_utc" = ?)`,
    )
    .all(project, project, day) as LedgerRow[];
  const accounts: (Amounts & { cost_status: CostStatus; cost_usd: number | null; unknown_allowance_tokens: number | null })[] = accountsOf(rows);
  // Invocations under way: launched or about to be, with no terminal
  // observation and so no ledger row yet.
  const underWay = db
    .prepare(
      `SELECT r."id" FROM "invocation_receipts" r WHERE r."project" = ?
       AND NOT EXISTS (SELECT 1 FROM "ledger_rows" l WHERE l."invocation" = r."id")
       AND NOT EXISTS (SELECT 1 FROM "invocation_status_observations" o WHERE o."invocation" = r."id" AND o."status" IN ('ended', 'unknown', 'refused'))`,
    )
    .all(project) as { id: string }[];
  let runningAllowanceTokens = 0;
  for (const u of underWay) {
    const so = observedSoFar(db, u.id);
    // An estimate is the price table's word on a charged invocation, kept on
    // its ledger row with the table's version: an invocation under way counts
    // its reported cost as it arrives, and its estimate once it is charged.
    accounts.push({ ...so, cost_usd: so.cost_status === 'estimated' ? null : so.cost_usd, unknown_allowance_tokens: null });
    if (opts.dispatch) runningAllowanceTokens += Math.max(0, runLimit(db, u.id, project) - (billable(so) ?? 0));
  }
  let unknownCostTokens = 0;
  let allowanceTokens = 0;
  let reportedUsd = 0;
  let estimatedUsd = 0;
  for (const a of accounts) {
    if (a.cost_status === 'unknown') unknownCostTokens += billable(a) ?? 0;
    if ((a.cost_status === 'reported' || a.cost_status === 'measured_zero') && a.cost_usd !== null) reportedUsd += a.cost_usd;
    if (a.cost_status === 'estimated' && a.cost_usd !== null) estimatedUsd += a.cost_usd;
    allowanceTokens += a.unknown_allowance_tokens ?? 0;
  }
  return { day, reportedUsd: money(reportedUsd), estimatedUsd: money(estimatedUsd), unknownCostTokens, allowanceTokens, runningAllowanceTokens };
}

// The ledger read's account of the current day against the day limits.
function budgetDay(db: Db, project: string) {
  const spend = daySpend(db, project, { check: false });
  return {
    day: spend.day,
    // Counted together against budget_day_verified_usd; never called
    // verified together.
    reported_usd: spend.reportedUsd,
    estimated_usd: spend.estimatedUsd,
    // Counted together against budget_day_unknown_tokens.
    unknown_cost_tokens: spend.unknownCostTokens,
    unknown_allowance_tokens: spend.allowanceTokens,
  };
}

// The day limits the project's current day has passed, sorted.
export function exhaustedLimits(db: Db, project: string, opts: { check: boolean; dispatch?: boolean }): string[] {
  const policy = projectPolicy(db, project);
  const spend = daySpend(db, project, opts);
  const over: string[] = [];
  if (spend.unknownCostTokens + spend.allowanceTokens + spend.runningAllowanceTokens > policy.budget_day_unknown_tokens!) over.push('budget_day_unknown_tokens');
  if (money(spend.reportedUsd + spend.estimatedUsd) > policy.budget_day_verified_usd!) over.push('budget_day_verified_usd');
  return over.sort((a, b) => DAY_LIMITS.indexOf(a as (typeof DAY_LIMITS)[number]) - DAY_LIMITS.indexOf(b as (typeof DAY_LIMITS)[number]));
}

// The check on a usage observation (D1 §13.3): the limit the run's
// invocation, or the project's day, has passed with what was observed so
// far; null if none.
export function budgetCheck(db: Db, args: { run: string; invocation: string }): string | null {
  const run = db.prepare('SELECT "project" FROM "runs" WHERE "id" = ?').get(args.run) as { project: string } | undefined;
  if (!run) throw notFound('run', args.run);
  seamBudgetRead(run.project);
  const policy = projectPolicy(db, run.project);
  // An unknown count is never read as zero (E74 item 3): where nothing
  // billable is known after an observation, the budget cannot be judged and
  // the run does not go on without it (D1 §6.6).
  const spent = billable(observedSoFar(db, args.invocation));
  if (spent === null) return 'budget_usage_unknown';
  if (spent > policy.budget_run_billable_tokens!) return 'budget_run_billable_tokens';
  const [day] = exhaustedLimits(db, run.project, { check: false });
  return day ?? null;
}
