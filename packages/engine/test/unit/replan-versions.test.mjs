// Developer tests for DECISIONS item 52 (the production defect of
// 2026-11-25: Workshop Cut Planner's iteration 2, a change to an existing
// app, parked after two Architect attempts were refused
// PLAN_STALE_BASELINE). A replan's package told the Architect to add its
// phase to roadmap.json and, in the same breath, to name the approved
// versions; the check (plan/check.ts, unchanged) compares with the versions
// the publication allocates (runs/accept.ts replanOf, unchanged): the
// roadmap version approved + 1 when roadmap.json changes, the architecture
// version approved + 1 when architecture.md, modules.json or an ADR
// changes, and a changed roadmap.json carries that architecture version
// (D6 §5.3 clause 2; M448 (a)). A plan written exactly as the package
// stated was refused by construction.
//
// Each case: the store holds an approved generation; the replan's facts are
// read from it (replanFacts) and its package written (writeContextPackage);
// a plan is written from what the package states (the
// `architect.prepared_against` element, as the Verifier's package fakes
// read it) and checked against the versions accept.ts allocates for it,
// computed here by accept.ts's own expressions (a tripwire below fails if
// accept.ts's allocation lines change). The prose is held to the same
// numbers. No engine, backend or git is started.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { checkPlan, computeChanges } = await import(join(dist, 'plan', 'check.js'));
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { replanBaseline } = await import(join(dist, 'plan', 'bundle.js'));
const { replanFacts, replanFiles, prototypePlanText } = await import(join(dist, 'plan', 'replan-package.js'));
const { writeContextPackage } = await import(join(dist, 'invoke', 'sandbox', 'context.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });

const AT = '2026-11-25T00:00:00.000Z';
const HEAD = '6'.repeat(40);
const MODULES = { version: 1, modules: [{ name: 'app', paths: ['src/'], sensitive_areas: [], interfaces: [] }], mapping_from_spec: [] };
const PHASE1 = { number: 1, goal: 'the planner, end to end', modules: ['app'], requirement_ids: ['R1'], depends_on: [] };
const ADR = (key) => `---\nkey: ${key}\nstatus: accepted\n---\n# Context\nc\n# Decision\nd\n# Consequences\nq\n`;

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// An approved generation: specification version `spec`, architecture and
// roadmap version 1 (the roadmap holding `phases`), phase 1 complete when
// `completed`; requirements R1 (phase 1) and, from iteration 2, R2 (phase 2).
function storeWith(t, { spec = 2, phases = [PHASE1], completed = true, requirements = [['R1', 1], ['R2', 2]] } = {}) {
  const dir = scratch(t);
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  db.prepare(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
  ).run(AT);
  for (let v = 1; v <= spec; v++) {
    db.prepare(`INSERT INTO spec_revisions (id, created_at, project, version, git_path, git_blob, semantic_digest, approved_by, approved_at) VALUES (?, ?, 'prj_1', ?, '.surety/spec/spec.md', ?, 'dg', 'human', ?)`).run(`spec_${v}`, AT, v, `blob${v}`, AT);
  }
  for (const [key, phase] of requirements) {
    db.prepare(`INSERT INTO requirements (id, created_at, project, key, text_ref, status, criteria, sensitive_areas, assigned_phase) VALUES (?, ?, 'prj_1', ?, 'x', 'pending', ?, '[]', ?)`).run(`req_${key}`, AT, key, JSON.stringify([`${key}.1`]), phase);
  }
  db.prepare(`INSERT INTO architecture_revisions (id, created_at, project, version, spec_revision, blobs, module_map, mapping_from_spec, approved_by, approved_at) VALUES ('arch_1', ?, 'prj_1', 1, 'spec_1', ?, ?, '[]', 'human', ?)`).run(
    AT,
    JSON.stringify({ '.surety/adrs/ADR-001.md': 'a1', '.surety/architecture/modules.json': 'm1' }),
    JSON.stringify(MODULES),
    AT,
  );
  db.prepare(`INSERT INTO baseline_texts (id, created_at, project, kind, key, text) VALUES ('bt_1', ?, 'prj_1', 'adr', 'ADR-001', ?)`).run(AT, ADR('ADR-001'));
  db.prepare(`INSERT INTO roadmap_revisions (id, created_at, project, version, architecture_revision, git_path, git_blob, phases, approved_by, approved_at) VALUES ('road_1', ?, 'prj_1', 1, 'arch_1', '.surety/roadmap/roadmap.json', 'r1', ?, 'human', ?)`).run(AT, JSON.stringify(phases), AT);
  if (completed) db.prepare(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, status, active, completed_at) VALUES ('plan_1', ?, 'prj_1', 1, 'H0', 'p', 'completed', 1, ?)`).run(AT, AT);
  db.prepare(`INSERT INTO ref_registry (id, created_at, project, ref, kind, expected_oid, immutable) VALUES ('ref_1', ?, 'prj_1', 'refs/heads/main', 'integration', ?, 0)`).run(AT, HEAD);
  return db;
}

// The replan work item a prototype iteration (or an ordinary phase
// completion) dispatches, and the package its run is given.
function packageOf(t, db, { prototype = true } = {}) {
  const item = { id: 'wi_replan', project: 'prj_1', trigger_source: prototype ? 'prototype_first_plan' : null, trigger_id: prototype ? 'it_2' : null, trigger_generation: null, subject: '{}', trigger_evidence: null };
  const replan = { ...replanFacts(db, item), spec_text: '# spec\n' };
  const dir = scratch(t);
  const claim = { run: 'run_1', role: 'architect', work_item: item.id, work_kind: 'replan', base_revision: HEAD, attempt: null, check_outputs: [] };
  const base = { run: { id: 'run_1', role: 'architect', base_revision: HEAD, content_hash: null }, work_item: { id: item.id, kind: 'replan', subject: '{}', project: 'prj_1' }, stage: null, requirements: [], modules: [], phase_plan: null, candidate: null, resumed: null, design_catalogue: { criteria: [] } };
  writeContextPackage(dir, claim, { ...base, replan }, { probe: false });
  const prompt = readFileSync(join(dir, 'prompt.md'), 'utf8');
  const blocks = {};
  for (const m of prompt.matchAll(/^```json surety-reads ([a-z_.]+)\n([\s\S]*?)\n```$/gm)) blocks[m[1]] = JSON.parse(m[2]);
  return { replan, prompt, prepared: blocks['architect.prepared_against'], generation: JSON.parse(replanFiles(replan).find((f) => f.path === 'generation.json').content) };
}

// What a plan names when written exactly as the package states: the
// element's facts, and the next version it states for what the plan
// changes (as the Verifier's package fakes read it,
// harness/standin/package-fakes.cjs preparedOf). Where the package states
// no next version, the stated (approved) one: what the Architect wrote.
function statedVersions(prepared, { roadmapChanges, architectureChanges }) {
  const f = prepared.facts;
  const architecture = architectureChanges ? (prepared.architecture_version_if_changed ?? f.architecture_version) : f.architecture_version;
  const roadmap = roadmapChanges ? (prepared.roadmap_version_if_changed ?? f.roadmap_version) : f.roadmap_version;
  return { spec_version: f.spec_version, architecture_version: architecture, roadmap_version: roadmap, revision: f.revision };
}

// runs/accept.ts replanOf's allocation, expression for expression: the
// versions the check compares a replan's plan with. This fixture holds no
// candidate, so phase 1's completion is unknown to bundleBaselineFacts; it
// is set complete here (completed_phases [1]), as phase 1 was in production:
// the dependency is not this file's subject.
function allocated(b0, artifacts) {
  const baseline = { ...b0, completed_phases: b0.completed_phases.includes(1) || artifacts.plan.phase === 1 ? b0.completed_phases : [...b0.completed_phases, 1], phase_unknown: undefined };
  const pre = computeChanges(baseline, artifacts);
  const r0 = pre.changes_roadmap;
  const roadmapChanging = artifacts.plan.roadmap_revision !== undefined || r0.phases_added.length + r0.phases_removed.length + r0.goals.length + r0.memberships.length + r0.assignments.length + r0.dependencies.length > 0;
  const architectureChanging = pre.changes_architecture.changed || pre.changes_adrs.added.length + pre.changes_adrs.changed.length + pre.changes_adrs.deleted.length > 0;
  const architectureVersion = architectureChanging ? baseline.architecture_version + 1 : baseline.architecture_version;
  return {
    ...baseline,
    architecture_version: architectureVersion,
    roadmap_version: roadmapChanging ? baseline.roadmap_version + 1 : baseline.roadmap_version,
    roadmap_architecture_version: roadmapChanging ? architectureVersion : (baseline.roadmap_architecture_version ?? baseline.architecture_version),
  };
}

const stage2 = { number: 1, goal: 'the unit selector', tasks: ['t'], modules: ['app'], implements: ['R2'], adrs: [], depends_on: [], validation: { criteria: ['R2.1'], kinds: ['acceptance', 'smoke'], sensitive_areas: [] }, integration_obligations: [] };
const stage1 = { ...stage2, goal: 'the planner again', implements: ['R1'], validation: { ...stage2.validation, criteria: ['R1.1'] } };

// A plan written from the package: phase `phase`, its roadmap (`phases`,
// or the approved one left as it is), the architecture changed or not.
function planFromPackage(pkg, { phase, phases = null, architectureChanges = false, approvedRoadmap }) {
  const roadmapChanges = phases !== null;
  const v = statedVersions(pkg.prepared, { roadmapChanges, architectureChanges });
  const roadmap = roadmapChanges ? { version: v.roadmap_version, architecture_version: v.architecture_version, phases } : approvedRoadmap;
  const plan = { phase, prepared_against: v, stages: [phase === 1 ? stage1 : stage2], conformance: 'within_baseline' };
  return {
    stated: v,
    artifacts: {
      modules: MODULES,
      roadmap,
      adrs: { 'ADR-001': ADR('ADR-001') },
      adr_front_matter: { 'ADR-001': { key: 'ADR-001', status: 'accepted' } },
      architecture_text: architectureChanges ? '# Architecture\n\nThe unit helpers join the app module.\n' : null,
      plan,
    },
  };
}

const stale = (check) => check.reasons.filter((r) => r.code === 'PLAN_STALE_BASELINE');

test('tripwire: the allocation this file mirrors is still runs/accept.ts replanOf\'s, expression for expression', () => {
  const src = readFileSync(join(root, 'src', 'runs', 'accept.ts'), 'utf8');
  for (const line of [
    'const roadmapChanging = plan.roadmap_revision !== undefined || r0.phases_added.length + r0.phases_removed.length + r0.goals.length + r0.memberships.length + r0.assignments.length + r0.dependencies.length > 0;',
    'const architectureChanging = pre.changes_architecture.changed || pre.changes_adrs.added.length + pre.changes_adrs.changed.length + pre.changes_adrs.deleted.length > 0;',
    'const architectureVersion = architectureChanging ? b.baseline.architecture_version + 1 : b.baseline.architecture_version;',
    'roadmap_version: roadmapChanging ? b.baseline.roadmap_version + 1 : b.baseline.roadmap_version,',
    'roadmap_architecture_version: roadmapChanging ? architectureVersion : (b.baseline.roadmap_architecture_version ?? b.baseline.architecture_version),',
  ]) assert.ok(src.includes(line), `accept.ts no longer reads: ${line}`);
});

test("the package's approved versions are replanBaseline's, the ones accept.ts allocates the next from", (t) => {
  const db = storeWith(t);
  // A later architecture revision: both read the newest.
  db.prepare(`INSERT INTO architecture_revisions (id, created_at, project, version, spec_revision, blobs, module_map, mapping_from_spec, approved_by, approved_at) VALUES ('arch_2', ?, 'prj_1', 2, 'spec_2', '{}', ?, '[]', 'human', ?)`).run(AT, JSON.stringify(MODULES), AT);
  const pkg = packageOf(t, db);
  const b = replanBaseline(db, { project: 'prj_1', head: HEAD });
  assert.deepEqual(
    [pkg.prepared.facts.spec_version, pkg.prepared.facts.architecture_version, pkg.prepared.facts.roadmap_version, pkg.prepared.facts.revision],
    [b.baseline.spec_version, b.baseline.architecture_version, b.baseline.roadmap_version, b.baseline.head],
  );
  assert.deepEqual([pkg.prepared.architecture_version_if_changed, pkg.prepared.roadmap_version_if_changed], [b.baseline.architecture_version + 1, b.baseline.roadmap_version + 1], 'the next versions stated as data');
  assert.deepEqual(pkg.generation.if_changed, { architecture_version: 3, roadmap_version: 2 }, 'generation.json names them too');
});

test('item 52, roadmap only: a prototype iteration adding phase 2 to an existing app, written as the package states, passes the check (roadmap version 2, architecture 1)', (t) => {
  const db = storeWith(t);
  const pkg = packageOf(t, db);
  const b = replanBaseline(db, { project: 'prj_1', head: HEAD });
  const { stated, artifacts } = planFromPackage(pkg, { phase: 2, phases: [PHASE1, { number: 2, goal: 'the unit selector', modules: ['app'], requirement_ids: ['R2'], depends_on: [1] }] });
  const against = allocated(b.baseline, artifacts);
  assert.deepEqual([against.architecture_version, against.roadmap_version, against.roadmap_architecture_version], [1, 2, 1], 'accept.ts checks it against roadmap 2, architecture 1');
  const check = checkPlan(against, artifacts);
  assert.deepEqual(stale(check), [], `no PLAN_STALE_BASELINE (the package stated ${JSON.stringify(stated)})`);
  assert.deepEqual([stated.spec_version, stated.architecture_version, stated.roadmap_version], [2, 1, 2], 'the package states the versions the check compares');
  assert.equal(check.outcome, 'passed', JSON.stringify(check.reasons));
  // The prose names the same numbers, and no longer the approved ones alone.
  assert.ok(
    pkg.prompt.includes("Adding the phase changes .surety/roadmap/roadmap.json, so this plan is published with roadmap version 2 (the approved roadmap is version 1, in /surety/context/generation.json): your plan's prepared_against names spec version 2, architecture version 1 (2 if you change .surety/architecture/architecture.md, .surety/architecture/modules.json or an ADR), roadmap version 2, and the revision you start from; roadmap.json names version 2 and the same architecture version (1, or 2 with such a change)."),
    'the prompt states roadmap version 2 for the changed roadmap',
  );
  assert.doesNotMatch(pkg.prompt, /names the generation in \/surety\/context\/generation\.json/);
  assert.doesNotMatch(pkg.prepared.rule, /keeps the approved version/);
  assert.match(pkg.prepared.rule, /roadmap_version_if_changed if you change roadmap\.json, as adding a phase or assigning a requirement to a phase does/);
});

test('item 52, architecture too (the repair attempt): adding phase 2 and changing the architecture, written as the package states, passes (roadmap 2, architecture 2)', (t) => {
  const db = storeWith(t);
  const pkg = packageOf(t, db);
  const b = replanBaseline(db, { project: 'prj_1', head: HEAD });
  const { stated, artifacts } = planFromPackage(pkg, { phase: 2, architectureChanges: true, phases: [PHASE1, { number: 2, goal: 'the unit selector', modules: ['app'], requirement_ids: ['R2'], depends_on: [1] }] });
  const against = allocated(b.baseline, artifacts);
  assert.deepEqual([against.architecture_version, against.roadmap_version, against.roadmap_architecture_version], [2, 2, 2], 'accept.ts checks it against architecture 2, roadmap 2, roadmap.json naming architecture 2');
  const check = checkPlan(against, artifacts);
  assert.deepEqual(stale(check), [], `no PLAN_STALE_BASELINE (the package stated ${JSON.stringify(stated)})`);
  assert.deepEqual([stated.architecture_version, stated.roadmap_version, artifacts.roadmap.version, artifacts.roadmap.architecture_version], [2, 2, 2, 2], 'the package states them');
  assert.equal(check.outcome, 'passed', JSON.stringify(check.reasons));
  assert.equal(check.routing, 'human', 'an architecture change routed to the owner, as before');
});

test('item 52, nothing changed: an iteration planning phase 1 again on the approved architecture and roadmap names the approved versions, and the prose states both cases', (t) => {
  const db = storeWith(t, { completed: false, requirements: [['R1', 1]] });
  const pkg = packageOf(t, db);
  assert.match(pkg.prompt, /continues an earlier one that ended before its phase 1 was complete/, 'the phase-1-again text');
  const b = replanBaseline(db, { project: 'prj_1', head: HEAD });
  const approvedRoadmap = { version: 1, architecture_version: 1, phases: [PHASE1] };
  const { stated, artifacts } = planFromPackage(pkg, { phase: 1, approvedRoadmap });
  const against = allocated(b.baseline, artifacts);
  assert.deepEqual([against.architecture_version, against.roadmap_version], [1, 1]);
  assert.deepEqual([stated.spec_version, stated.architecture_version, stated.roadmap_version], [2, 1, 1]);
  const check = checkPlan(against, artifacts);
  assert.deepEqual(stale(check), [], JSON.stringify(check.reasons));
  assert.ok(
    pkg.prompt.includes("Your plan's prepared_against names spec version 2, architecture version 1 (2 if you change .surety/architecture/architecture.md, .surety/architecture/modules.json or an ADR), roadmap version 1 if you leave .surety/roadmap/roadmap.json unchanged (2 if you change it), and the revision you start from"),
    'the prompt states the approved versions and the next of each',
  );
  // The same iteration changing the roadmap's phase goal: roadmap version 2, as stated.
  const changed = planFromPackage(pkg, { phase: 1, phases: [{ ...PHASE1, goal: 'the planner, with its brief' }] });
  const against2 = allocated(b.baseline, changed.artifacts);
  assert.deepEqual([against2.roadmap_version, changed.stated.roadmap_version], [2, 2]);
  assert.deepEqual(stale(checkPlan(against2, changed.artifacts)), []);
});

test('item 52, phase 1 again with a requirement the brief adds (M610 (e)\'s path): assigning it to phase 1 changes roadmap.json, and the package states roadmap version 2', (t) => {
  // The approved roadmap (iteration 1's) assigns R1; iteration 2's brief adds R2 to phase 1.
  const db = storeWith(t, { completed: false, requirements: [['R1', 1], ['R2', 1]] });
  const pkg = packageOf(t, db);
  assert.match(pkg.prompt, /continues an earlier one that ended before its phase 1 was complete/, 'the phase-1-again text');
  const b = replanBaseline(db, { project: 'prj_1', head: HEAD });
  const { stated, artifacts } = planFromPackage(pkg, { phase: 1, phases: [{ ...PHASE1, requirement_ids: ['R1', 'R2'] }] });
  artifacts.plan.stages = [{ ...stage1, implements: ['R1', 'R2'], validation: { ...stage1.validation, criteria: ['R1.1', 'R2.1'] } }];
  const against = allocated(b.baseline, artifacts);
  assert.deepEqual([against.architecture_version, against.roadmap_version, against.roadmap_architecture_version], [1, 2, 1], 'accept.ts checks it against roadmap 2, architecture 1');
  const check = checkPlan(against, artifacts);
  assert.deepEqual(stale(check), [], `no PLAN_STALE_BASELINE (the package stated ${JSON.stringify(stated)})`);
  assert.equal(check.outcome, 'passed', JSON.stringify(check.reasons));
  assert.ok(
    pkg.prompt.includes("Assigning R2 to phase 1 changes .surety/roadmap/roadmap.json, so this plan is published with roadmap version 2 (the approved roadmap is version 1, in /surety/context/generation.json): your plan's prepared_against names spec version 2, architecture version 1 (2 if you change .surety/architecture/architecture.md, .surety/architecture/modules.json or an ADR), roadmap version 2, and the revision you start from; roadmap.json names version 2 and the same architecture version (1, or 2 with such a change)."),
    'the prompt states roadmap version 2 for the requirement the brief adds',
  );
});

test("an ordinary replan's lead states the approved versions and the next of each; an ADR added is checked against architecture version 2, as stated", (t) => {
  const db = storeWith(t, { phases: [PHASE1, { number: 2, goal: 'two', modules: ['app'], requirement_ids: ['R2'], depends_on: [1] }] });
  const pkg = packageOf(t, db, { prototype: false });
  assert.ok(
    pkg.prompt.includes("It is generation spec version 2, architecture version 1, roadmap version 1 (/surety/context/generation.json). Your plan's prepared_against names spec version 2, architecture version 1 (2 if you change .surety/architecture/architecture.md, .surety/architecture/modules.json or an ADR), roadmap version 1 if you leave .surety/roadmap/roadmap.json unchanged (2 if you change it), and the revision you start from (your workspace's HEAD)"),
    'the lead states the numbers',
  );
  assert.doesNotMatch(pkg.prompt, /your plan's prepared_against names these and the revision/);
  const b = replanBaseline(db, { project: 'prj_1', head: HEAD });
  const approvedRoadmap = { version: 1, architecture_version: 1, phases: [PHASE1, { number: 2, goal: 'two', modules: ['app'], requirement_ids: ['R2'], depends_on: [1] }] };
  const { stated, artifacts } = planFromPackage(pkg, { phase: 2, architectureChanges: true, approvedRoadmap });
  artifacts.adrs['ADR-002'] = ADR('ADR-002');
  artifacts.adr_front_matter['ADR-002'] = { key: 'ADR-002', status: 'accepted' };
  const against = allocated(b.baseline, artifacts);
  assert.deepEqual([against.architecture_version, against.roadmap_version, against.roadmap_architecture_version], [2, 1, 1], 'the roadmap unchanged keeps its version and the architecture it was made with');
  assert.deepEqual([stated.architecture_version, stated.roadmap_version], [2, 1]);
  assert.deepEqual(stale(checkPlan(against, artifacts)), []);
});

test("the first plan's text and facts are as they were (versions 1 and 1; no approved generation to state)", (t) => {
  const text = prototypePlanText({ iteration: 'x', bounds: { phases: 1, max_stages: 2 }, brief: null }).join('\n');
  assert.ok(text.includes("Your plan's prepared_against names spec version as given, architecture version 1, roadmap version 1, and the revision you start from; roadmap.json names architecture version 1."));
  const dir = scratch(t);
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management) VALUES ('prj_1', ?, 'p', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`).run(AT);
  db.prepare(`INSERT INTO spec_revisions (id, created_at, project, version, git_path, git_blob, semantic_digest, approved_by, approved_at) VALUES ('spec_1', ?, 'prj_1', 1, '.surety/spec/spec.md', 'b', 'dg', 'human', ?)`).run(AT, AT);
  const pkg = packageOf(t, db);
  assert.match(pkg.prompt, /Nothing is approved yet but its brief/);
  assert.equal(pkg.prepared.facts, null, 'no approved architecture or roadmap: the facts are unknown, never 0');
  assert.deepEqual([pkg.prepared.architecture_version_if_changed, pkg.prepared.roadmap_version_if_changed], [undefined, undefined]);
});

test("generation.json's next versions: null when the generation has no approved architecture or roadmap (unknown, never 0 or 1)", (t) => {
  const dir = scratch(t);
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management) VALUES ('prj_1', ?, 'p', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`).run(AT);
  db.prepare(`INSERT INTO spec_revisions (id, created_at, project, version, git_path, git_blob, semantic_digest, approved_by, approved_at) VALUES ('spec_1', ?, 'prj_1', 1, '.surety/spec/spec.md', 'b', 'dg', 'human', ?)`).run(AT, AT);
  assert.equal(packageOf(t, db).generation.if_changed, null);
});
