// Fixtures, commands and reads for the M4 slice-23 rows, the walking
// deployment on the scripted deployment adapter (M301 to M306; SEAM.md
// §§244 to 254). Kernel lane: real SQLite and git, the scripted roles, the
// scripted check boundary of SEAM §190 and the scripted deployment adapter
// of SEAM §247, which stands in for every host call `local_service` would
// make. Nothing here creates a service unit, runs systemd-run or systemctl,
// or signals any process: the target is a JSON document the engine reads
// through the seam.
//
// Every workspace and post-deploy check result here comes from an execution
// the engine registered, moved through the scripted check boundary (the
// engine's own transition); none comes from the check-result fixture.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { releaseBarrier, waitFor } from '../engine.mjs';
import { permittedEdit, roleThat } from '../gitruns.mjs';
import { eventsOfType } from '../journal.mjs';
import { recordExit } from '../checks/selection.mjs';
import { buildAndNominate, def } from '../checks/repair.mjs';
import { scopeProject } from '../checks/scope.mjs';
import { requestTick, tick, tickUntil } from '../runs.mjs';
import { withStore } from '../store.mjs';

const json = (text) => (text === null || text === undefined ? text : typeof text === 'string' ? JSON.parse(text) : text);
const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const row = (home, sql, ...params) => rows(home, sql, ...params)[0];

// ---- the configuration (SEAM.md §245) -------------------------------------------------------

