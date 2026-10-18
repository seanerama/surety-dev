// Developer tests for the driver's ruling on the paid M519 run's finding F1:
// an approved design never became ready because its consolidated change
// added design criteria of kind `human` (judged by a person, D7 §7.2, §7.3)
// that the impact listed uncovered, that readiness waited to see covered,
// and that the Verifier rightly deferred to a stage itself held on the
// design: a deadlock with nothing in flight.
//   (a) the impact of a design's change never lists a `human` criterion
//       uncovered; it lists it judged_by_person;
//   (b) readiness follows D7 §7.5: approved, and the change's
//       spec_obligation correction ended with its proposal applied; a store
//       left in the deadlock (an impact recorded before the ruling, the
//       correction applied, nothing in flight) is ready at the design's
//       next tick, with no owner act;
//   (c) readiness still waits while that correction is pending, or its
//       proposal approved and not applied, and the wait is named with its
//       next action (design read and design_due evidence);
//   (d) a `human` criterion holds no gate: a stage's scope does not miss
//       it, and a requirement left with only such criteria is a human test;
//   (e) a Verifier's deferral of a `human` criterion holds nothing.
// Against a scratch store with the engine's migrations.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', '..', 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { computeImpact } = await import(join(dist, 'spec', 'change.js'));
const { designReadiness, readinessWaits } = await import(join(dist, 'design', 'approval.js'));
const { DESIGN_ENGINE_OPS } = await import(join(dist, 'design', 'ops.js'));
const { deliveredStageScope } = await import(join(dist, 'store', 'transitions', 'evidence.js'));
const { authoringShortfall } = await import(join(dist, 'plan', 'phase.js'));
const { resolveUnowedDeferrals } = await import(join(dist, 'plan', 'deferral.js'));
const { designView } = await import(join(dist, 'design', 'view.js'));

const AT = '2026-10-18T00:00:00.000Z';
const T = {
  r61: 'After each run the explanation card names the law and shows the equation with the numbers substituted.',
  r81: 'Every colour used by the page is a custom property.',
  r82: 'tokens.css defines every token of tokens.json as a custom property of the same name.',
  r83: 'The look and feel matches the approved mockups in both themes.',
};

// The design's criteria.json: one checkable criterion, two judged by a person.
const CRITERIA = [
  { requirement: 'R8', kind: 'token_parity', targets: ['web'], paths: ['public/styles/tokens.css'], text: T.r82 },
  { requirement: 'R6', kind: 'human', targets: ['web'], text: T.r61 },
  { requirement: 'R8', kind: 'human', targets: ['web'], text: T.r83 },
];
const MAP = [
  { index: 0, requirement: 'R8', kind: 'token_parity', id: 'R8.2', requirement_key: 'R8', targets: ['web'], how: 'text' },
  { index: 1, requirement: 'R6', kind: 'human', id: 'R6.1', requirement_key: 'R6', targets: ['web'], how: 'text' },
  { index: 2, requirement: 'R8', kind: 'human', id: 'R8.3', requirement_key: 'R8', targets: ['web'], how: 'text' },
];

const req = (key, criteria, human_test = false) => ({
  key,
  title: key,
  statement: `the statement of ${key}`,
  criteria,
  sensitive_areas: [],
  human_test,
  descriptive: false,
  phase_hint: 1,
  origin: 'intended',
  blocked_by_questions: [],
});
const rep = (requirements) => ({ header: { spec_version: 1, status: 'approved', tier: 'T1', owner: 'o' }, requirements, index: [], questions: [], modules: [], environments: [], claims: [] });
const APPROVED = rep([req('R6', [], true), req('R8', [{ id: 'R8.1', text: T.r81 }])]);
const PROPOSED = rep([
  req('R6', [{ id: 'R6.1', text: T.r61 }]),
  req('R8', [
    { id: 'R8.1', text: T.r81 },
    { id: 'R8.2', text: T.r82 },
    { id: 'R8.3', text: T.r83 },
  ]),
]);

