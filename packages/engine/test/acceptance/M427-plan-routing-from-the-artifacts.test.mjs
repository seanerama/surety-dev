// M427, plan routing from the artifacts (slice 35; kernel lane). M5 plan §3.5
// M427 (a) to (e); D6-P05; D6 §5.4; F §3.10.6; B03; the driver's rulings of
// 2026-10-13 ((d) the next generation of the same trigger with the note; (e)
// the refusal names the change-request route, `needs_spec_change` recorded,
// no request created); SEAM.md §§406, 407, 410.
//
// One journey to phase 1's completion (Tally's `phase_size` {2, 5}); the
// replan's launches scripted in turn, each declaring `within_baseline` with
// an empty `adrs_changed`:
//   (b) each change of the baseline: phase 2's goal; an ADR added; ADR-001
//       altered; ADR-001 deleted; R4 moved to an added phase 3; a module's
//       sensitivity; a phase dependency; the architecture text. Each:
//       `plan_approval` with the plan check's diff holding the changed
//       artifact, approved and proposed; the declarations recorded beside a
//       routing of `human`; nothing published until an answer;
//   (d) each rejected with a note: the replan's next generation of the same
//       trigger, the note in its package;
//   (c) `uncertain` with no change: `plan_approval`;
//   (e) an `implements` key the spec lacks: refused, the text naming
//       `PLAN_UNKNOWN_REQUIREMENT R9` and `POST …/spec/change-requests`,
//       `needs_spec_change`, no change request, no `plan_approval`;
//   (a) last, a plan changing nothing of the baseline: published with
//       `approved_by` `engine:plan_check`, no decision, `changes_*` empty.
// (e)'s `requirement_conflict` and (f) are in
// `M427-a-requirement-conflict-and-a-rebased-reroute.test.mjs`.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { changeRequests, planOfPhase, runsOfProject, workOf } from './harness/journey/drive.mjs';
import { afterRefusal, checkOfApproval, diffText, journey35, nextReplanOutcome, openPlanApprovals, phaseOf, planCheckRows, rejectWithNote, replan35, roadmapWith, outcomes, stagesWith, unpublished, phaseCompleteNoPlanAnswer } from './harness/journey/plan35.mjs';
import { ADR_001, ADR_001_REVISED, ADR_KEY, ARCHITECTURE_MD, MODULES_JSON, T2_KINDS, adrText } from './harness/journey/reference.mjs';
import { packageOf } from './harness/sessions.mjs';
import { withStore } from './harness/store.mjs';

const ADR_PATH = `.surety/adrs/${ADR_KEY}.md`;
const ADR_2_PATH = '.surety/adrs/ADR-002.md';
const ROADMAP = '.surety/roadmap/roadmap.json';
const MODULES = '.surety/architecture/modules.json';
const ARCHITECTURE = '.surety/architecture/architecture.md';
const DUMP = [{ probe: { action: 'context_dump' } }];
const NEW_GOAL = 'count the sums, then show them on /stats';
const ARCH_EDIT = '\nThe service logs every request to standard error.\n';
const ADR_2 = adrText({ key: 'ADR-002', decision: 'Every answer is JSON.' });
const noAdrs = stagesWith(2, { 3: { adrs: [] }, 4: { adrs: [] } });
const sensitiveStages = stagesWith(2, { 4: { validation: { sensitive_areas: ['secrets_credentials'], kinds: [...T2_KINDS, 'sensitivity_floor'] } } });

