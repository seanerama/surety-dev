// The workspace assistant's usage account and real enablement, the store's
// side (the assistant design of 2026-10-27, §§1 to 4; Sean's approval of
// O2(a), O4(a) and O7(a)). The account is one engine-scope account,
// `workspace_assistant`, not a project: its receipts, observations, domains
// and ledger rows carry `account = 'workspace_assistant'` and no project, run
// or grant (migration 0039), so no project fold reads them, and its own read
// is here.
//
// Its unit is the billable token (input plus cache creation, and output;
// D1 §13.2). Its limits are the owner's `workspace_assistant` block, which
// has no defaults (config/engine-config.ts). A turn is admitted in the
// transaction that writes its receipt, only if the assistant's state is
// `ready` (§2) and
//
//   used_known + unknown_allowance + reserved + turn_limit <= day_limit,
//
// where `used_known` is the billable tokens today's assistant rows know (and
// the turns under way have observed), `unknown_allowance` what their unknown
// part is charged (a row's allowance in force; a row that knows a count
// partly and carries none, its turn limit less what it knows: unknown is
// never zero), and `reserved` the remaining turn limit of every turn under
// way. Nothing is stored for a reservation: it is read from the receipts with
// no original ledger row and no refusal, so a restart neither loses one nor
// counts one twice (B2's approach), and the transaction that writes a turn's
// one original row (or its refusal) is the one that releases its
// reservation. Dollars are shown, reported and estimated apart, and never
// counted against the limit.

import { sameModel } from '../../invoke/adapters/model.js';
import { purposeOfTemplateVersion, templateOf } from '../../invoke/adapters/templates.js';
import { nowIso } from '../../clock.js';
import { Refusal } from '../../refusal.js';
import { seamBudgetRead } from '../../testing/seam.js';
import { hostIdentity } from '../../trust/host.js';
import type { AssistantConfig } from '../../config/engine-config.js';
import { notFound } from './common.js';
import { envelopeHold } from './envelope.js';
import { type CostStatus, type EgressAccount, type LedgerRow, accountsOf, billable, chargeInvocation, dayClearsAt, invocationLimit, observedSoFar } from './ledger.js';
import { observeInvocation } from './runs.js';
import { type RoleProfile, defaultProfileMax, engineSettings } from './settings.js';
import { type EntryRow, hostEligibility } from './trust.js';
import type { Tx } from './tx.js';

type Db = Tx['db'];

export const ASSISTANT_ACCOUNT = 'workspace_assistant';
export const ASSISTANT_STATES = ['unconfigured', 'credential_missing', 'qualification_pending', 'limit_reached', 'ready'] as const;
export type AssistantState = (typeof ASSISTANT_STATES)[number];

// The refusal code of each state that is not `ready`, at a message's
// admission (§2).
export const STATE_CODES: Readonly<Record<Exclude<AssistantState, 'ready'>, { code: string; status: number }>> = {
  unconfigured: { code: 'assistant_not_configured', status: 503 },
  credential_missing: { code: 'assistant_credential_missing', status: 409 },
  qualification_pending: { code: 'assistant_qualification_pending', status: 409 },
  limit_reached: { code: 'assistant_limit_reached', status: 429 },
};

// At most two turns under way at once, and one per conversation (the
// assistant's existing bounds, README "Safety limits").
export const ASSISTANT_CONCURRENT_TURNS = 2;

export const assistantConfig = (): AssistantConfig | null => engineSettings().workspace_assistant ?? null;

const today = (): string => nowIso().slice(0, 10);

// ---- the account (§§1.2, 1.3) ---------------------------------------------------------------

export interface AssistantAccountView {
  id: 'workspace_assistant';
  unit: 'billable_tokens';
  day: string;
  resets_at: string;
  day_limit: number;
  turn_limit: number;
  used_known: number;
  unknown_allowance: number;
  reserved: number;
  remaining: number;
  reported_usd: number;
  estimated_usd: number;
  unknown_cost_turns: number;
  turns_charged: number;
  turns_under_way: number;
  // The admission inequality for one more turn.
  fits_one_more_turn: boolean;
  limit_is: 'admission_and_in_flight_stop_not_a_hard_maximum';
}

// What one charged assistant turn counts against the day: its known
// billable tokens and the unknown part's charge. A row that knows neither
// count, or one of them, and carries no allowance is charged its turn limit
// less what it knows (never zero for the unknown part).
function chargeOf(db: Db, a: { invocation: string; billable_in: number | null; out: number | null; unknown_allowance_tokens: number | null }): { known: number; unknown: number } {
  const known = (a.billable_in ?? 0) + (a.out ?? 0);
  if (a.unknown_allowance_tokens !== null) return { known, unknown: a.unknown_allowance_tokens };
  if (a.billable_in === null || a.out === null) return { known, unknown: Math.max(0, invocationLimit(db, a.invocation, null) - known) };
  return { known, unknown: 0 };
}

const money = (v: number): number => Math.round(v * 1e9) / 1e9;

