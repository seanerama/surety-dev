// Developer tests for the two engine defects behind the M442 (c)
// intermittent (the driver's diagnosis, 2026-10-17):
// 1. a stage row holds its `depends_on` as stage ids (registerPlan), the
//    plan schema (B.5) requires stage numbers: every package that renders a
//    stage to an agent renders numbers, and a kept stage copied as built
//    from the replan package passes the schema and the check;
// 2. the phase waits (the driver's ruling, under Sean's delegation): a phase
//    whose last stage is done does not complete while a replacement of its
//    open generation is pending; the plan read names it; the phase completes
//    once the replacement is retired, or on the generation it publishes.

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
const { registerPlan } = await import(join(dist, 'store', 'transitions', 'work.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { executionInputsDigest } = await import(join(dist, 'plan', 'check.js'));
const { parsePhasePlan } = await import(join(dist, 'plan', 'schemas.js'));
const { replanFacts, replanFiles } = await import(join(dist, 'plan', 'replan-package.js'));
const { requestEarlyReplan, pendingReplacement } = await import(join(dist, 'plan', 'replace.js'));
const { phaseStep } = await import(join(dist, 'plan', 'phase.js'));
const { planView } = await import(join(dist, 'plan', 'reads.js'));
const { dependsOnNumbers } = await import(join(dist, 'plan', 'active.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });

const AT = '2026-10-17T00:00:00.000Z';

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
     VALUES ('prj_1', ?, 'p', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
  ).run(AT);
  return db;
}

const stage = (number, over = {}) => ({
  number,
  goal: `stage ${number}`,
  tasks: ['t'],
  modules: ['api'],
  implements: [],
  adrs: [],
  depends_on: [],
  validation: { criteria: [], kinds: ['acceptance', 'smoke'], sensitive_areas: [] },
  integration_obligations: [],
  ...over,
});
const input = (s) => ({ ...s, execution_inputs_digest: executionInputsDigest(s) });
const publish = (db, stages, replaces = null) =>
  transact(db, ENGINE_ACTOR, (tx) =>
    registerPlan(
      tx,
      { project: 'prj_1', baseRevision: 'h', authority: { kind: 'publication', by: 'engine:plan_check', bundle: replaces ? 'b2' : 'b1', check: null, routing: 'registered', replaces }, phase: 1, stages: stages.map(input), prepared: { spec: null, architecture: null, roadmap: null } },
      {},
    ),
  );

// ---- 1. depends_on as stage numbers ----------------------------------------------------------

test('the replan package renders a stage\'s depends_on as stage numbers, never the ids the row holds; copied as built it passes the schema and the kept-stage check', (t) => {
  const db = store(t);
  const s = [stage(1), stage(2, { depends_on: [1] }), stage(3, { depends_on: [1, 2] })];
  const first = publish(db, s);
  const [s1, s2, s3] = first.stages;
  // The defect's precondition: the row holds ids.
  assert.deepEqual(JSON.parse(db.prepare('SELECT depends_on FROM stages WHERE id = ?').get(s3.id).depends_on), [s1.id, s2.id], 'the fixture is live: the row holds stage ids');
  db.prepare(`UPDATE stages SET status = 'integrated', integrated_revision = 'r1' WHERE id IN (?, ?)`).run(s1.id, s2.id);
  const id = transact(db, ENGINE_ACTOR, (tx) => requestEarlyReplan(tx, { project: 'prj_1', source: 'spec_change', id: 'scr_1', evidence: { request: 'scr_1' }, stale: ['criterion:R1.1'] }));
  const w = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id);
  const facts = replanFacts(db, w);
  assert.deepEqual(
    facts.open_plan.stages.map((x) => [x.number, x.depends_on]),
    [
      [1, []],
      [2, [1]],
      [3, [1, 2]],
    ],
    'numbers, as the plan schema has them',
  );
  const file = replanFiles(facts).find((f) => f.path === 'open-plan.json');
  assert.ok(file && !file.content.includes('stage_'), 'open-plan.json names no stage id in depends_on');
  // An Architect copying the inputs as built writes a plan the schema reads.
  const copied = facts.open_plan.stages.map((x) => ({ number: x.number, goal: x.goal, tasks: x.tasks, modules: x.modules, implements: x.implements, adrs: x.adrs, depends_on: x.depends_on, validation: x.validation, integration_obligations: x.integration_obligations }));
  const text = JSON.stringify({ phase: 1, prepared_against: { spec_version: 1, architecture_version: 1, roadmap_version: 1, revision: 'a'.repeat(40) }, stages: copied, conformance: 'within_baseline' });
  const parsed = parsePhasePlan(text, '.surety/phases/phase-1.json', 1);
  assert.equal(parsed.ok, true, `the schema reads the copied plan (${JSON.stringify(parsed.finding ?? null)})`);
  // And the kept stages listed exactly as built are kept, not duplicates.
  for (const k of [1, 2]) {
    const listed = parsed.value.stages.find((x) => x.number === k);
    const row = db.prepare('SELECT execution_inputs_digest FROM stages WHERE phase_plan = ? AND number = ?').get(first.plan.id, k);
    assert.equal(executionInputsDigest(listed), row.execution_inputs_digest, `kept stage ${k} copied as built has the digest it was built with`);
  }
});

test('dependsOnNumbers: ids read back to numbers (a kept stage on an earlier row included); numbers kept; an unknown id left as stored, never dropped', (t) => {
  const db = store(t);
  const first = publish(db, [stage(1), stage(2, { depends_on: [1] })]);
  const [s1] = first.stages;
  assert.deepEqual(dependsOnNumbers(db, JSON.stringify([s1.id, 2, 'stage_gone'])), [1, 2, 'stage_gone']);
  assert.deepEqual(dependsOnNumbers(db, null), []);
  assert.deepEqual(dependsOnNumbers(db, '[]'), []);
});

test('GET …/plan states a stage\'s depends_on as stage numbers, an entry naming no stage as stored, never dropped (E163 item 7)', (t) => {
  const db = store(t);
  const first = publish(db, [stage(1), stage(2, { depends_on: [1] })]);
  const [s1, s2] = first.stages;
  db.prepare('UPDATE stages SET depends_on = ? WHERE id = ?').run(JSON.stringify([s1.id, 'stage_gone']), s2.id);
  const view = planView(db, { project: 'prj_1' });
  assert.deepEqual(
    view.plan.stages.map((x) => [x.number, x.depends_on]),
    [
      [1, []],
      [2, [1, 'stage_gone']],
    ],
  );
});

// ---- 2. the phase waits for a pending replacement --------------------------------------------

// A T1 phase at its completion step: every stage integrated with its work
// complete, the phase's nominated candidate, an effective protected version
// and a satisfied phase evaluation on the plan's generation.
function phaseAtCompletion(db, plan, generation) {
  db.prepare(`UPDATE phase_plans SET authoring_ready_at = ?, verification = ? WHERE id = ?`).run(AT, JSON.stringify({ nominated_revision: 'rev_1', at: AT }), plan);
  if (!db.prepare(`SELECT 1 FROM protected_versions WHERE id = 'pv_1'`).get()) {
    db.prepare(
      `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots)
       VALUES ('pv_1', ?, 'prj_1', 1, 'fp', 'initial', 'human', 'human', ?, 1, ?, '[]')`,
    ).run(AT, AT, AT);
    db.prepare(
      `INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress)
       VALUES ('cand_1', ?, 'prj_1', 1, 'rev_1', 'lin_1', ?, 'engine_cadence', 'developing')`,
    ).run(AT, AT);
  }
  db.prepare(
    `INSERT INTO gate_evaluations (id, created_at, project, scope, candidate, gate_kind, computed_at, inputs_hash, inputs_snapshot, check_states, outcome, reasons, satisfiers, stale, phase_plan, plan_generation)
     VALUES (?, ?, 'prj_1', '{}', 'cand_1', 'phase', ?, 'h', '{}', '{}', 'satisfied', '[]', '[]', 0, ?, ?)`,
  ).run(`ge_${plan}`, AT, AT, plan, generation);
}

function stagesDone(db, stages) {
  for (const s of stages) {
    db.prepare(`UPDATE stages SET status = 'integrated', integrated_revision = 'rev_1' WHERE id = ?`).run(s.id);
    if (s.work_item) db.prepare(`UPDATE work_items SET status = 'complete' WHERE id = ?`).run(s.work_item);
  }
}

const step = (db) => transact(db, ENGINE_ACTOR, (tx) => phaseStep(tx, { project: 'prj_1' }));
const planRow = (db, id) => db.prepare('SELECT id, status, active, generation, completed_at FROM phase_plans WHERE id = ?').get(id);

test('the fixture is live: with no replacement pending, a phase at its completion step completes', (t) => {
  const db = store(t);
  const first = publish(db, [stage(1), stage(2, { depends_on: [1] })]);
  stagesDone(db, first.stages);
  phaseAtCompletion(db, first.plan.id, 1);
  assert.equal(step(db).completed, first.plan.id);
  assert.equal(planRow(db, first.plan.id).status, 'completed');
});

test('a phase whose last stage is done stays open while a replacement of its generation is pending; the plan read names it; retired, the phase completes', (t) => {
  const db = store(t);
  const first = publish(db, [stage(1), stage(2, { depends_on: [1] })]);
  const replan = transact(db, ENGINE_ACTOR, (tx) => requestEarlyReplan(tx, { project: 'prj_1', source: 'spec_change', id: 'scr_1', evidence: { request: 'scr_1' }, stale: [] }));
  stagesDone(db, first.stages);
  phaseAtCompletion(db, first.plan.id, 1);
  for (const status of ['eligible', 'executing', 'parked']) {
    db.prepare('UPDATE work_items SET status = ? WHERE id = ?').run(status, replan);
    const r = step(db);
    assert.equal(r.completed, null, `held with the replacement ${status}`);
    assert.equal(planRow(db, first.plan.id).completed_at, null, `the phase is open with the replacement ${status}`);
    const held = pendingReplacement(db, 'prj_1', { id: first.plan.id, generation: 1 });
    assert.deepEqual([held?.work_item, held?.status, held?.trigger.source], [replan, status, 'spec_change']);
  }
  const view = planView(db, { project: 'prj_1' });
  assert.equal(view.plan.completion_held_by?.reason, 'replacement_pending', `the plan read names what holds completion (${JSON.stringify(view.plan.completion_held_by)})`);
  assert.equal(view.plan.completion_held_by.work_item, replan);
  // Its run integrated and its proposal awaits the owner: still pending.
  db.prepare(`UPDATE work_items SET status = 'complete' WHERE id = ?`).run(replan);
  db.prepare(`INSERT INTO runs (id, created_at, project, seq, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined, work_item) VALUES ('run_rp', ?, 'prj_1', 9, 'architect', 'one_shot', 'ended', 'scripted', '1', 'opus', 'h', ?, 0, ?)`).run(AT, AT, replan);
  db.prepare(`INSERT INTO plan_bundles (id, created_at, project, run, head, phase_number, blobs, artifacts, versions, status) VALUES ('bnd_r', ?, 'prj_1', 'run_rp', 'h', 1, '{}', '{}', '{}', 'proposed')`).run(AT);
  assert.equal(step(db).completed, null, 'held while its proposal awaits approval');
  assert.equal(pendingReplacement(db, 'prj_1', { id: first.plan.id, generation: 1 })?.bundle, 'bnd_r');
  // Retired by the owner's route: the proposal refused, the item cancelled.
  db.prepare(`UPDATE plan_bundles SET status = 'refused' WHERE id = 'bnd_r'`).run();
  assert.equal(pendingReplacement(db, 'prj_1', { id: first.plan.id, generation: 1 }), null, 'refused with no further generation: nothing pending');
  assert.equal(step(db).completed, first.plan.id, 'the phase completes once nothing replaces it');
  assert.equal(planView(db, { project: 'prj_1' }).plan.completion_held_by, null);
});

test('a replacement pending when the last stage completes publishes; the phase completes on the generation it published, never on the replaced one', (t) => {
  const db = store(t);
  const first = publish(db, [stage(1), stage(2, { depends_on: [1] })]);
  const replan = transact(db, ENGINE_ACTOR, (tx) => requestEarlyReplan(tx, { project: 'prj_1', source: 'spec_change', id: 'scr_1', evidence: { request: 'scr_1' }, stale: [] }));
  stagesDone(db, first.stages);
  phaseAtCompletion(db, first.plan.id, 1);
  assert.equal(step(db).completed, null, 'held: the replacement is pending');
  // The replacement publishes: both stages kept, a new stage 3.
  const second = publish(db, [stage(1), stage(2, { depends_on: [1] }), stage(3, { depends_on: [2] })], { phase_plan: first.plan.id, generation: 1, trigger: { source: 'spec_change', id: 'scr_1', generation: 1 }, evidence: null, stale: null });
  assert.equal(second.plan.generation, 2);
  assert.deepEqual(planRow(db, first.plan.id).status, 'replaced', 'the generation it replaced is never completed');
  // Its run integrated before the publication: its item is complete.
  db.prepare(`UPDATE work_items SET status = 'complete' WHERE id = ?`).run(replan);
  assert.equal(pendingReplacement(db, 'prj_1', { id: second.plan.id, generation: 2 }), null);
  // Its new stage built, the phase completes on generation 2.
  db.prepare(`UPDATE phase_plans SET authoring_ready_at = ?, verification = ? WHERE id = ?`).run(AT, JSON.stringify({ nominated_revision: 'rev_1', at: AT }), second.plan.id);
  assert.equal(step(db).completed, null, 'stage 3 is not built yet');
  stagesDone(db, second.stages);
  phaseAtCompletion(db, second.plan.id, 2);
  assert.equal(step(db).completed, second.plan.id);
  assert.equal(planRow(db, second.plan.id).status, 'completed');
  assert.equal(JSON.parse(db.prepare('SELECT completion_binding FROM phase_plans WHERE id = ?').get(second.plan.id).completion_binding).generation, 2);
});

test('the hold follows the replacement chain: replans A and B both aimed at generation 1; A publishes generation 2 while B is queued; generation 2 does not complete until B ends', (t) => {
  const db = store(t);
  const first = publish(db, [stage(1), stage(2, { depends_on: [1] })]);
  const a = transact(db, ENGINE_ACTOR, (tx) => requestEarlyReplan(tx, { project: 'prj_1', source: 'spec_change', id: 'scr_a', evidence: { request: 'scr_a' }, stale: [] }));
  const b = transact(db, ENGINE_ACTOR, (tx) => requestEarlyReplan(tx, { project: 'prj_1', source: 'spec_change', id: 'scr_b', evidence: { request: 'scr_b' }, stale: [] }));
  stagesDone(db, first.stages);
  // A publishes generation 2, keeping both stages and adding none.
  db.prepare(`UPDATE work_items SET status = 'complete' WHERE id = ?`).run(a);
  const second = publish(db, [stage(1), stage(2, { depends_on: [1] })], { phase_plan: first.plan.id, generation: 1, trigger: { source: 'spec_change', id: 'scr_a', generation: 1 }, evidence: null, stale: null });
  assert.equal(second.plan.generation, 2);
  // B, aimed at generation 1, is still queued (held on its own correction).
  db.prepare(`UPDATE work_items SET status = 'held' WHERE id = ?`).run(b);
  phaseAtCompletion(db, second.plan.id, 2);
  const held = pendingReplacement(db, 'prj_1', { id: second.plan.id, generation: 2 });
  assert.deepEqual([held?.work_item, held?.status], [b, 'held'], 'B, aimed at the generation 2 replaced, holds generation 2');
  assert.equal(step(db).completed, null, 'the phase does not complete under B');
  assert.equal(planView(db, { project: 'prj_1' }).plan.completion_held_by?.work_item, b, 'the plan read names B');
  // B ends (cancelled, or its stale proposal refused): the phase completes.
  db.prepare(`UPDATE work_items SET status = 'cancelled' WHERE id = ?`).run(b);
  assert.equal(step(db).completed, second.plan.id);
});