// The baseline-changing variants of (b): {what, script, diff: [texts the diff holds], changed(check)}.
const VARIANTS = [
  {
    what: 'an ADR added',
    script: replan35({ architecture_version: 2, before: DUMP, files: { [ADR_2_PATH]: ADR_2 } }),
    diff: ['Every answer is JSON.'],
    changed: (c) => (c.changes_adrs?.added ?? []).includes('ADR-002'),
  },
  {
    what: 'ADR-001 altered',
    script: replan35({ architecture_version: 2, before: DUMP, files: { [ADR_PATH]: ADR_001_REVISED } }),
    diff: ['content type application/json', 'no dependency.'],
    changed: (c) => (c.changes_adrs?.changed ?? []).includes(ADR_KEY),
  },
  {
    what: 'ADR-001 deleted',
    script: replan35({ architecture_version: 2, before: DUMP, stages: noAdrs, files: { [ADR_PATH]: null } }),
    diff: [ADR_001.split('\n').find((l) => l.startsWith('The service uses'))],
    changed: (c) => (c.changes_adrs?.deleted ?? []).includes(ADR_KEY),
  },
  {
    what: 'a module\'s sensitivity changed',
    script: replan35({ architecture_version: 2, before: DUMP, stages: sensitiveStages, files: { [MODULES]: { ...MODULES_JSON, modules: MODULES_JSON.modules.map((m) => (m.name === 'service' ? { ...m, sensitive_areas: ['secrets_credentials'] } : m)) } } }),
    diff: ['secrets_credentials'],
    changed: (c) => c.changes_architecture?.changed === true && JSON.stringify(c.changes_architecture.subjects).includes('modules'),
  },
  {
    what: 'the architecture text edited',
    script: replan35({ architecture_version: 2, before: DUMP, files: { [ARCHITECTURE]: ARCHITECTURE_MD + ARCH_EDIT } }),
    diff: ['logs every request to standard error', 'Two modules'],
    changed: (c) => c.changes_architecture?.changed === true && JSON.stringify(c.changes_architecture.subjects).includes('architecture'),
  },
  {
    what: 'phase 2\'s goal changed',
    script: replan35({ roadmap_version: 2, before: DUMP, files: { [ROADMAP]: roadmapWith({ phases: [phaseOf(1), { ...phaseOf(2), goal: NEW_GOAL }] }) } }),
    diff: [NEW_GOAL, 'count the sums and show the stats'],
    changed: (c) => (c.changes_roadmap?.goals ?? []).length > 0,
  },
  {
    what: 'R4 moved to an added phase 3',
    script: replan35({
      roadmap_version: 2,
      before: DUMP,
      stages: [stagesWith(2, {})[0]],
      files: { [ROADMAP]: roadmapWith({ phases: [phaseOf(1), { ...phaseOf(2), requirement_ids: ['R3'] }, { number: 3, goal: 'show the stats', modules: ['service'], requirement_ids: ['R4'], depends_on: [2] }] }) },
    }),
    diff: ['show the stats'],
    changed: (c) => JSON.stringify(c.changes_roadmap?.assignments ?? []).includes('R4') && JSON.stringify(c.changes_roadmap?.phases_added ?? []).includes('3'),
  },
  {
    what: 'a phase dependency changed',
    script: replan35({ roadmap_version: 2, before: DUMP, files: { [ROADMAP]: roadmapWith({ phases: [phaseOf(1), { ...phaseOf(2), depends_on: [] }] }) } }),
    diff: ['depends_on'],
    changed: (c) => (c.changes_roadmap?.dependencies ?? []).length > 0,
  },
];