// The assistant account's current UTC day (the engine's clock), its turns
// under way included. `check`: this read decides an admission or the state,
// and a store failure in it fails them (D1 §13.3, §6.6).
export function assistantAccount(db: Db, cfg: AssistantConfig, opts: { check?: boolean } = {}): AssistantAccountView {
  if (opts.check) seamBudgetRead(ASSISTANT_ACCOUNT);
  const day = today();
  const rows = db
    .prepare(
      `SELECT * FROM "ledger_rows" WHERE "account" = 'workspace_assistant'
       AND "invocation" IN (SELECT "invocation" FROM "ledger_rows" WHERE "account" = 'workspace_assistant' AND "corrects" IS NULL AND "day_utc" = ?) ORDER BY rowid`,
    )
    .all(day) as LedgerRow[];
  let usedKnown = 0;
  let unknown = 0;
  let reported = 0;
  let estimated = 0;
  let unknownCost = 0;
  const accounts = accountsOf(rows);
  for (const a of accounts) {
    const c = chargeOf(db, a);
    usedKnown += c.known;
    unknown += c.unknown;
    const status: CostStatus = a.cost_status;
    if (status === 'reported' && a.cost_usd !== null) reported += a.cost_usd;
    if (status === 'estimated' && a.cost_usd !== null) estimated += a.cost_usd;
    if (status === 'unknown') unknownCost++;
  }
  // Turns under way: a receipt with no original row and no refusal. Each
  // holds its turn limit, less what it has observed (counted as used).
  let reserved = 0;
  const underWay = underWayTurns(db);
  for (const id of underWay) {
    const so = observedSoFar(db, id);
    const seen = Math.max(0, billable(so) ?? 0);
    usedKnown += seen;
    reserved += Math.max(0, invocationLimit(db, id, null) - seen);
  }
  const used = usedKnown + unknown + reserved;
  return {
    id: 'workspace_assistant',
    unit: 'billable_tokens',
    day,
    resets_at: dayClearsAt(day),
    day_limit: cfg.day_limit_billable_tokens,
    turn_limit: cfg.turn_limit_billable_tokens,
    used_known: usedKnown,
    unknown_allowance: unknown,
    reserved,
    remaining: Math.max(0, cfg.day_limit_billable_tokens - used),
    reported_usd: money(reported),
    estimated_usd: money(estimated),
    unknown_cost_turns: unknownCost,
    turns_charged: accounts.length,
    turns_under_way: underWay.length,
    fits_one_more_turn: used + cfg.turn_limit_billable_tokens <= cfg.day_limit_billable_tokens,
    limit_is: 'admission_and_in_flight_stop_not_a_hard_maximum',
  };
}

// The assistant's receipts under way: no original ledger row, no refusal.
export function underWayTurns(db: Db): string[] {
  return (
    db
      .prepare(
        `SELECT r."id" FROM "invocation_receipts" r WHERE r."account" = 'workspace_assistant'
         AND NOT EXISTS (SELECT 1 FROM "ledger_rows" l WHERE l."invocation" = r."id" AND l."corrects" IS NULL)
         AND NOT EXISTS (SELECT 1 FROM "invocation_status_observations" o WHERE o."invocation" = r."id" AND o."status" = 'refused')
         ORDER BY r.rowid`,
      )
      .all() as { id: string }[]
  ).map((r) => r.id);
}

// ---- the entry and its qualification (§§2, 3) -----------------------------------------------

// The credential facts the main thread holds (values are never in the store):
// whether the saved credential manifest reads, and whether the block's
// reference is loaded.
export interface CredentialFacts {
  manifest_ok: boolean;
  loaded: boolean;
}

const json = <T>(text: string | null, fallback: T): T => {
  try {
    return text === null ? fallback : (JSON.parse(text) as T);
  } catch {
    return fallback;
  }
};

// The reference an entry's template takes its credential by ('' for none).
const keyRefOf = (e: Pick<EntryRow, 'backend' | 'auth_mode'>): string => templateOf(e.backend, { scripted: true, authMode: e.auth_mode, purpose: 'assistant' })?.keyRef ?? '';

// The active assistant-template entries on this host for the block's
// backend and model, with the current template version: those whose
// credential reference is the block's (`matching`), and those of another
// authentication mode (`other_mode`). A role template's entry, a Vision or a
// session-qualified entry is never among them.
export function assistantEntries(db: Db, cfg: AssistantConfig): { matching: EntryRow[]; other_mode: EntryRow[] } {
  const host = hostIdentity();
  const rows = (
    db
      .prepare(`SELECT * FROM "trust_entries" WHERE "backend" = ? AND "mode" = 'one_shot_headless' AND "status" = 'active' AND "host_id" = ? ORDER BY rowid DESC, "id" DESC`)
      .all(cfg.backend, host ?? '') as EntryRow[]
  ).filter((e) => {
    if (purposeOfTemplateVersion(e.template_version) !== 'assistant') return false;
    if (!sameModel(cfg.model, e.model)) return false;
    const t = templateOf(e.backend, { scripted: true, authMode: e.auth_mode, purpose: 'assistant' });
    return t !== undefined && t.version === e.template_version;
  });
  const matching = rows.filter((e) => {
    const ref = keyRefOf(e);
    return ref === '' || ref === cfg.credential_ref;
  });
  return { matching, other_mode: rows.filter((e) => !matching.includes(e)) };
}

