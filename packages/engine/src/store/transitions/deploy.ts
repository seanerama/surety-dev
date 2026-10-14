// Deployment to an Alpha environment, the store's half (D4 §§1, 3 to 6; J1,
// J3, J4, J5, J9; E111 to E115; BS4 §§3, 9.2's slice 23; SEAM.md §§244 to
// 254). Each function is one transition, run in the caller's transaction;
// the main thread (deploy/release-operator.ts) seals the artifact, reads the
// held secrets, writes the precondition manifest and makes every adapter
// call between them, holding no transaction across a call.
//
//   configuration   immutable versions with a keyed identity (§3.2)
//   the request     the engine-derived authorization, gated (J3, J4)
//   the intent      under the environment lease, once (§4.1)
//   the attempt     after the preconditions are read again (E113), its
//                   generation, frozen intent and capability (§4.2; E112)
//   the launch      a single-use grant, the init and the application
//                   instance recorded once (§§3.4, 9.2)
//   the effect      a receipt is a claim; a reconcile read decides (J1)
//   the finalizer   `attempted`, and one durable verification round (§4.2)
//   the round       two identity reads bracketing the required checks (§5.3)
//   completion      `alpha_complete` (gates.ts) and its effects (§5.5)
//   teardown        exactly what the engine owns (§4.6)

import { nowIso } from '../../clock.js';
import { assertEdge } from './lifecycle.js';
import { Refusal } from '../../refusal.js';
import { canonical, illegal, nextSeq, notFound, parseJson, sha256 } from './common.js';
import { type CandidateRow, type CheckRow, POST_DEPLOY_KINDS, getCandidate } from './evidence.js';
import { effectiveVersion } from './protected.js';
import { type DecisionRow, invalidateDecision } from './decisions.js';
import { raiseQuestion } from './queue.js';
import { raiseFinding } from './findings.js';
import { cancelExecution, refuseUnsupervised, registerExecutions } from './checks.js';
import { getWorkItem, observeTrigger, transitionWork } from './work.js';
import { quarantineDomain } from './runs.js';
import { effectiveProfileMax, engineSettings, projectOptions, projectPolicy } from './settings.js';
import { hostEligibility, observedHostFacts, type HostQualificationRow } from './trust.js';
import { seamHostChecks } from '../../testing/seam.js';
import { serviceAdmissionHold } from './envelope.js';
import type { Tx } from './tx.js';
import type { CommandResult } from './control.js';
import type { Capability, IdentityRead, Instance, InventoryEntry, TargetExpectation } from '../../deploy/adapter.js';
import { unaccountedUnits } from '../../deploy/reconcile.js';
import { ADAPTER_QUALIFICATION_CASES } from '../../deploy/qualify-cases.js';
import { HOST_MEMBERS, type HostFacts, adapterVersion, engineBuild, hostFactsDrift, hostFactsOf, isUnknownFact, profileFingerprint, unknownHostMember } from '../../deploy/qualification.js';
import {
  bumpRevision,
  changesInInterval,
  ensureObservationJob,
  environmentChangesRead,
  inventoryOfRead,
  observedRead,
  openChanges,
  recordIdentityReads,
  recordInventoryRead,
  resolveOnReplacement,
} from './observe.js';

type Db = Tx['db'];

export const ADAPTERS = ['local_service'] as const;
// The unit name a prefix gives generation n (D4 §9.3; SEAM.md §250).
export const unitName = (prefix: string, generation: number): string => `${prefix}g${generation}.service`;
const UNIT_CHARS = /^[A-Za-z0-9_.-]+\.service$/;

// ---- rows ---------------------------------------------------------------------------------

export interface EnvRow {
  id: string;
  project: string;
  name: string;
  adapter: string;
  verify_spec: string;
  current_config: string | null;
  deployment_generation: number;
  current_generation: number | null;
  prefix: string | null;
  teardown_requested_at: string | null;
}

export interface ConfigRow {
  id: string;
  project: string;
  environment: string;
  version: number;
  content: string;
  config_identity: string;
  secret_digests: string;
  status: 'current' | 'secrets_changed' | 'superseded';
}

export interface ConfigContent {
  adapter: string;
  adapter_version: string;
  targets: string[];
  runtime?: { path: string; sha256: string };
  start?: string[];
  identity_method?: string;
  secrets?: Record<string, string>;
  check_secrets?: string[];
  artifact?: { exclude?: string[] };
  [key: string]: unknown;
}

interface OpRow {
  id: string;
  project: string;
  seq: number;
  kind: string;
  status: string;
  created_at: string;
  finalizer_inputs: string;
  outcome_detail: string | null;
  orchestration_deadline_at: string | null;
  orchestration_stage: string | null;
  authorization: string | null;
  deadline_at: string;
  finalized_at: string | null;
}

interface AttemptRow {
  id: string;
  operation: string;
  attempt_number: number;
  status: string;
  incarnation: string | null;
  reconciliation_reads: string;
  deployment_generation: number | null;
  capability: string | null;
  launch_state: string | null;
  init_instance: string | null;
  app_instance: string | null;
  app_disagreement: string | null;
  receipt: string | null;
}

// What the intent froze (D4 §4.1; SEAM.md §250; objection 033): the
// operation's authorized inputs and the environment's identity and prefix.
// It names no unit and no prior state, which are each attempt's (E112).
export interface FrozenIntent {
  purpose: 'deploy' | 'teardown';
  work_item: string | null;
  authorization: string | null;
  candidate: string | null;
  mapping: string | null;
  artifact_digest: string | null;
  artifact_path: string | null;
  manifest: unknown[] | null;
  config_version: string | null;
  config_number: number | null;
  config_identity: string | null;
  secret_digests: { ref: string; digest: string }[];
  target_set: string[];
  environment: string;
  environment_name: string;
  prefix: string;
  adapter: string;
  adapter_version: string | null;
  runtime: { path: string; sha256: string } | null;
  start: string[] | null;
  lease: { id: string; generation: number };
  // An adapter qualification's own operation (D4 §2.6; deploy/qualify.ts):
  // the run that made it. Driven by that run only, never by the tick.
  qualification?: string | null;
}

export const getEnv = (db: Db, id: string): EnvRow | undefined => db.prepare('SELECT * FROM "environments" WHERE "id" = ?').get(id) as EnvRow | undefined;
const getConfig = (db: Db, id: string | null): ConfigRow | undefined => (id === null ? undefined : (db.prepare('SELECT * FROM "environment_configs" WHERE "id" = ?').get(id) as ConfigRow | undefined));
const getOp = (db: Db, id: string): OpRow | undefined => db.prepare('SELECT * FROM "operations" WHERE "id" = ?').get(id) as OpRow | undefined;
const getAttempt = (db: Db, id: string): AttemptRow | undefined => db.prepare('SELECT * FROM "operation_attempts" WHERE "id" = ?').get(id) as AttemptRow | undefined;
const attemptsOf = (db: Db, op: string): AttemptRow[] => db.prepare('SELECT * FROM "operation_attempts" WHERE "operation" = ? ORDER BY "attempt_number"').all(op) as AttemptRow[];
const frozenOf = (op: OpRow): FrozenIntent => JSON.parse(op.finalizer_inputs) as FrozenIntent;
const prefixOf = (db: Db, env: string): string => getEnv(db, env)?.prefix ?? '';

// An environment of the project by its name (SEAM.md §245), or its id. A
// configured environment is preferred to a fixture's of the same name.
export function environmentByName(db: Db, project: string, name: string): EnvRow | undefined {
  return db
    .prepare('SELECT * FROM "environments" WHERE "project" = ? AND ("name" = ? OR "id" = ?) ORDER BY "prefix" IS NULL, rowid LIMIT 1')
    .get(project, name, name) as EnvRow | undefined;
}

export const currentConfig = (db: Db, env: EnvRow): ConfigRow | undefined => getConfig(db, env.current_config);
const configContent = (c: ConfigRow): ConfigContent => JSON.parse(c.content) as ConfigContent;

// The current version's content of an environment, by its name (for
// `resolve-secrets`, SEAM.md §313); null when it has none.
export function currentConfigContent(db: Db, args: { project: string; name: string }): ConfigContent | null {
  const env = db.prepare('SELECT * FROM "environments" WHERE "project" = ? AND "name" = ? AND "prefix" IS NOT NULL').get(args.project, args.name) as EnvRow | undefined;
  const c = env ? currentConfig(db, env) : undefined;
  return c ? configContent(c) : null;
}
const targetsOf = (c: ConfigRow): string[] => [...configContent(c).targets].sort();

// The identity method an environment declares (J4): its configuration's.
export function identityMethodOf(db: Db, env: EnvRow): string | null {
  const c = currentConfig(db, env);
  const method = c ? configContent(c).identity_method : undefined;
  return typeof method === 'string' && method !== '' ? method : null;
}

// ---- configuration (D4 §3.2; Q5; SEAM.md §245) --------------------------------------------

// PUT /v1/projects/:p/environments/:e/config: a new immutable version. The
// main thread validated the content and computed its identity with the
// secret digests (deploy/config.ts); the first version creates the
// environment, its prefix fixed from the home's hash and its id. Content
// equal to the current version's writes nothing and answers it.
export function writeConfigVersion(
  tx: Tx,
  args: { project: string; name: string; content: ConfigContent; identity: string; secretDigests: { ref: string; digest: string }[]; homeHash: string },
): CommandResult {
  if (!tx.db.prepare('SELECT 1 FROM "projects" WHERE "id" = ?').get(args.project)) throw notFound('project', args.project);
  let env = tx.db.prepare('SELECT * FROM "environments" WHERE "project" = ? AND "name" = ? AND "prefix" IS NOT NULL').get(args.project, args.name) as EnvRow | undefined;
  const verifySpec = JSON.stringify({ identity_method: args.content.identity_method ?? 'none', target_set: args.content.targets });
  const answer = (status: number, e: EnvRow, c: ConfigRow): CommandResult => ({
    status,
    body: { environment: { id: e.id, name: e.name, prefix: e.prefix }, config: { id: c.id, version: c.version, config_identity: c.config_identity, status: c.status } },
  });
  if (env) {
    const current = currentConfig(tx.db, env);
    if (current && current.status === 'current' && current.config_identity === args.identity && current.content === canonical(args.content)) return answer(200, env, current);
  } else {
    const id = tx.newId('env_');
    if (!/^[0-9a-f]{12}$/.test(args.homeHash)) throw new Error('the home hash is not 12 hex characters');
    const prefix = `surety-${args.homeHash}-${id}-`;
    tx.db
      .prepare(
        `INSERT INTO "environments" ("id", "created_at", "project", "name", "adapter", "adapter_config_ref", "verify_spec", "deployment_generation", "prefix")
         VALUES (?, ?, ?, ?, ?, 'environment_configs', ?, 0, ?)`,
      )
      .run(id, tx.at, args.project, args.name, args.content.adapter, verifySpec, prefix);
    env = getEnv(tx.db, id)!;
    // Its observation job, first due one cadence from now (D4 §6.2; SEAM.md §291).
    ensureObservationJob(tx, { environment: id, project: args.project });
  }
  const { n } = tx.db.prepare('SELECT COALESCE(MAX("version"), 0) + 1 AS n FROM "environment_configs" WHERE "environment" = ?').get(env.id) as { n: number };
  tx.db.prepare(`UPDATE "environment_configs" SET "status" = 'superseded' WHERE "environment" = ? AND "status" <> 'superseded'`).run(env.id);
  const id = tx.newId('envc_');
  tx.db
    .prepare(
      `INSERT INTO "environment_configs" ("id", "created_at", "project", "environment", "version", "content", "config_identity", "secret_digests", "status", "written_by", "written_at")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'current', ?, ?)`,
    )
    .run(id, tx.at, args.project, env.id, n, canonical(args.content), args.identity, JSON.stringify(args.secretDigests), tx.actor.actor_kind, tx.at);
  tx.db.prepare('UPDATE "environments" SET "current_config" = ?, "adapter" = ?, "verify_spec" = ? WHERE "id" = ?').run(id, args.content.adapter, verifySpec, env.id);
  tx.emit('environment.configured', { project: args.project, environment: env.id }, { config: id, version: n, config_identity: args.identity, name: env.name });
  markStaleDeploy(tx);
  return answer(201, getEnv(tx.db, env.id)!, getConfig(tx.db, id)!);
}

// The configurations whose secrets the main thread recomputes at start.
export function configsWithSecrets(db: Db): { config: string; refs: string[]; digests: { ref: string; digest: string }[] }[] {
  const rows = db.prepare(`SELECT * FROM "environment_configs" WHERE "status" = 'current'`).all() as ConfigRow[];
  return rows.map((r) => {
    const digests = JSON.parse(r.secret_digests) as { ref: string; digest: string }[];
    return { config: r.id, refs: digests.map((d) => d.ref), digests };
  });
}

// At start (RV5): a current version whose held values no longer give its
// digests becomes `secrets_changed`; an unheld value is not the same value.
export function markSecretsChanged(tx: Tx, args: { configs: { config: string; changed: string[] }[] }): { changed: string[] } {
  const out: string[] = [];
  for (const c of args.configs) {
    if (c.changed.length === 0) continue;
    const row = getConfig(tx.db, c.config);
    if (!row || row.status !== 'current') continue;
    tx.db.prepare(`UPDATE "environment_configs" SET "status" = 'secrets_changed' WHERE "id" = ?`).run(row.id);
    tx.emit('environment.config_secrets_changed', { project: row.project, environment: row.environment }, { config: row.id, version: row.version, references: c.changed });
    out.push(row.id);
  }
  if (out.length > 0) markStaleDeploy(tx);
  return { changed: out };
}

// ---- adapter qualification (D4 §2.6, J4; E129 item 8; SEAM.md §§248, 322, 324) ----------------

export interface QualificationRow {
  id: string;
  adapter: string;
  adapter_version: string;
  engine_build: string;
  profile_fingerprint: string;
  status: string;
  host_qualification: string | null;
  host_facts: string | null;
}

const markStaleDeploy = (tx: Tx): void => {
  tx.db.prepare(`UPDATE "gate_evaluations" SET "stale" = 1 WHERE "stale" = 0 AND "gate_kind" IN ('alpha_authorize', 'alpha_complete')`).run();
};

// The host qualification in force and the host's facts (E129 item 8; the
// slice-29 review, m8): the facts this start's host checks read, whatever
// they found (a start whose checks failed, or under the bootstrap
// exception, writes no active row but read the facts all the same); before
// they are read, the active row's. `unrun`: the harness runs no host checks.
function hostInForce(db: Db): { id: string | null; facts: HostFacts | null; unrun: boolean } {
  const id = hostEligibility(db).host_qualification ?? null;
  const unrun = seamHostChecks()?.mode === 'unrun';
  const read = observedHostFacts();
  if (read) return { id, facts: hostFactsOf({ ...read, tool_versions: JSON.stringify(read.tool_versions) }), unrun };
  if (id === null) return { id: null, facts: null, unrun };
  const row = db.prepare('SELECT * FROM "host_qualifications" WHERE "id" = ?').get(id) as HostQualificationRow | undefined;
  return { id, facts: hostFactsOf(row), unrun };
}

// The host's facts a run would be recorded against, and the first member
// not known (the slice-29 review, S1), for the run's evidence.
export function qualificationHostFacts(db: Db): { facts: HostFacts | null; unknown: string | null; unread: string[]; unrun: boolean } {
  const host = hostInForce(db);
  const unknown = host.facts === null && host.unrun ? null : unknownHostMember(host.facts);
  // Every member not read (SEAM.md §328 `unread_host_facts`).
  const unread = host.facts === null ? (host.unrun ? [] : [...HOST_MEMBERS]) : HOST_MEMBERS.filter((m) => isUnknownFact(host.facts![m]));
  return { facts: host.facts, unknown, unread, unrun: host.unrun };
}

export type LapseReason = 'engine_build' | 'adapter_version' | 'host_qualification' | 'profile_fingerprint';

// The first fact of a `current` row that is no longer the engine's (SEAM.md
// §324), in this order; for the host qualification, the member that
// differs. null: the row matches.
export function qualificationDrift(db: Db, q: QualificationRow): { reason: LapseReason; member: string | null } | null {
  if (q.engine_build !== engineBuild()) return { reason: 'engine_build', member: null };
  if (q.adapter_version !== adapterVersion(q.adapter)) return { reason: 'adapter_version', member: null };
  const host = hostInForce(db);
  const member = hostFactsDrift(host.facts, parseJson<HostFacts>(q.host_facts), host.unrun);
  if (member !== null) return { reason: 'host_qualification', member };
  if (q.profile_fingerprint !== profileFingerprint()) return { reason: 'profile_fingerprint', member: null };
  return null;
}

// The row current for an adapter at a version (D4 §2.6): `current`, of the
// version this engine builds, every fact of it the engine's now.
function qualificationOf(db: Db, adapter: string, version: string | null): QualificationRow | undefined {
  if (version === null || version !== adapterVersion(adapter)) return undefined;
  const q = db.prepare(`SELECT * FROM "adapter_qualifications" WHERE "adapter" = ? AND "adapter_version" = ? AND "status" = 'current'`).get(adapter, version) as QualificationRow | undefined;
  if (!q || qualificationDrift(db, q) !== null) return undefined;
  return q;
}

// The qualification current for an environment (SEAM.md §§248, 324): a
// current row of its configuration's adapter and adapter version.
export function qualificationFor(db: Db, env: EnvRow): QualificationRow | undefined {
  const c = currentConfig(db, env);
  if (!c) return undefined;
  const content = configContent(c);
  return qualificationOf(db, content.adapter, content.adapter_version);
}

// A row recorded (D4 §2.6, A.3): the harness fixture's (SEAM.md §248, with
// no case run and its label; an existing current row is reused) or a run's
// (`run` and its evidence: always a new row, any current one of the adapter
// superseded). The engine's build, adapter version, host qualification and
// its facts, and the profile fingerprint are the engine's now.
export function recordAdapterQualification(
  tx: Tx,
  args: { adapter: string; adapterVersion: string; cases: unknown[]; label: Record<string, unknown> | null; run?: string; evidence?: string },
): { id: string; created: boolean } {
  const host = hostInForce(tx.db);
  if (args.run === undefined) {
    const existing = qualificationOf(tx.db, args.adapter, args.adapterVersion);
    if (existing) return { id: existing.id, created: false };
  }
  // No row on host facts not known (the slice-29 review, S1): it could
  // never be matched, and a fact not known is never taken as unchanged.
  // Under `unrun` (the kernel lane) no host facts exist and none are needed.
  const unknown = host.facts === null && host.unrun ? null : unknownHostMember(host.facts);
  if (unknown !== null) {
    throw new Refusal(409, 'host_facts_unknown', `The host's ${unknown} is not known, so no adapter qualification can be recorded against it.`, 'Start the engine where the host checks read every host fact, then qualify again.', { member: unknown });
  }
  const stale = tx.db.prepare(`SELECT "id" FROM "adapter_qualifications" WHERE "adapter" = ? AND "adapter_version" = ? AND "status" = 'current'`).get(args.adapter, args.adapterVersion) as { id: string } | undefined;
  if (stale) lapseQualification(tx, { id: stale.id, reason: 'superseded' });
  const id = tx.newId('aq_');
  tx.db
    .prepare(
      `INSERT INTO "adapter_qualifications" ("id", "created_at", "adapter", "adapter_version", "engine_build", "host_qualification", "host_facts", "profile_fingerprint", "cases", "evidence", "status", "qualified_at", "label", "run")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?, ?, ?)`,
    )
    .run(
      id,
      tx.at,
      args.adapter,
      args.adapterVersion,
      engineBuild(),
      host.id,
      host.facts === null ? null : canonical(host.facts),
      profileFingerprint(),
      JSON.stringify(args.cases),
      args.evidence ?? null,
      tx.at,
      args.label === null ? null : JSON.stringify(args.label),
      args.run ?? null,
    );
  tx.emit('adapter.qualified', { adapter_qualification: id }, { adapter: args.adapter, adapter_version: args.adapterVersion, host_qualification: host.id });
  markStaleDeploy(tx);
  return { id, created: true };
}

export function lapseQualification(tx: Tx, args: { id: string; reason: string; member?: string | null; run?: string | null }): { lapsed: string | null } {
  const q = tx.db.prepare('SELECT * FROM "adapter_qualifications" WHERE "id" = ?').get(args.id) as QualificationRow | undefined;
  if (!q) throw notFound('adapter qualification', args.id);
  if (q.status !== 'current') return { lapsed: null };
  const member = args.member ?? null;
  tx.db.prepare(`UPDATE "adapter_qualifications" SET "status" = 'lapsed', "lapsed_at" = ?, "lapsed_reason" = ?, "lapsed_member" = ? WHERE "id" = ?`).run(tx.at, args.reason, member, q.id);
  tx.emit('adapter.qualification_lapsed', { adapter_qualification: q.id }, { adapter: q.adapter, reason: args.reason, ...(member !== null ? { member } : {}), ...(args.run ? { qualification_run: args.run } : {}) });
  markStaleDeploy(tx);
  return { lapsed: q.id };
}

// The lapse (D4-A07; SEAM.md §324): every current row whose facts are no
// longer the engine's, lapsed naming the fact. Made at start, once the
// start's host qualification is recorded, and again after a later host
// check run (engine.ts, runtime.ts).
export function sweepAdapterQualifications(tx: Tx): { lapsed: string[] } {
  const rows = tx.db.prepare(`SELECT * FROM "adapter_qualifications" WHERE "status" = 'current' ORDER BY rowid`).all() as QualificationRow[];
  const lapsed: string[] = [];
  for (const q of rows) {
    const drift = qualificationDrift(tx.db, q);
    if (drift === null) continue;
    lapseQualification(tx, { id: q.id, reason: drift.reason, member: drift.member });
    lapsed.push(q.id);
  }
  return { lapsed };
}

// ---- the artifact and its mapping (D4 §3.1) --------------------------------------------------

export interface SealedArtifact {
  digest: string;
  manifest: unknown[];
  path: string;
  bytes: number;
  entries: number;
  // The sealed copy was already there: what rehashing it found.
  reused: 'new' | 'ok' | 'corrupt';
}

interface ArtifactRow {
  id: string;
  project: string;
  digest: string;
  manifest: string;
  path: string;
  status: string;
  bytes: number;
  entries: number;
}

const getArtifact = (db: Db, project: string, digest: string): ArtifactRow | undefined =>
  db.prepare('SELECT * FROM "artifacts" WHERE "project" = ? AND "digest" = ?').get(project, digest) as ArtifactRow | undefined;

// A sealed copy that no longer rehashes to its digest (D4 §3.1): the
// artifact `failed`, and a High security finding of the project, since only
// a same-uid process outside every domain can have changed it.
function artifactCorrupt(tx: Tx, project: string, a: ArtifactRow, where: string): void {
  if (a.status === 'failed') return;
  tx.db.prepare(`UPDATE "artifacts" SET "status" = 'failed', "refusal" = 'corrupt', "failed_at" = ? WHERE "id" = ?`).run(tx.at, a.id);
  tx.emit('artifact.failed', { project, artifact: a.id }, { digest: a.digest, reason: 'artifact_corrupt', where });
  raiseFinding(tx, {
    project,
    scope: 'project',
    candidate: null,
    run: null,
    role: null,
    category: 'security',
    severity: 'high',
    message: `The sealed artifact ${a.digest} no longer rehashes to its digest (${where}): a process outside every domain changed the engine's copy.`,
  });
}

// The sealed copy found changed at a precondition read (main thread's
// rehash): recorded before the operation fails on it.
export function artifactFoundCorrupt(tx: Tx, args: { project: string; digest: string; where?: 'precondition' | 'reuse' }): void {
  const a = getArtifact(tx.db, args.project, args.digest);
  if (a) artifactCorrupt(tx, args.project, a, args.where ?? 'precondition');
}

export function recordArtifact(tx: Tx, project: string, s: SealedArtifact): ArtifactRow {
  const existing = getArtifact(tx.db, project, s.digest);
  if (existing) {
    if (s.reused === 'corrupt') artifactCorrupt(tx, project, existing, 'reuse');
    const now = getArtifact(tx.db, project, s.digest)!;
    if (now.status !== 'sealed') {
      throw new Refusal(409, 'artifact_corrupt', `The sealed artifact ${s.digest} failed its rehash and is not deployed.`, 'Nothing was authorized. Read the security finding; the sealed copy must be replaced by hand.', {
        artifact_digest: s.digest,
      });
    }
    return now;
  }
  const id = tx.newId('art_');
  tx.db
    .prepare(
      `INSERT INTO "artifacts" ("id", "created_at", "project", "digest", "manifest", "path", "status", "sealed_at", "bytes", "entries")
       VALUES (?, ?, ?, ?, ?, ?, 'sealed', ?, ?, ?)`,
    )
    .run(id, tx.at, project, s.digest, JSON.stringify(s.manifest), s.path, tx.at, s.bytes, s.entries);
  tx.emit('artifact.sealed', { project, artifact: id }, { digest: s.digest, entries: s.entries, bytes: s.bytes });
  return getArtifact(tx.db, project, s.digest)!;
}

