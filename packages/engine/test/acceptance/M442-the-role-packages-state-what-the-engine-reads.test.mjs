// M442 (a), the role packages say what the engine reads (M5 slice 38; kernel
// lane). M5 plan §3.8 M442 (a); E135; E87 item 10; BS5 §3 "the role
// packages", §12; D6 §3.5, §5.3, §5.4, §6.2, §8.3, Appendix B; N04, B13;
// SEAM.md §§453, 454.
//
// Each package states, as a `json surety-reads <id>` block of its prompt.md
// listed in its manifest's `reads` (the Builder's design, SEAM.md §453), what
// the engine's parser or gate reads of its role's product, in the shapes
// §454 pins:
//   (a1) the Spec Writer's session package: TPL's header fields, B.2's forms
//        (`### R<n>`, the statement, the `**Sensitive areas:**` line, the
//        criterion items, the marks, §10's question form with its phase
//        hint), §5's columns with `Origin`, §6's module table, §7's
//        environment fields, the closed area list, the tier table and
//        `spec_approval`'s option blockers; (a2) in retrofit also §12's
//        claims table;
//   (a3) the Architect's session package and (a4) its replan one-shot's:
//        B.3 to B.6 as closed JSON Schemas, the plan reasons of D6 A.4 with
//        the tiers' kinds, §5.4's computed routing; in retrofit (a2) the
//        retrofit reasons too;
//   (a5) the phase-authoring Verifier's: the kinds, each gate's kind floor
//        at the project's tier (E135), `requires`, `covers`, `secrets`, the
//        post-deploy kinds and the authoring result with its governed-change
//        permissions and "a proposal grants no execution authority", its
//        fields in result-schema.json; (a2) in retrofit D6 §8.3's adoption
//        rule with `adopted_tests` and the dependency boundary;
//   (a6) the correction Verifier's: the same check-writing elements without
//        the governed-change permissions or the adoption rule;
//   (a7) the Builder's: its stage's tasks, `implements`, integration
//        obligations and its dependencies' interfaces, as registered;
//   (a8) the registry (`GET /v1/harness/package-elements`) lists every id.
//
// The packages are captured by `context_dump` on the reference journey of
// M401 (Tally, T2) and on the retrofit journey of M408 (Sums, T1), driven on
// the scripted backend through the owner's routes. A gap is listed with every
// other gap of its package in one assertion.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { runningClassifier, setEngineConfig } from './harness/checks/classifier.mjs';
import { consume, decision } from './harness/decisions.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { roleThat } from './harness/gitruns.mjs';
import {
  JOURNEY_POLICY,
  alphaReady,
  authoringScript,
  builderScript,
  changeRequest,
  correctionScript,
  createWithIdea,
  journeyContext,
  journeyScripts,
  nextPhasePublished,
  phaseCompleted,
  phasePlansOf,
  pump,
  replanScript,
  requirementsOf,
  specChangeScript,
  specSession,
  stagesOfPlan,
  visionSession,
  waitPublished,
} from './harness/journey/drive.mjs';
import { MODULES_JSON, architectFiles } from './harness/journey/reference.mjs';
import { tickUntil } from './harness/runs.mjs';
import { closeSession, openSession, packageOf, saveSession, sayAndSettle, scriptTurns, turnThatDumps } from './harness/sessions.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { ADOPTED_PHASE_SIZE, activePlan, ownerPolicy } from './harness/journey/drive.mjs';
import { FULL_ANSWERS, adoptProject, chooseMode, confirmAndApprove, retrofitEngine } from './harness/retrofit/drive.mjs';
import { SPEC as RETROFIT_SPEC, authoringFiles as retrofitAuthoringFiles, authoringResult, retrofitArchitectFiles } from './harness/retrofit/products.mjs';
import { refOid } from './harness/retrofit/repo.mjs';
import { step } from './harness/scripted.mjs';
import {
  ALL_ELEMENTS,
  ARCHITECT_ELEMENTS,
  AUTHORING_ELEMENTS,
  AUTHORING_RETROFIT_ELEMENTS,
  BUILDER_ELEMENTS,
  CORRECTION_ABSENT,
  CORRECTION_ELEMENTS,
  SPEC_WRITER_ELEMENTS,
  SPEC_WRITER_RETROFIT_ELEMENTS,
  packageProblems,
  packageReads,
} from './harness/real/packages.mjs';

const DUMP = Object.freeze({ probe: { action: 'context_dump' } });
const dumped = (s) => ({ ...s, steps: [DUMP, ...s.steps] });
const json = (v) => (v === null || v === undefined ? v : typeof v === 'string' ? JSON.parse(v) : v);

