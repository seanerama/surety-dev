// M533, selection and its floor (slice 41; kernel lane). M6 plan §3.3 M533;
// D7 §5.8, §5.6 clause 8, §6.2, §6.4, §6.7; SEAM.md §§480, 486, 496.
//
// On Pantry everywhere (the six targets, one design session after another):
// (a) a design selecting one theme, three logo variants and one layout per
//     target: the check passes, tokens and contrast checked in the selected
//     theme only, screens at the selected layouts only;
// (c) each floor element dropped (no theme; a target with no layout; no
//     logo; a logo with no variant; web with no favicon; android with no
//     app_icon): DESIGN_SELECTION_BELOW_FLOOR naming what was dropped;
// (b) the narrowings listed on design_approval ("narrowed: …"); before the
//     answer the placeholders and the release hook read the defaults; after
//     it, the selection;
// (d) placeholders and the release hook's count: selected slots only;
// (e) a later revision widening the selection: an ordinary revision through
//     §7, its approval raised with nothing narrowed.
// Each case goes on from the one before; a case after a failure fails "did
// not reach".

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { pump } from './harness/journey/drive.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { postCloseRaw } from './harness/session-lane.mjs';
import { answerWith, effectiveAssets, inventoryOf, openOfKind, readDesign } from './harness/design/drive.mjs';
import { consume } from './harness/decisions.mjs';
import {
  DESKTOP,
  SIX_REQUIREMENTS,
  SIX_SPEC_MODULES,
  SIX_TARGETS_LINE,
  TARGETS,
  approvedRevision,
  assertPassed,
  assertReason,
  checkSession,
  defaultSelection,
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
import { roleThat } from './harness/gitruns.mjs';
import { step } from './harness/scripted.mjs';

// One layout per target: web 1280, mobile phone-portrait, desktop its default window.
const ONE_LAYOUT = Object.freeze({ web: [1280], android: ['phone-portrait'], ios: ['phone-portrait'], macos: ['1280x800'], windows: ['1280x800'], linux: ['1280x800'] });
const LOGO_THREE = Object.freeze(['full', 'compact', 'monochrome']);

// The narrowed design: light only, the logo's three variants, no splash, one layout per target.
function narrowed(inventory) {
  const base = designModel(inventory, { themes: ['light'] });
  return variantOf(base, (m) => {
    m.design.selection.slots = m.design.selection.slots.filter((s) => s.kind !== 'splash').map((s) => (s.kind === 'logo' ? { kind: 'logo', variants: [...LOGO_THREE] } : s));
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
const slotsOf = (list) => [...new Set(list.map((e) => e.slot))].sort();
const variantsOf = (list, slot) => list.filter((e) => e.slot === slot).map((e) => e.variant).sort();

describe('M533 selection and its floor', () => {
  const shared = sharedFixture();
  after(() => shared.cleanup());
  const S = {};
  const reached = (what) => assert.ok(S.ok?.[what], `did not reach this case: ${what} did not complete`);

  test('(a) one theme, three logo variants and one layout per target: the check passes in the selected theme and at the selected layouts only', async () => {
    const fx = await scriptedEngine(shared.context);
    const { p } = await toSixPublished(fx);
    const inventory = inventoryOf(p);
    const model = narrowed(inventory);
    assert.deepEqual(Object.keys(model.tokens.themes), ['light'], 'the fixture is live: tokens.json holds the light theme only, no dark token at all');
    const v2 = specV2With({ criteria: model.criteria, base: SIX_REQUIREMENTS, targets: SIX_TARGETS_LINE, modules: SIX_SPEC_MODULES });
    const ctx = scriptVariant(fx, p, v2);
    Object.assign(S, { fx, p, ctx, inventory, model, ok: {} });
    const out = await checkSession(fx, p.id, [{ name: 'the narrowed selection', model }]);
    S.run = out.run;
    assertPassed(out.saves[0].res, 'the narrowed selection');
    S.ok.a = true;
  });

  test('(c) each floor element dropped: DESIGN_SELECTION_BELOW_FLOOR naming what was dropped', async () => {
    reached('a');
    const { fx, p, model } = S;
    const sel = (edit) => variantOf(model, (m) => edit(m.design.selection));
    const cases = [
      { name: 'no theme', model: sel((s) => (s.themes = [])), names: ['theme'] },
      { name: 'android with no layout', model: sel((s) => (s.layouts.find((x) => x.target === 'android').layouts = [])), names: ['android', 'layout'] },
      { name: 'no logo', model: sel((s) => (s.slots = s.slots.filter((x) => x.kind !== 'logo'))), names: ['logo'] },
      { name: 'a logo with no variant', model: sel((s) => (s.slots.find((x) => x.kind === 'logo').variants = [])), names: ['logo'] },
      { name: 'web with no favicon', model: sel((s) => (s.slots = s.slots.filter((x) => x.kind !== 'favicon'))), names: ['favicon', 'web'] },
      { name: 'android with no app_icon', model: sel((s) => (s.slots = s.slots.filter((x) => x.kind !== 'app_icon'))), names: ['app_icon', 'android'] },
      { name: 'the narrowed selection again', model },
    ];
    const out = await checkSession(fx, p.id, cases, { run: S.run });
    for (const c of cases.filter((x) => x.names)) assertReason(out.saves.find((s) => s.name === c.name).res, 'DESIGN_SELECTION_BELOW_FLOOR', c.names, c.name);
    assertPassed(out.saves.at(-1).res, 'the narrowed selection, saved last');
    S.ok.c = true;
  });

  test('(b) the narrowings listed on design_approval; before the answer the placeholders and the hook read the defaults, after it the selection; (d) selected slots only', async () => {
    reached('c');
    const { fx, p, ctx, inventory } = S;
    const closed = await postCloseRaw(fx, p.id, S.run.id, {});
    assert.equal(closed.status, 200, `the close (${closed.text?.slice(0, 400)})`);
    const batch = await untilBatch(fx, ctx);
    const narrowings = JSON.stringify(batch.design_approval.evidence?.narrowings ?? null);
    for (const word of ['dark', 'on_light', 'on_dark', 'splash', '360', '720', 'phone-landscape', 'tablet-portrait']) assert.ok(narrowings.includes(word), `the narrowing ${word} listed on design_approval (D7 §5.8; SEAM.md §486) (${narrowings})`);
    // Before the answer: the defaults (SEAM.md §496).
    const defaults = defaultSelection(inventory).slots;
    const before = await readDesign(fx, p.id);
    for (const s of defaults) assert.deepEqual(variantsOf(before.effective_assets ?? [], s.kind), [...s.variants].sort(), `before the answer, ${s.kind}'s placeholders are every default variant (${JSON.stringify(before.effective_assets)})`);
    assert.ok((before.effective_assets ?? []).every((e) => e.source === 'placeholder'), 'each a placeholder');
    assert.equal(before.assets_required?.count, defaults.length, `before the answer, the release hook counts every default slot (${JSON.stringify(before.assets_required)})`);
    // The answer.
    const a = await answerWith(fx, p.id, batch.design_approval, 'approve');
    assert.equal(a.status, 200, `approve (${a.text})`);
    await consume(fx, p.id, batch.spec_change, 'approve');
    const rev = await pump(fx, ctx, () => approvedRevision(fx.home, p.id) ?? undefined, { what: 'the narrowed design approved', max: 20 });
    S.approved = rev;
    // After: the selection; (d) selected slots only.
    const afterRead = await readDesign(fx, p.id);
    const stored = effectiveAssets(fx.home, p.id);
    for (const [where, list] of [['GET …/design', afterRead.effective_assets ?? []], ['design_effective_assets', stored]]) {
      assert.deepEqual(slotsOf(list), ['app_icon', 'favicon', 'logo'], `${where}: the selected slots only, no splash (${JSON.stringify(list.map((e) => `${e.slot}/${e.variant}`))})`);
      assert.deepEqual(variantsOf(list, 'logo'), [...LOGO_THREE].sort(), `${where}: the logo's three selected variants only`);
      assert.ok(list.every((e) => e.source === 'placeholder'), `${where}: placeholders, nothing proposed`);
    }
    assert.equal(afterRead.assets_required?.count, 3, `after the answer, the release hook counts the selected slots only (${JSON.stringify(afterRead.assets_required)})`);
    assert.deepEqual([...(afterRead.assets_required?.not_approved ?? [])].sort(), ['app_icon', 'favicon', 'logo'], 'naming them');
    S.ok.b = true;
  });

  test('(e) a later revision widening the selection: an ordinary revision through §7, raised with nothing narrowed', async () => {
    reached('b');
    const { fx, p, ctx, inventory } = S;
    const wide = designModel(inventory);
    for (const h of wide.criteria.human_tests) h.text = `${h.text} Both themes.`;
    const v3 = specV2With({ criteria: wide.criteria, base: SIX_REQUIREMENTS, targets: SIX_TARGETS_LINE, modules: SIX_SPEC_MODULES, version: 3 });
    fx.scripted.kindScript('spec_change', roleThat([step.write('.surety/spec/spec.md', v3.text)], { changes: v3.changes }));
    const out = await checkSession(fx, p.id, [{ name: 'the default selection again', model: wide }]);
    assertPassed(out.saves[0].res, 'the widened selection');
    const closed = await postCloseRaw(fx, p.id, out.run.id, {});
    assert.equal(closed.status, 200, `the close (${closed.text?.slice(0, 400)})`);
    const next = await pump(fx, ctx, () => openOfKind(fx.home, p.id, 'design_approval').at(-1), { what: 'the widened revision\'s design_approval', max: 40 });
    const narrowings = JSON.stringify(next.evidence?.narrowings ?? []);
    assert.ok(!narrowings.includes('dark') && !narrowings.includes('splash'), `nothing narrowed (${narrowings})`);
    assert.equal(approvedRevision(fx.home, p.id)?.id, S.approved.id, 'the narrowed revision stays the approved one until the owner answers');
  });
});
