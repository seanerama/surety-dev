// The flows that write the trust table and raise the two decisions about it
// (D2 §§4.1, 7.2, K10): an attempt proposed with its qualification_approval;
// an attempt that succeeded writing its entry proposed with its
// trust_activation. The same functions serve the harness fixtures, which
// stand for what a real attempt would have established (M2 plan §2.3).

import { Refusal } from '../../refusal.js';
import { canaryKindsOf } from '../../trust/canaries.js';
import { openSession } from '../../sessions/session.js';
import { notFound } from './common.js';
import type { CommandResult } from './control.js';
import { raiseQuestion } from './queue.js';
import { observeTrigger } from './work.js';
import {
  type AttemptInput,
  type AttemptRow,
  type EntryInput,
  type EntryRow,
  currentHostQualification,
  currentProfileFingerprint,
  finishAttempt,
  hostEligibility,
  invalidateAttempt,
  profileWithEgress,
  startAttempt,
  getAttempt,
  getHostRow,
  writeAttempt,
  writeEntry,
} from './trust.js';
import type { Tx } from './tx.js';
import { attemptSpendEstimate, attemptSpendUnavailable } from './ledger.js';
import { type RoleProfile, defaultProfileMax, engineSettings, projectPolicy, roleProfileOf } from './settings.js';

// An attempt is proposed and its approval asked for; nothing runs until a
// person authorizes it (Q7).
export function proposeAttempt(tx: Tx, input: AttemptInput, label: Record<string, unknown> = {}): { attempt: AttemptRow; decision: string | null } {
  const attempt = writeAttempt(tx, input, label);
  const d = raiseQuestion(tx, { project: null, kind: 'qualification_approval', subjectType: 'qualification_attempt', subjectId: attempt.id });
  // The row names its approval (SEAM.md §148).
  if (d) tx.db.prepare('UPDATE "qualification_attempts" SET "decision" = ? WHERE "id" = ?').run(d.id, attempt.id);
  return { attempt: { ...attempt, decision: d?.id ?? null }, decision: d?.id ?? null };
}

// A trust entry is written proposed and its activation asked for (D2 §4.1).
// An entry whose canaries observed no usage is written and never asked
// about: it cannot be activated (D2 §4.2).
export function proposeEntry(tx: Tx, input: EntryInput, label: Record<string, unknown> = {}): { entry: EntryRow; decision: string | null } {
  const entry = writeEntry(tx, input, label);
  const d = raiseQuestion(tx, { project: null, kind: 'trust_activation', subjectType: 'trust_entry', subjectId: entry.id });
  return { entry, decision: d?.id ?? null };
}

// A running attempt whose canaries all passed writes its entry (D2 §7.2); one
// whose canary failed ends `failed` with nothing written.
export function concludeAttempt(
  tx: Tx,
  args: { attempt: string; canaries: { kind: string; run: string | null; passed: boolean; failure_class?: string; provider_error?: string | null }[]; unexpected_contacts?: unknown[]; entry?: EntryInput },
  label: Record<string, unknown> = {},
): { status: 'succeeded' | 'failed'; entry: string | null; decision: string | null } {
  const a = getAttempt(tx.db, args.attempt)!;
  const passed = args.canaries.length === canaryKindsOf(a).length && args.canaries.every((c) => c.passed);
  // An active entry's session qualification (D6 §2.6): it writes no entry;
  // its passing continuation canary makes that entry session_qualified.
  if (a.session_entry) {
    if (!passed) {
      finishAttempt(tx, a, { outcome: 'failed', canaries: args.canaries, unexpected_contacts: args.unexpected_contacts ?? [] });
      return { status: 'failed', entry: null, decision: null };
    }
    finishAttempt(tx, a, { outcome: 'succeeded', canaries: args.canaries, unexpected_contacts: args.unexpected_contacts ?? [], trust_entry: a.session_entry });
    tx.db.prepare('UPDATE "trust_entries" SET "session_qualified" = 1 WHERE "id" = ? AND "status" = \'active\'').run(a.session_entry);
    return { status: 'succeeded', entry: a.session_entry, decision: null };
  }
  if (!passed || !args.entry) {
    finishAttempt(tx, a, { outcome: 'failed', canaries: args.canaries, unexpected_contacts: args.unexpected_contacts ?? [] });
    return { status: 'failed', entry: null, decision: null };
  }
  // The entry is held to the profile this host qualifies with its own
  // egress list (SEAM.md §150).
  const current = currentProfileFingerprint();
  const profile = current === null ? args.entry.profile_fingerprint : profileWithEgress(current, args.entry.egress_hosts);
  const { entry, decision } = proposeEntry(tx, { ...args.entry, profile_fingerprint: profile, qualification_attempt: a.id }, label);
  finishAttempt(tx, a, { outcome: 'succeeded', canaries: args.canaries, unexpected_contacts: args.unexpected_contacts ?? [], trust_entry: entry.id });
  return { status: 'succeeded', entry: entry.id, decision };
}

