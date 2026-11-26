// Developer test for DECISIONS item 57, exception E1: a tightened check
// (one a correction added beside the finding's own, objection 236 option 1)
// failing on a candidate holding an integrated stage, while an open defect
// finding on that candidate covers the criterion, takes no stage send-back:
// the brief's policy registers the finding's fix first, in the recording
// transaction (repair.ts reconcileRepair policyFixFirst), and the fix under
// way holds the stage (fixUnderway, now also by the criterion every failed
// check covers). Without such a finding the stage is sent back as before.
// The fixture is repair-and-findings.test.mjs's, foreign keys off, as a
// rapid prototype at T1.

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
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });

const AT = '2026-11-26T00:00:00.000Z';
const A = 'a'.repeat(40);

function store(t, { policy, prototype = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  run(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
  );
  if (prototype) run(`UPDATE projects SET mode = 'rapid_prototype' WHERE id = 'prj_1'`);
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
  // The iteration's approved brief (spec revision sr_1) and its Verifier's run.
  run(`INSERT INTO spec_revisions (id, created_at, project, version, git_path, git_blob, semantic_digest, approved_by, approved_at) VALUES ('sr_1', ?, 'prj_1', 1, 'spec.md', 'b', 'd', 'human', ?)`, AT, AT);
  run(`INSERT INTO prototype_iterations (id, created_at, project, seq, mode, status, limits_json, brief_spec_revision, brief_decision, approved_at) VALUES ('it_1', ?, 'prj_1', 1, 'rapid_prototype', 'building', '{"prototype_repairs_per_iteration":3}', 'sr_1', NULL, ?)`, AT, AT);
  candidate(db, 'cand_1', 1, A);
  run(`UPDATE candidates SET spec_revision = 'sr_1' WHERE id = 'cand_1'`);
  // acc2: the check a correction added beside acc, covering R1.1 too.
  for (const [id, key, kind, criteria, reqs] of [
    ['chk_acc', 'acc', 'acceptance', '["R1.1"]', '["req_1"]'],
    ['chk_acc2', 'acc2', 'acceptance', '["R1.1"]', '["req_1"]'],
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


const post = (db, check, cand, exit) => transact(db, ENGINE_ACTOR, (tx) => recordCheckResult(tx, { project: 'prj_1', check, candidate: cand, exit_status: exit }, {})).check_result;
const stage = (db) => db.prepare(`SELECT status, repair_attempts FROM work_items WHERE id = 'wi_1'`).get();
const fixes = (db) => db.prepare(`SELECT * FROM work_items WHERE kind = 'fix'`).all();

// The Verifier's finding on cand_1: a defect on R1.1 naming acc, raised by a run of the iteration.
function finding(db) {
  db.prepare(
    `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined, iteration, outcome)
     VALUES ('run_v', ?, 'prj_1', 9, 'wi_v', 'verifier', 'one_shot', 'ended', 'scripted', '1', 'm', ?, ?, 0, 'it_1', 'completed')`,
  ).run(AT, A, AT);
  db.prepare(
    `INSERT INTO findings (id, created_at, project, seq, scope, subject_id, candidate, source_run, source_role, category, message, "check", proposed_severity, effective_severity, severity_history, sensitive_area, status, reevaluations, criterion)
     VALUES ('fnd_1', ?, 'prj_1', 1, 'candidate', 'cand_1', 'cand_1', 'run_v', 'verifier', 'defect', 'the unit prints after the diagrams', 'acc', 'low', 'low', '[]', NULL, 'open', '[]', 'R1.1')`,
  ).run(AT);
}

test('E1: the tightened check fails on the integrated stage while a covering defect finding is open: the policy fix is registered first, no send-back, one fix item', (t) => {
  const db = store(t);
  finding(db);
  post(db, 'chk_acc', 'cand_1', 0);
  post(db, 'chk_smoke', 'cand_1', 0);
  post(db, 'chk_acc2', 'cand_1', 1);
  assert.deepEqual(stage(db), { status: 'verifying', repair_attempts: 0 }, 'the stage is not sent back');
  const f = db.prepare(`SELECT * FROM findings WHERE id = 'fnd_1'`).get();
  assert.deepEqual([f.disposition, f.disposition_authority, f.check], ['fix', 'policy', 'acc2'], 'fixed by policy, bound to the check that reproduced it');
  assert.equal(fixes(db).length, 1, 'one fix item');
  // Reconciled again (a later result, a tick): still held by the fix.
  post(db, 'chk_smoke', 'cand_1', 0);
  assert.deepEqual(stage(db), { status: 'verifying', repair_attempts: 0 });
  assert.equal(fixes(db).length, 1);
});

test('E1: the same failure with no covering finding sends the stage back as today', (t) => {
  const db = store(t);
  post(db, 'chk_acc', 'cand_1', 0);
  post(db, 'chk_smoke', 'cand_1', 0);
  post(db, 'chk_acc2', 'cand_1', 1);
  assert.deepEqual(stage(db), { status: 'eligible', repair_attempts: 1 });
  assert.equal(fixes(db).length, 0);
});

test('E1: a planned project with the same covering finding: no policy, the stage sent back as today', (t) => {
  const db = store(t, { prototype: false });
  finding(db);
  post(db, 'chk_acc2', 'cand_1', 1);
  assert.deepEqual(stage(db), { status: 'eligible', repair_attempts: 1 });
  assert.equal(db.prepare(`SELECT disposition FROM findings WHERE id = 'fnd_1'`).get().disposition, null);
});
