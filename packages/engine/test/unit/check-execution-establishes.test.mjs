// Developer tests for M3 slice 18, "what an execution establishes" (D3 §§2.5
// to 2.8, A.5; L1, L4; T05, T07, T09, T18, T19; SEAM.md §§203 to 211): the
// recovery registration and its budget; the not-run reasons decided at
// admission and the self-test's hold on admission; `running` from the
// recorded `started`; a quarantine's domain; EVIDENCE_MISSING for an
// established result that names no output record; NOW's `check_unrunnable`;
// the re-grant of a check lease; recording from the init's reports after a
// restart; the self-test's structural reading of B01 and its judgment; the
// slice's switches. Against a scratch store with the engine's migrations,
// and pure functions.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { evaluateGate } = await import(join(dist, 'store', 'transitions', 'gates.js'));
const checks = await import(join(dist, 'store', 'transitions', 'checks.js'));
const { readProject } = await import(join(dist, 'store', 'projections.js'));
const { setCheckLimits } = await import(join(dist, 'checks', 'limits.js'));
const { fromReports, cwdProblem, resolveProgram, decideResult } = await import(join(dist, 'checks', 'run.js'));
const { stateOf, parseMountinfo, mountAt, immutableProblem, programIn } = await import(join(dist, 'checks', 'selftest.js'));
const { SELF_TEST_CASES } = await import(join(dist, 'checks', 'selftest-cases.js'));
const { setHarnessSwitches } = await import(join(dist, 'testing', 'seam.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });

const AT = '2026-10-08T00:00:00.000Z';
const A = 'a'.repeat(40);
const FP = 'f'.repeat(64);

function store(t, { definition = '{}', runnerClass = 'direct' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.pragma('foreign_keys = ON');
  migrate(db, join(root, 'migrations'));
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  run(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
  );
  run(
    `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots, fingerprint_scheme)
     VALUES ('pv_1', ?, 'prj_1', 1, ?, 'initial', 'human', 'human', ?, 1, ?, '[".surety/checks/"]', 'manifest')`,
    AT,
    FP,
    AT,
    AT,
  );
  run(`INSERT INTO lineages (id, created_at, project, branch, started_from_candidate, open) VALUES ('lin_1', ?, 'prj_1', 'main', NULL, 0)`, AT);
  run(
    `INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, nominated_protected_version, progress)
     VALUES ('cand_1', ?, 'prj_1', 1, ?, 'lin_1', ?, 'builder_request', 'pv_1', 'developing')`,
    AT,
    A,
    AT,
  );
  run(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path) VALUES ('plan_1', ?, 'prj_1', 1, ?, 'plan.json')`, AT, A);
  run(`INSERT INTO stages (id, created_at, project, phase_plan, number, goal, modules, requirement_ids, implements, status) VALUES ('stage_1', ?, 'prj_1', 'plan_1', 1, 'g', '[]', '[]', '[]', 'planned')`, AT);
  run(
    `INSERT INTO checks (id, created_at, project, key, protected_version, kind, required, gate_kinds, definition_path, definition_hash, runner_class, definition)
     VALUES ('chk_1', ?, 'prj_1', 'sm', 'pv_1', 'smoke', 1, '["stage"]', '.surety/checks/defs/sm.json', 'h', ?, ?)`,
    AT,
    runnerClass,
    definition,
  );
  return { db, run };
}

function register(db, { id, source = 'nomination', status = 'queued', runnerClass = 'direct' }) {
  return transact(db, ENGINE_ACTOR, (tx) => {
    const seq = checks.nextExecutionSeq(tx, 'prj_1');
    const trigger = { source, id: `t_${id}`, generation: 1 };
    tx.db
      .prepare(
        `INSERT INTO check_executions (id, created_at, project, "check", key, candidate, source_revision, protected_version, runner_class, execution_seq, "trigger", trigger_key, status, registered_at)
         VALUES (?, ?, 'prj_1', 'chk_1', 'sm', 'cand_1', ?, 'pv_1', ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, AT, A, runnerClass, seq, JSON.stringify(trigger), `cand_1|${source}|t_${id}|1|sm`, status, AT);
    return seq;
  });
}

const step = (db, execution, to, result = null, output = null) => transact(db, ENGINE_ACTOR, (tx) => checks.scriptExecutionStep(tx, { execution, to, result, output, runner_id: 'test_fixture' }));
const rows = (db) => db.prepare(`SELECT * FROM check_executions ORDER BY execution_seq`).all();
const events = (db, type) => db.prepare('SELECT * FROM events WHERE type = ? ORDER BY seq').all(type);

// An active host qualification, with `check_runner` as given.
function qualification(db, checkRunner) {
  db.pragma('foreign_keys = OFF');
  db.prepare(
    `INSERT INTO host_qualifications (id, created_at, host_id, kernel, tool_versions, mechanism_fingerprint, checks, probes, bootstrap_exception, evidence, status, incarnation, qualified_at, check_runner)
     VALUES ('hq_1', ?, 'h', 'k', '{}', 'm', '[]', '[]', 0, 'rec_x', 'active', 'inc_x', ?, ?)`,
  ).run(AT, AT, checkRunner === null ? null : JSON.stringify(checkRunner));
  db.pragma('foreign_keys = ON');
}
const QUALIFIED = { profile_fingerprint: FP, self_test: [], qualified: true };
const admit = (db, extra = {}) => transact(db, ENGINE_ACTOR, (tx) => checks.admitExecution(tx, { project: 'prj_1', incarnation: 'inc_x', scope: '/nowhere', hostId: 'h', ...extra }));

// ---- recovery registrations (D3 §2.7; T05; SEAM.md §204) ---------------------------------

test('an interrupted execution is registered again as the next generation of its original trigger, at most check_infra_retries_max times', (t) => {
  setCheckLimits({ check_infra_retries_max: 2 });
  const { db } = store(t);
  register(db, { id: 'cx_0' });
  step(db, 'cx_0', 'materializing');
  step(db, 'cx_0', 'interrupted');
  let all = rows(db);
  assert.equal(all.length, 2);
  const first = all[1];
  assert.deepEqual([JSON.parse(first.trigger), first.retry_of, first.infra_retries, first.status], [{ source: 'recovery', id: 't_cx_0', generation: 2 }, 'cx_0', 1, 'queued']);
  // Registered in the transaction that ended the execution it retries.
  const reg = events(db, 'check.registered').find((e) => JSON.parse(e.subject).check_execution === first.id);
  const intr = events(db, 'check.interrupted').find((e) => JSON.parse(e.subject).check_execution === 'cx_0');
  assert.equal(reg.tx, intr.tx);
  step(db, first.id, 'materializing');
  step(db, first.id, 'interrupted');
  all = rows(db);
  const second = all[2];
  assert.deepEqual([JSON.parse(second.trigger).generation, second.retry_of, second.infra_retries], [3, first.id, 2]);
  step(db, second.id, 'materializing');
  step(db, second.id, 'interrupted');
  assert.equal(rows(db).length, 3, 'the budget of 2 is spent: nothing more');
});

test('a genuine failure, a cancellation and a superseded candidate are never retried; materialization_failed is', (t) => {
  setCheckLimits({ check_infra_retries_max: 2 });
  const { db } = store(t);
  register(db, { id: 'cx_f' });
  for (const to of ['materializing', 'running', 'collecting']) step(db, 'cx_f', to);
  step(db, 'cx_f', 'recorded', { exit_status: 1, signaled: false, deadline_hit: false, orphans: false });
  register(db, { id: 'cx_c' });
  step(db, 'cx_c', 'cancelled');
  assert.equal(rows(db).length, 2);
  register(db, { id: 'cx_m' });
  transact(db, ENGINE_ACTOR, (tx) => {
    tx.db.prepare(`UPDATE check_executions SET status = 'materializing' WHERE id = 'cx_m'`).run();
    checks.recordExecutionResult(tx, { execution: 'cx_m', established: false, exit_status: null, signaled: false, deadline_hit: false, orphans: false, not_run_reason: 'materialization_failed', output: null, output_dropped_bytes: null });
  });
  const retry = rows(db).find((x) => x.retry_of === 'cx_m');
  assert.ok(retry, 'materialization_failed is registered again');
  db.pragma('foreign_keys = OFF');
  db.prepare(`UPDATE candidates SET superseded_by = 'cand_9' WHERE id = 'cand_1'`).run();
  db.pragma('foreign_keys = ON');
  register(db, { id: 'cx_s' });
  step(db, 'cx_s', 'materializing');
  step(db, 'cx_s', 'interrupted');
  assert.equal(rows(db).filter((x) => x.retry_of === 'cx_s').length, 0, 'a superseded candidate is owed no retry');
});

// ---- not-run reasons at admission (D3 §§2.7, 2.8, 5 X3; SEAM.md §§208, 209, 211) ----------

test('with no active host qualification a queued execution is recorded isolation_unqualified, with no domain', (t) => {
  const { db } = store(t);
  register(db, { id: 'cx_1' });
  assert.equal(admit(db), null);
  const [x] = rows(db);
  assert.deepEqual([x.status, x.not_run_reason, x.domain], ['recorded', 'isolation_unqualified', null]);
  const r = db.prepare('SELECT * FROM check_results WHERE id = ?').get(x.result);
  assert.deepEqual([r.execution_established, r.not_run_reason, r.exit_status], [0, 'isolation_unqualified', null]);
});

test('check_runner null or unqualified: runner_unqualified; while the self-test runs, direct stays queued; other classes never wait', (t) => {
  const { db } = store(t);
  qualification(db, null);
  register(db, { id: 'cx_d' });
  register(db, { id: 'cx_box', runnerClass: 'container' });
  assert.equal(admit(db, { selfTestRunning: true }), null);
  let [d, box] = rows(db);
  assert.equal(d.status, 'queued', 'direct waits for the self-test');
  assert.deepEqual([box.status, box.not_run_reason, box.runner_qualification], ['recorded', 'runner_unqualified', 'hq_1']);
  admit(db);
  [d] = rows(db);
  assert.deepEqual([d.status, d.not_run_reason], ['recorded', 'runner_unqualified']);
});

test('a qualified runner admits direct; an environment-requiring definition is environment_unbound', (t) => {
  const { db } = store(t, { definition: JSON.stringify({ requires: ['environment', 'artifact_digest'] }) });
  qualification(db, QUALIFIED);
  register(db, { id: 'cx_e' });
  assert.equal(admit(db), null);
  const [x] = rows(db);
  assert.deepEqual([x.status, x.not_run_reason, x.environment, x.artifact_digest], ['recorded', 'environment_unbound', null, null]);
});

// ---- running from the recorded started; the domain of a quarantine ---------------------------

test('an execution is running from the transaction that records the init\'s started report; a quarantine quarantines its domain', (t) => {
  const { db } = store(t);
  register(db, { id: 'cx_1' });
  transact(db, ENGINE_ACTOR, (tx) => {
    tx.db
      .prepare(`INSERT INTO execution_domains (id, created_at, project, run, invocation, check_execution, status, profile, cgroup_path, launch_state) VALUES ('dom_1', ?, 'prj_1', NULL, NULL, 'cx_1', 'allocated', 'check', '/x', 'authorizable')`)
      .run(AT);
    tx.db.prepare(`UPDATE check_executions SET status = 'materializing', domain = 'dom_1' WHERE id = 'cx_1'`).run();
    checks.markLaunched(tx, { execution: 'cx_1', domain: 'dom_1' });
  });
  assert.equal(rows(db)[0].status, 'materializing', 'not running at authorization');
  transact(db, ENGINE_ACTOR, (tx) => checks.recordInitReport(tx, { execution: 'cx_1', kind: 'started', detail: { pid: 2 } }));
  assert.equal(rows(db)[0].status, 'running');
  transact(db, ENGINE_ACTOR, (tx) => checks.quarantineExecution(tx, { execution: 'cx_1', why: 'unknown' }));
  assert.equal(db.prepare(`SELECT status FROM execution_domains WHERE id = 'dom_1'`).get().status, 'quarantined');
  assert.equal(events(db, 'domain.quarantined').length, 1);
});

// ---- evidence presence (D3 §2.6; T09; SEAM.md §207) ----------------------------------------

test('an established execution result naming no output record is EVIDENCE_MISSING, naming the result', (t) => {
  const { db } = store(t);
  register(db, { id: 'cx_1' });
  for (const to of ['materializing', 'running', 'collecting']) step(db, 'cx_1', to);
  const { check_result } = step(db, 'cx_1', 'recorded', { exit_status: 0, signaled: false, deadline_hit: false, orphans: false }, null);
  const evaluation = transact(db, ENGINE_ACTOR, (tx) => evaluateGate(tx, { project: 'prj_1', candidate: 'cand_1', kind: 'stage', stage: 'stage_1', headFingerprint: FP, head: A })).evaluation;
  const reason = evaluation.reasons.find((r) => r.code === 'EVIDENCE_MISSING');
  assert.ok(reason && reason.subjects.includes(check_result.id), JSON.stringify(evaluation.reasons));
});

test('a refused check output raises the Critical finding and evidence.secret_refused naming the execution', (t) => {
  const { db } = store(t);
  register(db, { id: 'cx_1' });
  transact(db, ENGINE_ACTOR, (tx) => checks.checkOutputRefused(tx, { execution: 'cx_1', by: 'secret:x' }));
  const [e] = events(db, 'evidence.secret_refused');
  assert.equal(JSON.parse(e.subject).check_execution, 'cx_1');
  assert.equal(JSON.parse(e.payload).what, 'check_output');
  const f = db.prepare('SELECT * FROM findings').get();
  assert.deepEqual([f.category, f.effective_severity, f.status], ['security', 'critical', 'open']);
});

// ---- NOW (SEAM.md §209) -------------------------------------------------------------------

test("NOW is refused with cause check_unrunnable while a check's latest execution has a host-level reason", (t) => {
  const { db } = store(t);
  register(db, { id: 'cx_1' });
  admit(db); // isolation_unqualified
  let now = readProject(db, { project: 'prj_1', maxConcurrentRuns: 1 }).project.now;
  assert.deepEqual([now.state, now.cause], ['refused', 'check_unrunnable']);
  register(db, { id: 'cx_2' }); // a later registration of the same check
  now = readProject(db, { project: 'prj_1', maxConcurrentRuns: 1 }).project.now;
  assert.notEqual(now.cause, 'check_unrunnable');
});

// ---- the check lease's re-grant (D3 §2.5; D2 §3.5; SEAM.md §205) -----------------------------

test('a check lease is re-granted on the same generation only for a running execution launched under its binding', (t) => {
  const { db } = store(t);
  register(db, { id: 'cx_1' });
  db.pragma('foreign_keys = OFF');
  db.prepare(
    `INSERT INTO execution_domains (id, created_at, project, run, invocation, check_execution, status, profile, cgroup_path, launch_state, launch_binding, launch_authorized_at)
     VALUES ('dom_1', ?, 'prj_1', NULL, NULL, 'cx_1', 'launched', 'check', '/x', 'authorized', ?, ?)`,
  ).run(AT, JSON.stringify({ check_execution: 'cx_1', incarnation: 'inc_x', lease_generation: 1 }), AT);
  db.prepare(
    `INSERT INTO leases (id, created_at, resource_kind, resource_id, owner_incarnation, generation, acquired_at, renewed_at, expires_at, closing, cleanup_authority) VALUES ('lease_1', ?, 'check', 'cx_1', 'inc_x', 1, ?, ?, ?, 0, 0)`,
  ).run(AT, AT, AT, AT);
  db.pragma('foreign_keys = ON');
  db.prepare(`UPDATE check_executions SET status = 'running', domain = 'dom_1', lease = 'lease_1' WHERE id = 'cx_1'`).run();
  const challenge = { nonce: 'ab'.repeat(8), sent_at: AT, answered_at: AT, backend_state: 'running' };
  assert.equal(transact(db, ENGINE_ACTOR, (tx) => checks.regrantCheckLease(tx, { execution: 'cx_1', generation: 2, incarnation: 'inc_x', challenge })), null, 'another generation');
  assert.equal(transact(db, ENGINE_ACTOR, (tx) => checks.regrantCheckLease(tx, { execution: 'cx_1', generation: 1, incarnation: 'inc_y', challenge })), null, 'another incarnation');
  assert.notEqual(transact(db, ENGINE_ACTOR, (tx) => checks.regrantCheckLease(tx, { execution: 'cx_1', generation: 1, incarnation: 'inc_x', challenge })), null);
  const [e] = events(db, 'check.lease_regranted');
  assert.equal(JSON.parse(e.subject).check_execution, 'cx_1');
  assert.deepEqual([JSON.parse(e.payload).generation, JSON.parse(e.payload).challenge.nonce], [1, challenge.nonce]);
  assert.equal(db.prepare(`SELECT generation FROM leases WHERE id = 'lease_1'`).get().generation, 1);
});

// ---- recording from the init's reports (D3 §2.6 "Interrupted"; SEAM.md §205) ----------------

test('after a restart, an execution whose exit report was recorded is recorded from the reports; any other is interrupted', () => {
  const started = { kind: 'started', detail: { pid: 2 } };
  const exit0 = { kind: 'exit', detail: { code: 0, signal: null, cancelled: false, cause: null } };
  const none = { kind: 'orphans', detail: { count: 0 } };
  let d = fromReports({ reports: [started, none, exit0], authorized: true });
  assert.equal(d.kind, 'record');
  assert.deepEqual([d.fields.established, d.fields.exit_status, d.fields.orphans, d.fields.signaled], [true, 0, false, false]);
  d = fromReports({ reports: [started], authorized: true });
  assert.equal(d.kind, 'interrupt', 'started but no exit report: never recorded as run or not run');
  d = fromReports({ reports: [started, { kind: 'exit', detail: { code: 0, signal: null, cancelled: true, cause: 'deadline' } }], authorized: true });
  assert.deepEqual([d.fields.exit_status, d.fields.deadline_hit, d.fields.signaled, d.fields.orphans], [null, true, true, null], 'an exit after the engine began cancelling is never the exit status');
  d = fromReports({ reports: [{ kind: 'exec_failed', detail: { errno: 'ENOENT' } }], authorized: true });
  assert.deepEqual([d.kind, d.fields.not_run_reason], ['record', 'exec_failed']);
});

// ---- the definition's cwd and the program (D3 §2.7; SEAM.md §209) --------------------------

test('a cwd that is no directory of the check tree is definition_invalid; the program is resolved with its hash', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src', 'pkg'), { recursive: true });
  mkdirSync(join(dir, 'proj', 'tests'), { recursive: true });
  writeFileSync(join(dir, 'src', 'file'), 'x');
  const roots = [join(dir, 'src'), join(dir, 'proj')];
  assert.equal(cwdProblem(roots, '.'), null);
  assert.equal(cwdProblem(roots, 'pkg'), null);
  assert.equal(cwdProblem(roots, 'tests'), null, 'a directory of the input projection');
  assert.match(cwdProblem(roots, 'not-in-the-tree'), /not a directory/);
  assert.match(cwdProblem(roots, 'file'), /not a directory/);
  assert.match(cwdProblem(roots, '../x'), /plain relative/);
  const governed = { check_commands: { sh: { path: '/bin/sh' }, gone: { path: join(dir, 'none') }, pinned: { path: '/bin/sh', sha256: '0'.repeat(64) } } };
  assert.equal(resolveProgram(governed, { command: ['sh'] }).problem, null);
  assert.match(resolveProgram(governed, { command: ['gone'] }).problem, /cannot be read/);
  assert.match(resolveProgram(governed, { command: ['pinned'] }).problem, /pinned/);
  assert.match(resolveProgram(governed, { command: ['nope'] }).problem, /not in check_commands/);
});

