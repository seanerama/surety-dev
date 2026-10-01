// Runs, from dispatch to end (D1 §§2.6, 2.7, 3.2, 4.1, 4.5, 8.1 step 9, 8.3,
// 13.1, 15.1, 16; build spec §6 corrections 1, 2, 10, 12, 13). Each function
// here is one transition, run inside one store transaction by the caller.
// None of them waits on a process, git or a stream: the main thread does
// that between transitions and hands each result to the next one.

import { canonical, illegal, nextSeq, notFound, sha256 } from './common.js';
import { type DecisionRow, invalidateDecision, raiseDecision } from './decisions.js';
import { engineSettings, projectPolicy } from './settings.js';
import type { Tx } from './tx.js';
import { KIND_PATHS, RUN_OWNING, type WorkStatus } from './work-table.js';
import { type WorkRow, getWorkItem, transitionWork } from './work.js';

export type RunState = 'created' | 'claimed' | 'executing' | 'validating' | 'proposal_captured' | 'finalizing' | 'ended';
export type Outcome = 'completed' | 'failed' | 'refused' | 'timed_out' | 'stopped' | 'abandoned' | 'recovered';
export type ReasonClass = 'none' | 'invalid_result' | 'infra_error' | 'preflight_refused' | 'deadline' | 'human_stop' | 'human_abandon' | 'recovered';
export type DomainStatus = 'allocated' | 'launched' | 'terminated' | 'quarantined';
export type InvocationStatus = 'dispatch_started' | 'refused' | 'launched' | 'ended' | 'unknown';

export interface RunRow {
  id: string;
  created_at: string;
  project: string;
  seq: number;
  work_item: string;
  role: string;
  kind: string;
  state: RunState;
  outcome: Outcome | null;
  reason_class: ReasonClass | null;
  backend: string;
  model_requested: string;
  grant: string | null;
  workspace: string | null;
  base_revision: string;
  deadline_at: string;
  parent_run: string | null;
  quarantined: number;
}

export interface LeaseRow {
  id: string;
  resource_kind: string;
  resource_id: string;
  generation: number;
  released_at: string | null;
  closing: number;
}

const FOREVER = '9999-12-31T23:59:59.999Z';

const addSeconds = (iso: string, seconds: number) => new Date(Date.parse(iso) + seconds * 1000).toISOString();

export function getRun(tx: Tx, id: string): RunRow | undefined {
  return tx.db.prepare('SELECT * FROM "runs" WHERE "id" = ?').get(id) as RunRow | undefined;
}

function mustRun(tx: Tx, id: string): RunRow {
  const run = getRun(tx, id);
  if (!run) throw notFound('run', id);
  return run;
}

// The unreleased execution lease of a run, if any.
function runLease(tx: Tx, run: string): LeaseRow | undefined {
  return tx.db
    .prepare(`SELECT * FROM "leases" WHERE "resource_kind" = 'run' AND "resource_id" = ? AND "released_at" IS NULL`)
    .get(run) as LeaseRow | undefined;
}

const runSubject = (run: RunRow) => ({ project: run.project, run: run.id, work_item: run.work_item });

function setRunState(tx: Tx, run: RunRow, to: RunState, extra: Record<string, unknown> = {}): void {
  const sets = Object.keys(extra).map((k) => `"${k}" = ?`);
  tx.db.prepare(`UPDATE "runs" SET ${['"state" = ?', ...sets].join(', ')} WHERE "id" = ?`).run(to, ...Object.values(extra), run.id);
}

function statuses(tx: Tx, invocation: string): InvocationStatus[] {
  return (tx.db.prepare('SELECT "status" FROM "invocation_status_observations" WHERE "invocation" = ? ORDER BY "seq"').all(invocation) as { status: InvocationStatus }[]).map(
    (r) => r.status,
  );
}

