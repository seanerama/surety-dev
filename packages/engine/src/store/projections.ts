// The read projections of the API (D1 §§11.3, 12.2 to 12.4, 13.1; SEAM.md
// §§91, 95). Each is computed from current rows in one synchronous read of
// the store worker's connection, so it is one snapshot: no write can commit
// in the middle of it. A projection writes nothing, appends no event and
// calls no adapter. Every answer carries `served_at` (the engine clock) and
// `snapshot_seq`, the highest event sequence of the snapshot it was read
// from.

import type { Database } from 'better-sqlite3';

import { nowIso, nowMs } from '../clock.js';
import { Refusal } from '../refusal.js';
import { notFound, parseJson } from './transitions/common.js';
import { exhaustedLimits, ledgerView } from './transitions/ledger.js';
import { seamStatusRead } from '../testing/seam.js';
import { projectNotFound } from './transitions/project.js';
import { effectiveVersion } from './transitions/protected.js';
import { dispatchBlocker } from './transitions/runs.js';
import { envelopeHold } from './transitions/envelope.js';
import { projectPolicy } from './transitions/settings.js';
import type { WorkRow } from './transitions/work.js';

type Db = Database;

const envelope = (db: Db) => ({
  served_at: nowIso(),
  snapshot_seq: (db.prepare('SELECT COALESCE(MAX("seq"), 0) AS n FROM "events"').get() as { n: number }).n,
});

const mustProject = (db: Db, project: string): void => {
  if (!db.prepare('SELECT 1 FROM "projects" WHERE "id" = ?').get(project)) throw projectNotFound(project);
};

// ---- NOW (D1 §12.3) -----------------------------------------------------------------

// What a projection can say (D1 A.2). `unknown` is NOW whose inputs could
// not be read; a store snapshot that fails as a whole fails the read.
export const NOW_STATES = ['refused', 'waiting_on_you', 'running', 'ready', 'idle', 'unknown'] as const;
type NowState = (typeof NOW_STATES)[number];
export const FRESHNESS = ['fresh', 'stale', 'expired'] as const;
export const PROVENANCE = ['observed', 'claimed', 'configured'] as const;

interface ExecutionRun {
  id: string;
  state: string;
  quarantined: boolean;
}

function executionRuns(db: Db, project: string): ExecutionRun[] {
  return (
    db.prepare(`SELECT "id", "state", "quarantined" FROM "runs" WHERE "project" = ? AND "state" <> 'ended' ORDER BY "seq"`).all(project) as {
      id: string;
      state: string;
      quarantined: number;
    }[]
  ).map((r) => ({ id: r.id, state: r.state, quarantined: r.quarantined === 1 }));
}