function recordMapping(tx: Tx, args: { project: string; artifact: string; revision: string; config: string; spec: string; builder: string }): string {
  const existing = tx.db
    .prepare('SELECT "id" FROM "artifact_mappings" WHERE "artifact" = ? AND "dev_revision" = ? AND "config_version" = ? AND "artifact_spec_fingerprint" = ? AND "builder" = ?')
    .get(args.artifact, args.revision, args.config, args.spec, args.builder) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = tx.newId('artm_');
  tx.db
    .prepare(
      `INSERT INTO "artifact_mappings" ("id", "created_at", "project", "artifact", "dev_revision", "delivery_commit", "config_version", "artifact_spec_fingerprint", "builder")
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(id, tx.at, args.project, args.artifact, args.revision, args.config, args.spec, args.builder);
  return id;
}

// ---- the request (D4 §4.1; J3, J4; SEAM.md §246) ------------------------------------------------

interface AuthRow {
  id: string;
  project: string;
  candidate: string;
  environment: string;
  artifact_digest: string;
  source_delivery_mapping: string;
  config_identity: string;
  target_set: string;
  status: string;
  generation: number;
  binding_hash: string;
  evaluation: string | null;
}

export interface Binding {
  environment: string;
  artifact_digest: string;
  mapping: string;
  config_identity: string;
  target_set: string[];
}

const bindingOf = (a: AuthRow): Binding => ({
  environment: a.environment,
  artifact_digest: a.artifact_digest,
  mapping: (JSON.parse(a.source_delivery_mapping) as { mapping?: string }).mapping ?? '',
  config_identity: a.config_identity,
  target_set: [...(JSON.parse(a.target_set) as string[])].sort(),
});
const bindingKey = (b: Binding): string => sha256(canonical(b));

// The operation an authorization was consumed by, if any.
const operationOf = (db: Db, authorization: string): OpRow | undefined =>
  db.prepare('SELECT * FROM "operations" WHERE "authorization" = ?').get(authorization) as OpRow | undefined;

// Is the deployment of this authorization still pending (J3): issued and
// not consumed, or consumed by an operation whose orchestration has not
// ended?
function pending(db: Db, a: AuthRow): boolean {
  if (a.status === 'issued') return true;
  if (a.status !== 'consumed') return false;
  // Pending while the lease its intent took is held: a later re-verification
  // round takes a lease of its own and never makes the authorization pending
  // again (the slice-25 review's m7).
  const op = operationOf(db, a.id);
  if (op === undefined) return false;
  const lease = frozenOf(op).lease;
  const row = db.prepare('SELECT "released_at" FROM "leases" WHERE "id" = ?').get(lease.id) as { released_at: string | null } | undefined;
  return row !== undefined && row.released_at === null;
}

// An authorization `proposed` with its binding; `binding_hash` includes its
// generation (J3), so a deliberate request after a terminal operation is a
// new row.
function insertAuthorization(tx: Tx, args: { project: string; candidate: CandidateRow; binding: Binding; generation: number }): AuthRow {
  const effective = effectiveVersion(tx.db, args.project);
  if (!effective) throw new Refusal(409, 'illegal_transition', 'The project has no effective protected version.', 'Nothing was recorded.', { project: args.project });
  const policy = tx.db.prepare('SELECT "policy_revision" FROM "projects" WHERE "id" = ?').get(args.project) as { policy_revision: string | null };
  const id = tx.newId('dauth_');
  tx.db
    .prepare(
      `INSERT INTO "deployment_authorizations" ("id", "created_at", "project", "candidate", "environment", "artifact_digest", "source_delivery_mapping", "config_identity",
         "target_set", "policy_revision", "protected_version", "evaluation", "status", "generation", "binding_hash")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'proposed', ?, ?)`,
    )
    .run(
      id,
      tx.at,
      args.project,
      args.candidate.id,
      args.binding.environment,
      args.binding.artifact_digest,
      JSON.stringify({ dev_revision: args.candidate.revision, delivery_commit: null, artifact_digest: args.binding.artifact_digest, mapping: args.binding.mapping }),
      args.binding.config_identity,
      JSON.stringify(args.binding.target_set),
      policy.policy_revision,
      effective.id,
      args.generation,
      sha256(canonical({ ...args.binding, generation: args.generation })),
    );
  return tx.db.prepare('SELECT * FROM "deployment_authorizations" WHERE "id" = ?').get(id) as AuthRow;
}

export interface RequestArgs {
  project: string;
  candidate: string;
  environment: string;
  // null: prepared as coalescing with a pending deployment, nothing sealed.
  sealed: SealedArtifact | null;
  specFingerprint: string;
  builder: string;
  // The gate's facts, read on the main thread (gates/prepare.ts).
  facts: Record<string, unknown>;
  // Who requests (D6 §6.8, A.3): the owner's command, or the engine under
  // `alpha_deploy: on_phase_complete`.
  requested_by?: 'human' | 'policy';
}

// ---- the deployment request and its key (D6 §6.8, A.3; K9; B14; SEAM.md §354) ----------------

interface RequestRow {
  id: string;
  project: string;
  request_key: string;
  requested_by: 'human' | 'policy';
  authorization: string | null;
  outcome: string;
}

// The request key: the project, the completion binding of the phase that
// completed on the candidate (null when none did), the candidate and the
// environment's configuration version. Canonical text, unique per project.
function requestKey(db: Db, args: { project: string; candidate: string; config: string }): string {
  const plans = db
    .prepare(`SELECT "completion_binding" FROM "phase_plans" WHERE "project" = ? AND "completed_at" IS NOT NULL AND "completion_binding" IS NOT NULL ORDER BY "phase_number" DESC, rowid DESC`)
    .all(args.project) as { completion_binding: string }[];
  const binding = plans.map((p) => parseJson<Record<string, unknown>>(p.completion_binding)).find((b) => b?.candidate === args.candidate) ?? null;
  return canonical({ project: args.project, completion_binding: binding, candidate: args.candidate, environment_configuration: args.config });
}

const requestOfKey = (db: Db, project: string, key: string): RequestRow | undefined =>
  db.prepare('SELECT * FROM "deployment_requests" WHERE "project" = ? AND "request_key" = ?').get(project, key) as RequestRow | undefined;

// A policy request whose preparation failed with an error that is not a
// refusal, still within its bound (D6 §6.8; the driver's ruling Q4, slice
// 37; SEAM.md §433): its row stands `pending` with no authorization, and the
// key is prepared again; any other row of the key admits no new request.
const preparing = (r: RequestRow | undefined): boolean =>
  r !== undefined && r.requested_by === 'policy' && r.outcome === 'pending' && r.authorization === null && (r as RequestRow & { preparation_attempts?: number | null }).preparation_attempts != null;

// The policy's preparation failed unexpectedly: counted on the key's row
// (made `pending` at the first error); past 1 + `deploy_auto_retries_max`
// preparations, `not_issued` with reason `preparation_failed`, and the key
// is never prepared again. The policy is not an unbounded retry (D6 §6.8).
export function policyPreparationFailed(tx: Tx, args: { project: string; candidate: string; environment: string; key: string; error: string }): { attempts: number; outcome: string } {
  const env = environmentByName(tx.db, args.project, args.environment);
  if (!env) throw notFound('environment', args.environment);
  let row = requestOfKey(tx.db, args.project, args.key) as (RequestRow & { preparation_attempts?: number | null }) | undefined;
  if (row && !preparing(row)) return { attempts: row.preparation_attempts ?? 0, outcome: row.outcome };
  if (!row) row = recordRequest(tx, { project: args.project, key: args.key, requested_by: 'policy', candidate: args.candidate, environment: env.id, authorization: null, work_item: null, outcome: 'pending' }) as RequestRow & { preparation_attempts?: number | null };
  const attempts = (row.preparation_attempts ?? 0) + 1;
  const bound = 1 + (projectPolicy(tx.db, args.project).deploy_auto_retries_max ?? 0);
  const outcome = attempts >= bound ? 'not_issued' : 'pending';
  tx.db.prepare('UPDATE "deployment_requests" SET "preparation_attempts" = ?, "outcome" = ?, "reason" = ? WHERE "id" = ?').run(attempts, outcome, outcome === 'not_issued' ? 'preparation_failed' : null, row.id);
  return { attempts, outcome };
}

// The request's row: one per key. The owner's request again under a key
// already requested takes the row on (its authorization, work and outcome
// are the newest request's); a policy request never makes a second one.
function recordRequest(
  tx: Tx,
  args: { project: string; key: string; requested_by: 'human' | 'policy'; candidate: string; environment: string; authorization: string | null; work_item: string | null; outcome: string; refusal?: { code: string; reason: string } },
): RequestRow {
  // The owner's request again under a key the owner already requested takes
  // that row on; a policy's row is never rewritten by the owner's request
  // (the 31b review's M5): the owner's gets a row of its own.
  const mine = tx.db.prepare('SELECT * FROM "deployment_requests" WHERE "project" = ? AND "request_key" = ? AND "requested_by" = ?').get(args.project, args.key, args.requested_by) as RequestRow | undefined;
  if (mine) {
    tx.db.prepare('UPDATE "deployment_requests" SET "authorization" = ?, "work_item" = ?, "outcome" = ?, "reason" = ? WHERE "id" = ?').run(args.authorization, args.work_item, args.outcome, args.refusal?.code ?? null, mine.id);
    return tx.db.prepare('SELECT * FROM "deployment_requests" WHERE "id" = ?').get(mine.id) as RequestRow;
  }
  const id = tx.newId('dreq_');
  tx.db
    .prepare(
      'INSERT INTO "deployment_requests" ("id", "created_at", "project", "request_key", "requested_by", "candidate", "environment", "authorization", "work_item", "outcome", "reason") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, tx.at, args.project, args.key, args.requested_by, args.candidate, args.environment, args.authorization, args.work_item, args.outcome, args.refusal?.code ?? null);
  if (args.requested_by === 'policy') {
    tx.emit('deploy.requested_by_policy', { project: args.project, candidate: args.candidate, environment: args.environment }, { request: id, request_key: JSON.parse(args.key) as unknown, authorization: args.authorization, outcome: args.outcome, ...(args.refusal ? { refusal: args.refusal } : {}) });
  }
  return tx.db.prepare('SELECT * FROM "deployment_requests" WHERE "id" = ?').get(id) as RequestRow;
}

// The policy's request refused at its preparation, before any authorization
// (the runtime or the artifact refused, D4 §3.1; the 31b review's S6): the
// request is recorded `not_issued` under its key with the refusal, so it is
// never made again for that key (SEAM.md §354).
export function policyRequestRefused(tx: Tx, args: { project: string; candidate: string; environment: string; key: string; refusal: { code: string; reason: string } }): { recorded: boolean } {
  const env = environmentByName(tx.db, args.project, args.environment);
  if (!env) throw notFound('environment', args.environment);
  const existing = requestOfKey(tx.db, args.project, args.key);
  if (existing && preparing(existing)) {
    tx.db.prepare(`UPDATE "deployment_requests" SET "outcome" = 'not_issued', "reason" = ?, "preparation_attempts" = "preparation_attempts" + 1 WHERE "id" = ?`).run(args.refusal.code, existing.id);
    return { recorded: true };
  }
  if (existing) return { recorded: false };
  recordRequest(tx, { project: args.project, key: args.key, requested_by: 'policy', candidate: args.candidate, environment: env.id, authorization: null, work_item: null, outcome: 'not_issued', refusal: args.refusal });
  return { recorded: true };
}

// The outcome of the request whose authorization an operation consumed,
// when its orchestration ends (A.3): deployed, failed, not verified, or
// unknown.
function settleRequest(tx: Tx, op: OpRow, outcome: 'deployed' | 'failed' | 'not_verified' | 'unknown'): void {
  if (op.kind !== 'deploy' || !op.authorization) return;
  tx.db.prepare(`UPDATE "deployment_requests" SET "outcome" = ? WHERE "authorization" = ? AND "outcome" = 'pending'`).run(outcome, op.authorization);
}

// `alpha_deploy: on_phase_complete` (D6 §6.8; SEAM.md §354): at a tick
// after a phase's completion, the request the policy owes now, if any: the
// newest phase-complete candidate, on a configured environment whose
// adapter is qualified, under a key no request has had. Nothing while a
// deployment of the candidate and environment is pending: the policy never
// joins another request.
export function policyRequestDue(db: Db, args: { project: string }): { candidate: string; environment: string; key: string } | null {
  if (projectOptions(db, args.project).alpha_deploy !== 'on_phase_complete') return null;
  // The policy waits for a specification change to settle (the driver's
  // ruling 1 on M401's T1 runs, slice 37): no request while a change of the
  // project is proposed, its approval included until it is applied. An
  // owner's own request is his explicit act, never held.
  if (db.prepare(`SELECT 1 FROM "spec_change_requests" WHERE "project" = ? AND "status" = 'proposed' LIMIT 1`).get(args.project) !== undefined) return null;
  // Nor while an applied change's spec_changed obligations are unresolved
  // (the driver's ruling on M401's T1 stall, slice 37).
  if (db.prepare(`SELECT 1 FROM "check_obligations" WHERE "project" = ? AND "reason" = 'spec_changed' AND "resolved_at" IS NULL LIMIT 1`).get(args.project) !== undefined) return null;
  const plan = db
    .prepare(`SELECT "completion_binding" FROM "phase_plans" WHERE "project" = ? AND "completed_at" IS NOT NULL AND "completion_binding" IS NOT NULL ORDER BY "phase_number" DESC, rowid DESC LIMIT 1`)
    .get(args.project) as { completion_binding: string } | undefined;
  const candidate = parseJson<{ candidate?: string }>(plan?.completion_binding ?? null)?.candidate;
  if (!candidate || !getCandidate(db, candidate)) return null;
  const envs = db.prepare(`SELECT * FROM "environments" WHERE "project" = ? AND "prefix" IS NOT NULL AND "current_config" IS NOT NULL ORDER BY "name", rowid`).all(args.project) as EnvRow[];
  for (const env of envs) {
    const config = currentConfig(db, env);
    if (!config || config.status === 'secrets_changed') continue;
    if (qualificationFor(db, env) === undefined) continue;
    const key = requestKey(db, { project: args.project, candidate, config: config.id });
    const existing = requestOfKey(db, args.project, key);
    if (existing && !preparing(existing)) continue;
    const all = db.prepare('SELECT * FROM "deployment_authorizations" WHERE "candidate" = ? AND "environment" = ?').all(candidate, env.id) as AuthRow[];
    if (all.some((a) => pending(db, a))) continue;
    return { candidate, environment: env.name, key };
  }
  return null;
}

// A policy refusal reason a specification change leaves while its
// evidence is made again (the driver's ruling on M401's T1 stall, slice
// 37): EVIDENCE_GENERATION_STALE, and CHECK_NOT_PASSED on checks with no
// current result for the candidate because the change invalidated it
// (`spec_changed`) or its correction's version superseded it. Asked again
// at the next tick, like *_PENDING.
export function settlingAfterChange(db: Db, candidate: string, r: { code: string; subjects?: string[] }): boolean {
  if (r.code === 'EVIDENCE_GENERATION_STALE') return true;
  if (r.code !== 'CHECK_NOT_PASSED') return false;
  const subjects = r.subjects ?? [];
  if (subjects.length === 0) return false;
  return subjects.every((check) => {
    const key = (db.prepare('SELECT "key" FROM "checks" WHERE "id" = ?').get(check) as { key: string } | undefined)?.key;
    if (key === undefined) return false;
    const rows = db
      .prepare(`SELECT x."invalidated_at", x."invalidated_reason" FROM "check_results" x JOIN "checks" c ON c."id" = x."check" WHERE x."candidate" = ? AND c."key" = ?`)
      .all(candidate, key) as { invalidated_at: string | null; invalidated_reason: string | null }[];
    // Invalidated by the change itself (`spec_changed`), or superseded by the
    // protected version its correction applied (`protected_version_superseded`),
    // the checks registered again under it (M401's T1 store, 17195cf..42c58ba).
    return rows.length > 0 && rows.every((x) => x.invalidated_at !== null) && rows.some((x) => x.invalidated_reason === 'spec_changed' || x.invalidated_reason === 'protected_version_superseded');
  });
}

// What the request needs the main thread to read first.
export function requestFacts(db: Db, args: { project: string; candidate: string; environment: string }) {
  const candidate = getCandidate(db, args.candidate);
  if (!candidate || candidate.project !== args.project) throw notFound('candidate', args.candidate);
  const env = environmentByName(db, args.project, args.environment);
  if (!env || env.prefix === null) throw notFound('environment', args.environment);
  const config = currentConfig(db, env);
  if (!config) throw notFound('environment configuration', args.environment);
  const repo = (db.prepare('SELECT "dev_repo_path" FROM "projects" WHERE "id" = ?').get(args.project) as { dev_repo_path: string }).dev_repo_path;
  // Whether a request now would coalesce (J3): decided before anything is
  // sealed, so a coalesced request seals nothing (the slice-23 review's m5).
  const all = db.prepare('SELECT * FROM "deployment_authorizations" WHERE "candidate" = ? AND "environment" = ?').all(candidate.id, env.id) as AuthRow[];
  const pendingNow = all.some((a) => pending(db, a));
  return {
    candidate: candidate.id,
    revision: candidate.revision,
    environment: env.id,
    name: env.name,
    config: { id: config.id, version: config.version, status: config.status, content: configContent(config) },
    repo,
    pending: pendingNow,
  };
}

// Artifact admission (D4 §3.1): whether a row of the project records the
// digest, and the bytes every row of the home records.
export function artifactAdmission(db: Db, args: { project: string; digest: string }): { recorded: boolean; total: number } {
  const recorded = getArtifact(db, args.project, args.digest) !== undefined;
  const { total } = db.prepare('SELECT COALESCE(SUM("bytes"), 0) AS total FROM "artifacts"').get() as { total: number };
  return { recorded, total };
}

// Every recorded artifact's path, and whether the project has any (the
// start sweep's and a request's cleanup's read).
export function artifactPaths(db: Db): string[] {
  return (db.prepare('SELECT "path" FROM "artifacts"').all() as { path: string }[]).map((r) => r.path);
}

// Every artifact row's project, digest and path (the start sweep's read).
export function artifactRows(db: Db): { project: string; digest: string; path: string }[] {
  return db.prepare('SELECT "project", "digest", "path" FROM "artifacts"').all() as { project: string; digest: string; path: string }[];
}

// An artifact refused at the request (D4 §3.1, A.2): the bound recorded on
// `artifact.failed`; no row, since no sealed bytes exist.
export function artifactRefused(tx: Tx, args: { project: string; refusal: string; detail: Record<string, unknown>; candidate: string; environment: string }): void {
  tx.emit('artifact.failed', { project: args.project, candidate: args.candidate, environment: args.environment }, { refusal: args.refusal, ...args.detail });
}

export type Evaluate = (tx: Tx, a: Record<string, unknown>) => { evaluation: { id: string; outcome: string; reasons: unknown[] } };

// POST /v1/projects/:p/deployments (D4 §4.1). In one transaction after the
// artifact is sealed: the request coalesced with a pending deployment of the
// candidate and environment; otherwise the artifact and its mapping
// recorded, the authorization proposed with the engine-derived binding (a
// proposed row of the same binding re-evaluated in its generation) and
// `alpha_authorize` evaluated for it; satisfied, the `deploy` work item
// created.
export function requestDeployment(tx: Tx, args: RequestArgs, evaluate: Evaluate): CommandResult {
  const candidate = getCandidate(tx.db, args.candidate);
  if (!candidate || candidate.project !== args.project) throw notFound('candidate', args.candidate);
  const env = environmentByName(tx.db, args.project, args.environment);
  if (!env || env.prefix === null) throw notFound('environment', args.environment);
  const config = currentConfig(tx.db, env);
  if (!config) throw notFound('environment configuration', args.environment);
  const all = tx.db.prepare('SELECT * FROM "deployment_authorizations" WHERE "candidate" = ? AND "environment" = ? ORDER BY "generation", rowid').all(candidate.id, env.id) as AuthRow[];
  const workOf = (auth: string) =>
    tx.db.prepare(`SELECT "id", "status" FROM "work_items" WHERE "project" = ? AND "trigger_source" = 'deployment_request' AND "trigger_id" = ? AND "trigger_generation" = 1`).get(args.project, auth) as
      | { id: string; status: string }
      | undefined;
  const answer = (status: number, a: AuthRow, evaluation: unknown): CommandResult => {
    const now = tx.db.prepare('SELECT * FROM "deployment_authorizations" WHERE "id" = ?').get(a.id) as AuthRow;
    const w = workOf(a.id);
    return {
      status,
      body: {
        authorization: { id: now.id, status: now.status, generation: now.generation, artifact_digest: now.artifact_digest, config_identity: now.config_identity, target_set: JSON.parse(now.target_set) as string[] },
        work_item: w ? { id: w.id, status: w.status } : null,
        evaluation,
      },
      effects: [{ kind: 'tick' as const }],
    };
  };
  // Coalescing (J3): while the candidate and environment have a deployment
  // pending, a request is answered with it and creates nothing.
  const pendingRow = all.find((a) => pending(tx.db, a));
  const requestedBy = args.requested_by ?? 'human';
  const key = requestKey(tx.db, { project: args.project, candidate: candidate.id, config: config.id });
  if (requestedBy === 'policy') {
    // The same key admits no second request (B14), and the policy's request
    // derives its own authorization: it never joins a pending one (M407 (h)).
    const existing = requestOfKey(tx.db, args.project, key);
    if (existing && !preparing(existing)) return { status: 200, body: { request: null, skipped: 'requested' } };
    // Re-prepared under its key after an unexpected error: one more preparation counted.
    if (existing) tx.db.prepare('UPDATE "deployment_requests" SET "preparation_attempts" = "preparation_attempts" + 1 WHERE "id" = ?').run(existing.id);
    if (pendingRow) return { status: 200, body: { request: null, skipped: 'pending' } };
  }
  const record = (auth: string, outcome: string) =>
    recordRequest(tx, { project: args.project, key, requested_by: requestedBy, candidate: candidate.id, environment: env.id, authorization: auth, work_item: workOf(auth)?.id ?? null, outcome });
  // An authorization issued while the adapter was qualified, whose row has
  // lapsed since: refused before any intent, the authorization not consumed
  // (D4 §2.6, A.6; the driver's ruling on M338 (d); SEAM.md §324).
  if (pendingRow && pendingRow.status === 'issued' && qualificationFor(tx.db, env) === undefined) {
    const content = configContent(config);
    throw new Refusal(409, 'adapter_unqualified', `The ${env.name} deployment of candidate ${candidate.id} is authorized, but no adapter qualification of ${content.adapter} ${content.adapter_version} is current on this engine and host.`, 'Run `surety qualify-adapter ' + content.adapter + '`, then request the deployment again; nothing was intended.', {
      authorization: pendingRow.id,
      environment: env.id,
      adapter: content.adapter,
      adapter_version: content.adapter_version,
    });
  }
  if (pendingRow) {
    record(pendingRow.id, 'pending');
    const ev = pendingRow.evaluation === null ? undefined : (tx.db.prepare('SELECT "id", "outcome", "reasons" FROM "gate_evaluations" WHERE "id" = ?').get(pendingRow.evaluation) as { id: string; outcome: string; reasons: string } | undefined);
    return answer(200, pendingRow, ev ? { id: ev.id, gate_kind: 'alpha_authorize', outcome: ev.outcome, reasons: JSON.parse(ev.reasons) as unknown } : null);
  }
  if (config.status === 'secrets_changed') {
    throw new Refusal(409, 'config_secrets_changed', `A secret the current configuration of ${env.name} names has a value other than its version records.`, 'Write a new configuration version, then request the deployment again.', {
      environment: env.id,
      config: config.id,
    });
  }
  if (args.sealed === null) {
    // Prepared as a coalescing request, and nothing is pending any more: the
    // request is made again, and seals then.
    throw new Refusal(409, 'illegal_transition', `The ${env.name} deployment of candidate ${candidate.id} that this request would have joined ended while it was prepared.`, 'Request the deployment again.', {
      candidate: candidate.id,
      environment: env.id,
    });
  }
  const artifact = recordArtifact(tx, args.project, args.sealed);
  const mapping = recordMapping(tx, { project: args.project, artifact: artifact.id, revision: candidate.revision, config: config.id, spec: args.specFingerprint, builder: args.builder });
  const binding: Binding = { environment: env.id, artifact_digest: artifact.digest, mapping, config_identity: config.config_identity, target_set: targetsOf(config) };
  const bkey = bindingKey(binding);
  const proposed = all.find((a) => a.status === 'proposed' && bindingKey(bindingOf(a)) === bkey);
  const auth = proposed ?? insertAuthorization(tx, { project: args.project, candidate, binding, generation: (all.at(-1)?.generation ?? 0) + 1 });
  const { evaluation } = evaluate(tx, { ...args.facts, project: args.project, candidate: candidate.id, kind: 'alpha_authorize', authorization: auth.id });
  const now = tx.db.prepare('SELECT * FROM "deployment_authorizations" WHERE "id" = ?').get(auth.id) as AuthRow;
  if (now.status !== 'issued') {
    // The refused request keeps its evaluation on the proposed row (A.3:
    // the outcome and its reasons retained, SEAM.md §354).
    tx.db.prepare(`UPDATE "deployment_authorizations" SET "evaluation" = ? WHERE "id" = ? AND "status" = 'proposed'`).run(evaluation.id, auth.id);
    // The policy's request refused only for what is still settling (a git
    // operation of the project's journal in flight, a pending read): no
    // outcome is recorded under its key, so the next tick requests again
    // (under D6 K2 another run's integration is often in flight; a
    // not_issued here would end the policy's deployment for good).
    const reasons = (evaluation.reasons as { code: string; subjects?: string[] }[] | undefined) ?? [];
    const settling = reasons.length > 0 && reasons.every((r) => typeof r.code === 'string' && (r.code.endsWith('_PENDING') || settlingAfterChange(tx.db, candidate.id, r)));
    if (requestedBy === 'policy' && settling) {
      return {
        status: 409,
        body: {
          code: 'authorization_not_issued',
          reason: `The ${env.name} deployment of candidate ${candidate.id} is not authorized yet: ${reasons.map((r) => r.code).join(', ')}; the policy requests it again at the next tick.`,
          what_to_do: 'Nothing: the policy requests it again once the pending work settles.',
          subject: { authorization: auth.id, evaluation: evaluation.id, reasons: evaluation.reasons },
        },
      };
    }
    record(auth.id, 'not_issued');
    return {
      status: 409,
      body: {
        code: 'authorization_not_issued',
        reason: `The ${env.name} deployment of candidate ${candidate.id} is not authorized: alpha_authorize is not satisfied.`,
        what_to_do: 'Read the reasons, satisfy them, and request the deployment again.',
        subject: { authorization: auth.id, evaluation: evaluation.id, reasons: evaluation.reasons },
      },
    };
  }
  observeTrigger(
    tx,
    {
      project: args.project,
      kind: 'deploy',
      trigger_source: 'deployment_request',
      trigger_id: auth.id,
      trigger_generation: 1,
      subject: { candidate: candidate.id, environment: env.id, authorization: auth.id },
      engineRaised: true,
    },
    {},
  );
  record(auth.id, 'pending');
  return answer(201, now, evaluation);
}

// An issuance supersedes, beside an issued authorization of the candidate
// and environment, a consumed one whose operation has made no attempt yet:
// its effect has not begun, and its precondition then fails (D4 §4.1).
export function supersedeUnattempted(tx: Tx, auth: { id: string; project: string; candidate: string; environment: string }): void {
  const rows = tx.db
    .prepare(`SELECT "id" FROM "deployment_authorizations" WHERE "candidate" = ? AND "environment" = ? AND "status" = 'consumed' AND "id" <> ?`)
    .all(auth.candidate, auth.environment, auth.id) as { id: string }[];
  for (const r of rows) {
    const op = operationOf(tx.db, r.id);
    if (!op || op.orchestration_stage === 'ended' || attemptsOf(tx.db, op.id).length > 0) continue;
    assertEdge('AuthorizationStatus', 'consumed', 'superseded', { authorization: r.id });
    tx.db.prepare(`UPDATE "deployment_authorizations" SET "status" = 'superseded' WHERE "id" = ?`).run(r.id);
    tx.emit('authorization.superseded', { project: auth.project, candidate: auth.candidate, authorization: r.id }, { by: auth.id });
  }
}

// ---- the environment lease (J2, J9; D4 §4.7) --------------------------------------------------

interface LeaseRow {
  id: string;
  resource_id: string;
  generation: number;
  released_at: string | null;
}

export const environmentLease = (db: Db, env: string): LeaseRow | undefined =>
  db.prepare(`SELECT * FROM "leases" WHERE "resource_kind" = 'environment' AND "resource_id" = ? AND "released_at" IS NULL`).get(env) as LeaseRow | undefined;

function takeLease(tx: Tx, env: string, incarnation: string, until: string): LeaseRow {
  const { g } = tx.db.prepare(`SELECT COALESCE(MAX("generation"), 0) + 1 AS g FROM "leases" WHERE "resource_kind" = 'environment' AND "resource_id" = ?`).get(env) as { g: number };
  const id = tx.newId('lease_');
  tx.db
    .prepare(
      `INSERT INTO "leases" ("id", "created_at", "resource_kind", "resource_id", "owner_incarnation", "generation", "acquired_at", "renewed_at", "expires_at", "released_at", "closing", "cleanup_authority")
       VALUES (?, ?, 'environment', ?, ?, ?, ?, ?, ?, NULL, 0, 0)`,
    )
    .run(id, tx.at, env, incarnation, g, tx.at, tx.at, until);
  return tx.db.prepare('SELECT * FROM "leases" WHERE "id" = ?').get(id) as LeaseRow;
}

const releaseLease = (tx: Tx, frozen: FrozenIntent): void => {
  tx.db.prepare('UPDATE "leases" SET "released_at" = ? WHERE "id" = ? AND "released_at" IS NULL').run(tx.at, frozen.lease.id);
};

// Every environment lease an operation holds: the one its intent took, and
// any a later round of it took again (CD1; SEAM.md §§267, 269).
function operationLeases(db: Db, op: OpRow): LeaseRow[] {
  const frozen = frozenOf(op);
  return db
    .prepare(
      `SELECT * FROM "leases" WHERE "resource_kind" = 'environment' AND "resource_id" = ? AND "released_at" IS NULL
         AND ("id" = ? OR "generation" IN (SELECT "lease" FROM "verification_rounds" WHERE "operation" = ? AND "lease" IS NOT NULL))`,
    )
    .all(frozen.environment, frozen.lease.id, op.id) as LeaseRow[];
}

const releaseOperationLeases = (tx: Tx, op: OpRow): void => {
  releaseLease(tx, frozenOf(op));
  for (const l of operationLeases(tx.db, op)) tx.db.prepare('UPDATE "leases" SET "released_at" = ? WHERE "id" = ? AND "released_at" IS NULL').run(tx.at, l.id);
};

// ---- the deploy journal (J1) ------------------------------------------------------------------

type JState = 'intended' | 'applied' | 'confirmed' | 'failed' | 'ambiguous' | 'finalized';
const J_EDGES: Record<JState, JState[]> = {
  intended: ['applied', 'failed', 'ambiguous'],
  applied: ['confirmed', 'ambiguous'],
  confirmed: ['finalized'],
  ambiguous: ['applied', 'failed'],
  failed: [],
  finalized: [],
};

const journalOf = (db: Db, op: string): { journal_kind: string; state: JState; last_event_seq: number } | undefined =>
  db.prepare('SELECT "journal_kind", "state", "last_event_seq" FROM "deploy_journal_state" WHERE "operation" = ?').get(op) as { journal_kind: string; state: JState; last_event_seq: number } | undefined;

function journalAppend(tx: Tx, op: OpRow, to: JState, payload: Record<string, unknown> = {}): void {
  const j = journalOf(tx.db, op.id)!;
  if (j.state === to) return;
  if (!J_EDGES[j.state].includes(to)) throw illegal(`deploy journal ${j.state} → ${to}`, { operation: op.id, from: j.state, to });
  const seq = j.last_event_seq + 1;
  tx.db
    .prepare('INSERT INTO "deploy_journal_events" ("id", "created_at", "project", "operation", "seq", "journal_kind", "event_kind", "payload") VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(tx.newId('dje_'), tx.at, op.project, op.id, seq, j.journal_kind, to, JSON.stringify(payload));
  tx.db.prepare('UPDATE "deploy_journal_state" SET "state" = ?, "last_event_seq" = ? WHERE "operation" = ?').run(to, seq, op.id);
  if (to !== 'failed') tx.emit(`deploy.journal_${to}` as const, { project: op.project, operation: op.id }, { journal_kind: j.journal_kind, seq });
}

// The operation's status from its latest attempt and its journal (as git's,
// journal.ts deriveStatus), with an event for a status that is new.
function refreshOp(tx: Tx, id: string): string {
  const op = getOp(tx.db, id)!;
  // Superseded by a preempting teardown (D1 A.5; D4 §4.6): final.
  if (op.status === 'superseded') return op.status;
  const j = journalOf(tx.db, id)!;
  const latest = attemptsOf(tx.db, id).at(-1)?.status ?? null;
  let status: string;
  if (latest === 'succeeded' || latest === 'reconciled_succeeded') status = 'succeeded';
  else if (j.state === 'failed') status = 'failed';
  else if (latest === null) status = j.state === 'ambiguous' ? 'ambiguous' : 'intended';
  else if (latest === 'started') status = 'in_progress';
  else if (latest === 'failed') status = 'failed';
  else if (latest === 'ambiguous') status = 'ambiguous';
  else if (latest === 'reconciled_partial') status = 'partial';
  else status = 'intended';
  if (status !== op.status) {
    tx.db.prepare('UPDATE "operations" SET "status" = ? WHERE "id" = ?').run(status, id);
    const type = ({ succeeded: 'operation.succeeded', failed: 'operation.failed', partial: 'operation.partial', ambiguous: 'operation.ambiguous' } as const)[status as 'succeeded'];
    if (type) tx.emit(type, { project: op.project, operation: id }, { journal_kind: j.journal_kind, from: op.status });
  }
  return status;
}

function setAttempt(tx: Tx, a: AttemptRow, status: string, read?: { outcome: string; read: unknown }): void {
  const reads = JSON.parse(a.reconciliation_reads) as { at: string; read: unknown; result: string }[];
  // A read made again at every tick that found exactly what the last one
  // found is not recorded again (the attempt's record would otherwise grow
  // by one copy of the same inventory per tick).
  const last = reads.at(-1) as ({ at: string; read: unknown; result: string; last_at?: string } | undefined);
  if (read && last && last.result === read.outcome && canonical(last.read) === canonical(read.read)) last.last_at = tx.at;
  else if (read) reads.push({ at: tx.at, read: read.read, result: read.outcome });
  tx.db
    .prepare(`UPDATE "operation_attempts" SET "status" = ?, "finished_at" = CASE WHEN ? = 'started' THEN NULL ELSE COALESCE("finished_at", ?) END, "reconciliation_reads" = ? WHERE "id" = ?`)
    .run(status, status, tx.at, JSON.stringify(reads), a.id);
  a.status = status;
  a.reconciliation_reads = JSON.stringify(reads);
}

const openBlocker = (db: Db, op: string): DecisionRow | undefined =>
  db.prepare(`SELECT * FROM "decisions" WHERE "kind" = 'blocker' AND "subject_type" = 'operation' AND "subject_id" = ? AND "status" = 'open'`).get(op) as DecisionRow | undefined;

function block(tx: Tx, op: OpRow, outcome: string): void {
  if (openBlocker(tx.db, op.id)) return;
  void outcome;
  // The question is the preview's (deployBlockerPreview), which names the
  // outcome read.
  raiseQuestion(tx, { project: op.project, kind: 'blocker', subjectType: 'operation', subjectId: op.id });
}

// What a blocker on an operation says of the outcome read (D4 §§2.4, 4.6).
function blockerQuestion(op: OpRow, outcome: string): string {
  const head = `Operation ${op.id} (${op.kind} of ${frozenOf(op).environment_name}) cannot go on: `;
  if (outcome === 'partial') {
    return (
      head +
      'the reconcile read found its effect partial: owned resources of the environment survive the teardown. Nothing more is stopped by itself; it is read again at every tick, and is applied once a read finds every resource it covers gone. ' +
      'Tear the environment down again to stop what the engine owns of it.'
    );
  }
  return (
    head +
    `the reconcile read found its effect ${outcome}. ` +
    'Nothing is retried, completed or finalized, and nothing found is stopped, until a read can tell what the target holds; it is read again at every tick. ' +
    'Tear the environment down to stop what the engine owns of it.'
  );
}

function closeBlocker(tx: Tx, op: string, why: string): void {
  const d = openBlocker(tx.db, op);
  if (d) invalidateDecision(tx, d, why);
}

// The blocker an ambiguous deploy or teardown operation holds (queue.ts).
// Its manifest names the outcome the last read gave and what that read
// listed (SEAM.md §276); a deploy's `partial` is `rollout_partial`'s, and an
// operation whose orchestration ended blocks nothing.
export function deployBlockerPreview(db: Db, id: string): { manifest: Record<string, unknown>; question: string; environment: string } | null {
  const op = getOp(db, id);
  const j = op ? journalOf(db, id) : undefined;
  if (!op || !j || j.state !== 'ambiguous' || op.orchestration_stage === 'ended') return null;
  const latest = attemptsOf(db, id).at(-1);
  if (op.kind === 'deploy' && latest?.status === 'reconciled_partial') return null;
  const last = latest ? lastRead(latest) : null;
  const outcome = last?.result ?? 'unknown';
  const frozen = frozenOf(op);
  return {
    manifest: {
      operation: op.id,
      journal_kind: j.journal_kind,
      subject_status: j.state,
      cause: `effect_${outcome}`,
      quarantined: false,
      evidence: { attempt: latest?.id ?? null, read: outcome, complete: last?.read?.complete ?? null, inventory: inventoryNames(last?.read) },
      continuation: null,
    },
    question: blockerQuestion(op, outcome),
    environment: frozen.environment,
  };
}

// The state a reconcile read found, as `rollout_partial` binds it: its
// outcome, completeness and each entry of its inventory.
function reconciledOf(a: AttemptRow): { outcome: string | null; complete: boolean | null; inventory: { resource: string | null; kind: string | null; state: string | null; pending_job: unknown; generation: unknown; cgroup: unknown; invocation: unknown; instance: unknown }[] } {
  const last = lastRead(a);
  const inv = (last?.read?.inventory ?? []) as { resource?: string; kind?: string; state?: string; pending_job?: unknown; generation?: unknown; cgroup?: unknown; invocation?: unknown; instance?: unknown }[];
  return {
    outcome: last?.result ?? null,
    complete: last?.read?.complete ?? null,
    inventory: inv.map((e) => ({
      resource: e.resource ?? null,
      kind: e.kind ?? null,
      state: e.state ?? null,
      pending_job: e.pending_job ?? null,
      generation: e.generation ?? null,
      cgroup: e.cgroup ?? null,
      invocation: e.invocation ?? null,
      instance: e.instance ?? null,
    })),
  };
}

// The newest reconcile read recorded on an attempt.
function lastRead(a: AttemptRow): { result: string; read: { complete?: boolean; inventory?: { resource?: string; kind?: string; state?: string; pending_job?: unknown; generation?: unknown }[] } | null } | null {
  const reads = JSON.parse(a.reconciliation_reads) as { result: string; read: unknown }[];
  const r = reads.at(-1);
  return r ? { result: r.result, read: (r.read ?? null) as never } : null;
}

const inventoryNames = (read: { inventory?: { resource?: string; kind?: string }[] } | null | undefined) =>
  Array.isArray(read?.inventory) ? read!.inventory.map((e) => ({ resource: e.resource ?? null, kind: e.kind ?? null })) : null;

// ---- rollout_partial, and the preempting teardown (D4 §§4.4, 4.6; E112; SEAM.md §276) ----------------

// The question a deploy reconciled `partial` asks (D1 A.8; D4 §4.4): retry
// the bounded remaining effects, tear down, or abandon. Its manifest binds
// what the retry's effects were derived from, so a change to any of them
// stales it (BS §6 correction 22). null: the question does not stand.
export function rolloutPartialPreview(
  db: Db,
  id: string,
): { manifest: Record<string, unknown>; options: { key: string; label: string; consequence: string; effect: Record<string, unknown> }[]; question: string } | null {
  const op = getOp(db, id);
  const j = op ? journalOf(db, id) : undefined;
  if (!op || !j || op.kind !== 'deploy' || j.state !== 'ambiguous' || op.orchestration_stage === 'ended') return null;
  const attempts = attemptsOf(db, id);
  const latest = attempts.at(-1);
  if (!latest || latest.status !== 'reconciled_partial') return null;
  const frozen = frozenOf(op);
  const env = getEnv(db, frozen.environment)!;
  const lease = environmentLease(db, env.id);
  const config = currentConfig(db, env);
  const q = qualificationOf(db, frozen.adapter, frozen.adapter_version);
  // A retry already consumed for this attempt, whose state still holds, asks
  // nothing again.
  if (retryApproved(db, id, latest) !== null) return null;
  const reconciled = reconciledOf(latest);
  const inventory = reconciled.inventory;
  // The units of this operation's attempts, by the attempt that created them.
  const byUnit = new Map<string, string>();
  for (const a of attempts) {
    const intent = db.prepare('SELECT "create_units" FROM "attempt_intents" WHERE "attempt" = ?').get(a.id) as { create_units: string } | undefined;
    for (const u of intent ? (JSON.parse(intent.create_units) as string[]) : []) byUnit.set(u, a.id);
  }
  // The cleanup: every unit this operation's attempts created, each with its
  // attempt (D4 A.3), whether or not the read still found it (one gone is
  // nothing to stop); what the read found of them is the observation the
  // preview binds.
  // Each with what the read found of it (D4 §4.4: the resource identities):
  // its cgroup, invocation and application instance, null where it found
  // nothing.
  const resources = [...byUnit.entries()].map(([resource, attempt]) => {
    const e = inventory.find((x) => x.kind === 'unit' && x.resource === resource);
    return { resource, attempt, cgroup: e?.cgroup ?? null, invocation: e?.invocation ?? null, instance: e?.instance ?? null };
  });
  const present = inventory.filter((e) => e.kind !== null && typeof e.resource === 'string' && (byUnit.has(e.resource) || attemptGenerations(attempts).includes(e.generation as number)));
  const next = unitName(frozen.prefix, env.deployment_generation + 1);
  const stop = recordedUnits(db, env.id);
  return {
    manifest: {
      operation: op.id,
      operation_status: op.status,
      attempt: latest.id,
      deployment_generation: latest.deployment_generation,
      environment_generation: { current: env.current_generation, allocated: env.deployment_generation },
      lease_generation: lease?.generation ?? null,
      config_identity: config?.config_identity ?? null,
      config_version: config?.id ?? null,
      adapter_qualification: q?.id ?? null,
      reconciled,
      resources,
      observations: present,
    },
    options: [
      {
        key: 'retry',
        label: 'Retry',
        consequence: `A new attempt of the operation cleans up ${resources.length === 0 ? 'nothing' : resources.map((r) => r.resource).join(', ')} and starts ${next}, after its preconditions are read again.`,
        effect: { operation: op.id, cleanup: resources.map((r) => r.resource), create: [next] },
      },
      {
        key: 'teardown',
        label: 'Tear down',
        consequence: 'A teardown of the environment takes the lease from this deploy and stops only what the engine positively owns of it.',
        effect: { environment: env.id, teardown: { preempting: op.id, stop: stop } },
      },
      { key: 'abandon', label: 'Abandon', consequence: 'The operation ends failed; its authorization stays consumed; the lease is released. Nothing is rolled back.', effect: { operation: op.id, to: 'failed', code: 'abandoned' } },
    ],
    question:
      `Operation ${op.id} (deploy of ${frozen.environment_name}) was reconciled partial: attempt ${latest.attempt_number} took effect in part. ` +
      'Retry the bounded remaining effects, tear the environment down, or abandon the operation.',
  };
}

const attemptGenerations = (attempts: AttemptRow[]): number[] => attempts.map((a) => a.deployment_generation).filter((g): g is number => g !== null);

// The answer to `rollout_partial` (SEAM.md §276): `retry` is taken by the
// Release Operator at its next tick, with the preconditions read again;
// `teardown` preempts; `abandon` ends the operation `failed`, `abandoned`,
// the effect being quiescent (a `partial` read is only made after it).
export function answerRolloutPartial(tx: Tx, args: { operation: string; option: string }): { environment: string; executions: string[] } | null {
  const op = getOp(tx.db, args.operation)!;
  if (args.option === 'teardown') {
    const p = preemptTeardown(tx, { environment: frozenOf(op).environment, cause: `rollout_partial of ${op.id}` });
    return { environment: frozenOf(op).environment, executions: p.executions };
  }
  if (args.option === 'abandon') {
    const latest = attemptsOf(tx.db, op.id).at(-1);
    failOperation(tx, op, { code: 'abandoned', attempt: latest?.id ?? null });
  }
  return null;
}

// The preempting teardown (D4 §4.6; SEAM.md §296), from a decision's
// `teardown` option or `POST …/teardown {"preempt": true}`. One transaction,
// before any host call: the launch of every attempt of the environment
// closed, so no launcher can be authorized again; every queued or running
// execution of an open round of the environment cancelled and the round
// recorded `unknown` naming each; every operation of the environment whose
// orchestration has not ended (or that holds a round open) ended, its
// leases released: one with an attempt `superseded`, its attempts kept as
// they were; one with none `failed` naming `environment_lease` (the
// driver's ruling, answer 6); each `deploy.preempted`; the teardown intended
// under a new lease generation, its `linked_prior` the operation that held
// the lease. Its effect starts only once any call of the preempted attempt
// has settled (release-operator). Returns the executions to cancel on the
// main thread (the check runner's own supervisors).
export function preemptTeardown(tx: Tx, args: { environment: string; cause: string }): { operation: string; preempted: string[]; executions: string[] } {
  const env = getEnv(tx.db, args.environment);
  if (!env || env.prefix === null) throw notFound('environment', args.environment);
  const incarnation = engineSettings().incarnation;
  if (incarnation === undefined) throw illegal('a preempting teardown with no running incarnation', { environment: env.id });
  const ops = tx.db
    .prepare(
      `SELECT * FROM "operations" o WHERE json_extract(o."target", '$.environment') = ? AND o."kind" IN ('deploy', 'teardown')
         AND (o."orchestration_stage" IS NULL OR o."orchestration_stage" <> 'ended'
              OR EXISTS (SELECT 1 FROM "verification_rounds" r WHERE r."operation" = o."id" AND r."status" = 'open')) ORDER BY o."seq"`,
    )
    .all(env.id) as OpRow[];
  // The operation holding the environment lease, the teardown's linked_prior.
  const held = environmentLease(tx.db, env.id);
  const holder = ops.find((o) => operationLeases(tx.db, o).some((l) => l.id === held?.id)) ?? ops.at(-1) ?? null;
  // Every launch of the environment closed (D4 §4.6 step 2).
  const attempts = tx.db
    .prepare(
      `SELECT a.* FROM "operation_attempts" a JOIN "operations" o ON o."id" = a."operation"
       WHERE json_extract(o."target", '$.environment') = ? AND a."launch_state" IS NOT NULL AND a."launch_state" <> 'closed'`,
    )
    .all(env.id) as AttemptRow[];
  for (const a of attempts) closeAttemptLaunch(tx, a, 'preempted');
  const executions: string[] = [];
  for (const op of ops) {
    const open = tx.db.prepare(`SELECT * FROM "verification_rounds" WHERE "operation" = ? AND "status" = 'open'`).all(op.id) as RoundRow[];
    for (const r of open) {
      for (const id of roundExecutionIds(tx.db, r)) {
        const x = tx.db.prepare('SELECT "status" FROM "check_executions" WHERE "id" = ?').get(id) as { status: string } | undefined;
        const running = x !== undefined && x.status !== 'queued';
        if (cancelExecution(tx, { execution: id, why: 'a preempting teardown', live: true }) && running) executions.push(id);
      }
      finalizeRound(tx, { round: r.id, reads: null, failure: null, reason: 'preempted' });
    }
    closeBlocker(tx, op.id, 'a preempting teardown');
    closeRollout(tx, op.id, 'a preempting teardown');
  }
  // The lease passes to the teardown with a new generation: every lease the
  // preempted operations hold is released first.
  for (const op of ops) releaseOperationLeases(tx, op);
  const teardown = insertTeardown(tx, env, incarnation, holder?.id ?? null);
  const preempted: string[] = [];
  for (const op of ops) {
    if (op.orchestration_stage === 'ended') continue;
    const tried = attemptsOf(tx.db, op.id).length > 0;
    if (!tried && op.kind === 'deploy') {
      failOperation(tx, op, { code: 'EFFECT_PRECONDITION_CHANGED', fact: 'environment_lease', manifest: null, preempted_by: teardown.id });
    } else {
      endOperation(tx, op, 'cancelled', 'preempted');
      tx.db.prepare(`UPDATE "operations" SET "status" = 'superseded' WHERE "id" = ?`).run(op.id);
    }
    tx.emit('deploy.preempted', { project: op.project, operation: op.id, environment: env.id }, { teardown: teardown.id, cause: args.cause, attempt: attemptsOf(tx.db, op.id).at(-1)?.id ?? null });
    preempted.push(op.id);
  }
  bumpRevision(tx, env.id);
  return { operation: teardown.id, preempted, executions };
}

// The operation's way out (D4 §4.7): the lease released, the orchestration
// ended, and the deploy work item settled.
function endOperation(tx: Tx, op: OpRow, work: 'complete' | 'cancelled' | 'blocked' | 'none', cause: string, blockerFacts: Record<string, unknown> = {}): void {
  const f = frozenOf(op);
  if (op.orchestration_stage !== 'ended') bumpRevision(tx, f.environment);
  releaseOperationLeases(tx, op);
  tx.db.prepare(`UPDATE "operations" SET "orchestration_stage" = 'ended' WHERE "id" = ?`).run(op.id);
  settleRequest(tx, op, work === 'complete' ? 'deployed' : work === 'blocked' ? 'not_verified' : work === 'cancelled' && cause !== 'preempted' ? 'failed' : 'unknown');
  if (f.work_item === null || work === 'none') return;
  const item = getWorkItem(tx, f.work_item);
  if (!item || item.status === 'complete' || item.status === 'cancelled') return;
  if (work === 'complete') {
    let it = item;
    if (it.status === 'awaiting_decision') it = transitionWork(tx, it, 'executing', { blocker: null }, { cause: 'completion', operation: op.id });
    transitionWork(tx, it, 'complete', { blocker: null }, { operation: op.id, cause });
  } else if (work === 'cancelled') {
    transitionWork(tx, item, 'cancelled', { blocker: null }, { operation: op.id, cause });
  } else if (item.status === 'executing') {
    const waiting = transitionWork(tx, item, 'awaiting_decision', { blocker: JSON.stringify({ reason: cause, raised_at: tx.at, decision: null, operation: op.id, ...blockerFacts }) }, { operation: op.id, cause });
    // D4 §4.7: the work item waits on a blocker that names the cause and
    // offers what applies (re-verification, abandonment of completion, the
    // preempting teardown): a decision, never a blocker with none (the
    // driver's ruling 2 on M401, slice 37). With nothing to decide, the work
    // ends with its reason.
    if (raiseQuestion(tx, { project: op.project, kind: 'blocker', subjectType: 'work_item', subjectId: waiting.id }) === null) {
      transitionWork(tx, getWorkItem(tx, waiting.id)!, 'cancelled', { blocker: null }, { operation: op.id, cause });
    }
  }
}

// What a deploy work item waiting on a refused completion is offered (D4
// §4.7; the driver's ruling 2 on M401, slice 37), or null when it is not
// such an item: its operation and environment, and whether re-verification
// can succeed: the operation a finalized deploy whose latest attempt
// succeeded on the environment's current generation (as POST …/verify
// requires), and its candidate not superseded (D4 §5.5 refuses
// alpha_complete for a superseded candidate).
export function refusedCompletionFacts(db: Db, item: { kind: string; status: string; blocker: string | null }): { operation: string; environment: string; environment_name: string; candidate: string | null; reverify: boolean; cause: string } | null {
  if (item.kind !== 'deploy' || item.status !== 'awaiting_decision' || item.blocker === null) return null;
  const blocker = JSON.parse(item.blocker) as { reason?: string; operation?: string };
  if (typeof blocker.reason !== 'string' || !blocker.reason.startsWith('deploy_completion_refused') || typeof blocker.operation !== 'string') return null;
  const op = getOp(db, blocker.operation);
  if (!op) return null;
  const frozen = frozenOf(op);
  const j = journalOf(db, op.id);
  const latest = attemptsOf(db, op.id).at(-1);
  const env = getEnv(db, frozen.environment);
  const candidate = frozen.candidate ? (db.prepare('SELECT "superseded_by" FROM "candidates" WHERE "id" = ?').get(frozen.candidate) as { superseded_by: string | null } | undefined) : undefined;
  const reverify =
    op.kind === 'deploy' &&
    j?.state === 'finalized' &&
    latest !== undefined &&
    (latest.status === 'succeeded' || latest.status === 'reconciled_succeeded') &&
    env !== undefined &&
    env.current_generation === latest.deployment_generation &&
    candidate !== undefined &&
    candidate.superseded_by === null;
  return { operation: op.id, environment: frozen.environment, environment_name: frozen.environment_name, candidate: frozen.candidate, reverify, cause: blocker.reason };
}

// An operation that ends `failed` with nothing applied: the journal failed,
// its detail recorded, the authorization staying consumed (D4 §4.1).
function failOperation(tx: Tx, op: OpRow, detail: Record<string, unknown>): void {
  const j = journalOf(tx.db, op.id)!;
  if (j.state === 'applied') journalAppend(tx, op, 'ambiguous');
  if (journalOf(tx.db, op.id)!.state !== 'failed') journalAppend(tx, op, 'failed', detail);
  tx.db.prepare('UPDATE "operations" SET "outcome_detail" = ? WHERE "id" = ?').run(JSON.stringify(detail), op.id);
  closeBlocker(tx, op.id, 'the operation failed');
  refreshOp(tx, op.id);
  endOperation(tx, op, 'cancelled', String(detail.code ?? 'failed'));
}

// ---- the intent (D4 §4.1) -----------------------------------------------------------------------

// What the Release Operator takes on at a tick: deploy work to intend,
// teardowns asked for, and operations whose orchestration has not ended.
export function deployWork(db: Db, args: { project: string }): { intend: { work_item: string }[]; teardowns: string[]; drive: string[] } {
  const intend = (
    db
      .prepare(`SELECT "id" FROM "work_items" WHERE "project" = ? AND "kind" = 'deploy' AND "status" = 'eligible' AND "trigger_source" = 'deployment_request' ORDER BY "seq"`)
      .all(args.project) as { id: string }[]
  ).map((w) => ({ work_item: w.id }));
  const teardowns = (db.prepare('SELECT "id" FROM "environments" WHERE "project" = ? AND "teardown_requested_at" IS NOT NULL ORDER BY rowid').all(args.project) as { id: string }[]).map(
    (r) => r.id,
  );
  const drive = (
    db
      .prepare(
        `SELECT o."id" FROM "operations" o JOIN "deploy_journal_state" s ON s."operation" = o."id"
         WHERE o."project" = ? AND json_extract(o."finalizer_inputs", '$.qualification') IS NULL
           AND (o."orchestration_stage" IS NULL OR o."orchestration_stage" <> 'ended'
           OR EXISTS (SELECT 1 FROM "verification_rounds" r WHERE r."operation" = o."id" AND r."status" = 'open')) ORDER BY o."seq"`,
      )
      .all(args.project) as { id: string }[]
  ).map((r) => r.id);
  return { intend, teardowns, drive };
}

const addSeconds = (iso: string, seconds: number) => new Date(Date.parse(iso) + seconds * 1000).toISOString();

function insertOperation(tx: Tx, args: { project: string; kind: 'deploy' | 'teardown'; env: EnvRow; subject: Record<string, unknown>; key: string; frozen: FrozenIntent; deadline: string; authorization: string | null }): OpRow {
  const id = tx.newId('op_');
  tx.db
    .prepare(
      `INSERT INTO "operations" ("id", "created_at", "project", "seq", "kind", "target", "subject", "idempotency_key", "semantic_generation", "status",
         "deadline_at", "finalizer_inputs", "orchestration_deadline_at", "orchestration_stage", "authorization")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'intended', ?, ?, ?, 'effect', ?)`,
    )
    .run(
      id,
      tx.at,
      args.project,
      nextSeq(tx, args.project, 'operations'),
      args.kind,
      JSON.stringify({ environment: args.env.id }),
      JSON.stringify(args.subject),
      args.key,
      args.deadline,
      JSON.stringify(args.frozen),
      args.deadline,
      args.authorization,
    );
  const journalKind = args.kind === 'deploy' ? 'deploy_apply' : 'teardown_apply';
  const payload = { environment: args.env.id, authorization: args.authorization, artifact_digest: args.frozen.artifact_digest };
  tx.db
    .prepare(`INSERT INTO "deploy_journal_events" ("id", "created_at", "project", "operation", "seq", "journal_kind", "event_kind", "payload") VALUES (?, ?, ?, ?, 1, ?, 'intended', ?)`)
    .run(tx.newId('dje_'), tx.at, args.project, id, journalKind, JSON.stringify(payload));
  tx.db
    .prepare(`INSERT INTO "deploy_journal_state" ("id", "created_at", "project", "operation", "journal_kind", "state", "last_event_seq") VALUES (?, ?, ?, ?, ?, 'intended', 1)`)
    .run(tx.newId('djs_'), tx.at, args.project, id, journalKind);
  tx.emit('operation.intended', { project: args.project, operation: id, environment: args.env.id }, { kind: args.kind, journal_kind: journalKind });
  tx.emit('deploy.journal_intended', { project: args.project, operation: id }, { journal_kind: journalKind, seq: 1 });
  return getOp(tx.db, id)!;
}

// The Release Operator intends the deploy (D4 §4.1): under the environment
// lease, one transaction records the operation, consumes the authorization,
// freezes the operation's intent and starts its orchestration deadline. One
// authorization makes at most one operation (the consumption and the
// operation are this transaction; a unique index holds it).
export function intendDeploy(tx: Tx, args: { workItem: string; incarnation: string }): { operation: string } | { busy: string } | { skipped: string } {
  const item = getWorkItem(tx, args.workItem);
  if (!item || item.kind !== 'deploy' || item.status !== 'eligible' || item.trigger_source !== 'deployment_request') return { skipped: 'not eligible deploy work' };
  const auth = tx.db.prepare('SELECT * FROM "deployment_authorizations" WHERE "id" = ?').get(item.trigger_id) as AuthRow | undefined;
  if (!auth || auth.project !== item.project) return { skipped: 'no authorization' };
  if (auth.status !== 'issued') {
    // Superseded before its intent: nothing is deployed.
    if (auth.status === 'superseded') transitionWork(tx, item, 'cancelled', { blocker: null }, { cause: 'authorization_superseded', authorization: auth.id });
    return { skipped: `authorization ${auth.status}` };
  }
  const env = getEnv(tx.db, auth.environment)!;
  // No current adapter qualification: refused before its intent, held
  // `adapter_unqualified` (D4 §2.6, A.2's WorkItem hold; SEAM.md §324); the
  // authorization is not consumed and no intent is written. A qualification
  // current again lets a later tick intend it.
  if (qualificationFor(tx.db, env) === undefined) {
    if (parseJson<{ reason?: string }>(item.blocker)?.reason !== 'adapter_unqualified') {
      tx.db.prepare('UPDATE "work_items" SET "blocker" = ? WHERE "id" = ?').run(JSON.stringify({ reason: 'adapter_unqualified', raised_at: tx.at, decision: null, adapter: env.adapter }), item.id);
    }
    return { skipped: 'adapter_unqualified' };
  }
  const held = environmentLease(tx.db, env.id);
  if (held) {
    if (parseJson<{ reason?: string }>(item.blocker)?.reason !== 'environment_busy') {
      tx.db.prepare('UPDATE "work_items" SET "blocker" = ? WHERE "id" = ?').run(JSON.stringify({ reason: 'environment_busy', raised_at: tx.at, decision: null, lease: held.id }), item.id);
    }
    return { busy: held.id };
  }
  const config = tx.db.prepare('SELECT * FROM "environment_configs" WHERE "environment" = ? AND "config_identity" = ? ORDER BY "version" DESC LIMIT 1').get(env.id, auth.config_identity) as ConfigRow | undefined;
  const content = config ? configContent(config) : null;
  const mapping = (JSON.parse(auth.source_delivery_mapping) as { mapping?: string }).mapping ?? null;
  const artifact = getArtifact(tx.db, item.project, auth.artifact_digest);
  const deadline = addSeconds(tx.at, projectPolicy(tx.db, item.project).deploy_orchestration_deadline!);
  const lease = takeLease(tx, env.id, args.incarnation, deadline);
  const frozen: FrozenIntent = {
    purpose: 'deploy',
    work_item: item.id,
    authorization: auth.id,
    candidate: auth.candidate,
    mapping,
    artifact_digest: auth.artifact_digest,
    artifact_path: artifact?.path ?? null,
    manifest: artifact ? (JSON.parse(artifact.manifest) as unknown[]) : null,
    config_version: config?.id ?? null,
    config_number: config?.version ?? null,
    config_identity: auth.config_identity,
    secret_digests: config ? (JSON.parse(config.secret_digests) as { ref: string; digest: string }[]) : [],
    target_set: JSON.parse(auth.target_set) as string[],
    environment: env.id,
    environment_name: env.name,
    prefix: env.prefix ?? '',
    adapter: env.adapter,
    adapter_version: content?.adapter_version ?? null,
    runtime: content?.runtime ?? null,
    start: content?.start ?? null,
    lease: { id: lease.id, generation: lease.generation },
  };
  const op = insertOperation(tx, {
    project: item.project,
    kind: 'deploy',
    env,
    subject: { candidate: auth.candidate, artifact_digest: auth.artifact_digest },
    key: sha256(canonical({ kind: 'deploy', environment: env.id, authorization: auth.id, generation: 1 })),
    frozen,
    deadline,
    authorization: auth.id,
  });
  assertEdge('AuthorizationStatus', 'issued', 'consumed', { authorization: auth.id });
  tx.db.prepare(`UPDATE "deployment_authorizations" SET "status" = 'consumed' WHERE "id" = ?`).run(auth.id);
  tx.emit('authorization.consumed', { project: item.project, candidate: auth.candidate, authorization: auth.id }, { operation: op.id, environment: env.id });
  const claimed = transitionWork(tx, item, 'claimed', { blocker: null }, { operation: op.id, cause: 'release_operator' });
  transitionWork(tx, claimed, 'executing', {}, { operation: op.id });
  return { operation: op.id };
}

// POST /v1/projects/:p/environments/:e/teardown (D4 §4.6; SEAM.md §250): an
// ordinary teardown, by the operator's command, no gate; intended at a tick,
// under the environment lease.
// With `preempt` (D4 §4.6; SEAM.md §296): the preempting teardown, its
// transaction committed before the answer.
export function requestTeardown(tx: Tx, args: { project: string; environment: string; preempt?: boolean }): CommandResult {
  const env = environmentByName(tx.db, args.project, args.environment);
  if (!env || env.prefix === null) throw notFound('environment', args.environment);
  // The relay closes when a teardown is asked for, ordinary or preempting
  // (D4 §5.2; the slice-28 review, m3): its row here, its listener after the
  // commit.
  relayClosed(tx, { environment: env.id, reason: 'teardown' });
  const closeRelay = { kind: 'relay_closed' as const, environment: env.id };
  if (args.preempt === true) {
    const p = preemptTeardown(tx, { environment: env.id, cause: 'the operator\'s preempting teardown' });
    return {
      status: 202,
      body: { environment: { id: env.id, name: env.name }, teardown: { operation: p.operation, preempted: p.preempted } },
      effects: [closeRelay, { kind: 'tick' as const }, { kind: 'preempt' as const, environment: env.id, executions: p.executions }],
    };
  }
  if (env.teardown_requested_at === null) tx.db.prepare('UPDATE "environments" SET "teardown_requested_at" = ? WHERE "id" = ?').run(tx.at, env.id);
  return { status: 202, body: { environment: { id: env.id, name: env.name }, teardown: { requested_at: env.teardown_requested_at ?? tx.at } }, effects: [closeRelay, { kind: 'tick' as const }] };
}

export function intendTeardown(tx: Tx, args: { environment: string; incarnation: string }): { operation: string } | { busy: string } | { skipped: string } {
  const env = getEnv(tx.db, args.environment);
  if (!env || env.teardown_requested_at === null || env.prefix === null) return { skipped: 'no teardown asked for' };
  const held = environmentLease(tx.db, env.id);
  if (held) return { busy: held.id };
  return { operation: insertTeardown(tx, env, args.incarnation).id };
}

// A teardown operation of the environment, intended under a new environment
// lease (the ordinary teardown's, and the preempting one's once the lease
// was taken from the operation it preempts).
function insertTeardown(tx: Tx, env: EnvRow, incarnation: string, linkedPrior: string | null = null, qualification: string | null = null): OpRow {
  const deadline = addSeconds(tx.at, projectPolicy(tx.db, env.project).deploy_orchestration_deadline!);
  const lease = takeLease(tx, env.id, incarnation, deadline);
  const { n } = tx.db.prepare(`SELECT COUNT(*) + 1 AS n FROM "operations" WHERE "kind" = 'teardown' AND json_extract("target", '$.environment') = ?`).get(env.id) as { n: number };
  const frozen: FrozenIntent = {
    purpose: 'teardown',
    work_item: null,
    authorization: null,
    candidate: null,
    mapping: null,
    artifact_digest: null,
    artifact_path: null,
    manifest: null,
    config_version: null,
    config_number: null,
    config_identity: null,
    secret_digests: [],
    target_set: [],
    environment: env.id,
    environment_name: env.name,
    prefix: env.prefix ?? '',
    adapter: env.adapter,
    adapter_version: null,
    runtime: null,
    start: null,
    lease: { id: lease.id, generation: lease.generation },
    ...(qualification !== null ? { qualification } : {}),
  };
  const op = insertOperation(tx, {
    project: env.project,
    kind: 'teardown',
    env,
    subject: { environment: env.id },
    key: sha256(canonical({ kind: 'teardown', environment: env.id, n })),
    frozen,
    deadline,
    authorization: null,
  });
  if (linkedPrior !== null) tx.db.prepare('UPDATE "operations" SET "linked_prior" = ? WHERE "id" = ?').run(linkedPrior, op.id);
  tx.db.prepare('UPDATE "environments" SET "teardown_requested_at" = NULL WHERE "id" = ?').run(env.id);
  return getOp(tx.db, op.id)!;
}

// ---- what the main thread reads of an operation -----------------------------------------------

export interface DeployDetail {
  id: string;
  project: string;
  kind: 'deploy' | 'teardown';
  status: string;
  stage: string | null;
  journal: JState;
  frozen: FrozenIntent;
  prefix: string;
  deadline: string;
  attempts: {
    id: string;
    number: number;
    status: string;
    incarnation: string | null;
    generation: number | null;
    capability: Capability | null;
    launch_state: string | null;
    // The init's instance recorded at the grant: a launch was granted.
    init_instance: Instance | null;
    app_instance: Instance | null;
    // The init's report and the host read disagreed (§3.4 step 3).
    app_disagreement: Record<string, unknown> | null;
    intent: { create_units: string[]; prior: { unit: string; instance: Instance | null }[]; cleanup: string[]; resources: string[] } | null;
    // What an identity read of its generation expects (§3.4).
    expect: TargetExpectation[];
  }[];
  // Every unit a frozen intent of the environment named (D4 §4.6).
  recorded_units: string[];
  // The cgroup recorded for each unit's domain, where one was (SEAM.md §278).
  recorded_cgroups: Record<string, string | null>;
  // The bounded cleanup a consumed `retry` of `rollout_partial` authorized
  // for the next attempt (D4 §4.4; E112), or null.
  retry: { cleanup: { resource: string; attempt: string }[] } | null;
  rounds: { id: string; round: number; status: string; step: string; lease: number | null }[];
  blocker: string | null;
}

export function deployDetail(db: Db, args: { operation: string }): DeployDetail | null {
  const op = getOp(db, args.operation);
  const j = op ? journalOf(db, op.id) : undefined;
  if (!op || !j) return null;
  const frozen = frozenOf(op);
  const intents = new Map(
    (db.prepare('SELECT * FROM "attempt_intents" WHERE "operation" = ?').all(op.id) as { attempt: string; create_units: string; prior: string; cleanup: string; resources: string }[]).map((r) => [
      r.attempt,
      {
        create_units: JSON.parse(r.create_units) as string[],
        prior: JSON.parse(r.prior) as { unit: string; instance: Instance | null }[],
        // Each cleanup entry is {resource, attempt} (D4 A.3); by its unit here.
        cleanup: (JSON.parse(r.cleanup) as ({ resource: string } | string)[]).map((x) => (typeof x === 'string' ? x : x.resource)),
        resources: JSON.parse(r.resources) as string[],
      },
    ]),
  );
  return {
    id: op.id,
    project: op.project,
    kind: op.kind as 'deploy' | 'teardown',
    status: op.status,
    stage: op.orchestration_stage,
    journal: j.state,
    frozen,
    prefix: prefixOf(db, frozen.environment),
    deadline: op.orchestration_deadline_at ?? op.deadline_at,
    attempts: attemptsOf(db, op.id).map((a) => ({
      id: a.id,
      number: a.attempt_number,
      status: a.status,
      incarnation: a.incarnation,
      generation: a.deployment_generation,
      capability: parseJson<Capability>(a.capability),
      launch_state: a.launch_state,
      init_instance: parseJson<Instance>(a.init_instance),
      app_instance: parseJson<Instance>(a.app_instance),
      app_disagreement: parseJson<Record<string, unknown>>(a.app_disagreement),
      intent: intents.get(a.id) ?? null,
      expect: frozen.target_set.map((t) => expectationOf(db, a, frozen, t, intents.get(a.id)?.create_units[0] ?? null, a.deployment_generation)),
    })),
    recorded_units: recordedUnits(db, frozen.environment),
    recorded_cgroups: recordedCgroups(db, frozen.environment),
    retry: retryApproved(db, op.id, attemptsOf(db, op.id).at(-1)),
    rounds: db.prepare('SELECT "id", "round", "status", "step", "lease" FROM "verification_rounds" WHERE "operation" = ? ORDER BY rowid, "round"').all(op.id) as DeployDetail['rounds'],
    blocker: openBlocker(db, op.id)?.id ?? null,
  };
}

// Every resource the store recorded for an environment's service domains
// (D4 §2.4's inventory, the store's half): each domain's unit, generation,
// cgroup, invocation and runtime directory, and whether its closure was
// observed.
export function environmentResources(db: Db, args: { environment: string }) {
  return db
    .prepare(
      `SELECT d."id" AS "domain", d."unit", d."cgroup_path", d."cgroup_inode", d."invocation_id", d."runtime_dir", d."status", a."id" AS "attempt", a."deployment_generation" AS "generation"
       FROM "execution_domains" d JOIN "operation_attempts" a ON a."id" = d."attempt" JOIN "operations" o ON o."id" = a."operation"
       WHERE d."profile" = 'service' AND json_extract(o."target", '$.environment') = ? ORDER BY d.rowid, d."id"`,
    )
    .all(args.environment) as { domain: string; unit: string | null; cgroup_path: string | null; cgroup_inode: number | null; invocation_id: string | null; runtime_dir: string | null; status: string; attempt: string; generation: number }[];
}

// The cgroup the store recorded for each unit of the environment, at its
// domain's placement (the real launcher's, or the kernel lane's stand-in):
// what ownership compares the target's report with (D4 §4.6; SEAM.md §278).
export function recordedCgroups(db: Db, env: string): Record<string, string | null> {
  const rows = db
    .prepare(
      `SELECT d."unit", d."cgroup_path" FROM "execution_domains" d JOIN "operation_attempts" a ON a."id" = d."attempt" JOIN "operations" o ON o."id" = a."operation"
       WHERE d."profile" = 'service' AND d."unit" IS NOT NULL AND json_extract(o."target", '$.environment') = ? ORDER BY d.rowid, d."id"`,
    )
    .all(env) as { unit: string; cgroup_path: string | null }[];
  const out: Record<string, string | null> = {};
  for (const r of rows) out[r.unit] = r.cgroup_path ?? out[r.unit] ?? null;
  return out;
}

// The human's `retry` of the operation's `rollout_partial` for its latest
// attempt, consumed (D4 §4.4; SEAM.md §276): the bounded cleanup its
// preview named, or null.
// The retry stands only while the target reads as its preview bound it: a
// read that differs withdraws it (the slice-26 review, m5).
export function retryApproved(db: Db, operation: string, latest: AttemptRow | undefined): { cleanup: { resource: string; attempt: string }[] } | null {
  if (!latest || latest.status !== 'reconciled_partial') return null;
  const rows = db
    .prepare(`SELECT "answer", "dependency_manifest" FROM "decisions" WHERE "kind" = 'rollout_partial' AND "subject_type" = 'operation' AND "subject_id" = ? AND "status" = 'consumed' ORDER BY "seq" DESC`)
    .all(operation) as { answer: string | null; dependency_manifest: string }[];
  for (const r of rows) {
    const m = parseJson<{ attempt?: string; resources?: { resource: string; attempt: string }[] }>(r.dependency_manifest);
    if (m?.attempt !== latest.id) continue;
    if (parseJson<{ option?: string }>(r.answer)?.option !== 'retry') return null;
    if (canonical((m as { reconciled?: unknown }).reconciled ?? null) !== canonical(reconciledOf(latest))) return null;
    return { cleanup: Array.isArray(m.resources) ? m.resources.filter((x) => typeof x?.resource === 'string' && typeof x?.attempt === 'string') : [] };
  }
  return null;
}

export function recordedUnits(db: Db, env: string): string[] {
  const rows = db
    .prepare(
      `SELECT i."create_units" FROM "attempt_intents" i JOIN "operations" o ON o."id" = i."operation"
       WHERE json_extract(o."target", '$.environment') = ? ORDER BY i.rowid`,
    )
    .all(env) as { create_units: string }[];
  return [...new Set(rows.flatMap((r) => JSON.parse(r.create_units) as string[]))];
}

// ---- the preconditions (D4 §4.1; E113, E115; SEAM.md §250) ----------------------------------------

export interface PreconditionFacts {
  // The sealed copy rehashed now (main thread).
  rehash: 'ok' | 'corrupt' | 'unread' | 'none';
  // Each held secret's digest now, by reference; null: not held.
  secretDigests: Record<string, string | null>;
  // Admission of the service domain with one check's capacity (§4.7).
  admission: 'granted' | 'held';
  // The issuing gate's facts (gates/prepare.ts).
  gate: Record<string, unknown>;
  now: string;
  // The environment's inventory (the adapter's `status`, D4 §9.3), for the
  // unit of unknown ownership (D4 §§4.1, 9.2); null: not read.
  inventory?: { complete: boolean; inventory: InventoryEntry[] } | { failure: string } | null;
}

export interface Fact {
  fact: string;
  held: boolean;
  read: unknown;
}

export type Verdict = { verdict: 'hold'; facts: Fact[] } | { verdict: 'wait'; facts: Fact[] } | { verdict: 'fail'; fact: string; facts: Fact[] } | { verdict: 'none'; why: string };

// The issuing gate's eligibility, revalidated (E113): `alpha_authorize`'s
// rule for the operation's exact candidate and authorization, evaluated and
// rolled back. It neither issues nor consumes; the operation's own
// consumption of its authorization is not a change.
function eligible(tx: Tx, op: OpRow, frozen: FrozenIntent, gate: Record<string, unknown>, evaluate: Evaluate): { ok: boolean; reasons: unknown[] } {
  const events = tx.events.length;
  tx.db.exec('SAVEPOINT deploy_eligibility');
  try {
    const { evaluation } = evaluate(tx, { ...gate, project: op.project, candidate: frozen.candidate, kind: 'alpha_authorize', authorization: frozen.authorization });
    return { ok: evaluation.outcome === 'satisfied', reasons: evaluation.reasons };
  } catch (err) {
    return { ok: false, reasons: [{ code: 'EVALUATION_FAILED', subjects: [(err as Error).message] }] };
  } finally {
    tx.db.exec('ROLLBACK TO deploy_eligibility');
    tx.db.exec('RELEASE deploy_eligibility');
    tx.events.length = events;
  }
}

// Every precondition, read again immediately before the effect, in order
// (SEAM.md §250's facts, those this slice can read). Admission alone may
// wait, within the orchestration deadline.
export function readPreconditions(tx: Tx, args: { operation: string; facts: PreconditionFacts }, evaluate: Evaluate): Verdict {
  const op = getOp(tx.db, args.operation);
  if (!op) return { verdict: 'none', why: 'no operation' };
  const j = journalOf(tx.db, op.id)!;
  const latest = attemptsOf(tx.db, op.id).at(-1);
  if (j.state === 'failed' || j.state === 'finalized' || j.state === 'confirmed') return { verdict: 'none', why: `journal ${j.state}` };
  if (latest && latest.status !== 'reconciled_absent' && retryApproved(tx.db, op.id, latest) === null) return { verdict: 'none', why: `attempt ${latest.status}` };
  const frozen = frozenOf(op);
  const env = getEnv(tx.db, frozen.environment)!;
  const f = args.facts;
  const facts: Fact[] = [];
  const fact = (name: string, held: boolean, read: unknown) => facts.push({ fact: name, held, read });
  // What the inventory read shows beside the operation (D4 §6.3; the
  // driver's ruling, answer 1): any out-of-band change it finds is recorded.
  if (f.inventory && !('failure' in f.inventory) && Array.isArray(f.inventory.inventory)) {
    recordInventoryRead(tx, { environment: env.id, inventory: f.inventory.inventory, complete: f.inventory.complete === true, observation: null });
  }
  const ownership = op.kind === 'deploy' ? ownershipFact(tx.db, frozen, f.inventory ?? null) : null;
  // The preconditions are read immediately before the effect (§4.1): while
  // admission is held, the operation waits, within its deadline, and reads
  // them when admission is granted. A unit of unknown ownership read
  // meanwhile blocks deployment to the environment at once (D4 §9.2): the
  // wait would otherwise hold it to its deadline.
  const deadlinePassed = Date.parse(f.now) > Date.parse(op.orchestration_deadline_at ?? op.deadline_at);
  if (op.kind === 'deploy' && f.admission !== 'granted' && !deadlinePassed) {
    if (ownership !== null && ownership.unaccounted) return { verdict: 'fail', fact: 'unknown_ownership', facts: [{ fact: 'unknown_ownership', held: false, read: ownership.read }] };
    return { verdict: 'wait', facts: [] };
  }

  const lease = environmentLease(tx.db, env.id);
  fact('environment_lease', lease?.id === frozen.lease.id && lease.generation === frozen.lease.generation, { held: lease ? { id: lease.id, generation: lease.generation } : null, expected: frozen.lease });
  const qualifying = frozen.qualification !== undefined && frozen.qualification !== null;
  if (op.kind === 'deploy' && qualifying) {
    // An adapter qualification's deploy (D4 §2.6): its own configuration and
    // sealed fixture, on a qualified host; no authorization, candidate, gate
    // or adapter qualification (it is making one), and the out-of-band
    // changes its own instrument made are its evidence, never a stop.
    const config = currentConfig(tx.db, env);
    fact('configuration_changed', config?.id === frozen.config_version, { current: config ? { id: config.id, version: config.version } : null, frozen: frozen.config_version });
    const artifact = frozen.artifact_digest ? getArtifact(tx.db, op.project, frozen.artifact_digest) : undefined;
    fact('artifact_integrity', artifact !== undefined && f.rehash === 'ok' && artifact.status === 'sealed', { digest: frozen.artifact_digest, rehash: f.rehash });
    const host = hostEligibility(tx.db);
    fact('host_qualification', host.eligible === true, { host_qualification: host.host_qualification ?? null, failed_checks: host.failed_checks });
  } else if (op.kind === 'deploy') {
    const auth = tx.db.prepare('SELECT * FROM "deployment_authorizations" WHERE "id" = ?').get(frozen.authorization) as AuthRow | undefined;
    fact('authorization', auth?.status === 'consumed' && op.authorization === auth.id, { authorization: frozen.authorization, status: auth?.status ?? null });
    const candidate = getCandidate(tx.db, frozen.candidate!);
    fact('candidate_superseded', candidate !== undefined && (candidate.superseded_by ?? null) === null, { candidate: frozen.candidate, superseded_by: candidate?.superseded_by ?? null });
    const config = currentConfig(tx.db, env);
    fact('configuration_changed', config?.id === frozen.config_version, { current: config ? { id: config.id, version: config.version } : null, frozen: frozen.config_version });
    const changed = frozen.secret_digests.filter((d) => f.secretDigests[d.ref] !== d.digest).map((d) => d.ref);
    fact('config_secrets_changed', changed.length === 0 && (config?.id !== frozen.config_version || config.status === 'current'), {
      references: frozen.secret_digests.map((d) => d.ref),
      changed,
      status: config?.status ?? null,
    });
    const artifact = frozen.artifact_digest ? getArtifact(tx.db, op.project, frozen.artifact_digest) : undefined;
    fact('artifact_integrity', artifact !== undefined && f.rehash === 'ok' && artifact.status === 'sealed', { digest: frozen.artifact_digest, rehash: f.rehash });
    const q = qualificationOf(tx.db, frozen.adapter, frozen.adapter_version);
    fact('adapter_qualification', q !== undefined, { adapter: frozen.adapter, adapter_version: frozen.adapter_version, qualification: q?.id ?? null });
    const host = hostEligibility(tx.db);
    fact('host_qualification', host.eligible === true, { host_qualification: host.host_qualification ?? null, failed_checks: host.failed_checks });
    const e = eligible(tx, op, frozen, f.gate, evaluate);
    fact('gate_eligibility', e.ok, { gate: 'alpha_authorize', reasons: e.reasons });
  }
  fact('orchestration_deadline', !deadlinePassed, { deadline: op.orchestration_deadline_at, now: f.now, admission: f.admission });
  if (ownership !== null) fact('unknown_ownership', ownership.held, ownership.read);
  // No open out-of-band change of the environment (D4 §§4.1, 6.3; J6): an
  // acknowledged one is a disposition and holds nothing.
  if (op.kind === 'deploy' && !qualifying) {
    const open = openChanges(tx.db, env.id);
    fact('out_of_band', open.length === 0, { open: open.map((r) => ({ id: r.id, change: r.change, resource: r.resource })) });
  }
  const failed = facts.find((x) => !x.held);
  if (failed) return { verdict: 'fail', fact: failed.fact, facts };
  if (op.kind === 'deploy' && f.admission !== 'granted') return { verdict: 'wait', facts };
  return { verdict: 'hold', facts };
}

// No unit or domain of the environment of unknown ownership (D4 §§4.1, 9.2;
// SEAM.md §278): read from the environment's inventory; a unit carrying the
// prefix that no intent names, or reported in another cgroup than the one
// recorded, is listed by its exact name. An inventory not read, failed or
// incomplete holds nothing: unknown is never an empty inventory.
function ownershipFact(db: Db, frozen: FrozenIntent, inv: PreconditionFacts['inventory']): { held: boolean; unaccounted: boolean; read: Record<string, unknown> } {
  if (inv === null || inv === undefined) return { held: false, unaccounted: false, read: { inventory: 'not_read' } };
  if ('failure' in inv) return { held: false, unaccounted: false, read: { inventory: 'unread', failure: inv.failure } };
  const list = Array.isArray(inv.inventory) ? inv.inventory : [];
  const units = unaccountedUnits(list, recordedUnits(db, frozen.environment), recordedCgroups(db, frozen.environment));
  const read = {
    complete: inv.complete === true,
    units: units,
    inventory: list.filter((e) => typeof e === 'object' && e !== null && e.kind === 'unit').map((e) => e.resource),
  };
  if (units.length > 0) return { held: false, unaccounted: true, read };
  if (inv.complete !== true) return { held: false, unaccounted: false, read: { ...read, inventory: 'incomplete' } };
  return { held: true, unaccounted: false, read };
}

// The units a teardown's frozen intent may stop (D4 §4.6; SEAM.md §295):
// those a frozen intent of the environment names that the inventory read
// reports loaded under the cgroup the engine recorded for them (or with
// none, inactive or failed). Any other unit of the prefix is never named.
// With no inventory read, the recorded units whose domains have not ended:
// the adapter establishes ownership again before it acts on any.
function ownedUnits(db: Db, env: string, inv: PreconditionFacts['inventory']): string[] {
  const recorded = recordedUnits(db, env);
  const cgroups = recordedCgroups(db, env);
  if (inv && !('failure' in inv) && Array.isArray(inv.inventory)) {
    const unaccounted = new Set(unaccountedUnits(inv.inventory, recorded, cgroups).map((u) => u.unit));
    return recorded.filter((u) => inv.inventory.some((e) => e && e.kind === 'unit' && e.resource === u) && !unaccounted.has(u));
  }
  const live = new Set(environmentResources(db, { environment: env }).filter((r) => r.status !== 'terminated' && r.unit !== null).map((r) => r.unit!));
  return recorded.filter((u) => live.has(u));
}

// A failed precondition (D4 §4.1): the operation ends `failed` with
// EFFECT_PRECONDITION_CHANGED naming the fact and its manifest, before any
// adapter call; the consumed authorization is not restored; the lease is
// released at once.
export function preconditionFailed(tx: Tx, args: { operation: string; fact: string; manifest: string }): { failed: boolean } {
  const op = getOp(tx.db, args.operation);
  if (!op) throw notFound('operation', args.operation);
  const j = journalOf(tx.db, op.id)!;
  const latest = attemptsOf(tx.db, op.id).at(-1);
  if (j.state === 'failed' || j.state === 'finalized' || j.state === 'confirmed' || (latest && latest.status !== 'reconciled_absent' && retryApproved(tx.db, op.id, latest) === null)) return { failed: false };
  if (args.fact === 'orchestration_deadline') tx.emit('deploy.orchestration_deadline', { project: op.project, operation: op.id }, { stage: 'effect' });
  failOperation(tx, op, { code: 'EFFECT_PRECONDITION_CHANGED', fact: args.fact, manifest: args.manifest });
  return { failed: true };
}

// A deploy waiting for its service's admission (D4 §4.7, A.2: "admission
// waits show as D2's resource_envelope"; SEAM.md §271): the hold, on the
// deploy work item, for the work read's `dispatch_hold`. Cleared when the
// attempt starts or the operation ends.
export interface AdmissionHold {
  code: 'resource_envelope';
  reason: string;
  subject: Record<string, unknown>;
}

export function admissionWait(tx: Tx, args: { operation: string; hold: AdmissionHold }): void {
  const op = getOp(tx.db, args.operation);
  if (!op || op.kind !== 'deploy') return;
  const frozen = frozenOf(op);
  if (frozen.work_item === null) return;
  const item = getWorkItem(tx, frozen.work_item);
  if (!item || item.status === 'complete' || item.status === 'cancelled') return;
  const stored = parseJson<{ reason?: string; raised_at?: string }>(item.blocker);
  if (stored !== null && stored.reason !== 'resource_envelope') return;
  const hold = { code: 'resource_envelope' as const, reason: String(args.hold.reason ?? ''), subject: args.hold.subject ?? {} };
  const value = { reason: 'resource_envelope', raised_at: stored?.raised_at ?? tx.at, decision: null, operation: op.id, hold };
  if (canonical(stored) === canonical(value)) return;
  tx.db.prepare('UPDATE "work_items" SET "blocker" = ? WHERE "id" = ?').run(JSON.stringify(value), item.id);
}

function clearAdmissionWait(tx: Tx, frozen: FrozenIntent): void {
  if (frozen.work_item === null) return;
  const item = getWorkItem(tx, frozen.work_item);
  if (!item) return;
  if (parseJson<{ reason?: string }>(item.blocker)?.reason === 'resource_envelope') tx.db.prepare('UPDATE "work_items" SET "blocker" = NULL WHERE "id" = ?').run(item.id);
}

// The latest finalized deploy of the environment, if no teardown followed
// it: what the environment's last confirmed deployment left running.
function priorOf(db: Db, env: string): { unit: string; instance: Instance | null }[] {
  const last = db
    .prepare(
      `SELECT o."id", o."kind" FROM "operations" o JOIN "deploy_journal_state" s ON s."operation" = o."id"
       WHERE json_extract(o."target", '$.environment') = ? AND s."state" = 'finalized' ORDER BY o."seq" DESC LIMIT 1`,
    )
    .get(env) as { id: string; kind: string } | undefined;
  if (!last || last.kind !== 'deploy') return [];
  const a = db
    .prepare(
      `SELECT a."app_instance", i."create_units" FROM "operation_attempts" a JOIN "attempt_intents" i ON i."attempt" = a."id"
       WHERE a."operation" = ? AND a."status" IN ('succeeded', 'reconciled_succeeded') ORDER BY a."attempt_number" DESC LIMIT 1`,
    )
    .get(last.id) as { app_instance: string | null; create_units: string } | undefined;
  if (!a) return [];
  const app = parseJson<Instance>(a.app_instance);
  return (JSON.parse(a.create_units) as string[]).map((unit) => ({ unit, instance: app ? { pid: app.pid, start_time: app.start_time } : null }));
}

// The attempt (D4 §4.2; E112), when the preconditions read again in this
// transaction still hold: its generation from the environment's counter,
// now the environment's current generation (J9); its frozen intent with the
// precondition manifest's record; its capability; its launch authorizable.
export function startDeployAttempt(
  tx: Tx,
  args: { operation: string; incarnation: string; facts: PreconditionFacts; manifest: string; service?: { home: string; checkCapacity: number } },
  evaluate: Evaluate,
): { attempt: string; capability: Capability; domain?: string } | { retry: true } {
  const v = readPreconditions(tx, { operation: args.operation, facts: args.facts }, evaluate);
  if (v.verdict !== 'hold') return { retry: true };
  const op = getOp(tx.db, args.operation)!;
  // Admission and allocation in one transaction (D4 §4.7; the slice-24
  // review, m4): the service domain holds its reservation from here.
  if (op.kind === 'deploy' && args.service && serviceAdmissionHold(tx.db, { project: op.project }).admission !== 'granted') return { retry: true };
  const frozen = frozenOf(op);
  const env = getEnv(tx.db, frozen.environment)!;
  const latest = attemptsOf(tx.db, op.id).at(-1);
  const g = env.deployment_generation + 1;
  tx.db.prepare('UPDATE "environments" SET "deployment_generation" = ?, "current_generation" = ? WHERE "id" = ?').run(g, g, env.id);
  bumpRevision(tx, env.id);
  const n = (latest?.attempt_number ?? 0) + 1;
  const attempt = tx.newId('att_');
  const prefix = frozen.prefix;
  const prior = op.kind === 'deploy' ? priorOf(tx.db, env.id) : [];
  const create = op.kind === 'deploy' ? [unitName(prefix, g)] : [];
  // After `partial`, only the cleanup the human's retry authorized (D4 §4.4;
  // E112): the earlier attempts' units its preview named, each with its
  // attempt (D4 A.3).
  const cleanup = op.kind === 'deploy' ? (retryApproved(tx.db, op.id, latest)?.cleanup ?? []) : [];
  const resources = op.kind === 'teardown' ? ownedUnits(tx.db, env.id, args.facts.inventory ?? null) : [];
  const capability: Capability =
    op.kind === 'deploy'
      ? {
          kind: 'deploy',
          environment: env.id,
          operation: op.id,
          attempt,
          generation: g,
          incarnation: args.incarnation,
          lease_generation: frozen.lease.generation,
          artifact_digest: frozen.artifact_digest!,
          sealed_path: frozen.artifact_path ?? '',
          config_identity: frozen.config_identity!,
          config_version: frozen.config_version!,
          targets: frozen.target_set,
          create_units: create,
          prior,
          cleanup: cleanup.map((c) => c.resource),
        }
      : { kind: 'teardown', environment: env.id, operation: op.id, attempt, generation: g, incarnation: args.incarnation, lease_generation: frozen.lease.generation, stop_units: resources };
  tx.db
    .prepare(
      `INSERT INTO "operation_attempts" ("id", "created_at", "project", "operation", "attempt_number", "status", "started_at", "finished_at", "timeline", "reconciliation_reads", "incarnation",
         "deployment_generation", "capability", "launch_state")
       VALUES (?, ?, ?, ?, ?, 'started', ?, NULL, ?, '[]', ?, ?, ?, ?)`,
    )
    .run(attempt, tx.at, op.project, op.id, n, tx.at, JSON.stringify([{ at: tx.at, event: 'started', detail: null }]), args.incarnation, g, JSON.stringify(capability), op.kind === 'deploy' ? 'authorizable' : null);
  tx.db
    .prepare(
      `INSERT INTO "attempt_intents" ("id", "created_at", "project", "operation", "attempt", "generation", "create_units", "prior", "cleanup", "resources", "preconditions")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(tx.newId('ati_'), tx.at, op.project, op.id, attempt, g, JSON.stringify(create), JSON.stringify(prior), JSON.stringify(cleanup), JSON.stringify(resources), args.manifest);
  tx.emit('operation.attempt_started', { project: op.project, operation: op.id, environment: env.id }, { attempt_number: n, deployment_generation: g });
  // Any later attempt of O invalidates every earlier row of O (D4 §5.3 item
  // 8, `later_attempt`). Rows exist only after a confirmed effect, after
  // which no attempt is made, so this holds by construction; it is written
  // all the same (the slice-25 design, Q14).
  tx.db.prepare(`UPDATE "deployment_verifications" SET "invalidated_at" = ?, "invalidated_reason" = 'later_attempt' WHERE "operation" = ? AND "invalidated_at" IS NULL`).run(tx.at, op.id);
  clearAdmissionWait(tx, frozen);
  // The service domain of a deploy attempt (J2; D4 §§4.7, 9.2): allocated
  // with the attempt, its reservation and its runtime directory recorded
  // before anything of it exists.
  let domain: string | undefined;
  if (op.kind === 'deploy') {
    domain = tx.newId('dom_');
    const policy = projectPolicy(tx.db, op.project) as Record<string, number>;
    // The check capacity it reserves: its project's effective check maximum
    // (D6 K2, E126; B09), no longer the ceiling.
    const reservation = { memory: policy.service_memory_max ?? null, check_capacity: args.service ? effectiveProfileMax(tx.db, op.project, 'check') : null };
    const runtimeDir = args.service ? serviceRuntimeDir(args.service.home, env.id, g) : null;
    tx.db
      .prepare(
        `INSERT INTO "execution_domains" ("id", "created_at", "project", "run", "invocation", "check_execution", "attempt", "status", "profile", "launch_state", "reservation", "unit", "runtime_dir")
         VALUES (?, ?, ?, NULL, NULL, NULL, ?, 'allocated', 'service', 'authorizable', ?, ?, ?)`,
      )
      .run(domain, tx.at, op.project, attempt, JSON.stringify(reservation), create[0] ?? null, runtimeDir);
  }
  refreshOp(tx, op.id);
  return { attempt, capability, ...(domain ? { domain } : {}) };
}