function observe(tx: Tx, run: RunRow, invocation: string, status: InvocationStatus): void {
  const { n } = tx.db.prepare('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "invocation_status_observations" WHERE "invocation" = ?').get(invocation) as { n: number };
  tx.db
    .prepare('INSERT INTO "invocation_status_observations" ("id", "created_at", "project", "invocation", "seq", "status", "at") VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(tx.newId('iso_'), tx.at, run.project, invocation, n, status, tx.at);
  tx.emit('invocation.status', { project: run.project, run: run.id, invocation }, { status, seq: n });
}

const TERMINAL_OBSERVATIONS: InvocationStatus[] = ['ended', 'unknown', 'refused'];

// ---- dispatch ---------------------------------------------------------------

// The role that performs each dispatched kind (F §4.1; E24 item 5).
export const ROLE_OF: Record<string, string> = {
  stage_build: 'builder',
  fix: 'builder',
  verification: 'verifier',
  check_correction: 'verifier',
  review: 'reviewer',
  replan: 'architect',
  assessment: 'architect',
};

export interface ClaimArgs {
  project: string;
  workItem: string;
  incarnation: string;
  backend: { id: string; version: string };
  baseRevision: string;
  maxConcurrentRuns: number;
}

export interface Claim {
  run: string;
  project: string;
  work_item: string;
  work_kind: string;
  role: string;
  invocation: string;
  domain: string;
  generation: number;
  deadline_at: string;
  base_revision: string;
}

// Why an item may not be dispatched now (D1 §8.1 step 8), or null if it may.
export function dispatchBlocker(db: Tx['db'], item: WorkRow, maxConcurrentRuns: number): string | null {
  const project = db.prepare('SELECT "paused" FROM "projects" WHERE "id" = ?').get(item.project) as { paused: number } | undefined;
  if (!project) return 'project missing';
  if (project.paused === 1) return 'project paused';
  if (item.status !== 'eligible') return `status ${item.status}`;
  if (item.dispatch_hold === 1) return 'dispatch hold';
  if (!ROLE_OF[item.kind]) return `kind ${item.kind} is not dispatched`;
  const live = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
  if (live(`SELECT COUNT(*) AS n FROM "runs" WHERE "project" = ? AND "state" <> 'ended'`, item.project) > 0) return 'project has a run';
  if (live(`SELECT COUNT(*) AS n FROM "runs" WHERE "state" <> 'ended'`) >= maxConcurrentRuns) return 'engine at max_concurrent_runs';
  for (const dep of JSON.parse(item.depends_on ?? '[]') as string[]) {
    const row = db.prepare('SELECT "status" FROM "work_items" WHERE "id" = ?').get(dep) as { status: string } | undefined;
    if (!row || row.status !== 'complete') return `depends on ${dep}`;
  }
  const holding = db
    .prepare(
      `SELECT 1 FROM "decisions" d, json_each(json_extract(d."blocked_while_open", '$.work_items')) w
       WHERE d."project" = ? AND d."status" = 'open' AND w."value" = ? LIMIT 1`,
    )
    .get(item.project, item.id);
  if (holding) return 'held by an open decision';
  return null;
}

// D1 §8.1 step 9, one transaction: the run (claimed), its work item claimed,
// the run lease, the grant, the invocation receipt, the execution domain
// (allocated) and its process ownership with pid null. Returns null, and
// writes nothing, if the item may not be dispatched now.
export function claimDispatch(tx: Tx, args: ClaimArgs): Claim | null {
  const item = getWorkItem(tx, args.workItem);
  if (!item || item.project !== args.project) return null;
  if (dispatchBlocker(tx.db, item, args.maxConcurrentRuns) !== null) return null;
  const role = ROLE_OF[item.kind]!;
  const policy = projectPolicy(item.project);
  const deadlineSeconds = policy[`deadline_${role}`]!;
  const leaseTtl = engineSettings().lease_ttl;

  // A Resume, or a retry after a timeout, is a new run linked to the one it
  // continues (D1 §15.3).
  const previous = tx.db
    .prepare('SELECT "id", "outcome" FROM "runs" WHERE "work_item" = ? ORDER BY "seq" DESC LIMIT 1')
    .get(item.id) as { id: string; outcome: Outcome | null } | undefined;
  const parent = previous && ['stopped', 'timed_out', 'recovered'].includes(previous.outcome ?? '') ? previous.id : null;

  const run = tx.newId('run_');
  const seq = nextSeq(tx, item.project, 'runs');
  const deadlineAt = addSeconds(tx.at, deadlineSeconds);
  tx.db
    .prepare(
      `INSERT INTO "runs" ("id", "created_at", "project", "seq", "work_item", "role", "kind", "state", "backend", "backend_version",
         "model_requested", "base_revision", "deadline_at", "parent_run", "quarantined")
       VALUES (?, ?, ?, ?, ?, ?, 'one_shot', 'claimed', ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(run, tx.at, item.project, seq, item.id, role, args.backend.id, args.backend.version, args.backend.id, args.baseRevision, deadlineAt, parent);
  const subject = { project: item.project, run, work_item: item.id };
  tx.emit('run.created', subject, { seq, role, backend: args.backend.id, base_revision: args.baseRevision, parent_run: parent });
  tx.emit('run.claimed', subject, {});

  // An automatic re-dispatch after a failed run counts one repair (D1 §4.3).
  const repairs = item.repair_due === 1 ? item.repair_attempts + 1 : item.repair_attempts;
  transitionWork(tx, item, 'claimed', { prior_status: 'eligible', repair_attempts: repairs, repair_due: 0 }, { run });

  const lease = tx.newId('lease_');
  tx.db
    .prepare(
      `INSERT INTO "leases" ("id", "created_at", "resource_kind", "resource_id", "owner_incarnation", "generation", "acquired_at", "renewed_at",
         "expires_at", "closing", "cleanup_authority")
       VALUES (?, ?, 'run', ?, ?, 1, ?, ?, ?, 0, 0)`,
    )
    .run(lease, tx.at, run, args.incarnation, tx.at, tx.at, addSeconds(tx.at, leaseTtl));

  const grant = tx.newId('grant_');
  tx.db
    .prepare(
      `INSERT INTO "capability_grants" ("id", "created_at", "project", "run", "capabilities", "env_allowlist", "secret_refs", "issued_at", "expires_at")
       VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
    )
    .run(grant, tx.at, item.project, run, JSON.stringify(['workspace_write']), JSON.stringify(['PATH', 'LANG', 'SURETY_DOMAIN', 'SURETY_INVOCATION']), tx.at, deadlineAt);
  tx.db.prepare('UPDATE "runs" SET "grant" = ? WHERE "id" = ?').run(grant, run);

  const invocation = allocateReceipt(tx, run);
  const domain = tx.newId('dom_');
  tx.db
    .prepare(`INSERT INTO "execution_domains" ("id", "created_at", "project", "run", "invocation", "status") VALUES (?, ?, ?, ?, ?, 'allocated')`)
    .run(domain, tx.at, item.project, run, invocation);
  tx.db
    .prepare(`INSERT INTO "process_ownership" ("id", "created_at", "project", "domain", "invocation", "incarnation") VALUES (?, ?, ?, ?, ?, ?)`)
    .run(tx.newId('proc_'), tx.at, item.project, domain, invocation, args.incarnation);

  return {
    run,
    project: item.project,
    work_item: item.id,
    work_kind: item.kind,
    role,
    invocation,
    domain,
    generation: 1,
    deadline_at: deadlineAt,
    base_revision: args.baseRevision,
  };
}

// The scheduler's receipt allocation (D1 §2.6; correction 10): create or read
// the one null-turn receipt of a one-shot run.
export function allocateReceipt(tx: Tx, runId: string): string {
  const run = mustRun(tx, runId);
  const existing = tx.db.prepare('SELECT "id" FROM "invocation_receipts" WHERE "run" = ? AND "turn" IS NULL').get(runId) as { id: string } | undefined;
  if (existing) return existing.id;
  if (run.state === 'ended' || run.state === 'finalizing') throw illegal(`Allocating a receipt for a ${run.state} run`, { run: runId, state: run.state });
  if (!run.grant) throw illegal('Allocating a receipt for a run without a grant', { run: runId });
  const id = tx.newId('inv_');
  const policy = projectPolicy(run.project);
  const budget = {
    budget_run_billable_tokens: policy.budget_run_billable_tokens,
    budget_day_verified_usd: policy.budget_day_verified_usd,
    budget_day_unknown_tokens: policy.budget_day_unknown_tokens,
  };
  tx.db
    .prepare(
      `INSERT INTO "invocation_receipts" ("id", "created_at", "project", "run", "turn", "provider", "model_requested", "grant", "budget_snapshot")
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(id, tx.at, run.project, runId, run.backend, run.model_requested, run.grant, JSON.stringify(budget));
  tx.emit('invocation.receipt', { project: run.project, run: runId, invocation: id }, { provider: run.backend });
  return id;
}

// The choke point refused the backend (D1 §15.1): the invocation is recorded
// refused, never launched, and the run enters finalizing with outcome refused.
export function refuseInvocation(tx: Tx, args: { run: string; invocation: string; code: string }): void {
  const run = mustRun(tx, args.run);
  if (!statuses(tx, args.invocation).includes('refused')) observe(tx, run, args.invocation, 'refused');
  beginEnd(tx, { run: args.run, outcome: 'refused', reason: 'preflight_refused', reasonText: args.code });
}

// ---- workspace through the journal ----------------------------------------------

interface JournalPayload {
  repo: string;
  run: string;
  path: string;
  base?: string;
  workspace?: string;
  lease_generation?: number;
}

function journal(tx: Tx, project: string, operation: string, kind: 'worktree_add' | 'worktree_remove', event: 'intended' | 'applied' | 'confirmed' | 'failed' | 'ambiguous' | 'finalized', payload: JournalPayload): void {
  const { n } = tx.db.prepare('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "git_journal_events" WHERE "operation" = ?').get(operation) as { n: number };
  tx.db
    .prepare('INSERT INTO "git_journal_events" ("id", "created_at", "project", "operation", "seq", "journal_kind", "event_kind", "payload") VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(tx.newId('gje_'), tx.at, project, operation, n, kind, event, JSON.stringify(payload));
  const type = event === 'failed' ? null : (`git.journal_${event}` as const);
  if (type) tx.emit(type, { project, operation, run: payload.run }, { journal_kind: kind, seq: n });
}

// D1 §2.5, §6.3, §7.3: the git_worktree operation and its journal intent are
// committed before the worktree is touched.
export function intendWorktree(
  tx: Tx,
  args: { run: string; kind: 'worktree_add' | 'worktree_remove'; repo: string; path: string; base?: string; workspace?: string; deadlineSeconds: number },
): { operation: string } {
  const run = mustRun(tx, args.run);
  const operation = tx.newId('op_');
  const target = { repo: args.repo, path: args.path };
  const subject = { run: args.run, action: args.kind };
  const key = createKey('git_worktree', target, subject, 1);
  tx.db
    .prepare(
      `INSERT INTO "operations" ("id", "created_at", "project", "seq", "kind", "target", "subject", "idempotency_key", "semantic_generation", "status", "deadline_at")
       VALUES (?, ?, ?, ?, 'git_worktree', ?, ?, ?, 1, 'intended', ?)`,
    )
    .run(operation, tx.at, run.project, nextSeq(tx, run.project, 'operations'), JSON.stringify(target), JSON.stringify(subject), key, addSeconds(tx.at, args.deadlineSeconds));
  tx.emit('operation.intended', { project: run.project, operation, run: run.id }, { kind: 'git_worktree', journal_kind: args.kind });
  const payload: JournalPayload = { repo: args.repo, run: args.run, path: args.path };
  if (args.base !== undefined) payload.base = args.base;
  if (args.workspace !== undefined) payload.workspace = args.workspace;
  journal(tx, run.project, operation, args.kind, 'intended', payload);
  return { operation };
}

// D1 §2.5: sha256(kind, target, subject, semantic_generation).
const createKey = (kind: string, target: unknown, subject: unknown, generation: number): string => sha256(canonical({ kind, target, subject, generation }));

function operationPayload(tx: Tx, operation: string): { project: string; kind: 'worktree_add' | 'worktree_remove'; payload: JournalPayload; last: string } {
  const rows = tx.db.prepare('SELECT * FROM "git_journal_events" WHERE "operation" = ? ORDER BY "seq"').all(operation) as {
    project: string;
    journal_kind: 'worktree_add' | 'worktree_remove';
    event_kind: string;
    payload: string;
  }[];
  if (rows.length === 0) throw notFound('operation', operation);
  return { project: rows[0]!.project, kind: rows[0]!.journal_kind, payload: JSON.parse(rows[0]!.payload) as JournalPayload, last: rows.at(-1)!.event_kind };
}

// The outcome of a worktree effect, as the main thread observed it: the
// command's result and a probe of the worktree list (D1 §7.10). `present`
// confirms the effect; the finalizer writes the domain rows it exists for.
export function settleWorktree(tx: Tx, args: { operation: string; result: 'present' | 'absent' | 'ambiguous' }): { workspace: string | null } {
  const { project, kind, payload, last } = operationPayload(tx, args.operation);
  if (last === 'finalized' || last === 'failed') {
    const ws = tx.db.prepare('SELECT "id" FROM "workspaces" WHERE "path" = ?').get(payload.path) as { id: string } | undefined;
    return { workspace: ws?.id ?? null };
  }
  const done = (status: 'succeeded' | 'failed' | 'ambiguous') => {
    tx.db.prepare('UPDATE "operations" SET "status" = ?, "finalized_at" = ? WHERE "id" = ?').run(status, status === 'ambiguous' ? null : tx.at, args.operation);
    tx.emit(`operation.${status}` as const, { project, operation: args.operation, run: payload.run }, {});
  };
  const effectHappened = kind === 'worktree_add' ? args.result === 'present' : args.result === 'absent';
  if (args.result === 'ambiguous') {
    journal(tx, project, args.operation, kind, 'ambiguous', payload);
    done('ambiguous');
    return { workspace: null };
  }
  if (!effectHappened) {
    journal(tx, project, args.operation, kind, 'failed', payload);
    done('failed');
    return { workspace: null };
  }
  if (last === 'intended') journal(tx, project, args.operation, kind, 'applied', payload);
  journal(tx, project, args.operation, kind, 'confirmed', payload);
  let workspace: string | null = null;
  const run = mustRun(tx, payload.run);
  if (kind === 'worktree_add') {
    workspace = tx.newId('ws_');
    tx.db
      .prepare(
        `INSERT INTO "workspaces" ("id", "created_at", "project", "run", "path", "base_revision", "current_base", "disposition")
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
      )
      .run(workspace, tx.at, project, run.id, payload.path, payload.base!, payload.base!);
    tx.db.prepare('UPDATE "runs" SET "workspace" = ? WHERE "id" = ?').run(workspace, run.id);
  } else {
    workspace = payload.workspace ?? null;
    tx.db.prepare(`UPDATE "workspaces" SET "disposition" = 'discarded', "disposed_at" = ? WHERE "id" = ?`).run(tx.at, workspace);
  }
  journal(tx, project, args.operation, kind, 'finalized', payload);
  done('succeeded');
  tx.emit('operation.finalized', { project, operation: args.operation, run: run.id }, {});
  return { workspace };
}

