// Developer tests for M6 slice 39, the corrections carried from M5 (E154
// item 6; E156 Q1; BS6 §11.3): the run's observed model set from its ledger
// rows (M542); a replan held, not refused, while its prerequisite results
// are in flight (M543, M444F-1); the engine's source revision recorded
// beside the package version (M544); a superseded candidate's phase
// verification retired (M545, INK-2); no disposition question the owner's
// standing answer already gave (M546, INK2-2).
//
// Against scratch stores with the engine's migrations, foreign keys off. No
// process, no git, no engine started.

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
const { chargeInvocation } = await import(join(dist, 'store', 'transitions', 'ledger.js'));
const { paceView, observeHost } = await import(join(dist, 'plan', 'pace.js'));
const { readRevision, engineRevision } = await import(join(dist, 'revision.js'));
const { dispatchBlocker, PREREQUISITES_PENDING, parkWork } = await import(join(dist, 'store', 'transitions', 'runs.js'));
const { markHolds, holdReasonOf } = await import(join(dist, 'scheduler', 'holds.js'));
const { recordCheckResult } = await import(join(dist, 'store', 'transitions', 'baseline.js'));
const { registerExecutions } = await import(join(dist, 'store', 'transitions', 'checks.js'));
const { pendingPrerequisites } = await import(join(dist, 'plan', 'bundle.js'));
const { readWork, readProject } = await import(join(dist, 'store', 'projections.js'));
const { retireSupersededVerifications } = await import(join(dist, 'plan', 'phase.js'));
const { checkAnswer } = await import(join(dist, 'store', 'transitions', 'decisions.js'));
const { recordReport } = await import(join(dist, 'store', 'transitions', 'findings.js'));
const { answerQueued } = await import(join(dist, 'store', 'transitions', 'queue.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });

const AT = '2026-10-16T12:00:00.000Z';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

let seq = 100;

function scratch(t, tier = 'T2') {
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
     VALUES ('prj_1', ?, 'p', ?, '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
  ).run(AT, tier);
  return db;
}

function runRow(db, id, { role = 'builder', kind = 'one_shot', model = 'm-requested', workItem = kind === 'session' ? null : `wi_${id}` } = {}) {
  db.prepare(
    `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined)
     VALUES (?, ?, 'prj_1', ?, ?, ?, ?, 'ended', 'scripted', '1', ?, ?, ?, 0)`,
  ).run(id, AT, ++seq, workItem, role, kind, model, A, AT);
}

function item(db, id, kind, subject, status, trigger = { source: 'test', id }) {
  db.prepare(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, depends_on, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold, chain)
     VALUES (?, ?, 'prj_1', ?, ?, ?, ?, '[]', ?, ?, 1, 0, 0, 0, 0, 0)`,
  ).run(id, AT, ++seq, kind, JSON.stringify(subject), status, trigger.source, trigger.id);
  return () => db.prepare('SELECT * FROM work_items WHERE id = ?').get(id);
}

// An invocation of `run` whose observations are the given, charged through
// the production chargeInvocation (the transaction that records the usage).
function charge(db, run, invocation, observations, turn = null) {
  db.prepare(`INSERT INTO invocation_receipts (id, created_at, project, run, turn, provider, model_requested, "grant", budget_snapshot) VALUES (?, ?, 'prj_1', ?, ?, 'scripted', 'm-requested', 'g', '{}')`).run(invocation, AT, run, turn);
  observations.forEach((raw, i) =>
    db.prepare(`INSERT INTO usage_observations (id, created_at, project, invocation, seq, semantics, raw, at) VALUES (?, ?, 'prj_1', ?, ?, 'cumulative', ?, ?)`).run(`uo_${invocation}_${i}`, AT, invocation, i + 1, JSON.stringify(raw), AT),
  );
  const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(run);
  transact(db, ENGINE_ACTOR, (tx) => chargeInvocation(tx, { id: r.id, project: 'prj_1', role: r.role, backend: 'scripted', model_requested: r.model_requested, outcome: 'completed' }, { id: invocation, turn }));
}

const modelOf = (db, run) => db.prepare('SELECT model_observed FROM runs WHERE id = ?').get(run).model_observed;
const paceRun = (db, run) => paceView(db, { project: 'prj_1' }).runs.find((r) => r.id === run);

// ---- M542 ------------------------------------------------------------------------------------

test('M542 (a), (c), (d): a one-shot run takes the model its ledger row observed, in the charging transaction; with none observed it is unknown, never the requested model', (t) => {
  const db = scratch(t);
  runRow(db, 'run_a');
  assert.equal(modelOf(db, 'run_a'), null);
  charge(db, 'run_a', 'inv_a', [{ input_tokens: 1, output_tokens: 1, model: 'm-observed' }]);
  assert.equal(modelOf(db, 'run_a'), 'm-observed', 'set from the ledger when the usage is recorded');
  assert.equal(paceRun(db, 'run_a').model, 'm-observed');

  runRow(db, 'run_c');
  charge(db, 'run_c', 'inv_c', [{ input_tokens: 1, output_tokens: 1 }]);
  assert.equal(modelOf(db, 'run_c'), null, 'nothing observed: null, not the requested model');
  assert.deepEqual(paceRun(db, 'run_c').model, { unknown: 'no invocation of the run recorded an observed model' });

  runRow(db, 'run_none');
  assert.deepEqual(paceRun(db, 'run_none').model, { unknown: 'the run has no ledger row' });
});

test('M542 (b): a session run takes the models its turns observed, each once in first-observed order; model_per_turn by turn number, a turn with none unknown', (t) => {
  const db = scratch(t);
  const turn = (id, run, n) =>
    db.prepare(`INSERT INTO turns (id, created_at, project, run, number, invocation, domain, started_at) VALUES (?, ?, 'prj_1', ?, ?, ?, 'd', ?)`).run(id, AT, run, n, `inv_${id}`, AT);
  runRow(db, 'run_s', { role: 'architect', kind: 'session' });
  turn('t1', 'run_s', 1);
  turn('t2', 'run_s', 2);
  charge(db, 'run_s', 'inv_t1', [{ input_tokens: 1, model: 'm-x' }], 't1');
  charge(db, 'run_s', 'inv_t2', [{ input_tokens: 1, model: 'm-x' }], 't2');
  assert.equal(modelOf(db, 'run_s'), 'm-x');
  assert.deepEqual(paceRun(db, 'run_s').model_per_turn, [{ turn: 1, model: 'm-x' }, { turn: 2, model: 'm-x' }]);

  runRow(db, 'run_d', { role: 'architect', kind: 'session' });
  turn('u1', 'run_d', 1);
  turn('u2', 'run_d', 2);
  turn('u3', 'run_d', 3);
  charge(db, 'run_d', 'inv_u1', [{ input_tokens: 1, model: 'm-x' }], 'u1');
  charge(db, 'run_d', 'inv_u2', [{ input_tokens: 1, model: 'm-y' }], 'u2');
  charge(db, 'run_d', 'inv_u3', [{ input_tokens: 1 }], 'u3');
  assert.equal(modelOf(db, 'run_d'), 'm-x,m-y', 'each model once, in the order first observed');
  assert.deepEqual(paceRun(db, 'run_d').model_per_turn, [
    { turn: 1, model: 'm-x' },
    { turn: 2, model: 'm-y' },
    { turn: 3, model: { unknown: 'no invocation of the turn recorded an observed model' } },
  ]);
});

// ---- M544 ------------------------------------------------------------------------------------

test('M544 (a), (b): the revision is read from the working tree the engine stands in, through a linked worktree and packed refs; unknown with its reason otherwise', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A repository whose branch is only in packed-refs, and a linked worktree
  // of it on another branch (loose ref).
  const main = join(dir, 'main');
  mkdirSync(join(main, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(main, '.git', 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${A} refs/heads/main\n`);
  mkdirSync(join(main, 'packages', 'engine', 'dist'), { recursive: true });
  assert.deepEqual(readRevision(join(main, 'packages', 'engine', 'dist')), { revision: A });
  const wtGit = join(main, '.git', 'worktrees', 'w1');
  mkdirSync(wtGit, { recursive: true });
  writeFileSync(join(wtGit, 'HEAD'), 'ref: refs/heads/build\n');
  writeFileSync(join(wtGit, 'commondir'), '../..\n');
  writeFileSync(join(main, '.git', 'refs', 'heads', 'build'), `${B}\n`);
  const wt = join(dir, 'wt');
  mkdirSync(join(wt, 'dist'), { recursive: true });
  writeFileSync(join(wt, '.git'), `gitdir: ${wtGit}\n`);
  assert.deepEqual(readRevision(join(wt, 'dist')), { revision: B });
  writeFileSync(join(wtGit, 'HEAD'), `${C}\n`);
  assert.deepEqual(readRevision(join(wt, 'dist')), { revision: C }, 'a detached HEAD names its commit');
  writeFileSync(join(wtGit, 'HEAD'), 'ref: refs/heads/none\n');
  assert.match(readRevision(join(wt, 'dist')).unknown, /refs\/heads\/none/);
  const bare = join(dir, 'bare');
  mkdirSync(bare);
  const outside = readRevision(bare);
  if ('unknown' in outside) assert.match(outside.unknown, /not in a git working tree|could not be read|names/);
  // This build's own revision is a commit id, never the package version.
  const own = engineRevision();
  assert.ok('revision' in own ? /^[0-9a-f]{40}$/.test(own.revision) : typeof own.unknown === 'string');
});

