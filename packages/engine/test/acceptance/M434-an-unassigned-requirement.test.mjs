// M434 and M433 (d)'s "not otherwise" (slice 36; kernel lane). M5 plan §3.6
// M434, M433; D6-C06, D6-C05; D6 §4.5 ("an added requirement with no phase
// blocks the `phase` gate of every later phase (`REQUIREMENT_UNASSIGNED`)
// until a roadmap revision places it"), §4.7, §5.1; reading 6 ("only an
// approved, complete roadmap revision that assigns it clears the reason,
// never a row update"); A.4; SEAM.md §§424; the driver's rulings Q8 to Q11
// (2026-10-13).
//
// Phase 2 at rest (`phaseTwoAtRest`); a change adds R5 (index hint 2) and is
// approved; the replan it registers is held at first:
// (a) phase 2's gate carries `REQUIREMENT_UNASSIGNED` naming R5;
// (b) `GET …/spec` and `GET …/plan` show R5 pending with no phase, never
//     dropped (Q9);
// (c) a direct update of R5's `assigned_phase` is refused by a trigger and
//     clears nothing (Q11); the replan's roadmap that places R5 but leaves R4
//     out is refused by the roadmap check naming R4; its repair's complete
//     roadmap placing R5 in a new phase 3 (`moved_requirements` with `from`
//     null, Q10) routes to the owner and, approved, is published:
//     `baseline.roadmap_revised` with `moved_requirements` naming R5, R5 in
//     phase 3, the reason cleared;
// then M433 (d) "and not otherwise": a change rewording R1.1 alone (phase 1
//     complete) registers `check_correction` and no `replan`.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer } from './harness/decisions.mjs';
import { evaluate } from './harness/gates.mjs';
import { script } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { ROUTED_KINDS, eventsAbout, requirementsOf, roadmapRevisions, specRevisions, workOf } from './harness/journey/drive.mjs';
import { nextReplanOutcome, outcomes, phaseOf, replan35, roadmapWith } from './harness/journey/plan35.mjs';
import { REQUIREMENTS, specText } from './harness/journey/reference.mjs';
import { R5, changeScript, holding, launchHolding, phaseTwoAtRest, pumpHolding, untilProposedOrFailed } from './harness/journey/change36.mjs';

const ROADMAP = '.surety/roadmap/roadmap.json';
const PHASE_3 = { number: 3, goal: 'count the refusals', modules: ['service'], requirement_ids: ['R5'], depends_on: [2] };
const WITH_R5 = specText({ version: 2, requirements: [...REQUIREMENTS, R5], changeLog: [{ version: 2, date: '2026-10-13', change: 'R5 added', by: 'Sean' }] });
const R1_V3 = specText({
  version: 3,
  requirements: [...REQUIREMENTS.map((r) => (r.key === 'R1' ? { ...r, criteria: [{ id: 'R1.1', text: 'Given the numbers 2 and 3, when `sum(2, 3)` of `src/sum.mjs` is called, then it returns the number 5.' }] } : r)), R5],
  changeLog: [
    { version: 2, date: '2026-10-13', change: 'R5 added', by: 'Sean' },
    { version: 3, date: '2026-10-13', change: 'R1.1 names the type', by: 'Sean' },
  ],
});

async function approvedChange(fx, ctx, spec, changes, version) {
  fx.scripted.kindScript('spec_change', changeScript(spec, changes));
  const res = await fx.engine.post(`/v1/projects/${ctx.project}/spec/change-requests`, { text: 'The owner\'s change.' });
  assert.equal(res.status, 201, `POST …/spec/change-requests (→ ${res.status} ${res.text})`);
  const out = await untilProposedOrFailed(fx, ctx, res.body.request.id);
  assert.ok(out.decision, `the change is proposed (${out.request.status} ${out.request.failure ?? ''})`);
  assert.equal((await answer(fx.engine, ctx.project, out.decision, 'approve')).status, 200, 'the owner approves it');
  await pumpHolding(fx, ctx, () => specRevisions(fx.home, ctx.project).find((r) => r.version === version), { what: `version ${version}`, max: 20 });
  return out.request;
}

const unassigned = (evaluation) => evaluation.reasons.filter((r) => r.code === 'REQUIREMENT_UNASSIGNED');
const r5Of = (home, project) => requirementsOf(home, project).find((r) => r.key === 'R5');

