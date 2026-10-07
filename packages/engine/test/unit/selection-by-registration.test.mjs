// Developer tests for M3 slice 16, "which result decides" (D3 §§2.5, 2.6,
// 2.11, §5 X1; L7, B03, N02, N03, Q9; SEAM.md §§189 to 193): selection by
// registration with no fallback; history beside the deciding result; the
// one sequence and the disposition watermark; cancellation on supersession;
// the scripted check boundary's steps; the refusal of a superseded
// candidate; the gate's ref reads judged and reconciled. Against a scratch
// store with the engine's migrations.

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
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { checkState, evaluateGate, observeGateRefs, gateRefRegistry } = await import(join(dist, 'store', 'transitions', 'gates.js'));
const { cancelSuperseded, executionSeqHigh, nextExecutionSeq, scriptExecutionStep } = await import(join(dist, 'store', 'transitions', 'checks.js'));
const { getCandidate } = await import(join(dist, 'store', 'transitions', 'evidence.js'));
const { effectiveVersion } = await import(join(dist, 'store', 'transitions', 'protected.js'));
const { judgeRefs, sameGeneration } = await import(join(dist, 'gates', 'refs.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });

const AT = '2026-10-07T00:00:00.000Z';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const FP = 'f'.repeat(64);

function store(t) {
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
    `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots)
     VALUES ('pv_1', ?, 'prj_1', 1, ?, 'initial', 'human', 'human', ?, 1, ?, '[".surety/checks/"]')`,
    AT,
    FP,
    AT,
    AT,
  );
  run(`INSERT INTO lineages (id, created_at, project, branch, started_from_candidate, open) VALUES ('lin_1', ?, 'prj_1', 'main', NULL, 0)`, AT);
  for (const [id, seq, rev] of [
    ['cand_1', 1, A],
    ['cand_2', 2, B],
  ]) {
    run(
      `INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, nominated_protected_version, progress)
       VALUES (?, ?, 'prj_1', ?, ?, 'lin_1', ?, 'builder_request', 'pv_1', 'developing')`,
      id,
      AT,
      seq,
      rev,
      AT,
    );
  }
  for (const [id, ref, kind, oid, immutable] of [
    ['ref_main', 'refs/heads/main', 'integration', B, 0],
    ['ref_c1', 'refs/surety/cand/1', 'nomination', A, 1],
    ['ref_c2', 'refs/surety/cand/2', 'nomination', B, 1],
  ]) {
    run('INSERT INTO ref_registry (id, created_at, project, ref, kind, expected_oid, immutable) VALUES (?, ?, ?, ?, ?, ?, ?)', id, AT, 'prj_1', ref, kind, oid, immutable);
  }
  run(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path) VALUES ('plan_1', ?, 'prj_1', 1, ?, 'plan.json')`, AT, A);
  run(`INSERT INTO stages (id, created_at, project, phase_plan, number, goal, modules, requirement_ids, implements, status) VALUES ('stage_1', ?, 'prj_1', 'plan_1', 1, 'g', '[]', '[]', '[]', 'planned')`, AT);
  run(
    `INSERT INTO checks (id, created_at, project, key, protected_version, kind, required, gate_kinds, definition_path, definition_hash, runner_class)
     VALUES ('chk_1', ?, 'prj_1', 'login', 'pv_1', 'smoke', 1, '["stage","alpha_authorize"]', '.surety/checks/defs/login.json', 'h', 'direct')`,
    AT,
  );
  return { db, run };
}

// A result row, as a fixture or an execution records it.
function result(db, { id, candidate = 'cand_2', revision = B, seq, exit = 0, execution = null }) {
  db.prepare(
    `INSERT INTO check_results (id, created_at, project, "check", candidate, source_revision, protected_version, runner_class, runner_id, execution_seq,
       execution_established, signaled, deadline_hit, exit_status, execution)
     VALUES (?, ?, 'prj_1', 'chk_1', ?, ?, 'pv_1', 'direct', 'r', ?, 1, 0, 0, ?, ?)`,
  ).run(id, AT, candidate, revision, seq, exit, execution);
}

// A registration of `login` for a candidate, through the engine's sequence.
function register(db, { id, candidate = 'cand_2', revision = B, source = 'operator_request', status = 'queued' }) {
  return transact(db, ENGINE_ACTOR, (tx) => {
    const seq = nextExecutionSeq(tx, 'prj_1');
    const trigger = { source, id: `t_${id}`, generation: 1 };
    tx.db
      .prepare(
        `INSERT INTO check_executions (id, created_at, project, "check", key, candidate, source_revision, protected_version, runner_class, execution_seq, "trigger", trigger_key, status, registered_at)
         VALUES (?, ?, 'prj_1', 'chk_1', 'login', ?, ?, 'pv_1', 'direct', ?, ?, ?, ?, ?)`,
      )
      .run(id, AT, candidate, revision, seq, JSON.stringify(trigger), `${candidate}|${id}`, status, AT);
    return seq;
  });
}

const step = (db, execution, to, result = null) => transact(db, ENGINE_ACTOR, (tx) => scriptExecutionStep(tx, { execution, to, result, output: null, runner_id: 'test_fixture' }));
const recordExit = (db, execution, exit) => {
  for (const to of ['materializing', 'running', 'collecting']) step(db, execution, to);
  return step(db, execution, 'recorded', { exit_status: exit, signaled: false, deadline_hit: false, orphans: false });
};

const stateOf = (db, candidate = 'cand_2') => {
  const c = db.prepare('SELECT * FROM checks WHERE id = ?').get('chk_1');
  return checkState(db, 'prj_1', c, { candidate: getCandidate(db, candidate), effective: effectiveVersion(db, 'prj_1'), environment: null, artifact: null });
};

const reasonCodes = (e) => e.reasons.map((r) => r.code);
const gate = (db, candidate, extra = {}) =>
  transact(db, ENGINE_ACTOR, (tx) => evaluateGate(tx, { project: 'prj_1', candidate, kind: 'stage', stage: 'stage_1', headFingerprint: FP, head: B, ...extra })).evaluation;
const READ_ALL = (candidate) => [
  { ref: 'refs/heads/main', read: 'value', oid: B },
  { ref: `refs/surety/cand/${candidate === 'cand_1' ? 1 : 2}`, read: 'value', oid: candidate === 'cand_1' ? A : B },
];

test('a newer registration with no result leaves the check missing, naming it; the earlier pass never decides (L7)', (t) => {
  const { db } = store(t);
  register(db, { id: 'cx_0', status: 'queued' }); // seq 1, recorded below as an earlier pass
  recordExit(db, 'cx_0', 0);
  assert.equal(stateOf(db).state, 'passed');
  register(db, { id: 'cx_1' });
  for (const status of ['queued', 'materializing', 'running', 'quarantined', 'interrupted']) {
    if (status !== 'queued') step(db, 'cx_1', status);
    const s = stateOf(db);
    assert.deepEqual([s.state, s.decider, s.pending], ['missing', null, { execution: 'cx_1', status }], `${status}: missing, pending names it`);
  }
});

test('an assessed reuse pass gives way to a newer registration of the candidate, and a cancellation restores nothing', (t) => {
  const { db, run } = store(t);
  result(db, { id: 'cr_old', candidate: 'cand_1', revision: A, seq: 1 });
  run(`INSERT INTO evidence_reuse (id, created_at, project, candidate, "check", check_result, record, assessed) VALUES ('reuse_1', ?, 'prj_1', 'cand_2', 'chk_1', 'cr_old', NULL, 1)`, AT);
  assert.equal(stateOf(db).state, 'passed', 'the reuse pass decides first');
  register(db, { id: 'cx_1' });
  step(db, 'cx_1', 'cancelled');
  assert.deepEqual(stateOf(db).pending, { execution: 'cx_1', status: 'cancelled' });
  assert.equal(stateOf(db).state, 'missing');
});

test('registration orders, not completion; history lists every earlier execution with its trigger and state', (t) => {
  const { db } = store(t);
  register(db, { id: 'cx_a', source: 'nomination' });
  register(db, { id: 'cx_b' });
  recordExit(db, 'cx_b', 1);
  recordExit(db, 'cx_a', 0);
  const s = stateOf(db);
  assert.deepEqual([s.state, s.decider.execution], ['failed', 'cx_b'], 'the later registration decides however late the earlier finishes');
  assert.equal(s.history.count, 1);
  assert.deepEqual(
    s.history.executions.map((h) => [h.execution, h.state, h.trigger.source]),
    [['cx_a', 'passed', 'nomination']],
  );
  assert.equal(s.history.link, '/v1/projects/prj_1/candidates/cand_2/checks');
  // A fixture result decides with no history (SEAM.md §191 leaves it unpinned).
  transact(db, ENGINE_ACTOR, (tx) => nextExecutionSeq(tx, 'prj_1'));
  result(db, { id: 'cr_fx', seq: executionSeqHigh(db, 'prj_1') });
  assert.deepEqual([stateOf(db).state, stateOf(db).history], ['passed', null]);
});

test('the one sequence: registrations and fixture results never collide, and the high-water mark is the watermark', (t) => {
  const { db } = store(t);
  const a = register(db, { id: 'cx_1' });
  result(db, { id: 'cr_1', seq: a + 1 }); // a result recorded with a number above the counter
  assert.equal(executionSeqHigh(db, 'prj_1'), a + 1);
  const b = register(db, { id: 'cx_2' });
  assert.equal(b, a + 2, 'the next registration is above every number given');
  assert.equal(executionSeqHigh(db, 'prj_1'), b, 'a registration with no result counts toward the watermark (T06)');
});

test('supersession cancels queued executions with no row and leaves running ones (T15)', (t) => {
  const { db } = store(t);
  register(db, { id: 'cx_q', candidate: 'cand_1', revision: A });
  register(db, { id: 'cx_r', candidate: 'cand_1', revision: A });
  step(db, 'cx_r', 'materializing');
  step(db, 'cx_r', 'running');
  db.prepare(`UPDATE candidates SET superseded_by = 'cand_2' WHERE id = 'cand_1'`).run();
  assert.equal(transact(db, ENGINE_ACTOR, (tx) => cancelSuperseded(tx, 'prj_1')), 1);
  const rows = Object.fromEntries(db.prepare('SELECT id, status, result FROM check_executions').all().map((r) => [r.id, [r.status, r.result]]));
  assert.deepEqual(rows, { cx_q: ['cancelled', null], cx_r: ['running', null] });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'check.cancelled'`).get().n, 1);
});