// ---- the self-test's judgment and B01's structural reading (E95; SEAM.md §§198, 208) --------

test("a result's state: passed only established, exit 0, unsignaled, no deadline and orphans known absent", () => {
  const base = { established: true, exit_status: 0, signaled: false, deadline_hit: false, orphans: false };
  assert.equal(stateOf(base), 'passed');
  assert.equal(stateOf({ ...base, orphans: null }), 'failed', 'orphans unknown never passes');
  assert.equal(stateOf({ ...base, orphans: true }), 'failed');
  assert.equal(stateOf({ ...base, exit_status: 1 }), 'failed');
  assert.equal(stateOf({ ...base, established: false }), 'skipped');
  // TERM handled with exit 0 after the engine's cancellation is never passed (T07).
  const d = decideResult({ leaseLost: false, authorized: true, started: true, execFailed: false, report: { code: 0, signal: null }, cancelAt: 10, cancelCause: 'deadline', reportAt: 20, orphans: false });
  assert.equal(stateOf(d.fields), 'failed');
});

const line = (id, parent, point, opts, fstype, superopts) => `${id} ${parent} 0:1 / ${point} ${opts} - ${fstype} src ${superopts}`;

test('B01 structurally: every input and ancestor on a read-only mount below the workspace, with no upper layer', () => {
  const ok = parseMountinfo([
    line('1', '0', '/', 'rw', 'tmpfs', 'rw'),
    line('2', '1', '/surety/workspace', 'rw,nosuid', 'overlay', 'rw,lowerdir=/a,upperdir=/b,workdir=/c'),
    line('3', '2', '/surety/workspace/inputs', 'ro,nosuid', 'tmpfs', 'rw'),
    line('4', '2', '/surety/workspace/app', 'ro', 'overlay', 'ro,lowerdir=/x:/y'),
  ]);
  assert.equal(mountAt(ok, '/surety/workspace/inputs/deep/input.txt').point, '/surety/workspace/inputs');
  assert.equal(immutableProblem(ok, 'inputs/deep/input.txt'), null);
  assert.equal(immutableProblem(ok, 'app/expect/value.txt'), null);
  assert.match(immutableProblem(ok, 'lib/source.txt'), /not on a mount of its own/);
  const writable = parseMountinfo([line('1', '0', '/', 'rw', 'tmpfs', 'rw'), line('3', '1', '/surety/workspace/inputs', 'rw', 'tmpfs', 'rw')]);
  assert.match(immutableProblem(writable, 'inputs/x'), /not read-only/);
  const upper = parseMountinfo([line('1', '0', '/', 'rw', 'tmpfs', 'rw'), line('3', '1', '/surety/workspace/app', 'ro', 'overlay', 'ro,upperdir=/u')]);
  assert.match(immutableProblem(upper, 'app/x'), /upper layer/);
  // Of mounts stacked at one point, the top one.
  const stacked = parseMountinfo([line('3', '1', '/surety/workspace/in', 'rw', 'tmpfs', 'rw'), line('5', '3', '/surety/workspace/in', 'ro', 'tmpfs', 'rw')]);
  assert.equal(mountAt(stacked, '/surety/workspace/in/a').id, '5');
});

