// M522, placeholders that never block (slice 43; kernel lane). M6 plan
// §3.5 M522; D7 §6.2, §6.3, §6.7; Q8; SEAM.md §§484, 504, 506, 509.
//
// (a) inventory derivation for Pantry (web, android): a placeholder for
//     every default slot and variant of D7 §6.2's table (a labelled logo
//     block, an initials icon; a raster variant a flat PNG at its declared
//     size), provenance `engine_placeholder`, status `placeholder`,
//     deterministic from the project's name; a target added later (ios, by
//     an approved spec change and a later Architect revision): its slots get
//     theirs, the earlier placeholders unchanged byte for byte;
// (b) every effective slot a placeholder: design_ready, the UI stages'
//     dispatch, the phase gate and alpha_authorize each proceed, and no
//     asset status is read on the way (the release hook's condition counted
//     by caller, §509);
// (c) `assets_required_for: alpha`: refused, the range excludes Alpha;
// (d) a placeholder's bytes: byte-identical on regeneration in another home
//     for the same name, different for another name; valid by the header
//     checks (the test's own reading, and the engine's design check passing
//     a design over them).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { consume, decision } from './harness/decisions.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { getPolicy } from './harness/journal.mjs';
import { journeyContext, pump, specRevisions } from './harness/journey/drive.mjs';
import { postChange } from './harness/journey/review31b.mjs';
import { changedPaths } from './harness/repos.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { closeSession, openSession, saveSession, sayAndSettle, scriptTurns, turnThatWrites } from './harness/sessions.mjs';
import { ARCHITECTURE_MD, MANIFEST_PATH, MODULES_JSON, REQUIREMENTS, specText } from './harness/design/reference.mjs';
import { designEvents, designScripts, inventoryOf, manifestOf, openOfKind, revisionsOfKind, scriptBuilders, stageRow, toPublished } from './harness/design/drive.mjs';
import { BEFORE_BUILD, assertPassed, checkSession, designModel } from './harness/design/check41.mjs';
import {
  ALLOWED_CALLERS,
  DEFAULT_VARIANTS,
  blobBytes,
  headOf,
  hookEvaluated,
  hookEvaluations,
  isSvg,
  pngHeader,
  refuseClose,
  sha256hex,
  svgPassive,
  toAlphaWithPlaceholders,
  variantBytes,
} from './harness/design/assets43.mjs';

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const kindsOf = (manifest) => Object.fromEntries((manifest.slots ?? []).map((s) => [s.kind, s]));
const variantNames = (slot) => (slot?.variants ?? []).map((v) => v.name).sort();
// The initials of a name (SEAM.md §506): the first letter of each of its first two words, upper case.
const initialsOf = (name) => name.split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

// Every placeholder of a manifest: valid by its header as the test reads it.
function assertPlaceholderFiles(p, manifest, name, what) {
  for (const slot of manifest.slots) {
    if (slot.status !== 'placeholder') continue;
    assert.equal(slot.provenance, 'engine_placeholder', `${what}: ${slot.key} provenance engine_placeholder`);
    for (const v of slot.variants) {
      const bytes = variantBytes(p, v);
      assert.ok(bytes, `${what}: ${slot.key} ${v.name}: its file ${v.file} committed`);
      assert.match(v.digest ?? '', /^[0-9a-f]{64}$/, `${what}: ${slot.key} ${v.name}: a digest`);
      assert.equal(sha256hex(bytes), v.digest, `${what}: ${slot.key} ${v.name}: the digest is the file's SHA-256`);
      if (v.format === 'svg') {
        assert.ok(isSvg(bytes), `${what}: ${slot.key} ${v.name}: an SVG root`);
        const text = bytes.toString('utf8');
        assert.ok(svgPassive(text), `${what}: ${slot.key} ${v.name}: no script, event attribute or external reference`);
        if (slot.kind === 'logo') {
          assert.ok(text.toLowerCase().includes(name.toLowerCase()), `${what}: ${slot.key} ${v.name}: a labelled logo block naming ${name} (D7 §6.3)`);
          assert.match(text, /PLACEHOLDER/, `${what}: ${slot.key} ${v.name}: labelled PLACEHOLDER`);
        } else assert.ok(new RegExp(`>\\s*${initialsOf(name)}\\s*<`).test(text), `${what}: ${slot.key} ${v.name}: an initials icon (${initialsOf(name)}) (${text.slice(0, 300)})`);
      } else {
        assert.equal(v.format, 'png', `${what}: ${slot.key} ${v.name}: a raster placeholder is a flat PNG (D7 §6.3)`);
        const h = pngHeader(bytes);
        assert.ok(h, `${what}: ${slot.key} ${v.name}: a PNG signature and IHDR`);
        assert.ok(v.size, `${what}: ${slot.key} ${v.name}: a raster variant declares its size (B.16)`);
        assert.deepEqual([h.w, h.h], [v.size.w, v.size.h], `${what}: ${slot.key} ${v.name}: at its declared size`);
      }
    }
  }
}