// POST /v1/trust/qualify (D2 §7.2, K10, Q7, A.3, A.7): the attempt written
// `proposed`, binding before any launch the binary and help hashes, the
// template and its version, the model, the authentication mode, the current
// host qualification, the fixture project, the candidate egress list, a
// deadline per canary and the spend, an estimate labelled as one with the
// invocation overshoot stated (no M2 mechanism enforces a cap; a provider-side
// cap on the key is shown as configured). Its qualification_approval is
// raised. Nothing is launched.
export function qualify(
  tx: Tx,
  a: {
    backend: string;
    mode: string;
    model: string;
    auth_mode?: string;
    binary_path: string;
    binary_sha256: string;
    help_sha256: string;
    version: string;
    template: string;
    template_version: string;
    candidate_egress: string[];
    fixture_project: string;
    canary_deadlines: Record<string, number>;
    provider_cap_usd?: number | null;
    mode_requested?: 'one_shot_headless' | 'session_headless';
    session_entry?: string | null;
    role_memory_max?: number | null;
    canary_limit_tokens?: number | null;
  },
): CommandResult {
  // The role profile the attempt qualifies (D6-X09; B09): an entry's own for
  // its session qualification; else the one asked for, never above the
  // engine's ceiling, or the default under it.
  const ceiling = engineSettings().domain_memory_max;
  if (a.role_memory_max != null && ceiling !== undefined && a.role_memory_max > ceiling) {
    throw new Refusal(400, 'invalid_value', `role_memory_max must be at most the engine's domain_memory_max (${ceiling}).`, 'Ask for a profile under the ceiling.', { field: 'role_memory_max', max: ceiling });
  }
  // An entry's session qualification (D6 §2.6): the entry active, not yet
  // qualified for sessions.
  if (a.session_entry) {
    const e = tx.db.prepare('SELECT * FROM "trust_entries" WHERE "id" = ?').get(a.session_entry) as EntryRow | undefined;
    if (!e) throw notFound('trust entry', a.session_entry);
    if (e.status !== 'active' || e.session_qualified === 1) {
      throw new Refusal(409, 'illegal_transition', `Trust entry ${a.session_entry} is ${e.status}${e.session_qualified === 1 ? ' and already qualified for sessions' : ''}: only an active entry not yet qualified for sessions is.`, 'Name an active entry.', { entry: a.session_entry });
    }
    // What the entry was qualified with holds now (the review's M2): its
    // model, binary and help (checked by the route), its profile with its
    // own egress list, and a host qualification of the same mechanism.
    const mismatch = (what: string, expected: unknown, found: unknown) =>
      new Refusal(409, 'backend_refused', `Trust entry ${e.id}'s ${what} is not what it was qualified with: a session qualification runs only on what the entry qualified.`, 'Qualify the entry anew with a new attempt.', { entry: e.id, field: what, expected, found });
    if (e.model !== a.model) throw mismatch('model', e.model, a.model);
    if (e.binary_sha256 !== a.binary_sha256 || e.help_sha256 !== a.help_sha256) throw mismatch('binary', e.binary_sha256, a.binary_sha256);
    const now = currentProfileFingerprint();
    const profileNow = now === null ? null : profileWithEgress(now, JSON.parse(e.egress_hosts) as string[]);
    if (profileNow !== e.profile_fingerprint) throw mismatch('profile', e.profile_fingerprint, profileNow);
    const hqNow = currentHostQualification(tx.db);
    const then = e.host_qualification === null ? undefined : getHostRow(tx.db, e.host_qualification);
    if (!hqNow || !then || then.mechanism_fingerprint !== hqNow.mechanism_fingerprint) throw mismatch('host qualification', then?.mechanism_fingerprint ?? null, hqNow?.mechanism_fingerprint ?? null);
  }
  const project = tx.db.prepare('SELECT "id", "registration_state" FROM "projects" WHERE "id" = ?').get(a.fixture_project) as { id: string; registration_state: string } | undefined;
  if (!project) throw notFound('project', a.fixture_project);
  const hq = currentHostQualification(tx.db);
  const host = hostEligibility(tx.db);
  if (!hq || !host.eligible) {
    throw new Refusal(409, 'isolation_unqualified', 'No current host qualification makes this host eligible: a qualification attempt binds one.', 'Start the engine where the host checks pass.', {
      host_eligibility: host,
    });
  }
  const current = currentProfileFingerprint();
  const profile = current === null ? null : profileWithEgress(current, a.candidate_egress);
  if (profile === null) throw new Refusal(409, 'isolation_unqualified', "This start's checks did not establish the role profile an attempt binds.", 'Start the engine where the host checks pass.', {});
  // The spend (D2 §7.2, Q7; SEAM.md §§148, 161): no M2 mechanism enforces a
  // cap; the figure is an estimate, labelled, under the fixture project's
  // run limit, and null where no price is known (never 0).
  const canaries = a.session_entry ? 2 : a.mode_requested === 'session_headless' ? 5 : 3;
  // The workspace assistant's attempt (the assistant design §3, O7): each
  // canary limited to the assistant's turn limit, charged to the fixture
  // project's ledger and shown with the attempt, never the assistant's account.
  const canaryLimit = a.canary_limit_tokens ?? null;
  const estimate = attemptSpendEstimate(a.backend, a.model, canaryLimit ?? projectPolicy(tx.db, a.fixture_project).budget_run_billable_tokens!, canaries);
  const spend = {
    cap: null,
    estimate: estimate?.usd ?? null,
    label: 'estimate',
    overshoot: 'deadline',
    ...(estimate
      ? {
          basis: canaryLimit !== null
            ? `three canaries at the workspace assistant's turn_limit_billable_tokens (${canaryLimit}), at the model's output rate`
            : a.session_entry
            ? "the continuation canary's two turns at the fixture project's budget_run_billable_tokens, at the model's output rate"
            : a.mode_requested === 'session_headless'
              ? "three canaries and the continuation canary's two turns at the fixture project's budget_run_billable_tokens, at the model's output rate"
              : "three canaries at the fixture project's budget_run_billable_tokens, at the model's output rate",
          price_version: estimate.price_version,
          // Codex's prices are unconfirmed (C2): the figure says so.
          ...(estimate.prices === 'unconfirmed' ? { prices: 'unconfirmed' } : {}),
        }
      : // Codex (C2): why there is no figure, never a 0.
        a.backend === 'codex'
        ? { estimate_unavailable: attemptSpendUnavailable(a.backend, a.model) }
        : {}),
    auth_mode: a.auth_mode ?? 'api_key',
    ...(canaryLimit !== null ? { purpose: 'assistant', canary_limit_tokens: canaryLimit, charged_to: { account: 'project', project: a.fixture_project, as: 'qualification' } } : {}),
    // A provider-side cap is an API key's only (SEAM.md §160): a subscription
    // has none on its token, its hard limit being its usage limits.
    ...(a.provider_cap_usd && (a.auth_mode ?? 'api_key') === 'api_key' ? { provider_cap: { status: 'configured', usd: a.provider_cap_usd } } : {}),
  };
  const { attempt, decision } = proposeAttempt(tx, {
    backend: a.backend,
    version: a.version,
    binary_path: a.binary_path,
    binary_sha256: a.binary_sha256,
    help_sha256: a.help_sha256,
    template: a.template,
    template_version: a.template_version,
    model: a.model,
    auth_mode: a.auth_mode ?? 'api_key',
    host_qualification: hq.id,
    profile_fingerprint: profile,
    fixture_project: a.fixture_project,
    candidate_egress: a.candidate_egress,
    canary_deadlines: a.canary_deadlines,
    spend,
    mode: a.mode_requested ?? 'one_shot_headless',
    session_entry: a.session_entry ?? null,
    profile: a.session_entry
      ? (JSON.parse(((tx.db.prepare('SELECT "profile" FROM "trust_entries" WHERE "id" = ?').get(a.session_entry) as { profile: string | null } | undefined)?.profile ?? 'null')) as RoleProfile | null)
      : roleProfileOf(a.role_memory_max ?? defaultProfileMax('role')),
  });
  return { status: 201, body: { qualification_attempt: { id: attempt.id, status: attempt.status }, decision } };
}

