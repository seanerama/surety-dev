// Developer tests for DECISIONS item 55 (production 2026-11-25; M634): at
// T1 the phase nominates the integration head once; a fix integrated after
// that nomination nominates a candidate that supersedes it. The phase gate
// on the superseded candidate names CANDIDATE_SUPERSEDED and is never
// satisfied, so the phase step must follow `superseded_by` to the newest
// candidate, keep the one nomination as recorded, and record the follow.

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
const { phaseStep, registerPhaseAtNomination } = await import(join(dist, 'plan', 'phase.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });

const AT = '2026-11-25T00:00:00.000Z';

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
  db.prepare(
    `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots)
     VALUES ('pv_1', ?, 'prj_1', 1, 'fp', 'initial', 'human', 'human', ?, 1, ?, '[]')`,
  ).run(AT, AT, AT);
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

// A T1 phase whose stages are integrated with their work complete, its one
// nomination recorded for rev_1 and candidate cand_1 nominated for it.
function phaseNominated(db) {
  const { plan, stages } = transact(db, ENGINE_ACTOR, (tx) =>
    registerPlan(
      tx,
      { project: 'prj_1', baseRevision: 'h', authority: { kind: 'publication', by: 'engine:plan_check', bundle: 'b1', check: null, routing: 'registered', replaces: null }, phase: 1, stages: [stage(1), stage(2, { depends_on: [1] })].map(input), prepared: { spec: null, architecture: null, roadmap: null } },
      {},
    ),
  );
  for (const s of stages) {
    db.prepare(`UPDATE stages SET status = 'integrated', integrated_revision = 'rev_1' WHERE id = ?`).run(s.id);
    if (s.work_item) db.prepare(`UPDATE work_items SET status = 'complete' WHERE id = ?`).run(s.work_item);
  }
  db.prepare(`UPDATE phase_plans SET authoring_ready_at = ?, verification = ? WHERE id = ?`).run(AT, JSON.stringify({ nominated_revision: 'rev_1', at: AT }), plan.id);
  candidate(db, 1, 'engine_cadence');
  return plan.id;
}

function candidate(db, n, by = 'engine_cadence') {
  db.prepare(
    `INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress)
     VALUES (?, ?, 'prj_1', ?, ?, ?, ?, ?, 'developing')`,
  ).run(`cand_${n}`, AT, n, `rev_${n}`, `lin_${n}`, AT, by);
}

// A later nomination superseding the earlier one (finalize.ts: the one change
// a later nomination makes to an earlier candidate).
function supersede(db, from, to) {
  candidate(db, to, 'engine_cadence');
  db.prepare('UPDATE candidates SET superseded_by = ? WHERE id = ?').run(`cand_${to}`, `cand_${from}`);
}

function phaseEvaluation(db, cand, plan, outcome, reasons = []) {
  const id = `ge_${cand}_${db.prepare('SELECT COUNT(*) AS n FROM gate_evaluations').get().n}`;
  db.prepare(
    `INSERT INTO gate_evaluations (id, created_at, project, scope, candidate, gate_kind, computed_at, inputs_hash, inputs_snapshot, check_states, outcome, reasons, satisfiers, stale, phase_plan, plan_generation)
     VALUES (?, ?, 'prj_1', '{}', ?, 'phase', ?, 'h', '{}', '{}', ?, ?, '[]', 0, ?, 1)`,
  ).run(id, AT, cand, AT, outcome, JSON.stringify(reasons), plan);
  return id;
}

const step = (db) => transact(db, ENGINE_ACTOR, (tx) => phaseStep(tx, { project: 'prj_1' }));
const verification = (db, plan) => JSON.parse(db.prepare('SELECT verification FROM phase_plans WHERE id = ?').get(plan).verification);
const phaseEvaluated = (db, cand) => db.prepare(`SELECT COUNT(*) AS n FROM gate_evaluations WHERE candidate = ? AND gate_kind = 'phase'`).get(cand).n;

test('the fixture is live: with no supersession, the phase is evaluated on its nominated candidate and records no follow', (t) => {
  const db = store(t);
  const plan = phaseNominated(db);
  assert.deepEqual(step(db).evaluate, { candidate: 'cand_1', phase_plan: plan });
  assert.deepEqual(verification(db, plan), { nominated_revision: 'rev_1', at: AT });
  phaseEvaluation(db, 'cand_1', plan, 'satisfied');
  assert.equal(step(db).completed, plan);
  assert.equal(JSON.parse(db.prepare('SELECT completion_binding FROM phase_plans WHERE id = ?').get(plan).completion_binding).candidate, 'cand_1');
});

test('item 55: a fix nominated after the phase\'s nomination supersedes its candidate; the phase is evaluated on the superseding candidate and completes there, the nomination kept and the follow recorded', (t) => {
  const db = store(t);
  const plan = phaseNominated(db);
  // The production state: the nominated candidate's phase gate fresh, not
  // satisfied, naming its successor.
  supersede(db, 1, 2);
  phaseEvaluation(db, 'cand_1', plan, 'not_satisfied', [{ code: 'CANDIDATE_SUPERSEDED', subjects: ['cand_2'] }]);
  const due = db.prepare('SELECT nomination_due FROM projects WHERE id = ?').get('prj_1').nomination_due;
  // On the base the step returns nothing at every tick (the stall).
  for (let i = 0; i < 3; i++) assert.deepEqual(step(db).evaluate, { candidate: 'cand_2', phase_plan: plan }, `tick ${i}: the phase gate is due on the superseding candidate`);
  const v = verification(db, plan);
  assert.equal(v.nominated_revision, 'rev_1', 'the one nomination keeps its revision');
  assert.equal(v.at, AT);
  assert.deepEqual([v.followed_candidate, v.followed_revision, typeof v.followed_at], ['cand_2', 'rev_2', 'string']);
  assert.equal(db.prepare('SELECT nomination_due FROM projects WHERE id = ?').get('prj_1').nomination_due, due, 'no second nomination is made');
  const ev = phaseEvaluation(db, 'cand_2', plan, 'satisfied');
  assert.equal(step(db).completed, plan);
  const binding = JSON.parse(db.prepare('SELECT completion_binding FROM phase_plans WHERE id = ?').get(plan).completion_binding);
  assert.deepEqual([binding.candidate, binding.evaluation], ['cand_2', ev]);
  const bound = db.prepare(`SELECT subject FROM events WHERE type = 'phase.completion_bound'`).all();
  assert.equal(bound.length, 1);
  assert.equal(JSON.parse(bound[0].subject).candidate, 'cand_2');
  // Once per binding: a further tick completes nothing again.
  assert.equal(step(db).completed, null);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'phase.completion_bound'`).get().n, 1);
});

test('item 55: two supersessions in a row; the newest is followed and the intermediate gets no phase evaluation', (t) => {
  const db = store(t);
  const plan = phaseNominated(db);
  supersede(db, 1, 2);
  assert.deepEqual(step(db).evaluate, { candidate: 'cand_2', phase_plan: plan });
  supersede(db, 2, 3);
  assert.deepEqual(step(db).evaluate, { candidate: 'cand_3', phase_plan: plan });
  const v = verification(db, plan);
  assert.deepEqual([v.nominated_revision, v.followed_candidate, v.followed_revision], ['rev_1', 'cand_3', 'rev_3']);
  phaseEvaluation(db, 'cand_3', plan, 'satisfied');
  assert.equal(step(db).completed, plan);
  assert.equal(phaseEvaluated(db, 'cand_2'), 0, 'the intermediate candidate has no phase evaluation');
  assert.equal(JSON.parse(db.prepare('SELECT completion_binding FROM phase_plans WHERE id = ?').get(plan).completion_binding).candidate, 'cand_3');
});

test('item 55: the phase scope is registered at the superseding nomination, as at the phase\'s own; never at a candidate already superseded', (t) => {
  const db = store(t);
  const plan = phaseNominated(db);
  transact(db, ENGINE_ACTOR, (tx) => registerPhaseAtNomination(tx, { project: 'prj_1', candidate: 'cand_1' }));
  assert.equal(verification(db, plan).registered_at_nomination, 'cand_1');
  supersede(db, 1, 2);
  // The superseded candidate is no longer the phase's.
  transact(db, ENGINE_ACTOR, (tx) => registerPhaseAtNomination(tx, { project: 'prj_1', candidate: 'cand_1' }));
  assert.equal(verification(db, plan).registered_at_nomination, 'cand_1');
  transact(db, ENGINE_ACTOR, (tx) => registerPhaseAtNomination(tx, { project: 'prj_1', candidate: 'cand_2' }));
  const v = verification(db, plan);
  assert.deepEqual([v.nominated_revision, v.registered_at_nomination, v.followed_candidate], ['rev_1', 'cand_2', 'cand_2']);
});
