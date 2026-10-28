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

// ---- Codex's normalization (D2 §§1.5, 4.6; invoke/adapters/codex.ts) -----------------
//
// The adapter's one observation per invocation is the totals of `codex exec`'s
// one turn (`turn.completed`'s `usage`, cumulative): `input_tokens`,
// `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`, where
// the CLI gives it `cache_write_input_tokens`, and `usage_final`, with the
// provider's `thread_id`. As the Responses API counts them (OpenAI's API
// reference and caching guide, read 2026-10-27; the positive canary
// establishes it for the CLI, C3), input includes the cached input and the
// cache writes, and output includes the reasoning tokens. So billable input
// is input less cached input, never with it (D1 §13.2): the cached input is
// counted once, as cached; the reasoning tokens are kept in the raw usage
// and never added to output. A count not reported is unknown, and so is a
// difference that needs it, or one that would be negative. Codex reports no
// cost (D2 §4.6: tokens only), so a cost is never `reported`: it is
// `estimated` from CODEX_PRICE_TABLE where the stream named the one model
// the invocation used, the table prices it and the usage is final;
// otherwise unknown, never zero. Version 2 (2026-10-28) prices cache
// writes when the CLI reports them.
export const CODEX_NORMALIZATION = 'codex-exec-json-2';

// The Codex price table (the owner's decision 5 of the Codex assessment;
// replaced 2026-10-28 from the verified report
// batch-2026-10-27d/codex-pricing/PRICING.md, "The table, in the engine's
// shape" and §1b): USD per million tokens, Standard tier, short context
// (at most 272K input tokens per request), by model, each row with the
// OpenAI page it was read from and the date. `cache_write`: the write
// multiplier of the plain input rate for the default 30-minute cache
// lifetime (1.25x; the 12-hour lifetime's 2.5x is the dearer one and is
// not used), on the rows whose pages give one; absent where none is listed.
// `status`: the model page's, with its date (a legacy model keeps its row,
// so a name the API still serves is still estimated). Every estimate from
// it is a LOWER BOUND, for the reasons in `lower_bound_reasons`. A model it
// does not list has no estimate (null, with the reason), never 0.
const PRICING_PAGE = 'https://developers.openai.com/api/docs/pricing';
const MODEL_PAGE = (m: string) => `https://developers.openai.com/api/docs/models/${m}`;
const READ = '2026-10-27';
export interface CodexPrice {
  input: number;
  cached_in: number;
  out: number;
  cache_write?: number;
  status: 'current' | 'deprecated' | 'shut_down';
  status_note?: string;
  note?: string;
  sources: string[];
  read: string;
}
const row = (input: number, cached_in: number, out: number, extra: Partial<CodexPrice> & { model: string; pricingPage?: boolean }): CodexPrice => {
  const { model, pricingPage = true, ...rest } = extra;
  return { input, cached_in, out, status: 'current', sources: [...(pricingPage ? [PRICING_PAGE] : []), MODEL_PAGE(model)], read: READ, ...rest };
};
export const CODEX_PRICE_TABLE = {
  version: 'openai-pricing-page-2026-10-27',
  prices: 'from_pricing_page' as const,
  confirmed: true,
  unit: 'USD per 1M tokens, Standard tier, short context (at most 272K input tokens per request)',
  source: 'batch-2026-10-27d/codex-pricing/PRICING.md, verified against OpenAI\'s pages read 2026-10-27',
  lower_bound_reasons: [
    'cache writes are priced at the plain input rate when the usage does not report cache_write_input_tokens (gpt-5.6 and later charge 1.25x input for a 30-minute write)',
    'a reported cache write is priced at the 30-minute rate (1.25x input), the cheaper of the two lifetimes; a 12-hour write costs 2.5x',
    'the long-context tier (2x input and cache, 1.5x output for a request over 272K input tokens) is decided per request, and a turn total cannot show which requests crossed it',
    'fast mode (2x) and regional processing (+10%) cannot be told from the usage',
  ],
  models: {
    'gpt-6.1-sol': row(2, 0.1, 10, { model: 'gpt-6.1-sol', cache_write: 1.25, note: "Codex CLI 0.160.0's default under an API key, inferred from its source at the installed build's commit, not run" }),
    'gpt-6.1-terra': row(1, 0.05, 5, { model: 'gpt-6.1-terra', cache_write: 1.25, note: 'not in the 0.160.0 bundled catalog; `codex -m gpt-6.1-terra` per the Codex models page' }),
    'gpt-6-astra': row(10, 1, 50, { model: 'gpt-6-astra', cache_write: 1.25 }),
    'gpt-6-sol': row(2, 0.2, 10, { model: 'gpt-6-sol', cache_write: 1.25 }),
    'gpt-6-luna': row(0.1, 0.01, 0.5, { model: 'gpt-6-luna', cache_write: 1.25 }),
    'gpt-5.6-sol': row(4, 0.4, 20, { model: 'gpt-5.6-sol', cache_write: 1.25, note: 'promotional pricing, "available at least through November 21, 2026"' }),
    'gpt-5.6-terra': row(2, 0.2, 12, { model: 'gpt-5.6-terra', cache_write: 1.25 }),
    'gpt-5.6-luna': row(0.2, 0.02, 1.2, { model: 'gpt-5.6-luna', cache_write: 1.25 }),
    'gpt-5.5': row(5, 0.5, 30, { model: 'gpt-5.5', note: 'no cache-write rate listed' }),
    'gpt-5.3-codex': row(1.75, 0.175, 14, { model: 'gpt-5.3-codex', status: 'deprecated', status_note: 'deprecated; API shutdown April 1, 2027' }),
    'gpt-5': row(1.25, 0.125, 10, { model: 'gpt-5', status: 'deprecated', status_note: 'deprecated; removed from the API December 11, 2026 (replacement gpt-5.6-sol)' }),
    'gpt-5-mini': row(0.25, 0.025, 2, { model: 'gpt-5-mini', status: 'deprecated', status_note: 'deprecated; removed from the API December 11, 2026 (replacement gpt-5.6-terra)' }),
    'gpt-5-codex': row(1.25, 0.125, 10, { model: 'gpt-5-codex', pricingPage: false, status: 'shut_down', status_note: 'shut down; API shutdown July 23, 2026 (substitute gpt-5.6-sol); priced from its model page only' }),
  } as Record<string, CodexPrice>,
};