test('M544 (c): each host observation keeps the revision its engine started from; one recorded without it is unknown, never the present one', (t) => {
  const db = scratch(t);
  const observe = (incarnation, revision) =>
    transact(db, ENGINE_ACTOR, (tx) => observeHost(tx, { project: 'prj_1', incarnation, engine_version: '0.0.0', engine_revision: revision, settings: {} }));
  observe('inc_1', { revision: A });
  observe('inc_2', { unknown: 'the engine at /x is not in a git working tree, so its source revision cannot be read' });
  observe('inc_3', undefined);
  const hosts = paceView(db, { project: 'prj_1' }).hosts;
  assert.deepEqual(
    hosts.map((h) => [h.incarnation, h.engine_version, h.engine_revision]),
    [
      ['inc_1', '0.0.0', A],
      ['inc_2', '0.0.0', { unknown: 'the engine at /x is not in a git working tree, so its source revision cannot be read' }],
      ['inc_3', '0.0.0', { unknown: 'the engine did not report its revision' }],
    ],
  );
  db.prepare(`UPDATE host_observations SET engine_revision = NULL, engine_revision_unknown = NULL WHERE incarnation = 'inc_1'`).run();
  assert.match(paceView(db, { project: 'prj_1' }).hosts[0].engine_revision.unknown, /not recorded then/, 'an observation from before the column: unknown');
});

