// Developer tests for the engine's file-serving check beside each
// environment and the deployment answer for a service (DECISIONS item 42;
// the owner's words of 2026-11-24: "The pending proposal should be
// visible. ... Keep Deploy available whenever the engine would accept the
// request. A pending proposal alone adds no deployment gate. If the
// required behavioral check is missing, name that as the blocker."; M7
// plan §3e M626, M616 (e) amended).
//
// Against a scratch store (as deploy-readiness.test.mjs): the status
// function's every state, `unread` never taken as none, `holds_deployment`;
// the project read's `environments[]`, GET …/environments and GET
// …/environments/:e serving it; the readiness's `blocker`; a service's
// pending proposal leaving readiness `ready` with the check's state said.
// Then on the kernel lane through the engine's API: a service declaring
// serving, its proposal proposed, its question open, approved, applied.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { consume, openDecision } from '../acceptance/harness/decisions.mjs';
import { proposalsOf, sharedFixture } from '../acceptance/harness/gates.mjs';
import { scriptedEngine, tickUntil } from '../acceptance/harness/runs.mjs';
import { DEPLOY_DEFS, deployable } from '../acceptance/harness/deploy/kernel.mjs';
import { defPath } from '../acceptance/harness/checks/scope.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { transact } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { writeConfigVersion } = await import(join(dist, 'store', 'transitions', 'deploy.js'));
const { validateConfig } = await import(join(dist, 'deploy', 'config.js'));
const { readProject, readEnvironments, readOneEnvironment } = await import(join(dist, 'store', 'projections.js'));
const { servingCheckStatus, servingPendingBlock, requiredCheckBlock, recordCompatibility, SERVING_CHECK_STATES, BLOCKERS } = await import(join(dist, 'deploy', 'compatibility.js'));
const { readTreeKind } = await import(join(dist, 'deploy', 'output-kind.js'));
const { configureGit } = await import(join(dist, 'git', 'exec.js'));
const { ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });
configureGit({ deadlineSeconds: 30, outputCap: 1 << 20, home: mkdtempSync(join(tmpdir(), 'surety-scv-git-')), incarnation: 'inc_test' });

const AT = '2026-11-24T00:00:00.000Z';
const HEX = 'a'.repeat(64);
const BUILD_DONE = 'The planned build and its automated gates are complete.';

// ---- a scratch store --------------------------------------------------------------------

const NODE_MAP = {
  version: 1,
  modules: [{ name: 'api', paths: ['server.mjs'], sensitive_areas: [], interfaces: [{ name: 'notes', kind: 'http', path: '/notes', description: 'the notes' }], surface: 'api' }],
  mapping_from_spec: [],
};
const BROWSER_MAP = {
  version: 1,
  modules: [{ name: 'app', paths: ['index.html', 'src/'], sensitive_areas: [], interfaces: [], surface: 'ui', targets: [{ target: 'web', ui_technology: 'three_js' }] }],
  mapping_from_spec: [],
};
const spec = (runtime) => ({
  header: { spec_version: 1, status: 'approved', tier: 'T2', owner: 'o' },
  requirements: [],
  index: [],
  questions: [],
  modules: [],
  claims: [],
  environments: [{ name: 'alpha', fields: { Purpose: 'Alpha', ...(runtime ? { 'Runtime and start command': runtime } : {}) } }],
  targets: ['web'],
});

