// Developer tests for slice 44 (approval, holds, staleness and the plan):
// the plan check's design clauses (ARCH_INTERFACE_SHAPE_MISSING,
// PLAN_SCREEN_UNKNOWN, PLAN_DESIGN_UNCOVERED, the planned design
// obligation), B.5's `screens`, and the asset manifest's merge of a target
// added. Pure functions of the built engine; nothing runs.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { checkPlan, interfaceShapesMissing, stageTargets } = await import(join(dist, 'plan', 'check.js'));
const { parsePhasePlan } = await import(join(dist, 'plan', 'schemas.js'));
const { placeholderManifest } = await import(join(dist, 'design', 'assets.js'));

const ITEM = { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 40 } }, required: ['name'] };
const MODULES = {
  version: 1,
  modules: [
    {
      name: 'api',
      surface: 'api',
      paths: ['server.mjs'],
      sensitive_areas: [],
      interfaces: [
        { name: 'list-items', kind: 'http', description: 'list', consumed_by: ['web', 'mobile'], request: { type: 'null' }, response: ITEM, errors: [] },
        { name: 'add-item', kind: 'http', description: 'add', consumed_by: ['web'], request: ITEM, response: ITEM },
        { name: 'health', kind: 'http', description: 'health', consumed_by: [] },
      ],
    },
    { name: 'web', surface: 'ui', paths: ['web/'], sensitive_areas: [], interfaces: [], targets: [{ target: 'web', ui_technology: 'html_css' }] },
    { name: 'mobile', surface: 'ui', paths: ['mobile/'], sensitive_areas: [], interfaces: [], targets: [{ target: 'android', ui_technology: 'react_native' }] },
  ],
  mapping_from_spec: [],
};
const KINDS = ['acceptance', 'smoke', 'integration', 'security_lint'];
const stage = (number, modules, implements_, extra = {}) => ({ number, goal: `stage ${number}`, tasks: ['t'], modules, implements: implements_, adrs: [], depends_on: [], validation: { criteria: implements_.map((k) => `${k}.1`), kinds: KINDS, sensitive_areas: [] }, integration_obligations: [], ...extra });
const req = (key) => ({ key, criteria: [`${key}.1`], sensitive_areas: [], withdrawn: false, blocked_by_questions: [] });
const baselineOf = (design) => ({
  spec_version: 1,
  requirements: [req('R1'), req('R2'), req('R3'), req('R4')],
  questions: [],
  architecture_version: 1,
  roadmap_version: 1,
  head: 'h',
  project_tier: 'T1',
  completed_phases: [],
  approved: null,
  design,
});
const artifactsOf = (stages) => ({
  modules: MODULES,
  roadmap: { version: 1, architecture_version: 1, phases: [{ number: 1, goal: 'one', modules: ['api', 'web', 'mobile'], requirement_ids: ['R1', 'R2', 'R3', 'R4'], depends_on: [] }] },
  adrs: {},
  adr_front_matter: {},
  architecture_text: null,
  plan: { phase: 1, prepared_against: { spec_version: 1, architecture_version: 1, roadmap_version: 1, revision: 'h' }, stages, conformance: 'within_baseline' },
});
const STAGES = [stage(1, ['api'], ['R1']), stage(2, ['web'], ['R2', 'R4']), stage(3, ['mobile'], ['R3', 'R4'])];
const SCREENS = [
  { key: 'S1', target: 'web', requirements: ['R2'] },
  { key: 'S2', target: 'android', requirements: ['R3'] },
];
const reasons = (r, code) => r.reasons.find((x) => x.code === code)?.subjects ?? [];

