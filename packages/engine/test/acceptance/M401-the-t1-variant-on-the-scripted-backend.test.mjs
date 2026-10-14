// M401 (m), the T1 variant of the journey on the scripted backend (slice
// 31b; kernel lane). M5 plan §3.1 M401 (m); D6-J01 ("a T1 variant with no
// explicit nomination request runs in the scripted lane"); D6 §1, §5.8, §6.8;
// B06, B14; SEAM.md §§350 to 355.
//
// The same reference project at T1: no Reviewer, no Builder nomination
// request (`nominate` absent), `autonomy: phase`, `alpha_deploy:
// on_phase_complete`, on the scripted check boundary and the scripted
// deployment adapter. The harness answers the toolchain proposal and CR-1
// and nothing else. Read: at T1 the phase nominates when both stages are
// `integrated` and authoring is ready, runs the stage and phase checks on
// that candidate, completes without a `phase` sign-off, and the project
// reaches `alpha_deployed` through the policy's request.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import {
  correctionOrigin,
  alphaDeployed,
  buildActs,
  alphaReady,
  architectSession,
  candidatesOfProject,
  changeRequest,
  createWithIdea,
  deploymentRequests,
  evaluationsOfKind,
  executionsOf,
  journeyContext,
  journeyScripts,
  nextPhasePublished,
  phaseCompleted,
  planOfPhase,
  signoffsOfProject,
  specRevisions,
  specSession,
  stagesOfPlan,
  visionSession,
  ROUTED_KINDS,
  changeRequests,
} from './harness/journey/drive.mjs';
import { getRow } from './harness/runs.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { setEngineConfig, runningClassifier } from './harness/checks/classifier.mjs';

