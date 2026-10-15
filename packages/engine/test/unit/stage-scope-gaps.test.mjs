// Developer test for the driver's ruling C on the real M443 run: a stage's
// gate takes only the checks of its own scope, so an integration check of
// other requirements gives a stage no integration kind. A plan's stage scope
// gaps are seen at publication (no readiness is inherited over them), and
// the tick's sweep registers one check_authoring follow-up naming them,
// never while an authoring or a correction is pending, never twice for the
// same gaps. Against a scratch store, foreign keys off.

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
const { stageScopeGaps, registerGapAuthoring } = await import(join(dist, 'plan', 'phase.js'));
const { phaseAuthoringText } = await import(join(dist, 'checks', 'guide.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });
const AT = '2026-10-15T00:00:00.000Z';

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  run(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T2', '/repo', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
  );
  run(`INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots, authorized_revision) VALUES ('pv_1', ?, 'prj_1', 1, 'f', 'initial', 'h', 'human', ?, 1, ?, '[]', 'r')`, AT, AT, AT);
  run(`INSERT INTO requirements (id, created_at, project, key, text_ref, criteria, status) VALUES ('req_8', ?, 'prj_1', 'R8', 't', '["R8.1"]', 'active'), ('req_10', ?, 'prj_1', 'R10', 't', '["R10.1"]', 'active')`, AT, AT);
  run(`INSERT INTO modules (id, created_at, project, name, paths) VALUES ('mod_server', ?, 'prj_1', 'server', '["server.mjs"]'), ('mod_page', ?, 'prj_1', 'page', '["public/app/"]')`, AT, AT);
  const check = (id, key, kind, criteria, reqs) =>
    run(
      `INSERT INTO checks (id, created_at, project, protected_version, key, kind, criteria, requirement_ids, required, gate_kinds, definition_path, definition_hash, runner_class)
       VALUES (?, ?, 'prj_1', 'pv_1', ?, ?, ?, ?, 1, '["stage","alpha_authorize"]', 'x', 'h', 'direct')`,
      id,
      AT,
      key,
      kind,
      JSON.stringify(criteria),
      JSON.stringify(reqs),
    );
  for (const [k, kind] of [['smoke', 'smoke'], ['lint', 'security_lint']]) check(`chk_${k}`, k, kind, [], []);
  check('chk_acc8', 'acceptance-server', 'acceptance', ['R8.1'], ['req_8']);
  check('chk_int8', 'integration-server', 'integration', ['R8.1'], ['req_8']);
  check('chk_acc10', 'acceptance-page', 'acceptance', ['R10.1'], ['req_10']);
  run(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, status, active, generation) VALUES ('plan_1', ?, 'prj_1', 1, 'r', 'x', 'published', 1, 1)`, AT);
  const stage = (id, number, reqs, mods) =>
    run(
      `INSERT INTO stages (id, created_at, project, phase_plan, number, goal, modules, requirement_ids, implements, status, depends_on)
       VALUES (?, ?, 'prj_1', 'plan_1', ?, 'g', ?, '[]', ?, 'integrated', '[]')`,
      id,
      AT,
      number,
      JSON.stringify(mods),
      JSON.stringify(reqs),
    );
  stage('stage_2', 2, ['req_8'], ['mod_server']);
  stage('stage_5', 5, ['req_10'], ['mod_page']);
  return { db, run };
}

test("a stage's gate scope takes only its own checks: the integration check of R8 gives stage 5 (R10) no integration kind", (t) => {
  const s = store(t);
  assert.deepEqual(stageScopeGaps(s.db, 'plan_1', 'pv_1'), [{ stage: 5, kinds: ['integration'], criteria: [], areas: [] }]);
});

test('the sweep registers one check_authoring follow-up naming the gaps; not while an authoring or a correction is pending; not again for the same gaps', (t) => {
  const s = store(t);
  s.run(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
     VALUES ('wi_corr', ?, 'prj_1', 1, 'check_correction', '{}', 'parked', 'test', 'x', 1, 0, 0, 0, 0)`,
    AT,
  );
  assert.equal(transact(s.db, ENGINE_ACTOR, (tx) => registerGapAuthoring(tx, { project: 'prj_1' })), 0, 'a parked correction: nothing yet');
  s.run(`UPDATE work_items SET status = 'cancelled' WHERE id = 'wi_corr'`);
  assert.equal(transact(s.db, ENGINE_ACTOR, (tx) => registerGapAuthoring(tx, { project: 'prj_1' })), 1);
  const w = s.db.prepare(`SELECT * FROM work_items WHERE trigger_source = 'authoring_gap'`).get();
  assert.equal(w.kind, 'check_authoring');
  assert.deepEqual(JSON.parse(w.subject), { phase_plan: 'plan_1' });
  assert.deepEqual(JSON.parse(w.trigger_evidence).gaps, [{ stage: 5, kinds: ['integration'], criteria: [], areas: [] }]);
  assert.equal(transact(s.db, ENGINE_ACTOR, (tx) => registerGapAuthoring(tx, { project: 'prj_1' })), 0, 'pending: not twice');
  s.run(`UPDATE work_items SET status = 'complete' WHERE id = ?`, w.id);
  assert.equal(transact(s.db, ENGINE_ACTOR, (tx) => registerGapAuthoring(tx, { project: 'prj_1' })), 0, 'the same gaps after it completed: never asked again for them');
});