const openDecisionCount = (db: Db, project: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM "decisions" WHERE "project" = ? AND "status" = 'open'`).get(project) as { n: number }).n;

// Eligible work the next tick could dispatch, as far as the store can tell.
// A blocker that cannot be read (a budget read that fails) dispatches
// nothing, so it is not ready.
function dispatchable(db: Db, project: string, maxConcurrentRuns: number): number {
  const items = db.prepare(`SELECT * FROM "work_items" WHERE "project" = ? AND "status" = 'eligible'`).all(project) as WorkRow[];
  let n = 0;
  for (const item of items) {
    try {
      if (dispatchBlocker(db, item, maxConcurrentRuns, { check: false }) === null) n++;
    } catch {
      // not dispatchable on what can be read
    }
  }
  return n;
}

// Why the engine cannot act on the project, if it cannot (D1 §12.3): a
// quarantined run; a repository it cannot read; an out-of-band change nobody
// has settled; a journal operation whose effect git could not be made to tell.
// Each names its cause. null: none of these holds.
function refusalOf(db: Db, project: string, runs: ExecutionRun[]): { cause: string; reason: string; primary: string } | null {
  const quarantined = runs.find((r) => r.quarantined);
  if (quarantined) {
    return { cause: 'quarantine', reason: `The engine cannot act on this project: run ${quarantined.id} is quarantined until its termination is observed.`, primary: 'inspect_quarantine' };
  }
  const observations = db
    .prepare(
      `SELECT o."id", o."subject_kind", o."decision", r."ref", r."kind", c."path" FROM "out_of_band_changes" o
       LEFT JOIN "ref_registry" r ON r."id" = o."ref" LEFT JOIN "managed_checkouts" c ON c."id" = o."checkout"
       WHERE o."project" = ? AND o."disposition" IS NULL AND o."closed_at" IS NULL ORDER BY o."detected_at", o."id"`,
    )
    .all(project) as { id: string; subject_kind: string; decision: string; ref: string | null; kind: string | null; path: string | null }[];
  const unreadable = observations.find((o) => o.subject_kind === 'repository');
  if (unreadable) {
    return {
      cause: 'repository_unreadable',
      reason: "The engine cannot act on this project: its repository cannot be read, and nothing about it is known until it can.",
      primary: 'restore_repository_access',
    };
  }
  // An observation that holds the project (SEAM.md §§32, 107): the
  // integration branch changed outside the engine. One of another subject
  // (a checkout, another ref) leaves the engine able to act; its decision is
  // waiting on a person.
  const change = observations.find((o) => o.subject_kind === 'ref' && o.kind === 'integration');
  if (change) {
    return {
      cause: 'out_of_band_change',
      reason: `The engine cannot act on this project: its integration branch ${change.ref} was changed outside the engine (out-of-band change ${change.id}), and the change is not settled.`,
      primary: 'answer_decision',
    };
  }
  const blocked = db
    .prepare(
      `SELECT o."id" FROM "operations" o JOIN "git_journal_state" s ON s."operation" = o."id" WHERE o."project" = ? AND s."state" = 'ambiguous' ORDER BY o."seq" LIMIT 1`,
    )
    .get(project) as { id: string } | undefined;
  if (blocked) {
    return {
      cause: 'journal_blocked',
      reason: `The engine cannot act on this project: what git did for operation ${blocked.id} is not established, and nothing is dispatched until it is.`,
      primary: 'inspect_operation',
    };
  }
  // The store fails for the project (D1 §§6.6, 12.3; SEAM.md §107): the read
  // of its spend a budget check makes, made here with the check's own fault
  // point. What would refuse a dispatch refuses the status.
  try {
    exhaustedLimits(db, project, { check: true });
  } catch (err) {
    return {
      cause: 'store_error',
      reason: `The engine cannot act on this project: the store could not read its budget (${err instanceof Error ? err.message : String(err)}), and nothing is dispatched until it can.`,
      primary: 'inspect_store',
    };
  }
  return null;
}

function nowOf(db: Db, project: string, runs: ExecutionRun[], decisions: number, maxConcurrentRuns: number) {
  const refusal = refusalOf(db, project, runs);
  let state: NowState;
  let reason: string;
  let primary: string | null;
  let cause: string | null = null;
  if (refusal) {
    state = 'refused';
    reason = refusal.reason;
    primary = refusal.primary;
    cause = refusal.cause;
  } else if (decisions > 0) {
    state = 'waiting_on_you';
    reason = decisions === 1 ? 'One decision is waiting for your answer.' : `${decisions} decisions are waiting for your answer.`;
    primary = 'answer_decision';
  } else if (runs.length > 0) {
    state = 'running';
    reason = runs.length === 1 ? `Run ${runs[0]!.id} is under way.` : `${runs.length} runs are under way.`;
    primary = null;
  } else {
    const ready = dispatchable(db, project, maxConcurrentRuns);
    if (ready > 0) {
      state = 'ready';
      reason = ready === 1 ? 'One work item is eligible and can be dispatched at the next tick.' : `${ready} work items are eligible and can be dispatched at the next tick.`;
      primary = 'tick';
    } else {
      state = 'idle';
      reason = 'Nothing is under way, nothing waits for you, and no work can be dispatched.';
      primary = null;
    }
  }
  return { state, primary_action: primary, reason, cause };
}

// NOW when it cannot be computed (D1 §12.3): `unknown`, naming why, never a
// state the engine did not establish.
function unknownNow(err: unknown) {
  const what = err instanceof Error ? err.message : String(err);
  return { state: 'unknown' as const, primary_action: null, reason: `The project's state cannot be computed: the store could not be read (${what}).`, cause: 'store_error' };
}

