// Developer tests for D6 (DECISIONS item 57; the owner's ruling of
// 2026-11-26: "Bind observations about an implementation to the candidate
// inspected. Bind missing check coverage to the applicable plan and spec
// revision. Reserve project-wide findings for evidence that actually
// applies across versions. When a replan parks, surface the dependency
// immediately and keep the obsolete task out of dispatch. Elapsed time
// alone must never release it. Re-evaluate it when the plan is approved,
// replaced, or abandoned."): findings.ts recordReport's binding, gates.ts
// planFindingApplies and closePlanFindings, runs.ts heldByPlan, the work
// read's held_by, the replan's blocker evidence, and plan/phase.ts's
// plan_abandoned retirement. Against a scratch store, foreign keys off.

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
const { recordReport } = await import(join(dist, 'store', 'transitions', 'findings.js'));
const { planFindingApplies, closePlanFindings, findingApplies } = await import(join(dist, 'store', 'transitions', 'gates.js'));
const { heldByPlan, dispatchBlocker } = await import(join(dist, 'store', 'transitions', 'runs.js'));
const { readWork } = await import(join(dist, 'store', 'projections.js'));
const { retireObsoleteGapAuthorings } = await import(join(dist, 'plan', 'phase.js'));
const { raiseQuestion } = await import(join(dist, 'store', 'transitions', 'queue.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });
const AT = '2026-11-26T00:00:00.000Z';
const R1 = 'a'.repeat(40);
const R2 = 'b'.repeat(40);

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
  run(`INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management, mode) VALUES ('prj_1', ?, 'p', 'T1', '/repo', 'main', 'spec_ready', 'registered', '{}', 'rapid_prototype')`, AT);
  run(`INSERT INTO spec_revisions (id, created_at, project, version, git_path, git_blob, semantic_digest, approved_by, approved_at) VALUES ('sr_1', ?, 'prj_1', 1, 'spec.md', 'b', 'd', 'human', ?)`, AT, AT);
  run(`INSERT INTO spec_revisions (id, created_at, project, version, git_path, git_blob, semantic_digest, approved_by, approved_at) VALUES ('sr_2', ?, 'prj_1', 2, 'spec.md', 'b2', 'd2', 'human', ?)`, AT, AT);
  run(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, prepared_against_spec, status, active) VALUES ('pp_1', ?, 'prj_1', 1, ?, 'p1', 'sr_1', 'completed', 1)`, AT, R1);
  run(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, prepared_against_spec, status, active) VALUES ('pp_2', ?, 'prj_1', 2, ?, 'p2', 'sr_2', 'published', 1)`, AT, R1);
  run(`INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress) VALUES ('cand_1', ?, 'prj_1', 1, ?, 'l', ?, 'engine_cadence', 'developing')`, AT, R1, AT);
  run(`INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress) VALUES ('cand_2', ?, 'prj_1', 2, ?, 'l', ?, 'engine_cadence', 'developing')`, AT, R2, AT);
  // Phase 1's stage is in both candidates; phase 2's only in cand_2.
  run(`INSERT INTO stages (id, created_at, project, phase_plan, number, goal, modules, requirement_ids, implements, status, integrated_revision) VALUES ('st_1', ?, 'prj_1', 'pp_1', 1, 'g', '[]', '[]', '[]', 'integrated', ?)`, AT, R1);
  run(`INSERT INTO stages (id, created_at, project, phase_plan, number, goal, modules, requirement_ids, implements, status, integrated_revision) VALUES ('st_2', ?, 'prj_1', 'pp_2', 1, 'g', '[]', '[]', '[]', 'integrated', ?)`, AT, R2);
  run(`INSERT INTO revision_ancestry (created_at, project, ancestor, descendant, is_ancestor) VALUES (?, 'prj_1', ?, ?, 1)`, AT, R1, R2);
  let seq = 0;
  const item = (id, kind, subject, { trigger_source = 'test', trigger_id = id, status = 'executing', evidence = null, blocker = null } = {}) =>
    run(
      `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold, trigger_evidence, blocker)
       VALUES (?, ?, 'prj_1', ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, 0, ?, ?)`,
      id,
      AT,
      ++seq,
      kind,
      JSON.stringify(subject),
      status,
      trigger_source,
      trigger_id,
      evidence === null ? null : JSON.stringify(evidence),
      blocker === null ? null : JSON.stringify(blocker),
    );
  const report = (id, wi, findings) =>
    run(
      `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined, result_value, outcome)
       VALUES (?, ?, 'prj_1', ?, ?, 'verifier', 'one_shot', 'ended', 'scripted', '1', 'm', ?, ?, 0, ?, 'completed')`,
      id,
      AT,
      ++seq,
      wi,
      R1,
      AT,
      JSON.stringify({ report: { findings } }),
    );
  return { db, run, item, report };
}