// How a Codex estimate priced the cache writes, named in the row's basis
// (its normalization version).
const CODEX_CACHE_WRITE_BASIS = {
  rate: 'cache-write-reported-1.25x-input-30m',
  none_listed: 'cache-write-reported-at-input-no-write-rate-listed',
  absent: 'cache-write-not-reported-priced-as-input',
} as const;

function normalizeCodex(raw: Record<string, unknown>): Normalized {
  const input = amount(raw.input_tokens);
  const cached = amount(raw.cached_input_tokens);
  // Cache writes, inside input (the caching guide): reported or not.
  const writes = raw.cache_write_input_tokens === undefined ? null : amount(raw.cache_write_input_tokens);
  const writesBad = raw.cache_write_input_tokens !== undefined && writes === null;
  const base = {
    billable_in: input === null || cached === null || cached > input ? null : input - cached,
    cached_in: cached,
    out: amount(raw.output_tokens),
    model_observed: typeof raw.model === 'string' ? raw.model : null,
    normalization_version: CODEX_NORMALIZATION,
  };
  const prices = base.model_observed === null ? undefined : CODEX_PRICE_TABLE.models[base.model_observed];
  if (prices && raw.usage_final === true && base.billable_in !== null && base.cached_in !== null && base.out !== null && !writesBad && (writes === null || writes <= base.billable_in)) {
    const plain = base.billable_in - (writes ?? 0);
    const writeRate = writes === null ? prices.input : prices.input * (prices.cache_write ?? 1);
    const usd = (plain * prices.input + (writes ?? 0) * writeRate + base.cached_in * prices.cached_in + base.out * prices.out) / 1_000_000;
    const cacheBasis = writes === null ? CODEX_CACHE_WRITE_BASIS.absent : prices.cache_write === undefined ? CODEX_CACHE_WRITE_BASIS.none_listed : CODEX_CACHE_WRITE_BASIS.rate;
    return { ...base, cost_status: 'estimated', cost_usd: money(usd), normalization_version: `${CODEX_NORMALIZATION}+${CODEX_PRICE_TABLE.version}+${cacheBasis}+lower-bound` };
  }
  return { ...base, cost_status: 'unknown', cost_usd: null };
}

