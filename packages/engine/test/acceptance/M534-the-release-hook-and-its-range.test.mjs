// M534, the release hook and its range (slice 43; kernel lane). M6 plan
// §3.5 M534; D7 §6.7; G10; Q8; A.7; SEAM.md §§496, 509.
//
// The hook's condition is reached only through the seam (no production
// caller until D5): `POST /v1/harness/release-hook {project, tier, public?,
// targets?}`. On Pantry everywhere, its design approved with a selection
// narrowed below the defaults (the splash dropped), every slot a placeholder:
// (a) under `live` (the default), a Beta, public and not: no ASSETS_NOT_APPROVED;
// (c) under `live`, a Live: ASSETS_NOT_APPROVED naming every selected slot
//     of a deployed target without an approved effective version;
// (b) under `beta`, a Beta and a Live: the same;
// (d) under `none`: none, for either;
// (e) the narrowed selection: selected slots only, those of the deployed
//     targets (ios; web);
// (f) GET …/design: "required for <tier>: n slots not approved";
//     an Alpha tier refused by the hook's own range;
// (g) on Pantry carried to Alpha with every slot a placeholder: no
//     production call site evaluates the hook (design_ready, dispatch, the
//     stage and phase gates and alpha_authorize counted).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { consume } from './harness/decisions.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { pump } from './harness/journey/drive.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { postCloseRaw } from './harness/session-lane.mjs';
import { answerWith, inventoryOf, readDesign } from './harness/design/drive.mjs';
import {
  DESKTOP,
  SIX_REQUIREMENTS,
  SIX_SPEC_MODULES,
  SIX_TARGETS_LINE,
  TARGETS,
  approvedRevision,
  assertPassed,
  checkSession,
  designModel,
  mockupEntry,
  screenOfTarget,
  scriptVariant,
  specV2With,
  targetEntry,
  toSixPublished,
  untilBatch,
  variantOf,
} from './harness/design/check41.mjs';
import { ALLOWED_CALLERS, evaluateHook, hookEvaluated, hookEvaluations, notApprovedOf, setPolicy, toAlphaWithPlaceholders } from './harness/design/assets43.mjs';

// M533's narrowed design: light only, three logo variants, no splash, one layout per target.
const ONE_LAYOUT = Object.freeze({ web: [1280], android: ['phone-portrait'], ios: ['phone-portrait'], macos: ['1280x800'], windows: ['1280x800'], linux: ['1280x800'] });
function narrowed(inventory) {
  return variantOf(designModel(inventory, { themes: ['light'] }), (m) => {
    m.design.selection.slots = m.design.selection.slots.filter((s) => s.kind !== 'splash').map((s) => (s.kind === 'logo' ? { kind: 'logo', variants: ['full', 'compact', 'monochrome'] } : s));
    m.design.selection.layouts = TARGETS.map((target) => ({ target, layouts: [...ONE_LAYOUT[target]] }));
    for (const target of TARGETS) {
      targetEntry(m, target).layouts = [...ONE_LAYOUT[target]];
      screenOfTarget(m, target).layouts = [...ONE_LAYOUT[target]];
      const mock = mockupEntry(m, target);
      if (mock.simulates) mock.simulates.layout = ONE_LAYOUT[target][0];
    }
    for (const target of DESKTOP) targetEntry(m, target).window = { min: [800, 600], default: [1280, 800] };
  });
}
const SELECTED = Object.freeze(['app_icon', 'favicon', 'logo']);