export interface QualificationView {
  attempt: string | null;
  attempt_status: string | null;
  trust_entry: string | null;
  trust_entry_status: string | null;
  // The owner's open decision about it: the attempt's qualification_approval
  // or the entry's trust_activation; null when none is open.
  decision: { id: string; kind: string } | null;
  stage: 'not_proposed' | 'qualification_approval' | 'authorized' | 'running' | 'failed' | 'invalidated' | 'trust_activation' | 'active' | 'revoked';
}

// The latest assistant qualification for the block's backend, and the open
// decision the owner has about it.
export function assistantQualification(db: Db, cfg: AssistantConfig): QualificationView {
  const attempts = (db.prepare(`SELECT * FROM "qualification_attempts" WHERE "backend" = ? ORDER BY rowid DESC, "id" DESC`).all(cfg.backend) as {
    id: string;
    status: string;
    template_version: string;
    model: string;
    trust_entry: string | null;
  }[]).filter((a) => purposeOfTemplateVersion(a.template_version) === 'assistant');
  const entries = (db.prepare(`SELECT * FROM "trust_entries" WHERE "backend" = ? ORDER BY rowid DESC, "id" DESC`).all(cfg.backend) as EntryRow[]).filter(
    (e) => purposeOfTemplateVersion(e.template_version) === 'assistant',
  );
  const attempt = attempts[0] ?? null;
  // The latest attempt's entry (written by it), or, with no attempt, the
  // latest entry.
  const entry = attempt === null ? (entries[0] ?? null) : (entries.find((e) => e.qualification_attempt === attempt.id || e.id === attempt.trust_entry) ?? null);
  const open = (type: string, id: string | null | undefined) =>
    id ? ((db.prepare(`SELECT "id", "kind" FROM "decisions" WHERE "subject_type" = ? AND "subject_id" = ? AND "status" = 'open' ORDER BY rowid DESC LIMIT 1`).get(type, id) as { id: string; kind: string } | undefined) ?? null) : null;
  const decision = open('trust_entry', entry?.id) ?? open('qualification_attempt', attempt?.id);
  let stage: QualificationView['stage'] = 'not_proposed';
  if (entry) stage = entry.status === 'active' ? 'active' : entry.status === 'revoked' ? 'revoked' : 'trust_activation';
  else if (attempt) stage = attempt.status === 'proposed' ? 'qualification_approval' : (attempt.status as QualificationView['stage']);
  if (stage === ('succeeded' as string)) stage = 'trust_activation';
  return {
    attempt: attempt?.id ?? null,
    attempt_status: attempt?.status ?? null,
    trust_entry: entry?.id ?? null,
    trust_entry_status: entry?.status ?? null,
    decision,
    stage,
  };
}

// ---- the state (§2) ---------------------------------------------------------------------------

export interface AssistantStanding {
  state: AssistantState;
  configured: boolean;
  reason: string;
  what_to_do: string;
  provider: string;
  model: string | null;
  qualification: QualificationView | null;
  account: AssistantAccountView | null;
  // The entry a turn would run on now; null unless ready or limit_reached.
  entry: EntryRow | null;
}

// The state from the real configuration, the first failing condition
// winning: unconfigured, credential_missing, qualification_pending,
// limit_reached, ready. A store failure while computing it is thrown, and is
// a refusal, never `ready` (§2).
export function assistantStanding(db: Db, args: { credential: CredentialFacts }): AssistantStanding {
  const cfg = assistantConfig();
  if (cfg === null) {
    return {
      state: 'unconfigured',
      configured: false,
      reason: 'Assistant not configured: config.json has no workspace_assistant block, so no real assistant path is reachable and nothing is charged.',
      what_to_do: 'Continue using the ordinary workspace controls. To enable the assistant, write the whole workspace_assistant block into config.json and restart the engine.',
      provider: 'unconfigured',
      model: null,
      qualification: null,
      account: null,
      entry: null,
    };
  }
  const base = { provider: cfg.backend, model: cfg.model };
  const account = assistantAccount(db, cfg, { check: true });
  const qualification = assistantQualification(db, cfg);
  const not = (state: AssistantState, reason: string, whatToDo: string): AssistantStanding => ({ state, configured: false, reason, what_to_do: whatToDo, ...base, qualification, account, entry: null });
  if (!args.credential.manifest_ok) {
    return not('credential_missing', 'Assistant credential not available: the saved credential references (provider-credentials.json) cannot be read safely (credential_manifest_invalid).', 'Check provider-credentials.json in Engine setup; nothing is run until it reads.');
  }
  if (!args.credential.loaded) {
    return not('credential_missing', `Assistant credential not available: the reference ${cfg.credential_ref} the workspace_assistant block names is not loaded by this engine.`, `Register a credential file for ${cfg.credential_ref} in Engine setup, or start the engine with it.`);
  }
  const entries = assistantEntries(db, cfg);
  if (entries.matching.length === 0 && entries.other_mode.length > 0) {
    const e = entries.other_mode[0]!;
    return not(
      'credential_missing',
      `Assistant credential not available: the active assistant entry ${e.id} was qualified with ${e.auth_mode}, whose credential is ${keyRefOf(e)}, not the block's ${cfg.credential_ref}.`,
      `Name ${keyRefOf(e)} as the block's credential_ref, or qualify the assistant in the block's authentication mode.`,
    );
  }
  const host = hostEligibility(db);
  if (entries.matching.length === 0 || !host.eligible) {
    const why = !host.eligible
      ? 'this host has no current host qualification that makes it eligible to run a real backend'
      : `no active trust entry of the assistant template for ${cfg.backend} and the model ${cfg.model} is on this host (stage: ${qualification.stage})`;
    return not(
      'qualification_pending',
      `Qualification pending: ${why}. A project role's, Vision's or a session-qualified entry is not the assistant's.`,
      qualification.decision
        ? `Answer the open ${qualification.decision.kind} (${qualification.decision.id}).`
        : qualification.stage === 'not_proposed' || qualification.stage === 'failed' || qualification.stage === 'invalidated' || qualification.stage === 'revoked'
          ? `Propose the assistant qualification (POST /v1/trust/qualify with "purpose": "assistant", backend ${cfg.backend}, model ${cfg.model}); then approve its qualification_approval and, once its canaries pass, its trust_activation.`
          : 'Wait for the qualification attempt to finish, then answer its trust_activation.',
    );
  }
  const entry = entries.matching[0]!;
  if (!account.fits_one_more_turn) {
    return {
      state: 'limit_reached',
      configured: true,
      reason: `Today's assistant limit is reached: ${account.used_known} billable tokens used, ${account.unknown_allowance} charged as unknown, ${account.reserved} reserved by turns under way, of ${account.day_limit}; one more turn reserves ${account.turn_limit}.`,
      what_to_do: `The day resets at ${account.resets_at} (00:00 UTC). History and receipts stay readable; the limit is the owner's, in config.json.`,
      ...base,
      qualification,
      account,
      entry,
    };
  }
  return {
    state: 'ready',
    configured: true,
    reason: `Ready: ${cfg.backend} ${cfg.model} on trust entry ${entry.id}; ${account.remaining} of ${account.day_limit} billable tokens remain today.`,
    what_to_do: 'Ask a question about this workspace. Answers cite the engine reads they rest on; approvals stay yours.',
    ...base,
    qualification,
    account,
    entry,
  };
}

