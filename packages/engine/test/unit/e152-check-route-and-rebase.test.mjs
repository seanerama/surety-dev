// Developer tests for E152 items 3 and 4 (Sean, 2026-10-16), against a
// scratch store with the engine's migrations; no process, no git.
//
// Item 3 (D3 §2.11 as amended): a finding naming no criterion, whose named
// check covers no criterion and is required in the evaluated scope (the
// loop-3 phase-only smoke check page-static), is offered `fix` and is
// resolved when that check passes after the disposition; the owner may ask
// for the check to be corrected (`correct_check`) without a conflict
// finding, and the finding is then resolved when the corrected check passes.
// The loop-3 sequence: the phase Verifier signs nothing and raises a hygiene
// finding on page-static; the owner's question offers fix, correct_check,
// accept; fix makes fix work and no check_correction; the fix's candidate
// passes page-static; the phase gate resolves the finding and completes the
// fix; the phase asks its Verifier again. And the correct_check variant.
//
// Item 4 (D1 §7.5, D1-19 as amended): a Builder's rebase conflict with the
// moved integration branch sends the item back once on the new head, within
// repair_attempts_max, the conflict named in its context; the second
// parks, as a spent budget or a compare-and-swap failure does.

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
const { recordCheckResult } = await import(join(dist, 'store', 'transitions', 'baseline.js'));
const { recordReport } = await import(join(dist, 'store', 'transitions', 'findings.js'));
const { answerQueued } = await import(join(dist, 'store', 'transitions', 'queue.js'));
const { evaluateGate } = await import(join(dist, 'store', 'transitions', 'gates.js'));
const { beginEnd, finishRun } = await import(join(dist, 'store', 'transitions', 'runs.js'));
const { heldForFindings } = await import(join(dist, 'plan', 'phase.js'));
const { rebaseConflictFacts, ownerAskedCorrection } = await import(join(dist, 'store', 'reads.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });

const AT = '2026-10-16T00:00:00.000Z';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const HUMAN = { actor_kind: 'human', actor_id: null, request_id: null };

function scratchDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  return db;
}

// ---- item 3 -------------------------------------------------------------------------

// The loop-3 finding, as its Verifier reported it.
const LOOP3 = {
  category: 'hygiene',
  severity: 'low',
  check: 'page-static',
  message: "public/physics/validate.mjs line 1 reads '// ... the three labs'; page-static fails any public/physics/ file matching /three/i.",
};

// A T2 project in phase 1 (plan_1), its one stage verified on candidate 1,
// the stage check `acc` (R1.1) and the phase-only smoke check page-static
// (acceptance origin, criteria []), as in the loop-3 store.
function store(t) {
  const db = scratchDb(t);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  run(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T2', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
  );
  run(
    `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots, fingerprint_scheme)
     VALUES ('pv_1', ?, 'prj_1', 1, 'fp', 'initial', 'human', 'human', ?, 1, ?, '[".surety/checks/"]', 'manifest')`,
    AT,
    AT,
    AT,
  );
  run(`INSERT INTO requirements (id, created_at, project, key, text_ref, status, criteria, sensitive_areas, assigned_phase) VALUES ('req_1', ?, 'prj_1', 'R1', 'r1', 'approved', '["R1.1"]', '[]', 1)`, AT);
  run(`INSERT INTO lineages (id, created_at, project, branch, started_from_candidate, open) VALUES ('lin_1', ?, 'prj_1', 'main', NULL, 0)`, AT);
  run(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, generation, active) VALUES ('plan_1', ?, 'prj_1', 1, ?, 'plan.json', 1, 1)`, AT, A);
  run(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, depends_on, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold, chain)
     VALUES ('wi_1', ?, 'prj_1', 1, 'stage_build', '{"stage":"stage_1"}', 'complete', '[]', 'plan', 'stage_1', 1, 0, 0, 0, 0, 0)`,
    AT,
  );
  run(
    `INSERT INTO stages (id, created_at, project, phase_plan, number, goal, modules, requirement_ids, implements, status, work_item, integrated_revision)
     VALUES ('stage_1', ?, 'prj_1', 'plan_1', 1, 'g', '[]', '["req_1"]', '["req_1"]', 'verified', 'wi_1', ?)`,
    AT,
    A,
  );
  candidate(db, 'cand_1', 1, A, ['wi_1']);
  check(db, 'chk_acc', 'acc', 'pv_1', { kind: 'acceptance', criteria: '["R1.1"]', reqs: '["req_1"]', gates: '["stage","alpha_authorize"]' });
  check(db, 'chk_ps', 'page-static', 'pv_1', { kind: 'smoke', criteria: '[]', reqs: '[]', gates: '["phase"]' });
  for (const [id, ref, kind, oid, immutable] of [
    ['ref_main', 'refs/heads/main', 'integration', A, 0],
    ['ref_c1', 'refs/surety/cand/1', 'nomination', A, 1],
    ['ref_c2', 'refs/surety/cand/2', 'nomination', B, 1],
  ]) {
    run('INSERT INTO ref_registry (id, created_at, project, ref, kind, expected_oid, immutable) VALUES (?, ?, ?, ?, ?, ?, ?)', id, AT, 'prj_1', ref, kind, oid, immutable);
  }
  // The candidate's engine review, reported (T2).
  item(db, 'wi_review', 'review', { candidate: 'cand_1' }, 'complete', { source: 'verification', id: 'cand_1' });
  return db;
}

