// M517, a design change after the final phase (slice 44; kernel lane). M6
// plan §3.6 M517; D7 §10.3, §10.4, §10.6; G7; Q6; E153 item 1; E156 Q2;
// BS6 §6; SEAM.md §§471, 502, 518.
//
// The trigger keeps the name it was built with, `spec_change` (E156 Q2):
// an accepted naming deviation from D7 A.2's `post_phase_change`, no rename
// and no migration (COVERAGE's declared deviation). M433's E153 file stays as
// written. Pantry, its design approved before build (every slot a
// placeholder, no design criterion), built and `alpha_deployed` under
// `on_phase_complete`: every roadmap phase complete. Then the owner reviews
// his Android build (D7 §10.5) and finds a design delta: the role's revised
// design adds R3.2 (`state_marker_present` on android), confirmed and
// approved with its consolidated spec change.
// (g) the corrected check's result on the Alpha candidate not yet recorded
//     (queued): nothing registered while the evidence is unresolved;
// (a) the corrected check failing on the Alpha candidate: one Architect
//     replan, `trigger_source` `spec_change` with the request as its
//     identity, proposing a delivery phase by roadmap revision, routed to
//     `plan_approval`;
// (d) repeated ticks and a restart: one per change request and roadmap
//     generation;
// (f) the delivery phase built, verified and `alpha_deployed` under
//     `alpha_deploy`; phase 1's bindings, sign-offs and records unchanged;
// (b) the same with the corrected check passing on the Alpha candidate: no
//     replan, no build phase (E156 Q2: the corrections establish the
//     candidate already satisfies the change);
// (c) a change carrying only human-test requirements: none;
// (e) the replan's plan refused (and its repair): an owner question naming
//     it, never a silent stall.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { definitionText } from './harness/checks/fixtures.mjs';
import { scriptCall } from './harness/deploy/kernel.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { roleThat } from './harness/gitruns.mjs';
import {
  alphaDeployed,
  candidatesOfProject,
  deploymentRequests,
  environmentsOf,
  openDecisions,
  phaseCompleted,
  planChecks,
  planOfPhase,
  pump,
  queuedExecutions,
  resultsOf,
  runsOfProject,
  stagesOfPlan,
} from './harness/journey/drive.mjs';
import { allReplans, beyondPhaseOne, changeReplans, phaseOneHistory } from './harness/journey/final153.mjs';
import { scriptedEngine, tick, waitForIdle } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { ADR_KEY, APP_JS, REQUIREMENTS, T2_KINDS } from './harness/design/reference.mjs';
import { toAlphaWithPlaceholders } from './harness/design/assets43.mjs';
import { filesOf, variantOf } from './harness/design/check41.mjs';
import { approveReviewBatch, authoringByPhase, batchSpec, currentRoadmap, latestRequest, ownerReview, replanWith, reviewFileOf, revisedHumanTests, roadmapRevision, specOf, specWriter } from './harness/design/plan44.mjs';

const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const WRAPPER_PATH = '.surety/checks/wrapper.mjs';
const MARKER_TEST = '.surety/checks/tests/marker-android.test.mjs';
const MARKER = 'marker-android';
const R3_2 = 'Given the mobile module, when mobile/App.js is read, then each row of the list carries the accessibility label "pantry-item".';
const CRITERION = Object.freeze({ requirement: 'R3', text: R3_2, kind: 'state_marker_present', targets: ['android'], paths: ['mobile/App.js'] });

