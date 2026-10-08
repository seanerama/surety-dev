// Developer tests for M3 slice 21, repair and findings (D3 §§2.10, 2.11, §5
// X2; store/transitions/repair.ts), against a scratch store with the
// engine's migrations: the repair a failed check takes and its limits, the
// conflict route and its answers, what can verify a finding and the route
// for a missing verification, and the result's criterion and objections.

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
const { recordCheckResult } = await import(join(dist, 'store', 'transitions', 'baseline.js'));
const repair = await import(join(dist, 'store', 'transitions', 'repair.js'));
const { recordDisposition } = await import(join(dist, 'store', 'transitions', 'queue.js'));
const { unknownCheck } = await import(join(dist, 'invoke', 'choke.js'));
const { resultSchema } = await import(join(dist, 'invoke', 'sandbox', 'context.js'));
const { parseReport, fieldAllowed } = await import(join(dist, 'runs', 'report.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });

const AT = '2026-10-08T00:00:00.000Z';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const TREE = 'c'.repeat(40);

// A T1 project whose stage's work `wi_1` is verifying on candidate 1, with
// the required acceptance check `acc` (covering R1.1) and smoke check `smoke`.
function store(t, { policy } = {}) {
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
  if (policy) {
    run(
      `INSERT INTO policy_revisions (id, created_at, project, revision, git_path, git_blob, changed_by, changed_at, diff_summary, widens_authority, committed, effective)
       VALUES ('pol_1', ?, 'prj_1', 1, '.surety/policy.json', 'blob', 'human', ?, '', 0, 1, ?)`,
      AT,
      AT,
      JSON.stringify(policy),
    );
    run(`UPDATE projects SET policy_revision = 'pol_1' WHERE id = 'prj_1'`);
  }
  run(
    `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots, fingerprint_scheme)
     VALUES ('pv_1', ?, 'prj_1', 1, 'fp', 'initial', 'human', 'human', ?, 1, ?, '[".surety/checks/"]', 'manifest')`,
    AT,
    AT,
    AT,
  );
  run(`INSERT INTO requirements (id, created_at, project, key, text_ref, status, criteria, sensitive_areas) VALUES ('req_1', ?, 'prj_1', 'R1', 'r1', 'approved', '["R1.1"]', '[]')`, AT);
  run(`INSERT INTO lineages (id, created_at, project, branch, started_from_candidate, open) VALUES ('lin_1', ?, 'prj_1', 'main', NULL, 0)`, AT);
  run(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path) VALUES ('plan_1', ?, 'prj_1', 1, ?, 'plan.json')`, AT, A);
  run(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, depends_on, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold, chain)
     VALUES ('wi_1', ?, 'prj_1', 1, 'stage_build', '{"stage":"stage_1"}', 'verifying', '[]', 'plan', 'stage_1', 1, 0, 0, 0, 0, 0)`,
    AT,
  );
  run(
    `INSERT INTO stages (id, created_at, project, phase_plan, number, goal, modules, requirement_ids, implements, status, work_item, integrated_revision)
     VALUES ('stage_1', ?, 'prj_1', 'plan_1', 1, 'g', '[]', '["req_1"]', '["req_1"]', 'integrated', 'wi_1', ?)`,
    AT,
    A,
  );
  candidate(db, 'cand_1', 1, A);
  for (const [id, key, kind, criteria, reqs] of [
    ['chk_acc', 'acc', 'acceptance', '["R1.1"]', '["req_1"]'],
    ['chk_smoke', 'smoke', 'smoke', '[]', '[]'],
  ]) {
    run(
      `INSERT INTO checks (id, created_at, project, key, protected_version, kind, required, gate_kinds, definition_path, definition_hash, runner_class, criteria, requirement_ids)
       VALUES (?, ?, 'prj_1', ?, 'pv_1', ?, 1, '["stage","alpha_authorize"]', ?, 'h', 'direct', ?, ?)`,
      id,
      AT,
      key,
      kind,
      `.surety/checks/defs/${key}.json`,
      criteria,
      reqs,
    );
  }
  return db;
}

function candidate(db, id, seq, revision, { held = ['wi_1'] } = {}) {
  db.prepare(
    `INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, nominated_protected_version, progress, held_work)
     VALUES (?, ?, 'prj_1', ?, ?, 'lin_1', ?, 'builder_request', 'pv_1', 'developing', ?)`,
  ).run(id, AT, seq, revision, AT, JSON.stringify(held));
  // The stage's integrated revision is an ancestor of every later candidate's, as git said.
  if (revision !== A) {
    db.prepare(`INSERT INTO revision_ancestry (id, created_at, project, ancestor, descendant, is_ancestor) VALUES (?, ?, 'prj_1', ?, ?, 1)`).run(`anc_${id}`, AT, A, revision);
  }
}

// The engine's own commit of a revision, as the journal records it: what the progress key reads the tree from.
function commitOf(db, sha, tree) {
  db.prepare(
    `INSERT INTO operations (id, created_at, project, seq, kind, target, subject, idempotency_key, semantic_generation, status, finalizer_inputs, deadline_at)
     VALUES (?, ?, 'prj_1', (SELECT COALESCE(MAX(seq), 0) + 1 FROM operations), 'git_commit', '{}', '{}', ?, 1, 'succeeded', ?, ?)`,
  ).run(`op_${sha.slice(0, 6)}`, AT, `k_${sha}`, JSON.stringify({ sha, tree, parent: A }), AT);
}

const post = (db, check, cand, exit) => transact(db, ENGINE_ACTOR, (tx) => recordCheckResult(tx, { project: 'prj_1', check, candidate: cand, exit_status: exit }, {})).check_result;
const item = (db, id = 'wi_1') => {
  const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id);
  return { ...row, blocker: row.blocker && JSON.parse(row.blocker), check_repair: row.check_repair && JSON.parse(row.check_repair), check_conflict: row.check_conflict && JSON.parse(row.check_conflict) };
};
const reconcile = (db) => transact(db, ENGINE_ACTOR, (tx) => repair.reconcileRepairs(tx, 'prj_1'));
const openBlocker = (db) => db.prepare(`SELECT * FROM decisions WHERE kind = 'blocker' AND subject_id = 'wi_1' AND status = 'open'`).get();

