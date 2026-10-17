// Developer tests for slice 44 (approval, holds, staleness and the plan):
// the plan check's design clauses (ARCH_INTERFACE_SHAPE_MISSING,
// PLAN_SCREEN_UNKNOWN, PLAN_DESIGN_UNCOVERED, the planned design
// obligation), B.5's `screens`, and the asset manifest's merge of a target
// added. Pure functions of the built engine; nothing runs.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { checkPlan, interfaceShapesMissing, stageTargets } = await import(join(dist, 'plan', 'check.js'));
const { parsePhasePlan } = await import(join(dist, 'plan', 'schemas.js'));
const { mergeTargetSlots, recordedPlaceholders } = await import(join(dist, 'design', 'stale.js'));
const { placeholderManifest } = await import(join(dist, 'design', 'assets.js'));

const ITEM = { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 40 } }, required: ['name'] };
const MODULES = {
  version: 1,
  modules: [
    {
      name: 'api',
      surface: 'api',
      paths: ['server.mjs'],
      sensitive_areas: [],
      interfaces: [
        { name: 'list-items', kind: 'http', description: 'list', consumed_by: ['web', 'mobile'], request: { type: 'null' }, response: ITEM, errors: [] },
        { name: 'add-item', kind: 'http', description: 'add', consumed_by: ['web'], request: ITEM, response: ITEM },
        { name: 'health', kind: 'http', description: 'health', consumed_by: [] },
      ],
    },
    { name: 'web', surface: 'ui', paths: ['web/'], sensitive_areas: [], interfaces: [], targets: [{ target: 'web', ui_technology: 'html_css' }] },
    { name: 'mobile', surface: 'ui', paths: ['mobile/'], sensitive_areas: [], interfaces: [], targets: [{ target: 'android', ui_technology: 'react_native' }] },
  ],
  mapping_from_spec: [],
};
const KINDS = ['acceptance', 'smoke', 'integration', 'security_lint'];
const stage = (number, modules, implements_, extra = {}) => ({ number, goal: `stage ${number}`, tasks: ['t'], modules, implements: implements_, adrs: [], depends_on: [], validation: { criteria: implements_.map((k) => `${k}.1`), kinds: KINDS, sensitive_areas: [] }, integration_obligations: [], ...extra });
const req = (key) => ({ key, criteria: [`${key}.1`], sensitive_areas: [], withdrawn: false, blocked_by_questions: [] });
const baselineOf = (design) => ({
  spec_version: 1,
  requirements: [req('R1'), req('R2'), req('R3'), req('R4')],
  questions: [],
  architecture_version: 1,
  roadmap_version: 1,
  head: 'h',
  project_tier: 'T1',
  completed_phases: [],
  approved: null,
  design,
});
const artifactsOf = (stages) => ({
  modules: MODULES,
  roadmap: { version: 1, architecture_version: 1, phases: [{ number: 1, goal: 'one', modules: ['api', 'web', 'mobile'], requirement_ids: ['R1', 'R2', 'R3', 'R4'], depends_on: [] }] },
  adrs: {},
  adr_front_matter: {},
  architecture_text: null,
  plan: { phase: 1, prepared_against: { spec_version: 1, architecture_version: 1, roadmap_version: 1, revision: 'h' }, stages, conformance: 'within_baseline' },
});
const STAGES = [stage(1, ['api'], ['R1']), stage(2, ['web'], ['R2', 'R4']), stage(3, ['mobile'], ['R3', 'R4'])];
const SCREENS = [
  { key: 'S1', target: 'web', requirements: ['R2'] },
  { key: 'S2', target: 'android', requirements: ['R3'] },
];
const reasons = (r, code) => r.reasons.find((x) => x.code === code)?.subjects ?? [];

test('clause 5: an interface a ui module consumes without request, response or errors is named <module>:<interface>; one no ui module consumes is not', () => {
  assert.deepEqual(interfaceShapesMissing(MODULES), ['api:add-item']);
  const r = checkPlan(baselineOf({ policy: 'before_build', spec_targets: ['web', 'android'], approved_screens: null }), artifactsOf(STAGES));
  assert.deepEqual(reasons(r, 'ARCH_INTERFACE_SHAPE_MISSING'), ['api:add-item']);
  const off = checkPlan(baselineOf({ policy: 'off', spec_targets: ['web', 'android'], approved_screens: null }), artifactsOf(STAGES));
  assert.deepEqual(reasons(off, 'ARCH_INTERFACE_SHAPE_MISSING'), [], 'optional under off');
});

