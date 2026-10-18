// Developer tests for the Reviewer's should-fix items on build/m6-ready (the
// driver's rulings on M519's F1, continued):
//   (1) a criterion paired with the design's by order alone (a reworded
//       text) is never classified `human`: rewording cannot move a
//       checkable criterion out of the gates;
//   (2) the plan check accepts a plan that validates a human-kind criterion
//       or omits it, and a requirement whose only criteria are human-kind
//       owes no validation (a human test, as at the gates);
//   (3) the human-kind set is the design in force's: a criterion a later
//       design drops is checkable again;
//   (4) a parked correction's next action names what follows a cancel.
// Against a scratch store with the engine's migrations, and the pure check.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', '..', 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { computeImpact } = await import(join(dist, 'spec', 'change.js'));
const { designHumanCriteria } = await import(join(dist, 'design', 'criterion-map.js'));
const { readinessWaits } = await import(join(dist, 'design', 'approval.js'));
const { checkPlan } = await import(join(dist, 'plan', 'check.js'));

const AT = '2026-10-18T00:00:00.000Z';
const req = (key, criteria, human_test = false) => ({ key, title: key, statement: `the statement of ${key}`, criteria, sensitive_areas: [], human_test, descriptive: false, phase_hint: 1, origin: 'intended', blocked_by_questions: [] });
const rep = (requirements) => ({ header: { spec_version: 1, status: 'approved', tier: 'T1', owner: 'o' }, requirements, index: [], questions: [], modules: [], environments: [], claims: [] });
const entry = (index, id, kind, how) => ({ index, requirement: id.split('.')[0], kind, id, requirement_key: id.split('.')[0], targets: ['web'], how });

function store() {
  const db = new Database(':memory:');
  migrate(db, join(here, '..', '..', 'migrations'));
  db.pragma('foreign_keys = OFF');
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  run(`INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management) VALUES ('p', ?, 'p', 'T1', '/repo', 'main', 'spec_ready', 'registered', '{}')`, AT);
  return { db, run };
}
const revision = (run, id, { status, map = null, content = null, request = null }) =>
  run(
    `INSERT INTO design_revisions (id, created_at, project, version, scope, revision, blobs, origin, targets, status, spec_change_request, content, criterion_map) VALUES (?, ?, 'p', 1, 'full', 'r', '{}', 'intended', '["web"]', ?, ?, ?, ?)`,
    id,
    AT,
    status,
    request,
    content === null ? null : JSON.stringify(content),
    map === null ? null : JSON.stringify(map),
  );

test('(1) a reworded, swapped pair is paired by order and never made human: both criteria stay checkable and uncovered', () => {
  const { db, run } = store();
  const approved = rep([req('R8', [{ id: 'R8.1', text: 'one' }])]);
  run(`INSERT INTO spec_semantics (id, created_at, project, git_blob, readable, representation) VALUES ('sem_1', ?, 'p', 'b1', 1, ?)`, AT, JSON.stringify(approved));
  run(`INSERT INTO spec_revisions (id, created_at, project, version, git_path, git_blob, semantic_digest, approved_by, approved_at, semantics) VALUES ('spec_1', ?, 'p', 1, 's', 'b1', 'd1', 'human', ?, 'sem_1')`, AT, AT);
  run(`INSERT INTO spec_change_requests (id, created_at, project, seq, request_text, source, status) VALUES ('scr_1', ?, 'p', 1, 'd', 'design', 'proposed')`, AT);
  const criteria = [
    { requirement: 'R8', kind: 'token_parity', targets: ['web'], text: 'tokens.css defines every token.' },
    { requirement: 'R8', kind: 'human', targets: ['web'], text: 'The look and feel matches the mockups.' },
  ];
  revision(run, 'dsg_1', { status: 'proposed', request: 'scr_1', content: { criteria: { criteria, human_tests: [] }, screens: { screens: [] } } });
  // The Spec Writer reworded both and wrote the human one first.
  const proposed = rep([
    req('R8', [
      { id: 'R8.1', text: 'one' },
      { id: 'R8.2', text: 'A person judges that the look and feel matches the mockups.' },
      { id: 'R8.3', text: 'Every token of tokens.json is defined in tokens.css.' },
    ]),
  ]);
  const impact = computeImpact(db, { project: 'p', proposed, proposedDigest: null, claimed: null, request: 'scr_1' });
  assert.deepEqual(impact.checks.uncovered, ['R8.2', 'R8.3'], 'neither is a person\'s by order alone');
  assert.equal(impact.checks.judged_by_person, undefined);
  // A recorded map's `order` entry is never human either.
  revision(run, 'dsg_2', { status: 'approved', map: [entry(0, 'R8.3', 'token_parity', 'order'), entry(1, 'R8.2', 'human', 'order')] });
  assert.deepEqual([...designHumanCriteria(db, 'p')], []);
});