test('the scripted boundary moves one A.5 step; a recorded result keeps the registration\'s number and carries the harness label', (t) => {
  const { db } = store(t);
  const seq = register(db, { id: 'cx_1' });
  assert.throws(() => step(db, 'cx_1', 'running'), (e) => e.status === 409 && e.code === 'illegal_transition', 'queued → running skips a status');
  const answer = recordExit(db, 'cx_1', 0);
  assert.equal(answer.check_result.execution_seq, seq);
  const row = db.prepare('SELECT * FROM check_results WHERE execution = ?').get('cx_1');
  assert.deepEqual([row.execution_seq, row.runner_id, row.runner_qualification, row.execution_established], [seq, 'test_fixture', null, 1]);
  assert.throws(() => step(db, 'cx_1', 'cancelled'), (e) => e.status === 409, 'a terminal execution never moves');
});

test('Q9: an evaluation of a superseded candidate is refused first, naming its successor, and resolves nothing', (t) => {
  const { db } = store(t);
  register(db, { id: 'cx_1', candidate: 'cand_1', revision: A });
  recordExit(db, 'cx_1', 0);
  assert.deepEqual(reasonCodes(gate(db, 'cand_1', { refs: READ_ALL('cand_1') })), [], 'satisfied before the supersession');
  db.prepare(`UPDATE candidates SET superseded_by = 'cand_2' WHERE id = 'cand_1'`).run();
  const e = gate(db, 'cand_1', { refs: READ_ALL('cand_1') });
  assert.equal(e.outcome, 'not_satisfied');
  assert.deepEqual(e.reasons, [{ code: 'CANDIDATE_SUPERSEDED', subjects: ['cand_2'] }]);
  assert.equal(e.check_states.chk_1, 'passed', 'no new check state');
});

