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
import { dispatchBlocker, requalificationHold } from './transitions/runs.js';
import { type EnvelopeHold, envelopeHold } from './transitions/envelope.js';
import { DESIGN_PREVIEW_ENV, deployParts, journalEvents, readEnvironment } from './transitions/deploy.js';
import { readLogs } from './transitions/observe.js';
import { projectOptions, projectPolicy } from './transitions/settings.js';
import { resultState } from './transitions/gates.js';
import { runnerProfileHold } from './transitions/checks.js';
import { buildComplete } from '../plan/phase.js';
import { type Compatibility, readinessOf, servedCompatibility, unreadCompatibility } from '../deploy/compatibility.js';
import type { TreeAnswer } from '../deploy/output-kind.js';
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
// `checking`, `deploying` and `build_complete` (the owner's finding of
// 2026-10-28, Lap-Lab): automated checks of the current candidate in flight
// with no run under way; a deployment under way; the planned build complete
// under `alpha_deploy: manual` with no deployment of the candidate. None of
// them says anything of visual acceptance, human testing or production.
export const NOW_STATES = ['refused', 'waiting_on_you', 'running', 'checking', 'ready', 'deploying', 'build_complete', 'idle', 'unknown'] as const;
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
function dispatchable(db: Db, project: string): number {
  const items = db.prepare(`SELECT * FROM "work_items" WHERE "project" = ? AND "status" = 'eligible'`).all(project) as WorkRow[];
  let n = 0;
  for (const item of items) {
    try {
      if (dispatchBlocker(db, item, { check: false }) === null) n++;
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
       WHERE o."project" = ? AND o."disposition" IS NULL AND o."closed_at" IS NULL ORDER BY o.rowid, o."id"`,
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
  // A check of the project the runner cannot run on this host (D3 §2.7;
  // SEAM.md §209): the latest registration of some check of a current
  // candidate was recorded with a host-level reason.
  const unrunnable = db
    .prepare(
      `SELECT x."id", x."key", x."not_run_reason" FROM "check_executions" x JOIN "candidates" c ON c."id" = x."candidate"
       WHERE x."project" = ? AND c."superseded_by" IS NULL AND x."status" = 'recorded'
         AND x."not_run_reason" IN ('toolchain_missing', 'mount_plan_refused', 'isolation_unqualified', 'runner_unqualified')
         AND NOT EXISTS (SELECT 1 FROM "check_executions" y WHERE y."candidate" = x."candidate" AND y."key" = x."key" AND y."execution_seq" > x."execution_seq")
       ORDER BY x."execution_seq" LIMIT 1`,
    )
    .get(project) as { id: string; key: string; not_run_reason: string } | undefined;
  if (unrunnable) {
    return {
      cause: 'check_unrunnable',
      reason: `The engine cannot run the check ${unrunnable.key} on this host: its execution ${unrunnable.id} was not run (${unrunnable.not_run_reason}).`,
      primary: 'inspect_checks',
    };
  }
  return null;
}

// ---- the automated checks of the current candidate (the owner's finding of 2026-10-28) ----

// A check execution's status as progress (D3 A.5): waiting for admission or
// past it and not yet running; running, being collected, or quarantined
// (its domain's termination not yet observed: not settled, so still under
// way, never completed).
const CHECK_QUEUED = ['queued', 'materializing'];
const CHECK_RUNNING = ['running', 'collecting', 'quarantined'];

export interface CheckHeld {
  count: number;
  code: string;
  reason: string;
  decision: string | null;
}

export interface CheckProgress {
  candidate: string;
  phase: number | null;
  planned: number;
  completed: number;
  passed: number;
  failed: number;
  skipped: number;
  interrupted: number;
  queued: number;
  running: number;
  held: CheckHeld | null;
}

// The progress of the automated checks of the project's current candidate,
// read from the stored executions, or null when no candidate that is not
// superseded has one. The candidate: the newest not superseded with an
// execution. Its registrations: those under the protected version of its
// latest registration (a version superseded under it has its own, newer
// ones). A check is counted once, by its key, at its latest execution there
// that was not cancelled: a retry, a recovery registration or a later
// trigger replaces the earlier execution and never adds a check; a key with
// only cancelled executions is not planned. A result of the candidate with
// no execution of its own is taken by its number too, as the gate takes it.
// Of those latest executions:
// `completed` the recorded ones, each `passed`, `failed` or `skipped` by the
// gate's own reading of its result (gates.ts resultState; `skipped`: not
// established, which a recorded not-run reason is); `queued` and `running`
// by status; `interrupted`: ended with no result and no retry registered.
// `planned` is completed + queued + running + interrupted. `held`: the hold
// the engine's admission applies now to its queued `direct` executions,
// the one the candidate's checks read shows on each (runner_unqualified
// first, else resource_envelope), with how many it holds; null when none.
// No decision of the store holds a queued execution, so `decision` is null
// unless one ever does.
function checksOf(db: Db, project: string): CheckProgress | null {
  const candidate = db
    .prepare(
      `SELECT c."id", c."held_work" FROM "candidates" c WHERE c."project" = ? AND c."superseded_by" IS NULL
         AND EXISTS (SELECT 1 FROM "check_executions" x WHERE x."candidate" = c."id") ORDER BY c."seq" DESC LIMIT 1`,
    )
    .get(project) as { id: string; held_work: string } | undefined;
  if (!candidate) return null;
  const { protected_version: version } = db
    .prepare('SELECT "protected_version" FROM "check_executions" WHERE "candidate" = ? ORDER BY "execution_seq" DESC LIMIT 1')
    .get(candidate.id) as { protected_version: string };
  type Row = {
    id: string;
    key: string;
    status: string;
    runner_class: string;
    deployment: string | null;
    execution_seq: number;
    result_id: string | null;
    execution_established: number | null;
    signaled: number | null;
    deadline_hit: number | null;
    orphans: number | null;
    exit_status: number | null;
  };
  const executions = db
    .prepare(
      `SELECT x."id", x."key", x."status", x."runner_class", x."deployment", x."execution_seq", r."id" AS "result_id", r."execution_established", r."signaled", r."deadline_hit", r."orphans", r."exit_status"
       FROM "check_executions" x LEFT JOIN "check_results" r ON r."id" = x."result"
       WHERE x."candidate" = ? AND x."protected_version" = ? AND x."status" <> 'cancelled'`,
    )
    .all(candidate.id, version) as Row[];
  // A result of the candidate recorded with no execution of its own (an
  // observation of a past execution, SEAM.md §189) shares the project's one
  // sequence and decides over an earlier registration, as at the gate
  // (gates.ts checkState): it is that check's latest.
  const observed = db
    .prepare(
      `SELECT r."id", c."key", 'recorded' AS "status", r."runner_class", NULL AS "deployment", r."execution_seq", r."id" AS "result_id", r."execution_established", r."signaled", r."deadline_hit", r."orphans", r."exit_status"
       FROM "check_results" r JOIN "checks" c ON c."id" = r."check" WHERE r."candidate" = ? AND r."protected_version" = ? AND r."execution" IS NULL`,
    )
    .all(candidate.id, version) as Row[];
  const latest = new Map<string, Row>();
  for (const x of [...executions, ...observed]) {
    const held = latest.get(x.key);
    if (held === undefined || x.execution_seq > held.execution_seq) latest.set(x.key, x);
  }
  const rows = [...latest.values()];
  const out: CheckProgress = { candidate: candidate.id, phase: candidatePhase(db, candidate), planned: rows.length, completed: 0, passed: 0, failed: 0, skipped: 0, interrupted: 0, queued: 0, running: 0, held: null };
  for (const x of rows) {
    if (x.status === 'recorded') {
      out.completed++;
      // A recorded execution whose result cannot be read is completed and
      // neither passed, failed nor skipped: unknown, never a pass.
      if (x.result_id === null) continue;
      const state = resultState(x as Parameters<typeof resultState>[0]);
      if (state === 'passed') out.passed++;
      else if (state === 'skipped') out.skipped++;
      else out.failed++;
    } else if (CHECK_QUEUED.includes(x.status)) out.queued++;
    else if (CHECK_RUNNING.includes(x.status)) out.running++;
    else if (x.status === 'interrupted') out.interrupted++;
  }
  out.held = checksHeld(db, project, rows.filter((x) => x.status === 'queued' && x.runner_class === 'direct'));
  return out;
}

// What holds the queued `direct` executions now, as the candidate's checks
// read shows it (store/transitions/checks.ts readCandidateExecutions): the
// check profile the runner has not qualified, else the resource envelope
// (unbound and deployment-bound apart). null: nothing holds them.
function checksHeld(db: Db, project: string, queued: { deployment: string | null }[]): CheckHeld | null {
  if (queued.length === 0) return null;
  const profile = runnerProfileHold(db, project);
  if (profile !== null) return { count: queued.length, code: profile.code, reason: profile.reason, decision: null };
  const unbound = queued.filter((x) => x.deployment === null);
  const bound = queued.filter((x) => x.deployment !== null);
  const holds = [
    unbound.length > 0 ? { n: unbound.length, hold: envelopeHold(db, { kind: 'check', project }) } : null,
    bound.length > 0 ? { n: bound.length, hold: envelopeHold(db, { kind: 'check', bound: true, project }) } : null,
  ].filter((h) => h !== null && h.hold !== null) as { n: number; hold: EnvelopeHold }[];
  if (holds.length === 0) return null;
  return { count: holds.reduce((n, h) => n + h.n, 0), code: holds[0]!.hold.code, reason: holds[0]!.hold.reason, decision: null };
}

// The phase a candidate's checks are for: the phase plan a `phase` trigger
// of its executions names (the latest), else the phase of the stages its
// nomination held (`held_work`), the latest phase if several; null when
// neither says.
function candidatePhase(db: Db, candidate: { id: string; held_work: string }): number | null {
  const byTrigger = db
    .prepare(
      `SELECT p."phase_number" FROM "check_executions" x JOIN "phase_plans" p ON p."id" = json_extract(x."trigger", '$.id')
       WHERE x."candidate" = ? AND json_extract(x."trigger", '$.source') = 'phase' ORDER BY x."execution_seq" DESC LIMIT 1`,
    )
    .get(candidate.id) as { phase_number: number } | undefined;
  if (byTrigger) return byTrigger.phase_number;
  const held = parseJson<unknown[]>(candidate.held_work) ?? [];
  const items = held.filter((h): h is string => typeof h === 'string');
  if (items.length === 0) return null;
  const byStage = db
    .prepare(
      `SELECT MAX(p."phase_number") AS "phase" FROM "work_items" w JOIN "stages" s ON s."id" = json_extract(w."subject", '$.stage') JOIN "phase_plans" p ON p."id" = s."phase_plan"
       WHERE w."id" IN (SELECT value FROM json_each(?))`,
    )
    .get(JSON.stringify(items)) as { phase: number | null };
  return byStage.phase;
}

// ---- deployment under way, and the candidate's current deployment ---------------------------

// A deployment under way in the project (D4 §4): a deploy operation whose
// orchestration has not ended, else deploy work not yet finished (requested,
// its operation not intended yet, or not completed). Its reason; null: none.
function deploymentUnderWay(db: Db, project: string): string | null {
  const op = db
    .prepare(
      `SELECT o."id", o."orchestration_stage", json_extract(o."subject", '$.candidate') AS "candidate", e."name" AS "environment" FROM "operations" o
       LEFT JOIN "environments" e ON e."id" = json_extract(o."target", '$.environment')
       WHERE o."project" = ? AND o."kind" = 'deploy' AND o."orchestration_stage" IS NOT NULL AND o."orchestration_stage" <> 'ended' ORDER BY o."seq" DESC LIMIT 1`,
    )
    .get(project) as { id: string; orchestration_stage: string; candidate: string | null; environment: string | null } | undefined;
  if (op) {
    return `Deployment operation ${op.id} of candidate ${op.candidate ?? '(not recorded)'} to ${op.environment ?? 'an environment not recorded'} is under way (its ${op.orchestration_stage} stage).`;
  }
  const work = db
    .prepare(
      `SELECT w."id", w."status", w."blocker", json_extract(w."subject", '$.candidate') AS "candidate", e."name" AS "environment" FROM "work_items" w
       LEFT JOIN "environments" e ON e."id" = json_extract(w."subject", '$.environment')
       WHERE w."project" = ? AND w."kind" = 'deploy' AND w."status" NOT IN ('complete', 'cancelled', 'parked') ORDER BY w."seq" DESC LIMIT 1`,
    )
    .get(project) as { id: string; status: string; blocker: string | null; candidate: string | null; environment: string | null } | undefined;
  if (!work) return null;
  const what = `The deployment of candidate ${work.candidate ?? '(not recorded)'} to ${work.environment ?? 'an environment not recorded'} (work item ${work.id}, ${work.status})`;
  if (work.status === 'eligible') {
    const held = parseJson<{ reason?: string }>(work.blocker)?.reason;
    return `${what} was requested and its operation has not started${held ? ` (held: ${held})` : ''}.`;
  }
  return `${what} has not finished.`;
}

// The project's current candidate: the newest not superseded.
const currentCandidate = (db: Db, project: string): string | null =>
  (db.prepare('SELECT "id" FROM "candidates" WHERE "project" = ? AND "superseded_by" IS NULL ORDER BY "seq" DESC LIMIT 1').get(project) as { id: string } | undefined)?.id ?? null;

// Whether the candidate is what runs in one of the project's environments
// (the design preview's reserved one apart, D7 §5.7): a service running
// there (`environment_records.running`) launched by a deploy operation of
// the candidate, read from the `attempted` fact of the same generation.
// `unknown` when something runs whose operation or candidate is not read.
function candidateDeployed(db: Db, project: string, candidate: string): 'current' | 'none' | 'unknown' {
  const envs = db
    .prepare(
      `SELECT e."name", r."running", r."attempted" FROM "environments" e LEFT JOIN "environment_records" r ON r."environment" = e."id"
       WHERE e."project" = ? AND e."name" <> ? ORDER BY e.rowid`,
    )
    .all(project, DESIGN_PREVIEW_ENV) as { name: string; running: string | null; attempted: string | null }[];
  let unknown = false;
  for (const env of envs) {
    if (env.running === null) continue;
    const running = parseJson<{ generation?: unknown }>(env.running);
    const attempted = parseJson<{ operation?: unknown; generation?: unknown }>(env.attempted);
    if (running === null || attempted === null || typeof attempted.operation !== 'string' || attempted.generation !== running.generation) {
      unknown = true;
      continue;
    }
    const op = db.prepare(`SELECT json_extract("subject", '$.candidate') AS "candidate" FROM "operations" WHERE "id" = ?`).get(attempted.operation) as { candidate: string | null } | undefined;
    if (!op || op.candidate === null) unknown = true;
    else if (op.candidate === candidate) return 'current';
  }
  return unknown ? 'unknown' : 'none';
}

// The checks as NOW reads them: their progress, or `unreadable` with why.
type ChecksRead = { progress: CheckProgress | null } | { unreadable: string };

// NOW's build_complete continues with the deploy readiness (the owner's
// instruction of 2026-10-29: "Build complete" distinguishes completed
// implementation from readiness to deploy): its sentence, and the primary
// action it allows (deploy only when ready; configure_environment when the
// environment is not configured; none otherwise).
interface ReadinessForNow {
  sentence: string;
  primary: 'deploy' | 'configure_environment' | null;
}

function nowOf(db: Db, project: string, runs: ExecutionRun[], decisions: number, checks: ChecksRead, readiness: () => ReadinessForNow) {
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
  } else if ('unreadable' in checks) {
    // Whether checks are under way is not known: neither checking nor any
    // state after it is established.
    return { state: 'unknown' as const, primary_action: null, reason: `The project's state cannot be computed: its automated checks could not be read (${checks.unreadable}).`, cause: 'store_error' };
  } else if (checks.progress !== null && checks.progress.queued + checks.progress.running > 0) {
    const c = checks.progress;
    state = 'checking';
    reason = `Checking${c.phase === null ? '' : ` phase ${c.phase}`}: ${c.completed} of ${c.planned} checks completed.`;
    primary = null;
    if (c.held !== null) {
      reason += ` ${c.held.count === 1 ? 'One queued check is' : `${c.held.count} queued checks are`} held (${c.held.code}): ${c.held.reason}`;
      if (c.held.decision !== null) primary = 'answer_decision';
    }
  } else {
    const ready = dispatchable(db, project);
    const deploying = ready > 0 ? null : deploymentUnderWay(db, project);
    if (ready > 0) {
      state = 'ready';
      reason = ready === 1 ? 'One work item is eligible and can be dispatched at the next tick.' : `${ready} work items are eligible and can be dispatched at the next tick.`;
      primary = 'tick';
    } else if (deploying !== null) {
      state = 'deploying';
      reason = deploying;
      primary = null;
    } else if (buildCompleteAwaitingDeploy(db, project)) {
      // Implementation complete; whether it can be deployed is the
      // readiness's, never claimed here (no visual acceptance, no
      // production readiness).
      const r = readiness();
      state = 'build_complete';
      reason = `The planned build and its automated gates are complete.${r.sentence}`;
      primary = r.primary;
    } else {
      state = 'idle';
      reason = 'Nothing is under way, nothing waits for you, and no work can be dispatched.';
      primary = null;
    }
  }
  return { state, primary_action: primary, reason, cause };
}

// The build complete and its deployment the owner's to make (SEAM.md §352;
// D6 §6.8): every phase of the roadmap completed (the plan read's
// `build.complete`), `alpha_deploy: manual`, a current candidate, and that
// candidate running in none of the project's environments, as far as the
// store says (one whose candidate is not read is not taken as none).
function buildCompleteAwaitingDeploy(db: Db, project: string): boolean {
  if (!buildComplete(db, project)) return false;
  if (projectOptions(db, project).alpha_deploy !== 'manual') return false;
  const candidate = currentCandidate(db, project);
  if (candidate === null) return false;
  return candidateDeployed(db, project, candidate) === 'none';
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
       WHERE e."project" = ? ORDER BY e.rowid, e."id"`,
    )
    .all(project) as { id: string; name: string; observed: string | null }[];
  return rows.map((row) => {
    const stored = parseJson<{ condition: string; observed_at: string | null; source: string | null }>(row.observed);
    if (stored === null || stored.observed_at === null) {
      // Never observed: the condition is unknown, and nothing says when.
      return { id: row.id, name: row.name, state: 'unknown', observed: { condition: 'unknown', observed_at: null, source: null, provenance: null, freshness: null, expires_at: null } };
    }
    const at = Date.parse(stored.observed_at);
    const age = now - at;
    const freshness = !Number.isFinite(age) || age > bound ? 'expired' : age > bound / 2 ? 'stale' : 'fresh';
    return {
      id: row.id,
      name: row.name,
      // The environment's state as the engine knows it now (SEAM.md §378):
      // the condition observed, `unknown` when nothing current says.
      state: freshness === 'expired' ? 'unknown' : stored.condition,
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

// The deployment compatibility a read serves, and the build's readiness to
// deploy (deploy/compatibility.ts): unknown with the reason when the store
// cannot be read for it, never a default.
function deployFacts(db: Db, project: string, trees: TreeAnswer[]): { compatibility: Compatibility; complete: boolean | null; readiness: ReturnType<typeof readinessOf>['readiness']; now: ReadinessForNow } {
  const at = nowIso();
  let compatibility: Compatibility;
  try {
    compatibility = servedCompatibility(db, project, trees, at);
  } catch (err) {
    compatibility = unreadCompatibility(err, at);
  }
  let complete: boolean | null;
  try {
    complete = buildComplete(db, project);
  } catch {
    complete = null;
  }
  if (complete === null) {
    const reason = 'Whether the planned build is complete cannot be read from the store.';
    return { compatibility, complete, readiness: { state: 'unknown', reason, environment: null }, now: { sentence: '', primary: null } };
  }
  const { readiness, sentence } = readinessOf(complete, compatibility);
  return { compatibility, complete, readiness, now: { sentence, primary: readiness.state === 'ready' ? 'deploy' : readiness.state === 'unconfigured' ? 'configure_environment' : null } };
}

function projectSummary(db: Db, project: string, trees: TreeAnswer[] = []) {
  return projectRead(db, project, trees).summary;
}

function projectRead(db: Db, project: string, trees: TreeAnswer[]) {
  let facts: ReturnType<typeof deployFacts> | null = null;
  const deploy = () => (facts ??= deployFacts(db, project, trees));
  const runs = executionRuns(db, project);
  const decisions = openDecisionCount(db, project);
  let now;
  // The automated checks of the current candidate, served whatever NOW is
  // (beside a waiting decision too); null with the reason when they cannot
  // be read, never zeros.
  let checks: CheckProgress | null = null;
  let checksReason: string | null = null;
  let checksRead = false;
  try {
    seamStatusRead(project);
    checksRead = true;
    let read: ChecksRead;
    try {
      read = { progress: checksOf(db, project) };
    } catch (err) {
      read = { unreadable: err instanceof Error ? err.message : String(err) };
    }
    if ('unreadable' in read) checksReason = `The automated checks cannot be shown: the store could not be read (${read.unreadable}).`;
    else checks = read.progress;
    now = nowOf(db, project, runs, decisions, read, () => deploy().now);
  } catch (err) {
    now = unknownNow(err);
    if (!checksRead) checksReason = `The automated checks cannot be shown: the store could not be read (${err instanceof Error ? err.message : String(err)}).`;
  }
  return {
    summary: {
      id: project,
      now,
      checks,
      checks_reason: checksReason,
      execution: { runs },
      open_decisions: { count: decisions },
      spend_today: spendToday(db, project),
    },
    deploy,
  };
}

// GET /v1/projects
// `trees`: the current candidates' trees the main thread read for this
// read (deploy/compatibility-eval.ts treesForRead), when no current
// evaluation records them.
export function listProjects(db: Db, args: { trees?: TreeAnswer[] } = {}) {
  const head = envelope(db);
  const ids = (db.prepare('SELECT "id" FROM "projects" ORDER BY rowid, "id"').all() as { id: string }[]).map((r) => r.id);
  return { ...head, projects: ids.map((id) => projectSummary(db, id, args.trees ?? [])) };
}

// GET /v1/projects/:p
export function readProject(db: Db, args: { project: string; trees?: TreeAnswer[] }) {
  mustProject(db, args.project);
  const head = envelope(db);
  const row = db.prepare('SELECT "id", "name", "tier", "paused", "registration_state" FROM "projects" WHERE "id" = ?').get(args.project) as Record<string, unknown>;
  const read = projectRead(db, args.project, args.trees ?? []);
  const deploy = read.deploy();
  return {
    ...head,
    project: {
      ...read.summary,
      // Whether the environments can host the build's output (the
      // static-preview shapes, §5), and the build's completion beside its
      // readiness to deploy: implementation complete is not deployable.
      deployment_compatibility: deploy.compatibility,
      build: { complete: deploy.complete, deploy_readiness: deploy.readiness },
      name: row.name,
      tier: row.tier,
      paused: row.paused === 1,
      registration_state: row.registration_state,
      environments: environmentsOf(db, args.project),
      idea: ideaOf(db, args.project),
      // D6 §8.1 step 1 (SEAM.md §379): A, the signals and the mode; the
      // mode is null, with its reason, while the owner has not chosen it.
      adoption: parseJson<unknown>((db.prepare('SELECT "adoption" FROM "projects" WHERE "id" = ?').get(args.project) as { adoption: string | null }).adoption),
      // The work held now, with what each waits on (M543 (f)).
      held_work: heldWork(db, args.project),
      // The Designer turns held on the day limits, oldest first (the
      // driver's decision on objection 156; rule 25).
      held_turns: (
        db
          .prepare(
            `SELECT h."run", h."number", h."limits", h."waiting_on", h."created_at" FROM "session_held_turns" h JOIN "runs" r ON r."id" = h."run"
             WHERE h."project" = ? AND h."released_at" IS NULL AND r."state" <> 'ended' AND r."session_state" = 'turn_running' AND r."turn_count" = h."number"
             ORDER BY h."created_at", h.rowid`,
          )
          .all(args.project) as { run: string; number: number; limits: string; waiting_on: string; created_at: string }[]
      ).map((t) => ({
        run: t.run,
        turn: t.number,
        reason: 'day_limit',
        limits: parseJson<string[]>(t.limits),
        waiting_on: (parseJson<{ run: string; role: string }[]>(t.waiting_on) ?? []).map((w) => ({ run: w.run, role: w.role })),
        since: t.created_at,
      })),
    },
  };
}

// The project's idea record (D6 §3.1; SEAM.md §345): its version, its blob,
// the binding that accepted it (the create route's or an `idea_accept`
// decision), the identity block once one that parses was accepted, and every
// binding kept. null for a project created without one.
function ideaOf(db: Db, project: string): Record<string, unknown> | null {
  const row = db.prepare('SELECT "idea_version", "idea_blob", "idea_identity", "idea_history" FROM "projects" WHERE "id" = ?').get(project) as
    | { idea_version: number | null; idea_blob: string | null; idea_identity: string | null; idea_history: string }
    | undefined;
  if (!row || row.idea_version === null) return null;
  let history: { version: number; blob: string; binding: Record<string, unknown> }[] = [];
  try {
    history = JSON.parse(row.idea_history) as typeof history;
  } catch {
    history = [];
  }
  const current = history.find((h) => h.version === row.idea_version) ?? null;
  let identity: unknown = null;
  try {
    identity = row.idea_identity === null ? null : (JSON.parse(row.idea_identity) as unknown);
  } catch {
    identity = null;
  }
  return {
    version: row.idea_version,
    blob: row.idea_blob,
    binding: current?.binding ?? null,
    identity,
    history: history.map((h) => ({ version: h.version, blob: h.blob, binding: h.binding })),
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
         o."created_at", o."finalized_at", COALESCE(s."journal_kind", d."journal_kind") AS "journal_kind", COALESCE(s."state", d."state") AS "state"
       FROM "operations" o LEFT JOIN "git_journal_state" s ON s."operation" = o."id" LEFT JOIN "deploy_journal_state" d ON d."operation" = o."id"
       WHERE o."project" = ? ORDER BY o."seq"`,
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
      const deployment = o.kind === 'deploy' || o.kind === 'teardown' ? deployParts(db, o.id) : null;
      return {
        id: o.id,
        seq: o.seq,
        kind: o.kind,
        journal_kind: o.journal_kind,
        state: o.state,
        // SEAM.md §250: the journal's events, in order.
        journal: journalEvents(db, o.id),
        status: o.status,
        purpose: inputs?.purpose ?? null,
        intent: intent ? (JSON.parse(intent.payload) as Record<string, unknown>) : (deployment?.intent ?? null),
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
        // A deploy or teardown operation (D4 §§4.1, 4.2): its frozen intent,
        // its attempts' frozen intents and its verification rounds.
        ...(deployment !== null ? { deployment } : {}),
      };
    }),
  };
}