// The most a qualification attempt's canaries can cost in billable tokens,
// as an estimate (D2 §7.2, Q7; SEAM.md §161): three canaries, each at the
// fixture project's run limit, priced at the model's output rate (the
// highest); null where the model has no price (never 0). An estimate, never
// a maximum: cache reads and the overshoot to each canary's deadline are
// outside it (D2 §4.2).
// Codex's from CODEX_PRICE_TABLE, read from OpenAI's pricing page: labelled
// so (`prices: 'from_pricing_page'`) and a lower bound, with the reasons
// (the long-context and fast tiers raise the output rate); a deprecated or
// shut-down model's status is shown with it.
export interface SpendEstimate {
  usd: number;
  price_version: string;
  prices?: 'from_pricing_page';
  bound?: 'lower';
  lower_bound_reasons?: string[];
  model_status?: string;
}
export function attemptSpendEstimate(provider: string, model: string, runLimitTokens: number, invocations = 3): SpendEstimate | null {
  if (provider === 'codex') {
    const p = CODEX_PRICE_TABLE.models[model];
    if (!p) return null;
    return {
      usd: money((invocations * runLimitTokens * p.out) / 1_000_000),
      price_version: CODEX_PRICE_TABLE.version,
      prices: CODEX_PRICE_TABLE.prices,
      bound: 'lower',
      lower_bound_reasons: ['the long-context tier (1.5x output for a request over 272K input tokens) and fast mode (2x) cannot be told from the usage, and either raises the output rate this figure uses'],
      ...(p.status_note ? { model_status: p.status_note } : {}),
    };
  }
  const prices = provider === 'claude' ? CLAUDE_PRICE_TABLE.models[model] : undefined;
  if (!prices) return null;
  return { usd: money((invocations * runLimitTokens * prices.out) / 1_000_000), price_version: CLAUDE_PRICE_TABLE.version };
}

// Why an attempt has no spend estimate (C2): the model is not in its
// provider's price table, or the provider has none; null where it has one.
export function attemptSpendUnavailable(provider: string, model: string): string | null {
  if (provider === 'codex') return CODEX_PRICE_TABLE.models[model] ? null : `no Codex price for ${model}: the Codex price table (${CODEX_PRICE_TABLE.version}) lists ${Object.keys(CODEX_PRICE_TABLE.models).join(', ')} only, so the spend is not estimated (unknown, never 0)`;
  if (provider === 'claude') return CLAUDE_PRICE_TABLE.models[model] ? null : `no Claude price for ${model} in the price table (${CLAUDE_PRICE_TABLE.version})`;
  return `${provider} has no price table`;
}

// The provider's normalization; the scripted one for every provider without
// its own.
export function normalizeFor(provider: string, raw: Record<string, unknown>): Normalized {
  return provider === 'claude' ? normalizeClaude(raw) : provider === 'codex' ? normalizeCodex(raw) : normalize(raw);
}

