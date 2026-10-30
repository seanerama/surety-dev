// Developer tests for the project read's automated checks and the NOW states
// the owner's finding of 2026-10-28 (Lap-Lab walkthrough) asks for: NOW said
// `idle` while checks of the current candidate advanced (49, then 52 of 71),
// and again once the build was complete under `alpha_deploy: manual` with no
// deployment. Now the read serves `checks` (the current candidate's checks,
// each key once at its latest execution) and NOW is `checking` while they
// are in flight with no run, `deploying` while a deployment is under way and
// `build_complete` when the build is done, continued with its readiness to
// deploy (deploy-readiness.test.mjs).
// A waiting decision keeps precedence; a store that cannot be read gives
// `unknown` and no counts. Against a scratch store, foreign keys off, the
// rows the minimum the projection reads (now-refused.test.mjs's harness).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { readProject, listProjects, NOW_STATES } = await import(join(dist, 'store', 'projections.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });

const AT = '2026-10-28T00:00:00.000Z';
const A = 'a'.repeat(40);

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  db.prepare(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T2', '/repo', 'main', 'spec_ready', 'registered', '{}')`,
  ).run(AT);
  db.prepare(`INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, roots) VALUES ('pv_1', ?, 'prj_1', 1, 'f1', 'initial', 'h', 'human', ?, 1, '[]')`).run(AT, AT);
  db.prepare(
    `INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, generation, active, status) VALUES ('plan_2', ?, 'prj_1', 2, ?, 'p2.json', 1, 1, 'published')`,
  ).run(AT, A);
  candidate(db, 'cand_0', 0, 'cand_1');
  candidate(db, 'cand_1', 1, null);
  return db;
}

function candidate(db, id, seq, supersededBy) {
  db.prepare(
    `INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress, superseded_by, held_work) VALUES (?, ?, 'prj_1', ?, ?, 'lin_1', ?, 'engine_cadence', 'developing', ?, '[]')`,
  ).run(id, AT, seq, A, AT, supersededBy);
}