// The GET body's state part (§2): the standing without the entry row.
export function assistantStateBody(db: Db, args: { credential: CredentialFacts }) {
  const { entry, ...body } = assistantStanding(db, args);
  return { ...body, trust_entry: entry?.id ?? null };
}

// ---- admission (§1.3 step 1) -----------------------------------------------------------------

export interface TurnClaim {
  invocation: string;
  domain: string;
  conversation: string;
  intent_id: string;
  trust_entry: string;
  backend: string;
  auth_mode: string;
  model: string;
  binary_path: string;
  binary_sha256: string;
  help_sha256: string;
  key_ref: string;
  template_version: string;
  egress_hosts: string[];
  turn_limit: number;
  deadline_at: string;
  cgroup_path: string | null;
  memory_max: number;
  incarnation: string;
}

const refusedState = (s: AssistantStanding): Refusal => {
  const code = STATE_CODES[s.state as Exclude<AssistantState, 'ready'>];
  const subject: Record<string, unknown> = { state: s.state };
  if (s.state === 'limit_reached' && s.account) {
    Object.assign(subject, {
      used_known: s.account.used_known,
      unknown_allowance: s.account.unknown_allowance,
      reserved: s.account.reserved,
      turn_limit: s.account.turn_limit,
      day_limit: s.account.day_limit,
      resets_at: s.account.resets_at,
    });
  }
  if (s.qualification) subject.qualification = s.qualification;
  return new Refusal(code.status, code.code, s.reason, s.what_to_do, subject);
};

