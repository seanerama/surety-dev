// M523, the asset manifest's versions, owner files and asset-only
// revisions (slice 43; kernel lane). M6 plan §3.5 M523; D7 §6.1, §6.3,
// §6.4, §6.6; B.16; A.4, A.6, A.8; SEAM.md §§504, 505, 507.
//
// On one Pantry, one Designer session of faults, each save the whole design
// with one change to its asset manifest (the valid design first, as the
// control):
// (a) a slot's file changed without a slot_version increment; the manifest
//     changed without a version increment: DESIGN_ASSET_VERSION_INVALID;
// (b) a save marking a slot `approved`: DESIGN_ASSET_STATUS_FORGED;
// (f) `packaging` entries `recorded` and `not_checkable_yet`: recorded;
//     `checked_pass`: refused by the schema;
// (g) a banner without its placement; a logo without alt text; a platform
//     outside the inventory; a selected slot missing; a variant with no
//     file: DESIGN_ASSET_PLACEMENT_MISSING, _ALT_MISSING, _PLATFORM_UNKNOWN,
//     _SLOT_MISSING, _FILE_MISSING.
// On another Pantry, carried through its batch with the logo held:
// (c) `surety design asset add` with a valid file: an engine `intent`
//     revision on .surety/design/assets/, `proposed`, provenance `owner`,
//     `design.asset_added`; with an active SVG: refused
//     `design_asset_invalid` naming its reason, nothing committed;
// (d) `surety design assets submit`: the check run; an asset-only
//     design_approval with no consolidated spec change and no criteria
//     blocker, for the pending proposals, the held logo included; no screen
//     stale; readiness unchanged; a slot held again stays `proposed` until a
//     later approval;
// (e) the slots' history: every entry kept, the placeholder's recoverable.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { consume } from './harness/decisions.mjs';
import { journeyContext, pump } from './harness/journey/drive.mjs';
import { changedPaths } from './harness/repos.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { LOGO_SVG } from './harness/design/reference.mjs';
import {
  answerWith,
  batchOf,
  designEvents,
  designRevisions,
  designScripts,
  designerSession,
  effectiveAssets,
  inventoryOf,
  manifestOf,
  revisionsOfKind,
  scriptBuilders,
  stageWork,
  toPublished,
  validDesign,
} from './harness/design/drive.mjs';
import { BEFORE_BUILD, assertPassed, assertReason, designModel } from './harness/design/check41.mjs';
import {
  ACTIVE_SVG,
  M43,
  addSlot,
  assertReasonAny,
  assetAdd,
  assetSession,
  assetsSubmit,
  blobBytes,
  designAssetsOf,
  headOf,
  json,
  openApproval,
  passiveSvg,
  pngOf,
  propose,
  refuseClose,
  sha256hex,
  slotOf,
  variantOf,
} from './harness/design/assets43.mjs';

const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const OWNER = ['check_correction_unclassifiable', 'check_correction_tightening', 'check_correction_loosening', 'plan_approval'];
const LOGO_FILE = `${M43}/logo-full.svg`;
const BANNER_SVG = passiveSvg(1200, 400, 'Pantry, the household list');
const BANNER = Object.freeze({
  key: 'banner',
  kind: 'banner',
  purpose: 'the web page\'s hero',
  platforms: ['web'],
  placement: 'website_hero',
  variants: [{ name: 'default', format: 'svg', transparency: 'any', file: `${M43}/banner.svg`, digest: sha256hex(BANNER_SVG) }],
  alt_text: 'Pantry: what is in the cupboard',
});
const PACKAGING = Object.freeze([
  { target: 'android', slot: 'app_icon', requirement: 'adaptive icon layers', guidance: { source: 'the Android developer guide on adaptive icons', read_on: '2026-10-16' }, status: 'recorded' },
  { target: 'web', requirement: 'a favicon set', guidance: { source: 'the browsers\' favicon guidance', read_on: '2026-10-16' }, status: 'not_checkable_yet' },
]);