// The correction authoring R3.2's check (D6 §4.5): a tightening.
const MARKER_CORRECTION = roleThat(
  [
    step.write(MARKER_TEST, `import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nimport { test } from 'node:test';\n\ntest('R3.2: the rows carry the label', () => {\n  assert.match(readFileSync('mobile/App.js', 'utf8'), /accessibilityLabel="pantry-item"/);\n});\n`),
    step.write('.surety/checks/defs/marker-android.json', definitionText(MARKER, { inputs: [WRAPPER_PATH, MARKER_TEST], kind: 'acceptance', command: ['node', WRAPPER_PATH, MARKER_TEST], timeout_s: 120, gate_kinds: ['stage', 'alpha_authorize'], covers: { criteria: ['R3.2'] } })),
  ],
  { proposal: { rationale: 'The approved design added R3.2: its check.', requested_change_kind: 'tightening' } },
);
// The delivery stage's Builder: the label added to the Android app.
const DELIVERY_BUILDER = roleThat([step.write('mobile/App.js', APP_JS.replace('return null;', 'return null; // accessibilityLabel="pantry-item"'))]);
const DELIVERY_STAGE = Object.freeze({ number: 4, goal: 'deliver the design change to R3', tasks: ['label each row of the Android list'], modules: ['mobile'], implements: ['R3'], adrs: [ADR_KEY], depends_on: [], validation: { criteria: ['R3.1', 'R3.2'], kinds: T2_KINDS, sensitive_areas: [] }, integration_obligations: [] });

// The delivery replan against the roadmap as it stands: R3 moved from the
// completed phase 1 into a delivery phase 2 (D7 §10.4; E153 item 1).
function deliveryReplan(fx, project, { buildable = true } = {}) {
  const roadmap = roadmapRevision(fx.home, project, (phases) => [
    ...phases.map((p) => (p.number === 1 && buildable ? { ...p, requirement_ids: p.requirement_ids.filter((k) => k !== 'R3') } : p)),
    { number: 2, goal: 'deliver the approved design change to R3', modules: ['mobile'], requirement_ids: buildable ? ['R3'] : [], depends_on: [] },
  ], { moved: buildable ? [{ key: 'R3', from: 1, to: 2 }] : [] });
  return replanWith({ phase: 2, stages: [DELIVERY_STAGE], spec_version: 3, roadmap_version: currentRoadmap(fx.home, project).version, roadmap });
}

// Pantry at Alpha with every phase complete; then the owner's review of his
// Android build with a design delta, the revised design adding R3.2;
// confirmed and approved. `exits(old)`: the boundary's exits by candidate.
// Returns {fx, p, ctx, old, request, history}.
async function reviewedAfterTheLastPhase(context, name, { replan = 'buildable' } = {}) {
  const fx = await scriptedEngine(context);
  const a = await toAlphaWithPlaceholders(fx, { name });
  const { p, ctx, model } = a;
  await waitForIdle(fx.home, p.id);
  assert.deepEqual(planOfPhase(fx.home, p.id, 1).map((x) => x.status), ['completed'], 'the fixture is live: every roadmap phase complete');
  assert.deepEqual(allReplans(fx.home, p.id), [], 'the fixture is live: no replan yet');
  const history = phaseOneHistory(fx.home, p.id);
  const old = new Set(candidatesOfProject(fx.home, p.id).map((c) => c.id));
  // The scripts after the last phase.
  const v2 = batchSpec({ base: REQUIREMENTS, criteria: model.criteria });
  const revised = variantOf(model, (m) => {
    m.design.version = 2;
    m.criteria.criteria = [{ ...CRITERION }];
  });
  const v3 = batchSpec({ base: v2.requirements.filter((r) => !Object.values(v2.humanKeys).includes(r.key)), criteria: revised.criteria, version: 3, humanKind: 'text_changed', humanKeys: v2.humanKeys });
  fx.scripted.kindScript('spec_change', specWriter(v3.text, [{ key: 'R3', kind: 'criteria_added', reason: 'the owner\'s design delta: R3.2' }]));
  fx.scripted.kindScript('check_correction', MARKER_CORRECTION);
  authoringByPhase(fx);
  fx.scripted.kindScript('stage_build', DELIVERY_BUILDER);
  // One more deploy answered by the scripted adapter, for the delivery phase's Alpha.
  const env = environmentsOf(fx.home, p.id).find((e) => e.name === 'alpha');
  await scriptCall(fx.engine, env.id, 'deploy', [{ result: 'issued', apply: true }]);
  // The owner's review of his Android build (D7 §10.5): a design delta, the revised design written.
  const screens = [{ target: 'android', key: model.keyOf.android, verdict: 'deltas', observed_on: 'device', evidence: [], deltas: [{ owner_words: 'A screen reader does not announce the rows.', kind: 'design' }] }];
  const files = { ...filesOf(revised), '.surety/design/reviews/review-1.json': reviewFileOf({ screens, revised_design: true }) };
  const review = await ownerReview(fx, p.id, { files, say: 'On my phone the screen reader skips the rows.' });
  assert.equal(review.close.status, 200, `the review's close (${review.close.text?.slice(0, 600)})`);
  const approved = await approveReviewBatch(fx, ctx);
  assert.equal(approved.version.version, 3, 'the fixture is live: spec version 3 approved');
  const request = latestRequest(fx.home, p.id);
  assert.equal(request.status, 'approved', 'the fixture is live: the design change is approved');
  if (replan === 'buildable') {
    const r = deliveryReplan(fx, p.id);
    fx.scripted.kindScript('replan', [r, r, r]);
  } else {
    const r = deliveryReplan(fx, p.id, { buildable: false });
    fx.scripted.kindScript('replan', [r, r, r]);
  }
  return { fx, p, ctx, old, request, history, v3, revised, model, v2 };
}
const failsOn = (old) => (x) => (x.key === MARKER && old.has(x.candidate) ? 1 : 0);
// The corrected check's results on the Alpha candidate (the newest before the change).
const markerResults = (fx, p, old) => {
  const keyed = new Map(rows(fx.home, 'SELECT r."id", c."key" FROM "check_results" r JOIN "checks" c ON c."id" = r."check" WHERE r."project" = ?', p.id).map((r) => [r.id, r.key]));
  return resultsOf(fx.home, p.id).filter((r) => keyed.get(r.id) === MARKER && old.has(r.candidate));
};

