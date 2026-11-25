// M633, a later iteration's replan names the versions its publication
// allocates (the owner's M7 plan §3i, row M633; D6 §5.3 clause 2, §5.6;
// M448 (a); M424 (c), (d); M610; M442; DECISIONS item 52). Found on
// Workshop Cut Planner iteration 2 (2026-11-25): the replan package told the
// Architect to add phase 2 to roadmap.json and to name the approved versions
// (architecture 1, roadmap 1) in prepared_against and roadmap.json, while the
// plan check compares with the versions the publication allocates (roadmap
// 2; architecture 2 when architecture.md, modules.json or an ADR changes).
// The check is the rule; the instructions and the stated facts follow it.
//
// Kernel lane, the scripted backend and the scripted deployment adapter
// (harness/prototype.mjs). Every replan launch dumps its context package
// first (the `context_dump` probe, as M442 and M424 capture it); what the
// package STATES is read from it: its `architect.prepared_against` element
// (`facts`, any `<key>_if_changed`, `rule`), the plan reasons' gloss of
// PLAN_STALE_BASELINE, and the prose of prompt.md outside the surety-reads
// blocks (`statedVersions` below). Where the element states no facts (a
// first plan, `facts` null), the prose's numbers are what it states.
//
// How "a plan written exactly as the package states" is scripted: the
// scripted backend has no step that derives a plan from its own package at
// run time (child.mjs offers `copy_context` and `plan_from_open_plan`, neither
// of which writes versions from `prepared_against`), so the package is read
// on the test side first: App A's first replan run of iteration 2 dumps its
// package (case (a)); the versions it states for a commit that adds phase 2
// (with and without an architecture change) are derived from it, and the
// Architect of App B (case (b)), App C (case (c)) and App A's retry (case
// (e)) is scripted with them. Each of those runs dumps its own package too,
// and the test asserts that its own package states the same versions (the
// revision aside, which is each workspace's HEAD, substituted at run time),
// so each plan is what its own package states.
//
//   (a) App A: iteration 1 at Alpha; Iterate with a change to the existing
//       app; brief and specification version 2 approved; the replan
//       dispatched. Its package states: spec 2, the revision started from,
//       roadmap approved + 1 for the commit that adds phase 2, architecture
//       approved when unchanged and approved + 1 when changed, roadmap.json
//       carrying that roadmap version and the architecture version it is
//       published with; the rule and the PLAN_STALE_BASELINE gloss say what
//       the check compares; the next versions are text in the prose.
//   (b) App B: the Architect writes exactly what (a) states, phase 2 added,
//       no architecture change: published policy_authorized; roadmap_revisions
//       2 naming architecture 1; no new architecture_revisions; the phase-2
//       plan prepared against the new roadmap revision.
//   (c) App C: the same with architecture.md changed: architecture_revisions
//       2; roadmap_revisions 2 naming architecture 2.
//   (d) App A's first replan run (the reproduction: the approved versions
//       declared, phase 2 added): failed invalid_result, PLAN_STALE_BASELINE
//       naming roadmap_version and roadmap.json version; its plan_checks row
//       refused.
//   (e) App A: the one automatic repair refused too; the replan parked at
//       repair_attempts_max with its blocker; the owner answers retry (the
//       project paused across the answer, so the eligible item is observed
//       before any dispatch); resumed: one dispatch, its package stating the
//       facts of (a), the plan published, the iteration building, then its
//       stage build; no duplicate replan work. Iteration 1's environment
//       (current_generation, its deployment, its relay, the adapter's
//       deploy/teardown calls) is asserted unchanged at every pump step of
//       (a), (d) and (e).
//   (f) the first plan (App A, B, C, D's iteration 1) and the phase-1-again
//       plan (App D, M610 (e)'s path): the versions their packages state
//       equal those their publication carried.
//
// No fixture write: every state here is reached through the owner's routes
// and the scripted roles. The relay is null throughout in the kernel lane
// (the scripted adapter runs no service a relay could reach; M337 is the
// sandbox lane's); it is snapshotted and compared as it is.

import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';

import { adapterState, effectCalls, environmentRow, operationsOf } from './harness/deploy/kernel.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { packageReads } from './harness/real/packages.mjs';
import { resumeProject } from './harness/runs.mjs';
import { packageOf } from './harness/sessions.mjs';
import { withStore } from './harness/store.mjs';
import {
  CHECK_FILES,
  CHECK_FILE_R4,
  CHECK_KINDS,
  PROTO,
  REQ4,
  REQS,
  ROADMAP,
  ROADMAP2,
  STAGES2,
  alphaReady,
  answerOpen,
  authoringScript,
  briefToAlpha,
  builderOwn,
  builderScript,
  decisionRead,
  deploymentRequestsOf,
  eventsFor,
  firstPlanScript,
  idle,
  iterationRead,
  json,
  kindNext,
  modelBrief,
  observedCurrent,
  ok,
  prepScript,
  protoEngine,
  pump,
  result,
  specText,
  statusIs,
  toBrief,
  usage,
  write,
} from './harness/prototype.mjs';

