// M406, phase completion's effects, once per binding (slice 31b; kernel
// lane). M5 plan §3.1 M406; D6-F03; D6 §5.6, §5.8; K5; F §3.10.4; B06;
// SEAM.md §§350 to 352.
//
// The reference project's phase 1 is built on the scripted backend under
// `autonomy: phase` (D6 §1 steps 5 to 8), the harness answering only the
// toolchain proposal (Q9), at T2 (the shared fixture) and at T1 (the driver's
// ruling: the phase gate on both tiers).
//   (a) the `phase` gate satisfied and the sign-off recorded, a next phase in
//       the roadmap: `completed_at`, `completion_binding`, every stage
//       `verified`, `baseline.phase_complete`, one `replan` from the trigger
//       (phase_complete, <plan>, 1); at T1 the same with no sign-off;
//   (b) no next phase: no `replan`; the build complete, the request by command
//       works (§6.8);
//   (c) the candidate's progress and the authorizations unchanged before and
//       after: completion issues no authorization and advances no candidate;
//   (d) repeated ticks and a restart: no second completion, no second replan;
//   (e) a later regression on a successor candidate: history unchanged; the
//       deploy request refuses through the gate that rereads. The row's
//       other current effect, the next plan's dependency clause
//       (PLAN_DEPENDENCY_INCOMPLETE, D6 §5.3 item 3), has no plan check to
//       reread it in this journey: the reference project's only next plan,
//       phase 2, is published before any successor candidate exists (a T2
//       successor is a phase-2 stage's). A plan check after a regression
//       needs an early replan (M430) or the prerequisite clause's own row
//       (M426 (a)); not claimed here.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { assertRefused } from './harness/fixtures.mjs';
import { sharedFixture } from './harness/gates.mjs';
import {
  alphaReady,
  architectSession,
  authorizationsOfProject,
  candidatesOfProject,
  createWithIdea,
  evaluationsOfKind,
  eventsAbout,
  journeyContext,
  journeyScripts,
  nextPhasePublished,
  phaseCompleted,
  phasePlansOf,
  planOfPhase,
  checkRows,
  executionsOf,
  pump,
  signoffsOfProject,
  specSession,
  stagesOfPlan,
  visionSession,
  workOf,
} from './harness/journey/drive.mjs';
import { REQUIREMENTS, ROADMAP_JSON, ROADMAP_MD, specText } from './harness/journey/reference.mjs';
import { requestDeployment } from './harness/deploy/kernel.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';
import { setEngineConfig, runningClassifier } from './harness/checks/classifier.mjs';

// A project of `tier` at `developing`, the reference journey's scripts in
// place, the classifier authoritative (the ruling), under `autonomy: phase`
// with `alpha_deploy` manual. `spec`/`roadmap` vary the products.
async function developing(t, { tier = 'T2', spec, roadmap } = {}) {
  const fx = await scriptedEngine(t);
  const version = await runningClassifier(fx.engine);
  setEngineConfig(fx, { classifier_authority: { mode: 'authoritative', version } });
  await fx.engine.kill();
  await fx.start();
  journeyScripts(fx);
  const p = await createWithIdea(fx, { tier, policy: { autonomy: 'phase', alpha_deploy: 'manual' } });
  await visionSession(fx, p.id);
  await specSession(fx, p.id, spec === undefined ? {} : { second: spec });
  const over = roadmap === undefined ? {} : { '.surety/roadmap/roadmap.json': roadmap, '.surety/roadmap/roadmap.md': ROADMAP_MD };
  const arch = await architectSession(fx, p.id, p.repo, { over });
  const ctx = journeyContext(fx, p, { tier });
  return { fx, p, ctx, plan: arch.published };
}

const replans = (home, project) => workOf(home, project, 'replan');