// Journal operations not yet finalized or failed, for recovery (D1 §7.10).
export function pendingWorktreeOperations(tx: Tx): { operation: string; kind: string; payload: JournalPayload; last: string }[] {
  const ops = tx.db.prepare(`SELECT "id" FROM "operations" WHERE "kind" = 'git_worktree' AND "finalized_at" IS NULL AND "status" IN ('intended', 'in_progress')`).all() as { id: string }[];
  return ops.map((o) => {
    const p = operationPayload(tx, o.id);
    return { operation: o.id, kind: p.kind, payload: p.payload, last: p.last };
  });
}

// The choke point appends dispatch_started immediately before it spawns
// (D1 §15.1), while the run lease is still active.
export function dispatchStarted(tx: Tx, args: { run: string; invocation: string }): boolean {
  const run = mustRun(tx, args.run);
  const lease = runLease(tx, run.id);
  if (!lease || lease.closing === 1) return false;
  if (!statuses(tx, args.invocation).includes('dispatch_started')) observe(tx, run, args.invocation, 'dispatch_started');
  return true;
}

export function leaseActive(tx: Tx, args: { run: string; generation: number }): boolean {
  const lease = runLease(tx, args.run);
  return lease !== undefined && lease.closing === 0 && lease.generation === args.generation;
}

