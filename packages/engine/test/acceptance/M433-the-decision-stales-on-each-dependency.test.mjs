// M433 (a) (slice 36; kernel lane). M5 plan §3.6 M433; D6-C04; D6 §4.4
// ("preview and effect recompute the manifest, and a material change between
// them (a new result, finding, work status or plan generation touching an
// affected subject) makes the answer stale"), §4.5 (the manifest binds the
// spec version, the side ref's revision, the effective protected version
// and the impact's hash); D1 §4.6, §10.5; B05; SEAM.md §§420, 421; the
// driver's rulings Q4, Q5 (2026-10-13).
//
// The change rewords R2.1 and R2.2: its impact lists accept-r2 and
// integration, stage 2 and R2, in phase 1, the current phase. Each of these
// in turn, between the preview and the answer, makes the answer stale and
// the next generation is asked:
//   a work status change (stage 2's Builder, held, released: its work moves);
//   a new result (accept-r2's execution on stage 2's candidate recorded);
//   a new finding (a Reviewer's naming R2.1);
//   a protected change (the owner's policy commit);
// then (Q5) a new result of a check the impact does not list (accept-r1)
// stales nothing: the answer is accepted; and between that answer and its
// effect a new result touching an affected subject (integration's) makes
// the effect's intent invalidated, nothing applied.
// A plan generation change (stage 1 parked, its blocker answered `replan`,
// the replacement published) and a new spec version (Q4: a Spec Writer
// session's `spec_approval` in `developing`) each make it stale too.
// The moved side ref is M431 (f)'s.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer, answerAndHoldEffect, assertEffectInvalidated, assertStaleAnswer, decision, decisionsOn } from './harness/decisions.mjs';
import { operatorRequest, recordExit } from './harness/checks/selection.mjs';
import { executionRow } from './harness/checks/fixtures.mjs';
import { script } from './harness/scripted.mjs';
import { ROUTED_KINDS, builderScript, candidatesOfProject, ownerPolicy, planOfPhase, queuedExecutions, runsOfProject, specRevisions, stagesOfPlan, workOf } from './harness/journey/drive.mjs';
import { tick } from './harness/runs.mjs';
import { journey35, replan35 } from './harness/journey/plan35.mjs';
import { STAGES } from './harness/journey/reference.mjs';
import { pumpNoIdle } from './harness/journey/review31b.mjs';
import { specSaves } from './harness/journey/spec34.mjs';
import {
  SPEC_CHANGES,
  changeScript,
  findingsOn,
  nextOpenChange,
  pumpHolding,
  requestRow,
  untilProposedOrFailed,
} from './harness/journey/change36.mjs';

const R2_CHANGE = [{ key: 'R2', kind: 'criteria_changed', reason: 'R2.1 and R2.2 name the content type' }];
const LISTED = ['accept-r2', 'integration'];
const active = (x) => x.active === 1 || x.active === true;

async function proposeR2(fx, ctx, spec = SPEC_CHANGES.r2Both, changes = R2_CHANGE) {
  fx.scripted.kindScript('spec_change', changeScript(spec, changes));
  const res = await fx.engine.post(`/v1/projects/${ctx.project}/spec/change-requests`, { text: 'The owner\'s change.' });
  assert.equal(res.status, 201, `POST …/spec/change-requests (→ ${res.status} ${res.text})`);
  const out = await untilProposedOrFailed(fx, ctx, res.body.request.id, ctx.holdOpts);
  assert.ok(out.decision, `the change is proposed (${out.request.status} ${out.request.failure ?? ''})`);
  return out;
}

// A stale answer on `previewed`, then the next generation, read.
async function staleThenNext(fx, ctx, request, previewed, what) {
  await tick(fx.engine, ctx.project, { rounds: 2 });
  await assertStaleAnswer(fx, ctx.project, previewed, 'approve').catch((err) => {
    throw new Error(`${what}: the answer on the earlier preview is not stale (D6 §4.4): ${err.message}`);
  });
  await nextOpenChange(fx, ctx, request, previewed);
  await quiet(fx, ctx);
  return current(fx, ctx, request);
}