function candidate(db, id, seq, revision, held) {
  db.prepare(
    `INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, nominated_protected_version, progress, held_work)
     VALUES (?, ?, 'prj_1', ?, ?, 'lin_1', ?, 'engine_cadence', 'pv_1', 'developing', ?)`,
  ).run(id, AT, seq, revision, AT, JSON.stringify(held));
  if (revision !== A) db.prepare(`INSERT INTO revision_ancestry (id, created_at, project, ancestor, descendant, is_ancestor) VALUES (?, ?, 'prj_1', ?, ?, 1)`).run(`anc_${id}`, AT, A, revision);
}

function check(db, id, key, version, { kind, criteria, reqs, gates }) {
  db.prepare(
    `INSERT INTO checks (id, created_at, project, key, protected_version, kind, required, gate_kinds, definition_path, definition_hash, runner_class, criteria, requirement_ids, origin)
     VALUES (?, ?, 'prj_1', ?, ?, ?, 1, ?, ?, 'h', 'direct', ?, ?, 'acceptance')`,
  ).run(id, AT, key, version, kind, gates, `.surety/checks/defs/${key}.json`, criteria, reqs);
}

let seq = 100;
function item(db, id, kind, subject, status, trigger = { source: 'test', id }) {
  db.prepare(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, depends_on, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold, chain)
     VALUES (?, ?, 'prj_1', ?, ?, ?, ?, '[]', ?, ?, 1, 0, 0, 0, 0, 0)`,
  ).run(id, AT, ++seq, kind, JSON.stringify(subject), status, trigger.source, trigger.id);
}

// The phase Verifier's run on candidate 1, its result the report given; the
// run end completes its work.
function phaseVerifier(db, report) {
  item(db, 'wi_pv', 'phase_verification', { candidate: 'cand_1', phase_plan: 'plan_1' }, 'executing', { source: 'phase', id: 'cand_1:plan_1' });
  db.prepare(
    `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined, result_value)
     VALUES ('run_pv', ?, 'prj_1', ?, 'wi_pv', 'verifier', 'one_shot', 'validating', 'scripted', '1', 'm', ?, ?, 0, ?)`,
  ).run(AT, ++seq, A, AT, JSON.stringify({ report }));
  transact(db, ENGINE_ACTOR, (tx) => recordReport(tx, { run: 'run_pv' }));
  db.prepare(`UPDATE work_items SET status = 'complete' WHERE id = 'wi_pv'`).run();
}

const post = (db, chk, cand, exit) => transact(db, ENGINE_ACTOR, (tx) => recordCheckResult(tx, { project: 'prj_1', check: chk, candidate: cand, exit_status: exit }, {})).check_result;
const evaluate = (db, cand, { kind = 'phase', fingerprint = 'fp' } = {}) =>
  transact(db, ENGINE_ACTOR, (tx) =>
    evaluateGate(tx, {
      project: 'prj_1',
      candidate: cand,
      kind,
      ...(kind === 'phase' ? { phase_plan: 'plan_1' } : { stage: 'stage_1' }),
      headFingerprint: fingerprint,
      head: cand === 'cand_1' ? A : B,
      refs: [
        { ref: 'refs/heads/main', read: 'value', oid: cand === 'cand_1' ? A : B },
        { ref: cand === 'cand_1' ? 'refs/surety/cand/1' : 'refs/surety/cand/2', read: 'value', oid: cand === 'cand_1' ? A : B },
      ],
    }),
  ).evaluation;
const owedOpen = (db, id) => db.prepare(`SELECT * FROM decisions WHERE kind = 'finding_disposition' AND subject_id = ? AND scope = 'disposition_owed' AND status = 'open'`).all(id);
const keys = (d) => JSON.parse(d.options).map((o) => o.key);
const answer = (db, d, option) => transact(db, HUMAN, (tx) => answerQueued(tx, { project: 'prj_1', decision: d.id, option, preview_hash: d.preview_hash, note: null }));
const findingOf = (db) => db.prepare(`SELECT * FROM findings WHERE source_run = 'run_pv'`).get();
const workOf = (db, kind, finding) => db.prepare(`SELECT * FROM work_items WHERE kind = ? AND (json_extract(subject, '$.finding') = ? OR trigger_id = ?)`).all(kind, finding, finding);

test('E152 item 3, the loop-3 sequence: page-static fails, the phase Verifier raises a no-criterion hygiene finding on it; fix, correct_check and accept are offered; fix makes fix work and no correction; the fix candidate passes page-static and the phase gate resolves the finding, completing the fix; the phase asks its Verifier again', (t) => {
  const db = store(t);
  post(db, 'chk_acc', 'cand_1', 0);
  post(db, 'chk_ps', 'cand_1', 1);
  const before = evaluate(db, 'cand_1');
  assert.equal(before.outcome, 'not_satisfied', 'page-static failed: the phase gate is not satisfied');
  assert.equal(before.check_states.chk_ps, 'failed');

  phaseVerifier(db, { findings: [LOOP3], signoffs: [] });
  const f = findingOf(db);
  assert.deepEqual([f.check, f.criterion, f.category, f.effective_severity], ['page-static', null, 'hygiene', 'low']);
  const [d] = owedOpen(db, f.id);
  assert.ok(d, 'owed to the owner at once');
  assert.deepEqual(keys(d), ['fix', 'correct_check', 'accept'], 'page-static covers no criterion and is required in a phase scope of the candidate: fix; it names a check: correct_check');
  assert.match(d.question, /fix it, or have its check page-static corrected, or accept it/i);
  assert.equal(heldForFindings(db, 'wi_pv'), 'waiting');

  answer(db, d, 'fix');
  const row = db.prepare('SELECT * FROM findings WHERE id = ?').get(f.id);
  assert.deepEqual([row.status, row.disposition, row.disposition_authority], ['dispositioned', 'fix', 'human']);
  const [fix] = workOf(db, 'fix', f.id);
  assert.ok(fix, 'fix work for a Builder');
  assert.deepEqual(workOf(db, 'check_correction', f.id), [], 'page-static can verify the finding: no check_correction is routed (D3 §2.11 as amended)');
  assert.equal(heldForFindings(db, 'wi_pv'), 'waiting', 'the phase waits for the fix work');

  // The Builder's fix integrated on the current head and nominated: candidate 2 holds the fix.
  db.prepare(`INSERT INTO lineages (id, created_at, project, branch, started_from_candidate, open) VALUES ('lin_2', ?, 'prj_1', 'main', 'cand_1', 0)`).run(AT);
  candidate(db, 'cand_2', 2, B, [fix.id]);
  db.prepare(`UPDATE candidates SET lineage = 'lin_2' WHERE id = 'cand_2'`).run();
  db.prepare(`UPDATE candidates SET superseded_by = 'cand_2' WHERE id = 'cand_1'`).run();
  db.prepare(`UPDATE work_items SET status = 'verifying' WHERE id = ?`).run(fix.id);
  post(db, 'chk_acc', 'cand_2', 0);
  // A stage gate on the fix's candidate: page-static is not in its scope, so
  // it resolves nothing there, and names no missing verification (a phase
  // scope can verify it).
  const stage = evaluate(db, 'cand_2', { kind: 'stage' });
  assert.equal(db.prepare('SELECT status FROM findings WHERE id = ?').get(f.id).status, 'dispositioned', 'not resolved at a stage gate');
  assert.deepEqual(stage.missing_verifications, [], 'no missing verification');
  assert.ok(stage.reasons.some((r) => r.code === 'FINDING_UNSATISFIED' && r.subjects.includes(f.id)), `the fix still holds that gate (${JSON.stringify(stage.reasons)}; findings ${JSON.stringify(JSON.parse(db.prepare('SELECT inputs_snapshot FROM gate_evaluations WHERE id = ?').get(stage.id).inputs_snapshot).findings)})`);

  post(db, 'chk_ps', 'cand_2', 0);
  const phase = evaluate(db, 'cand_2');
  const resolved = db.prepare('SELECT * FROM findings WHERE id = ?').get(f.id);
  assert.equal(resolved.status, 'resolved', `resolved by page-static passing after the disposition (${JSON.stringify(phase.reasons)})`);
  assert.equal(JSON.parse(resolved.resolution_verification).evaluation, phase.id, 'by the phase evaluation');
  assert.equal(phase.check_states.chk_ps, 'passed');
  assert.ok(!phase.reasons.some((r) => r.code.startsWith('FINDING_')), 'no finding holds the phase gate');
  assert.equal(db.prepare('SELECT status FROM work_items WHERE id = ?').get(fix.id).status, 'complete', 'the fix completes with its finding');
  assert.equal(heldForFindings(db, 'wi_pv'), 'settled', 'the phase asks its Verifier again');
});

test('E152 item 3, the correct_check variant: no fix work, one check_correction for the Verifier (unchained), the phase waits until the corrected version is applied, and the corrected page-static passing resolves the finding', (t) => {
  const db = store(t);
  post(db, 'chk_acc', 'cand_1', 0);
  post(db, 'chk_ps', 'cand_1', 1);
  phaseVerifier(db, { findings: [LOOP3], signoffs: [] });
  const f = findingOf(db);
  const [d] = owedOpen(db, f.id);
  const option = JSON.parse(d.options).find((o) => o.key === 'correct_check');
  assert.match(option.consequence_text, /check_correction work/);
  assert.match(option.consequence_text, /stays in force until a corrected version is approved/);
  answer(db, d, 'correct_check');
  const row = db.prepare('SELECT * FROM findings WHERE id = ?').get(f.id);
  assert.deepEqual([row.status, row.disposition, row.disposition_authority], ['dispositioned', 'fix', 'human'], 'dispositioned fix: resolved only by the check');
  assert.deepEqual(workOf(db, 'fix', f.id), [], 'no fix work: nothing changes in the code');
  const corrections = workOf(db, 'check_correction', f.id);
  assert.equal(corrections.length, 1, 'one check_correction for the Verifier');
  assert.deepEqual([corrections[0].trigger_source, corrections[0].trigger_id, corrections[0].chain], ['check_correction', f.id, 0]);
  assert.equal(ownerAskedCorrection(db, f.id), true, "its package says the owner asked for it");
  assert.equal(heldForFindings(db, 'wi_pv'), 'waiting', 'waiting for the correction');

  // The correction's run captured a proposal; the work ends; the proposal is not yet applied.
  db.prepare(
    `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined)
     VALUES ('run_cc', ?, 'prj_1', ?, ?, 'verifier', 'one_shot', 'ended', 'scripted', '1', 'm', ?, ?, 0)`,
  ).run(AT, ++seq, corrections[0].id, A, AT);
  db.prepare(
    `INSERT INTO protected_proposals (id, created_at, project, seq, proposed_by, run, base_revision, tree_id, diff_hash, requested_change_kind, status)
     VALUES ('pp_1', ?, 'prj_1', 1, 'verifier_run', 'run_cc', ?, 't', 'd', 'loosening', 'awaiting_human')`,
  ).run(AT, A);
  db.prepare(`UPDATE work_items SET status = 'complete' WHERE id = ?`).run(corrections[0].id);
  assert.equal(heldForFindings(db, 'wi_pv'), 'waiting', 'its proposal is not yet applied: still waiting');
  // The old page-static still fails: the check stays in force.
  assert.equal(evaluate(db, 'cand_1').check_states.chk_ps, 'failed');
  assert.equal(db.prepare('SELECT status FROM findings WHERE id = ?').get(f.id).status, 'dispositioned');

  // Applied: version 2, with page-static corrected (still smoke, criteria []).
  db.prepare(`UPDATE protected_versions SET superseded_by = 'pv_2' WHERE id = 'pv_1'`).run();
  db.prepare(
    `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots, fingerprint_scheme)
     VALUES ('pv_2', ?, 'prj_1', 2, 'fp2', 'loosening', 'human', 'human', ?, 1, ?, '[".surety/checks/"]', 'manifest')`,
  ).run(AT, AT, AT);
  db.prepare(`UPDATE protected_versions SET superseded_by = 'pv_2' WHERE id = 'pv_1'`).run();
  db.prepare(`UPDATE protected_proposals SET status = 'applied', resulting_version = 'pv_2' WHERE id = 'pp_1'`).run();
  check(db, 'chk_acc2', 'acc', 'pv_2', { kind: 'acceptance', criteria: '["R1.1"]', reqs: '["req_1"]', gates: '["stage","alpha_authorize"]' });
  check(db, 'chk_ps2', 'page-static', 'pv_2', { kind: 'smoke', criteria: '[]', reqs: '[]', gates: '["phase"]' });
  // The correction is over; the phase step registers the corrected check and
  // evaluates the phase gate before it asks its Verifier again (plan/phase.ts:
  // pending executions come first).
  assert.equal(heldForFindings(db, 'wi_pv'), 'settled', 'the correction applied: nothing more to wait for');
  post(db, 'chk_acc2', 'cand_1', 0);
  post(db, 'chk_ps2', 'cand_1', 0);
  const phase = evaluate(db, 'cand_1', { fingerprint: 'fp2' });
  assert.equal(phase.check_states.chk_ps2, 'passed');
  const resolved = db.prepare('SELECT * FROM findings WHERE id = ?').get(f.id);
  assert.equal(resolved.status, 'resolved', `the corrected page-static passing after the disposition resolves it (${JSON.stringify(phase.reasons)})`);
  assert.equal(JSON.parse(resolved.resolution_verification).evaluation, phase.id);
  assert.ok(!phase.reasons.some((r) => r.code.startsWith('FINDING_')), 'no finding holds the phase gate');
});

test('E152 item 3: correct_check is offered on any finding naming a check; a finding naming no check is offered neither fix nor correct_check; a no-criterion finding on a check covering a criterion is still not verifiable by it (M235 (c))', (t) => {
  const db = store(t);
  phaseVerifier(db, {
    findings: [
      { category: 'hygiene', severity: 'low', message: 'no check named' },
      { category: 'defect', severity: 'medium', check: 'acc', message: 'names acc, no criterion' },
    ],
    signoffs: [],
  });
  const [none, covering] = db.prepare(`SELECT * FROM findings WHERE source_run = 'run_pv' ORDER BY seq`).all();
  assert.deepEqual(keys(owedOpen(db, none.id)[0]), ['accept']);
  assert.deepEqual(keys(owedOpen(db, covering.id)[0]), ['correct_check', 'accept'], 'acc covers R1.1: it cannot verify a finding naming no criterion; it can be corrected');
  answer(db, owedOpen(db, covering.id)[0], 'accept');
  assert.equal(db.prepare('SELECT disposition FROM findings WHERE id = ?').get(covering.id).disposition, 'accept');
});

// ---- item 4 -------------------------------------------------------------------------

// A T1 project; a Builder's fix work `wi_b` integrating, its run `run_<n>` at
// the end of integration with the failure given.
function integrationStore(t, { repairMax = 3 } = {}) {
  const db = scratchDb(t);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  run(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
  );
  run(
    `INSERT INTO policy_revisions (id, created_at, project, revision, git_path, git_blob, changed_by, changed_at, diff_summary, widens_authority, committed, effective)
     VALUES ('pol_1', ?, 'prj_1', 1, '.surety/policy.json', 'blob', 'human', ?, '', 0, 1, ?)`,
    AT,
    AT,
    JSON.stringify({ repair_attempts_max: repairMax }),
  );
  run(`UPDATE projects SET policy_revision = 'pol_1' WHERE id = 'prj_1'`);
  run(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, depends_on, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold, chain)
     VALUES ('wi_b', ?, 'prj_1', 1, 'fix', '{}', 'integrating', '[]', 'test', 'wi_b', 1, 0, 0, 0, 0, 1)`,
    AT,
  );
  return db;
}