test("the self-test's program lookup reads nothing outside a cgroup it can list", () => {
  assert.equal(programIn('/nonexistent-cgroup', ['sleep']), null);
});

// ---- the slice's switches (SEAM.md §§208, 212, 214) -----------------------------------------

test('the self-test switches: a closed case list, results failed or not_exercised, labels and limits checked', () => {
  const base = { templateVersions: [], hostId: null, mechanismVariant: null, collectBounds: null };
  assert.deepEqual([...SELF_TEST_CASES], ['exit_zero', 'exit_nonzero', 'prints_passed_exits_nonzero', 'foreign_signal', 'deadline', 'term_handled_after_cancel', 'missing_program', 'input_immutable', 'orphan_stdout_closed', 'egress']);
  assert.equal(setHarnessSwitches({ ...base, runnerSelfTest: 'run', selfTestCases: ['exit_zero=failed', 'egress=not_exercised'] }), null);
  assert.match(setHarnessSwitches({ ...base, runnerSelfTest: 'yes' }), /takes run/);
  assert.match(setHarnessSwitches({ ...base, selfTestCases: ['nope=failed'] }), /takes <case>/);
  assert.match(setHarnessSwitches({ ...base, selfTestCases: ['exit_zero=passed'] }), /takes <case>/);
  assert.match(setHarnessSwitches({ ...base, checkProfileVariant: 'a b' }), /label/);
  assert.equal(setHarnessSwitches({ ...base, checkDomainLimits: 'pids_max=64,memory_max=67108864' }), null);
  assert.match(setHarnessSwitches({ ...base, checkDomainLimits: 'pids_max=0' }), /positive/);
  assert.match(setHarnessSwitches({ ...base, checkDomainLimits: 'cpu=1' }), /pids_max/);
});
