// M520, simulation labelling (slice 42; kernel lane; its sandbox half is
// `M520-simulation-labelling-through-the-preview-unit`). M6 plan §3.4 M520;
// D7 §5.4, §5.7, §10.2, §10.5; Q2, Q4; BS6 §4.1 rules 21, 22; SEAM.md §§488,
// 498 to 502.
//
// The reference project "Pantry": S1 on web (`html_css`, capability
// `native`, a `static_html` mockup) and S2 on android (`react_native`,
// `simulated`, a `simulated_html` mockup declaring `{target: android,
// form_factor: phone, layout: phone-portrait}`).
//   (a) to (c), the server's responses over a sealed tree with no unit: a
//       preview deployed on the scripted adapter, then the engine's own server
//       run by the test as the reserved environment's configuration starts it,
//       in the sealed directory, on 127.0.0.1 (SEAM.md §500):
//       (a) the simulated mockup's frame path (the index's link) and a direct
//           request for its own path: the engine's frame, each, never the
//           mockup's bytes bare;
//       (b) the frame: the fixed banner naming target, form factor and layout
//           and D7 §5.7's sentence, outside and before one iframe whose
//           `sandbox` is `allow-scripts` (scripts, not same origin), its src
//           the mockup;
//       (c) the index: every mockup with its target and its capability; the
//           native mockup served as its bytes;
//   (d) export: `SIMULATIONS.txt` from the CLI and in the archive, naming the
//       simulated mockup and not the native one;
//   (e) an HTML mockup of an android screen not declared `simulated_html`,
//       and a `simulated_html` with no `simulates`: DESIGN_SIMULATION_UNDECLARED
//       each, naming the target and the mockup;
//   (f) an owner-invoked review of the android target (D7 §10.5) whose
//       verdict is `observed_on: simulation`, confirmed by the owner:
//       recorded, never counted as native evidence (the android human test
//       `pending` on GET …/design, `owed` on the pace read); the control, a
//       second review observed on an emulator and confirmed: owner accepted.
//
// SAFETY (BS6 §4.1). No unit, no domain. The one process the test starts
// is the engine's own server (an engine file, never the Designer's), its
// own child on 127.0.0.1, ended through its handle; it serves the sealed
// tree as data. Mockups are read as bytes and markup; nothing is rendered or
// run (rules 21, 22).

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { pump, readPace } from './harness/journey/drive.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { closeSession, saveSession, sayAndSettle, scriptTurns, turnResult } from './harness/sessions.mjs';
import { step } from './harness/scripted.mjs';
import { qualifyByFixture } from './harness/deploy/kernel.mjs';
import { ANDROID_MOCKUP, ANDROID_MOCKUP_PATH, HUMAN_TEST_KEYS, WEB_MOCKUP, WEB_MOCKUP_PATH } from './harness/design/reference.mjs';
import { answerWith, cli, designReviews, designerSession, inventoryOf, openOfKind, readDesign, toPublished, validDesign } from './harness/design/drive.mjs';
import { BEFORE_BUILD, approveBatch, assertPassed, assertReason, checkSession, designModel, mockupEntry, scriptVariant, untilBatch, variantOf } from './harness/design/check41.mjs';
import {
  assertFrame,
  engineBytes,
  indexEntries,
  previewConfig,
  previewOnKernel,
  rawRequest,
  runPreviewServer,
  sealedPathOf,
  simulationRecords,
  textOf,
  untar,
} from './harness/design/preview42.mjs';

const SIMULATES = Object.freeze({ target: 'android', form_factor: 'phone', layout: 'phone-portrait' });