// Every package a launch of `kind` dumped, in launch order: [{launch, files}].
function dumpsOfKind(fx, kind) {
  const out = [];
  for (const launch of fx.scripted.launches().filter((l) => l.work_kind === kind)) {
    const dump = fx.scripted.probes(launch.invocation, 'context_dump').at(-1);
    if (dump?.outcome !== 'dumped') continue;
    out.push({ launch, files: Object.fromEntries((dump.files ?? []).filter((f) => f.type === 'file').map((f) => [f.name, f.text ?? null])) });
  }
  return out;
}

// A stage as the store registered it, keys and numbers resolved: what the
// Builder's package must state of it (§454).
function stageFacts(home, project, plan, number) {
  const stages = stagesOfPlan(home, plan);
  const byId = new Map(stages.map((s) => [s.id, s.number]));
  const keys = new Map(requirementsOf(home, project).map((r) => [r.id, r.key]));
  const s = stages.find((x) => x.number === number);
  if (!s) return null;
  const depends = (s.depends_on ?? []).map((d) => (typeof d === 'number' ? d : (byId.get(d) ?? d)));
  const obligations = json(withStore(home, (db) => db.prepare('SELECT "integration_obligations" FROM "stages" WHERE "id" = ?').get(s.id))?.integration_obligations ?? '[]');
  return { number: s.number, goal: s.goal, tasks: s.tasks, implements: (s.implements ?? []).map((k) => keys.get(k) ?? k), integration_obligations: obligations, depends_on: depends, modules: json(s.modules) ?? [] };
}

// The module map's interfaces of the stages a stage depends on ("module:name").
// A stage row lists its modules by id (D3 §4.1); each is resolved to its name.
function dependencyInterfaces(home, project, plan, stage) {
  const stages = stagesOfPlan(home, plan);
  const names = new Map(withStore(home, (db) => db.prepare('SELECT "id", "name" FROM "modules" WHERE "project" = ?').all(project)).map((m) => [m.id, m.name]));
  const modules = new Set(stages.filter((s) => stage.depends_on.includes(s.number)).flatMap((s) => (json(s.modules) ?? []).map((m) => names.get(m) ?? m)));
  assert.ok(modules.size > 0 || stage.depends_on.length === 0, `the modules of the stages stage ${stage.number} depends on are known (${JSON.stringify([...modules])})`);
  return MODULES_JSON.modules.filter((m) => modules.has(m.name)).flatMap((m) => (m.interfaces ?? []).map((i) => `${m.name}:${i.name}`));
}

const assertNoGaps = (problems, what) => assert.deepEqual(problems, [], `${what}: every element the engine reads is stated (SEAM.md §454); the gaps:\n- ${problems.join('\n- ')}`);

