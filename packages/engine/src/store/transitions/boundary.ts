// The execution boundary's store side (D2 §§3.2 to 3.5, K1, K5, A.3, A.4):
// a domain's launch state, changed only here; its placement; the launch
// authorization, granted in one transaction only to a binding that is
// current; closure; what an observation found; and the re-grant of a run
// lease after a pause, on a fresh challenge. The main thread does the
// cgroup work and the talking to the launcher and the init between these
// transitions; none of them waits on a process.

import { illegal, notFound } from './common.js';
import { assertEdge } from './lifecycle.js';
import { engineSettings } from './settings.js';
import type { Tx } from './tx.js';

type Db = Tx['db'];

export interface DomainRow {
  id: string;
  project: string;
  run: string;
  invocation: string;
  status: 'allocated' | 'launched' | 'terminated' | 'quarantined';
  profile: string;
  cgroup_path: string | null;
  cgroup_inode: number | null;
  placed_at: string | null;
  launch_state: 'authorizable' | 'authorized' | 'closed';
  launch_binding: string | null;
  launch_authorized_at: string | null;
  launch_closed_at: string | null;
  observation: string | null;
  observed_at: string | null;
  terminated_at: string | null;
  exit_class: string | null;
  exit_evidence: string | null;
}

export const getDomain = (db: Db, id: string): DomainRow | undefined => db.prepare('SELECT * FROM "execution_domains" WHERE "id" = ?').get(id) as DomainRow | undefined;

function mustDomain(tx: Tx, id: string): DomainRow {
  const d = getDomain(tx.db, id);
  if (!d) throw notFound('domain', id);
  return d;
}

const domainSubject = (d: DomainRow) => ({ project: d.project, domain: d.id, run: d.run });

// May the engine create the domain's cgroup directory now (D2 §3.2: only
// while the launch is not closed)? The main thread creates it at once after
// this read, before anything that could close and then remove it runs.
export function domainMayCreate(db: Db, args: { domain: string }): { cgroup_path: string | null; may: boolean } {
  const d = getDomain(db, args.domain);
  if (!d) return { cgroup_path: null, may: false };
  return { cgroup_path: d.cgroup_path, may: d.cgroup_path !== null && d.launch_state !== 'closed' && d.status !== 'terminated' };
}

// The directory exists: its inode names this one creation of it.
export function cgroupCreated(tx: Tx, args: { domain: string; inode: number }): void {
  const d = mustDomain(tx, args.domain);
  if (d.cgroup_inode !== null) return;
  tx.db.prepare('UPDATE "execution_domains" SET "cgroup_inode" = ? WHERE "id" = ?').run(args.inode, d.id);
}

// The launcher has written its pid into the domain's cgroup and confirmed it
// (D2 §3.2). Recorded whatever the launch state: a placed launcher is a
// member, and termination will establish its end.
export function recordPlacement(tx: Tx, args: { domain: string; pid: number }): void {
  const d = mustDomain(tx, args.domain);
  if (d.placed_at !== null) return;
  tx.db.prepare('UPDATE "execution_domains" SET "placed_at" = ? WHERE "id" = ?').run(tx.at, d.id);
  tx.emit('domain.placed', domainSubject(d), { pid: args.pid, cgroup_path: d.cgroup_path, launch_state: d.launch_state });
}

export interface LaunchBinding {
  invocation: string;
  incarnation: string;
  lease_generation: number;
}

