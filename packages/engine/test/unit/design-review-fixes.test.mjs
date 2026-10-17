// Developer tests for the slice-40 review's items: names the Designer
// writes never become host paths outside their base (B1); a restart during
// a preview leaves no environment locked (B2); a human test is no stage's
// obligation only when the design approval generated and the engine
// assigned it (B3). Against a scratch store with the engine's migrations.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { isSlug, isSafeRelative, within } = await import(join(dist, 'design', 'paths.js'));
const { checkDesign } = await import(join(dist, 'design', 'check.js'));
const { interruptPreviews, previewState } = await import(join(dist, 'store', 'transitions', 'deploy.js'));
const { unplannedRequirements } = await import(join(dist, 'plan', 'phase.js'));
const { checkPlan } = await import(join(dist, 'plan', 'check.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { default: Database } = await import('better-sqlite3');

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  migrate(db, join(dist, '..', 'migrations'));
  db.pragma('foreign_keys = OFF');
  return db;
}

// ---- B1: slot keys and paths ---------------------------------------------------------------

test('a slot key is a slug; a relative path has no ., .. or empty segment; a joined path stays inside its base', () => {
  for (const ok of ['logo', 'app_icon', 'favicon-2']) assert.equal(isSlug(ok), true, ok);
  for (const bad of ['../../x', 'a/b', 'a\\b', '..', '', 'Logo', '1logo', 'a b', 'x'.repeat(65), null, 3]) assert.equal(isSlug(bad), false, String(bad));
  for (const ok of ['mockups/web/s1.html', 'design/assets/logo/full.svg']) assert.equal(isSafeRelative(ok), true, ok);
  for (const bad of ['../x', 'a/../b', '/etc/passwd', 'a//b', './a', 'a\\..\\b', 'a/\0b', '']) assert.equal(isSafeRelative(bad), false, JSON.stringify(bad));
  assert.equal(within('/tmp/base', 'design/x.json'), '/tmp/base/design/x.json');
  assert.equal(within('/tmp/base', '../../../../x'), null);
  assert.equal(within('/tmp/base', 'design/../../x'), null);
});

test('the design check refuses a slot key that is not a slug, naming the slot', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const manifest = {
    version: 1,
    slots: [
      { key: '../../../../../x', kind: 'logo', platforms: ['web'], alt_text: 'x', slot_version: 1, status: 'proposed', provenance: 'designer', variants: [{ name: 'full', format: 'png', file: 'assets/x/full.png' }] },
    ],
  };
  const files = new Map([
    ['assets/manifest.json', Buffer.from(JSON.stringify(manifest))],
    ['assets/x/full.png', png],
  ]);
  const out = checkDesign({ files }, { inventory: null, externalHosts: [], approved: [] });
  assert.equal(out.outcome, 'refused');
  const r = out.reasons.find((x) => x.code === 'DESIGN_ASSET_SLOT_KEY_INVALID');
  assert.ok(r, `DESIGN_ASSET_SLOT_KEY_INVALID (${JSON.stringify(out.reasons.map((x) => x.code))})`);
  assert.equal(r.subjects.slot, '../../../../../x');
});

// ---- B2: a restart during a preview --------------------------------------------------------------

test('a preview operation an earlier incarnation left under way is ended, its lease released and its preview failed; one of this incarnation is left', (t) => {
  const db = store(t);
  const env = 'env_01M5AAAAAAAAAAAAAAAAAAAAAA';
  db.prepare(`INSERT INTO "environments" ("id", "created_at", "project", "name", "adapter", "adapter_config_ref", "verify_spec", "deployment_generation", "prefix") VALUES (?, 'x', 'proj_p', 'design-preview', 'local_service', 'environment_configs', '{}', 1, ?)`).run(
    env,
    `surety-0123456789ab-${env}-`,
  );
  const lease = (id, incarnation) =>
    db.prepare(`INSERT INTO "leases" ("id", "created_at", "resource_kind", "resource_id", "owner_incarnation", "generation", "acquired_at", "renewed_at", "expires_at", "released_at", "closing", "cleanup_authority") VALUES (?, 'x', 'environment', ?, ?, 1, 'x', 'x', '2099-01-01T00:00:00Z', NULL, 0, 0)`).run(id, env, incarnation);
  const op = (id, leaseId, seq) => {
    db.prepare(
      `INSERT INTO "operations" ("id", "created_at", "project", "seq", "kind", "target", "subject", "idempotency_key", "semantic_generation", "status", "deadline_at", "finalizer_inputs", "orchestration_stage")
       VALUES (?, 'x', 'proj_p', ?, 'deploy', ?, '{}', ?, 1, 'intended', 'x', ?, 'effect')`,
    ).run(id, seq, JSON.stringify({ environment: env }), id, JSON.stringify({ purpose: 'deploy', preview: 'dpv_1', environment: env, prefix: `surety-0123456789ab-${env}-`, lease: { id: leaseId, generation: 1 }, work_item: null }));
    db.prepare(`INSERT INTO "deploy_journal_state" ("id", "created_at", "project", "operation", "journal_kind", "state", "last_event_seq") VALUES (?, 'x', 'proj_p', ?, 'deploy_apply', 'intended', 1)`).run(`djs_${id}`, id);
  };
  lease('lease_old', 'inc_old');
  op('op_old', 'lease_old', 1);
  db.prepare(`INSERT INTO "design_previews" ("id", "created_at", "project", "generation", "revision", "tree_digest", "server_digest", "unit", "port", "status", "mockups") VALUES ('dpv_1', 'x', 'proj_p', 1, 'r', 't', 's', NULL, 9000, 'deploying', '[]')`).run();
  assert.equal(previewState(db, { project: 'proj_p' }).busy, true, 'the environment is held before recovery');
  const out = transact(db, ENGINE_ACTOR, (tx) => interruptPreviews(tx, { incarnation: 'inc_new' }));
  assert.deepEqual(out.interrupted, ['op_old']);
  assert.notEqual(db.prepare('SELECT "released_at" FROM "leases" WHERE "id" = ?').get('lease_old').released_at, null, 'its lease released');
  assert.equal(db.prepare('SELECT "orchestration_stage" FROM "operations" WHERE "id" = ?').get('op_old').orchestration_stage, 'ended', 'its operation ended');
  assert.equal(previewState(db, { project: 'proj_p' }).busy, false, 'the environment is free again');
  const p = previewState(db, { project: 'proj_p' }).latest;
  assert.equal(p.status, 'failed', 'its preview failed, so its unit is torn down by exact name next');
  // An operation this incarnation runs is not touched.
  lease('lease_now', 'inc_new');
  op('op_now', 'lease_now', 2);
  assert.deepEqual(transact(db, ENGINE_ACTOR, (tx) => interruptPreviews(tx, { incarnation: 'inc_new' })).interrupted, []);
  assert.equal(db.prepare('SELECT "released_at" FROM "leases" WHERE "id" = ?').get('lease_now').released_at, null);
});