// GET /v1/projects/:p/environments (D1 §11.3; brief B4): the project's
// environments with their current observation, as the project read shows
// them. M1 keeps no observation history and runs no observation job, so
// there is none to show.
// GET /v1/projects/:p/environments/:e (D4 §6.1; N02): the three facts apart,
// the configuration in force beside what the running service was launched
// with, the generation and the operation in flight, all as stored. A read:
// no adapter call, no record written, no observation's age refreshed.
export function readOneEnvironment(db: Db, args: { project: string; environment: string; trees?: TreeAnswer[] }) {
  mustProject(db, args.project);
  const read = readEnvironment(db, args);
  // The deployment compatibility as the project read serves it, this
  // environment's entry only (the static-preview shapes, §5).
  let compatibility: Compatibility;
  try {
    compatibility = servedCompatibility(db, args.project, args.trees ?? [], nowIso());
  } catch (err) {
    compatibility = unreadCompatibility(err, nowIso());
  }
  const own = compatibility.environments === null ? null : compatibility.environments.filter((e) => e.environment === read.environment.id);
  return { ...envelope(db), ...read, environment: { ...read.environment, deployment_compatibility: { ...compatibility, environments: own } } };
}

// GET /v1/projects/:p/environments/:e/logs (D4 §6.1, A.8; SEAM.md §294):
// stored records only.
export function readEnvironmentLogs(db: Db, args: { project: string; environment: string }) {
  mustProject(db, args.project);
  return { ...envelope(db), ...readLogs(db, args) };
}

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
  const gates: Record<string, { id: string; outcome: string; stale: boolean; computed_at: string; serving?: unknown }> = {};
  const evaluations = db
    .prepare('SELECT "id", "gate_kind", "outcome", "stale", "computed_at", "serving" FROM "gate_evaluations" WHERE "candidate" = ? ORDER BY rowid')
    .all(args.candidate) as { id: string; gate_kind: string; outcome: string; stale: number; computed_at: string; serving: string | null }[];
  // An evaluation's `serving` (the owner's ruling of 2026-10-29): serving
  // verified, never acceptance; shown only where one was recorded.
  for (const e of evaluations) gates[e.gate_kind] = { id: e.id, outcome: e.outcome, stale: e.stale === 1, computed_at: e.computed_at, ...(e.serving !== null ? { serving: JSON.parse(e.serving) as unknown } : {}) };
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
function deployAdmissionHold(item: WorkRow): { code: string; reason: string | null; subject: Record<string, unknown> } | null {
  const stored = parseJson<{ reason?: string; hold?: { code?: string; reason?: string; subject?: Record<string, unknown> } }>(item.blocker);
  if (stored?.reason !== 'resource_envelope' || !stored.hold) return null;
  return { code: stored.hold.code ?? 'resource_envelope', reason: stored.hold.reason ?? null, subject: stored.hold.subject ?? {} };
}

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

