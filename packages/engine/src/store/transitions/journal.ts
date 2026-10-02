// The git journal and operation attempts (D1 §§2.5, 3.5, 4.4, 6.3, 7.10, A.5;
// build spec §6 corrections 14 and 16; SEAM.md §§44, 45). Every repository
// mutation is an operation with one idempotency key; each execution of its
// effect is an attempt. The journal's events are immutable facts, and
// `git_journal_state` is their projection, moved only in the transaction
// that appends an event. An operation's status is never written by hand: it
// is derived, after every change, from its latest attempt, its journal state
// and whether a linked successor is recorded.
//
// Each function is one step of an operation, run in the caller's
// transaction. The main thread (journal/driver.ts) makes the git effect and
// the probes between them; no transaction is held across a git call.

import { canonical, illegal, nextSeq, notFound, sha256 } from './common.js';
import { type DecisionRow, invalidateDecision } from './decisions.js';
import { raiseQuestion } from './queue.js';
import { markBlockedStale } from './evidence.js';
import { runFinalizer } from './finalize.js';
import type { Tx } from './tx.js';

export type JournalKind = 'ref_update' | 'commit_tree' | 'worktree_add' | 'worktree_remove';
export type JournalState = 'intended' | 'applied' | 'confirmed' | 'failed' | 'ambiguous' | 'finalized';
export type AttemptStatus = 'started' | 'succeeded' | 'failed' | 'ambiguous' | 'reconciled_succeeded' | 'reconciled_absent' | 'reconciled_partial';
export type ProbeOutcome = 'absent' | 'applied' | 'partial' | 'conflicting' | 'unknown';

export const OPERATION_KIND: Record<JournalKind, string> = {
  ref_update: 'git_ref_update',
  commit_tree: 'git_commit',
  worktree_add: 'git_worktree',
  worktree_remove: 'git_worktree',
};

// D1 A.5 Journal, with correction 14's two edges out of `ambiguous`.
const EDGES: Record<JournalState, JournalState[]> = {
  intended: ['applied', 'failed', 'ambiguous'],
  applied: ['confirmed', 'ambiguous'],
  confirmed: ['finalized'],
  ambiguous: ['applied', 'failed'],
  failed: [],
  finalized: [],
};

export interface JournalPayload {
  repo: string;
  run?: string;
  ref?: string;
  old_oid?: string | null;
  new_oid?: string;
  tree?: string;
  path?: string;
  base?: string;
  workspace?: string;
}

export interface AttemptRow {
  id: string;
  attempt_number: number;
  status: AttemptStatus;
  incarnation: string | null;
  reconciliation_reads: string;
}

export interface OpDetail {
  id: string;
  project: string;
  kind: JournalKind;
  status: string;
  finalized: boolean;
  payload: JournalPayload;
  inputs: Record<string, unknown>;
  state: JournalState;
  seq: number;
  attempts: AttemptRow[];
  blocker: string | null;
  remaining_scope: Record<string, unknown> | null;
  outcome_detail: Record<string, unknown> | null;
}

interface OpRow {
  id: string;
  project: string;
  kind: string;
  status: string;
  finalized_at: string | null;
  finalizer_inputs: string;
  remaining_scope: string | null;
  outcome_detail: string | null;
  linked_prior: string | null;
}

