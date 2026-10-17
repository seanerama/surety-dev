// M524, the three axes (slice 41; kernel lane). M6 plan §3.3 M524; D7
// §4.1, §5.1, §5.6 clauses 4 and 6; Q7; G2; SEAM.md §§493, 495.
//
// (a) `**Targets:**` missing under `design` other than `off` with a `ui`
//     module: the plan check refuses SPEC_TARGETS_MISSING, routed to
//     change_spec; under `off`: no refusal, nothing assumed;
// (b) a module target the spec does not list: ARCH_TARGET_UNKNOWN; a spec
//     target no `ui` module serves: ARCH_TARGET_UNCOVERED;
// (c) every pair of the admissibility table, admitted and refused:
//     ARCH_TECHNOLOGY_TARGET_MISMATCH exactly for the refused pairs; `other`
//     admitted on each target and its preview capability never `native`;
// (d) a design target entry whose technology or capability differs from
//     the inventory's: DESIGN_AXIS_MISMATCH;
// (e) a cross-platform flow step with a screen on one target only:
//     DESIGN_TARGET_DIVERGENCE_UNSTATED; with a stated `difference`: passing.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { scriptedEngine } from './harness/runs.mjs';
import { closeSession } from './harness/sessions.mjs';
import { semanticsOf } from './harness/journey/spec34.mjs';
import { postCloseRaw } from './harness/session-lane.mjs';
import { INVENTORY_PATH, REQUIREMENTS, specText } from './harness/design/reference.mjs';
import { createPantry, gitText, inventoryOf, pantryArchitect, pantrySpec, toPublished } from './harness/design/drive.mjs';
import {
  ADMISSIBLE,
  BEFORE_BUILD,
  SIX_TARGETS_LINE,
  TARGETS,
  TECHNOLOGIES,
  assertPassed,
  assertReason,
  checkSession,
  designModel,
  latestPlanCheck,
  modulesWith,
  planSubjects,
  screenOf,
  scriptVariant,
  targetEntry,
  variantOf,
} from './harness/design/check41.mjs';

const UNMARKED = REQUIREMENTS.map(({ surface, ...r }) => r);
const SPEC_NO_TARGETS = specText({ requirements: UNMARKED, targets: null, crossPlatform: null });
const OFF = Object.freeze({ autonomy: 'phase', phase_size: { min: 1, max: 5 } });
const CLAUSE_5 = ['SPEC_TARGETS_MISSING', 'ARCH_TARGET_UNKNOWN', 'ARCH_TARGET_UNCOVERED', 'ARCH_TECHNOLOGY_TARGET_MISMATCH', 'ARCH_INTERFACE_SHAPE_MISSING'];

// A project at its approved spec (`text`) under `policy`.
async function atSpec(fx, { policy = BEFORE_BUILD, text, name }) {
  const p = await createPantry(fx, { policy, name });
  await pantrySpec(fx, p.id, { text });
  return p;
}
// One Architect session with `modules`, closed and left unanswered; a
// refused close is closed with --refuse. Returns {res, check}.
async function attempt(fx, p, modules) {
  const arch = await pantryArchitect(fx, p.id, p.repo, { answer: 'none', files: { modules } });
  const check = latestPlanCheck(fx.home, p.id);
  if (arch.closeRes.status !== 200) await closeSession(fx, p.id, arch.run.id, { refuse: true });
  return { res: arch.closeRes, check, arch };
}
const refusedFor = (out, code, what) => {
  assert.equal(out.res.status, 422, `${what}: the close is refused (→ ${out.res.status} ${out.res.text?.slice(0, 600)})`);
  assert.equal(out.res.body?.code, 'plan_refused', `${what}: plan_refused`);
  assert.ok(out.check?.outcome === 'refused' && (out.check.reasons ?? []).some((r) => r.code === code), `${what}: the refused plan check records ${code} (${JSON.stringify(out.check?.reasons)})`);
};