// ---- an authorized attempt's canaries (D2 §7.2, K10; trust/attempts.ts) ----------------------

export const attemptsDue = (db: Tx['db']) => db.prepare(`SELECT "id", "status" FROM "qualification_attempts" WHERE "status" IN ('authorized', 'running') ORDER BY rowid, "id"`).all() as { id: string; status: string }[];

export function startAttemptRun(tx: Tx, a: { attempt: string }): AttemptRow {
  const row = getAttempt(tx.db, a.attempt);
  if (!row) throw notFound('qualification attempt', a.attempt);
  if (row.status === 'running') return row;
  return startAttempt(tx, a);
}

export function invalidateAttemptBy(tx: Tx, a: { attempt: string; reason: string }): void {
  const row = getAttempt(tx.db, a.attempt);
  if (row) invalidateAttempt(tx, row, a.reason);
}

// One canary's work item on the fixture project, belonging to the attempt:
// no other dispatch runs it (runs.ts, dispatchBlocker).
export function canaryItem(tx: Tx, a: { attempt: string; kind: string }): string {
  const row = getAttempt(tx.db, a.attempt);
  if (!row || row.fixture_project === null) throw notFound('qualification attempt', a.attempt);
  const made = observeTrigger(
    tx,
    { project: row.fixture_project, kind: 'verification', trigger_source: 'qualification', trigger_id: `${row.id}:${a.kind}`, trigger_generation: 1, subject: {} },
    { qualification_attempt: row.id, canary: a.kind },
  );
  tx.db.prepare('UPDATE "work_items" SET "qualification_attempt" = ?, "canary_kind" = ? WHERE "id" = ?').run(row.id, a.kind, made.work_item.id);
  return made.work_item.id;
}