let seq = 0;
// One execution of a check: its status, and a result row when recorded
// (`result`: 'passed', 'failed' or 'not_run').
function execution(db, { candidate = 'cand_1', key, status, result = null, trigger = { source: 'nomination', id: candidate, generation: 1 }, retryOf = null, version = 'pv_1', runnerClass = 'direct', deployment = null }) {
  seq += 1;
  const id = `cx_${seq}`;
  let resultId = null;
  if (status === 'recorded') {
    resultId = `cr_${seq}`;
    db.prepare(
      `INSERT INTO check_results (id, created_at, project, "check", candidate, source_revision, protected_version, runner_class, runner_id, execution_seq, execution_established, signaled, deadline_hit, exit_status, orphans, execution, not_run_reason)
       VALUES (?, ?, 'prj_1', ?, ?, ?, ?, 'direct', 'direct', ?, ?, 0, 0, ?, 0, ?, ?)`,
    ).run(resultId, AT, `chk_${key}`, candidate, A, version, seq, result === 'not_run' ? 0 : 1, result === 'passed' ? 0 : result === 'failed' ? 1 : null, id, result === 'not_run' ? 'environment_unbound' : null);
  }
  db.prepare(
    `INSERT INTO check_executions (id, created_at, project, "check", key, candidate, source_revision, protected_version, runner_class, execution_seq, "trigger", trigger_key, retry_of, status, result, not_run_reason, registered_at, deployment)
     VALUES (?, ?, 'prj_1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, AT, `chk_${key}`, key, candidate, A, version, runnerClass, seq, JSON.stringify(trigger), `tk_${seq}`, retryOf, status, resultId, result === 'not_run' ? 'environment_unbound' : null, AT, deployment === null ? null : JSON.stringify(deployment));
  return id;
}

const read = (db) => readProject(db, { project: 'prj_1' }).project;

// The Lap-Lab shape: 71 checks of phase 2, 49 recorded (46 passed, 2
// failed, 1 not run), one running, 21 queued.
function lapLab(db) {
  const phase = { source: 'phase', id: 'plan_2', generation: 1 };
  for (let i = 0; i < 71; i++) {
    const status = i < 49 ? 'recorded' : i === 49 ? 'running' : 'queued';
    const result = i < 46 ? 'passed' : i < 48 ? 'failed' : i === 48 ? 'not_run' : null;
    execution(db, { key: `k${i}`, status, result, trigger: phase });
  }
}

test('the NOW states include checking, deploying and build_complete, each in its place', () => {
  assert.deepEqual([...NOW_STATES], ['refused', 'waiting_on_you', 'running', 'checking', 'ready', 'deploying', 'build_complete', 'idle', 'unknown']);
});

test('checks advancing with no agent run: NOW is checking, with exact counts and the phase, never idle', (t) => {
  const db = store(t);
  assert.equal(read(db).checks, null, 'no current candidate with an execution: checks is null');
  assert.equal(read(db).checks_reason, null);
  assert.equal(read(db).now.state, 'idle');
  lapLab(db);
  const p = read(db);
  assert.deepEqual(p.checks, { candidate: 'cand_1', phase: 2, planned: 71, completed: 49, passed: 46, failed: 2, skipped: 1, interrupted: 0, queued: 21, running: 1, held: null });
  assert.equal(p.checks_reason, null);
  assert.deepEqual(p.now, { state: 'checking', primary_action: null, reason: 'Checking phase 2: 49 of 71 checks completed.', cause: null });
  // Three more recorded: 52 of 71.
  for (const id of ['cx_50', 'cx_51', 'cx_52']) db.prepare(`UPDATE check_executions SET status = 'recorded', result = 'cr_x' || id WHERE id = ?`).run(id);
  for (const id of ['cx_50', 'cx_51', 'cx_52']) {
    db.prepare(
      `INSERT INTO check_results (id, created_at, project, "check", candidate, source_revision, protected_version, runner_class, runner_id, execution_seq, execution_established, signaled, deadline_hit, exit_status, orphans, execution)
       VALUES ('cr_x' || ?, ?, 'prj_1', 'c', 'cand_1', ?, 'pv_1', 'direct', 'direct', ?, 1, 0, 0, 0, 0, ?)`,
    ).run(id, AT, A, 1000 + Number(id.slice(3)), id);
  }
  assert.equal(read(db).now.reason, 'Checking phase 2: 52 of 71 checks completed.');
  assert.deepEqual([read(db).checks.completed, read(db).checks.passed, read(db).checks.queued, read(db).checks.running], [52, 49, 19, 0]);
  // Every check recorded: nothing in flight, and the NOW is no longer checking.
  db.prepare(`UPDATE check_executions SET status = 'recorded' WHERE status <> 'recorded'`).run();
  assert.equal(read(db).now.state, 'idle');
  assert.equal(read(db).checks.planned, 71);
});

test('a candidate with no phase named: the reason has no phase clause', (t) => {
  const db = store(t);
  execution(db, { key: 'a', status: 'recorded', result: 'passed' });
  execution(db, { key: 'b', status: 'materializing' });
  const p = read(db);
  assert.equal(p.checks.phase, null);
  assert.deepEqual([p.now.state, p.now.reason], ['checking', 'Checking: 1 of 2 checks completed.']);
});

test('retries, recovery registrations, superseded candidates and cancelled executions add no planned check', (t) => {
  const db = store(t);
  // The superseded candidate's executions are not the current candidate's.
  execution(db, { candidate: 'cand_0', key: 'old', status: 'queued' });
  // A check interrupted and registered again as recovery: one check, the retry's status.
  const first = execution(db, { key: 'a', status: 'interrupted' });
  execution(db, { key: 'a', status: 'running', trigger: { source: 'recovery', id: 'cand_1', generation: 2 }, retryOf: first });
  // A check recorded failed, then registered again by a later trigger and passed.
  execution(db, { key: 'b', status: 'recorded', result: 'failed' });
  execution(db, { key: 'b', status: 'recorded', result: 'passed', trigger: { source: 'operator_request', id: 'req_1', generation: 1 } });
  // A recorded check whose later registration was cancelled: the recorded one stands.
  execution(db, { key: 'c', status: 'recorded', result: 'passed' });
  execution(db, { key: 'c', status: 'cancelled' });
  // A check whose only execution was cancelled is not planned.
  execution(db, { key: 'd', status: 'cancelled' });
  // A check interrupted with no retry: planned, not completed, named.
  execution(db, { key: 'e', status: 'interrupted' });
  // Quarantined: not settled, so running.
  execution(db, { key: 'f', status: 'quarantined' });
  const c = read(db).checks;
  assert.deepEqual(c, { candidate: 'cand_1', phase: null, planned: 5, completed: 2, passed: 2, failed: 0, skipped: 0, interrupted: 1, queued: 0, running: 2, held: null });
  assert.equal(read(db).now.reason, 'Checking: 2 of 5 checks completed.');
});

test('a new protected version: the candidate is counted under its latest registration, not twice', (t) => {
  const db = store(t);
  db.prepare(`INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, roots) VALUES ('pv_2', ?, 'prj_1', 2, 'f2', 'tightening', 'h', 'human', ?, 1, '[]')`).run(AT, AT);
  db.prepare(`UPDATE protected_versions SET superseded_by = 'pv_2' WHERE id = 'pv_1'`).run();
  execution(db, { key: 'a', status: 'recorded', result: 'passed' });
  execution(db, { key: 'gone', status: 'recorded', result: 'passed' });
  execution(db, { key: 'a', status: 'queued', version: 'pv_2', trigger: { source: 'protected_application', id: 'pp_1', generation: 1 } });
  execution(db, { key: 'new', status: 'queued', version: 'pv_2', trigger: { source: 'protected_application', id: 'pp_1', generation: 1 } });
  assert.deepEqual([read(db).checks.planned, read(db).checks.completed, read(db).checks.queued], [2, 0, 2]);
});

test('queued checks the runner is not qualified to admit: held named, beside the progress; no decision invented', (t) => {
  const db = store(t);
  db.prepare(
    `INSERT INTO host_qualifications (id, created_at, host_id, kernel, tool_versions, mechanism_fingerprint, checks, probes, bootstrap_exception, evidence, status, incarnation, qualified_at, check_runner)
     VALUES ('hq_1', ?, 'h', 'k', '{}', 'm', '[]', '[]', 0, '[]', 'active', 'inc_1', ?, ?)`,
  ).run(AT, AT, JSON.stringify({ profile_fingerprint: 'pf', self_test: [], qualified: true, profiles: [{ memory_max: 1 }] }));
  execution(db, { key: 'a', status: 'recorded', result: 'passed' });
  execution(db, { key: 'b', status: 'queued' });
  execution(db, { key: 'c', status: 'queued' });
  const p = read(db);
  assert.equal(p.checks.held.count, 2);
  assert.equal(p.checks.held.code, 'runner_unqualified');
  assert.equal(p.checks.held.decision, null, 'no decision of the store holds a queued execution');
  assert.match(p.checks.held.reason, /not qualified for the check profile/);
  assert.equal(p.now.state, 'checking');
  assert.equal(p.now.primary_action, null);
  assert.ok(p.now.reason.startsWith('Checking: 1 of 3 checks completed. 2 queued checks are held (runner_unqualified): The check runner is not qualified'), p.now.reason);
});

test('a waiting decision beside running checks: waiting_on_you first, and checks still served', (t) => {
  const db = store(t);
  lapLab(db);
  db.prepare(
    `INSERT INTO decisions (id, created_at, project, seq, kind, subject_type, subject_id, semantic_generation, scope, question, options, dependency_manifest, transition_schema_version, preview_hash, evidence, blocked_while_open, raised_at, status)
     VALUES ('dec_1', ?, 'prj_1', 1, 'blocker', 'work_item', 'wi_1', 1, 'project', 'q', '[]', '{}', 1, 'h', '[]', '{}', ?, 'open')`,
  ).run(AT, AT);
  const p = read(db);
  assert.deepEqual([p.now.state, p.now.primary_action], ['waiting_on_you', 'answer_decision']);
  assert.deepEqual([p.checks.completed, p.checks.planned, p.checks.queued, p.checks.running], [49, 71, 21, 1]);
  assert.equal(listProjects(db).projects[0].checks.planned, 71, 'the projects list serves the same');
});

function completeBuild(db) {
  db.prepare(`INSERT INTO roadmap_revisions (id, created_at, project, version, git_path, git_blob, phases, approved_by, approved_at) VALUES ('rm_1', ?, 'prj_1', 1, 'r', 'b', ?, 'human', ?)`).run(
    AT,
    JSON.stringify([{ number: 1 }, { number: 2 }]),
    AT,
  );
  db.prepare(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, generation, active, status, completed_at) VALUES ('plan_1', ?, 'prj_1', 1, ?, 'p1.json', 1, 1, 'completed', ?)`).run(AT, A, AT);
  db.prepare(`UPDATE phase_plans SET status = 'completed', completed_at = ? WHERE id = 'plan_2'`).run(AT);
  execution(db, { key: 'a', status: 'recorded', result: 'passed', trigger: { source: 'phase', id: 'plan_2', generation: 1 } });
  db.prepare(`INSERT INTO environments (id, created_at, project, name, adapter, adapter_config_ref, verify_spec, prefix, current_generation, deployment_generation) VALUES ('env_1', ?, 'prj_1', 'alpha', 'local_service', 'x', '{}', 'p', 1, 1)`).run(AT);
}