test('(3) the design in force decides: a criterion a later design drops is checkable again', () => {
  const { db, run } = store();
  revision(run, 'dsg_1', { status: 'superseded', map: [entry(0, 'R6.1', 'human', 'text'), entry(1, 'R8.20', 'human', 'text')] });
  revision(run, 'dsg_2', { status: 'approved', map: [entry(0, 'R8.20', 'human', 'existing'), entry(1, 'R8.6', 'token_parity', 'text')] });
  assert.deepEqual([...designHumanCriteria(db, 'p')], ['R8.20'], 'R6.1, dropped by the design in force, is checkable again');
});

test('(2) the plan check accepts a human-kind criterion validated or omitted; a requirement whose only criteria are human-kind owes no validation', () => {
  const MODULES = { version: 1, modules: [{ name: 'ui', paths: ['public/'], sensitive_areas: [], interfaces: [] }], mapping_from_spec: [] };
  const baseline = {
    spec_version: 2,
    requirements: [
      { key: 'R6', criteria: ['R6.1'], judged_by_person: ['R6.1'], sensitive_areas: [], withdrawn: false, blocked_by_questions: [] },
      { key: 'R8', criteria: ['R8.1', 'R8.20'], judged_by_person: ['R8.20'], sensitive_areas: [], withdrawn: false, blocked_by_questions: [] },
    ],
    questions: [],
    architecture_version: 1,
    roadmap_version: 1,
    head: 'h',
    project_tier: 'T1',
    completed_phases: [],
    approved: null,
  };
  const stage = (number, implements_, criteria, depends_on = []) => ({ number, goal: `s${number}`, tasks: ['t'], modules: ['ui'], implements: implements_, adrs: [], depends_on, validation: { criteria, kinds: ['acceptance', 'smoke'], sensitive_areas: [] }, integration_obligations: [] });
  const artifacts = (stages) => ({
    modules: MODULES,
    roadmap: { version: 1, architecture_version: 1, phases: [{ number: 1, goal: 'one', modules: ['ui'], requirement_ids: ['R6', 'R8'], depends_on: [] }] },
    adrs: {},
    adr_front_matter: {},
    architecture_text: null,
    plan: { phase: 1, prepared_against: { spec_version: 2, architecture_version: 1, roadmap_version: 1, revision: 'h' }, stages, conformance: 'within_baseline' },
  });
  const codes = (r) => r.reasons.map((x) => `${x.code}:${x.subjects.join(',')}`);
  const full = checkPlan(baseline, artifacts([stage(1, ['R8'], ['R8.1', 'R8.20']), stage(2, ['R6'], ['R6.1'], [1])]));
  assert.deepEqual(codes(full), [], 'validated in full: accepted');
  const omitted = checkPlan(baseline, artifacts([stage(1, ['R8'], ['R8.1']), stage(2, ['R6'], [], [1])]));
  assert.deepEqual(codes(omitted), [], 'the human-kind criteria omitted: accepted');
  for (const o of omitted.planned_obligations) assert.ok(!o.criteria.includes('R8.20') && !o.criteria.includes('R6.1'), `no planned obligation owes a human-kind criterion (${JSON.stringify(o)})`);
  // A checkable criterion omitted is still refused.
  const missing = checkPlan(baseline, artifacts([stage(1, ['R8'], ['R8.20']), stage(2, ['R6'], [], [1])]));
  assert.ok(codes(missing).some((c) => c.startsWith('PLAN_CRITERION_UNVALIDATED') && c.includes('R8.1')));
});

test("(4) a parked correction's next action names the blocker question and what follows a cancel", () => {
  const { db, run } = store();
  run(`INSERT INTO spec_change_requests (id, created_at, project, seq, request_text, source, status) VALUES ('scr_1', ?, 'p', 1, 'd', 'design', 'approved')`, AT);
  revision(run, 'dsg_1', { status: 'approved', request: 'scr_1', map: [] });
  run(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
     VALUES ('wi_corr', ?, 'p', 1, 'check_correction', '{"request":"scr_1"}', 'parked', 'spec_obligation', 'scr_1', 1, 0, 0, 0, 0)`,
    AT,
  );
  run(
    `INSERT INTO decisions (id, created_at, project, seq, kind, subject_type, subject_id, semantic_generation, scope, question, options, dependency_manifest, transition_schema_version, preview_hash, evidence, blocked_while_open, raised_at, status)
     VALUES ('dec_b', ?, 'p', 1, 'blocker', 'work_item', 'wi_corr', 1, 'project', 'q', '[]', '{}', 1, 'h', '[]', '[]', ?, 'open')`,
    AT,
    AT,
  );
  const [w] = readinessWaits(db, 'p');
  assert.deepEqual(w.waits_on, { kind: 'check_correction', work_item: 'wi_corr' });
  assert.match(w.next_action, /dec_b/);
  assert.match(w.next_action, /cancel ends it/);
  assert.match(w.next_action, /no route registers another correction/);
  // Cancelled: the wait names it, never a dead end without the owner's routes.
  run(`UPDATE work_items SET status = 'cancelled' WHERE id = 'wi_corr'`);
  const [c] = readinessWaits(db, 'p');
  assert.equal(c.waits_on.kind, 'correction_ended');
  assert.match(c.next_action, /design_due/);
});