const CHANGE = 'Show the number of open tasks at the top.';
const DUMP = Object.freeze({ probe: { action: 'context_dump' } });
const dumped = (s) => ({ ...s, steps: [DUMP, ...s.steps] });
const FIRST_PLAN = dumped(firstPlanScript());

const rows = (home, sql, ...p) => withStore(home, (db) => db.prepare(sql).all(...p));
const archRevs = (home, p) => rows(home, 'SELECT * FROM "architecture_revisions" WHERE "project" = ? ORDER BY "version"', p);
const roadRevs = (home, p) => rows(home, 'SELECT * FROM "roadmap_revisions" WHERE "project" = ? ORDER BY "version"', p);
const specRevs = (home, p) => rows(home, 'SELECT * FROM "spec_revisions" WHERE "project" = ? ORDER BY "version"', p);
const plansOf = (home, p) => rows(home, 'SELECT * FROM "phase_plans" WHERE "project" = ? ORDER BY rowid', p);
const planChecksOf = (home, p) => rows(home, 'SELECT * FROM "plan_checks" WHERE "project" = ? ORDER BY rowid', p);
const replanItems = (home, p) => rows(home, `SELECT * FROM "work_items" WHERE "project" = ? AND "kind" = 'replan' ORDER BY "seq"`, p);
const runsOfItem = (home, item) => rows(home, 'SELECT * FROM "runs" WHERE "work_item" = ? ORDER BY "seq"', item);
const runsOfKind = (home, it, kind) => rows(home, 'SELECT r.* FROM "runs" r JOIN "work_items" w ON w."id" = r."work_item" WHERE r."iteration" = ? AND w."kind" = ? ORDER BY r."seq"', it, kind);
const itemOfIteration = (home, p, it) => replanItems(home, p).find((w) => w.trigger_id === it);
const versionOf = (revs, id) => revs.find((r) => r.id === id)?.version ?? null;

// ---- what a package states ------------------------------------------------------------------

// The prompt's prose: prompt.md without its surety-reads blocks.
const proseOf = (prompt) => String(prompt ?? '').replace(/^```json surety-reads [^\n]*\n[\s\S]*?^```[ \t]*$/gm, '');
const fileNamed = (files, name) => Object.entries(files ?? {}).find(([path]) => path.split('/').at(-1) === name)?.[1] ?? null;

// The versions a package states for a commit that changes the roadmap
// (`roadmap`) and the architecture (`architecture`) as given: what a plan
// written as stated declares in prepared_against and in roadmap.json.
function statedVersions(files, { roadmap, architecture }) {
  const r = packageReads(files);
  const el = r.blocks['architect.prepared_against'] ?? null;
  const f = el?.facts ?? null;
  if (f) {
    const ifChanged = (k) => (Number.isInteger(el[`${k}_if_changed`]) ? el[`${k}_if_changed`] : Number.isInteger(f[`${k}_if_changed`]) ? f[`${k}_if_changed`] : null);
    const arch = architecture && ifChanged('architecture_version') !== null ? ifChanged('architecture_version') : f.architecture_version;
    const road = roadmap && ifChanged('roadmap_version') !== null ? ifChanged('roadmap_version') : f.roadmap_version;
    // A changed roadmap.json carries that roadmap version and the
    // architecture version it is published with.
    return { source: 'element', spec_version: f.spec_version, architecture_version: arch, roadmap_version: road, roadmap_json_version: road, roadmap_json_architecture_version: arch, revision: f.revision };
  }
  // No facts (a first plan): the prose's numbers and the generation's spec.
  const prose = proseOf(r.prompt);
  const num = (re) => {
    const m = prose.match(re);
    return m ? Number(m[1]) : null;
  };
  let spec = null;
  try {
    spec = JSON.parse(fileNamed(files, 'generation.json') ?? 'null')?.spec_revision?.version ?? null;
  } catch {
    spec = null;
  }
  const arch = num(/architecture version (\d+)/);
  const road = num(/roadmap version (\d+)/);
  return { source: 'prose', spec_version: spec, architecture_version: arch, roadmap_version: road, roadmap_json_version: road, roadmap_json_architecture_version: num(/roadmap\.json names architecture version (\d+)/) ?? arch, revision: null };
}
const versionsOnly = ({ source, revision, ...v }) => v;

// The package a replan run dumped, or a named failure.
function dumpedPackage(fx, run) {
  const pkg = packageOf(fx, run.id);
  assert.ok(pkg && typeof pkg['prompt.md'] === 'string', `replan run ${run.id} dumped its package (files: ${Object.keys(pkg ?? {}).join(', ')})`);
  return pkg;
}

// ---- the plans the scripted Architect writes ------------------------------------------------