function deployOp(db, id, candidate, stage) {
  db.prepare(
    `INSERT INTO operations (id, created_at, project, seq, kind, target, subject, idempotency_key, semantic_generation, status, deadline_at, finalizer_inputs, orchestration_stage)
     VALUES (?, ?, 'prj_1', ?, 'deploy', '{"environment":"env_1"}', ?, ?, 1, 'in_progress', ?, '{}', ?)`,
  ).run(id, AT, ++seq, JSON.stringify({ candidate }), `k_${id}`, AT, stage);
}

test('a completed build under alpha_deploy manual with no deployment: build_complete, its readiness to deploy next; nothing claims more', (t) => {
  const db = store(t);
  completeBuild(db);
  const p = read(db);
  // The environment has no configuration (deploy-readiness.test.mjs has
  // every readiness state): implementation complete, not deployable yet.
  assert.deepEqual(p.now, {
    state: 'build_complete',
    primary_action: 'configure_environment',
    reason: 'The planned build and its automated gates are complete. Its environment alpha is not configured for hosting yet.',
    cause: null,
  });
  assert.doesNotMatch(p.now.reason, /visual|human|production|accept/i);
  assert.deepEqual([p.checks.completed, p.checks.planned], [1, 1]);
  // An older candidate's deployment running there leaves the current one undeployed.
  deployOp(db, 'op_old', 'cand_0', 'ended');
  db.prepare(`INSERT INTO environment_records (id, created_at, project, environment, observed, running, attempted) VALUES ('er_1', ?, 'prj_1', 'env_1', '{}', ?, ?)`).run(
    AT,
    JSON.stringify({ generation: 1 }),
    JSON.stringify({ operation: 'op_old', generation: 1, outcome: 'applied' }),
  );
  assert.equal(read(db).now.state, 'build_complete');
});