test('a failed required check sends the stage work back once, in the recording transaction, one repair counted however many failed', (t) => {
  const db = store(t);
  post(db, 'chk_smoke', 'cand_1', 0);
  assert.equal(item(db).status, 'verifying', 'a pass sends nothing back');
  const failed = post(db, 'chk_acc', 'cand_1', 1);
  const row = item(db);
  assert.deepEqual([row.status, row.repair_attempts, row.repair_due], ['eligible', 1, 0]);
  assert.deepEqual([row.check_repair.candidate, row.check_repair.generation], ['cand_1', 1]);
  const steps = db.prepare(`SELECT tx, payload FROM events WHERE type LIKE 'work.%' AND json_extract(payload, '$.from') = 'verifying'`).all();
  const recorded = db.prepare(`SELECT tx FROM events WHERE type = 'check.result' AND json_extract(subject, '$.check_result') = ?`).get(failed.id);
  assert.deepEqual(steps.map((s) => s.tx), [recorded.tx], 'one step, in the recording transaction');
  // Back in verifying on the same candidate (a harness move), another failure and repeated reconciliations take no second repair.
  db.prepare(`UPDATE work_items SET status = 'verifying' WHERE id = 'wi_1'`).run();
  post(db, 'chk_smoke', 'cand_1', 1);
  reconcile(db);
  reconcile(db);
  assert.deepEqual([item(db).status, item(db).repair_attempts], ['verifying', 1], 'once per candidate and generation');
});

test("the repair run is told of every failed repair check at dispatch, each with its deciding result and output record", (t) => {
  const db = store(t);
  db.prepare(`UPDATE work_items SET status = 'eligible' WHERE id = 'wi_1'`).run();
  const acc = post(db, 'chk_acc', 'cand_1', 1);
  const smoke = post(db, 'chk_smoke', 'cand_1', 2);
  const outputs = repair.checkOutputsFor(db, db.prepare(`SELECT * FROM work_items WHERE id = 'wi_1'`).get());
  assert.deepEqual(outputs, [
    { key: 'acc', check: 'chk_acc', check_result: acc.id, output: null },
    { key: 'smoke', check: 'chk_smoke', check_result: smoke.id, output: null },
  ]);
  // A later pass of one: only the other is still failed.
  post(db, 'chk_smoke', 'cand_1', 0);
  assert.deepEqual(repair.checkOutputsFor(db, db.prepare(`SELECT * FROM work_items WHERE id = 'wi_1'`).get()).map((o) => o.key), ['acc']);
  assert.equal(repair.checkOutputsFor(db, { ...db.prepare(`SELECT * FROM work_items WHERE id = 'wi_1'`).get(), kind: 'verification' }), undefined, 'other kinds carry none');
});