describe('M517 a design change after the final phase: the corrected check failing on the Alpha candidate (shared)', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    Object.assign(J, await reviewedAfterTheLastPhase(shared.context, 'pantry-after-final'));
  });
  after(shared.cleanup);

  test('(g) the corrected check\'s result not yet recorded on the Alpha candidate: nothing registered while it is unresolved', async () => {
    const { fx, p, ctx, old, request } = J;
    const queued = await pump(fx, ctx, () => queuedExecutions(fx.home, p.id).find((x) => x.key === MARKER && old.has(x.candidate)), { what: 'R3.2\'s check queued on the Alpha candidate', max: 60, exits: () => 0 });
    assert.ok(queued, 'queued');
    // Ticks with nothing recorded: the evidence is unresolved (unknown is neither passing nor failing).
    await tick(fx.engine, p.id, { rounds: 4 });
    await waitForIdle(fx.home, p.id);
    assert.deepEqual(changeReplans(fx.home, p.id, request.id), [], 'no replan registered while the result is still to come (E156 Q2)');
    assert.deepEqual(allReplans(fx.home, p.id), [], 'none at all');
  });

  test('(a) the corrected check failing on the Alpha candidate: one Architect replan, trigger spec_change naming the request, a delivery phase by roadmap revision routed to plan_approval', async () => {
    const { fx, p, ctx, old, request } = J;
    ctx.answerKinds = ['check_correction_unclassifiable', 'check_correction_tightening', 'check_correction_loosening'];
    const items = await pump(fx, ctx, () => {
      const x = changeReplans(fx.home, p.id, request.id);
      return x.length > 0 ? x : undefined;
    }, { what: 'the change\'s replan', max: 60, exits: failsOn(old) });
    assert.ok(markerResults(fx, p, old).some((r) => r.exit_status !== 0), 'the fixture is live: R3.2\'s check failed on the Alpha candidate');
    assert.equal(items.length, 1, 'exactly one replan from the change');
    assert.equal(allReplans(fx.home, p.id).length, 1, 'and no other');
    assert.equal(items[0].trigger_source, 'spec_change', 'its trigger keeps the built name spec_change (E156 Q2), not post_phase_change');
    assert.equal(items[0].trigger_id, request.id, 'the request as its identity');
    const approval = await pump(fx, ctx, () => openDecisions(fx.home, p.id).find((d) => d.kind === 'plan_approval'), { what: 'the delivery phase\'s plan_approval', max: 40, exits: failsOn(old) });
    assert.ok(approval, 'routed to plan_approval (D6 §5.4)');
    const run = runsOfProject(fx.home, p.id).find((r) => r.work_item === items[0].id);
    assert.deepEqual([run?.role, run?.kind], ['architect', 'one_shot'], 'an Architect one-shot');
    const check = planChecks(fx.home, p.id).at(-1);
    assert.deepEqual(check?.changes_roadmap?.phases_added, [2], `proposing a delivery phase by roadmap revision (${JSON.stringify(check?.changes_roadmap)})`);
    J.items = items;
  });

  test('(d) repeated ticks and a restart: still one replan for the change and roadmap generation', async () => {
    const { fx, p, request } = J;
    await tick(fx.engine, p.id, { rounds: 3 });
    await waitForIdle(fx.home, p.id);
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, p.id, { rounds: 3 });
    await waitForIdle(fx.home, p.id);
    assert.equal(changeReplans(fx.home, p.id, request.id).length, 1, 'one replan for the change after ticks and a restart');
    assert.equal(allReplans(fx.home, p.id).length, 1, 'no second replan of any trigger');
  });

  test('(f) the delivery phase built, verified and alpha_deployed under the policy; phase 1\'s history unchanged', async () => {
    const { fx, p, ctx, old, history } = J;
    ctx.answerKinds = ['check_correction_unclassifiable', 'check_correction_tightening', 'check_correction_loosening', 'plan_approval'];
    const published = await pump(fx, ctx, () => planOfPhase(fx.home, p.id, 2).find((x) => x.published_at), { what: 'the delivery phase published', max: 30, exits: failsOn(old) });
    assert.deepEqual(stagesOfPlan(fx.home, published.id).map((s) => s.number), [DELIVERY_STAGE.number], 'its one delivery stage');
    const phase2 = await phaseCompleted(fx, ctx, 2, { exits: failsOn(old), max: 200 });
    assert.deepEqual(stagesOfPlan(fx.home, published.id).map((s) => s.status), ['verified'], 'the delivery stage verified');
    const deployed = await alphaDeployed(fx, ctx, { newest: true, exits: failsOn(old), max: 120 });
    assert.equal(deployed.id, phase2.completion_binding?.candidate, 'the delivery phase\'s candidate alpha_deployed');
    assert.ok(deploymentRequests(fx.home, p.id).some((r) => r.requested_by === 'policy' && r.request_key?.candidate === deployed.id), 'by the policy\'s request (alpha_deploy on_phase_complete)');
    const now = phaseOneHistory(fx.home, p.id);
    assert.deepEqual(now.plan, history.plan, 'phase 1\'s plan row: completion binding, generation, status unchanged');
    assert.deepEqual(now.stages, history.stages, 'its stages unchanged');
    assert.deepEqual(now.signoffs, history.signoffs, 'its phase sign-offs unchanged');
    assert.deepEqual(now.phaseEvaluations, history.phaseEvaluations, 'its phase evaluations unchanged');
    assert.deepEqual(now.completions, history.completions, 'its one baseline.phase_complete');
  });
});