// ---- spend today (D1 §13.1; SEAM.md §§54, 91) ----------------------------------------

function spendToday(db: Db, project: string) {
  const day = nowIso().slice(0, 10);
  const { totals } = ledgerView(db, { project, day });
  // "No dispatch" is a fact of its own with no row (D1 §13.1): none of the
  // day's invocations of the project was launched.
  const launched = db
    .prepare(`SELECT 1 FROM "invocation_status_observations" WHERE "project" = ? AND "status" = 'launched' AND substr("at", 1, 10) = ? LIMIT 1`)
    .get(project, day);
  return { no_dispatch: !launched && (totals.invocations ?? 0) === 0, ...totals };
}

// ---- environments and their current observation (D1 §3.5, D1-28) --------------------

function environmentsOf(db: Db, project: string) {
  const bound = projectPolicy(db, project).observation_freshness_bound! * 1000;
  const now = nowMs();
  const rows = db
    .prepare(
      `SELECT e."id", e."name", r."observed" FROM "environments" e LEFT JOIN "environment_records" r ON r."environment" = e."id"
       WHERE e."project" = ? ORDER BY e."created_at", e."id"`,
    )
    .all(project) as { id: string; name: string; observed: string | null }[];
  return rows.map((row) => {
    const stored = parseJson<{ condition: string; observed_at: string | null; source: string | null }>(row.observed);
    if (stored === null || stored.observed_at === null) {
      // Never observed: the condition is unknown, and nothing says when.
      return { id: row.id, name: row.name, observed: { condition: 'unknown', observed_at: null, source: null, provenance: null, freshness: null, expires_at: null } };
    }
    const at = Date.parse(stored.observed_at);
    const age = now - at;
    const freshness = !Number.isFinite(age) || age > bound ? 'expired' : age > bound / 2 ? 'stale' : 'fresh';
    return {
      id: row.id,
      name: row.name,
      observed: {
        // An expired observation says nothing about now (D1 §3.5).
        condition: freshness === 'expired' ? 'unknown' : stored.condition,
        observed_at: stored.observed_at,
        source: stored.source,
        provenance: 'observed',
        freshness,
        expires_at: Number.isFinite(at) ? new Date(at + bound).toISOString() : null,
      },
    };
  });
}

// ---- the projections ----------------------------------------------------------------------

function projectSummary(db: Db, project: string, maxConcurrentRuns: number) {
  const runs = executionRuns(db, project);
  const decisions = openDecisionCount(db, project);
  let now;
  try {
    seamStatusRead(project);
    now = nowOf(db, project, runs, decisions, maxConcurrentRuns);
  } catch (err) {
    now = unknownNow(err);
  }
  return {
    id: project,
    now,
    execution: { runs },
    open_decisions: { count: decisions },
    spend_today: spendToday(db, project),
  };
}

// GET /v1/projects
export function listProjects(db: Db, args: { maxConcurrentRuns: number }) {
  const head = envelope(db);
  const ids = (db.prepare('SELECT "id" FROM "projects" ORDER BY "created_at", "id"').all() as { id: string }[]).map((r) => r.id);
  return { ...head, projects: ids.map((id) => projectSummary(db, id, args.maxConcurrentRuns)) };
}

