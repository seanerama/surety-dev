// M521, target-scoped criteria; native obligations (slice 41; kernel lane).
// M6 plan §3.3 M521; D7 §5.3, §7.2, §7.3, §5.6 clause 7; Q3; A.2, A.3, A.8;
// SEAM.md §§483, 494.
//
// (a) tokens_only, layout_at_width, label_with_unit, focus_visible,
//     reduced_motion proposed for an android `compose` screen and for a web
//     `streamlit` screen: DESIGN_CRITERION_NOT_APPLICABLE naming kind,
//     target and technology; for a web `html_css` screen: admitted;
// (b) token_parity and contrast_aa for an html_css screen: admitted; for a
//     react_native screen naming the path its code reads the neutral tokens
//     from: admitted; without a path: refused naming the missing path;
//     state_marker_present, asset_parity, human on any target: admitted;
// (c) a criterion of a native-convention kind (system_back, safe_area,
//     keyboard_shortcuts): DESIGN_CRITERION_NOT_APPLICABLE with the hint
//     `not_checkable_yet`; a criterion of no catalogue kind:
//     DESIGN_CRITERION_UNCHECKABLE;
// (d) an approved design with screens on all six targets: a
//     design_native_obligations row `not_checkable_yet` per target, screen
//     and convention of §5.3's "not checkable" column, web's browser_back
//     and keyboard_path among them, each listed in its target's human-test
//     requirement; none dropped;
// (e) GET …/design: their counts per target.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { requirementsOf } from './harness/journey/drive.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { postCloseRaw } from './harness/session-lane.mjs';
import { withStore } from './harness/store.mjs';
import { WEB_LOGO_PATH } from './harness/design/reference.mjs';
import { inventoryOf, readDesign, toPublished } from './harness/design/drive.mjs';
import {
  BEFORE_BUILD,
  SIX_REQUIREMENTS,
  SIX_SPEC_MODULES,
  SIX_TARGETS_LINE,
  TARGETS,
  approveBatch,
  assertPassed,
  assertReason,
  checkSession,
  designModel,
  notCheckableOf,
  scriptVariant,
  specV2With,
  toScPublished,
  toSixPublished,
  untilBatch,
  variantOf,
} from './harness/design/check41.mjs';

const CSS_KINDS = Object.freeze(['tokens_only', 'layout_at_width', 'label_with_unit', 'focus_visible', 'reduced_motion']);
const PATHS = Object.freeze({ web: ['web/app.css', 'web/tokens.css'], android: ['mobile/App.js'] });
const REQ = Object.freeze({ web: 'R2', android: 'R3' });
const criterion = (kind, target, extra = {}) => ({
  requirement: REQ[target],
  text: `Given the ${target} module, when its files are read, then ${kind} holds.`,
  kind,
  targets: [target],
  ...(kind === 'human' ? {} : { paths: PATHS[target] }),
  ...(kind === 'layout_at_width' ? { width: 360 } : {}),
  ...extra,
});
const withCriteria = (model, list) => variantOf(model, (m) => (m.criteria.criteria = list));
const noPaths = (c) => {
  const { paths, ...rest } = c;
  return rest;
};

async function published(t, how) {
  const fx = await scriptedEngine(t);
  const { p } = how === 'sc' ? await toScPublished(fx) : await toPublished(fx, { policy: BEFORE_BUILD });
  scriptVariant(fx, p);
  return { fx, p, model: designModel(inventoryOf(p)) };
}

