// M432 (d), (a) and M431 (b), as the slice-36 review found them (slice 36;
// kernel lane). D6 §4.2 (one proposal at a time), §4.4 ("an impact the
// engine cannot compute ... refuses the proposal with the reason, never an
// empty impact"; "whether the change touches the current phase ... or only
// later ones"), §4.5, §5.7; the driver's rulings on the review's S2 and M1
// (2026-10-14); SEAM §§417, 418, 419, 421, 426.
//
// S2: a change touching R2 is proposed and awaits the owner; meanwhile a Spec
//     Writer session's approval makes version 2, which withdraws R2. The
//     pending proposal's impact can no longer be computed against the
//     current version: the engine refuses it with the reason, the request
//     terminal (neither requested, proposed nor approved), its decision no
//     longer open, its work ended; a second change request then proceeds to
//     its proposal and is not stuck eligible.
// M1: phase 1 open (stage 1 parked, stage 2 planned), a change touching only
//     R3, a phase-2 requirement: the impact's `touches_current` is false;
//     approved, phase 1's plan keeps its generation and its stages, and no
//     replan replaces phase 1.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer, decision, decisionsOn } from './harness/decisions.mjs';
import { script } from './harness/scripted.mjs';
import { scriptedEngine, waitForIdle } from './harness/runs.mjs';
import { ROUTED_KINDS, authoringReady, builderScript, journeyContext, planOfPhase, specRevisions, stagesOfPlan, workOf } from './harness/journey/drive.mjs';
import { journey35, specReady } from './harness/journey/plan35.mjs';
import { REQUIREMENTS, specText } from './harness/journey/reference.mjs';
import { specSaves } from './harness/journey/spec34.mjs';
import { SPEC_CHANGES, changeScript, impactRecordOf, pumpHolding, requestRow, untilProposedOrFailed } from './harness/journey/change36.mjs';

const OWNER_KINDS = ROUTED_KINDS.filter((k) => k !== 'spec_change');
const active = (x) => x.active === 1 || x.active === true;
const withoutR2 = (version, extra = {}) =>
  specText({
    version,
    requirements: REQUIREMENTS.filter((r) => r.key !== 'R2').map((r) => (extra[r.key] ? { ...r, ...extra[r.key] } : r)),
    changeLog: [{ version: 2, date: '2026-10-14', change: 'R2 withdrawn', by: 'Sean' }, ...(version > 2 ? [{ version, date: '2026-10-14', change: 'R1.1 names the type', by: 'Sean' }] : [])],
  });

async function post(fx, project, spec, changes, text) {
  fx.scripted.kindScript('spec_change', changeScript(spec, changes));
  const res = await fx.engine.post(`/v1/projects/${project}/spec/change-requests`, { text });
  assert.equal(res.status, 201, `${text} (→ ${res.status} ${res.text})`);
  return res.body.request.id;
}

