// Deployment to an Alpha environment, the store's half (D4 §§1, 3 to 6; J1,
// J3, J4, J5, J9; E111 to E115; BS4 §§3, 9.2's slice 23). Each function is
// one transition, run in the caller's transaction; the main thread
// (deploy/release-operator.ts) seals the artifact, reads the held secrets
// and makes every adapter call between them, holding no transaction across
// a call.
//
//   configuration   immutable versions with a keyed identity (§3.2)
//   the request     the engine-derived authorization, gated (J3, J4)
//   the intent      under the environment lease, once (§4.1)
//   the attempt     its generation, frozen intent and capability, after the
//                   preconditions are read again (§4.2; E113)
//   the effect      a receipt is a claim; a reconcile read decides (J1)
//   the finalizer   `attempted`, and one durable verification round (§4.2)
//   the round       two identity reads bracketing the required checks (§5.3)
//   completion      `alpha_complete` (gates.ts) and its effects (§5.5)
//   teardown        exactly what the engine owns (§4.6)

import { assertEdge } from './lifecycle.js';
import { Refusal } from '../../refusal.js';
import { canonical, illegal, nextSeq, notFound, parseJson, sha256 } from './common.js';
import { type CandidateRow, type CheckRow, POST_DEPLOY_KINDS, getCandidate, markStale } from './evidence.js';
import { effectiveVersion } from './protected.js';
import { type DecisionRow, invalidateDecision } from './decisions.js';
import { raiseQuestion } from './queue.js';
import { raiseFinding } from './findings.js';
import { registerExecutions } from './checks.js';
import { getWorkItem, observeTrigger, transitionWork } from './work.js';
import type { Tx } from './tx.js';
import type { CommandResult } from './control.js';
import type { Capability, IdentityRead, Instance, Reconciliation, ReconcileOutcome } from '../../deploy/adapter.js';

type Db = Tx['db'];

export const SECRET_REFERENCE = /^deploy\/[a-z0-9_]{1,64}$/;
export const ADAPTERS = ['local_service'] as const;
// The unit name a prefix gives generation n (D4 §9.3).
export const unitName = (prefix: string, generation: number): string => `${prefix}-g${generation}.service`;
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
  targets: { name: string }[];
  identity_method?: string;
  secrets?: Record<string, string>;
  check_secrets?: string[];
  [key: string]: unknown;
}

interface OpRow {
  id: string;
  project: string;
  seq: number;
  kind: string;
  status: string;
  finalizer_inputs: string;
  outcome_detail: string | null;
  orchestration_deadline_at: string | null;
  orchestration_stage: string | null;
  authorization: string | null;
  deadline_at: string;
  finalized_at: string | null;
  linked_prior: string | null;
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
  app_instance: string | null;
  receipt: string | null;
}

// What the intent froze (D4 §4.1): the operation's authorized inputs. It
// names no unit and no prior state: those are each attempt's (E112).
export interface FrozenIntent {
  purpose: 'deploy' | 'teardown';
  work_item: string | null;
  authorization: string | null;
  candidate: string | null;
  mapping: string | null;
  artifact: { id: string; digest: string; path: string; entries: number; bytes: number } | null;
  config: { id: string; version: number; identity: string; secret_digests: { ref: string; digest: string }[] } | null;
  targets: string[];
  environment: { id: string; name: string; prefix: string; adapter: string };
  lease: { id: string; generation: number };
}

export const getEnv = (db: Db, id: string): EnvRow | undefined => db.prepare('SELECT * FROM "environments" WHERE "id" = ?').get(id) as EnvRow | undefined;
const getConfig = (db: Db, id: string | null): ConfigRow | undefined => (id === null ? undefined : (db.prepare('SELECT * FROM "environment_configs" WHERE "id" = ?').get(id) as ConfigRow | undefined));
const getOp = (db: Db, id: string): OpRow | undefined => db.prepare('SELECT * FROM "operations" WHERE "id" = ?').get(id) as OpRow | undefined;
const attemptsOf = (db: Db, op: string): AttemptRow[] => db.prepare('SELECT * FROM "operation_attempts" WHERE "operation" = ? ORDER BY "attempt_number"').all(op) as AttemptRow[];
const frozenOf = (op: OpRow): FrozenIntent => JSON.parse(op.finalizer_inputs) as FrozenIntent;

// An environment of the project by its name (E121 decision 2), or its id.
// A configured environment is preferred to a fixture's of the same name.
export function environmentByName(db: Db, project: string, name: string): EnvRow | undefined {
  return db
    .prepare('SELECT * FROM "environments" WHERE "project" = ? AND ("name" = ? OR "id" = ?) ORDER BY "prefix" IS NULL, "created_at" LIMIT 1')
    .get(project, name, name) as EnvRow | undefined;
}

export function currentConfig(db: Db, env: EnvRow): ConfigRow | undefined {
  return getConfig(db, env.current_config);
}

const configContent = (c: ConfigRow): ConfigContent => JSON.parse(c.content) as ConfigContent;
const targetsOf = (c: ConfigRow): string[] => configContent(c).targets.map((t) => t.name).sort();

// The identity method an environment declares (J4): its configuration's,
// or a fixture environment's verify_spec.
export function identityMethodOf(db: Db, env: EnvRow): string | null {
  const c = currentConfig(db, env);
  const method = c ? configContent(c).identity_method : (parseJson<{ identity_method?: string }>(env.verify_spec)?.identity_method ?? null);
  return typeof method === 'string' && method !== '' && method !== 'none' ? method : null;
}

// ---- configuration (D4 §3.2; Q5) ----------------------------------------------------------