// Whether an invocation's observations include its terminal usage: for
// Claude Code, the result's totals (`usage_final`); a stream that ended
// without them is incomplete whatever per-call usage it carried. For Codex,
// the terminal turn's usage with every count the ledger needs
// (`usage_final`). Other providers as M1 had it.
export function terminalUsageObserved(provider: string, raw: Record<string, unknown>): boolean {
  return provider === 'claude' || provider === 'codex' ? raw.usage_final === true : true;
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
export function observedSoFar(db: Db, invocation: string): Normalized {
  const obs = observationsOf(db, invocation);
  return obs.length === 0 ? NOTHING_OBSERVED : normalizeFor(providerOf(db, invocation), foldObservations(obs));
}

// ---- the original row (D1 §13.1; SEAM.md §53) ------------------------------------

// Outcomes in which the engine, not the role, ended the invocation: what was
// observed is kept, and the remainder is unknown.
const ENGINE_ENDED = ['stopped', 'timed_out', 'abandoned', 'recovered'];

// ---- a known zero by the egress evidence (E85, Sean's rule; SEAM.md §174) -------------
//
// A real backend's usage is a known zero, whatever it reported or failed to,
// only when the engine's own evidence proves that nothing reached any
// provider: (a) every domain of the invocation was a sandbox whose only
// network path is the engine's egress proxy, as recorded for it (launched
// through the launcher, which gives each domain a network namespace of its
// own, on a validated mount plan published as a record, its cgroup placed,
// not the probe profile, whose echo endpoint is reachable, and terminated);
// (b) each domain's egress log is complete (written whole as its record, not
// cut at its bound, no tunnel still open), as the engine that closed its
// proxy accounted for it; (c) no tunnel was accepted to any destination and
// no byte went up; (d) the backend's own report does not contradict zero:
// no observation, or none with a count or cost other than 0. Otherwise the
// usage is what the observations say, unknown included. The row's
// `normalization_version` names the basis, and its `raw_usage` keeps the
// evidence (`zero_basis`).
export const EGRESS_ZERO_BASIS = 'egress-evidence-zero-1';

export type EgressAccount = { domain: string; egress_log: string | null; complete: boolean; entries: number; accepted: number; bytes_up: number };

const realInvocation = (db: Db, invocation: string): boolean => {
  const receipt = db.prepare('SELECT "trust_entry", "qualification_attempt", "provider" FROM "invocation_receipts" WHERE "id" = ?').get(invocation) as
    | { trust_entry: string | null; qualification_attempt: string | null; provider: string }
    | undefined;
  return (receipt?.trust_entry ?? null) !== null || ((receipt?.qualification_attempt ?? null) !== null && receipt?.provider !== 'scripted');
};

// The basis of a known zero, or why there is none.
export function egressZeroBasis(
  db: Db,
  invocation: string,
  evidence: readonly EgressAccount[],
  observations: { raw: Record<string, unknown> }[],
): { basis: Record<string, unknown> } | { none: string } {
  if (!realInvocation(db, invocation)) return { none: 'not a real backend' };
  const domains = db
    .prepare('SELECT "id", "status", "profile", "cgroup_path", "launch_binding", "mount_plan_record" FROM "execution_domains" WHERE "invocation" = ? ORDER BY "id"')
    .all(invocation) as { id: string; status: string; profile: string; cgroup_path: string | null; launch_binding: string | null; mount_plan_record: string | null }[];
  if (domains.length === 0) return { none: '(a) no domain is recorded' };
  const used: Record<string, unknown>[] = [];
  for (const d of domains) {
    // (a)
    if (d.status !== 'terminated') return { none: `(a) domain ${d.id} is not terminated` };
    if (d.profile === 'probe') return { none: `(a) domain ${d.id} ran the probe profile` };
    if (d.cgroup_path === null || d.launch_binding === null || d.mount_plan_record === null) return { none: `(a) domain ${d.id} has no recorded sandbox (launch, cgroup or mount plan)` };
    // (b)
    const e = evidence.find((x) => x.domain === d.id);
    if (!e) return { none: `(b) no egress account of domain ${d.id}` };
    if (!e.complete || e.egress_log === null) return { none: `(b) the egress log of domain ${d.id} is not complete` };
    if (!db.prepare(`SELECT 1 FROM "records" WHERE "id" = ? AND "kind" = 'egress_log' AND "missing_at" IS NULL`).get(e.egress_log)) return { none: `(b) the egress log record of domain ${d.id} is not there` };
    // (c)
    if (e.accepted !== 0) return { none: `(c) domain ${d.id} had ${e.accepted} tunnel(s) accepted` };
    if (e.bytes_up !== 0) return { none: `(c) domain ${d.id} sent bytes up` };
    used.push({ domain: d.id, egress_log: e.egress_log, entries: e.entries, accepted: 0, bytes_up: 0 });
  }
  // (d) every number the backend reported is 0.
  for (const o of observations) {
    for (const [key, v] of Object.entries(o.raw)) {
      if (typeof v === 'number' && v !== 0) return { none: `(d) the backend reported ${key} ${v}` };
    }
  }
  return { basis: { kind: EGRESS_ZERO_BASIS, observations: observations.length, domains: used } };
}

// The account a ledger row is charged to (migration 0039): a project's, or
// the workspace assistant's, which has no project, run or turn.
export type LedgerAccount = 'project' | 'workspace_assistant';

// The basis on which a real assistant turn's provider-reported zero is not
// taken as a known zero (the assistant design §1.3): only the fake provider,
// and the engine's own egress-evidence zero (O6), are a measured zero; a
// provider's own 0 is recorded unknown, its report kept.
export const ASSISTANT_REPORTED_ZERO = 'assistant-reported-zero-is-unknown-1';

export function chargeInvocation(
  tx: Tx,
  run: { id: string | null; project: string | null; role: string; backend: string; model_requested: string; outcome: string | null },
  receipt: { id: string; turn: string | null },
  egress: readonly EgressAccount[] = [],
  account: LedgerAccount = 'project',
): void {
  const exists = tx.db.prepare('SELECT 1 FROM "ledger_rows" WHERE "invocation" = ? AND "corrects" IS NULL').get(receipt.id);
  if (exists) return;
  const obs = observationsOf(tx.db, receipt.id);
  let raw = foldObservations(obs);
  let n = obs.length === 0 ? NOTHING_OBSERVED : normalizeFor(run.backend, raw);
  let complete = obs.length > 0 && !ENGINE_ENDED.includes(run.outcome ?? '') && terminalUsageObserved(run.backend, raw) ? 1 : 0;
  const zero = egressZeroBasis(tx.db, receipt.id, egress, obs);
  if ('basis' in zero) {
    raw = { ...raw, zero_basis: zero.basis };
    n = { billable_in: 0, cached_in: 0, out: 0, model_observed: n.model_observed, cost_status: 'measured_zero', cost_usd: 0, normalization_version: EGRESS_ZERO_BASIS };
    complete = 1;
  } else if (account === 'workspace_assistant' && n.cost_status === 'measured_zero') {
    // A real assistant turn's provider said 0: unknown, with what it said kept.
    n = { ...n, cost_status: 'unknown', cost_usd: null, normalization_version: `${n.normalization_version}+${ASSISTANT_REPORTED_ZERO}` };
  }
  const allowance = complete === 1 ? null : unknownAllowance(tx.db, receipt.id, run.project, n, obs.length, ENGINE_ENDED.includes(run.outcome ?? ''));
  const assistant = account === 'workspace_assistant';
  const id = tx.newId('led_');
  tx.db
    .prepare(
      `INSERT INTO "ledger_rows" ("id", "created_at", "project", "invocation", "run", "turn", "role", "provider", "model_requested", "model_observed", "raw_usage",
         "normalization_version", "billable_in", "cached_in", "out", "usage_complete", "cost_status", "cost_usd", "day_utc", "unknown_allowance_tokens", "account")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      tx.at,
      assistant ? null : run.project,
      receipt.id,
      assistant ? null : run.id,
      assistant ? null : receipt.turn,
      assistant ? 'workspace_assistant' : run.role,
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
      account,
    );
  tx.emit(
    'ledger.row',
    assistant ? { account, invocation: receipt.id } : { project: run.project, run: run.id, invocation: receipt.id },
    { ledger_row: id, observations: obs.length, cost_status: n.cost_status, usage_complete: complete === 1, unknown_allowance_tokens: allowance },
  );
  if (!assistant && run.id !== null) noteRunModel(tx, run.id, n.model_observed);
}

// The run's observed model (D6 §7.6; M542; E154 item 6 (1)), set from its
// ledger rows in the transaction that records their usage: the models its
// invocations observed, each once in the order first observed, joined by
// a comma as a ledger row joins an invocation's own. null while none of
// them observed one: unknown, never the requested model in its place.
export function noteRunModel(tx: Tx, run: string, observed: string | null): void {
  // The row just charged added to what the run's earlier rows gave (the
  // rows are charged in order, so the first-observed order holds): one
  // read of the run's row, not of every ledger row of it.
  if (observed === null) return;
  const had = (tx.db.prepare('SELECT "model_observed" FROM "runs" WHERE "id" = ?').get(run) as { model_observed: string | null } | undefined)?.model_observed ?? null;
  const split = (v: string | null) => (v ?? '').split(',').map((m) => m.trim()).filter((m) => m.length > 0);
  const models = [...new Set([...split(had), ...split(observed)])];
  if (models.length > 0 && models.join(',') !== had) tx.db.prepare('UPDATE "runs" SET "model_observed" = ? WHERE "id" = ?').run(models.join(','), run);
}

// The run's token limit as its receipt fixed it at dispatch, or the
// project's current one where the receipt holds none.
// A Designer session's receipt fixes the Designer's own budget beside it,
// and that is its limit (D7 §3.2; SEAM.md §491). The raw limit: what the
// session has left of it is `sessionRemainder`'s, the one place prior
// spend is subtracted (the slice-41 review's B1).
// A workspace assistant turn's receipt fixes its turn limit (the assistant
// design §1.3): that is its limit, and it has no project to fall back on.
function runLimit(db: Db, invocation: string, project: string | null): number {
  const row = db.prepare('SELECT "budget_snapshot" FROM "invocation_receipts" WHERE "id" = ?').get(invocation) as { budget_snapshot: string } | undefined;
  const snapshot = row
    ? (JSON.parse(row.budget_snapshot) as { budget_run_billable_tokens?: unknown; designer_session_budget_billable_tokens?: unknown; turn_limit_billable_tokens?: unknown })
    : {};
  if (typeof snapshot.turn_limit_billable_tokens === 'number') return snapshot.turn_limit_billable_tokens;
  if (typeof snapshot.designer_session_budget_billable_tokens === 'number') return snapshot.designer_session_budget_billable_tokens;
  if (typeof snapshot.budget_run_billable_tokens === 'number') return snapshot.budget_run_billable_tokens;
  if (project === null) throw new Error(`invocation ${invocation} has no limit of its own and no project`);
  return projectPolicy(db, project).budget_run_billable_tokens!;
}

// What an invocation may still spend: its limit less what its session's
// earlier turns were charged (0 for an invocation that is not a session
// turn), not below zero.
export const invocationLimit = (db: Db, invocation: string, project: string | null): number => runLimit(db, invocation, project);

function sessionRemainder(db: Db, invocation: string, project: string | null): number {
  return Math.max(0, runLimit(db, invocation, project) - sessionPriorSpend(db, invocation));
}

// Whether an invocation's receipt is a Designer turn's (its snapshot holds
// the Designer's own budget).
function designerTurn(db: Db, invocation: string): boolean {
  const row = db.prepare('SELECT "budget_snapshot" FROM "invocation_receipts" WHERE "id" = ?').get(invocation) as { budget_snapshot: string } | undefined;
  return row !== undefined && typeof (JSON.parse(row.budget_snapshot) as { designer_session_budget_billable_tokens?: unknown }).designer_session_budget_billable_tokens === 'number';
}

// The key of a run's cumulative token budget: a Designer session's is
// `designer_session_budget_billable_tokens`, in place of the run budget
// (D7 §3.2, "double the run budget"; SEAM.md §491); every other run's,
// the other roles' sessions included, `budget_run_billable_tokens`.
export type RunBudgetKey = 'budget_run_billable_tokens' | 'designer_session_budget_billable_tokens';
export const runBudgetKey = (run: { kind?: string | null; role?: string | null }): RunBudgetKey =>
  run.kind === 'session' && run.role === 'designer' ? 'designer_session_budget_billable_tokens' : 'budget_run_billable_tokens';
export function runBudgetOf(db: Db, run: { project: string; kind?: string | null; role?: string | null }): { key: RunBudgetKey; limit: number } {
  const key = runBudgetKey(run);
  return { key, limit: projectPolicy(db, run.project)[key]! };
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
export function unknownAllowance(db: Db, invocation: string, project: string | null, n: Amounts, observations: number, engineEnded: boolean): number | null {
  const receipt = db.prepare('SELECT "trust_entry", "qualification_attempt", "provider" FROM "invocation_receipts" WHERE "id" = ?').get(invocation) as
    | { trust_entry: string | null; qualification_attempt: string | null; provider: string }
    | undefined;
  // A real backend's invocation: under a trust entry, or a canary of an
  // attempt for a backend other than the scripted one (D2 §7.2: a canary is
  // charged to the ordinary ledger, its incomplete usage as any other).
  const real = (receipt?.trust_entry ?? null) !== null || ((receipt?.qualification_attempt ?? null) !== null && receipt?.provider !== 'scripted');
  if (!real && (observations === 0 || !engineEnded)) return null;
  // A session turn is charged the session's remainder (D6 §2.4; M447 (c);
  // the review's N5): the run's limit less what its earlier turns were
  // charged and what this one is known to have spent, not below zero.
  return Math.max(0, sessionRemainder(db, invocation, project) - (billable(n) ?? 0));
}

// ---- corrections (SEAM.md §54) ---------------------------------------------------

export interface LedgerRow extends Amounts {
  unknown_allowance_tokens?: number | null;
  id: string;
  created_at: string;
  // Null only on a workspace assistant row (migration 0039).
  project: string;
  account?: LedgerAccount;
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
         "normalization_version", "billable_in", "cached_in", "out", "usage_complete", "cost_status", "cost_usd", "day_utc", "corrects", "correction_seq", "account")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      // A correction is of its original's account (migration 0039).
      original.account ?? 'project',
    );
  tx.emit(
    'ledger.correction',
    original.account === 'workspace_assistant' ? { account: original.account, invocation: original.invocation } : { project: original.project, run: original.run, invocation: original.invocation },
    { ledger_row: id, corrects: original.id, correction_seq: args.correction_seq },
  );
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

export function accountsOf(rows: LedgerRow[]): Account[] {
  const by = new Map<string, LedgerRow[]>();
  for (const r of rows) {
    const list = by.get(r.invocation) ?? [];
    list.push(r);
    by.set(r.invocation, list);
  }
  return [...by.values()].filter((list) => list.some((r) => r.corrects === null)).map(fold);
}

// The billable tokens of an account, as far as they are known.
export const billable = (a: Amounts): number | null => addKnown(a.billable_in, a.out);

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
    // A Designer turn reserves what its session has left (the driver's
    // decision on objection 156, item 5); every other invocation its run's
    // limit, as built.
    if (opts.dispatch) runningAllowanceTokens += outstandingReservation(db, u.id, project, so);
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

// What an invocation under way still reserves, beyond what it has observed
// (the day check's running allowance above, the one rule for it): a
// Designer turn what its session has left, every other invocation its run's
// limit, less the billable tokens observed so far, not below zero. Also the
// prototype iteration read's outstanding reservation (prototype/iterations.ts).
export function outstandingReservation(db: Db, invocation: string, project: string | null, so: Amounts = observedSoFar(db, invocation)): number {
  return Math.max(0, (designerTurn(db, invocation) ? sessionRemainder(db, invocation, project) : runLimit(db, invocation, project)) - (billable(so) ?? 0));
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

// ---- the qualification budget's admission (B2, SETUP-01; Sean's approval of 2026-10-27) ----

// When the current UTC day of the engine's clock ends: what the day limits
// count clears then.
export const dayClearsAt = (day: string): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString();

// A project's account of its current day against budget_day_unknown_tokens,
// as the day check counts it (daySpend): `charged_tokens` is the unknown-cost
// billable tokens and the unknown allowances charged today, an invocation
// under way counted by what it has observed so far; `running_allowance_tokens`
// is what a dispatch would add on top, the remaining run limit of every
// invocation under way. Not a budget check (no seam read).
export function dayUnknownAccount(db: Db, project: string): { day: string; charged_tokens: number; running_allowance_tokens: number; limit_tokens: number; clears_at: string } {
  const spend = daySpend(db, project, { check: false, dispatch: true });
  return {
    day: spend.day,
    charged_tokens: spend.unknownCostTokens + spend.allowanceTokens,
    running_allowance_tokens: spend.runningAllowanceTokens,
    limit_tokens: projectPolicy(db, project).budget_day_unknown_tokens!,
    clears_at: dayClearsAt(spend.day),
  };
}

// One invocation as a qualification reservation sees it: `charged` once its
// original ledger row is written (or once it was refused, which charges
// nothing); otherwise what it already counts in `dayUnknownAccount`'s
// charged tokens (its unknown-cost tokens observed so far) and its run
// limit as its receipt fixed it. A reservation held for it is its limit less
// what it already counts, so that the two together are never more than the
// one charge its ledger row will make (C4: observed plus the allowance, the
// run limit at most).
export function invocationStanding(db: Db, invocation: string, project: string | null): { charged: boolean; counted: number; limit: number } {
  const row = db.prepare('SELECT 1 FROM "ledger_rows" WHERE "invocation" = ? AND "corrects" IS NULL').get(invocation);
  const refused = db.prepare(`SELECT 1 FROM "invocation_status_observations" WHERE "invocation" = ? AND "status" = 'refused'`).get(invocation);
  const limit = runLimit(db, invocation, project);
  if (row || refused) return { charged: true, counted: 0, limit };
  const so = observedSoFar(db, invocation);
  return { charged: false, counted: so.cost_status === 'unknown' ? (billable(so) ?? 0) : 0, limit };
}

// The check on a usage observation (D1 §13.3): the limit the run's
// invocation, or the project's day, has passed with what was observed so
// far; null if none.
// `terminal`: the check is on the backend's terminal event, after which it
// spends nothing (Sean's second real-agent run): an unknown usage then is
// not a reason to stop a run ending by itself, and is recorded unknown with
// the run's ledger row; the run's own limit on what is known, and the day's
// limits, are still checked, and a limit passed is still a stop.
export function budgetCheck(db: Db, args: { run: string; invocation: string; terminal?: boolean }): string | null {
  const run = db.prepare('SELECT "project", "kind", "role" FROM "runs" WHERE "id" = ?').get(args.run) as { project: string; kind: string; role: string | null } | undefined;
  if (!run) throw notFound('run', args.run);
  seamBudgetRead(run.project);
  const limit = runBudgetOf(db, run);
  // An unknown count is never read as zero (E74 item 3): where usage has
  // been observed and nothing billable in it is known, the run's budget
  // cannot be judged and the run does not go on without it (D1 §6.6). With
  // nothing observed yet (a check at a pause's re-grant, before any usage)
  // there is nothing to judge the run's limit on, and only the day's limits
  // are checked.
  const observed = observationsOf(db, args.invocation).length > 0;
  // A session's turn counts the session's cumulative spend: its earlier
  // turns' plus this one's (D1 §13.3; the review's M4).
  const own = billable(observedSoFar(db, args.invocation));
  const spent = sessionSpendAt(db, { invocation: args.invocation, current: own });
  if (observed && spent === null && args.terminal !== true) return 'budget_usage_unknown';
  if (spent !== null && spent > limit.limit) return limit.key;
  const [day] = exhaustedLimits(db, run.project, { check: false });
  return day ?? null;
}

// What a session turn's earlier turns were charged (their billable tokens
// and allowances), for its run's cumulative budget (D1 §13.3); 0 for an
// invocation that is not a session turn. A row whose figure is unknown
// counts its allowance, never 0 for the unknown part.
function sessionPriorSpend(db: Db, invocation: string): number {
  const r = db.prepare('SELECT "run", "turn" FROM "invocation_receipts" WHERE "id" = ?').get(invocation) as { run: string; turn: string | null } | undefined;
  if (!r || r.turn === null) return 0;
  const rows = db.prepare('SELECT "billable_in", "out", "unknown_allowance_tokens" FROM "ledger_rows" WHERE "run" = ? AND "invocation" <> ? AND "corrects" IS NULL').all(r.run, invocation) as {
    billable_in: number | null;
    out: number | null;
    unknown_allowance_tokens: number | null;
  }[];
  return rows.reduce((n, x) => n + (x.billable_in ?? 0) + (x.out ?? 0) + (x.unknown_allowance_tokens ?? 0), 0);
}

// The session's cumulative spend at a usage observation of one of its turns
// (D1 §13.3 "on every usage observation"; the review's M4): its earlier
// turns' charges plus what this turn has spent so far; null when this turn's
// spend so far is unknown.
export function sessionSpendAt(db: Db, args: { invocation: string; current: number | null }): number | null {
  if (args.current === null) return null;
  return sessionPriorSpend(db, args.invocation) + args.current;
}