function store(t, { node = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-scv-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  db.prepare(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T2', ?, 'main', 'spec_ready', 'registered', '{}')`,
  ).run(AT, join(dir, 'repo-missing'));
  db.prepare(`INSERT INTO spec_semantics (id, created_at, project, git_blob, representation, readable) VALUES ('ss_1', ?, 'prj_1', 'b', ?, 1)`).run(AT, JSON.stringify(spec(node ? '`node server.mjs`' : null)));
  db.prepare(`INSERT INTO spec_revisions (id, created_at, project, version, git_path, git_blob, semantic_digest, semantics, approved_by, approved_at) VALUES ('sr_1', ?, 'prj_1', 1, '.surety/spec/spec.md', 'b', 'd', 'ss_1', 'human', ?)`).run(AT, AT);
  db.prepare(`INSERT INTO architecture_revisions (id, created_at, project, version, blobs, module_map, mapping_from_spec, approved_by, approved_at) VALUES ('ar_1', ?, 'prj_1', 1, '{}', ?, '[]', 'human', ?)`).run(
    AT,
    JSON.stringify(node ? NODE_MAP : BROWSER_MAP),
    AT,
  );
  db.prepare(`INSERT INTO environments (id, created_at, project, name, adapter, adapter_config_ref, verify_spec) VALUES ('env_alpha', ?, 'prj_1', 'alpha', 'none', 'spec', '{}')`).run(AT);
  // The build complete: every roadmap phase's plan completed.
  db.prepare(`INSERT INTO roadmap_revisions (id, created_at, project, version, git_path, git_blob, phases, approved_by, approved_at) VALUES ('rm_1', ?, 'prj_1', 1, 'r', 'b', ?, 'human', ?)`).run(AT, JSON.stringify([{ number: 1 }]), AT);
  db.prepare(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, generation, active, status, completed_at) VALUES ('plan_1', ?, 'prj_1', 1, ?, 'p1.json', 1, 1, 'completed', ?)`).run(AT, 'a'.repeat(40), AT);
  return db;
}

// The current candidate, a Node service's tree, its kind recorded as a
// nomination's evaluation records it (so NOW reads build_complete).
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
async function nodeCandidate(t, db) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-scv-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node server.mjs' } }));
  writeFileSync(join(dir, 'server.mjs'), '');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'c');
  const revision = git(dir, 'rev-parse', 'HEAD');
  db.prepare(`UPDATE projects SET dev_repo_path = ?`).run(dir);
  db.prepare(`INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress, held_work) VALUES ('cand_1', ?, 'prj_1', 1, ?, 'lin_1', ?, 'engine_cadence', 'developing', '[]')`).run(AT, revision, AT);
  const tree = await readTreeKind(dir, revision);
  transact(db, ENGINE_ACTOR, (tx) => recordCompatibility(tx, { project: 'prj_1', trigger: 'candidate_nominated', tree }));
  return revision;
}

const SERVICE = { adapter: 'local_service', adapter_version: '1', targets: ['alpha'], runtime: { path: '/usr/bin/node', sha256: HEX }, start: ['node', 'server.mjs'], port: 8080 };
const { start: _start, ...NO_START } = SERVICE;
const serviceConfig = (over = {}) => validateConfig({ ...structuredClone(SERVICE), ...over });
const staticConfig = () => validateConfig({ ...structuredClone(NO_START), mode: 'static' });

function configure(db, name, content) {
  return transact(db, { actor_kind: 'human', actor_id: 'owner', request_id: null }, (tx) =>
    writeConfigVersion(tx, { project: 'prj_1', name, content, identity: `sha256:${JSON.stringify(content)}`, secretDigests: [], homeHash: 'abcdefabcdef', tree: null }),
  );
}
const envId = (db, name = 'alpha') => db.prepare(`SELECT id FROM environments WHERE name = ? AND prefix IS NOT NULL`).get(name).id;
const effectiveV1 = (db) =>
  db.prepare(`INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, roots, effective_from) VALUES ('pv_1', ?, 'prj_1', 1, 'f1', 'initial', 'h', 'human', ?, 1, '[]', ?)`).run(AT, AT, AT);
const check = (db, key, kind, gates = ['alpha_complete']) =>
  db
    .prepare(`INSERT INTO checks (id, created_at, project, protected_version, key, kind, required, gate_kinds, definition_path, definition_hash, runner_class) VALUES (?, ?, 'prj_1', 'pv_1', ?, ?, 1, ?, 'x', 'h', 'direct')`)
    .run(`chk_${key}`, AT, key, kind, JSON.stringify(gates));
const proposal = (db, status, id = 'pp_1', seq = 1) =>
  db.prepare(`INSERT INTO protected_proposals (id, created_at, project, seq, proposed_by, base_revision, tree_id, diff_hash, requested_change_kind, status) VALUES (?, ?, 'prj_1', ?, 'engine', 'b', 't', 'd', 'tightening', ?)`).run(id, AT, seq, status);
const setProposal = (db, status, id = 'pp_1') => db.prepare(`UPDATE protected_proposals SET status = ? WHERE id = ?`).run(status, id);
const decision = (db, id, subject, status = 'open') =>
  db
    .prepare(
      `INSERT INTO decisions (id, created_at, project, seq, kind, subject_type, subject_id, semantic_generation, scope, question, options, dependency_manifest, transition_schema_version, preview_hash, evidence, blocked_while_open, raised_at, status)
       VALUES (?, ?, 'prj_1', 1, 'check_correction_tightening', 'protected_proposal', ?, 1, 'subject', 'q', '[]', '{}', 1, 'h', '[]', '{}', ?, ?)`,
    )
    .run(id, AT, subject, AT, status);
const read = (db) => readProject(db, { project: 'prj_1' }).project;
const status = (db, output = 'node_service', name = 'alpha') => servingCheckStatus(db, 'prj_1', envId(db, name), output);

const PUBLIC = { mode: 'service', root: 'public', entry: 'index.html' };
const SERVICE_TAIL = 'for a service it does not hold the deployment: the required behavioural check (post_deploy_behavior) does';
const MISSING =
  "the required behavioural check (post_deploy_behavior, of the alpha_complete scope) is not in the effective protected version; a Verifier writes it, asked by the engine when a deployment is requested (the policy's request under on_phase_complete, or a request from the operator console), and its approval and a request again follow";

// ---- the status, every state -------------------------------------------------------------

test('the served names: six states, five blockers (signoff_pending, DECISIONS item 44)', () => {
  assert.deepEqual([...SERVING_CHECK_STATES], ['present', 'awaiting_decision', 'approved', 'proposed', 'not_proposed', 'unread']);
  assert.deepEqual([...BLOCKERS], ['required_check_missing', 'serving_check_pending', 'checks_running', 'checks_unread', 'signoff_pending']);
});

test('a service declaring serving: proposed, awaiting_decision, approved, present, each named; holds_deployment false throughout', (t) => {
  const db = store(t);
  configure(db, 'alpha', serviceConfig({ serving: { root: 'public' } }));
  effectiveV1(db);
  check(db, 'behaves', 'post_deploy_behavior');
  proposal(db, 'captured');
  assert.deepEqual(status(db), {
    kind: 'post_deploy_serving',
    declared: PUBLIC,
    state: 'proposed',
    check: null,
    proposal: 'pp_1',
    decision: null,
    holds_deployment: false,
    reason: `The engine's file-serving check is proposed (proposal pp_1); its question is raised at a coming tick; ${SERVICE_TAIL}.`,
  });
  setProposal(db, 'classified');
  assert.equal(status(db).state, 'proposed', 'classified, its question not yet raised');
  decision(db, 'dec_1', 'pp_1');
  assert.deepEqual(status(db), {
    kind: 'post_deploy_serving',
    declared: PUBLIC,
    state: 'awaiting_decision',
    check: null,
    proposal: 'pp_1',
    decision: 'dec_1',
    holds_deployment: false,
    reason: `The engine's file-serving check is proposed (proposal pp_1) and waits for your answer on decision dec_1; ${SERVICE_TAIL}.`,
  });
  db.prepare(`UPDATE decisions SET status = 'consumed' WHERE id = 'dec_1'`).run();
  setProposal(db, 'approved');
  assert.deepEqual([status(db).state, status(db).decision, status(db).proposal], ['approved', null, 'pp_1']);
  assert.equal(status(db).reason, `The engine's file-serving check (proposal pp_1) is approved, awaiting application; ${SERVICE_TAIL}.`);
  setProposal(db, 'applied');
  check(db, 'surety-static-serving', 'post_deploy_serving');
  assert.deepEqual(status(db), {
    kind: 'post_deploy_serving',
    declared: PUBLIC,
    state: 'present',
    check: 'surety-static-serving',
    proposal: null,
    decision: null,
    holds_deployment: false,
    reason: `The engine's file-serving check surety-static-serving is in place in the effective protected version; ${SERVICE_TAIL}.`,
  });
});