let runSeq = 0;
// A run of wi_b that ends failed at integration with `detail`; the item is
// put back to `integrating` as the next run's acceptance would.
function endIntegration(db, detail, { role = 'builder' } = {}) {
  const id = `run_${++runSeq}`;
  db.prepare(`UPDATE work_items SET status = 'integrating' WHERE id = 'wi_b'`).run();
  db.prepare(
    `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined)
     VALUES (?, ?, 'prj_1', ?, 'wi_b', ?, 'one_shot', 'validating', 'scripted', '1', 'm', ?, ?, 0)`,
  ).run(id, AT, runSeq, role, A, AT);
  transact(db, ENGINE_ACTOR, (tx) => {
    beginEnd(tx, { run: id, outcome: 'failed', reason: 'integration_conflict', reasonText: 'the integration branch moved', detail });
    finishRun(tx, { run: id, invocations: {}, recovery: null });
  });
  return id;
}
const work = (db) => db.prepare(`SELECT * FROM work_items WHERE id = 'wi_b'`).get();
const REBASE = (head, files) => ({ park: 'integration_conflict', conflict: 'rebase', head, files });

test('E152 item 4: a rebase conflict sends the item back to its Builder once on the new head, the conflict named in its context; the second parks integration_conflict', (t) => {
  const db = integrationStore(t);
  db.prepare(`UPDATE work_items SET continue_from = ? WHERE id = 'wi_b'`).run(A);
  const first = endIntegration(db, REBASE(B, ['src/a.js', 'src/b.js']));
  let w = work(db);
  assert.deepEqual([w.status, w.repair_due, w.continue_from, w.blocker], ['eligible', 1, null, null], 'back to its Builder, one repair due, on the new head (no checkpoint to continue from), no blocker');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE kind = 'blocker'`).get().n, 0, 'no blocker question');
  const back = db.prepare(`SELECT payload FROM events WHERE type LIKE 'work.%' ORDER BY seq DESC LIMIT 1`).get();
  assert.match(back.payload, /rebase_conflict/);

  // The repair's context: the next run reads the conflict of the one before.
  const next = `run_${runSeq + 1}`;
  db.prepare(
    `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined)
     VALUES (?, ?, 'prj_1', ?, 'wi_b', 'builder', 'one_shot', 'claimed', 'scripted', '1', 'm', ?, ?, 0)`,
  ).run(next, AT, runSeq + 1, B, AT);
  assert.deepEqual(rebaseConflictFacts(db, 'wi_b', next), { run: first, head: B, files: ['src/a.js', 'src/b.js'] });
  db.prepare('DELETE FROM runs WHERE id = ?').run(next);

  endIntegration(db, REBASE('d'.repeat(40), ['src/a.js']));
  w = work(db);
  assert.equal(w.status, 'parked', 'the second rebase conflict parks');
  assert.equal(JSON.parse(w.blocker).reason, 'integration_conflict');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE kind = 'blocker' AND subject_id = 'wi_b' AND status = 'open'`).get().n, 1, 'an open blocker for the owner');
});

test('E152 item 4: a spent repair budget parks the first rebase conflict; a compare-and-swap failure parks; a non-Builder run parks', (t) => {
  const spent = integrationStore(t, { repairMax: 0 });
  endIntegration(spent, REBASE(B, ['src/a.js']));
  assert.equal(work(spent).status, 'parked', 'repair_attempts_max 0: no send-back');

  const cas = integrationStore(t);
  endIntegration(cas, { park: 'integration_conflict', conflict: 'compare_and_swap' });
  assert.equal(work(cas).status, 'parked', 'a compare-and-swap failure parks, as before');
  assert.equal(JSON.parse(work(cas).blocker).reason, 'integration_conflict');

  const legacy = integrationStore(t);
  endIntegration(legacy, { park: 'integration_conflict' });
  assert.equal(work(legacy).status, 'parked', 'a conflict recorded without its kind parks (unknown is not a rebase)');

  const verifier = integrationStore(t);
  endIntegration(verifier, REBASE(B, ['.surety/checks/defs/x.json']), { role: 'verifier' });
  assert.equal(work(verifier).status, 'parked', 'only a Builder is sent back');
});
