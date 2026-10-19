// M430, the slice-35 review's M3 (slice 35; kernel lane). M5 plan §3.5 M430;
// D6-F04; D6 §5.7, §6.6, A.2 (BlockerOption `replan` for stage work); D3 §5
// X2; the driver's message of 2026-10-13; SEAM.md §415.
//
// (i)   a `fix` item's X2 blocker offers no `replan` (exactly correct_check,
//       change_spec, retry, cancel);
// (ii)  a stage's blocker answered `replan`, whose replan is refused and
//       parks: the stage's blocker is raised again;
// (iii) a plan-targeted Reviewer `fix` whose replan loses the swap: the
//       finding's disposition is reopened (no longer `fix`).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer, consume, openDecision } from './harness/decisions.mjs';
import { findingsOf, raiseFindings, review } from './harness/gates.mjs';
import { roleThat, waitForCandidates } from './harness/gitruns.mjs';
import { buildAndNominate, findingRow, registrationsBy, repairProject, x2Blocker } from './harness/checks/repair.mjs';
import { recordExit } from './harness/checks/selection.mjs';
import { candidatesOfProject, pump, readPlan, runsOfProject, workOf } from './harness/journey/drive.mjs';
import { journey35, openPlanApprovals, replan35 } from './harness/journey/plan35.mjs';
import { NO_PLAN_ANSWER, S1, S2, changed, generationOf, openBlockerAbout, replacementPending, replanOf, stageWorkOf } from './harness/journey/review35.mjs';
import { pumpNoIdle } from './harness/journey/review31b.mjs';
import { scriptedEngine, tickUntil, runsOf } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { stagesOfPlan } from './harness/journey/drive.mjs';
import { workItemsOf } from './harness/journal.mjs';

const R9 = [S1, { ...S2, implements: ['R2', 'R9'] }];