describe('M522 placeholders that never block', () => {
  test('(a), (d) a placeholder for every default slot and variant of Pantry\'s targets, deterministic from the name and valid by its header; regenerated byte-identical in another home, different for another name; a design over them passes the check', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await toPublished(fx, { policy: BEFORE_BUILD });
    designScripts(fx);
    const manifest = manifestOf(p);
    const by = kindsOf(manifest);
    assert.deepEqual(Object.keys(by).sort(), ['app_icon', 'favicon', 'logo'], `the default slots of web and android (D7 §6.2) (${Object.keys(by)})`);
    assert.deepEqual(variantNames(by.logo), [...DEFAULT_VARIANTS.logo].sort(), 'the logo\'s five variants');
    assert.deepEqual(variantNames(by.favicon), [...DEFAULT_VARIANTS.favicon].sort(), 'the favicon\'s default');
    assert.deepEqual(variantNames(by.app_icon), [...DEFAULT_VARIANTS.app_icon_android].sort(), 'android\'s app_icon with its adaptive variants');
    assert.deepEqual([...by.logo.platforms].sort(), ['android', 'web'], 'the logo on both targets');
    assert.deepEqual(by.favicon.platforms, ['web']);
    assert.deepEqual(by.app_icon.platforms, ['android']);
    for (const s of manifest.slots) {
      assert.deepEqual([s.key, s.status, s.provenance, s.slot_version], [s.kind, 'placeholder', 'engine_placeholder', 1], `${s.key}: an engine placeholder at slot_version 1 (SEAM.md §484)`);
      assert.ok(s.variants.every((v) => v.file), `${s.key}: every variant has its placeholder file`);
    }
    assertPlaceholderFiles(p, manifest, 'pantry', 'pantry');

    // (d) Regenerated in another home for the same name: byte-identical.
    const fx2 = await scriptedEngine(t);
    const p2 = (await toPublished(fx2, { policy: BEFORE_BUILD })).p;
    const manifest2 = manifestOf(p2);
    assert.deepEqual(manifest2, manifest, 'the same name derives the same manifest in another home');
    for (const s of manifest.slots) for (const v of s.variants) assert.ok(variantBytes(p2, variantOf2(manifest2, s.key, v.name)).equals(variantBytes(p, v)), `${s.key} ${v.name}: byte-identical on regeneration`);
    // Another name: the logo block names it; the bytes differ.
    const other = (await toPublished(fx2, { policy: BEFORE_BUILD, name: 'larder-box' })).p;
    const otherManifest = manifestOf(other);
    assertPlaceholderFiles(other, otherManifest, 'larder-box', 'larder-box');
    const full = (m, pp) => variantBytes(pp, m.slots.find((s) => s.kind === 'logo').variants.find((v) => v.name === 'full'));
    assert.ok(!full(otherManifest, other).equals(full(manifest2, p2)), 'another name, another logo block (deterministic from the name)');

    // (d) The engine's own check admits a design over its placeholders.
    const out = await checkSession(fx, p.id, [{ name: 'the design over the placeholders', model: designModel(inventoryOf(p)) }]);
    assertPassed(out.saves[0].res, 'a design naming the engine\'s placeholders');
    await refuseClose(fx, p.id, out.run.id);
  });

  test('(a) a target added later (ios): its slots get their placeholders in an engine intent revision; the earlier placeholders unchanged byte for byte', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await toPublished(fx, { policy: BEFORE_BUILD, name: 'pantry-ios' });
    designScripts(fx);
    scriptBuilders(fx, p.id);
    const ctx = journeyContext(fx, p, { lane: 'kernel' });
    ctx.answerKinds = ['check_correction_unclassifiable', 'check_correction_tightening', 'check_correction_loosening', 'plan_approval', 'architecture_approval'];
    const before = manifestOf(p);
    const beforeHead = headOf(p);
    // The spec change: ios among the targets, R3 on android and ios (D7 §4.1; Q7: targets in the approved spec).
    const v2 = specText({
      version: 2,
      targets: '**Targets:** web, android, ios',
      requirements: REQUIREMENTS.map((r) => (r.key === 'R3' ? { ...r, surface: 'ui (android, ios)' } : r)),
      changeLog: [{ version: 2, date: '2026-10-17', change: 'The pantry on iOS too', by: 'Sean' }],
    });
    fx.scripted.kindScript('spec_change', roleThat([step.write('.surety/spec/spec.md', v2)], { changes: [{ key: 'R3', kind: 'text_changed', reason: 'the app on iOS as well' }] }));
    await postChange(fx, ctx, 'Ship the mobile app on iOS as well.');
    const change = await pump(fx, ctx, () => openOfKind(fx.home, p.id, 'spec_change').at(-1), { what: 'the spec change adding ios', max: 40 });
    await consume(fx, p.id, change, 'approve');
    // Nothing in flight before the Architect session opens (its save refuses a moved head, E147 item 4):
    // spec version 2 applied, the API stage verified, the UI stages held for the design.
    await pump(fx, ctx, () => (specRevisions(fx.home, p.id).some((r) => r.version === 2) && stageRow(fx.home, p.id, 1)?.status === 'verified' ? true : undefined), { what: 'spec version 2 applied and the API stage verified', max: 80 });
    // A later Architect session: the mobile module serves ios too.
    const modules = structuredClone(MODULES_JSON);
    modules.modules.find((m) => m.name === 'mobile').targets.push({ target: 'ios', ui_technology: 'react_native', form_factors: ['phone'] });
    const run = await openSession(fx, p.id, 'architect');
    scriptTurns(fx, run.id, [turnThatWrites({ '.surety/architecture/modules.json': json(modules), '.surety/architecture/architecture.md': `${ARCHITECTURE_MD}\nThe mobile app also targets iOS (React Native).\n` }, { reply: 'mobile serves ios as well.', done: true })]);
    await sayAndSettle(fx, p.id, run.id, 'The mobile app ships on iOS too.');
    await saveSession(fx, p.id, run.id);
    const closed = await closeSession(fx, p.id, run.id);
    for (const d of closed.decisions ?? []) await consume(fx, p.id, decision(fx.home, d.id), 'approve');
    const inventory = await pump(fx, ctx, () => {
      const inv = inventoryOf(p);
      return (inv.targets ?? []).some((x) => x.target === 'ios') ? inv : undefined;
    }, { what: 'the inventory re-derived with ios', max: 40 });
    assert.ok(inventory.targets.some((x) => x.target === 'ios' && x.module === 'mobile'), 'ios served by mobile');
    const after_ = manifestOf(p);
    const by = kindsOf(after_);
    assert.ok(by.splash, `ios's splash slot (D7 §6.2) (${Object.keys(by)})`);
    assert.deepEqual([by.splash.status, by.splash.provenance, by.splash.platforms], ['placeholder', 'engine_placeholder', ['ios']], 'an engine placeholder for ios');
    assert.deepEqual(variantNames(by.splash), [...DEFAULT_VARIANTS.splash].sort(), 'its default variant');
    assert.ok(by.app_icon.platforms.includes('ios') && by.logo.platforms.includes('ios'), `app_icon and logo on ios too (${JSON.stringify([by.app_icon.platforms, by.logo.platforms])})`);
    assertPlaceholderFiles(p, after_, 'pantry-ios', 'after ios');
    for (const s of before.slots) for (const v of s.variants) {
      const now = variantOf2(after_, s.key, v.name);
      assert.ok(now, `${s.key} ${v.name}: still in the manifest`);
      assert.deepEqual([now.file, now.digest], [v.file, v.digest], `${s.key} ${v.name}: unchanged`);
      assert.ok(variantBytes(p, now).equals(blobBytes(p.repo.path, beforeHead, `.surety/design/${v.file}`)), `${s.key} ${v.name}: byte for byte`);
    }
    // The new placeholders in an engine intent revision (no run made it), touching .surety/design/ only.
    const splash = by.splash.variants[0];
    const carrying = revisionsOfKind(fx.home, p.id, 'intent').filter((r) => r.created_by_run === null && r.parent_sha && changedPaths(p.repo.path, r.parent_sha, r.sha)[`.surety/design/${splash.file}`]);
    assert.equal(carrying.length, 1, 'one engine intent revision commits the new placeholder');
    const changed = changedPaths(p.repo.path, carrying[0].parent_sha, carrying[0].sha);
    assert.ok(changed[MANIFEST_PATH] && Object.keys(changed).every((x) => x.startsWith('.surety/design/')), `with the manifest, under .surety/design/ only (${Object.keys(changed).join(', ')})`);
  });

  test('(b) every effective slot a placeholder: design_ready, dispatch, the phase gate and alpha_authorize proceed; no asset status read on the way (counted)', async (t) => {
    const fx = await scriptedEngine(t);
    const { p, marks } = await toAlphaWithPlaceholders(fx);
    assert.ok(marks.readyAt, 'design_ready_at set with every slot a placeholder');
    assert.equal(designEvents(fx.home, 'design.ready', p.id).length, 1, 'design.ready');
    assert.ok(marks.uiLaunched, 'both UI stages dispatched');
    assert.ok(marks.phase.some((e) => e.outcome === 'satisfied'), `the phase gate satisfied (${JSON.stringify(marks.phase.map((e) => [e.outcome, e.reasons]))})`);
    assert.ok(marks.alphaAuthorize.some((e) => e.outcome === 'satisfied'), `alpha_authorize satisfied (${JSON.stringify(marks.alphaAuthorize.map((e) => [e.outcome, e.reasons]))})`);
    assert.equal(marks.deployed.progress, 'alpha_deployed', 'the candidate alpha_deployed');
    for (const e of [...marks.phase, ...marks.alphaAuthorize]) assert.ok(!JSON.stringify(e.reasons ?? []).includes('ASSETS_NOT_APPROVED'), 'no gate names an asset');
    // The counter is live: one evaluation through the seam is counted as the harness's.
    await hookEvaluated(fx, { project: p.id, tier: 'live' }, 'the seam\'s own evaluation');
    const evaluations = await hookEvaluations(fx);
    assert.ok(evaluations.some((e) => e.caller === 'harness' && e.project === p.id), `the seam's evaluation counted (${JSON.stringify(evaluations)})`);
    const others = evaluations.filter((e) => !ALLOWED_CALLERS.includes(e.caller));
    assert.deepEqual(others, [], 'no asset status read by readiness, dispatch, a gate or alpha_authorize (D7 §6.7)');
  });

  test('(c) assets_required_for: alpha is refused; the range excludes Alpha', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await toPublished(fx, { policy: BEFORE_BUILD, name: 'pantry-range' });
    const before = await getPolicy(fx.engine, p.id);
    assert.equal(before.effective?.assets_required_for, 'live', `the default is live (D7 A.7; Q8) (${JSON.stringify(before.effective)})`);
    const res = await fx.engine.post(`/v1/projects/${p.id}/policy`, { assets_required_for: 'alpha' });
    assertRefused(res, 400, 'invalid_value', 'assets_required_for: alpha');
    assert.ok(JSON.stringify(res.body).includes('assets_required_for'), `naming the key (${res.text})`);
    const now = await getPolicy(fx.engine, p.id);
    assert.deepEqual([now.revision, now.effective?.assets_required_for], [before.revision, 'live'], 'nothing changed');
  });
});

function variantOf2(manifest, key, name) {
  return (manifest.slots.find((s) => s.key === key)?.variants ?? []).find((v) => v.name === name) ?? null;
}
