// M520, simulation labelling through the preview's unit (slice 42; sandbox
// lane; its kernel half is `M520-simulation-labelling`). M6 plan §3.4 M520
// (a) to (c); D7 §5.4, §5.7; Q2; BS6 §4.1 rules 1, 2, 7, 8, 15, 21 to 24;
// SEAM.md §§488, 498 to 500; objection 135 (decided: the preview's unit
// named from its environment's id as D4 §9.3 names every unit).
//
// The reference project "Pantry" under `design: before_build` on real
// domains and the real `local_service` adapter; one Designer save, its
// checkpoint previewed on `surety-<h>-<env id>-g1.service` (`<env id>` the
// project's reserved `design-preview` row's), read
// through the operator relay (`surety env open design-preview`, 127.0.0.1):
//   (a) the simulated mockup's frame path (the index's link) and a direct
//       request for its own path: the engine's frame, each, never the
//       mockup's bytes bare;
//   (b) the frame: the fixed banner naming target, form factor and layout
//       and D7 §5.7's sentence, outside and before one iframe whose
//       `sandbox` is `allow-scripts`, its src the mockup;
//   (c) the index: every mockup with its target and capability; the native
//       mockup served as its bytes;
// then `--stop`, the teardown applied and nothing of the prefix left.
//
// SAFETY (BS6 §4.1; E64; SEAM.md §§257, 474, 488). The preview's unit is
// the engine's own under this home's hash, started and stopped only by the
// engine's commands and read by exact name or the list filtered to this
// home's prefix; the test acts on none itself but by `stopPreviewLeftovers`'
// exact name after the file (an `env_` name, so the fail-closed teardown and
// the guard see it too), and signals nothing but its own engine. The
// relay is opened by the test's own command on 127.0.0.1 and closed by the
// case that opened it. Mockups are read as bytes and markup, never rendered
// or run (rules 21, 22). The file ends with `operatorGuard`.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { assertOwnUnit, operatorGuard } from './harness/deploy/host.mjs';
import { qualifyByCommand } from './harness/deploy/qualify.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { journeyContext, pump } from './harness/journey/drive.mjs';
import { journeyEngine } from './harness/journey/project.mjs';
import { ANDROID_MOCKUP, ANDROID_MOCKUP_PATH, WEB_MOCKUP, WEB_MOCKUP_PATH } from './harness/design/reference.mjs';
import { cli, createPantry, designScripts, designerSession, pantryArchitect, pantrySpec, validDesign } from './harness/design/drive.mjs';
import { BEFORE_BUILD } from './harness/design/check41.mjs';
import {
  PREVIEW_ENV,
  assertFrame,
  deployedEvents,
  indexEntries,
  previewCgroups,
  previewEnvRow,
  previewOps,
  previewUnitName,
  previewUnits,
  quiesce,
  rawRequest,
  stopPreviewLeftovers,
  teardownApplied,
  textOf,
  tornDownEvents,
} from './harness/design/preview42.mjs';

const SIMULATES = Object.freeze({ target: 'android', form_factor: 'phone', layout: 'phone-portrait' });