export function opDetail(tx: Tx, id: string): OpDetail {
  const op = tx.db.prepare('SELECT * FROM "operations" WHERE "id" = ?').get(id) as OpRow | undefined;
  if (!op) throw notFound('operation', id);
  const events = tx.db.prepare('SELECT "seq", "journal_kind", "event_kind", "payload" FROM "git_journal_events" WHERE "operation" = ? ORDER BY "seq"').all(id) as {
    seq: number;
    journal_kind: JournalKind;
    event_kind: JournalState;
    payload: string;
  }[];
  if (events.length === 0) throw notFound('operation journal', id);
  const attempts = tx.db.prepare('SELECT * FROM "operation_attempts" WHERE "operation" = ? ORDER BY "attempt_number"').all(id) as AttemptRow[];
  const blocker = tx.db
    .prepare(`SELECT "id" FROM "decisions" WHERE "kind" = 'blocker' AND "subject_type" = 'operation' AND "subject_id" = ? AND "status" = 'open' LIMIT 1`)
    .get(id) as { id: string } | undefined;
  return {
    id,
    project: op.project,
    kind: events[0]!.journal_kind,
    status: op.status,
    finalized: op.finalized_at !== null,
    payload: JSON.parse(events[0]!.payload) as JournalPayload,
    inputs: JSON.parse(op.finalizer_inputs) as Record<string, unknown>,
    state: events.at(-1)!.event_kind,
    seq: events.at(-1)!.seq,
    attempts,
    blocker: blocker?.id ?? null,
    remaining_scope: op.remaining_scope === null ? null : (JSON.parse(op.remaining_scope) as Record<string, unknown>),
    outcome_detail: op.outcome_detail === null ? null : (JSON.parse(op.outcome_detail) as Record<string, unknown>),
  };
}

// The operation's status (contract `attempts.derivation`, rules in order).
export function deriveStatus(latest: AttemptStatus | null, journal: JournalState, successor: boolean): string {
  if (successor && latest !== 'succeeded' && latest !== 'reconciled_succeeded') return 'superseded';
  if (latest === 'succeeded' || latest === 'reconciled_succeeded') return 'succeeded';
  if (latest === null && (journal === 'confirmed' || journal === 'finalized')) return 'succeeded';
  if (journal === 'failed') return 'failed';
  if (latest === null && journal === 'ambiguous') return 'ambiguous';
  if (latest === null) return 'intended';
  if (latest === 'started') return 'in_progress';
  if (latest === 'failed') return 'failed';
  if (latest === 'ambiguous') return 'ambiguous';
  if (latest === 'reconciled_partial') return 'partial';
  return 'intended';
}

const STATUS_EVENTS: Record<string, 'operation.succeeded' | 'operation.failed' | 'operation.partial' | 'operation.ambiguous'> = {
  succeeded: 'operation.succeeded',
  failed: 'operation.failed',
  partial: 'operation.partial',
  ambiguous: 'operation.ambiguous',
};

// Recompute and store the operation's status; emit the event of a status
// that is new.
export function refreshStatus(tx: Tx, id: string): string {
  const op = opDetail(tx, id);
  const successor = (tx.db.prepare('SELECT COUNT(*) AS n FROM "operations" WHERE "linked_prior" = ?').get(id) as { n: number }).n > 0;
  const status = deriveStatus(op.attempts.at(-1)?.status ?? null, op.state, successor);
  if (status !== op.status) {
    tx.db.prepare('UPDATE "operations" SET "status" = ? WHERE "id" = ?').run(status, id);
    const type = STATUS_EVENTS[status];
    if (type) tx.emit(type, { project: op.project, operation: id, run: op.payload.run ?? null }, { journal_kind: op.kind, from: op.status });
  }
  return status;
}

