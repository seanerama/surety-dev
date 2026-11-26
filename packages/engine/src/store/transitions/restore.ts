// Restoring an earlier Alpha (DECISIONS item 57, the owner's ruling WO1 Q1
// of 2026-11-26: "Verify the exact candidate against the spec and checks that
// qualified that Alpha. Apply current environment authorization and safety
// policy as well. Show which version was restored. Restoring iteration 1 must
// neither claim iteration 2 passed nor queue work to implement iteration 2.";
// closes DECISIONS item 54; migration 0053's deployment_requests.restore).
//
// POST /v1/projects/:p/iterations/:i/restore {environment?}: the iteration's
// Alpha candidate deployed again, authorized against the acceptance scope
// recorded by the evaluation that qualified that Alpha (the iteration's
// deployment request → its authorization → its alpha_authorize evaluation
// → its scope: the specification revision, the effective protected version
// and the required checks then), never against the project's current
// specification: each of those checks' results on the candidate under that
// version is read again (checkState) and must still be passed. The current
// facts apply as well: the environment's configuration must be the one
// that Alpha was authorized under (config identity) and not secrets_changed,
// its adapter qualification current, no blocking finding applying to the
// candidate open since, and D4's target binding (requestDeployment). The
// gap path (alpha-gap.ts) is never taken: a restore that cannot be
// authorized is refused, naming why, and queues nothing. No work is
// attributed to the current iteration and its Alpha is not recorded on it
// (deploy.ts afterCompletion).

import { Refusal } from '../../refusal.js';
import { canonical, notFound, parseJson, sha256 } from './common.js';
import { currentConfig, environmentByName, qualificationFor, supersedeUnattempted } from './deploy.js';
import { type CandidateRow, type CheckRow, getCandidate } from './evidence.js';
import { type FindingRow, blocks, checkState, findingApplies } from './gates.js';
import type { VersionRow } from './protected.js';
import type { Tx } from './tx.js';

type Db = Tx['db'];

export interface RestoreSource {
  iteration: { id: string; seq: number; project: string };
  candidate: CandidateRow;
  request: { id: string; environment: string };
  authorization: { id: string; environment: string; config_identity: string };
  evaluation: string;
  scope: Record<string, unknown> & { id: string; spec_revision: string | null; effective_protected_version: string; required_check_ids: string; delivered_requirement_ids: string };
}

// What qualified the iteration's Alpha, as recorded; refused when the
// iteration has no Alpha recorded through an authorization.
export function restoreSource(db: Db, project: string, iteration: string): RestoreSource {
  const it = db.prepare('SELECT "id", "seq", "project", "candidate", "deployment_request", "alpha_at" FROM "prototype_iterations" WHERE "id" = ? AND "project" = ?').get(iteration, project) as
    | { id: string; seq: number; project: string; candidate: string | null; deployment_request: string | null; alpha_at: string | null }
    | undefined;
  if (!it) throw notFound('iteration', iteration);
  const none = (why: string) => new Refusal(409, 'illegal_transition', `Iteration ${it.seq} has no Alpha to restore: ${why}.`, 'Restore an iteration that reached its Alpha.', { iteration: it.id });
  if (it.alpha_at === null || it.candidate === null || it.deployment_request === null) throw none('it never reached its Alpha');
  const request = db.prepare('SELECT "id", "environment", "authorization" FROM "deployment_requests" WHERE "id" = ?').get(it.deployment_request) as { id: string; environment: string; authorization: string | null } | undefined;
  if (!request || request.authorization === null) throw none('its deployment request names no authorization');
  const auth = db.prepare('SELECT "id", "environment", "config_identity", "evaluation" FROM "deployment_authorizations" WHERE "id" = ?').get(request.authorization) as
    | { id: string; environment: string; config_identity: string; evaluation: string | null }
    | undefined;
  if (!auth || auth.evaluation === null) throw none('its authorization names no evaluation');
  const ev = db.prepare('SELECT "scope" FROM "gate_evaluations" WHERE "id" = ?').get(auth.evaluation) as { scope: string } | undefined;
  const scope = ev ? (db.prepare('SELECT * FROM "acceptance_scopes" WHERE "id" = ?').get(ev.scope) as RestoreSource['scope'] | undefined) : undefined;
  if (!scope) throw none('the evaluation that qualified it names no acceptance scope');
  const candidate = getCandidate(db, it.candidate);
  if (!candidate) throw notFound('candidate', it.candidate);
  return { iteration: { id: it.id, seq: it.seq, project }, candidate, request: { id: request.id, environment: request.environment }, authorization: { id: auth.id, environment: auth.environment, config_identity: auth.config_identity }, evaluation: auth.evaluation, scope };
}

