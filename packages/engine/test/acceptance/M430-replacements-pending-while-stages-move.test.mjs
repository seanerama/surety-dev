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
//
// The driver's ruling of 2026-10-17 (Sean's delegation; an erratum; SEAM.md
// §548), on M442 (c)'s intermittent failure: a phase does not complete while
// a replacement replan of its open generation is pending (queued, in
// flight, or awaiting its automatic repair); it completes only after that
// replacement publishes and its stages are built, or the replan is retired
// or decided by the owner's route; a parked replan is accounted for by its
// owner question; the phase read names the pending replacement as what
// holds completion; and no replacement replan launches with a package
// saying "plan the next phase" for a generation already completed.
// R1     the replacement's run held past the last stage's integration, then
//        refused, its automatic repair publishing: phase 1 open until then,
//        then complete on generation 2;
// R2     the replacement's run held past the last stage's integration, then
//        refused twice and parked: phase 1 open while it is parked, its
//        blocker open; answered `cancel`, phase 1 completes on generation 1.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer } from './harness/decisions.mjs';
import { builderScript, candidatesOfProject, eventsAbout, phasePlansOf, pump, queuedExecutions, readPlan, runsOfProject, stagesOfPlan, workOf } from './harness/journey/drive.mjs';
import { journey35, replan35 } from './harness/journey/plan35.mjs';
import { HELD, NO_PLAN_ANSWER, S1, S2, S3, active, advanceHolding, boundApproval, changeTouching, changed, currentApproval, generationOf, openBlockerAbout, replacementPending, stageWorkOf } from './harness/journey/review35.mjs';
import { pumpNoIdle, postChange } from './harness/journey/review31b.mjs';
import { BUILDER_FILES } from './harness/journey/reference.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { script, step } from './harness/scripted.mjs';
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

// ---- a replacement pending at the phase's end (SEAM.md §548) ----------------------------------

const DUMP = step.probe('context_dump');
const HOLD = step.hold('gate', { heartbeat_ms: 250 });
// The replacement's stage: R2 restated, after the kept stage 2; and its Builder.
const S2R = changed(S2, { number: 3, goal: 'the service, restated', depends_on: [2] });
const builderS2R = roleThat([step.write('server.mjs', `${BUILDER_FILES[2]['server.mjs']}// R2 restated: a refused request names the parameter.\n`)]);
// A replacement plan the plan check refuses (PLAN_INVALID: a dependency that is no stage number).
const refusedPlan = (before = []) => replan35({ phase: 1, spec_version: 2, stages: [{ ...S2R, depends_on: ['stage-x'] }], before });
const replacementPlan = (before = []) => replan35({ phase: 1, spec_version: 2, stages: [S2R], before });

// The T1 reference project (phase 1: S1, S2) with a change touching R2
// approved (its obligations met by the Verifier's assessment) and its
// replacement replan's first run held at launch (`replan`:
// the replan scripts by launch, the first holding); every routed decision but
// `plan_approval` answered, every check passing. Ticks until phase 1's stages
// are all integrated and nothing but the held replan runs, for six reads in
// a row ({settled}), or until phase 1's plan completes ({completed}).
async function replacementHeldAtPhaseEnd(t, replan) {
  const { fx, p, ctx, plan } = await journey35(t, { tier: 'T1' });
  fx.scripted.kindScript('stage_build', [builderScript(1), builderScript(2), builderS2R, builderS2R]);
  fx.scripted.kindScript('spec_change', changeTouching('R2', 'A user sums two numbers through the service, and a refused request names the parameter.'));
  // The change's obligations (accept-r2, integration) met by the Verifier's
  // assessment that both apply unchanged to the restated statement (D6 §4.5).
  fx.scripted.kindScript('check_correction', roleThat([], { spec_applicability: ['accept-r2', 'integration'].map((check) => ({ check, criteria: ['R1.1', 'R2.1', 'R2.2'], rationale: `${check} asserts what R2's criteria say; the restated statement leaves them unchanged.` })) }));
  fx.scripted.kindScript('replan', replan);
  await postChange(fx, ctx, 'Restate R2.');
  const launch = await advanceHolding(fx, ctx, () => {
    const l = fx.scripted.launches({ work_kind: 'replan' })[0];
    return l && fx.scripted.eventsOf(l.pid, 'holding').length > 0 ? l : undefined;
  }, { what: 'the replacement replan launched and held' });
  const [item] = replans(fx.home, p.id);
  assert.ok(item && item.trigger_source === 'spec_change' && item.id === launch.work_item, `the fixture is live: the held run is the spec change's replan (${JSON.stringify(replans(fx.home, p.id).map((w) => [w.id, w.trigger_source]))}, launch ${launch.work_item})`);
  let quiet = 0;
  const end = await advanceHolding(fx, ctx, () => {
    const now = phasePlansOf(fx.home, p.id).find((x) => x.id === plan.id);
    if (now.completed_at) return { completed: now };
    const built = stagesOfPlan(fx.home, plan.id).every((x) => x.status === 'integrated' || x.status === 'verified');
    const busy = runsOfProject(fx.home, p.id).some((r) => r.state !== 'ended' && r.work_item !== item.id) || queuedExecutions(fx.home, p.id).length > 0;
    quiet = built && !busy ? quiet + 1 : 0;
    return quiet >= 6 ? { settled: true } : undefined;
  }, { what: 'phase 1\'s stages integrated with the replacement held', max: 200 });
  return { fx, p, ctx, plan, item, end };
}

