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
import { ledgerView } from './transitions/ledger.js';
import { projectNotFound } from './transitions/project.js';
import { effectiveVersion } from './transitions/protected.js';
import { dispatchBlocker } from './transitions/runs.js';
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

// What a projection can say (D1 A.2). M1 computes no `unknown` NOW: a store
// snapshot that fails fails the read.
export const NOW_STATES = ['refused', 'waiting_on_you', 'running', 'ready', 'idle'] as const;
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

function nowOf(db: Db, project: string, runs: ExecutionRun[], decisions: number, maxConcurrentRuns: number) {
  const quarantined = runs.filter((r) => r.quarantined);
  let state: NowState;
  let reason: string;
  let primary: string | null;
  if (quarantined.length > 0) {
    state = 'refused';
    reason = `The engine cannot act on this project: run ${quarantined[0]!.id} is quarantined until its termination is observed.`;
    primary = 'inspect_quarantine';
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
  return { state, primary_action: primary, reason };
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
  return {
    id: project,
    now: nowOf(db, project, runs, decisions, maxConcurrentRuns),
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

// What holds a work item, if anything: the blocker stored on the item (a
// park, a chaining boundary), or else an open decision of the project whose
// `blocked_while_open` names the item (a quarantined run's blocker). The
// options are the keys the decision offers, in its stored order; a decision
// that cannot be found has none to show, which is null, not [].
function blockerOf(db: Db, item: WorkRow) {
  const stored = parseJson<{ reason?: string; raised_at?: string; decision?: string | null }>(item.blocker);
  const holding = db
    .prepare(
      `SELECT d."id", d."kind", d."status", d."options", d."dependency_manifest", d."raised_at" FROM "decisions" d, json_each(json_extract(d."blocked_while_open", '$.work_items')) w
       WHERE d."project" = ? AND d."status" = 'open' AND w."value" = ? ORDER BY d."seq" LIMIT 1`,
    )
    .get(item.project, item.id) as DecisionRef | undefined;
  if (stored === null && holding === undefined) return null;
  const decisionId = stored?.decision ?? holding?.id ?? null;
  const decision =
    decisionId === null
      ? undefined
      : (db.prepare('SELECT "id", "kind", "status", "options", "dependency_manifest", "raised_at" FROM "decisions" WHERE "id" = ? AND "project" = ?').get(decisionId, item.project) as
          | DecisionRef
          | undefined);
  const cause = decision ? parseJson<{ cause?: unknown }>(decision.dependency_manifest)?.cause : undefined;
  return {
    reason: stored?.reason ?? (typeof cause === 'string' ? cause : (decision?.kind ?? null)),
    raised_at: stored?.raised_at ?? decision?.raised_at ?? null,
    decision: decisionId,
    options: decision ? (JSON.parse(decision.options) as { key: string }[]).map((o) => o.key) : null,
  };
}

// GET /v1/projects/:p/work: every work item of the project, oldest first,
// with what holds it when something does.
export function readWork(db: Db, args: { project: string }) {
  mustProject(db, args.project);
  const head = envelope(db);
  const items = db.prepare('SELECT * FROM "work_items" WHERE "project" = ? ORDER BY "seq"').all(args.project) as (WorkRow & {
    created_at: string;
    trigger_consumed_at: string | null;
  })[];
  return {
    ...head,
    work: items.map((w) => ({
      id: w.id,
      seq: w.seq,
      kind: w.kind,
      status: w.status,
      subject: parseJson<Record<string, unknown>>(w.subject),
      trigger: { source: w.trigger_source, id: w.trigger_id, generation: w.trigger_generation },
      chain: w.chain,
      depends_on: parseJson<string[]>(w.depends_on) ?? [],
      dispatch_hold: w.dispatch_hold === 1,
      created_at: w.created_at,
      blocker: blockerOf(db, w),
    })),
  };
}

// ---- a gate evaluation (D1 §11.3; E47) -------------------------------------------------

// GET /v1/projects/:p/candidates/:c/gates/:kind: the latest recorded
// evaluation of that gate kind for the candidate (the one the candidate read
// names), as it was recorded. It evaluates nothing: every check state is the
// stored one, and `stale` is the stored flag. Before any evaluation of the
// kind there is nothing to read: 404.
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
  const scope = db.prepare('SELECT * FROM "acceptance_scopes" WHERE "id" = ?').get(e.scope) as Record<string, unknown>;
  const states = JSON.parse(e.check_states as string) as Record<string, string>;
  const results = (parseJson<{ results?: Record<string, string | null> }>(e.inputs_snapshot as string)?.results ?? {}) as Record<string, string | null>;
  const checks = (JSON.parse(scope.required_check_ids as string) as string[]).map((id) => {
    const check = db.prepare('SELECT "key", "kind" FROM "checks" WHERE "id" = ?').get(id) as { key: string; kind: string } | undefined;
    const result = results[id] ?? null;
    const output = result === null ? null : ((db.prepare('SELECT "output" FROM "check_results" WHERE "id" = ?').get(result) as { output: string | null } | undefined)?.output ?? null);
    return { id, key: check?.key ?? null, kind: check?.kind ?? null, state: states[id] ?? null, check_result: result, output };
  });
  return {
    ...head,
    evaluation: {
      id: e.id,
      gate_kind: e.gate_kind,
      candidate: e.candidate,
      stage: e.stage ?? null,
      authorization: e.authorization ?? null,
      computed_at: e.computed_at,
      outcome: e.outcome,
      stale: e.stale === 1,
      reasons: JSON.parse(e.reasons as string) as { code: string; subjects: string[] }[],
      satisfiers: JSON.parse(e.satisfiers as string) as unknown[],
      checks,
      scope: {
        id: scope.id,
        source_revision: scope.source_revision,
        delivered_requirements: JSON.parse(scope.delivered_requirement_ids as string) as string[],
        partial_requirements: JSON.parse(scope.partial_requirement_ids as string) as string[],
        required_checks: checks.map((k) => k.id),
        required_signoffs: JSON.parse(scope.required_signoffs as string) as unknown[],
        environment: scope.environment ?? null,
        artifact_digest: scope.artifact_digest ?? null,
        validated: scope.validated === 1,
      },
      // The version the evaluation was made under beside the one in force now.
      protected_version: { evaluated: scope.effective_protected_version, effective: effectiveVersion(db, args.project)?.id ?? null },
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