export function recordCanary(tx: Tx, a: { attempt: string; canary: Record<string, unknown>; unexpected: unknown[] }): void {
  const row = getAttempt(tx.db, a.attempt);
  if (!row) throw notFound('qualification attempt', a.attempt);
  const list = JSON.parse(row.canaries ?? '[]') as Record<string, unknown>[];
  list.push(a.canary);
  tx.db.prepare('UPDATE "qualification_attempts" SET "canaries" = ?, "unexpected_contacts" = ? WHERE "id" = ?').run(JSON.stringify(list), JSON.stringify(a.unexpected), row.id);
}

export function attemptTarget(db: Tx['db'], a: { project: string | null }) {
  if (a.project === null) return null;
  return (db.prepare('SELECT "id" AS "project", "dev_repo_path" AS "repo", "integration_branch" AS "branch" FROM "projects" WHERE "id" = ?').get(a.project) as { project: string; repo: string; branch: string } | undefined) ?? null;
}

export function canaryRunFacts(db: Tx['db'], a: { run: string }) {
  const run = db.prepare('SELECT "outcome", "transcript", "provider_session_id" FROM "runs" WHERE "id" = ?').get(a.run) as
    | { outcome: string | null; transcript: string | null; provider_session_id: string | null }
    | undefined;
  const exit = db
    .prepare(`SELECT o."exit_class" FROM "invocation_status_observations" o JOIN "invocation_receipts" r ON r."id" = o."invocation" WHERE r."run" = ? AND o."exit_class" IS NOT NULL ORDER BY o."seq" DESC LIMIT 1`)
    .get(a.run) as { exit_class: string } | undefined;
  return { outcome: run?.outcome ?? null, exit_class: exit?.exit_class ?? null, transcript: run?.transcript ?? null, provider_session_id: run?.provider_session_id ?? null };
}

