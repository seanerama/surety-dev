// M413 (b), a conformance stage in phase 2 of an adopted project (slice 35,
// carried from an earlier review; kernel lane). M5 plan §3.2 M413 (b); D6
// §8.1, K11 ("one per project, in the first phase of an adopted project
// only"); A.4 `PLAN_CONFORMANCE_MISPLACED`; the driver's ruling of
// 2026-10-13 (written under manifest slice 35); SEAM.md §§382, 406.
//
// The adopted fixture is carried through conformance and its Alpha barrier;
// the change-phase replan's plan carries a `conformance: true` stage beside
// the Builder stage: refused `PLAN_CONFORMANCE_MISPLACED` naming that stage,
// nothing of phase 2 published.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { deploy } from './harness/deploy/kernel.mjs';
import { candidatesOfProject, planOfPhase } from './harness/journey/drive.mjs';
import { planCheckRows, replanRunsOf, subjectsOf } from './harness/journey/plan35.mjs';
import { pump, retrofitEngine, toConformanceComplete } from './harness/retrofit/drive.mjs';
import { DEFECT_STAGE, conformanceStage, phasePlan } from './harness/retrofit/products.mjs';
import { step } from './harness/scripted.mjs';

const text = (v) => `${JSON.stringify(v, null, 2)}\n`;
const MISPLACED = conformanceStage({ number: 3, implements: [], modules: ['service'] });
const replanWithConformance = {
  steps: [
    { write: { path: '.surety/phases/phase-2.json', content: text({ ...phasePlan(2, { revision: '__HEAD__' }), stages: [DEFECT_STAGE, MISPLACED] }), substitute_head: true } },
    step.write('.surety/phases/phase-2.md', '# Phase 2\n\n- Stage 2: refuse a non-number\n- Stage 3: conformance again\n'),
    step.result({ status: 'completed', summary: 'phase 2 planned', plan: 'phase-2', conformance: 'within_baseline' }),
  ],
};

describe('M413 (b) a conformance stage in phase 2', () => {
  test('the change-phase replan carrying a conformance stage: PLAN_CONFORMANCE_MISPLACED naming it; nothing of phase 2 published', async (t) => {
    const fx = await retrofitEngine(t);
    fx.scripted.kindScript('replan', [replanWithConformance, replanWithConformance, replanWithConformance, replanWithConformance]);
    const { J, env, c1 } = await toConformanceComplete(fx);
    await deploy(fx.engine, J.p.id, c1.id, env.name);
    await pump(fx, J.ctx, () => candidatesOfProject(fx.home, J.p.id).find((c) => c.id === c1.id && c.progress === 'alpha_deployed'), { what: 'c-1 to be alpha_deployed', max: 40 });
    const ended = await pump(fx, J.ctx, () => replanRunsOf(fx.home, J.p.id).find((r) => r.state === 'ended'), { what: 'the change-phase replan to end', max: 20 });
    assert.deepEqual([ended.outcome, ended.reason_class], ['failed', 'invalid_result'], `the plan is refused (${ended.reason_text})`);
    assert.match(ended.reason_text ?? '', /PLAN_CONFORMANCE_MISPLACED/, 'PLAN_CONFORMANCE_MISPLACED');
    const check = planCheckRows(fx.home, J.p.id).filter((c) => c.outcome === 'refused').at(-1);
    assert.ok(subjectsOf(check, 'PLAN_CONFORMANCE_MISPLACED').some((s) => s.startsWith('stage 3')), `naming stage 3 (${JSON.stringify(check?.reasons)})`);
    assert.equal(planOfPhase(fx.home, J.p.id, 2).filter((x) => x.published_at).length, 0, 'nothing of phase 2 published');
  });
});