test('the same with a deployment under way: deploying, naming the operation, never idle', (t) => {
  const db = store(t);
  completeBuild(db);
  deployOp(db, 'op_1', 'cand_1', 'verification');
  assert.deepEqual(read(db).now, { state: 'deploying', primary_action: null, reason: 'Deployment operation op_1 of candidate cand_1 to alpha is under way (its verification stage).', cause: null });
});

test('a deployment in its verification stage, its post-deploy check queued: deploying outranks checking, and checks counts the check beside it', (t) => {
  const db = store(t);
  completeBuild(db);
  deployOp(db, 'op_1', 'cand_1', 'verification');
  const binding = { operation: 'op_1', attempt: 'att_1', deployment_generation: 1 };
  execution(db, { key: 'post', status: 'queued', trigger: { source: 'deployment_verification', id: 'round_1', generation: 1 }, deployment: binding });
  const p = read(db);
  assert.deepEqual(p.now, { state: 'deploying', primary_action: null, reason: 'Deployment operation op_1 of candidate cand_1 to alpha is under way (its verification stage).', cause: null });
  assert.deepEqual([p.checks.planned, p.checks.completed, p.checks.queued, p.checks.running], [2, 1, 1, 0], 'the phase check recorded, the post-deploy check queued');
  // Its operation ended, the check still running: checking.
  db.prepare(`UPDATE operations SET orchestration_stage = 'ended' WHERE id = 'op_1'`).run();
  db.prepare(`UPDATE check_executions SET status = 'running' WHERE key = 'post'`).run();
  assert.deepEqual([read(db).now.state, read(db).now.reason], ['checking', 'Checking phase 2: 1 of 2 checks completed.']);
});

test('dispatchable work beside a deployment under way: deploying, not ready', (t) => {
  const db = store(t);
  deployOp(db, 'op_1', 'cand_1', 'effect');
  db.prepare(`INSERT INTO environments (id, created_at, project, name, adapter, adapter_config_ref, verify_spec, prefix, current_generation, deployment_generation) VALUES ('env_1', ?, 'prj_1', 'alpha', 'local_service', 'x', '{}', 'p', 1, 1)`).run(AT);
  db.prepare(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
     VALUES ('wi_f', ?, 'prj_1', 2, 'fix', '{}', 'eligible', 'test', 'wi_f', 1, 0, 0, 0, 0)`,
  ).run(AT);
  assert.equal(read(db).now.state, 'deploying');
  db.prepare(`UPDATE operations SET orchestration_stage = 'ended' WHERE id = 'op_1'`).run();
  assert.equal(read(db).now.state, 'ready', 'the fixture is live: with the operation ended the work is ready');
});

test('deploy work requested and not yet intended: deploying, naming the work item and its hold', (t) => {
  const db = store(t);
  completeBuild(db);
  db.prepare(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold, blocker)
     VALUES ('wi_d', ?, 'prj_1', 1, 'deploy', '{"candidate":"cand_1","environment":"env_1"}', 'eligible', 'deployment_request', 'dauth_1', 1, 0, 0, 0, 0, '{"reason":"environment_busy"}')`,
  ).run(AT);
  assert.deepEqual([read(db).now.state, read(db).now.reason], ['deploying', 'The deployment of candidate cand_1 to alpha (work item wi_d, eligible) was requested and its operation has not started (held: environment_busy).']);
});