// A service domain's runtime directory (SEAM.md §259): under
// $SURETY_HOME/run/, its name carrying the environment's id and generation.
export const serviceRuntimeDir = (home: string, env: string, generation: number): string => `${home.replace(/\/+$/, '')}/run/${env}-g${generation}`;

// adapterCall's check (D4 §2.2): every field of the capability against the
// store, before any host call. null: it holds; otherwise the field that
// failed.
export function capabilityCheck(db: Db, args: { capability: Capability; incarnation: string }): { field: string } | null {
  const c = args.capability;
  const a = getAttempt(db, c.attempt);
  if (!a || a.operation !== c.operation) return { field: 'attempt' };
  const op = getOp(db, c.operation);
  if (!op) return { field: 'operation' };
  const frozen = frozenOf(op);
  if (c.environment !== frozen.environment) return { field: 'environment' };
  const latest = attemptsOf(db, op.id).at(-1);
  if (a.status !== 'started' || latest?.id !== a.id) return { field: 'attempt' };
  if (c.incarnation !== args.incarnation || a.incarnation !== args.incarnation) return { field: 'incarnation' };
  const env = getEnv(db, frozen.environment);
  if (!env || a.deployment_generation !== c.generation || env.current_generation !== c.generation) return { field: 'generation' };
  const lease = environmentLease(db, env.id);
  if (!lease || lease.id !== frozen.lease.id || lease.generation !== c.lease_generation) return { field: 'lease_generation' };
  const intent = db.prepare('SELECT * FROM "attempt_intents" WHERE "attempt" = ?').get(a.id) as { create_units: string; prior: string; cleanup: string; resources: string } | undefined;
  if (!intent) return { field: 'attempt' };
  const prefix = frozen.prefix;
  // The member that failed is named (D4 §2.2; SEAM.md §315).
  if (prefix === '' || env.prefix !== prefix) return { field: c.kind === 'deploy' ? 'create_units' : 'stop_units' };
  const derived = (u: string) => prefix !== '' && UNIT_CHARS.test(u) && u.startsWith(prefix) && /^g\d+\.service$/.test(u.slice(prefix.length));
  if (c.kind === 'deploy') {
    if (frozen.artifact_digest === null || c.artifact_digest !== frozen.artifact_digest) return { field: 'artifact_digest' };
    if (frozen.artifact_path === null || c.sealed_path !== frozen.artifact_path) return { field: 'sealed_path' };
    if (frozen.config_identity === null || c.config_identity !== frozen.config_identity) return { field: 'config_identity' };
    if (frozen.config_version === null || c.config_version !== frozen.config_version) return { field: 'config_version' };
    if (!Array.isArray(c.targets) || canonical([...c.targets].sort()) !== canonical([...frozen.target_set].sort())) return { field: 'targets' };
    const create = JSON.parse(intent.create_units) as string[];
    const prior = (JSON.parse(intent.prior) as { unit: string }[]).map((p) => p.unit);
    if (!Array.isArray(c.create_units) || !c.create_units.every((u) => derived(u) && create.includes(u))) return { field: 'create_units' };
    if (!Array.isArray(c.prior) || !c.prior.every((p) => derived(p.unit) && prior.includes(p.unit))) return { field: 'prior' };
    const cleanup = (JSON.parse(intent.cleanup) as { resource: string }[]).map((x) => x.resource);
    if (!Array.isArray(c.cleanup) || !c.cleanup.every((u) => derived(u) && cleanup.includes(u))) return { field: 'cleanup' };
  } else {
    const resources = JSON.parse(intent.resources) as string[];
    if (!Array.isArray(c.stop_units) || !c.stop_units.every((u) => derived(u) && resources.includes(u))) return { field: 'stop_units' };
  }
  // And it is the capability the attempt's transaction minted, whole: no
  // field a check above does not name differs from it (review m7).
  if (a.capability === null || canonical(JSON.parse(a.capability)) !== canonical(c)) return { field: 'capability' };
  return null;
}