test("the follow-up's package names each stage's gaps", () => {
  const text = phaseAuthoringText({ phase_plan: { id: 'plan_1', phase_number: 1, generation: 2 }, stages: [], interfaces: null, architecture: null, environments: null, gaps: [{ stage: 5, kinds: ['integration'], criteria: [], areas: [] }] }).join('\n');
  assert.match(text, /What each stage lacks/);
  assert.match(text, /"stage": 5/);
  assert.match(text, /"integration"/);
});

test("a replacement whose planned obligations the version meets by pooling, but whose stage scope lacks a kind, is not ready as published: it registers its own check_authoring", async (t) => {
  const s = store(t);
  const { registerPlan } = await import(join(dist, 'store', 'transitions', 'work.js'));
  const { executionInputsDigest } = await import(join(dist, 'plan', 'check.js'));
  // Planned obligations of stage 6 (R10): the T2 kinds and R10.1 — every one met by some check of the version, pooled.
  const obligations = [{ scope: { kind: 'stage', number: 6 }, tier: 'T2', criteria: ['R10.1'], kinds: ['acceptance', 'smoke', 'integration', 'security_lint'], sensitive_areas: [] }];
  s.run(
    `INSERT INTO plan_checks (id, created_at, project, phase_number, outcome, reasons, conformance, changes_architecture, changes_adrs, changes_roadmap, changes_goals, roadmap_revision, needs_spec_change, obligations)
     VALUES ('pchk_2', ?, 'prj_1', 1, 'passed', '[]', 'within_baseline', '{}', '{}', '{}', 0, 0, 0, ?)`,
    AT,
    JSON.stringify(obligations),
  );
  const st = { number: 6, goal: 'R10', tasks: ['t'], modules: ['mod_page'], implements: ['req_10'], adrs: [], depends_on: [], validation: { criteria: ['R10.1'], kinds: ['acceptance', 'smoke', 'integration', 'security_lint'], sensitive_areas: [] }, integration_obligations: [] };
  const out = transact(s.db, ENGINE_ACTOR, (tx) =>
    registerPlan(
      tx,
      {
        project: 'prj_1',
        baseRevision: 'h',
        authority: { kind: 'publication', by: 'engine:plan_check', bundle: 'b2', check: 'pchk_2', routing: 'registered', replaces: { phase_plan: 'plan_1', generation: 1, trigger: { source: 'spec_change', id: 'scr_1', generation: 1 }, evidence: null, stale: null } },
        phase: 1,
        stages: [{ ...st, execution_inputs_digest: executionInputsDigest(st) }],
        prepared: { spec: null, architecture: null, roadmap: null },
      },
      {},
    ),
  );
  assert.ok(out.check_authoring, 'its own check_authoring, not readiness inherited');
  assert.equal(s.db.prepare('SELECT authoring_ready_at FROM phase_plans WHERE id = ?').get(out.plan.id).authoring_ready_at, null);
});
