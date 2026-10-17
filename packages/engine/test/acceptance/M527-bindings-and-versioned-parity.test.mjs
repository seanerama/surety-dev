// M527, bindings and versioned parity (slice 43; kernel lane). M6 plan
// §3.5 M527; D7 §6.5; G11, G14, G15; B.17; SEAM.md §§482, 487, 504, 508, 510.
//
// One Pantry, its design's logo proposal held at the first approval and its
// app_icon proposal approved there; one `asset_parity` criterion, on the
// web logo (R2.3); none on the app_icon:
// (c) a slot no stage had carried (the app_icon, approved before any stage
//     integrated): no work; the android stage's package holds its new version;
// (a) the web Builder's results: a binding to a path missing from the
//     integrated tree, then to a slot the package's effective set lacks,
//     then a `copy` and a `derived` binding; the android Builder's: a `copy`
//     whose file differs, then two copies: ASSET_BINDING_PATH_MISSING,
//     _UNKNOWN_SLOT and _MISMATCH each refusing the integration, the valid
//     ones recorded with their stage and revision (`design.asset_bound`);
// (g) GET …/design/bindings: each binding with its form and source version;
//     the favicon, carried by the web stage and bound by none, `unbound`;
// then the owner's favicon and app_icon files and the held logo approved by
// one asset-only approval, the engine killed at `design.effective_moved`:
// (b) the app_icon, bound, with no `asset_parity` criterion: one `fix`,
//     cause `asset_updated`, naming the slot, its old and new slot@version
//     and its bound path, on the latest integrated candidate;
// (c) the favicon, carried and unbound: the same work with no paths;
// (f) after the kill and recovery, a replayed answer and a restart before
//     the work is dispatched: one work item per slot, one obligation per
//     check reading it;
// (e) the parity check's earlier result records the slot@version it read;
//     an `asset_version_changed` obligation for it; that result, offered
//     again for the latest candidate, never counted for the new version;
// (d) the fix Builders rebinding: the paths updated, the `derived` one
//     re-derived, the bindings recorded anew, the old ones `superseded_by`.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { consume, untilKilled } from './harness/decisions.mjs';
import { waitFor } from './harness/engine.mjs';
import { armBarrier } from './harness/journal.mjs';
import { candidatesOfProject, journeyContext, pump } from './harness/journey/drive.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { runsOf, scriptedEngine, tick } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import {
  ANDROID_LOGO_PATH,
  APP_CSS,
  APP_JS,
  CORRECTION_FILES,
  CRITERIA,
  INDEX_HTML,
  LOGO_PATH,
  LOGO_SVG,
  PACKAGE_LOGO,
  PACKAGE_TOKENS_CSS,
  SERVER_MJS,
  WEB_LOGO_PATH,
  designFiles,
  specV2For,
} from './harness/design/reference.mjs';
import {
  answerWith,
  assetBindings,
  batchOf,
  designEvents,
  designRevisions,
  designScripts,
  designerSession,
  dumpedPackage,
  effectiveAssets,
  inventoryOf,
  manifestOf,
  readDesign,
  specChangeScriptFor,
  stageRow,
  stageWork,
  toPublished,
} from './harness/design/drive.mjs';
import { BEFORE_BUILD } from './harness/design/check41.mjs';
import { assetAdd, assetFixes, assetsSubmit, blobBytes, headOf, json, openApproval, passiveSvg, pngOf, propose, readBindings, resultsOfKey, sha256hex, slotOf, variantOf, versionObligations } from './harness/design/assets43.mjs';