// A capability refused (D4 §2.2): nothing issued, the event naming the
// field, the attempt `failed` with nothing applied.
export function capabilityRefused(tx: Tx, args: { attempt: string; field: string }): void {
  const a = getAttempt(tx.db, args.attempt);
  if (!a) throw notFound('attempt', args.attempt);
  const op = getOp(tx.db, a.operation)!;
  tx.emit('deploy.capability_refused', { project: op.project, operation: op.id, attempt: a.id }, { field: args.field });
  if (a.status === 'started') setAttempt(tx, a, 'failed');
  writeAttemptedOnce(tx, op, a, 'failed');
  // The operation's outcome names the refusal; the error code itself is
  // internal, never a route's answer (D4 A.6).
  failOperation(tx, op, { code: 'CAPABILITY_REFUSED', field: args.field });
}

// ---- the launch (D4 §§3.4, 9.2; SEAM.md §§247, 259) -------------------------------------------------

interface ServiceDomainRow {
  id: string;
  project: string;
  attempt: string;
  status: string;
  launch_state: string;
  cgroup_path: string | null;
  cgroup_inode: number | null;
  unit: string | null;
  invocation_id: string | null;
  runtime_dir: string | null;
  reservation: string | null;
  launched_by_incarnation: string | null;
  app_exit: string | null;
}