// GET /v1/projects/:p
export function readProject(db: Db, args: { project: string; maxConcurrentRuns: number }) {
  mustProject(db, args.project);
  const head = envelope(db);
  const row = db.prepare('SELECT "id", "name", "tier", "paused", "registration_state" FROM "projects" WHERE "id" = ?').get(args.project) as Record<string, unknown>;
  return {
    ...head,
    project: {
      ...projectSummary(db, args.project, args.maxConcurrentRuns),
      name: row.name,
      tier: row.tier,
      paused: row.paused === 1,
      registration_state: row.registration_state,
      environments: environmentsOf(db, args.project),
    },
  };
}

// GET /v1/projects/:p/decisions: the project's open decisions, each with what
// a person needs to answer it (D1 §11.3; E39).
export function openDecisions(db: Db, args: { project: string }) {
  mustProject(db, args.project);
  const head = envelope(db);
  const rows = db
    .prepare(
      `SELECT "id", "kind", "subject_type", "subject_id", "question", "options", "preview_hash", "raised_at", "target_seconds", "escalated_at"
       FROM "decisions" WHERE "project" = ? AND "status" = 'open' ORDER BY "seq"`,
    )
    .all(args.project) as Record<string, unknown>[];
  return {
    ...head,
    decisions: rows.map((d) => ({
      id: d.id,
      kind: d.kind,
      subject_type: d.subject_type,
      subject_id: d.subject_id,
      question: d.question,
      options: JSON.parse(d.options as string) as unknown[],
      preview_hash: d.preview_hash,
      raised_at: d.raised_at,
      target_seconds: d.target_seconds,
      escalated_at: d.escalated_at,
    })),
  };
}

// GET /v1/decisions (SEAM.md §117): the open engine-scoped decisions, in the
// list's form.
export function engineDecisions(db: Db) {
  const head = envelope(db);
  const rows = db
    .prepare(
      `SELECT "id", "kind", "subject_type", "subject_id", "question", "options", "preview_hash", "raised_at", "target_seconds", "escalated_at"
       FROM "decisions" WHERE "project" IS NULL AND "status" = 'open' ORDER BY "seq"`,
    )
    .all() as Record<string, unknown>[];
  return { ...head, decisions: rows.map((d) => ({ ...d, options: JSON.parse(d.options as string) as unknown[] })) };
}

// GET /v1/projects/:p/decisions/:d (D1 §11.3; brief B4): one decision of the
// project by its identifier, whatever its status, in the list's form, with
// its status, its generation, what its preview is bound to (the dependency
// manifest) and its answer once given. A decision of another project is not
// found here.
export function readDecision(db: Db, args: { project: string; decision: string }) {
  mustProject(db, args.project);
  const head = envelope(db);
  const d = db
    .prepare(
      `SELECT "id", "project", "kind", "subject_type", "subject_id", "semantic_generation", "status", "question", "options", "dependency_manifest", "preview_hash",
         "raised_at", "target_seconds", "escalated_at", "answer", "consumed_at", "invalidated_reason"
       FROM "decisions" WHERE "id" = ?`,
    )
    .get(args.decision) as Record<string, unknown> | undefined;
  if (!d || d.project !== args.project) throw notFound('decision', args.decision);
  return {
    ...head,
    decision: {
      id: d.id,
      kind: d.kind,
      subject_type: d.subject_type,
      subject_id: d.subject_id,
      semantic_generation: d.semantic_generation,
      status: d.status,
      question: d.question,
      options: JSON.parse(d.options as string) as unknown[],
      dependency_manifest: JSON.parse(d.dependency_manifest as string) as Record<string, unknown>,
      preview_hash: d.preview_hash,
      raised_at: d.raised_at,
      target_seconds: d.target_seconds,
      escalated_at: d.escalated_at,
      answer: parseJson<Record<string, unknown>>((d.answer as string | null) ?? null),
      consumed_at: d.consumed_at,
      invalidated_reason: d.invalidated_reason,
    },
  };
}

