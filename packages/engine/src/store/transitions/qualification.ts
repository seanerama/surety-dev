// The flows that write the trust table and raise the two decisions about it
// (D2 §§4.1, 7.2, K10): an attempt proposed with its qualification_approval;
// an attempt that succeeded writing its entry proposed with its
// trust_activation. The same functions serve the harness fixtures, which
// stand for what a real attempt would have established (M2 plan §2.3).

import { Refusal } from '../../refusal.js';
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
  writeAttempt,
  writeEntry,
} from './trust.js';
import type { Tx } from './tx.js';
import { attemptSpendEstimate } from './ledger.js';
import { projectPolicy } from './settings.js';

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
  const passed = args.canaries.length === 3 && args.canaries.every((c) => c.passed);
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
  },
): CommandResult {
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
  const estimate = attemptSpendEstimate(a.backend, a.model, projectPolicy(tx.db, a.fixture_project).budget_run_billable_tokens!);
  const spend = {
    cap: null,
    estimate: estimate?.usd ?? null,
    label: 'estimate',
    overshoot: 'deadline',
    ...(estimate ? { basis: 'three canaries at the fixture project\'s budget_run_billable_tokens, at the model\'s output rate', price_version: estimate.price_version } : {}),
    ...(a.provider_cap_usd ? { provider_cap: { status: 'configured', usd: a.provider_cap_usd } } : {}),
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
    auth_mode: 'api_key',
    host_qualification: hq.id,
    profile_fingerprint: profile,
    fixture_project: a.fixture_project,
    candidate_egress: a.candidate_egress,
    canary_deadlines: a.canary_deadlines,
    spend,
  });
  return { status: 201, body: { qualification_attempt: { id: attempt.id, status: attempt.status }, decision } };
}

// ---- an authorized attempt's canaries (D2 §7.2, K10; trust/attempts.ts) ----------------------

export const attemptsDue = (db: Tx['db']) => db.prepare(`SELECT "id", "status" FROM "qualification_attempts" WHERE "status" IN ('authorized', 'running') ORDER BY "created_at", "id"`).all() as { id: string; status: string }[];

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
  return { observations: rows.length, cost: rows.some((r) => /"cost_usd"\s*:/.test(r.raw) || /"total_cost_usd"\s*:/.test(r.raw)) };
}