// ---- launch and callbacks ---------------------------------------------------------

function completeOwnership(tx: Tx, run: RunRow, args: { domain: string; invocation: string; pid: number; pgid: number; startTime: string | null }): void {
  tx.db
    .prepare('UPDATE "process_ownership" SET "pid" = ?, "pgid" = ?, "pid_start_time" = ? WHERE "domain" = ? AND "pid" IS NULL')
    .run(args.pid, args.pgid, args.startTime, args.domain);
  if (!statuses(tx, args.invocation).includes('launched')) observe(tx, run, args.invocation, 'launched');
  tx.db.prepare(`UPDATE "execution_domains" SET "status" = 'launched' WHERE "id" = ? AND "status" = 'allocated'`).run(args.domain);
}

// After the spawn (D1 §15.1): ownership completed, `launched`, the domain
// launched; and, unless the run was stopped meanwhile, the run and its work
// item executing.
export function recordLaunch(tx: Tx, args: { run: string; invocation: string; domain: string; pid: number; pgid: number; startTime: string | null }): void {
  const run = mustRun(tx, args.run);
  completeOwnership(tx, run, args);
  const lease = runLease(tx, run.id);
  if (run.state === 'claimed' && lease && lease.closing === 0) {
    setRunState(tx, run, 'executing', { started_at: tx.at });
    tx.emit('run.started', runSubject(run), {});
    const item = getWorkItem(tx, run.work_item)!;
    if (item.status === 'claimed') transitionWork(tx, item, 'executing', {}, { run: run.id });
  }
}