// ---- M543 ------------------------------------------------------------------------------------

// Phase 1 complete, phase 2 next and depending on it; one required check of
// phase 1 (its requirement's acceptance check) at protected version pv_1;
// candidate cand_2 the newest, on which that check has no result yet.
function phased(t) {
  const db = scratch(t);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  run(`INSERT INTO requirements (id, created_at, project, key, text_ref, status, criteria, sensitive_areas, assigned_phase) VALUES ('req_1', ?, 'prj_1', 'R1', 'r1', 'approved', '["R1.1"]', '[]', 1)`, AT);
  run(
    `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots, fingerprint_scheme)
     VALUES ('pv_1', ?, 'prj_1', 1, 'fp1', 'initial', 'human', 'human', ?, 1, ?, '[".surety/checks/"]', 'manifest')`,
    AT,
    AT,
    AT,
  );
  run(
    `INSERT INTO checks (id, created_at, project, key, protected_version, kind, required, gate_kinds, definition_path, definition_hash, runner_class, criteria, requirement_ids, origin)
     VALUES ('chk_acc', ?, 'prj_1', 'acc', 'pv_1', 'acceptance', 1, '["stage"]', '.surety/checks/defs/acc.json', 'h', 'direct', '["R1.1"]', '["req_1"]', 'acceptance')`,
    AT,
  );
  run(`INSERT INTO lineages (id, created_at, project, branch, started_from_candidate, open) VALUES ('lin_1', ?, 'prj_1', 'main', NULL, 0)`, AT);
  for (const [id, n, rev] of [['cand_1', 1, A], ['cand_2', 2, B]]) {
    db.prepare(
      `INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, nominated_protected_version, progress, held_work)
       VALUES (?, ?, 'prj_1', ?, ?, 'lin_1', ?, 'engine_cadence', 'pv_1', 'developing', '[]')`,
    ).run(id, AT, n, rev, AT);
  }
  run(`UPDATE candidates SET superseded_by = 'cand_2' WHERE id = 'cand_1'`);
  run(
    `INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, generation, active, status, completed_at, completion_binding)
     VALUES ('plan_1', ?, 'prj_1', 1, ?, 'plan.json', 1, 1, 'completed', ?, ?)`,
    AT,
    A,
    AT,
    JSON.stringify({ candidate: 'cand_1', protected_version: 'pv_1', spec_revision: null, generation: 1 }),
  );
  run(
    `INSERT INTO roadmap_revisions (id, created_at, project, version, architecture_revision, git_path, git_blob, phases, approved_by, approved_at)
     VALUES ('road_1', ?, 'prj_1', 1, NULL, '.surety/roadmap/roadmap.json', 'b', ?, 'human', ?)`,
    AT,
    JSON.stringify([
      { number: 1, goal: 'g1', modules: [], requirement_ids: ['R1'], depends_on: [] },
      { number: 2, goal: 'g2', modules: [], requirement_ids: [], depends_on: [1] },
    ]),
    AT,
  );
  const replan = item(db, 'wi_replan', 'replan', { phase_plan: 'plan_1' }, 'eligible', { source: 'phase_complete', id: 'plan_1' });
  const cand = (id) => db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
  const check = db.prepare(`SELECT * FROM checks WHERE id = 'chk_acc'`).get();
  const register = () => transact(db, ENGINE_ACTOR, (tx) => registerExecutions(tx, { project: 'prj_1', candidate: cand('cand_2'), checks: [check], trigger: { source: 'phase', id: 'plan_1', generation: 1 } }));
  const result = (exit) => transact(db, ENGINE_ACTOR, (tx) => recordCheckResult(tx, { project: 'prj_1', check: 'chk_acc', candidate: 'cand_2', exit_status: exit, protected_version: 'pv_1' }, {}));
  return { db, replan, register, result };
}