test('no repair for a superseded candidate, while the item has an unended run, or while it is not verifying', (t) => {
  const db = store(t);
  db.prepare(
    `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined, chain)
     VALUES ('run_1', ?, 'prj_1', 1, 'wi_1', 'builder', 'one_shot', 'validating', 'scripted', '1', 'm', ?, ?, 0, 1)`,
  ).run(AT, A, AT);
  post(db, 'chk_acc', 'cand_1', 1);
  assert.equal(item(db).status, 'verifying', 'its run has not ended: it ends first');
  db.prepare(`UPDATE runs SET state = 'ended' WHERE id = 'run_1'`).run();
  candidate(db, 'cand_2', 2, B, { held: [] });
  db.prepare(`UPDATE candidates SET superseded_by = 'cand_2' WHERE id = 'cand_1'`).run();
  reconcile(db);
  assert.deepEqual([item(db).status, item(db).repair_attempts], ['verifying', 0], "a superseded candidate's failure triggers nothing");
});

test('repair_attempts_max parks the item, the blocker naming the failed checks', (t) => {
  const db = store(t, { policy: { repair_attempts_max: 0 } });
  post(db, 'chk_acc', 'cand_1', 1);
  const row = item(db);
  assert.deepEqual([row.status, row.repair_attempts, row.blocker?.reason, row.blocker?.checks], ['parked', 0, 'repair_attempts_max', ['chk_acc']]);
  assert.ok(openBlocker(db), 'the decision that holds it');
});

test('the same failure on the same tree counts toward no_progress_max; an unknown tree never counts', (t) => {
  const db = store(t, { policy: { no_progress_max: 1 } });
  commitOf(db, A, TREE);
  post(db, 'chk_acc', 'cand_1', 1);
  assert.deepEqual([item(db).status, item(db).repair_attempts], ['eligible', 1]);
  const key = item(db).progress_key;
  assert.match(key, /^[0-9a-f]{64}$/, 'the key over the tree and the failure');
  // The repair's candidate has the same tree and fails the same way.
  commitOf(db, B, TREE);
  candidate(db, 'cand_2', 2, B);
  db.prepare(`UPDATE candidates SET superseded_by = 'cand_2' WHERE id = 'cand_1'`).run();
  db.prepare(`UPDATE work_items SET status = 'verifying' WHERE id = 'wi_1'`).run();
  post(db, 'chk_acc', 'cand_2', 1);
  assert.deepEqual([item(db).status, item(db).repair_attempts, item(db).blocker?.reason, item(db).blocker?.checks], ['parked', 1, 'no_progress_max', ['chk_acc']]);
});

test('an unknown tree gives no progress key: the repair is taken and nothing counts toward no_progress_max', (t) => {
  const db = store(t, { policy: { no_progress_max: 1 } });
  post(db, 'chk_acc', 'cand_1', 1);
  assert.deepEqual([item(db).status, item(db).progress_key, item(db).no_progress_count], ['eligible', null, 0]);
});

// ---- the conflict route (D3 §5 X2) -------------------------------------------------------

function objection(db, { role = 'builder', candidate = null, category = 'contract_conflict', check = 'acc' } = {}) {
  db.prepare(
    `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined, chain)
     VALUES ('run_b', ?, 'prj_1', 9, 'wi_1', ?, 'one_shot', 'ended', 'scripted', '1', 'm', ?, ?, 0, 1)`,
  ).run(AT, role, A, AT);
  db.prepare(
    `INSERT INTO findings (id, created_at, project, seq, scope, subject_id, candidate, source_run, source_role, category, message, "check", criterion, proposed_severity, effective_severity, status)
     VALUES ('fnd_x', ?, 'prj_1', 1, 'candidate', 'prj_1', ?, 'run_b', ?, ?, 'conflict', ?, 'R1.1', 'medium', 'medium', 'open')`,
  ).run(AT, candidate, role, category, check);
}

test("a Builder's objection to a check that then fails: the X2 blocker instead of the repair, offering exactly its four answers", (t) => {
  const db = store(t);
  objection(db);
  post(db, 'chk_acc', 'cand_1', 1);
  const row = item(db);
  assert.deepEqual([row.status, row.continuation, row.repair_attempts, row.blocker.reason, row.blocker.findings, row.blocker.checks], ['awaiting_decision', 'verifying', 0, 'check_conflict', ['fnd_x'], ['chk_acc']]);
  const d = openBlocker(db);
  assert.deepEqual(JSON.parse(d.options).map((o) => o.key), ['correct_check', 'change_spec', 'retry', 'cancel']);
  assert.equal(JSON.parse(d.dependency_manifest).cause, 'check_conflict');
});