describe('M517 a design change after the final phase: no implementation impact', () => {
  test('(b) the corrected check passing on the Alpha candidate: no replan, no build phase; (c) a later change of human-test requirements only: none', async (t) => {
    const { fx, p, ctx, old, request, v3, revised } = await reviewedAfterTheLastPhase(t, 'pantry-satisfied');
    ctx.answerKinds = ['check_correction_unclassifiable', 'check_correction_tightening', 'check_correction_loosening', 'plan_approval'];
    let quiet = 0;
    await pump(fx, ctx, () => (markerResults(fx, p, old).some((r) => r.exit_status === 0) && ++quiet > 12 ? true : undefined), { what: 'R3.2\'s check passing on the Alpha candidate, then quiet', max: 80, exits: () => 0 });
    assert.deepEqual(changeReplans(fx.home, p.id, request.id), [], 'no replan: the correction establishes that the candidate satisfies the change (E153 (d); E156 Q2)');
    assert.deepEqual(beyondPhaseOne(fx.home, p.id).plans, [], 'no build phase');
    // (c) a second review whose revised design changes only its human tests' texts.
    const human = revisedHumanTests(revised, 3);
    const v4 = batchSpec({ base: v3.requirements.filter((r) => !Object.values(v3.humanKeys).includes(r.key)), criteria: human.criteria, version: 4, humanKind: 'text_changed', humanKeys: v3.humanKeys });
    fx.scripted.kindScript('spec_change', specWriter(v4.text, Object.values(v3.humanKeys).map((key) => ({ key, kind: 'text_changed', reason: 'the revised human tests' }))));
    const screens = [{ target: 'android', key: revised.keyOf.android, verdict: 'deltas', observed_on: 'device', evidence: [], deltas: [{ owner_words: 'Judge the list on a tablet too.', kind: 'design' }] }];
    const review = await ownerReview(fx, p.id, { build_ref: 'pantry-android 0.1.1 (build 8)', files: { ...filesOf(human), '.surety/design/reviews/review-2.json': reviewFileOf({ screens, build_ref: 'pantry-android 0.1.1 (build 8)', design_version: 2, revised_design: true }) } });
    assert.equal(review.close.status, 200, `the second review's close (${review.close.text?.slice(0, 400)})`);
    const approved = await approveReviewBatch(fx, ctx);
    assert.equal(approved.version.version, 4, 'spec version 4: human-test requirements only');
    const second = latestRequest(fx.home, p.id);
    for (let i = 0; i < 12; i++) await pump(fx, ctx, () => false, { max: 1, exits: () => 0 }).catch(() => null);
    assert.deepEqual(changeReplans(fx.home, p.id, second.id), [], 'no replan for a change carrying only human-test requirements');
    assert.deepEqual(allReplans(fx.home, p.id), [], 'none at all');
    assert.deepEqual(beyondPhaseOne(fx.home, p.id).plans, [], 'no build phase');
  });

  test('(e) the replan\'s plan refused, and its repair: an owner question on the replan naming the refusal, never a silent stall', async (t) => {
    const { fx, p, ctx, old, request } = await reviewedAfterTheLastPhase(t, 'pantry-unbuildable', { replan: 'unbuildable' });
    ctx.answerKinds = ['check_correction_unclassifiable', 'check_correction_tightening', 'check_correction_loosening', 'plan_approval'];
    const item = await pump(fx, ctx, () => changeReplans(fx.home, p.id, request.id)[0], { what: 'the change\'s replan', max: 60, exits: failsOn(old) });
    const blocker = await pump(fx, ctx, () => openDecisions(fx.home, p.id).find((d) => d.kind === 'blocker' && d.subject_id === item.id), { what: 'an owner question on the refused replan', max: 40, exits: failsOn(old) });
    const refused = planChecks(fx.home, p.id).filter((c) => c.outcome === 'refused').at(-1);
    const code = refused?.reasons?.[0]?.code;
    assert.ok(code && (blocker.question ?? '').includes(code), `the question names the plan check's refusal (${code}; ${blocker.question})`);
    assert.ok(blocker.options.some((o) => o.key === 'retry'), `and is actionable (${JSON.stringify(blocker.options.map((o) => o.key))})`);
    assert.deepEqual(beyondPhaseOne(fx.home, p.id).stages, [], 'no stage registered from the refused proposal');
  });
});