test('M543 (a), (f): a replan whose prerequisite results are queued on the newest candidate is held, its interval and the reads naming them; no repair, no blocker', (t) => {
  const { db, replan, register } = phased(t);
  assert.equal(pendingPrerequisites(db, 'prj_1', [1]), null, 'no execution in flight: nothing pending, the check refuses as built (d)');
  assert.equal(dispatchBlocker(db, replan(), { check: false }), null);
  const [x] = register();
  const pending = pendingPrerequisites(db, 'prj_1', [1]);
  assert.deepEqual(pending, [{ phase: 1, key: 'acc', candidate: 'cand_2', execution: x.id, status: 'queued' }]);
  const blocker = dispatchBlocker(db, replan(), { check: false });
  assert.ok(blocker.startsWith(PREREQUISITES_PENDING), blocker);
  assert.equal(holdReasonOf(blocker), 'prerequisite_results');
  transact(db, ENGINE_ACTOR, (tx) => markHolds(tx));
  const held = replan();
  assert.deepEqual([held.status, held.held, held.repair_attempts], ['eligible', 'prerequisite_results', 0]);
  const [interval] = JSON.parse(held.held_intervals);
  assert.deepEqual(interval.pending, pending, 'the interval names the results it waits on');
  assert.equal(interval.to, undefined);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE kind = 'blocker'`).get().n, 0, 'no blocker raised');
  const listed = readWork(db, { project: 'prj_1' }).work_items.find((w) => w.id === 'wi_replan');
  assert.deepEqual(listed.held, { reason: 'prerequisite_results', since: interval.from, pending });
  assert.deepEqual(readProject(db, { project: 'prj_1' }).project.held_work, [{ work_item: 'wi_replan', kind: 'replan', reason: 'prerequisite_results', since: interval.from, pending }]);
  // (e) the hold is read from the store: read again, as after a restart, it continues, one interval.
  transact(db, ENGINE_ACTOR, (tx) => markHolds(tx));
  assert.equal(JSON.parse(replan().held_intervals).length, 1);
});

test('M543 (b): recorded passed, the replan is released; recorded failed, it is released to be refused by the check as built', (t) => {
  for (const exit of [0, 1]) {
    const { db, replan, register, result } = phased(t);
    register();
    transact(db, ENGINE_ACTOR, (tx) => markHolds(tx));
    assert.equal(replan().held, 'prerequisite_results');
    result(exit);
    assert.equal(pendingPrerequisites(db, 'prj_1', [1]), null, `exit ${exit}: nothing pending`);
    assert.equal(dispatchBlocker(db, replan(), { check: false }), null, `exit ${exit}: dispatchable`);
    transact(db, ENGINE_ACTOR, (tx) => markHolds(tx));
    const [interval] = JSON.parse(replan().held_intervals);
    assert.ok(interval.to, 'the hold interval closed');
    assert.equal(replan().repair_attempts, 0, '(c) the hold spent no repair');
  }
});

test('M543 (d): a lack no execution in flight will settle, beside a pending one, is not held; nor a dependency not complete', (t) => {
  const { db, replan, register } = phased(t);
  register();
  db.prepare(
    `INSERT INTO checks (id, created_at, project, key, protected_version, kind, required, gate_kinds, definition_path, definition_hash, runner_class, criteria, requirement_ids, origin)
     VALUES ('chk_more', ?, 'prj_1', 'more', 'pv_1', 'acceptance', 1, '["stage"]', '.surety/checks/defs/more.json', 'h', 'direct', '["R1.1"]', '["req_1"]', 'acceptance')`,
  ).run(AT);
  assert.equal(pendingPrerequisites(db, 'prj_1', [1]), null, 'one result with no execution in flight: refused as built');
  assert.equal(dispatchBlocker(db, replan(), { check: false }), null);
  assert.equal(pendingPrerequisites(db, 'prj_1', [2]), null, 'a dependency not complete: refused as built');
});

// ---- M545 ------------------------------------------------------------------------------------

test('M545 (a), (c), (d): a parked phase verification of a superseded candidate is cancelled once the successor\'s of the same plan is complete, its blocker closed naming it; a retry is refused; nothing revives it', (t) => {
  const { db } = phased(t);
  db.prepare(`UPDATE phase_plans SET status = 'published', completed_at = NULL, completion_binding = NULL WHERE id = 'plan_1'`).run();
  const c1 = item(db, 'wi_pv1', 'phase_verification', { candidate: 'cand_1', phase_plan: 'plan_1' }, 'executing', { source: 'phase', id: 'cand_1:plan_1' });
  transact(db, ENGINE_ACTOR, (tx) => parkWork(tx, c1(), 'repair_attempts_max', {}));
  const blocker = db.prepare(`SELECT * FROM decisions WHERE kind = 'blocker' AND subject_id = 'wi_pv1'`).get();
  assert.equal(blocker?.status, 'open', 'the fixture: c1 parked on its blocker');
  const c2 = item(db, 'wi_pv2', 'phase_verification', { candidate: 'cand_2', phase_plan: 'plan_1' }, 'executing', { source: 'phase', id: 'cand_2:plan_1' });
  assert.deepEqual(transact(db, ENGINE_ACTOR, (tx) => retireSupersededVerifications(tx, 'prj_1')), [], "c2's verification not complete: c1's is kept");
  db.prepare(`UPDATE work_items SET status = 'complete' WHERE id = 'wi_pv2'`).run();
  assert.deepEqual(transact(db, ENGINE_ACTOR, (tx) => retireSupersededVerifications(tx, 'prj_1')), ['wi_pv1']);
  assert.deepEqual([c1().status, c1().end_cause, c2().status], ['cancelled', 'superseded', 'complete']);
  const cancelled = db.prepare(`SELECT payload FROM events WHERE type = 'work.cancelled' AND json_extract(subject, '$.work_item') = 'wi_pv1'`).get();
  assert.equal(JSON.parse(cancelled.payload).cause, 'candidate_superseded');
  assert.equal(JSON.parse(cancelled.payload).superseded_by, 'cand_2');
  const closed = db.prepare('SELECT * FROM decisions WHERE id = ?').get(blocker.id);
  assert.equal(closed.status, 'invalidated');
  assert.match(closed.invalidated_reason, /cand_2/);
  assert.throws(
    () => transact(db, { actor_kind: 'human', actor_id: null, request_id: null }, (tx) => checkAnswer(tx, { project: 'prj_1', decision: blocker.id, option: 'retry', preview_hash: blocker.preview_hash }, () => ({}))),
    (err) => err.code === 'decision_invalidated',
    '(c) the retry is refused',
  );
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE work_item = 'wi_pv1'`).get().n, 0, 'nothing dispatched on c1');
  assert.deepEqual(transact(db, ENGINE_ACTOR, (tx) => retireSupersededVerifications(tx, 'prj_1')), [], '(d) again (a restart): nothing revived or retired twice');
  assert.equal(c1().status, 'cancelled');
});

