// M430, the slice-35 review's findings on a pending replacement (slice 35;
// kernel lane). M5 plan §3.5 M430; D6-F04; D6 §5.5 (the bundle re-compared at
// publication), §5.7, §6.6; B08; the driver's message of 2026-10-13 (S1, S2,
// M4); SEAM.md §415.
//
// S1 (a) a pending replacement lists a changed stage 2 while stage 2 is
//        `building`; stage 2 integrates before the owner approves: on the
//        approval the bundle is stale, and the changed stage 2 is never
//        silently dropped;
// S1 (b) a pending replacement's new stage depends on kept stage 1, whose
//        work parks before the approval: stale, a next generation, no
//        publication and no endless error;
// S2     stage 1 integrated and `verifying`, kept by a replacement; after the
//        swap its required check fails: the repair is dispatched and the
//        stage reaches `verified`;
// M4     a replacement while integrated stage 1's work is parked keeps stage
//        1, its work and its open blocker; stage 1's blocker answered
//        `replan` then replaces that generation in turn.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer } from './harness/decisions.mjs';
import { builderScript, candidatesOfProject, phasePlansOf, pump, readPlan, runsOfProject, stagesOfPlan, workOf } from './harness/journey/drive.mjs';
import { journey35, replan35 } from './harness/journey/plan35.mjs';
import { HELD, NO_PLAN_ANSWER, S1, S2, S3, active, advanceHolding, boundApproval, changeTouching, changed, generationOf, openBlockerAbout, replacementPending, stageWorkOf } from './harness/journey/review35.mjs';
import { pumpNoIdle, postChange } from './harness/journey/review31b.mjs';
import { script } from './harness/scripted.mjs';
import { tick } from './harness/runs.mjs';

const replans = (home, project) => workOf(home, project, 'replan');
// The owner approves the replacement as it is now: the open generation of its
// decision once it is bound to the registered head, or none (`res` null) when
// no open decision binds the bundle. A head move just before (S2's stage 1
// integrated, S1 (a)'s stage 2) re-raises the open generation on the next
// tick's rebind; an answer to the one before races it (objection 173).
async function approveNow(fx, p) {
  const row = await boundApproval(fx, p.id);
  return row ? answer(fx.engine, p.id, row, 'approve') : null;
}
// After an approval refused for staleness: either the answer was 409
// `plan_generation_stale`, or the bundle is listed `stale` and the replan's
// next generation exists (the driver's message).
async function assertStale(fx, p, res, first) {
  if (res && res.status === 409) {
    assert.equal(res.body?.code, 'plan_generation_stale', `refused as stale (${res.text})`);
    return;
  }
  if (res) assert.equal(res.status, 200, `the answer (→ ${res.status} ${res.text})`);
  await tick(fx.engine, p.id, { rounds: 3 });
  const read = await readPlan(fx, p.id);
  assert.ok((read.proposals ?? []).some((x) => x.phase === 1 && x.status === 'stale'), `the bundle listed stale (${JSON.stringify(read.proposals)})`);
  assert.ok(replans(fx.home, p.id).some((w) => w.trigger_source === first.trigger_source && w.trigger_id === first.trigger_id && w.trigger_generation === first.trigger_generation + 1), `and the replan's next generation (${JSON.stringify(replans(fx.home, p.id).map((w) => [w.trigger_source, w.trigger_generation]))})`);
}