function store({ approved = true } = {}) {
  const db = new Database(':memory:');
  migrate(db, join(here, '..', '..', 'migrations'));
  db.pragma('foreign_keys = OFF');
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  run(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('p', ?, 'p', 'T1', '/repo', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
  );
  run(`INSERT INTO spec_semantics (id, created_at, project, git_blob, readable, representation) VALUES ('sem_1', ?, 'p', 'b1', 1, ?)`, AT, JSON.stringify(APPROVED));
  run(`INSERT INTO spec_revisions (id, created_at, project, version, git_path, git_blob, semantic_digest, approved_by, approved_at, semantics) VALUES ('spec_1', ?, 'p', 1, '.surety/spec/spec.md', 'b1', 'd1', 'human', ?, 'sem_1')`, AT, AT);
  run(
    `INSERT INTO spec_change_requests (id, created_at, project, seq, request_text, source, status) VALUES ('scr_1', ?, 'p', 1, 'the design', 'design', ?)`,
    AT,
    approved ? 'approved' : 'proposed',
  );
  run(
    `INSERT INTO design_revisions (id, created_at, project, version, scope, revision, blobs, origin, targets, status, spec_change_request, content, criterion_map, approved_at)
     VALUES ('dsg_1', ?, 'p', 1, 'full', 'r1', '{}', 'intended', '["web"]', ?, 'scr_1', ?, ?, ?)`,
    AT,
    approved ? 'approved' : 'proposed',
    JSON.stringify({ criteria: { criteria: CRITERIA, human_tests: [] }, screens: { screens: [] } }),
    approved ? JSON.stringify(MAP) : null,
    approved ? AT : null,
  );
  return { db, run };
}

// The deadlock's store, as the paid run left it: the change approved with an
// impact recorded before the ruling (every added criterion uncovered), its
// correction complete with its proposal applied, the effective version
// covering only the checkable criteria, nothing in flight.
function deadlocked({ correction = 'complete' } = {}) {
  const h = store();
  h.run(
    `UPDATE spec_change_requests SET impact_value = ? WHERE id = 'scr_1'`,
    JSON.stringify({ added_criteria: ['R6.1', 'R8.2', 'R8.3'], affected_criteria: [], removed_criteria: [], requirements: [], checks: { obligations: [], criterion_unknown: [], uncovered: ['R6.1', 'R8.2', 'R8.3'] } }),
  );
  h.run(
    `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, roots, effective_from)
     VALUES ('pv_2', ?, 'p', 2, 'f', 'tightening', 'human', 'human', ?, 1, '[]', ?)`,
    AT,
    AT,
    AT,
  );
  for (const [id, key, kind, criteria] of [
    ['chk_1', 'page-tokens', 'acceptance', ['R8.1']],
    ['chk_2', 'design-token-parity', 'acceptance', ['R8.2']],
    ['chk_3', 'smoke', 'smoke', []],
  ]) {
    h.run(
      `INSERT INTO checks (id, created_at, project, key, protected_version, kind, required, gate_kinds, definition_path, definition_hash, runner_class, requirement_ids, sensitive_areas, origin, criteria)
       VALUES (?, ?, 'p', ?, 'pv_2', ?, 1, '["stage"]', 'x', 'h', 'direct', '[]', '[]', 'acceptance', ?)`,
      id,
      AT,
      key,
      kind,
      JSON.stringify(criteria),
    );
  }
  h.run(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
     VALUES ('wi_corr', ?, 'p', 1, 'check_correction', '{"request":"scr_1"}', ?, 'spec_obligation', 'scr_1', 1, 0, 0, 0, 0)`,
    AT,
    correction,
  );
  return h;
}
const readyAt = (db) => db.prepare(`SELECT ready_at FROM design_revisions WHERE id = 'dsg_1'`).get().ready_at;

test('(a) the impact of a design change adding checkable and human criteria lists only the checkable ones uncovered', () => {
  const { db } = store({ approved: false });
  const impact = computeImpact(db, { project: 'p', proposed: PROPOSED, proposedDigest: null, claimed: null, request: 'scr_1' });
  assert.deepEqual(impact.added_criteria, ['R6.1', 'R8.2', 'R8.3']);
  assert.deepEqual(impact.checks.uncovered, ['R8.2'], 'a criterion of kind human is never uncovered');
  assert.deepEqual(impact.checks.judged_by_person, ['R6.1', 'R8.3'], 'and is listed as judged by a person');
  // An owner's change carrying the same text owes checks for everything it adds.
  const owner = computeImpact(db, { project: 'p', proposed: PROPOSED, proposedDigest: null, claimed: null, request: null });
  assert.deepEqual(owner.checks.uncovered, ['R6.1', 'R8.2', 'R8.3'], 'never from the wording: only a design\'s kind makes a criterion a person\'s');
});

test('(b) the deadlock: the correction covering the checkable criteria applied, the design becomes ready at its next tick with no owner act', () => {
  const { db } = deadlocked();
  assert.equal(readyAt(db), null);
  assert.deepEqual(readinessWaits(db, 'p'), [], 'nothing is waited on');
  transact(db, ENGINE_ACTOR, (tx) => DESIGN_ENGINE_OPS['design.tick'](tx, { project: 'p' }));
  assert.ok(readyAt(db), 'design_ready_at set by the tick');
  const ev = db.prepare(`SELECT payload FROM events WHERE type = 'design.ready'`).all();
  assert.equal(ev.length, 1, 'design.ready once');
  transact(db, ENGINE_ACTOR, (tx) => DESIGN_ENGINE_OPS['design.tick'](tx, { project: 'p' }));
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'design.ready'`).get().n, 1, 'and never again');
  // The human criteria are read as a person's.
  const view = designView(db, { project: 'p' });
  assert.deepEqual(view.criteria_judged_by_person, ['R6.1', 'R8.3']);
  assert.equal(view.revisions[0].readiness, undefined, 'a ready revision waits on nothing');
});