test('M545 (b): an eligible phase verification of a superseded candidate is not dispatched and is cancelled at once, naming its successor', (t) => {
  const { db } = phased(t);
  const c1 = item(db, 'wi_pv1', 'phase_verification', { candidate: 'cand_1', phase_plan: 'plan_1' }, 'eligible', { source: 'phase', id: 'cand_1:plan_1' });
  assert.match(dispatchBlocker(db, c1(), { check: false }), /superseded by candidate cand_2/);
  assert.deepEqual(transact(db, ENGINE_ACTOR, (tx) => retireSupersededVerifications(tx, 'prj_1')), ['wi_pv1']);
  assert.equal(c1().status, 'cancelled');
  const ok = item(db, 'wi_pv2', 'phase_verification', { candidate: 'cand_2', phase_plan: 'plan_1' }, 'eligible', { source: 'phase', id: 'cand_2:plan_1' });
  assert.doesNotMatch(dispatchBlocker(db, ok(), { check: false }) ?? '', /superseded/, "the successor's own is dispatched as before");
  assert.deepEqual(transact(db, ENGINE_ACTOR, (tx) => retireSupersededVerifications(tx, 'prj_1')), []);
});

// ---- M546 ------------------------------------------------------------------------------------

const HUMAN = { actor_kind: 'human', actor_id: null, request_id: null };