// The admission of one turn, in one transaction with its receipt (§1.3): the
// state recomputed (refused with its code unless `ready`), the concurrency
// bounds, the resource envelope, then the receipt (its budget snapshot fixing
// the turn and day limits and the day), the turn, the domain and its
// ownership. A refused admission writes nothing. The transaction asks for a
// tick, which dispatches the turn (§4).
export function admitTurn(
  tx: Tx,
  args: { conversation: string; intent_id: string; credential: CredentialFacts; incarnation: string; scope: string | null },
): TurnClaim {
  const db = tx.db;
  const prior = db.prepare('SELECT "invocation" FROM "assistant_turns" WHERE "conversation" = ? AND "intent_id" = ?').get(args.conversation, args.intent_id) as { invocation: string } | undefined;
  if (prior) throw new Refusal(409, 'assistant_intent_conflict', 'This intent identifier already names a turn; a turn is never replayed.', 'Use a new intent identifier for a new owner request.', { invocation: prior.invocation });
  const standing = assistantStanding(db, { credential: args.credential });
  if (standing.state !== 'ready' || standing.entry === null) throw refusedState(standing);
  const cfg = assistantConfig()!;
  const open = db.prepare(`SELECT "conversation" FROM "assistant_turns" WHERE "status" <> 'ended'`).all() as { conversation: string }[];
  if (open.some((t) => t.conversation === args.conversation)) {
    throw new Refusal(409, 'assistant_busy', 'A response is already running in this conversation.', 'Wait for it to settle; do not replay the request.', { conversation: args.conversation });
  }
  if (open.length >= ASSISTANT_CONCURRENT_TURNS) {
    throw new Refusal(429, 'assistant_limit', 'The assistant concurrency limit was reached.', 'Wait for a current response to settle.', { turns_under_way: open.length });
  }
  const e = standing.entry;
  const profile = json<RoleProfile | null>((e as EntryRow & { profile?: string | null }).profile ?? null, null);
  const memoryMax = profile?.memory_max ?? defaultProfileMax('role');
  const hold = envelopeHold(db, { kind: 'role', memory: memoryMax });
  if (hold !== null) {
    throw new Refusal(429, 'assistant_limit', "The engine's resource envelope admits no further domain now.", 'Wait for running work to settle and ask again; nothing was charged.', { envelope: hold as unknown as Record<string, unknown> });
  }
  const template = templateOf(e.backend, { scripted: true, authMode: e.auth_mode, purpose: 'assistant' })!;
  const invocation = tx.newId('inv_');
  const day = tx.at.slice(0, 10);
  const deadline = new Date(Date.parse(tx.at) + cfg.turn_deadline_seconds * 1000).toISOString();
  const snapshot = {
    account: ASSISTANT_ACCOUNT,
    turn_limit_billable_tokens: cfg.turn_limit_billable_tokens,
    day_limit_billable_tokens: cfg.day_limit_billable_tokens,
    turn_deadline_seconds: cfg.turn_deadline_seconds,
    day,
    // What the day held at admission (the inequality's terms).
    admitted_against: { used_known: standing.account!.used_known, unknown_allowance: standing.account!.unknown_allowance, reserved: standing.account!.reserved },
  };
  const session = template.sessionIdOf?.(invocation) ?? null;
  db.prepare(
    `INSERT INTO "invocation_receipts" ("id", "created_at", "project", "run", "turn", "provider", "model_requested", "grant", "budget_snapshot", "trust_entry", "qualification_attempt", "provider_session_id", "deadline_at", "account")
     VALUES (?, ?, NULL, NULL, NULL, ?, ?, NULL, ?, ?, NULL, ?, ?, 'workspace_assistant')`,
  ).run(invocation, tx.at, e.backend, cfg.model, JSON.stringify(snapshot), e.id, session, deadline);
  tx.emit('invocation.receipt', { account: ASSISTANT_ACCOUNT, invocation }, { provider: e.backend, ...(session ? { provider_session_id: session } : {}) });
  db.prepare(`INSERT INTO "assistant_turns" ("invocation", "created_at", "conversation", "intent_id", "status") VALUES (?, ?, ?, ?, 'admitted')`).run(invocation, tx.at, args.conversation, args.intent_id);
  const domain = tx.newId('dom_');
  const cgroupPath = args.scope ? `${args.scope}/${domain}` : null;
  db.prepare(
    `INSERT INTO "execution_domains" ("id", "created_at", "project", "run", "invocation", "status", "profile", "cgroup_path", "launch_state", "memory_max", "account")
     VALUES (?, ?, NULL, NULL, ?, 'allocated', 'role', ?, 'authorizable', ?, 'workspace_assistant')`,
  ).run(domain, tx.at, invocation, cgroupPath, memoryMax);
  db.prepare(`INSERT INTO "process_ownership" ("id", "created_at", "project", "domain", "invocation", "incarnation", "account") VALUES (?, ?, NULL, ?, ?, ?, 'workspace_assistant')`).run(
    tx.newId('proc_'),
    tx.at,
    domain,
    invocation,
    args.incarnation,
  );
  tx.emit(
    'assistant.turn_admitted',
    { account: ASSISTANT_ACCOUNT, invocation, domain },
    { conversation: args.conversation, intent_id: args.intent_id, trust_entry: e.id, turn_limit: cfg.turn_limit_billable_tokens, day_limit: cfg.day_limit_billable_tokens, day, ...snapshot.admitted_against },
  );
  return claimOf(db, invocation)!;
}

// What the main thread needs to launch an admitted turn.
export function claimOf(db: Db, invocation: string): TurnClaim | null {
  const r = db
    .prepare(
      `SELECT r."id", r."model_requested", r."budget_snapshot", r."deadline_at", r."trust_entry", t."conversation", t."intent_id", d."id" AS "domain", d."cgroup_path", d."memory_max", o."incarnation"
       FROM "invocation_receipts" r JOIN "assistant_turns" t ON t."invocation" = r."id" JOIN "execution_domains" d ON d."invocation" = r."id" JOIN "process_ownership" o ON o."domain" = d."id"
       WHERE r."id" = ? AND r."account" = 'workspace_assistant'`,
    )
    .get(invocation) as
    | { id: string; model_requested: string; budget_snapshot: string; deadline_at: string; trust_entry: string; conversation: string; intent_id: string; domain: string; cgroup_path: string | null; memory_max: number; incarnation: string }
    | undefined;
  if (!r) return null;
  const e = db.prepare('SELECT * FROM "trust_entries" WHERE "id" = ?').get(r.trust_entry) as EntryRow | undefined;
  if (!e) return null;
  const snapshot = json<{ turn_limit_billable_tokens?: number }>(r.budget_snapshot, {});
  return {
    invocation: r.id,
    domain: r.domain,
    conversation: r.conversation,
    intent_id: r.intent_id,
    trust_entry: e.id,
    backend: e.backend,
    auth_mode: e.auth_mode,
    model: e.model,
    binary_path: e.binary_path,
    binary_sha256: e.binary_sha256,
    help_sha256: e.help_sha256,
    key_ref: keyRefOf(e),
    template_version: e.template_version,
    egress_hosts: json<string[]>(e.egress_hosts, []),
    turn_limit: snapshot.turn_limit_billable_tokens ?? 0,
    deadline_at: r.deadline_at,
    cgroup_path: r.cgroup_path,
    memory_max: r.memory_max,
    incarnation: r.incarnation,
  };
}