test('a conflict naming a check that did not fail, or another item\'s, does not stop the repair', (t) => {
  const db = store(t);
  objection(db, { check: 'smoke' });
  post(db, 'chk_acc', 'cand_1', 1);
  assert.equal(item(db).status, 'eligible');
});

test("a Verifier's conflict finding counts only on the item's current candidate", (t) => {
  const db = store(t);
  objection(db, { role: 'verifier', candidate: 'cand_1', category: 'requirement_conflict' });
  post(db, 'chk_acc', 'cand_1', 1);
  assert.equal(item(db).status, 'awaiting_decision');
});

const answer = (db, option) =>
  transact(db, ENGINE_ACTOR, (tx) => {
    const now = tx.db.prepare(`SELECT * FROM work_items WHERE id = 'wi_1'`).get();
    return repair.answerConflict(tx, now, option, 'dec_1');
  });

test('retry takes the one repair; the answered conflict never stops it again', (t) => {
  const db = store(t);
  objection(db);
  post(db, 'chk_acc', 'cand_1', 1);
  answer(db, 'retry');
  assert.deepEqual([item(db).status, item(db).repair_attempts, item(db).check_conflict.answer], ['eligible', 1, 'retry']);
});

test('correct_check registers check_correction work for the Verifier, triggered by the finding, and holds the item at that candidate and version', (t) => {
  const db = store(t);
  objection(db);
  post(db, 'chk_acc', 'cand_1', 1);
  answer(db, 'correct_check');
  const w = db.prepare(`SELECT * FROM work_items WHERE kind = 'check_correction'`).all();
  assert.deepEqual(w.map((x) => [x.trigger_id, x.chain, JSON.parse(x.subject).finding]), [['fnd_x', 0, 'fnd_x']]);
  assert.deepEqual([item(db).status, item(db).repair_attempts], ['verifying', 0]);
  reconcile(db);
  assert.deepEqual([item(db).status, item(db).repair_attempts], ['verifying', 0], 'held: no repair for that failure');
  // A new candidate is judged afresh.
  candidate(db, 'cand_2', 2, B);
  db.prepare(`UPDATE candidates SET superseded_by = 'cand_2' WHERE id = 'cand_1'`).run();
  post(db, 'chk_acc', 'cand_2', 1);
  assert.deepEqual([item(db).status, item(db).repair_attempts], ['eligible', 1]);
});

test('change_spec raises spec_change work (never dispatched), cancel cancels', (t) => {
  const db = store(t);
  objection(db);
  post(db, 'chk_acc', 'cand_1', 1);
  answer(db, 'change_spec');
  const w = db.prepare(`SELECT * FROM work_items WHERE kind = 'spec_change'`).get();
  assert.deepEqual([w.trigger_id, w.status], ['fnd_x', 'eligible']);
  const db2 = store(t);
  objection(db2);
  post(db2, 'chk_acc', 'cand_1', 1);
  answer(db2, 'cancel');
  assert.equal(item(db2).status, 'cancelled');
});

test("recording a Builder's objections: valid ones once, as conflict findings of its run; invalid ones dropped", (t) => {
  const db = store(t);
  db.prepare(`INSERT INTO requirements (id, created_at, project, key, text_ref, status, criteria, sensitive_areas) VALUES ('req_2', ?, 'prj_1', 'R2', 'r2', 'approved', '["R2.1"]', '[]')`).run(AT);
  const objections = [
    { check: 'acc', criterion: 'R1.1', category: 'contract_conflict', message: 'valid' },
    { check: 'acc', criterion: 'R1.1', category: 'contract_conflict', message: 'valid' },
    { check: 'nosuch', category: 'contract_conflict', message: 'unknown check' },
    { check: 'acc', criterion: 'R9.9', category: 'contract_conflict', message: 'unknown criterion' },
    { check: 'acc', criterion: 'R2.1', category: 'requirement_conflict', message: 'unrelated criterion' },
  ];
  db.prepare(
    `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, outcome, backend, backend_version, model_requested, base_revision, deadline_at, quarantined, chain, result_value)
     VALUES ('run_o', ?, 'prj_1', 3, 'wi_1', 'builder', 'one_shot', 'ended', 'completed', 'scripted', '1', 'm', ?, ?, 0, 1, ?)`,
  ).run(AT, A, AT, JSON.stringify({ summary: 's', report: { objections } }));
  const r = db.prepare(`SELECT * FROM runs WHERE id = 'run_o'`).get();
  transact(db, ENGINE_ACTOR, (tx) => repair.recordObjections(tx, r));
  transact(db, ENGINE_ACTOR, (tx) => repair.recordObjections(tx, r));
  const rows = db.prepare(`SELECT category, "check", criterion, message, source_run, candidate FROM findings`).all();
  assert.deepEqual(rows, [{ category: 'contract_conflict', check: 'acc', criterion: 'R1.1', message: 'valid', source_run: 'run_o', candidate: null }]);
});