describe('M521 target-scoped criteria and native obligations', () => {
  test('(a) the CSS kinds on an android compose screen and a web streamlit screen: DESIGN_CRITERION_NOT_APPLICABLE naming kind, target and technology', async (t) => {
    const { fx, p, model } = await published(t, 'sc');
    const all = [...CSS_KINDS.map((k) => criterion(k, 'web')), ...CSS_KINDS.map((k) => criterion(k, 'android'))];
    const out = await checkSession(fx, p.id, [{ name: 'the design', model }, { name: 'the CSS kinds', model: withCriteria(model, all) }]);
    assertPassed(out.saves[0].res, 'the design on streamlit and compose, no criterion (the control)');
    for (const kind of CSS_KINDS) {
      assertReason(out.saves[1].res, 'DESIGN_CRITERION_NOT_APPLICABLE', [kind, 'web', 'streamlit'], `${kind} on web under streamlit`);
      assertReason(out.saves[1].res, 'DESIGN_CRITERION_NOT_APPLICABLE', [kind, 'android', 'compose'], `${kind} on android under compose`);
    }
    await postCloseRaw(fx, p.id, out.run.id, { refuse: true });
  });

  test('(a) the CSS kinds on a web html_css screen: admitted; (b) token_parity and contrast_aa on html_css, and on react_native with a path, admitted, without one refused naming it; state_marker_present, asset_parity, human on both targets admitted', async (t) => {
    const { fx, p, model } = await published(t, 'base');
    const admitted = [
      ...CSS_KINDS.map((k) => criterion(k, 'web')),
      criterion('token_parity', 'web', { paths: ['web/tokens.css'] }),
      criterion('contrast_aa', 'web', { paths: ['web/tokens.css'] }),
      criterion('token_parity', 'android', { paths: ['mobile/tokens.json'] }),
      criterion('contrast_aa', 'android', { paths: ['mobile/tokens.json'] }),
      ...['web', 'android'].flatMap((target) => [
        criterion('state_marker_present', target),
        criterion('asset_parity', target, { paths: [target === 'web' ? WEB_LOGO_PATH : 'mobile/assets/logo.svg'], slot: 'logo', variant: 'full' }),
        criterion('human', target),
      ]),
    ];
    const cases = [
      { name: 'the admitted kinds', model: withCriteria(model, admitted) },
      { name: 'token_parity on react_native without a path', model: withCriteria(model, [noPaths(criterion('token_parity', 'android'))]) },
      { name: 'contrast_aa on react_native without a path', model: withCriteria(model, [noPaths(criterion('contrast_aa', 'android'))]) },
    ];
    const out = await checkSession(fx, p.id, cases);
    const res = Object.fromEntries(out.saves.map((s) => [s.name, s.res]));
    assertPassed(res['the admitted kinds'], 'every kind where it applies (D7 §7.2)');
    assertReason(res['token_parity on react_native without a path'], 'DESIGN_CRITERION_NOT_APPLICABLE', ['token_parity', 'android', 'react_native', 'paths'], 'token_parity on react_native without the path its code reads (SEAM.md §494)');
    assertReason(res['contrast_aa on react_native without a path'], 'DESIGN_CRITERION_NOT_APPLICABLE', ['contrast_aa', 'android', 'react_native', 'paths'], 'contrast_aa on react_native without the path');
    await postCloseRaw(fx, p.id, out.run.id, { refuse: true });
  });

  test('(c) a native-convention kind: DESIGN_CRITERION_NOT_APPLICABLE with the hint not_checkable_yet; a kind of no catalogue: DESIGN_CRITERION_UNCHECKABLE', async (t) => {
    const { fx, p, model } = await published(t, 'base');
    const cases = [
      { name: 'system_back on android', model: withCriteria(model, [criterion('system_back', 'android')]) },
      { name: 'safe_area on android', model: withCriteria(model, [criterion('safe_area', 'android')]) },
      { name: 'keyboard_shortcuts on web', model: withCriteria(model, [criterion('keyboard_shortcuts', 'web')]) },
      { name: 'a kind of no catalogue', model: withCriteria(model, [criterion('pixel_perfect', 'web')]) },
    ];
    const out = await checkSession(fx, p.id, cases);
    const res = Object.fromEntries(out.saves.map((s) => [s.name, s.res]));
    for (const [name, kind, target] of [['system_back on android', 'system_back', 'android'], ['safe_area on android', 'safe_area', 'android'], ['keyboard_shortcuts on web', 'keyboard_shortcuts', 'web']]) {
      const r = assertReason(res[name], 'DESIGN_CRITERION_NOT_APPLICABLE', [kind, target], name);
      assert.match(JSON.stringify(r), /not_checkable_yet/, `${name}: with the hint not_checkable_yet (SEAM.md §494) (${JSON.stringify(r)})`);
    }
    assertReason(res['a kind of no catalogue'], 'DESIGN_CRITERION_UNCHECKABLE', ['pixel_perfect'], 'a kind of no catalogue');
    await postCloseRaw(fx, p.id, out.run.id, { refuse: true });
  });

  test('(d) an approved design on all six targets: a design_native_obligations row not_checkable_yet per target, screen and convention, each bound to its target\'s human-test requirement, none dropped; (e) GET …/design counts them per target', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await toSixPublished(fx);
    const inventory = inventoryOf(p);
    const model = designModel(inventory);
    assert.deepEqual(model.screens.screens.map((s) => s.target), [...TARGETS], 'the fixture is live: a screen on each of the six targets');
    const v2 = specV2With({ criteria: model.criteria, base: SIX_REQUIREMENTS, targets: SIX_TARGETS_LINE, modules: SIX_SPEC_MODULES });
    const ctx = scriptVariant(fx, p, v2);
    const out = await checkSession(fx, p.id, [{ name: 'the six-target design', model }]);
    assertPassed(out.saves[0].res, 'the six-target design');
    const closed = await postCloseRaw(fx, p.id, out.run.id, {});
    assert.equal(closed.status, 200, `the close (${closed.text?.slice(0, 400)})`);
    const batch = await untilBatch(fx, ctx);
    const revision = await approveBatch(fx, ctx, batch);
    const rows = withStore(fx.home, (db) => db.prepare('SELECT * FROM "design_native_obligations" WHERE "design_revision" = ?').all(revision.id));
    const reqs = requirementsOf(fx.home, p.id);
    const human = (target) => reqs.find((r) => r.key === v2.humanKeys[target]);
    for (const target of TARGETS) {
      const key = model.keyOf[target];
      const req = human(target);
      assert.ok(req, `the fixture is live: ${target}'s human-test requirement ${v2.humanKeys[target]} is in the specification`);
      for (const convention of notCheckableOf(inventory, target)) {
        const row = rows.find((r) => r.target === target && r.screen === key && r.convention === convention);
        assert.ok(row, `${target} ${key} ${convention}: a design_native_obligations row (D7 §7.2; SEAM.md §494) (rows: ${JSON.stringify(rows.map((r) => [r.target, r.screen, r.convention]))})`);
        assert.equal(row.status, 'not_checkable_yet', `${target} ${key} ${convention}: not_checkable_yet`);
        assert.ok([req.id, req.key].includes(row.requirement), `${target} ${key} ${convention}: listed in ${target}'s human-test requirement ${req.key} (${row.requirement})`);
      }
    }
    for (const c of ['browser_back', 'keyboard_path']) assert.ok(rows.some((r) => r.target === 'web' && r.convention === c), `web's ${c} among them`);
    assert.ok(rows.every((r) => r.status === 'not_checkable_yet'), 'every row not_checkable_yet');
    // (e)
    const read = await readDesign(fx, p.id);
    for (const target of TARGETS) {
      const n = rows.filter((r) => r.target === target).length;
      assert.equal(read.not_checkable_yet?.[target], n, `GET …/design counts ${target}'s not_checkable_yet conventions (SEAM.md §494) (${JSON.stringify(read.not_checkable_yet)})`);
    }
  });
});