describe('M442 (a) the role packages say what the engine reads: the journey from an idea', () => {
  const shared = sharedFixture();
  let J;
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    const version = await runningClassifier(fx.engine);
    setEngineConfig(fx, { classifier_authority: { mode: 'authoritative', version } });
    await fx.engine.kill();
    await fx.start();
    journeyScripts(fx);
    // Every one-shot the journey runs dumps its package first, then does as M401's does.
    fx.scripted.kindScript('check_authoring', [dumped(authoringScript(1)), dumped(authoringScript(2)), dumped(authoringScript(2)), dumped(authoringScript(2))]);
    fx.scripted.kindScript('stage_build', [1, 2, 3, 4, 4].map((n) => dumped(builderScript(n))));
    fx.scripted.kindScript('replan', [dumped(replanScript()), dumped(replanScript({ spec_version: 2 })), dumped(replanScript({ spec_version: 2 }))]);
    fx.scripted.kindScript('spec_change', dumped(specChangeScript()));
    fx.scripted.kindScript('check_correction', dumped(correctionScript()));
    const p = await createWithIdea(fx, { policy: JOURNEY_POLICY });
    await visionSession(fx, p.id);
    const spec = await specSession(fx, p.id, { dumpSecond: true });
    // The Architect's session, its one turn dumping its package first.
    const run = await openSession(fx, p.id, 'architect');
    scriptTurns(fx, run.id, [turnThatDumps(architectFiles({ revision: refOid(p.repo.path, p.repo.ref) }), { reply: 'Architecture, module map, one ADR, the roadmap and the plan for phase 1.', done: true })]);
    await sayAndSettle(fx, p.id, run.id, 'Design Tally from the approved specification and plan phase 1.');
    await saveSession(fx, p.id, run.id);
    const closed = await closeSession(fx, p.id, run.id);
    for (const d of closed.decisions ?? []) await consume(fx, p.id, decision(fx.home, d.id), 'approve');
    const plan1 = await waitPublished(fx, p.id);
    const ctx = journeyContext(fx, p, { lane: 'kernel', tier: 'T2' });
    await alphaReady(fx, ctx);
    await phaseCompleted(fx, ctx, 1);
    await nextPhasePublished(fx, ctx, 2);
    await changeRequest(fx, ctx);
    await pump(fx, ctx, () => (dumpsOfKind(fx, 'check_correction').length > 0 ? true : undefined), { what: "CR-1's check correction to run", max: 60 });
    J = { fx, p, plan1, spec: packageOf(fx, spec.run.id, 1), architect: packageOf(fx, run.id, 0) };
  });
  after(shared.cleanup);

  test("(a1) the Spec Writer's session package: the header, B.2's forms, the index with Origin, the module table, the environment fields, the closed areas, the tier table and spec_approval's blockers", () => {
    assert.ok(J.spec, 'the Spec Writer\'s second turn dumped its package');
    assertNoGaps(packageProblems(J.spec, SPEC_WRITER_ELEMENTS, { facts: { tier: 'T2' } }), "the Spec Writer's package");
  });

  test("(a3) the Architect's session package: B.3 to B.6 as closed schemas, the plan reasons with the tiers' kinds, the computed routing", () => {
    assert.ok(J.architect, 'the Architect\'s turn dumped its package');
    assertNoGaps(packageProblems(J.architect, ARCHITECT_ELEMENTS), "the Architect's session package");
  });

  test("(a4) the Architect's replan one-shot package: the same schemas, reasons and routing", () => {
    const replans = dumpsOfKind(J.fx, 'replan');
    assert.ok(replans.length > 0, 'the replan dumped its package');
    assertNoGaps(packageProblems(replans[0].files, ARCHITECT_ELEMENTS), "the replan's package");
  });

  test("(a5) the phase-authoring Verifier's package: kinds, the floor at T2, requires, covers, secrets, the post-deploy kinds, the authoring result with its permissions in result-schema.json", () => {
    const authoring = dumpsOfKind(J.fx, 'check_authoring');
    assert.ok(authoring.length > 0, 'phase 1\'s authoring dumped its package');
    const problems = packageProblems(authoring[0].files, AUTHORING_ELEMENTS, { absent: ['verifier.adoption_rule'], facts: { tier: 'T2' } });
    const schema = packageReads(authoring[0].files).resultSchema;
    const props = schema?.properties ?? {};
    if (!props.governed_changes?.properties?.check_commands) problems.push('result-schema.json: governed_changes with check_commands');
    if (!props.deferred_criteria) problems.push('result-schema.json: deferred_criteria');
    assertNoGaps(problems, "the phase-authoring Verifier's package");
  });

  test("(a6) the correction Verifier's package: the check-writing elements, without the governed-change permissions or the adoption rule", () => {
    const corrections = dumpsOfKind(J.fx, 'check_correction');
    assert.ok(corrections.length > 0, 'CR-1\'s correction dumped its package');
    const problems = packageProblems(corrections[0].files, CORRECTION_ELEMENTS, { absent: CORRECTION_ABSENT, facts: { tier: 'T2' } });
    const props = packageReads(corrections[0].files).resultSchema?.properties ?? {};
    if ('governed_changes' in props) problems.push('result-schema.json: a correction states no governed_changes');
    if ('adopted_tests' in props) problems.push('result-schema.json: a correction states no adopted_tests');
    assertNoGaps(problems, "the correction Verifier's package");
  });

  test("(a7) the Builder's package: its stage's tasks, implements, integration obligations and its dependencies' interfaces, as registered", () => {
    const builds = dumpsOfKind(J.fx, 'stage_build');
    assert.ok(builds.length >= 2, `phase 1's two Builders dumped their packages (${builds.length})`);
    const problems = [];
    for (const number of [1, 2]) {
      const stage = stageFacts(J.fx.home, J.p.id, J.plan1.id, number);
      assert.ok(stage, `stage ${number} is registered`);
      const facts = { stage, dependencyInterfaces: dependencyInterfaces(J.fx.home, J.p.id, J.plan1.id, stage) };
      const own = builds.find((b) => packageReads(b.files).blocks['builder.tasks']?.stage === number) ?? builds[number - 1];
      problems.push(...packageProblems(own.files, BUILDER_ELEMENTS, { facts }).map((s) => `stage ${number}: ${s}`));
    }
    assertNoGaps(problems, "the Builders' packages");
  });

  test('(a8) the registry lists every element id, each with the packages that carry it', async () => {
    const res = await J.fx.engine.get('/v1/harness/package-elements');
    assert.equal(res.status, 200, `GET /v1/harness/package-elements (SEAM.md §453) (→ ${res.status} ${res.text})`);
    const ids = (res.body?.elements ?? []).map((e) => e.id);
    assert.deepEqual(ALL_ELEMENTS.filter((id) => !ids.includes(id)), [], `every element id is in the registry (${JSON.stringify(ids)})`);
    for (const e of res.body.elements) assert.ok(typeof e.title === 'string' && Array.isArray(e.packages), `${e.id}: a title and its packages (${JSON.stringify(e)})`);
  });
});