// Whether the attempt's canaries observed usage, and a cost (D2 §4.2).
export function attemptUsage(db: Tx['db'], a: { attempt: string }) {
  const rows = db
    .prepare(`SELECT u."raw" FROM "usage_observations" u JOIN "invocation_receipts" r ON r."id" = u."invocation" WHERE r."qualification_attempt" = ?`)
    .all(a.attempt) as { raw: string }[];
  return { observations: rows.length, cost: rows.some((r) => /"cost_usd"\s*:/.test(r.raw) || /"total_cost_usd(_estimate)?"\s*:/.test(r.raw)) };
}


// D6 §2.6 (M5 slice 33): the continuation canary's session, opened on the
// attempt's fixture project under its authority alone (sessions/session.ts).
export function canarySession(tx: Tx, a: { attempt: string; incarnation: string }): { run: Record<string, unknown> } {
  const row = getAttempt(tx.db, a.attempt);
  if (!row || row.fixture_project === null) throw notFound('qualification attempt', a.attempt);
  return openSession(tx, { project: row.fixture_project, role: 'vision', scripted: null, incarnation: a.incarnation, attempt: row.id });
}

// What the continuation canary's judgement reads of its session run: each
// turn's outcome and reply, its domain, when its invocation launched and
// ended; the provider-files inventories; the models the ledger observed.
export function continuationFacts(db: Tx['db'], a: { run: string }) {
  const run = db.prepare('SELECT "state" FROM "runs" WHERE "id" = ?').get(a.run) as { state: string } | undefined;
  const turns = (db.prepare('SELECT "number", "invocation", "domain", "outcome", "usage_status", "settled_at", "reply" FROM "turns" WHERE "run" = ? ORDER BY "number"').all(a.run) as {
    number: number;
    invocation: string;
    domain: string;
    outcome: string | null;
    usage_status: string | null;
    settled_at: string | null;
    reply: string | null;
  }[]).map((t) => {
    const at = (status: string[]) =>
      (db.prepare(`SELECT MIN("at") AS at FROM "invocation_status_observations" WHERE "invocation" = ? AND "status" IN (${status.map(() => '?').join(', ')})`).get(t.invocation, ...status) as { at: string | null }).at;
    // Which came first is the store's insertion order, never the wall times
    // (D1's monotonic rule; the slice-36 review's M4): a clock step must not
    // fail the canary.
    const order = (status: string[]) =>
      (db.prepare(`SELECT MIN(rowid) AS o FROM "invocation_status_observations" WHERE "invocation" = ? AND "status" IN (${status.map(() => '?').join(', ')})`).get(t.invocation, ...status) as { o: number | null }).o;
    const d = db.prepare('SELECT "status" FROM "execution_domains" WHERE "id" = ?').get(t.domain) as { status: string } | undefined;
    return { ...t, domain_status: d?.status ?? null, launched_at: at(['launched']), ended_at: at(['ended', 'unknown']), launched_order: order(['launched']), ended_order: order(['ended', 'unknown']) };
  });
  const inventories = db
    .prepare(`SELECT "id", "path", "sha256", "bytes" FROM "records" WHERE "run" = ? AND "kind" = 'provider_files' AND "published" = 1 ORDER BY rowid, "id"`)
    .all(a.run) as { id: string; path: string | null; sha256: string | null; bytes: number | null }[];
  const models = (db.prepare('SELECT "model_observed" FROM "ledger_rows" WHERE "run" = ? AND "corrects" IS NULL AND "model_observed" IS NOT NULL').all(a.run) as { model_observed: string }[]).flatMap((r) => r.model_observed.split(','));
  return { state: run?.state ?? 'unknown', turns, inventories, models_observed: [...new Set(models.map((m) => m.trim()).filter((m) => m !== ''))] };
}