const PHASE2 = ROADMAP2.phases[1];
const ARCH_CHANGED = "# Tasks: architecture\n\nOne module, `app`: `server.mjs` with Node's own `http`, and helpers under `src/`. Phase 2 adds the open count as a helper under `src/`.\n";
// A phase-2 plan declaring the versions `v` (statedVersions' shape).
const laterPlanScript = (v, { architecture = false } = {}) =>
  dumped({
    steps: [
      usage(1800, 0, 700),
      ...(architecture ? [write('.surety/architecture/architecture.md', ARCH_CHANGED)] : []),
      write('.surety/roadmap/roadmap.json', json({ version: v.roadmap_json_version, architecture_version: v.roadmap_json_architecture_version, phases: [...ROADMAP.phases, PHASE2] })),
      write('.surety/roadmap/roadmap.md', '# Roadmap\n\n1. The task list, end to end (R1, R2, R3).\n2. The open count (R4).\n'),
      { write: { path: '.surety/phases/phase-2.json', content: json({ phase: 2, prepared_against: { spec_version: v.spec_version, architecture_version: v.architecture_version, roadmap_version: v.roadmap_version, revision: '__HEAD__' }, stages: STAGES2, conformance: 'within_baseline' }), substitute_head: true } },
      write('.surety/phases/phase-2.md', '# Phase 2\n\n- Stage 1: count the open tasks\n'),
      result({ summary: "iteration 2's plan: phase 2", plan: 'phase-2', conformance: 'within_baseline' }),
    ],
  });
// (d): the approved versions (spec 2, architecture 1, roadmap 1) with phase 2 added, as the production Architect wrote it.
const APPROVED = Object.freeze({ spec_version: 2, architecture_version: 1, roadmap_version: 1, roadmap_json_version: 1, roadmap_json_architecture_version: 1 });

// ---- iteration 1's environment -------------------------------------------------------------

async function envState(fx, p, env) {
  const e = environmentRow(fx.home, env.id);
  const state = await adapterState(fx.engine, env.id);
  return {
    current_generation: e.current_generation,
    deployment_generation: e.deployment_generation,
    current_config: e.current_config,
    relay: e.relay,
    teardown_requested_at: e.teardown_requested_at,
    deployment_requests: deploymentRequestsOf(fx.home, p).map((r) => [r.id, r.candidate, r.status]),
    deploy_operations: operationsOf(fx.home, p, 'deploy').map((o) => [o.id, o.finalized_at]),
    teardown_operations: operationsOf(fx.home, p, 'teardown').map((o) => o.id),
    adapter_deploy_calls: effectCalls(state, 'deploy').length,
    adapter_teardown_calls: effectCalls(state, 'teardown').length,
  };
}
const envUnchanged = async (fx, app, where) => assert.deepEqual(await envState(fx, app.p, app.env), app.envBefore, `iteration 1's environment unchanged (${where})`);

// ---- the apps ------------------------------------------------------------------------------

// The second iteration's products (as harness secondIterationScripts): the
// brief's fourth requirement in spec version 2; then, for its build, its
// check and the Builder's file. The kind scripts follow launch ordinals
// shared by every app of the engine (kindNext), so each is set just before
// the one app that consumes it runs, every other app paused and idle
// (`quiesce`), and every app is quiesced when its case ends, passing or not.
function secondBriefScript(fx) {
  const reqs2 = [...REQS, REQ4];
  kindNext(fx, 'brief_preparation', [prepScript({ spec: specText({ version: 2, reqs: reqs2, changeLog: [{ version: 2, change: 'Show the number of open tasks at the top' }] }), brief: modelBrief({ objectives: reqs2.map((r) => `${r.key}: ${r.statement}`), included: ['adding, listing and finishing tasks', 'the number of open tasks'] }) })], prepScript());
}
function secondBuildScripts(fx) {
  kindNext(fx, 'check_authoring', [authoringScript({ files: { ...CHECK_FILES, ...CHECK_FILE_R4 } })], authoringScript());
  kindNext(fx, 'stage_build', [builderOwn('src/count.mjs', 'export const open = (ts) => ts.filter((t) => !t.done).length;\n')], builderScript(1));
}
// Every later launch of every kind back to its default script: what an
// earlier case scripted and did not consume (it failed first) is not taken
// by another app.
function resetKinds(fx) {
  kindNext(fx, 'brief_preparation', [], prepScript());
  kindNext(fx, 'replan', [], FIRST_PLAN);
  kindNext(fx, 'check_authoring', [], authoringScript());
  kindNext(fx, 'stage_build', [], builderScript(1));
}
// The project paused (whatever it answers if already paused) and its runs ended.
async function quiesce(fx, p) {
  if (!p) return;
  await fx.engine.post(`/v1/projects/${p}/pause`, {});
  await idle(fx, p);
}

