// Runs, from dispatch to end (D1 §§2.6, 2.7, 3.2, 4.1, 4.5, 8.1 step 9, 8.3,
// 13.1, 15.1, 16; build spec §6 corrections 1, 2, 10, 12, 13). Each function
// here is one transition, run inside one store transaction by the caller.
// None of them waits on a process, git or a stream: the main thread does
// that between transitions and hands each result to the next one.

import { seamLeaseRead } from '../../testing/seam.js';
import { canonical, illegal, nextSeq, notFound, sha256 } from './common.js';
import { assertEdge } from './lifecycle.js';
import { type DecisionRow, invalidateDecision } from './decisions.js';
import { raiseQuestion } from './queue.js';
import { contentHash, getCandidate } from './evidence.js';
import { engineSettings, projectPolicy } from './settings.js';
import type { Tx } from './tx.js';
import { journalBlocks } from './journal.js';
import { chargeInvocation, exhaustedLimits } from './ledger.js';
import { type Baseline, blockingObservation, integrationRef, projectRepoRow, rebaselineRunCheckout, registryRow } from './repo.js';
import { resolveBackend } from './trust.js';
import { closeLaunch } from './boundary.js';
import { keyVariable } from '../../invoke/adapters/templates.js';
import { RUN_OWNING, type WorkStatus } from './work-table.js';
import { type WorkRow, getWorkItem, transitionWork } from './work.js';

export type RunState = 'created' | 'claimed' | 'executing' | 'validating' | 'proposal_captured' | 'finalizing' | 'ended';
export type Outcome = 'completed' | 'failed' | 'refused' | 'timed_out' | 'stopped' | 'abandoned' | 'recovered';
export type ReasonClass =
  | 'none'
  | 'invalid_result'
  | 'infra_error'
  | 'preflight_refused'
  | 'deadline'
  | 'human_stop'
  | 'human_abandon'
  | 'recovered'
  | 'diff_violation'
  | 'ref_violation'
  | 'integration_conflict'
  | 'budget';
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
  reason_text: string | null;
  reason_detail: string | null;
  chain: number;
  transcript: string | null;
  result: string | null;
}