// The admitted turns the tick dispatches (§4), oldest first.
export function admittedTurns(db: Db): string[] {
  return (db.prepare(`SELECT "invocation" FROM "assistant_turns" WHERE "status" = 'admitted' ORDER BY rowid`).all() as { invocation: string }[]).map((r) => r.invocation);
}

// The turn of an owner message, with its end once ended.
export function turnOf(db: Db, args: { conversation: string; intent_id: string } | { invocation: string }) {
  const row = (
    'invocation' in args
      ? db.prepare('SELECT * FROM "assistant_turns" WHERE "invocation" = ?').get(args.invocation)
      : db.prepare('SELECT * FROM "assistant_turns" WHERE "conversation" = ? AND "intent_id" = ?').get(args.conversation, args.intent_id)
  ) as
    | { invocation: string; conversation: string; intent_id: string; status: string; outcome: string | null; reason: string | null; reason_text: string | null; cancel_requested_at: string | null; reply: string | null; ended_at: string | null }
    | undefined;
  if (!row) return null;
  const led = db.prepare(`SELECT * FROM "ledger_rows" WHERE "invocation" = ? ORDER BY rowid`).all(row.invocation) as LedgerRow[];
  const usage = led.length === 0 ? null : accountsOf(led)[0] ?? null;
  return {
    ...row,
    reply: row.reply === null ? null : (JSON.parse(row.reply) as unknown),
    usage:
      usage === null
        ? null
        : {
            account: ASSISTANT_ACCOUNT,
            provider: led[0]!.provider,
            model_observed: led.find((x) => x.corrects === null)?.model_observed ?? null,
            cost_status: usage.cost_status,
            cost_usd: usage.cost_usd,
            input_tokens: usage.billable_in,
            output_tokens: usage.out,
            cached_input_tokens: usage.cached_in,
            usage_complete: usage.usage_complete,
            unknown_allowance_tokens: usage.unknown_allowance_tokens,
            // The basis of the figures: the provider's normalization, or the
            // engine's own egress-evidence zero (O6), labelled.
            basis: led.find((x) => x.corrects === null)?.normalization_version ?? null,
          },
  };
}

// ---- the turn's launch, usage and end (§§1.3 steps 2 and 3, 4) ------------------------------

// The scheduler dispatched it: running, `dispatch_started`. false when it is
// no longer admitted (ended meanwhile).
export function turnDispatched(tx: Tx, args: { invocation: string }): boolean {
  const t = tx.db.prepare('SELECT "status" FROM "assistant_turns" WHERE "invocation" = ?').get(args.invocation) as { status: string } | undefined;
  if (!t || t.status !== 'admitted') return false;
  tx.db.prepare(`UPDATE "assistant_turns" SET "status" = 'running' WHERE "invocation" = ?`).run(args.invocation);
  observeInvocation(tx, args.invocation, 'dispatch_started');
  tx.emit('assistant.turn_started', { account: ASSISTANT_ACCOUNT, invocation: args.invocation }, {});
  return true;
}

const statusesOf = (db: Db, invocation: string): string[] =>
  (db.prepare('SELECT "status" FROM "invocation_status_observations" WHERE "invocation" = ? ORDER BY "seq"').all(invocation) as { status: string }[]).map((r) => r.status);
const TERMINAL = ['ended', 'unknown', 'refused'];

// The spawn on the kernel lane, or the launch authorization's grant on the
// real boundary: ownership completed, `launched`, the domain launched.
export function turnLaunched(tx: Tx, args: { invocation: string; domain: string; pid: number; pgid: number; startTime: string | null }): void {
  tx.db.prepare('UPDATE "process_ownership" SET "pid" = ?, "pgid" = ?, "pid_start_time" = ? WHERE "domain" = ? AND "pid" IS NULL').run(args.pid, args.pgid, args.startTime, args.domain);
  if (!statusesOf(tx.db, args.invocation).includes('launched')) observeInvocation(tx, args.invocation, 'launched');
  tx.db.prepare(`UPDATE "execution_domains" SET "status" = 'launched' WHERE "id" = ? AND "status" = 'allocated'`).run(args.domain);
}