describe('M401 (m) the T1 variant: autonomous to alpha_deployed with no nomination request', () => {
  const shared = sharedFixture();
  let J;
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    const version = await runningClassifier(fx.engine);
    setEngineConfig(fx, { classifier_authority: { mode: 'authoritative', version } });
    await fx.engine.kill();
    await fx.start();
    journeyScripts(fx);
    // `phase_size` (slice 35; SEAM.md §406): Tally's two-stage phases, so the replan keeps computed routing.
    const p = await createWithIdea(fx, { tier: 'T1', policy: { autonomy: 'phase', alpha_deploy: 'on_phase_complete', phase_size: { min: 2, max: 5 } } });
    await visionSession(fx, p.id);
    await specSession(fx, p.id);
    const arch = await architectSession(fx, p.id, p.repo);
    const ctx = journeyContext(fx, p, { tier: 'T1' });
    // Authoritative: phase 2's authoring tightening is the Reviewer's (SEAM.md
    // §351); the owner answers the other routed kinds (objection 105; §451).
    ctx.answerKinds = ROUTED_KINDS.filter((k) => k !== 'check_correction_tightening');
    // One scripted deploy answer per deployment the journey makes: under
    // `on_phase_complete` one per completed phase (objection 104, the
    // driver's ruling 3: under K1 and K2 phase 1's candidate is deployed
    // first, then superseded by phase 2's, whose deployment is the one
    // expected; SEAM.md §449).
    await alphaReady(fx, ctx, { answers: [{ result: 'issued', apply: true }, { result: 'issued', apply: true }] });
    J = { fx, p, ctx, plan: arch.published };
    J.phase1 = await phaseCompleted(fx, ctx, 1);
    J.candidatesAfterPhase1 = candidatesOfProject(fx.home, p.id);
    await nextPhasePublished(fx, ctx, 2);
    J.change = await changeRequest(fx, ctx);
    J.phase2 = await phaseCompleted(fx, ctx, 2, { max: 200 });
    J.deployed = await alphaDeployed(fx, ctx, { newest: true });
  });
  after(shared.cleanup);

  test('at T1 the phase nominates once both stages are integrated and authoring is ready: one candidate per phase, by engine cadence, not per stage and not on a Builder request', () => {
    const { fx, ctx } = J;
    assert.equal(J.candidatesAfterPhase1.length, 1, `one candidate at the end of phase 1 (${JSON.stringify(J.candidatesAfterPhase1.map((c) => c.id))})`);
    const [c1] = J.candidatesAfterPhase1;
    assert.equal(J.phase1.completion_binding.candidate, c1.id, 'the phase bound to it');
    const stages = stagesOfPlan(fx.home, J.plan.id);
    assert.deepEqual(stages.map((s) => s.status), ['verified', 'verified']);
    assert.ok(stages.every((s) => s.integrated_revision), 'both stages integrated before the nomination');
    assert.ok(fx.scripted.launches({ work_kind: 'stage_build' }).length >= 2, 'the Builders ran');
    // A Reviewer may still approve a protected proposal (phase 2's tightening); none signs off a candidate at T1.
    assert.deepEqual(fx.scripted.log().filter((e) => e.event === 'review_auto' && e.proposal === null), [], 'T1: no Reviewer run on a candidate (F §5.7)');
  });

  test('the stage and phase checks ran on that candidate: accept-r1, accept-r2, smoke and the phase-2 phase-only check on phase 2\'s candidate, each an engine registration recorded through the scripted boundary', () => {
    const { fx, ctx } = J;
    const c1 = J.phase1.completion_binding.candidate;
    const keys1 = [...new Set(executionsOf(fx.home, c1).map((x) => x.key))].sort();
    for (const key of ['accept-r1', 'accept-r2', 'integration-lib', 'integration', 'lint', 'smoke']) assert.ok(keys1.includes(key), `${key} executed on phase 1's candidate (${keys1.join(', ')})`);
    const c2 = J.phase2.completion_binding.candidate;
    const keys2 = [...new Set(executionsOf(fx.home, c2).map((x) => x.key))].sort();
    for (const key of ['accept-r3', 'accept-r4', 'integration-tally', 'integration-stats', 'phase-regression', 'accept-r1']) assert.ok(keys2.includes(key), `${key} executed on phase 2's candidate (${keys2.join(', ')})`);
    assert.ok(!executionsOf(fx.home, c1).some((x) => x.key === 'phase-regression'), 'the phase-only check of phase 2 never ran on phase 1\'s candidate');
    assert.ok(evaluationsOfKind(fx.home, ctx.project, 'phase').some((e) => e.candidate === c2 && e.outcome === 'satisfied'));
  });

  test('completes without a phase sign-off at T1; the change between the phases was approved as version 2; alpha_deployed through the policy\'s request', () => {
    const { fx, ctx } = J;
    assert.deepEqual(signoffsOfProject(fx.home, ctx.project), [], 'T1: no sign-off of any scope');
    assert.ok(J.phase1.completed_at && J.phase2.completed_at);
    assert.equal(specRevisions(fx.home, ctx.project).length, 2, 'spec version 2 approved mid-build');
    assert.equal(J.deployed.progress, 'alpha_deployed');
    const requests = deploymentRequests(fx.home, ctx.project);
    assert.ok(requests.some((r) => r.requested_by === 'policy' && r.request_key?.candidate === J.deployed.id), `the policy requested the deployed candidate (${JSON.stringify(requests.map((r) => [r.requested_by, r.request_key?.candidate]))})`);
    // Sean, 2026-10-12, CR-1 correction counted as a human act (SEAM.md §370):
    // the correction rewrites accept-r2's declared input, which D3 §3.1 makes unclassifiable.
    // Counted from the store (objection 074): a refused post on a superseded generation is no act.
    // Counted by request (objection 105; SEAM.md §451): the toolchain's
    // proposal once; CR-1's submission once, and its approval and its check
    // correction's approvals, each at least once (a decision's generation
    // re-raised when its impact moved, or a correction's repaired proposal
    // after an approved one conflicted with the moved head, asks again), all
    // about CR-1; nothing else, and no tightening answered by a person.
    const acts = buildActs(ctx);
    const show = `${JSON.stringify(acts)}; posts ${JSON.stringify(ctx.humanActs)}`;
    const kinds = new Set(acts.map((h) => h.kind));
    assert.deepEqual([...kinds].sort(), ['check_correction_unclassifiable', 'spec_change', 'spec_change_request'], `the human acts are of these kinds and no other (${show})`);
    assert.equal(acts.filter((h) => h.kind === 'spec_change_request').length, 1, `CR-1 submitted once (${show})`);
    const corrections = acts.filter((h) => h.kind === 'check_correction_unclassifiable');
    const origins = corrections.map((h) => correctionOrigin(fx.home, h.id));
    assert.equal(origins.filter((o) => o === 'check_authoring').length, 1, `one from phase 1's check authoring, the toolchain (${JSON.stringify(origins)})`);
    assert.ok(origins.filter((o) => o === 'check_correction').length >= 1 && origins.every((o) => o === 'check_authoring' || o === 'check_correction'), `the rest from CR-1's check correction (${JSON.stringify(origins)})`);
    assert.ok(corrections.every((h) => h.option === 'approve'), 'each answered approve by the owner');
    const changes = changeRequests(fx.home, ctx.project);
    assert.equal(changes.length, 1, 'one change request, CR-1');
    // Every spec_change the owner answered is about CR-1: several are allowed
    // (a new result that moves the impact asks again, D6 §4.4; the driver's
    // ruling, slice 37), and exactly one is consumed.
    const answered = ctx.humanActs.filter((h) => h.kind === 'spec_change' && h.status === 200).map((h) => getRow(fx.home, 'decisions', h.id));
    assert.ok(answered.length >= 1, `CR-1's change answered by the owner (${show})`);
    for (const row of answered) assert.equal(row?.subject_id, changes[0].id, `each spec_change answer is about CR-1 (${JSON.stringify(row && { subject_id: row.subject_id, kind: row.kind, status: row.status })})`);
    assert.equal(acts.filter((x) => x.kind === 'spec_change').length, 1, `exactly one spec_change consumed (${show})`);
    for (const h of acts.filter((x) => x.kind === 'spec_change')) assert.equal(getRow(fx.home, 'decisions', h.id)?.subject_id, changes[0].id, 'the consumed spec_change is about CR-1');
    assert.ok(planOfPhase(fx.home, ctx.project, 2).some((p) => p.completed_at));
  });
});