export interface LeaseRow {
  id: string;
  resource_kind: string;
  resource_id: string;
  generation: number;
  renewed_at: string;
  expires_at: string;
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

// A lease past its expiry is expired, and expiry is final: it is never
// renewed again and no callback presenting it is accepted (D1 §8.3; E26
// item 1). Timestamps share one format, so they compare as strings.
const expired = (lease: LeaseRow, at: string): boolean => lease.expires_at <= at;

// Execution authority for a run at `at`: the run lease, unreleased, not
// closing, of this generation, and not expired (D1 §8.3).
function liveLease(tx: Tx, run: string, generation: number): LeaseRow | null {
  const lease = runLease(tx, run);
  if (!lease || lease.closing === 1 || lease.generation !== generation || expired(lease, tx.at)) return null;
  return lease;
}

const runSubject = (run: RunRow) => ({ project: run.project, run: run.id, work_item: run.work_item });

function setRunState(tx: Tx, run: RunRow, to: RunState, extra: Record<string, unknown> = {}): void {
  assertEdge('RunState', run.state, to, { run: run.id });
  const sets = Object.keys(extra).map((k) => `"${k}" = ?`);
  tx.db.prepare(`UPDATE "runs" SET ${['"state" = ?', ...sets].join(', ')} WHERE "id" = ?`).run(to, ...Object.values(extra), run.id);
}

function statuses(tx: Tx, invocation: string): InvocationStatus[] {
  return (tx.db.prepare('SELECT "status" FROM "invocation_status_observations" WHERE "invocation" = ? ORDER BY "seq"').all(invocation) as { status: InvocationStatus }[]).map(
    (r) => r.status,
  );
}

function observe(tx: Tx, run: RunRow, invocation: string, status: InvocationStatus, exit: { exit_class: string | null; exit_evidence: string | null } | null = null): void {
  const { n } = tx.db.prepare('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "invocation_status_observations" WHERE "invocation" = ?').get(invocation) as { n: number };
  tx.db
    .prepare(
      'INSERT INTO "invocation_status_observations" ("id", "created_at", "project", "invocation", "seq", "status", "at", "exit_class", "exit_evidence") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(tx.newId('iso_'), tx.at, run.project, invocation, n, status, tx.at, exit?.exit_class ?? null, exit?.exit_evidence ?? null);
  tx.emit('invocation.status', { project: run.project, run: run.id, invocation }, { status, seq: n, ...(exit?.exit_class ? { exit_class: exit.exit_class } : {}) });
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
  // The scripted backend's version where this engine has it (harness mode
  // with a scripted directory), else null.
  scripted: string | null;
  maxConcurrentRuns: number;
  // The provider-side cap held with each secret reference that has one
  // (D2 §4.2, Q2; SEAM.md §120).
  providerCaps?: Record<string, number>;
  // The incarnation's scope, when the run's domain is a cgroup of the real
  // boundary (D2 §§3.1, 3.2): the domain is allocated with its path under it.
  scope?: string | null;
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
  // When the run lease was taken, on the engine clock.
  lease_renewed_at: string;
  // The domain's cgroup under the incarnation's scope; null on the scripted
  // boundary.
  cgroup_path: string | null;
  // The sandbox profile (D2 §§2.8, 3.8).
  profile: string;
  // The backend the run is dispatched to (D2 §4.1): the trust entry that
  // authorizes it, if any; or why it is refused before any domain or
  // process (`backend_refused`, `isolation_unqualified`,
  // `budget_boundary_unenforceable`).
  backend: string;
  trust_entry: string | null;
  // What the choke point launches for a real backend: the entry's binary.
  entry: { backend: string; binary_path: string; binary_sha256: string; model: string; key_ref: string } | null;
  // A refusal in its form (code, reason, what_to_do, subject), recorded
  // with the run's end (SEAM.md §116).
  refusal: { code: string; reason: string; what_to_do: string; subject: Record<string, unknown> } | null;
}

// Why an item may not be dispatched now (D1 §8.1 step 8), or null if it may.
// `check`: false for a projection, which reads the budget without being a
// budget check (D1 §6.6 governs the check, not the read).
export function dispatchBlocker(db: Tx['db'], item: WorkRow, maxConcurrentRuns: number, opts: { check?: boolean } = {}): string | null {
  const project = db.prepare('SELECT "paused", "registration_state" FROM "projects" WHERE "id" = ?').get(item.project) as { paused: number; registration_state: string } | undefined;
  if (!project) return 'project missing';
  if (project.paused === 1) return 'project paused';
  if (project.registration_state !== 'registered') return 'project not registered';
  // Nothing of a project is dispatched while its integration branch or its
  // repository has an unreconciled observation (SEAM.md §32), or its journal
  // holds an ambiguous operation (SEAM.md §45).
  if (blockingObservation(db, item.project)) return 'out-of-band change';
  if (journalBlocks(db, item.project)) return 'journal blocked';
  if (item.status !== 'eligible') return `status ${item.status}`;
  if (item.dispatch_hold === 1) return 'dispatch hold';
  if (!ROLE_OF[item.kind]) return `kind ${item.kind} is not dispatched`;
  const live = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
  if (live(`SELECT COUNT(*) AS n FROM "runs" WHERE "project" = ? AND "state" <> 'ended'`, item.project) > 0) return 'project has a run';
  // A project whose day has passed a day limit is not dispatched (D1 §13.3;
  // SEAM.md §55). The check reads the ledger; a read that fails throws, and
  // nothing is dispatched on it (D1 §6.6).
  if (exhaustedLimits(db, item.project, { check: opts.check ?? true, dispatch: true }).length > 0) return 'budget exhausted';
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
  // D1 §8.1 step 8, D1-34: work a run's outcome created runs only as far as
  // max_chained_roles allows without a human step.
  if (item.chain + 1 > projectPolicy(db, item.project).max_chained_roles!) return CHAIN_BOUNDARY;
  return null;
}

export const CHAIN_BOUNDARY = 'chaining boundary';

// D1 §8.1 step 9, one transaction: the run (claimed), its work item claimed,
// the run lease, the grant, the invocation receipt, the execution domain
// (allocated) and its process ownership with pid null. Returns null, and
// writes nothing, if the item may not be dispatched now.
export function claimDispatch(tx: Tx, args: ClaimArgs): Claim | null {
  const item = getWorkItem(tx, args.workItem);
  if (!item || item.project !== args.project) return null;
  if (dispatchBlocker(tx.db, item, args.maxConcurrentRuns) !== null) return null;
  // The run's base: the checkpoint the work continues from (D1 §7.4), or the
  // commit the registry expects the integration branch at.
  const p = projectRepoRow(tx, item.project);
  const registered = registryRow(tx, item.project, integrationRef(p.integration_branch));
  const baseRevision = item.continue_from ?? registered?.expected_oid ?? null;
  if (baseRevision === null) return null;
  const role = ROLE_OF[item.kind]!;
  const policy = projectPolicy(tx.db, item.project);
  const deadlineSeconds = policy[`deadline_${role}`]!;
  // The backend, from the policy and the trust table (D2 §4.1). A refusal is
  // recorded with the run it refuses, before any domain is placed or any
  // process started.
  const backend = resolveBackend(tx.db, { project: item.project, role, scripted: args.scripted });
  const leaseTtl = engineSettings().lease_ttl;

  // A Resume, or a retry after a timeout, is a new run linked to the one it
  // continues (D1 §15.3).
  const previous = tx.db
    .prepare('SELECT "id", "outcome" FROM "runs" WHERE "work_item" = ? ORDER BY "seq" DESC LIMIT 1')
    .get(item.id) as { id: string; outcome: Outcome | null } | undefined;
  // A continuation from a checkpoint is linked to the run that made it (D1 §7.4).
  const continues = previous?.outcome === 'completed' && item.continue_from !== null;
  const parent = previous && (['stopped', 'timed_out', 'recovered'].includes(previous.outcome ?? '') || continues) ? previous.id : null;
  // The roles of the chain this run belongs to (D1-34; E24 item 1).
  const chain = item.chain + 1;

  const run = tx.newId('run_');
  const seq = nextSeq(tx, item.project, 'runs');
  const deadlineAt = addSeconds(tx.at, deadlineSeconds);
  tx.db
    .prepare(
      `INSERT INTO "runs" ("id", "created_at", "project", "seq", "work_item", "role", "kind", "state", "backend", "backend_version",
         "model_requested", "base_revision", "deadline_at", "parent_run", "quarantined", "chain")
       VALUES (?, ?, ?, ?, ?, ?, 'one_shot', 'claimed', ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(run, tx.at, item.project, seq, item.id, role, backend.backend, backend.version, backend.model, baseRevision, deadlineAt, parent, chain);
  // The acceptance content the run is given, fixed now (E41 item 4).
  const candidateId = (JSON.parse(item.subject) as { candidate?: string }).candidate;
  const candidateRow = candidateId ? getCandidate(tx.db, candidateId) : undefined;
  if (candidateRow) tx.db.prepare('UPDATE "runs" SET "content_hash" = ? WHERE "id" = ?').run(contentHash(tx.db, item.project, candidateRow), run);
  const subject = { project: item.project, run, work_item: item.id };
  tx.emit('run.created', subject, { seq, role, backend: backend.backend, base_revision: baseRevision, parent_run: parent });
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

  // A real backend's grant names its provider key's reference and the
  // variable the adapter's template delivers it in; the key's provider-side
  // cap, if one is held with it, is recorded as configured evidence, never
  // as the engine's enforcement (D2 §§2.5, 4.2; SEAM.md §§116, 120).
  const keyRef = `backend/${backend.backend}/api_key`;
  const real = backend.kind === 'entry';
  const cap = real ? args.providerCaps?.[keyRef] : undefined;
  const grant = tx.newId('grant_');
  tx.db
    .prepare(
      `INSERT INTO "capability_grants" ("id", "created_at", "project", "run", "capabilities", "env_allowlist", "secret_refs", "issued_at", "expires_at", "provider_cap")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      grant,
      tx.at,
      item.project,
      run,
      JSON.stringify(['workspace_write']),
      JSON.stringify(['PATH', 'LANG', 'SURETY_DOMAIN', 'SURETY_INVOCATION', ...(real ? [keyVariable(backend.backend)] : [])]),
      JSON.stringify(real ? [keyRef] : []),
      tx.at,
      deadlineAt,
      cap === undefined ? null : JSON.stringify({ status: 'configured', usd: cap, reference: keyRef }),
    );
  tx.db.prepare('UPDATE "runs" SET "grant" = ? WHERE "id" = ?').run(grant, run);

  const trustEntry = backend.kind === 'entry' ? backend.entry.id : null;
  const invocation = allocateReceipt(tx, run, { trustEntry });
  const domain = tx.newId('dom_');
  // D2 §3.2: the dispatch transaction allocates the domain `authorizable`,
  // with its cgroup path when the real boundary will hold it.
  const cgroupPath = args.scope ? `${args.scope}/${domain}` : null;
  const profile = item.profile ?? 'role';
  tx.db
    .prepare(
      `INSERT INTO "execution_domains" ("id", "created_at", "project", "run", "invocation", "status", "profile", "cgroup_path", "launch_state")
       VALUES (?, ?, ?, ?, ?, 'allocated', ?, ?, 'authorizable')`,
    )
    .run(domain, tx.at, item.project, run, invocation, profile, cgroupPath);
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
    base_revision: baseRevision,
    lease_renewed_at: tx.at,
    cgroup_path: cgroupPath,
    profile,
    backend: backend.backend,
    trust_entry: trustEntry,
    entry:
      backend.kind === 'entry'
        ? { backend: backend.backend, binary_path: backend.entry.binary_path, binary_sha256: backend.entry.binary_sha256, model: backend.entry.model, key_ref: keyRef }
        : null,
    refusal:
      backend.kind === 'refused'
        ? {
            code: backend.code,
            reason: backend.reason,
            what_to_do: backend.what_to_do,
            subject: backend.code === 'budget_boundary_unenforceable' ? { ...backend.subject, overshoot: { bounded_by: 'deadline', deadline_at: deadlineAt } } : backend.subject,
          }
        : null,
  };
}

// The scheduler's receipt allocation (D1 §2.6; correction 10): create or read
// the one null-turn receipt of a one-shot run.
export function allocateReceipt(tx: Tx, runId: string, opts: { trustEntry?: string | null } = {}): string {
  const run = mustRun(tx, runId);
  const existing = tx.db.prepare('SELECT "id" FROM "invocation_receipts" WHERE "run" = ? AND "turn" IS NULL').get(runId) as { id: string } | undefined;
  if (existing) return existing.id;
  if (run.state === 'ended' || run.state === 'finalizing') throw illegal(`Allocating a receipt for a ${run.state} run`, { run: runId, state: run.state });
  if (!run.grant) throw illegal('Allocating a receipt for a run without a grant', { run: runId });
  const id = tx.newId('inv_');
  const policy = projectPolicy(tx.db, run.project);
  const budget = {
    budget_run_billable_tokens: policy.budget_run_billable_tokens,
    budget_day_verified_usd: policy.budget_day_verified_usd,
    budget_day_unknown_tokens: policy.budget_day_unknown_tokens,
  };
  tx.db
    .prepare(
      `INSERT INTO "invocation_receipts" ("id", "created_at", "project", "run", "turn", "provider", "model_requested", "grant", "budget_snapshot", "trust_entry")
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(id, tx.at, run.project, runId, run.backend, run.model_requested, run.grant, JSON.stringify(budget), opts.trustEntry ?? null);
  tx.emit('invocation.receipt', { project: run.project, run: runId, invocation: id }, { provider: run.backend });
  return id;
}

// The choke point appends dispatch_started immediately before it spawns
// (D1 §15.1), while the run lease is still active.
export function dispatchStarted(tx: Tx, args: { run: string; invocation: string }): boolean {
  const run = mustRun(tx, args.run);
  const lease = runLease(tx, run.id);
  if (!lease || lease.closing === 1 || expired(lease, tx.at)) return false;
  if (!statuses(tx, args.invocation).includes('dispatch_started')) observe(tx, run, args.invocation, 'dispatch_started');
  return true;
}

export function leaseActive(tx: Tx, args: { run: string; generation: number }): boolean {
  seamLeaseRead();
  return liveLease(tx, args.run, args.generation) !== null;
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
  if (run.state === 'claimed' && lease && lease.closing === 0 && !expired(lease, tx.at)) {
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

// One renewal of a live run lease: renewed now, expiring lease_ttl from now,
// with run.heartbeat (D1 §4.1, §8.3). Returns the renewal time, or null if the
// lease is not live: released, closing, of another generation, or expired.
function renew(tx: Tx, args: { run: string; generation: number }, by: 'role' | 'engine'): string | null {
  const lease = liveLease(tx, args.run, args.generation);
  if (!lease) return null;
  const run = mustRun(tx, args.run);
  if (run.state === 'finalizing' || run.state === 'ended') return null;
  tx.db.prepare('UPDATE "leases" SET "renewed_at" = ?, "expires_at" = ? WHERE "id" = ?').run(tx.at, addSeconds(tx.at, engineSettings().lease_ttl), lease.id);
  tx.emit('run.heartbeat', runSubject(run), { generation: lease.generation, by });
  return tx.at;
}

// A role heartbeat renews the run lease while it is live (D1 §8.3).
export function heartbeat(tx: Tx, args: { run: string; generation: number }): string | null {
  return renew(tx, args, 'role');
}

// The engine renews the lease of a run whose live process it supervises, at
// least every lease_ttl/3, heartbeat or not (D1 §8.3; E25 item 1). Like a
// heartbeat, it cannot bring back a lease that has expired.
export function renewLease(tx: Tx, args: { run: string; generation: number }): string | null {
  return renew(tx, args, 'engine');
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
// result is a role effect: refused once the lease is closing or has expired
// (D1 §8.3), so a success that arrives after Stop, a deadline or the expiry
// of the lease has no effect.
export function recordResult(
  tx: Tx,
  args: { run: string; generation: number; valid: boolean; result?: Record<string, unknown> | null; record?: string | null; pending?: boolean },
): boolean {
  // `pending`: a lease that expired while the engine was paused, whose fresh
  // challenge found the backend exited (D2 §3.5; SEAM.md §130): the result it
  // sent before its exit takes effect with that exit. The lease must still be
  // unreleased, not closing and of the generation.
  if (args.pending) {
    const lease = runLease(tx, args.run);
    if (!lease || lease.closing === 1 || lease.generation !== args.generation) return false;
  } else if (!liveLease(tx, args.run, args.generation)) return false;
  const run = mustRun(tx, args.run);
  if (run.state !== 'executing') return false;
  // The result record is referenced only once it is published (SEAM.md §56).
  const record = args.record
    ? (tx.db.prepare(`SELECT "id" FROM "records" WHERE "id" = ? AND "run" = ? AND "kind" = 'result' AND "published" = 1`).get(args.record, run.id) as { id: string } | undefined)
    : undefined;
  setRunState(tx, run, 'validating', {
    ...(args.valid && args.result ? { result_value: JSON.stringify(args.result) } : {}),
    ...(record ? { result: record.id } : {}),
  });
  tx.emit('run.validating', runSubject(run), { valid: args.valid });
  return true;
}

// ---- the run-end protocol (D1 §4.5) ------------------------------------------------

// Step 1, and the outcome: the run lease becomes closing and the run enters
// finalizing with its outcome, which is set exactly once. Idempotent: a run
// already finalizing or ended keeps what it has.
//
// `decidedAt` is when the engine decided this end, which may be earlier than
// this transaction: the engine retries an end whose first attempt failed
// (E27 item 5). If the run lease, not yet closing, had expired by then, the
// expiry came first and nothing had decided the run's outcome before it: the
// run is recovered, whatever the engine saw afterwards (E27 item 3). Without
// `decidedAt` (a Stop or Abandon command, startup recovery) the given
// outcome is recorded as it is.
export function beginEnd(
  tx: Tx,
  args: { run: string; outcome: Outcome; reason: ReasonClass; reasonText?: string; decidedAt?: string; detail?: Record<string, unknown> },
): { run: string; state: RunState; outcome: Outcome } {
  const run = mustRun(tx, args.run);
  if (run.state === 'finalizing' || run.state === 'ended') return { run: run.id, state: run.state, outcome: run.outcome! };
  const lease = runLease(tx, run.id);
  let { outcome, reason, reasonText } = args;
  if (args.decidedAt !== undefined && lease && lease.closing === 0 && expired(lease, args.decidedAt)) {
    outcome = 'recovered';
    reason = 'recovered';
    reasonText = 'lease_expired';
  }
  if (lease) tx.db.prepare('UPDATE "leases" SET "closing" = 1, "cleanup_authority" = 1 WHERE "id" = ?').run(lease.id);
  setRunState(tx, run, 'finalizing', {
    outcome,
    reason_class: reason,
    reason_text: reasonText ?? null,
    reason_detail: args.detail !== undefined && outcome === args.outcome ? JSON.stringify(args.detail) : null,
  });
  const payload: Record<string, unknown> = { outcome, reason_class: reason, from: run.state };
  if (reasonText !== undefined) payload.reason_text = reasonText;
  tx.emit('run.finalizing', runSubject(run), payload);
  return { run: run.id, state: 'finalizing', outcome };
}

// D1 §8.1 step 1: a run lease past its expiry is reconciled through the
// run-end protocol, whether or not the engine that owns it is alive. This is
// step 1 for such a run. An outcome already recorded is kept; an end the
// engine decided before the expiry stands (beginEnd checks `decidedAt`); a
// run with neither is recovered (E27 item 3). Returns null if the lease is
// not expired (or no longer exists), in which case nothing is written.
export function expireRun(tx: Tx, args: { run: string; outcome: Outcome; reason: ReasonClass; decidedAt?: string }): { run: string; state: RunState } | null {
  const lease = runLease(tx, args.run);
  if (!lease || !expired(lease, tx.at)) return null;
  const decidedAt = args.outcome === 'recovered' ? undefined : args.decidedAt;
  const ended = decidedAt !== undefined
    ? beginEnd(tx, { run: args.run, outcome: args.outcome, reason: args.reason, decidedAt })
    : beginEnd(tx, { run: args.run, outcome: 'recovered', reason: 'recovered', reasonText: 'lease_expired' });
  return { run: ended.run, state: ended.state };
}

// Unreleased run leases past their expiry, with their runs (D1 §8.1 step 1).
export function expiredRunLeases(db: Tx['db'], at: string): { run: string; project: string; state: RunState }[] {
  return db
    .prepare(
      `SELECT r."id" AS "run", r."project", r."state" FROM "leases" l JOIN "runs" r ON r."id" = l."resource_id"
       WHERE l."resource_kind" = 'run' AND l."released_at" IS NULL AND l."expires_at" <= ? ORDER BY r."created_at", r."id"`,
    )
    .all(at) as { run: string; project: string; state: RunState }[];
}

// Step 2's result for one domain: termination established, by the boundary's
// observation, or because the running engine knows it never spawned into it.
//
// When termination rests on the engine's knowledge that it never spawned into
// the domain (`observed` false), that knowledge is made durable here, in the
// same transaction: the domain's invocation is recorded `refused`, never
// launched. A later step of the run-end protocol, repeated after a failure,
// then reads it from the store and cannot charge an invocation that never ran
// (SEAM.md §24).
export function domainTerminated(tx: Tx, args: { domain: string; observed: boolean; evidence?: Record<string, unknown> | null; observedAt?: string }): void {
  const d = tx.db.prepare('SELECT * FROM "execution_domains" WHERE "id" = ?').get(args.domain) as
    | { id: string; run: string; project: string; status: DomainStatus; invocation: string; launch_state: string; exit_class: string | null; exit_evidence: string | null }
    | undefined;
  if (!d) throw notFound('domain', args.domain);
  if (d.status === 'terminated') return;
  assertEdge('DomainStatus', d.status, 'terminated', { domain: d.id });
  // D2 A.4: a domain is terminated only with its launch closed. On the real
  // boundary closure has its own transaction, before any signal; on the
  // scripted boundary of the kernel lane, where no launcher exists, it is
  // recorded here.
  closeLaunch(tx, { domain: d.id, cause: 'termination' });
  // `observed_at` is when emptiness was read, which a barrier may hold apart
  // from this record (SEAM.md §126).
  tx.db
    .prepare(`UPDATE "execution_domains" SET "status" = 'terminated', "terminated_at" = ?, "observation" = 'terminated', "observed_at" = ? WHERE "id" = ?`)
    .run(tx.at, args.observedAt ?? tx.at, d.id);
  tx.db.prepare('UPDATE "process_ownership" SET "termination_confirmed_at" = ? WHERE "domain" = ?').run(tx.at, d.id);
  const payload: Record<string, unknown> = { from: d.status, observed: args.observed };
  if (args.evidence) payload.evidence = args.evidence;
  if (d.exit_class) payload.exit_class = d.exit_class;
  if (d.exit_evidence) payload.exit_evidence = JSON.parse(d.exit_evidence) as unknown;
  tx.emit('domain.terminated', { project: d.project, domain: d.id, run: d.run }, payload);
  if (!args.observed) {
    const seen = statuses(tx, d.invocation);
    if (!seen.includes('launched') && !seen.some((s) => TERMINAL_OBSERVATIONS.includes(s))) observe(tx, mustRun(tx, d.run), d.invocation, 'refused');
  }
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
    assertEdge('DomainStatus', d.status, 'quarantined', { domain: id });
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
  raiseQuestion(tx, {
    project: run.project,
    kind: 'blocker',
    subjectType: 'run',
    subjectId: run.id,
    question:
      `Run ${run.id} cannot be ended: the execution boundary has not reported its domain${args.domains.length === 1 ? '' : 's'} ` +
      `${args.domains.join(', ')} terminated` +
      (args.processes.length > 0 ? ` (processes seen: ${args.processes.join(', ')})` : '') +
      '. It stays quarantined until termination is observed; nothing of it is reused or discarded meanwhile.',
  });
}

// Steps 5 to 7, one transaction: every invocation gets its terminal
// observation and, if it was launched, its one original ledger row; the
// workspace is disposed of; the grant revoked; every lease naming the run
// released; the run ended; the work item moved as its outcome requires.
// Idempotent: a run already ended is left as it is.
export function finishRun(
  tx: Tx,
  args: { run: string; invocations: Record<string, 'ended' | 'unknown' | 'refused'>; recovery: string | null; baseline?: Baseline | null },
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
    // On the real boundary a launch is authorized, and recorded `launched`,
    // in one transaction (SEAM.md §125): an invocation whose domain's launch
    // was never authorized never ran, however its domain's termination was
    // reached (directly, or through a quarantine and its clearance). It is
    // `refused`, and charged nothing.
    const neverAuthorized = tx.db
      .prepare(`SELECT 1 FROM "execution_domains" WHERE "invocation" = ? AND "cgroup_path" IS NOT NULL AND "launch_binding" IS NULL`)
      .get(receipt.id);
    if (terminal === undefined && neverAuthorized && !seen.includes('launched')) terminal = 'refused';
    if (terminal === undefined) terminal = seen.includes('launched') ? 'ended' : seen.includes('dispatch_started') ? 'unknown' : 'refused';
    if (seen.includes('launched') && terminal === 'refused') terminal = 'unknown';
    // How the backend ended, as the boundary established it (D2 §1.6, A.3).
    const exit = tx.db.prepare('SELECT "exit_class", "exit_evidence" FROM "execution_domains" WHERE "invocation" = ? ORDER BY "created_at" DESC LIMIT 1').get(receipt.id) as
      | { exit_class: string | null; exit_evidence: string | null }
      | undefined;
    observe(tx, run, receipt.id, terminal, terminal === 'refused' ? null : (exit ?? null));
    if (terminal !== 'refused') chargeInvocation(tx, run, receipt);
  }

  tx.db
    .prepare(`UPDATE "workspaces" SET "disposition" = 'retained' WHERE "run" = ? AND "disposition" IN ('active', 'quarantined')`)
    .run(run.id);
  // What the role left is the retained workspace's baseline from now on.
  if (args.baseline) rebaselineRunCheckout(tx, run.id, args.baseline);
  tx.db.prepare('UPDATE "capability_grants" SET "revoked_at" = ? WHERE "run" = ? AND "revoked_at" IS NULL').run(tx.at, run.id);
  tx.db.prepare('UPDATE "leases" SET "released_at" = ? WHERE "resource_id" = ? AND "released_at" IS NULL').run(tx.at, run.id);
  // The run's transcript, once it is a published record (SEAM.md §56). A
  // stream that was not published is never named.
  const transcript = tx.db
    .prepare(`SELECT "id" FROM "records" WHERE "run" = ? AND "kind" = 'transcript' AND "published" = 1 ORDER BY "created_at" DESC, "id" DESC LIMIT 1`)
    .get(run.id) as { id: string } | undefined;
  setRunState(tx, run, 'ended', { finished_at: tx.at, quarantined: 0, ...(transcript ? { transcript: transcript.id } : {}) });
  const payload: Record<string, unknown> = { outcome: run.outcome, reason_class: run.reason_class };
  if (args.recovery !== null) payload.recovery = { incarnation: args.recovery };
  tx.emit('run.ended', runSubject(run), payload);

  const blockers = tx.db.prepare(`SELECT * FROM "decisions" WHERE "subject_type" = 'run' AND "subject_id" = ? AND "status" = 'open'`).all(run.id) as DecisionRow[];
  for (const d of blockers) invalidateDecision(tx, d, 'the run has ended');

  workAfterRun(tx, run);
  return { ended: true };
}

// What a run's outcome does to its work item (D1 §4.3, §8.4; SEAM.md §§15,
// 16, 28–30, 40, 47). Only an item the run still owns is moved, and only by
// its latest run. What the journal still has in hand is the journal's: work
// whose integration is journaled and not yet settled is left integrating, and
// integrated work stays integrated after a recovery (SEAM.md §45).
function workAfterRun(tx: Tx, run: RunRow): void {
  const item = getWorkItem(tx, run.work_item);
  if (!item || !RUN_OWNING.includes(item.status)) return;
  const latest = tx.db.prepare('SELECT "id" FROM "runs" WHERE "work_item" = ? ORDER BY "seq" DESC LIMIT 1').get(item.id) as { id: string };
  if (latest.id !== run.id) return;
  const policy = projectPolicy(tx.db, run.project);
  const cause = { run: run.id, outcome: run.outcome };
  const integration = tx.db
    .prepare(
      `SELECT s."state" FROM "operations" o JOIN "git_journal_state" s ON s."operation" = o."id"
       WHERE json_extract(o."finalizer_inputs", '$.run') = ? AND json_extract(o."finalizer_inputs", '$.purpose') = 'integration' ORDER BY o."seq" DESC LIMIT 1`,
    )
    .get(run.id) as { state: string } | undefined;
  const integrationPending = integration !== undefined && integration.state !== 'failed';
  switch (run.outcome) {
    case 'completed':
      // A Verifier's or a Reviewer's work is complete with its accepted run.
      // A candidate's verification no longer completes the work it holds: a
      // stage's work completes with its stage gate, a fix's with its finding's
      // resolution (SEAM.md §§70, 74).
      if (item.status === 'executing' && !KIND_INTEGRATES.includes(item.kind)) transitionWork(tx, item, 'complete', {}, cause);
      return;
    case 'failed': {
      if ((item.status === 'integrating' && integrationPending) || item.status === 'integrated' || item.status === 'verifying') return;
      if (run.reason_class === 'integration_conflict') {
        const detail = run.reason_detail ? (JSON.parse(run.reason_detail) as { park?: string; worktree?: string }) : {};
        parkWork(tx, item, detail.park ?? 'integration_conflict', cause, {}, detail.worktree);
        return;
      }
      // The progress key over the snapshot tree of an attempt that failed
      // validation (D1 §4.3; SEAM.md §28). Findings join it in slice 5.
      let progress: { no_progress_count?: number; progress_key?: string | null } = {};
      if (run.reason_class === 'diff_violation' || run.reason_class === 'ref_violation') {
        const ws = tx.db.prepare('SELECT "snapshot_tree" FROM "workspaces" WHERE "run" = ?').get(run.id) as { snapshot_tree: string | null } | undefined;
        if (ws?.snapshot_tree) {
          const key = sha256(canonical({ tree: ws.snapshot_tree, findings: [] }));
          if (key === item.progress_key) {
            const count = item.no_progress_count + 1;
            if (count >= policy.no_progress_max!) {
              parkWork(tx, item, 'no_progress_max', cause, { no_progress_count: count });
              return;
            }
            progress = { no_progress_count: count };
          } else progress = { progress_key: key };
        }
      }
      if (item.repair_attempts >= policy.repair_attempts_max!) parkWork(tx, item, 'repair_attempts_max', cause, progress);
      else transitionWork(tx, item, 'eligible', { repair_due: 1, ...progress }, cause);
      return;
    }
    case 'refused': {
      const refusals = item.preflight_refusals + 1;
      if (refusals >= policy.preflight_refusals_max!) parkWork(tx, item, 'preflight_refusals_max', cause, { preflight_refusals: refusals });
      else transitionWork(tx, item, 'eligible', { preflight_refusals: refusals }, cause);
      return;
    }
    case 'timed_out':
      if ((item.status === 'integrating' && integrationPending) || item.status === 'integrated' || item.status === 'verifying') return;
      parkWork(tx, item, 'deadline', cause);
      return;
    case 'recovered':
      if (integrationPending && (item.status === 'integrating' || item.status === 'integrated')) return;
      if (item.status === 'verifying') return;
      transitionWork(tx, item, 'held', {}, cause);
      return;
    case 'stopped':
      if (item.status === 'verifying') return;
      // A budget stops the run at its enforceable boundary; the work parks
      // behind a blocker that names the limit (D1 §13.3; SEAM.md §55).
      if (run.reason_class === 'budget') {
        parkWork(tx, item, run.reason_text ?? 'budget', cause);
        return;
      }
      transitionWork(tx, item, 'held', {}, cause);
      return;
    case 'abandoned':
      if (item.status === 'verifying') return;
      transitionWork(tx, item, (item.prior_status ?? 'eligible') as WorkStatus, { dispatch_hold: 1 }, { ...cause, cause: 'abandon' });
      return;
    default:
      return;
  }
}

const KIND_INTEGRATES: readonly string[] = ['stage_build', 'fix', 'replan', 'assessment'];

// A limit was reached, or a person must act: the item parks with a visible
// blocker and an open `blocker` decision that holds it (D1 §4.3, §10.6;
// SEAM.md §§15, 30).
function parkWork(
  tx: Tx,
  item: WorkRow,
  reason: string,
  cause: Record<string, unknown>,
  extra: { preflight_refusals?: number; no_progress_count?: number; progress_key?: string | null } = {},
  worktree?: string,
): void {
  // The item parks with its blocker first; the decision is raised about the
  // parked item, as it stands, and the blocker names it.
  const blocker = JSON.stringify({ reason, raised_at: tx.at, decision: null, ...(worktree ? { worktree } : {}) });
  transitionWork(tx, item, 'parked', { blocker, ...extra }, { ...cause, reason });
  raiseQuestion(tx, { project: item.project, kind: 'blocker', subjectType: 'work_item', subjectId: item.id });
}

// ---- reads for the run-end protocol and recovery -----------------------------------

export interface EndFacts {
  run: RunRow;
  repo: string;
  lease: LeaseRow | null;
  domains: {
    id: string;
    status: DomainStatus;
    invocation: string;
    pid: number | null;
    pgid: number | null;
    pid_start_time: string | null;
    cgroup_path: string | null;
    cgroup_inode: number | null;
    launch_binding: string | null;
    incarnation: string;
  }[];
  receipts: { id: string; statuses: InvocationStatus[] }[];
  workspace: { id: string; path: string; disposition: string; base_revision: string; current_base: string; snapshot_tree: string | null; metadata_baseline: string | null } | null;
}

export function endFacts(tx: Tx, runId: string): EndFacts {
  const run = mustRun(tx, runId);
  const repo = (tx.db.prepare('SELECT "dev_repo_path" FROM "projects" WHERE "id" = ?').get(run.project) as { dev_repo_path: string }).dev_repo_path;
  const domains = tx.db
    .prepare(
      `SELECT d."id", d."status", d."invocation", o."pid", o."pgid", o."pid_start_time", d."cgroup_path", d."cgroup_inode", d."launch_binding", o."incarnation"
       FROM "execution_domains" d LEFT JOIN "process_ownership" o ON o."domain" = d."id" WHERE d."run" = ? ORDER BY d."id"`,
    )
    .all(runId) as EndFacts['domains'];
  const receipts = (tx.db.prepare('SELECT "id" FROM "invocation_receipts" WHERE "run" = ? ORDER BY "id"').all(runId) as { id: string }[]).map((r) => ({
    id: r.id,
    statuses: statuses(tx, r.id),
  }));
  const columns = '"id", "path", "disposition", "base_revision", "current_base", "snapshot_tree", "metadata_baseline"';
  const workspace = (run.workspace
    ? tx.db.prepare(`SELECT ${columns} FROM "workspaces" WHERE "id" = ?`).get(run.workspace)
    : tx.db.prepare(`SELECT ${columns} FROM "workspaces" WHERE "run" = ?`).get(runId)) as EndFacts['workspace'] | undefined;
  return { run, repo, lease: runLease(tx, runId) ?? null, domains, receipts, workspace: workspace ?? null };
}

// Runs that have not ended, oldest first.
export function unendedRuns(tx: Tx): RunRow[] {
  return tx.db.prepare(`SELECT * FROM "runs" WHERE "state" <> 'ended' ORDER BY "created_at", "id"`).all() as RunRow[];
}