describe('M524 the three axes', () => {
  test('(a) no **Targets:** line with a ui module: SPEC_TARGETS_MISSING under before_build, routed to change_spec; under off nothing refused and nothing assumed', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await atSpec(fx, { text: SPEC_NO_TARGETS, name: 'pantry-untargeted' });
    const out = await attempt(fx, p, undefined);
    refusedFor(out, 'SPEC_TARGETS_MISSING', 'design before_build');
    assert.deepEqual(planSubjects(out.check, 'SPEC_TARGETS_MISSING'), ['mobile', 'web'], 'naming the ui modules (SEAM.md §495)');
    assert.match(JSON.stringify(out.res.body), /change_spec|spec\/change-requests/, `routed to change_spec (SEAM.md §495) (${out.res.text?.slice(0, 600)})`);
    // Under off: the same specification and map publish.
    const { p: q, spec } = await toPublished(fx, { policy: OFF, name: 'pantry-off', spec: SPEC_NO_TARGETS });
    const [row] = semanticsOf(fx.home, spec.run.id).slice(-1);
    assert.ok(row?.representation, 'the specification\'s representation is read');
    assert.ok(!(row.representation.targets ?? []).length, `no target assumed (${JSON.stringify(row.representation.targets)})`);
    const check = latestPlanCheck(fx.home, q.id);
    assert.ok(!(check?.reasons ?? []).some((r) => CLAUSE_5.includes(r.code)), `no clause-5 reason under off (${JSON.stringify(check?.reasons)})`);
    assert.equal(gitText(q, INVENTORY_PATH), null, 'no inventory under off: web not assumed');
  });

  test('(b) a module target the spec does not list: ARCH_TARGET_UNKNOWN; a spec target no ui module serves: ARCH_TARGET_UNCOVERED', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await atSpec(fx, { text: specText({ targets: '**Targets:** web, android, ios' }), name: 'pantry-axes-b' });
    const uncovered = await attempt(fx, p, modulesWith({}));
    refusedFor(uncovered, 'ARCH_TARGET_UNCOVERED', 'ios served by no ui module');
    assert.deepEqual(planSubjects(uncovered.check, 'ARCH_TARGET_UNCOVERED'), ['ios'], 'naming ios');
    const unknown = await attempt(
      fx,
      p,
      modulesWith({
        web: [{ target: 'web', ui_technology: 'html_css' }, { target: 'windows', ui_technology: 'flutter' }],
        mobile: [{ target: 'android', ui_technology: 'react_native', form_factors: ['phone'] }, { target: 'ios', ui_technology: 'react_native', form_factors: ['phone'] }],
      }),
    );
    refusedFor(unknown, 'ARCH_TARGET_UNKNOWN', 'web serving windows, which the spec does not list');
    assert.deepEqual(planSubjects(unknown.check, 'ARCH_TARGET_UNKNOWN'), ['web:windows'], 'naming the module and the target');
    assert.deepEqual(planSubjects(unknown.check, 'ARCH_TARGET_UNCOVERED'), [], 'ios now served');
  });

  test('(c) every pair of the admissibility table: ARCH_TECHNOLOGY_TARGET_MISMATCH exactly for the refused pairs; other admitted on each target and never native', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await atSpec(fx, { text: specText({ targets: SIX_TARGETS_LINE }), name: 'pantry-axes-c' });
    const every = (tech) => TARGETS.map((target) => ({ target, ui_technology: tech }));
    const refused = (module, tech) => TARGETS.filter((target) => !ADMISSIBLE[tech].includes(target)).map((target) => `${module}:${target}:${tech}`);
    const seen = new Set();
    for (const [a, b] of [['html_css', 'three_js'], ['streamlit', 'react_native'], ['flutter', 'swiftui'], ['compose', 'other']]) {
      const out = await attempt(fx, p, modulesWith({ web: every(a), mobile: every(b) }));
      const expected = [...refused('web', a), ...refused('mobile', b)].sort();
      assert.deepEqual(planSubjects(out.check, 'ARCH_TECHNOLOGY_TARGET_MISMATCH').sort(), expected, `${a} and ${b} on the six targets: refused exactly the pairs the table refuses (SEAM.md §495) (${JSON.stringify(out.check?.reasons)})`);
      if (expected.length > 0) refusedFor(out, 'ARCH_TECHNOLOGY_TARGET_MISMATCH', `${a} and ${b}`);
      seen.add(a).add(b);
    }
    assert.deepEqual([...seen].sort(), [...TECHNOLOGIES].sort(), 'the fixture is live: every technology tried on every target');
    // `other` on each target: admitted, published, never native.
    const q = await atSpec(fx, { text: specText({ targets: SIX_TARGETS_LINE }), name: 'pantry-other' });
    const pub = await pantryArchitect(fx, q.id, q.repo, { files: { modules: modulesWith({ web: [{ target: 'web', ui_technology: 'other' }], mobile: TARGETS.filter((x) => x !== 'web').map((target) => ({ target, ui_technology: 'other' })) }) } });
    assert.equal(pub.closeRes.status, 200, `the close is accepted (→ ${pub.closeRes.status} ${pub.closeRes.text?.slice(0, 600)})`);
    assert.deepEqual(planSubjects(latestPlanCheck(fx.home, q.id), 'ARCH_TECHNOLOGY_TARGET_MISMATCH'), [], 'other admitted on every target');
    assert.ok(pub.published, 'published with other on every target');
    const inv = inventoryOf(q);
    assert.deepEqual((inv.targets ?? []).map((x) => x.target).sort(), [...TARGETS].sort(), 'every target in the inventory');
    for (const x of inv.targets) assert.notEqual(x.preview_capability, 'native', `${x.target} under other: its preview capability is never native (${x.preview_capability})`);
  });

  test('(d) a design target entry whose technology or capability differs from the inventory: DESIGN_AXIS_MISMATCH; (e) a shared flow step with no screen on one target: DESIGN_TARGET_DIVERGENCE_UNSTATED, passing with a stated difference', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await toPublished(fx, { policy: BEFORE_BUILD });
    scriptVariant(fx, p);
    const model = designModel(inventoryOf(p));
    const cases = [
      { name: 'the valid design', model },
      { name: 'web drawn as three_js', model: variantOf(model, (m) => (targetEntry(m, 'web').ui_technology = 'three_js')) },
      { name: 'android drawn as native', model: variantOf(model, (m) => (targetEntry(m, 'android').preview_capability = 'native')) },
      { name: 'F1.2 with no android screen', model: variantOf(model, (m) => (screenOf(m, 'S2').flow_steps = ['F1.1'])) },
      {
        name: 'F1.2 with no android screen, the difference stated',
        model: variantOf(model, (m) => {
          screenOf(m, 'S2').flow_steps = ['F1.1'];
          m.design.cross_platform.differences = [{ target: 'android', flow_step: 'F1.2', what: 'adding an item comes in a later version', why: 'the household adds on the laptop first' }];
        }),
      },
    ];
    const out = await checkSession(fx, p.id, cases);
    const res = Object.fromEntries(out.saves.map((s) => [s.name, s.res]));
    assertPassed(res['the valid design'], 'the valid design (the control)');
    assertReason(res['web drawn as three_js'], 'DESIGN_AXIS_MISMATCH', ['web', 'three_js'], 'a technology other than the inventory\'s');
    assertReason(res['android drawn as native'], 'DESIGN_AXIS_MISMATCH', ['android', 'native'], 'a capability other than the inventory\'s');
    assertReason(res['F1.2 with no android screen'], 'DESIGN_TARGET_DIVERGENCE_UNSTATED', ['android', 'F1.2'], 'a shared step missing on android');
    assertPassed(res['F1.2 with no android screen, the difference stated'], 'the difference stated');
    await postCloseRaw(fx, p.id, out.run.id, { refuse: true });
  });
});