describe('M430 the review\'s pending replacements', () => {
  test('S1 (a) a changed stage 2, building when proposed, integrated before the approval: the bundle is stale; the changed stage 2 is never silently dropped', async (t) => {
    const S2b = changed(S2);
    const { fx, p, ctx, plan } = await replacementPending(t, { replacement: [S1, S2b, { ...S3, number: 5, depends_on: [2] }], stageBuild: [builderScript(1), HELD(2), builderScript(2), builderScript(3)] });
    const [first] = replans(fx.home, p.id);
    await advanceHolding(fx, ctx, () => {
      const launch = fx.scripted.launches({ work_kind: 'stage_build' })[1];
      return launch && fx.scripted.eventsOf(launch.pid, 'holding').length > 0 ? true : undefined;
    }, { what: 'stage 2 building' });
    fx.scripted.release('all', 'gate');
    await advanceHolding(fx, ctx, () => (stagesOfPlan(fx.home, plan.id).find((s) => s.number === 2)?.status === 'integrated' ? true : undefined), { what: 'stage 2 integrated before the approval' });
    const res = await approveNow(fx, p);
    await assertStale(fx, p, res, first);
    // Never silently dropped: no generation 2 published without the changed stage 2.
    const g2 = generationOf(fx.home, p.id, 1, 2);
    if (g2) {
      const stages = [...stagesOfPlan(fx.home, g2.id), ...stagesOfPlan(fx.home, plan.id).filter((s) => !s.cancelled_at)];
      assert.ok(stages.some((s) => JSON.stringify(s.tasks).includes('revised:')), `generation 2 carries the changed stage 2 (${JSON.stringify(stages.map((s) => [s.number, s.tasks]))})`);
    }
  });

  test('S1 (b) a new stage depending on kept stage 1, whose work parks before the approval: stale, a next generation, no publication, no endless error', async (t) => {
    const { fx, p, ctx, plan } = await replacementPending(t, {
      policy: { repair_attempts_max: 0 },
      replacement: [S1, changed(S2, { number: 4, depends_on: [1] }), { ...S3, number: 5, depends_on: [4] }],
      after: [replan35({ phase: 1, spec_version: 2, conformance: 'uncertain', stages: [changed(S1, { number: 6 }), changed(S2, { number: 7, depends_on: [6] }), { ...S3, number: 8, depends_on: [7] }] })],
      stageBuild: [script.crash(), script.crash(), script.crash()],
    });
    const [first] = replans(fx.home, p.id);
    await advanceHolding(fx, ctx, () => (stageWorkOf(fx.home, p.id, stagesOfPlan(fx.home, plan.id)[0])?.status === 'parked' ? true : undefined), { what: 'stage 1\'s work parked' });
    const res = await approveNow(fx, p);
    await assertStale(fx, p, res, first);
    assert.equal(generationOf(fx.home, p.id, 1, 2), null, 'nothing published from the stale bundle');
    // No endless error: further rounds make a bounded number of replan runs.
    const before = runsOfProject(fx.home, p.id).length;
    await advanceHolding(fx, ctx, () => undefined, { max: 10 }).catch(() => null);
    assert.ok(replans(fx.home, p.id).length <= 3, `a bounded number of replan generations (${replans(fx.home, p.id).length})`);
    assert.ok(runsOfProject(fx.home, p.id).length - before <= 3, `no endless run of refusals (${runsOfProject(fx.home, p.id).length - before} runs in ten rounds)`);
  });

  test('S2 stage 1 integrated and verifying, kept by the replacement; its check fails after the swap: the repair is dispatched and stage 1 reaches verified', async (t) => {
    const { fx, p, ctx, plan } = await replacementPending(t, {
      tier: 'T2',
      three: false,
      replacement: [S1, changed(S2, { number: 3 })],
      stageBuild: [builderScript(1), builderScript(1), builderScript(2), builderScript(2)],
    });
    const s1 = stagesOfPlan(fx.home, plan.id)[0];
    // Readiness given, stage 1 built and nominated, its checks left queued.
    const c1 = await advanceHolding(fx, ctx, () => candidatesOfProject(fx.home, p.id)[0], { exits: () => null, what: 'stage 1\'s candidate' });
    assert.ok(c1, 'stage 1 nominated');
    const res = await approveNow(fx, p);
    assert.equal(res?.status, 200, `the replacement approved while stage 1 is verifying (→ ${res?.status} ${res?.text})`);
    assert.notEqual(stagesOfPlan(fx.home, plan.id)[0]?.status, 'verified', 'stage 1 not yet verified at the approval (its checks still queued)');
    await advanceHolding(fx, ctx, () => generationOf(fx.home, p.id, 1, 2)?.published_at ?? undefined, { exits: () => null, what: 'generation 2 published' });
    let failed = false;
    const exits = (x) => {
      if (x.key === 'accept-r1' && !failed) {
        failed = true;
        return 1;
      }
      return 0;
    };
    await advanceHolding(fx, ctx, () => (stagesOfPlan(fx.home, plan.id)[0]?.status === 'verified' ? true : undefined), { exits, what: 'kept stage 1 verified after its repair', max: 160 }).catch((err) => {
      const w = stageWorkOf(fx.home, p.id, s1);
      throw new Error(`${err.message} (stage 1 ${stagesOfPlan(fx.home, plan.id)[0]?.status}; its work ${w?.status}, ${runsOfProject(fx.home, p.id).filter((r) => r.work_item === w?.id).length} run(s); accept-r1 failed: ${failed})`);
    });
    assert.ok(failed, 'the fixture is live: accept-r1 failed once after the swap');
    assert.ok(runsOfProject(fx.home, p.id).filter((r) => r.work_item === stageWorkOf(fx.home, p.id, s1).id).length >= 2, 'its repair was dispatched');
  });

  test('M4 a replacement while integrated stage 1\'s work is parked keeps stage 1, its work and its open blocker; stage 1\'s blocker answered replan replaces that generation', async (t) => {
    const { fx, p, ctx, plan } = await journey35(t, { policy: { repair_attempts_max: 0 } });
    fx.scripted.kindScript('stage_build', [builderScript(1), builderScript(1), builderScript(2)]);
    fx.scripted.kindScript('replan', [replan35({ phase: 1, spec_version: 2, stages: [S1, S2] }), replan35({ phase: 1, spec_version: 2, stages: [S1, changed(S2, { number: 3 })] })]);
    fx.scripted.kindScript('spec_change', changeTouching('R2', 'A user sums two numbers through the service, and a refused request names the parameter.'));
    const s1 = stagesOfPlan(fx.home, plan.id)[0];
    // Stage 1 integrated; accept-r1 fails on its candidate; its work parks with a blocker.
    const blocker = await pump(fx, ctx, () => {
      const w = stageWorkOf(fx.home, p.id, s1);
      return w?.status === 'parked' ? openBlockerAbout(fx.home, w.id) : undefined;
    }, { what: 'stage 1\'s work parked', max: 60, exits: (x) => (x.key === 'accept-r1' ? 1 : 0) });
    assert.equal(stagesOfPlan(fx.home, plan.id)[0].status, 'integrated', 'the fixture is live: stage 1 integrated');
    await postChange(fx, ctx, 'Restate R2.');
    const g2 = await pumpNoIdle(fx, ctx, () => generationOf(fx.home, p.id, 1, 2)?.published_at ? generationOf(fx.home, p.id, 1, 2) : undefined, { what: 'the spec change\'s replacement published', max: 200, answerKinds: NO_PLAN_ANSWER, exits: (x) => (x.key === 'accept-r1' ? 1 : 0) });
    const kept = stagesOfPlan(fx.home, plan.id)[0];
    assert.deepEqual([kept.id, kept.status, kept.cancelled_at ?? null], [s1.id, 'integrated', null], 'stage 1 kept');
    assert.equal(stageWorkOf(fx.home, p.id, s1).status, 'parked', 'its work kept, parked');
    assert.equal(openBlockerAbout(fx.home, stageWorkOf(fx.home, p.id, s1).id)?.id, blocker.id, 'its blocker still open');
    assert.ok(blocker.options.some((o) => o.key === 'replan'), 'offering replan');
    const res = await answer(fx.engine, p.id, blocker, 'replan');
    assert.equal(res.status, 200, `the owner answers replan (→ ${res.status} ${res.text})`);
    const g3 = await pumpNoIdle(fx, ctx, () => generationOf(fx.home, p.id, 1, 3)?.published_at ? generationOf(fx.home, p.id, 1, 3) : undefined, { what: 'the blocker\'s replacement published', max: 60, answerKinds: NO_PLAN_ANSWER, exits: (x) => (x.key === 'accept-r1' ? 1 : 0) });
    assert.ok(active(g3), 'generation 3 active');
    assert.equal(phasePlansOf(fx.home, p.id).find((x) => x.id === g2.id).status, 'replaced', 'generation 2 replaced by it');
    assert.ok(replans(fx.home, p.id).some((w) => w.trigger_source === 'blocker_replan'), 'by a blocker_replan');
  });
});