test('before any design: one planned design obligation per UI stage, with its targets; none for the API stage', () => {
  const shaped = structuredClone(MODULES);
  shaped.modules[0].interfaces[1].errors = [];
  const a = { ...artifactsOf(STAGES), modules: shaped };
  const r = checkPlan(baselineOf({ policy: 'before_build', spec_targets: ['web', 'android'], approved_screens: null }), a);
  assert.equal(r.outcome, 'passed', JSON.stringify(r.reasons));
  assert.deepEqual(r.design_obligations, [{ stage: 2, targets: ['web'] }, { stage: 3, targets: ['android'] }]);
  assert.deepEqual(stageTargets(shaped, ['api']), []);
  const atAlpha = checkPlan(baselineOf({ policy: 'at_alpha', spec_targets: ['web', 'android'], approved_screens: null }), a);
  assert.deepEqual(atAlpha.design_obligations, [], 'at_alpha holds nothing before build');
});

test('with an approved design: PLAN_DESIGN_UNCOVERED names <requirement>:<target> per UI stage, never a covered one; PLAN_SCREEN_UNKNOWN names a key the design lacks', () => {
  const shaped = structuredClone(MODULES);
  shaped.modules[0].interfaces[1].errors = [];
  const stages = [STAGES[0], STAGES[1], { ...STAGES[2], screens: ['S2', 'S9'] }];
  const r = checkPlan(baselineOf({ policy: 'both', spec_targets: ['web', 'android'], approved_screens: SCREENS }), { ...artifactsOf(stages), modules: shaped });
  assert.deepEqual(reasons(r, 'PLAN_DESIGN_UNCOVERED'), ['R4:android', 'R4:web']);
  assert.deepEqual(reasons(r, 'PLAN_SCREEN_UNKNOWN'), ['stage 3:S9']);
  assert.deepEqual(r.design_obligations, [], 'a refused check records none');
  // A requirement marked for one target is a UI requirement of it only.
  const marked = checkPlan(baselineOf({ policy: 'both', spec_targets: ['web', 'android'], approved_screens: SCREENS, surface_targets: { R4: ['web'] } }), { ...artifactsOf(STAGES), modules: shaped });
  assert.deepEqual(reasons(marked, 'PLAN_DESIGN_UNCOVERED'), ['R4:web']);
});

test("B.5's stage takes `screens`, a list of keys; anything else is refused naming the field", () => {
  const plan = (screens) => JSON.stringify({ phase: 1, prepared_against: { spec_version: 1, architecture_version: 1, roadmap_version: 1, revision: 'a'.repeat(40) }, stages: [stage(1, ['web'], ['R2'], screens === undefined ? {} : { screens })], conformance: 'within_baseline' });
  assert.deepEqual(parsePhasePlan(plan(['S1']), 'p.json', 1).value.stages[0].screens, ['S1']);
  assert.equal(parsePhasePlan(plan(undefined), 'p.json', 1).value.stages[0].screens, undefined);
  const bad = parsePhasePlan(plan('S1'), 'p.json', 1);
  assert.equal(bad.ok, false);
  assert.match(bad.finding.field, /screens/);
});

test('a target added: its default slots merged into the tree manifest as placeholders, the Designer\'s slots kept, the version advanced; nothing changes twice', () => {
  const two = placeholderManifest('Pantry', ['web', 'android']);
  const tree = structuredClone(two.manifest);
  tree.slots.find((s) => s.key === 'logo').status = 'approved';
  const three = placeholderManifest('Pantry', ['web', 'android', 'ios']);
  const merged = mergeTargetSlots(tree, three);
  assert.ok(merged);
  assert.equal(merged.manifest.version, tree.version + 1);
  const splash = merged.manifest.slots.find((s) => s.kind === 'splash');
  assert.deepEqual([splash.platforms, splash.status], [['ios'], 'placeholder']);
  assert.ok(Object.keys(merged.files).some((f) => f.startsWith('assets/splash/')), 'its placeholder files written');
  const logo = merged.manifest.slots.find((s) => s.key === 'logo');
  assert.ok(logo.platforms.includes('ios') && logo.status === 'approved', 'the approved logo keeps its status, its platforms gain ios');
  assert.equal(mergeTargetSlots(merged.manifest, three), null, 'nothing to merge again');
  // Removed again: the recorded placeholders keep ios's platforms for stale_platforms.
  const recorded = recordedPlaceholders(two.manifest, merged.manifest);
  assert.ok(recorded.slots.find((s) => s.key === 'splash').platforms.includes('ios'));
});
