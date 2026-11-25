// Developer tests for the reads that name a held phase and an authoring's
// criteria (DECISIONS item 57 work order 3; row M642; the console's rows
// U56 to U58): the plan read serves the phase's recorded verification and,
// while the open plan's latest phase gate evaluation is fresh and not
// satisfied, `completion_held_by` naming it with the engine's sentence and
// the owner's act where one is open; the work read serves what a gap
// authoring asks for; NOW on a paused project with work that waits only for
// the pause names it and serves `resume`. Against a scratch store.

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
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { planView } = await import(join(dist, 'plan', 'reads.js'));
const { readProject, readWork } = await import(join(dist, 'store', 'projections.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });

const AT = '2026-11-25T12:00:00.000Z';
const A = 'a'.repeat(40);
const VERIFICATION = { nominated_revision: A, at: AT, registered_at_nomination: 'cand_2', followed_candidate: 'cand_3', followed_revision: 'b'.repeat(40), followed_at: AT };

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
    `INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, generation, active, status, published_at, authoring_ready_at, verification, check_authoring)
     VALUES ('plan_2', ?, 'prj_1', 2, ?, 'plan.json', 1, 1, 'published', ?, ?, ?, 'wi_pa')`,
  ).run(AT, A, AT, AT, JSON.stringify(VERIFICATION));
  return db;
}

function evaluation(db, id, candidate, outcome, reasons, stale = 0) {
  db.prepare(
    `INSERT INTO gate_evaluations (id, created_at, project, scope, candidate, gate_kind, computed_at, inputs_hash, inputs_snapshot, check_states, outcome, reasons, satisfiers, stale, phase_plan, plan_generation)
     VALUES (?, ?, 'prj_1', 'scope_1', ?, 'phase', ?, 'h', '{}', '{}', ?, ?, '[]', ?, 'plan_2', 1)`,
  ).run(id, AT, candidate, AT, outcome, JSON.stringify(reasons), stale);
}