describe('M442 (a2) the role packages in retrofit mode: the adopted repository', () => {
  const shared = sharedFixture();
  let R;
  before(async () => {
    const fx = await retrofitEngine(shared.context);
    fx.scripted.kindScript('check_authoring', [dumped(roleThat(Object.entries(retrofitAuthoringFiles()).map(([path, text]) => step.write(path, text)), authoringResult()))]);
    const p = await adoptProject(fx);
    await chooseMode(fx, p.id, 'full');
    await ownerPolicy(fx, p.id, { phase_size: ADOPTED_PHASE_SIZE });
    // The retrofit Spec Writer's one turn dumps its package first.
    const sw = await openSession(fx, p.id, 'spec_writer');
    scriptTurns(fx, sw.id, [turnThatDumps({ '.surety/spec/spec.md': RETROFIT_SPEC }, { reply: 'The specification of the code as it is, with the claims table.', done: true })]);
    await sayAndSettle(fx, p.id, sw.id, 'Describe the repository as it is.');
    await saveSession(fx, p.id, sw.id);
    await closeSession(fx, p.id, sw.id);
    await confirmAndApprove(fx, p.id, FULL_ANSWERS);
    // The retrofit Architect's one turn dumps its package first.
    const ar = await openSession(fx, p.id, 'architect');
    scriptTurns(fx, ar.id, [turnThatDumps(retrofitArchitectFiles({ revision: refOid(p.repo.path, p.repo.ref) }), { reply: 'The architecture as it is and the conformance plan.', done: true })]);
    await sayAndSettle(fx, p.id, ar.id, 'Reconstruct the architecture and plan the conformance phase.');
    await saveSession(fx, p.id, ar.id);
    const closed = await closeSession(fx, p.id, ar.id);
    for (const d of closed.decisions ?? []) await consume(fx, p.id, decision(fx.home, d.id), 'approve');
    await tickUntil(fx.engine, p.id, () => activePlan(fx.home, p.id) ?? undefined, { max: 6, what: 'the conformance plan to be published' });
    const ctx = journeyContext(fx, { id: p.id, repo: p.repo }, { tier: 'T1' });
    await pump(fx, ctx, () => (dumpsOfKind(fx, 'check_authoring').length > 0 ? true : undefined), { what: "the conformance phase's authoring to run", max: 30 });
    R = { fx, p, spec: packageOf(fx, sw.id, 0), architect: packageOf(fx, ar.id, 0), authoring: dumpsOfKind(fx, 'check_authoring')[0]?.files ?? null };
  });
  after(shared.cleanup);

  test("(a2) the retrofit Spec Writer's package adds the claims table; the retrofit Architect's names the retrofit reasons; the retrofit authoring package states the adoption rule and adopted_tests with the dependency boundary", () => {
    assert.ok(R.spec && R.architect && R.authoring, `each package was dumped (spec ${Boolean(R.spec)}, architect ${Boolean(R.architect)}, authoring ${Boolean(R.authoring)})`);
    const problems = [
      ...packageProblems(R.spec, SPEC_WRITER_RETROFIT_ELEMENTS, { facts: { tier: 'T1' } }).map((s) => `spec_writer: ${s}`),
      ...packageProblems(R.architect, ARCHITECT_ELEMENTS, { facts: { retrofit: true } }).map((s) => `architect: ${s}`),
      ...packageProblems(R.authoring, AUTHORING_RETROFIT_ELEMENTS, { facts: { tier: 'T1', retrofit: true } }).map((s) => `check_authoring: ${s}`),
    ];
    const adopted = packageReads(R.authoring ?? {}).resultSchema?.properties?.adopted_tests;
    const disposition = adopted?.items?.properties?.dependency_boundary?.items?.properties?.disposition?.enum;
    if (JSON.stringify(disposition) !== JSON.stringify(['copied', 'replaced', 'application'])) problems.push(`check_authoring: result-schema.json adopted_tests[].dependency_boundary[].disposition copied | replaced | application (got ${JSON.stringify(disposition)})`);
    assertNoGaps(problems, 'the retrofit packages');
  });
});