// An app whose iteration 1 reached Alpha (observed), iterated with a change
// to the existing app, its iteration 2 brief awaiting approval.
const APPS = [];
async function toSecondBrief(fx, name, port) {
  const { id: p, it } = await toBrief(fx, { name });
  APPS.push(p);
  const env = await briefToAlpha(fx, p, it.id, { port });
  await observedCurrent(fx, p, it.id);
  const firstReplan = runsOfKind(fx.home, it.id, 'replan');
  const made = await ok(fx.engine.post(`/v1/projects/${p}/iterations/${it.id}/iterate`, { change: CHANGE }), 201, 'POST …/iterate');
  const two = made.iteration.id;
  secondBriefScript(fx);
  await answerOpen(fx, p, PROTO.preparation.decision);
  await pump(fx, p, statusIs(fx, p, two, 'awaiting_brief_approval'), { what: `${name}: iteration 2's brief` });
  assert.equal((await iterationRead(fx, p, two)).iteration.brief.version, 2, `${name}: a new specification revision`);
  const app = { p, one: it.id, two, env, firstReplan };
  app.envBefore = await envState(fx, p, env);
  return app;
}

// The approved generation's versions of an app now.
const approvedNow = (fx, p) => ({ spec: specRevs(fx.home, p).at(-1)?.version, architecture: archRevs(fx.home, p).at(-1)?.version, roadmap: roadRevs(fx.home, p).at(-1)?.version });

// A replan run of iteration `it` that ended refused: throws its reason (a
// named failure instead of a timeout).
const noRefusal = (fx, it, what) => {
  const refused = runsOfKind(fx.home, it, 'replan').find((r) => r.state === 'ended' && r.outcome !== 'succeeded' && r.outcome !== 'completed');
  if (refused) throw new Error(`${what}: the replan run ${refused.id} ended ${refused.outcome}/${refused.reason_class}: ${refused.reason_text}`);
};

