// M508, the plan check's design clauses (slice 44; kernel lane). M6 plan
// §3.6 M508; D7 §4.1, §8.1, §8.3; G2, G6; SEAM.md §§495, 512, 513.
//
// (a) under `design` other than `off`, a UI-consumed interface without
//     `request`, `response` or `errors`: ARCH_INTERFACE_SHAPE_MISSING naming
//     it, told to the Architect's session before close (the save) and
//     refusing the close; under `off` the same map publishes;
// (b) a plan naming a `screens` key the approved design lacks:
//     PLAN_SCREEN_UNKNOWN naming it;
// (c) with an approved design, a UI stage implementing a UI requirement no
//     approved screen of a target it serves covers: PLAN_DESIGN_UNCOVERED
//     naming the requirement and the target, per target;
// (d) the first plan, before any design: published, a planned design
//     obligation recorded per UI stage, carried by M507's hold;
// (e) the replan refused PLAN_DESIGN_UNCOVERED and its repair refused
//     likewise: the blocker offers `design` beside `retry`, `replan`,
//     `cancel`;
// (f) `stage_screens` computed and recorded at the design's approval and at
//     each publication; a plan naming `screens` verified against the design.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { decisionsOfKind } from './harness/decisions.mjs';
import { phaseCompleted, planChecks, planOfPhase, pump, runsOfProject, workOf } from './harness/journey/drive.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { closeSession, transcriptEntries } from './harness/sessions.mjs';
import { INTERFACES, MODULES_JSON } from './harness/design/reference.mjs';
import { assertNoSilentHold, createPantry, pantryArchitect, pantrySpec, stageRow, stageWork, toPublished } from './harness/design/drive.mjs';
import { BEFORE_BUILD, approveBatch, latestPlanCheck, planSubjects } from './harness/design/check41.mjs';
import { PHASE_TWO_STAGES, TWO_PHASE, currentRevision, currentRoadmap, designedPantry, replanWith, stageIdsOf, stageScreens } from './harness/design/plan44.mjs';

const OFF = Object.freeze({ autonomy: 'phase', phase_size: { min: 1, max: 5 } });
const clone = (v) => structuredClone(v);

// Pantry's map with list-items lacking `request` and `response`, and add-item lacking `errors`.
function shapelessMap() {
  const m = clone(MODULES_JSON);
  const api = m.modules.find((x) => x.name === 'api');
  api.interfaces = [
    (({ request, response, ...rest }) => rest)(clone(INTERFACES.list)),
    (({ errors, ...rest }) => rest)(clone(INTERFACES.add)),
    clone(INTERFACES.health),
  ];
  return m;
}

// The plan_checks row as stored, its JSON columns parsed.
const planCheckRows = (fx, project) => planChecks(fx.home, project);
const designObligationsOf = (check) => {
  const v = check?.design_obligations;
  return typeof v === 'string' ? JSON.parse(v) : (v ?? null);
};

// Pantry in two phases, designed and approved during phase 1, carried to
// phase 1's completion with the replan scripted `replans(roadmap_version)`
// (one per launch), prepared against the roadmap as the design's approval
// left it (the engine's placing of the human tests, SEAM.md §486).
async function twoPhaseToReplan(t, name, replans) {
  const fx = await scriptedEngine(t);
  const d = await designedPantry(fx, { name, variant: TWO_PHASE });
  fx.scripted.kindScript('replan', replans(currentRoadmap(fx.home, d.p.id).version));
  await phaseCompleted(fx, d.ctx, 1, { max: 200 });
  return { fx, ...d };
}

