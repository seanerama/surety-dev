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

const NOTHING_OBSERVED: Normalized = { billable_in: null, cached_in: null, out: null, model_observed: null, cost_status: 'unknown', cost_usd: null, normalization_version: NORMALIZATION };

// An invocation's observations folded key by key: for cumulative ones the
// value of the latest observation that carries the key; for delta ones the
// sum of the numbers over those that carry it (SEAM.md §53).
export function foldObservations(observations: { semantics: string; raw: Record<string, unknown> }[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const o of observations) {
    for (const [key, value] of Object.entries(o.raw)) {
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
  return obs.length === 0 ? NOTHING_OBSERVED : normalize(foldObservations(obs));
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
  const n = obs.length === 0 ? NOTHING_OBSERVED : normalize(raw);
  const complete = obs.length > 0 && !ENGINE_ENDED.includes(run.outcome ?? '') ? 1 : 0;
  const id = tx.newId('led_');
  tx.db
    .prepare(
      `INSERT INTO "ledger_rows" ("id", "created_at", "project", "invocation", "run", "turn", "role", "provider", "model_requested", "model_observed", "raw_usage",
         "normalization_version", "billable_in", "cached_in", "out", "usage_complete", "cost_status", "cost_usd", "day_utc")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
  tx.emit('ledger.row', { project: run.project, run: run.id, invocation: receipt.id }, { ledger_row: id, observations: obs.length, cost_status: n.cost_status, usage_complete: complete === 1 });
}

// ---- corrections (SEAM.md §54) ---------------------------------------------------

export interface LedgerRow extends Amounts {
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
}

const addKnown = (a: number | null, b: number | null): number | null => (b === null ? a : a === null ? b : a + b);

// One invocation's rows, original first and corrections in order: amounts
// summed over the rows that know them; status and completeness of the last.
function fold(rows: LedgerRow[]): Account {
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
  return {
    invocation: original.invocation,
    role: original.role,
    day: original.day_utc,
    ...acc,
    cost_usd: acc.cost_usd === null ? null : money(acc.cost_usd),
    cost_status: last.cost_status,
    usage_complete: last.usage_complete === 1,
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
  };
}

// ---- budgets (D1 §13.3; SEAM.md §55) ---------------------------------------------

const DAY_LIMITS = ['budget_day_unknown_tokens', 'budget_day_verified_usd'] as const;

const today = (): string => nowIso().slice(0, 10);

// A project's spend on the current UTC day of the engine's clock: the
// billable tokens of the day's invocations whose cost is unknown, and the
// reported cost of the day's invocations, the ones under way included, from
// their observations as they arrive. An estimate is not verified cost.
// `check`: this read is a budget check, and a store failure in it fails the
// check (D1 §6.6).
function daySpend(db: Db, project: string, check: boolean): { unknownTokens: number; verifiedUsd: number } {
  if (check) seamBudgetRead(project);
  const day = today();
  const rows = db
    .prepare(
      `SELECT l.* FROM "ledger_rows" l WHERE l."project" = ?
       AND l."invocation" IN (SELECT "invocation" FROM "ledger_rows" WHERE "project" = ? AND "corrects" IS NULL AND "day_utc" = ?)`,
    )
    .all(project, project, day) as LedgerRow[];
  const accounts: (Amounts & { cost_status: CostStatus; cost_usd: number | null })[] = accountsOf(rows);
  // Invocations under way: launched or about to be, with no terminal
  // observation and so no ledger row yet.
  const underWay = db
    .prepare(
      `SELECT r."id" FROM "invocation_receipts" r WHERE r."project" = ?
       AND NOT EXISTS (SELECT 1 FROM "ledger_rows" l WHERE l."invocation" = r."id")
       AND NOT EXISTS (SELECT 1 FROM "invocation_status_observations" o WHERE o."invocation" = r."id" AND o."status" IN ('ended', 'unknown', 'refused'))`,
    )
    .all(project) as { id: string }[];
  for (const u of underWay) accounts.push(observedSoFar(db, u.id));
  let unknownTokens = 0;
  let verifiedUsd = 0;
  for (const a of accounts) {
    if (a.cost_status === 'unknown') unknownTokens += billable(a) ?? 0;
    if ((a.cost_status === 'reported' || a.cost_status === 'measured_zero') && a.cost_usd !== null) verifiedUsd += a.cost_usd;
  }
  return { unknownTokens, verifiedUsd: money(verifiedUsd) };
}

// The day limits the project's current day has passed, sorted.
export function exhaustedLimits(db: Db, project: string, opts: { check: boolean }): string[] {
  const policy = projectPolicy(db, project);
  const spend = daySpend(db, project, opts.check);
  const over: string[] = [];
  if (spend.unknownTokens > policy.budget_day_unknown_tokens!) over.push('budget_day_unknown_tokens');
  if (spend.verifiedUsd > policy.budget_day_verified_usd!) over.push('budget_day_verified_usd');
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
  const spent = billable(observedSoFar(db, args.invocation)) ?? 0;
  if (spent > policy.budget_run_billable_tokens!) return 'budget_run_billable_tokens';
  const [day] = exhaustedLimits(db, run.project, { check: false });
  return day ?? null;
}