// The launch authorization (D2 §3.2, K1): granted, in this one transaction,
// only if the domain, the invocation, the incarnation and the lease
// generation the launcher presents are all current, the lease is neither
// expired nor closing, the run is not ending, and the launch state is
// `authorizable`. A grant makes the domain `launched` and completes its
// ownership with the launcher's process and the cgroup as containment.
export function authorizeLaunch(
  tx: Tx,
  args: { domain: string; invocation: string; incarnation: string; generation: number; pid: number; startTime: string | null },
): { granted: boolean; reason: string | null } {
  const d = mustDomain(tx, args.domain);
  const refuse = (reason: string) => ({ granted: false, reason });
  if (d.launch_state !== 'authorizable') return refuse(`the launch is ${d.launch_state}`);
  if (d.status !== 'allocated') return refuse(`the domain is ${d.status}`);
  if (d.invocation !== args.invocation) return refuse('the invocation is not the domain\'s');
  const owner = tx.db.prepare('SELECT "incarnation" FROM "process_ownership" WHERE "domain" = ?').get(d.id) as { incarnation: string } | undefined;
  if (!owner || owner.incarnation !== args.incarnation) return refuse('the incarnation is not the one that owns the domain');
  const lease = tx.db
    .prepare(`SELECT * FROM "leases" WHERE "resource_kind" = 'run' AND "resource_id" = ? AND "released_at" IS NULL`)
    .get(d.run) as { generation: number; closing: number; expires_at: string; owner_incarnation: string } | undefined;
  if (!lease) return refuse('the run has no lease');
  if (lease.closing === 1) return refuse('the run is ending');
  if (lease.expires_at <= tx.at) return refuse('the run lease has expired');
  if (lease.generation !== args.generation) return refuse('the lease generation is not current');
  if (lease.owner_incarnation !== args.incarnation) return refuse('the lease is held by another incarnation');
  const run = tx.db.prepare('SELECT "state" FROM "runs" WHERE "id" = ?').get(d.run) as { state: string };
  if (run.state !== 'claimed') return refuse(`the run is ${run.state}`);

  const binding: LaunchBinding = { invocation: args.invocation, incarnation: args.incarnation, lease_generation: args.generation };
  assertEdge('LaunchState', d.launch_state, 'authorized', { domain: d.id });
  assertEdge('DomainStatus', d.status, 'launched', { domain: d.id });
  tx.db
    .prepare(`UPDATE "execution_domains" SET "launch_state" = 'authorized', "launch_binding" = ?, "launch_authorized_at" = ?, "status" = 'launched' WHERE "id" = ?`)
    .run(JSON.stringify(binding), tx.at, d.id);
  tx.db
    .prepare('UPDATE "process_ownership" SET "pid" = ?, "pgid" = ?, "pid_start_time" = ?, "containment_id" = ? WHERE "domain" = ?')
    .run(args.pid, args.pid, args.startTime, d.cgroup_path, d.id);
  tx.emit('domain.launch_authorized', domainSubject(d), { launch_binding: binding, cgroup_path: d.cgroup_path, pid: args.pid });
  return { granted: true, reason: null };
}

// Closure (D2 §3.2 step 1): from here no grant is possible. Idempotent; true
// when this call closed it.
export function closeLaunch(tx: Tx, args: { domain: string; cause?: string }): boolean {
  const d = mustDomain(tx, args.domain);
  if (d.launch_state === 'closed') return false;
  assertEdge('LaunchState', d.launch_state, 'closed', { domain: d.id });
  tx.db.prepare(`UPDATE "execution_domains" SET "launch_state" = 'closed', "launch_closed_at" = ? WHERE "id" = ?`).run(tx.at, d.id);
  tx.emit('domain.launch_closed', domainSubject(d), { from: d.launch_state, cause: args.cause ?? null });
  return true;
}

// What an observation of the domain found, when it did not establish
// termination: `running`, or `unknown` with why (D2 §3.4).
export function recordObservation(tx: Tx, args: { domain: string; observation: 'running' | 'unknown'; detail?: string | null }): void {
  const d = mustDomain(tx, args.domain);
  if (d.status === 'terminated') return;
  tx.db.prepare('UPDATE "execution_domains" SET "observation" = ?, "observed_at" = ? WHERE "id" = ?').run(args.observation, tx.at, d.id);
}

// How the domain's backend ended (D2 §1.6), kept with the domain until the
// run's end copies it onto the invocation's terminal observation.
export function recordExit(tx: Tx, args: { domain: string; exit_class: string; exit_evidence: Record<string, unknown> }): void {
  const d = mustDomain(tx, args.domain);
  tx.db.prepare('UPDATE "execution_domains" SET "exit_class" = ?, "exit_evidence" = ? WHERE "id" = ?').run(args.exit_class, JSON.stringify(args.exit_evidence), d.id);
}

// The domains a restart must account for (D2 §3.3): every one not terminated
// whose cgroup was recorded, with the incarnation that owned it.
export function boundaryDomains(db: Db): (DomainRow & { incarnation: string })[] {
  return db
    .prepare(
      `SELECT d.*, o."incarnation" FROM "execution_domains" d JOIN "process_ownership" o ON o."domain" = d."id"
       WHERE d."status" <> 'terminated' AND d."cgroup_path" IS NOT NULL ORDER BY d."created_at", d."id"`,
    )
    .all() as (DomainRow & { incarnation: string })[];
}