describe('M534 the release hook and its range', () => {
  test('(a) to (f) the hook through the seam under live, beta and none; selected slots of deployed targets only; GET …/design\'s count; no Alpha tier', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await toSixPublished(fx, { name: 'pantry-hook' });
    const inventory = inventoryOf(p);
    const model = narrowed(inventory);
    const ctx = scriptVariant(fx, p, specV2With({ criteria: model.criteria, base: SIX_REQUIREMENTS, targets: SIX_TARGETS_LINE, modules: SIX_SPEC_MODULES }));
    const out = await checkSession(fx, p.id, [{ name: 'the narrowed selection', model }]);
    assertPassed(out.saves[0].res, 'the narrowed design');
    assert.equal((await postCloseRaw(fx, p.id, out.run.id, {})).status, 200, 'the close');
    const batch = await untilBatch(fx, ctx);
    assert.equal((await answerWith(fx, p.id, batch.design_approval, 'approve')).status, 200, 'the narrowed design approved');
    await consume(fx, p.id, batch.spec_change, 'approve');
    await pump(fx, ctx, () => approvedRevision(fx.home, p.id) ?? undefined, { what: 'the design approved', max: 20 });
    const hook = (body, what) => hookEvaluated(fx, { project: p.id, ...body }, what);

    // (a) Under live, the default: a Beta, public or not, ships with placeholders.
    for (const pub of [true, false]) {
      const a = await hook({ tier: 'beta', public: pub }, `(a) live, a ${pub ? 'public ' : ''}Beta`);
      assert.deepEqual([a.outcome, notApprovedOf(a)], ['met', []], `(a) under live a ${pub ? 'public ' : ''}Beta needs no approved branding (${JSON.stringify(a)})`);
    }
    // (c) Under live, a Live: every selected slot of a deployed target without an approved version.
    const c = await hook({ tier: 'live' }, '(c) live, a Live');
    assert.deepEqual([c.outcome, notApprovedOf(c)], ['not_met', [...SELECTED]], `(c) ASSETS_NOT_APPROVED naming the selected slots, not the splash (${JSON.stringify(c)})`);
    // (f) GET …/design under live.
    const live = await readDesign(fx, p.id);
    assert.equal(live.assets_required?.text, 'required for live: 3 slots not approved', `(f) the count against the policy (D7 §6.7) (${JSON.stringify(live.assets_required)})`);
    // (b) Under beta: a Beta and a Live.
    await setPolicy(fx, p.id, { assets_required_for: 'beta' });
    for (const tier of ['beta', 'live']) {
      const b = await hook({ tier, public: true }, `(b) beta, a ${tier}`);
      assert.deepEqual([b.outcome, notApprovedOf(b)], ['not_met', [...SELECTED]], `(b) under beta a ${tier} names the selected slots (${JSON.stringify(b)})`);
    }
    const beta = await readDesign(fx, p.id);
    assert.equal(beta.assets_required?.text, 'required for beta: 3 slots not approved', `(f) under beta (${JSON.stringify(beta.assets_required)})`);
    // (e) The deployed targets: ios (no favicon, no splash); web (no app_icon).
    const ios = await hook({ tier: 'beta', targets: ['ios'] }, '(e) a Beta of ios');
    assert.deepEqual(notApprovedOf(ios), ['app_icon', 'logo'], `(e) ios: its selected slots only (${JSON.stringify(ios)})`);
    const web = await hook({ tier: 'beta', targets: ['web'] }, '(e) a Beta of web');
    assert.deepEqual(notApprovedOf(web), ['favicon', 'logo'], `(e) web: its selected slots only (${JSON.stringify(web)})`);
    // (d) Under none: nothing, for either tier.
    await setPolicy(fx, p.id, { assets_required_for: 'none' });
    for (const tier of ['beta', 'live']) {
      const d = await hook({ tier }, `(d) none, a ${tier}`);
      assert.deepEqual([d.outcome, notApprovedOf(d)], ['met', []], `(d) under none no condition (${JSON.stringify(d)})`);
    }
    // The hook's range excludes Alpha by construction.
    const alpha = await evaluateHook(fx, { project: p.id, tier: 'alpha' });
    assertRefused(alpha, 400, 'invalid_value', 'the hook asked for an Alpha tier');
  });

  test('(g) Pantry to Alpha with every slot a placeholder: no production call site evaluates the hook', async (t) => {
    const fx = await scriptedEngine(t);
    const { p, marks } = await toAlphaWithPlaceholders(fx, { name: 'pantry-sites' });
    assert.equal(marks.deployed.progress, 'alpha_deployed', 'the journey reached Alpha');
    assert.ok(marks.phase.length > 0 && marks.alphaAuthorize.length > 0, 'the phase gate and alpha_authorize evaluated');
    await hookEvaluated(fx, { project: p.id, tier: 'live' }, 'the seam\'s own evaluation, the counter\'s control');
    const evaluations = await hookEvaluations(fx);
    assert.ok(evaluations.some((e) => e.caller === 'harness' && e.project === p.id), `the seam's evaluation counted (${JSON.stringify(evaluations)})`);
    assert.deepEqual(evaluations.filter((e) => !ALLOWED_CALLERS.includes(e.caller)), [], '(g) no evaluation by alpha_authorize, design_ready, dispatch or any D6 gate (D7 §6.7: inert until D5)');
  });
});
