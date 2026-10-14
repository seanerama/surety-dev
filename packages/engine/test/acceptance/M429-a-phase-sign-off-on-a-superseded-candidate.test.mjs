// M429 (d), the superseded-candidate half (slice 37; kernel lane). M5 plan
// §3.5 M429 (d); D6-F02; D6 §5.8 (the sign-off bound to candidate content,
// protected version, spec revision and plan generation); B06; the driver's
// ruling 4 of slice 35 (the half reachable once concurrency exists, K2);
// SEAM.md §§412, 433 The plan-generation half is
// `M429-phase-verification-and-its-sign-off` (d).
//
// At T2 under `phase`, phase 1's `phase_verification` Verifier holds before
// its result; a `fix` integrates meanwhile (K2: one run per work item, not
// per project), and its integration nominates a successor candidate (E104).
// Released, the Verifier's `phase` sign-off is bound to the superseded
// candidate: refused (`signoff.refused`, `payload.cause`
// `candidate_superseded` †), no `signoffs` row; the phase completes only on
// a fresh sign-off bound to the successor (or a later candidate), once.
// Candidates are ordered by `seq` (insertion), never by a timestamp.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { roleThat } from './harness/gitruns.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { ROUTED_KINDS, evaluationsOfKind, phaseCompleted, planOfPhase, runsOfProject, signoffsOfProject, workOf } from './harness/journey/drive.mjs';
import { journey35 } from './harness/journey/plan35.mjs';
import { addWork, runsOf } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { candidatesOf, holding, launchesOfKind, pumpSome } from './harness/exec37/autonomy.mjs';

const NOT_PLAN = ROUTED_KINDS.filter((k) => k !== 'plan_approval');
const SIGN = roleThat([], { signoffs: [{ scope: 'phase' }] });

describe('M429 (d) a phase sign-off bound to a superseded candidate', () => {
  test('(d) a fix integrates while the phase Verifier holds: its sign-off on the superseded candidate refused candidate_superseded, no row; the phase completes on a fresh sign-off bound to the successor', async (t) => {
    const { fx, p, ctx } = await journey35(t);
    fx.scripted.kindScript('phase_verification', [{ steps: [step.hold('gate', { heartbeat_ms: 250 }), ...SIGN.steps] }, SIGN, SIGN]);
    fx.scripted.kindScript('fix', roleThat([step.write('NOTES.md', 'A note the fix adds.\n')]));
    const held = await pumpSome(fx, ctx, () => launchesOfKind(fx, 'phase_verification').find((l) => holding(fx, l)), { what: 'the phase Verifier holding', max: 300, answerKinds: NOT_PLAN });
    const evaluation = evaluationsOfKind(fx.home, p.id, 'phase').at(-1);
    assert.ok(evaluation, 'the fixture is live: the phase evaluated');
    const superseded = candidatesOf(fx.home, p.id).find((c) => c.id === evaluation.candidate);
    const fix = await addWork(fx.engine, p.id, 'fix');
    const successor = await pumpSome(fx, ctx, () => candidatesOf(fx.home, p.id).find((c) => c.seq > superseded.seq), {
      what: 'the fix integrated and its successor nominated while the phase Verifier holds (K2)',
      max: 40,
      answerKinds: NOT_PLAN,
    });
    assert.ok(runsOf(fx.home, fix).length >= 1, 'the fix ran beside the held Verifier');
    fx.scripted.release(held.work_item, 'gate');
    const [heldRun] = runsOf(fx.home, held.work_item);
    await pumpSome(fx, ctx, () => runsOf(fx.home, held.work_item).find((r) => r.state === 'ended'), { what: 'the held Verifier\'s run to end', max: 20, answerKinds: NOT_PLAN });
    const onSuperseded = signoffsOfProject(fx.home, p.id).filter((s) => s.scope === 'phase' && s.candidate === superseded.id);
    assert.deepEqual(onSuperseded, [], 'no phase sign-off row on the superseded candidate');
    const refused = eventsOfType(fx.home, 'signoff.refused').filter((e) => JSON.stringify(e).includes(heldRun.id) || e.subject?.project === p.id);
    assert.equal(refused.length, 1, `one signoff.refused (${JSON.stringify(refused)})`);
    assert.equal(refused[0].payload?.cause, 'candidate_superseded', `its cause candidate_superseded † (${JSON.stringify(refused[0])})`);
    assert.equal(workOf(fx.home, p.id, 'phase_verification').find((w) => w.id === held.work_item)?.status, 'complete', 'the refused Verifier\'s work completes');
    assert.equal(planOfPhase(fx.home, p.id, 1).find((x) => x.completed_at) ?? null, null, 'the phase not complete on the refused sign-off');
    const done = await phaseCompleted(fx, ctx, 1, { max: 300 });
    const bound = candidatesOf(fx.home, p.id).find((c) => c.id === done.completion_binding.candidate);
    assert.ok(bound.seq >= successor.seq, `completed on the successor or a later candidate, never the superseded one (${JSON.stringify(done.completion_binding)})`);
    const phaseSignoffs = signoffsOfProject(fx.home, p.id).filter((s) => s.scope === 'phase');
    assert.deepEqual(phaseSignoffs.map((s) => s.candidate), [bound.id], 'one phase sign-off, on the completion\'s candidate');
    assert.ok(runsOfProject(fx.home, p.id).filter((r) => workOf(fx.home, p.id, 'phase_verification').some((w) => w.id === r.work_item)).length >= 2, 'from a fresh phase Verifier');
  });
});