function requalificationBlocker(db: Db, w: WorkRow) {
  const hold = requalificationHold(db, w);
  if (hold === null) return null;
  return { reason: 'requalification_required', trust_entry: hold.trust_entry, run: hold.run, what_to_do: hold.what_to_do, decision: null, options: null };
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
      // Held on a requalification once its question is acknowledged (D2
      // §4.1; real loop run 4): still shown, with what releases it.
      blocker: blockerOf(db, w) ?? requalificationBlocker(db, w),
      // An eligible item held by the resource envelope (D2 §3.7, A.7): it
      // stays eligible, and this says why it is not dispatched now.
      // A deploy waiting for its service's admission (D4 §4.7, A.2) shows
      // the hold its operation recorded (SEAM.md §271).
      dispatch_hold: w.status === 'eligible' ? envelopeHold(db, { kind: 'role', project: w.project }) : w.kind === 'deploy' ? deployAdmissionHold(w) : null,
      // Why an eligible item waits now (N01), with what it waits on where
      // its hold names it (M543: a replan's prerequisite results).
      held: heldOf(w),
    })),
  };
}

// An item's hold as it stands (work.ts setHold): its reason, since when,
// and the results it waits on; null when it is not held.
function heldOf(w: WorkRow): { reason: string; since: string | null; pending?: unknown[] } | null {
  const row = w as WorkRow & { held?: string | null; held_intervals?: string | null };
  if (!row.held) return null;
  const intervals = parseJson<{ from: string; to?: string; reason: string; pending?: unknown[] }[]>(row.held_intervals ?? null) ?? [];
  const open = intervals.length > 0 && intervals[intervals.length - 1]!.to === undefined ? intervals[intervals.length - 1]! : null;
  return { reason: row.held, since: open?.from ?? null, ...(open?.pending ? { pending: open.pending } : {}) };
}