// PUT /v1/projects/:p/environments/:e/config: a new immutable version. The
// main thread validated the content and computed its identity with the
// secret digests (deploy/config.ts); the first version creates the
// environment, its prefix fixed from the home's hash and its id (E121
// decision 8).
export function writeConfigVersion(
  tx: Tx,
  args: { project: string; name: string; content: ConfigContent; identity: string; secretDigests: { ref: string; digest: string }[]; homeHash: string },
): { status: number; body: unknown } {
  if (!tx.db.prepare('SELECT 1 FROM "projects" WHERE "id" = ?').get(args.project)) throw notFound('project', args.project);
  let env = tx.db.prepare('SELECT * FROM "environments" WHERE "project" = ? AND "name" = ? AND "prefix" IS NOT NULL').get(args.project, args.name) as EnvRow | undefined;
  const verifySpec = JSON.stringify({ identity_method: args.content.identity_method ?? 'none', target_set: args.content.targets.map((t) => t.name) });
  if (!env) {
    const id = tx.newId('env_');
    if (!/^[0-9a-f]{12}$/.test(args.homeHash)) throw new Error('the home hash is not 12 hex characters');
    const prefix = `surety-${args.homeHash}-${id.toLowerCase()}`;
    tx.db
      .prepare(
        `INSERT INTO "environments" ("id", "created_at", "project", "name", "adapter", "adapter_config_ref", "verify_spec", "deployment_generation", "prefix")
         VALUES (?, ?, ?, ?, ?, 'environment_configs', ?, 0, ?)`,
      )
      .run(id, tx.at, args.project, args.name, args.content.adapter, verifySpec, prefix);
    env = getEnv(tx.db, id)!;
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
  return {
    status: 201,
    body: { environment: { id: env.id, name: env.name, prefix: env.prefix }, config: { id, version: n, config_identity: args.identity, status: 'current' } },
  };
}

// The configurations whose secrets the main thread recomputes at start.
export function configsWithSecrets(db: Db): { config: string; project: string; environment: string; refs: string[]; digests: { ref: string; digest: string }[] }[] {
  const rows = db.prepare(`SELECT * FROM "environment_configs" WHERE "status" = 'current'`).all() as ConfigRow[];
  return rows.map((r) => {
    const digests = JSON.parse(r.secret_digests) as { ref: string; digest: string }[];
    return { config: r.id, project: r.project, environment: r.environment, refs: digests.map((d) => d.ref), digests };
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
  return { changed: out };
}

// ---- adapter qualification (D4 §2.6, J4) ----------------------------------------------------

export interface QualificationRow {
  id: string;
  adapter: string;
  status: string;
  host_qualification: string | null;
}

export function currentQualification(db: Db, adapter: string): QualificationRow | undefined {
  return db.prepare(`SELECT * FROM "adapter_qualifications" WHERE "adapter" = ? AND "status" = 'current'`).get(adapter) as QualificationRow | undefined;
}

// Whether a qualification still stands: current, and the host
// qualification it was made under still active.
export function qualificationStands(db: Db, q: QualificationRow | undefined): boolean {
  if (!q || q.status !== 'current') return false;
  if (q.host_qualification === null) return true;
  const h = db.prepare('SELECT "status" FROM "host_qualifications" WHERE "id" = ?').get(q.host_qualification) as { status: string } | undefined;
  return h?.status === 'active';
}

export function recordAdapterQualification(
  tx: Tx,
  args: { adapter: string; adapterVersion: string; engineBuild: string; profileFingerprint: string; cases: unknown[]; label: Record<string, unknown> | null },
): { adapter_qualification: { id: string; host_qualification: string | null } } {
  const prior = currentQualification(tx.db, args.adapter);
  if (prior) lapseQualification(tx, { adapter: args.adapter, reason: 'requalified' });
  const host = tx.db.prepare(`SELECT "id" FROM "host_qualifications" WHERE "status" = 'active'`).get() as { id: string } | undefined;
  const id = tx.newId('aq_');
  tx.db
    .prepare(
      `INSERT INTO "adapter_qualifications" ("id", "created_at", "adapter", "adapter_version", "engine_build", "host_qualification", "profile_fingerprint", "cases", "evidence", "status", "qualified_at", "label")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'current', ?, ?)`,
    )
    .run(id, tx.at, args.adapter, args.adapterVersion, args.engineBuild, host?.id ?? null, args.profileFingerprint, JSON.stringify(args.cases), tx.at, args.label === null ? null : JSON.stringify(args.label));
  tx.emit('adapter.qualified', { adapter_qualification: id }, { adapter: args.adapter, adapter_version: args.adapterVersion, host_qualification: host?.id ?? null });
  markStaleAll(tx);
  return { adapter_qualification: { id, host_qualification: host?.id ?? null } };
}

export function lapseQualification(tx: Tx, args: { adapter: string; reason: string }): { lapsed: string | null } {
  const q = currentQualification(tx.db, args.adapter);
  if (!q) return { lapsed: null };
  tx.db.prepare(`UPDATE "adapter_qualifications" SET "status" = 'lapsed', "lapsed_at" = ?, "lapsed_reason" = ? WHERE "id" = ?`).run(tx.at, args.reason, q.id);
  tx.emit('adapter.qualification_lapsed', { adapter_qualification: q.id }, { adapter: args.adapter, reason: args.reason });
  markStaleAll(tx);
  return { lapsed: q.id };
}

const markStaleAll = (tx: Tx): void => {
  tx.db.prepare(`UPDATE "gate_evaluations" SET "stale" = 1 WHERE "stale" = 0 AND "gate_kind" IN ('alpha_authorize', 'alpha_complete')`).run();
};

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

function recordArtifact(tx: Tx, project: string, s: SealedArtifact): ArtifactRow {
  const existing = getArtifact(tx.db, project, s.digest);
  if (existing) {
    if (s.reused === 'corrupt') artifactCorrupt(tx, project, existing, 'reuse');
    const now = getArtifact(tx.db, project, s.digest)!;
    if (now.status !== 'sealed') {
      throw new Refusal(409, 'artifact_corrupt', `The sealed artifact ${s.digest} failed its rehash and is not deployed.`, 'Nothing was authorized. Read the security finding; a new projection needs the sealed copy replaced.', {
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

// ---- the request (D4 §4.1; J3, J4; E121 decision 3) ----------------------------------------

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
  const op = operationOf(db, a.id);
  return op !== undefined && op.orchestration_stage !== 'ended';
}

// Insert an authorization `proposed` with its binding; `binding_hash`
// includes its generation (J3), so a deliberate request after a terminal
// operation is a new row.
export function insertAuthorization(tx: Tx, args: { project: string; candidate: CandidateRow; binding: Binding; generation: number; revision: string }): AuthRow {
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
      JSON.stringify({ dev_revision: args.revision, delivery_commit: null, artifact_digest: args.binding.artifact_digest, mapping: args.binding.mapping }),
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
  sealed: SealedArtifact;
  specFingerprint: string;
  builder: string;
  // The gate's facts, read on the main thread (gates/prepare.ts).
  facts: Record<string, unknown>;
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
  return { candidate: candidate.id, revision: candidate.revision, environment: env.id, name: env.name, config: { id: config.id, version: config.version, status: config.status, content: configContent(config) }, repo };
}

// POST /v1/projects/:p/deployments (D4 §4.1). In one transaction after the
// artifact is sealed: the artifact and its mapping recorded; the request
// coalesced with a pending deployment of the same binding; otherwise the
// authorization proposed with the engine-derived binding (a proposed row of
// the same binding re-evaluated in its generation) and `alpha_authorize`
// evaluated for it; satisfied, the `deploy` work item created.
export function requestDeployment(
  tx: Tx,
  args: RequestArgs,
  evaluate: (tx: Tx, a: Record<string, unknown>) => { evaluation: { id: string; outcome: string; reasons: unknown[] } },
): CommandResult {
  const candidate = getCandidate(tx.db, args.candidate);
  if (!candidate || candidate.project !== args.project) throw notFound('candidate', args.candidate);
  const env = environmentByName(tx.db, args.project, args.environment);
  if (!env || env.prefix === null) throw notFound('environment', args.environment);
  const config = currentConfig(tx.db, env);
  if (!config) throw notFound('environment configuration', args.environment);
  if (config.status === 'secrets_changed') {
    throw new Refusal(409, 'config_secrets_changed', `A secret the current configuration of ${env.name} names has a value other than its version records.`, 'Write a new configuration version (surety env config --resolve-secrets), then request the deployment again.', {
      environment: env.id,
      config: config.id,
    });
  }
  const artifact = recordArtifact(tx, args.project, args.sealed);
  const mapping = recordMapping(tx, { project: args.project, artifact: artifact.id, revision: candidate.revision, config: config.id, spec: args.specFingerprint, builder: args.builder });
  const binding: Binding = { environment: env.id, artifact_digest: artifact.digest, mapping, config_identity: config.config_identity, target_set: targetsOf(config) };
  const key = bindingKey(binding);
  const rows = (tx.db.prepare('SELECT * FROM "deployment_authorizations" WHERE "candidate" = ? AND "environment" = ? ORDER BY "generation", "created_at"').all(candidate.id, env.id) as AuthRow[]).filter(
    (a) => bindingKey(bindingOf(a)) === key,
  );
  const workOf = (auth: string) => tx.db.prepare(`SELECT "id", "status" FROM "work_items" WHERE "project" = ? AND "trigger_source" = 'deployment_request' AND "trigger_id" = ?`).get(args.project, auth) as
    | { id: string; status: string }
    | undefined;
  const answer = (status: number, a: AuthRow, evaluation: unknown) => {
    const now = tx.db.prepare('SELECT * FROM "deployment_authorizations" WHERE "id" = ?').get(a.id) as AuthRow;
    const w = workOf(a.id);
    return {
      status,
      body: {
        authorization: { id: now.id, status: now.status, generation: now.generation, artifact_digest: now.artifact_digest, mapping, config_identity: now.config_identity, target_set: JSON.parse(now.target_set) as string[] },
        work_item: w ? { id: w.id, status: w.status } : null,
        evaluation,
      },
      effects: [{ kind: 'tick' as const }],
    };
  };
  // Coalescing (J3): the same binding pending returns it and creates nothing.
  const pendingRow = rows.find((a) => pending(tx.db, a));
  if (pendingRow) return answer(200, pendingRow, pendingRow.evaluation === null ? null : { id: pendingRow.evaluation });
  const proposed = rows.find((a) => a.status === 'proposed');
  const auth = proposed ?? insertAuthorization(tx, { project: args.project, candidate, binding, generation: (rows.at(-1)?.generation ?? 0) + 1, revision: candidate.revision });
  const { evaluation } = evaluate(tx, { ...args.facts, project: args.project, candidate: candidate.id, kind: 'alpha_authorize', authorization: auth.id });
  const now = tx.db.prepare('SELECT * FROM "deployment_authorizations" WHERE "id" = ?').get(auth.id) as AuthRow;
  if (now.status !== 'issued') {
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
    { project: args.project, kind: 'deploy', trigger_source: 'deployment_request', trigger_id: auth.id, trigger_generation: 1, subject: { candidate: candidate.id }, engineRaised: true },
    { authorization: auth.id, environment: env.id },
  );
  return answer(201, now, { id: evaluation.id, outcome: evaluation.outcome });
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

function releaseLease(tx: Tx, frozen: FrozenIntent): void {
  tx.db.prepare('UPDATE "leases" SET "released_at" = ? WHERE "id" = ? AND "released_at" IS NULL').run(tx.at, frozen.lease.id);
}

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
  const j = journalOf(tx.db, id)!;
  const latest = attemptsOf(tx.db, id).at(-1)?.status ?? null;
  const successor = (tx.db.prepare('SELECT COUNT(*) AS n FROM "operations" WHERE "linked_prior" = ?').get(id) as { n: number }).n > 0;
  let status: string;
  if (successor && latest !== 'succeeded' && latest !== 'reconciled_succeeded') status = 'superseded';
  else if (latest === 'succeeded' || latest === 'reconciled_succeeded') status = 'succeeded';
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
  const reads = JSON.parse(a.reconciliation_reads) as unknown[];
  if (read) reads.push({ at: tx.at, read: read.read, result: read.outcome });
  tx.db
    .prepare('UPDATE "operation_attempts" SET "status" = ?, "finished_at" = CASE WHEN ? = \'started\' THEN NULL ELSE COALESCE("finished_at", ?) END, "reconciliation_reads" = ? WHERE "id" = ?')
    .run(status, status, tx.at, JSON.stringify(reads), a.id);
  a.status = status;
  a.reconciliation_reads = JSON.stringify(reads);
}

function openBlocker(db: Db, op: string): DecisionRow | undefined {
  return db.prepare(`SELECT * FROM "decisions" WHERE "kind" = 'blocker' AND "subject_type" = 'operation' AND "subject_id" = ? AND "status" = 'open'`).get(op) as DecisionRow | undefined;
}

function block(tx: Tx, op: OpRow, outcome: string): void {
  if (openBlocker(tx.db, op.id)) return;
  const f = frozenOf(op);
  raiseQuestion(tx, {
    project: op.project,
    kind: 'blocker',
    subjectType: 'operation',
    subjectId: op.id,
    question:
      `Operation ${op.id} (${op.kind} of ${f.environment.name}) cannot go on: the reconcile read found its effect ${outcome}. ` +
      'Nothing is retried, completed or finalized, and nothing found is stopped, until a read can tell what the target holds; it is read again at every tick.',
  });
}

function closeBlocker(tx: Tx, op: string, why: string): void {
  const d = openBlocker(tx.db, op);
  if (d) invalidateDecision(tx, d, why);
}

// The operation's way out (D4 §4.7): the lease released, the orchestration
// ended, and the deploy work item settled.
function endOperation(tx: Tx, op: OpRow, work: 'complete' | 'cancelled' | 'blocked' | 'none', cause: string): void {
  const f = frozenOf(op);
  releaseLease(tx, f);
  tx.db.prepare(`UPDATE "operations" SET "orchestration_stage" = 'ended' WHERE "id" = ?`).run(op.id);
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
    transitionWork(tx, item, 'awaiting_decision', { blocker: JSON.stringify({ reason: cause, raised_at: tx.at, decision: null, operation: op.id }) }, { operation: op.id, cause });
    raiseQuestion(tx, { project: op.project, kind: 'blocker', subjectType: 'work_item', subjectId: item.id });
  }
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

// What the Release Operator takes on at a tick: deploy work to intend, and
// operations whose orchestration has not ended.
export function deployWork(db: Db, args: { project: string }): { intend: { work_item: string; authorization: string; environment: string }[]; drive: string[] } {
  const items = db
    .prepare(`SELECT "id", "trigger_id" FROM "work_items" WHERE "project" = ? AND "kind" = 'deploy' AND "status" = 'eligible' AND "trigger_source" = 'deployment_request' ORDER BY "seq"`)
    .all(args.project) as { id: string; trigger_id: string }[];
  const intend: { work_item: string; authorization: string; environment: string }[] = [];
  for (const w of items) {
    const a = db.prepare('SELECT "id", "environment", "status", "project" FROM "deployment_authorizations" WHERE "id" = ?').get(w.trigger_id) as
      | { id: string; environment: string; status: string; project: string }
      | undefined;
    if (a && a.project === args.project) intend.push({ work_item: w.id, authorization: a.id, environment: a.environment });
  }
  const drive = (
    db
      .prepare(
        `SELECT o."id" FROM "operations" o JOIN "deploy_journal_state" s ON s."operation" = o."id"
         WHERE o."project" = ? AND (o."orchestration_stage" IS NULL OR o."orchestration_stage" <> 'ended') ORDER BY o."seq"`,
      )
      .all(args.project) as { id: string }[]
  ).map((r) => r.id);
  return { intend, drive };
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
  const payload = { environment: args.env.id, authorization: args.authorization, artifact_digest: args.frozen.artifact?.digest ?? null };
  tx.db
    .prepare('INSERT INTO "deploy_journal_events" ("id", "created_at", "project", "operation", "seq", "journal_kind", "event_kind", "payload") VALUES (?, ?, ?, ?, 1, ?, \'intended\', ?)')
    .run(tx.newId('dje_'), tx.at, args.project, id, journalKind, JSON.stringify(payload));
  tx.db
    .prepare('INSERT INTO "deploy_journal_state" ("id", "created_at", "project", "operation", "journal_kind", "state", "last_event_seq") VALUES (?, ?, ?, ?, ?, \'intended\', 1)')
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
export function intendDeploy(tx: Tx, args: { workItem: string; incarnation: string; deadlineSeconds: number }): { operation: string } | { busy: string } | { skipped: string } {
  const item = getWorkItem(tx, args.workItem);
  if (!item || item.kind !== 'deploy' || item.status !== 'eligible' || item.trigger_source !== 'deployment_request') return { skipped: 'not eligible deploy work' };
  const auth = tx.db.prepare('SELECT * FROM "deployment_authorizations" WHERE "id" = ?').get(item.trigger_id) as AuthRow | undefined;
  if (!auth || auth.project !== item.project) return { skipped: 'no authorization' };
  if (auth.status !== 'issued') {
    // Superseded or already consumed before its intent: nothing is deployed.
    if (auth.status === 'superseded') transitionWork(tx, item, 'cancelled', { blocker: null }, { cause: 'authorization_superseded', authorization: auth.id });
    return { skipped: `authorization ${auth.status}` };
  }
  const env = getEnv(tx.db, auth.environment)!;
  const held = environmentLease(tx.db, env.id);
  if (held) {
    if (parseJson<{ reason?: string }>(item.blocker)?.reason !== 'environment_busy') {
      tx.db.prepare('UPDATE "work_items" SET "blocker" = ? WHERE "id" = ?').run(JSON.stringify({ reason: 'environment_busy', raised_at: tx.at, decision: null, lease: held.id }), item.id);
    }
    return { busy: held.id };
  }
  const config = tx.db.prepare('SELECT * FROM "environment_configs" WHERE "environment" = ? AND "config_identity" = ? ORDER BY "version" DESC LIMIT 1').get(env.id, auth.config_identity) as ConfigRow | undefined;
  const mappingId = (JSON.parse(auth.source_delivery_mapping) as { mapping?: string }).mapping ?? null;
  const artifact = getArtifact(tx.db, item.project, auth.artifact_digest);
  const deadline = addSeconds(tx.at, args.deadlineSeconds);
  const lease = takeLease(tx, env.id, args.incarnation, deadline);
  const frozen: FrozenIntent = {
    purpose: 'deploy',
    work_item: item.id,
    authorization: auth.id,
    candidate: auth.candidate,
    mapping: mappingId,
    artifact: artifact ? { id: artifact.id, digest: artifact.digest, path: artifact.path, entries: artifact.entries, bytes: artifact.bytes } : null,
    config: config ? { id: config.id, version: config.version, identity: config.config_identity, secret_digests: JSON.parse(config.secret_digests) as { ref: string; digest: string }[] } : null,
    targets: JSON.parse(auth.target_set) as string[],
    environment: { id: env.id, name: env.name, prefix: env.prefix ?? '', adapter: env.adapter },
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

// ---- what the main thread reads of an operation -----------------------------------------------

export interface DeployDetail {
  id: string;
  project: string;
  kind: 'deploy' | 'teardown';
  status: string;
  stage: string | null;
  journal: JState;
  frozen: FrozenIntent;
  deadline: string;
  attempts: {
    id: string;
    number: number;
    status: string;
    incarnation: string | null;
    generation: number | null;
    capability: Capability | null;
    app_instance: Instance | null;
    intent: { create_units: string[]; prior: { unit: string; instance: Instance | null }[]; cleanup: string[]; resources: string[] } | null;
  }[];
  // Every unit a frozen intent of the environment named (D4 §4.6).
  recorded_units: string[];
  rounds: { id: string; round: number; status: string; step: string }[];
  blocker: string | null;
  candidate_superseded: boolean;
}

export function deployDetail(db: Db, args: { operation: string }): DeployDetail | null {
  const op = getOp(db, args.operation);
  const j = op ? journalOf(db, op.id) : undefined;
  if (!op || !j) return null;
  const frozen = frozenOf(op);
  const intents = new Map(
    (db.prepare('SELECT * FROM "attempt_intents" WHERE "operation" = ?').all(op.id) as { attempt: string; create_units: string; prior: string; cleanup: string; resources: string }[]).map((r) => [
      r.attempt,
      { create_units: JSON.parse(r.create_units) as string[], prior: JSON.parse(r.prior) as { unit: string; instance: Instance | null }[], cleanup: JSON.parse(r.cleanup) as string[], resources: JSON.parse(r.resources) as string[] },
    ]),
  );
  const recorded = recordedUnits(db, frozen.environment.id);
  const rounds = db.prepare('SELECT "id", "round", "status", "step" FROM "verification_rounds" WHERE "operation" = ? ORDER BY "created_at", "round"').all(op.id) as DeployDetail['rounds'];
  const candidate = frozen.candidate ? getCandidate(db, frozen.candidate) : undefined;
  return {
    id: op.id,
    project: op.project,
    kind: op.kind as 'deploy' | 'teardown',
    status: op.status,
    stage: op.orchestration_stage,
    journal: j.state,
    frozen,
    deadline: op.orchestration_deadline_at ?? op.deadline_at,
    attempts: attemptsOf(db, op.id).map((a) => ({
      id: a.id,
      number: a.attempt_number,
      status: a.status,
      incarnation: a.incarnation,
      generation: a.deployment_generation,
      capability: parseJson<Capability>(a.capability),
      app_instance: parseJson<Instance>(a.app_instance),
      intent: intents.get(a.id) ?? null,
    })),
    recorded_units: recorded,
    rounds,
    blocker: openBlocker(db, op.id)?.id ?? null,
    candidate_superseded: candidate ? (candidate.superseded_by ?? null) !== null : false,
  };
}

export function recordedUnits(db: Db, env: string): string[] {
  const rows = db
    .prepare(
      `SELECT i."create_units" FROM "attempt_intents" i JOIN "operations" o ON o."id" = i."operation"
       WHERE json_extract(o."target", '$.environment') = ? ORDER BY i."created_at"`,
    )
    .all(env) as { create_units: string }[];
  return [...new Set(rows.flatMap((r) => JSON.parse(r.create_units) as string[]))];
}

// ---- the attempt and its preconditions (D4 §§4.1, 4.2; E112, E113, E115) -----------------------

export interface PreconditionFacts {
  // The sealed copy rehashed now (main thread): equal, different, or not read.
  rehash: 'ok' | 'corrupt' | 'unread' | 'none';
  // Each held secret's digest now, by reference; null: not held.
  secretDigests: Record<string, string | null>;
  // Admission of the service domain with one check's capacity (§4.7).
  admission: 'granted' | 'held';
  // The environment's units as a read found them, or why it could not read.
  inventory: { units: string[] } | { unread: string };
  // The issuing gate's facts (gates/prepare.ts).
  gate: Record<string, unknown>;
  now: string;
}

interface Precondition {
  fact: string;
  ok: boolean;
  read: unknown;
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
    .prepare(`SELECT a."app_instance", i."create_units" FROM "operation_attempts" a JOIN "attempt_intents" i ON i."attempt" = a."id" WHERE a."operation" = ? AND a."status" IN ('succeeded', 'reconciled_succeeded') ORDER BY a."attempt_number" DESC LIMIT 1`)
    .get(last.id) as { app_instance: string | null; create_units: string } | undefined;
  if (!a) return [];
  return (JSON.parse(a.create_units) as string[]).map((unit) => ({ unit, instance: parseJson<Instance>(a.app_instance) }));
}

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

export type Evaluate = (tx: Tx, a: Record<string, unknown>) => { evaluation: { id: string; outcome: string; reasons: unknown[] } };

// Read the preconditions again immediately before the effect and, if they
// hold, record the attempt in one transaction (D4 §4.2): its generation,
// its frozen intent, its capability, its launch state. A failed
// precondition ends the operation `failed` with EFFECT_PRECONDITION_CHANGED
// naming the fact, before any adapter call; admission alone may wait,
// within the orchestration deadline.
export function startDeployAttempt(
  tx: Tx,
  args: { operation: string; incarnation: string; facts: PreconditionFacts },
  evaluate: Evaluate,
): { attempt: string; capability: Capability } | { waiting: 'admission' } | { failed: string } | { skipped: string } {
  const op = getOp(tx.db, args.operation);
  if (!op) throw notFound('operation', args.operation);
  const j = journalOf(tx.db, op.id)!;
  const attempts = attemptsOf(tx.db, op.id);
  const latest = attempts.at(-1);
  if (j.state === 'failed' || j.state === 'finalized' || j.state === 'confirmed') return { skipped: `journal ${j.state}` };
  if (latest && !['reconciled_absent'].includes(latest.status)) return { skipped: `attempt ${latest.status}` };
  const frozen = frozenOf(op);
  const env = getEnv(tx.db, frozen.environment.id)!;
  const f = args.facts;
  const checks: Precondition[] = [];
  const check = (fact: string, ok: boolean, read: unknown) => checks.push({ fact, ok, read });

  const lease = environmentLease(tx.db, env.id);
  check('lease', lease?.id === frozen.lease.id && lease.generation === frozen.lease.generation, { held: lease ? { id: lease.id, generation: lease.generation } : null, expected: frozen.lease });
  const deadlinePassed = Date.parse(f.now) > Date.parse(op.orchestration_deadline_at ?? op.deadline_at);
  if (op.kind === 'deploy') {
    const auth = tx.db.prepare('SELECT * FROM "deployment_authorizations" WHERE "id" = ?').get(frozen.authorization) as AuthRow | undefined;
    check('authorization', auth?.status === 'consumed' && op.authorization === auth.id, { authorization: frozen.authorization, status: auth?.status ?? null });
    const candidate = getCandidate(tx.db, frozen.candidate!);
    check('candidate', candidate !== undefined && (candidate.superseded_by ?? null) === null, { candidate: frozen.candidate, superseded_by: candidate?.superseded_by ?? null });
    const e = eligible(tx, op, frozen, f.gate, evaluate);
    check('eligibility', e.ok, { gate: 'alpha_authorize', reasons: e.reasons });
    const config = currentConfig(tx.db, env);
    check('configuration', config?.id === frozen.config?.id && config?.status === 'current', { current: config ? { id: config.id, version: config.version, status: config.status } : null, frozen: frozen.config?.id ?? null });
    const changed = (frozen.config?.secret_digests ?? []).filter((d) => f.secretDigests[d.ref] !== d.digest).map((d) => d.ref);
    check('secret_value', changed.length === 0, { references: (frozen.config?.secret_digests ?? []).map((d) => d.ref), changed });
    const artifact = frozen.artifact ? getArtifact(tx.db, op.project, frozen.artifact.digest) : undefined;
    if (artifact && f.rehash === 'corrupt') artifactCorrupt(tx, op.project, artifact, 'precondition');
    check('artifact', artifact !== undefined && f.rehash === 'ok' && getArtifact(tx.db, op.project, artifact.digest)!.status === 'sealed', { digest: frozen.artifact?.digest ?? null, rehash: f.rehash });
    const q = currentQualification(tx.db, frozen.environment.adapter);
    check('adapter_qualification', qualificationStands(tx.db, q), { adapter: frozen.environment.adapter, qualification: q?.id ?? null });
    check('host_qualification', q === undefined || q.host_qualification === null || qualificationStands(tx.db, q), { host_qualification: q?.host_qualification ?? null });
  }
  // No unit or domain of the environment of unknown ownership (§9.2): a
  // unit the read found that no frozen intent of the environment names, or
  // a read that could not be made, which establishes nothing.
  const recorded = recordedUnits(tx.db, env.id);
  if ('unread' in f.inventory) check('unit_ownership', false, { unread: f.inventory.unread });
  else {
    const unknown = f.inventory.units.filter((u) => !recorded.includes(u));
    check('unit_ownership', unknown.length === 0, { unknown });
  }
  const failed = checks.find((c) => !c.ok);
  if (failed || deadlinePassed) {
    const fact = failed?.fact ?? 'deadline';
    const detail = { code: 'EFFECT_PRECONDITION_CHANGED', fact, manifest: [...checks, { fact: 'deadline', ok: !deadlinePassed, read: { deadline: op.orchestration_deadline_at, now: f.now } }] };
    if (fact === 'deadline') tx.emit('deploy.orchestration_deadline', { project: op.project, operation: op.id }, { stage: 'effect' });
    failOperation(tx, op, detail);
    return { failed: fact };
  }
  if (op.kind === 'deploy' && f.admission !== 'granted') return { waiting: 'admission' };

  // The attempt (E112): its generation from the environment's counter, which
  // is now the environment's current generation (J9).
  const g = env.deployment_generation + 1;
  tx.db.prepare('UPDATE "environments" SET "deployment_generation" = ?, "current_generation" = ? WHERE "id" = ?').run(g, g, env.id);
  const n = (latest?.attempt_number ?? 0) + 1;
  const attempt = tx.newId('att_');
  const prior = op.kind === 'deploy' ? priorOf(tx.db, env.id) : [];
  const create = op.kind === 'deploy' ? [unitName(frozen.environment.prefix, g)] : [];
  const resources = op.kind === 'teardown' ? recorded : [];
  const capability: Capability =
    op.kind === 'deploy'
      ? {
          kind: 'deploy',
          environment: env.id,
          operation: op.id,
          attempt,
          generation: g,
          incarnation: args.incarnation,
          leaseGeneration: frozen.lease.generation,
          artifact: { digest: frozen.artifact!.digest, sealedPath: frozen.artifact!.path },
          configIdentity: frozen.config!.identity,
          configVersion: frozen.config!.version,
          targets: frozen.targets,
          createUnits: create,
          prior,
          cleanup: [],
        }
      : { kind: 'teardown', environment: env.id, operation: op.id, attempt, generation: g, incarnation: args.incarnation, leaseGeneration: frozen.lease.generation, stopUnits: resources };
  tx.db
    .prepare(
      `INSERT INTO "operation_attempts" ("id", "created_at", "project", "operation", "attempt_number", "status", "started_at", "finished_at", "timeline", "reconciliation_reads", "incarnation",
         "deployment_generation", "capability", "launch_state")
       VALUES (?, ?, ?, ?, ?, 'started', ?, NULL, ?, '[]', ?, ?, ?, 'authorizable')`,
    )
    .run(attempt, tx.at, op.project, op.id, n, tx.at, JSON.stringify([{ at: tx.at, event: 'started', detail: null }]), args.incarnation, g, JSON.stringify(capability));
  tx.db
    .prepare(
      `INSERT INTO "attempt_intents" ("id", "created_at", "project", "operation", "attempt", "generation", "create_units", "prior", "cleanup", "resources", "preconditions")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
    )
    .run(tx.newId('ati_'), tx.at, op.project, op.id, attempt, g, JSON.stringify(create), JSON.stringify(prior), JSON.stringify(resources), JSON.stringify(checks));
  tx.emit('operation.attempt_started', { project: op.project, operation: op.id, environment: env.id }, { attempt_number: n, deployment_generation: g });
  refreshOp(tx, op.id);
  return { attempt, capability };
}

// adapterCall's check (D4 §2.2): every field of the capability against the
// store, before any host call. null: it holds; otherwise the field that
// failed.
export function capabilityCheck(db: Db, args: { capability: Capability; incarnation: string }): { field: string } | null {
  const c = args.capability;
  const a = db.prepare('SELECT * FROM "operation_attempts" WHERE "id" = ?').get(c.attempt) as AttemptRow | undefined;
  if (!a || a.operation !== c.operation) return { field: 'attempt' };
  const op = getOp(db, c.operation);
  if (!op) return { field: 'operation' };
  const frozen = frozenOf(op);
  if (c.environment !== frozen.environment.id) return { field: 'environment' };
  const latest = attemptsOf(db, op.id).at(-1);
  if (a.status !== 'started' || latest?.id !== a.id) return { field: 'attempt' };
  if (c.incarnation !== args.incarnation || a.incarnation !== args.incarnation) return { field: 'incarnation' };
  const env = getEnv(db, frozen.environment.id);
  if (!env || a.deployment_generation !== c.generation || env.current_generation !== c.generation) return { field: 'generation' };
  const lease = environmentLease(db, env.id);
  if (!lease || lease.id !== frozen.lease.id || lease.generation !== c.leaseGeneration) return { field: 'lease_generation' };
  const intent = db.prepare('SELECT * FROM "attempt_intents" WHERE "attempt" = ?').get(a.id) as { create_units: string; prior: string; resources: string } | undefined;
  if (!intent) return { field: 'attempt' };
  const derived = (u: string) => UNIT_CHARS.test(u) && u.startsWith(`${frozen.environment.prefix}-g`) && /-g\d+\.service$/.test(u);
  if (c.kind === 'deploy') {
    if (frozen.artifact === null || c.artifact.digest !== frozen.artifact.digest) return { field: 'artifact_digest' };
    if (frozen.config === null || c.configIdentity !== frozen.config.identity) return { field: 'config_identity' };
    const create = JSON.parse(intent.create_units) as string[];
    const prior = (JSON.parse(intent.prior) as { unit: string }[]).map((p) => p.unit);
    if (!c.createUnits.every((u) => derived(u) && create.includes(u))) return { field: 'units' };
    if (!c.prior.every((p) => derived(p.unit) && prior.includes(p.unit))) return { field: 'units' };
    if (c.cleanup.length > 0) return { field: 'units' };
  } else {
    const resources = JSON.parse(intent.resources) as string[];
    if (!c.stopUnits.every((u) => derived(u) && resources.includes(u))) return { field: 'units' };
  }
  return null;
}

// A capability refused (D4 §2.2): nothing issued, the event naming the
// field, the attempt `failed` with nothing applied.
export function capabilityRefused(tx: Tx, args: { attempt: string; field: string }): void {
  const a = tx.db.prepare('SELECT * FROM "operation_attempts" WHERE "id" = ?').get(args.attempt) as AttemptRow | undefined;
  if (!a) throw notFound('attempt', args.attempt);
  const op = getOp(tx.db, a.operation)!;
  tx.emit('deploy.capability_refused', { project: op.project, operation: op.id, attempt: a.id }, { field: args.field });
  if (a.status === 'started') setAttempt(tx, a, 'failed');
  failOperation(tx, op, { code: 'deploy_capability_refused', field: args.field });
}

// ---- the receipt and the reconcile read (D4 §§2.3, 2.4; J1) ---------------------------------------

// The adapter's receipt, recorded as a claim. `issued` is the journal's
// `applied` (the receipt), never the attempt's success; `uncertain` (or a
// call past its bound) leaves the attempt `ambiguous`; `refused` and
// `not_issued` end it `failed` with nothing applied.
export function recordReceipt(tx: Tx, args: { attempt: string; receipt: { result: string; steps: unknown[] }; bound: string | null }): { reconcile: boolean } {
  const a = tx.db.prepare('SELECT * FROM "operation_attempts" WHERE "id" = ?').get(args.attempt) as AttemptRow | undefined;
  if (!a) throw notFound('attempt', args.attempt);
  const op = getOp(tx.db, a.operation)!;
  if (a.status !== 'started') return { reconcile: a.status === 'ambiguous' };
  tx.db.prepare('UPDATE "operation_attempts" SET "receipt" = ? WHERE "id" = ?').run(JSON.stringify({ provenance: 'claimed', ...args.receipt, bound: args.bound }), a.id);
  const j = journalOf(tx.db, op.id)!;
  switch (args.receipt.result) {
    case 'issued':
      if (j.state === 'intended' || j.state === 'ambiguous') journalAppend(tx, op, 'applied', { provenance: 'claimed', attempt: a.id });
      refreshOp(tx, op.id);
      return { reconcile: true };
    case 'refused':
    case 'not_issued':
      setAttempt(tx, a, 'failed');
      failOperation(tx, op, { code: args.receipt.result, attempt: a.id, nothing_applied: true });
      return { reconcile: false };
    default:
      setAttempt(tx, a, 'ambiguous');
      if (j.state !== 'ambiguous') journalAppend(tx, op, 'ambiguous', { attempt: a.id, bound: args.bound });
      refreshOp(tx, op.id);
      return { reconcile: true };
  }
}

// The reconcile read's answer, taken on its way (D4 §2.4): `applied`
// confirms (the attempt `succeeded`, the original application instance
// recorded once); `absent` permits a retry after quiescence, at most
// `deploy_auto_retries_max` times by itself; `partial`, `conflicting` and
// `unknown` keep the attempt ambiguous with a blocker, never retried, the
// lease held.
export function recordReconcile(
  tx: Tx,
  args: { attempt: string; outcome: ReconcileOutcome; read: unknown; instance: Instance | null; autoRetriesMax: number },
): { way: 'confirmed' | 'retry' | 'failed' | 'blocked' } {
  const a = tx.db.prepare('SELECT * FROM "operation_attempts" WHERE "id" = ?').get(args.attempt) as AttemptRow | undefined;
  if (!a) throw notFound('attempt', args.attempt);
  const op = getOp(tx.db, a.operation)!;
  const j = journalOf(tx.db, op.id)!;
  if (j.state === 'confirmed' || j.state === 'finalized') return { way: 'confirmed' };
  if (j.state === 'failed') return { way: 'failed' };
  const read = { outcome: args.outcome, read: args.read };
  switch (args.outcome) {
    case 'applied': {
      setAttempt(tx, a, a.status === 'started' ? 'succeeded' : 'reconciled_succeeded', read);
      if (op.kind === 'deploy' && a.app_instance === null && args.instance !== null) {
        tx.db.prepare('UPDATE "operation_attempts" SET "app_instance" = ? WHERE "id" = ?').run(JSON.stringify(args.instance), a.id);
      }
      if (journalOf(tx.db, op.id)!.state !== 'applied') journalAppend(tx, op, 'applied', { provenance: 'reconcile', attempt: a.id });
      journalAppend(tx, op, 'confirmed', { attempt: a.id });
      closeBlocker(tx, op.id, 'the reconcile read confirmed the effect');
      refreshOp(tx, op.id);
      return { way: 'confirmed' };
    }
    case 'absent': {
      setAttempt(tx, a, 'reconciled_absent', read);
      if (journalOf(tx.db, op.id)!.state === 'applied') journalAppend(tx, op, 'ambiguous', { attempt: a.id });
      closeBlocker(tx, op.id, 'the reconcile read found the effect absent');
      const absent = attemptsOf(tx.db, op.id).filter((x) => x.status === 'reconciled_absent').length;
      refreshOp(tx, op.id);
      if (absent <= args.autoRetriesMax) return { way: 'retry' };
      failOperation(tx, op, { code: 'reconciled_absent', attempt: a.id, retries: absent - 1 });
      return { way: 'failed' };
    }
    default: {
      setAttempt(tx, a, args.outcome === 'partial' ? 'reconciled_partial' : 'ambiguous', read);
      if (journalOf(tx.db, op.id)!.state !== 'ambiguous') journalAppend(tx, op, 'ambiguous', { attempt: a.id, outcome: args.outcome });
      refreshOp(tx, op.id);
      block(tx, op, args.outcome);
      return { way: 'blocked' };
    }
  }
}

// An attempt `started` by an earlier incarnation (D4 §4.3): its launch is
// closed first, so that nothing of that incarnation can still make the
// effect happen; the attempt becomes `ambiguous`, for the reconcile read.
export function attemptOrphaned(tx: Tx, args: { attempt: string; incarnation: string }): void {
  const a = tx.db.prepare('SELECT * FROM "operation_attempts" WHERE "id" = ?').get(args.attempt) as AttemptRow | undefined;
  if (!a || a.status !== 'started' || a.incarnation === args.incarnation) return;
  const op = getOp(tx.db, a.operation)!;
  if (a.launch_state !== 'closed') tx.db.prepare(`UPDATE "operation_attempts" SET "launch_state" = 'closed' WHERE "id" = ?`).run(a.id);
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
}

const getRound = (db: Db, id: string): RoundRow | undefined => db.prepare('SELECT * FROM "verification_rounds" WHERE "id" = ?').get(id) as RoundRow | undefined;

const succeededAttempt = (db: Db, op: string): AttemptRow | undefined =>
  (db.prepare(`SELECT * FROM "operation_attempts" WHERE "operation" = ? ORDER BY "attempt_number" DESC LIMIT 1`).get(op) as AttemptRow | undefined);

function envRecord(tx: Tx, project: string, env: string): { id: string } {
  const row = tx.db.prepare('SELECT "id" FROM "environment_records" WHERE "environment" = ?').get(env) as { id: string } | undefined;
  if (row) return row;
  const id = tx.newId('envr_');
  tx.db
    .prepare('INSERT INTO "environment_records" ("id", "created_at", "project", "environment", "observed") VALUES (?, ?, ?, ?, ?)')
    .run(id, tx.at, project, env, JSON.stringify({ condition: 'unknown', detail: null, observed_at: null, source: null }));
  return { id };
}

// `attempted` is written only by the attempt whose generation is current
// (J9).
function writeAttempted(tx: Tx, op: OpRow, attempt: AttemptRow, outcome: string, extra: Record<string, unknown> = {}): boolean {
  const frozen = frozenOf(op);
  const env = getEnv(tx.db, frozen.environment.id)!;
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
export function registerRound(tx: Tx, args: { operation: string; requiredOf: RequiredOf; deadlineAt: string | null }): RoundRow {
  const op = getOp(tx.db, args.operation)!;
  const frozen = frozenOf(op);
  const a = succeededAttempt(tx.db, op.id)!;
  const effective = effectiveVersion(tx.db, op.project)!;
  const candidate = getCandidate(tx.db, frozen.candidate!)!;
  const required = args.requiredOf(tx.db, op.project, candidate, effective.id).filter((c) => POST_DEPLOY_KINDS.includes(c.kind));
  const q = currentQualification(tx.db, frozen.environment.adapter);
  const { k } = tx.db.prepare('SELECT COALESCE(MAX("round"), 0) + 1 AS k FROM "verification_rounds" WHERE "attempt" = ?').get(a.id) as { k: number };
  const id = tx.newId('vr_');
  tx.db
    .prepare(
      `INSERT INTO "verification_rounds" ("id", "created_at", "project", "operation", "attempt", "round", "candidate", "mapping", "environment", "deployment_generation", "config_identity",
         "protected_version", "required_checks", "adapter_qualification", "status", "registered_at", "deadline_at", "step")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 'first_read')`,
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
      frozen.environment.id,
      a.deployment_generation,
      frozen.config!.identity,
      effective.id,
      JSON.stringify(required.map((c) => ({ id: c.id, key: c.key, kind: c.kind }))),
      qualificationStands(tx.db, q) ? q!.id : null,
      tx.at,
      args.deadlineAt,
    );
  tx.emit('deploy.round_registered', { project: op.project, operation: op.id, round: id }, { attempt: a.id, round: k, deployment_generation: a.deployment_generation, required: required.map((c) => c.key) });
  tx.db.prepare(`UPDATE "gate_evaluations" SET "stale" = 1 WHERE "candidate" = ? AND "gate_kind" = 'alpha_complete' AND "stale" = 0`).run(candidate.id);
  return getRound(tx.db, id)!;
}

// The finalizer (D4 §4.2), keyed on the operation and idempotent: the
// confirmed effect recorded once, the environment's `attempted`, and the
// first verification round created, or on replay returned.
export function finalizeDeploy(tx: Tx, args: { operation: string; requiredOf: RequiredOf }): { round: string | null; replay: boolean } {
  const op = getOp(tx.db, args.operation)!;
  const j = journalOf(tx.db, op.id)!;
  const existing = tx.db.prepare('SELECT "id" FROM "verification_rounds" WHERE "operation" = ? ORDER BY "created_at", "round" LIMIT 1').get(op.id) as { id: string } | undefined;
  if (j.state === 'finalized') return { round: existing?.id ?? null, replay: true };
  if (j.state !== 'confirmed') throw illegal(`finalizing a ${j.state} deploy operation`, { operation: op.id });
  journalAppend(tx, op, 'finalized');
  tx.db.prepare('UPDATE "operations" SET "finalized_at" = ? WHERE "id" = ?').run(tx.at, op.id);
  tx.emit('operation.finalized', { project: op.project, operation: op.id }, { journal_kind: op.kind === 'deploy' ? 'deploy_apply' : 'teardown_apply' });
  const a = succeededAttempt(tx.db, op.id)!;
  const frozen = frozenOf(op);
  if (op.kind === 'teardown') {
    const intent = tx.db.prepare('SELECT "resources" FROM "attempt_intents" WHERE "attempt" = ?').get(a.id) as { resources: string };
    writeAttempted(tx, op, a, 'teardown_applied', { cleanup: { removed: JSON.parse(intent.resources) as string[], left: [] } });
    tx.db.prepare('UPDATE "environment_records" SET "running" = NULL WHERE "environment" = ?').run(frozen.environment.id);
    endOperation(tx, op, 'none', 'teardown_applied');
    return { round: null, replay: false };
  }
  if (writeAttempted(tx, op, a, 'applied')) {
    tx.db
      .prepare('UPDATE "environment_records" SET "running" = ? WHERE "environment" = ?')
      .run(JSON.stringify({ config: frozen.config!.id, config_version: frozen.config!.version, config_identity: frozen.config!.identity, secret_digests: frozen.config!.secret_digests, generation: a.deployment_generation }), frozen.environment.id);
  }
  tx.db.prepare(`UPDATE "operations" SET "orchestration_stage" = 'verification' WHERE "id" = ?`).run(op.id);
  const round = registerRound(tx, { operation: op.id, requiredOf: args.requiredOf, deadlineAt: null });
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
  expect: { target: string; digest: string; unit: string | null; generation: number | null; instance: Instance | null }[];
  deadline: string;
  // Every execution the round registered: terminal or not.
  executions: { id: string; key: string; status: string }[];
}

export function roundDetail(db: Db, args: { round: string }): RoundDetail | null {
  const r = getRound(db, args.round);
  if (!r) return null;
  const op = getOp(db, r.operation)!;
  const frozen = frozenOf(op);
  const a = db.prepare('SELECT * FROM "operation_attempts" WHERE "id" = ?').get(r.attempt) as AttemptRow;
  const intent = db.prepare('SELECT "create_units" FROM "attempt_intents" WHERE "attempt" = ?').get(a.id) as { create_units: string } | undefined;
  const unit = intent ? ((JSON.parse(intent.create_units) as string[])[0] ?? null) : null;
  const ids = JSON.parse(r.executions) as string[];
  const executions = ids.map((id) => db.prepare('SELECT "id", "key", "status" FROM "check_executions" WHERE "id" = ?').get(id) as { id: string; key: string; status: string });
  return {
    id: r.id,
    operation: r.operation,
    attempt: r.attempt,
    round: r.round,
    status: r.status,
    step: r.step,
    environment: { id: frozen.environment.id, prefix: frozen.environment.prefix },
    expect: frozen.targets.map((t) => ({ target: t, digest: frozen.artifact!.digest, unit, generation: r.deployment_generation, instance: parseJson<Instance>(a.app_instance) })),
    deadline: r.deadline_at ?? op.orchestration_deadline_at ?? op.deadline_at,
    executions,
  };
}

interface ReadEntry {
  bracket: 'first' | 'second';
  reads: IdentityRead[] | null;
  failure: string | null;
  at: string;
}

const allMatch = (reads: IdentityRead[] | null, expectTargets: string[]): boolean =>
  reads !== null && expectTargets.every((t) => reads.some((r) => r.target === t && r.match === 'match' && r.instance !== 'unread'));

const sameInstance = (x: Instance | 'unread', y: Instance | null): boolean => x !== 'unread' && y !== null && x.pid === y.pid && x.startTime === y.startTime && x.invocationId === y.invocationId;

// The first identity read (D4 §5.3 item 2) naming its round; with every
// target matching, the round's required checks registered with trigger
// (deployment_verification, O:N, k), bound to the round (item 3).
export function roundFirstRead(tx: Tx, args: { round: string; reads: IdentityRead[] | null; failure: string | null; checksOf: (db: Db, ids: string[]) => CheckRow[] }): { next: 'checks' | 'finalize' | 'none' } {
  const r = getRound(tx.db, args.round);
  if (!r || r.status !== 'open' || r.step !== 'first_read') return { next: 'none' };
  const reads = JSON.parse(r.reads) as ReadEntry[];
  reads.push({ bracket: 'first', reads: args.reads, failure: args.failure, at: tx.at });
  const op = getOp(tx.db, r.operation)!;
  const frozen = frozenOf(op);
  const a = tx.db.prepare('SELECT * FROM "operation_attempts" WHERE "id" = ?').get(r.attempt) as AttemptRow;
  const instance = parseJson<Instance>(a.app_instance);
  const matched = allMatch(args.reads, frozen.targets) && (args.reads ?? []).every((x) => sameInstance(x.instance, instance));
  if (!matched) {
    tx.db.prepare(`UPDATE "verification_rounds" SET "reads" = ?, "step" = 'second_read' WHERE "id" = ?`).run(JSON.stringify(reads), r.id);
    return { next: 'finalize' };
  }
  const candidate = getCandidate(tx.db, r.candidate)!;
  const required = JSON.parse(r.required_checks) as { id: string }[];
  const checks = args.checksOf(tx.db, required.map((c) => c.id));
  const trigger = { source: 'deployment_verification' as const, id: `${op.id}:${a.attempt_number}`, generation: r.round };
  const made = registerExecutions(tx, {
    project: op.project,
    candidate,
    checks,
    trigger,
    binding: { environment: frozen.environment.id, artifact_digest: frozen.artifact!.digest, deployment: { operation: op.id, attempt: a.id, deployment_generation: r.deployment_generation, round: r.id } },
  });
  tx.db.prepare(`UPDATE "verification_rounds" SET "reads" = ?, "step" = 'checks', "executions" = ? WHERE "id" = ?`).run(JSON.stringify(reads), JSON.stringify(made.map((m) => m.id)), r.id);
  return { next: 'checks' };
}

// Whether the round's executions have all ended, so that the second read
// may be made (item 5: after the last required execution's result).
export function roundChecksDone(tx: Tx, args: { round: string }): { done: boolean } {
  const r = getRound(tx.db, args.round);
  if (!r || r.step !== 'checks') return { done: false };
  const ids = JSON.parse(r.executions) as string[];
  const done = ids.every((id) => {
    const latest = latestExecutionFor(tx.db, id);
    return latest !== undefined && ['recorded', 'cancelled', 'interrupted'].includes(latest.status);
  });
  if (done) tx.db.prepare(`UPDATE "verification_rounds" SET "step" = 'second_read' WHERE "id" = ?`).run(r.id);
  return { done };
}

interface ExecRow {
  id: string;
  key: string;
  status: string;
  result: string | null;
  deployment: string | null;
  execution_seq: number;
}

// The execution that decides a registration of the round: itself, or the
// latest one registered for its check bound to the same round (a recovery
// retry, D3 §2.7).
function latestExecutionFor(db: Db, execution: string): ExecRow | undefined {
  const x = db.prepare('SELECT * FROM "check_executions" WHERE "id" = ?').get(execution) as ExecRow | undefined;
  if (!x || x.deployment === null) return x;
  const round = (JSON.parse(x.deployment) as { round?: string }).round;
  const later = db
    .prepare(`SELECT * FROM "check_executions" WHERE "project" = (SELECT "project" FROM "check_executions" WHERE "id" = ?) AND "key" = ? AND json_extract("deployment", '$.round') = ? ORDER BY "execution_seq" DESC LIMIT 1`)
    .get(execution, x.key, round ?? '') as ExecRow | undefined;
  return later ?? x;
}

interface ResultRow {
  id: string;
  execution_established: number;
  signaled: number;
  deadline_hit: number;
  orphans: number | null;
  exit_status: number | null;
  invalidated_at: string | null;
  deployment: string | null;
}

export const resultPassed = (r: Pick<ResultRow, 'execution_established' | 'signaled' | 'deadline_hit' | 'orphans' | 'exit_status'>): 'passed' | 'failed' | 'skipped' => {
  if (r.execution_established === 0) return 'skipped';
  if (r.signaled === 1 || r.deadline_hit === 1 || r.orphans !== 0 || r.exit_status === null || r.exit_status !== 0) return 'failed';
  return 'passed';
};

// The verification row (D4 §5.3 item 6) and its effects (item 8), in one
// transaction that checks the environment's current generation and that
// the round decides.
export function finalizeRound(tx: Tx, args: { round: string; reads: IdentityRead[] | null; failure: string | null; reason?: 'deadline' }): { outcome: string; decides: boolean } | null {
  const r = getRound(tx.db, args.round);
  if (!r || r.status !== 'open') return null;
  const op = getOp(tx.db, r.operation)!;
  const frozen = frozenOf(op);
  const a = tx.db.prepare('SELECT * FROM "operation_attempts" WHERE "id" = ?').get(r.attempt) as AttemptRow;
  const instance = parseJson<Instance>(a.app_instance);
  const reads = JSON.parse(r.reads) as ReadEntry[];
  if (args.reason !== 'deadline' && (args.reads !== null || args.failure !== null) && r.step === 'second_read') {
    reads.push({ bracket: 'second', reads: args.reads, failure: args.failure, at: tx.at });
  }
  const first = reads.find((x) => x.bracket === 'first');
  const second = reads.find((x) => x.bracket === 'second');
  const missing: { kind: string; id: string }[] = [];
  let differs = false;
  for (const [name, entry] of [['first', first], ['second', second]] as const) {
    if (!entry || entry.reads === null) {
      missing.push({ kind: 'identity_read', id: name });
      continue;
    }
    for (const t of frozen.targets) {
      const x = entry.reads.find((y) => y.target === t);
      if (!x || x.match === 'unread' || x.instance === 'unread') missing.push({ kind: 'identity_read', id: `${name}:${t}` });
      else if (x.match === 'differs' || !sameInstance(x.instance, instance)) differs = true;
    }
  }
  // The deciding results of the round's required checks (item 6).
  const required = JSON.parse(r.required_checks) as { id: string; key: string; kind: string }[];
  const executions = JSON.parse(r.executions) as string[];
  const results: { check: string; key: string; kind: string; execution: string | null; result: string | null; state: string }[] = [];
  let failedCheck = false;
  for (const c of required) {
    const reg = executions.map((id) => latestExecutionFor(tx.db, id)).find((x) => x?.key === c.key);
    const res = reg?.result ? (tx.db.prepare('SELECT * FROM "check_results" WHERE "id" = ?').get(reg.result) as ResultRow | undefined) : undefined;
    const state = res && res.invalidated_at === null ? resultPassed(res) : 'missing';
    if (state === 'failed') failedCheck = true;
    if (state !== 'passed' && state !== 'failed') missing.push({ kind: reg ? 'check_result' : 'check_execution', id: reg?.id ?? c.key });
    results.push({ check: c.id, key: c.key, kind: c.kind, execution: reg?.id ?? null, result: res?.id ?? null, state });
  }
  const behaviour = results.some((x) => x.kind === 'post_deploy_behavior' && x.state === 'passed');
  const q = currentQualification(tx.db, frozen.environment.adapter);
  const qualified = r.adapter_qualification !== null && q?.id === r.adapter_qualification && qualificationStands(tx.db, q);
  if (!qualified) missing.push({ kind: 'qualification', id: r.adapter_qualification ?? frozen.environment.adapter });
  if (args.reason === 'deadline') missing.push({ kind: 'deadline', id: op.orchestration_deadline_at ?? r.deadline_at ?? '' });
  let outcome: 'verified' | 'failed' | 'unknown';
  if (differs || failedCheck) outcome = 'failed';
  else if (missing.length === 0 && behaviour && required.length > 0 && results.every((x) => x.state === 'passed')) outcome = 'verified';
  else {
    outcome = 'unknown';
    if (!behaviour && missing.length === 0) missing.push({ kind: 'check_result', id: 'post_deploy_behavior' });
  }
  // The guards (§4.5; J9): the environment's current generation, and the
  // newest registered round of the operation's current attempt.
  const env = getEnv(tx.db, frozen.environment.id)!;
  const newest = tx.db.prepare('SELECT "id" FROM "verification_rounds" WHERE "operation" = ? ORDER BY "created_at" DESC, "round" DESC LIMIT 1').get(op.id) as { id: string };
  const latestAttempt = attemptsOf(tx.db, op.id).at(-1)!;
  const current = env.current_generation === r.deployment_generation;
  const decides = newest.id === r.id && latestAttempt.id === r.attempt;
  const invalidated = !current ? 'generation_superseded' : !decides ? 'round_superseded' : null;
  const id = tx.newId('dv_');
  const authRow = frozen.authorization ? (tx.db.prepare('SELECT "target_set" FROM "deployment_authorizations" WHERE "id" = ?').get(frozen.authorization) as { target_set: string } | undefined) : undefined;
  const identityReads = reads.flatMap((e) =>
    (e.reads ?? []).map((x) => ({ target: x.target, method: x.method, expected: x.expected, read: x.read, match: x.match, instance: x.instance, generation: x.generation, at: x.at, bracket: e.bracket })),
  );
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
      authRow?.target_set ?? JSON.stringify(frozen.targets),
      frozen.artifact!.digest,
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
  tx.db.prepare(`UPDATE "verification_rounds" SET "status" = 'decided', "step" = 'done', "reads" = ? WHERE "id" = ?`).run(JSON.stringify(reads), r.id);
  if (args.reason === 'deadline') tx.emit('deploy.orchestration_deadline', { project: op.project, operation: op.id }, { stage: 'verification', round: r.id });
  tx.emit('environment.verified', { project: op.project, environment: env.id, operation: op.id }, { verification: id, round: r.id, outcome, deployment_generation: r.deployment_generation, invalidated_reason: invalidated });
  if (invalidated === null) {
    const rec = envRecord(tx, op.project, env.id);
    if (outcome === 'verified') {
      tx.db
        .prepare('UPDATE "environment_records" SET "last_verified" = ? WHERE "id" = ?')
        .run(
          JSON.stringify({ candidate: r.candidate, artifact_digest: frozen.artifact!.digest, config_identity: r.config_identity, generation: r.deployment_generation, round: r.id, operation: op.id, at: tx.at, verification: id }),
          rec.id,
        );
    } else writeAttempted(tx, op, a, outcome === 'failed' ? 'verification_failed' : 'verification_unknown');
  }
  tx.db.prepare(`UPDATE "operations" SET "orchestration_stage" = 'completion' WHERE "id" = ? AND "orchestration_stage" = 'verification'`).run(op.id);
  tx.db.prepare(`UPDATE "gate_evaluations" SET "stale" = 1 WHERE "candidate" = ? AND "gate_kind" = 'alpha_complete' AND "stale" = 0`).run(r.candidate);
  return { outcome, decides: invalidated === null };
}

// ---- completion (D4 §5.5; J5, J9) ---------------------------------------------------------------

export interface DeployVerdict {
  operation: string | null;
  verification: string | null;
  reasons: { code: string; subjects: string[] }[];
  // The deciding results a satisfied completion rests on, re-read now.
  results: { check: string; key: string; result: string | null; state: string }[];
}

// What `alpha_complete` reads of the deployment (gates.ts): the verification
// row of the deciding round of the operation's current attempt, never a
// stored label trusted (AR B05): its generation current, its round
// deciding, its qualification standing, its results re-read.
export function deploymentVerdict(db: Db, args: { project: string; candidate: string; operation: string | null }): DeployVerdict {
  const reasons: DeployVerdict['reasons'] = [];
  const op = args.operation ? getOp(db, args.operation) : undefined;
  if (!op || op.project !== args.project || op.kind !== 'deploy' || frozenOf(op).candidate !== args.candidate) {
    return { operation: null, verification: null, reasons: [{ code: 'DEPLOY_OPERATION_MISSING', subjects: [args.operation ?? args.candidate] }], results: [] };
  }
  const frozen = frozenOf(op);
  const latest = attemptsOf(db, op.id).at(-1);
  const round = latest ? (db.prepare('SELECT * FROM "verification_rounds" WHERE "attempt" = ? ORDER BY "round" DESC LIMIT 1').get(latest.id) as RoundRow | undefined) : undefined;
  if (!round) return { operation: op.id, verification: null, reasons: [{ code: 'DEPLOY_VERIFICATION_MISSING', subjects: [op.id] }], results: [] };
  if (round.status === 'open') return { operation: op.id, verification: null, reasons: [{ code: 'DEPLOY_VERIFICATION_PENDING', subjects: [round.id] }], results: [] };
  const row = db.prepare('SELECT * FROM "deployment_verifications" WHERE "round" = ?').get(round.id) as
    | { id: string; outcome: string; deployment_generation: number; invalidated_reason: string | null; behavioral_results: string; adapter_qualification: string | null }
    | undefined;
  if (!row) return { operation: op.id, verification: null, reasons: [{ code: 'DEPLOY_VERIFICATION_MISSING', subjects: [round.id] }], results: [] };
  const env = getEnv(db, frozen.environment.id)!;
  if (row.invalidated_reason === 'generation_superseded' || env.current_generation !== row.deployment_generation) reasons.push({ code: 'DEPLOY_GENERATION_SUPERSEDED', subjects: [row.id] });
  else if (row.invalidated_reason !== null) reasons.push({ code: 'DEPLOY_VERIFICATION_PENDING', subjects: [row.id] });
  if (row.outcome === 'failed') reasons.push({ code: 'DEPLOY_VERIFICATION_FAILED', subjects: [row.id] });
  else if (row.outcome === 'unknown') reasons.push({ code: 'DEPLOY_VERIFICATION_UNKNOWN', subjects: [row.id] });
  const q = currentQualification(db, frozen.environment.adapter);
  if (row.outcome === 'verified' && (q?.id !== row.adapter_qualification || !qualificationStands(db, q))) reasons.push({ code: 'DEPLOY_VERIFICATION_UNKNOWN', subjects: [row.id] });
  const stored = JSON.parse(row.behavioral_results) as { check: string; key: string; result: string | null }[];
  const results = stored.map((s) => {
    const res = s.result ? (db.prepare('SELECT * FROM "check_results" WHERE "id" = ?').get(s.result) as ResultRow | undefined) : undefined;
    return { check: s.check, key: s.key, result: s.result, state: res && res.invalidated_at === null ? resultPassed(res) : 'missing' };
  });
  return { operation: op.id, verification: row.id, reasons, results };
}

// A satisfied `alpha_complete` (§5.5), in the evaluation's transaction: the
// candidate `developing → alpha_deployed` and the deploy work item
// complete; the lease released. Not satisfied, the orchestration of an
// operation at its completion ends with the lease released and the work
// item waiting on a blocker that names the cause (§4.7).
export function afterCompletion(tx: Tx, args: { operation: string | null; candidate: string; satisfied: boolean; evaluation: string; reasons: string[] }): void {
  const op = args.operation ? getOp(tx.db, args.operation) : undefined;
  if (args.satisfied) {
    const c = getCandidate(tx.db, args.candidate)!;
    if (c.progress === 'developing') {
      tx.db.prepare(`UPDATE "candidates" SET "progress" = 'alpha_deployed' WHERE "id" = ?`).run(c.id);
      tx.emit('candidate.advanced', { project: c.project, candidate: c.id }, { from: 'developing', to: 'alpha_deployed', evaluation: args.evaluation, operation: op?.id ?? null });
    }
    if (op && op.orchestration_stage !== 'ended') endOperation(tx, op, 'complete', 'alpha_complete');
    else if (op) {
      const item = frozenOf(op).work_item ? getWorkItem(tx, frozenOf(op).work_item!) : undefined;
      if (item && item.status !== 'complete' && item.status !== 'cancelled') endOperation(tx, op, 'complete', 'alpha_complete');
    }
    return;
  }
  if (op && op.orchestration_stage === 'completion') endOperation(tx, op, 'blocked', `deploy_completion_refused:${args.reasons.join(',')}`);
}

// ---- teardown (D4 §4.6) ---------------------------------------------------------------------------

// POST /v1/projects/:p/environments/:e/teardown: an ordinary teardown, by
// the operator's command, no gate. It takes the environment lease or waits
// for it (`environment_busy`).
export function requestTeardown(tx: Tx, args: { project: string; environment: string; incarnation: string; deadlineSeconds: number }): CommandResult {
  const env = environmentByName(tx.db, args.project, args.environment);
  if (!env || env.prefix === null) throw notFound('environment', args.environment);
  const held = environmentLease(tx.db, env.id);
  if (held) {
    throw new Refusal(409, 'environment_busy', `Environment ${env.name} is held by an operation in flight (lease ${held.id}).`, 'Wait until the operation releases the environment, then ask again.', {
      environment: env.id,
      lease: held.id,
    });
  }
  const deadline = addSeconds(tx.at, args.deadlineSeconds);
  const lease = takeLease(tx, env.id, args.incarnation, deadline);
  const { n } = tx.db.prepare(`SELECT COUNT(*) + 1 AS n FROM "operations" WHERE "kind" = 'teardown' AND json_extract("target", '$.environment') = ?`).get(env.id) as { n: number };
  const frozen: FrozenIntent = {
    purpose: 'teardown',
    work_item: null,
    authorization: null,
    candidate: null,
    mapping: null,
    artifact: null,
    config: null,
    targets: [],
    environment: { id: env.id, name: env.name, prefix: env.prefix, adapter: env.adapter },
    lease: { id: lease.id, generation: lease.generation },
  };
  const op = insertOperation(tx, { project: args.project, kind: 'teardown', env, subject: { environment: env.id }, key: sha256(canonical({ kind: 'teardown', environment: env.id, n })), frozen, deadline, authorization: null });
  return { status: 202, body: { operation: { id: op.id, kind: 'teardown', status: op.status } }, effects: [{ kind: 'tick' as const }] };
}

// ---- reads (D4 §6.1; N02: stored reads only) --------------------------------------------------------

export function readEnvironment(db: Db, args: { project: string; environment: string }) {
  const env = environmentByName(db, args.project, args.environment);
  if (!env) throw notFound('environment', args.environment);
  const config = currentConfig(db, env);
  const rec = db.prepare('SELECT * FROM "environment_records" WHERE "environment" = ?').get(env.id) as { last_verified: string | null; attempted: string | null; observed: string; running: string | null } | undefined;
  const running = parseJson<{ config: string; config_version: number; secret_digests: { ref: string; digest: string }[] }>(rec?.running ?? null);
  const inFlight = db
    .prepare(
      `SELECT o."id", o."kind", o."status", o."orchestration_stage" FROM "operations" o
       WHERE json_extract(o."target", '$.environment') = ? AND o."orchestration_stage" IS NOT NULL AND o."orchestration_stage" <> 'ended' ORDER BY o."seq" DESC LIMIT 1`,
    )
    .get(env.id) as { id: string; kind: string; status: string; orchestration_stage: string } | undefined;
  const conditions: string[] = [];
  if (running && config && (running.config !== config.id || canonical(running.secret_digests) !== canonical(JSON.parse(config.secret_digests)))) conditions.push('rotation_pending_replacement');
  return {
    environment: {
      id: env.id,
      name: env.name,
      adapter: env.adapter,
      prefix: env.prefix,
      config: config ? { id: config.id, version: config.version, config_identity: config.config_identity, status: config.status } : null,
      running,
      deployment_generation: env.deployment_generation,
      current_generation: env.current_generation,
      last_verified: parseJson<Record<string, unknown>>(rec?.last_verified ?? null),
      attempted: parseJson<Record<string, unknown>>(rec?.attempted ?? null),
      observed: parseJson<Record<string, unknown>>(rec?.observed ?? null),
      operation_in_flight: inFlight ? { id: inFlight.id, kind: inFlight.kind, status: inFlight.status, stage: inFlight.orchestration_stage } : null,
      conditions,
    },
  };
}

// The deployment parts of an operation, for the operations read.
export function deployParts(db: Db, op: string) {
  const o = getOp(db, op);
  if (!o) return null;
  const j = journalOf(db, op);
  if (!j) return null;
  const intended = db.prepare(`SELECT "payload" FROM "deploy_journal_events" WHERE "operation" = ? AND "event_kind" = 'intended' ORDER BY "seq" LIMIT 1`).get(op) as { payload: string } | undefined;
  const intents = db.prepare('SELECT * FROM "attempt_intents" WHERE "operation" = ? ORDER BY "created_at"').all(op) as Record<string, unknown>[];
  const rounds = db.prepare('SELECT "id", "round", "attempt", "status", "deployment_generation", "registered_at" FROM "verification_rounds" WHERE "operation" = ? ORDER BY "created_at", "round"').all(op);
  return {
    journal_kind: j.journal_kind,
    state: j.state,
    intent: intended ? (JSON.parse(intended.payload) as Record<string, unknown>) : null,
    frozen: frozenOf(o),
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
      preconditions: JSON.parse(i.preconditions as string) as unknown,
    })),
    rounds,
  };
}

export const isDeployKind = (kind: string): boolean => kind === 'deploy' || kind === 'teardown';
export type { CandidateRow, Reconciliation };