const serviceDomainOf = (db: Db, attempt: string): ServiceDomainRow | undefined =>
  db.prepare(`SELECT * FROM "execution_domains" WHERE "attempt" = ? AND "profile" = 'service'`).get(attempt) as ServiceDomainRow | undefined;

// The attempt's launch closed, on the attempt and on its service domain:
// from here no launcher of it is ever granted (D4 §9.2).
function closeAttemptLaunch(tx: Tx, a: AttemptRow, cause: string): void {
  if (a.launch_state !== null && a.launch_state !== 'closed') tx.db.prepare(`UPDATE "operation_attempts" SET "launch_state" = 'closed' WHERE "id" = ?`).run(a.id);
  const d = serviceDomainOf(tx.db, a.id);
  if (d && d.launch_state !== 'closed') {
    tx.db.prepare(`UPDATE "execution_domains" SET "launch_state" = 'closed', "launch_closed_at" = ? WHERE "id" = ?`).run(tx.at, d.id);
    tx.emit('domain.launch_closed', { project: d.project, domain: d.id, attempt: a.id }, { from: d.launch_state, reason: cause });
  }
}

// What a service launcher's first message is checked against (D4 §9.2):
// the attempt, its launch state, incarnation and lease, its service domain,
// and what the launch will run. null: no such attempt.
export function launchLookup(db: Db, args: { attempt: string }) {
  const a = getAttempt(db, args.attempt);
  if (!a) return null;
  const op = getOp(db, a.operation)!;
  const frozen = frozenOf(op);
  const lease = environmentLease(db, frozen.environment);
  const d = serviceDomainOf(db, a.id);
  const config = getConfig(db, frozen.config_version);
  const content = config ? configContent(config) : null;
  const intent = db.prepare('SELECT "create_units" FROM "attempt_intents" WHERE "attempt" = ?').get(a.id) as { create_units: string } | undefined;
  const policy = projectPolicy(db, op.project) as Record<string, number>;
  return {
    attempt: a.id,
    operation: op.id,
    project: op.project,
    status: a.status,
    launch_state: a.launch_state,
    incarnation: a.incarnation,
    generation: a.deployment_generation,
    environment: frozen.environment,
    prefix: frozen.prefix,
    unit: intent ? ((JSON.parse(intent.create_units) as string[])[0] ?? null) : null,
    lease: lease && lease.id === frozen.lease.id ? { generation: lease.generation } : null,
    lease_expected: frozen.lease.generation,
    domain: d ? { id: d.id, status: d.status, launch_state: d.launch_state, cgroup_path: d.cgroup_path, unit: d.unit, invocation_id: d.invocation_id, runtime_dir: d.runtime_dir } : null,
    init_instance: parseJson<Instance>(a.init_instance),
    app_instance: parseJson<Instance & { exe: string; exe_sha256: string | null; argv: string[] }>(a.app_instance),
    artifact: { digest: frozen.artifact_digest, path: frozen.artifact_path },
    runtime: frozen.runtime,
    start: frozen.start,
    port: typeof content?.port === 'number' ? content.port : null,
    env: (content?.env as Record<string, string> | undefined) ?? {},
    secrets: content?.secrets ?? {},
    limits: {
      memory_max: policy.service_memory_max ?? null,
      memory_swap_max: 0,
      pids_max: policy.service_tasks_max ?? null,
      writable_bytes: policy.service_writable_bytes ?? null,
      writable_inodes: policy.service_writable_inodes ?? null,
      log_max_bytes: policy.service_log_max_bytes ?? null,
    },
  };
}

// The service launcher's placement, read from the host by the main thread
// (D4 §9.2; E121 item 4): its pid the unit's MainPID, its cgroup the unit's
// own ControlGroup, the limits read back from the cgroup files. Recorded on
// the domain only while the launch is authorizable, the attempt started and
// of this incarnation, the lease current. The answer says why not.
export function serviceLauncherPlaced(
  tx: Tx,
  args: { attempt: string; domain: string; incarnation: string; lease_generation: number; pid: number; cgroup: string; inode: number | null; invocation_id: string; unit: string },
): { placed: boolean; reason: string | null } {
  const a = getAttempt(tx.db, args.attempt);
  const no = (reason: string) => ({ placed: false, reason });
  if (!a) return no('no such attempt');
  if (a.status !== 'started') return no(`the attempt is ${a.status}`);
  if (a.launch_state !== 'authorizable') return no(`the launch is ${a.launch_state}`);
  if (a.incarnation !== args.incarnation) return no('the incarnation is not the one that started the attempt');
  const op = getOp(tx.db, a.operation)!;
  const frozen = frozenOf(op);
  const lease = environmentLease(tx.db, frozen.environment);
  if (!lease || lease.id !== frozen.lease.id || lease.generation !== args.lease_generation) return no('the environment lease is not current');
  const d = serviceDomainOf(tx.db, a.id);
  if (!d || d.id !== args.domain) return no("the domain is not the attempt's");
  if (d.status !== 'allocated' || d.launch_state !== 'authorizable') return no(`the domain is ${d.status}, its launch ${d.launch_state}`);
  if (d.unit !== args.unit) return no("the unit is not the attempt's");
  if (typeof args.invocation_id !== 'string' || !/^[0-9a-f]{32}$/.test(args.invocation_id)) return no("the unit's invocation was not read");
  if (d.cgroup_path !== null && d.cgroup_path !== args.cgroup) return no('the domain was placed in another cgroup');
  tx.db
    .prepare('UPDATE "execution_domains" SET "cgroup_path" = ?, "cgroup_inode" = ?, "invocation_id" = ?, "placed_at" = COALESCE("placed_at", ?) WHERE "id" = ?')
    .run(args.cgroup, args.inode, args.invocation_id, tx.at, d.id);
  tx.emit('domain.placed', { project: d.project, domain: d.id, attempt: a.id }, { cgroup_path: args.cgroup, launcher_pid: args.pid, launch_state: d.launch_state, invocation_id: args.invocation_id });
  return { placed: true, reason: null };
}

// A service launcher asks for its attempt's launch, presenting the
// incarnation, the lease generation and the init's instance (read and
// checked on the host by the main thread, D4 §3.4 step 2). Granted once, in
// one transaction, only while all are current and the launch is
// authorizable (single use: `authorizable → authorized`, never back), on the
// attempt and on its service domain together.
export function launchAuthorize(
  tx: Tx,
  args: { attempt: string; incarnation: string; lease_generation: number; init: Instance; limits?: Record<string, number> },
): { granted: false; reason?: string } | { granted: true; exe: string; exe_sha256: string | null; argv: string[] } {
  const a = getAttempt(tx.db, args.attempt);
  if (!a || a.status !== 'started' || a.launch_state !== 'authorizable' || a.incarnation !== args.incarnation) return { granted: false, reason: 'the attempt is not started, authorizable and of this incarnation' };
  const op = getOp(tx.db, a.operation)!;
  const frozen = frozenOf(op);
  const lease = environmentLease(tx.db, frozen.environment);
  if (!lease || lease.id !== frozen.lease.id || lease.generation !== args.lease_generation) return { granted: false, reason: 'the environment lease is not current' };
  if (!Number.isInteger(args.init?.pid) || !Number.isInteger(args.init?.start_time)) return { granted: false, reason: 'no init instance' };
  const d = serviceDomainOf(tx.db, a.id);
  if (d && (d.status !== 'allocated' || d.launch_state !== 'authorizable')) return { granted: false, reason: `the domain is ${d.status}, its launch ${d.launch_state}` };
  const init = { pid: args.init.pid, start_time: args.init.start_time };
  tx.db.prepare(`UPDATE "operation_attempts" SET "launch_state" = 'authorized', "init_instance" = ? WHERE "id" = ?`).run(JSON.stringify(init), a.id);
  if (d) {
    const binding = { attempt: a.id, incarnation: args.incarnation, lease_generation: args.lease_generation };
    tx.db
      .prepare(`UPDATE "execution_domains" SET "launch_state" = 'authorized', "launch_binding" = ?, "launch_authorized_at" = ?, "status" = 'launched', "launched_by_incarnation" = ? WHERE "id" = ?`)
      .run(JSON.stringify(binding), tx.at, args.incarnation, d.id);
  }
  tx.emit(
    'deploy.launch_authorized',
    { project: op.project, operation: op.id, attempt: a.id, environment: frozen.environment, ...(d ? { domain: d.id } : {}) },
    { init, ...(args.limits ? { limits: args.limits } : {}) },
  );
  return { granted: true, exe: frozen.runtime?.path ?? '', exe_sha256: frozen.runtime?.sha256 ?? null, argv: frozen.start ?? [] };
}

// The init's `started` report: the original application instance, recorded
// once and never rebound (§3.4), only under a granted launch.
export function applicationStarted(tx: Tx, args: { attempt: string; app: Instance & { exe: string; exe_sha256: string | null; argv: string[] } }): { recorded: boolean } {
  const a = getAttempt(tx.db, args.attempt);
  if (!a || a.launch_state !== 'authorized' || a.app_instance !== null || a.app_disagreement !== null) return { recorded: false };
  const app = { pid: args.app.pid, start_time: args.app.start_time, exe: args.app.exe, exe_sha256: args.app.exe_sha256, argv: args.app.argv };
  tx.db.prepare('UPDATE "operation_attempts" SET "app_instance" = ? WHERE "id" = ?').run(JSON.stringify(app), a.id);
  return { recorded: true };
}

// The init's report and the host read disagree (§3.4 step 3): neither binds
// anything; what each said is kept, and reconcile reads `conflicting`.
export function applicationDisagreement(tx: Tx, args: { attempt: string; detail: Record<string, unknown> }): void {
  const a = getAttempt(tx.db, args.attempt);
  if (!a || a.app_instance !== null || a.app_disagreement !== null) return;
  tx.db.prepare('UPDATE "operation_attempts" SET "app_disagreement" = ? WHERE "id" = ?').run(JSON.stringify(args.detail), a.id);
}

// The application's terminal exit, as the init reported it while attached
// (D4 §9.2): kept on the domain; `deploy.service_exited`.
export function applicationExited(tx: Tx, args: { attempt: string; exit: { at: string; code: number | null; signal: number | null; external_term?: boolean } }): void {
  const a = getAttempt(tx.db, args.attempt);
  const d = a ? serviceDomainOf(tx.db, a.id) : undefined;
  if (!a || !d || d.app_exit !== null) return;
  // D4 A.3, SEAM.md §278: {at, status}, the status as the init reported it;
  // `external_term` (engine-owned): the init had received a termination
  // signal the engine did not order before the exit (an ending by hand, the
  // driver's ruling on the slice-27 design, answer 2).
  const exit = { at: args.exit.at, status: { code: args.exit.code, signal: args.exit.signal }, ...(args.exit.external_term === true ? { external_term: true } : {}) };
  tx.db.prepare('UPDATE "execution_domains" SET "app_exit" = ? WHERE "id" = ?').run(JSON.stringify(exit), d.id);
  const op = getOp(tx.db, a.operation)!;
  tx.emit('deploy.service_exited', { project: d.project, operation: op.id, attempt: a.id, domain: d.id }, exit);
}

// The service domains of a project not yet terminated, with what the main
// thread needs to observe their closure.
export function openServiceDomains(db: Db, args: { project?: string }) {
  const rows = db
    .prepare(
      `SELECT d."id", d."attempt", d."status", d."launch_state", d."cgroup_path", d."cgroup_inode", d."unit", d."runtime_dir", d."launched_by_incarnation", d."observed_at",
              json_extract(o."target", '$.environment') AS "environment"
       FROM "execution_domains" d JOIN "operation_attempts" a ON a."id" = d."attempt" JOIN "operations" o ON o."id" = a."operation"
       WHERE d."profile" = 'service' AND d."status" <> 'terminated' ${args.project ? 'AND d."project" = ?' : ''} ORDER BY d.rowid, d."id"`,
    )
    .all(...(args.project ? [args.project] : [])) as { id: string; attempt: string; status: string; launch_state: string; cgroup_path: string | null; cgroup_inode: number | null; unit: string | null; runtime_dir: string | null; launched_by_incarnation: string | null; observed_at: string | null; environment: string }[];
  return rows;
}

// A service domain's closure observed (D2 §3.2, absence in the verified
// hierarchy; D4 §9.2): its launch closed first, then `terminated`.
export function serviceDomainClosed(tx: Tx, args: { domain: string; observed: string; resource_events?: { oom_kill: number | null; pids_max: number | null } | null }): { terminated: boolean } {
  const d = tx.db.prepare(`SELECT * FROM "execution_domains" WHERE "id" = ? AND "profile" = 'service'`).get(args.domain) as ServiceDomainRow | undefined;
  if (!d || d.status === 'terminated') return { terminated: false };
  // The domain's limits as its cgroup counted them, read before its stop
  // (D4 §9.2, D4-T05; D2 A.3 `resource_events`): kept with the domain.
  if (args.resource_events) tx.db.prepare('UPDATE "execution_domains" SET "resource_events" = ? WHERE "id" = ?').run(JSON.stringify({ oom_kill: args.resource_events.oom_kill ?? null, pids_max: args.resource_events.pids_max ?? null }), d.id);
  const a = getAttempt(tx.db, d.attempt);
  if (a) closeAttemptLaunch(tx, a, 'closure_observed');
  else if (d.launch_state !== 'closed') tx.db.prepare(`UPDATE "execution_domains" SET "launch_state" = 'closed', "launch_closed_at" = ? WHERE "id" = ?`).run(tx.at, d.id);
  tx.db.prepare(`UPDATE "execution_domains" SET "status" = 'terminated', "terminated_at" = ?, "observation" = 'terminated', "observed_at" = ? WHERE "id" = ?`).run(tx.at, tx.at, d.id);
  tx.emit('domain.terminated', { project: d.project, domain: d.id, attempt: d.attempt }, { observed: args.observed, profile: 'service' });
  const owner = a ? getOp(tx.db, a.operation) : undefined;
  if (owner) bumpRevision(tx, frozenOf(owner).environment);
  return { terminated: true };
}

// A service domain whose termination was not observed (D4 §9.2, A.4): its
// launch closed, `quarantined`, keeping its reservation and conferring
// nothing, until a later observation of its closure terminates it.
export function serviceDomainQuarantined(tx: Tx, args: { domain: string; observed: string }): { quarantined: boolean } {
  const d = tx.db.prepare(`SELECT * FROM "execution_domains" WHERE "id" = ? AND "profile" = 'service'`).get(args.domain) as ServiceDomainRow | undefined;
  if (!d || d.status === 'terminated' || d.status === 'quarantined') return { quarantined: false };
  const a = getAttempt(tx.db, d.attempt);
  if (a) closeAttemptLaunch(tx, a, 'closure_unobserved');
  else if (d.launch_state !== 'closed') tx.db.prepare(`UPDATE "execution_domains" SET "launch_state" = 'closed', "launch_closed_at" = ? WHERE "id" = ?`).run(tx.at, d.id);
  quarantineDomain(tx, { domain: d.id, subject: { attempt: d.attempt } });
  tx.db.prepare('UPDATE "execution_domains" SET "observed_at" = ? WHERE "id" = ?').run(tx.at, d.id);
  return { quarantined: true };
}

// What the latest observation of a live service domain found (the driver's
// ruling on slice 26, item A): `unknown` while its unit is loaded under
// another cgroup than the one recorded (its reservation cannot be accounted,
// and every admission is held), `running` once it reads as recorded again.
export function serviceDomainObserved(tx: Tx, args: { domain: string; observation: 'running' | 'unknown' }): void {
  const d = tx.db.prepare(`SELECT "status", "observation" FROM "execution_domains" WHERE "id" = ? AND "profile" = 'service'`).get(args.domain) as { status: string; observation: string | null } | undefined;
  if (!d || d.status === 'terminated' || d.observation === args.observation) return;
  tx.db.prepare('UPDATE "execution_domains" SET "observation" = ?, "observed_at" = ? WHERE "id" = ?').run(args.observation, tx.at, args.domain);
}

// At start, before any launch request is accepted (D4 §9.2; SEAM.md §278):
// the launch of every attempt an earlier incarnation granted or left
// authorizable is closed, on the attempt and on its service domain.
export function closePriorLaunches(tx: Tx, args: { incarnation: string }): { closed: number } {
  const rows = tx.db
    .prepare(`SELECT * FROM "operation_attempts" WHERE "launch_state" IN ('authorizable', 'authorized') AND ("incarnation" IS NULL OR "incarnation" <> ?)`)
    .all(args.incarnation) as AttemptRow[];
  for (const a of rows) closeAttemptLaunch(tx, a, 'engine_restart');
  return { closed: rows.length };
}

// The executions of an operation's rounds not yet ended (the review's m1):
// while any is queued, launching, running or collecting, its link may be
// open, so completion, which may release the lease, waits (D4 §4.7).
function liveExecutionIds(db: Db, operation: string): string[] {
  return (
    db
      .prepare(
        `SELECT "id" FROM "check_executions" WHERE json_extract("deployment", '$.operation') = ? AND "status" IN ('queued', 'materializing', 'running', 'collecting') ORDER BY "execution_seq"`,
      )
      .all(operation) as { id: string }[]
  ).map((r) => r.id);
}

export function liveRoundExecutions(db: Db, args: { operation: string }): { count: number } {
  return { count: liveExecutionIds(db, args.operation).length };
}

// What a post-deploy check's service link may reach, read at each
// connection (D4 §5.2; J8; SEAM.md §268): the execution's frozen binding,
// and whether its generation's service may be reached now: the
// environment's current generation, its domain launched and not ended, its
// supervision `attached` (E116: otherwise `redaction_unavailable`).
export function linkTarget(db: Db, args: { execution: string }): {
  ok: boolean;
  reason: string | null;
  binding: { execution: string; round: string; operation: string; attempt: string; generation: number; instance: { pid: number; start_time: number } | null } | null;
} {
  const x = db.prepare('SELECT "id", "deployment", "environment" FROM "check_executions" WHERE "id" = ?').get(args.execution) as { id: string; deployment: string | null; environment: string | null } | undefined;
  const dep = parseJson<{ operation?: string; attempt?: string; deployment_generation?: number; round?: string }>(x?.deployment ?? null);
  if (!x || !dep || !dep.attempt || !dep.operation || !dep.round || !Number.isInteger(dep.deployment_generation)) return { ok: false, reason: 'not_bound', binding: null };
  const a = getAttempt(db, dep.attempt);
  const app = a ? parseJson<Instance>(a.app_instance) : null;
  const binding = { execution: x.id, round: dep.round, operation: dep.operation, attempt: dep.attempt, generation: dep.deployment_generation!, instance: app ? { pid: app.pid, start_time: app.start_time } : null };
  const env = x.environment ? getEnv(db, x.environment) : undefined;
  if (!a || !env) return { ok: false, reason: 'not_bound', binding };
  if (env.current_generation !== dep.deployment_generation) return { ok: false, reason: 'generation_not_current', binding };
  const d = serviceDomainOf(db, a.id);
  if (!d || d.status !== 'launched') return { ok: false, reason: 'domain_not_running', binding };
  if (attemptSupervision(db, a) !== 'attached') return { ok: false, reason: 'redaction_unavailable', binding };
  return { ok: true, reason: null, binding };
}

// ---- the receipt and the reconcile read (D4 §§2.3, 2.4; J1) ---------------------------------------

// The adapter's receipt, recorded as a claim. `issued` is the journal's
// `applied` (the receipt), never the attempt's success; `uncertain`, or any
// call past its bound, leaves the attempt `ambiguous`; `refused` and
// `not_issued` end it `failed` with nothing applied.
export function recordReceipt(tx: Tx, args: { attempt: string; receipt: { result: string; steps: unknown[] }; bound: string | null }): { reconcile: boolean } {
  const a = getAttempt(tx.db, args.attempt);
  if (!a) throw notFound('attempt', args.attempt);
  const op = getOp(tx.db, a.operation)!;
  // A receipt arriving after the operation's orchestration ended (superseded
  // or failed by a preempting teardown) appends nothing and changes nothing
  // (the slice-27 review, m5).
  if (op.orchestration_stage === 'ended') return { reconcile: false };
  if (a.status !== 'started') return { reconcile: a.status === 'ambiguous' };
  tx.db.prepare('UPDATE "operation_attempts" SET "receipt" = ? WHERE "id" = ?').run(JSON.stringify({ result: args.receipt.result, provenance: 'claimed', steps: args.receipt.steps, bound: args.bound }), a.id);
  const j = journalOf(tx.db, op.id)!;
  if (args.bound === null && args.receipt.result === 'issued') {
    if (j.state === 'intended' || j.state === 'ambiguous') journalAppend(tx, op, 'applied', { provenance: 'claimed', attempt: a.id });
    refreshOp(tx, op.id);
    return { reconcile: true };
  }
  if (args.bound === null && (args.receipt.result === 'refused' || args.receipt.result === 'not_issued')) {
    setAttempt(tx, a, 'failed');
    writeAttemptedOnce(tx, op, a, 'failed');
    closeAttemptLaunch(tx, a, 'not_issued');
    failOperation(tx, op, { code: args.receipt.result, attempt: a.id });
    return { reconcile: false };
  }
  setAttempt(tx, a, 'ambiguous');
  if (j.state !== 'ambiguous') journalAppend(tx, op, 'ambiguous', { attempt: a.id, bound: args.bound });
  refreshOp(tx, op.id);
  return { reconcile: true };
}

// The reconcile read's answer, taken on its way (D4 §2.4): `applied`
// confirms (the attempt `succeeded`, or `reconciled_succeeded` after it was
// ambiguous); `absent` permits a retry after quiescence, at most
// `deploy_auto_retries_max` times by itself; `partial`, `conflicting` and
// `unknown` keep the attempt ambiguous with a blocker, never retried, the
// lease held, and the read made again at every tick.
export function recordReconcile(tx: Tx, args: { attempt: string; outcome: string; read: unknown }): { way: 'confirmed' | 'retry' | 'failed' | 'blocked' } {
  const a = getAttempt(tx.db, args.attempt);
  if (!a) throw notFound('attempt', args.attempt);
  const op = getOp(tx.db, a.operation)!;
  const j = journalOf(tx.db, op.id)!;
  if (j.state === 'confirmed' || j.state === 'finalized') return { way: 'confirmed' };
  if (j.state === 'failed') return { way: 'failed' };
  // An operation whose orchestration ended (preempted, abandoned) takes no
  // further way on; nor does an attempt a later one superseded, which is
  // final and never relabelled (the driver's ruling on slice 26: D4 §2.4
  // governs a deploy attempt while it is its operation's latest).
  if (op.orchestration_stage === 'ended') return { way: 'failed' };
  if (attemptsOf(tx.db, op.id).at(-1)?.id !== a.id) return { way: 'blocked' };
  const read = { outcome: args.outcome, read: args.read };
  // What the read shows beside the operation (D4 §6.3; the driver's ruling,
  // answer 1): any out-of-band change it finds is recorded.
  const inv = inventoryOfRead(args.read);
  if (inv !== null) recordInventoryRead(tx, { environment: frozenOf(op).environment, inventory: inv.inventory, complete: inv.complete, observation: null });
  // A teardown's cleanup record, beside every outcome (D4 §4.6).
  const cleanup = op.kind === 'teardown' ? { cleanup: teardownCleanup(tx.db, op, a, args.read) } : {};
  // Nothing of the environment runs, by a complete read (SEAM.md §278): the
  // environment read then shows nothing running.
  if (args.outcome !== 'unknown' && nothingRuns(args.read)) clearRunning(tx, op, a);
  switch (args.outcome) {
    case 'applied': {
      setAttempt(tx, a, a.status === 'started' ? 'succeeded' : 'reconciled_succeeded', read);
      if (journalOf(tx.db, op.id)!.state !== 'applied') journalAppend(tx, op, 'applied', { provenance: 'reconcile', attempt: a.id });
      journalAppend(tx, op, 'confirmed', { attempt: a.id });
      closeBlocker(tx, op.id, 'the reconcile read confirmed the effect');
      closeRollout(tx, op.id, 'the reconcile read confirmed the effect');
      refreshOp(tx, op.id);
      return { way: 'confirmed' };
    }
    case 'absent': {
      setAttempt(tx, a, 'reconciled_absent', read);
      if (a.launch_state === 'authorizable') closeAttemptLaunch(tx, a, 'reconciled_absent');
      if (journalOf(tx.db, op.id)!.state === 'applied') journalAppend(tx, op, 'ambiguous', { attempt: a.id });
      closeBlocker(tx, op.id, 'the reconcile read found the effect absent');
      closeRollout(tx, op.id, 'the reconcile read found the effect absent');
      const absent = attemptsOf(tx.db, op.id).filter((x) => x.status === 'reconciled_absent').length;
      refreshOp(tx, op.id);
      if (absent <= projectPolicy(tx.db, op.project).deploy_auto_retries_max!) return { way: 'retry' };
      writeAttemptedOnce(tx, op, a, 'failed');
      failOperation(tx, op, { code: 'reconciled_absent', attempt: a.id, retries: absent - 1 });
      return { way: 'failed' };
    }
    case 'partial': {
      // A deploy's `partial` asks the human (D4 §§2.4, 4.4): `rollout_partial`,
      // its retry, teardown or abandonment; it is read again at every tick
      // while the question is open, and a changed outcome takes its own way
      // and invalidates it. A teardown's `partial` blocks, as `unknown` does.
      setAttempt(tx, a, 'reconciled_partial', read);
      if (journalOf(tx.db, op.id)!.state !== 'ambiguous') journalAppend(tx, op, 'ambiguous', { attempt: a.id, outcome: args.outcome });
      writeAttemptedOnce(tx, op, a, 'partial', cleanup);
      refreshOp(tx, op.id);
      if (op.kind === 'deploy') {
        closeBlocker(tx, op.id, 'the reconcile read found the effect partial');
        raiseQuestion(tx, { project: op.project, kind: 'rollout_partial', subjectType: 'operation', subjectId: op.id });
      } else block(tx, op, args.outcome);
      return { way: 'blocked' };
    }
    default: {
      setAttempt(tx, a, 'ambiguous', read);
      if (journalOf(tx.db, op.id)!.state !== 'ambiguous') journalAppend(tx, op, 'ambiguous', { attempt: a.id, outcome: args.outcome });
      writeAttemptedOnce(tx, op, a, 'ambiguous', cleanup);
      closeRollout(tx, op.id, `the reconcile read found the effect ${args.outcome}`);
      refreshOp(tx, op.id);
      block(tx, op, args.outcome);
      return { way: 'blocked' };
    }
  }
}