test('(b) readiness does not wait for an added checkable criterion still uncovered: it carries ACCEPTANCE_SCOPE_INCOMPLETE instead (D6 §4.5)', () => {
  const { db, run } = deadlocked();
  run(`DELETE FROM checks WHERE id = 'chk_2'`);
  assert.deepEqual(transact(db, ENGINE_ACTOR, (tx) => designReadiness(tx, 'p')), ['dsg_1']);
});

test('(c) readiness waits while the spec_obligation correction is pending, and the wait is named with its next action', () => {
  const { db, run } = deadlocked({ correction: 'eligible' });
  assert.deepEqual(transact(db, ENGINE_ACTOR, (tx) => designReadiness(tx, 'p')), []);
  assert.equal(readyAt(db), null);
  const [w] = readinessWaits(db, 'p');
  assert.equal(w.design_revision, 'dsg_1');
  assert.deepEqual(w.waits_on, { kind: 'check_correction', work_item: 'wi_corr' });
  assert.match(w.next_action, /wi_corr/);
  assert.deepEqual(designView(db, { project: 'p' }).revisions[0].readiness.waits_on, { kind: 'check_correction', work_item: 'wi_corr' }, 'the design read names it');
  // Its proposal approved, not applied: still waiting, named.
  run(
    `INSERT INTO protected_proposals (id, created_at, project, seq, proposed_by, base_revision, tree_id, diff_hash, affected_checks, requested_change_kind, status, changes_required_set, recommendations)
     VALUES ('prop_9', ?, 'p', 9, 'verifier_run', 'b', 't', 'h', '[]', 'tightening', 'approved', 0, '[]')`,
    AT,
  );
  run(`INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined) VALUES ('run_9', ?, 'p', 1, 'wi_corr', 'verifier', 'one_shot', 'ended', 'scripted', '1', 'm', 'b', 't', 0)`, AT);
  run(`UPDATE protected_proposals SET run = 'run_9' WHERE id = 'prop_9'`);
  run(`UPDATE work_items SET status = 'awaiting_decision', blocker = ? WHERE id = 'wi_corr'`, JSON.stringify({ reason: 'correction_proposed', proposal: 'prop_9' }));
  assert.deepEqual(transact(db, ENGINE_ACTOR, (tx) => designReadiness(tx, 'p')), []);
  const [w2] = readinessWaits(db, 'p');
  assert.deepEqual(w2.waits_on, { kind: 'proposal', proposal: 'prop_9', decision: null, work_item: 'wi_corr' });
  // Applied (the correction complete): ready.
  run(`UPDATE work_items SET status = 'complete', blocker = NULL WHERE id = 'wi_corr'`);
  assert.deepEqual(transact(db, ENGINE_ACTOR, (tx) => designReadiness(tx, 'p')), ['dsg_1']);
});