test('the candidate deployed and running, or alpha_deploy on_phase_complete: not build_complete, idle', (t) => {
  const db = store(t);
  completeBuild(db);
  deployOp(db, 'op_1', 'cand_1', 'ended');
  db.prepare(`INSERT INTO environment_records (id, created_at, project, environment, observed, running, attempted) VALUES ('er_1', ?, 'prj_1', 'env_1', '{}', ?, ?)`).run(
    AT,
    JSON.stringify({ generation: 1 }),
    JSON.stringify({ operation: 'op_1', generation: 1, outcome: 'applied' }),
  );
  assert.equal(read(db).now.state, 'idle', 'its deployment is current: idle');
  db.prepare(`UPDATE environment_records SET running = NULL`).run();
  assert.equal(read(db).now.state, 'build_complete', 'torn down: deploying it is next again');
  db.prepare(
    `INSERT INTO policy_revisions (id, created_at, project, revision, git_path, git_blob, changed_by, changed_at, diff_summary, widens_authority, committed, effective)
     VALUES ('pol_1', ?, 'prj_1', 1, '.surety/policy.json', 'b', 'human', ?, '', 0, 1, ?)`,
  ).run(AT, AT, JSON.stringify({ alpha_deploy: 'on_phase_complete' }));
  db.prepare(`UPDATE projects SET policy_revision = 'pol_1'`).run();
  assert.equal(read(db).now.state, 'idle', 'the policy deploys: the owner is not told to');
});

test('a running service whose candidate cannot be read is not taken as no deployment', (t) => {
  const db = store(t);
  completeBuild(db);
  db.prepare(`INSERT INTO environment_records (id, created_at, project, environment, observed, running, attempted) VALUES ('er_1', ?, 'prj_1', 'env_1', '{}', ?, NULL)`).run(AT, JSON.stringify({ generation: 1 }));
  assert.equal(read(db).now.state, 'idle');
});

test('a store that cannot be read: NOW unknown, checks null with the reason, never zeros', (t) => {
  const db = store(t);
  lapLab(db);
  db.prepare('DROP TABLE check_results').run();
  const p = read(db);
  assert.deepEqual([p.now.state, p.now.cause], ['unknown', 'store_error']);
  assert.match(p.now.reason, /automated checks could not be read/);
  assert.equal(p.checks, null);
  assert.match(p.checks_reason, /^The automated checks cannot be shown: the store could not be read \(.*check_results/);
});

test('a result of the candidate recorded after its registration, with no execution of its own, decides it as at the gate', (t) => {
  const db = store(t);
  execution(db, { key: 'a', status: 'queued' });
  execution(db, { key: 'b', status: 'queued' });
  // An observation of a past execution of `a` (SEAM.md §189), numbered after the registration.
  db.prepare(`INSERT INTO checks (id, created_at, project, key, protected_version, kind, required, gate_kinds, definition_path, definition_hash, runner_class) VALUES ('chk_a', ?, 'prj_1', 'a', 'pv_1', 'acceptance', 1, '[]', 'a', 'h', 'direct')`).run(AT);
  db.prepare(
    `INSERT INTO check_results (id, created_at, project, "check", candidate, source_revision, protected_version, runner_class, runner_id, execution_seq, execution_established, signaled, deadline_hit, exit_status, orphans)
     VALUES ('cr_obs', ?, 'prj_1', 'chk_a', 'cand_1', ?, 'pv_1', 'direct', 'fixture-runner', 5000, 1, 0, 0, 0, 0)`,
  ).run(AT, A);
  const c = read(db).checks;
  assert.deepEqual([c.planned, c.completed, c.passed, c.queued], [2, 1, 1, 1]);
  assert.equal(read(db).now.reason, 'Checking: 1 of 2 checks completed.');
});