describe('M434 an unassigned requirement', () => {
  test('(a) REQUIREMENT_UNASSIGNED on the later phase gate; (b) shown pending; (c) a row update refused, an incomplete revision refused, the approved complete revision clears it; M433 (d) a change touching only a completed phase registers no replan', async (t) => {
    const { fx, p, ctx, plan2, candidate3 } = await phaseTwoAtRest(t, { policy: { repair_attempts_max: 1 } });
    // The replan the change registers: held, then the incomplete roadmap, then (its repair) the complete one.
    // A kind array is indexed by every launch of the kind (SEAM §350; objection 089): padded by phase 1's.
    const earlier = fx.scripted.launches({ work_kind: 'replan' }).length;
    fx.scripted.kindScript('replan', [
      ...Array.from({ length: earlier }, () => script.complete()),
      { steps: [{ hold: 'gate', heartbeat_ms: 250 }, ...replan35({ spec_version: 2, roadmap_version: 2, files: { [ROADMAP]: roadmapWith({ phases: [phaseOf(1), { ...phaseOf(2), requirement_ids: ['R3'] }, PHASE_3] }) }, result: { roadmap_revision: true } }).steps] },
      replan35({ spec_version: 2, roadmap_version: 2, files: { [ROADMAP]: { ...roadmapWith({ phases: [phaseOf(1), phaseOf(2), PHASE_3] }), moved_requirements: [{ key: 'R5', from: null, to: 3 }] } }, result: { roadmap_revision: true } }),
    ]);
    await approvedChange(fx, ctx, WITH_R5, [{ key: 'R5', kind: 'added', reason: 'R5 counts refusals' }], 2);
    assert.equal(r5Of(fx.home, p.id)?.assigned_phase, null, 'R5 added has no phase after the approval, whatever its index hint (D6 §4.5; Q8)');
    await pumpHolding(fx, ctx, () => launchHolding(fx, 'replan'), { what: 'the replan held', max: 20 });
    // (a)
    const gate = async () => {
      const res = await fx.engine.post(`/v1/projects/${p.id}/candidates/${candidate3.id}/gates/phase`, { phase_plan: plan2.id });
      assert.equal(res.status, 200, `the phase gate evaluates (→ ${res.status} ${res.text})`);
      return res.body.evaluation;
    };
    let evaluation = await gate();
    assert.ok(unassigned(evaluation).some((r) => JSON.stringify(r.subjects ?? []).includes('R5')), `REQUIREMENT_UNASSIGNED names R5 on phase 2's gate (${JSON.stringify(evaluation.reasons)})`);
    // (b)
    const spec = await fx.engine.get(`/v1/projects/${p.id}/spec`);
    assert.equal(spec.status, 200);
    const inSpec = (spec.body.requirements ?? []).find((r) => r.key === 'R5');
    assert.ok(inSpec, 'the spec read shows R5');
    assert.deepEqual([inSpec.assigned_phase, inSpec.status], [null, 'pending'], 'pending, with no phase');
    const plan = await fx.engine.get(`/v1/projects/${p.id}/plan`);
    assert.equal(plan.status, 200);
    const inPlan = (plan.body.requirements ?? []).find((r) => r.key === 'R5');
    assert.ok(inPlan, 'the plan read shows R5, never dropped');
    assert.deepEqual([inPlan.assigned_phase, inPlan.status], [null, 'pending'], 'pending, with no phase');
    // (c) a direct row update.
    let refused = null;
    try {
      withStore(fx.home, (db) => db.prepare(`UPDATE "requirements" SET "assigned_phase" = 2 WHERE "project" = ? AND "key" = 'R5'`).run(p.id), { readonly: false });
    } catch (err) {
      refused = err;
    }
    assert.ok(refused, 'a direct update of assigned_phase is refused by the store\'s trigger (Q11)');
    assert.equal(r5Of(fx.home, p.id).assigned_phase, null, 'R5 still has no phase');
    evaluation = await gate();
    assert.ok(unassigned(evaluation).length > 0, 'and the reason stands');
    // The incomplete revision, refused; its repair, complete, routed and approved.
    fx.scripted.release('all', 'gate');
    const seen = outcomes([plan2.id]);
    const incomplete = await nextReplanOutcome(fx, ctx, 2, seen);
    assert.ok(incomplete.failed, `the roadmap that leaves R4 out is refused (${JSON.stringify(Object.keys(incomplete))})`);
    assert.deepEqual([incomplete.failed.outcome, incomplete.failed.reason_class], ['failed', 'invalid_result']);
    assert.match(incomplete.failed.reason_text ?? '', /R4/, `naming R4 (${incomplete.failed.reason_text})`);
    assert.deepEqual(roadmapRevisions(fx.home, p.id).map((r) => r.version), [1], 'no roadmap revision from it');
    const complete = await nextReplanOutcome(fx, ctx, 2, seen);
    assert.ok(complete.approval, `the complete revision placing R5 routes to the owner (${JSON.stringify(complete.failed ? [complete.failed.reason_class, complete.failed.reason_text] : Object.keys(complete))})`);
    assert.equal((await answer(fx.engine, p.id, complete.approval, 'approve')).status, 200, 'the owner approves it');
    await pumpHolding(fx, ctx, () => roadmapRevisions(fx.home, p.id).find((r) => r.version === 2), { what: 'roadmap version 2 published', max: 20, answerKinds: ROUTED_KINDS.filter((k) => k !== 'plan_approval') });
    const revised = eventsAbout(fx.home, 'baseline.roadmap_revised', p.id).at(-1);
    assert.ok(JSON.stringify(revised?.payload?.moved_requirements ?? null).includes('R5'), `baseline.roadmap_revised records the move of R5 (${JSON.stringify(revised?.payload)})`);
    assert.equal(r5Of(fx.home, p.id).assigned_phase, 3, 'R5 is in phase 3');
    const active = withStore(fx.home, (db) => db.prepare('SELECT * FROM "phase_plans" WHERE "project" = ? AND "phase_number" = 2 AND "active" = 1').get(p.id));
    const after = await fx.engine.post(`/v1/projects/${p.id}/candidates/${candidate3.id}/gates/phase`, { phase_plan: active.id });
    assert.equal(after.status, 200);
    assert.deepEqual(unassigned(after.body.evaluation), [], `the reason is cleared (${JSON.stringify(after.body.evaluation.reasons)})`);
    // M433 (d): a change touching only phase 1, complete, registers no replan.
    const replansBefore = workOf(fx.home, p.id, 'replan').length;
    fx.scripted.kindScript('check_correction', holding());
    const request = await approvedChange(fx, ctx, R1_V3, [{ key: 'R1', kind: 'criteria_changed', reason: 'R1.1 names the type' }], 3);
    const corrections = workOf(fx.home, p.id, 'check_correction').filter((w) => JSON.stringify(w).includes(request.id));
    assert.equal(corrections.length, 1, 'check_correction registered for R1.1\'s checks');
    assert.equal(workOf(fx.home, p.id, 'replan').length, replansBefore, 'no replan: the change touches neither the current phase nor a later one');
    void evaluate;
  });
});