function reviewed(t) {
  const { db } = phased(t);
  item(db, 'wi_rev', 'review', { candidate: 'cand_2' }, 'executing');
  db.prepare(
    `INSERT INTO findings (id, created_at, project, seq, scope, subject_id, candidate, source_run, source_role, category, message, proposed_severity, effective_severity, status)
     VALUES ('fnd_1', ?, 'prj_1', 1, 'candidate', 'cand_2', 'cand_2', NULL, 'verifier', 'defect', 'm', 'medium', 'medium', 'open')`,
  ).run(AT);
  let n = 0;
  const review = (dispositions, severity_changes = []) => {
    const id = `run_rev_${++n}`;
    db.prepare(
      `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined, result_value)
       VALUES (?, ?, 'prj_1', ?, 'wi_rev', 'reviewer', 'one_shot', 'validating', 'scripted', '1', 'm', ?, ?, 0, ?)`,
    ).run(id, AT, ++seq, A, AT, JSON.stringify({ report: { dispositions, severity_changes } }));
    transact(db, ENGINE_ACTOR, (tx) => recordReport(tx, { run: id }));
    return id;
  };
  const questions = () => db.prepare(`SELECT * FROM decisions WHERE kind = 'finding_disposition' AND subject_id = 'fnd_1' ORDER BY rowid`).all();
  const finding = () => db.prepare(`SELECT * FROM findings WHERE id = 'fnd_1'`).get();
  // The owner's accept as production records it: a Reviewer's proposal
  // raises the question, and the owner approves it.
  const ownerAccepts = () => {
    review([{ finding: 'fnd_1', disposition: 'accept' }]);
    const q = questions().find((d) => d.status === 'open');
    transact(db, HUMAN, (tx) => answerQueued(tx, { project: 'prj_1', decision: q.id, option: 'approve', preview_hash: q.preview_hash, note: null }));
    assert.deepEqual([finding().status, finding().disposition, finding().disposition_authority], ['dispositioned', 'accept', 'human'], 'the fixture: the owner accepted');
    return q.id;
  };
  const standing = () => db.prepare(`SELECT * FROM events WHERE type = 'finding.proposal_standing' ORDER BY seq`).all();
  return { db, review, questions, finding, ownerAccepts, standing };
}