// The checks a restore makes now, before anything is sealed and again in its
// transaction; each refusal names what refused it. Returns the candidate and
// the environment's name.
export function restoreFacts(db: Db, args: { project: string; iteration: string; environment?: unknown }): { candidate: string; environment: string; source: RestoreSource } {
  const source = restoreSource(db, args.project, args.iteration);
  if (args.environment !== undefined && typeof args.environment !== 'string') throw new Refusal(400, 'invalid_value', '"environment" must be a string.', 'Name the environment, or leave it out for the one that Alpha was deployed to.', { field: 'environment' });
  const original = db.prepare('SELECT "name" FROM "environments" WHERE "id" = ?').get(source.authorization.environment) as { name: string } | undefined;
  const name = (args.environment as string | undefined) ?? original?.name;
  const env = name === undefined ? undefined : environmentByName(db, args.project, name);
  if (!env || env.prefix === null) throw notFound('environment', String(name));
  const config = currentConfig(db, env);
  if (!config) throw notFound('environment configuration', env.name);
  const subject = { iteration: source.iteration.id, candidate: source.candidate.id, environment: env.id, qualified_by: source.evaluation };
  // The current environment authorization: the configuration that Alpha was
  // authorized under, still current and its secrets as recorded.
  if (config.config_identity !== source.authorization.config_identity) {
    throw new Refusal(409, 'config_changed', `The configuration of ${env.name} changed since iteration ${source.iteration.seq}'s Alpha was authorized (configuration identity ${config.config_identity}, then ${source.authorization.config_identity}): that Alpha was not qualified under it.`, 'Request a deployment of the candidate instead, which is evaluated under the current configuration; nothing was restored.', { ...subject, config: config.id, config_identity: config.config_identity, qualified_config_identity: source.authorization.config_identity });
  }
  if (config.status === 'secrets_changed') throw new Refusal(409, 'config_secrets_changed', `A secret the current configuration of ${env.name} names has a value other than its version records.`, 'Write a new configuration version; nothing was restored.', { ...subject, config: config.id });
  if (qualificationFor(db, env) === undefined) {
    throw new Refusal(409, 'adapter_unqualified', `No adapter qualification of ${env.adapter} is current on this engine and host for ${env.name}: the restore is refused under the current authorization.`, `Run \`surety qualify-adapter ${env.adapter}\`, then restore again; nothing was restored.`, subject);
  }
  // Findings: any blocking finding that applies to the candidate now.
  const blocking = (db.prepare(`SELECT * FROM "findings" WHERE "project" = ? AND "status" IN ('open', 'dispositioned') ORDER BY "seq"`).all(args.project) as FindingRow[])
    .filter((f) => findingApplies(db, f, source.candidate) && f.disposition !== 'accept' && f.disposition !== 'defer' && blocks(f, 'alpha_authorize', { candidate: source.candidate.id, contentHash: String(source.scope.acceptance_content_hash ?? '') }))
    .map((f) => f.id);
  if (blocking.length > 0) {
    throw new Refusal(409, 'finding_blocking', `Finding(s) ${blocking.join(', ')} apply to candidate ${source.candidate.id} and block its Alpha: iteration ${source.iteration.seq}'s Alpha is not restored.`, 'Disposition the finding(s), then restore again; nothing was restored.', { ...subject, findings: blocking });
  }
  // The checks that qualified that Alpha, read again on the candidate under
  // that protected version.
  const version = db.prepare('SELECT * FROM "protected_versions" WHERE "id" = ?').get(source.scope.effective_protected_version) as VersionRow | undefined;
  if (!version) throw notFound('protected version', source.scope.effective_protected_version);
  const ids = parseJson<string[]>(source.scope.required_check_ids) ?? [];
  const notPassed: { check: string; state: string }[] = [];
  for (const id of ids) {
    const check = db.prepare('SELECT * FROM "checks" WHERE "id" = ?').get(id) as CheckRow | undefined;
    if (!check) {
      notPassed.push({ check: id, state: 'missing' });
      continue;
    }
    const s = checkState(db, args.project, check, { candidate: source.candidate, effective: version, environment: env.id, artifact: null });
    if (s.state !== 'passed') notPassed.push({ check: id, state: s.state });
  }
  if (ids.length === 0 || notPassed.length > 0) {
    throw new Refusal(
      409,
      'check_not_passed',
      ids.length === 0
        ? `The scope that qualified iteration ${source.iteration.seq}'s Alpha names no required check: nothing can be verified again.`
        : `Check(s) of the scope that qualified iteration ${source.iteration.seq}'s Alpha are not passed on candidate ${source.candidate.id} now: ${notPassed.map((c) => `${c.check} (${c.state})`).join(', ')}. Re-running a superseded version's checks is not done by a restore.`,
      'Nothing was restored.',
      { ...subject, checks: notPassed },
    );
  }
  return { candidate: source.candidate.id, environment: env.name, source };
}