test('clause 5: an interface a ui module consumes without request, response or errors is named <module>:<interface>; one no ui module consumes is not', () => {
  assert.deepEqual(interfaceShapesMissing(MODULES), ['api:add-item']);
  const r = checkPlan(baselineOf({ policy: 'before_build', spec_targets: ['web', 'android'], approved_screens: null }), artifactsOf(STAGES));
  assert.deepEqual(reasons(r, 'ARCH_INTERFACE_SHAPE_MISSING'), ['api:add-item']);
  const off = checkPlan(baselineOf({ policy: 'off', spec_targets: ['web', 'android'], approved_screens: null }), artifactsOf(STAGES));
  assert.deepEqual(reasons(off, 'ARCH_INTERFACE_SHAPE_MISSING'), [], 'optional under off');
});

test('before any design: one planned design obligation per UI stage, with its targets; none for the API stage', () => {
  const shaped = structuredClone(MODULES);
  shaped.modules[0].interfaces[1].errors = [];
  const a = { ...artifactsOf(STAGES), modules: shaped };
  const r = checkPlan(baselineOf({ policy: 'before_build', spec_targets: ['web', 'android'], approved_screens: null }), a);
  assert.equal(r.outcome, 'passed', JSON.stringify(r.reasons));
  assert.deepEqual(r.design_obligations, [{ stage: 2, targets: ['web'] }, { stage: 3, targets: ['android'] }]);
  assert.deepEqual(stageTargets(shaped, ['api']), []);
  const atAlpha = checkPlan(baselineOf({ policy: 'at_alpha', spec_targets: ['web', 'android'], approved_screens: null }), a);
  assert.deepEqual(atAlpha.design_obligations, [], 'at_alpha holds nothing before build');
});

test('with an approved design: PLAN_DESIGN_UNCOVERED names <requirement>:<target> per UI stage, never a covered one; PLAN_SCREEN_UNKNOWN names a key the design lacks', () => {
  const shaped = structuredClone(MODULES);
  shaped.modules[0].interfaces[1].errors = [];
  const stages = [STAGES[0], STAGES[1], { ...STAGES[2], screens: ['S2', 'S9'] }];
  const r = checkPlan(baselineOf({ policy: 'both', spec_targets: ['web', 'android'], approved_screens: SCREENS }), { ...artifactsOf(stages), modules: shaped });
  assert.deepEqual(reasons(r, 'PLAN_DESIGN_UNCOVERED'), ['R4:android', 'R4:web']);
  assert.deepEqual(reasons(r, 'PLAN_SCREEN_UNKNOWN'), ['stage 3:S9']);
  assert.deepEqual(r.design_obligations, [], 'a refused check records none');
  // A requirement marked for one target is a UI requirement of it only.
  const marked = checkPlan(baselineOf({ policy: 'both', spec_targets: ['web', 'android'], approved_screens: SCREENS, surface_targets: { R4: ['web'] } }), { ...artifactsOf(STAGES), modules: shaped });
  assert.deepEqual(reasons(marked, 'PLAN_DESIGN_UNCOVERED'), ['R4:web']);
});

test("B.5's stage takes `screens`, a list of keys; anything else is refused naming the field", () => {
  const plan = (screens) => JSON.stringify({ phase: 1, prepared_against: { spec_version: 1, architecture_version: 1, roadmap_version: 1, revision: 'a'.repeat(40) }, stages: [stage(1, ['web'], ['R2'], screens === undefined ? {} : { screens })], conformance: 'within_baseline' });
  assert.deepEqual(parsePhasePlan(plan(['S1']), 'p.json', 1).value.stages[0].screens, ['S1']);
  assert.equal(parsePhasePlan(plan(undefined), 'p.json', 1).value.stages[0].screens, undefined);
  const bad = parsePhasePlan(plan('S1'), 'p.json', 1);
  assert.equal(bad.ok, false);
  assert.match(bad.finding.field, /screens/);
});
// ---- the slice-44 review: a scratch store ---------------------------------------------------------