// The scopes the store records for this home's earlier incarnations.
export function priorScopes(db: Db, args: { incarnation: string }): { incarnation: string; scope_cgroup: string }[] {
  return db
    .prepare(`SELECT "id" AS "incarnation", "scope_cgroup" FROM "engine_incarnations" WHERE "id" <> ? AND "scope_cgroup" IS NOT NULL ORDER BY "created_at", "id"`)
    .all(args.incarnation) as { incarnation: string; scope_cgroup: string }[];
}

// ---- the re-grant after a pause (D2 §3.5, K5) ---------------------------------------------------

// Is the run's lease, past its expiry, a candidate for a re-grant (everything
// but the challenge, which the main thread makes)? The current domain is
// launched with an authorization binding this incarnation and the current
// lease generation, and the run is not ending.
export function regrantFacts(
  db: Db,
  args: { run: string; incarnation: string },
): { eligible: boolean; reason: string | null; generation: number | null; domain: string | null; invocation: string | null; deadline_at: string | null } {
  const lease = db
    .prepare(`SELECT * FROM "leases" WHERE "resource_kind" = 'run' AND "resource_id" = ? AND "released_at" IS NULL`)
    .get(args.run) as { generation: number; closing: number; owner_incarnation: string } | undefined;
  const run = db.prepare('SELECT "state", "deadline_at" FROM "runs" WHERE "id" = ?').get(args.run) as { state: string; deadline_at: string } | undefined;
  const none = (reason: string) => ({ eligible: false, reason, generation: lease?.generation ?? null, domain: null, invocation: null, deadline_at: run?.deadline_at ?? null });
  if (!lease || !run) return none('the run has no lease');
  if (lease.closing === 1 || run.state === 'finalizing' || run.state === 'ended') return none('the run is ending');
  if (lease.owner_incarnation !== args.incarnation) return none('the lease is another incarnation\'s');
  const d = db
    .prepare(`SELECT d.* FROM "execution_domains" d WHERE d."run" = ? AND d."status" = 'launched' ORDER BY d."created_at" DESC, d."id" DESC LIMIT 1`)
    .get(args.run) as DomainRow | undefined;
  if (!d || d.launch_state !== 'authorized' || d.launch_binding === null) return none('the run has no authorized domain');
  const binding = JSON.parse(d.launch_binding) as LaunchBinding;
  if (binding.incarnation !== args.incarnation || binding.lease_generation !== lease.generation) return none('the launch authorization names another incarnation or generation');
  const owner = db.prepare('SELECT "incarnation" FROM "process_ownership" WHERE "domain" = ?').get(d.id) as { incarnation: string } | undefined;
  if (owner?.incarnation !== args.incarnation) return none('the domain is owned by another incarnation');
  return { eligible: true, reason: null, generation: lease.generation, domain: d.id, invocation: d.invocation, deadline_at: run.deadline_at };
}

// The re-grant itself: the same generation, so fencing is unchanged; a new
// expiry; the deadline, the budget and every ending decision untouched. The
// event carries the evidence of the fresh challenge (D2 §3.5).
export function regrantLease(tx: Tx, args: { run: string; generation: number; incarnation: string; challenge: Record<string, unknown> }): string | null {
  const facts = regrantFacts(tx.db, { run: args.run, incarnation: args.incarnation });
  if (!facts.eligible || facts.generation !== args.generation) return null;
  const lease = tx.db.prepare(`SELECT * FROM "leases" WHERE "resource_kind" = 'run' AND "resource_id" = ? AND "released_at" IS NULL`).get(args.run) as {
    id: string;
    expires_at: string;
  };
  const expires = new Date(Date.parse(tx.at) + engineSettings().lease_ttl * 1000).toISOString();
  tx.db.prepare('UPDATE "leases" SET "renewed_at" = ?, "expires_at" = ? WHERE "id" = ?').run(tx.at, expires, lease.id);
  const run = tx.db.prepare('SELECT "project", "work_item" FROM "runs" WHERE "id" = ?').get(args.run) as { project: string; work_item: string };
  tx.emit(
    'run.lease_regranted',
    { project: run.project, run: args.run, work_item: run.work_item },
    { generation: args.generation, expired_at: lease.expires_at, expires_at: expires, deadline_at: facts.deadline_at, challenge: args.challenge },
  );
  return tx.at;
}

export function assertLaunchClosed(d: DomainRow): void {
  if (d.launch_state !== 'closed') throw illegal('Terminating a domain whose launch is not closed', { domain: d.id, launch_state: d.launch_state });
}
