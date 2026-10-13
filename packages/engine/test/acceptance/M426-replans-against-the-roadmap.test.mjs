// M426 on the replan path (slice 35; kernel lane). M5 plan §3.5 M426 (a)'s
// regression variant, (b) and (f); D6-P03; D6 §5.2, §5.3 item 3, §5.8 (a
// later regression blocks the next plan's dependency clause); B04; the
// driver's rulings of 2026-10-12 (SEAM.md §352) and 2026-10-13; SEAM.md
// §§406, 407, 409.
//
// One journey to phase 1's completion under the default `phase_size`
// {3, 5}, the replan's launches scripted in turn:
//   (b) a roadmap revision that drops R4: refused naming R4;
//   (b) one that assigns R4 twice: refused naming R4;
//   (f) a two-stage plan within the baseline: `plan_approval`, `uncertain`
//       naming `phase_size`, never refused; rejected, the next generation;
//   (b) one that moves R4 to a new phase 3: it passes the reference check and
//       routes to the owner with the whole roadmap in the diff; nothing of
//       the move takes effect before the approval, and after it R4 is in
//       phase 3.
// (a)'s regression: phase 1 complete, `accept-r1` failed on a phase-2
// candidate, then an early replacement of phase 2 (a parked stage's blocker
// answered `replan`): `PLAN_DEPENDENCY_INCOMPLETE` naming `phase 1`.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { decisionsOn } from './harness/decisions.mjs';
import { builderScript, candidatesOfProject, nextPhasePublished, phaseCompleted, pump, requirementsOf, workOf } from './harness/journey/drive.mjs';
import { afterRefusal, answer, checkOfApproval, phaseCompleteNoPlanAnswer, diffText, journey35, nextReplanOutcome, phaseOf, rejectWithNote, replan35, replanRunsOf, roadmapWith, outcomes, unpublished } from './harness/journey/plan35.mjs';
import { STAGES } from './harness/journey/reference.mjs';
import { script } from './harness/scripted.mjs';

const ROADMAP = '.surety/roadmap/roadmap.json';
const STAGE_3 = [STAGES[2][0]];
const roadmapFile = (phases) => ({ [ROADMAP]: roadmapWith({ phases }) });