const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const KINDS = ['check_correction_unclassifiable', 'check_correction_tightening', 'check_correction_loosening', 'plan_approval'];
const writes = (files) => Object.entries(files).map(([path, text]) => step.write(path, text));
const DERIVED_PATH = 'web/assets/logo-48.png';
const ICON_PATH = 'mobile/assets/icon.svg';
const FAVICON_PATH = 'web/favicon.svg';
const PACKAGE_ICON = 'design/assets/app_icon/default.svg';
const PACKAGE_FAVICON = 'design/assets/favicon/default.svg';
const ICON_A = passiveSvg(108, 108, 'P');
const ICON_B = passiveSvg(108, 108, 'Pa');
const FAVICON_OWNER = passiveSvg(48, 48, 'p');
const LOGO = sha256hex(LOGO_SVG);
// The design's criteria: tokens_only on R2 and asset_parity on the web logo only.
const CRITERIA_43 = Object.freeze({ ...CRITERIA, criteria: CRITERIA.criteria.filter((c) => !(c.kind === 'asset_parity' && c.targets.includes('android'))) });
const V2 = specV2For({ criteria: CRITERIA_43 });
const CORRECTION_43 = Object.fromEntries(Object.entries(CORRECTION_FILES).filter(([path]) => !path.includes('parity-android')));
const binding = (slot, variant, target, path, form = 'copy') => ({ slot, variant, target, path, form });
const reasonOf = (run) => `${run.outcome}/${run.reason_class}: ${run.reason_text ?? ''}`;