// While the replacement is pending: phase 1 open, no completion recorded,
// and the phase read naming the replan (by its work item) as what holds it.
async function assertHeldOpen(fx, p, plan, item, how) {
  const now = phasePlansOf(fx.home, p.id).find((x) => x.id === plan.id);
  assert.deepEqual([now.status, now.completed_at ?? null], ['published', null], `phase 1 does not complete while the replacement of its open generation is ${how} (status ${now.status}, completed_at ${now.completed_at}, binding ${JSON.stringify(now.completion_binding)})`);
  assert.deepEqual(eventsAbout(fx.home, 'baseline.phase_complete', p.id).filter((e) => e.subject?.phase_plan === plan.id), [], 'no baseline.phase_complete for it');
  assert.deepEqual(replans(fx.home, p.id).filter((w) => w.trigger_source === 'phase_complete'), [], 'and no replan of the next phase');
  const read = await readPlan(fx, p.id);
  assert.deepEqual([read.plan?.id, read.plan?.completed_at ?? null], [plan.id, null], 'the phase read: generation 1, not complete');
  assert.ok(JSON.stringify(read).includes(item.id), `the phase read names the pending replacement ${item.id} as what holds completion (${JSON.stringify(read.plan).slice(0, 1500)})`);
}

// Every launch of the replacement was given the open phase to replace,
// never "plan the next phase" for a completed generation: its dumped
// prompt and its open-plan.json.
function assertEveryLaunchReplacesTheOpenPhase(fx, item) {
  const launches = fx.scripted.launches({ work_item: item.id });
  assert.ok(launches.length >= 1, 'the replacement launched');
  for (const [i, l] of launches.entries()) {
    const files = fx.scripted.probes(l.invocation, 'context_dump').at(-1)?.files ?? [];
    const prompt = files.find((f) => f.name === 'prompt.md')?.text ?? '';
    const line = /^Plan the next phase.*$/m.exec(prompt)?.[0] ?? null;
    assert.ok(line && line.includes('the open phase 1, replacing its plan'), `launch ${i + 1} of the replacement is asked to replace the open phase 1's plan (${JSON.stringify(line)})`);
    const open = files.find((f) => f.name === 'open-plan.json');
    assert.ok(open && JSON.parse(open.text).phase_number === 1, `and carries phase 1's open plan (${JSON.stringify(files.map((f) => f.name))})`);
  }
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
  test('R1 the replacement held past the last stage\'s integration, then refused and repaired: phase 1 stays open until the repair publishes, then completes on generation 2', async (t) => {
    const { fx, p, ctx, plan, item, end } = await replacementHeldAtPhaseEnd(t, [refusedPlan([DUMP, HOLD]), replacementPlan([DUMP])]);
    assert.equal(end.completed, undefined, `phase 1 completed while its replacement replan was in flight (completed_at ${end.completed?.completed_at}; binding ${JSON.stringify(end.completed?.completion_binding)})`);
    await assertHeldOpen(fx, p, plan, item, 'in flight');
    fx.scripted.release('all', 'gate');
    // Refused, then awaiting and running its automatic repair: still open until it publishes.
    const g2 = await advanceHolding(fx, ctx, () => {
      const g = generationOf(fx.home, p.id, 1, 2);
      if (g?.published_at) return g;
      const now = phasePlansOf(fx.home, p.id).find((x) => x.id === plan.id);
      if (now.completed_at) throw new Error(`phase 1 completed while its replacement replan awaited its repair (runs ${JSON.stringify(runsOfProject(fx.home, p.id).filter((r) => r.work_item === item.id).map((r) => [r.outcome, r.reason_class, r.reason_text]))})`);
      const approval = currentApproval(fx.home, p.id);
      return approval ? { approval } : undefined;
    }, { what: 'the repaired replacement published or routed' });
    const runs = runsOfProject(fx.home, p.id).filter((r) => r.work_item === item.id);
    assert.deepEqual(runs.map((r) => r.outcome).slice(0, 1), ['failed'], `the fixture is live: the first run was refused (${JSON.stringify(runs.map((r) => [r.outcome, r.reason_class, r.reason_text]))})`);
    assertEveryLaunchReplacesTheOpenPhase(fx, item);
    if (g2.approval) assert.equal((await answer(fx.engine, p.id, g2.approval, 'approve')).status, 200, 'the owner approves the replacement');
    const done = await pump(fx, ctx, () => phasePlansOf(fx.home, p.id).find((x) => x.phase_number === 1 && active(x) && x.completed_at), { what: 'phase 1 complete after its replacement', max: 160 });
    assert.equal(done.generation, 2, 'phase 1 completes on generation 2');
    assert.equal(done.completion_binding?.generation, 2, 'bound to generation 2');
    assert.equal(phasePlansOf(fx.home, p.id).find((x) => x.id === plan.id).completed_at ?? null, null, 'generation 1 never completed');
    assert.ok(stagesOfPlan(fx.home, done.id).some((x) => x.number === 3 && x.status === 'verified'), `the replacement's stage 3 built and verified (${JSON.stringify(stagesOfPlan(fx.home, done.id).map((x) => [x.number, x.status]))})`);
    assertEveryLaunchReplacesTheOpenPhase(fx, item);
  });

  test('R2 the replacement held past the last stage\'s integration, then refused twice and parked: phase 1 stays open, accounted for by the blocker; answered cancel, phase 1 completes on generation 1', async (t) => {
    const { fx, p, ctx, plan, item, end } = await replacementHeldAtPhaseEnd(t, [refusedPlan([DUMP, HOLD]), refusedPlan([DUMP])]);
    assert.equal(end.completed, undefined, `phase 1 completed while its replacement replan was in flight (completed_at ${end.completed?.completed_at}; binding ${JSON.stringify(end.completed?.completion_binding)})`);
    fx.scripted.release('all', 'gate');
    const blocker = await advanceHolding(fx, ctx, () => {
      const w = replans(fx.home, p.id).find((x) => x.id === item.id);
      return w?.status === 'parked' ? openBlockerAbout(fx.home, w.id) : undefined;
    }, { what: 'the replacement parked with its blocker' });
    assert.ok(blocker, 'the parked replacement asks its owner question');
    assertEveryLaunchReplacesTheOpenPhase(fx, item);
    await tick(fx.engine, p.id, { rounds: 4 });
    await assertHeldOpen(fx, p, plan, item, 'parked');
    assert.equal(openBlockerAbout(fx.home, item.id)?.id, blocker.id, 'its blocker still open: the parked replacement is accounted for by its question');
    assert.ok(blocker.options.some((o) => o.key === 'cancel'), `offering cancel (${JSON.stringify(blocker.options.map((o) => o.key))})`);
    assert.equal((await answer(fx.engine, p.id, blocker, 'cancel')).status, 200, 'the owner cancels the replacement');
    const done = await pump(fx, ctx, () => phasePlansOf(fx.home, p.id).find((x) => x.id === plan.id && x.completed_at), { what: 'phase 1 complete once its replacement is retired', max: 60 });
    assert.equal(done.completion_binding?.generation, 1, 'phase 1 completes on generation 1');
    assert.equal(generationOf(fx.home, p.id, 1, 2), null, 'no generation 2');
  });
});