// Whether a recorded read found nothing of the environment running (the
// slice-26 review, m3): no domain cgroup populated, and every unit it found
// inactive or failed. Anything else, unread included, runs or may.
function nothingRuns(read: unknown): boolean {
  const inv = (read as { inventory?: { kind?: string; state?: string }[] } | null)?.inventory;
  if (!Array.isArray(inv)) return false;
  if (inv.some((e) => e?.kind === 'cgroup' && e.state !== 'absent')) return false;
  return inv.every((e) => e?.kind !== 'unit' || e.state === 'inactive' || e.state === 'failed');
}

// `running` cleared when a read of the current generation's attempt found
// nothing of the environment running (D4 §4.4: "nothing shown running when
// nothing is"; SEAM.md §278); `last_verified` is untouched.
function clearRunning(tx: Tx, op: OpRow, a: AttemptRow): void {
  const env = getEnv(tx.db, frozenOf(op).environment)!;
  if (a.deployment_generation === null || env.current_generation !== a.deployment_generation) return;
  const cleared = tx.db.prepare('UPDATE "environment_records" SET "running" = NULL WHERE "environment" = ? AND "running" IS NOT NULL').run(env.id);
  if (cleared.changes > 0) bumpRevision(tx, env.id);
}

// `attempted` with this attempt's outcome, written once per change (a read
// made again at every tick rewrites nothing).
function writeAttemptedOnce(tx: Tx, op: OpRow, a: AttemptRow, outcome: string, extra: Record<string, unknown> = {}): void {
  const rec = tx.db.prepare('SELECT "attempted" FROM "environment_records" WHERE "environment" = ?').get(frozenOf(op).environment) as { attempted: string | null } | undefined;
  const now = parseJson<{ attempt?: string; outcome?: string; cleanup?: unknown }>(rec?.attempted ?? null);
  if (now?.attempt === a.id && now.outcome === outcome && canonical(now.cleanup ?? null) === canonical(extra.cleanup ?? null)) return;
  writeAttempted(tx, op, a, outcome, extra);
}

// A teardown's cleanup record (D4 §4.6, A.3; SEAM.md §295), from the read
// and the attempt's frozen intent, never from the receipt: every unit it
// covered that the read no longer finds, removed; every resource of the
// environment the read still finds, left, with the reason.
function teardownCleanup(db: Db, op: OpRow, a: AttemptRow, read: unknown): { removed: string[]; left: { resource: string; reason: string }[] } {
  const frozen = frozenOf(op);
  const intent = db.prepare('SELECT "resources" FROM "attempt_intents" WHERE "attempt" = ?').get(a.id) as { resources: string | null } | undefined;
  const stop = parseJson<string[]>(intent?.resources ?? null) ?? [];
  const inv = inventoryOfRead((read as { read?: unknown } | null)?.read ?? read);
  if (inv === null) return { removed: [], left: stop.map((u) => ({ resource: u, reason: 'unread: the read failed' })) };
  const recorded = recordedUnits(db, frozen.environment);
  const unaccounted = new Map(unaccountedUnits(inv.inventory, recorded, recordedCgroups(db, frozen.environment)).map((u) => [u.unit, u.why]));
  const left: { resource: string; reason: string }[] = [];
  for (const e of inv.inventory) {
    if (e.state === 'unread') left.push({ resource: e.resource, reason: 'unread: its state could not be read' });
    else if (unaccounted.get(e.resource) === 'no_intent') left.push({ resource: e.resource, reason: 'not owned: no attempt intent of the environment names it' });
    else if (unaccounted.get(e.resource) === 'other_cgroup') left.push({ resource: e.resource, reason: 'not owned: the manager reports another cgroup than the one the engine recorded' });
    else if (e.kind === 'unit' && !stop.includes(e.resource)) left.push({ resource: e.resource, reason: 'not named by the teardown: its ownership was not established when it was intended' });
    else left.push({ resource: e.resource, reason: `survived: ${e.kind} ${e.state}` });
  }
  const present = new Set(inv.inventory.map((e) => e.resource));
  return { removed: inv.complete ? stop.filter((u) => !present.has(u)) : [], left };
}

const openRollout = (db: Db, op: string): DecisionRow | undefined =>
  db.prepare(`SELECT * FROM "decisions" WHERE "kind" = 'rollout_partial' AND "subject_type" = 'operation' AND "subject_id" = ? AND "status" = 'open'`).get(op) as DecisionRow | undefined;

function closeRollout(tx: Tx, op: string, why: string): void {
  const d = openRollout(tx.db, op);
  if (d) invalidateDecision(tx, d, why);
}

// An attempt `started` by an earlier incarnation (D4 §4.3): its launch is
// closed first, so nothing of that incarnation can still make the effect
// happen; the attempt becomes `ambiguous`, for the reconcile read.
export function attemptOrphaned(tx: Tx, args: { attempt: string; incarnation: string }): void {
  const a = getAttempt(tx.db, args.attempt);
  if (!a || a.status !== 'started' || a.incarnation === args.incarnation) return;
  const op = getOp(tx.db, a.operation)!;
  closeAttemptLaunch(tx, a, 'engine_restart');
  setAttempt(tx, a, 'ambiguous');
  if (journalOf(tx.db, op.id)!.state !== 'ambiguous') journalAppend(tx, op, 'ambiguous', { attempt: a.id, cause: 'engine_restart' });
  refreshOp(tx, op.id);
}

// ---- the finalizer and the first round (D4 §4.2; E112) --------------------------------------------

interface RoundRow {
  id: string;
  project: string;
  operation: string;
  attempt: string;
  round: number;
  candidate: string;
  mapping: string;
  environment: string;
  deployment_generation: number;
  config_identity: string;
  protected_version: string;
  required_checks: string;
  adapter_qualification: string | null;
  status: string;
  registered_at: string;
  deadline_at: string | null;
  step: string;
  reads: string;
  executions: string;
  origin: string;
  lease: number | null;
}

const getRound = (db: Db, id: string): RoundRow | undefined => db.prepare('SELECT * FROM "verification_rounds" WHERE "id" = ?').get(id) as RoundRow | undefined;

function envRecord(tx: Tx, project: string, env: string): { id: string } {
  const row = tx.db.prepare('SELECT "id" FROM "environment_records" WHERE "environment" = ?').get(env) as { id: string } | undefined;
  if (row) return row;
  const id = tx.newId('envr_');
  tx.db
    .prepare('INSERT INTO "environment_records" ("id", "created_at", "project", "environment", "observed") VALUES (?, ?, ?, ?, ?)')
    .run(id, tx.at, project, env, JSON.stringify({ condition: 'unknown', detail: null, observed_at: null, source: null }));
  return { id };
}

// `attempted` is written only by the attempt whose generation is current (J9).
function writeAttempted(tx: Tx, op: OpRow, attempt: AttemptRow, outcome: string, extra: Record<string, unknown> = {}): boolean {
  const frozen = frozenOf(op);
  const env = getEnv(tx.db, frozen.environment)!;
  if (attempt.deployment_generation === null || env.current_generation !== attempt.deployment_generation) return false;
  const rec = envRecord(tx, op.project, env.id);
  const value = { operation: op.id, attempt: attempt.id, generation: attempt.deployment_generation, outcome, at: tx.at, ...extra };
  tx.db.prepare('UPDATE "environment_records" SET "attempted" = ? WHERE "id" = ?').run(JSON.stringify(value), rec.id);
  return true;
}

// The required set a round freezes (D4 §5.3 item 1): every required check
// of the post-deploy kinds in the `alpha_complete` scope.
export type RequiredOf = (db: Db, project: string, candidate: CandidateRow, version: string) => CheckRow[];

// A round registered before any read (E114), its bindings frozen, and the
// dependent `alpha_complete` evaluations stale in this transaction.
// `origin` (SEAM.md §267): the finalizer's first round, the operator's
// `POST …/verify`, or the engine's when a round's bindings changed. `lease`:
// the environment lease generation it runs under, when known now.
function registerRound(tx: Tx, args: { operation: string; requiredOf: RequiredOf; deadlineAt: string | null; origin: 'finalizer' | 'operator' | 'supersession'; lease: number | null }): RoundRow {
  const op = getOp(tx.db, args.operation)!;
  const frozen = frozenOf(op);
  const a = attemptsOf(tx.db, op.id).at(-1)!;
  const effective = effectiveVersion(tx.db, op.project)!;
  const candidate = getCandidate(tx.db, frozen.candidate!)!;
  const required = args.requiredOf(tx.db, op.project, candidate, effective.id).filter((c) => POST_DEPLOY_KINDS.includes(c.kind));
  const q = qualificationOf(tx.db, frozen.adapter, frozen.adapter_version);
  const { k } = tx.db.prepare('SELECT COALESCE(MAX("round"), 0) + 1 AS k FROM "verification_rounds" WHERE "attempt" = ?').get(a.id) as { k: number };
  const id = tx.newId('vr_');
  tx.db
    .prepare(
      `INSERT INTO "verification_rounds" ("id", "created_at", "project", "operation", "attempt", "round", "candidate", "mapping", "environment", "deployment_generation", "config_identity",
         "protected_version", "required_checks", "adapter_qualification", "status", "registered_at", "deadline_at", "step", "origin", "lease")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 'first_read', ?, ?)`,
    )
    .run(
      id,
      tx.at,
      op.project,
      op.id,
      a.id,
      k,
      candidate.id,
      frozen.mapping,
      frozen.environment,
      a.deployment_generation,
      frozen.config_identity,
      effective.id,
      JSON.stringify(required.map((c) => c.id)),
      q?.id ?? null,
      tx.at,
      args.deadlineAt,
      args.origin,
      args.lease,
    );
  tx.emit(
    'deploy.round_registered',
    { project: op.project, operation: op.id, round: id },
    { attempt: a.id, round: k, deployment_generation: a.deployment_generation, required: required.map((c) => c.key), origin: args.origin },
  );
  tx.db.prepare(`UPDATE "gate_evaluations" SET "stale" = 1 WHERE "candidate" = ? AND "gate_kind" = 'alpha_complete' AND "stale" = 0`).run(candidate.id);
  // The newest registered round decides (E114): while it is open the
  // operation is in verification again, whatever stage it had reached.
  tx.db.prepare(`UPDATE "operations" SET "orchestration_stage" = 'verification' WHERE "id" = ? AND "orchestration_stage" IS NOT 'verification'`).run(op.id);
  return getRound(tx.db, id)!;
}

// Whether a round's bindings still hold (D4 §5.3 item 7; E114 item 2;
// SEAM.md §267): null, or why not: the effective protected version changed
// with the same required checks (`protected_change`), or the required set
// changed (`required_set_changed`).
// `unreadable` (the review's m8): what the bindings are now could not be
// read, so whether they hold is unknown.
function roundRebound(db: Db, r: RoundRow, requiredOf: RequiredOf): 'protected_change' | 'required_set_changed' | { unreadable: string } | null {
  const effective = effectiveVersion(db, r.project);
  const candidate = getCandidate(db, r.candidate);
  if (!effective) return { unreadable: 'protected_version' };
  if (!candidate) return { unreadable: 'candidate' };
  const now = requiredOf(db, r.project, candidate, effective.id).filter((c) => POST_DEPLOY_KINDS.includes(c.kind));
  const frozenIds = (JSON.parse(r.required_checks) as string[]).slice().sort();
  const nowIds = now.map((c) => c.id).sort();
  if (effective.id === r.protected_version && canonical(frozenIds) === canonical(nowIds)) return null;
  const keyOf = (id: string) => (db.prepare('SELECT "key" FROM "checks" WHERE "id" = ?').get(id) as { key: string } | undefined)?.key ?? id;
  const frozenKeys = frozenIds.map(keyOf).sort();
  const nowKeys = now.map((c) => c.key).sort();
  return canonical(frozenKeys) === canonical(nowKeys) ? 'protected_change' : 'required_set_changed';
}

// Every execution registered for a round, its retries included.
function roundExecutionIds(db: Db, r: RoundRow): string[] {
  return (db.prepare(`SELECT "id" FROM "check_executions" WHERE "project" = ? AND json_extract("deployment", '$.round') = ? ORDER BY "execution_seq"`).all(r.project, r.id) as { id: string }[]).map(
    (x) => x.id,
  );
}

// A round that will decide nothing more: its queued executions cancelled
// (one already launched is recorded under its own round, deciding nothing).
function cancelRoundQueue(tx: Tx, r: RoundRow, why: string): void {
  for (const id of roundExecutionIds(tx.db, r)) cancelExecution(tx, { execution: id, why });
}

// A round superseded (D4 §5.3 item 7): `superseded` with its reason,
// `deploy.round_superseded`, its queue cancelled, and in the same
// transaction a fresh round (`supersession`) with its own bracketing reads
// and registrations, the superseded round's deadline and lease inherited
// (never renewed, the slice-25 design Q2). Nothing of it is relabelled.
function supersedeRound(tx: Tx, r: RoundRow, reason: 'protected_change' | 'required_set_changed', requiredOf: RequiredOf): RoundRow {
  tx.db.prepare(`UPDATE "verification_rounds" SET "status" = 'superseded', "superseded_reason" = ?, "step" = 'done' WHERE "id" = ? AND "status" = 'open'`).run(reason, r.id);
  cancelRoundQueue(tx, r, `its verification round was superseded (${reason})`);
  tx.emit('deploy.round_superseded', { project: r.project, operation: r.operation, round: r.id }, { reason, round: r.round, attempt: r.attempt });
  return registerRound(tx, { operation: r.operation, requiredOf, deadlineAt: r.deadline_at, origin: 'supersession', lease: r.lease });
}

// The environment lease a round runs under (CD1; SEAM.md §269): the one its
// operation holds, or, when it holds none, a new one if the environment's is
// free. False: another operation holds it (`environment_busy`).
function roundTakeLease(tx: Tx, r: RoundRow, incarnation: string): boolean {
  if (r.lease !== null) return true;
  const op = getOp(tx.db, r.operation)!;
  const frozen = frozenOf(op);
  const mine = operationLeases(tx.db, op)[0];
  let generation: number;
  if (mine) generation = mine.generation;
  else {
    if (environmentLease(tx.db, frozen.environment)) {
      markBusy(tx, op, frozen);
      return false;
    }
    const until = r.deadline_at ?? op.orchestration_deadline_at ?? addSeconds(tx.at, projectPolicy(tx.db, op.project).deploy_orchestration_deadline!);
    generation = takeLease(tx, frozen.environment, incarnation, until).generation;
  }
  tx.db.prepare('UPDATE "verification_rounds" SET "lease" = ? WHERE "id" = ?').run(generation, r.id);
  r.lease = generation;
  clearBusy(tx, frozen);
  return true;
}

function markBusy(tx: Tx, op: OpRow, frozen: FrozenIntent): void {
  if (frozen.work_item === null) return;
  const item = getWorkItem(tx, frozen.work_item);
  if (!item || item.status === 'complete' || item.status === 'cancelled') return;
  const held = environmentLease(tx.db, frozen.environment);
  if (parseJson<{ reason?: string }>(item.blocker)?.reason === 'environment_busy') return;
  tx.db.prepare('UPDATE "work_items" SET "blocker" = ? WHERE "id" = ?').run(JSON.stringify({ reason: 'environment_busy', raised_at: tx.at, decision: null, lease: held?.id ?? null, operation: op.id }), item.id);
}

function clearBusy(tx: Tx, frozen: FrozenIntent): void {
  if (frozen.work_item === null) return;
  const item = getWorkItem(tx, frozen.work_item);
  if (item && parseJson<{ reason?: string }>(item.blocker)?.reason === 'environment_busy') tx.db.prepare('UPDATE "work_items" SET "blocker" = NULL WHERE "id" = ?').run(item.id);
}

// POST /v1/projects/:p/operations/:o/verify (D4 §5.3 item 1, A.8; SEAM.md
// §266): round k+1 of the operation's latest attempt, registered in this
// transaction before any read, its bindings frozen, the dependent
// evaluations stale; under CD1 with its own deadline, the environment lease
// taken again now if free (or when it is, `environment_busy` meanwhile).
export function requestVerification(tx: Tx, args: { project: string; operation: string; incarnation: string }, requiredOf: RequiredOf): CommandResult {
  const op = getOp(tx.db, args.operation);
  if (!op || op.project !== args.project) throw notFound('operation', args.operation);
  const j = journalOf(tx.db, op.id);
  const latest = attemptsOf(tx.db, op.id).at(-1);
  const env = getEnv(tx.db, frozenOf(op).environment);
  // A generation no longer current has nothing of its own running to verify
  // (the review's m2).
  if (
    op.kind !== 'deploy' ||
    !j ||
    j.state !== 'finalized' ||
    !latest ||
    (latest.status !== 'succeeded' && latest.status !== 'reconciled_succeeded') ||
    !env ||
    env.current_generation !== latest.deployment_generation
  ) {
    throw new Refusal(
      409,
      'operation_not_verifiable',
      `Operation ${op.id} is not a finalized deploy whose latest attempt succeeded and whose generation is the environment's current one, so it has nothing running to verify.`,
      'Verify a deploy operation whose effect was confirmed; deploy again to verify a new attempt.',
      { operation: op.id, kind: op.kind, journal: j?.state ?? null, attempt: latest?.status ?? null, generation: latest?.deployment_generation ?? null, current_generation: env?.current_generation ?? null },
    );
  }
  const deadline = addSeconds(tx.at, projectPolicy(tx.db, op.project).deploy_orchestration_deadline!);
  const r = registerRound(tx, { operation: op.id, requiredOf, deadlineAt: deadline, origin: 'operator', lease: null });
  const frozen = frozenOf(op);
  if (frozen.work_item !== null) {
    const item = getWorkItem(tx, frozen.work_item);
    if (item && item.status === 'awaiting_decision') transitionWork(tx, item, 'executing', { blocker: null }, { cause: 'reverification', operation: op.id, round: r.id });
  }
  roundTakeLease(tx, r, args.incarnation);
  return { status: 202, body: { round: { id: r.id, round: r.round, operation: op.id, attempt: r.attempt } }, effects: [{ kind: 'tick' as const }] };
}

// One step of the Release Operator's drive of an open round, before its
// read or registration (D4 §5.3; E110; E114; CD1): a round whose bindings
// changed is superseded; one on a service whose supervision is `unknown` is
// decided at once (`unknown`, naming `supervision`: nothing verifies on it,
// E110); one with no lease waits for it. `go` names the step to take.
export function roundStep(
  tx: Tx,
  args: { round: string; incarnation: string },
  requiredOf: RequiredOf,
): { state: 'gone' } | { state: 'superseded'; next: string } | { state: 'decided'; outcome: string } | { state: 'wait'; reason: string } | { state: 'go'; step: string } {
  const r = getRound(tx.db, args.round);
  if (!r || r.status !== 'open') return { state: 'gone' };
  const why = roundRebound(tx.db, r, requiredOf);
  if (why !== null && typeof why === 'object') {
    const done = finalizeRound(tx, { round: r.id, reads: null, failure: null }, requiredOf);
    return { state: 'decided', outcome: done?.outcome ?? 'unknown' };
  }
  if (why !== null) return { state: 'superseded', next: supersedeRound(tx, r, why, requiredOf).id };
  // A service whose supervision is `unknown` (an engine restart, or its
  // channel lost) is still read through the manager and /proc, and its
  // round's required checks are registered and refused, not run,
  // `redaction_unavailable` (checks.ts; E116; SEAM.md §278); the row names
  // `supervision`, so nothing verifies on it (E110).
  if (attemptSupervision(tx.db, getAttempt(tx.db, r.attempt)!) !== 'attached') refuseUnsupervised(tx, r.project);
  if (!roundTakeLease(tx, r, args.incarnation)) return { state: 'wait', reason: 'environment_busy' };
  return { state: 'go', step: r.step };
}

// The finalizer (D4 §4.2), keyed on the operation and idempotent: the
// confirmed effect recorded once, the environment's `attempted`, and the
// first verification round created, or on replay returned. A teardown's
// records its cleanup and ends.
export function finalizeDeploy(tx: Tx, args: { operation: string; requiredOf: RequiredOf }): { round: string | null; replay: boolean } {
  const op = getOp(tx.db, args.operation)!;
  const j = journalOf(tx.db, op.id)!;
  const existing = tx.db.prepare('SELECT "id" FROM "verification_rounds" WHERE "operation" = ? ORDER BY rowid, "round" LIMIT 1').get(op.id) as { id: string } | undefined;
  if (j.state === 'finalized') return { round: existing?.id ?? null, replay: true };
  if (j.state !== 'confirmed') throw illegal(`finalizing a ${j.state} deploy operation`, { operation: op.id });
  journalAppend(tx, op, 'finalized');
  tx.db.prepare('UPDATE "operations" SET "finalized_at" = ? WHERE "id" = ?').run(tx.at, op.id);
  tx.emit('operation.finalized', { project: op.project, operation: op.id }, { journal_kind: op.kind === 'deploy' ? 'deploy_apply' : 'teardown_apply' });
  const a = attemptsOf(tx.db, op.id).at(-1)!;
  const frozen = frozenOf(op);
  bumpRevision(tx, frozen.environment);
  if (op.kind === 'teardown') {
    const reads = JSON.parse(a.reconciliation_reads) as { result?: string; read?: unknown }[];
    const last = [...reads].reverse().find((r) => r.result === 'applied');
    // `running` speaks for the environment: only the current generation's
    // attempt writes it (J9).
    if (writeAttempted(tx, op, a, 'teardown_applied', { cleanup: teardownCleanup(tx.db, op, a, last?.read ?? null) })) {
      tx.db.prepare('UPDATE "environment_records" SET "running" = NULL WHERE "environment" = ?').run(frozen.environment);
    }
    // What runs was replaced by the engine (D4 §6.3): the changes resolved.
    resolveOnReplacement(tx, { environment: frozen.environment, operation: op.id });
    endOperation(tx, op, 'none', 'teardown_applied');
    return { round: null, replay: false };
  }
  resolveOnReplacement(tx, { environment: frozen.environment, operation: op.id });
  if (writeAttempted(tx, op, a, 'applied')) {
    tx.db
      .prepare('UPDATE "environment_records" SET "running" = ? WHERE "environment" = ?')
      .run(JSON.stringify({ config: frozen.config_version, config_version: frozen.config_number, config_identity: frozen.config_identity, secret_digests: frozen.secret_digests, generation: a.deployment_generation }), frozen.environment);
  }
  tx.db.prepare(`UPDATE "operations" SET "orchestration_stage" = 'verification' WHERE "id" = ?`).run(op.id);
  const round = registerRound(tx, { operation: op.id, requiredOf: args.requiredOf, deadlineAt: null, origin: 'finalizer', lease: frozen.lease.generation });
  return { round: round.id, replay: false };
}

// ---- the round (D4 §5.3; J7; E114) --------------------------------------------------------------

export interface RoundDetail {
  id: string;
  operation: string;
  attempt: string;
  round: number;
  status: string;
  step: string;
  environment: { id: string; prefix: string };
  expect: TargetExpectation[];
  deadline: string;
  executions: string[];
}

// What an identity read of target `t` of attempt `a` expects (D4 §3.4): the
// sealed digest and manifest, the unit and its recorded invocation and
// cgroup, the init and the original application instance, the runtime's hash
// and the start command.
export function expectationOf(db: Db, a: AttemptRow, frozen: FrozenIntent, t: string, unit: string | null, generation: number | null): TargetExpectation {
  const app = parseJson<Instance & { exe: string; exe_sha256: string | null; argv: string[] }>(a.app_instance);
  const init = parseJson<Instance>(a.init_instance);
  const d = serviceDomainOf(db, a.id);
  return {
    target: t,
    digest: frozen.artifact_digest ?? '',
    unit,
    generation,
    instance: app ? { pid: app.pid, start_time: app.start_time } : null,
    init,
    attempt: a.id,
    cgroup: d?.cgroup_path ?? null,
    invocation_id: d?.invocation_id ?? null,
    exe_sha256: frozen.runtime?.sha256 ?? null,
    exe: frozen.runtime?.path ?? null,
    argv: frozen.start ?? null,
    sealed_path: frozen.artifact_path,
    manifest: (frozen.manifest as unknown[] | null) ?? null,
  };
}

export function roundDetail(db: Db, args: { round: string }): RoundDetail | null {
  const r = getRound(db, args.round);
  if (!r) return null;
  const op = getOp(db, r.operation)!;
  const frozen = frozenOf(op);
  const a = getAttempt(db, r.attempt)!;
  const intent = db.prepare('SELECT "create_units" FROM "attempt_intents" WHERE "attempt" = ?').get(a.id) as { create_units: string } | undefined;
  const unit = intent ? ((JSON.parse(intent.create_units) as string[])[0] ?? null) : null;
  const app = parseJson<Instance>(a.app_instance);
  return {
    id: r.id,
    operation: r.operation,
    attempt: r.attempt,
    round: r.round,
    status: r.status,
    step: r.step,
    environment: { id: frozen.environment, prefix: prefixOf(db, frozen.environment) },
    expect: frozen.target_set.map((t) => expectationOf(db, a, frozen, t, unit, r.deployment_generation)),
    deadline: r.deadline_at ?? op.orchestration_deadline_at ?? op.deadline_at,
    executions: JSON.parse(r.executions) as string[],
  };
}

interface ReadEntry {
  bracket: 'first' | 'second';
  reads: IdentityRead[];
  failure: string | null;
  at: string;
}

const sameInstance = (x: Instance | 'unread' | null, y: Instance | null): boolean => x !== 'unread' && x !== null && y !== null && x.pid === y.pid && x.start_time === y.start_time;

// The supervision of an attempt's service (D4 §9.2; E110): `attached` only
// while the incarnation that granted its launch is the running one; after
// an engine restart it is `unknown` for the rest of the domain's life, and
// no verification passes on it (§5.3). A launch never granted supervises
// nothing.
// A control channel lost in the granting incarnation (`supervision_lost_at`,
// the slice-25 design Q15) makes it `unknown` too, for good.
export function supervisionOf(a: { incarnation: string | null; init_instance: string | null }, lostAt: string | null = null): 'attached' | 'unknown' {
  let current: string | undefined;
  try {
    current = engineSettings().incarnation;
  } catch {
    current = undefined;
  }
  return a.init_instance !== null && current !== undefined && a.incarnation === current && lostAt === null ? 'attached' : 'unknown';
}

// An attempt's supervision, read with its service domain's lost channel.
export function attemptSupervision(db: Db, a: AttemptRow): 'attached' | 'unknown' {
  return supervisionOf(a, (serviceDomainOf(db, a.id) as { supervision_lost_at?: string | null } | undefined)?.supervision_lost_at ?? null);
}

// Whether a result was recorded after the service's supervision was lost
// (the slice-36 review's M2): by the store's event order, its check.result
// after the highest seq at the loss; none recorded is after (unknown fails
// closed). A loss with no recorded order falls back to the times.
export function resultAfterLoss(db: Db, args: { result: string; finishedAt: string | null; lostAt: string; lostSeq: number | null }): boolean {
  if (args.lostSeq === null) return args.finishedAt === null || Date.parse(args.finishedAt) >= Date.parse(args.lostAt);
  const ev = db.prepare(`SELECT MIN("seq") AS s FROM "events" WHERE "type" = 'check.result' AND json_extract("subject", '$.check_result') = ?`).get(args.result) as { s: number | null };
  return ev.s === null || ev.s > args.lostSeq;
}

// The service's control channel closed while this incarnation supervised it
// (D4 §9.2; E110): its supervision is `unknown` from now on, durably.
export function supervisionLost(tx: Tx, args: { attempt: string; why: string }): void {
  const a = getAttempt(tx.db, args.attempt);
  const d = a ? serviceDomainOf(tx.db, a.id) : undefined;
  if (!a || !d || (d as { supervision_lost_at?: string | null }).supervision_lost_at) return;
  // A domain whose application's exit was reported, or whose closure was
  // observed, has nothing left to supervise.
  if (d.app_exit !== null || d.status === 'terminated') return;
  // The record is the column; D4 A.5 names no event for it.
  const { seq } = tx.db.prepare('SELECT COALESCE(MAX("seq"), 0) AS seq FROM "events"').get() as { seq: number };
  tx.db.prepare('UPDATE "execution_domains" SET "supervision_lost_at" = ?, "supervision_lost_seq" = ? WHERE "id" = ? AND "supervision_lost_at" IS NULL').run(tx.at, seq, d.id);
}

// The reads a bracket recorded, one per target: what the adapter answered,
// or, when the read failed, every value it should have returned `unread`.
function readsFor(targets: string[], expect: RoundDetail['expect'], reads: IdentityRead[] | null, at: string): IdentityRead[] {
  return targets.map((t) => {
    const x = Array.isArray(reads) ? reads.find((y) => y?.target === t) : undefined;
    if (x) return { target: x.target, method: x.method, expected: x.expected, read: x.read, match: x.match, instance: x.instance, generation: x.generation, at: x.at, duration_ms: x.duration_ms ?? null, detail: x.detail ?? null };
    return { target: t, method: 'tree_digest', expected: expect.find((e) => e.target === t)?.digest ?? '', read: 'unread', match: 'unread', instance: 'unread', generation: 'unread', at, duration_ms: null, detail: { field: 'read', failure: 'no read' } };
  });
}

