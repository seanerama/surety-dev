// The environment beside its operations, the store's half (D4 §§6.1 to 6.3;
// J6; AR N01, N02; E120 item 2; E121 CD2; SEAM.md §§290 to 294): the
// expected-state revision, the observation job and its history, the
// out-of-band changes any adapter read finds, the decision about each, and
// the log collection. Each function is one transition in the caller's
// transaction, or a read; the main thread (deploy/observe.ts,
// deploy/release-operator.ts) makes every adapter call between them.

import type { IdentityRead, Instance, InventoryEntry, TargetExpectation, TargetInventory, TargetStatus } from '../../deploy/adapter.js';
import { type Change, type ExpectedService, changesFromIdentity, changesFromInventory, judgeCondition, sameChange } from '../../deploy/environment.js';
import { unaccountedUnits } from '../../deploy/reconcile.js';
import { notFound, parseJson } from './common.js';
import { type DecisionRow, invalidateDecision, raiseDecision } from './decisions.js';
import { attemptSupervision, environmentByName, expectationOf, getEnv, recordedCgroups, recordedUnits, requestTeardown, unitName } from './deploy.js';
import { projectPolicy } from './settings.js';
import type { CommandResult } from './control.js';
import type { Tx } from './tx.js';

type Db = Tx['db'];

const addSeconds = (iso: string, seconds: number) => new Date(Date.parse(iso) + seconds * 1000).toISOString();
const json = <T>(text: string | null | undefined): T | null => parseJson<T>(text ?? null);

// ---- the expected-state revision (D4 §6.2; AR N01) -----------------------------------------------

// Every change the engine makes to what the environment is expected to run
// moves it; an observation read before the change is not installed after it.
export function bumpRevision(tx: Tx, environment: string): void {
  tx.db.prepare('UPDATE "environments" SET "expected_revision" = "expected_revision" + 1 WHERE "id" = ?').run(environment);
}

// ---- what the environment is expected to run --------------------------------------------------

interface AttemptLike {
  id: string;
  operation: string;
  incarnation: string | null;
  init_instance: string | null;
  app_instance: string | null;
  deployment_generation: number | null;
  [key: string]: unknown;
}

// The current generation's service as the engine recorded it, if the
// environment's record says it runs (`running`, written at the finalizer and
// cleared by a teardown or a read that found nothing running).
// `anyGeneration`: what the record says runs even when a later attempt (an
// operation in flight) made another generation current: read, so that its
// application is not unread, but never expected.
export function expectedService(db: Db, environment: string, anyGeneration = false): { expected: ExpectedService; attempt: AttemptLike; frozen: Record<string, unknown> } | null {
  const env = getEnv(db, environment);
  if (!env || env.prefix === null || env.current_generation === null) return null;
  const rec = db.prepare('SELECT "running" FROM "environment_records" WHERE "environment" = ?').get(environment) as { running: string | null } | undefined;
  const running = json<{ generation?: number }>(rec?.running);
  if (!running || typeof running.generation !== 'number' || (!anyGeneration && running.generation !== env.current_generation)) return null;
  const generation = running.generation;
  const a = db
    .prepare(
      `SELECT a.*, o."finalizer_inputs" AS "frozen_text" FROM "operation_attempts" a JOIN "operations" o ON o."id" = a."operation"
       WHERE o."kind" = 'deploy' AND json_extract(o."target", '$.environment') = ? AND a."deployment_generation" = ? ORDER BY a."created_at" DESC LIMIT 1`,
    )
    .get(environment, generation) as (AttemptLike & { frozen_text: string }) | undefined;
  if (!a) return null;
  const frozen = JSON.parse(a.frozen_text) as { artifact_digest?: string | null; target_set?: string[] };
  const app = json<Instance>(a.app_instance);
  const d = db.prepare(`SELECT "invocation_id", "app_exit" FROM "execution_domains" WHERE "attempt" = ? AND "profile" = 'service'`).get(a.id) as
    | { invocation_id: string | null; app_exit: string | null }
    | undefined;
  const exit = json<{ status?: { code?: number | null; signal?: number | null }; external_term?: boolean }>(d?.app_exit);
  const naturalExit = exit !== null && typeof exit.status?.code === 'number' && (exit.status.signal ?? null) === null && exit.external_term !== true;
  return {
    attempt: a,
    frozen,
    expected: {
      target: frozen.target_set?.[0] ?? 'app',
      unit: unitName(env.prefix, generation),
      generation,
      invocation: d?.invocation_id ?? null,
      instance: app ? { pid: app.pid, start_time: app.start_time } : null,
      digest: frozen.artifact_digest ?? null,
      naturalExit,
    },
  };
}