const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { designUnmet } = await import(join(dist, 'design', 'readiness.js'));
const staleModule = await import(join(dist, 'design', 'stale.js'));
const { staleScreens, specDesignClass, inventoryDesignClass } = staleModule;
const { bindStageScreensTo, designInForce } = await import(join(dist, 'design', 'stage-screens.js'));
const { untilTime } = await import(join(dist, 'design', 'due.js'));
const { default: Database } = await import('better-sqlite3');

const P = 'proj_d44';
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  migrate(db, join(dist, '..', 'migrations'));
  db.pragma('foreign_keys = OFF');
  setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, domain_memory_max: 8 * 1024 ** 3, max_concurrent_domains: 8 });
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO "projects" ("id", "created_at", "name", "tier", "dev_repo_path", "integration_branch", "baseline_state", "registration_state", "management") VALUES (?, ?, 'pantry', 'T2', '/nowhere', 'main', 'spec_ready', 'registered', 'x')`).run(P, at);
  db.prepare(
    `INSERT INTO "policy_revisions" ("id", "created_at", "project", "revision", "git_path", "git_blob", "changed_by", "changed_at", "diff_summary", "widens_authority", "committed", "effective") VALUES ('pol_1', ?, ?, 1, '.surety/policy.json', 'b', 'human', ?, '{}', 0, 1, ?)`,
  ).run(at, P, at, JSON.stringify({ design: 'before_build' }));
  db.prepare(`UPDATE "projects" SET "policy_revision" = 'pol_1' WHERE "id" = ?`).run(P);
  db.prepare(`INSERT INTO "architecture_revisions" ("id", "created_at", "project", "version", "blobs", "module_map", "mapping_from_spec", "approved_by", "approved_at") VALUES ('arch_1', ?, ?, 1, '{}', ?, '[]', 'human', ?)`).run(at, P, JSON.stringify(MODULES), at);
  const stage = (id, number, modules, implements_, screens = null) =>
    db.prepare(`INSERT INTO "stages" ("id", "created_at", "project", "phase_plan", "number", "goal", "modules", "requirement_ids", "implements", "status", "screens") VALUES (?, ?, ?, 'plan_1', ?, 'g', ?, ?, ?, 'planned', ?)`).run(id, at, P, number, JSON.stringify(modules), JSON.stringify(implements_), JSON.stringify(implements_), screens === null ? null : JSON.stringify(screens));
  const revision = (id, status, ready) =>
    db
      .prepare(`INSERT INTO "design_revisions" ("id", "created_at", "project", "version", "scope", "revision", "blobs", "origin", "targets", "status", "ready_at", "inventory_digest") VALUES (?, ?, ?, 1, 'full', 'r', '{}', 'intended', '[]', ?, ?, 'inv_1')`)
      .run(id, at, P, status, ready ? at : null);
  const screen = (rev, key, target, requirements, interfaces = []) =>
    db.prepare(`INSERT INTO "design_screens" ("id", "created_at", "design_revision", "key", "target", "requirements", "interfaces", "status") VALUES (?, ?, ?, ?, ?, ?, ?, 'current')`).run(`${rev}_${key}`, at, rev, key, target, JSON.stringify(requirements), JSON.stringify(interfaces));
  const status = (rev, key) => db.prepare('SELECT "status" FROM "design_screens" WHERE "design_revision" = ? AND "key" = ?').get(rev, key).status;
  const tx = (fn) => transact(db, ENGINE_ACTOR, fn);
  return { db, at, stage, revision, screen, status, tx };
}

test('B1: rev1 approved and ready, rev2 approved and not ready, an owner change stales rev2\'s R2 screen: both revisions stale, the stage held, design_stale once rev2 is ready', (t) => {
  const { db, stage, revision, screen, status, tx } = scratch(t);
  stage('st_web', 2, ['web'], ['R2']);
  revision('rev_1', 'superseded', true);
  revision('rev_2', 'approved', false);
  for (const r of ['rev_1', 'rev_2']) screen(r, 'S1', 'web', ['R2']);
  assert.deepEqual(designInForce(db, P).stale_scope.sort(), ['rev_1', 'rev_2']);
  tx((x) => bindStageScreensTo(x, { project: P, stages: ['st_web'] }));
  const staled = tx((x) => staleScreens(x, { project: P, screens: [{ screen: 'S1', target: 'web', reason: 'R2 text_changed' }], cause: {} }));
  assert.deepEqual(staled, ['S1']);
  assert.deepEqual([status('rev_1', 'S1'), status('rev_2', 'S1')], ['stale', 'stale'], 'every revision a stage could be released against is stale');
  assert.equal(designUnmet(db, 'st_web'), 'design_pending', 'rev2, in force, is not ready: the stage is held, never released against rev1');
  db.prepare(`UPDATE "design_revisions" SET "ready_at" = ? WHERE "id" = 'rev_2'`).run(new Date().toISOString());
  assert.equal(designUnmet(db, 'st_web'), 'design_stale', 'ready and stale: held design_stale');
});

test('S6: a stage naming no screens, or a subset, is bound to the union of the named and the computed screens', (t) => {
  const { db, stage, revision, screen, tx } = scratch(t);
  revision('rev_1', 'approved', true);
  screen('rev_1', 'S1', 'web', ['R2']);
  screen('rev_1', 'S3', 'web', ['R4']);
  stage('st_none', 2, ['web'], ['R2', 'R4'], []);
  stage('st_some', 3, ['web'], ['R2', 'R4'], ['S1']);
  tx((x) => bindStageScreensTo(x, { project: P, stages: ['st_none', 'st_some'] }));
  const bound = (s) => db.prepare('SELECT "screen" FROM "stage_screens" WHERE "stage" = ? ORDER BY "screen"').all(s).map((r) => r.screen);
  assert.deepEqual(bound('st_none'), ['S1', 'S3']);
  assert.deepEqual(bound('st_some'), ['S1', 'S3']);
});

test('S7: a proposed specification with no Targets where the approved one had them stales every screen, the reason unknown; a UI requirement no longer of a target stales its screen', (t) => {
  const { db, revision, screen } = scratch(t);
  revision('rev_1', 'approved', true);
  screen('rev_1', 'S1', 'web', ['R2']);
  screen('rev_1', 'S2', 'android', ['R3']);
  const rep = (targets) => ({ header: {}, requirements: [], index: [], questions: [], modules: [], environments: [], claims: [], ...(targets ? { targets } : {}) });
  const cls = specDesignClass(db, { project: P, changes: [], before: rep(['web', 'android']), after: rep(undefined) });
  assert.deepEqual(cls.screens.map((s) => s.screen).sort(), ['S1', 'S2']);
  assert.ok(cls.screens.every((s) => s.reason.startsWith('unknown:')), JSON.stringify(cls.screens));
  assert.deepEqual(specDesignClass(db, { project: P, changes: [], before: rep(['web', 'android']), after: rep(['web', 'android']) }).screens, []);
  const inv = (digest, r3) => ({ inventory_digest: digest, targets: [], interfaces: [], ui_requirements: [{ key: 'R2', targets: ['web'] }, ...(r3 ? [{ key: 'R3', targets: ['android'] }] : [])] });
  assert.deepEqual(inventoryDesignClass(db, { project: P, from: inv('a', true), to: inv('b', false) }).map((s) => s.screen), ['S2']);
});

test('until: Z or an offset, a date that exists; anything else unknown', () => {
  assert.equal(untilTime('2026-10-17T12:00:00Z'), Date.parse('2026-10-17T12:00:00Z'));
  assert.equal(untilTime('2026-10-17T12:00+02:00'), Date.parse('2026-10-17T10:00:00Z'));
  for (const bad of ['2026-02-30T12:00:00Z', '2026-10-17T12:00:00', '2026-10-17T24:00:00Z', '2026-13-01T00:00:00Z', '2026-10-17', 1760702400000]) assert.equal(untilTime(bad), null, String(bad));
});

test('PLAN_SCREEN_UNKNOWN: a screen named on a stage whose modules do not serve its target, or on a non-UI stage, is refused, never dropped', () => {
  const shaped = structuredClone(MODULES);
  shaped.modules[0].interfaces[1].errors = [];
  const stages = [{ ...STAGES[0], screens: ['S1'] }, { ...STAGES[1], screens: ['S2'] }, STAGES[2]];
  const r = checkPlan(baselineOf({ policy: 'both', spec_targets: ['web', 'android'], approved_screens: SCREENS }), { ...artifactsOf(stages), modules: shaped });
  const subjects = reasons(r, 'PLAN_SCREEN_UNKNOWN');
  assert.ok(subjects.some((s) => s.startsWith('stage 1:S1')) && subjects.some((s) => s.startsWith('stage 2:S2')), JSON.stringify(subjects));
});

// ---- design_due: stale screens only, a session open, a changed reason, a deferral --------------------

const { DESIGN_DUE, reviewDesignDue } = await import(join(dist, 'design', 'due.js'));
const { reviewVerdictBlockers } = await import(join(dist, 'design', 'approval.js'));
const dueSubject = { project: P, kind: 'design_due', subject_type: 'project', subject_id: P, scope: 'subject', options: '[]' };
const openDues = (db) => db.prepare(`SELECT * FROM "decisions" WHERE "project" = ? AND "kind" = 'design_due' AND "status" = 'open'`).all(P);
function staleDesign(t) {
  const s = scratch(t);
  s.revision('rev_1', 'approved', true);
  s.screen('rev_1', 'S1', 'web', ['R2']);
  s.db.prepare(`UPDATE "projects" SET "design_inventory_digest" = 'inv_1' WHERE "id" = ?`).run(P);
  s.tx((x) => staleScreens(x, { project: P, screens: [{ screen: 'S1', target: 'web', reason: 'R2 text_changed' }], cause: {} }));
  return s;
}

test('S4, S2, S5: stale screens alone raise design_due with waive blocked NOTHING_HELD; a session open blocks open naming it; a changed note changes the reason bound', (t) => {
  const { db, at, tx } = staleDesign(t);
  const p = tx((x) => DESIGN_DUE.preview(x, dueSubject));
  assert.deepEqual(p.manifest.stale_screens, [{ screen: 'S1', target: 'web' }]);
  assert.deepEqual(p.options.find((o) => o.key === 'waive').blockers, ['NOTHING_HELD'], 'never a no-op waiver');
  assert.deepEqual(p.options.find((o) => o.key === 'open').blockers, []);
  assert.match(p.options.find((o) => o.key === 'open').consequence, /The engine opens a Designer session/);
  db.prepare(
    `INSERT INTO "runs" ("id", "created_at", "project", "seq", "role", "kind", "state", "session_state", "backend", "backend_version", "model_requested", "base_revision", "deadline_at", "quarantined", "turn_count")
     VALUES ('run_des', ?, ?, 1, 'designer', 'session', 'claimed', 'allocated', 'scripted', '1', 'opus', 'r', '2099-01-01T00:00:00.000Z', 0, 0)`,
  ).run(at, P);
  const q = tx((x) => DESIGN_DUE.preview(x, dueSubject));
  assert.deepEqual(q.options.find((o) => o.key === 'open').blockers, ['DESIGNER_SESSION_OPEN:run_des']);
  assert.equal(q.evidence.designer_session, 'run_des');
  assert.notEqual(q.manifest.reason, p.manifest.reason, 'the session is part of the reason bound');
  db.prepare(`UPDATE "projects" SET "design_due" = ? WHERE "id" = ?`).run(JSON.stringify({ stage: 'revise', note: 'larger buttons' }), P);
  const r = tx((x) => DESIGN_DUE.preview(x, dueSubject));
  assert.notEqual(r.manifest.reason, q.manifest.reason, 'a changed note changes the manifest');
});

test('S1: a later deferral asks nothing until its time, and is ended at once by a new cause (a screen staled)', (t) => {
  const { db, at, screen, tx } = staleDesign(t);
  const until = new Date(Date.now() + 3_600_000).toISOString();
  db.prepare(`UPDATE "projects" SET "design_due" = ? WHERE "id" = ?`).run(JSON.stringify({ stage: 'revise', deferred: { until, decision: 'dec_x', held: [], stale: ['S1/web'], stage: 'revise', rejected: 0 } }), P);
  tx((x) => reviewDesignDue(x, P));
  assert.equal(openDues(db).length, 0, 'deferred: nothing asked');
  screen('rev_1', 'S2', 'android', ['R3']);
  tx((x) => staleScreens(x, { project: P, screens: [{ screen: 'S2', target: 'android', reason: 'R3 text_changed' }], cause: {} }));
  tx((x) => reviewDesignDue(x, P));
  assert.equal(openDues(db).length, 1, 'a new stale screen ends the deferral: asked at once');
  assert.equal(JSON.parse(db.prepare('SELECT "design_due" FROM "projects" WHERE "id" = ?').get(P).design_due).deferred, undefined);
  void at;
});

test('S9: a review\'s design is blocked UNCONFIRMED until its verdicts are answered, REJECTED once rejected', (t) => {
  const { db, at } = scratch(t);
  db.prepare(`INSERT INTO "design_reviews" ("id", "created_at", "project", "run", "trigger", "subject", "verdicts") VALUES ('drv_1', ?, ?, 'run_r', 'owner_command', '{}', '[]')`).run(at, P);
  assert.deepEqual(reviewVerdictBlockers(db, 'run_r'), ['DESIGN_VERDICTS_UNCONFIRMED:drv_1']);
  db.prepare(
    `INSERT INTO "decisions" ("id", "created_at", "project", "seq", "kind", "subject_type", "subject_id", "semantic_generation", "scope", "question", "options", "dependency_manifest", "transition_schema_version", "preview_hash", "evidence", "blocked_while_open", "raised_at", "status", "answer")
     VALUES ('dec_v', ?, ?, 1, 'design_verdicts', 'design_review', 'drv_1', 1, 'subject', 'q', '[]', '{}', 1, 'h', '[]', '[]', ?, 'consumed', ?)`,
  ).run(at, P, at, JSON.stringify({ option: 'reject' }));
  assert.deepEqual(reviewVerdictBlockers(db, 'run_r'), ['DESIGN_VERDICTS_REJECTED:drv_1']);
  assert.deepEqual(reviewVerdictBlockers(db, null), []);
});

test('a target removed: the slots an earlier inventory\'s placeholder record gave it are named on stale_platforms, no other target\'s', (t) => {
  const { db, at } = scratch(t);
  const { stalePlatforms } = { stalePlatforms: staleModule.stalePlatforms };
  const record = (id, targets) =>
    db
      .prepare(`INSERT INTO "design_inventories" ("id", "created_at", "project", "inventory_digest", "revision", "inventory", "manifest", "recorded_at") VALUES (?, ?, ?, ?, 'r', '{}', ?, ?)`)
      .run(id, at, P, id, JSON.stringify(placeholderManifest('Pantry', targets).manifest), at);
  record('inv_a', ['web', 'android']);
  record('inv_b', ['web', 'android', 'ios']);
  const now = { targets: [{ target: 'web' }, { target: 'android' }] };
  const marked = stalePlatforms(db, P, now);
  assert.ok(marked.some((x) => x.slot === 'splash' && x.target === 'ios'), JSON.stringify(marked));
  assert.ok(marked.every((x) => x.target === 'ios'));
  assert.deepEqual(stalePlatforms(db, P, { targets: [{ target: 'web' }, { target: 'android' }, { target: 'ios' }] }), []);
});