describe('M523 the asset manifest\'s versions, owner files and asset-only revisions', () => {
  test('(a), (b), (f), (g) one fault session over the asset manifest, the valid design with a logo proposal and a banner first', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await toPublished(fx, { policy: BEFORE_BUILD });
    designScripts(fx);
    const base = manifestOf(p);
    const model = designModel(inventoryOf(p));
    model.design.selection.slots.push({ kind: 'banner', variants: ['default'] });
    // The valid manifest: the logo's full variant proposed, a banner added.
    const proposed = propose(base, [{ slot: 'logo', variant: 'full', format: 'svg', transparency: 'any', file: LOGO_FILE, bytes: LOGO_SVG }]);
    const valid = addSlot(proposed.manifest, BANNER);
    const assets = { ...proposed.files, [`${M43}/banner.svg`]: BANNER_SVG };
    const withManifest = (m, extra = {}) => ({ ...model, extra: { 'assets/manifest.json': json(m), ...assets, ...extra } });
    const edit = (fn) => {
      const m = structuredClone(valid);
      fn(m);
      return withManifest(m);
    };
    const logo = (m) => slotOf(m, 'logo');
    const banner = (m) => slotOf(m, 'banner');
    const cases = [
      { name: 'the valid manifest: a logo proposal and a banner', model: withManifest(valid) },
      { name: 'the logo\'s file changed, its slot_version not incremented', model: edit((m) => { logo(m).slot_version = slotOf(base, 'logo').slot_version; logo(m).history = logo(m).history.slice(0, -1); }), code: 'DESIGN_ASSET_VERSION_INVALID', names: ['logo'] },
      { name: 'the manifest changed, its version not incremented', model: edit((m) => (m.version = base.version)), code: 'DESIGN_ASSET_VERSION_INVALID', names: [] },
      { name: 'the logo marked approved by the save', model: edit((m) => (logo(m).status = 'approved')), code: 'DESIGN_ASSET_STATUS_FORGED', names: ['logo'] },
      { name: 'packaging recorded and not_checkable_yet', model: edit((m) => (m.packaging = structuredClone(PACKAGING))) },
      { name: 'packaging checked_pass', model: edit((m) => (m.packaging = [{ ...structuredClone(PACKAGING[0]), status: 'checked_pass' }])), code: 'DESIGN_SCHEMA_INVALID', anyOf: ['checked_pass', 'packaging'] },
      { name: 'a banner without its placement', model: edit((m) => delete banner(m).placement), code: 'DESIGN_ASSET_PLACEMENT_MISSING', names: ['banner'] },
      { name: 'a logo without alt text', model: edit((m) => delete logo(m).alt_text), code: 'DESIGN_ASSET_ALT_MISSING', names: ['logo'] },
      { name: 'a banner on ios, a target the inventory lacks', model: edit((m) => (banner(m).platforms = ['web', 'ios'])), code: 'DESIGN_ASSET_PLATFORM_UNKNOWN', names: ['banner', 'ios'] },
      { name: 'the selected favicon missing from the manifest', model: edit((m) => (m.slots = m.slots.filter((s) => s.kind !== 'favicon'))), code: 'DESIGN_ASSET_SLOT_MISSING', names: ['favicon'] },
      { name: 'the logo\'s full variant with no file', model: edit((m) => { const v = variantOf(logo(m), 'full'); delete v.file; delete v.digest; }), code: 'DESIGN_ASSET_FILE_MISSING', names: ['logo', 'full'] },
      { name: 'the valid manifest again', model: withManifest(valid) },
    ];
    const out = await assetSession(fx, p.id, cases);
    const save = (name) => out.saves.find((s) => s.name === name).res;
    assertPassed(save(cases[0].name), 'the control: a logo proposal and a banner');
    assertPassed(save('packaging recorded and not_checkable_yet'), '(f) packaging recorded and not_checkable_yet (D7 §6.6)');
    for (const c of cases.filter((x) => x.code)) {
      if (c.anyOf) assertReasonAny(save(c.name), c.code, c.anyOf, c.name);
      else assertReason(save(c.name), c.code, c.names, c.name);
    }
    assertPassed(out.saves.at(-1).res, 'the valid manifest, saved last');
    await refuseClose(fx, p.id, out.run.id);
  });

  test('(c), (d), (e) owner files, asset-only revisions and the slots\' history, after a batch approved with the logo held', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await toPublished(fx, { policy: BEFORE_BUILD, name: 'pantry-owner' });
    designScripts(fx);
    scriptBuilders(fx, p.id);
    const ctx = journeyContext(fx, p, { lane: 'kernel' });
    ctx.answerKinds = [...OWNER];
    const placeholders = manifestOf(p);
    const derivation = headOf(p);
    await designerSession(fx, p.id, [{ files: validDesign(p), say: 'Draw Pantry.', result: { done: true } }]);
    const batch = await pump(fx, ctx, () => (batchOf(fx.home, p.id)?.spec_change ? batchOf(fx.home, p.id) : undefined), { what: 'the batch', max: 40 });
    assert.equal((await answerWith(fx, p.id, batch.design_approval, 'approve', { assets_held: ['logo'] })).status, 200, 'approve with the logo held');
    await consume(fx, p.id, batch.spec_change, 'approve');
    const v1 = await pump(fx, ctx, () => designRevisions(fx.home, p.id).find((r) => r.status === 'approved' && r.ready_at) ?? undefined, { what: 'design revision 1 approved and ready', max: 80 });
    const readyEvents = designEvents(fx.home, 'design.ready', p.id).length;
    const screensBefore = rows(fx.home, 'SELECT "key", "target", "status" FROM "design_screens" WHERE "design_revision" = ? ORDER BY "key"', v1.id);
    const afterBatch = manifestOf(p);

    // (c) An owner's file failing its header checks: refused, nothing committed.
    const headBefore = headOf(p);
    const intentsBefore = revisionsOfKind(fx.home, p.id, 'intent').length;
    const bad = assetAdd(fx, p.id, 'logo', 'full', 'active.svg', ACTIVE_SVG.script);
    assert.equal(bad.status, 1, `surety design asset add with an active SVG exits 1 (${bad.stdout.slice(0, 400)} ${bad.stderr.slice(0, 400)})`);
    assert.match(`${bad.stdout}${bad.stderr}`, /design_asset_invalid/, 'refused design_asset_invalid (D7 A.6)');
    assert.match(`${bad.stdout}${bad.stderr}`, /DESIGN_ASSET_SVG_ACTIVE/, 'with its reason');
    assert.equal(headOf(p), headBefore, 'nothing committed');
    assert.equal(revisionsOfKind(fx.home, p.id, 'intent').length, intentsBefore, 'no revision');

    // (c) A valid owner file for the favicon, in the variant's declared format.
    const fav = variantOf(slotOf(afterBatch, 'favicon'), 'default');
    const ownerBytes = fav.format === 'png' ? pngOf(fav.size?.w ?? 48, fav.size?.h ?? 48) : Buffer.from(passiveSvg(48, 48, 'P'));
    const added = assetAdd(fx, p.id, 'favicon', 'default', `owner-favicon.${fav.format}`, ownerBytes);
    assert.equal(added.status, 0, `surety design asset add exits 0 (${added.stdout.slice(0, 400)} ${added.stderr.slice(0, 400)})`);
    assert.notEqual(headOf(p), headBefore, 'committed');
    const carrying = revisionsOfKind(fx.home, p.id, 'intent').filter((r) => r.created_by_run === null && r.sha === headOf(p));
    assert.equal(carrying.length, 1, 'as an engine intent revision (D1 §7.8)');
    const changed = Object.keys(changedPaths(p.repo.path, carrying[0].parent_sha, carrying[0].sha));
    assert.ok(changed.length > 0 && changed.every((x) => x.startsWith('.surety/design/assets/')), `on .surety/design/assets/ only (${changed.join(', ')})`);
    const owned = slotOf(manifestOf(p), 'favicon');
    assert.deepEqual([owned.status, owned.provenance, owned.slot_version], ['proposed', 'owner', slotOf(afterBatch, 'favicon').slot_version + 1], `proposed by the owner, its slot_version incremented (${JSON.stringify(owned)})`);
    assert.equal(variantOf(owned, 'default').digest, sha256hex(ownerBytes), 'the owner\'s file by its digest');
    assert.ok(designEvents(fx.home, 'design.asset_added', p.id).length >= 1, 'design.asset_added');

    // (d) Submit: the asset-only approval for the pending proposals, the held logo included.
    const checksBefore = designEvents(fx.home, 'design.checked', p.id).length;
    const submitted = assetsSubmit(fx, p.id);
    assert.equal(submitted.status, 0, `surety design assets submit exits 0 (${submitted.stdout.slice(0, 400)} ${submitted.stderr.slice(0, 400)})`);
    const approval = await pump(fx, ctx, () => openApproval(fx.home, p.id) ?? undefined, { what: 'the asset-only design_approval', max: 20 });
    const revision = designRevisions(fx.home, p.id).find((r) => r.id === approval.subject_id) ?? designRevisions(fx.home, p.id).at(-1);
    assert.equal(revision.scope, 'asset_only', `an asset-only revision (A.2) (${JSON.stringify({ id: revision.id, scope: revision.scope, status: revision.status })})`);
    assert.ok(revision.design_check, 'its design check recorded');
    assert.equal(rows(fx.home, 'SELECT "outcome" FROM "design_checks" WHERE "id" = ?', revision.design_check)[0]?.outcome, 'passed', 'and passed');
    assert.ok(designEvents(fx.home, 'design.checked', p.id).length > checksBefore, 'the check run (design.checked)');
    const specChanges = approval.batch_key ? rows(fx.home, 'SELECT * FROM "decisions" WHERE "project" = ? AND "batch_key" = ? AND "kind" = \'spec_change\'', p.id, approval.batch_key) : [];
    assert.deepEqual(specChanges, [], 'no consolidated spec change');
    const approve = (approval.options ?? []).find((o) => o.key === 'approve');
    assert.ok(approve, `approve offered (${JSON.stringify(approval.options)})`);
    assert.deepEqual(approve.blockers ?? [], [], 'with no criteria blocker');
    const pending = designAssetsOf(fx.home, revision.id).filter((a) => a.status === 'proposed').map((a) => a.slot).sort();
    assert.deepEqual(pending, ['favicon', 'logo'], `the pending proposals, the held logo included (${JSON.stringify(designAssetsOf(fx.home, revision.id))})`);
    // Answered approve with the favicon held this time.
    assert.equal((await answerWith(fx, p.id, approval, 'approve', { assets_held: ['favicon'] })).status, 200, 'approved with the favicon held');
    const logoEff = await pump(fx, ctx, () => effectiveAssets(fx.home, p.id).find((e) => e.slot === 'logo' && e.variant === 'full' && e.source === 'approved') ?? undefined, { what: 'the logo effective', max: 20 });
    assert.equal(logoEff.digest, sha256hex(LOGO_SVG), 'the held logo now effective');
    const favEff = effectiveAssets(fx.home, p.id).find((e) => e.slot === 'favicon' && e.variant === 'default');
    assert.equal(favEff?.source, 'placeholder', `the favicon held: still the placeholder (${JSON.stringify(favEff)})`);
    const heldRow = designAssetsOf(fx.home, revision.id).find((a) => a.slot === 'favicon');
    assert.deepEqual([heldRow?.status, heldRow?.held], ['proposed', 1], 'the favicon stays proposed, held');
    assert.equal(designEvents(fx.home, 'design.stale', p.id).length, 0, 'no screen stale');
    assert.deepEqual(rows(fx.home, 'SELECT "key", "target", "status" FROM "design_screens" WHERE "design_revision" = ? ORDER BY "key"', v1.id), screensBefore, 'revision 1\'s screens unchanged');
    assert.equal(designRevisions(fx.home, p.id).find((r) => r.id === v1.id).ready_at, v1.ready_at, 'readiness unchanged');
    assert.equal(designEvents(fx.home, 'design.ready', p.id).length, readyEvents, 'no design.ready');
    for (const n of [2, 3]) assert.ok(!['design_pending', 'design_stale'].includes(stageWork(fx.home, p.id, n)?.held), `stage ${n} not held for design`);
    // A later submit: the held favicon approved.
    const again = assetsSubmit(fx, p.id);
    assert.equal(again.status, 0, `the second submit (${again.stdout.slice(0, 300)} ${again.stderr.slice(0, 300)})`);
    const second = await pump(fx, ctx, () => (openApproval(fx.home, p.id)?.id !== approval.id ? openApproval(fx.home, p.id) ?? undefined : undefined), { what: 'the second asset-only approval', max: 20 });
    assert.equal((await answerWith(fx, p.id, second, 'approve')).status, 200);
    const favNow = await pump(fx, ctx, () => effectiveAssets(fx.home, p.id).find((e) => e.slot === 'favicon' && e.variant === 'default' && e.source === 'approved') ?? undefined, { what: 'the favicon effective', max: 20 });
    assert.equal(favNow.digest, sha256hex(ownerBytes), 'the owner\'s favicon effective after the later approval');

    // (e) The history: every entry kept; the placeholder's entry recoverable.
    const latest = manifestOf(p);
    for (const key of ['logo', 'favicon']) {
      const was = slotOf(placeholders, key).history;
      const now = slotOf(latest, key).history ?? [];
      for (const h of was) assert.ok(now.some((x) => JSON.stringify(x) === JSON.stringify(h)), `${key}: the entry ${JSON.stringify(h)} kept (${JSON.stringify(now)})`);
      const first = now.find((x) => x.status === 'placeholder');
      assert.ok(first && first.design_version === 0 && first.slot_version === 1, `${key}: the placeholder's entry (SEAM.md §484)`);
      for (const f of first.files) {
        const v = variantOf(slotOf(placeholders, key), f.variant);
        assert.equal(sha256hex(blobBytes(p.repo.path, derivation, `.surety/design/${v.file}`)), f.digest, `${key} ${f.variant}: the placeholder recoverable from the derivation's commit by its digest`);
      }
      for (const h of now) assert.ok(['slot_version', 'design_version', 'status', 'files'].every((k) => k in h), `${key}: each entry {slot_version, design_version, status, files} (${JSON.stringify(h)})`);
    }
    assert.ok(slotOf(latest, 'logo').history.some((h) => h.files.some((f) => f.digest === sha256hex(LOGO_SVG))), 'the logo\'s proposal kept in its history');
    assert.ok(slotOf(latest, 'favicon').history.some((h) => h.files.some((f) => f.digest === sha256hex(ownerBytes))), 'the owner\'s favicon kept in its history');
  });
});