test("M546 (a), the review's finding 5: a Reviewer's accept on a finding the owner accepted raises no question; it names the decision that recorded the owner's answer, not a later one", (t) => {
  const { db, review, questions, finding, ownerAccepts, standing } = reviewed(t);
  const approved = ownerAccepts();
  // A later consumed finding_disposition decision of another scope about the
  // same finding: not the one the answer stands on.
  db.prepare(
    `INSERT INTO decisions (id, created_at, project, seq, kind, subject_type, subject_id, semantic_generation, scope, question, options, dependency_manifest, transition_schema_version, preview_hash, evidence, blocked_while_open, raised_at, status, answer, consumed_at)
     VALUES ('dec_later', ?, 'prj_1', 999, 'finding_disposition', 'finding', 'fnd_1', 1, 'alpha_exception', 'q', '[]', '{}', 1, 'h', '[]', '[]', ?, 'consumed', '{"option":"reject"}', ?)`,
  ).run(AT, AT, AT);
  const asked = questions().length;
  const run = review([{ finding: 'fnd_1', disposition: 'accept' }]);
  assert.equal(questions().length, asked, 'no finding_disposition question');
  assert.deepEqual([finding().status, finding().disposition, finding().disposition_authority, finding().proposed_disposition], ['dispositioned', 'accept', 'human', null]);
  const [ev] = standing();
  assert.equal(JSON.parse(ev.subject).run, run);
  const payload = JSON.parse(ev.payload);
  assert.equal(payload.disposition, 'accept');
  assert.equal(payload.decision, approved, 'the decision that recorded the standing answer');
});

test("M546, the review's finding 4: a severity the same report changes is a change since the owner's answer: asked", (t) => {
  const { review, questions, finding, ownerAccepts, standing } = reviewed(t);
  ownerAccepts();
  const before = questions().length;
  review([{ finding: 'fnd_1', disposition: 'accept' }], [{ finding: 'fnd_1', to: 'high' }]);
  assert.equal(finding().effective_severity, 'high');
  assert.equal(questions().length, before + 1, 'asked');
  assert.equal(standing().length, 0);
});

test("M546, the review's finding 4: a severity raised after the owner's answer by an earlier report: asked", (t) => {
  const { review, questions, finding, ownerAccepts, standing } = reviewed(t);
  ownerAccepts();
  review([], [{ finding: 'fnd_1', to: 'high' }]);
  assert.equal(finding().effective_severity, 'high');
  const before = questions().length;
  review([{ finding: 'fnd_1', disposition: 'accept' }]);
  assert.equal(questions().length, before + 1, 'asked');
  assert.equal(standing().length, 0);
});