// The units of every operation of the environment in flight (its
// orchestration not ended, or a round of it open): its latest attempt's
// frozen next, prior and cleanup, and a teardown's resources. Their states
// between prior and next are the engine's own, never out of band (D4 §4.5).
export function permittedUnits(db: Db, environment: string): string[] {
  const rows = db
    .prepare(
      `SELECT i."create_units", i."prior", i."cleanup", i."resources" FROM "operations" o
       JOIN "operation_attempts" a ON a."operation" = o."id"
       JOIN "attempt_intents" i ON i."attempt" = a."id"
       WHERE json_extract(o."target", '$.environment') = ? AND o."kind" IN ('deploy', 'teardown')
         AND (o."orchestration_stage" IS NULL OR o."orchestration_stage" <> 'ended'
              OR EXISTS (SELECT 1 FROM "verification_rounds" r WHERE r."operation" = o."id" AND r."status" = 'open'))
         AND a."attempt_number" = (SELECT MAX(b."attempt_number") FROM "operation_attempts" b WHERE b."operation" = o."id")`,
    )
    .all(environment) as { create_units: string; prior: string; cleanup: string; resources: string | null }[];
  const out = new Set<string>();
  for (const r of rows) {
    for (const u of json<string[]>(r.create_units) ?? []) out.add(u);
    for (const p of json<{ unit: string }[]>(r.prior) ?? []) if (typeof p?.unit === 'string') out.add(p.unit);
    for (const c of json<{ resource: string }[]>(r.cleanup) ?? []) if (typeof c?.resource === 'string') out.add(c.resource);
    for (const u of json<string[]>(r.resources) ?? []) out.add(u);
  }
  return [...out];
}

// ---- out-of-band changes (D4 §6.3; J6; SEAM.md §293) ---------------------------------------------

export interface EnvChangeRow {
  id: string;
  project: string;
  environment: string;
  resource: string;
  change: string;
  expected: string;
  found: string | null;
  detected_at: string;
  disposition: string | null;
  decision: string;
  closed_at: string | null;
  observation: string | null;
  acknowledged: string | null;
  closed_by: string | null;
}

export const ENV_OOB_OPTIONS = [
  {
    key: 'teardown',
    label: 'Tear down',
    consequence: 'An ordinary teardown of the environment is requested; it waits for the environment lease and stops only what the engine positively owns.',
    effect: { disposition: 'teardown' },
  },
  {
    key: 'acknowledge',
    label: 'Acknowledge',
    consequence:
      'Records the change and leaves it in place. The environment stays degraded until an engine operation replaces what runs; nothing is adopted, and verification is not made to pass.',
    effect: { disposition: 'acknowledge' },
  },
];

const changeRows = (db: Db, environment: string): EnvChangeRow[] =>
  db.prepare(`SELECT * FROM "out_of_band_changes" WHERE "subject_kind" = 'environment' AND "environment" = ? ORDER BY "detected_at", "id"`).all(environment) as EnvChangeRow[];

// Not settled: open, or acknowledged and not yet replaced.
export const unresolvedChanges = (db: Db, environment: string): EnvChangeRow[] => changeRows(db, environment).filter((r) => r.closed_at === null && (r.disposition === null || r.disposition === 'acknowledge'));
// Open: no disposition and not closed (what fails a precondition, §6.3).
export const openChanges = (db: Db, environment: string): EnvChangeRow[] => changeRows(db, environment).filter((r) => r.closed_at === null && r.disposition === null);

// What an environment change's decision binds (D4 §6.3): the resource it
// names with what was found, and the observation it rests on.
export function envChangeManifest(row: EnvChangeRow): Record<string, unknown> {
  return {
    subject_kind: 'environment',
    expected: row.expected,
    found: row.found,
    resources: [{ resource: row.resource, change: row.change, found: json(row.found) }],
    observation: row.observation,
  };
}

const QUESTION: Record<string, string> = {
  stopped: 'is not running, and no operation of the engine stopped it',
  restarted: 'runs under another invocation than the one the engine launched; its launcher is refused, so nothing of the application runs again',
  unexpected_unit: 'carries the environment\'s prefix, and the engine cannot account for its ownership; it is never adopted and never stopped by the engine',
  identity_differs: 'was read with an identity other than the sealed one',
};

function closeChange(tx: Tx, row: EnvChangeRow, by: string, why: string): void {
  tx.db.prepare('UPDATE "out_of_band_changes" SET "closed_at" = ?, "closed_by" = ? WHERE "id" = ? AND "closed_at" IS NULL').run(tx.at, by, row.id);
  const d = tx.db.prepare('SELECT * FROM "decisions" WHERE "id" = ?').get(row.decision) as DecisionRow | undefined;
  if (d && d.status === 'open') invalidateDecision(tx, d, why);
}