describe('M520 simulation labelling through the preview\'s unit (sandbox lane)', () => {
  const shared = sharedFixture();
  let guard;
  const J = {};
  let stopped = null;
  const step = (name, fn) =>
    test(name, async () => {
      assert.equal(stopped, null, `the file did not reach this case: it stopped at ${stopped}`);
      try {
        await fn();
      } catch (err) {
        stopped = name.slice(0, 3);
        throw err;
      }
    });

  before(async () => {
    guard = operatorGuard();
    J.fx = await journeyEngine(shared.context, guard, { lane: 'project' });
    designScripts(J.fx);
  });
  after(async () => {
    const problems = [];
    try {
      const { fx, p } = J;
      if (fx && p) {
        if (J.relayOpen) cli(fx, ['env', 'close', PREVIEW_ENV, '--project', p.id]);
        const left = stopPreviewLeftovers(fx, p.id);
        if (left.length > 0) problems.push(`preview units left: ${left.join(', ')}`);
        const env = previewEnvRow(fx.home, p.id);
        if (env) for (const dir of previewCgroups(fx.home, env.id)) problems.push(`preview cgroup left: ${dir}`);
        await quiesce(fx, p.id).catch((err) => problems.push(`the project could not be quiesced: ${err.message}`));
      }
      guard.assertClean();
      assert.deepEqual(problems, [], 'the file left nothing of the preview');
    } finally {
      await shared.cleanup();
    }
  });

  step('(a) to (c) through the relay: the index lists each mockup with its target and capability; the native mockup is its bytes; the simulated mockup\'s frame path and its own path both answer the engine\'s labelled frame around a sandboxed iframe', async () => {
    const { fx } = J;
    const p = await createPantry(fx, { policy: BEFORE_BUILD });
    J.p = p;
    J.ctx = journeyContext(fx, p, { lane: 'project', tier: 'T2' });
    await pantrySpec(fx, p.id);
    const arch = await pantryArchitect(fx, p.id, p.repo);
    assert.equal(arch.closeRes.status, 200, `the Architect's close is accepted (${arch.closeRes.status} ${arch.closeRes.text?.slice(0, 400)})`);
    const q = qualifyByCommand(fx);
    assert.equal(q.status, 0, `surety qualify-adapter local_service exits 0 in the test's home (${q.stdout.slice(0, 300)} ${q.stderr.slice(0, 300)})`);
    const s = await designerSession(fx, p.id, [{ files: validDesign(p), say: 'Draw Pantry for the web and Android.' }], { close: null });
    assert.equal(s.saves[0]?.body?.design_check?.outcome, 'passed', `the reference design saved (${s.saves[0]?.text?.slice(0, 300)})`);
    const asked = cli(fx, ['design', 'preview', '--project', p.id, '--revision', 'checkpoint']);
    assert.equal(asked.status, 0, `surety design preview exits 0 (${asked.stdout.slice(0, 400)} ${asked.stderr.slice(0, 400)})`);
    const url = asked.body?.preview?.url;
    assert.match(url ?? '', /^http:\/\/127\.0\.0\.1:\d+\/$/, `the URL printed (${asked.stdout.slice(0, 300)})`);
    await pump(fx, J.ctx, () => deployedEvents(fx.home, p.id)[0], { what: 'the preview to be deployed', projectMs: 300_000 });
    J.env = previewEnvRow(fx.home, p.id);
    assert.ok(J.env, 'the reserved environment design-preview, a row of the project (SEAM.md §499)');
    const unit = previewUnitName(fx.home, J.env.id, 1);
    assertOwnUnit(fx.home, unit, 'the preview\'s unit');
    assert.deepEqual(previewUnits(fx.home, J.env.id).map((u) => u.unit), [unit], 'the preview\'s unit by exact name');
    const port = Number(new URL(url).port);
    const opened = cli(fx, ['env', 'open', PREVIEW_ENV, '--project', p.id]);
    assert.equal(opened.status, 0, `surety env open design-preview exits 0 (${opened.stdout.slice(0, 300)} ${opened.stderr.slice(0, 300)})`);
    J.relayOpen = true;
    try {
      // (c) the index.
      const index = await rawRequest(port, 'GET', '/');
      assert.equal(index.status, 200, `the index through the relay (→ ${index.status} ${index.error ?? ''})`);
      const entries = indexEntries(textOf(index));
      const byPath = Object.fromEntries(entries.map((e) => [e.path, e]));
      assert.deepEqual(Object.keys(byPath).sort(), [ANDROID_MOCKUP_PATH, WEB_MOCKUP_PATH].sort(), `every mockup listed (SEAM.md §500) (${JSON.stringify(entries)})`);
      assert.deepEqual([byPath[WEB_MOCKUP_PATH].target, byPath[WEB_MOCKUP_PATH].capability], ['web', 'native']);
      assert.deepEqual([byPath[ANDROID_MOCKUP_PATH].target, byPath[ANDROID_MOCKUP_PATH].capability], ['android', 'simulated']);
      const web = await rawRequest(port, 'GET', `/${WEB_MOCKUP_PATH}`);
      assert.ok(web.status === 200 && web.bytes.equals(Buffer.from(WEB_MOCKUP)), 'the native mockup is served as its bytes');
      // (a) and (b).
      const framePath = new URL(byPath[ANDROID_MOCKUP_PATH].href ?? '', 'http://127.0.0.1/');
      assertFrame(await rawRequest(port, 'GET', `${framePath.pathname}${framePath.search}`), { path: ANDROID_MOCKUP_PATH, mockup: ANDROID_MOCKUP, ...SIMULATES }, '(a) the frame path the index links');
      assertFrame(await rawRequest(port, 'GET', `/${ANDROID_MOCKUP_PATH}`), { path: ANDROID_MOCKUP_PATH, mockup: ANDROID_MOCKUP, ...SIMULATES }, '(a) a direct request for the mockup\'s own path');
    } finally {
      const closed = cli(fx, ['env', 'close', PREVIEW_ENV, '--project', p.id]);
      J.relayOpen = closed.status !== 0;
    }
  });

  step('(end) --stop: the teardown applied, nothing of the prefix left', async () => {
    const { fx, p } = J;
    const stop = cli(fx, ['design', 'preview', '--stop', '--project', p.id]);
    assert.equal(stop.status, 0, `surety design preview --stop exits 0 (${stop.stdout.slice(0, 300)} ${stop.stderr.slice(0, 300)})`);
    await pump(fx, J.ctx, () => (tornDownEvents(fx.home, p.id).length > 0 && previewUnits(fx.home, J.env.id).length === 0 ? true : undefined), { what: 'the preview to be torn down', projectMs: 300_000 });
    const [teardown] = previewOps(fx.home, p.id, 'teardown');
    assert.ok(teardown && teardownApplied(fx.home, teardown), 'the teardown applied (D4 §4.6)');
    assert.deepEqual(previewUnits(fx.home, J.env.id), [], 'no unit of the preview\'s prefix');
    assert.deepEqual(previewCgroups(fx.home, J.env.id), [], 'no cgroup of the preview\'s prefix');
  });
});