function item(db, id, seq, kind, subject, status, source, triggerId, evidence, generation = 1) {
  db.prepare(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, depends_on, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold, chain, trigger_evidence)
     VALUES (?, ?, 'prj_1', ?, ?, ?, ?, '[]', ?, ?, ?, 0, 0, 0, 0, 0, ?)`,
  ).run(id, AT, seq, kind, JSON.stringify(subject), status, source, triggerId, generation, evidence);
}

const plan = (db) => planView(db, { project: 'prj_1' }).plan;

test("the plan read serves the phase's verification as recorded, and a fresh unsatisfied phase gate as the hold, naming the superseder, with no owner act", (t) => {
  const db = store(t);
  assert.deepEqual(plan(db).verification, VERIFICATION);
  assert.equal(plan(db).completion_held_by, null, 'no evaluation yet: nothing holds it');
  evaluation(db, 'gate_1', 'cand_2', 'not_satisfied', [{ code: 'CANDIDATE_SUPERSEDED', subjects: ['cand_3'] }]);
  assert.deepEqual(plan(db).completion_held_by, {
    reason: 'phase_gate_not_satisfied',
    evaluation: 'gate_1',
    candidate: 'cand_2',
    evaluated_at: AT,
    stale: false,
    reasons: [{ code: 'CANDIDATE_SUPERSEDED', subjects: ['cand_3'] }],
    owner_act: null,
    text: 'Phase 2 is held: its gate was evaluated on candidate cand_2, which candidate cand_3 superseded, and is not satisfied (CANDIDATE_SUPERSEDED); no act of the owner clears it.',
  });
});

test("an open decision on a finding the gate names is the owner's act; a stale or satisfied evaluation holds nothing", (t) => {
  const db = store(t);
  evaluation(db, 'gate_1', 'cand_3', 'not_satisfied', [{ code: 'FINDING_BLOCKING', subjects: ['fnd_1'] }]);
  db.prepare(
    `INSERT INTO decisions (id, created_at, project, seq, kind, subject_type, subject_id, semantic_generation, scope, question, options, dependency_manifest, transition_schema_version, preview_hash, evidence, blocked_while_open, raised_at, status) VALUES ('dec_f', ?, 'prj_1', 1, 'finding_disposition', 'finding', 'fnd_1', 1, 'subject', 'q', '[]', '{}', 1, 'h', '[]', '{}', ?, 'open')`,
  ).run(AT, AT);
  const held = plan(db).completion_held_by;
  assert.deepEqual(held.owner_act, { decision: 'dec_f' });
  assert.equal(held.text, "Phase 2 is held: its gate was evaluated on candidate cand_3 and is not satisfied (FINDING_BLOCKING); decision dec_f is the owner's act that clears it.");
  db.prepare(`UPDATE gate_evaluations SET stale = 1 WHERE id = 'gate_1'`).run();
  assert.equal(plan(db).completion_held_by, null, 'stale');
  evaluation(db, 'gate_2', 'cand_3', 'satisfied', []);
  assert.equal(plan(db).completion_held_by, null, 'satisfied');
});

test('the work read serves what a gap authoring asks for, from its recorded evidence, and nothing on other items', (t) => {
  const db = store(t);
  const deployment = { gate: 'alpha_authorize', evaluation: 'gate_a', candidate: 'cand_1', environment: 'alpha', targets: null, missing: { kinds: [], criteria: ['R1.2', 'R3.2'], areas: [] } };
  item(db, 'wi_gap', 1, 'check_authoring', { phase_plan: 'plan_2' }, 'eligible', 'authoring_gap', 'plan_2', JSON.stringify({ deployment }));
  item(db, 'wi_stage', 2, 'check_authoring', { phase_plan: 'plan_2' }, 'eligible', 'authoring_gap', 'plan_2', JSON.stringify({ gaps: [{ stage: 1, kinds: ['integration'], criteria: ['R2.1'], areas: [] }, { stage: 2, kinds: [], criteria: ['R1.1'], areas: [] }] }), 2);
  item(db, 'wi_bad', 3, 'check_authoring', { phase_plan: 'plan_2' }, 'eligible', 'authoring_gap', 'plan_2', '{not json', 3);
  item(db, 'wi_pa', 4, 'check_authoring', { phase_plan: 'plan_2' }, 'eligible', 'phase_plan', 'plan_2', null);
  const byId = Object.fromEntries(readWork(db, { project: 'prj_1' }).work_items.map((w) => [w.id, w]));
  assert.deepEqual(byId.wi_gap.authoring, { phase_plan: 'plan_2', phase_number: 2, criteria: ['R1.2', 'R3.2'], kinds: [] });
  assert.deepEqual(byId.wi_stage.authoring, { phase_plan: 'plan_2', phase_number: 2, criteria: ['R1.1', 'R2.1'], kinds: ['integration'] });
  assert.ok(byId.wi_bad.authoring.criteria.unknown, 'unreadable evidence is unknown, never no criteria');
  assert.equal('authoring' in byId.wi_pa, false);
});

test('NOW on a paused project names the work that waits only for the pause and serves resume; unpaused, no resume', (t) => {
  const db = store(t);
  item(db, 'wi_rp', 1, 'replan', { phase_plan: 'plan_2' }, 'eligible', 'brief', 'it_2', null);
  db.prepare(`UPDATE projects SET paused = 1 WHERE id = 'prj_1'`).run();
  const paused = readProject(db, { project: 'prj_1' }).project.now;
  assert.equal(paused.primary_action, 'resume');
  assert.equal(paused.state, 'idle');
  assert.equal(paused.reason, 'The project is paused: work item wi_rp (replan) is eligible and waits only for the pause. Resume the project to dispatch it.');
  db.prepare(`UPDATE projects SET paused = 0 WHERE id = 'prj_1'`).run();
  const unpaused = readProject(db, { project: 'prj_1' }).project.now;
  assert.notEqual(unpaused.primary_action, 'resume');
});