// What phase 1's completion must have written, on either tier.
function assertCompletion(fx, ctx, plan, { tier }) {
  const done = planOfPhase(fx.home, ctx.project, 1).find((x) => x.id === plan.id);
  assert.ok(done.completed_at, 'completed_at recorded');
  const b = done.completion_binding;
  assert.ok(b && typeof b === 'object', `completion_binding recorded (${JSON.stringify(b)})`);
  assert.match(b.candidate ?? '', /^cand_/, 'bound to the candidate');
  assert.ok(b.acceptance_hash && b.protected_version && b.spec_revision, 'bound to the acceptance content hash, the protected version and the spec revision');
  assert.equal(b.generation, done.generation, 'and the plan generation');
  assert.deepEqual(stagesOfPlan(fx.home, plan.id).map((s) => s.status), ['verified', 'verified'], 'every stage verified');
  const completed = eventsAbout(fx.home, 'baseline.phase_complete', ctx.project);
  assert.equal(completed.length, 1, 'baseline.phase_complete once');
  const evaluations = evaluationsOfKind(fx.home, ctx.project, 'phase');
  assert.ok(evaluations.some((e) => e.candidate === b.candidate && e.outcome === 'satisfied'), `a satisfied phase evaluation on the bound candidate (${JSON.stringify(evaluations.map((e) => [e.candidate, e.outcome]))})`);
  const phaseSignoffs = signoffsOfProject(fx.home, ctx.project).filter((s) => s.scope === 'phase');
  if (tier === 'T1') assert.deepEqual(phaseSignoffs, [], 'T1: no phase sign-off needed or recorded (B06)');
  else {
    assert.equal(phaseSignoffs.length, 1, 'T2: one phase sign-off');
    assert.deepEqual([phaseSignoffs[0].candidate, phaseSignoffs[0].binding?.plan_generation], [b.candidate, b.generation], 'bound to the candidate and the generation');
  }
  return done;
}

describe('M406 phase completion\'s effects, once per binding (T2, the shared journey)', () => {
  const shared = sharedFixture();
  let J;
  before(async () => {
    const { fx, p, ctx, plan } = await developing(shared.context);
    J = { fx, p, ctx, plan };
    J.before = { candidates: candidatesOfProject(fx.home, p.id).map((c) => [c.id, c.progress]), authorizations: authorizationsOfProject(fx.home, p.id).length };
    J.done = await phaseCompleted(fx, ctx, 1);
    J.after = { candidates: candidatesOfProject(fx.home, p.id).map((c) => [c.id, c.progress]), authorizations: authorizationsOfProject(fx.home, p.id).length };
  });
  after(shared.cleanup);

  test('(a) T2: the phase gate satisfied and the sign-off recorded, a next phase in the roadmap: completed_at, completion_binding, every stage verified, baseline.phase_complete, one replan from (phase_complete, plan, 1)', () => {
    const { fx, ctx, plan } = J;
    assertCompletion(fx, ctx, plan, { tier: 'T2' });
    const items = replans(fx.home, ctx.project);
    assert.equal(items.length, 1, 'one replan item');
    assert.deepEqual([items[0].trigger_source, items[0].trigger_id, items[0].trigger_generation], ['phase_complete', plan.id, 1]);
    const routed = ctx.humanActs.filter((h) => h.kind !== 'check_correction_unclassifiable');
    assert.deepEqual(routed, [], `no human act within the phase but the toolchain proposal (${JSON.stringify(ctx.humanActs)})`);
  });

  test('(c) the candidate\'s progress and the authorizations before and after: completion issues no authorization and advances no candidate (F §3.10.4)', () => {
    const { fx, ctx } = J;
    assert.equal(J.after.authorizations, 0, 'no deployment authorization exists');
    assert.equal(J.before.authorizations, 0);
    assert.ok(candidatesOfProject(fx.home, ctx.project).every((c) => c.progress === 'developing'), `every candidate still developing (${JSON.stringify(J.after.candidates)})`);
  });

  test('(d) repeated ticks and a restart: no second completion, no second replan', async () => {
    const { fx, ctx, plan } = J;
    await tick(fx.engine, ctx.project, { rounds: 3 });
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, ctx.project, { rounds: 3 });
    const done = planOfPhase(fx.home, ctx.project, 1).find((x) => x.id === plan.id);
    assert.equal(done.completed_at, J.done.completed_at, 'completed_at unchanged');
    assert.deepEqual(done.completion_binding, J.done.completion_binding, 'the binding unchanged');
    assert.equal(eventsAbout(fx.home, 'baseline.phase_complete', ctx.project).length, 1, 'baseline.phase_complete once');
    assert.equal(replans(fx.home, ctx.project).length, 1, 'one replan');
  });

  test('(e) a later regression on a successor candidate: history unchanged; the deploy request refuses through the gate that rereads', async () => {
    const { fx, ctx, plan } = J;
    // Phase 2 published by the replan, then its first stage built; on that
    // successor candidate stage 1's check fails (the scripted boundary).
    await nextPhasePublished(fx, ctx, 2);
    const failing = new Set();
    const successor = await pump(
      fx,
      ctx,
      () => candidatesOfProject(fx.home, ctx.project).find((c) => failing.has(c.id)) ?? undefined,
      {
        what: 'a successor candidate with a failed earlier-stage check',
        max: 120,
        exits: (x) => {
          if (x.key === 'accept-r1' && x.candidate !== J.done.completion_binding?.candidate) {
            failing.add(x.candidate);
            return 1;
          }
          return 0;
        },
      },
    );
    assert.ok(successor, 'a successor candidate exists with accept-r1 failed on it');
    const done = planOfPhase(fx.home, ctx.project, 1).find((x) => x.id === plan.id);
    assert.equal(done.completed_at, J.done.completed_at, 'phase 1\'s completed_at unchanged');
    assert.deepEqual(done.completion_binding, J.done.completion_binding, 'its binding unchanged');
    assert.equal(eventsAbout(fx.home, 'baseline.phase_complete', ctx.project).length, 1, 'no second completion');
    assert.equal(replans(fx.home, ctx.project).length, 1, 'no second replan');
    // The deploy request, by command, on the regressed successor: the gate rereads and refuses.
    await alphaReady(fx, ctx);
    const res = await requestDeployment(fx.engine, ctx.project, successor.id, 'alpha');
    assertRefused(res, 409, 'authorization_not_issued', 'a deploy request on a candidate whose earlier-stage check failed');
    // Reasons name ids (SEAM.md §70): the failed check is accept-r1's row of any protected version.
    const ids = checkRows(fx.home, ctx.project).filter((c) => c.key === 'accept-r1').map((c) => c.id);
    const named = (res.body?.subject?.reasons ?? []).flatMap((r) => r.subjects ?? []);
    assert.ok(named.some((id) => ids.includes(id)), `the refusal names the failed check (reasons ${JSON.stringify(res.body?.subject?.reasons)}; accept-r1 is ${ids.join(', ')})`);
  });
});

