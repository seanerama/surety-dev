// M509, the UI Builder's package (slice 40; kernel lane). M6 plan §3.2
// M509; D7 §8.4, §6.5; E151; `339e116`; SEAM.md §482.
//
// (a) a UI stage on web `html_css`; on `android` `react_native`: read from
//     the captured package, the approved version's neutral tokens.json, and
//     tokens.css for html_css only; the stage's screens for its targets with
//     states, layouts, inputs and conventions; each target's navigation;
//     mockups and fixtures read-only, each simulated_html labelled a
//     simulation; the effective set with each file's slot@version and
//     source; the instruction to return a binding for every file placed;
//     the stage's design criteria; the statement that the Builder
//     implements the design in source and writes nothing under `.surety/`;
// (b) a backend stage of the same phase: none of these;
// (c) with a held proposal and an Architect-declared `asset_paths`: the
//     held proposal's digest absent; the declared paths stated;
// (d) after a newer design checkpoint than the approved revision: the
//     approved revision's files only.

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { consume } from './harness/decisions.mjs';
import { journeyContext, pump } from './harness/journey/drive.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { closeSession } from './harness/sessions.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { ANDROID_LOGO_PATH, ANDROID_MOCKUP_PATH, LOGO_SVG, TOKENS, WEB_MOCKUP_PATH, sha256hex } from './harness/design/reference.mjs';
import {
  answerWith,
  batchOf,
  designScripts,
  designerSession,
  designRevisions,
  dumpedPackage,
  gitText,
  scriptBuilders,
  stageWork,
  toPublished,
  validDesign,
} from './harness/design/drive.mjs';

const parse = (t) => (t ? JSON.parse(t) : null);
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const LOGO_DIGEST = sha256hex(LOGO_SVG);
// The checkpoint's tokens: the accent changed after the approval.
const CHECKPOINT_TOKENS = { ...TOKENS, themes: { ...TOKENS.themes, light: { ...TOKENS.themes.light, 'color.accent': '#7a1fa2' } } };