describe('M426 replans against the roadmap', () => {
  test('(b) dropping R4 and assigning it twice are refused; (f) a plan outside phase_size is uncertain and routed; (b) moving R4 routes with the whole roadmap and takes effect only on approval', async (t) => {
    const { fx, p, ctx } = await journey35(t, { policy: { phase_size: { min: 3, max: 5 }, repair_attempts_max: 3 } });
    const NOTE = 'Keep R4 in phase 2 for now.';
    fx.scripted.kindScript('replan', [
      replan35({ roadmap_version: 2, stages: STAGE_3, files: roadmapFile([phaseOf(1), { ...phaseOf(2), requirement_ids: ['R3'] }]) }),
      replan35({ roadmap_version: 2, stages: STAGE_3, files: roadmapFile([{ ...phaseOf(1), requirement_ids: ['R1', 'R2', 'R4'] }, phaseOf(2)]) }),
      replan35({}),
      replan35({
        roadmap_version: 2,
        stages: STAGE_3,
        before: [{ probe: { action: 'context_dump' } }],
        files: roadmapFile([phaseOf(1), { ...phaseOf(2), requirement_ids: ['R3'] }, { number: 3, goal: 'show the stats', modules: ['service'], requirement_ids: ['R4'], depends_on: [2] }]),
      }),
    ]);
    const seen = outcomes();
    await phaseCompleteNoPlanAnswer(fx, ctx, 1);
    // (b) dropped.
    const dropped = await nextReplanOutcome(fx, ctx, 2, seen);
    const runsSoFar = () => JSON.stringify(replanRunsOf(fx.home, p.id).map((r) => [r.outcome, r.reason_class, r.reason_text]));
    assert.ok(dropped.failed, `the roadmap dropping R4 is refused (${JSON.stringify(Object.keys(dropped))}; runs ${runsSoFar()})`);
    assert.deepEqual([dropped.failed.outcome, dropped.failed.reason_class], ['failed', 'invalid_result']);
    assert.match(dropped.failed.reason_text ?? '', /R4/, `naming R4 (${dropped.failed.reason_text}; runs ${runsSoFar()})`);
    assert.doesNotMatch(dropped.failed.reason_text ?? '', /phases 1 and 2|twice/, `for its own defect, not the next variant's (runs ${runsSoFar()})`);
    await afterRefusal(fx, ctx, dropped.failed);
    // (b) twice.
    const twice = await nextReplanOutcome(fx, ctx, 2, seen);
    assert.ok(twice.failed, `the roadmap assigning R4 twice is refused (${JSON.stringify(Object.keys(twice))})`);
    assert.match(twice.failed.reason_text ?? '', /R4/, `naming R4 (${twice.failed.reason_text}; runs ${runsSoFar()})`);
    await afterRefusal(fx, ctx, twice.failed);
    // (f) the default bound.
    const sized = await nextReplanOutcome(fx, ctx, 2, seen);
    assert.ok(sized.approval, `a two-stage plan under {3, 5} goes to the owner, never refused (${JSON.stringify(sized.failed ? [sized.failed.reason_class, sized.failed.reason_text] : Object.keys(sized))})`);
    const sizedCheck = checkOfApproval(fx.home, p.id, sized.approval);
    assert.deepEqual([sizedCheck.outcome, sizedCheck.reasons], ['passed', []], 'passed, no reason');
    assert.ok((sizedCheck.uncertain ?? []).some((u) => String(u).startsWith('phase_size')), `uncertain names phase_size (${JSON.stringify(sizedCheck.uncertain)})`);
    const rejected = await rejectWithNote(fx, p.id, sized.approval, NOTE);
    assert.equal(rejected.status, 200, `the owner rejects it (→ ${rejected.status} ${rejected.text})`);
    // (b) moved.
    const moved = await nextReplanOutcome(fx, ctx, 2, seen);
    assert.ok(moved.approval, `moving R4 to phase 3 passes the reference check and routes to the owner (${JSON.stringify(moved.failed ? [moved.failed.reason_class, moved.failed.reason_text] : Object.keys(moved))})`);
    const movedCheck = checkOfApproval(fx.home, p.id, moved.approval);
    assert.equal(movedCheck.outcome, 'passed');
    assert.ok(JSON.stringify(movedCheck.changes_roadmap?.assignments ?? []).includes('R4'), `the check records R4's assignment changed (${JSON.stringify(movedCheck.changes_roadmap)})`);
    const diff = diffText(fx.home, movedCheck);
    assert.ok(diff && diff.includes('show the stats') && diff.includes('count the sums and show the stats'), `the diff holds the whole roadmap, proposed and approved (SEAM.md §407) (${diff?.slice(0, 400)})`);
    assert.equal(requirementsOf(fx.home, p.id).find((r) => r.key === 'R4').assigned_phase, 2, 'before the approval R4 is still assigned to phase 2');
    assert.deepEqual(unpublished(fx.home, p.id, 2), { plans: 0, architecture: [1], roadmap: [1] }, 'and nothing of the move is published');
    const approved = await answer(fx.engine, p.id, moved.approval, 'approve');
    assert.equal(approved.status, 200, `the owner approves (→ ${approved.status} ${approved.text})`);
    await pump(fx, ctx, () => (unpublished(fx.home, p.id, 2).plans > 0 ? true : undefined), { what: 'phase 2 published', max: 8 });
    assert.deepEqual(unpublished(fx.home, p.id, 2).roadmap, [1, 2], 'roadmap version 2 registered with the plan');
    assert.equal(requirementsOf(fx.home, p.id).find((r) => r.key === 'R4').assigned_phase, 3, 'R4 now in phase 3');
  });

  test('(a) after phase 1 completes, a later regression: the early replacement of phase 2 is refused PLAN_DEPENDENCY_INCOMPLETE naming phase 1', async (t) => {
    const { fx, p, ctx } = await journey35(t, { policy: { repair_attempts_max: 0 } });
    const builds = fx.scripted;
    builds.kindScript('stage_build', [builderScript(1), builderScript(2), builderScript(3), script.crash(), script.crash()]);
    builds.kindScript('replan', [replan35({}), replan35({}), replan35({})]);
    const done = await phaseCompleted(fx, ctx, 1);
    await nextPhasePublished(fx, ctx, 2);
    // Stage 3 integrated and nominated; on its candidate accept-r1 fails (the scripted boundary); stage 4's Builder fails and parks.
    const exits = (x) => (x.key === 'accept-r1' && x.candidate !== done.completion_binding?.candidate ? 1 : 0);
    const stage4 = () => workOf(fx.home, p.id, 'stage_build').find((w) => w.subject?.stage && w.status === 'parked') ?? undefined;
    const parked = await pump(fx, ctx, () => {
      const w = stage4();
      return w && decisionsOn(fx.home, 'blocker', w.id).find((d) => d.status === 'open');
    }, { what: 'stage 4 parked with its blocker', max: 160, exits });
    assert.ok(candidatesOfProject(fx.home, p.id).length >= 2, 'a phase-2 candidate exists');
    const options = parked.options.map((o) => o.key);
    assert.ok(options.includes('replan'), `the parked stage's blocker offers replan (${JSON.stringify(options)})`);
    const before = replanRunsOf(fx.home, p.id).length;
    const res = await answer(fx.engine, p.id, parked, 'replan');
    assert.equal(res.status, 200, `the owner answers replan (→ ${res.status} ${res.text})`);
    const ended = await pump(fx, ctx, () => replanRunsOf(fx.home, p.id).slice(before).find((r) => r.state === 'ended'), { what: 'the replacement replan to end', max: 20, exits });
    assert.deepEqual([ended.outcome, ended.reason_class], ['failed', 'invalid_result'], `the replacement is refused (${ended.reason_text})`);
    assert.match(ended.reason_text ?? '', /PLAN_DEPENDENCY_INCOMPLETE/, 'PLAN_DEPENDENCY_INCOMPLETE: phase 1 regressed, the gate reread (D6 §5.8)');
    assert.match(ended.reason_text ?? '', /phase 1/, 'naming phase 1');
  });
});