// Recovery found a live process of a domain whose ownership was never
// completed (a crash between spawn and ownership, D1 §3.2): it records what it
// found, so the launch is never reported as one that did not happen.
export function recordFoundProcess(tx: Tx, args: { run: string; invocation: string; domain: string; pid: number; pgid: number; startTime: string }): void {
  completeOwnership(tx, mustRun(tx, args.run), args);
}

// A role heartbeat renews the run lease (D1 §8.3) while it is active.
export function heartbeat(tx: Tx, args: { run: string; generation: number }): boolean {
  const lease = runLease(tx, args.run);
  if (!lease || lease.closing === 1 || lease.generation !== args.generation) return false;
  tx.db.prepare('UPDATE "leases" SET "renewed_at" = ?, "expires_at" = ? WHERE "id" = ?').run(tx.at, addSeconds(tx.at, engineSettings().lease_ttl), lease.id);
  const run = mustRun(tx, args.run);
  tx.emit('run.heartbeat', runSubject(run), { generation: lease.generation });
  return true;
}

// A usage observation (D1§3.6, §13.1). Accepted while the lease is unreleased,
// closing included (cleanup may append usage, D1 §4.5 step 1), and until the
// invocation has its terminal observation.
export function recordUsage(tx: Tx, args: { run: string; generation: number; invocation: string; semantics: 'cumulative' | 'delta'; raw: unknown }): boolean {
  const lease = runLease(tx, args.run);
  if (!lease || lease.generation !== args.generation) return false;
  if (statuses(tx, args.invocation).some((s) => TERMINAL_OBSERVATIONS.includes(s))) return false;
  const run = mustRun(tx, args.run);
  const { n } = tx.db.prepare('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "usage_observations" WHERE "invocation" = ?').get(args.invocation) as { n: number };
  tx.db
    .prepare('INSERT INTO "usage_observations" ("id", "created_at", "project", "invocation", "seq", "semantics", "raw", "at") VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(tx.newId('uo_'), tx.at, run.project, args.invocation, n, args.semantics, JSON.stringify(args.raw), tx.at);
  tx.emit('invocation.usage', { project: run.project, run: run.id, invocation: args.invocation }, { seq: n, semantics: args.semantics });
  return true;
}

// The role's structured result arrived (D1 §4.1): the run is validating. A
// result is a role effect: refused once the lease is closing (D1 §8.3), so a
// success that arrives after Stop or a deadline has no effect.
export function recordResult(tx: Tx, args: { run: string; generation: number; valid: boolean }): boolean {
  const lease = runLease(tx, args.run);
  if (!lease || lease.closing === 1 || lease.generation !== args.generation) return false;
  const run = mustRun(tx, args.run);
  if (run.state !== 'executing') return false;
  setRunState(tx, run, 'validating');
  tx.emit('run.validating', runSubject(run), { valid: args.valid });
  return true;
}

// ---- the run-end protocol (D1 §4.5) ------------------------------------------------

// Step 1, and the outcome: the run lease becomes closing and the run enters
// finalizing with its outcome, which is set exactly once. Idempotent: a run
// already finalizing or ended keeps what it has.
export function beginEnd(tx: Tx, args: { run: string; outcome: Outcome; reason: ReasonClass; reasonText?: string }): { run: string; state: RunState; outcome: Outcome } {
  const run = mustRun(tx, args.run);
  if (run.state === 'finalizing' || run.state === 'ended') return { run: run.id, state: run.state, outcome: run.outcome! };
  const lease = runLease(tx, run.id);
  if (lease) tx.db.prepare('UPDATE "leases" SET "closing" = 1, "cleanup_authority" = 1 WHERE "id" = ?').run(lease.id);
  setRunState(tx, run, 'finalizing', { outcome: args.outcome, reason_class: args.reason, reason_text: args.reasonText ?? null });
  tx.emit('run.finalizing', runSubject(run), { outcome: args.outcome, reason_class: args.reason, from: run.state });
  return { run: run.id, state: 'finalizing', outcome: args.outcome };
}

// Step 2's result for one domain: termination established, by the boundary's
// observation, or because the running engine knows it never spawned into it.
export function domainTerminated(tx: Tx, args: { domain: string; observed: boolean }): void {
  const d = tx.db.prepare('SELECT * FROM "execution_domains" WHERE "id" = ?').get(args.domain) as { id: string; run: string; project: string; status: DomainStatus } | undefined;
  if (!d) throw notFound('domain', args.domain);
  if (d.status === 'terminated') return;
  tx.db.prepare(`UPDATE "execution_domains" SET "status" = 'terminated' WHERE "id" = ?`).run(d.id);
  tx.db.prepare('UPDATE "process_ownership" SET "termination_confirmed_at" = ? WHERE "domain" = ?').run(tx.at, d.id);
  tx.emit('domain.terminated', { project: d.project, domain: d.id, run: d.run }, { from: d.status, observed: args.observed });
}

// Step 3: termination could not be established. The run stays finalizing and
// quarantined; nothing is released or discarded; the run lease becomes a
// quarantine reservation, which is never execution authority; the grant is
// revoked; a blocker names what is wrong (D1 §4.5 step 3; corrections 1, 2).
export function quarantineRun(tx: Tx, args: { run: string; domains: string[]; processes: string[]; incarnation: string }): void {
  const run = mustRun(tx, args.run);
  if (run.state !== 'finalizing') throw illegal(`Quarantining a ${run.state} run`, { run: run.id });
  for (const id of args.domains) {
    const d = tx.db.prepare('SELECT "status" FROM "execution_domains" WHERE "id" = ?').get(id) as { status: DomainStatus } | undefined;
    if (!d || (d.status !== 'allocated' && d.status !== 'launched')) continue;
    tx.db.prepare(`UPDATE "execution_domains" SET "status" = 'quarantined' WHERE "id" = ?`).run(id);
    tx.emit('domain.quarantined', { project: run.project, domain: id, run: run.id }, { from: d.status });
  }
  if (run.quarantined === 0) {
    tx.db.prepare('UPDATE "runs" SET "quarantined" = 1 WHERE "id" = ?').run(run.id);
    tx.emit('run.quarantined', runSubject(run), { outcome: run.outcome, domains: args.domains });
    tx.emit('engine.quarantine', { project: run.project, run: run.id }, { domains: args.domains });
  }
  tx.db.prepare(`UPDATE "workspaces" SET "disposition" = 'quarantined' WHERE "run" = ? AND "disposition" = 'active'`).run(run.id);
  const lease = runLease(tx, run.id);
  if (lease) tx.db.prepare('UPDATE "leases" SET "released_at" = ? WHERE "id" = ?').run(tx.at, lease.id);
  const reservation = tx.db.prepare(`SELECT 1 FROM "leases" WHERE "resource_kind" = 'quarantine' AND "resource_id" = ? AND "released_at" IS NULL`).get(run.id);
  if (!reservation) {
    tx.db
      .prepare(
        `INSERT INTO "leases" ("id", "created_at", "resource_kind", "resource_id", "owner_incarnation", "generation", "acquired_at", "renewed_at",
           "expires_at", "closing", "cleanup_authority")
         VALUES (?, ?, 'quarantine', ?, ?, 1, ?, ?, ?, 0, 1)`,
      )
      .run(tx.newId('lease_'), tx.at, run.id, args.incarnation, tx.at, tx.at, FOREVER);
  }
  tx.db.prepare('UPDATE "capability_grants" SET "revoked_at" = ? WHERE "run" = ? AND "revoked_at" IS NULL').run(tx.at, run.id);
  raiseDecision(tx, {
    project: run.project,
    kind: 'blocker',
    subjectType: 'run',
    subjectId: run.id,
    question:
      `Run ${run.id} cannot be ended: the execution boundary has not reported its domain${args.domains.length === 1 ? '' : 's'} ` +
      `${args.domains.join(', ')} terminated` +
      (args.processes.length > 0 ? ` (processes seen: ${args.processes.join(', ')})` : '') +
      '. It stays quarantined until termination is observed; nothing of it is reused or discarded meanwhile.',
    options: [
      {
        key: 'acknowledge',
        label: 'Acknowledge',
        consequence: 'Records that you have seen this. It establishes nothing: the quarantine ends only when termination is observed.',
        effect: { record: 'acknowledgement' },
      },
    ],
    manifest: runBlockerManifest(tx, run.id),
    blockedWorkItems: [run.work_item],
  });
}

// A.8 blocker manifest for a run: its status and its quarantine state.
export function runBlockerManifest(tx: Tx, runId: string): Record<string, unknown> {
  const run = getRun(tx, runId);
  return { run: runId, run_state: run?.state ?? null, quarantined: run?.quarantined ?? null };
}

// Steps 5 to 7, one transaction: every invocation gets its terminal
// observation and, if it was launched, its one original ledger row; the
// workspace is disposed of; the grant revoked; every lease naming the run
// released; the run ended; the work item moved as its outcome requires.
// Idempotent: a run already ended is left as it is.
export function finishRun(
  tx: Tx,
  args: { run: string; invocations: Record<string, 'ended' | 'unknown' | 'refused'>; recovery: string | null },
): { ended: boolean } {
  const run = mustRun(tx, args.run);
  if (run.state === 'ended') return { ended: false };
  if (run.state !== 'finalizing' || run.outcome === null) throw illegal(`Ending a ${run.state} run`, { run: run.id });
  const open = tx.db.prepare(`SELECT "id", "status" FROM "execution_domains" WHERE "run" = ? AND "status" <> 'terminated'`).all(run.id) as { id: string }[];
  if (open.length > 0) throw illegal('Ending a run whose domains are not terminated', { run: run.id, domains: open.map((d) => d.id) });

  const receipts = tx.db.prepare('SELECT "id", "turn" FROM "invocation_receipts" WHERE "run" = ? ORDER BY "id"').all(run.id) as { id: string; turn: string | null }[];
  for (const receipt of receipts) {
    const seen = statuses(tx, receipt.id);
    if (seen.some((s) => TERMINAL_OBSERVATIONS.includes(s))) continue;
    let terminal = args.invocations[receipt.id];
    if (terminal === undefined) terminal = seen.includes('launched') ? 'ended' : seen.includes('dispatch_started') ? 'unknown' : 'refused';
    if (seen.includes('launched') && terminal === 'refused') terminal = 'unknown';
    observe(tx, run, receipt.id, terminal);
    if (terminal !== 'refused') charge(tx, run, receipt);
  }

  tx.db
    .prepare(`UPDATE "workspaces" SET "disposition" = 'retained' WHERE "run" = ? AND "disposition" IN ('active', 'quarantined')`)
    .run(run.id);
  tx.db.prepare('UPDATE "capability_grants" SET "revoked_at" = ? WHERE "run" = ? AND "revoked_at" IS NULL').run(tx.at, run.id);
  tx.db.prepare('UPDATE "leases" SET "released_at" = ? WHERE "resource_id" = ? AND "released_at" IS NULL').run(tx.at, run.id);
  setRunState(tx, run, 'ended', { finished_at: tx.at, quarantined: 0 });
  const payload: Record<string, unknown> = { outcome: run.outcome, reason_class: run.reason_class };
  if (args.recovery !== null) payload.recovery = { incarnation: args.recovery };
  tx.emit('run.ended', runSubject(run), payload);

  const blockers = tx.db.prepare(`SELECT * FROM "decisions" WHERE "subject_type" = 'run' AND "subject_id" = ? AND "status" = 'open'`).all(run.id) as DecisionRow[];
  for (const d of blockers) invalidateDecision(tx, d, 'the run has ended');

  workAfterRun(tx, run);
  return { ended: true };
}

// One original ledger row per launched invocation (D1 §13.1). Usage is kept
// raw; normalized amounts are the ledger slice's (slice 4), so the token
// fields stay null (unknown, never zero) and the cost is unknown.
function charge(tx: Tx, run: RunRow, receipt: { id: string; turn: string | null }): void {
  const exists = tx.db.prepare('SELECT 1 FROM "ledger_rows" WHERE "invocation" = ? AND "corrects" IS NULL').get(receipt.id);
  if (exists) return;
  const usage = tx.db.prepare('SELECT "seq", "semantics", "raw" FROM "usage_observations" WHERE "invocation" = ? ORDER BY "seq"').all(receipt.id) as {
    seq: number;
    semantics: string;
    raw: string;
  }[];
  const raw = { observations: usage.map((u) => ({ seq: u.seq, semantics: u.semantics, raw: JSON.parse(u.raw) as unknown })) };
  const id = tx.newId('led_');
  tx.db
    .prepare(
      `INSERT INTO "ledger_rows" ("id", "created_at", "project", "invocation", "run", "turn", "role", "provider", "model_requested", "raw_usage",
         "normalization_version", "billable_in", "cached_in", "out", "usage_complete", "cost_status", "day_utc")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unnormalized', NULL, NULL, NULL, 0, 'unknown', ?)`,
    )
    .run(id, tx.at, run.project, receipt.id, run.id, receipt.turn, run.role, run.backend, run.model_requested, JSON.stringify(raw), tx.at.slice(0, 10));
  tx.emit('ledger.row', { project: run.project, run: run.id, invocation: receipt.id }, { ledger_row: id, observations: usage.length });
}

// What a run's outcome does to its work item (D1 §4.3, §8.4; SEAM.md §§15,
// 16). Only an item the run still owns is moved.
function workAfterRun(tx: Tx, run: RunRow): void {
  const item = getWorkItem(tx, run.work_item);
  if (!item || !RUN_OWNING.includes(item.status)) return;
  const latest = tx.db.prepare('SELECT "id" FROM "runs" WHERE "work_item" = ? ORDER BY "seq" DESC LIMIT 1').get(item.id) as { id: string };
  if (latest.id !== run.id) return;
  const policy = projectPolicy(run.project);
  const cause = { run: run.id, outcome: run.outcome };
  switch (run.outcome) {
    case 'completed':
      if (KIND_PATHS[item.kind].includes('integrating')) {
        // Integration is not built in this revision: the work stops here,
        // visibly, rather than being reported as integrated or complete.
        parkWork(tx, item, 'integration_unavailable', cause);
      } else {
        transitionWork(tx, item, 'complete', {}, cause);
      }
      return;
    case 'failed':
      if (item.repair_attempts >= policy.repair_attempts_max!) parkWork(tx, item, 'repair_attempts_max', cause);
      else transitionWork(tx, item, 'eligible', { repair_due: 1 }, cause);
      return;
    case 'refused': {
      const refusals = item.preflight_refusals + 1;
      if (refusals >= policy.preflight_refusals_max!) parkWork(tx, item, 'preflight_refusals_max', cause, { preflight_refusals: refusals });
      else transitionWork(tx, item, 'eligible', { preflight_refusals: refusals }, cause);
      return;
    }
    case 'timed_out':
      parkWork(tx, item, 'deadline', cause);
      return;
    case 'stopped':
    case 'recovered':
      transitionWork(tx, item, 'held', {}, cause);
      return;
    case 'abandoned':
      transitionWork(tx, item, (item.prior_status ?? 'eligible') as WorkStatus, { dispatch_hold: 1 }, { ...cause, cause: 'abandon' });
      return;
    default:
      return;
  }
}

// A limit was reached: the item parks with a visible blocker and an open
// `blocker` decision that holds it (D1 §4.3, §10.6; SEAM.md §15).
function parkWork(tx: Tx, item: WorkRow, reason: string, cause: Record<string, unknown>, extra: { preflight_refusals?: number } = {}): void {
  const decision = raiseDecision(tx, {
    project: item.project,
    kind: 'blocker',
    subjectType: 'work_item',
    subjectId: item.id,
    question: `Work item ${item.id} (${item.kind}) is parked: ${PARK_REASONS[reason] ?? reason}. Retry it, or cancel it.`,
    options: [
      { key: 'retry', label: 'Retry', consequence: 'The item becomes eligible and is dispatched again by the scheduler.', effect: { work_item: item.id, to: 'eligible' } },
      { key: 'cancel', label: 'Cancel', consequence: 'The item is cancelled and never dispatched again.', effect: { work_item: item.id, to: 'cancelled' } },
    ],
    manifest: { work_item: item.id, status: 'parked', reason },
    blockedWorkItems: [item.id],
  });
  const blocker = JSON.stringify({ reason, raised_at: tx.at, decision: decision.id });
  transitionWork(tx, item, 'parked', { blocker, ...extra }, { ...cause, reason });
}

const PARK_REASONS: Record<string, string> = {
  repair_attempts_max: 'every permitted repair attempt failed',
  preflight_refusals_max: 'its runs were refused before launch as often as policy allows',
  deadline: 'its run passed its deadline',
  integration_unavailable: 'its run finished, and integration is not available in this engine revision',
};

// A.8 blocker manifest for a work item.
export function workBlockerManifest(tx: Tx, d: DecisionRow): Record<string, unknown> {
  const item = getWorkItem(tx, d.subject_id);
  const blocker = item?.blocker ? (JSON.parse(item.blocker) as { reason: string }) : null;
  return { work_item: d.subject_id, status: item?.status ?? null, reason: blocker?.reason ?? null };
}

// ---- reads for the run-end protocol and recovery -----------------------------------

export interface EndFacts {
  run: RunRow;
  repo: string;
  lease: LeaseRow | null;
  domains: { id: string; status: DomainStatus; invocation: string; pid: number | null; pgid: number | null; pid_start_time: string | null }[];
  receipts: { id: string; statuses: InvocationStatus[] }[];
  workspace: { id: string; path: string; disposition: string } | null;
}

export function endFacts(tx: Tx, runId: string): EndFacts {
  const run = mustRun(tx, runId);
  const repo = (tx.db.prepare('SELECT "dev_repo_path" FROM "projects" WHERE "id" = ?').get(run.project) as { dev_repo_path: string }).dev_repo_path;
  const domains = tx.db
    .prepare(
      `SELECT d."id", d."status", d."invocation", o."pid", o."pgid", o."pid_start_time"
       FROM "execution_domains" d LEFT JOIN "process_ownership" o ON o."domain" = d."id" WHERE d."run" = ? ORDER BY d."id"`,
    )
    .all(runId) as EndFacts['domains'];
  const receipts = (tx.db.prepare('SELECT "id" FROM "invocation_receipts" WHERE "run" = ? ORDER BY "id"').all(runId) as { id: string }[]).map((r) => ({
    id: r.id,
    statuses: statuses(tx, r.id),
  }));
  const workspace = (run.workspace
    ? tx.db.prepare('SELECT "id", "path", "disposition" FROM "workspaces" WHERE "id" = ?').get(run.workspace)
    : tx.db.prepare('SELECT "id", "path", "disposition" FROM "workspaces" WHERE "run" = ?').get(runId)) as EndFacts['workspace'] | undefined;
  return { run, repo, lease: runLease(tx, runId) ?? null, domains, receipts, workspace: workspace ?? null };
}

// Runs that have not ended, oldest first.
export function unendedRuns(tx: Tx): RunRow[] {
  return tx.db.prepare(`SELECT * FROM "runs" WHERE "state" <> 'ended' ORDER BY "created_at", "id"`).all() as RunRow[];
}