test('(c) a later generation of the correction, parked, keeps it waiting, named', () => {
  const { db, run } = deadlocked();
  run(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
     VALUES ('wi_corr2', ?, 'p', 2, 'check_correction', '{"request":"scr_1"}', 'parked', 'spec_obligation', 'scr_1', 2, 0, 0, 0, 0)`,
    AT,
  );
  assert.deepEqual(transact(db, ENGINE_ACTOR, (tx) => designReadiness(tx, 'p')), []);
  assert.match(readinessWaits(db, 'p')[0].next_action, /parked correction wi_corr2/);
});

test('(d) a human criterion holds no gate: the stage scope misses only checkable criteria, and a requirement left with only human criteria is a human test', () => {
  const { db, run } = deadlocked();
  run(`INSERT INTO requirements (id, created_at, project, key, text_ref, status, criteria, sensitive_areas, human_test) VALUES ('req_6', ?, 'p', 'R6', 't', 'pending', '["R6.1"]', '[]', 0)`, AT);
  run(`INSERT INTO requirements (id, created_at, project, key, text_ref, status, criteria, sensitive_areas, human_test) VALUES ('req_8', ?, 'p', 'R8', 't', 'pending', '["R8.1","R8.2","R8.3"]', '[]', 0)`, AT);
  run(`INSERT INTO stages (id, created_at, project, phase_plan, number, goal, modules, requirement_ids, implements, status) VALUES ('st_4', ?, 'p', 'plan_1', 4, 'g', '[]', '[]', '["req_6","req_8"]', 'planned')`, AT);
  const scope = deliveredStageScope(db, { project: 'p', stage: 'st_4', version: 'pv_2' });
  assert.deepEqual(scope.missing.criteria, [], 'R6.1 and R8.3 are no check\'s');
  assert.deepEqual(scope.missing.uncertain, [], 'R6, left with only a person\'s criterion, is a human test, not uncertain');
  // A checkable criterion uncovered still carries the gap.
  run(`DELETE FROM checks WHERE id = 'chk_2'`);
  assert.deepEqual(deliveredStageScope(db, { project: 'p', stage: 'st_4', version: 'pv_2' }).missing.criteria, ['R8.2']);
});

test('(e) a deferral of a human criterion holds nothing: it is resolved at the tick and its shortfall is not counted', () => {
  const { db, run } = deadlocked();
  const planned = [{ scope: { kind: 'stage', number: 4 }, tier: 'T1', criteria: ['R6.1', 'R8.2', 'R8.3'], kinds: [], sensitive_areas: [] }];
  run(`INSERT INTO plan_bundles (id, created_at, project, head, blobs, artifacts, versions, status) VALUES ('b_1', ?, 'p', 'h', '{}', '{}', '{}', 'published')`, AT);
  run(
    `INSERT INTO plan_checks (id, created_at, project, bundle, phase_number, outcome, reasons, conformance, changes_architecture, changes_adrs, changes_roadmap, changes_goals, roadmap_revision, needs_spec_change, routing, obligations)
     VALUES ('pc_1', ?, 'p', 'b_1', 1, 'passed', '[]', 'within_baseline', '{}', '{}', '{}', 0, 0, 0, 'registered', ?)`,
    AT,
    JSON.stringify(planned),
  );
  run(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, status, active, generation, bundle, "check") VALUES ('plan_1', ?, 'p', 1, 'r', 'x', 'published', 1, 1, 'b_1', 'pc_1')`, AT);
  run(
    `INSERT INTO check_obligations (id, created_at, project, criteria, generation, reason, prerequisite, follow_up, phase_plan) VALUES ('obl_6', ?, 'p', '["R6.1"]', 1, 'deferred_authoring', '{"stage":4}', ?, 'plan_1')`,
    AT,
    JSON.stringify({ trigger_source: 'deferred_authoring', trigger_id: 'obl_6', trigger_generation: 1 }),
  );
  assert.deepEqual(authoringShortfall(db, 'plan_1', 'pv_2'), [], 'neither the planned human criteria nor their deferral are a shortfall');
  assert.equal(transact(db, ENGINE_ACTOR, (tx) => resolveUnowedDeferrals(tx, 'p')), 1);
  const o = db.prepare(`SELECT resolved_at FROM check_obligations WHERE id = 'obl_6'`).get();
  assert.ok(o.resolved_at, 'resolved');
  const ev = db.prepare(`SELECT payload FROM events WHERE type = 'check.obligation_resolved'`).all().map((e) => JSON.parse(e.payload));
  assert.equal(ev[0].how, 'judged_by_person');
});