// The open spec_change decision about the request, as it is now.
const current = (fx, ctx, request) =>
  pumpHolding(fx, ctx, () => {
    const d = decisionsOn(fx.home, 'spec_change', request).filter((x) => x.status === 'open').at(-1);
    return d ? decision(fx.home, d.id) : undefined;
  }, { what: `the open spec_change about ${request}`, max: 12, ...ctx.holdOpts });

// Rounds until no run is live and no work item changes status for two
// rounds: the project at rest, so what follows is the only change.
async function quiet(fx, ctx) {
  let last = null;
  let same = 0;
  await pumpHolding(
    fx,
    ctx,
    () => {
      const live = runsOfProject(fx.home, ctx.project).filter((r) => r.state !== 'ended').length;
      const sig = JSON.stringify(workOf(fx.home, ctx.project).map((w) => [w.id, w.status]));
      same = sig === last && live === 0 ? same + 1 : 0;
      last = sig;
      return same >= 2;
    },
    { what: 'the project at rest', max: 40, ...ctx.holdOpts },
  );
}

describe('M433 (a) the decision stales on each dependency the impact touches', () => {
  test('a work status change, a new result, a new finding, a protected change, each touching an affected subject, stale it in turn; an unlisted check\'s result does not; a listed result between answer and effect invalidates the effect', async (t) => {
    const { fx, p, ctx } = await journey35(t, { policy: { repair_attempts_max: 0 } });
    // Stage 2's first Builder fails, so its work parks; the owner's retry is the
    // work status change. Every execution of a listed check is held queued by the test.
    fx.scripted.kindScript('stage_build', [builderScript(1), script.crash(), builderScript(2), builderScript(3), builderScript(4)]);
    ctx.holdOpts = { hold: (x) => LISTED.includes(x.key), answerKinds: ROUTED_KINDS.filter((k) => k !== 'spec_change') };
    const plan1 = planOfPhase(fx.home, p.id, 1).find(active);
    const stage2 = stagesOfPlan(fx.home, plan1.id).find((s) => s.number === 2);
    const build2 = () => workOf(fx.home, p.id, 'stage_build').find((w) => w.subject?.stage === stage2.id);
    const parked = await pumpHolding(fx, ctx, () => {
      const w = build2();
      return w?.status === 'parked' ? decisionsOn(fx.home, 'blocker', w.id).find((d) => d.status === 'open') : undefined;
    }, { what: 'stage 2 parked with its blocker', max: 300, ...ctx.holdOpts });
    await quiet(fx, ctx);
    const { request } = await proposeR2(fx, ctx);
    const d1 = await current(fx, ctx, request.id);
    // 1. A work status change of an affected subject: stage 2's parked work retried.
    assert.equal((await answer(fx.engine, p.id, decision(fx.home, parked.id), 'retry')).status, 200, 'the owner answers stage 2\'s blocker retry');
    const d2 = await staleThenNext(fx, ctx, request.id, d1, 'a work status change of stage 2');
    // 2. A new result of a listed check: accept-r2 on stage 2's candidate.
    const candidate = candidatesOfProject(fx.home, p.id).at(-1);
    const ex = Object.fromEntries(queuedExecutions(fx.home, p.id).filter((x) => x.candidate === candidate.id && LISTED.includes(x.key)).map((x) => [x.key, x.id]));
    assert.ok(ex['accept-r2'] && ex.integration, `the fixture is live: accept-r2 and integration queued on stage 2's candidate (${JSON.stringify(ex)})`);
    await recordExit(fx.engine, ex['accept-r2'], 0);
    const d3 = await staleThenNext(fx, ctx, request.id, d2, 'a new result of accept-r2');
    // 3. A new finding naming an affected criterion.
    await findingsOn(fx, ctx, candidate.id, [{ category: 'defect', severity: 'low', criterion: 'R2.1', message: 'The answer has no content type.' }]);
    const d4 = await staleThenNext(fx, ctx, request.id, d3, 'a new finding naming R2.1');
    // 4. A protected change: the owner's policy commit.
    await ownerPolicy(fx, p.id, { deadline_reviewer: 900 });
    const d5 = await staleThenNext(fx, ctx, request.id, d4, 'a protected change');
    // 5. (Q5) with the project at rest, a result of a check the impact does not list stales nothing.
    const [smoke] = Object.values(await operatorRequest(fx.engine, p.id, candidate.id, ['smoke']));
    await recordExit(fx.engine, smoke, 0);
    // 6. The answer accepted; a listed result between it and its effect.
    const held = await answerAndHoldEffect(fx, p.id, decision(fx.home, d5.id), 'approve');
    assert.equal(executionRow(fx.home, ex.integration).status, 'queued', 'the fixture is live: integration still queued');
    await recordExit(fx.engine, ex.integration, 0);
    await assertEffectInvalidated(fx, decision(fx.home, d5.id), held);
    assert.deepEqual(specRevisions(fx.home, p.id).map((r) => r.version), [1], 'nothing applied');
    assert.notEqual(requestRow(fx.home, request.id).status, 'approved', 'the request is not approved');
  });

  test('a plan generation change touching an affected subject: stage 1 parked, its blocker answered replan, the replacement published, the answer stale', async (t) => {
    const { fx, p, ctx } = await journey35(t, { policy: { repair_attempts_max: 0 } });
    fx.scripted.kindScript('stage_build', [script.crash(), builderScript(1), builderScript(2)]);
    const S1b = { ...STAGES[1][0], number: 3, tasks: ['write src/sum.mjs exporting sum(a, b) with Number arguments'] };
    const S2b = { ...STAGES[1][1], number: 4, depends_on: [3] };
    fx.scripted.kindScript('replan', [replan35({ phase: 1, stages: [S1b, S2b] }), replan35({})]);
    ctx.holdOpts = {};
    const plan1 = planOfPhase(fx.home, p.id, 1).find(active);
    const parked = await pumpNoIdle(fx, ctx, () => {
      const w = workOf(fx.home, p.id, 'stage_build').find((x) => x.status === 'parked');
      return w && decisionsOn(fx.home, 'blocker', w.id).find((d) => d.status === 'open');
    }, { what: 'stage 1 parked with its blocker', max: 60 });
    const { request, decision: d1 } = await proposeR2(fx, ctx, SPEC_CHANGES.r1Reworded, [{ key: 'R1', kind: 'criteria_changed', reason: 'R1.1 names the type' }]);
    assert.equal((await answer(fx.engine, p.id, parked, 'replan')).status, 200, 'the owner answers the parked blocker replan');
    await pumpNoIdle(fx, ctx, () => planOfPhase(fx.home, p.id, 1).find((x) => active(x) && x.generation > plan1.generation), { what: 'the replacement published', max: 60, answerKinds: ['plan_approval'] });
    await staleThenNext(fx, ctx, request.id, decision(fx.home, d1.id), 'a plan generation change touching stage 1');
  });

  test('a new spec version (Q4: a Spec Writer session\'s spec_approval in developing) makes the answer stale', async (t) => {
    const { fx, p, ctx } = await journey35(t);
    ctx.holdOpts = {};
    const { request, decision: d1 } = await proposeR2(fx, ctx, SPEC_CHANGES.r1Reworded, [{ key: 'R1', kind: 'criteria_changed', reason: 'R1.1 names the type' }]);
    const { approval } = await specSaves(fx, p.id, [SPEC_CHANGES.r3Statement]);
    assert.ok(approval, 'its close raises spec_approval');
    assert.equal((await answer(fx.engine, p.id, approval, 'approve')).status, 200, 'the owner approves it');
    await pumpHolding(fx, ctx, () => specRevisions(fx.home, p.id).find((r) => r.version === 2), { what: 'version 2 from the session', max: 10 });
    await staleThenNext(fx, ctx, request.id, decision(fx.home, d1.id), 'a new spec version');
  });
});