describe('M427 plan routing from the artifacts', () => {
  test('(b) every baseline change routes to the owner whatever the declarations; (d) a rejection is the next generation with the note; (c) uncertain routes; (e) an unknown requirement is refused toward a spec change; (a) an unchanged plan publishes by engine:plan_check', async (t) => {
    const { fx, p, ctx } = await journey35(t, { policy: { repair_attempts_max: 3 } });
    const R9 = stagesWith(2, { 3: { implements: ['R3', 'R9'] } });
    fx.scripted.kindScript('replan', [
      ...VARIANTS.map((v) => v.script),
      replan35({ before: DUMP, conformance: 'uncertain' }),
      replan35({ before: DUMP, stages: R9 }),
      replan35({ before: DUMP }),
    ]);
    const seen = outcomes();
    await phaseCompleteNoPlanAnswer(fx, ctx, 1);
    // (d) after a rejection: the next generation of the rejected item's trigger, its run's package holding the note.
    let rejected = null;
    const assertNextGeneration = (what) => {
      if (!rejected) return;
      const { item, note } = rejected;
      const next = workOf(fx.home, p.id, 'replan').find((w) => w.trigger_source === item.trigger_source && w.trigger_id === item.trigger_id && w.trigger_generation === item.trigger_generation + 1);
      assert.ok(next, `${what}: the rejection made the next generation of the same trigger (${item.trigger_source}, ${item.trigger_id}, ${item.trigger_generation + 1}) (${JSON.stringify(workOf(fx.home, p.id, 'replan').map((w) => [w.trigger_source, w.trigger_id, w.trigger_generation]))})`);
      const run = runsOfProject(fx.home, p.id).find((r) => r.work_item === next.id);
      const pkg = run ? packageOf(fx, run.id) : null;
      assert.ok(pkg && Object.values(pkg).some((x) => typeof x === 'string' && x.includes(note)), `${what}: the note is in the next generation's package (files: ${pkg ? Object.keys(pkg).join(', ') : 'none'})`);
    };
    // The replan item whose run the approval is about (the decision's subject, or the bundle's run).
    const itemOf = (approval) => {
      const bundleRun = withStore(fx.home, (db) => db.prepare('SELECT "run" FROM "plan_bundles" WHERE "id" = ?').get(checkOfApproval(fx.home, p.id, approval)?.bundle ?? '')?.run ?? null);
      const run = runsOfProject(fx.home, p.id).find((r) => r.id === approval.subject_id || r.id === bundleRun) ?? null;
      const items = workOf(fx.home, p.id, 'replan');
      return items.find((w) => w.id === run?.work_item) ?? items.at(-1);
    };
    for (const [i, v] of VARIANTS.entries()) {
      const out = await nextReplanOutcome(fx, ctx, 2, seen);
      assert.ok(out.approval, `${v.what}: plan_approval raised (${JSON.stringify(out.failed ? [out.failed.reason_class, out.failed.reason_text] : Object.keys(out))})`);
      assertNextGeneration(v.what);
      const check = checkOfApproval(fx.home, p.id, out.approval);
      assert.equal(check.outcome, 'passed', `${v.what}: the check passed (${JSON.stringify(check.reasons)})`);
      assert.equal(check.routing, 'human', `${v.what}: routed to the owner`);
      assert.ok(v.changed(check), `${v.what}: the check records the change (${JSON.stringify({ a: check.changes_architecture, d: check.changes_adrs, r: check.changes_roadmap })})`);
      assert.deepEqual([check.declared?.conformance, check.declared?.adrs_changed], ['within_baseline', []], `${v.what}: the declarations recorded as declared, and overridden (SEAM.md §407) (${JSON.stringify(check.declared)})`);
      const diff = diffText(fx.home, check);
      for (const x of v.diff) assert.ok(diff?.includes(x), `${v.what}: the diff holds "${x}" (${diff?.slice(0, 300)})`);
      assert.deepEqual(unpublished(fx.home, p.id, 2), { plans: 0, architecture: [1], roadmap: [1] }, `${v.what}: nothing published before an answer`);
      const note = `Variant ${i + 1} rejected: keep the baseline (${v.what}).`;
      rejected = { item: itemOf(out.approval), note };
      const res = await rejectWithNote(fx, p.id, out.approval, note);
      assert.equal(res.status, 200, `${v.what}: the owner rejects (→ ${res.status} ${res.text})`);
    }
    // (c) uncertain with no change.
    const uncertain = await nextReplanOutcome(fx, ctx, 2, seen);
    assert.ok(uncertain.approval, `uncertain with no change: plan_approval (${JSON.stringify(uncertain.failed ? [uncertain.failed.reason_class, uncertain.failed.reason_text] : Object.keys(uncertain))})`);
    assertNextGeneration('uncertain');
    const uc = checkOfApproval(fx.home, p.id, uncertain.approval);
    assert.deepEqual([uc.outcome, uc.routing, uc.declared?.conformance], ['passed', 'human', 'uncertain'], 'passed, routed by the declaration alone');
    assert.equal(uc.changes_architecture?.changed, false, 'no detected change');
    rejected = { item: itemOf(uncertain.approval), note: 'Rejected: plan it within the baseline.' };
    assert.equal((await rejectWithNote(fx, p.id, uncertain.approval, rejected.note)).status, 200);
    // (e) an implements key the spec lacks.
    const unknown = await nextReplanOutcome(fx, ctx, 2, seen);
    assert.ok(unknown.failed, `R9 is refused, never routed (${JSON.stringify(Object.keys(unknown))})`);
    assert.deepEqual([unknown.failed.outcome, unknown.failed.reason_class], ['failed', 'invalid_result']);
    assert.match(unknown.failed.reason_text ?? '', /PLAN_UNKNOWN_REQUIREMENT[^\n]*R9/, `naming PLAN_UNKNOWN_REQUIREMENT R9 (${unknown.failed.reason_text})`);
    assert.match(unknown.failed.reason_text ?? '', /POST [^\n]*\/spec\/change-requests/, `offering the spec-change route (the driver's ruling) (${unknown.failed.reason_text})`);
    const unknownCheck = planCheckRows(fx.home, p.id).filter((c) => c.outcome === 'refused' && JSON.stringify(c.reasons).includes('R9')).at(-1);
    assert.ok(unknownCheck, 'a refused plan check records it');
    assert.equal(Number(unknownCheck.needs_spec_change), 1, 'needs_spec_change recorded');
    assert.deepEqual(changeRequests(fx.home, p.id), [], 'no change request created');
    assert.deepEqual(openPlanApprovals(fx.home, p.id), [], 'no plan_approval for it');
    await afterRefusal(fx, ctx, unknown.failed);
    // (a) the repair (or the owner's retry): a plan changing nothing of the baseline.
    const unchanged = await nextReplanOutcome(fx, ctx, 2, seen);
    assert.ok(unchanged.published, `an unchanged plan is published without a decision (${JSON.stringify(unchanged.failed ? [unchanged.failed.reason_class, unchanged.failed.reason_text] : Object.keys(unchanged))})`);
    assert.deepEqual([unchanged.published.approved_by, unchanged.published.routing], ['engine:plan_check', 'registered']);
    const ac = planCheckRows(fx.home, p.id).find((c) => c.id === unchanged.published.check) ?? planCheckRows(fx.home, p.id).at(-1);
    assert.equal(ac.changes_architecture?.changed, false, 'no architecture change');
    assert.deepEqual(Object.values(ac.changes_adrs ?? {}).flat(), [], 'no ADR change');
    assert.deepEqual(Object.values(ac.changes_roadmap ?? {}).flat(), [], 'no roadmap change');
    assert.deepEqual(openPlanApprovals(fx.home, p.id), [], 'no decision');
    assert.deepEqual(unpublished(fx.home, p.id, 2), { plans: 1, architecture: [1], roadmap: [1] }, 'the baseline unchanged');
    void planOfPhase;
  });
});
