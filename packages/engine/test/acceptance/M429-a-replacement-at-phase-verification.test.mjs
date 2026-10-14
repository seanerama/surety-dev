// M429, the slice-35 review's M2 (slice 35; kernel lane). M5 plan §3.5 M429;
// D6-F02; D6 §5.8 (the sign-off bound to the plan generation; supersession
// transfers nothing), §5.7; B06, B08; the driver's message of 2026-10-13;
// SEAM.md §415.
//
// At T2, every stage verified and `phase_verification` under way, a
// replacement that keeps every stage and adds none is approved: the old
// sign-off is refused, a new `phase_verification` is registered for the new
// generation, and the phase completes on that generation after its sign-off.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer } from './harness/decisions.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { planOfPhase, runsOfProject, signoffsOfProject, workOf } from './harness/journey/drive.mjs';
import { NO_PLAN_ANSWER, S1, S2, currentApproval, generationOf, replacementPending } from './harness/journey/review35.mjs';
import { pumpNoIdle } from './harness/journey/review31b.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { step } from './harness/scripted.mjs';

describe('M429 a replacement at phase verification', () => {
  test('M2 a replacement keeping every stage while phase_verification runs: a new phase_verification for the new generation; the phase completes after its sign-off', async (t) => {
    const { fx, p, ctx, plan, pending } = await replacementPending(t, { tier: 'T2', three: false, key: 'R2', replacement: [S1, S2] });
    fx.scripted.kindScript('phase_verification', [{ steps: [step.hold('gate', { heartbeat_ms: 250 }), ...roleThat([], { signoffs: [{ scope: 'phase' }] }).steps] }, roleThat([], { signoffs: [{ scope: 'phase' }] })]);
    await pumpNoIdle(fx, ctx, () => {
      const launch = fx.scripted.launches({ work_kind: 'phase_verification' }).at(-1);
      return launch && fx.scripted.eventsOf(launch.pid, 'holding').length > 0 ? true : undefined;
    }, { what: 'every stage verified and phase_verification under way', max: 400, answerKinds: NO_PLAN_ANSWER });
    const now = currentApproval(fx.home, p.id);
    assert.ok(now, `the fixture is live: the replacement still pending (first raised ${pending.id})`);
    const res = await answer(fx.engine, p.id, now, 'approve');
    assert.equal(res.status, 200, `the owner approves the replacement during phase verification (→ ${res.status} ${res.text})`);
    const g2 = await pumpNoIdle(fx, ctx, () => generationOf(fx.home, p.id, 1, 2)?.published_at ? generationOf(fx.home, p.id, 1, 2) : undefined, { what: 'generation 2 published', max: 20, answerKinds: NO_PLAN_ANSWER });
    const firstItem = workOf(fx.home, p.id, 'phase_verification')[0];
    fx.scripted.release('all', 'gate');
    const done = await pumpNoIdle(fx, ctx, () => planOfPhase(fx.home, p.id, 1).find((x) => x.id === g2.id && x.completed_at), { what: 'phase 1 completed on generation 2', max: 200, answerKinds: NO_PLAN_ANSWER }).catch((err) => {
      throw new Error(`${err.message} (phase_verification work: ${JSON.stringify(workOf(fx.home, p.id, 'phase_verification').map((w) => [w.status, w.trigger_source, w.trigger_generation]))}; signoff.refused: ${eventsOfType(fx.home, 'signoff.refused').length})`);
    });
    assert.equal(done.completion_binding?.generation, 2, 'completed on generation 2');
    const items = workOf(fx.home, p.id, 'phase_verification');
    const second = items.find((w) => w.id !== firstItem.id);
    assert.ok(second, `a new phase_verification registered for generation 2 (${JSON.stringify(items.map((w) => [w.status, w.trigger_source, w.trigger_id]))})`);
    assert.ok(runsOfProject(fx.home, p.id).some((r) => r.work_item === second.id && r.outcome === 'completed'), 'and it ran');
    const signoffs = signoffsOfProject(fx.home, p.id).filter((s) => s.scope === 'phase');
    assert.deepEqual(signoffs.map((s) => s.binding?.plan_generation), [2], `one phase sign-off, bound to generation 2 (${JSON.stringify(signoffs.map((s) => s.binding))})`);
    assert.equal(eventsOfType(fx.home, 'signoff.refused').filter((e) => JSON.stringify(e).includes(p.id) || JSON.stringify(e).includes(firstItem.id)).length >= 1, true, 'the first, bound to generation 1, refused');
    void plan;
  });
});