// ---- operations (D1 §§3.5, 11.3; brief B4) -----------------------------------------------

interface OperationRow {
  id: string;
  seq: number;
  kind: string;
  status: string;
  subject: string;
  target: string;
  finalizer_inputs: string;
  outcome_detail: string | null;
  remaining_scope: string | null;
  linked_prior: string | null;
  created_at: string;
  finalized_at: string | null;
  journal_kind: string | null;
  state: string | null;
}

// GET /v1/projects/:p/operations: every operation of the project, in `seq`
// order, whatever its state: pending and blocked ones included. Each with its
// kind, the journal's state and the operation's status, its intent as the
// journal's `intended` event froze it (what it was to do), its purpose, its
// attempts with their reconciliation reads, and the id of the open blocker
// decision that holds it, or null (SEAM.md §108). Nothing is probed: a state is as stored.
export function readOperations(db: Db, args: { project: string }) {
  mustProject(db, args.project);
  const head = envelope(db);
  const rows = db
    .prepare(
      `SELECT o."id", o."seq", o."kind", o."status", o."subject", o."target", o."finalizer_inputs", o."outcome_detail", o."remaining_scope", o."linked_prior",
         o."created_at", o."finalized_at", s."journal_kind", s."state"
       FROM "operations" o LEFT JOIN "git_journal_state" s ON s."operation" = o."id" WHERE o."project" = ? ORDER BY o."seq"`,
    )
    .all(args.project) as OperationRow[];
  const intended = db.prepare(`SELECT "payload" FROM "git_journal_events" WHERE "operation" = ? AND "event_kind" = 'intended' ORDER BY "seq" LIMIT 1`);
  const attempts = db.prepare(
    'SELECT "attempt_number", "status", "started_at", "finished_at", "reconciliation_reads" FROM "operation_attempts" WHERE "operation" = ? ORDER BY "attempt_number"',
  );
  const blocker = db.prepare(`SELECT "id" FROM "decisions" WHERE "kind" = 'blocker' AND "subject_type" = 'operation' AND "subject_id" = ? AND "status" = 'open' ORDER BY "seq" LIMIT 1`);
  return {
    ...head,
    operations: rows.map((o) => {
      const intent = intended.get(o.id) as { payload: string } | undefined;
      const held = blocker.get(o.id) as { id: string } | undefined;
      const inputs = parseJson<{ purpose?: string }>(o.finalizer_inputs);
      return {
        id: o.id,
        seq: o.seq,
        kind: o.kind,
        journal_kind: o.journal_kind,
        state: o.state,
        status: o.status,
        purpose: inputs?.purpose ?? null,
        intent: intent ? (JSON.parse(intent.payload) as Record<string, unknown>) : null,
        subject: parseJson<Record<string, unknown>>(o.subject),
        attempts: (attempts.all(o.id) as { attempt_number: number; status: string; started_at: string; finished_at: string | null; reconciliation_reads: string }[]).map((a) => ({
          attempt_number: a.attempt_number,
          status: a.status,
          started_at: a.started_at,
          finished_at: a.finished_at,
          reconciliation_reads: JSON.parse(a.reconciliation_reads) as unknown[],
        })),
        outcome_detail: parseJson<Record<string, unknown>>(o.outcome_detail),
        remaining_scope: parseJson<Record<string, unknown>>(o.remaining_scope),
        linked_prior: o.linked_prior,
        created_at: o.created_at,
        finalized_at: o.finalized_at,
        blocker: held?.id ?? null,
      };
    }),
  };
}

// GET /v1/projects/:p/environments (D1 §11.3; brief B4): the project's
// environments with their current observation, as the project read shows
// them. M1 keeps no observation history and runs no observation job, so
// there is none to show.
export function readEnvironments(db: Db, args: { project: string }) {
  mustProject(db, args.project);
  const head = envelope(db);
  return { ...head, environments: environmentsOf(db, args.project) };
}