// In the restore's request transaction (deploy.ts requestDeployment): the
// scope that qualified that Alpha recorded again for this authorization
// (its specification revision, protected version, delivered requirements
// and required checks; this environment and artifact), its evaluation
// satisfied, and the authorization issued under it.
export function recordRestoreEvaluation(tx: Tx, args: { source: RestoreSource; authorization: { id: string; project: string; candidate: string; environment: string; status: string }; environment: string; artifact: string }): { id: string; outcome: string; reasons: unknown[] } {
  const s = args.source.scope;
  const scopeId = tx.newId('scope_');
  const body = { restore_of: s.id, iteration: args.source.iteration.id, environment: args.environment, artifact: args.artifact };
  tx.db
    .prepare(
      `INSERT INTO "acceptance_scopes" ("id", "created_at", "project", "candidate", "gate_kind", "stage", "policy_revision", "effective_protected_version", "source_revision",
         "delivered_requirement_ids", "partial_requirement_ids", "sensitivity_categories", "required_check_ids", "runner_classes", "required_signoffs",
         "environment", "artifact_digest", "evidence_reuse", "validated", "scope_hash", "acceptance_content_hash", "spec_revision", "architecture_revision", "phase")
       VALUES (?, ?, ?, ?, 'alpha_authorize', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 1, ?, ?, ?, ?, ?)`,
    )
    .run(
      scopeId,
      tx.at,
      args.authorization.project,
      args.source.candidate.id,
      (tx.db.prepare('SELECT "policy_revision" FROM "projects" WHERE "id" = ?').get(args.authorization.project) as { policy_revision: string | null }).policy_revision,
      s.effective_protected_version,
      args.source.candidate.revision,
      s.delivered_requirement_ids,
      s.partial_requirement_ids as string,
      s.sensitivity_categories as string,
      s.required_check_ids,
      s.runner_classes as string,
      s.required_signoffs as string,
      args.environment,
      args.artifact,
      sha256(canonical({ ...body, scope_hash: s.scope_hash })),
      s.acceptance_content_hash as string,
      s.spec_revision,
      (s.architecture_revision as string | null) ?? null,
      (s.phase as number | null) ?? null,
    );
  tx.emit('gate.scope_built', { project: args.authorization.project, candidate: args.source.candidate.id, scope: scopeId }, { gate_kind: 'alpha_authorize', stage: null, required: parseJson<string[]>(s.required_check_ids) ?? [], delivered: parseJson<string[]>(s.delivered_requirement_ids) ?? [], restore_of: s.id });
  const id = tx.newId('gate_');
  const snapshot = { restore_of: { iteration: args.source.iteration.id, evaluation: args.source.evaluation, scope: s.id } };
  const ev = tx.emit('gate.evaluated', { project: args.authorization.project, candidate: args.source.candidate.id, evaluation: id }, { gate_kind: 'alpha_authorize', outcome: 'satisfied', reasons: [], restore_of: snapshot.restore_of });
  tx.db
    .prepare(
      `INSERT INTO "gate_evaluations" ("id", "created_at", "project", "scope", "candidate", "gate_kind", "computed_at", "inputs_hash", "inputs_snapshot", "check_states",
         "outcome", "reasons", "satisfiers", "stale", "stage", "authorization", "checks", "missing_verifications", "seq")
       VALUES (?, ?, ?, ?, ?, 'alpha_authorize', ?, ?, ?, '{}', 'satisfied', '[]', '[]', 0, NULL, ?, '{}', '[]', ?)`,
    )
    .run(id, tx.at, args.authorization.project, scopeId, args.source.candidate.id, tx.at, sha256(canonical(snapshot)), JSON.stringify(snapshot), args.authorization.id, ev.seq);
  // Issued under it (as gates.ts issueAuthorization): an earlier issued one
  // of the candidate and environment superseded first.
  const earlier = tx.db
    .prepare(`SELECT "id" FROM "deployment_authorizations" WHERE "candidate" = ? AND "environment" = ? AND "status" = 'issued' AND "id" <> ?`)
    .all(args.authorization.candidate, args.authorization.environment, args.authorization.id) as { id: string }[];
  for (const e of earlier) {
    tx.db.prepare(`UPDATE "deployment_authorizations" SET "status" = 'superseded' WHERE "id" = ?`).run(e.id);
    tx.emit('authorization.superseded', { project: args.authorization.project, candidate: args.authorization.candidate, authorization: e.id }, { by: args.authorization.id });
  }
  supersedeUnattempted(tx, args.authorization);
  tx.db.prepare(`UPDATE "deployment_authorizations" SET "status" = 'issued', "evaluation" = ? WHERE "id" = ? AND "status" = 'proposed'`).run(id, args.authorization.id);
  tx.emit('authorization.issued', { project: args.authorization.project, candidate: args.authorization.candidate, authorization: args.authorization.id }, { evaluation: id, environment: args.authorization.environment, restore_of: snapshot.restore_of });
  return { id, outcome: 'satisfied', reasons: [] };
}