const findingsOf = (db, run) => db.prepare('SELECT * FROM findings WHERE source_run = ? ORDER BY seq').all(run);
const record = (db, run) => transact(db, ENGINE_ACTOR, (tx) => recordReport(tx, { run }));
const DEPLOYMENT = (candidate) => ({ deployment: { gate: 'alpha_authorize', evaluation: 'ge_1', candidate, environment: 'local', targets: null, missing: { kinds: [], criteria: ['R5.5'], areas: [] }, requested_by: 'policy' } });
const F = { category: 'defect', severity: 'high', message: 'm' };

test('(a) a deployment-gap authoring binds its implementation finding to the candidate its evidence names; it applies to that candidate and its descendants only', (t) => {
  const s = store(t);
  s.item('wi_gap', 'check_authoring', { phase_plan: 'pp_1' }, { trigger_source: 'authoring_gap', trigger_id: 'pp_1', evidence: DEPLOYMENT('cand_1') });
  s.report('run_gap', 'wi_gap', [F]);
  record(s.db, 'run_gap');
  const [f] = findingsOf(s.db, 'run_gap');
  assert.deepEqual([f.scope, f.candidate, f.subject_id], ['candidate', 'cand_1', 'cand_1'], 'never project');
  const c1 = s.db.prepare(`SELECT * FROM candidates WHERE id = 'cand_1'`).get();
  assert.equal(findingApplies(s.db, f, c1), true);
  // A sibling built apart (no recorded lineage to cand_1): not applicable.
  s.run(`INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress) VALUES ('cand_3', ?, 'prj_1', 3, ?, 'l2', ?, 'engine_cadence', 'developing')`, AT, 'c'.repeat(40), AT);
  assert.equal(findingApplies(s.db, f, s.db.prepare(`SELECT * FROM candidates WHERE id = 'cand_3'`).get()), false);
});