describe('M430 the review\'s blockers and dispositions', () => {
  test('(i) a fix item\'s X2 blocker offers no replan', async (t) => {
    const fx = await scriptedEngine(t);
    fx.scripted.defaultScript(script.complete());
    const p = await repairProject(fx, { policy: { autonomy: 'step' } });
    const { candidate: c1 } = await buildAndNominate(fx, p);
    const [found] = await raiseFindings(fx, p.id, c1.id, [{ category: 'defect', severity: 'medium', message: 'the session survives a logout', check: 'acc', criterion: 'R1.1' }], { kind: 'verification' });
    await review(fx, p.id, c1.id, { dispositions: [{ finding: found.id, disposition: 'fix' }] });
    const fix = workItemsOf(fx.home, p.id).find((w) => w.kind === 'fix' && w.subject?.finding === found.id);
    assert.ok(fix, 'the fixture is live: the fix registered');
    // The fix's Builder objects to acc, then acc fails on the fix's candidate.
    fx.scripted.script(fix.id, [roleThat([step.write('src/fix-1.js', 'export const fix = 1;\n')], { nominate: true, objections: [{ check: 'acc', criterion: 'R1.1', category: 'contract_conflict', message: 'acc contradicts the logout interface' }] })]);
    await consume(fx, p.id, await openDecision(fx, p.id, 'blocker', fix.id), 'continue');
    await tickUntil(fx.engine, p.id, () => runsOf(fx.home, fix.id)[0]?.state === 'ended', { what: 'the fix to be built' });
    const [, c2] = await waitForCandidates(fx, p.id, 2);
    const acc = await tickUntil(fx.engine, p.id, () => registrationsBy(fx.home, c2.id).acc, { max: 6, what: 'acc registered on the fix candidate' });
    await recordExit(fx.engine, acc.id, 1, { output: 'acc failed on the fix candidate\n' });
    // x2Blocker asserts the fix's exact set: correct_check, change_spec, retry, cancel (SEAM.md §415).
    await x2Blocker(fx, p.id, fix.id);
  });

  test('(ii) a stage\'s blocker answered replan, whose replan is refused and parks: the stage\'s blocker is raised again', async (t) => {
    const { fx, p, ctx, plan } = await journey35(t, { policy: { repair_attempts_max: 0 } });
    fx.scripted.kindScript('stage_build', [script.crash(), script.crash(), script.crash()]);
    fx.scripted.kindScript('replan', [replan35({ phase: 1, stages: R9 }), replan35({ phase: 1, stages: R9 }), replan35({ phase: 1, stages: R9 })]);
    const s1 = stagesOfPlan(fx.home, plan.id)[0];
    const blocker = await pump(fx, ctx, () => {
      const w = stageWorkOf(fx.home, p.id, s1);
      return w?.status === 'parked' ? openBlockerAbout(fx.home, w.id) : undefined;
    }, { what: 'stage 1 parked', max: 60 });
    assert.equal((await answer(fx.engine, p.id, blocker, 'replan')).status, 200, 'the owner answers replan');
    const [r] = workOf(fx.home, p.id, 'replan');
    assert.ok(r, 'replan work created');
    // The replan refused (R9), repaired and refused again, parks; the stage's blocker returns.
    const again = await pumpNoIdle(fx, ctx, () => {
      const replanParked = workOf(fx.home, p.id, 'replan').find((w) => w.id === r.id)?.status === 'parked';
      const b = openBlockerAbout(fx.home, stageWorkOf(fx.home, p.id, s1).id);
      return replanParked && b && b.id !== blocker.id ? b : undefined;
    }, { what: 'the replan parked and the stage\'s blocker raised again', max: 60, answerKinds: NO_PLAN_ANSWER }).catch((err) => {
      throw new Error(`${err.message} (replan ${workOf(fx.home, p.id, 'replan').map((w) => w.status).join(',')}; stage work ${stageWorkOf(fx.home, p.id, s1)?.status}; open blocker ${openBlockerAbout(fx.home, stageWorkOf(fx.home, p.id, s1).id)?.id ?? 'none'})`);
    });
    assert.ok(again.options.some((o) => o.key === 'retry'), 'the stage\'s blocker offers its answers again');
  });

  test('(iii) a plan-targeted fix whose replan loses the swap: the finding\'s disposition is reopened', async (t) => {
    const { fx, p, ctx } = await journey35(t);
    fx.scripted.kindScript('replan', [replan35({ phase: 1, conformance: 'uncertain', stages: [S1, changed(S2, { number: 3 })] }), replan35({ phase: 1, conformance: 'uncertain', stages: [S1, changed(S2, { number: 4 })] })]);
    const c1 = await pump(fx, ctx, () => candidatesOfProject(fx.home, p.id)[0], { what: 'stage 1\'s candidate', max: 60 });
    const [a, b] = await raiseFindings(fx, p.id, c1.id, [
      { category: 'contract_conflict', severity: 'medium', message: 'A: the plan has stage 2 accept floats; the map says integers.' },
      { category: 'contract_conflict', severity: 'medium', message: 'B: the plan has stage 2 answer text; the map says JSON.' },
    ]);
    await review(fx, p.id, c1.id, { dispositions: [a, b].map((f) => ({ finding: f.id, disposition: 'fix', target: 'plan' })) });
    const pending = await pumpNoIdle(fx, ctx, () => {
      const open = openPlanApprovals(fx.home, p.id);
      return open.length === 2 ? open : undefined;
    }, { what: 'both replacements pending', max: 120, answerKinds: NO_PLAN_ANSWER });
    // The approval for B's replan wins; A's loses.
    const itemOfApproval = (d) => runsOfProject(fx.home, p.id).find((r) => r.id === d.subject_id)?.work_item;
    const byFinding = (f) => pending.find((d) => workOf(fx.home, p.id, 'replan').find((w) => w.id === itemOfApproval(d))?.trigger_id === f.id) ?? null;
    const [forA, forB] = [byFinding(a), byFinding(b)];
    assert.ok(forA && forB, `each replacement traced to its finding (${JSON.stringify(workOf(fx.home, p.id, 'replan').map((w) => [w.trigger_source, w.trigger_id]))})`);
    assert.equal((await answer(fx.engine, p.id, forB, 'approve')).status, 200);
    await pumpNoIdle(fx, ctx, () => generationOf(fx.home, p.id, 1, 2)?.published_at ?? undefined, { what: 'B\'s replacement published', max: 20, answerKinds: NO_PLAN_ANSWER });
    const lost = await answer(fx.engine, p.id, forA, 'approve');
    assert.equal(lost.status, 409, `A's replacement loses the swap (→ ${lost.status} ${lost.text})`);
    await pumpNoIdle(fx, ctx, () => (findingRow(fx.home, a.id).disposition !== 'fix' ? true : undefined), { what: 'A\'s disposition reopened', max: 6, answerKinds: NO_PLAN_ANSWER }).catch(() => null);
    const after = findingRow(fx.home, a.id);
    assert.notEqual(after.disposition, 'fix', `A's disposition is reopened to the owner, no longer fix (SEAM.md §415) (${JSON.stringify({ disposition: after.disposition, status: after.status })})`);
    assert.ok(findingsOf(fx.home, p.id).some((f) => f.id === a.id), 'the finding itself kept');
  });

  test('(iv) H4: a spec change\'s replacement refused stale by a stage blocker\'s replacement: re-registered against the active generation, holding completion; its approval publishes generation 3; no further re-raise', async (t) => {
    // Every Builder crashes, so no stage is ever carried; each replacement lists only new stage
    // numbers, so a stage parking moves nothing a pending replacement counted.
    const crashes = Array.from({ length: 12 }, () => script.crash());
    const blockerPlan = replanOf([changed(S1, { number: 3 }), changed(S2, { number: 4, depends_on: [3] })]);
    const againPlan = replanOf([changed(S1, { number: 5 }), changed(S2, { number: 6, depends_on: [5] })]);
    const { fx, p, ctx, plan } = await replacementPending(t, { three: false, policy: { repair_attempts_max: 0 }, replacement: [changed(S1, { number: 7 }), changed(S2, { number: 8, depends_on: [7] })], after: [blockerPlan, againPlan], stageBuild: crashes });
    const replans = () => workOf(fx.home, p.id, 'replan');
    const [spec1] = replans();
    assert.equal(spec1?.trigger_source, 'spec_change', 'the fixture is live: the spec change\'s replacement pending');
    const sourceOf = (d) => replans().find((w) => w.id === runsOfProject(fx.home, p.id).find((r) => r.id === d.subject_id)?.work_item)?.trigger_source;
    const approvalOf = (source, item) => openPlanApprovals(fx.home, p.id).find((d) => sourceOf(d) === source && (!item || runsOfProject(fx.home, p.id).find((r) => r.id === d.subject_id)?.work_item === item.id));
    // Stage 1 parks; its blocker answered replan; that replacement approved: generation 2.
    const s1 = stagesOfPlan(fx.home, plan.id)[0];
    const blocker = await pumpNoIdle(fx, ctx, () => {
      const w = stageWorkOf(fx.home, p.id, s1);
      return w?.status === 'parked' ? openBlockerAbout(fx.home, w.id) : undefined;
    }, { what: 'stage 1 parked', max: 60, answerKinds: NO_PLAN_ANSWER });
    assert.equal((await answer(fx.engine, p.id, blocker, 'replan')).status, 200, 'the owner answers replan');
    const forBlocker = await pumpNoIdle(fx, ctx, () => approvalOf('blocker_replan'), { what: 'the blocker\'s replacement awaiting the owner', max: 60, answerKinds: NO_PLAN_ANSWER });
    const forSpec = approvalOf('spec_change');
    assert.ok(forSpec, `the fixture is live: the spec change's replacement still awaits the owner (${JSON.stringify(replans().map((w) => [w.trigger_source, w.trigger_generation, w.status]))})`);
    assert.equal((await answer(fx.engine, p.id, forBlocker, 'approve')).status, 200);
    const g2 = await pumpNoIdle(fx, ctx, () => generationOf(fx.home, p.id, 1, 2)?.published_at ? generationOf(fx.home, p.id, 1, 2) : undefined, { what: 'generation 2 published', max: 20, answerKinds: NO_PLAN_ANSWER });
    const lost = await answer(fx.engine, p.id, forSpec, 'approve');
    assert.deepEqual([lost.status, lost.body?.code], [409, 'plan_generation_stale'], `the spec change's replacement refused stale (→ ${lost.status} ${lost.text})`);
    // Sean's ruling (E171 item 5 H4): re-registered against the active generation.
    const spec2 = await pumpNoIdle(fx, ctx, () => replans().find((w) => w.trigger_source === 'spec_change' && w.trigger_id === spec1.trigger_id && w.trigger_generation === 2), { what: 'the spec change\'s replan re-registered', max: 10, answerKinds: NO_PLAN_ANSWER }).catch(() => null);
    assert.ok(spec2, `a spec change's replan refused stale is re-registered against the active generation 2, trigger_generation 2 (E171 item 5 H4; Sean's ruling) (replans ${JSON.stringify(replans().map((w) => [w.trigger_source, w.trigger_generation, w.status]))})`);
    const ev = JSON.parse(spec2.trigger_evidence);
    assert.deepEqual([ev.phase_plan, ev.generation, ev.evidence?.request, ev.from_work_item], [g2.id, 2, JSON.parse(spec1.trigger_evidence).evidence?.request, spec1.id], `its evidence names generation 2's plan, the request and the stale replan (${spec2.trigger_evidence})`);
    const held = (await readPlan(fx, p.id)).plan?.completion_held_by;
    assert.equal(held?.work_item, spec2.id, `completion_held_by names it (${JSON.stringify(held)})`);
    assert.equal(generationOf(fx.home, p.id, 1, 2).completed_at ?? null, null, 'phase 1 not complete');
    const forSpec2 = await pumpNoIdle(fx, ctx, () => approvalOf('spec_change', spec2), { what: 'the re-registered replacement awaiting the owner', max: 60, answerKinds: NO_PLAN_ANSWER });
    assert.equal((await answer(fx.engine, p.id, forSpec2, 'approve')).status, 200);
    const g3 = await pumpNoIdle(fx, ctx, () => generationOf(fx.home, p.id, 1, 3)?.published_at ? generationOf(fx.home, p.id, 1, 3) : undefined, { what: 'generation 3 published', max: 20, answerKinds: NO_PLAN_ANSWER });
    assert.equal(JSON.parse(g3.replacement ?? 'null')?.trigger?.source, 'spec_change', `generation 3 carries the spec change (${g3.replacement})`);
    await pumpNoIdle(fx, ctx, () => undefined, { max: 8, answerKinds: NO_PLAN_ANSWER }).catch(() => null);
    assert.deepEqual(replans().filter((w) => w.trigger_source === 'spec_change').map((w) => w.trigger_generation), [1, 2], 'no third replan of the spec change');
  });
});