// The first identity read (D4 §5.3 item 2) naming its round; with every
// target matching the original instance, the round's required checks
// registered with trigger (deployment_verification, O:N, k), bound to the
// round (item 3).
export function roundFirstRead(tx: Tx, args: { round: string; reads: IdentityRead[] | null; failure: string | null; checksOf: (db: Db, ids: string[]) => CheckRow[] }): { next: 'checks' | 'finalize' | 'none' } {
  const r = getRound(tx.db, args.round);
  if (!r || r.status !== 'open' || r.step !== 'first_read') return { next: 'none' };
  const detail = roundDetail(tx.db, { round: r.id })!;
  const op = getOp(tx.db, r.operation)!;
  const frozen = frozenOf(op);
  const a = getAttempt(tx.db, r.attempt)!;
  const reads = readsFor(frozen.target_set, detail.expect, args.reads, tx.at);
  const entries = JSON.parse(r.reads) as ReadEntry[];
  entries.push({ bracket: 'first', reads, failure: args.failure, at: tx.at });
  roundReadChanges(tx, r, args.reads);
  const app = parseJson<Instance>(a.app_instance);
  const matched = reads.every((x) => x.match === 'match' && sameInstance(x.instance, app));
  if (!matched) {
    tx.db.prepare(`UPDATE "verification_rounds" SET "reads" = ?, "step" = 'second_read' WHERE "id" = ?`).run(JSON.stringify(entries), r.id);
    return { next: 'finalize' };
  }
  const candidate = getCandidate(tx.db, r.candidate)!;
  const checks = args.checksOf(tx.db, JSON.parse(r.required_checks) as string[]);
  const trigger = { source: 'deployment_verification' as const, id: `${op.id}:${a.attempt_number}`, generation: r.round };
  const made = registerExecutions(tx, {
    project: op.project,
    candidate,
    checks,
    trigger,
    binding: { environment: frozen.environment, artifact_digest: frozen.artifact_digest!, deployment: { operation: op.id, attempt: a.id, deployment_generation: r.deployment_generation, round: r.id } },
  });
  tx.db.prepare(`UPDATE "verification_rounds" SET "reads" = ?, "step" = 'checks', "executions" = ? WHERE "id" = ?`).run(JSON.stringify(entries), JSON.stringify(made.map((m) => m.id)), r.id);
  return { next: 'checks' };
}

interface ExecRow {
  id: string;
  project: string;
  key: string;
  status: string;
  result: string | null;
  deployment: string | null;
  execution_seq: number;
}

// The execution that decides a registration of the round: itself, or the
// latest registered for its check bound to the same round (a recovery
// retry, D3 §2.7).
function latestExecutionFor(db: Db, execution: string): ExecRow | undefined {
  const x = db.prepare('SELECT * FROM "check_executions" WHERE "id" = ?').get(execution) as ExecRow | undefined;
  if (!x || x.deployment === null) return x;
  const round = (JSON.parse(x.deployment) as { round?: string }).round ?? '';
  return (
    (db
      .prepare(`SELECT * FROM "check_executions" WHERE "project" = ? AND "key" = ? AND json_extract("deployment", '$.round') = ? ORDER BY "execution_seq" DESC LIMIT 1`)
      .get(x.project, x.key, round) as ExecRow | undefined) ?? x
  );
}

// Whether the round's executions have all ended, so that the second read
// may be made (item 5: after the last required execution's result).
export function roundChecksDone(tx: Tx, args: { round: string }): { done: boolean } {
  const r = getRound(tx.db, args.round);
  if (!r || r.status !== 'open') return { done: false };
  if (r.step === 'second_read') return { done: true };
  if (r.step !== 'checks') return { done: false };
  const done = (JSON.parse(r.executions) as string[]).every((id) => {
    const latest = latestExecutionFor(tx.db, id);
    return latest !== undefined && ['recorded', 'cancelled', 'interrupted'].includes(latest.status);
  });
  if (done) tx.db.prepare(`UPDATE "verification_rounds" SET "step" = 'second_read' WHERE "id" = ?`).run(r.id);
  return { done };
}

// A result row bound to round `r`: its deployment binding names the round,
// its operation and attempt, and it is of the round's candidate and
// protected version.
function resultBoundTo(res: ResultRow, r: RoundRow): boolean {
  const b = parseJson<{ round?: string; operation?: string; attempt?: string; deployment_generation?: number }>(res.deployment);
  return b !== null && b.round === r.id && b.operation === r.operation && b.attempt === r.attempt && b.deployment_generation === r.deployment_generation && res.candidate === r.candidate && res.protected_version === r.protected_version;
}

interface ResultRow {
  id: string;
  finished_at: string | null;
  deployment: string | null;
  candidate: string;
  protected_version: string;
  execution_established: number;
  signaled: number;
  deadline_hit: number;
  orphans: number | null;
  exit_status: number | null;
  invalidated_at: string | null;
}

export const resultState = (r: Pick<ResultRow, 'execution_established' | 'signaled' | 'deadline_hit' | 'orphans' | 'exit_status'>): 'passed' | 'failed' | 'skipped' => {
  if (r.execution_established === 0) return 'skipped';
  if (r.signaled === 1 || r.deadline_hit === 1 || r.orphans !== 0 || r.exit_status === null || r.exit_status !== 0) return 'failed';
  return 'passed';
};