test("M546 (b), (c): another disposition than the owner's, or one on a finding with none, is asked as built; a disposition no recorded answer gave stands on nothing", (t) => {
  const { db, review, questions, ownerAccepts, standing } = reviewed(t);
  ownerAccepts();
  const before = questions().length;
  review([{ finding: 'fnd_1', disposition: 'defer', linked_issue: 'x', defer_target: '2099-01-01T00:00:00.000Z' }]);
  assert.equal(questions().length, before + 1, '(b) another disposition: asked');
  assert.equal(standing().length, 0);
  db.prepare(
    `INSERT INTO findings (id, created_at, project, seq, scope, subject_id, candidate, source_run, source_role, category, message, proposed_severity, effective_severity, status, disposition, disposition_authority, disposition_by, disposition_at)
     VALUES ('fnd_2', ?, 'prj_1', 2, 'candidate', 'cand_2', 'cand_2', NULL, 'verifier', 'defect', 'm', 'medium', 'medium', 'dispositioned', 'accept', 'human', 'human', ?)`,
  ).run(AT, AT);
  review([{ finding: 'fnd_2', disposition: 'accept' }]);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE kind = 'finding_disposition' AND subject_id = 'fnd_2'`).get().n, 1, 'set in the store with no recorded answer: asked');
});

// ---- the review's findings 1 and 2 (M543) ----------------------------------------------------

test("M543, the review's finding 2: a quarantined prerequisite execution counts as in flight", (t) => {
  const { db, replan, register } = phased(t);
  const [x] = register();
  db.prepare(`UPDATE check_executions SET status = 'quarantined' WHERE id = ?`).run(x.id);
  assert.deepEqual(pendingPrerequisites(db, 'prj_1', [1])?.map((p) => [p.execution, p.status]), [[x.id, 'quarantined']]);
  assert.ok(dispatchBlocker(db, replan(), { check: false })?.startsWith(PREREQUISITES_PENDING));
});

test("M543, the review's finding 1: a replan whose last run ended held stays held on the executions it named while they are in flight, whatever the approved roadmap reads", (t) => {
  const { db, replan, register, result } = phased(t);
  // The approved roadmap names no dependency of phase 2: the check before
  // dispatch alone would find nothing pending.
  db.prepare(`UPDATE roadmap_revisions SET phases = ?`).run(
    JSON.stringify([
      { number: 1, goal: 'g1', modules: [], requirement_ids: ['R1'], depends_on: [] },
      { number: 2, goal: 'g2', modules: [], requirement_ids: [], depends_on: [] },
    ]),
  );
  const [x] = register();
  assert.equal(dispatchBlocker(db, replan(), { check: false }), null, 'the roadmap alone holds nothing');
  // The run's commit named phase 1: it ended held on the execution.
  db.prepare(
    `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined, outcome, reason_class, reason_detail)
     VALUES ('run_held', ?, 'prj_1', ?, 'wi_replan', 'architect', 'one_shot', 'ended', 'scripted', '1', 'm', ?, ?, 0, 'failed', 'invalid_result', ?)`,
  ).run(AT, ++seq, A, AT, JSON.stringify({ hold: 'prerequisite_results', pending: [{ phase: 1, key: 'acc', candidate: 'cand_2', execution: x.id, status: 'queued' }] }));
  const blocker = dispatchBlocker(db, replan(), { check: false });
  assert.ok(blocker?.startsWith(PREREQUISITES_PENDING), `held on the run's own pending list (${blocker})`);
  transact(db, ENGINE_ACTOR, (tx) => markHolds(tx));
  assert.equal(replan().held, 'prerequisite_results');
  assert.equal(JSON.parse(replan().held_intervals)[0].pending[0].execution, x.id);
  // Recorded: the execution leaves the in-flight set and the hold ends.
  result(0);
  db.prepare(`UPDATE check_executions SET status = 'recorded' WHERE id = ?`).run(x.id);
  assert.equal(dispatchBlocker(db, replan(), { check: false }), null, 'released once the execution it named is recorded');
});