// The project's work held now (M543 (f)): each held item with its reason
// and what it waits on.
function heldWork(db: Db, project: string) {
  const rows = db.prepare(`SELECT * FROM "work_items" WHERE "project" = ? AND "held" IS NOT NULL AND "status" = 'eligible' ORDER BY "seq"`).all(project) as WorkRow[];
  return rows.map((w) => ({ work_item: w.id, kind: w.kind, ...heldOf(w)! }));
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
      checks: JSON.parse((e.checks as string | undefined) ?? '{}') as Record<string, unknown>,
      scope: e.scope,
      stale: e.stale === 1,
      missing_verifications: JSON.parse((e.missing_verifications as string | undefined) ?? '[]') as { finding: string; criterion: string | null; check: string | null }[],
    },
  };
}

// What a run's output tail reads once no live transcript is there: whether
// the run has ended, and its published transcript, if any (SEAM.md §92).
export function runTail(db: Db, args: { project: string; run: string }) {
  const run = db.prepare('SELECT "project", "state" FROM "runs" WHERE "id" = ?').get(args.run) as { project: string; state: string } | undefined;
  if (!run || run.project !== args.project) throw notFound('run', args.run);
  const record = db
    .prepare(`SELECT "id", "path", "sha256", "bytes", "post_scan" FROM "records" WHERE "run" = ? AND "kind" = 'transcript' AND "published" = 1 AND "path" IS NOT NULL ORDER BY rowid DESC, "id" DESC LIMIT 1`)
    .get(args.run) as { id: string; path: string; sha256: string | null; bytes: number | null; post_scan: string } | undefined;
  return { ended: run.state === 'ended', record: record ? { id: record.id, path: record.path, sha256: record.sha256, bytes: record.bytes, quarantined: record.post_scan === 'hit' } : null };
}