describe('M633 a later iteration\'s replan names the versions its publication allocates', () => {
  const shared = sharedFixture();
  const S = {};
  before(async () => {
    const fx = await protoEngine(shared.context);
    fx.scripted.kindScript('replan', FIRST_PLAN);
    S.fx = fx;
    S.A = await toSecondBrief(fx, 'Tasks replan A', 18131);
  });
  // Every app paused and idle when a case ends, passed or failed, so no
  // app's later launch takes a kind ordinal scripted for another.
  afterEach(async () => {
    for (const p of APPS) await quiesce(S.fx, p);
  });
  after(() => shared.cleanup());

  test('(a) the replan of a change to the existing app: its package states the versions the publication of a phase-2 commit allocates, and the rule', async () => {
    const { fx, A } = S;
    // The replan's first run writes the plan of (d) (the approved versions);
    // its repair the same. Both dump their packages.
    kindNext(fx, 'replan', [laterPlanScript(APPROVED), laterPlanScript(APPROVED)], FIRST_PLAN);
    await answerOpen(fx, A.p, 'spec_approval');
    const approved = approvedNow(fx, A.p);
    assert.deepEqual(approved, { spec: 2, architecture: 1, roadmap: 1 }, 'the fixture is live: spec 2 approved on architecture 1 and roadmap 1');
    S.approved = approved;
    await pump(fx, A.p, async () => {
      await envUnchanged(fx, A, 'while the replan runs and is repaired');
      const item = itemOfIteration(fx.home, A.p, A.two);
      return item?.status === 'parked' ? item : undefined;
    }, { what: "App A's replan parked after its repair" });
    const item = itemOfIteration(fx.home, A.p, A.two);
    S.item = item;
    const runs = runsOfItem(fx.home, item.id);
    S.runsA = runs;
    const pkg = dumpedPackage(fx, runs[0]);
    S.pkgA = pkg;
    // What the package states, kept for (b), (c) and (e) before any assertion.
    S.stated = statedVersions(pkg, { roadmap: true, architecture: false });
    S.statedArch = statedVersions(pkg, { roadmap: true, architecture: true });
    const { blocks, prompt } = packageReads(pkg);
    const el = blocks['architect.prepared_against'];
    assert.ok(el && el.facts, `the package carries architect.prepared_against with its facts (${JSON.stringify(el)})`);
    // The checker allocates, for a commit that adds phase 2: roadmap approved
    // + 1; architecture approved, or approved + 1 when it changes; a changed
    // roadmap.json carries that roadmap version and the architecture version
    // it is published with (runs/accept.ts; plan/check.ts).
    const want = { spec_version: approved.spec, architecture_version: approved.architecture, roadmap_version: approved.roadmap + 1, roadmap_json_version: approved.roadmap + 1, roadmap_json_architecture_version: approved.architecture };
    const wantArch = { ...want, architecture_version: approved.architecture + 1, roadmap_json_architecture_version: approved.architecture + 1 };
    assert.match(S.stated.revision ?? '', /^[0-9a-f]{40}$/, 'the revision started from is stated');
    assert.equal(S.stated.revision, runs[0].base_revision ?? S.stated.revision, "the revision is the run's base");
    assert.deepEqual(versionsOnly(S.stated), want, `phase 2 added, the architecture unchanged: the versions stated equal those the check accepts (stated ${JSON.stringify(S.stated)}; element ${JSON.stringify(el)})`);
    assert.deepEqual(versionsOnly(S.statedArch), wantArch, `phase 2 added and the architecture changed: the versions stated equal those the check accepts (stated ${JSON.stringify(S.statedArch)}; element ${JSON.stringify(el)})`);
    // The rule and the PLAN_STALE_BASELINE gloss say what the check compares:
    // the approved versions, or the next where the plan changes them, the
    // roadmap's on a roadmap.json change and the architecture's on an
    // architecture.md, modules.json or ADR change.
    const rule = el.rule ?? '';
    assert.match(rule, /roadmap\.json/, `the rule names roadmap.json (${rule})`);
    assert.match(rule, /architecture\.md|modules\.json|ADR/, `the rule names what changes the architecture (${rule})`);
    for (const k of ['roadmap_version_if_changed', 'architecture_version_if_changed']) {
      if (k in el || k in el.facts) assert.ok(rule.includes(k), `the rule says what ${k}, which the element carries, is for (${rule})`);
    }
    assert.match(rule, /allocat|next|_if_changed/i, `the rule says a changed file is named with the next version (${rule})`);
    const stale = (blocks['architect.plan_reasons']?.reasons ?? []).find((x) => x.code === 'PLAN_STALE_BASELINE');
    assert.ok(stale, 'the plan reasons list PLAN_STALE_BASELINE');
    assert.match(stale.rule, /allocat|next/i, `its gloss says the check compares with the next version where the plan changes it (${stale.rule})`);
    assert.match(stale.rule, /roadmap/i, `its gloss covers roadmap.json (${stale.rule})`);
    assert.match(stale.rule, /architecture/i, `its gloss covers the architecture (${stale.rule})`);
    // The next versions are text in the prose, not only in the element: the
    // roadmap version the added phase allocates, the architecture version
    // when unchanged and, within the same clause (the form "architecture
    // version 1 (2 if you change …)"), when changed; and what the check is.
    const prose = proseOf(prompt);
    assert.match(prose, new RegExp(`roadmap version\\s+${want.roadmap_version}\\b`, 'i'), 'the prose names the roadmap version the added phase allocates');
    assert.match(prose, new RegExp(`architecture version\\s+${want.architecture_version}\\b`, 'i'), 'the prose names the architecture version when it is unchanged');
    assert.match(prose, new RegExp(`architecture[ _]version[^.]{0,80}?\\b${wantArch.architecture_version}\\b`, 'i'), 'the prose names the architecture version a change allocates');
    assert.match(prose, /PLAN_STALE_BASELINE/, 'the prose names the refusal the check gives');
  });

  test('(b) a scripted Architect that writes what (a) states, phase 2 added, the architecture unchanged: published, roadmap_revisions 2 naming architecture 1, no new architecture revision', async () => {
    const { fx } = S;
    assert.ok(S.stated, '(a) read the package');
    resetKinds(fx);
    const B = await toSecondBrief(fx, 'Tasks replan B', 18132);
    S.B = B;
    const archBefore = archRevs(fx.home, B.p);
    kindNext(fx, 'replan', [laterPlanScript(S.stated), laterPlanScript(S.stated)], FIRST_PLAN);
    await answerOpen(fx, B.p, 'spec_approval');
    await pump(fx, B.p, async () => {
      await envUnchanged(fx, B, "App B's replan");
      noRefusal(fx, B.two, "(b) the plan written as (a)'s package states");
      const routed = eventsFor(fx.home, 'prototype.plan_routed_to_owner', 'iteration', B.two);
      if (routed.length > 0) throw new Error(`(b) routed to the owner: ${JSON.stringify(routed[0].payload)}`);
      return eventsFor(fx.home, 'prototype.plan_policy_authorized', 'iteration', B.two)[0];
    }, { what: "App B's phase-2 plan published" });
    await quiesce(fx, B.p);
    const [run] = runsOfKind(fx.home, B.two, 'replan');
    // Its own package states what (a)'s did: the plan is what it states.
    const own = statedVersions(dumpedPackage(fx, run), { roadmap: true, architecture: false });
    assert.deepEqual(versionsOnly(own), versionsOnly(S.stated), "App B's own package states the versions (a) states");
    const read = await iterationRead(fx, B.p, B.two);
    assert.deepEqual([read.plan.routing, read.plan.approved_by, read.plan.bundle_status], [PROTO.routing, PROTO.publisher, 'published'], 'published by computed routing (the prototype policy)');
    const roads = roadRevs(fx.home, B.p);
    const archs = archRevs(fx.home, B.p);
    assert.deepEqual(roads.map((r) => r.version), [1, 2], 'roadmap_revisions 2');
    assert.equal(versionOf(archs, roads[1].architecture_revision), 1, 'roadmap_revisions 2 names architecture 1');
    assert.deepEqual(archs.map((r) => r.id), archBefore.map((r) => r.id), 'no new architecture_revisions');
    const plan = plansOf(fx.home, B.p).find((x) => x.phase_number === 2 && x.status === 'published');
    assert.ok(plan, `a published phase-2 plan (${JSON.stringify(plansOf(fx.home, B.p).map((x) => [x.phase_number, x.status]))})`);
    assert.equal(plan.prepared_against_roadmap, roads[1].id, 'prepared against the new roadmap revision');
    assert.equal(plan.prepared_against_architecture, archs[0].id, 'and architecture 1');
    assert.equal(plan.prepared_against_revision, own.revision, 'its revision the one its package stated');
  });

  test('(c) the same with architecture.md changed: architecture_revisions 2, roadmap_revisions 2 naming architecture 2', async () => {
    const { fx } = S;
    assert.ok(S.statedArch, '(a) read the package');
    resetKinds(fx);
    const C = await toSecondBrief(fx, 'Tasks replan C', 18133);
    S.C = C;
    kindNext(fx, 'replan', [laterPlanScript(S.statedArch, { architecture: true }), laterPlanScript(S.statedArch, { architecture: true })], FIRST_PLAN);
    await answerOpen(fx, C.p, 'spec_approval');
    const acts = [];
    await pump(fx, C.p, async () => {
      await envUnchanged(fx, C, "App C's replan");
      noRefusal(fx, C.two, "(c) the plan written as (a)'s package states for an architecture change");
      return plansOf(fx.home, C.p).find((x) => x.phase_number === 2 && x.status === 'published');
    }, { what: "App C's phase-2 plan published", answer: ['architecture_approval', 'plan_approval'], acts });
    await quiesce(fx, C.p);
    const [run] = runsOfKind(fx.home, C.two, 'replan');
    const own = statedVersions(dumpedPackage(fx, run), { roadmap: true, architecture: true });
    assert.deepEqual(versionsOnly(own), versionsOnly(S.statedArch), "App C's own package states the versions (a) states for an architecture change");
    const archs = archRevs(fx.home, C.p);
    const roads = roadRevs(fx.home, C.p);
    assert.deepEqual(archs.map((r) => r.version), [1, 2], 'architecture_revisions 2');
    assert.deepEqual(roads.map((r) => r.version), [1, 2], 'roadmap_revisions 2');
    assert.equal(versionOf(archs, roads[1].architecture_revision), 2, 'roadmap_revisions 2 names architecture 2');
    const plan = plansOf(fx.home, C.p).find((x) => x.phase_number === 2 && x.status === 'published');
    assert.deepEqual([versionOf(archs, plan.prepared_against_architecture), versionOf(roads, plan.prepared_against_roadmap)], [2, 2], 'the plan prepared against architecture 2 and roadmap 2');
    S.routingC = { routing: plan.routing, owner_acts: acts };
  });

  test('(d) the reproduction: the approved versions declared with phase 2 added: failed invalid_result, PLAN_STALE_BASELINE naming roadmap_version and roadmap.json version', async () => {
    const { fx, A } = S;
    assert.ok(S.runsA?.length >= 1, '(a) ran the replan');
    const first = S.runsA[0];
    assert.deepEqual([first.state, first.outcome, first.reason_class], ['ended', 'failed', 'invalid_result'], `the run failed invalid_result (${first.reason_text})`);
    assert.match(first.reason_text ?? '', /PLAN_STALE_BASELINE/, 'naming PLAN_STALE_BASELINE');
    assert.match(first.reason_text ?? '', /roadmap_version 1\b/, 'naming roadmap_version');
    assert.match(first.reason_text ?? '', /roadmap\.json version 1\b/, "naming roadmap.json's version");
    const refused = planChecksOf(fx.home, A.p).filter((c) => c.outcome === 'refused' && String(c.reasons).includes('PLAN_STALE_BASELINE'));
    assert.ok(refused.length >= 1, `a plan_checks row records the refusal (${JSON.stringify(planChecksOf(fx.home, A.p).map((c) => [c.outcome, c.reasons]))})`);
    S.reasonD = first.reason_text;
  });

  test('(e) the retry: parked at repair_attempts_max with its blocker; retry; eligible, dispatched once, its package stating the facts of (a); published; building, then its build; no duplicate replan work; iteration 1\'s environment unchanged throughout', async () => {
    const { fx, A, item } = S;
    assert.ok(item, '(a) parked the replan');
    const runs = runsOfItem(fx.home, item.id);
    assert.equal(runs.length, 2, `one automatic repair: two runs (${runs.map((r) => r.outcome).join(', ')})`);
    assert.deepEqual([runs[1].outcome, runs[1].reason_class], ['failed', 'invalid_result'], `the repair refused too (${runs[1].reason_text})`);
    assert.match(runs[1].reason_text ?? '', /PLAN_STALE_BASELINE/);
    S.reasonRepair = runs[1].reason_text;
    const parked = itemOfIteration(fx.home, A.p, A.two);
    assert.equal(parked.status, 'parked');
    assert.equal(JSON.parse(parked.blocker ?? 'null')?.reason, 'repair_attempts_max', `parked at repair_attempts_max (${parked.blocker})`);
    const blockers = rows(fx.home, `SELECT * FROM "decisions" WHERE "subject_id" = ? AND "kind" = 'blocker' AND "status" = 'open'`, item.id);
    assert.equal(blockers.length, 1, 'its blocker is open');
    assert.ok(JSON.parse(blockers[0].options).some((o) => o.key === 'retry'), 'offering retry');
    const itRead = await iterationRead(fx, A.p, A.two);
    S.iterationWhileParked = [itRead.iteration.status, itRead.outcome?.reason ?? null];
    await envUnchanged(fx, A, 'parked');
    const itemsBefore = replanItems(fx.home, A.p).map((w) => w.id);

    // The retry's Architect writes what (a)'s package states.
    resetKinds(fx);
    kindNext(fx, 'replan', [laterPlanScript(S.stated)], FIRST_PLAN);
    // Paused across the answer: the item's eligibility is observed before any dispatch.
    await quiesce(fx, A.p);
    const d = await decisionRead(fx, A.p, blockers[0].id);
    await ok(fx.engine.post(`/v1/projects/${A.p}/decisions/${d.id}/answer`, { option: 'retry', preview_hash: d.preview_hash }), 200, 'the owner answers retry');
    const eligible = itemOfIteration(fx.home, A.p, A.two);
    assert.equal(eligible.status, 'eligible', `the item eligible (${eligible.status})`);
    assert.equal(runsOfItem(fx.home, item.id).length, 2, 'not dispatched while paused');
    await envUnchanged(fx, A, 'retry answered');
    secondBuildScripts(fx);
    await resumeProject(fx.engine, A.p);
    await pump(fx, A.p, async () => {
      await envUnchanged(fx, A, 'the retry runs');
      const third = runsOfItem(fx.home, item.id)[2];
      if (third?.state === 'ended' && third.outcome !== 'succeeded' && third.outcome !== 'completed') throw new Error(`(e) the retry's plan was refused: ${third.outcome}/${third.reason_class}: ${third.reason_text}`);
      return eventsFor(fx.home, 'prototype.plan_policy_authorized', 'iteration', A.two)[0];
    }, { what: "App A's retried phase-2 plan published" });
    const after3 = runsOfItem(fx.home, item.id);
    assert.equal(after3.length, 3, `dispatched once (${after3.map((r) => r.outcome).join(', ')})`);
    const own = statedVersions(dumpedPackage(fx, after3[2]), { roadmap: true, architecture: false });
    assert.deepEqual(versionsOnly(own), versionsOnly(S.stated), "the retry's package states the facts of (a)");
    const plan = plansOf(fx.home, A.p).find((x) => x.phase_number === 2 && x.status === 'published');
    assert.ok(plan, 'the phase-2 plan published');
    assert.equal(plan.prepared_against_revision, own.revision, 'prepared against the revision its package stated');
    assert.equal((await iterationRead(fx, A.p, A.two)).iteration.status, 'building', 'the iteration building');
    assert.deepEqual(replanItems(fx.home, A.p).map((w) => w.id), itemsBefore, 'no duplicate replan work');
    // On to its build: the stage built; nothing deployed (iteration 1's environment as it was).
    await pump(fx, A.p, async () => {
      await envUnchanged(fx, A, 'the build');
      return runsOfKind(fx.home, A.two, 'stage_build').find((r) => r.state === 'ended');
    }, { what: "iteration 2's stage build", answer: CHECK_KINDS });
    await quiesce(fx, A.p);
    assert.equal(runsOfItem(fx.home, item.id).length, 3, 'no further replan run');
    assert.deepEqual(replanItems(fx.home, A.p).map((w) => w.id), itemsBefore, 'no duplicate replan work after the build');
    await envUnchanged(fx, A, 'at the end');
  });

  test('(f) the first plan and the phase-1-again plan: the versions their packages state are those their publication carried', async () => {
    const { fx } = S;
    // The first plans of the apps above (each iteration 1's replan).
    const firsts = [S.A, S.B, S.C].filter(Boolean);
    for (const app of firsts) {
      assert.equal(app.firstReplan.length, 1, 'one first-plan run');
      const pkg = dumpedPackage(fx, app.firstReplan[0]);
      const stated = statedVersions(pkg, { roadmap: true, architecture: true });
      const archs = archRevs(fx.home, app.p);
      const roads = roadRevs(fx.home, app.p);
      const plan1 = plansOf(fx.home, app.p).find((x) => x.phase_number === 1);
      assert.deepEqual(versionsOnly(stated), { spec_version: 1, architecture_version: versionOf(archs, plan1.prepared_against_architecture), roadmap_version: versionOf(roads, plan1.prepared_against_roadmap), roadmap_json_version: 1, roadmap_json_architecture_version: 1 }, `the first plan's stated versions are those it was published with (${stated.source}: ${JSON.stringify(stated)})`);
    }

    // The phase-1-again plan (M610 (e)): iteration 1 limit_reached with its
    // phase-1 plan open; Iterate closes it; iteration 2 plans phase 1 again,
    // R4 added to it (the roadmap changes; the architecture does not).
    resetKinds(fx);
    const { id: q, it } = await toBrief(fx, { name: 'Tasks replan D', policy: { prototype_repairs_per_stage: 1 } });
    APPS.push(q);
    const failing = () => ({ steps: [usage(300, 0, 100), { exit: 3 }] });
    kindNext(fx, 'stage_build', [builderScript(1), failing(), failing()], builderScript(1));
    await answerOpen(fx, q, 'spec_approval');
    await alphaReady(fx, q, { port: 18134 });
    await pump(fx, q, statusIs(fx, q, it.id, 'limit_reached'), { answer: CHECK_KINDS, max: 100, what: 'App D iteration 1 limit_reached' });
    await idle(fx, q);
    const firstD = runsOfKind(fx.home, it.id, 'replan');
    const made = await ok(fx.engine.post(`/v1/projects/${q}/iterations/${it.id}/iterate`, { change: CHANGE }), 201, 'POST …/iterate');
    const two = made.iteration.id;
    const REQS_E = [...REQS, { ...REQ4, phase: 1 }];
    const KEYS_E = REQS_E.map((r) => r.key);
    const ROADMAP_E = { version: 2, architecture_version: 1, phases: [{ number: 1, goal: 'the task list and its open count, end to end', modules: ['app'], requirement_ids: KEYS_E, depends_on: [] }] };
    const STAGES_E = [{ number: 1, goal: 'the task list and its open count', tasks: ['the task list and its open count'], modules: ['app'], implements: KEYS_E, adrs: [], depends_on: [], validation: { criteria: KEYS_E.map((k) => `${k}.1`), kinds: ['acceptance', 'smoke'], sensitive_areas: [] }, integration_obligations: [] }];
    const again = dumped({
      steps: [
        usage(1800, 0, 700),
        write('.surety/roadmap/roadmap.json', json(ROADMAP_E)),
        write('.surety/roadmap/roadmap.md', '# Roadmap\n\n1. The task list and its open count, end to end (R1, R2, R3, R4).\n'),
        { write: { path: '.surety/phases/phase-1.json', content: json({ phase: 1, prepared_against: { spec_version: 2, architecture_version: 1, roadmap_version: 2, revision: '__HEAD__' }, stages: STAGES_E, conformance: 'within_baseline' }), substitute_head: true } },
        write('.surety/phases/phase-1.md', '# Phase 1\n\n- Stage 1: the task list and its open count\n'),
        result({ summary: "iteration 2's first plan: phase 1 again", plan: 'phase-1', conformance: 'within_baseline' }),
      ],
    });
    kindNext(fx, 'brief_preparation', [prepScript({ spec: specText({ version: 2, reqs: REQS_E, changeLog: [{ version: 2, change: 'Show the number of open tasks at the top' }] }), brief: modelBrief({ objectives: REQS_E.map((r) => `${r.key}: ${r.statement}`), included: ['adding, listing and finishing tasks', 'the number of open tasks'] }) })], prepScript());
    kindNext(fx, 'replan', [again], FIRST_PLAN);
    await answerOpen(fx, q, PROTO.preparation.decision);
    await pump(fx, q, statusIs(fx, q, two, 'awaiting_brief_approval'), { what: "App D iteration 2's brief" });
    await answerOpen(fx, q, 'spec_approval');
    await pump(fx, q, async () => {
      noRefusal(fx, two, '(f) the phase-1-again plan');
      return eventsFor(fx.home, 'prototype.plan_policy_authorized', 'iteration', two)[0];
    }, { what: "App D's phase-1-again plan published" });
    await quiesce(fx, q);
    // App D's first plan too.
    const stated1 = statedVersions(dumpedPackage(fx, firstD[0]), { roadmap: true, architecture: true });
    assert.deepEqual(versionsOnly(stated1), { spec_version: 1, architecture_version: 1, roadmap_version: 1, roadmap_json_version: 1, roadmap_json_architecture_version: 1 }, `App D's first plan: stated as published (${JSON.stringify(stated1)})`);
    // The phase-1-again plan: published as before (roadmap 2 on architecture 1); what its package states.
    const archs = archRevs(fx.home, q);
    const roads = roadRevs(fx.home, q);
    const plan = plansOf(fx.home, q).find((x) => x.phase_number === 1 && x.status === 'published');
    assert.ok(plan, 'the phase-1-again plan published');
    const published = { architecture: versionOf(archs, plan.prepared_against_architecture), roadmap: versionOf(roads, plan.prepared_against_roadmap) };
    assert.deepEqual(published, { architecture: 1, roadmap: 2 }, 'published as before: roadmap 2 on architecture 1');
    const [run] = runsOfKind(fx.home, two, 'replan');
    const stated = statedVersions(dumpedPackage(fx, run), { roadmap: true, architecture: false });
    S.statedAgain = stated;
    assert.deepEqual(versionsOnly(stated), { spec_version: 2, architecture_version: 1, roadmap_version: 2, roadmap_json_version: 2, roadmap_json_architecture_version: 1 }, `the phase-1-again plan's package states the versions its publication carried (${stated.source}: ${JSON.stringify(stated)})`);
  });
});
