// M453, the conformance Alpha barrier (slice 32; kernel lane). M5 plan §3.2
// M453; D6-R10; D6 §8.1 step 6, §5.6; E6; B11; K11; SEAM.md §385. On the
// scripted check boundary (§190) and the scripted deployment adapter (§247),
// the adopted fixture at T1, `alpha_deploy` `manual`.
//   (a) phase 1 (conformance) complete, no deploy yet: `completed_at` and
//       `baseline.phase_complete`, no `replan`, and the plan read carries
//       `CONFORMANCE_ALPHA_PENDING`;
//   (d) a restart before the barrier opens: still no `replan`;
//   (b) the owner's deploy of c-1 (source A) completing `alpha_complete`: the
//       `replan` created once, and no second after more ticks;
//   (c) a deploy refused, one ending `uncertain`, and one whose verification
//       cannot be read: the barrier closed, no `replan`, the condition shown;
//   (f) a project that is not adopted: no barrier, the `replan` at the phase's
//       completion as M406.
// (e) "a deploy of a candidate whose source is not A" has no case: before the
// barrier opens no production path makes such a candidate (SEAM.md §385;
// the driver's question).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { deploy, scriptCall } from './harness/deploy/kernel.mjs';
import { alphaReady, candidatesOfProject, eventsAbout, phaseCompleted, planOfPhase, readPlan, workOf } from './harness/journey/drive.mjs';
import { journeyProject } from './harness/journey/review31b.mjs';
import { tick } from './harness/runs.mjs';
import { pump, retrofitEngine, toConformancePublished } from './harness/retrofit/drive.mjs';

const replans = (home, project) => workOf(home, project, 'replan');

// The adopted fixture to phase 1's completion, the environment configured and
// the adapter qualified (the deploy's answers queued by the caller).
async function conformanceComplete(t, { answers = [{ result: 'issued', apply: true }] } = {}) {
  const fx = await retrofitEngine(t);
  const J = await toConformancePublished(fx, { policy: { alpha_deploy: 'manual' } });
  const ready = await alphaReady(fx, J.ctx, { answers });
  const phase1 = await phaseCompleted(fx, J.ctx, 1, { max: 120 });
  const c1 = candidatesOfProject(fx.home, J.p.id).find((c) => c.id === phase1.completion_binding?.candidate);
  assert.ok(c1, `the phase bound its candidate (${JSON.stringify(phase1.completion_binding)})`);
  return { fx, J, env: ready.env, phase1, c1 };
}

describe('M453 the conformance Alpha barrier', () => {
  test('(a) complete, no deploy: no replan and CONFORMANCE_ALPHA_PENDING; (d) a restart before it opens: no replan; (b) the owner\'s deploy of c-1 completing alpha_complete: one replan', async (t) => {
    const { fx, J, env, phase1, c1 } = await conformanceComplete(t);
    const project = J.p.id;
    assert.ok(phase1.completed_at, 'completed_at');
    assert.equal(eventsAbout(fx.home, 'baseline.phase_complete', project).length, 1, 'baseline.phase_complete');
    await tick(fx.engine, project, { rounds: 3 });
    assert.deepEqual(replans(fx.home, project), [], 'no replan before Alpha');
    assert.match(JSON.stringify(await readPlan(fx, project)), /CONFORMANCE_ALPHA_PENDING/, 'the plan read shows the barrier');
    // (d) a restart before the barrier opens.
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, project, { rounds: 3 });
    assert.deepEqual(replans(fx.home, project), [], 'no replan at or after a restart');
    // (b) the owner's deploy of c-1.
    await deploy(fx.engine, project, c1.id, env.name);
    await pump(fx, J.ctx, () => candidatesOfProject(fx.home, project).find((c) => c.id === c1.id && c.progress === 'alpha_deployed'), { what: 'c-1 to be alpha_deployed', max: 40 });
    await pump(fx, J.ctx, () => (replans(fx.home, project).length > 0 ? true : undefined), { what: 'the replan once the barrier opens', max: 10 });
    await tick(fx.engine, project, { rounds: 4 });
    assert.equal(replans(fx.home, project).length, 1, 'one replan');
    assert.equal(planOfPhase(fx.home, project, 1).filter((p) => p.completed_at).length, 1, 'phase 1 completed once');
  });

  for (const [label, answers, verify] of [
    ['a deploy the adapter refuses', [{ result: 'refused' }], null],
    ['a deploy whose effect is uncertain', [{ result: 'uncertain' }], null],
    ['a deploy whose verification cannot be read', [{ result: 'issued', apply: true }], [{ failure: 'unavailable' }, { failure: 'unavailable' }, { failure: 'unavailable' }]],
  ]) {
    test(`(c) ${label}: the barrier stays closed, no replan, the condition shown`, async (t) => {
      const { fx, J, env, c1 } = await conformanceComplete(t, { answers });
      const project = J.p.id;
      if (verify) await scriptCall(fx.engine, env.id, 'verify', verify);
      await deploy(fx.engine, project, c1.id, env.name);
      await pump(fx, J.ctx, () => undefined, { max: 12 }).catch(() => null);
      assert.equal(workOf(fx.home, project, 'deploy').length, 1, 'the fixture is live: the owner\'s deploy was made');
      assert.notEqual(candidatesOfProject(fx.home, project).find((c) => c.id === c1.id)?.progress, 'alpha_deployed', 'c-1 is not alpha_deployed');
      assert.deepEqual(replans(fx.home, project), [], 'no replan');
      assert.match(JSON.stringify(await readPlan(fx, project)), /CONFORMANCE_ALPHA_PENDING/, 'the barrier shown');
    });
  }

  test('(f) a project that is not adopted: the replan at the phase\'s completion, no barrier', async (t) => {
    const { fx, p, ctx } = await journeyProject(t);
    await phaseCompleted(fx, ctx, 1);
    await tick(fx.engine, p.id, { rounds: 2 });
    assert.equal(workOf(fx.home, p.id, 'replan').length, 1, 'one replan without any Alpha');
    assert.doesNotMatch(JSON.stringify(await readPlan(fx, p.id)), /CONFORMANCE_ALPHA_PENDING/, 'and no barrier shown');
  });
});