// The verification row (D4 §5.3 item 6) and its effects (item 8), in one
// transaction that checks the environment's current generation and that
// the round decides.
export function finalizeRound(
  tx: Tx,
  args: { round: string; reads: IdentityRead[] | null; failure: string | null; reason?: 'deadline' | 'preempted' },
  requiredOf?: RequiredOf,
): { outcome: string; decides: boolean } | null {
  const r = getRound(tx.db, args.round);
  if (!r || r.status !== 'open') return null;
  // Bindings that changed since the round's registration supersede it: it
  // is never decided under them (D4 §5.3 item 7; SEAM.md §267).
  let unboundBy: string | null = null;
  if (requiredOf) {
    const why = roundRebound(tx.db, r, requiredOf);
    if (why !== null && typeof why === 'object') unboundBy = why.unreadable;
    else if (why !== null) {
      supersedeRound(tx, r, why, requiredOf);
      return null;
    }
  }
  const op = getOp(tx.db, r.operation)!;
  const frozen = frozenOf(op);
  const a = getAttempt(tx.db, r.attempt)!;
  const app = parseJson<Instance>(a.app_instance);
  const detail = roundDetail(tx.db, { round: r.id })!;
  const entries = JSON.parse(r.reads) as ReadEntry[];
  const executions = JSON.parse(r.executions) as string[];
  if (args.reason === undefined && r.step === 'second_read' && executions.length > 0) {
    entries.push({ bracket: 'second', reads: readsFor(frozen.target_set, detail.expect, args.reads, tx.at), failure: args.failure, at: tx.at });
    roundReadChanges(tx, r, args.reads);
  }
  const missing: { kind: string; id: string }[] = [];
  let differs = false;
  for (const bracket of ['first', 'second'] as const) {
    const entry = entries.find((x) => x.bracket === bracket);
    if (!entry) {
      missing.push({ kind: 'identity_read', id: bracket });
      continue;
    }
    for (const x of entry.reads) {
      // A read that differs is a difference whatever else it could not
      // read (another generation's unit, M316 (d)); an unread one is absent
      // evidence; a match on another instance is a difference too.
      if (x.match === 'differs') differs = true;
      else if (x.match === 'unread' || x.instance === 'unread') missing.push({ kind: 'identity_read', id: `${bracket}:${x.target}` });
      else if (!sameInstance(x.instance, app)) differs = true;
    }
  }
  // A result that finished after the service's control channel was lost is
  // no evidence (the driver's ruling m3 on D4 §5.3 item 6): missing, naming
  // supervision; one that finished before the loss still counts.
  const lostDomain = serviceDomainOf(tx.db, a.id) as { supervision_lost_at?: string | null; supervision_lost_seq?: number | null } | undefined;
  const lostAt = lostDomain?.supervision_lost_at ?? null;
  const lostSeq = lostDomain?.supervision_lost_seq ?? null;
  // Whether a result came after the loss is read in the store's order (the
  // slice-36 review's M2): its check.result event after the highest seq at
  // the loss; a result with no such event is taken to be after (unknown
  // fails closed). A loss recorded before this order was kept falls back
  // to the times.
  const recordedAfterLoss = (res: ResultRow): boolean => resultAfterLoss(tx.db, { result: res.id, finishedAt: res.finished_at, lostAt: lostAt!, lostSeq });
  // The deciding results of the round's required checks (item 6).
  const required = (JSON.parse(r.required_checks) as string[]).map((id) => tx.db.prepare('SELECT "id", "key", "kind" FROM "checks" WHERE "id" = ?').get(id) as { id: string; key: string; kind: string });
  const results: { check: string; key: string; kind: string; execution: string | null; result: string | null; state: string }[] = [];
  let failedCheck = false;
  for (const c of required) {
    const reg = executions.map((id) => latestExecutionFor(tx.db, id)).find((x) => x?.key === c.key);
    const res = reg?.result ? (tx.db.prepare('SELECT * FROM "check_results" WHERE "id" = ?').get(reg.result) as ResultRow | undefined) : undefined;
    // Only a result bound to this round, of its candidate and protected
    // version, is ever selected for it (D4-V01; E114).
    const afterLoss = res !== undefined && lostAt !== null && recordedAfterLoss(res);
    const state = res && res.invalidated_at === null && resultBoundTo(res, r) && !afterLoss ? resultState(res) : 'missing';
    if (state === 'failed') failedCheck = true;
    // A required check never registered is named by its id (SEAM.md §279).
    if (state !== 'passed' && state !== 'failed') missing.push({ kind: reg ? 'check_result' : 'check_execution', id: reg?.id ?? c.id });
    results.push({ check: c.id, key: c.key, kind: c.kind, execution: reg?.id ?? null, result: res?.id ?? null, state });
  }
  const behaviour = results.some((x) => x.kind === 'post_deploy_behavior' && x.state === 'passed');
  const q = qualificationOf(tx.db, frozen.adapter, frozen.adapter_version);
  const qualified = r.adapter_qualification !== null && q?.id === r.adapter_qualification;
  if (!qualified) missing.push({ kind: 'qualification', id: r.adapter_qualification ?? frozen.adapter });
  if (args.reason === 'deadline') missing.push({ kind: 'deadline', id: detail.deadline });
  // Ended by a preempting teardown (D4 §4.6): unknown, never decided on.
  if (args.reason === 'preempted') missing.push({ kind: 'preempted', id: r.operation });
  // An out-of-band change of the environment between the first read and
  // now, or open at the first read (D4 §5.3 item 6; the driver's ruling):
  // never verified; `unknown` unless a read itself differs.
  const first = entries.find((x) => x.bracket === 'first');
  if (first) for (const id of changesInInterval(tx.db, { environment: frozen.environment, from: first.at, to: tx.at })) missing.push({ kind: 'out_of_band', id });
  // The service's supervision, attached throughout (item 6; E110): after a
  // restart the round is `unknown`, naming it.
  if (attemptSupervision(tx.db, a) !== 'attached') missing.push({ kind: 'supervision', id: a.id });
  // Bindings that could not be read (m8): unknown, never decided as held.
  if (unboundBy !== null) missing.push({ kind: 'binding', id: unboundBy });
  let outcome: 'verified' | 'failed' | 'unknown';
  // A preempted round is recorded `unknown` naming what it lacked (D4 §4.6
  // step 2), whatever it had read.
  if (args.reason === 'preempted') outcome = 'unknown';
  else if (differs || failedCheck) outcome = 'failed';
  else if (missing.length === 0 && behaviour && results.every((x) => x.state === 'passed')) outcome = 'verified';
  else {
    outcome = 'unknown';
    if (!behaviour && missing.length === 0) missing.push({ kind: 'check_result', id: 'post_deploy_behavior' });
  }
  // The guards (§4.5; J9): the environment's current generation, and the
  // newest registered round of the operation's current attempt.
  const env = getEnv(tx.db, frozen.environment)!;
  const newest = tx.db.prepare('SELECT "id" FROM "verification_rounds" WHERE "operation" = ? ORDER BY rowid DESC, "round" DESC LIMIT 1').get(op.id) as { id: string };
  const latestAttempt = attemptsOf(tx.db, op.id).at(-1)!;
  const current = env.current_generation === r.deployment_generation;
  const decides = newest.id === r.id && latestAttempt.id === r.attempt;
  const invalidated = !current ? 'generation_superseded' : !decides ? 'round_superseded' : null;
  const id = tx.newId('dv_');
  const identityReads = entries.flatMap((e) => e.reads.map((x) => ({ target: x.target, method: x.method, expected: x.expected, read: x.read, match: x.match, instance: x.instance, generation: x.generation, at: x.at, duration_ms: x.duration_ms ?? null, detail: x.detail ?? null, bracket: e.bracket })));
  tx.db
    .prepare(
      `INSERT INTO "deployment_verifications" ("id", "created_at", "project", "environment", "operation", "attempt", "round", "deployment_generation", "candidate", "target_set", "artifact_digest",
         "mapping", "config_identity", "protected_version", "identity_reads", "behavioral_results", "adapter_qualification", "outcome", "missing", "computed_at", "invalidated_at", "invalidated_reason")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      tx.at,
      op.project,
      env.id,
      op.id,
      r.attempt,
      r.id,
      r.deployment_generation,
      r.candidate,
      JSON.stringify(frozen.target_set),
      frozen.artifact_digest,
      r.mapping,
      r.config_identity,
      r.protected_version,
      JSON.stringify(identityReads),
      JSON.stringify(results),
      r.adapter_qualification,
      outcome,
      missing.length === 0 ? null : JSON.stringify(missing),
      tx.at,
      invalidated === null ? null : tx.at,
      invalidated,
    );
  tx.db.prepare(`UPDATE "verification_rounds" SET "status" = 'decided', "step" = 'done', "reads" = ? WHERE "id" = ?`).run(JSON.stringify(entries), r.id);
  cancelRoundQueue(tx, r, 'its verification round was decided');
  if (args.reason === 'deadline') tx.emit('deploy.orchestration_deadline', { project: op.project, operation: op.id }, { stage: 'verification', round: r.id });
  tx.emit('environment.verified', { project: op.project, environment: env.id, operation: op.id }, { verification: id, round: r.id, outcome, deployment_generation: r.deployment_generation, invalidated_reason: invalidated });
  if (invalidated === null) {
    const rec = envRecord(tx, op.project, env.id);
    if (outcome === 'verified') {
      tx.db
        .prepare('UPDATE "environment_records" SET "last_verified" = ? WHERE "id" = ?')
        .run(
          JSON.stringify({ candidate: r.candidate, artifact_digest: frozen.artifact_digest, config_identity: r.config_identity, generation: r.deployment_generation, round: r.id, operation: op.id, at: tx.at, verification: id }),
          rec.id,
        );
    } else writeAttempted(tx, op, a, outcome === 'failed' ? 'verification_failed' : 'verification_unknown');
  }
  // Completion follows the newest round's row, at a later tick (SEAM.md
  // §270); an older round's late row leaves the stage as it is.
  if (newest.id === r.id) tx.db.prepare(`UPDATE "operations" SET "orchestration_stage" = 'completion' WHERE "id" = ? AND "orchestration_stage" = 'verification'`).run(op.id);
  tx.db.prepare(`UPDATE "gate_evaluations" SET "stale" = 1 WHERE "candidate" = ? AND "gate_kind" = 'alpha_complete' AND "stale" = 0`).run(r.candidate);
  return { outcome, decides: invalidated === null };
}

// What a round's own identity read shows beside the round (D4 §6.3; the
// driver's ruling, answer 1): a read of the environment's current generation
// that differs records the change; the round's own unit's states are its
// operation's, never out of band.
function roundReadChanges(tx: Tx, r: RoundRow, reads: IdentityRead[] | null): void {
  if (!Array.isArray(reads)) return;
  const env = getEnv(tx.db, r.environment);
  if (!env || env.current_generation !== r.deployment_generation) return;
  recordIdentityReads(tx, { environment: env.id, reads, observation: null });
}

// ---- completion (D4 §5.5; J5, J9) ---------------------------------------------------------------

export interface DeployVerdict {
  reasons: { code: string; subjects: string[] }[];
  // The deciding results a satisfied completion rests on, re-read now.
  results: { check: string; key: string; result: string | null; state: string }[];
}

// What `alpha_complete` reads of the deployment (gates.ts): the verification
// row of the deciding round of the operation's current attempt, never a
// stored label trusted (AR B05): its generation current, its round
// deciding, its qualification standing, its results re-read.
export function deploymentVerdict(db: Db, args: { operation: string }): DeployVerdict {
  const op = getOp(db, args.operation)!;
  const frozen = frozenOf(op);
  const latest = attemptsOf(db, op.id).at(-1);
  const round = latest ? (db.prepare('SELECT * FROM "verification_rounds" WHERE "attempt" = ? ORDER BY "round" DESC LIMIT 1').get(latest.id) as RoundRow | undefined) : undefined;
  if (!round) return { reasons: [{ code: 'DEPLOY_VERIFICATION_MISSING', subjects: [op.id] }], results: [] };
  if (round.status === 'open') return { reasons: [{ code: 'DEPLOY_VERIFICATION_PENDING', subjects: [round.id] }], results: [] };
  const row = db.prepare('SELECT * FROM "deployment_verifications" WHERE "round" = ?').get(round.id) as
    | { id: string; outcome: string; deployment_generation: number; invalidated_reason: string | null; behavioral_results: string; adapter_qualification: string | null }
    | undefined;
  if (!row) return { reasons: [{ code: 'DEPLOY_VERIFICATION_MISSING', subjects: [round.id] }], results: [] };
  const reasons: DeployVerdict['reasons'] = [];
  const env = getEnv(db, frozen.environment)!;
  if (row.invalidated_reason === 'generation_superseded' || env.current_generation !== row.deployment_generation) reasons.push({ code: 'DEPLOY_GENERATION_SUPERSEDED', subjects: [row.id] });
  else if (row.invalidated_reason !== null) reasons.push({ code: 'DEPLOY_VERIFICATION_PENDING', subjects: [row.id] });
  if (row.outcome === 'failed') reasons.push({ code: 'DEPLOY_VERIFICATION_FAILED', subjects: [row.id] });
  else if (row.outcome === 'unknown') reasons.push({ code: 'DEPLOY_VERIFICATION_UNKNOWN', subjects: [row.id] });
  else if (qualificationOf(db, frozen.adapter, frozen.adapter_version)?.id !== row.adapter_qualification) reasons.push({ code: 'DEPLOY_VERIFICATION_UNKNOWN', subjects: [row.id] });
  // The round's bindings as they are now (AR B05): a protected version that
  // is no longer the effective one leaves no verification under the current
  // one (the slice-25 design Q3: refused, no automatic round).
  const effective = effectiveVersion(db, op.project);
  if (effective?.id !== round.protected_version) reasons.push({ code: 'DEPLOY_VERIFICATION_MISSING', subjects: [round.id] });
  const stored = JSON.parse(row.behavioral_results) as { check: string; key: string; result: string | null }[];
  const lost: string[] = [];
  const results = stored.map((s) => {
    const res = s.result ? (db.prepare('SELECT * FROM "check_results" WHERE "id" = ?').get(s.result) as ResultRow | undefined) : undefined;
    const intact = res !== undefined && res.invalidated_at === null && resultBoundTo(res, round);
    if (!intact && s.result !== null) lost.push(s.result);
    return { check: s.check, key: s.key, result: s.result, state: intact ? resultState(res) : 'missing' };
  });
  // A deciding result invalidated or lost after the row: the stored label is
  // not trusted (D4 §5.5; SEAM.md §270), the row and the results named.
  if (row.outcome === 'verified' && lost.length > 0) reasons.push({ code: 'DEPLOY_VERIFICATION_MISSING', subjects: [row.id, ...lost] });
  // Executions of the operation's rounds still live (an older round's, its
  // link perhaps open): pending, named (D4 §5.5 "the pending executions";
  // §4.7; the review's m1).
  const live = liveExecutionIds(db, op.id);
  if (live.length > 0) reasons.push({ code: 'DEPLOY_VERIFICATION_PENDING', subjects: live });
  // An open out-of-band change of the environment (J6; D4 §6.3): an
  // acknowledged one is a disposition and holds nothing here.
  const open = openChanges(db, frozen.environment);
  if (open.length > 0) reasons.push({ code: 'OUT_OF_BAND_CHANGE', subjects: open.map((r) => r.id) });
  return { reasons, results };
}

// A satisfied `alpha_complete` (§5.5), in the evaluation's transaction: the
// candidate `developing → alpha_deployed` and the deploy work item
// complete; the lease released. Not satisfied, an operation at its
// completion ends with the lease released and the work item waiting on a
// blocker that names the cause (§4.7).
export function afterCompletion(tx: Tx, args: { operation: string; candidate: string; satisfied: boolean; evaluation: string; reasons: string[] }): void {
  const op = getOp(tx.db, args.operation);
  if (!op) return;
  if (args.satisfied) {
    const c = getCandidate(tx.db, args.candidate)!;
    if (c.progress === 'developing') {
      tx.db.prepare(`UPDATE "candidates" SET "progress" = 'alpha_deployed' WHERE "id" = ?`).run(c.id);
      tx.emit('candidate.advanced', { project: c.project, candidate: c.id }, { from: 'developing', to: 'alpha_deployed', evaluation: args.evaluation, operation: op.id });
    }
    endOperation(tx, op, 'complete', 'alpha_complete');
    return;
  }
  // Never while an execution of its rounds is live: its link may be open,
  // and the lease is released only once ingress is closed (D4 §4.7; m1).
  if (liveExecutionIds(tx.db, op.id).length > 0) return;
  if (op.orchestration_stage === 'completion') endOperation(tx, op, 'blocked', `deploy_completion_refused:${args.reasons.join(',')}`, { evaluation: args.evaluation });
}

// ---- reads (D4 §6.1; N02: stored reads only) --------------------------------------------------------

// The service an environment runs now, as the store recorded it: the attempt
// that launched it (the `attempted` fact, while `running` is set) and its
// supervision (D4 §§6.1, 9.2; E110); null when none runs.
export function runningService(db: Db, environment: string): { attempt: string; generation: number | null; supervision: 'attached' | 'unknown' } | null {
  const rec = db.prepare('SELECT "attempted", "running" FROM "environment_records" WHERE "environment" = ?').get(environment) as { attempted: string | null; running: string | null } | undefined;
  if (!rec?.running) return null;
  const attempted = parseJson<{ attempt?: string }>(rec.attempted ?? null);
  const a = attempted?.attempt ? getAttempt(db, attempted.attempt) : undefined;
  if (!a) return null;
  return { attempt: a.id, generation: a.deployment_generation ?? null, supervision: attemptSupervision(db, a) };
}

// ---- the operator relay (D4 §5.2; Q7; SEAM.md §317) ---------------------------------------------

export interface RelayRow {
  attempt: string;
  generation: number | null;
  port: number;
  opened_at: string;
}

const relayOf = (db: Db, environment: string): RelayRow | null =>
  parseJson<RelayRow>((db.prepare('SELECT "relay" FROM "environments" WHERE "id" = ?').get(environment) as { relay: string | null } | undefined)?.relay ?? null);

// What `POST …/relay` opens a relay to: the running generation's service and
// its configured port. Refused when none runs, or when its supervision is
// unknown (`redaction_unavailable`, D4 §§5.2, 7.3).
export function relayTarget(db: Db, args: { project: string; environment: string }): { environment: string; name: string; attempt: string; generation: number | null; port: number; relay: RelayRow | null } {
  const env = environmentByName(db, args.project, args.environment);
  if (!env || env.prefix === null) throw notFound('environment', args.environment);
  // Not while a teardown is asked for or under way (the slice-28 review, m3).
  const tearing = db
    .prepare(`SELECT o."id" FROM "operations" o WHERE o."kind" = 'teardown' AND json_extract(o."target", '$.environment') = ? AND o."orchestration_stage" IS NOT NULL AND o."orchestration_stage" <> 'ended' LIMIT 1`)
    .get(env.id) as { id: string } | undefined;
  if (env.teardown_requested_at !== null || tearing) {
    throw new Refusal(409, 'environment_busy', `A teardown of ${env.name} is asked for or under way: no relay opens.`, 'Wait for the teardown to finish, deploy again, then open the relay.', { environment: env.id, ...(tearing ? { operation: tearing.id } : {}) });
  }
  const svc = runningService(db, env.id);
  if (svc === null) throw new Refusal(409, 'no_running_service', `No service of ${env.name} runs: there is nothing to relay to.`, 'Deploy the environment, then open its relay.', { environment: env.id });
  if (svc.supervision !== 'attached') {
    throw new Refusal(409, 'redaction_unavailable', `The service of ${env.name} survived an engine restart or lost its control channel: the engine cannot screen it, so no relay opens.`, 'Redeploy or tear down the environment; then open the relay to the new service.', { environment: env.id, attempt: svc.attempt });
  }
  const rec = db.prepare('SELECT "running" FROM "environment_records" WHERE "environment" = ?').get(env.id) as { running: string | null } | undefined;
  const running = parseJson<{ config?: string }>(rec?.running ?? null);
  const config = running?.config ? getConfig(db, running.config) : undefined;
  const port = config ? configContent(config).port : undefined;
  if (!Number.isInteger(port)) throw new Refusal(409, 'no_running_service', `The configuration ${env.name}'s service was launched with could not be read.`, 'Redeploy the environment.', { environment: env.id });
  return { environment: env.id, name: env.name, attempt: svc.attempt, generation: svc.generation, port: port as number, relay: relayOf(db, env.id) };
}

// Whether a relay connection may reach the service now: the relay is still
// open to that attempt, which is still the environment's running service,
// supervised.
export function relayCheck(db: Db, args: { environment: string; attempt: string }): boolean {
  const r = relayOf(db, args.environment);
  const svc = runningService(db, args.environment);
  return r !== null && r.attempt === args.attempt && svc !== null && svc.attempt === args.attempt && svc.supervision === 'attached';
}

// The relay opened (the main thread bound its listener first).
export function relayOpened(tx: Tx, args: { environment: string; attempt: string; generation: number | null; port: number }): CommandResult {
  const env = getEnv(tx.db, args.environment);
  if (!env) throw notFound('environment', args.environment);
  const row: RelayRow = { attempt: args.attempt, generation: args.generation, port: args.port, opened_at: tx.at };
  const before = relayOf(tx.db, env.id);
  if (before !== null && before.attempt === args.attempt && before.port === args.port) return { status: 200, body: { environment: { id: env.id, name: env.name }, relay: { ...before, host: '127.0.0.1' } } };
  tx.db.prepare('UPDATE "environments" SET "relay" = ? WHERE "id" = ?').run(JSON.stringify(row), env.id);
  tx.emit('environment.relay_opened', { project: env.project, environment: env.id }, { attempt: args.attempt, generation: args.generation, host: '127.0.0.1', port: args.port });
  return { status: 201, body: { environment: { id: env.id, name: env.name }, relay: { ...row, host: '127.0.0.1' } } };
}

// The relay closed: by command, at a teardown, at its generation's end, at
// a lost supervision, or because the engine that held it restarted. With
// `attempt`, only a relay of that attempt.
export function relayClosed(tx: Tx, args: { environment: string; reason: string; attempt?: string | null; project?: string; name?: string }): CommandResult {
  const env = args.project !== undefined && args.name !== undefined ? environmentByName(tx.db, args.project, args.name) : getEnv(tx.db, args.environment);
  if (!env || env.prefix === null) throw notFound('environment', args.name ?? args.environment);
  const r = relayOf(tx.db, env.id);
  if (r === null || (args.attempt && r.attempt !== args.attempt)) return { status: 200, body: { environment: { id: env.id, name: env.name }, relay: null, closed: false } };
  tx.db.prepare('UPDATE "environments" SET "relay" = NULL WHERE "id" = ?').run(env.id);
  tx.emit('environment.relay_closed', { project: env.project, environment: env.id }, { reason: args.reason, attempt: r.attempt, generation: r.generation, port: r.port });
  return { status: 200, body: { environment: { id: env.id, name: env.name }, relay: null, closed: true } };
}

// At start: a relay lives in the engine that opened it, so every one
// recorded is closed now.
export function relaysReset(tx: Tx): void {
  const rows = tx.db.prepare('SELECT "id" FROM "environments" WHERE "relay" IS NOT NULL').all() as { id: string }[];
  for (const r of rows) relayClosed(tx, { environment: r.id, reason: 'engine_restart' });
}

export function readEnvironment(db: Db, args: { project: string; environment: string }) {
  const env = environmentByName(db, args.project, args.environment);
  if (!env) throw notFound('environment', args.environment);
  const config = currentConfig(db, env);
  const rec = db.prepare('SELECT * FROM "environment_records" WHERE "environment" = ?').get(env.id) as { last_verified: string | null; attempted: string | null; observed: string; running: string | null } | undefined;
  const running = parseJson<{ config: string; secret_digests: { ref: string; digest: string }[] }>(rec?.running ?? null);
  const inFlight = db
    .prepare(
      `SELECT o."id", o."kind", o."status", o."orchestration_stage" FROM "operations" o
       WHERE json_extract(o."target", '$.environment') = ? AND o."orchestration_stage" IS NOT NULL AND o."orchestration_stage" <> 'ended' ORDER BY o."seq" DESC LIMIT 1`,
    )
    .get(env.id) as { id: string; kind: string; status: string; orchestration_stage: string } | undefined;
  const conditions: string[] = [];
  // A held value no longer the one the running service was given (a version
  // `secrets_changed`) is pending replacement too (D4 §§3.2, 7.4; E116).
  if (running && config && (running.config !== config.id || canonical(running.secret_digests) !== canonical(JSON.parse(config.secret_digests)) || config.status === 'secrets_changed')) conditions.push('rotation_pending_replacement');
  // The running service's supervision (§§6.1, 9.2; E110; CD2): the attempt
  // that launched it, from the environment's `attempted` fact.
  const attempted = parseJson<{ attempt?: string; outcome?: string }>(rec?.attempted ?? null);
  const launched = running && attempted?.attempt ? getAttempt(db, attempted.attempt) : undefined;
  const supervision = launched ? attemptSupervision(db, launched) : null;
  // Its output, link, relay and checks withheld (D4 §§6.1, 7.3, A.1; E116).
  if (supervision === 'unknown') conditions.push('supervision_unknown', 'redaction_unavailable');
  return {
    environment: {
      id: env.id,
      name: env.name,
      adapter: env.adapter,
      prefix: env.prefix,
      config: config ? { id: config.id, version: config.version, config_identity: config.config_identity, status: config.status } : null,
      running,
      relay: relayOf(db, env.id),
      deployment_generation: env.deployment_generation,
      current_generation: env.current_generation,
      last_verified: parseJson<Record<string, unknown>>(rec?.last_verified ?? null),
      attempted: parseJson<Record<string, unknown>>(rec?.attempted ?? null),
      // The stored observation, its freshness computed at the read (D4 §6.1;
      // SEAM.md §292): an expired one is never shown as healthy.
      observed: observedRead(db, { project: env.project, observed: rec?.observed ?? null, now: nowIso() }),
      // Every out-of-band change not settled, open or acknowledged (§6.3).
      out_of_band: environmentChangesRead(db, env.id),
      operation_in_flight: inFlight ? { id: inFlight.id, kind: inFlight.kind, status: inFlight.status, stage: inFlight.orchestration_stage } : null,
      supervision,
      teardown_requested_at: env.teardown_requested_at,
      conditions,
    },
  };
}

// The deployment parts of an operation, for the operations read.
export function deployParts(db: Db, op: string) {
  const o = getOp(db, op);
  const j = o ? journalOf(db, op) : undefined;
  if (!o || !j) return null;
  const intended = db.prepare(`SELECT "payload" FROM "deploy_journal_events" WHERE "operation" = ? AND "event_kind" = 'intended' ORDER BY "seq" LIMIT 1`).get(op) as { payload: string } | undefined;
  const intents = db.prepare('SELECT * FROM "attempt_intents" WHERE "operation" = ? ORDER BY rowid').all(op) as Record<string, unknown>[];
  return {
    journal_kind: j.journal_kind,
    state: j.state,
    intent: intended ? (JSON.parse(intended.payload) as Record<string, unknown>) : null,
    orchestration_deadline_at: o.orchestration_deadline_at,
    orchestration_stage: o.orchestration_stage,
    authorization: o.authorization,
    attempt_intents: intents.map((i) => ({
      attempt: i.attempt,
      generation: i.generation,
      create_units: JSON.parse(i.create_units as string) as unknown,
      prior: JSON.parse(i.prior as string) as unknown,
      cleanup: JSON.parse(i.cleanup as string) as unknown,
      resources: JSON.parse(i.resources as string) as unknown,
      preconditions: i.preconditions,
    })),
    rounds: db.prepare('SELECT "id", "round", "attempt", "status", "deployment_generation", "registered_at" FROM "verification_rounds" WHERE "operation" = ? ORDER BY rowid, "round"').all(op),
  };
}

// The journal events of any operation, git's or the deployment's, in order
// (SEAM.md §250).
export function journalEvents(db: Db, op: string): { seq: number; event_kind: string }[] {
  const deploy = db.prepare('SELECT "seq", "event_kind" FROM "deploy_journal_events" WHERE "operation" = ? ORDER BY "seq"').all(op) as { seq: number; event_kind: string }[];
  if (deploy.length > 0) return deploy;
  return db.prepare('SELECT "seq", "event_kind" FROM "git_journal_events" WHERE "operation" = ? ORDER BY "seq"').all(op) as { seq: number; event_kind: string }[];
}

export const isDeployKind = (kind: string): boolean => kind === 'deploy' || kind === 'teardown';

// ---- the adapter qualification's own environment and operations (D4 §2.6; SEAM.md §§322, 323) -----
//
// A run of `surety qualify-adapter` (deploy/qualify.ts) makes its own
// environment in the engine's fixture project, seals its two fixture
// artifacts there, and drives its own deploy and teardown operations
// through the same attempt, capability check, launch grant and reconcile
// reads as any operation; never through the tick (deployWork excludes
// them), with no observation job, and raising no decision of their own.

interface RunRow {
  id: string;
  adapter: string;
  adapter_version: string;
  project: string;
  environment: string | null;
  incarnation: string;
  status: string;
  cases: string | null;
  evidence: string | null;
  qualification: string | null;
  started_at: string;
  ended_at: string | null;
}

const getRun = (db: Db, id: string): RunRow | undefined => db.prepare('SELECT * FROM "adapter_qualification_runs" WHERE "id" = ?').get(id) as RunRow | undefined;

// What an earlier run left of its environment (the driver's ruling: no
// automatic cleanup): every service domain of it not observed terminated,
// by its unit's exact name; and, from `paths` (read on the main thread:
// qualificationPaths), every runtime directory or socket of it still
// present or unread, by its exact path (the slice-29 review, m10).
function leftovers(db: Db, paths: { environment: string; path: string; state: string }[] = []): { environment: string; name: string; units: string[]; paths: string[] }[] {
  const rows = db
    .prepare(
      `SELECT e."id" AS environment, e."name" AS name, d."unit" AS unit FROM "environments" e
         JOIN "operation_attempts" a ON a."project" = e."project"
         JOIN "operations" o ON o."id" = a."operation" AND json_extract(o."target", '$.environment') = e."id"
         JOIN "execution_domains" d ON d."attempt" = a."id" AND d."profile" = 'service'
       WHERE e."qualification_run" IS NOT NULL AND d."status" <> 'terminated' AND d."unit" IS NOT NULL
         AND e."qualification_run" NOT IN (SELECT "id" FROM "adapter_qualification_runs" WHERE "status" = 'running')
       ORDER BY e."id", d."unit"`,
    )
    .all() as { environment: string; name: string; unit: string }[];
  const out = new Map<string, { environment: string; name: string; units: string[]; paths: string[] }>();
  const of = (environment: string) => {
    let e = out.get(environment);
    if (!e) {
      const env = getEnv(db, environment);
      e = { environment, name: env?.name ?? environment, units: [], paths: [] };
      out.set(environment, e);
    }
    return e;
  };
  for (const r of rows) {
    const e = of(r.environment);
    if (!e.units.includes(r.unit)) e.units.push(r.unit);
  }
  const ours = new Set(qualificationPaths(db).map((p) => `${p.environment}\0${p.path}`));
  for (const p of paths) {
    if (p.state === 'absent' || !ours.has(`${p.environment}\0${p.path}`)) continue;
    const e = of(p.environment);
    if (!e.paths.includes(p.path)) e.paths.push(p.path);
  }
  return [...out.values()];
}

// The runtime directories (with their ingress sockets) the service domains
// of every ended run's environment recorded: the main thread reads whether
// each is still there (deploy/qualify.ts) before a run begins.
export function qualificationPaths(db: Db): { environment: string; path: string }[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT e."id" AS environment, d."runtime_dir" AS dir FROM "environments" e
         JOIN "operation_attempts" a ON a."project" = e."project"
         JOIN "operations" o ON o."id" = a."operation" AND json_extract(o."target", '$.environment') = e."id"
         JOIN "execution_domains" d ON d."attempt" = a."id" AND d."profile" = 'service'
       WHERE e."qualification_run" IS NOT NULL AND d."runtime_dir" IS NOT NULL
         AND e."qualification_run" NOT IN (SELECT "id" FROM "adapter_qualification_runs" WHERE "status" = 'running')
       ORDER BY e."id", d."runtime_dir"`,
    )
    .all() as { environment: string; dir: string }[];
  return rows.flatMap((r) => [
    { environment: r.environment, path: r.dir },
    { environment: r.environment, path: `${r.dir}/in.sock` },
  ]);
}

// Whether a unit of `environment` may be acted on by its running
// qualification's hand acts, and the units its attempt intents name (the
// slice-29 review, m6; BS4 §4.1 rule 5): only a qualification environment
// whose run is running, only units the store's intents of its operations
// name.
export function qualificationPermits(db: Db, args: { environment: string }): { running: boolean; units: string[] } {
  const env = getEnv(db, args.environment) as (EnvRow & { qualification_run?: string | null }) | undefined;
  const run = env?.qualification_run ? getRun(db, env.qualification_run) : undefined;
  if (!env || !run || run.status !== 'running') return { running: false, units: [] };
  const rows = db
    .prepare(
      `SELECT i."create_units" FROM "attempt_intents" i JOIN "operations" o ON o."id" = i."operation"
       WHERE json_extract(o."target", '$.environment') = ? AND json_extract(o."finalizer_inputs", '$.qualification') = ?`,
    )
    .all(env.id, run.id) as { create_units: string }[];
  return { running: true, units: [...new Set(rows.flatMap((r) => parseJson<string[]>(r.create_units) ?? []))] };
}

// Whether `attempt` is an attempt of a running qualification's own
// operation (the slice-29 review, m6).
export function qualificationAttemptRunning(db: Db, args: { attempt: string }): boolean {
  const a = getAttempt(db, args.attempt);
  if (!a) return false;
  const op = getOp(db, a.operation);
  const run = op ? frozenOf(op).qualification : null;
  if (!run) return false;
  return getRun(db, run)?.status === 'running';
}

// A run begun (SEAM.md §322): refused while another runs, and while an
// earlier run's environment has units left (409, each named; nothing is
// cleaned). Otherwise the run, its environment (an `env_<ULID>`, its prefix
// this home's) and its configuration, written by the engine.
export function beginQualification(
  tx: Tx,
  args: { adapter: string; adapterVersion: string; project: string; incarnation: string; homeHash: string; content: ConfigContent; identity: string; paths?: { environment: string; path: string; state: string }[] },
): { run: string; environment: string; name: string; prefix: string; config: string } {
  const running = tx.db.prepare(`SELECT * FROM "adapter_qualification_runs" WHERE "adapter" = ? AND "status" = 'running'`).get(args.adapter) as RunRow | undefined;
  if (running && running.incarnation !== args.incarnation) interruptRun(tx, running);
  else if (running) {
    throw new Refusal(409, 'qualification_running', `A qualification of ${args.adapter} is running (${running.id}).`, 'Wait for it to end, then ask again.', { qualification_run: running.id });
  }
  const left = leftovers(tx.db, args.paths ?? []);
  if (left.length > 0) {
    const units = left.flatMap((l) => l.units);
    const paths = left.flatMap((l) => l.paths);
    throw new Refusal(
      409,
      'qualification_left_units',
      `An earlier qualification of ${args.adapter} left resources of its environment: ${[...units, ...paths].join(', ')}.`,
      `Nothing was cleaned. Tear each of these environments down (surety env teardown <name> --project ${args.project}), then ask again.`,
      { project: args.project, environments: left.map((l) => ({ id: l.environment, name: l.name, units: l.units, paths: l.paths })), units, paths },
    );
  }
  if (!/^[0-9a-f]{12}$/.test(args.homeHash)) throw new Error('the home hash is not 12 hex characters');
  const run = tx.newId('aqr_');
  tx.db
    .prepare(
      `INSERT INTO "adapter_qualification_runs" ("id", "created_at", "adapter", "adapter_version", "project", "environment", "incarnation", "status", "started_at")
       VALUES (?, ?, ?, ?, ?, NULL, ?, 'running', ?)`,
    )
    .run(run, tx.at, args.adapter, args.adapterVersion, args.project, args.incarnation, tx.at);
  const env = tx.newId('env_');
  const name = `qualify-${run.slice(-12).toLowerCase()}`;
  const prefix = `surety-${args.homeHash}-${env}-`;
  const verifySpec = JSON.stringify({ identity_method: args.content.identity_method ?? 'none', target_set: args.content.targets });
  tx.db
    .prepare(
      `INSERT INTO "environments" ("id", "created_at", "project", "name", "adapter", "adapter_config_ref", "verify_spec", "deployment_generation", "prefix", "qualification_run")
       VALUES (?, ?, ?, ?, ?, 'environment_configs', ?, 0, ?, ?)`,
    )
    .run(env, tx.at, args.project, name, args.content.adapter, verifySpec, prefix, run);
  const config = tx.newId('envc_');
  tx.db
    .prepare(
      `INSERT INTO "environment_configs" ("id", "created_at", "project", "environment", "version", "content", "config_identity", "secret_digests", "status", "written_by", "written_at")
       VALUES (?, ?, ?, ?, 1, ?, ?, '[]', 'current', 'engine', ?)`,
    )
    .run(config, tx.at, args.project, env, canonical(args.content), args.identity, tx.at);
  tx.db.prepare('UPDATE "environments" SET "current_config" = ? WHERE "id" = ?').run(config, env);
  tx.db.prepare('UPDATE "adapter_qualification_runs" SET "environment" = ? WHERE "id" = ?').run(env, run);
  tx.emit('environment.configured', { project: args.project, environment: env }, { config, version: 1, config_identity: args.identity, name, qualification_run: run });
  return { run, environment: env, name, prefix, config };
}

// The run's fixture artifact, sealed by the main thread, recorded.
export function qualificationArtifact(tx: Tx, args: { run: string; sealed: SealedArtifact }): { digest: string; path: string; manifest: unknown[] } {
  const r = getRun(tx.db, args.run);
  if (!r || r.status !== 'running') throw notFound('running qualification', args.run);
  const a = recordArtifact(tx, r.project, args.sealed);
  return { digest: a.digest, path: a.path, manifest: JSON.parse(a.manifest) as unknown[] };
}

// One deploy or teardown operation of the run's environment, intended under
// the environment lease, its intent frozen with the run.
export function intendQualificationOp(tx: Tx, args: { run: string; kind: 'deploy' | 'teardown'; digest?: string; incarnation: string }): { operation: string } {
  const r = getRun(tx.db, args.run);
  if (!r || r.status !== 'running' || r.environment === null) throw notFound('running qualification', args.run);
  const env = getEnv(tx.db, r.environment)!;
  const held = environmentLease(tx.db, env.id);
  if (held) throw new Refusal(409, 'environment_busy', `The qualification environment ${env.name} is held by another operation.`, 'Wait for it to end.', { environment: env.id, lease: held.id });
  if (args.kind === 'teardown') return { operation: insertTeardown(tx, env, args.incarnation, null, r.id).id };
  const config = currentConfig(tx.db, env)!;
  const content = configContent(config);
  const artifact = getArtifact(tx.db, r.project, args.digest ?? '');
  if (!artifact) throw notFound('artifact', args.digest ?? '');
  const deadline = addSeconds(tx.at, projectPolicy(tx.db, r.project).deploy_orchestration_deadline!);
  const lease = takeLease(tx, env.id, args.incarnation, deadline);
  const frozen: FrozenIntent = {
    purpose: 'deploy',
    work_item: null,
    authorization: null,
    candidate: null,
    mapping: null,
    artifact_digest: artifact.digest,
    artifact_path: artifact.path,
    manifest: JSON.parse(artifact.manifest) as unknown[],
    config_version: config.id,
    config_number: config.version,
    config_identity: config.config_identity,
    secret_digests: [],
    target_set: content.targets,
    environment: env.id,
    environment_name: env.name,
    prefix: env.prefix ?? '',
    adapter: env.adapter,
    adapter_version: content.adapter_version,
    runtime: content.runtime ?? null,
    start: content.start ?? null,
    lease: { id: lease.id, generation: lease.generation },
    qualification: r.id,
  };
  const { n } = tx.db.prepare(`SELECT COUNT(*) + 1 AS n FROM "operations" WHERE json_extract("target", '$.environment') = ?`).get(env.id) as { n: number };
  const op = insertOperation(tx, {
    project: r.project,
    kind: 'deploy',
    env,
    subject: { qualification_run: r.id, artifact_digest: artifact.digest },
    key: sha256(canonical({ kind: 'deploy', environment: env.id, qualification: r.id, n })),
    frozen,
    deadline,
    authorization: null,
  });
  return { operation: op.id };
}

// A qualification operation's attempt whose launch the run closes before
// its effect (D4 §2.6 `late_launcher`).
export function closeQualificationLaunch(tx: Tx, args: { attempt: string }): void {
  const a = getAttempt(tx.db, args.attempt);
  if (!a) throw notFound('attempt', args.attempt);
  if (!frozenOf(getOp(tx.db, a.operation)!).qualification) throw notFound('qualification attempt', args.attempt);
  closeAttemptLaunch(tx, a, 'qualification_late_launcher');
}

// A reconcile read of a qualification attempt, recorded on its attempt and
// taken on its way as D4 §2.4 says, but raising no question: the run itself
// is what reads the outcome (no blocker, no rollout_partial). Anything the
// read shows beside the operation is recorded as for any environment.
export function qualificationReconciled(tx: Tx, args: { attempt: string; outcome: string; read: unknown }): { status: string } {
  const a = getAttempt(tx.db, args.attempt);
  if (!a) throw notFound('attempt', args.attempt);
  const op = getOp(tx.db, a.operation)!;
  const frozen = frozenOf(op);
  if (!frozen.qualification) throw notFound('qualification attempt', args.attempt);
  const inv = inventoryOfRead(args.read);
  if (inv !== null) recordInventoryRead(tx, { environment: frozen.environment, inventory: inv.inventory, complete: inv.complete, observation: null });
  const read = { outcome: args.outcome, read: args.read };
  const j = journalOf(tx.db, op.id)!;
  if (j.state === 'failed' || j.state === 'finalized' || j.state === 'confirmed' || op.orchestration_stage === 'ended') {
    setAttempt(tx, a, a.status, read);
    return { status: a.status };
  }
  if (args.outcome === 'applied') {
    setAttempt(tx, a, a.status === 'started' ? 'succeeded' : 'reconciled_succeeded', read);
    if (journalOf(tx.db, op.id)!.state !== 'applied') journalAppend(tx, op, 'applied', { provenance: 'reconcile', attempt: a.id });
    journalAppend(tx, op, 'confirmed', { attempt: a.id });
  } else if (args.outcome === 'absent') {
    setAttempt(tx, a, 'reconciled_absent', read);
    if (a.launch_state === 'authorizable') closeAttemptLaunch(tx, a, 'reconciled_absent');
    if (journalOf(tx.db, op.id)!.state === 'applied') journalAppend(tx, op, 'ambiguous', { attempt: a.id });
  } else {
    setAttempt(tx, a, args.outcome === 'partial' ? 'reconciled_partial' : 'ambiguous', read);
    if (journalOf(tx.db, op.id)!.state !== 'ambiguous') journalAppend(tx, op, 'ambiguous', { attempt: a.id, outcome: args.outcome });
  }
  refreshOp(tx, op.id);
  return { status: getAttempt(tx.db, a.id)!.status };
}

// A qualification operation ended by its run: a confirmed one finalized as
// any (its `attempted` and `running` written, what runs replaced; no
// verification round, for no candidate is verified here); any other failed
// with what the run read, its launch closed. The lease released either way.
export function endQualificationOp(tx: Tx, args: { operation: string; detail: Record<string, unknown> }): { journal: string } {
  const op = getOp(tx.db, args.operation);
  if (!op) throw notFound('operation', args.operation);
  const frozen = frozenOf(op);
  if (!frozen.qualification) throw notFound('qualification operation', args.operation);
  const j = journalOf(tx.db, op.id)!;
  const a = attemptsOf(tx.db, op.id).at(-1);
  if (j.state === 'confirmed' && a) {
    journalAppend(tx, op, 'finalized');
    tx.db.prepare('UPDATE "operations" SET "finalized_at" = ? WHERE "id" = ?').run(tx.at, op.id);
    tx.emit('operation.finalized', { project: op.project, operation: op.id }, { journal_kind: op.kind === 'deploy' ? 'deploy_apply' : 'teardown_apply' });
    bumpRevision(tx, frozen.environment);
    resolveOnReplacement(tx, { environment: frozen.environment, operation: op.id });
    if (op.kind === 'teardown') {
      if (writeAttempted(tx, op, a, 'teardown_applied')) tx.db.prepare('UPDATE "environment_records" SET "running" = NULL WHERE "environment" = ?').run(frozen.environment);
    } else if (writeAttempted(tx, op, a, 'applied')) {
      tx.db
        .prepare('UPDATE "environment_records" SET "running" = ? WHERE "environment" = ?')
        .run(JSON.stringify({ config: frozen.config_version, config_version: frozen.config_number, config_identity: frozen.config_identity, secret_digests: frozen.secret_digests, generation: a.deployment_generation }), frozen.environment);
    }
    endOperation(tx, op, 'none', 'qualification');
  } else if (j.state !== 'finalized') {
    if (a && a.status === 'started') setAttempt(tx, a, 'failed');
    if (a) closeAttemptLaunch(tx, a, 'qualification');
    if (j.state !== 'failed') failOperation(tx, op, { code: 'qualification_case', ...args.detail });
    else endOperation(tx, op, 'none', 'qualification');
  }
  return { journal: journalOf(tx.db, op.id)!.state };
}

// What the run reads of its environment between its acts: the latest
// observation and the out-of-band rows, and every launch granted per attempt.
export function qualificationFacts(db: Db, args: { environment: string }) {
  const history = db.prepare('SELECT "condition", "detail", "facts", "observed_at" FROM "observation_history" WHERE "environment" = ? ORDER BY rowid DESC LIMIT 1').get(args.environment) as
    | { condition: string; detail: string | null; facts: string | null; observed_at: string }
    | undefined;
  const changes = db.prepare('SELECT rowid AS "seq", "id", "change", "resource", "closed_at", "detected_at" FROM "out_of_band_changes" WHERE "environment" = ? ORDER BY rowid').all(args.environment) as {
    seq: number;
    id: string;
    change: string;
    resource: string;
    closed_at: string | null;
    detected_at: string;
  }[];
  return { observation: history ? { condition: history.condition, detail: parseJson(history.detail), observed_at: history.observed_at } : null, changes };
}

// A run ended (SEAM.md §§322, 323): its cases recorded. It qualifies only
// when it checks for itself that every one of D4 §2.6's nine cases, in
// order, passed beside a passed control, that its evidence is recorded and
// that the host's facts are known (the slice-29 review, S1, m4); then its
// row is recorded current with its evidence (D4 §2.6, A.3), in this
// transaction. A run the engine's stop cut short ends `interrupted`, never
// `unqualified` (S2).
export function endQualification(
  tx: Tx,
  args: { run: string; cases: unknown[]; qualified: boolean; evidence: string | null; interrupted?: boolean },
): { qualification: string | null; status: string; detail: Record<string, unknown> | null } {
  const r = getRun(tx.db, args.run);
  if (!r || r.status !== 'running') throw notFound('running qualification', args.run);
  const cases = (Array.isArray(args.cases) ? args.cases : []) as { case?: unknown; result?: unknown; control?: unknown }[];
  const why: string[] = [];
  if (args.interrupted === true) why.push('the engine stopped during the qualification');
  if (cases.length !== ADAPTER_QUALIFICATION_CASES.length || cases.some((c, i) => c.case !== ADAPTER_QUALIFICATION_CASES[i])) why.push("the cases are not D4 §2.6's nine, in order");
  const short = cases.filter((c) => c.result !== 'passed' || c.control !== 'passed').map((c) => String(c.case));
  if (short.length > 0) why.push(`not passed beside a passed control: ${short.join(', ')}`);
  if (args.evidence === null) why.push('no qualification_evidence record');
  else if (!tx.db.prepare(`SELECT 1 FROM "records" WHERE "id" = ? AND "kind" = 'qualification_evidence'`).get(args.evidence)) why.push(`the evidence ${args.evidence} is not a qualification_evidence record`);
  if (args.qualified !== true && why.length === 0) why.push('the run did not report itself qualified');
  let qualification: string | null = null;
  if (why.length === 0) {
    tx.db.exec('SAVEPOINT qualification_row');
    const events = tx.events.length;
    try {
      qualification = recordAdapterQualification(tx, { adapter: r.adapter, adapterVersion: r.adapter_version, cases: args.cases, label: null, run: r.id, evidence: args.evidence! }).id;
      tx.db.exec('RELEASE qualification_row');
    } catch (err) {
      tx.db.exec('ROLLBACK TO qualification_row');
      tx.db.exec('RELEASE qualification_row');
      tx.events.length = events;
      if (!(err instanceof Refusal)) throw err;
      why.push(err.message);
    }
  }
  const status = args.interrupted === true ? 'interrupted' : qualification !== null ? 'qualified' : 'unqualified';
  // Whatever path ended it, no operation of the run stays open or holds its
  // environment's lease, so the operator's ordinary teardown can take the
  // environment (the slice-29 review, S3).
  const ended = endRunOperations(tx, r);
  if (ended.length > 0) why.push(`ended its open operations ${ended.join(', ')}`);
  // A run that ends unqualified lapses the adapter's current row, in this
  // transaction, naming itself (D4-A06 as Sean decided it); an interrupted
  // run lapses nothing.
  const lapsed: string[] = [];
  if (status === 'unqualified') {
    const current = tx.db.prepare(`SELECT "id" FROM "adapter_qualifications" WHERE "adapter" = ? AND "status" = 'current' ORDER BY rowid`).all(r.adapter) as { id: string }[];
    for (const q of current) if (lapseQualification(tx, { id: q.id, reason: 'qualification_failed', run: r.id }).lapsed !== null) lapsed.push(q.id);
  }
  if (lapsed.length > 0) why.push(`lapsed the current qualification ${lapsed.join(', ')}`);
  const detail = why.length > 0 ? { not_qualified: why, ...(lapsed.length > 0 ? { lapsed } : {}) } : null;
  tx.db
    .prepare(`UPDATE "adapter_qualification_runs" SET "status" = ?, "cases" = ?, "evidence" = ?, "qualification" = ?, "ended_at" = ?, "outcome_detail" = ? WHERE "id" = ?`)
    .run(status, JSON.stringify(args.cases), args.evidence, qualification, tx.at, detail === null ? null : JSON.stringify(detail), r.id);
  return { qualification, status, detail };
}

// The run's open operations ended in the store, with no host act (the
// slice-29 review, S3; the driver's ruling 5): every launch of them closed,
// an attempt left `started` ambiguous (its effect is unknown), a confirmed
// operation finalized, any other failed as interrupted; their leases
// released. What runs is left for the operator's ordinary exact teardown.
function endRunOperations(tx: Tx, r: RunRow): string[] {
  const ops = tx.db
    .prepare(`SELECT * FROM "operations" WHERE json_extract("finalizer_inputs", '$.qualification') = ? AND ("orchestration_stage" IS NULL OR "orchestration_stage" <> 'ended') ORDER BY "seq"`)
    .all(r.id) as OpRow[];
  for (const op of ops) {
    for (const a of attemptsOf(tx.db, op.id)) {
      closeAttemptLaunch(tx, a, 'qualification_interrupted');
      if (a.status === 'started') setAttempt(tx, a, 'ambiguous');
    }
    const j = journalOf(tx.db, op.id)!;
    if (j.state === 'confirmed') endQualificationOp(tx, { operation: op.id, detail: { code: 'qualification_interrupted' } });
    else if (j.state === 'failed' || j.state === 'finalized') endOperation(tx, op, 'none', 'qualification_interrupted');
    else failOperation(tx, op, { code: 'qualification_interrupted' });
    releaseOperationLeases(tx, getOp(tx.db, op.id)!);
  }
  return ops.map((o) => o.id);
}

// The sealed fixture copies of each run an earlier incarnation left
// running, for its interruption's rehash on the main thread.
export function runArtifacts(db: Db, args: { incarnation: string }): { run: string; project: string; digest: string; path: string; manifest: unknown[] }[] {
  const runs = db.prepare(`SELECT * FROM "adapter_qualification_runs" WHERE "status" = 'running' AND "incarnation" <> ?`).all(args.incarnation) as RunRow[];
  const out: { run: string; project: string; digest: string; path: string; manifest: unknown[] }[] = [];
  for (const r of runs) {
    const seen = new Set<string>();
    const ops = db.prepare(`SELECT "finalizer_inputs" FROM "operations" WHERE json_extract("finalizer_inputs", '$.qualification') = ?`).all(r.id) as { finalizer_inputs: string }[];
    for (const o of ops) {
      const f = JSON.parse(o.finalizer_inputs) as FrozenIntent;
      if (!f.artifact_digest || !f.artifact_path || seen.has(f.artifact_digest)) continue;
      seen.add(f.artifact_digest);
      out.push({ run: r.id, project: r.project, digest: f.artifact_digest, path: f.artifact_path, manifest: (f.manifest as unknown[]) ?? [] });
    }
  }
  return out;
}

function interruptRun(tx: Tx, r: RunRow, rehashed: { digest: string; rehash: string }[] = []): void {
  const operations = endRunOperations(tx, r);
  // A fixture copy that no longer rehashes (the out_of_band case's byte,
  // never restored): the artifact `failed`, named in the run's record (the
  // slice-29 review, m7). One not read is named as unread.
  for (const a of rehashed) if (a.rehash === 'corrupt') artifactFoundCorrupt(tx, { project: r.project, digest: a.digest, where: 'precondition' });
  const cases = ADAPTER_QUALIFICATION_CASES.map((c) => ({ case: c, result: 'not_exercised', control: 'not_exercised', detail: { reason: 'the engine stopped during the qualification' } }));
  const detail = { not_qualified: ['the engine stopped during the qualification'], interrupted: { operations_ended: operations, artifacts: rehashed } };
  tx.db
    .prepare(`UPDATE "adapter_qualification_runs" SET "status" = 'interrupted', "cases" = ?, "ended_at" = ?, "outcome_detail" = ? WHERE "id" = ?`)
    .run(JSON.stringify(cases), tx.at, JSON.stringify(detail), r.id);
}

// At start: a run an earlier incarnation left running ended `interrupted`
// (its cases not exercised), its open operations ended in the store and its
// sealed copies' rehash (read on the main thread) recorded; what its
// environment holds stays, for the operator's exact teardown (the driver's
// ruling 8).
export function interruptQualifications(tx: Tx, args: { incarnation: string; rehashed?: { run: string; digest: string; rehash: string }[] }): { interrupted: string[] } {
  const rows = tx.db.prepare(`SELECT * FROM "adapter_qualification_runs" WHERE "status" = 'running' AND "incarnation" <> ?`).all(args.incarnation) as RunRow[];
  for (const r of rows) interruptRun(tx, r, (args.rehashed ?? []).filter((x) => x.run === r.id).map(({ digest, rehash }) => ({ digest, rehash })));
  return { interrupted: rows.map((r) => r.id) };
}

// The answer of the route (SEAM.md §322), from the ended run.
export function qualificationAnswer(db: Db, args: { run: string }): CommandResult {
  const r = getRun(db, args.run);
  if (!r || r.status === 'running') throw notFound('ended qualification', args.run);
  return {
    status: 200,
    body: {
      qualified: r.status === 'qualified',
      adapter: r.adapter,
      adapter_version: r.adapter_version,
      adapter_qualification: r.qualification,
      cases: parseJson<unknown[]>(r.cases) ?? [],
      evidence: r.evidence,
      environment: r.environment,
      qualification_run: r.id,
    },
  };
}