// The launch authorization of an assistant turn's domain on the real
// boundary (D2 §3.2, K1, as a run's and a check's): granted in this one
// transaction only if the domain, the invocation and the owning incarnation
// are current, the launch is authorizable, and the turn is running with no
// cancel asked for and no terminal observation. An assistant turn holds no
// lease: its deadline (turn_deadline_seconds, at most an hour) bounds it.
export function authorizeTurnLaunch(tx: Tx, args: { domain: string; invocation: string; incarnation: string; pid: number; startTime: string | null }): { granted: boolean; reason: string | null } {
  const d = tx.db.prepare('SELECT * FROM "execution_domains" WHERE "id" = ?').get(args.domain) as
    | { id: string; account: string; invocation: string | null; launch_state: string; status: string; cgroup_path: string | null }
    | undefined;
  const refuse = (reason: string) => ({ granted: false, reason });
  if (!d || d.account !== ASSISTANT_ACCOUNT) return refuse('the domain is not an assistant turn\'s');
  if (d.launch_state !== 'authorizable') return refuse(`the launch is ${d.launch_state}`);
  if (d.status !== 'allocated') return refuse(`the domain is ${d.status}`);
  if (d.invocation !== args.invocation) return refuse("the invocation is not the domain's");
  const owner = tx.db.prepare('SELECT "incarnation" FROM "process_ownership" WHERE "domain" = ?').get(d.id) as { incarnation: string } | undefined;
  if (!owner || owner.incarnation !== args.incarnation) return refuse('the incarnation is not the one that owns the domain');
  const t = tx.db.prepare('SELECT "status", "cancel_requested_at", "invocation" FROM "assistant_turns" WHERE "invocation" = ?').get(args.invocation) as
    | { status: string; cancel_requested_at: string | null }
    | undefined;
  if (!t || t.status !== 'running') return refuse(`the turn is ${t?.status ?? 'missing'}`);
  if (t.cancel_requested_at !== null) return refuse('the owner cancelled the turn');
  if (statusesOf(tx.db, args.invocation).some((s) => TERMINAL.includes(s))) return refuse('the invocation has ended');
  const r = tx.db.prepare('SELECT "deadline_at" FROM "invocation_receipts" WHERE "id" = ?').get(args.invocation) as { deadline_at: string | null };
  if (r.deadline_at !== null && r.deadline_at <= tx.at) return refuse('the turn is past its deadline');
  const binding = { invocation: args.invocation, incarnation: args.incarnation, account: ASSISTANT_ACCOUNT };
  tx.db
    .prepare(`UPDATE "execution_domains" SET "launch_state" = 'authorized', "launch_binding" = ?, "launch_authorized_at" = ?, "status" = 'launched' WHERE "id" = ?`)
    .run(JSON.stringify(binding), tx.at, d.id);
  tx.db.prepare('UPDATE "process_ownership" SET "containment_id" = ? WHERE "domain" = ?').run(d.cgroup_path, d.id);
  tx.emit('domain.launch_authorized', { account: ASSISTANT_ACCOUNT, domain: d.id, invocation: args.invocation }, { launch_binding: binding, cgroup_path: d.cgroup_path, launcher_pid: args.pid });
  turnLaunched(tx, { invocation: args.invocation, domain: d.id, pid: args.pid, pgid: args.pid, startTime: args.startTime });
  return { granted: true, reason: null };
}

// A usage observation of a turn (D1 §3.6), until the turn's terminal
// observation. false when it is not taken.
export function recordTurnUsage(tx: Tx, args: { invocation: string; semantics: 'cumulative' | 'delta'; raw: unknown }): boolean {
  const r = tx.db.prepare('SELECT "account" FROM "invocation_receipts" WHERE "id" = ?').get(args.invocation) as { account: string } | undefined;
  if (!r || r.account !== ASSISTANT_ACCOUNT) return false;
  if (statusesOf(tx.db, args.invocation).some((s) => TERMINAL.includes(s))) return false;
  if (tx.db.prepare('SELECT 1 FROM "ledger_rows" WHERE "invocation" = ?').get(args.invocation)) return false;
  const { n } = tx.db.prepare('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "usage_observations" WHERE "invocation" = ?').get(args.invocation) as { n: number };
  tx.db
    .prepare(`INSERT INTO "usage_observations" ("id", "created_at", "project", "invocation", "seq", "semantics", "raw", "at", "account") VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'workspace_assistant')`)
    .run(tx.newId('uo_'), tx.at, args.invocation, n, args.semantics, JSON.stringify(args.raw), tx.at);
  tx.emit('invocation.usage', { account: ASSISTANT_ACCOUNT, invocation: args.invocation }, { seq: n, semantics: args.semantics });
  return true;
}

// The in-flight check on a usage observation (§1.3 step 2): the turn limit
// passed by what is known, or a usage observed whose billable count is not
// known (never read as zero, E74 item 3), unless at the backend's terminal
// event, after which it spends nothing.
export function turnLimitCheck(db: Db, args: { invocation: string; terminal?: boolean }): 'assistant_turn_limit' | 'assistant_usage_unknown' | null {
  const observed = (db.prepare('SELECT COUNT(*) AS n FROM "usage_observations" WHERE "invocation" = ?').get(args.invocation) as { n: number }).n > 0;
  if (!observed) return null;
  const so = observedSoFar(db, args.invocation);
  const known = so.billable_in === null || so.out === null ? null : so.billable_in + so.out;
  const limit = invocationLimit(db, args.invocation, null);
  const lower = (so.billable_in ?? 0) + (so.out ?? 0);
  if (lower > limit) return 'assistant_turn_limit';
  if (known === null && args.terminal !== true) return 'assistant_usage_unknown';
  return null;
}

export type TurnOutcome = 'completed' | 'failed' | 'refused' | 'stopped' | 'timed_out' | 'recovered';