describe('M406 at T1', () => {
  test('(a) T1: with every stage integrated and authoring ready the phase nominates, runs the stage and phase checks on that candidate, completes without a sign-off and creates one replan', async (t) => {
    const { fx, ctx, plan } = await developing(t, { tier: 'T1' });
    await phaseCompleted(fx, ctx, 1);
    const done = assertCompletion(fx, ctx, plan, { tier: 'T1' });
    const candidates = candidatesOfProject(fx.home, ctx.project);
    assert.equal(candidates.length, 1, 'one candidate: nominated at the completion of building, not per stage (B06; E11)');
    assert.equal(candidates[0].nominated_by, 'engine_cadence', 'nominated by the engine, not on a Builder request');
    assert.equal(done.completion_binding.candidate, candidates[0].id);
    // The stage checks and the phase scope's checks registered and run on that candidate (D6 §5.8, T1).
    const keys = [...new Set(executionsOf(fx.home, candidates[0].id).filter((x) => x.status === 'recorded').map((x) => x.key))].sort();
    for (const key of ['accept-r1', 'accept-r2', 'integration-lib', 'integration', 'lint', 'smoke']) assert.ok(keys.includes(key), `${key} recorded on the phase's candidate (${keys.join(', ')})`);
    assert.ok(evaluationsOfKind(fx.home, ctx.project, 'stage').filter((e) => e.candidate === candidates[0].id && e.outcome === 'satisfied').length >= 2, 'both stage gates evaluated satisfied on that candidate');
    assert.equal(replans(fx.home, ctx.project).length, 1, 'one replan');
    assert.deepEqual(ctx.humanActs.map((h) => h.kind), ['check_correction_unclassifiable'], 'the toolchain proposal was the one human act');
  });
});

describe('M406 with no next phase', () => {
  test('(b) the roadmap has no next phase: no replan; the build is complete and the owner\'s deploy request is answered as M342', async (t) => {
    const spec = specText({ requirements: REQUIREMENTS.slice(0, 2) });
    const roadmap = { ...ROADMAP_JSON, phases: [ROADMAP_JSON.phases[0]] };
    const { fx, ctx, plan } = await developing(t, { spec, roadmap });
    const done = await phaseCompleted(fx, ctx, 1);
    assert.ok(done.completed_at);
    await tick(fx.engine, ctx.project, { rounds: 3 });
    assert.deepEqual(replans(fx.home, ctx.project), [], 'no replan when the roadmap has no next phase');
    assert.equal(phasePlansOf(fx.home, ctx.project).length, 1);
    const read = await fx.engine.get(`/v1/projects/${ctx.project}/plan`);
    assert.equal(read.body?.build?.complete, true, `the plan read shows the build complete (${JSON.stringify(read.body?.build)})`);
    await alphaReady(fx, ctx);
    const res = await requestDeployment(fx.engine, ctx.project, done.completion_binding.candidate, 'alpha');
    assert.ok([200, 201].includes(res.status), `the owner's request is answered with an issued authorization (→ ${res.status} ${res.text})`);
    assert.equal(res.body?.authorization?.status, 'issued');
    void plan;
  });
});