test("(b) a phase plan's own check authoring naming no candidate: the finding is scope plan, bound to the plan and its spec revision; it applies to that plan's candidates, not an earlier plan's; it is closed plan_replaced when the plan is replaced", (t) => {
  const s = store(t);
  s.item('wi_auth', 'check_authoring', { phase_plan: 'pp_2' }, { trigger_source: 'phase', trigger_id: 'pp_2' });
  s.report('run_auth', 'wi_auth', [F]);
  record(s.db, 'run_auth');
  const [f] = findingsOf(s.db, 'run_auth');
  assert.deepEqual([f.scope, f.candidate, f.bound_plan, f.bound_spec_revision, f.subject_id], ['plan', null, 'pp_2', 'sr_2', 'pp_2']);
  assert.deepEqual(JSON.parse(f.scope_reason), { reported_scope: 'candidate', stored_scope: 'plan', reason: 'phase_authoring_names_no_candidate', stated: null });
  const cand = (id) => s.db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
  assert.equal(planFindingApplies(s.db, f, cand('cand_2')), true, "pp_2's candidate");
  assert.equal(planFindingApplies(s.db, f, cand('cand_1')), false, "phase 1's candidate: none of pp_2's stages");
  // A later plan's candidate (phase 3's stage integrated after): not this plan's.
  const R3 = 'd'.repeat(40);
  s.run(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, status, active) VALUES ('pp_3', ?, 'prj_1', 3, ?, 'p3', 'published', 1)`, AT, R2);
  s.run(`INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress) VALUES ('cand_4', ?, 'prj_1', 4, ?, 'l', ?, 'engine_cadence', 'developing')`, AT, R3, AT);
  s.run(`INSERT INTO stages (id, created_at, project, phase_plan, number, goal, modules, requirement_ids, implements, status, integrated_revision) VALUES ('st_3', ?, 'prj_1', 'pp_3', 1, 'g', '[]', '[]', '[]', 'integrated', ?)`, AT, R3);
  s.run(`INSERT INTO revision_ancestry (created_at, project, ancestor, descendant, is_ancestor) VALUES (?, 'prj_1', ?, ?, 1), (?, 'prj_1', ?, ?, 1)`, AT, R1, R3, AT, R2, R3);
  assert.equal(planFindingApplies(s.db, f, cand('cand_4')), false, "a later plan's candidate");
  // Not closed while the plan stands; closed once it is replaced.
  assert.deepEqual(transact(s.db, ENGINE_ACTOR, (tx) => closePlanFindings(tx, 'prj_1')), []);
  s.run(`UPDATE phase_plans SET status = 'replaced', active = 0, replaced_by = 'pp_2b' WHERE id = 'pp_2'`);
  assert.deepEqual(transact(s.db, ENGINE_ACTOR, (tx) => closePlanFindings(tx, 'prj_1')), [f.id]);
  const closed = s.db.prepare('SELECT * FROM findings WHERE id = ?').get(f.id);
  assert.equal(closed.status, 'resolved');
  assert.equal(JSON.parse(closed.resolution_verification).cause, 'plan_replaced');
  const ev = JSON.parse(s.db.prepare(`SELECT payload FROM events WHERE type = 'finding.resolved'`).get().payload);
  assert.equal(ev.cause, 'plan_replaced');
});

test('(b) abandoned: the iteration that published the plan discarded closes its plan findings', (t) => {
  const s = store(t);
  s.run(`INSERT INTO prototype_iterations (id, created_at, project, seq, mode, status, limits_json, phase_plan) VALUES ('it_2', ?, 'prj_1', 2, 'rapid_prototype', 'discarded', '{}', 'pp_2')`, AT);
  s.item('wi_auth', 'check_authoring', { phase_plan: 'pp_2' }, { trigger_source: 'phase', trigger_id: 'pp_2' });
  s.report('run_auth', 'wi_auth', [F]);
  record(s.db, 'run_auth');
  const [f] = findingsOf(s.db, 'run_auth');
  assert.deepEqual(transact(s.db, ENGINE_ACTOR, (tx) => closePlanFindings(tx, 'prj_1')), [f.id]);
  assert.match(JSON.parse(s.db.prepare('SELECT resolution_verification FROM findings WHERE id = ?').get(f.id).resolution_verification).reason, /abandoned/);
});

test('(c) a role reporting project scope keeps it, its stated reason recorded; a correction naming no candidate keeps the E180 normalization', (t) => {
  const s = store(t);
  s.item('wi_auth', 'check_authoring', { phase_plan: 'pp_2' }, { trigger_source: 'phase', trigger_id: 'pp_2' });
  s.report('run_p', 'wi_auth', [{ ...F, scope: 'project', scope_reason: 'the shared print stylesheet is in every version' }]);
  record(s.db, 'run_p');
  const [p] = findingsOf(s.db, 'run_p');
  assert.equal(p.scope, 'project');
  assert.deepEqual(JSON.parse(p.scope_reason), { reported_scope: 'project', stored_scope: 'project', reason: 'the shared print stylesheet is in every version' });
  s.item('wi_cc', 'check_correction', { finding: 'fnd_x' }, { trigger_source: 'check_correction', trigger_id: 'fnd_x' });
  s.report('run_cc', 'wi_cc', [F]);
  record(s.db, 'run_cc');
  const [c] = findingsOf(s.db, 'run_cc');
  assert.equal(c.scope, 'project');
  assert.equal(JSON.parse(c.scope_reason).reason, 'no_source_candidate');
  const raised = JSON.parse(s.db.prepare(`SELECT payload FROM events WHERE type = 'finding.raised' AND json_extract(subject, '$.finding') = ?`).get(c.id).payload);
  assert.deepEqual([raised.reported_scope, raised.scope_reason], ['candidate', 'no_source_candidate']);
});

test('(d, e, f) a parked replan holds the gap item, served at once in the work read and the blocker evidence; no time releases it; a discarded iteration retires it plan_abandoned', (t) => {
  const s = store(t);
  s.run(`INSERT INTO prototype_iterations (id, created_at, project, seq, mode, status, limits_json) VALUES ('it_2', ?, 'prj_1', 2, 'rapid_prototype', 'building', '{}')`, '2026-11-25T00:00:00.000Z');
  // pp_2 owes nothing of R5.5 (no requirement R5): a plan under way may.
  s.item('wi_replan', 'replan', { phase_plan: 'pp_1' }, { status: 'parked', blocker: { reason: 'repairs_exhausted', raised_at: AT, decision: null } });
  s.item('wi_gap', 'check_authoring', { phase_plan: 'pp_1' }, { trigger_source: 'authoring_gap', trigger_id: 'pp_1', status: 'eligible', evidence: DEPLOYMENT('cand_1') });
  const d = transact(s.db, ENGINE_ACTOR, (tx) => raiseQuestion(tx, { project: 'prj_1', kind: 'blocker', subjectType: 'work_item', subjectId: 'wi_replan' }));
  assert.ok(d, 'the replan\'s blocker question');
  const manifest = JSON.parse(d.dependency_manifest);
  assert.deepEqual(manifest.evidence.held_dependents, [{ work_item: 'wi_gap', kind: 'check_authoring', criteria: ['R5.5'] }], 'the blocker question lists the held item');
  const gap = s.db.prepare(`SELECT * FROM work_items WHERE id = 'wi_gap'`).get();
  assert.deepEqual(heldByPlan(s.db, gap), { replan: 'wi_replan', bundle: null, status: 'parked', decision: d.id });
  assert.match(dispatchBlocker(s.db, gap, { check: false }), /depends on the plan under way: replan wi_replan is parked/);
  const served = readWork(s.db, { project: 'prj_1' }).work_items.find((w) => w.id === 'wi_gap');
  assert.deepEqual(served.held_by, { replan: 'wi_replan', bundle: null, status: 'parked', decision: d.id });
  assert.equal(readWork(s.db, { project: 'prj_1' }).work_items.find((w) => w.id === 'wi_replan').held_by, undefined, 'only on the held item');
  // Retirement while the iteration stands: nothing.
  assert.deepEqual(transact(s.db, ENGINE_ACTOR, (tx) => retireObsoleteGapAuthorings(tx, 'prj_1')), []);
  // Discarded: cancelled superseded, plan_abandoned, never dispatched.
  s.run(`UPDATE prototype_iterations SET status = 'discarded', outcome_reason = 'discarded by the owner' WHERE id = 'it_2'`);
  assert.deepEqual(transact(s.db, ENGINE_ACTOR, (tx) => retireObsoleteGapAuthorings(tx, 'prj_1')), ['wi_gap']);
  const after = s.db.prepare(`SELECT status, end_cause FROM work_items WHERE id = 'wi_gap'`).get();
  assert.deepEqual(after, { status: 'cancelled', end_cause: 'superseded' });
  const cancelled = JSON.parse(s.db.prepare(`SELECT payload FROM events WHERE type = 'work.cancelled' AND json_extract(subject, '$.work_item') = 'wi_gap'`).get().payload);
  assert.equal(cancelled.reason_code, 'plan_abandoned');
  assert.match(cancelled.reason, /^plan_abandoned: iteration 2/);
  assert.equal(s.db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE work_item = 'wi_gap'`).get().n, 0);
});