describe('M432: a pending proposal the current version voids; a change to a later phase only', () => {
  test('S2: a proposal whose requirement a new version withdraws is refused with the reason; its request ends; a second request proceeds', async (t) => {
    const fx = await scriptedEngine(t);
    fx.scripted.defaultScript(script.complete());
    const p = await specReady(fx);
    const ctx = journeyContext(fx, p);
    const first = await post(fx, p.id, SPEC_CHANGES.r2Both, [{ key: 'R2', kind: 'criteria_changed', reason: 'content type' }], 'R2.1 and R2.2 name the content type.');
    const proposed = await untilProposedOrFailed(fx, ctx, first);
    assert.ok(proposed.decision, `the fixture is live: the change is proposed and awaits the owner (${proposed.request.status})`);
    // A Spec Writer's version 2 withdraws R2, once the spec_change run that
    // raised the proposal has ended: no session opens beside a one-shot run (SEAM §344; S4, E174 item 7).
    await waitForIdle(fx.home, p.id);
    const { approval } = await specSaves(fx, p.id, [withoutR2(2)]);
    assert.ok(approval, 'the fixture is live: the session\'s close raises spec_approval');
    assert.equal((await answer(fx.engine, p.id, approval, 'approve')).status, 200, 'the owner approves version 2');
    await pumpHolding(fx, ctx, () => specRevisions(fx.home, p.id).find((r) => r.version === 2), { what: 'version 2', max: 10 });
    // The pending proposal is refused with its reason.
    const ended = await pumpHolding(fx, ctx, () => {
      const r = requestRow(fx.home, first);
      return ['requested', 'proposed', 'approved'].includes(r.status) ? undefined : r;
    }, { what: 'the voided proposal refused', max: 20 }).catch(() => requestRow(fx.home, first));
    assert.ok(!['requested', 'proposed', 'approved'].includes(ended.status), `the request is terminal, refused (it is ${ended.status})`);
    assert.match(`${ended.failure ?? ''} ${ended.last_refusal ?? ''}`, /\S/, 'with the reason recorded');
    assert.deepEqual(decisionsOn(fx.home, 'spec_change', first).filter((d) => d.status === 'open').map((d) => d.id), [], 'no spec_change about it stays open');
    const work = workOf(fx.home, p.id, 'spec_change').find((w) => w.id === ended.work_item);
    assert.ok(['complete', 'cancelled'].includes(work.status), `its work ends (it is ${work.status})`);
    // A second request proceeds.
    const second = await post(fx, p.id, withoutR2(3, { R1: { criteria: [{ id: 'R1.1', text: 'Given the numbers 2 and 3, when `sum(2, 3)` of `src/sum.mjs` is called, then it returns the number 5.' }] } }), [{ key: 'R1', kind: 'criteria_changed', reason: 'R1.1 names the type' }], 'R1.1 names the type.');
    const next = await untilProposedOrFailed(fx, ctx, second, { max: 30 }).catch((err) => ({ request: requestRow(fx.home, second), error: err.message }));
    assert.ok(next.decision, `the second request proceeds to its proposal, not stuck (${next.request?.status}; ${next.error ?? ''})`);
    void decision;
  });

  test('M1: phase 1 open, a change touching only R3 (phase 2): touches_current false; approved, phase 1 keeps its plan generation and stages, and no replan replaces it', async (t) => {
    const { fx, p, ctx } = await journey35(t, { policy: { repair_attempts_max: 0 } });
    ctx.holdOpts = { answerKinds: OWNER_KINDS };
    // Stage 1's Builder fails and its work parks; stage 2 stays planned.
    fx.scripted.kindScript('stage_build', [script.crash(), builderScript(1), builderScript(2)]);
    await authoringReady(fx, ctx, 1);
    const plan1 = planOfPhase(fx.home, p.id, 1).find(active);
    await pumpHolding(fx, ctx, () => workOf(fx.home, p.id, 'stage_build').some((w) => w.status === 'parked'), { what: 'stage 1 parked', max: 40, ...ctx.holdOpts });
    const stagesBefore = stagesOfPlan(fx.home, plan1.id).map((s) => [s.number, s.status]);
    const id = await post(fx, p.id, SPEC_CHANGES.r3Statement, [{ key: 'R3', kind: 'text_changed', reason: 'R3 sharpened' }], 'R3 sharpened.');
    const proposed = await untilProposedOrFailed(fx, ctx, id, ctx.holdOpts);
    assert.ok(proposed.decision, `the fixture is live: the change is proposed (${proposed.request.status})`);
    const impact = impactRecordOf(fx.home, id).value;
    assert.deepEqual(impact.phases ?? [], [2], 'the phase concerned is phase 2');
    assert.equal(impact.touches_current, false, 'a change to phase 2 alone does not touch phase 1, the current phase');
    assert.equal((await answer(fx.engine, p.id, proposed.decision, 'approve')).status, 200, 'the owner approves it');
    await pumpHolding(fx, ctx, () => specRevisions(fx.home, p.id).find((r) => r.version === 2), { what: 'version 2', max: 20, ...ctx.holdOpts });
    await pumpHolding(fx, ctx, () => false, { max: 8, ...ctx.holdOpts }).catch(() => null);
    const plans1 = planOfPhase(fx.home, p.id, 1);
    assert.deepEqual(plans1.filter(active).map((x) => [x.id, x.generation]), [[plan1.id, plan1.generation]], 'phase 1 keeps its active plan and generation');
    assert.deepEqual(stagesOfPlan(fx.home, plan1.id).map((s) => [s.number, s.status]).filter(([, st]) => st === 'cancelled'), [], `none of phase 1's stages is superseded (before ${JSON.stringify(stagesBefore)})`);
    const replans = workOf(fx.home, p.id, 'replan').filter((w) => w.trigger_source === 'spec_change');
    for (const w of replans) assert.notEqual(w.subject?.phase_plan, plan1.id, `the change's replan is not an early replacement of phase 1 (${JSON.stringify(w.subject)})`);
  });
});