// The turn's end, once its domain's termination is established (or nothing
// was ever launched into it), in one transaction (§1.3 step 3): its terminal
// observation; its one original ledger row through the provider's
// normalization, an incomplete usage charged its turn limit less what was
// observed as an unknown allowance (C4), unless it was refused before any
// launch (no row: the refusal releases the reservation, nothing was spent);
// the turn ended with its outcome, reason and validated reply. Idempotent: a
// turn already ended is returned as it is, and its row is never written twice.
export function endTurn(
  tx: Tx,
  args: {
    invocation: string;
    outcome: TurnOutcome;
    reason: string;
    reason_text?: string | null;
    exit?: { exit_class: string | null; exit_evidence: string | null } | null;
    reply?: unknown;
    egress?: readonly EgressAccount[];
    // The engine knows the backend never started (its launch was
    // authorized, its sandbox was not built): nothing was spent.
    never_ran?: boolean;
  },
): { ended: boolean } {
  const t = tx.db.prepare('SELECT * FROM "assistant_turns" WHERE "invocation" = ?').get(args.invocation) as { status: string; conversation: string; intent_id: string } | undefined;
  if (!t) throw notFound('assistant turn', args.invocation);
  if (t.status === 'ended') return { ended: false };
  const r = tx.db.prepare('SELECT "provider", "model_requested" FROM "invocation_receipts" WHERE "id" = ?').get(args.invocation) as { provider: string; model_requested: string };
  const seen = statusesOf(tx.db, args.invocation);
  const launched = seen.includes('launched');
  const refusedBeforeLaunch = args.outcome === 'refused' && (!launched || args.never_ran === true);
  if (!seen.some((s) => TERMINAL.includes(s))) {
    const status = refusedBeforeLaunch ? 'refused' : args.outcome === 'recovered' ? 'unknown' : 'ended';
    observeInvocation(tx, args.invocation, status, args.exit ?? null);
  }
  if (!refusedBeforeLaunch) {
    // The run-shaped facts the ledger's normalization takes: an engine-ended
    // outcome (stopped, timed_out, recovered) keeps what was observed and
    // charges the remainder as unknown.
    const engineOutcome = args.outcome === 'refused' ? 'failed' : args.outcome;
    chargeInvocation(tx, { id: null, project: null, role: ASSISTANT_ACCOUNT, backend: r.provider, model_requested: r.model_requested, outcome: engineOutcome }, { id: args.invocation, turn: null }, args.egress ?? [], 'workspace_assistant');
  }
  tx.db
    .prepare(`UPDATE "assistant_turns" SET "status" = 'ended', "outcome" = ?, "reason" = ?, "reason_text" = ?, "reply" = ?, "ended_at" = ? WHERE "invocation" = ?`)
    .run(args.outcome, args.reason, args.reason_text ?? null, args.reply === undefined || args.reply === null ? null : JSON.stringify(args.reply), tx.at, args.invocation);
  tx.emit('assistant.turn_ended', { account: ASSISTANT_ACCOUNT, invocation: args.invocation }, { conversation: t.conversation, intent_id: t.intent_id, outcome: args.outcome, reason: args.reason, charged: !refusedBeforeLaunch });
  return { ended: true };
}

// The owner's cancel of a turn under way (§4: `stopped` / `human_stop`),
// recorded before the engine cancels; the launch authorization refuses it
// from here. Returns the invocation, or null when there is no turn under way.
export function requestTurnCancel(tx: Tx, args: { conversation: string; intent_id: string }): { invocation: string; status: string } | null {
  const t = tx.db.prepare('SELECT "invocation", "status", "cancel_requested_at" FROM "assistant_turns" WHERE "conversation" = ? AND "intent_id" = ?').get(args.conversation, args.intent_id) as
    | { invocation: string; status: string; cancel_requested_at: string | null }
    | undefined;
  if (!t) return null;
  if (t.status === 'ended' || t.cancel_requested_at !== null) return { invocation: t.invocation, status: t.status };
  tx.db.prepare('UPDATE "assistant_turns" SET "cancel_requested_at" = ? WHERE "invocation" = ?').run(tx.at, t.invocation);
  tx.emit('assistant.cancel_requested', { account: ASSISTANT_ACCOUNT, invocation: t.invocation }, { conversation: args.conversation, intent_id: args.intent_id });
  return { invocation: t.invocation, status: t.status };
}

// The turns an earlier incarnation left unended (D1 §16.1), with their
// domains, for startup recovery: each is ended `recovered` once its domain's
// termination is established, never replayed.
export function unendedTurns(db: Db) {
  return db
    .prepare(
      `SELECT t."invocation", t."status", d."id" AS "domain", d."status" AS "domain_status", d."cgroup_path", d."cgroup_inode", d."launch_binding",
              o."incarnation", o."pid", o."pgid", o."pid_start_time"
       FROM "assistant_turns" t JOIN "execution_domains" d ON d."invocation" = t."invocation" LEFT JOIN "process_ownership" o ON o."domain" = d."id"
       WHERE t."status" <> 'ended' ORDER BY t.rowid`,
    )
    .all() as {
    invocation: string;
    status: string;
    domain: string;
    domain_status: string;
    cgroup_path: string | null;
    cgroup_inode: number | null;
    launch_binding: string | null;
    incarnation: string | null;
    pid: number | null;
    pgid: number | null;
    pid_start_time: string | null;
  }[];
}