test('REF_UNREAD names each unread ref, and an evaluation made with no ref facts reads none', (t) => {
  const { db } = store(t);
  register(db, { id: 'cx_1' });
  recordExit(db, 'cx_1', 0);
  assert.deepEqual(gate(db, 'cand_2').reasons.find((r) => r.code === 'REF_UNREAD')?.subjects, ['refs/heads/main', 'refs/surety/cand/2']);
  const one = gate(db, 'cand_2', { refs: [{ ref: 'refs/heads/main', read: 'unread', oid: null }, READ_ALL('cand_2')[1]] });
  assert.deepEqual(one.reasons, [{ code: 'REF_UNREAD', subjects: ['refs/heads/main'] }]);
  assert.deepEqual(gate(db, 'cand_2', { refs: READ_ALL('cand_2') }).reasons, []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM out_of_band_changes').get().n, 0, 'nothing is recorded for an unread ref');
});

test('the gate\'s observation is reconciled against the registry as it is now (N02)', (t) => {
  const { db } = store(t);
  const regs = gateRefRegistry(db, { project: 'prj_1', candidate: 'cand_2' });
  assert.deepEqual(regs.map((r) => [r.ref, r.expected]), [['refs/heads/main', B], ['refs/surety/cand/2', B]]);
  // The registry moved since the read: nothing is recorded.
  db.prepare(`UPDATE ref_registry SET expected_oid = ? WHERE id = 'ref_main'`).run(C);
  assert.equal(transact(db, ENGINE_ACTOR, (tx) => observeGateRefs(tx, { project: 'prj_1', changes: [{ registry: 'ref_main', expected: B, found: C }] })).observed, 0);
  // A real change is recorded, once.
  for (let i = 0; i < 2; i++) transact(db, ENGINE_ACTOR, (tx) => observeGateRefs(tx, { project: 'prj_1', changes: [{ registry: 'ref_c2', expected: B, found: null }] }));
  assert.deepEqual(db.prepare('SELECT ref, expected, found FROM out_of_band_changes').all(), [{ ref: 'ref_c2', expected: B, found: null }]);
});

test('judging a read: unread is never a change; either generation and the journal\'s moving values account for a value', () => {
  const gen = (expected, moving = []) => [{ registry: 'ref_main', ref: 'refs/heads/main', expected, moving }];
  assert.deepEqual(judgeRefs(gen(A), gen(A), null), [{ fact: { ref: 'refs/heads/main', read: 'unread', oid: null }, change: null }]);
  assert.equal(judgeRefs(gen(A, [B]), gen(A, [B]), new Map([['refs/heads/main', B]]))[0].change, null, "the engine's own update in flight");
  assert.equal(judgeRefs(gen(A, [B]), gen(B), new Map([['refs/heads/main', A]]))[0].change, null, 'read before the finalizer moved the registry');
  assert.deepEqual(judgeRefs(gen(A), gen(A), new Map())[0], { fact: { ref: 'refs/heads/main', read: 'absent', oid: null }, change: { registry: 'ref_main', expected: A, found: null } });
  assert.deepEqual(judgeRefs(gen(A), gen(A), new Map([['refs/heads/main', C]]))[0].change, { registry: 'ref_main', expected: A, found: C });
  assert.equal(sameGeneration(gen(A, [B]), gen(A, [B])), true);
  assert.equal(sameGeneration(gen(A, [B]), gen(B)), false);
});
