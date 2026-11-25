// Developer tests for an obsolete deployment-gap authoring (DECISIONS item
// 57; row M641): Workshop Cut Planner iteration 2. A refused redeploy of the
// previous Alpha (candidate 1) queued a check_authoring (trigger
// authoring_gap) for criteria the approved brief had just added to a
// delivered requirement; it was dispatched while the replan was under way,
// before the phase plan whose stages implement that requirement was
// published, and its Verifier wrote checks against the old candidate. Now
// the item waits while a plan is under way, is never dispatched once a
// published plan owes its criteria, and the phase step retires it
// `superseded` with the engine's reason; a criterion the candidate still
// delivers is asked again, narrowed; kinds alone are never held or retired.
//
// Against a scratch store with the engine's migrations, foreign keys off;
// the production dispatchBlocker and phaseStep. No process, no git.

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
const { dispatchBlocker } = await import(join(dist, 'store', 'transitions', 'runs.js'));
const { phaseStep } = await import(join(dist, 'plan', 'phase.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });

const AT = '2026-11-25T12:00:00.000Z';
const A = 'a'.repeat(40);

function store(t, missing) {
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
     VALUES ('prj_1', ?, 'p', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
  );
  for (const [id, key, criteria] of [['req_1', 'R1', '["R1.1","R1.2"]'], ['req_2', 'R2', '["R2.1","R2.2"]']]) {
    run(`INSERT INTO requirements (id, created_at, project, key, text_ref, status, criteria, sensitive_areas, assigned_phase) VALUES (?, ?, 'prj_1', ?, 'r', 'approved', ?, '[]', 1)`, id, AT, key, criteria);
  }
  // Iteration 1: phase 1 completed on candidate 1, both stages integrated.
  run(
    `INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, generation, active, status, completed_at, completion_binding)
     VALUES ('plan_1', ?, 'prj_1', 1, ?, 'plan.json', 1, 1, 'completed', ?, '{"candidate":"cand_1"}')`,
    AT,
    A,
    AT,
  );
  for (const [id, n, req] of [['stage_1', 1, 'req_1'], ['stage_2', 2, 'req_2']]) {
    run(
      `INSERT INTO stages (id, created_at, project, phase_plan, number, goal, modules, requirement_ids, implements, status, integrated_revision) VALUES (?, ?, 'prj_1', 'plan_1', ?, 'g', '[]', ?, ?, 'verified', ?)`,
      id,
      AT,
      n,
      JSON.stringify([req]),
      JSON.stringify([req]),
      A,
    );
  }
  run(`INSERT INTO lineages (id, created_at, project, branch, started_from_candidate, open) VALUES ('lin_1', ?, 'prj_1', 'main', NULL, 0)`, AT);
  run(
    `INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, nominated_protected_version, progress, held_work)
     VALUES ('cand_1', ?, 'prj_1', 1, ?, 'lin_1', ?, 'engine_cadence', 'pv_1', 'developing', '[]')`,
    AT,
    A,
    AT,
  );
  // Iteration 2's replan, under way.
  item(db, 'wi_rp', 2, 'replan', { phase_plan: 'plan_1' }, 'eligible', 'brief', 'it_2', null);
  // The refused redeploy of candidate 1 queued the gap authoring.
  const deployment = { gate: 'alpha_authorize', evaluation: 'gate_a', candidate: 'cand_1', environment: 'alpha', targets: null, missing, requested_by: 'human' };
  item(db, 'wi_gap', 3, 'check_authoring', { phase_plan: 'plan_1' }, 'eligible', 'authoring_gap', 'plan_1', JSON.stringify({ deployment }));
  return db;
}

function item(db, id, seq, kind, subject, status, source, triggerId, evidence, generation = 1) {
  db.prepare(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, depends_on, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold, chain, trigger_evidence)
     VALUES (?, ?, 'prj_1', ?, ?, ?, ?, '[]', ?, ?, ?, 0, 0, 0, 0, 0, ?)`,
  ).run(id, AT, seq, kind, JSON.stringify(subject), status, source, triggerId, generation, evidence);
}

// The replan ends and publishes phase 2's plan, whose one stage implements
// R1 (not integrated anywhere yet), with its own check authoring.
function publishPhase2(db) {
  db.prepare(`UPDATE work_items SET status = 'complete' WHERE id = 'wi_rp'`).run();
  db.prepare(
    `INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, generation, active, status, published_at, check_authoring)
     VALUES ('plan_2', ?, 'prj_1', 2, ?, 'plan.json', 1, 1, 'published', ?, 'wi_pa')`,
  ).run(AT, A, AT);
  db.prepare(
    `INSERT INTO stages (id, created_at, project, phase_plan, number, goal, modules, requirement_ids, implements, status) VALUES ('stage_3', ?, 'prj_1', 'plan_2', 1, 'g', '[]', '["req_1"]', '["req_1"]', 'planned')`,
  ).run(AT);
  item(db, 'wi_pa', 4, 'check_authoring', { phase_plan: 'plan_2' }, 'eligible', 'phase_plan', 'plan_2', null);
}

const blocker = (db, id) => dispatchBlocker(db, db.prepare('SELECT * FROM work_items WHERE id = ?').get(id), { check: false });
const step = (db) => transact(db, ENGINE_ACTOR, (tx) => phaseStep(tx, { project: 'prj_1' }));
const row = (db, id) => db.prepare('SELECT * FROM work_items WHERE id = ?').get(id);
const cancelled = (db, id) =>
  db
    .prepare(`SELECT * FROM events WHERE type = 'work.cancelled' AND json_extract(subject, '$.work_item') = ?`)
    .all(id)
    .map((e) => JSON.parse(e.payload));

test('the production order: the gap item waits while the replan is under way, is never dispatched once the published plan owes its criteria, and the phase step retires it superseded with the reason, once', (t) => {
  const db = store(t, { kinds: [], criteria: ['R1.2'], areas: [] });
  // On the base it was dispatchable here (the Verifier ran before plan 2).
  const waiting = blocker(db, 'wi_gap');
  assert.ok(waiting?.startsWith('depends on the plan under way: replan wi_rp is eligible'), String(waiting));
  step(db);
  assert.equal(row(db, 'wi_gap').status, 'eligible', 'nothing is retired before a plan owes the criteria');

  publishPhase2(db);
  const superseded = blocker(db, 'wi_gap');
  assert.ok(superseded?.startsWith('Superseded: criteria R1.2 is owed by phase 2'), String(superseded));
  assert.equal(blocker(db, 'wi_pa'), null, "the plan's own authoring is dispatchable");

  step(db);
  const w = row(db, 'wi_gap');
  assert.equal(w.status, 'cancelled');
  assert.equal(w.end_cause, 'superseded');
  const [payload, ...more] = cancelled(db, 'wi_gap');
  assert.equal(more.length, 0);
  assert.equal(payload.cause, 'superseded');
  assert.equal(payload.superseded_by, 'wi_pa');
  assert.deepEqual(payload.kept, []);
  assert.deepEqual(payload.criteria, ['R1.2']);
  assert.equal(payload.phase_plan, 'plan_2');
  assert.equal(payload.candidate, 'cand_1');
  assert.equal(
    payload.reason,
    "Superseded: criteria R1.2 is owed by phase 2's plan plan_2, whose stages implement R1 and are not integrated in candidate cand_1; that plan's own check authoring wi_pa writes their checks. Candidate cand_1's deployment scope no longer lacks it, so this authoring for its deployment gap is not run.",
  );
  // Again (a restart, the next tick): one retirement, nothing revived, no run.
  step(db);
  step(db);
  assert.equal(cancelled(db, 'wi_gap').length, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM work_items WHERE kind = 'check_authoring' AND trigger_source = 'authoring_gap'`).get().n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM runs`).get().n, 0);
});

test('a plan bundle awaiting its approval holds the gap item; an open decision on it is invalidated at its retirement', (t) => {
  const db = store(t, { kinds: [], criteria: ['R1.2'], areas: [] });
  db.prepare(`UPDATE work_items SET status = 'complete' WHERE id = 'wi_rp'`).run();
  db.prepare(
    `INSERT INTO plan_bundles (id, created_at, project, run, spec_revision, head, phase_number, blobs, artifacts, versions, status) VALUES ('bnd_1', ?, 'prj_1', 'run_a', NULL, ?, 2, '{}', '{}', '{}', 'proposed')`,
  ).run(AT, A);
  const decision = (id, seq, kind, type, subject, scope) =>
    db
      .prepare(
        `INSERT INTO decisions (id, created_at, project, seq, kind, subject_type, subject_id, semantic_generation, scope, question, options, dependency_manifest, transition_schema_version, preview_hash, evidence, blocked_while_open, raised_at, status) VALUES (?, ?, 'prj_1', ?, ?, ?, ?, 1, ?, 'q', '[]', '{}', 1, 'h', '[]', '{}', ?, 'open')`,
      )
      .run(id, AT, seq, kind, type, subject, scope, AT);
  decision('dec_plan', 1, 'plan_approval', 'run', 'run_a', 'bnd_1');
  decision('dec_gap', 2, 'blocker', 'work_item', 'wi_gap', 'subject');
  assert.ok(blocker(db, 'wi_gap')?.startsWith('depends on the plan under way: bundle bnd_1 awaits its approval'));
  // Approved and published.
  db.prepare(`UPDATE plan_bundles SET status = 'published' WHERE id = 'bnd_1'`).run();
  db.prepare(`UPDATE decisions SET status = 'consumed' WHERE id = 'dec_plan'`).run();
  publishPhase2(db);
  step(db);
  assert.equal(row(db, 'wi_gap').status, 'cancelled');
  const d = db.prepare(`SELECT status, invalidated_reason FROM decisions WHERE id = 'dec_gap'`).get();
  assert.equal(d.status, 'invalidated');
  assert.ok(d.invalidated_reason.startsWith('Superseded: criteria R1.2'));
});

test('a partial gap: the criterion candidate 1 still delivers is asked again, narrowed, as the next generation', (t) => {
  const db = store(t, { kinds: [], criteria: ['R1.2', 'R2.2'], areas: [] });
  publishPhase2(db);
  assert.ok(blocker(db, 'wi_gap')?.startsWith('Superseded: criteria R1.2 is owed'));
  step(db);
  assert.equal(row(db, 'wi_gap').status, 'cancelled');
  const [payload] = cancelled(db, 'wi_gap');
  assert.deepEqual(payload.kept, ['R2.2']);
  assert.ok(payload.reason.endsWith('; R2.2 is still owed and asked again.'), payload.reason);
  const next = db.prepare(`SELECT * FROM work_items WHERE kind = 'check_authoring' AND trigger_source = 'authoring_gap' AND trigger_generation = 2`).get();
  assert.ok(next, 'the narrowed next generation');
  assert.equal(next.status, 'eligible');
  assert.equal(next.trigger_id, 'plan_1');
  const ev = JSON.parse(next.trigger_evidence).deployment;
  assert.deepEqual(ev.missing, { kinds: [], criteria: ['R2.2'], areas: [] });
  assert.equal(ev.narrowed_from, 'wi_gap');
  assert.equal(ev.candidate, 'cand_1');
  // Nothing under way and nothing of it owed by a plan: dispatchable, kept.
  assert.equal(blocker(db, next.id), null);
  step(db);
  assert.equal(row(db, next.id).status, 'eligible');
});

test("a kinds-only gap (M627's post_deploy_behavior) is never held and never retired", (t) => {
  const db = store(t, { kinds: ['post_deploy_behavior'], criteria: [], areas: [] });
  assert.equal(blocker(db, 'wi_gap'), null, 'not held while the replan is under way');
  publishPhase2(db);
  step(db);
  assert.equal(row(db, 'wi_gap').status, 'eligible');
  assert.equal(blocker(db, 'wi_gap'), null);
});

test('a parked replan still holds the gap item; a run of it already made is never retired', (t) => {
  const db = store(t, { kinds: [], criteria: ['R1.2'], areas: [] });
  db.prepare(`UPDATE work_items SET status = 'parked' WHERE id = 'wi_rp'`).run();
  assert.ok(blocker(db, 'wi_gap')?.startsWith('depends on the plan under way: replan wi_rp is parked'));
  publishPhase2(db);
  db.prepare(
    `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined) VALUES ('run_g', ?, 'prj_1', 1, 'wi_gap', 'verifier', 'one_shot', 'ended', 'scripted', '1', 'm', 'r', ?, 0)`,
  ).run(AT, AT);
  step(db);
  assert.equal(row(db, 'wi_gap').status, 'eligible', 'an item that ran is history, not retired');
});
