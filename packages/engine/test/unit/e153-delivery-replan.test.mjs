// Developer tests for E153 item 1 (Sean, 2026-10-16; D6 §4.5 amended),
// against a scratch store with the engine's migrations; no process, no git.
//
// An approved specification change that leaves an implementation
// obligation when every phase of the roadmap is complete schedules exactly
// one Architect replan (spec/change.ts registerDeliveryReplans):
//   1. the obligation is read from evidence: the change's corrected checks,
//      its obligations resolved, recorded failing on the last candidate; the
//      engine waits while a result is missing or not established; passing
//      corrected checks register nothing;
//   2. once per change request (trigger `spec_change`, the request), across
//      repeated calls;
//   3. the completed phase's row is not touched;
//   5. the driver's ruling: a completed phase whose checks a later change
//      makes fail stays complete for the dependency clause
//      (plan/bundle.ts phasesNotHeld); a regression with no such change
//      still blocks it (D6 §5.8), and a phase never completed is never in
//      `completed_phases`.
// Item 4 (an unbuildable proposal raises a blocker) is the existing replan
// route (M424; D1 §4.3), reached from this registration; the acceptance file
// M433-a-change-after-the-final-phase-schedules-a-replan (d) covers it.

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
const { registerDeliveryReplans, deliveryVerdict, everyPhaseComplete } = await import(join(dist, 'spec', 'change.js'));
const { phasesNotHeld, bundleBaselineFacts } = await import(join(dist, 'plan', 'bundle.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });

const AT = '2026-10-16T00:00:00.000Z';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

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

let eventSeq = 0;
function event(db, type, subject) {
  eventSeq++;
  db.prepare(`INSERT INTO events (id, created_at, seq, at, type, subject, actor_kind, payload, tx) VALUES (?, ?, ?, ?, ?, ?, 'engine', '{}', ?)`).run(
    `ev_${eventSeq}`,
    AT,
    1000 + eventSeq,
    AT,
    type,
    JSON.stringify(subject),
    `tx_${eventSeq}`,
  );
}

function check(db, id, key, version, { criteria = '["R1.1"]', gates = '["stage","phase"]' } = {}) {
  db.prepare(
    `INSERT INTO checks (id, created_at, project, key, protected_version, kind, required, gate_kinds, definition_path, definition_hash, runner_class, criteria, requirement_ids, origin)
     VALUES (?, ?, 'prj_1', ?, ?, 'acceptance', 1, ?, ?, ?, 'direct', ?, '["req_1"]', 'acceptance')`,
  ).run(id, AT, key, version, gates, `.surety/checks/defs/${key}.json`, `h_${id}`, criteria);
}

function candidate(db, id, seq, revision) {
  db.prepare(
    `INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, nominated_protected_version, progress, held_work)
     VALUES (?, ?, 'prj_1', ?, ?, 'lin_1', ?, 'engine_cadence', 'pv_2', 'developing', '["wi_1"]')`,
  ).run(id, AT, seq, revision, AT);
}

// A T2 project whose roadmap has one phase, completed on cand_1 under spec
// version 1; spec version 2 approved after the completion (scr_1), its one
// obligation on `acc` resolved by the correction (protected version 2).
// `approvedBefore`: the change's approval event precedes the completion.
function store(t, { approvedBefore = false, resolved = true, obligation = true } = {}) {
  const db = scratchDb(t);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  run(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T2', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
  );
  for (const [id, seq, superseded] of [
    ['pv_1', 1, 'pv_2'],
    ['pv_2', 2, null],
  ]) {
    run(
      `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots, fingerprint_scheme, superseded_by)
       VALUES (?, ?, 'prj_1', ?, ?, 'initial', 'human', 'human', ?, 1, ?, '[".surety/checks/"]', 'manifest', ?)`,
      id,
      AT,
      seq,
      `fp${seq}`,
      AT,
      AT,
      superseded,
    );
  }
  for (const [id, version] of [
    ['spec_1', 1],
    ['spec_2', 2],
  ]) {
    run(`INSERT INTO spec_revisions (id, created_at, project, version, git_path, git_blob, semantic_digest, approved_by, approved_at) VALUES (?, ?, 'prj_1', ?, '.surety/spec/spec.md', ?, ?, 'human', ?)`, id, AT, version, `blob${version}`, `d${version}`, AT);
  }
  run(`INSERT INTO requirements (id, created_at, project, key, text_ref, status, criteria, sensitive_areas, assigned_phase) VALUES ('req_1', ?, 'prj_1', 'R1', 'r1', 'approved', '["R1.1"]', '[]', 1)`, AT);
  run(
    `INSERT INTO roadmap_revisions (id, created_at, project, version, git_path, git_blob, phases, approved_by, approved_at) VALUES ('rm_1', ?, 'prj_1', 1, '.surety/roadmap/roadmap.json', 'rb1', ?, 'human', ?)`,
    AT,
    JSON.stringify([{ number: 1, goal: 'g', modules: ['lib'], requirement_ids: ['R1'], depends_on: [] }]),
    AT,
  );
  run(`INSERT INTO lineages (id, created_at, project, branch, started_from_candidate, open) VALUES ('lin_1', ?, 'prj_1', 'main', NULL, 0)`, AT);
  const binding = { candidate: 'cand_1', acceptance_hash: 'ah', protected_version: 'pv_1', spec_revision: 'spec_1', generation: 1, evaluation: 'ge_1' };
  run(
    `INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, generation, active, status, published_at, completed_at, completion_binding)
     VALUES ('plan_1', ?, 'prj_1', 1, ?, 'plan.json', 1, 1, 'completed', ?, ?, ?)`,
    AT,
    A,
    AT,
    AT,
    JSON.stringify(binding),
  );
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
  candidate(db, 'cand_1', 1, A);
  check(db, 'chk_acc_1', 'acc', 'pv_1');
  check(db, 'chk_acc_2', 'acc', 'pv_2');
  check(db, 'chk_other', 'other', 'pv_2', { criteria: '["R1.1"]' });
  run(
    `INSERT INTO spec_change_requests (id, created_at, project, seq, spec_revision, request_text, source, status, approved_revision, impact_value) VALUES ('scr_1', ?, 'prj_1', 1, 'spec_1', 'R1.1 changes', 'owner', 'approved', 'spec_2', ?)`,
    AT,
    JSON.stringify({ requirements: [{ key: 'R1', changes: ['criteria_changed'] }], affected_criteria: ['R1.1'], removed_criteria: [], added_criteria: [] }),
  );
  if (obligation) {
    run(
      `INSERT INTO check_obligations (id, created_at, project, "check", key, criteria, generation, reason, request, resolved_by, resolved_at) VALUES ('obl_1', ?, 'prj_1', 'chk_acc_1', 'acc', '["R1.1"]', 2, 'spec_changed', 'scr_1', ?, ?)`,
      AT,
      resolved ? 'pv_2' : null,
      resolved ? AT : null,
    );
  }
  const complete = () => event(db, 'baseline.phase_complete', { project: 'prj_1', phase_plan: 'plan_1' });
  const approved = () => event(db, 'spec.change_approved', { project: 'prj_1', spec_change_request: 'scr_1' });
  if (approvedBefore) {
    approved();
    complete();
  } else {
    complete();
    approved();
  }
  return db;
}

const post = (db, chk, cand, exit, extra = {}) => transact(db, ENGINE_ACTOR, (tx) => recordCheckResult(tx, { project: 'prj_1', check: chk, candidate: cand, exit_status: exit, ...extra }, {})).check_result;
const register = (db) => transact(db, ENGINE_ACTOR, (tx) => registerDeliveryReplans(tx, { project: 'prj_1' }));
const replans = (db) => db.prepare(`SELECT * FROM work_items WHERE project = 'prj_1' AND kind = 'replan' ORDER BY seq`).all();
const planRow = (db) => db.prepare(`SELECT id, generation, status, active, completed_at, completion_binding, published_at, approved_by FROM phase_plans WHERE id = 'plan_1'`).get();
const stageRow = (db) => db.prepare(`SELECT id, status, integrated_revision FROM stages WHERE id = 'stage_1'`).get();

test('E153 1-3: every phase complete, the corrected check failing on the last candidate: exactly one replan from the change, once across repeated calls; phase 1 untouched', (t) => {
  const db = store(t);
  assert.equal(everyPhaseComplete(db, 'prj_1'), true);
  const plan = planRow(db);
  const stage = stageRow(db);
  // No result yet on the last candidate under the corrected version: wait.
  assert.equal(deliveryVerdict(db, 'prj_1', 'scr_1'), null, 'no result of the corrected check: no decision');
  assert.deepEqual(register(db), [], 'nothing registered while the corrected check has no result');
  // A result under the version the obligation was resolved before: not fresh.
  post(db, 'chk_acc_1', 'cand_1', 1, { protected_version: 'pv_1' });
  assert.deepEqual(register(db), [], 'a result under the earlier protected version is not the corrected check\'s');
  // Not established: unknown, never failing.
  post(db, 'chk_acc_2', 'cand_1', null, { execution_established: false });
  assert.equal(deliveryVerdict(db, 'prj_1', 'scr_1'), null, 'a result not established is no verdict');
  assert.deepEqual(register(db), []);
  const failed = post(db, 'chk_acc_2', 'cand_1', 1);
  const verdict = deliveryVerdict(db, 'prj_1', 'scr_1');
  assert.deepEqual(verdict, { verdict: 'failing', candidate: 'cand_1', results: [{ key: 'acc', result: failed.id, state: 'failed' }] });
  const made = register(db);
  assert.equal(made.length, 1, 'one replan');
  const [item] = replans(db);
  assert.equal(item.id, made[0]);
  assert.deepEqual([item.trigger_source, item.trigger_id, item.trigger_generation, item.status], ['spec_change', 'scr_1', 1, 'eligible']);
  assert.deepEqual(JSON.parse(item.subject), { request: 'scr_1' });
  const evidence = JSON.parse(item.trigger_evidence);
  assert.equal(evidence.evidence.request, 'scr_1');
  assert.deepEqual(evidence.delivery.failing, [{ key: 'acc', result: failed.id }]);
  assert.ok(evidence.stale.includes('criterion:R1.1') && evidence.stale.includes('check:acc'), JSON.stringify(evidence.stale));
  // Idempotent: repeated calls, even with the item done, register none.
  assert.deepEqual(register(db), []);
  db.prepare(`UPDATE work_items SET status = 'complete' WHERE id = ?`).run(item.id);
  assert.deepEqual(register(db), [], 'a completed replan of the change is still its one');
  db.prepare(`UPDATE work_items SET status = 'parked' WHERE id = ?`).run(item.id);
  assert.deepEqual(register(db), []);
  assert.equal(replans(db).length, 1, 'exactly one replan');
  assert.deepEqual(planRow(db), plan, 'phase 1\'s row unchanged');
  assert.deepEqual(stageRow(db), stage, 'its stage unchanged');
});

test('E153 (e): the corrected check passing on the last candidate registers nothing; a text-only change (no obligation) registers nothing', (t) => {
  const db = store(t);
  post(db, 'chk_acc_2', 'cand_1', 0);
  assert.equal(deliveryVerdict(db, 'prj_1', 'scr_1').verdict, 'passing');
  assert.deepEqual(register(db), []);
  assert.deepEqual(register(db), []);
  assert.deepEqual(replans(db), []);

  const text = store(t, { obligation: false });
  post(text, 'chk_acc_2', 'cand_1', 1);
  assert.equal(deliveryVerdict(text, 'prj_1', 'scr_1'), null, 'no obligation: no verdict');
  assert.deepEqual(register(text), []);
  assert.deepEqual(replans(text), []);
});

test('E153: the last candidate is the newest; an unresolved obligation, an open phase, a replan under way, or an approval before the last completion register nothing', (t) => {
  // The newest candidate decides: failing on cand_1, passing on cand_2.
  const newer = store(t);
  post(newer, 'chk_acc_2', 'cand_1', 1);
  candidate(newer, 'cand_2', 2, B);
  assert.equal(deliveryVerdict(newer, 'prj_1', 'scr_1'), null, 'the newest candidate has no result yet');
  post(newer, 'chk_acc_2', 'cand_2', 0);
  assert.equal(deliveryVerdict(newer, 'prj_1', 'scr_1').verdict, 'passing');
  assert.deepEqual(register(newer), []);

  const unresolved = store(t, { resolved: false });
  post(unresolved, 'chk_acc_2', 'cand_1', 1);
  assert.deepEqual(register(unresolved), [], 'the correction not yet applied: wait');

  const open = store(t);
  post(open, 'chk_acc_2', 'cand_1', 1);
  open.prepare(
    `INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, generation, active, status, published_at) VALUES ('plan_2', ?, 'prj_1', 2, ?, 'plan2.json', 1, 1, 'published', ?)`,
  ).run(AT, A, AT);
  assert.equal(everyPhaseComplete(open, 'prj_1'), false);
  assert.deepEqual(register(open), [], 'a phase open: §4.5\'s own replan rule, not this one');

  const roadmap2 = store(t);
  post(roadmap2, 'chk_acc_2', 'cand_1', 1);
  roadmap2.prepare(
    `INSERT INTO roadmap_revisions (id, created_at, project, version, git_path, git_blob, phases, approved_by, approved_at) VALUES ('rm_2', ?, 'prj_1', 2, '.surety/roadmap/roadmap.json', 'rb2', ?, 'human', ?)`,
  ).run(AT, JSON.stringify([{ number: 1, requirement_ids: ['R1'], modules: [], depends_on: [] }, { number: 2, requirement_ids: [], modules: [], depends_on: [] }]), AT);
  assert.equal(everyPhaseComplete(roadmap2, 'prj_1'), false, 'a roadmap phase with no completed plan');
  assert.deepEqual(register(roadmap2), []);

  const busy = store(t);
  post(busy, 'chk_acc_2', 'cand_1', 1);
  busy.prepare(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, depends_on, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold, chain)
     VALUES ('wi_rp', ?, 'prj_1', 9, 'replan', '{}', 'eligible', '[]', 'test', 'other', 1, 0, 0, 0, 0, 0)`,
  ).run(AT);
  assert.deepEqual(register(busy), [], 'another replan under way: wait for it');

  const before = store(t, { approvedBefore: true });
  post(before, 'chk_acc_2', 'cand_1', 1);
  assert.deepEqual(register(before), [], 'approved before the last phase completed: that phase\'s to meet');
});

test('E153, the driver\'s ruling: a completed phase whose check a later change makes fail stays complete for the dependency clause; a regression with no change does not; a phase never completed is not complete', (t) => {
  const db = store(t);
  post(db, 'chk_other', 'cand_1', 0);
  post(db, 'chk_acc_2', 'cand_1', 1);
  assert.deepEqual(phasesNotHeld(db, 'prj_1'), {}, 'acc fails under a change approved after the completion: phase 1 still held');
  const facts = bundleBaselineFacts(db, { project: 'prj_1', head: A, withPlan: true });
  assert.deepEqual(facts.baseline.completed_phases, [1], 'a delivery phase may depend on phase 1');

  // The same failure with no later change (the obligation's request
  // approved as the binding's own version): a regression (D6 §5.8).
  const regression = store(t);
  regression.prepare(`UPDATE spec_change_requests SET approved_revision = 'spec_1' WHERE id = 'scr_1'`).run();
  post(regression, 'chk_other', 'cand_1', 0);
  post(regression, 'chk_acc_2', 'cand_1', 1);
  assert.deepEqual(phasesNotHeld(regression, 'prj_1'), { 1: ['failed: acc on cand_1'] }, 'a regression with no later change still blocks the clause');
  assert.deepEqual(bundleBaselineFacts(regression, { project: 'prj_1', head: A, withPlan: true }).baseline.completed_phases, []);

  // Another check failing alongside the changed one is still read.
  const other = store(t);
  post(other, 'chk_acc_2', 'cand_1', 1);
  post(other, 'chk_other', 'cand_1', 1);
  assert.deepEqual(phasesNotHeld(other, 'prj_1'), { 1: ['failed: other on cand_1'] }, 'only the changed check is not read against the phase');

  // A phase never completed is never complete for the clause.
  const never = store(t);
  never.prepare(`UPDATE phase_plans SET status = 'published', completed_at = NULL, completion_binding = NULL WHERE id = 'plan_1'`).run();
  post(never, 'chk_acc_2', 'cand_1', 1);
  assert.deepEqual(bundleBaselineFacts(never, { project: 'prj_1', head: A, withPlan: true }).baseline.completed_phases, []);
});