describe('M509 the UI Builder\'s package', () => {
  const shared = sharedFixture();
  const P = {};
  // The journey to the UI Builders' packages, made once by the first case
  // that needs it; every case awaits it, so a failure is each case's own.
  let made = null;
  const ready = () => (made ??= make());
  async function make() {
    const fx = await scriptedEngine(shared.context);
    const { p } = await toPublished(fx, { policy: { design: 'before_build', autonomy: 'phase', phase_size: { min: 1, max: 5 } } });
    designScripts(fx);
    scriptBuilders(fx, p.id, { dump: [1, 2, 3] });
    const ctx = journeyContext(fx, p, { lane: 'kernel' });
    ctx.answerKinds = ['check_correction_unclassifiable', 'check_correction_tightening', 'check_correction_loosening', 'plan_approval'];
    Object.assign(P, { fx, p, ctx });
    const approvedFiles = validDesign(p);
    await designerSession(fx, p.id, [{ files: approvedFiles, say: 'Draw Pantry.', result: { done: true } }]);
    const batch = await pump(fx, ctx, () => {
      const b = batchOf(fx.home, p.id);
      return b?.spec_change ? b : undefined;
    }, { what: 'the batch', max: 40 });
    const held = await answerWith(fx, p.id, batch.design_approval, 'approve', { assets_held: ['logo'] });
    assert.equal(held.status, 200, `approve with the logo held (${held.text})`);
    await consume(fx, p.id, batch.spec_change, 'approve');
    await pump(fx, ctx, () => designRevisions(fx.home, p.id).find((r) => r.status === 'approved') ?? undefined, { what: 'the design approved', max: 10 });
    // (d) a newer checkpoint than the approved revision, its product recorded, nothing raised.
    const later = await designerSession(fx, p.id, [{ files: { '.surety/design/tokens.json': json(CHECKPOINT_TOKENS) }, say: 'Try a purple accent.' }], { close: null });
    P.checkpoint = later.saves[0]?.body?.revision ?? null;
    await closeSession(fx, p.id, later.run.id, { refuse: true });
    P.approvedTokens = approvedFiles['.surety/design/tokens.json'];
    await pump(fx, ctx, () => ([2, 3].every((n) => fx.scripted.launches({ work_item: stageWork(fx.home, p.id, n).id }).length > 0) ? true : undefined), { what: 'both UI Builders launched', max: 80 });
    const pkg = (n) => {
      const launch = fx.scripted.launches({ work_item: stageWork(fx.home, p.id, n).id })[0];
      return launch ? dumpedPackage(fx, launch.run, 0) : null;
    };
    P.pkg = { 1: pkg(1), 2: pkg(2), 3: pkg(3) };
  }
  after(() => shared.cleanup());

  const designFiles = (pkg) => Object.keys(pkg ?? {}).filter((n) => n.startsWith('design/'));
  const text = (pkg, name) => pkg?.[name]?.text ?? null;

  for (const [n, target, tech, screen, mockup, simulated] of [[2, 'web', 'html_css', 'S1', WEB_MOCKUP_PATH, false], [3, 'android', 'react_native', 'S2', ANDROID_MOCKUP_PATH, true]]) {
    test(`(a) the UI stage on ${target} ${tech}: the approved tokens${n === 2 ? ' and tokens.css' : ', no tokens.css'}, its screens, navigation, mockups and fixtures, the effective set, the binding instruction, its criteria, the statement`, async () => {
      await ready();
      const pkg = P.pkg[n];
      assert.ok(pkg, `stage ${n}'s Builder dumped its package`);
      assert.equal(text(pkg, 'design/tokens.json'), P.approvedTokens, 'the approved version\'s neutral tokens.json (SEAM.md §482)');
      if (n === 2) assert.match(text(pkg, 'design/tokens.css') ?? '', /--color-text-primary:\s*#1a1a1a/, 'tokens.css, the CSS binding (B.11)');
      else assert.equal(pkg['design/tokens.css'], undefined, 'no tokens.css for react_native');
      const screens = parse(text(pkg, 'design/screens.json'))?.screens ?? [];
      assert.deepEqual(screens.map((s) => [s.key, s.target]), [[screen, target]], `its target's screens only (${JSON.stringify(screens.map((s) => s.key))})`);
      assert.ok(screens[0].states.length > 0 && screens[0].layouts.length > 0 && screens[0].inputs.length > 0 && screens[0].conventions, 'with states, layouts, inputs and conventions');
      assert.deepEqual((parse(text(pkg, 'design/navigation.json'))?.targets ?? []).map((x) => x.target), [target], 'its target\'s navigation');
      assert.ok(pkg[`design/${mockup}`], `the mockup ${mockup}, read-only, as reference`);
      const mockups = parse(text(pkg, 'design/mockups.json')) ?? [];
      assert.deepEqual(mockups.map((m) => [m.path, m.simulation]), [[mockup, simulated]], `labelled${simulated ? ' a simulation' : ''} (${JSON.stringify(mockups)})`);
      for (const s of screens[0].states) assert.ok(pkg[`design/${s.fixture}`], `the fixture ${s.fixture}`);
      const eff = parse(text(pkg, 'design/effective-assets.json')) ?? [];
      assert.ok(eff.length > 0, 'the effective set');
      for (const e of eff) {
        assert.ok(e.slot && e.variant && Number.isInteger(e.slot_version) && ['approved', 'placeholder'].includes(e.source), `each with slot@version and source (${JSON.stringify(e)})`);
        assert.equal(pkg[e.path]?.sha256, e.digest, `${e.slot}/${e.variant}: the file at ${e.path} is the effective one`);
      }
      const prompt = text(pkg, 'prompt.md') ?? '';
      assert.match(prompt, /asset_bindings/, 'the instruction to return a binding for every file placed');
      assert.ok(JSON.stringify(parse(text(pkg, 'result-schema.json')) ?? {}).includes('asset_bindings'), 'and the result schema carries it (B.17)');
      assert.match(prompt, /implements? the design in source/i, 'the Builder implements the design in source');
      assert.match(prompt, /nothing under `?\.surety\/`?/, 'and writes nothing under .surety/');
      const criteria = (parse(text(pkg, 'design/criteria.json'))?.criteria ?? []).map((c) => c.id).sort();
      assert.deepEqual(criteria, n === 2 ? ['R2.2', 'R2.3'] : ['R3.2'], 'the stage\'s design criteria');
    });
  }

  test('(b) a backend stage of the same phase: none of these', async () => {
    await ready();
    const pkg = P.pkg[1];
    assert.ok(pkg, 'stage 1\'s Builder dumped its package');
    assert.deepEqual(designFiles(pkg), [], 'no design file');
    assert.doesNotMatch(text(pkg, 'prompt.md') ?? '', /asset_bindings/, 'no binding instruction');
  });

  test('(c) the held proposal\'s digest absent from every UI package; the Architect-declared asset_paths stated', async () => {
    await ready();
    for (const n of [2, 3]) for (const [name, f] of Object.entries(P.pkg[n] ?? {})) {
      assert.notEqual(f.sha256, LOGO_DIGEST, `stage ${n}: ${name} is not the held proposal`);
      assert.ok(!(f.text ?? '').includes(LOGO_DIGEST), `stage ${n}: ${name} does not name its digest`);
    }
    const eff = parse(text(P.pkg[3], 'design/effective-assets.json')) ?? [];
    const logo = eff.find((e) => e.variant === 'full' && e.slot === 'logo');
    assert.equal(logo?.declared_path, ANDROID_LOGO_PATH, `the declared path stated (${JSON.stringify(logo)})`);
  });

  test('(d) after a newer checkpoint than the approved revision: the approved revision\'s files only', async () => {
    await ready();
    assert.ok(P.checkpoint, 'the later checkpoint was saved');
    assert.ok(gitText(P.p, '.surety/design/tokens.json', P.checkpoint)?.includes('#7a1fa2'), 'the checkpoint carries the purple accent');
    for (const n of [2, 3]) {
      assert.equal(text(P.pkg[n], 'design/tokens.json'), P.approvedTokens, `stage ${n}: the approved tokens`);
      assert.ok(!JSON.stringify(P.pkg[n]).includes('#7a1fa2'), `stage ${n}: nothing of the checkpoint`);
    }
  });
});
