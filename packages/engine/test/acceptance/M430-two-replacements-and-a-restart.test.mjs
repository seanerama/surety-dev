// M430 (e), two replacements and a restart (slice 35; kernel lane). M5 plan
// §3.5 M430 (e); D6-F04; D6 §5.7; B08; the driver's ruling 5 of 2026-10-13
// (pending routed replacements answered in turn, until slice 37 brings
// concurrency); SEAM.md §§401, 406, 413.
//
// Phase 1's two stages are independent; each Builder fails and parks, and
// each blocker is answered `replan`: two replacements of generation 1, each
// routed to the owner (declared `uncertain`) and pending. The first is
// approved with the engine killed at `plan.after_publication`; after the
// restart generation 2 is active and its remainder registered once. The
// second is answered after: 409 `plan_generation_stale`, nothing registered.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { decisionsOn, untilKilled } from './harness/decisions.mjs';
import { armBarrier } from './harness/journal.mjs';
import { builderScript, eventsAbout, phasePlansOf, pump, stagesOfPlan, workOf } from './harness/journey/drive.mjs';
import { answer, journey35, openPlanApprovals, replan35 } from './harness/journey/plan35.mjs';
import { pumpNoIdle } from './harness/journey/review31b.mjs';
import { STAGES } from './harness/journey/reference.mjs';
import { tick } from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';
import { ROUTED_KINDS } from './harness/journey/drive.mjs';

const S1 = STAGES[1][0];
const S2 = { ...STAGES[1][1], depends_on: [] };
const g2Of = (home, project) => phasePlansOf(home, project).filter((x) => x.phase_number === 1 && x.generation === 2);

describe('M430 (e) two replacements and a restart', () => {
  test('one wins the swap; a restart between the swap and the remainder registers it once; the other is plan_generation_stale', async (t) => {
    const { fx, p, ctx, plan } = await journey35(t, { stages: [S1, S2], policy: { repair_attempts_max: 0 } });
    fx.scripted.kindScript('stage_build', [script.crash(), script.crash(), builderScript(1), builderScript(2)]);
    const A = [{ ...S1, number: 3, tasks: ['write src/sum.mjs exporting sum(a, b), numbers only'] }, { ...S2, number: 4 }];
    const B = [{ ...S1, number: 5, tasks: ['write src/sum.mjs exporting sum(a, b) and a type check'] }, { ...S2, number: 6 }];
    fx.scripted.kindScript('replan', [replan35({ phase: 1, conformance: 'uncertain', stages: A }), replan35({ phase: 1, conformance: 'uncertain', stages: B }), replan35({})]);
    const blockers = await pump(fx, ctx, () => {
      const open = workOf(fx.home, p.id, 'stage_build').flatMap((w) => decisionsOn(fx.home, 'blocker', w.id).filter((d) => d.status === 'open'));
      return open.length === 2 ? open : undefined;
    }, { what: 'both stages parked with their blockers', max: 60 });
    for (const b of blockers) assert.equal((await answer(fx.engine, p.id, b, 'replan')).status, 200, 'the owner answers replan');
    const answerKinds = ROUTED_KINDS.filter((k) => k !== 'plan_approval');
    const pending = await pumpNoIdle(fx, ctx, () => {
      const open = openPlanApprovals(fx.home, p.id);
      return open.length === 2 ? open : undefined;
    }, { what: 'two replacements pending', max: 60, answerKinds });
    // The first approved, the engine killed after the publication's transaction.
    await armBarrier(fx.engine, 'plan.after_publication', 'kill');
    const first = answer(fx.engine, p.id, pending[0], 'approve').catch((err) => err);
    await untilKilled(fx, p.id);
    await first;
    await fx.start();
    await tick(fx.engine, p.id, { rounds: 3 });
    const g2 = g2Of(fx.home, p.id);
    assert.equal(g2.length, 1, 'one generation 2 after the restart');
    assert.ok(g2[0].active === 1 || g2[0].active === true, 'active');
    assert.equal(phasePlansOf(fx.home, p.id).find((x) => x.id === plan.id).status, 'replaced', 'generation 1 replaced');
    const remainder = stagesOfPlan(fx.home, g2[0].id);
    assert.equal(remainder.length, 2, 'the remainder registered');
    for (const s of remainder) assert.equal(workOf(fx.home, p.id, 'stage_build').filter((w) => w.subject?.stage === s.id).length, 1, `once: one stage_build for S${s.number}`);
    assert.equal(eventsAbout(fx.home, 'plan.published', p.id).filter((e) => JSON.stringify(e).includes(g2[0].id)).length, 1, 'one plan.published for generation 2');
    // The second, answered after the swap.
    const res = await answer(fx.engine, p.id, pending[1], 'approve');
    assert.equal(res.status, 409, `the other replacement loses the swap (→ ${res.status} ${res.text})`);
    assert.equal(res.body?.code, 'plan_generation_stale');
    await tick(fx.engine, p.id, { rounds: 2 });
    assert.equal(g2Of(fx.home, p.id).length, 1, 'still one generation 2');
    assert.deepEqual(phasePlansOf(fx.home, p.id).filter((x) => x.phase_number === 1 && x.generation > 2), [], 'no generation 3');
  });
});