describe('M520 simulation labelling (kernel lane)', () => {
  const shared = sharedFixture();
  after(() => shared.cleanup());

  // Pantry with a checkpoint previewed on the scripted adapter, made once.
  let made = null;
  const previewed = () =>
    (made ??= (async () => {
      const fx = await scriptedEngine(shared.context);
      const { p } = await toPublished(fx, { policy: BEFORE_BUILD, name: 'pantry-frame' });
      scriptVariant(fx, p);
      const s = await designerSession(fx, p.id, [{ files: validDesign(p), say: 'Draw Pantry for the web and Android.' }], { close: null });
      assert.equal(s.saves[0]?.body?.design_check?.outcome, 'passed', `the reference design saved (${s.saves[0]?.text?.slice(0, 300)})`);
      await qualifyByFixture(fx.engine);
      const { env, op } = await previewOnKernel(fx, p.id, { revision: 'checkpoint' });
      const sealed = sealedPathOf(fx.home, op);
      assert.ok(sealed, `the preview's attempt names its sealed directory (capability.sealed_path) (${JSON.stringify(op)})`);
      const config = previewConfig(fx.home, env.id)?.content;
      const tmp = join(fx.root, 'm520-server');
      mkdirSync(tmp, { recursive: true });
      return { fx, p, env, op, sealed, config, tmp };
    })());

  test('(a), (b), (c) the server over the sealed tree, no unit: the index lists each mockup with its target and capability; the native mockup is its bytes; the simulated mockup\'s frame path and its own path both answer the engine\'s labelled frame around a sandboxed iframe', async () => {
    const { config, sealed, tmp } = await previewed();
    const server = await runPreviewServer(config, sealed, { tmp });
    try {
      // (c) the index.
      const index = await rawRequest(server.port, 'GET', '/');
      assert.equal(index.status, 200, `the index (→ ${index.status} ${index.error ?? ''})`);
      const entries = indexEntries(textOf(index));
      const byPath = Object.fromEntries(entries.map((e) => [e.path, e]));
      assert.deepEqual(Object.keys(byPath).sort(), [ANDROID_MOCKUP_PATH, WEB_MOCKUP_PATH].sort(), `every mockup of design.json listed (SEAM.md §500) (${JSON.stringify(entries)})`);
      assert.deepEqual([byPath[WEB_MOCKUP_PATH].target, byPath[WEB_MOCKUP_PATH].capability], ['web', 'native'], 'the web mockup: web, native');
      assert.deepEqual([byPath[ANDROID_MOCKUP_PATH].target, byPath[ANDROID_MOCKUP_PATH].capability], ['android', 'simulated'], 'the android mockup: android, simulated');
      const web = await rawRequest(server.port, 'GET', `/${WEB_MOCKUP_PATH}`);
      assert.equal(web.status, 200);
      assert.ok(web.bytes.equals(Buffer.from(WEB_MOCKUP)), 'the native mockup is served as its bytes');
      assert.equal(new URL(byPath[WEB_MOCKUP_PATH].href, 'http://127.0.0.1/').pathname, `/${WEB_MOCKUP_PATH}`, 'the index links the native mockup to its own path');

      // (a) and (b): the frame path and the mockup's own path.
      const framePath = new URL(byPath[ANDROID_MOCKUP_PATH].href ?? '', 'http://127.0.0.1/');
      const viaIndex = await rawRequest(server.port, 'GET', `${framePath.pathname}${framePath.search}`);
      assertFrame(viaIndex, { path: ANDROID_MOCKUP_PATH, mockup: ANDROID_MOCKUP, ...SIMULATES }, '(a) the frame path the index links');
      const direct = await rawRequest(server.port, 'GET', `/${ANDROID_MOCKUP_PATH}`);
      assertFrame(direct, { path: ANDROID_MOCKUP_PATH, mockup: ANDROID_MOCKUP, ...SIMULATES }, '(a) a direct request for the mockup\'s own path');
      assert.ok(!textOf(direct).includes('Reminders are off: notifications are not allowed.'), '(a) the frame does not carry the mockup\'s markup itself');
    } finally {
      await server.stop();
    }
  });

  test('(d) export: SIMULATIONS.txt names the simulated mockup with its target, form factor and layout, and not the native one, from the CLI and in the archive', async () => {
    const { fx, p } = await previewed();
    const dir = join(fx.root, 'm520-export');
    const out = cli(fx, ['design', 'export', '--project', p.id, '--revision', 'checkpoint', dir]);
    assert.equal(out.status, 0, `surety design export exits 0 (${out.stdout.slice(0, 300)} ${out.stderr.slice(0, 300)})`);
    const expected = [[ANDROID_MOCKUP_PATH, SIMULATES.target, SIMULATES.form_factor, SIMULATES.layout]];
    const text = readFileSync(join(dir, 'SIMULATIONS.txt'), 'utf8');
    assert.deepEqual(simulationRecords(text), expected, `the directory's SIMULATIONS.txt (SEAM.md §501) (${JSON.stringify(text)})`);
    assert.ok(!text.includes(WEB_MOCKUP_PATH), 'the native mockup is not named');
    const archive = await engineBytes(fx, `/v1/projects/${p.id}/design/export?revision=checkpoint`);
    assert.equal(archive.status, 200, `GET …/design/export (→ ${archive.status})`);
    const inArchive = untar(archive.bytes)['SIMULATIONS.txt']?.toString('utf8') ?? '';
    assert.deepEqual(simulationRecords(inArchive), expected, `the archive's SIMULATIONS.txt (${JSON.stringify(inArchive)})`);
  });

  test('(e) an HTML mockup of an android screen not declared simulated_html; a simulated_html with no simulates: DESIGN_SIMULATION_UNDECLARED each, naming the target and the mockup', async () => {
    const fx = await scriptedEngine(shared.context);
    const { p } = await toPublished(fx, { policy: BEFORE_BUILD, name: 'pantry-undeclared' });
    scriptVariant(fx, p);
    const model = designModel(inventoryOf(p));
    const cases = [
      { name: 'the valid design', model },
      {
        name: 'static_html on android',
        model: variantOf(model, (m) => {
          mockupEntry(m, 'android').kind = 'static_html';
          delete mockupEntry(m, 'android').simulates;
        }),
      },
      { name: 'simulated_html without simulates', model: variantOf(model, (m) => delete mockupEntry(m, 'android').simulates) },
    ];
    const out = await checkSession(fx, p.id, cases);
    const saves = Object.fromEntries(out.saves.map((s) => [s.name, s.res]));
    assertPassed(saves['the valid design'], 'the valid design (the control)');
    const path = mockupEntry(model, 'android').path;
    assertReason(saves['static_html on android'], 'DESIGN_SIMULATION_UNDECLARED', ['android', path], 'an HTML mockup of an android screen declared static_html (D7 §5.4)');
    assertReason(saves['simulated_html without simulates'], 'DESIGN_SIMULATION_UNDECLARED', ['android', path], 'a simulated_html mockup that does not say what it simulates (D7 §5.6 clause 6)');
  });

  test('(f) a review verdict observed_on simulation, confirmed by the owner: recorded, never counted as native evidence; the android human test stays pending; observed on an emulator and confirmed: owner accepted', async () => {
    const fx = await scriptedEngine(shared.context);
    const { p } = await toPublished(fx, { policy: BEFORE_BUILD, name: 'pantry-review' });
    const ctx = scriptVariant(fx, p);
    await designerSession(fx, p.id, [{ files: validDesign(p), say: 'Draw Pantry for the web and Android.' }], { close: {} });
    await approveBatch(fx, ctx, await untilBatch(fx, ctx));
    const humanTest = async (target) => ((await readDesign(fx, p.id)).human_tests ?? []).find((h) => h.target === target) ?? null;
    const androidKey = HUMAN_TEST_KEYS.android;
    await pump(fx, ctx, async () => ((await humanTest('android')) ? true : undefined), { what: 'the design\'s human tests on GET …/design', max: 40 });
    assert.equal((await humanTest('android')).status, 'pending', 'the android human test pending before any review');

    // One owner-invoked review of the android target (D7 §10.5; SEAM.md §502): its verdict written by the role, confirmed by the owner.
    const review = async (n, observed_on) => {
      const build_ref = `pantry-android 0.1.${n} (build ${n + 6})`;
      const opened = await fx.engine.post(`/v1/projects/${p.id}/design/reviews`, { target: 'android', build_ref });
      assert.equal(opened.status, 201, `POST …/design/reviews opens the review (SEAM.md §502) (→ ${opened.status} ${opened.text?.slice(0, 400)})`);
      const run = opened.body?.run;
      assert.match(run?.id ?? '', /^run_/, `naming its session (${opened.text?.slice(0, 400)})`);
      const file = `${JSON.stringify({ design_version: 1, subject: { kind: 'owner_build', target: 'android', build_ref }, screens: [{ target: 'android', key: 'S2', verdict: 'matches', observed_on, evidence: [], deltas: [] }], revised_design: false, first_design: false }, null, 2)}\n`;
      scriptTurns(fx, run.id, [{ steps: [step.write(`.surety/design/reviews/review-${n}.json`, file), step.result(turnResult({ reply: `S2 matches, as the owner saw it on the ${observed_on}.`, artifact_changed: true, done: true }))] }]);
      await sayAndSettle(fx, p.id, run.id, `S2 matches what I saw on the ${observed_on}.`);
      await saveSession(fx, p.id, run.id);
      await closeSession(fx, p.id, run.id);
      const verdicts = await pump(fx, ctx, () => openOfKind(fx.home, p.id, 'design_verdicts').at(-1), { what: 'design_verdicts', max: 20 });
      const confirmed = await answerWith(fx, p.id, verdicts, 'confirm');
      assert.equal(confirmed.status, 200, `design_verdicts answered confirm (${confirmed.text})`);
      return designReviews(fx.home, p.id).at(-1);
    };

    const simulated = await review(1, 'simulation');
    const v = simulated?.verdicts?.find((x) => x.target === 'android' && x.screen === 'S2');
    assert.deepEqual([v?.verdict, v?.observed_on, v?.status], ['matches', 'simulation', 'confirmed'], `the verdict recorded as the owner confirmed it (${JSON.stringify(simulated?.verdicts)})`);
    assert.deepEqual([simulated?.subject?.kind, simulated?.subject?.target], ['owner_build', 'android'], `the review's subject (${JSON.stringify(simulated?.subject)})`);
    assert.equal((await humanTest('android')).status, 'pending', 'GET …/design: the android human test stays pending (a simulation is never native evidence, D7 §10.2; Q4)');
    const owed = ((await readPace(fx, p.id)).human_tests ?? []).find((h) => h.requirement === androidKey);
    assert.equal(owed?.status, 'owed', `the pace read: the android human test (${androidKey}) still owed (${JSON.stringify(owed)})`);

    const emulated = await review(2, 'emulator');
    assert.equal(emulated?.verdicts?.find((x) => x.target === 'android')?.observed_on, 'emulator');
    assert.equal((await humanTest('android')).status, 'owner_accepted', 'the control: a confirmed verdict observed on an emulator is owner accepted (D7 §10.3; Q4)');
  });
});