// GET /v1/projects/:p/candidates/:c (D1 §11.3; SEAM.md §95): the candidate,
// the protected version it was nominated under beside the effective one, the
// candidate whose lineage started from it, and the latest stored evaluation
// of each gate kind evaluated for it.
export function readCandidate(db: Db, args: { project: string; candidate: string }) {
  mustProject(db, args.project);
  const head = envelope(db);
  const c = db.prepare('SELECT * FROM "candidates" WHERE "id" = ?').get(args.candidate) as Record<string, unknown> | undefined;
  if (!c || c.project !== args.project) throw notFound('candidate', args.candidate);
  const successor = db
    .prepare('SELECT c."id" FROM "candidates" c JOIN "lineages" l ON l."id" = c."lineage" WHERE l."started_from_candidate" = ? ORDER BY c."seq" LIMIT 1')
    .get(args.candidate) as { id: string } | undefined;
  const gates: Record<string, { id: string; outcome: string; stale: boolean; computed_at: string }> = {};
  const evaluations = db
    .prepare('SELECT "id", "gate_kind", "outcome", "stale", "computed_at" FROM "gate_evaluations" WHERE "candidate" = ? ORDER BY rowid')
    .all(args.candidate) as { id: string; gate_kind: string; outcome: string; stale: number; computed_at: string }[];
  for (const e of evaluations) gates[e.gate_kind] = { id: e.id, outcome: e.outcome, stale: e.stale === 1, computed_at: e.computed_at };
  return {
    ...head,
    candidate: {
      id: c.id,
      seq: c.seq,
      revision: c.revision,
      lineage: c.lineage,
      nominated_at: c.nominated_at,
      nominated_by: c.nominated_by,
      progress: c.progress,
      protected_version: { nominated: c.nominated_protected_version ?? null, effective: effectiveVersion(db, args.project)?.id ?? null },
      successor: successor?.id ?? null,
      gates,
    },
  };
}

// ---- work items (D1 §11.3; E47) -------------------------------------------------------

interface DecisionRef {
  id: string;
  kind: string;
  status: string;
  options: string;
  dependency_manifest: string;
  raised_at: string;
}

// What holds a work item, if anything (SEAM.md §98): the blocker stored on
// the item (a park, a chaining boundary), as stored, or else an open decision
// of the project whose `blocked_while_open` names the item. `options` are the
// options the holding decision offers, in its stored order and in the
// decisions read's form; a decision that cannot be found has none to show,
// which is null, not [].
function blockerOf(db: Db, item: WorkRow) {
  const stored = parseJson<{ reason?: string; raised_at?: string; decision?: string | null }>(item.blocker);
  const holding = db
    .prepare(
      `SELECT d."id" FROM "decisions" d, json_each(json_extract(d."blocked_while_open", '$.work_items')) w
       WHERE d."project" = ? AND d."status" = 'open' AND w."value" = ? ORDER BY d."seq" LIMIT 1`,
    )
    .get(item.project, item.id) as { id: string } | undefined;
  if (stored === null && holding === undefined) return null;
  const decisionId = stored?.decision ?? holding?.id ?? null;
  const decision =
    decisionId === null
      ? undefined
      : (db.prepare('SELECT "kind", "options", "dependency_manifest", "raised_at" FROM "decisions" WHERE "id" = ? AND "project" = ?').get(decisionId, item.project) as
          | DecisionRef
          | undefined);
  const options = decision ? (JSON.parse(decision.options) as unknown[]) : null;
  if (stored !== null) return { ...stored, decision: decisionId, options };
  // Held by a decision with no blocker stored on the item: its cause.
  const cause = decision ? parseJson<{ cause?: unknown }>(decision.dependency_manifest)?.cause : undefined;
  return { reason: typeof cause === 'string' ? cause : (decision?.kind ?? null), raised_at: decision?.raised_at ?? null, decision: decisionId, options };
}