// ---- B3: the human tests a stage need not plan ---------------------------------------------------

test('the phase gate exempts only the human tests the design approval generated and the engine assigned', (t) => {
  const db = store(t);
  db.prepare(`INSERT INTO "phase_plans" ("id", "created_at", "project", "phase_number", "prepared_against_revision", "git_path", "generation", "status", "active") VALUES ('plan_1', 'x', 'proj_h', 1, 'r', '.surety/phases/phase-1.json', 1, 'published', 1)`).run();
  db.prepare(`INSERT INTO "stages" ("id", "created_at", "project", "phase_plan", "number", "goal", "modules", "requirement_ids", "implements", "status") VALUES ('stage_1', 'x', 'proj_h', 'plan_1', 1, 'g', '["api"]', '["R1"]', '["R1"]', 'planned')`).run();
  const req = (key, humanTest) =>
    db.prepare(`INSERT INTO "requirements" ("id", "created_at", "project", "key", "text_ref", "assigned_phase", "criteria", "human_test", "status") VALUES (?, 'x', 'proj_h', ?, 'rec_x', 1, '[]', ?, 'approved')`).run(`req_${key}`, key, humanTest ? 1 : 0);
  req('R1', false);
  req('R4', true); // a hand-written human test
  req('R5', true); // the design's, assigned by the engine
  assert.deepEqual(unplannedRequirements(db, 'plan_1'), ['phase 1:R4', 'phase 1:R5'], 'before any design assignment: both human tests are D6 obligations');
  db.prepare(
    `INSERT INTO "roadmap_revisions" ("id", "created_at", "project", "version", "architecture_revision", "git_path", "git_blob", "phases", "moved_requirements", "approved_by", "approved_at") VALUES ('road_2', 'x', 'proj_h', 2, NULL, '.surety/roadmap/roadmap.json', 'b', '[]', ?, 'engine:design_approval', 'x')`,
  ).run(JSON.stringify([{ key: 'R5', from: null, to: 1 }]));
  assert.deepEqual(unplannedRequirements(db, 'plan_1'), ['phase 1:R4'], 'the engine-assigned design human test is no stage\'s; the hand-written one still is');
});

test('the plan check: a hand-written human test with no criterion is still PLAN_REQUIREMENT_UNPLANNED; the design\'s engine-assigned one is not', () => {
  const MODULES = { version: 1, modules: [{ name: 'api', paths: ['src/api/'], sensitive_areas: [], interfaces: [] }], mapping_from_spec: [] };
  const baseline = {
    spec_version: 2,
    requirements: [
      { key: 'R1', criteria: ['R1.1'], sensitive_areas: [], withdrawn: false, blocked_by_questions: [] },
      { key: 'R4', criteria: [], sensitive_areas: [], withdrawn: false, blocked_by_questions: [], human_test: true },
      { key: 'R5', criteria: [], sensitive_areas: [], withdrawn: false, blocked_by_questions: [], human_test: true, design_human_test: true },
    ],
    questions: [],
    architecture_version: 1,
    roadmap_version: 2,
    head: 'h',
    project_tier: 'T1',
    completed_phases: [],
    approved: null,
  };
  const stage = { number: 1, goal: 'one', tasks: ['t'], modules: ['api'], implements: ['R1'], adrs: [], depends_on: [], validation: { criteria: ['R1.1'], kinds: ['acceptance', 'smoke'], sensitive_areas: [] }, integration_obligations: [] };
  const artifacts = {
    modules: MODULES,
    roadmap: { version: 2, architecture_version: 1, phases: [{ number: 1, goal: 'one', modules: ['api'], requirement_ids: ['R1', 'R4', 'R5'], depends_on: [] }] },
    adrs: {},
    adr_front_matter: {},
    architecture_text: null,
    plan: { phase: 1, prepared_against: { spec_version: 2, architecture_version: 1, roadmap_version: 2, revision: 'h' }, stages: [stage], conformance: 'within_baseline' },
  };
  const r = checkPlan(baseline, artifacts);
  assert.deepEqual(r.reasons.find((x) => x.code === 'PLAN_REQUIREMENT_UNPLANNED')?.subjects ?? [], ['R4'], JSON.stringify(r.reasons));
});