// Record the changes a read found, once each: the same change found again
// adds nothing; an open row whose subject changed again is closed and its
// decision invalidated, and the change found now recorded (SEAM.md §293).
export function recordChanges(tx: Tx, args: { environment: string; changes: Change[]; observation: string | null }): string[] {
  if (args.changes.length === 0) return [];
  const env = getEnv(tx.db, args.environment);
  if (!env) return [];
  const made: string[] = [];
  for (const c of args.changes) {
    const rows = unresolvedChanges(tx.db, env.id).filter((r) => r.resource === c.resource && r.change === c.change);
    if (rows.some((r) => sameChange({ change: r.change, resource: r.resource, found: json<Record<string, unknown>>(r.found) }, c))) continue;
    for (const r of rows) if (r.disposition === null) closeChange(tx, r, args.observation ?? 'read', 'the subject changed again');
    const id = tx.newId('oob_');
    const row: EnvChangeRow = {
      id,
      project: env.project,
      environment: env.id,
      resource: c.resource,
      change: c.change,
      expected: JSON.stringify(c.expected),
      found: JSON.stringify(c.found),
      detected_at: tx.at,
      disposition: null,
      decision: '',
      closed_at: null,
      observation: args.observation,
      acknowledged: null,
      closed_by: null,
    };
    const decision = raiseDecision(tx, {
      project: env.project,
      kind: 'out_of_band_change',
      subjectType: 'out_of_band_change',
      subjectId: id,
      question: `Out of band in environment ${env.name}: ${c.resource} ${QUESTION[c.change] ?? 'changed'}. Tear the environment down, or acknowledge the change.`,
      options: ENV_OOB_OPTIONS,
      manifest: envChangeManifest(row),
    });
    tx.db
      .prepare(
        `INSERT INTO "out_of_band_changes" ("id", "created_at", "project", "subject_kind", "ref", "checkout", "expected", "found", "detected_at", "decision", "environment", "resource", "change", "observation")
         VALUES (?, ?, ?, 'environment', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, tx.at, env.project, row.expected, row.found, tx.at, decision.id, env.id, c.resource, c.change, args.observation);
    tx.emit('environment.out_of_band', { project: env.project, environment: env.id, out_of_band_change: id }, { change: c.change, resource: c.resource, expected: c.expected, found: c.found, decision: decision.id, observation: args.observation });
    made.push(id);
  }
  if (made.length > 0) staleCompletion(tx, env.project);
  return made;
}

// `alpha_complete` reads the environment's open changes (J6): its
// evaluations are stale when one is recorded or settled.
function staleCompletion(tx: Tx, project: string): void {
  tx.db.prepare(`UPDATE "gate_evaluations" SET "stale" = 1 WHERE "project" = ? AND "gate_kind" = 'alpha_complete' AND "stale" = 0`).run(project);
}

// What an inventory read (a status or reconcile read, by an operation or
// the observation job) shows of the environment beside the operation's own
// outcome; and an unexpected unit the read no longer finds closes its open
// row, kept (the driver's ruling, answer 12).
export function recordInventoryRead(
  tx: Tx,
  args: { environment: string; inventory: InventoryEntry[]; complete: boolean; targets?: TargetStatus[] | undefined; observation: string | null },
): string[] {
  const env = getEnv(tx.db, args.environment);
  if (!env || env.prefix === null) return [];
  const exp = expectedService(tx.db, env.id);
  const changes = changesFromInventory({
    inventory: args.inventory,
    complete: args.complete,
    ...(args.targets ? { targets: args.targets } : {}),
    expected: exp?.expected ?? null,
    permitted: permittedUnits(tx.db, env.id),
    recorded: recordedUnits(tx.db, env.id),
    cgroups: recordedCgroups(tx.db, env.id),
  });
  if (args.complete) {
    const listed = new Set(args.inventory.filter((e) => e && e.kind === 'unit').map((e) => e.resource));
    for (const r of openChanges(tx.db, env.id)) {
      if (r.change === 'unexpected_unit' && !listed.has(r.resource)) closeChange(tx, r, args.observation ?? 'read', 'the unit is gone');
    }
  }
  return recordChanges(tx, { environment: env.id, changes, observation: args.observation });
}

// What identity reads (a round's, or the observation job's) show.
export function recordIdentityReads(tx: Tx, args: { environment: string; reads: IdentityRead[]; observation: string | null }): string[] {
  const exp = expectedService(tx.db, args.environment);
  const changes = changesFromIdentity({ reads: args.reads, expected: exp?.expected ?? null, permitted: permittedUnits(tx.db, args.environment) });
  return recordChanges(tx, { environment: args.environment, changes, observation: args.observation });
}

// A recorded reconcile read (deploy.ts's summary of it) as an inventory.
export function inventoryOfRead(read: unknown): { complete: boolean; inventory: InventoryEntry[] } | null {
  const r = read as { complete?: unknown; inventory?: unknown } | null;
  if (!r || !Array.isArray(r.inventory)) return null;
  const inventory = (r.inventory as Record<string, unknown>[])
    .filter((e) => e && typeof e.resource === 'string' && typeof e.kind === 'string')
    .map(
      (e): InventoryEntry => ({
        resource: e.resource as string,
        kind: e.kind as InventoryEntry['kind'],
        recorded: false,
        state: (e.state as string | null) ?? 'unread',
        pendingJob: (e.pending_job as boolean | 'unread' | null) ?? 'unread',
        generation: (e.generation as number | 'unread' | null) ?? null,
        invocation_id: (e.invocation as string | null) ?? null,
        cgroup: (e.cgroup as string | null) ?? null,
      }),
    );
  return { complete: r.complete === true, inventory };
}

// An engine operation replaced what runs (a later generation applied, or a
// teardown applied): every change not yet settled is resolved (D4 §6.3).
export function resolveOnReplacement(tx: Tx, args: { environment: string; operation: string }): void {
  for (const r of unresolvedChanges(tx.db, args.environment)) closeChange(tx, r, args.operation, 'an engine operation replaced what runs');
}

// The changes a verification round's interval holds (D4 §5.3 item 6; the
// driver's ruling): every row detected from its first read to its decision,
// and every row open at its first read; never an acknowledged one.
export function changesInInterval(db: Db, args: { environment: string; from: string; to: string }): string[] {
  return changeRows(db, args.environment)
    .filter((r) => r.disposition !== 'acknowledge')
    .filter((r) => (r.detected_at >= args.from && r.detected_at <= args.to) || (r.detected_at < args.from && (r.closed_at === null || r.closed_at >= args.from)))
    .map((r) => r.id);
}

// The decision's answer (D4 §6.3): `teardown` requests an ordinary
// teardown, which waits for the lease (the driver's ruling, answer 5);
// `acknowledge` records the change and leaves a marker unresolved until a
// replacement. Neither adopts anything.
export function answerEnvironmentChange(tx: Tx, row: EnvChangeRow, option: string): CommandResult['effects'] {
  if (option === 'acknowledge') {
    const ack = { at: tx.at, actor: tx.actor.actor_id ?? tx.actor.actor_kind, unresolved_until_replacement: true };
    tx.db.prepare(`UPDATE "out_of_band_changes" SET "disposition" = 'acknowledge', "acknowledged" = ? WHERE "id" = ?`).run(JSON.stringify(ack), row.id);
  } else {
    tx.db.prepare(`UPDATE "out_of_band_changes" SET "disposition" = 'teardown' WHERE "id" = ?`).run(row.id);
    const env = getEnv(tx.db, row.environment)!;
    requestTeardown(tx, { project: env.project, environment: env.name });
  }
  staleCompletion(tx, row.project);
  return [{ kind: 'tick' }];
}

export const changeRow = (db: Db, id: string): EnvChangeRow | undefined => db.prepare('SELECT * FROM "out_of_band_changes" WHERE "id" = ?').get(id) as EnvChangeRow | undefined;

// ---- the observation job (D4 §6.2; SEAM.md §291) ------------------------------------------------

export function ensureObservationJob(tx: Tx, args: { environment: string; project: string }): void {
  if (tx.db.prepare('SELECT 1 FROM "observation_jobs" WHERE "environment" = ?').get(args.environment)) return;
  const cadence = projectPolicy(tx.db, args.project).observation_cadence!;
  tx.db
    .prepare(`INSERT INTO "observation_jobs" ("id", "created_at", "project", "environment", "cadence_s", "next_due") VALUES (?, ?, ?, ?, ?, ?)`)
    .run(tx.newId('obsj_'), tx.at, args.project, args.environment, cadence, addSeconds(tx.at, cadence));
}

interface JobRow {
  id: string;
  created_at: string;
  project: string;
  environment: string;
  cadence_s: number;
  next_due: string;
  last_success_at: string | null;
  last_attempt_at: string | null;
  error_class: string | null;
}

// The jobs to act on now: due, or past the freshness bound with no
// observation since (once per lapse).
export function observationsDue(db: Db, args: { now: string }): { environment: string; project: string; due: boolean; missed: boolean }[] {
  const jobs = db.prepare('SELECT * FROM "observation_jobs" ORDER BY "next_due", "id"').all() as JobRow[];
  const out: { environment: string; project: string; due: boolean; missed: boolean }[] = [];
  const now = Date.parse(args.now);
  for (const j of jobs) {
    const bound = projectPolicy(db, j.project).observation_freshness_bound! * 1000;
    const due = Date.parse(j.next_due) <= now;
    const since = Date.parse(j.last_success_at ?? j.created_at);
    const missed = j.error_class !== 'freshness_bound' && Number.isFinite(since) && now - since > bound;
    if (due || missed) out.push({ environment: j.environment, project: j.project, due, missed });
  }
  return out;
}

const historyCount = (db: Db, environment: string): number => (db.prepare('SELECT COUNT(*) AS n FROM "observation_history" WHERE "environment" = ?').get(environment) as { n: number }).n;

// The newest identity read of the environment, whoever's observation made it.
function newestIdentity(db: Db, environment: string): { at: string; match: string; observation: string; generation: number | null } | null {
  const row = db
    .prepare(
      `SELECT "id", "facts", "deployment_generation" FROM "observation_history"
       WHERE "environment" = ? AND json_extract("facts", '$.identity.observation') = "id" ORDER BY "observed_at" DESC, rowid DESC LIMIT 1`,
    )
    .get(environment) as { id: string; facts: string; deployment_generation: number | null } | undefined;
  if (!row) return null;
  const f = json<{ identity?: { at: string; match: string; observation: string } }>(row.facts);
  return f?.identity ? { ...f.identity, generation: row.deployment_generation } : null;
}

// What one observation will read (main thread): the environment's
// expectation, the revision and generation it compares against, and
// whether this is an identity observation (k a multiple of
// identity_observation_every, with an expected instance).
export function observationPlan(db: Db, args: { environment: string }) {
  const env = getEnv(db, args.environment);
  if (!env || env.prefix === null) return null;
  const exp = expectedService(db, env.id);
  // What runs, read even when not expected now (an operation in flight).
  const read = exp ?? expectedService(db, env.id, true);
  const every = projectPolicy(db, env.project).identity_observation_every!;
  const k = historyCount(db, env.id) + 1;
  let expect: TargetExpectation[] = [];
  if (read) {
    const frozen = read.frozen as unknown as Parameters<typeof expectationOf>[2];
    expect = (frozen.target_set ?? [read.expected.target]).map((t) => expectationOf(db, read.attempt as unknown as Parameters<typeof expectationOf>[1], frozen, t, read.expected.unit, read.expected.generation));
  }
  return {
    project: env.project,
    environment: env.id,
    prefix: env.prefix,
    adapter: env.adapter,
    expected_revision: (env as { expected_revision?: number }).expected_revision ?? 0,
    generation: env.current_generation,
    expect,
    identity: exp !== null && exp.expected.instance !== null && k % every === 0,
  };
}

function writeObserved(tx: Tx, env: { id: string; project: string }, observed: Record<string, unknown>): void {
  const text = JSON.stringify(observed);
  const row = tx.db.prepare('SELECT "id" FROM "environment_records" WHERE "environment" = ?').get(env.id) as { id: string } | undefined;
  if (row) tx.db.prepare('UPDATE "environment_records" SET "observed" = ? WHERE "id" = ?').run(text, row.id);
  else tx.db.prepare('INSERT INTO "environment_records" ("id", "created_at", "project", "environment", "observed") VALUES (?, ?, ?, ?, ?)').run(tx.newId('envr_'), tx.at, env.project, env.id, text);
}

function insertHistory(
  tx: Tx,
  env: { id: string; project: string },
  h: { id: string; condition: string; detail: unknown; read_interval: { from: string; to: string }; expected_revision: number; deployment_generation: number | null; facts: unknown; installed: boolean; stale_reason?: string | null },
): Record<string, unknown> {
  tx.db
    .prepare(
      `INSERT INTO "observation_history" ("id", "created_at", "project", "environment", "observed_at", "source", "condition", "detail", "read_interval", "expected_revision", "deployment_generation", "facts", "installed", "stale_reason")
       VALUES (?, ?, ?, ?, ?, 'observation_job', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      h.id,
      tx.at,
      env.project,
      env.id,
      tx.at,
      h.condition,
      h.detail === null ? null : JSON.stringify(h.detail),
      JSON.stringify(h.read_interval),
      h.expected_revision,
      h.deployment_generation,
      JSON.stringify(h.facts),
      h.installed ? 1 : 0,
      h.stale_reason ?? null,
    );
  return {
    id: h.id,
    environment: env.id,
    condition: h.condition,
    detail: h.detail,
    observed_at: tx.at,
    source: 'observation_job',
    read_interval: h.read_interval,
    expected_revision: h.expected_revision,
    deployment_generation: h.deployment_generation,
    facts: h.facts,
  };
}

const ACTIVE = new Set(['active', 'activating', 'reloading']);

// One observation, recorded (D4 §6.2): appended to history; installed as the
// environment's current observation unless a change the engine made since
// its first read left it stale (kept as history, retried); a failed read is
// `unknown` with `environment.observation_missed`, never the previous value
// and never an out-of-band fact.
export function recordObservation(
  tx: Tx,
  args: {
    environment: string;
    from: string;
    to: string;
    expected_revision: number;
    generation: number | null;
    status: { ok: TargetInventory } | { failure: string };
    identity: { ok: IdentityRead[] } | { failure: string } | null;
    missed?: boolean;
  },
): { observation: string; condition: string; installed: boolean } {
  const env = getEnv(tx.db, args.environment);
  if (!env) throw notFound('environment', args.environment);
  const job = tx.db.prepare('SELECT * FROM "observation_jobs" WHERE "environment" = ?').get(env.id) as JobRow | undefined;
  const policy = projectPolicy(tx.db, env.project);
  const cadence = policy.observation_cadence!;
  const id = tx.newId('obsh_');
  const interval = { from: args.from, to: args.to };
  const revision = (env as { expected_revision?: number }).expected_revision ?? 0;
  const previous = newestIdentity(tx.db, env.id);
  const prevFact = previous ? { at: previous.at, match: previous.match, observation: previous.observation } : null;
  const statusAt = (t: TargetInventory): string => {
    const at = (Array.isArray(t.targets) ? t.targets : []).map((x) => x?.at).find((x) => typeof x === 'string');
    return at ?? args.to;
  };
  // A change the engine made since the first read: kept as history, never
  // installed, no out-of-band fact; the job is due again at once.
  if (revision !== args.expected_revision || env.current_generation !== args.generation) {
    insertHistory(tx, env, {
      id,
      condition: 'unknown',
      detail: { code: 'stale' },
      read_interval: interval,
      expected_revision: args.expected_revision,
      deployment_generation: args.generation,
      facts: { status: 'ok' in args.status ? { at: statusAt(args.status.ok) } : null, identity: prevFact },
      installed: false,
      stale_reason: `the expected state moved from revision ${args.expected_revision} (generation ${args.generation}) to ${revision} (generation ${env.current_generation}) during the read`,
    });
    if (job) tx.db.prepare('UPDATE "observation_jobs" SET "last_attempt_at" = ? WHERE "id" = ?').run(tx.at, job.id);
    return { observation: id, condition: 'unknown', installed: false };
  }
  const missed = (reason: string, extra: Record<string, unknown> = {}) =>
    tx.emit('environment.observation_missed', { project: env.project, environment: env.id, observation: id }, { reason, ...extra });
  if (args.missed === true) missed('freshness_bound', { last_success_at: job?.last_success_at ?? null });
  let observed: Record<string, unknown>;
  let condition: string;
  if ('failure' in args.status) {
    const detail = { code: 'read_failed', failure: args.status.failure };
    condition = 'unknown';
    observed = insertHistory(tx, env, { id, condition, detail, read_interval: interval, expected_revision: revision, deployment_generation: env.current_generation, facts: { status: null, identity: prevFact }, installed: true });
    missed(args.status.failure);
    if (job) tx.db.prepare('UPDATE "observation_jobs" SET "last_attempt_at" = ?, "error_class" = ?, "next_due" = ?, "cadence_s" = ? WHERE "id" = ?').run(tx.at, args.status.failure, addSeconds(tx.at, cadence), cadence, job.id);
  } else {
    const t = args.status.ok;
    const inventory = Array.isArray(t?.inventory) ? t.inventory.filter((e) => e && typeof e === 'object') : [];
    const targets = Array.isArray(t?.targets) ? t.targets.filter((e) => e && typeof e === 'object') : [];
    const complete = t?.complete === true;
    // The changes it finds name it; its own row follows, with its final values.
    recordInventoryRead(tx, { environment: env.id, inventory, complete, targets, observation: id });
    let identityFact = prevFact;
    let identityUnread = false;
    if (args.identity !== null) {
      if ('failure' in args.identity) {
        identityFact = { at: args.to, match: 'unread', observation: id };
        identityUnread = true;
      } else {
        const reads = Array.isArray(args.identity.ok) ? args.identity.ok : [];
        recordIdentityReads(tx, { environment: env.id, reads, observation: id });
        const match = reads.length === 0 || reads.some((r) => r.match === 'unread') ? 'unread' : reads.some((r) => r.match === 'differs') ? 'differs' : 'match';
        identityFact = { at: reads.map((r) => r.at).find((x) => typeof x === 'string') ?? args.to, match, observation: id };
        identityUnread = match === 'unread';
      }
    }
    const exp = expectedService(tx.db, env.id);
    const unaccounted = unaccountedUnits(
      inventory.filter((e) => e.kind === 'unit'),
      recordedUnits(tx.db, env.id),
      recordedCgroups(tx.db, env.id),
    );
    const unexpectedActive = unaccounted.some((u) => ACTIVE.has(String(inventory.find((e) => e.resource === u.unit)?.state)));
    const strangers = new Set(unaccounted.map((u) => u.unit));
    const appUnread = inventory.some((e) => e.kind === 'unit' && ACTIVE.has(String(e.state)) && !strangers.has(e.resource) && !targets.some((x) => x.unit === e.resource));
    const newest = identityFact && (identityFact.observation === id || previous?.generation === env.current_generation) ? { match: identityFact.match } : null;
    const judged = judgeCondition({
      read: { complete, inventory, targets },
      identityUnread,
      appUnread,
      expected: exp?.expected ?? null,
      supervision: exp ? attemptSupervision(tx.db, exp.attempt as unknown as Parameters<typeof attemptSupervision>[1]) : null,
      newestIdentity: newest,
      unexpectedActive,
      drift: unresolvedChanges(tx.db, env.id).length,
    });
    condition = judged.condition;
    const facts = { status: { at: statusAt(t) }, identity: identityFact };
    observed = insertHistory(tx, env, { id, condition, detail: judged.detail, read_interval: interval, expected_revision: revision, deployment_generation: env.current_generation, facts, installed: true });
    if (job) {
      tx.db
        .prepare('UPDATE "observation_jobs" SET "last_attempt_at" = ?, "last_success_at" = ?, "error_class" = NULL, "next_due" = ?, "cadence_s" = ? WHERE "id" = ?')
        .run(tx.at, tx.at, addSeconds(tx.at, cadence), cadence, job.id);
    }
  }
  writeObserved(tx, env, observed);
  tx.emit('environment.observed', { project: env.project, environment: env.id, observation: id }, { condition, observed_at: tx.at, source: 'observation_job', detail: observed.detail ?? null });
  return { observation: id, condition, installed: true };
}

// A tick at which the job's last successful observation is past the
// freshness bound and it is not due (D1 §8.1 step 5): `unknown`, once per
// lapse, with `environment.observation_missed`.
export function observationLapsed(tx: Tx, args: { environment: string }): { observation: string } | null {
  const env = getEnv(tx.db, args.environment);
  const job = tx.db.prepare('SELECT * FROM "observation_jobs" WHERE "environment" = ?').get(args.environment) as JobRow | undefined;
  if (!env || !job || job.error_class === 'freshness_bound') return null;
  const id = tx.newId('obsh_');
  const previous = newestIdentity(tx.db, env.id);
  const detail = { code: 'freshness_bound', last_success_at: job.last_success_at };
  const observed = insertHistory(tx, env, {
    id,
    condition: 'unknown',
    detail,
    read_interval: { from: tx.at, to: tx.at },
    expected_revision: (env as { expected_revision?: number }).expected_revision ?? 0,
    deployment_generation: env.current_generation,
    facts: { status: null, identity: previous ? { at: previous.at, match: previous.match, observation: previous.observation } : null },
    installed: true,
  });
  writeObserved(tx, env, observed);
  tx.db.prepare(`UPDATE "observation_jobs" SET "error_class" = 'freshness_bound', "last_attempt_at" = ? WHERE "id" = ?`).run(tx.at, job.id);
  tx.emit('environment.observation_missed', { project: env.project, environment: env.id, observation: id }, { reason: 'freshness_bound', last_success_at: job.last_success_at });
  tx.emit('environment.observed', { project: env.project, environment: env.id, observation: id }, { condition: 'unknown', observed_at: tx.at, source: 'observation_job', detail });
  return { observation: id };
}

// ---- the environment read's parts (D4 §6.1; SEAM.md §294) ----------------------------------------

export function environmentChangesRead(db: Db, environment: string) {
  return unresolvedChanges(db, environment).map((r) => ({
    id: r.id,
    status: r.disposition === 'acknowledge' ? 'acknowledged' : 'open',
    change: r.change,
    resource: r.resource,
    expected: json(r.expected),
    found: json(r.found),
    detected_at: r.detected_at,
    decision: r.decision,
    acknowledged: json(r.acknowledged),
  }));
}

// The stored observation with its freshness computed at the read (D4 §6.1;
// D1-28): an expired one is shown `expired`, its condition `unknown`.
export function observedRead(db: Db, args: { project: string; observed: string | null; now: string }): Record<string, unknown> {
  const stored = json<Record<string, unknown>>(args.observed) ?? {};
  const at = typeof stored.observed_at === 'string' ? Date.parse(stored.observed_at) : NaN;
  if (!Number.isFinite(at)) return { ...stored, condition: 'unknown', freshness: null, expires_at: null };
  const bound = projectPolicy(db, args.project).observation_freshness_bound! * 1000;
  const age = Date.parse(args.now) - at;
  const freshness = age > bound ? 'expired' : age > bound / 2 ? 'stale' : 'fresh';
  return { ...stored, ...(freshness === 'expired' ? { condition: 'unknown', stored_condition: stored.condition } : {}), freshness, expires_at: new Date(at + bound).toISOString() };
}

// ---- logs (D4 §6.1, A.8; SEAM.md §294) ---------------------------------------------------------

// POST …/logs: a collection asked for; the engine reads once at a later tick.
export function requestLogs(tx: Tx, args: { project: string; environment: string }): CommandResult {
  const env = environmentByName(tx.db, args.project, args.environment);
  if (!env || env.prefix === null) throw notFound('environment', args.environment);
  const row = tx.db.prepare('SELECT "logs_requested_at" FROM "environments" WHERE "id" = ?').get(env.id) as { logs_requested_at: string | null };
  const at = row.logs_requested_at ?? tx.at;
  if (row.logs_requested_at === null) tx.db.prepare('UPDATE "environments" SET "logs_requested_at" = ? WHERE "id" = ?').run(at, env.id);
  // Taken up at the next tick the scheduler makes (SEAM.md §294: "at a later
  // tick"); the request asks for none itself.
  return { status: 202, body: { environment: { id: env.id, name: env.name }, collection: { requested_at: at } } };
}

export function logsDue(db: Db, args: { project: string }): { environment: string; prefix: string; adapter: string; generation: number | null; target: string }[] {
  const rows = db.prepare('SELECT * FROM "environments" WHERE "project" = ? AND "logs_requested_at" IS NOT NULL AND "prefix" IS NOT NULL').all(args.project) as (ReturnType<typeof getEnv> & {})[];
  return rows.map((e) => ({ environment: e.id, prefix: e.prefix!, adapter: e.adapter, generation: e.current_generation, target: expectedService(db, e.id)?.expected.target ?? 'app' }));
}

// The collection's read, recorded: a stored `deployment_logs` record.
export function recordLogs(tx: Tx, args: { environment: string; record: string | null; generation: number | null; at: string; bytes: number; failure?: string | null }): void {
  const env = getEnv(tx.db, args.environment);
  if (!env) return;
  if (args.record === null) return;
  tx.db
    .prepare('INSERT INTO "environment_logs" ("id", "created_at", "project", "environment", "record", "generation", "at", "collected_at", "bytes") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(tx.newId('envl_'), tx.at, env.project, env.id, args.record, args.generation, args.at, tx.at, args.bytes);
  tx.db.prepare('UPDATE "environments" SET "logs_requested_at" = NULL WHERE "id" = ?').run(env.id);
}

// GET …/logs: stored records only (N02).
export function readLogs(db: Db, args: { project: string; environment: string }) {
  const env = environmentByName(db, args.project, args.environment);
  if (!env || env.prefix === null) throw notFound('environment', args.environment);
  const requested = (db.prepare('SELECT "logs_requested_at" FROM "environments" WHERE "id" = ?').get(env.id) as { logs_requested_at: string | null }).logs_requested_at;
  const logs = db.prepare('SELECT "record", "generation", "at", "collected_at", "bytes" FROM "environment_logs" WHERE "environment" = ? ORDER BY "collected_at" DESC, "id" DESC').all(env.id) as {
    record: string;
    generation: number | null;
    at: string;
    collected_at: string;
    bytes: number;
  }[];
  const state = requested !== null ? 'pending' : logs.some((l) => l.generation === env.current_generation) ? 'collected' : 'missing';
  return { environment: { id: env.id, name: env.name }, logs, state, requested_at: requested };
}