// GET /v1/projects/:p/work (SEAM.md §98): every work item of the project,
// whatever its status, in `seq` order, with the stored columns and what
// holds it when something does.
export function readWork(db: Db, args: { project: string }) {
  mustProject(db, args.project);
  const head = envelope(db);
  const items = db.prepare('SELECT * FROM "work_items" WHERE "project" = ? ORDER BY "seq"').all(args.project) as WorkRow[];
  return {
    ...head,
    work_items: items.map((w) => ({
      id: w.id,
      seq: w.seq,
      kind: w.kind,
      status: w.status,
      subject: parseJson<Record<string, unknown>>(w.subject),
      trigger_source: w.trigger_source,
      trigger_id: w.trigger_id,
      trigger_generation: w.trigger_generation,
      chain: w.chain,
      blocker: blockerOf(db, w),
      // An eligible item held by the resource envelope (D2 §3.7, A.7): it
      // stays eligible, and this says why it is not dispatched now.
      dispatch_hold: w.status === 'eligible' ? envelopeHold(db) : null,
    })),
  };
}

// ---- a gate evaluation (D1 §11.3; E47) -------------------------------------------------

// GET /v1/projects/:p/candidates/:c/gates/:kind (SEAM.md §98): the latest
// recorded evaluation of that gate kind for the candidate, the one the
// candidate read names, in the evaluation route's form and with the stored
// values. It evaluates nothing: the check states are the stored ones and
// `stale` is the stored flag. Before any evaluation of the kind there is
// nothing to read: 404 naming the candidate and the gate kind.
export function readGate(db: Db, args: { project: string; candidate: string; kind: string }) {
  mustProject(db, args.project);
  const head = envelope(db);
  const c = db.prepare('SELECT "project" FROM "candidates" WHERE "id" = ?').get(args.candidate) as { project: string } | undefined;
  if (!c || c.project !== args.project) throw notFound('candidate', args.candidate);
  const e = db.prepare('SELECT * FROM "gate_evaluations" WHERE "candidate" = ? AND "gate_kind" = ? ORDER BY rowid DESC LIMIT 1').get(args.candidate, args.kind) as
    | Record<string, unknown>
    | undefined;
  if (!e) {
    throw new Refusal(404, 'not_found', `Candidate ${args.candidate} has no recorded evaluation of the ${args.kind} gate.`, 'Evaluate the gate first; this read evaluates nothing.', {
      candidate: args.candidate,
      gate_kind: args.kind,
    });
  }
  return {
    ...head,
    evaluation: {
      id: e.id,
      gate_kind: e.gate_kind,
      outcome: e.outcome,
      reasons: JSON.parse(e.reasons as string) as { code: string; subjects: string[] }[],
      check_states: JSON.parse(e.check_states as string) as Record<string, string>,
      scope: e.scope,
      stale: e.stale === 1,
    },
  };
}

// What a run's output tail reads once no live transcript is there: whether
// the run has ended, and its published transcript, if any (SEAM.md §92).
export function runTail(db: Db, args: { project: string; run: string }) {
  const run = db.prepare('SELECT "project", "state" FROM "runs" WHERE "id" = ?').get(args.run) as { project: string; state: string } | undefined;
  if (!run || run.project !== args.project) throw notFound('run', args.run);
  const record = db
    .prepare(`SELECT "id", "path", "sha256", "bytes", "post_scan" FROM "records" WHERE "run" = ? AND "kind" = 'transcript' AND "published" = 1 AND "path" IS NOT NULL ORDER BY "created_at" DESC, "id" DESC LIMIT 1`)
    .get(args.run) as { id: string; path: string; sha256: string | null; bytes: number | null; post_scan: string } | undefined;
  return { ended: run.state === 'ended', record: record ? { id: record.id, path: record.path, sha256: record.sha256, bytes: record.bytes, quarantined: record.post_scan === 'hit' } : null };
}