// ---- what verifies a finding (D3 §2.11) ----------------------------------------------------

test('only a required acceptance-origin check covering the criterion verifies it', () => {
  const c = { required: 1, origin: 'acceptance', criteria: '["R1.1"]' };
  assert.equal(repair.verifiesCriterion(c, 'R1.1'), true);
  assert.equal(repair.verifiesCriterion(c, 'R1.2'), false);
  assert.equal(repair.verifiesCriterion(c, null), false);
  assert.equal(repair.verifiesCriterion({ ...c, origin: 'developer' }, 'R1.1'), false);
  assert.equal(repair.verifiesCriterion({ ...c, required: 0 }, 'R1.1'), false);
  assert.equal(repair.verifiesCriterion(undefined, 'R1.1'), false);
});

test("a fix disposition of a finding its check cannot verify routes one check_correction in the disposition's transaction; one it can, none", (t) => {
  const db = store(t);
  const insert = (id, seq, check, criterion) =>
    db.prepare(
      `INSERT INTO findings (id, created_at, project, seq, scope, subject_id, category, message, "check", criterion, proposed_severity, effective_severity, status)
       VALUES (?, ?, 'prj_1', ?, 'project', 'prj_1', 'defect', 'm', ?, ?, 'medium', 'medium', 'open')`,
    ).run(id, AT, seq, check, criterion);
  insert('fnd_ok', 1, 'acc', 'R1.1');
  insert('fnd_none', 2, 'acc', null);
  insert('fnd_smoke', 3, 'smoke', 'R1.1');
  for (const id of ['fnd_ok', 'fnd_none', 'fnd_smoke', 'fnd_none']) {
    transact(db, ENGINE_ACTOR, (tx) =>
      recordDisposition(tx, tx.db.prepare('SELECT * FROM findings WHERE id = ?').get(id), { disposition: 'fix', authority: 'human', by: 'human', linked_issue: null, defer_target: null }),
    );
  }
  const routed = db.prepare(`SELECT trigger_id, chain FROM work_items WHERE kind = 'check_correction' ORDER BY seq`).all();
  assert.deepEqual(routed, [
    { trigger_id: 'fnd_none', chain: 1 },
    { trigger_id: 'fnd_smoke', chain: 1 },
  ]);
});

// ---- the result: criterion and objections ---------------------------------------------------

test("a finding's criterion must be one of the index's; with no index, none can be named", () => {
  const result = { report: { findings: [{ category: 'defect', severity: 'low', message: 'm', check: 'acc', criterion: 'R9.9' }] } };
  assert.match(unknownCheck(result, ['acc'], ['R1.1']), /criterion "R9\.9", which is not a criterion/);
  assert.match(unknownCheck(result, ['acc'], null), /no registered requirement index/);
  assert.equal(unknownCheck({ report: { findings: [{ ...result.report.findings[0], criterion: 'R1.1' }] } }, ['acc'], ['R1.1']), null);
});

test("the schema gives criterion as the index's enum; a Builder's objections take the keys and criteria; only a Builder may send them", () => {
  const v = resultSchema('verifier', ['acc'], ['R1.1', 'R1.2']);
  assert.deepEqual(v.properties.findings.items.properties.criterion.enum, ['R1.1', 'R1.2']);
  assert.equal(resultSchema('verifier', ['acc'], []).properties.findings.items.properties.criterion, undefined);
  const b = resultSchema('builder', ['acc'], ['R1.1']).properties.objections.items;
  assert.deepEqual([b.properties.check.enum, b.properties.criterion.enum, b.properties.category.enum], [['acc'], ['R1.1'], ['contract_conflict', 'requirement_conflict']]);
  const objections = [{ check: 'acc', category: 'contract_conflict', message: 'm' }];
  assert.deepEqual(parseReport({ objections }).objections, objections);
  assert.equal(parseReport({ objections: [{ check: 'acc', category: 'defect', message: 'm' }] }), null, 'only the two conflict categories');
  assert.equal(fieldAllowed({ objections }, 'builder'), true);
  assert.equal(fieldAllowed({ objections }, 'verifier'), false);
});