// The runtime the configurations pin: the node that runs the tests, by path
// and hash (BS4 §9: the reference project's runtime is the engine's own node).
export const RUNTIME = Object.freeze({ path: process.execPath, sha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') });

// The adapter version the configurations and the qualification fixture name.
export const ADAPTER_VERSION = '1';

// A configuration's content, complete (SEAM.md §245), with `over` applied.
export function configContent(over = {}) {
  return {
    adapter: 'local_service',
    adapter_version: ADAPTER_VERSION,
    targets: ['app'],
    runtime: { ...RUNTIME },
    start: [RUNTIME.path, 'server.js'],
    port: 8080,
    env: {},
    secrets: {},
    check_secrets: [],
    egress: [],
    artifact: { exclude: [] },
    identity_method: 'tree_digest',
    ...over,
  };
}

// PUT the owner's configuration of environment `name` (SEAM.md §245).
export const putConfig = (engine, project, name, content, opts = {}) =>
  engine.request('PUT', `/v1/projects/${project}/environments/${name}/config`, { body: content, ...opts });

// A configuration version written; returns {environment: {id, name}, config: {id, version, config_identity, status}}.
export async function configure(engine, project, name, content = configContent()) {
  const res = await putConfig(engine, project, name, content);
  assert.ok([200, 201].includes(res.status), `the owner writes configuration of ${name} through PUT …/environments/${name}/config (SEAM.md §245) (→ ${res.status} ${res.text})`);
  assert.match(res.body?.environment?.id ?? '', /^env_/, `the answer names the environment (body: ${res.text})`);
  assert.match(res.body?.config?.config_identity ?? '', /^sha256:[0-9a-f]{64}$/, `the answer carries the version's config_identity (body: ${res.text})`);
  return res.body;
}

export const configsOf = (home, environment) =>
  rows(home, 'SELECT * FROM "environment_configs" WHERE "environment" = ? ORDER BY "version"', environment).map((r) => ({ ...r, content: json(r.content), secret_digests: json(r.secret_digests) }));
export const environmentRow = (home, id) => row(home, 'SELECT * FROM "environments" WHERE "id" = ?', id);

// ---- the labelled qualification facts (SEAM.md §248) ----------------------------------------

export async function qualifyByFixture(engine, { adapter = 'local_service', adapter_version = ADAPTER_VERSION } = {}) {
  const res = await engine.post('/v1/harness/fixtures/adapter-qualification', { adapter, adapter_version });
  assert.equal(res.status, 201, `the adapter qualification fixture records a current row labelled test_fixture (SEAM.md §248) (body: ${res.text})`);
  assert.match(res.body?.adapter_qualification ?? '', /^aq_/, `it names the row (body: ${res.text})`);
  return res.body.adapter_qualification;
}

export async function lapseByFixture(engine, id) {
  const res = await engine.post('/v1/harness/fixtures/adapter-qualification', { adapter_qualification: id, status: 'lapsed' });
  assert.equal(res.status, 200, `the fixture lapses its own row (SEAM.md §248) (body: ${res.text})`);
}

// ---- the scripted deployment adapter (SEAM.md §247) -------------------------------------------

const adapterPath = (environment) => `/v1/harness/deploy/environments/${environment}`;

// Queue answers for the next calls of `call` on the environment.
export async function scriptCall(engine, environment, call, answers) {
  const res = await engine.post(`${adapterPath(environment)}/answers`, { call, answers });
  assert.equal(res.status, 200, `the scripted deployment adapter takes answers for ${call} (SEAM.md §247) (body: ${res.text})`);
}

// Replace the scripted target's state.
export async function setTarget(engine, environment, target) {
  const res = await engine.post(`${adapterPath(environment)}/target`, target);
  assert.equal(res.status, 200, `the scripted target is set (SEAM.md §247) (body: ${res.text})`);
}

// Admission of the service domain, `granted` (the default) or `held`.
export async function setAdmission(engine, environment, answer) {
  const res = await engine.post(`${adapterPath(environment)}/admission`, { answer });
  assert.equal(res.status, 200, `the scripted admission answers ${answer} (SEAM.md §247) (body: ${res.text})`);
}

// {target: {complete, units}, calls: [{call, at, capability, answer}], admission}.
export async function adapterState(engine, environment) {
  const res = await engine.get(adapterPath(environment));
  assert.equal(res.status, 200, `the scripted deployment adapter's state is read (SEAM.md §247) (body: ${res.text})`);
  return res.body;
}

export const effectCalls = (state, call = 'deploy') => state.calls.filter((c) => c.call === call);

// ---- requests, gates and the fixture authorization (SEAM.md §§246, 249) ------------------------

export const requestDeployment = (engine, project, candidate, environment, extra = {}) => engine.post(`/v1/projects/${project}/deployments`, { candidate, environment, ...extra });

// A satisfied request: returns {authorization, work_item, evaluation}.
export async function deploy(engine, project, candidate, environment) {
  const res = await requestDeployment(engine, project, candidate, environment);
  assert.ok([200, 201].includes(res.status), `the deployment request is answered with an issued authorization (SEAM.md §246) (→ ${res.status} ${res.text})`);
  assert.equal(res.body?.authorization?.status, 'issued', `the authorization is issued (body: ${res.text})`);
  assert.match(res.body?.work_item?.id ?? '', /^wi_/, `the answer names the deploy work item (body: ${res.text})`);
  return res.body;
}

export const evaluateAlphaComplete = (engine, project, candidate, operation) => engine.post(`/v1/projects/${project}/candidates/${candidate}/gates/alpha_complete`, { operation });

export async function fixtureAuthorization(engine, binding) {
  const res = await engine.post('/v1/harness/fixtures/authorization', binding);
  assert.ok([200, 201].includes(res.status), `the fixture records an authorization with the caller's binding (SEAM.md §246) (→ ${res.status} ${res.text})`);
  return res.body.authorization;
}

export const teardown = (engine, project, environment, body = {}) => engine.post(`/v1/projects/${project}/environments/${environment}/teardown`, body);

export async function armBarrier(engine, name, action = 'pause') {
  const res = await engine.post('/v1/harness/barriers', { name, action });
  assert.ok(res.status >= 200 && res.status < 300, `arm ${name}=${action} (SEAM.md §251) (body: ${res.text})`);
}

export async function atBarrier(engine, name) {
  await waitFor(async () => (await engine.get('/v1/harness/barriers')).body?.barriers?.some((b) => b.name === name && b.state === 'waiting'), { what: `the engine to wait at ${name}`, timeoutMs: 60_000 });
}

export { releaseBarrier };

// Ask for ticks of the project until the engine waits at the paused barrier
// `name` (armed beforehand). A paused tick does not end, so each request is
// answered 202 and not waited for.
export async function tickToBarrier(fx, project, name, { attempts = 10 } = {}) {
  const waiting = async () => (await fx.engine.get('/v1/harness/barriers')).body?.barriers?.some((b) => b.name === name && b.state === 'waiting');
  for (let i = 0; i < attempts; i++) {
    await requestTick(fx.engine, project);
    try {
      await waitFor(waiting, { timeoutMs: 3000, what: `the engine to wait at ${name}` });
      return;
    } catch {
      // not yet: another tick
    }
  }
  throw new Error(`the engine never waited at ${name} after ${attempts} tick requests`);
}

// ---- store reads (SEAM.md §250) -------------------------------------------------------------

const parseOp = (r) => r && { ...r, target: json(r.target), subject: json(r.subject), finalizer_inputs: json(r.finalizer_inputs), outcome_detail: r.outcome_detail === null ? null : safeJson(r.outcome_detail) };
const safeJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export const operationsOf = (home, project, kind) => rows(home, 'SELECT * FROM "operations" WHERE "project" = ? AND "kind" = ? ORDER BY "seq"', project, kind).map(parseOp);
export const operationRow = (home, id) => parseOp(row(home, 'SELECT * FROM "operations" WHERE "id" = ?', id));
export const attemptsOf = (home, operation) =>
  rows(home, 'SELECT * FROM "operation_attempts" WHERE "operation" = ? ORDER BY "attempt_number"', operation).map((a) => ({
    ...a,
    reconciliation_reads: json(a.reconciliation_reads),
    capability: json(a.capability),
    init_instance: json(a.init_instance),
    app_instance: json(a.app_instance),
    receipt: json(a.receipt),
  }));
export const attemptIntent = (home, attempt) => {
  const r = row(home, 'SELECT * FROM "attempt_intents" WHERE "attempt" = ?', attempt);
  return r && { ...r, create_units: json(r.create_units), prior: json(r.prior), cleanup: json(r.cleanup) };
};
export const roundsOf = (home, operation) => rows(home, 'SELECT * FROM "verification_rounds" WHERE "operation" = ? ORDER BY "round"', operation).map((r) => ({ ...r, required_checks: json(r.required_checks) }));
export const verificationsOf = (home, round) =>
  rows(home, 'SELECT * FROM "deployment_verifications" WHERE "round" = ? ORDER BY rowid', round).map((v) => ({ ...v, identity_reads: json(v.identity_reads), missing: json(v.missing) }));
export const environmentRecord = (home, environment) => {
  const r = row(home, 'SELECT * FROM "environment_records" WHERE "environment" = ?', environment);
  return r && { ...r, last_verified: json(r.last_verified), attempted: json(r.attempted), observed: json(r.observed) };
};
export const artifactsOf = (home, project) => rows(home, 'SELECT * FROM "artifacts" WHERE "project" = ? ORDER BY rowid', project);
export const mappingsOf = (home, artifact) => rows(home, 'SELECT * FROM "artifact_mappings" WHERE "artifact" = ? ORDER BY rowid', artifact);
export const authorizationRow = (home, id) => row(home, 'SELECT * FROM "deployment_authorizations" WHERE "id" = ?', id);
export const deployWork = (home, project) => rows(home, `SELECT * FROM "work_items" WHERE "project" = ? AND "kind" = 'deploy' ORDER BY "seq"`, project).map((w) => ({ ...w, subject: json(w.subject) }));
export const environmentLeases = (home, environment) => rows(home, `SELECT * FROM "leases" WHERE "resource_kind" = 'environment' AND "resource_id" = ? ORDER BY rowid`, environment);
export const candidateRow = (home, id) => row(home, 'SELECT * FROM "candidates" WHERE "id" = ?', id);

// The post-deploy executions the engine registered for a candidate, with their trigger and binding parsed.
export const postDeployExecutions = (home, candidate) =>
  rows(home, `SELECT x.*, c."key" AS "key" FROM "check_executions" x JOIN "checks" c ON c."id" = x."check" WHERE x."candidate" = ? ORDER BY x."execution_seq"`, candidate)
    .map((x) => ({ ...x, trigger: json(x.trigger), deployment: json(x.deployment) }))
    .filter((x) => x.trigger?.source === 'deployment_verification');

export const eventsAbout = (home, type, key, id) => eventsOfType(home, type).filter((e) => e.subject?.[key] === id);

// The project's operations through the read of SEAM §108, extended in §250.
export async function operationsRead(engine, project) {
  const res = await engine.get(`/v1/projects/${project}/operations`);
  assert.equal(res.status, 200, `the operations read answers (SEAM.md §§108, 250) (body: ${res.text})`);
  return res.body.operations;
}

// GET /v1/projects/:p/environments/:e (`:e` the name; SEAM.md §255): the
// stored read, {environment: {…, supervision, conditions, observed, last_verified, attempted}}.
export async function environmentRead(engine, project, name) {
  const res = await engine.get(`/v1/projects/${project}/environments/${name}`);
  assert.equal(res.status, 200, `the environment read answers (SEAM.md §255) (body: ${res.text})`);
  return res.body.environment;
}

// ---- the deployable project (SEAM.md §244) ----------------------------------------------------

// The files the project's revision carries beside its protected set: the
// service the configuration's start command names.
export const SERVICE_FILES = Object.freeze({
  'server.js': "import { createServer } from 'node:http';\ncreateServer((q, s) => s.end('ok')).listen(Number(process.env.PORT ?? 8080), '127.0.0.1');\n",
  'lib/greeting.js': "export const greeting = 'hello';\n",
});

// The workspace checks (acceptance covering R1.1, smoke) and the required
// `post_deploy_behavior` check of the `alpha_complete` scope (D4 §5.1).
export const POST_DEPLOY = def('post_deploy_behavior', { gates: ['alpha_complete'], requires: ['environment', 'artifact_digest'] });
export const DEPLOY_DEFS = Object.freeze({ acc: def('acceptance', { criteria: ['R1.1'] }), smoke: def('smoke'), behaves: POST_DEPLOY });

// A T1 project whose checks are discovered (`defs`), built and nominated,
// its workspace checks recorded passing through the scripted check boundary;
// environment `name` configured by the owner with `config`; the adapter
// qualified by the labelled fixture unless `qualify` is false.
// Returns {fx, p, project, candidate, reg, env: {id, name}, config, qualification}.
export async function deployable(fx, { defs = DEPLOY_DEFS, name = 'alpha', config = {}, qualify = true, tier = 'T1', files = {} } = {}) {
  const p = await scopeProject(fx, { tier, defs, files: { ...SERVICE_FILES, ...files }, index: [{ key: 'R1', criteria: ['R1.1'] }], stages: [{ number: 1, goal: 'the first stage', implements: ['R1'] }] });
  const workspace = Object.keys(defs).filter((k) => !(defs[k].gate_kinds ?? []).every((g) => g === 'alpha_complete'));
  const built = await buildAndNominate(fx, p, { scripts: [roleThat([permittedEdit()], { nominate: true })], keys: workspace });
  for (const key of workspace) await recordExit(fx.engine, built.reg[key].id, 0);
  const configured = await configure(fx.engine, p.id, name, configContent(config));
  const qualification = qualify ? await qualifyByFixture(fx.engine, { adapter_version: configContent(config).adapter_version }) : null;
  return { fx, p, project: p.id, candidate: built.candidate, reg: built.reg, env: configured.environment, config: configured.config, qualification };
}

// An applying deploy scripted, the request made, and ticks until the
// round's post-deploy execution is registered. Returns {request, operation, execution}.
export async function deployToRound(ctx, { answers = [{ result: 'issued', apply: true }] } = {}) {
  const { fx, project, candidate, env } = ctx;
  await scriptCall(fx.engine, env.id, 'deploy', answers);
  const request = await deploy(fx.engine, project, candidate.id, env.name);
  const execution = await tickUntil(fx.engine, project, () => postDeployExecutions(fx.home, candidate.id)[0], { max: 16, what: 'the round to register its post-deploy check' });
  const [operation] = operationsOf(fx.home, project, 'deploy');
  return { request, operation, execution };
}

// The round's post-deploy execution recorded passing, then ticks until the candidate is alpha_deployed.
export async function completeRound(ctx, execution) {
  const { fx, project, candidate } = ctx;
  await recordExit(fx.engine, execution.id, 0);
  return tickUntil(fx.engine, project, () => (candidateRow(fx.home, candidate.id).progress === 'alpha_deployed' ? true : undefined), { max: 12, what: 'the candidate to be alpha_deployed' });
}

export const tickSome = (fx, project, n = 3) => tick(fx.engine, project, { rounds: n });

// ---- the sealed artifact, read from the host -------------------------------------------------

// Every regular file under `dir`, as {relative path: bytes}.
export function filesUnder(dir, base = dir, out = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(path, base, out);
    else if (entry.isFile()) out[relative(base, path)] = readFileSync(path);
    else out[relative(base, path)] = null;
  }
  return out;
}

export const isWritable = (path) => (statSync(path).mode & 0o222) !== 0;

// The unit names of an environment (D4 §9.3; SEAM.md §250): `<h>` the first
// 12 hex digits of SHA-256 of $SURETY_HOME as the engine is given it, `<env>`
// the environment's id.
export const homeHash = (home) => createHash('sha256').update(home).digest('hex').slice(0, 12);
export const unitPrefix = (home, environment) => `surety-${homeHash(home)}-${environment}-`;
export const unitName = (home, environment, generation) => `${unitPrefix(home, environment)}g${generation}.service`;