test('not_proposed says why: no serving declared; the proposal rejected; none captured; present with declared null when the project has the check', (t) => {
  const db = store(t);
  configure(db, 'alpha', serviceConfig());
  effectiveV1(db);
  let s = status(db);
  assert.deepEqual([s.declared, s.state, s.proposal, s.holds_deployment], [null, 'not_proposed', null, false]);
  assert.match(s.reason, /^The engine's file-serving check is not proposed for environment alpha: its configuration declares no serving root and entry; for a service it does not hold the deployment/);
  configure(db, 'alpha', serviceConfig({ serving: {} }));
  s = status(db);
  assert.deepEqual([s.declared, s.state, s.proposal], [{ mode: 'service', root: '.', entry: 'index.html' }, 'not_proposed', null]);
  assert.match(s.reason, /no proposal of the engine's for it was captured/);
  proposal(db, 'rejected');
  s = status(db);
  assert.deepEqual([s.state, s.proposal], ['not_proposed', 'pp_1']);
  assert.match(s.reason, /the engine's proposal pp_1 was rejected/);
  check(db, 'surety-static-serving', 'post_deploy_serving');
  configure(db, 'alpha', serviceConfig({ port: 8081 }));
  s = status(db);
  assert.deepEqual([s.declared, s.state, s.check], [null, 'present', 'surety-static-serving'], 'the project has the check: present, declared null');
});

test('unread when the facts cannot be read, never not_proposed; null with no configuration', (t) => {
  const db = store(t);
  assert.equal(servingCheckStatus(db, 'prj_1', 'env_alpha', 'node_service'), null, 'the spec-named environment, not configured: null');
  configure(db, 'alpha', serviceConfig({ serving: { root: 'public' } }));
  let s = status(db);
  assert.deepEqual([s.state, s.declared, s.holds_deployment], ['unread', PUBLIC, false], 'no effective protected version: unread');
  assert.match(s.reason, /^Whether the engine's file-serving check is in place could not be read \(the project has no effective protected version\)/);
  effectiveV1(db);
  db.prepare(`UPDATE environment_configs SET status = 'superseded' WHERE environment = ?`).run(envId(db));
  db.prepare(`INSERT INTO environment_configs (id, created_at, project, environment, version, content, config_identity, secret_digests, status, written_by, written_at) VALUES ('envc_bad', ?, 'prj_1', ?, 9, '{not json', 'i', '[]', 'current', 'human', ?)`).run(AT, envId(db), AT);
  db.prepare(`UPDATE environments SET current_config = 'envc_bad' WHERE id = ?`).run(envId(db));
  s = status(db);
  assert.deepEqual([s.state, s.declared], ['unread', null], 'its configuration not read: unread, never a default');
  assert.match(s.reason, /could not be read/);
  // The store itself failing: unread.
  const broken = { prepare: () => ({ get: () => { throw new Error('disk I/O error'); }, all: () => { throw new Error('disk I/O error'); } }) };
  s = servingCheckStatus(broken, 'prj_1', 'env_x', 'node_service');
  assert.deepEqual([s.state, s.holds_deployment], ['unread', false]);
  assert.match(s.reason, /disk I\/O error/);
});

test('holds_deployment: a static site in static mode, unless a required post_deploy_behavior check meets the requirement; never a service, a node service, or the design preview', (t) => {
  const db = store(t, { node: false });
  configure(db, 'alpha', staticConfig());
  effectiveV1(db);
  proposal(db, 'captured');
  const s = status(db, 'static_site');
  assert.deepEqual([s.declared, s.state, s.holds_deployment], [{ mode: 'static', root: '.', entry: 'index.html' }, 'proposed', true]);
  assert.match(s.reason, /a deployment request is refused until it is in place\.$/);
  assert.equal(status(db, 'unknown').holds_deployment, false, 'an output not known to be a static site');
  // The design preview's environment, configured by the engine: never held.
  db.prepare(`INSERT INTO environments (id, created_at, project, name, adapter, adapter_config_ref, verify_spec, prefix, current_config) VALUES ('env_dp', ?, 'prj_1', 'design-preview', 'local_service', 'environment_configs', '{}', 'surety-x-env_dp-', 'envc_dp')`).run(AT);
  db.prepare(`INSERT INTO environment_configs (id, created_at, project, environment, version, content, config_identity, secret_digests, status, written_by, written_at) VALUES ('envc_dp', ?, 'prj_1', 'env_dp', 1, ?, 'i', '[]', 'current', 'engine', ?)`).run(
    AT,
    JSON.stringify(staticConfig()),
    AT,
  );
  assert.equal(servingCheckStatus(db, 'prj_1', 'env_dp', 'static_site').holds_deployment, false);
  check(db, 'behaves', 'post_deploy_behavior');
  const b = status(db, 'static_site');
  assert.deepEqual([b.state, b.holds_deployment], ['proposed', false]);
  assert.match(b.reason, /it does not hold the deployment: the project's required post_deploy_behavior check meets the requirement\.$/);
  assert.equal(servingPendingBlock(b), null);
  assert.equal(servingPendingBlock(s).blocker.what, 'serving_check_pending');
});

test('the blocks: serving_check_pending names kind:post_deploy_serving and the decision; an unread holding check blocks as checks_unread; required_check_missing by the output kind', () => {
  const base = { kind: 'post_deploy_serving', declared: { mode: 'static', root: '.', entry: 'index.html' }, check: null, proposal: 'pp_1', decision: null, holds_deployment: true, reason: 'R.' };
  assert.deepEqual(servingPendingBlock({ ...base, state: 'awaiting_decision', decision: 'dec_1' }), {
    clause: "the engine's serving check (proposal pp_1), which the deployment needs, is not applied yet: it waits for your answer on decision dec_1",
    decision: 'dec_1',
    blocker: { what: 'serving_check_pending', subject: 'kind:post_deploy_serving' },
  });
  assert.deepEqual(servingPendingBlock({ ...base, state: 'unread', reason: 'Whether it is in place could not be read (x).' }), { clause: 'whether it is in place could not be read (x)', decision: null, blocker: { what: 'checks_unread', subject: null } });
  assert.equal(servingPendingBlock({ ...base, state: 'present' }), null);
  assert.deepEqual(servingPendingBlock({ ...base, state: 'not_proposed', proposal: null }).blocker, { what: 'required_check_missing', subject: 'kind:post_deploy_serving' }, 'neither present nor proposed: the required check missing (M616 (e) amended)');
  assert.equal(servingPendingBlock({ ...base, state: 'proposed', holds_deployment: false }), null, 'a service: a pending proposal adds no deployment gate');
  assert.deepEqual(requiredCheckBlock([], 'node_service'), { clause: MISSING, decision: null, blocker: { what: 'required_check_missing', subject: 'kind:post_deploy_behavior' } });
  assert.deepEqual(requiredCheckBlock(['post_deploy_serving'], 'node_service').blocker, { what: 'required_check_missing', subject: 'kind:post_deploy_behavior' }, 'a serving check never meets a service\'s requirement');
  assert.equal(requiredCheckBlock(['post_deploy_behavior'], 'node_service'), null);
  assert.deepEqual(requiredCheckBlock([], 'static_site').blocker, { what: 'required_check_missing', subject: 'kind:post_deploy_serving' });
  assert.equal(requiredCheckBlock(['post_deploy_serving'], 'static_site'), null);
});

// ---- the reads -----------------------------------------------------------------------------

test('the project read, GET …/environments and GET …/environments/:e serve the same serving_check beside the environment', (t) => {
  const db = store(t);
  configure(db, 'alpha', serviceConfig({ serving: { root: 'public' } }));
  configure(db, 'beta', serviceConfig({ targets: ['beta'], port: 8081 }));
  db.prepare(`INSERT INTO environments (id, created_at, project, name, adapter, adapter_config_ref, verify_spec) VALUES ('env_gamma', ?, 'prj_1', 'gamma', 'none', 'spec', '{}')`).run(AT);
  effectiveV1(db);
  check(db, 'behaves', 'post_deploy_behavior');
  proposal(db, 'classified');
  decision(db, 'dec_1', 'pp_1');
  const project = read(db).environments;
  const listed = readEnvironments(db, { project: 'prj_1' }).environments;
  assert.deepEqual(listed, project, 'the list serves the project read\'s entries');
  const by = Object.fromEntries(project.map((e) => [e.name, e.serving_check]));
  assert.deepEqual([by.alpha.state, by.alpha.decision, by.alpha.declared], ['awaiting_decision', 'dec_1', PUBLIC]);
  assert.deepEqual([by.beta.state, by.beta.declared], ['not_proposed', null]);
  assert.equal(by.gamma, null, 'no configuration: null');
  for (const e of project) assert.deepEqual(Object.keys(e).sort(), ['id', 'name', 'observed', 'serving_check', 'state']);
  const one = readOneEnvironment(db, { project: 'prj_1', environment: 'alpha' }).environment;
  assert.deepEqual(one.serving_check, by.alpha);
});

// ---- the readiness -----------------------------------------------------------------------

test('a service declaring serving with a required behavioural check: ready throughout the proposal (no deployment gate), the reason stating the check\'s state; deploy', async (t) => {
  const db = store(t);
  await nodeCandidate(t, db);
  configure(db, 'alpha', serviceConfig({ serving: { root: 'public' } }));
  effectiveV1(db);
  check(db, 'behaves', 'post_deploy_behavior');
  const HOST = 'The environment alpha can host this output (Node service) with local_service in service mode.';
  const steps = [
    ['proposed', () => proposal(db, 'captured')],
    ['awaiting_decision', () => decision(db, 'dec_1', 'pp_1')],
    ['approved', () => (db.prepare(`UPDATE decisions SET status = 'consumed'`).run(), setProposal(db, 'approved'))],
    ['present', () => (setProposal(db, 'applied'), check(db, 'surety-static-serving', 'post_deploy_serving'))],
  ];
  for (const [state, step] of steps) {
    step();
    const p = read(db);
    const r = p.build.deploy_readiness;
    const sc = p.environments.find((e) => e.name === 'alpha').serving_check;
    assert.equal(sc.state, state);
    assert.deepEqual([r.state, r.means, r.follows, r.blocker], ['ready', 'request_deployment', ['deployment', 'verification'], undefined], `${state}: ${JSON.stringify(r)}`);
    assert.equal(r.reason, `${HOST} ${sc.reason} Ready to request deployment, not verified and not open: the deployment and its verification follow before the preview opens.`);
    // An open decision ranks first in NOW (M616 (e)); otherwise the request.
    assert.equal(p.now.primary_action, state === 'awaiting_decision' ? 'answer_decision' : 'deploy');
  }
});

test('a service with no behavioural check: blocked, required_check_missing kind:post_deploy_behavior, no decision, no primary action, the reason and the status naming it; the serving check said beside', async (t) => {
  const db = store(t);
  await nodeCandidate(t, db);
  configure(db, 'alpha', serviceConfig({ serving: { root: 'public' } }));
  effectiveV1(db);
  proposal(db, 'captured');
  decision(db, 'dec_1', 'pp_1');
  const p = read(db);
  const sc = p.environments.find((e) => e.name === 'alpha').serving_check;
  assert.equal(sc.state, 'awaiting_decision');
  const { authoring, ...readiness } = p.build.deploy_readiness;
  assert.deepEqual(readiness, {
    state: 'blocked',
    reason: `The environment alpha can host this output (Node service) with local_service in service mode, but a deployment would be refused now: ${MISSING}. ${sc.reason}`,
    environment: 'alpha',
    decision: null,
    blocker: { what: 'required_check_missing', subject: 'kind:post_deploy_behavior' },
  });
  // DECISIONS item 43: the owner's request for it offered.
  assert.deepEqual([authoring.state, authoring.offer?.path], ['none', '/v1/projects/prj_1/environments/alpha/request-checks']);
  assert.equal(p.now.state, 'waiting_on_you', 'the open decision ranks first');
  db.prepare(`UPDATE decisions SET status = 'consumed'`).run();
  const q = read(db);
  assert.deepEqual(q.now, { state: 'build_complete', primary_action: null, reason: `${BUILD_DONE} It cannot be deployed to alpha yet: ${MISSING}.`, cause: null });
});

test('a static site in static mode, its serving check neither present nor proposed (rejected): blocked, required_check_missing kind:post_deploy_serving; with a required behavioural check, ready', (t) => {
  const db = store(t, { node: false });
  configure(db, 'alpha', staticConfig());
  effectiveV1(db);
  proposal(db, 'rejected');
  let p = read(db);
  assert.equal(p.environments.find((e) => e.name === 'alpha').serving_check.state, 'not_proposed');
  assert.deepEqual([p.build.deploy_readiness.state, p.build.deploy_readiness.blocker, p.build.deploy_readiness.decision], ['blocked', { what: 'required_check_missing', subject: 'kind:post_deploy_serving' }, null]);
  assert.match(p.build.deploy_readiness.reason, /proposes it again when the environment's static configuration is written/);
  assert.equal(p.build.deploy_readiness.follows, undefined, 'serving_check_proposal never follows ready');
  check(db, 'behaves', 'post_deploy_behavior');
  p = read(db);
  assert.deepEqual([p.build.deploy_readiness.state, p.build.deploy_readiness.follows], ['ready', ['deployment', 'verification']]);
});

test('the required check missing named before the candidate\'s checks running; with it in place, the checks running', async (t) => {
  const db = store(t);
  configure(db, 'alpha', serviceConfig());
  effectiveV1(db);
  await nodeCandidate(t, db);
  db.prepare(
    `INSERT INTO check_executions (id, created_at, project, "check", key, candidate, source_revision, protected_version, runner_class, execution_seq, "trigger", trigger_key, status, registered_at)
     VALUES ('cx_1', ?, 'prj_1', 'chk_smoke', 'smoke', 'cand_1', 'r', 'pv_1', 'direct', 1, '{"source":"protected_application"}', 'tk_1', 'running', ?)`,
  ).run(AT, AT);
  assert.deepEqual(read(db).build.deploy_readiness.blocker, { what: 'required_check_missing', subject: 'kind:post_deploy_behavior' });
  check(db, 'behaves', 'post_deploy_behavior');
  assert.deepEqual(read(db).build.deploy_readiness.blocker, { what: 'checks_running', subject: null });
});

// ---- on the kernel lane ----------------------------------------------------------------------

// The project's own checks list their inputs file by file (as
// service-serving-proposal's), a behavioural check among them.
const OWN = Object.freeze({ acc: { ...DEPLOY_DEFS.acc, inputs: [defPath('acc')] }, smoke: { ...DEPLOY_DEFS.smoke, inputs: [defPath('smoke')] }, behaves: { ...DEPLOY_DEFS.behaves, inputs: [defPath('behaves')] } });
const FILES = Object.freeze({ 'public/index.html': '<!doctype html><p>Lap Lab</p>\n' });

describe('the serving check beside a service environment on the kernel lane: proposed, its question open, approved, present', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    const ctx = await deployable(fx, { files: FILES, defs: OWN, config: { serving: { root: 'public' } }, name: 'alpha' });
    const reads = async () => {
      const project = (await fx.engine.get(`/v1/projects/${ctx.project}`)).body.project.environments.find((e) => e.name === 'alpha').serving_check;
      const listed = (await fx.engine.get(`/v1/projects/${ctx.project}/environments`)).body.environments.find((e) => e.name === 'alpha').serving_check;
      const one = (await fx.engine.get(`/v1/projects/${ctx.project}/environments/alpha`)).body.environment.serving_check;
      return { project, listed, one };
    };
    J.proposal = proposalsOf(fx.home, ctx.project).find((x) => x.proposed_by === 'engine');
    J.proposed = await reads();
    J.decision = await openDecision(fx, ctx.project, 'check_correction_tightening', J.proposal.id, { max: 8 });
    J.asked = await reads();
    await consume(fx, ctx.project, J.decision, 'approve');
    J.approvedStatus = proposalsOf(fx.home, ctx.project).find((x) => x.id === J.proposal.id).status;
    J.approved = await reads();
    await tickUntil(fx.engine, ctx.project, () => proposalsOf(fx.home, ctx.project).find((x) => x.id === J.proposal.id && x.status === 'applied'), { max: 8, what: 'the serving check applied' });
    J.present = await reads();
  });
  after(() => shared.cleanup());

  test('each read serves the same serving_check at every step', () => {
    for (const step of ['proposed', 'asked', 'approved', 'present']) {
      assert.deepEqual(J[step].listed, J[step].project, `${step}: the list and the project read`);
      assert.deepEqual(J[step].one, J[step].project, `${step}: the environment read and the project read`);
    }
  });

  test('proposed, then awaiting_decision naming the decision, then approved, then present naming the check; declared and holds_deployment throughout', () => {
    const p = J.proposed.project;
    assert.deepEqual([p.state, p.proposal, p.decision], ['proposed', J.proposal.id, null], JSON.stringify(p));
    assert.deepEqual([J.asked.project.state, J.asked.project.decision, J.asked.project.proposal], ['awaiting_decision', J.decision.id, J.proposal.id]);
    if (J.approvedStatus === 'approved') assert.deepEqual([J.approved.project.state, J.approved.project.decision], ['approved', null]);
    else assert.equal(J.approved.project.state, 'present', `applied at once (${J.approvedStatus})`);
    assert.deepEqual([J.present.project.state, J.present.project.check], ['present', 'surety-static-serving']);
    for (const step of ['proposed', 'asked', 'approved', 'present']) {
      assert.deepEqual(J[step].project.declared, PUBLIC, step);
      assert.equal(J[step].project.holds_deployment, false, step);
      assert.equal(J[step].project.kind, 'post_deploy_serving');
    }
  });
});