describe('M527 bindings and versioned parity', () => {
  test('(a) to (g) bindings validated and recorded; one asset_updated per moved slot from the recorded bindings; asset_version_changed obligations; the rebinding', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await toPublished(fx, { policy: BEFORE_BUILD });
    designScripts(fx);
    fx.scripted.kindScript('spec_change', specChangeScriptFor(V2));
    fx.scripted.kindScript('check_correction', roleThat(writes(CORRECTION_43), { proposal: { rationale: 'The approved design added R2.2 and R2.3: their checks.', requested_change_kind: 'tightening' } }));
    const ctx = journeyContext(fx, p, { lane: 'kernel' });
    ctx.answerKinds = [...KINDS];
    const placeholders = manifestOf(p);
    // The design: the logo proposed (held at the approval) and the app_icon's default proposed (approved).
    const proposed = propose(placeholders, [
      { slot: 'logo', variant: 'full', format: 'svg', transparency: 'any', file: LOGO_PATH, bytes: LOGO_SVG },
      { slot: 'app_icon', variant: 'default', format: 'svg', transparency: 'any', file: 'assets/app_icon/proposed-default.svg', bytes: ICON_A },
    ]);
    const files = { ...designFiles(inventoryOf(p), placeholders, { criteria: CRITERIA_43 }), '.surety/design/assets/manifest.json': json(proposed.manifest), '.surety/design/assets/app_icon/proposed-default.svg': ICON_A };
    // The UI Builders' attempts, by work item.
    const webPlace = [step.copyContext(PACKAGE_TOKENS_CSS, 'web/tokens.css'), step.copyContext(PACKAGE_LOGO, WEB_LOGO_PATH), ...writes({ 'web/index.html': INDEX_HTML, 'web/app.css': APP_CSS })];
    fx.scripted.script(stageWork(fx.home, p.id, 1).id, [0, 1, 2].map(() => roleThat(writes({ 'server.mjs': SERVER_MJS }))));
    fx.scripted.script(stageWork(fx.home, p.id, 2).id, [
      roleThat(webPlace, { asset_bindings: [binding('logo', 'full', 'web', 'web/assets/missing.svg')] }),
      roleThat(webPlace, { asset_bindings: [binding('banner', 'default', 'web', WEB_LOGO_PATH)] }),
      roleThat([step.probe('context_dump'), ...webPlace, step.writeBytes(DERIVED_PATH, pngOf(48, 48))], { asset_bindings: [binding('logo', 'full', 'web', WEB_LOGO_PATH), binding('logo', 'full', 'web', DERIVED_PATH, 'derived')] }),
    ]);
    fx.scripted.script(stageWork(fx.home, p.id, 3).id, [
      roleThat([step.write(ANDROID_LOGO_PATH, '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>\n'), ...writes({ 'mobile/App.js': APP_JS })], { asset_bindings: [binding('logo', 'full', 'android', ANDROID_LOGO_PATH)] }),
      roleThat([step.probe('context_dump'), step.copyContext(PACKAGE_LOGO, ANDROID_LOGO_PATH), step.copyContext(PACKAGE_ICON, ICON_PATH), ...writes({ 'mobile/App.js': APP_JS })], { asset_bindings: [binding('logo', 'full', 'android', ANDROID_LOGO_PATH), binding('app_icon', 'default', 'android', ICON_PATH)] }),
    ]);

    await designerSession(fx, p.id, [{ files, say: 'Draw Pantry: a logo and an app icon.', result: { done: true } }]);
    const batch = await pump(fx, ctx, () => (batchOf(fx.home, p.id)?.spec_change ? batchOf(fx.home, p.id) : undefined), { what: 'the batch', max: 40 });
    assert.equal((await answerWith(fx, p.id, batch.design_approval, 'approve', { assets_held: ['logo'] })).status, 200, 'approve, the logo held');
    await consume(fx, p.id, batch.spec_change, 'approve');
    const icon = await pump(fx, ctx, () => effectiveAssets(fx.home, p.id).find((e) => e.slot === 'app_icon' && e.variant === 'default' && e.source === 'approved') ?? undefined, { what: 'the app_icon effective', max: 30 });
    assert.equal(icon.digest, sha256hex(ICON_A), 'the app_icon proposal effective');
    // (c) No stage had carried it: no work.
    assert.deepEqual(assetFixes(fx.home, p.id), [], '(c) a slot no integrated stage carried: no asset_updated work');

    // The stages built: the refusals, then the bindings.
    await pump(fx, ctx, () => ([1, 2, 3].every((n) => stageRow(fx.home, p.id, n)?.status === 'verified') ? true : undefined), { what: 'the three stages verified', max: 200 });
    const web = runsOf(fx.home, stageWork(fx.home, p.id, 2).id);
    const android = runsOf(fx.home, stageWork(fx.home, p.id, 3).id);
    const refused = (run, code) => run && run.outcome === 'failed' && run.reason_class === 'invalid_result' && (run.reason_text ?? '').includes(code);
    assert.ok(refused(web[0], 'ASSET_BINDING_PATH_MISSING'), `(a) a binding to a missing path refuses the integration (${web[0] && reasonOf(web[0])})`);
    assert.ok(refused(web[1], 'ASSET_BINDING_UNKNOWN_SLOT'), `(a) a slot outside the package's effective set (${web[1] && reasonOf(web[1])})`);
    assert.equal(web[2]?.outcome, 'completed', `(a) the copy and the derived binding accepted (${web[2] && reasonOf(web[2])})`);
    assert.ok(refused(android[0], 'ASSET_BINDING_MISMATCH'), `(a) a copy whose file differs (${android[0] && reasonOf(android[0])})`);
    assert.equal(android[1]?.outcome, 'completed', `(a) the two copies accepted (${android[1] && reasonOf(android[1])})`);
    // (c) The android package held the app_icon's new version.
    const pkg = dumpedPackage(fx, android[1].id, 0);
    const iconInPkg = JSON.parse(pkg?.['design/effective-assets.json']?.text ?? '[]').find((e) => e.slot === 'app_icon' && e.variant === 'default');
    assert.deepEqual([iconInPkg?.source, iconInPkg?.slot_version, iconInPkg?.digest], ['approved', icon.slot_version, icon.digest], `(c) the next UI stage's package holds the new version (${JSON.stringify(iconInPkg)})`);
    const stage2 = stageRow(fx.home, p.id, 2).id;
    const stage3 = stageRow(fx.home, p.id, 3).id;
    const logoPh = slotOf(placeholders, 'logo').slot_version;
    const first = assetBindings(fx.home, p.id);
    const key = (b) => `${b.stage}|${b.target}|${b.slot}|${b.variant}|${b.path}|${b.form}|${b.source_slot_version}|${b.declared_by}`;
    assert.deepEqual(first.map(key).sort(), [
      `${stage2}|web|logo|full|${WEB_LOGO_PATH}|copy|${logoPh}|builder`,
      `${stage2}|web|logo|full|${DERIVED_PATH}|derived|${logoPh}|builder`,
      `${stage3}|android|logo|full|${ANDROID_LOGO_PATH}|copy|${logoPh}|builder`,
      `${stage3}|android|app_icon|default|${ICON_PATH}|copy|${icon.slot_version}|builder`,
    ].sort(), `(a) the valid bindings recorded with their stage, nothing of the refused ones (${JSON.stringify(first)})`);
    for (const b of first) assert.match(b.revision ?? '', /^[0-9a-f]{40}$/, `${b.path}: recorded with the integrated revision`);
    assert.ok(designEvents(fx.home, 'design.asset_bound', p.id).length >= 4, 'design.asset_bound');
    // (g) The bindings route; the favicon unbound.
    const route = await readBindings(fx, p.id);
    for (const b of first) {
      const shown = (route.bindings ?? []).find((x) => x.id === b.id);
      assert.ok(shown, `${b.path}: on GET …/design/bindings (${JSON.stringify(route).slice(0, 600)})`);
      assert.deepEqual([shown.form, shown.source_slot_version, shown.slot, shown.variant, shown.path], [b.form, b.source_slot_version, b.slot, b.variant, b.path], `${b.path}: its form and source version`);
    }
    const unbound = (await readDesign(fx, p.id)).unbound ?? [];
    assert.ok(unbound.some((u) => u.slot === 'favicon' && u.variant === 'default' && u.stage === stage2), `the favicon carried by the web stage and bound by none: unbound (${JSON.stringify(unbound)})`);
    assert.ok(!unbound.some((u) => u.slot === 'logo' && u.variant === 'full' && u.stage === stage2), 'the bound logo is not unbound');

    // The parity check's results before the move, each naming the slot@version it read (G14).
    const parityBefore = resultsOfKey(fx.home, p.id, 'parity-web');
    assert.ok(parityBefore.length > 0, 'parity-web ran on the web stage\'s candidates');
    for (const r of parityBefore) assert.deepEqual(r.asset_inputs, [{ slot: 'logo', variant: 'full', slot_version: logoPh }], `(e) its result records the slot@version it read (${JSON.stringify(r.asset_inputs)})`);
    const oldResult = parityBefore.at(-1);

    // The owner's files; one asset-only approval moving three slots.
    const fav = assetAdd(fx, p.id, 'favicon', 'default', 'owner-favicon.svg', Buffer.from(FAVICON_OWNER));
    assert.equal(fav.status, 0, `the owner's favicon (${fav.stdout.slice(0, 300)} ${fav.stderr.slice(0, 300)})`);
    const ic = assetAdd(fx, p.id, 'app_icon', 'default', 'owner-icon.svg', Buffer.from(ICON_B));
    assert.equal(ic.status, 0, `the owner's app icon (${ic.stdout.slice(0, 300)} ${ic.stderr.slice(0, 300)})`);
    assert.equal(assetsSubmit(fx, p.id).status, 0, 'surety design assets submit');
    const approval = await pump(fx, ctx, () => openApproval(fx.home, p.id) ?? undefined, { what: 'the asset-only approval', max: 20 });
    const latestCandidate = candidatesOfProject(fx.home, p.id).at(-1);
    const effBefore = Object.fromEntries(effectiveAssets(fx.home, p.id).map((e) => [`${e.slot}/${e.variant}`, e]));
    // (f) The engine killed between the effective version's move and its work's registration.
    await armBarrier(fx.engine, 'design.effective_moved', 'kill');
    answerWith(fx, p.id, approval, 'approve').catch(() => null);
    await untilKilled(fx, p.id);
    await fx.start();
    const row = rows(fx.home, 'SELECT * FROM "decisions" WHERE "id" = ?', approval.id)[0];
    if (row.status === 'open') assert.equal((await answerWith(fx, p.id, { ...approval, preview_hash: row.preview_hash }, 'approve')).status, 200, 'answered again after the kill');
    // The work registered, read from the store with no tick (nothing dispatched before its script).
    const moved = await waitFor(() => (assetFixes(fx.home, p.id).length >= 3 ? assetFixes(fx.home, p.id) : undefined), { what: 'the asset_updated work registered' });
    // (d) The fix Builders: each updates its paths and binds anew.
    const fixScript = {
      logo: roleThat([step.probe('context_dump'), step.copyContext(PACKAGE_LOGO, WEB_LOGO_PATH), step.copyContext(PACKAGE_LOGO, ANDROID_LOGO_PATH), step.writeBytes(DERIVED_PATH, pngOf(48, 48, { rgba: [0x2e, 0x7d, 0x32, 0xff] }))], { asset_bindings: [binding('logo', 'full', 'web', WEB_LOGO_PATH), binding('logo', 'full', 'web', DERIVED_PATH, 'derived'), binding('logo', 'full', 'android', ANDROID_LOGO_PATH)] }),
      app_icon: roleThat([step.copyContext(PACKAGE_ICON, ICON_PATH)], { asset_bindings: [binding('app_icon', 'default', 'android', ICON_PATH)] }),
      favicon: roleThat([step.copyContext(PACKAGE_FAVICON, FAVICON_PATH)], { asset_bindings: [binding('favicon', 'default', 'web', FAVICON_PATH)] }),
    };
    for (const w of moved) fx.scripted.script(w.id, [0, 1, 2].map(() => fixScript[w.subject.slot]));
    // A replayed answer and a restart before dispatch create nothing more.
    const replay = await answerWith(fx, p.id, { ...approval, preview_hash: rows(fx.home, 'SELECT "preview_hash" FROM "decisions" WHERE "id" = ?', approval.id)[0].preview_hash }, 'approve');
    assert.notEqual(replay.status, 200, `(f) a replayed answer is refused (${replay.status} ${replay.text?.slice(0, 200)})`);
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, p.id, { rounds: 2 });
    const fixes = assetFixes(fx.home, p.id);
    assert.deepEqual(fixes.map((w) => w.subject.slot).sort(), ['app_icon', 'favicon', 'logo'], `(f) one asset_updated fix per moved slot, no duplicate (${JSON.stringify(fixes.map((w) => w.subject))})`);
    assert.equal(fixes.length, moved.length, '(f) nothing added by the replay or the restart');
    const obligations = versionObligations(fx.home, p.id);
    assert.deepEqual(obligations.map((o) => o.key), ['parity-web'], `(e), (f) one asset_version_changed obligation, for the one check reading the logo (${JSON.stringify(obligations.map((o) => o.key))})`);
    const of = (slot) => fixes.find((w) => w.subject.slot === slot).subject;
    const eff = Object.fromEntries(effectiveAssets(fx.home, p.id).map((e) => [`${e.slot}/${e.variant}`, e]));
    const ver = (slot, variant) => `${slot}@${eff[`${slot}/${variant}`].slot_version}`;
    const was = (slot, variant) => `${slot}@${effBefore[`${slot}/${variant}`].slot_version}`;
    // (b) The app_icon: bound, no parity criterion.
    assert.deepEqual([of('app_icon').from_version, of('app_icon').to_version, of('app_icon').candidate], [was('app_icon', 'default'), ver('app_icon', 'default'), latestCandidate.id], `(b) the app_icon's fix names its old and new slot@version, on the latest integrated candidate (${JSON.stringify(of('app_icon'))})`);
    assert.deepEqual((of('app_icon').bindings ?? []).map((b) => b.path), [ICON_PATH], '(b) and its bound path');
    // (c) The favicon: carried, unbound: no paths.
    assert.deepEqual([of('favicon').from_version, of('favicon').to_version, of('favicon').bindings ?? []], [was('favicon', 'default'), ver('favicon', 'default'), []], `(c) the favicon's fix carries no path (${JSON.stringify(of('favicon'))})`);
    // The logo: every recorded binding.
    assert.deepEqual([of('logo').from_version, of('logo').to_version], [`logo@${logoPh}`, ver('logo', 'full')], `the logo's fix (${JSON.stringify(of('logo'))})`);
    assert.deepEqual((of('logo').bindings ?? []).map((b) => b.path).sort(), [ANDROID_LOGO_PATH, DERIVED_PATH, WEB_LOGO_PATH].sort(), 'every recorded binding of the logo');
    assert.equal(eff['logo/full'].digest, LOGO, 'the held logo effective');

    // (e) The old result offered again for the latest candidate: never counted for the new version.
    const parityCheck = rows(fx.home, 'SELECT c."id" FROM "checks" c JOIN "check_executions" x ON x."check" = c."id" JOIN "check_results" r ON r."execution" = x."id" WHERE r."id" = ?', oldResult.id)[0].id;
    const offered = await fx.engine.post('/v1/harness/fixtures/evidence-reuse', { project: p.id, candidate: latestCandidate.id, check: parityCheck, check_result: oldResult.id, assessed: true });
    assert.equal(offered.status, 201, `the old result offered (SEAM.md §73) (${offered.status} ${offered.text?.slice(0, 200)})`);
    const mark = rows(fx.home, 'SELECT COALESCE(MAX(rowid), 0) AS r FROM "gate_evaluations"')[0].r;

    await pump(fx, ctx, () => (assetFixes(fx.home, p.id).every((w) => w.status === 'complete') ? true : undefined), { what: 'the three asset_updated fixes integrated', max: 200 });
    const head = headOf(p);
    assert.equal(sha256hex(blobBytes(p.repo.path, head, WEB_LOGO_PATH)), LOGO, '(d) the web path holds the new logo');
    assert.equal(sha256hex(blobBytes(p.repo.path, head, ANDROID_LOGO_PATH)), LOGO, '(d) the android path holds the new logo');
    assert.equal(sha256hex(blobBytes(p.repo.path, head, ICON_PATH)), sha256hex(ICON_B), '(d) the icon path the owner\'s icon');
    const all = assetBindings(fx.home, p.id);
    for (const old of first.filter((b) => b.slot === 'logo' || b.slot === 'app_icon')) {
      const now = all.find((b) => b.id === old.id);
      assert.ok(now.superseded_by, `(d) ${old.path}: the old binding superseded (${JSON.stringify(now)})`);
      const next = all.find((b) => b.id === now.superseded_by);
      assert.deepEqual([next?.path, next?.form, next?.source_slot_version], [old.path, old.form, eff[`${old.slot}/${old.variant}`].slot_version], `(d) ${old.path}: recorded anew at the new version`);
    }
    assert.ok(all.some((b) => b.slot === 'favicon' && b.path === FAVICON_PATH && !b.superseded_by), '(c) the favicon placed and bound by its fix');

    // (e) The gate waits on results of the new version; the old result never counts for it.
    await pump(fx, ctx, () => (resultsOfKey(fx.home, p.id, 'parity-web').some((r) => r.asset_inputs?.[0]?.slot_version === eff['logo/full'].slot_version) ? true : undefined), { what: 'a parity-web result of the new version', max: 60 });
    await tick(fx.engine, p.id, { rounds: 2 });
    const byId = Object.fromEntries(resultsOfKey(fx.home, p.id, 'parity-web').map((r) => [r.id, r]));
    assert.deepEqual(byId[oldResult.id].asset_inputs, [{ slot: 'logo', variant: 'full', slot_version: logoPh }], '(e) the earlier result still names the version it read');
    const later = rows(fx.home, 'SELECT * FROM "gate_evaluations" WHERE "project" = ? AND rowid > ? ORDER BY rowid', p.id, mark);
    assert.ok(later.length > 0, 'gates evaluated after the move');
    for (const e of later) {
      for (const id of Object.keys(byId)) {
        if (!e.satisfiers.includes(id)) continue;
        assert.equal(byId[id].asset_inputs?.[0]?.slot_version, eff['logo/full'].slot_version, `(e) a ${e.gate_kind} gate counted parity-web result ${id} only of the new version (${JSON.stringify(byId[id].asset_inputs)})`);
      }
    }
    const resolved = versionObligations(fx.home, p.id)[0];
    assert.ok(resolved.resolved_at, `(e) the obligation resolved once a result of the new version exists (${JSON.stringify(resolved)})`);
    void variantOf;
    void designRevisions;
  });
});