describe('M508 the plan check\'s design clauses', () => {
  test('(a) a UI-consumed interface without request, response or errors under before_build: ARCH_INTERFACE_SHAPE_MISSING naming each, told at the save and refusing the close; under off the map publishes', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createPantry(fx, { policy: BEFORE_BUILD, name: 'pantry-shapes' });
    await pantrySpec(fx, p.id);
    const arch = await pantryArchitect(fx, p.id, p.repo, { answer: 'none', files: { modules: shapelessMap() } });
    // Told to the session before close: the save's findings or the next engine entry name it (D7 §4.1).
    const told = `${JSON.stringify(arch.saved?.findings ?? [])}\n${transcriptEntries(fx.home, arch.run.id).filter((e) => e.speaker === 'engine').map((e) => e.text ?? '').join('\n')}`;
    for (const i of ['list-items', 'add-item']) assert.ok(told.includes('ARCH_INTERFACE_SHAPE_MISSING') && told.includes(i), `the Architect's session is told ARCH_INTERFACE_SHAPE_MISSING naming ${i} before close (${told.slice(0, 800)})`);
    assert.equal(arch.closeRes.status, 422, `the close is refused (→ ${arch.closeRes.status} ${arch.closeRes.text?.slice(0, 600)})`);
    assert.equal(arch.closeRes.body?.code, 'plan_refused', 'plan_refused');
    const check = latestPlanCheck(fx.home, p.id);
    assert.equal(check?.outcome, 'refused', `the plan check refused (${JSON.stringify(check?.reasons)})`);
    assert.deepEqual(planSubjects(check, 'ARCH_INTERFACE_SHAPE_MISSING').sort(), ['api:add-item', 'api:list-items'], `ARCH_INTERFACE_SHAPE_MISSING naming <module>:<interface> for each (SEAM.md §495) (${JSON.stringify(check?.reasons)})`);
    assert.ok(!planSubjects(check, 'ARCH_INTERFACE_SHAPE_MISSING').some((s) => s.includes('health')), 'health, consumed by no ui module, is not named');
    await closeSession(fx, p.id, arch.run.id, { refuse: true });
    // Under off: the shapes are optional, the same map publishes.
    const { p: q } = await toPublished(fx, { policy: OFF, name: 'pantry-shapes-off', files: { modules: shapelessMap() } });
    const off = latestPlanCheck(fx.home, q.id);
    assert.equal(off?.outcome, 'passed', `under off the plan check passes (${JSON.stringify(off?.reasons)})`);
    assert.ok(planOfPhase(fx.home, q.id, 1).some((x) => x.published_at), 'and phase 1 is published');
  });

  test('(d) the first plan, before any design: published, a planned design obligation per UI stage carried by the hold; (f) stage_screens computed at the design\'s approval', async (t) => {
    const fx = await scriptedEngine(t);
    const d = await designedPantry(fx, { name: 'pantry-first-plan', approve: false });
    const { p } = d;
    const plan = planOfPhase(fx.home, p.id, 1).find((x) => x.published_at);
    assert.ok(plan, 'the first plan is published though no design exists (D7 §8.1: no Architect re-entry)');
    const check = planCheckRows(fx, p.id).filter((c) => c.outcome === 'passed').at(-1);
    const obligations = designObligationsOf(check);
    assert.ok(Array.isArray(obligations), `the passed plan check records its planned design obligations (SEAM.md §513) (${JSON.stringify(check)?.slice(0, 600)})`);
    assert.deepEqual(obligations.map((o) => [o.stage, [...(o.targets ?? [])].sort()]).sort(), [[2, ['web']], [3, ['android']]], `one per UI stage with its targets, none for the API stage (${JSON.stringify(obligations)})`);
    // Carried by M507's hold: the UI stages' work depends on design_ready and is held design_pending.
    await pump(fx, d.ctx, () => (stageRow(fx.home, p.id, 1)?.status === 'verified' ? true : undefined), { what: 'the API stage verified', max: 80 });
    for (const n of [2, 3]) {
      const w = stageWork(fx.home, p.id, n);
      assert.ok((w.depends_on ?? []).some((x) => x.milestone === 'design_ready'), `stage ${n} carries the obligation as its design_ready milestone (${JSON.stringify(w.depends_on)})`);
      assert.equal(w.held, 'design_pending', `stage ${n} held design_pending`);
    }
    assertNoSilentHold(fx.home, p.id, '(d)');
    // (f) at the design's approval: each UI stage bound to the approved screens of its targets.
    await approveBatch(fx, d.ctx, d.batch);
    const rev = currentRevision(fx.home, p.id);
    const [s2, s3] = stageIdsOf(fx.home, p.id, [2, 3]);
    const bound = stageScreens(fx.home, p.id).filter((b) => b.design_revision === rev.id);
    assert.deepEqual(bound.map((b) => [b.stage, b.screen, b.target]).sort(), [[s2, 'S1', 'web'], [s3, 'S2', 'android']].sort(), `stage_screens at the approval: stage 2 S1 (web), stage 3 S2 (android) (${JSON.stringify(bound)})`);
    assertNoSilentHold(fx.home, p.id, '(f)');
  });

  test('(c) with an approved design, R4 given to the Android and web UI stages: PLAN_DESIGN_UNCOVERED naming R4 and each target; (e) refused again at the repair: the blocker offers design beside retry, replan and cancel', async (t) => {
    const uncovered = (roadmap_version) => replanWith({ roadmap_version, stages: [{ ...PHASE_TWO_STAGES.android, implements: ['R3', 'R4'], validation: { ...PHASE_TWO_STAGES.android.validation, criteria: ['R3.1', 'R4.1'] } }, PHASE_TWO_STAGES.countWeb] });
    const { fx, p, ctx } = await twoPhaseToReplan(t, 'pantry-uncovered', (rv) => [uncovered(rv), uncovered(rv), uncovered(rv)]);
    const item = await pump(fx, ctx, () => workOf(fx.home, p.id, 'replan').find((w) => w.trigger_source !== 'spec_change'), { what: 'phase 2\'s replan', max: 20 });
    const blocker = await pump(fx, ctx, () => decisionsOfKind(fx.home, p.id, 'blocker').find((d) => d.status === 'open' && d.subject_id === item.id), { what: 'the replan\'s blocker', max: 40 });
    const refused = planCheckRows(fx, p.id).filter((c) => c.outcome === 'refused' && (c.reasons ?? []).some((r) => r.code === 'PLAN_DESIGN_UNCOVERED'));
    assert.ok(refused.length >= 2, `the replan and its repair each refused PLAN_DESIGN_UNCOVERED (${refused.length}; runs ${JSON.stringify(runsOfProject(fx.home, p.id).filter((r) => r.work_item === item.id).map((r) => [r.outcome, r.reason_class, r.reason_text]))})`);
    const subjects = planSubjects(refused.at(-1), 'PLAN_DESIGN_UNCOVERED').map(String);
    for (const target of ['android', 'web']) assert.ok(subjects.some((s) => s.includes('R4') && s.includes(target)), `PLAN_DESIGN_UNCOVERED naming R4 and ${target} (SEAM.md §513) (${JSON.stringify(subjects)})`);
    assert.ok(!subjects.some((s) => s.includes('R3')), `not R3, which S2 covers (${JSON.stringify(subjects)})`);
    const keys = (blocker.options ?? []).map((o) => o.key);
    for (const key of ['design', 'retry', 'replan', 'cancel']) assert.ok(keys.includes(key), `the blocker offers ${key} (D7 §8.3; A.2 BlockerOption) (${JSON.stringify(keys)})`);
    assert.equal(planOfPhase(fx.home, p.id, 2).some((x) => x.published_at), false, 'nothing of phase 2 published');
  });

  test('(b) a plan naming a screens key the approved design lacks: PLAN_SCREEN_UNKNOWN naming it; (f) the repaired plan naming S2 published, stage_screens recorded at its publication', async (t) => {
    const unknown = (roadmap_version) => replanWith({ roadmap_version, stages: [{ ...PHASE_TWO_STAGES.android, screens: ['S2', 'S9'] }, PHASE_TWO_STAGES.countApi] });
    const named = (roadmap_version) => replanWith({ roadmap_version, stages: [{ ...PHASE_TWO_STAGES.android, screens: ['S2'] }, PHASE_TWO_STAGES.countApi] });
    const { fx, p, ctx } = await twoPhaseToReplan(t, 'pantry-screens', (rv) => [unknown(rv), named(rv), named(rv)]);
    const published = await pump(fx, ctx, () => planOfPhase(fx.home, p.id, 2).find((x) => x.published_at), { what: 'phase 2 published after the repair', max: 60 });
    const refused = planCheckRows(fx, p.id).find((c) => c.outcome === 'refused' && (c.reasons ?? []).some((r) => r.code === 'PLAN_SCREEN_UNKNOWN'));
    assert.ok(refused, `the first plan refused PLAN_SCREEN_UNKNOWN (${JSON.stringify(planCheckRows(fx, p.id).map((c) => [c.outcome, c.reasons]))})`);
    const subjects = planSubjects(refused, 'PLAN_SCREEN_UNKNOWN').map(String);
    assert.ok(subjects.some((s) => s.includes('S9')) && !subjects.some((s) => /\bS2\b/.test(s)), `naming S9 and not S2 (${JSON.stringify(subjects)})`);
    const rev = currentRevision(fx.home, p.id);
    const [s3] = stageIdsOf(fx.home, p.id, [3], 2);
    const bound = stageScreens(fx.home, p.id).filter((b) => b.stage === s3);
    assert.deepEqual(bound.map((b) => [b.screen, b.target, b.design_revision]), [['S2', 'android', rev.id]], `stage_screens recorded at phase 2's publication: stage 3 to S2 of the approved revision (${JSON.stringify(bound)})`);
    const [s4] = stageIdsOf(fx.home, p.id, [4], 2);
    assert.deepEqual(stageScreens(fx.home, p.id).filter((b) => b.stage === s4), [], 'none for the API stage');
    assert.ok(published.id, 'published');
    assertNoSilentHold(fx.home, p.id, '(b)');
  });
});