// What the environment's current deployment was restored from, while it is
// a restore (the environment read): its iteration, candidate, specification
// revision, protected version, the evaluation that qualified it, and when.
// null when the environment's latest deployed request was not a restore.
export function restoredOf(db: Db, environment: string): Record<string, unknown> | null {
  const r = db.prepare(`SELECT "id", "restore", "authorization" FROM "deployment_requests" WHERE "environment" = ? AND "outcome" = 'deployed' ORDER BY rowid DESC LIMIT 1`).get(environment) as { id: string; restore: string | null; authorization: string | null } | undefined;
  const restore = parseJson<Record<string, unknown>>(r?.restore ?? null);
  if (!r || restore === null) return null;
  const done = r.authorization === null ? undefined : (db.prepare(`SELECT "finalized_at" FROM "operations" WHERE "authorization" = ? ORDER BY rowid DESC LIMIT 1`).get(r.authorization) as { finalized_at: string | null } | undefined);
  return { ...restore, request: r.id, restored_at: done?.finalized_at ?? null };
}

// The iteration whose Alpha an authorization's request restores, or null.
export function restoreOfAuthorization(db: Db, authorization: string): string | null {
  const r = db.prepare('SELECT "restore" FROM "deployment_requests" WHERE "authorization" = ? AND "restore" IS NOT NULL ORDER BY rowid DESC LIMIT 1').get(authorization) as { restore: string } | undefined;
  const id = parseJson<{ iteration_id?: unknown }>(r?.restore ?? null)?.iteration_id;
  return typeof id === 'string' ? id : null;
}