// Append one journal event, move the projection with it, and log it.
function append(tx: Tx, op: OpDetail, to: JournalState): void {
  if (!EDGES[op.state].includes(to)) throw illegal(`journal ${op.state} → ${to}`, { operation: op.id, from: op.state, to });
  const seq = op.seq + 1;
  tx.db
    .prepare('INSERT INTO "git_journal_events" ("id", "created_at", "project", "operation", "seq", "journal_kind", "event_kind", "payload") VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(tx.newId('gje_'), tx.at, op.project, op.id, seq, op.kind, to, JSON.stringify(op.payload));
  tx.db.prepare('UPDATE "git_journal_state" SET "state" = ?, "last_event_seq" = ? WHERE "operation" = ?').run(to, seq, op.id);
  if (to !== 'failed') tx.emit(`git.journal_${to}` as const, { project: op.project, operation: op.id, run: op.payload.run ?? null }, { journal_kind: op.kind, seq });
  op.state = to;
  op.seq = seq;
  // A journal operation that is no longer pending no longer blocks a gate.
  if (to === 'finalized' || to === 'failed') markBlockedStale(tx, op.project, ['GIT_JOURNAL_PENDING']);
}

const latestAttempt = (op: OpDetail): AttemptRow | undefined => op.attempts.at(-1);

function setAttempt(tx: Tx, attempt: AttemptRow, status: AttemptStatus, read?: { outcome: ProbeOutcome; read: string }): void {
  const reads = JSON.parse(attempt.reconciliation_reads) as { at: string; read: string; result: string }[];
  if (read) reads.push({ at: tx.at, read: read.read, result: read.outcome });
  const finished = status === 'started' ? null : tx.at;
  tx.db
    .prepare('UPDATE "operation_attempts" SET "status" = ?, "finished_at" = COALESCE("finished_at", ?), "reconciliation_reads" = ? WHERE "id" = ?')
    .run(status, finished, JSON.stringify(reads), attempt.id);
  attempt.status = status;
  attempt.reconciliation_reads = JSON.stringify(reads);
}

function closeBlocker(tx: Tx, op: OpDetail, reason: string): void {
  if (op.blocker === null) return;
  const d = tx.db.prepare('SELECT * FROM "decisions" WHERE "id" = ?').get(op.blocker) as DecisionRow;
  invalidateDecision(tx, d, reason);
  op.blocker = null;
}

// ---- the intent ------------------------------------------------------------------

export interface IntentSpec {
  project: string;
  kind: JournalKind;
  payload: JournalPayload;
  // What, with the kind, identifies the effect: sha256(kind, target,
  // subject, semantic_generation) is the idempotency key (D1 §2.5).
  target: Record<string, unknown>;
  subject: Record<string, unknown>;
  finalizer: Record<string, unknown>;
  deadlineSeconds: number;
  // The run on whose behalf the effect is made: an intent for a run whose
  // lease is closing or released is refused (D1 §8.3).
  run?: string;
  // Name a failed operation that did what this one is to do (D1 §4.4).
  linkFailedIntegration?: { workItem: string; ref: string };
}

export type IntentResult = { operation: string; existing: boolean } | { fenced: true };

const addSeconds = (iso: string, seconds: number) => new Date(Date.parse(iso) + seconds * 1000).toISOString();

// May an effect be made on behalf of this run now? Its lease must be held:
// unreleased and not closing; and the run must not be ending or ended.
//
// A run that is ending (its lease closing: a Stop, an Abandon, a deadline) is
// fenced, and so is one that ended stopped or abandoned. A run that ended
// otherwise (recovered, after a crash) is not: recovery completes what such
// a run had journaled (SEAM.md §45).
export function runFenced(tx: Tx, run: string): boolean {
  const r = tx.db.prepare('SELECT "state", "outcome" FROM "runs" WHERE "id" = ?').get(run) as { state: string; outcome: string | null } | undefined;
  if (!r || r.state === 'finalizing') return true;
  if (r.state === 'ended') return r.outcome === 'stopped' || r.outcome === 'abandoned';
  const lease = tx.db.prepare(`SELECT "closing" FROM "leases" WHERE "resource_kind" = 'run' AND "resource_id" = ? AND "released_at" IS NULL`).get(run) as { closing: number } | undefined;
  return !lease || lease.closing === 1;
}

export function intendOperation(tx: Tx, spec: IntentSpec): IntentResult {
  const opKind = OPERATION_KIND[spec.kind];
  const key = sha256(canonical({ kind: opKind, journal_kind: spec.kind, target: spec.target, subject: spec.subject, generation: 1 }));
  const existing = tx.db.prepare('SELECT "id" FROM "operations" WHERE "idempotency_key" = ?').get(key) as { id: string } | undefined;
  if (existing) return { operation: existing.id, existing: true };
  if (spec.run !== undefined && runFenced(tx, spec.run)) return { fenced: true };

  let prior: string | null = null;
  if (spec.linkFailedIntegration) {
    const row = tx.db
      .prepare(
        `SELECT o."id" FROM "operations" o WHERE o."project" = ? AND o."kind" = 'git_ref_update' AND o."status" = 'failed'
         AND json_extract(o."finalizer_inputs", '$.purpose') = 'integration' AND json_extract(o."finalizer_inputs", '$.work_item') = ?
         AND json_extract(o."finalizer_inputs", '$.ref') = ?
         AND NOT EXISTS (SELECT 1 FROM "operations" s WHERE s."linked_prior" = o."id")
         ORDER BY o."seq" DESC LIMIT 1`,
      )
      .get(spec.project, spec.linkFailedIntegration.workItem, spec.linkFailedIntegration.ref) as { id: string } | undefined;
    prior = row?.id ?? null;
  }

  const id = tx.newId('op_');
  tx.db
    .prepare(
      `INSERT INTO "operations" ("id", "created_at", "project", "seq", "kind", "target", "subject", "idempotency_key", "semantic_generation", "status",
         "linked_prior", "deadline_at", "finalizer_inputs")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'intended', ?, ?, ?)`,
    )
    .run(
      id,
      tx.at,
      spec.project,
      nextSeq(tx, spec.project, 'operations'),
      opKind,
      JSON.stringify(spec.target),
      JSON.stringify(spec.subject),
      key,
      prior,
      addSeconds(tx.at, spec.deadlineSeconds),
      JSON.stringify(spec.finalizer),
    );
  tx.emit('operation.intended', { project: spec.project, operation: id, run: spec.payload.run ?? null }, { kind: opKind, journal_kind: spec.kind });
  tx.db
    .prepare('INSERT INTO "git_journal_events" ("id", "created_at", "project", "operation", "seq", "journal_kind", "event_kind", "payload") VALUES (?, ?, ?, ?, 1, ?, \'intended\', ?)')
    .run(tx.newId('gje_'), tx.at, spec.project, id, spec.kind, JSON.stringify(spec.payload));
  tx.db
    .prepare('INSERT INTO "git_journal_state" ("id", "created_at", "project", "operation", "journal_kind", "state", "last_event_seq") VALUES (?, ?, ?, ?, ?, \'intended\', 1)')
    .run(tx.newId('gjs_'), tx.at, spec.project, id, spec.kind);
  tx.emit('git.journal_intended', { project: spec.project, operation: id, run: spec.payload.run ?? null }, { journal_kind: spec.kind, seq: 1 });
  if (prior !== null) refreshStatus(tx, prior);
  return { operation: id, existing: false };
}

// ---- attempts --------------------------------------------------------------------

const ADMITS_NEXT: AttemptStatus[] = ['reconciled_absent', 'reconciled_partial'];

function admits(op: OpDetail): boolean {
  const latest = latestAttempt(op);
  return latest === undefined || ADMITS_NEXT.includes(latest.status);
}

function insertAttempt(tx: Tx, op: OpDetail, status: AttemptStatus, incarnation: string): AttemptRow {
  const n = (latestAttempt(op)?.attempt_number ?? 0) + 1;
  const id = tx.newId('att_');
  tx.db
    .prepare(
      `INSERT INTO "operation_attempts" ("id", "created_at", "project", "operation", "attempt_number", "status", "started_at", "finished_at", "timeline", "reconciliation_reads", "incarnation")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
    )
    .run(id, tx.at, op.project, op.id, n, status, tx.at, status === 'started' ? null : tx.at, JSON.stringify([{ at: tx.at, event: status, detail: null }]), incarnation);
  const row: AttemptRow = { id, attempt_number: n, status, incarnation, reconciliation_reads: '[]' };
  op.attempts.push(row);
  return row;
}

// The operation's effect is refused before anything was applied: the
// attempt (a new one, admitted as any would be) is failed, and so are the
// journal and the operation. Failed is not proven absence: nothing retries it.
function refuseInTx(tx: Tx, op: OpDetail, detail: Record<string, unknown>, incarnation: string): void {
  const latest = latestAttempt(op);
  if (latest && latest.status === 'started') setAttempt(tx, latest, 'failed');
  else if (admits(op)) insertAttempt(tx, op, 'failed', incarnation);
  if (op.state === 'applied') append(tx, op, 'ambiguous');
  append(tx, op, 'failed');
  tx.db.prepare('UPDATE "operations" SET "outcome_detail" = ? WHERE "id" = ?').run(JSON.stringify(detail), op.id);
  closeBlocker(tx, op, 'the operation failed');
  refreshStatus(tx, op.id);
}

// Issue the next attempt (D1 §2.5; correction 16): the first is admitted
// once, a further one only after the previous was positively reconciled. An
// attempt on behalf of a run whose lease is closing is refused instead.
export function startAttempt(tx: Tx, args: { operation: string; incarnation: string }): { attempt: number } | { refused: 'closing' } {
  const op = opDetail(tx, args.operation);
  if (op.state !== 'intended' && op.state !== 'ambiguous') throw illegal(`an attempt of a ${op.state} operation`, { operation: op.id });
  if (!admits(op)) throw illegal(`an attempt after a ${latestAttempt(op)!.status} one`, { operation: op.id });
  if ((op.inputs as { fence?: boolean }).fence === true && op.payload.run !== undefined && runFenced(tx, op.payload.run)) {
    refuseInTx(tx, op, { reason: 'closing', text: 'the run on whose behalf the effect was to be made is ending' }, args.incarnation);
    return { refused: 'closing' };
  }
  const attempt = insertAttempt(tx, op, 'started', args.incarnation);
  tx.emit('operation.attempt_started', { project: op.project, operation: op.id, run: op.payload.run ?? null }, { attempt: attempt.attempt_number });
  refreshStatus(tx, op.id);
  return { attempt: attempt.attempt_number };
}

// A precondition of the effect failed (the integration branch is checked
// out elsewhere, the path is occupied): refused before any effect.
export function refuseOperation(tx: Tx, args: { operation: string; detail: Record<string, unknown>; incarnation: string }): void {
  const op = opDetail(tx, args.operation);
  if (op.state === 'failed' || op.state === 'finalized') return;
  refuseInTx(tx, op, args.detail, args.incarnation);
}

// ---- the ordinary course -----------------------------------------------------------

// The effect's receipt: the journal is `applied`. The attempt is not yet
// succeeded: that is the probe's to say.
export function recordApplied(tx: Tx, args: { operation: string }): void {
  const op = opDetail(tx, args.operation);
  if (op.state === 'applied' || op.state === 'confirmed' || op.state === 'finalized') return;
  append(tx, op, 'applied');
  refreshStatus(tx, op.id);
}

// The probe found the effect: the journal is `confirmed` and the attempt in
// flight succeeded, or (an attempt of an incarnation that died) reconciled
// succeeded, with what the probe found on its record.
export function recordConfirmed(tx: Tx, args: { operation: string; incarnation: string; read?: string }): void {
  const op = opDetail(tx, args.operation);
  if (op.state === 'confirmed' || op.state === 'finalized') return;
  if (op.state !== 'applied') append(tx, op, 'applied');
  const latest = latestAttempt(op);
  if (latest && (latest.status === 'started' || latest.status === 'ambiguous' || latest.status === 'failed')) {
    if (latest.status === 'started' && latest.incarnation === args.incarnation && args.read === undefined) setAttempt(tx, latest, 'succeeded');
    else setAttempt(tx, latest, 'reconciled_succeeded', { outcome: 'applied', read: args.read ?? 'probe' });
  }
  append(tx, op, 'confirmed');
  tx.db.prepare('UPDATE "operations" SET "remaining_scope" = NULL WHERE "id" = ?').run(op.id);
  closeBlocker(tx, op, 'the effect was found applied');
  refreshStatus(tx, op.id);
}

// The effect was not made: the command failed and a probe found nothing of
// it. The attempt and the operation are failed.
export function recordFailed(tx: Tx, args: { operation: string; detail: Record<string, unknown>; incarnation: string }): void {
  refuseOperation(tx, args);
}

// A command that could have written was killed at its deadline (D1 §8.5),
// or what the probe found cannot be explained: the attempt in flight and the
// operation are ambiguous.
export function recordAmbiguous(tx: Tx, args: { operation: string; outcome?: ProbeOutcome }): void {
  const op = opDetail(tx, args.operation);
  if (op.state === 'failed' || op.state === 'finalized' || op.state === 'confirmed') return;
  if (op.state !== 'ambiguous') append(tx, op, 'ambiguous');
  const latest = latestAttempt(op);
  if (latest && latest.status === 'started') setAttempt(tx, latest, 'ambiguous', args.outcome ? { outcome: args.outcome, read: 'probe' } : undefined);
  refreshStatus(tx, op.id);
}

// The finalizer (D1 §7.10): the domain receipts the operation exists for, in
// one transaction with `finalized`. It runs once: a finalized operation is
// left as it is, and returns what its finalizer wrote.
export function finalizeOperation(tx: Tx, args: { operation: string }): Record<string, unknown> {
  const op = opDetail(tx, args.operation);
  if (op.state === 'finalized') return { finalized: false };
  if (op.state !== 'confirmed') throw illegal(`finalizing a ${op.state} operation`, { operation: op.id });
  const receipts = runFinalizer(tx, op);
  append(tx, op, 'finalized');
  tx.db.prepare('UPDATE "operations" SET "finalized_at" = ? WHERE "id" = ?').run(tx.at, op.id);
  closeBlocker(tx, op, 'the operation was finalized');
  refreshStatus(tx, op.id);
  tx.emit('operation.finalized', { project: op.project, operation: op.id, run: op.payload.run ?? null }, { journal_kind: op.kind });
  return { finalized: true, ...receipts };
}

// ---- reconciliation (corrections 14 and 16; SEAM.md §45) -------------------------------

// What the probe found, recorded on the attempt that was in flight before
// anything follows from it. `to` is the attempt's reconciled status;
// `remaining` the bounded remainder of a partial effect. Where the journal
// says `applied` and the effect is not all there, the receipt is contradicted
// and the journal goes to `ambiguous` before the retry.
export function reconcileOperation(
  tx: Tx,
  args: { operation: string; outcome: ProbeOutcome; to: 'reconciled_absent' | 'reconciled_partial'; remaining?: Record<string, unknown>; read: string },
): void {
  const op = opDetail(tx, args.operation);
  if (op.state === 'failed' || op.state === 'finalized' || op.state === 'confirmed') return;
  const latest = latestAttempt(op);
  if (latest && !ADMITS_NEXT.includes(latest.status) && latest.status !== 'succeeded' && latest.status !== 'reconciled_succeeded') {
    setAttempt(tx, latest, args.to, { outcome: args.outcome, read: args.read });
  }
  if (op.state === 'applied') append(tx, op, 'ambiguous');
  tx.db.prepare('UPDATE "operations" SET "remaining_scope" = ? WHERE "id" = ?').run(args.to === 'reconciled_partial' ? JSON.stringify(args.remaining ?? { remaining: 'declared' }) : null, op.id);
  closeBlocker(tx, op, `reconciled: ${args.outcome}`);
  refreshStatus(tx, op.id);
}

// Nothing is retried, completed or finalized: the journal, the attempt in
// flight and the operation are ambiguous, and one open blocker names the
// operation. Asked once: a blocker that is open stays the one.
export function blockOperation(tx: Tx, args: { operation: string; outcome: ProbeOutcome; read: string; question: string; workItems: string[] }): void {
  const op = opDetail(tx, args.operation);
  if (op.state === 'failed' || op.state === 'finalized' || op.state === 'confirmed') return;
  if (op.state !== 'ambiguous') append(tx, op, 'ambiguous');
  const latest = latestAttempt(op);
  if (latest && latest.status !== 'succeeded' && latest.status !== 'reconciled_succeeded' && !ADMITS_NEXT.includes(latest.status)) {
    const reads = JSON.parse(latest.reconciliation_reads) as { result: string }[];
    if (latest.status !== 'ambiguous' || reads.at(-1)?.result !== args.outcome) setAttempt(tx, latest, 'ambiguous', { outcome: args.outcome, read: args.read });
  }
  if (op.blocker === null) {
    raiseQuestion(tx, { project: op.project, kind: 'blocker', subjectType: 'operation', subjectId: op.id, question: args.question });
    if (args.workItems.length > 0) {
      const d = tx.db.prepare(`SELECT "id", "blocked_while_open" FROM "decisions" WHERE "kind" = 'blocker' AND "subject_type" = 'operation' AND "subject_id" = ? AND "status" = 'open'`).get(op.id) as
        | { id: string; blocked_while_open: string }
        | undefined;
      if (d) {
        const blocked = JSON.parse(d.blocked_while_open) as { work_items: string[] };
        blocked.work_items = [...new Set([...blocked.work_items, ...args.workItems])];
        tx.db.prepare('UPDATE "decisions" SET "blocked_while_open" = ? WHERE "id" = ?').run(JSON.stringify(blocked), d.id);
      }
    }
  }
  refreshStatus(tx, op.id);
}

// The operation is withdrawn: what it was for is over, and its effect is
// absent or only owned residue of it was there (now removed). Nothing is
// retried and no finalizer runs.
export function withdrawOperation(tx: Tx, args: { operation: string; outcome: ProbeOutcome; residueRemoved: boolean; read: string; incarnation: string }): void {
  const op = opDetail(tx, args.operation);
  if (op.state === 'failed' || op.state === 'finalized') return;
  const latest = latestAttempt(op);
  if (latest && !ADMITS_NEXT.includes(latest.status) && latest.status !== 'succeeded' && latest.status !== 'reconciled_succeeded') {
    setAttempt(tx, latest, args.residueRemoved ? 'reconciled_partial' : 'reconciled_absent', { outcome: args.outcome, read: args.read });
  }
  if (op.state === 'applied') append(tx, op, 'ambiguous');
  append(tx, op, 'failed');
  tx.db.prepare('UPDATE "operations" SET "outcome_detail" = ?, "remaining_scope" = NULL WHERE "id" = ?').run(JSON.stringify({ reason: 'withdrawn', outcome: args.outcome }), op.id);
  closeBlocker(tx, op, 'the operation was withdrawn');
  refreshStatus(tx, op.id);
}

// ---- reads ----------------------------------------------------------------------

// Operations not finalized and not failed, oldest first: what recovery and
// the journal step of a tick visit (correction 14).
export function unfinishedOperations(db: Tx['db'], project?: string): { id: string; project: string; kind: string }[] {
  return db
    .prepare(
      `SELECT o."id", o."project", s."journal_kind" AS "kind" FROM "operations" o JOIN "git_journal_state" s ON s."operation" = o."id"
       WHERE s."state" NOT IN ('finalized', 'failed') AND (? IS NULL OR o."project" = ?) ORDER BY o."created_at", o."seq"`,
    )
    .all(project ?? null, project ?? null) as { id: string; project: string; kind: string }[];
}

// Does the project's journal hold an operation that is ambiguous (blocked, or
// waiting to be reconciled)? Nothing of such a project is dispatched.
export function journalBlocks(db: Tx['db'], project: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM "git_journal_state" s JOIN "operations" o ON o."id" = s."operation" WHERE o."project" = ? AND s."state" = 'ambiguous' LIMIT 1`,
      )
      .get(project) !== undefined
  );
}

export function opsOfRun(db: Tx['db'], run: string, kind?: JournalKind): { id: string; kind: JournalKind; state: JournalState; status: string; inputs: string }[] {
  return db
    .prepare(
      `SELECT o."id", s."journal_kind" AS "kind", s."state", o."status", o."finalizer_inputs" AS "inputs" FROM "operations" o JOIN "git_journal_state" s ON s."operation" = o."id"
       WHERE json_extract(o."finalizer_inputs", '$.run') = ? AND (? IS NULL OR s."journal_kind" = ?) ORDER BY o."seq"`,
    )
    .all(run, kind ?? null, kind ?? null) as { id: string; kind: JournalKind; state: JournalState; status: string; inputs: string }[];
}
