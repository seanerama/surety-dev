// Developer tests for M5 slice 35 (D6 §5.2 to §5.8; K4, K5; B03, B04, B06,
// B08): the plan check's validation clause through D3 §4.3's one coverage
// primitive, `phase_size` as uncertainty, an early replacement's kept
// stages, the complete diff, and the replacement's compare-and-swap against
// a scratch store with the engine's migrations.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { checkPlan, artifactDiff, computeChanges, executionInputsDigest } = await import(join(dist, 'plan', 'check.js'));
const { coverageMissing, computeScope, SCOPE_KINDS } = await import(join(dist, 'checks', 'scope.js'));
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { registerPlan } = await import(join(dist, 'store', 'transitions', 'work.js'));
const { activeStages, keptOf, replacementOf, supersededWhileRunning } = await import(join(dist, 'plan', 'replace.js'));
const { validatePolicySubmission, effectiveOf } = await import(join(dist, 'config', 'project-policy.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });

// ---- the check -------------------------------------------------------------------------------

const MODULES = {
  version: 1,
  modules: [
    { name: 'api', paths: ['src/api/'], sensitive_areas: [], interfaces: [] },
    { name: 'auth', paths: ['src/auth/'], sensitive_areas: ['secrets_credentials'], tier_override: 'T2', interfaces: [] },
  ],
  mapping_from_spec: [],
};

function baseline(over = {}) {
  return {
    spec_version: 1,
    requirements: [
      { key: 'R1', criteria: ['R1.1', 'R1.2'], sensitive_areas: [], withdrawn: false, blocked_by_questions: [] },
      { key: 'R2', criteria: ['R2.1'], sensitive_areas: [], withdrawn: false, blocked_by_questions: [] },
      { key: 'R3', criteria: [], sensitive_areas: [], withdrawn: false, blocked_by_questions: [], descriptive_unverified: true },
    ],
    questions: [],
    architecture_version: 1,
    roadmap_version: 1,
    head: 'h',
    project_tier: 'T1',
    completed_phases: [],
    approved: null,
    ...over,
  };
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

function artifacts(stages, over = {}) {
  const roadmap = { version: 1, architecture_version: 1, phases: [{ number: 1, goal: 'one', modules: ['api', 'auth'], requirement_ids: ['R1', 'R2', 'R3'], depends_on: [] }] };
  return {
    modules: MODULES,
    roadmap,
    adrs: {},
    adr_front_matter: {},
    architecture_text: null,
    plan: { phase: 1, prepared_against: { spec_version: 1, architecture_version: 1, roadmap_version: 1, revision: 'h' }, stages, conformance: 'within_baseline' },
    ...over,
  };
}

const codes = (r) => r.reasons.map((x) => x.code);
const subjects = (r, code) => r.reasons.find((x) => x.code === code)?.subjects ?? [];

const GOOD = [
  stage(1, { implements: ['R1'], validation: { criteria: ['R1.1', 'R1.2'], kinds: ['acceptance', 'smoke'], sensitive_areas: [] } }),
  stage(2, { implements: ['R2'], depends_on: [1], validation: { criteria: ['R2.1'], kinds: ['acceptance', 'smoke'], sensitive_areas: [] } }),
];

test('a correct plan passes; the descriptive requirement is neither an obligation nor unplanned', () => {
  const r = checkPlan(baseline(), artifacts(GOOD));
  assert.deepEqual(codes(r), []);
  assert.equal(r.outcome, 'passed');
  const phase = r.planned_obligations.find((o) => o.scope.kind === 'phase');
  assert.deepEqual(phase.criteria, ['R1.1', 'R1.2', 'R2.1']);
});

test('the union of the stages\' arrays satisfies nothing: each stage answers for its own scope; a raised tier\'s kinds for that stage only', () => {
  const stages = [
    stage(1, { implements: ['R1'], validation: { criteria: ['R1.1'], kinds: ['acceptance', 'smoke'], sensitive_areas: [] } }),
    stage(2, { implements: ['R2'], modules: ['auth'], validation: { criteria: ['R2.1', 'R1.2'], kinds: ['acceptance', 'smoke'], sensitive_areas: [] } }),
  ];
  const r = checkPlan(baseline(), artifacts(stages));
  assert.deepEqual(subjects(r, 'PLAN_CRITERION_UNVALIDATED'), ['stage 1:R1.2']);
  // R1.2 named by stage 2, which does not implement R1.
  assert.deepEqual(subjects(r, 'PLAN_CRITERION_MISMATCH'), ['R1.2']);
  assert.deepEqual(subjects(r, 'PLAN_AREA_UNVALIDATED'), ['stage 2:secrets_credentials']);
  assert.deepEqual(subjects(r, 'PLAN_KIND_MISSING'), ['stage 2:integration', 'stage 2:security_lint'], 'T2 kinds for the auth stage only');
});

test('one coverage primitive: the plan check and the gate scope count with it', () => {
  assert.deepEqual(coverageMissing({ criteria: ['a', 'b', 'a'], kinds: ['k1', 'k2'], areas: ['x'] }, { criteria: ['a'], kinds: ['k2'], areas: [] }), { criteria: ['b'], kinds: ['k1'], areas: ['x'] });
  const scope = computeScope({
    kind: 'stage',
    projectTier: 'T1',
    checks: [{ id: 'c1', key: 'c1', kind: 'acceptance', origin: 'acceptance', required: true, gate_kinds: ['stage'], tier_floor: null, criteria: ['R1.1'], requirements: ['r1'], sensitive_areas: [] }],
    requirements: [{ id: 'r1', key: 'R1', criteria: ['R1.1', 'R1.2'], sensitive_areas: [] }],
    delivered: ['r1'],
    partial: [],
    stageImplements: ['r1'],
    modules: [],
  });
  assert.deepEqual(scope.missing.criteria, ['R1.2']);
  assert.deepEqual(scope.missing.kinds, ['kind:smoke']);
  assert.ok(SCOPE_KINDS.includes('phase'), 'SCOPE_KINDS gains phase (K5)');
});

test('phase_size outside its bound is uncertain and routed to the human, never refused; the declaration is recorded beside it', () => {
  const r = checkPlan(baseline({ phase_size: { min: 3, max: 5 } }), artifacts(GOOD));
  assert.equal(r.outcome, 'passed');
  assert.equal(r.conformance, 'uncertain');
  assert.equal(r.routing, 'human');
  assert.match(r.uncertain[0], /^phase_size: 2 stages/);
  assert.deepEqual(r.declared, { conformance: 'within_baseline' });
  // The same plan with the approved artifacts unchanged and the bound met.
  const unchanged = { modules: MODULES, roadmap: artifacts(GOOD).roadmap, adrs: {}, architecture_text: null };
  const ok = checkPlan(baseline({ phase_size: { min: 1, max: 5 }, approved: unchanged }), artifacts(GOOD));
  assert.deepEqual([ok.conformance, ok.routing, ok.uncertain], ['within_baseline', 'registered', []]);
});

test('phase_size: a closed {min, max} within 1 to 12, default {3, 5}', () => {
  assert.deepEqual(effectiveOf(null).phase_size, { min: 3, max: 5 });
  assert.deepEqual(validatePolicySubmission({ phase_size: { min: 1, max: 12 } }), { phase_size: { min: 1, max: 12 } });
  for (const bad of [{ min: 0, max: 5 }, { min: 3, max: 13 }, { min: 6, max: 5 }, { min: 3 }, { min: 3, max: 5, x: 1 }, [3, 5], 4]) {
    assert.throws(() => validatePolicySubmission({ phase_size: bad }), (err) => err.code === 'invalid_value', JSON.stringify(bad));
  }
});

test('a replacement: a kept stage counts as a stage of the plan, listed or not; listed with other inputs it is a second stage under its number', () => {
  const kept = { number: 1, digest: executionInputsDigest(GOOD[0]), implements: ['R1'] };
  const onlyTwo = checkPlan(baseline({ kept: [kept] }), artifacts([GOOD[1]]));
  assert.deepEqual(codes(onlyTwo), [], 'stage 2 depends on kept stage 1, and R1 is implemented by it');
  const same = checkPlan(baseline({ kept: [kept] }), artifacts(GOOD));
  assert.deepEqual(codes(same), []);
  const changed = checkPlan(baseline({ kept: [kept] }), artifacts([{ ...GOOD[0], tasks: ['other'] }, GOOD[1]]));
  assert.deepEqual(subjects(changed, 'PLAN_DUPLICATE_STAGE'), ['stage 1: kept (integrated) with other inputs']);
});

test('the complete diff: the whole roadmap when an assignment moves, a deleted ADR with its approved text, and the plan', () => {
  const approvedRoadmap = { version: 1, architecture_version: 1, phases: [{ number: 1, goal: 'one', modules: ['api', 'auth'], requirement_ids: ['R1', 'R2', 'R3'], depends_on: [] }, { number: 2, goal: 'two', modules: ['api'], requirement_ids: [], depends_on: [1] }] };
  const b = baseline({ approved: { modules: MODULES, roadmap: approvedRoadmap, adrs: { 'ADR-001': 'old' }, architecture_text: null } });
  const moved = { ...approvedRoadmap, phases: [{ ...approvedRoadmap.phases[0], requirement_ids: ['R1', 'R3'] }, { ...approvedRoadmap.phases[1], requirement_ids: ['R2'] }] };
  const a = artifacts([GOOD[0]], { roadmap: moved });
  const changes = computeChanges(b, a);
  assert.deepEqual(changes.changes_adrs.deleted, ['ADR-001']);
  const diff = artifactDiff(b, a, changes);
  assert.deepEqual(diff.map((d) => d.artifact), ['adr', 'roadmap', 'plan']);
  assert.deepEqual(diff[1].proposed, moved, 'the whole proposed roadmap');
  assert.equal(diff[0].approved, 'old');
  const r = checkPlan(b, a);
  assert.equal(r.routing, 'human', 'a deleted ADR and a moved requirement route to the human whatever the declaration');
});

// ---- the swap --------------------------------------------------------------------------------

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, join(root, 'migrations'));
  // The rows a publication names (bundles, records) are not this test's.
  db.pragma('foreign_keys = OFF');
  db.prepare(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', '2026-10-02T00:00:00.000Z', 'p', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
  ).run();
  return db;
}

const input = (s) => ({ ...s, execution_inputs_digest: executionInputsDigest(s) });
const publish = (db, stages, replaces = null) =>
  transact(db, ENGINE_ACTOR, (tx) =>
    registerPlan(tx, { project: 'prj_1', baseRevision: 'h', authority: { kind: 'publication', by: 'engine:plan_check', bundle: replaces ? 'b2' : 'b1', check: null, routing: 'registered', replaces }, phase: 1, stages: stages.map(input), prepared: { spec: null, architecture: null, roadmap: null } }, {}),
  );
const stageRow = (db, id) => db.prepare('SELECT * FROM stages WHERE id = ?').get(id);
const work = (db, id) => db.prepare('SELECT * FROM work_items WHERE id = ?').get(id);

test('the swap: integrated kept, building with unchanged inputs retained, a changed one superseded, planned cancelled; only the remainder registered', (t) => {
  const db = store(t);
  const s = [stage(1), stage(2, { depends_on: [1] }), stage(3, { depends_on: [1] }), stage(4, { depends_on: [2] })];
  const first = publish(db, s);
  const [s1, s2, s3, s4] = first.stages;
  db.prepare(`UPDATE stages SET status = 'integrated', integrated_revision = 'r1' WHERE id = ?`).run(s1.id);
  db.prepare(`UPDATE work_items SET status = 'verifying' WHERE id = ?`).run(s1.work_item);
  for (const x of [s2, s3]) {
    db.prepare(`UPDATE stages SET status = 'building' WHERE id = ?`).run(x.id);
    db.prepare(`UPDATE work_items SET status = 'executing' WHERE id = ?`).run(x.work_item);
  }
  assert.deepEqual(keptOf(db, first.plan.id).map((k) => k.number), [1]);

  const replaces = { phase_plan: first.plan.id, generation: 1, trigger: { source: 'blocker_replan', id: 'wi_x', generation: 1 }, evidence: { work_item: 'wi_x' }, stale: { stages: [3] } };
  const next = [stage(1), stage(2, { depends_on: [1] }), stage(3, { depends_on: [1], tasks: ['changed'] }), stage(4, { depends_on: [2], goal: 'replanned' }), stage(5, { depends_on: [3] })];
  const second = publish(db, next, replaces);
  assert.equal(second.plan.generation, 2);
  const old = db.prepare('SELECT * FROM phase_plans WHERE id = ?').get(first.plan.id);
  assert.deepEqual([old.status, old.active, old.replaced_by], ['replaced', 0, second.plan.id]);
  assert.deepEqual(second.stages.map((x) => x.number), [3, 4, 5], 'only the remainder is registered');
  assert.deepEqual([stageRow(db, s1.id).phase_plan, stageRow(db, s2.id).phase_plan], [first.plan.id, first.plan.id], 'kept and retained on their own rows, under their ids');
  assert.deepEqual(activeStages(db, second.plan.id).map((x) => x.number), [1, 2, 3, 4, 5], 'the active generation: kept, retained and the remainder');
  assert.ok(!activeStages(db, second.plan.id).some((x) => x.id === s3.id || x.id === s4.id), 'no superseded or cancelled stage');
  assert.deepEqual([stageRow(db, s3.id).status, stageRow(db, s3.id).cancelled_at !== null, work(db, s3.work_item).status], ['building', true, 'executing'], 'a changed building stage runs on as history');
  assert.equal(supersededWhileRunning(db, s3.id), true);
  assert.deepEqual([stageRow(db, s4.id).status, work(db, s4.work_item).status], ['cancelled', 'cancelled']);
  const deps = JSON.parse(work(db, s2.work_item).depends_on);
  assert.ok(deps.some((m) => m.milestone === 'authoring_ready' && m.phase_plan === second.plan.id), 'a retained stage waits on the new generation\'s readiness if dispatched again');
  const five = stageRow(db, second.stages[2].id);
  assert.deepEqual(JSON.parse(five.depends_on), [second.stages[0].id], 'the remainder depends on the new stage 3, not the superseded one');
  const record = JSON.parse(db.prepare('SELECT replacement FROM phase_plans WHERE id = ?').get(second.plan.id).replacement);
  assert.deepEqual([record.kept, record.retained, record.cancelled, record.superseded], [[s1.id], [s2.id], [s4.id], [s3.id]]);
  assert.deepEqual(record.stale, { stages: [3] }, 'the stale as the trigger recorded it');

  // A second replacement naming the replaced generation loses the swap.
  assert.throws(() => publish(db, next, replaces), (err) => err.code === 'plan_generation_stale');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM phase_plans WHERE active = 1`).get().n, 1, 'one active generation');
});

test('a building stage is retained only when the stages it depends on keep their identities', (t) => {
  const db = store(t);
  const first = publish(db, [stage(1), stage(2, { depends_on: [1] })]);
  const [s1, s2] = first.stages;
  for (const x of [s1, s2]) {
    db.prepare(`UPDATE stages SET status = 'building' WHERE id = ?`).run(x.id);
    db.prepare(`UPDATE work_items SET status = 'executing' WHERE id = ?`).run(x.work_item);
  }
  const second = publish(db, [stage(1, { tasks: ['changed'] }), stage(2, { depends_on: [1] })], { phase_plan: first.plan.id, generation: 1, trigger: null, evidence: null, stale: null });
  assert.deepEqual(second.stages.map((x) => x.number), [1, 2], 'stage 2 is unchanged but its dependency is new: neither is retained');
});

test('an early replan names the generation recorded on its subject; any other names none', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE phase_plans (id TEXT PRIMARY KEY, generation INTEGER)');
  db.prepare("INSERT INTO phase_plans VALUES ('p1', 3)").run();
  const item = (source, subject, evidence = null) => ({ trigger_source: source, trigger_id: 'x', trigger_generation: 1, subject: JSON.stringify(subject), trigger_evidence: evidence && JSON.stringify(evidence) });
  assert.equal(replacementOf(db, item('phase_complete', { phase_plan: 'p1' })), null);
  assert.equal(replacementOf(db, item('spec_change', { phase_plan: 'p1' }, { phase_plan: 'p1', generation: 2, evidence: { request: 'r' } })).generation, 2);
  assert.equal(replacementOf(db, item('spec_change', { phase_plan: 'p1' })).generation, 3, 'no generation recorded: the plan\'s');
  assert.equal(replacementOf(db, item('blocker_replan', {}, { evidence: {} })), null, 'no plan open when it was made');
});

// ---- carried item (i): an architecture revision with a later phase's plan --------------------

const { finalizeReplan, approveBundlePart, publishAuthorized, rebindDue, rebindBundle, getBundle } = await import(join(dist, 'plan', 'bundle.js'));

const AT = '2026-10-13T00:00:00.000Z';
const ADR = (key) => `---\nkey: ${key}\nstatus: accepted\n---\n# Context\nc\n# Decision\nd\n# Consequences\nq\n`;

// Phase 1 complete under architecture and roadmap version 1; the integration
// head H1; requirements R1 (phase 1) and R2 (phase 2).
function laterPhaseStore(t) {
  const db = store(t);
  db.prepare(`UPDATE projects SET tier = 'T1' WHERE id = 'prj_1'`).run();
  db.prepare(`INSERT INTO spec_revisions (id, created_at, project, version, git_path, git_blob, semantic_digest, approved_by, approved_at) VALUES ('spec_1', ?, 'prj_1', 1, '.surety/spec/spec.md', 'blob', 'dg', 'human', ?)`).run(AT, AT);
  for (const [id, key, phase] of [['req_1', 'R1', 1], ['req_2', 'R2', 2]]) {
    db.prepare(`INSERT INTO requirements (id, created_at, project, key, text_ref, status, criteria, sensitive_areas, assigned_phase) VALUES (?, ?, 'prj_1', ?, 'x', 'pending', ?, '[]', ?)`).run(id, AT, key, JSON.stringify([`${key}.1`]), phase);
  }
  const modules1 = { version: 1, modules: [{ name: 'api', paths: ['src/api/'], sensitive_areas: [], interfaces: [] }], mapping_from_spec: [] };
  db.prepare(`INSERT INTO architecture_revisions (id, created_at, project, version, spec_revision, blobs, module_map, mapping_from_spec, approved_by, approved_at) VALUES ('arch_1', ?, 'prj_1', 1, 'spec_1', ?, ?, '[]', 'human', ?)`).run(
    AT,
    JSON.stringify({ '.surety/adrs/ADR-001.md': 'a1', '.surety/architecture/modules.json': 'm1' }),
    JSON.stringify(modules1),
    AT,
  );
  db.prepare(`INSERT INTO baseline_texts (id, created_at, project, kind, key, text) VALUES ('bt_1', ?, 'prj_1', 'adr', 'ADR-001', ?)`).run(AT, ADR('ADR-001'));
  const phases = [
    { number: 1, goal: 'one', modules: ['api'], requirement_ids: ['R1'], depends_on: [] },
    { number: 2, goal: 'two', modules: ['api'], requirement_ids: ['R2'], depends_on: [1] },
  ];
  db.prepare(`INSERT INTO roadmap_revisions (id, created_at, project, version, architecture_revision, git_path, git_blob, phases, approved_by, approved_at) VALUES ('road_1', ?, 'prj_1', 1, 'arch_1', '.surety/roadmap/roadmap.json', 'r1', ?, 'human', ?)`).run(AT, JSON.stringify(phases), AT);
  db.prepare(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, status, active, completed_at) VALUES ('plan_1', ?, 'prj_1', 1, 'H0', 'p', 'completed', 1, ?)`).run(AT, AT);
  db.prepare(`INSERT INTO ref_registry (id, created_at, project, ref, kind, expected_oid, immutable) VALUES ('ref_1', ?, 'prj_1', 'refs/heads/main', 'integration', 'H1', 0)`).run(AT);
  db.prepare(
    `INSERT INTO runs (id, created_at, project, seq, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined, work_item) VALUES ('run_r', ?, 'prj_1', 1, 'architect', 'one_shot', 'finalizing', 'scripted', '1', 'opus', 'H0', ?, 0, 'wi_replan')`,
  ).run(AT, AT);
  // The replan's products: a new ADR (the architecture changes) and phase 2's plan.
  const modules = modules1;
  const roadmap = { version: 1, architecture_version: 1, phases };
  const plan = { phase: 2, prepared_against: { spec_version: 1, architecture_version: 2, roadmap_version: 1, revision: 'H0' }, stages: [stage(1, { implements: ['R2'], adrs: ['ADR-002'], validation: { criteria: ['R2.1'], kinds: ['acceptance', 'smoke'], sensitive_areas: [] } })], conformance: 'within_baseline' };
  const adrs = { 'ADR-001': ADR('ADR-001'), 'ADR-002': ADR('ADR-002') };
  const base = {
    ...baseline({ requirements: [{ key: 'R1', criteria: ['R1.1'], sensitive_areas: [], withdrawn: false, blocked_by_questions: [] }, { key: 'R2', criteria: ['R2.1'], sensitive_areas: [], withdrawn: false, blocked_by_questions: [] }] }),
    architecture_version: 2,
    roadmap_architecture_version: 1,
    head: 'H0',
    completed_phases: [1],
    approved: { modules: modules1, roadmap, adrs: { 'ADR-001': ADR('ADR-001') }, architecture_text: null },
  };
  const a = { modules, roadmap, adrs, adr_front_matter: { 'ADR-001': { key: 'ADR-001', status: 'accepted' }, 'ADR-002': { key: 'ADR-002', status: 'accepted' } }, architecture_text: null, plan };
  const check = checkPlan(base, a);
  assert.deepEqual([check.outcome, check.routing], ['passed', 'human'], 'the fixture is live: an architecture change routed to the owner');
  const prepared = {
    bundle: 'rec_bundle',
    obligations_record: null,
    phase: 2,
    head: 'H1',
    blobs: { '.surety/adrs/ADR-001.md': 'a1', '.surety/adrs/ADR-002.md': 'a2', '.surety/architecture/modules.json': 'm1', '.surety/phases/phase-2.json': 'p2' },
    content: { modules, roadmap, roadmap_changed: false, plan, adrs: { 'ADR-001': { text: ADR('ADR-001'), status: 'accepted' }, 'ADR-002': { text: ADR('ADR-002'), status: 'accepted' } }, architecture_text: null },
    check,
    spec_revision: 'spec_1',
    architecture_revision: 'arch_1',
    roadmap_revision: 'road_1',
    versions: { architecture: 2, roadmap: 1, phase_plan: 1 },
  };
  transact(db, ENGINE_ACTOR, (tx) => finalizeReplan(tx, { project: 'prj_1', run: 'run_r', prepared, integrated: 'H1' }));
  return db;
}

const kindsRaised = (db) => db.prepare(`SELECT kind, status FROM decisions WHERE scope = 'rec_bundle' ORDER BY kind, seq`).all().map((d) => `${d.kind}:${d.status}`);
const answer = (db, kind) => {
  const d = db.prepare(`SELECT id FROM decisions WHERE scope = 'rec_bundle' AND kind = ? AND status = 'open'`).get(kind);
  db.prepare(`UPDATE decisions SET status = 'consumed' WHERE id = ?`).run(d.id);
  return transact(db, ENGINE_ACTOR, (tx) => approveBundlePart(tx, { bundle: 'rec_bundle', kind, decision: d.id, option: 'approve' }));
};
const moveHead = (db, to) => db.prepare(`UPDATE ref_registry SET expected_oid = ? WHERE ref = 'refs/heads/main'`).run(to);
const tickOnce = (db) => {
  // The tick's order (scheduler/tick.ts): rebind (a harmless move: the
  // diff touches no bound input), then the authorized finalizer.
  for (const d of rebindDue(db, { project: 'prj_1' })) transact(db, ENGINE_ACTOR, (tx) => rebindBundle(tx, { bundle: d.bundle, from: d.from, to: d.to, touched: [] }));
  return transact(db, ENGINE_ACTOR, (tx) => publishAuthorized(tx, { bundle: 'rec_bundle' }));
};

test('carried (i): a phase-2 replan changing the architecture publishes the architecture revision with the plan after both approvals', (t) => {
  const db = laterPhaseStore(t);
  assert.deepEqual(kindsRaised(db), ['architecture_approval:open', 'plan_approval:open'], 'the pair raised in one batch');
  answer(db, 'architecture_approval');
  answer(db, 'plan_approval');
  const made = transact(db, ENGINE_ACTOR, (tx) => publishAuthorized(tx, { bundle: 'rec_bundle' }));
  assert.equal(made.published, true);
  const arch = db.prepare(`SELECT version FROM architecture_revisions WHERE project = 'prj_1' ORDER BY version DESC LIMIT 1`).get();
  assert.equal(arch.version, 2);
  const plan = db.prepare(`SELECT * FROM phase_plans WHERE id = ?`).get(made.plan);
  assert.deepEqual([plan.phase_number, plan.status, plan.active, plan.approved_by], [2, 'published', 1, 'human']);
  assert.equal(getBundle(db, 'rec_bundle').status, 'published');
});

test('carried (i): an engine commit between the authority and the publication re-bases the pair, which then publishes; never stale', (t) => {
  const db = laterPhaseStore(t);
  answer(db, 'architecture_approval');
  // An engine commit lands before the second answer: the pending approval is re-raised on the new head.
  moveHead(db, 'H2');
  tickOnce(db);
  assert.equal(getBundle(db, 'rec_bundle').head, 'H2');
  assert.deepEqual(kindsRaised(db), ['architecture_approval:consumed', 'plan_approval:invalidated', 'plan_approval:open'].sort());
  answer(db, 'plan_approval');
  // Another engine commit lands after the authority is complete and before the publication.
  moveHead(db, 'H3');
  const held = transact(db, ENGINE_ACTOR, (tx) => publishAuthorized(tx, { bundle: 'rec_bundle' }));
  assert.deepEqual([held.published, held.stale], [false, null], 'not judged stale: the rebind reads what changed first');
  const made = tickOnce(db);
  assert.equal(made.published, true);
  assert.equal(getBundle(db, 'rec_bundle').status, 'published');
  assert.equal(db.prepare(`SELECT version FROM architecture_revisions ORDER BY version DESC LIMIT 1`).get().version, 2);
});

test('an early trigger\'s replan names the active generation on its trigger evidence, its subject D1\'s closed keys only', async (t) => {
  const { requestEarlyReplan } = await import(join(dist, 'plan', 'replace.js'));
  const db = store(t);
  const first = publish(db, [stage(1)]);
  const id = transact(db, ENGINE_ACTOR, (tx) => requestEarlyReplan(tx, { project: 'prj_1', source: 'blocker_replan', id: 'wi_x', evidence: { decision: 'd' }, stale: { stages: [1] } }));
  const w = work(db, id);
  assert.deepEqual(JSON.parse(w.subject), { phase_plan: first.plan.id });
  assert.deepEqual(JSON.parse(w.trigger_evidence), { phase_plan: first.plan.id, generation: 1, evidence: { decision: 'd' }, stale: { stages: [1] } });
  assert.deepEqual([w.trigger_source, w.trigger_id, w.trigger_generation], ['blocker_replan', 'wi_x', 1]);
  const again = transact(db, ENGINE_ACTOR, (tx) => requestEarlyReplan(tx, { project: 'prj_1', source: 'blocker_replan', id: 'wi_x', evidence: null, stale: null }));
  assert.equal(work(db, again).trigger_generation, 2, 'a repeated trigger takes the next generation');
  assert.equal(replacementOf(db, w).generation, 1);
});

test('M4: an integrated stage whose work is parked is kept, unless it is the trigger\'s own subject; S1: what the check counted is compared again', async (t) => {
  const { classifyStages, classesDiffer, countStages, listedSame } = await import(join(dist, 'plan', 'replace.js'));
  const db = store(t);
  const first = publish(db, [stage(1), stage(2, { depends_on: [1] })]);
  const [s1, s2] = first.stages;
  db.prepare(`UPDATE stages SET status = 'integrated', integrated_revision = 'r' WHERE id IN (?, ?)`).run(s1.id, s2.id);
  db.prepare(`UPDATE work_items SET status = 'parked' WHERE id = ?`).run(s1.work_item);
  db.prepare(`UPDATE work_items SET status = 'verifying' WHERE id = ?`).run(s2.work_item);
  const digests = new Map([[1, executionInputsDigest(stage(1))], [2, executionInputsDigest(stage(2, { depends_on: [1] }))]]);
  const plain = classifyStages(db, first.plan.id, digests, null);
  assert.deepEqual([plain.get(s1.id), plain.get(s2.id)], ['kept', 'kept'], 'a parked integrated stage is kept');
  const subject = classifyStages(db, first.plan.id, digests, s1.work_item);
  assert.deepEqual([subject.get(s1.id), subject.get(s2.id)], ['superseded', 'kept'], 'the trigger\'s own subject is superseded');
  const counted = countStages(db, first.plan.id, digests, null);
  const listed = listedSame(db, first.plan.id, digests);
  assert.equal(classesDiffer(counted, countStages(db, first.plan.id, digests, null), listed), null, 'nothing moved');
  assert.match(classesDiffer(counted, countStages(db, first.plan.id, digests, s1.work_item), listed), new RegExp(`${s1.id} counted kept`));
  // A listed stage counted planned and carried now, unchanged: held either way.
  assert.equal(classesDiffer({ ...counted, [s1.id]: 'cancelled|planned|eligible' }, counted, listed), null);
  // A listed stage not carried that moved since the check: differs.
  db.prepare(`UPDATE stages SET status = 'building', integrated_revision = NULL WHERE id = ?`).run(s1.id);
  assert.match(classesDiffer({ ...counted, [s1.id]: 'cancelled|planned|eligible' }, countStages(db, first.plan.id, digests, null), listed) ?? '', new RegExp(`${s1.id} counted cancelled\\|planned\\|eligible, now cancelled\\|building\\|parked`));
});

test('N3: a published plan whose planned obligations are absent or unreadable is unknown, never complete', async (t) => {
  const { authoringShortfall } = await import(join(dist, 'plan', 'phase.js'));
  const db = store(t);
  const first = publish(db, [stage(1)]);
  db.prepare(`UPDATE phase_plans SET bundle = 'b1', "check" = NULL WHERE id = ?`).run(first.plan.id);
  assert.match(authoringShortfall(db, first.plan.id, 'pv_x')[0], /planned obligations unknown \(no plan check recorded\)/);
  db.prepare(`INSERT INTO plan_checks (id, created_at, project, outcome, reasons, conformance, changes_architecture, changes_adrs, changes_roadmap, changes_goals, roadmap_revision, needs_spec_change, obligations) VALUES ('pchk_1', 'x', 'prj_1', 'passed', '[]', 'within_baseline', '{}', '{}', '{}', 0, 0, 0, 'not json')`).run();
  db.prepare(`UPDATE phase_plans SET "check" = 'pchk_1' WHERE id = ?`).run(first.plan.id);
  assert.match(authoringShortfall(db, first.plan.id, 'pv_x')[0], /planned obligations unknown \(unreadable\)/);
});

// ---- module paths: the form the presence matcher reads (the real M443 run) ---------------------

const { presentModules, modulePathOk, MODULE_PATH } = await import(join(dist, 'checks', 'scope.js'));

// The mechanica tree at candidate 3 (51cf48b), the paths that decide presence.
const MECHANICA_TREE = [
  '.surety/architecture/modules.json',
  'public/app/labs/common.mjs',
  'public/app/main.mjs',
  'public/index.html',
  'public/physics/constants.mjs',
  'public/physics/friction.mjs',
  'public/physics/integrate.mjs',
  'server.mjs',
];
const MECHANICA_MODULES = [
  { id: 'physics', paths: ['public/physics/**'] },
  { id: 'server', paths: ['server.mjs'] },
  { id: 'page', paths: ['public/index.html', 'public/app/**'] },
];

test('the mechanica module set: a trailing /** is the directory it names, so physics, page and server are present; absent is read as absent; any other glob stays unread', () => {
  assert.deepEqual(presentModules(MECHANICA_TREE, MECHANICA_MODULES).sort(), ['page', 'physics', 'server']);
  assert.deepEqual(presentModules(['server.mjs', 'public/physicsish.mjs'], MECHANICA_MODULES), ['server'], 'a dir/** module with no path under the directory is absent, read; not a prefix of a sibling name');
  assert.equal(presentModules(['server.mjs'], [{ id: 'gl', paths: ['public/*.mjs'] }]), null, 'another glob: unread, never absent');
  for (const ok of ['server.mjs', 'public/physics/', 'public/physics/**', '.surety/checks/']) assert.equal(modulePathOk(ok), true, ok);
  for (const bad of ['public/*.mjs', 'dir/**/x', '**', '/abs', 'a//b', './a', 'a/..', 'a[1]']) assert.equal(modulePathOk(bad), false, bad);
  assert.equal(new RegExp(MODULE_PATH.source, 'u').test('public/app/**'), true, 'the pattern the packages state reads under a JSON Schema validator (u flag)');
});

test('the plan check refuses a module path the matcher cannot read: PLAN_MODULE_PATH_INVALID, naming module and path; dir/** passes', () => {
  const globbed = { ...MODULES, modules: [{ ...MODULES.modules[0], paths: ['src/api/**', 'src/*.js'] }, MODULES.modules[1]] };
  const r = checkPlan(baseline(), artifacts(GOOD, { modules: globbed }));
  assert.deepEqual(subjects(r, 'PLAN_MODULE_PATH_INVALID'), ['api:src/*.js']);
  assert.equal(r.outcome === 'passed', false);
  const ok = checkPlan(baseline(), artifacts(GOOD, { modules: { ...MODULES, modules: [{ ...MODULES.modules[0], paths: ['src/api/**'] }, MODULES.modules[1]] } }));
  assert.deepEqual(codes(ok), []);
});
