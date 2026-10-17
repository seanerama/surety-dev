// M526, the effective asset set (slice 43; kernel lane). M6 plan §3.5
// M526; D7 §6.4, §6.5; Q8; SEAM.md §§482, 487, 496, 504, 508.
//
// (a) a design approved with a logo (A), then a revised layout approved
//     with its proposed logo (B) held: every UI Builder package, every check
//     result's asset inputs and GET …/design hold A by slot@version and
//     digest;
// (b) a design approved with its logo held and no logo ever approved: the
//     placeholder, in each of the same;
// (c) the held or pending proposal's digest in none of them;
//     design_effective_assets one row per selected slot and variant, with
//     its source;
// (d) a Designer save proposing a new logo file: the effective set
//     unchanged;
// (e) a later asset-only approval of the held file: B effective,
//     `design.assets_approved`;
// (f) a restart between the approval and the next package: the package
//     holds the recorded set, never the manifest's latest (B at the head).
// E162 item 4 (D7 §6.4 as clarified; SEAM.md §547):
// (g) every design approval durably records its full effective asset set in
//     design_effective_assets, unchanged assets and placeholders included:
//     one row per selected slot and variant after each approval, the same
//     across a restart;
// (h) an approval that changes no effective version (the layout approved
//     with the new logo held; the first design approved with its logo held
//     and the placeholders already effective) emits no
//     `design.assets_approved`, schedules no `asset_updated` work and
//     records no `asset_version_changed` obligation;
// (i) a retried approval (the owner's answer sent again, and a restart
//     after it) duplicates neither the event nor the work.
// The export of an approved revision is objection 141's (not asserted here).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { consume, decisionsOfKind } from './harness/decisions.mjs';
import { journeyContext, openDecisions, pump } from './harness/journey/drive.mjs';
import { resumeWork, scriptedEngine, tick, waitForIdle } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { step } from './harness/scripted.mjs';
import { postTurn, readSession, scriptTurns } from './harness/sessions.mjs';
import { CRITERIA, HUMAN_TEST_KEYS, LOGO_SVG, REQUIREMENTS_V2, TOKENS, designFiles, specText } from './harness/design/reference.mjs';
import {
  answerWith,
  batchOf,
  builderScript,
  designEvents,
  designRevisions,
  designScripts,
  designTurn,
  designerSession,
  dumpedPackage,
  effectiveAssets,
  inventoryOf,
  manifestOf,
  openDesigner,
  readDesign,
  scriptBuilders,
  specChangeScriptFor,
  stageRow,
  stageWork,
  toPublished,
  workItems,
} from './harness/design/drive.mjs';
import { BEFORE_BUILD } from './harness/design/check41.mjs';
import { assetsSubmit, json, openApproval, passiveSvg, propose, resultsOfKey, sha256hex, slotOf } from './harness/design/assets43.mjs';

const OWNER = ['check_correction_unclassifiable', 'check_correction_loosening', 'plan_approval'];
const LOGO_A = sha256hex(LOGO_SVG);
const LOGO_B_SVG = passiveSvg(120, 40, 'Pantry B');
const LOGO_B = sha256hex(LOGO_B_SVG);
const PARITY = Object.freeze(['parity-web', 'parity-android']);

// While the API stage's Builder waits at its hold (objection 172). The pump waits for every
// run to end, and a held Builder does not: this ticks the engine itself and answers the open
// decisions of `ctx.answerKinds` as the owner, until `done` answers.
async function whileHeld(fx, ctx, done, { what = 'the expected state', max = 160 } = {}) {
  for (let i = 0; ; i++) {
    const value = await done();
    if (value !== undefined && value !== null && value !== false) return value;
    if (i >= max) throw new Error(`${what}: not reached within ${max} ticks while the API Builder holds (open decisions: ${JSON.stringify(openDecisions(fx.home, ctx.project).map((d) => d.kind))})`);
    for (const d of openDecisions(fx.home, ctx.project).filter((x) => ctx.answerKinds.includes(x.kind))) await consume(fx, ctx.project, d, 'approve');
    await tick(fx.engine, ctx.project);
    await new Promise((r) => setTimeout(r, 250));
  }
}
// The batch raised and both members approved; `held` the slots held; `wait` the pump, or
// `whileHeld` while a Builder holds.
async function approveTheBatch(fx, ctx, project, held = [], wait = pump) {
  const batch = await wait(fx, ctx, () => (batchOf(fx.home, project)?.spec_change ? batchOf(fx.home, project) : undefined), { what: 'the batch', max: 40 });
  const a = await answerWith(fx, project, batch.design_approval, 'approve', held.length > 0 ? { assets_held: held } : {});
  assert.equal(a.status, 200, `design_approval approved${held.length ? ` with ${held.join(', ')} held` : ''} (${a.text})`);
  await consume(fx, project, batch.spec_change, 'approve');
  // The newest design revision (by insertion) is the one the batch is about.
  return wait(fx, ctx, () => {
    const latest = designRevisions(fx.home, project).at(-1);
    return latest?.status === 'approved' ? latest : undefined;
  }, { what: 'the design revision approved', max: 30 });
}
// What a UI Builder's package holds of the logo, and whether any of its files or texts carries `digest`.
function packageLogo(fx, project, n) {
  const launch = fx.scripted.launches({ work_item: stageWork(fx.home, project, n).id })[0];
  const pkg = launch ? dumpedPackage(fx, launch.run, 0) : null;
  assert.ok(pkg, `stage ${n}'s Builder dumped its package`);
  const eff = JSON.parse(pkg['design/effective-assets.json']?.text ?? '[]');
  const logo = eff.find((e) => e.slot === 'logo' && e.variant === 'full');
  return { pkg, eff, logo, file: logo ? pkg[logo.path] : null, carries: (digest) => Object.entries(pkg).filter(([, f]) => f.sha256 === digest || (f.text ?? '').includes(digest)).map(([name]) => name) };
}
// design_effective_assets: one row per selected slot and variant, each with its source.
function assertOneRowPerSelected(fx, project, revision) {
  const eff = effectiveAssets(fx.home, project);
  const want = (revision.selection?.slots ?? []).flatMap((s) => s.variants.map((v) => `${s.kind}/${v}`)).sort();
  const got = eff.map((e) => `${e.slot}/${e.variant}`).sort();
  assert.deepEqual(got, want, `one row per selected slot and variant (${JSON.stringify(got)})`);
  for (const e of eff) assert.ok(['approved', 'placeholder'].includes(e.source) && Number.isInteger(e.slot_version) && /^[0-9a-f]{64}$/.test(e.digest), `${e.slot}/${e.variant}: its slot_version, source and digest (${JSON.stringify(e)})`);
}

// E162 item 4: what an approval did to the effective set, by design revision.
const tuples = (eff) => eff.map((e) => [e.slot, e.variant, e.source, e.slot_version, e.digest].join(' ')).sort();
const approvedEventsOf = (fx, project, revision) => designEvents(fx.home, 'design.assets_approved', project).filter((e) => e.subject?.design_revision === revision);
const assetUpdatesOf = (fx, project, revision) => workItems(fx.home, project, 'fix').filter((w) => w.trigger_source === 'asset_updated' && String(w.trigger_id).startsWith(`${revision}:`));
const assetObligations = (fx, project) => withStore(fx.home, (db) => db.prepare(`SELECT "id" FROM "check_obligations" WHERE "project" = ? AND "reason" = 'asset_version_changed'`).all(project));
// (h): an approval of `revision` that moved no effective version: no event, no work, no obligation.
function assertNothingMoved(fx, project, revision, obligationsBefore, how) {
  assert.deepEqual(approvedEventsOf(fx, project, revision), [], `${how}: no design.assets_approved for an approval that changes no effective version (E162 item 4)`);
  assert.deepEqual(assetUpdatesOf(fx, project, revision).map((w) => w.id), [], `${how}: no asset_updated work scheduled`);
  assert.equal(assetObligations(fx, project).length, obligationsBefore, `${how}: no asset_version_changed obligation recorded`);
}
// (i): the owner's answer to an approval sent again: refused as answered (or accepted as the same), changing nothing.
async function retryApproval(fx, project, revision, extra = {}) {
  const row = decisionsOfKind(fx.home, project, 'design_approval').filter((d) => d.subject_id === revision && d.status !== 'open').at(-1);
  assert.ok(row, `the approval of ${revision} answered (${JSON.stringify(decisionsOfKind(fx.home, project, 'design_approval').map((d) => [d.id, d.subject_id, d.status]))})`);
  const res = await answerWith(fx, project, row, 'approve', extra);
  assert.ok([200, 409].includes(res.status), `the retried answer is refused as answered or accepted as the same (${res.status} ${res.text})`);
  return res;
}

describe('M526 the effective asset set', () => {
  test('(a), (c), (d), (e), (f) a logo approved, a revised layout approved with a new logo held: the approved logo everywhere, across a restart; then the held logo approved', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await toPublished(fx, { policy: BEFORE_BUILD });
    designScripts(fx);
    scriptBuilders(fx, p.id, { dump: [2, 3] });
    // No UI stage builds before the restart: the API stage's Builder waits at a hold, and the UI
    // stages wait on its code milestone (objection 172). Version 1's criteria correction is
    // answered, as the owner must: version 2's batch is not raised while it is pending
    // (objection 166's extended rule).
    const api = stageWork(fx.home, p.id, 1);
    fx.scripted.script(api.id, [{ steps: [step.hold('until-restart'), ...builderScript(1).steps] }, builderScript(1), builderScript(1)]);
    const ctx = journeyContext(fx, p, { lane: 'kernel' });
    ctx.answerKinds = [...OWNER, 'check_correction_tightening'];
    const inventory = inventoryOf(p);
    const placeholders = manifestOf(p);
    // Version 1: the logo A proposed and approved, and the criteria's correction applied: the design is ready.
    await designerSession(fx, p.id, [{ files: designFiles(inventory, placeholders), say: 'Draw Pantry with its logo.', result: { done: true } }]);
    const v1 = await approveTheBatch(fx, ctx, p.id, [], whileHeld);
    const logo1 = await whileHeld(fx, ctx, () => effectiveAssets(fx.home, p.id).find((e) => e.slot === 'logo' && e.variant === 'full' && e.source === 'approved') ?? undefined, { what: 'logo A effective', max: 20 });
    assert.equal(logo1.digest, LOGO_A, 'logo A effective after version 1');
    // (g) the approval's full set recorded, the placeholders of the other slots included.
    assertOneRowPerSelected(fx, p.id, v1);
    assert.equal(approvedEventsOf(fx, p.id, v1.id).length, 1, 'version 1 moved the logo: one design.assets_approved');
    await whileHeld(fx, ctx, () => designRevisions(fx.home, p.id).find((r) => r.id === v1.id && r.ready_at) ?? undefined, { what: 'version 1 ready (its criteria\'s correction applied)', max: 60 });
    assert.ok(await fx.scripted.waitForHolding({ work_item: api.id }, 'until-restart'), 'the API stage\'s Builder waits at its hold');
    for (const n of [2, 3]) assert.deepEqual(fx.scripted.launches({ work_item: stageWork(fx.home, p.id, n).id }), [], `no stage ${n} Builder yet`);

    // Version 2: another accent and logo B, its human tests revised (so the batch carries a change).
    const head = manifestOf(p);
    const b = propose(head, [{ slot: 'logo', variant: 'full', format: 'svg', transparency: 'any', file: 'assets/logo/full-b.svg', bytes: LOGO_B_SVG }], { designVersion: 2 });
    const criteria2 = { ...CRITERIA, human_tests: CRITERIA.human_tests.map((h) => ({ ...h, text: h.text.replace('version 1', 'version 2') })) };
    const tokens2 = { ...TOKENS, themes: { ...TOKENS.themes, light: { ...TOKENS.themes.light, 'color.accent': '#2e7d32' } } };
    // Drawn against the inventory as it stands now (re-derived from spec version 2).
    const files2 = { ...designFiles(inventoryOf(p), placeholders, { version: 2, tokens: tokens2, criteria: criteria2 }), '.surety/design/assets/manifest.json': json(b.manifest), '.surety/design/assets/logo/full-b.svg': LOGO_B_SVG };
    const v3 = {
      text: specText({
        version: 3,
        requirements: REQUIREMENTS_V2.map((r) => (r.human_test ? { ...r, human_test: criteria2.human_tests.find((h) => HUMAN_TEST_KEYS[h.target] === r.key)?.text ?? r.human_test } : r)),
        changeLog: [
          { version: 2, date: '2026-10-16', change: 'The approved design\'s criteria and human tests', by: 'Sean' },
          { version: 3, date: '2026-10-17', change: 'The revised design\'s human tests', by: 'Sean' },
        ],
      }),
      changes: Object.values(HUMAN_TEST_KEYS).map((key) => ({ key, kind: 'text_changed', reason: 'the revised design\'s human test' })),
    };
    fx.scripted.kindScript('spec_change', specChangeScriptFor(v3));
    const effBefore = effectiveAssets(fx.home, p.id);
    // Version 2's session, its turn waited on while the API Builder holds (designerSession's wait needs every run ended).
    const s2 = await openDesigner(fx, p.id);
    scriptTurns(fx, s2.id, [designTurn(files2)]);
    const turn2 = await postTurn(fx, p.id, s2.id, 'A green accent and a new logo.');
    const read2 = await whileHeld(
      fx,
      ctx,
      async () => {
        const body = await readSession(fx, p.id, s2.id);
        const turn = (body.turns ?? []).find((x) => x.turn === turn2.turn);
        return turn && ['settled', 'failed', 'unknown'].includes(turn.state) ? body : undefined;
      },
      { what: 'version 2\'s turn settled', max: 24 },
    );
    assert.equal(read2.turns.find((x) => x.turn === turn2.turn).state, 'settled', `version 2's turn settled (${JSON.stringify(read2.turns)})`);
    const save2 = await fx.engine.post(`/v1/projects/${p.id}/sessions/${s2.id}/save`, {});
    // (d) A save proposing a new logo file: the effective set unchanged.
    assert.equal(save2.body?.design_check?.outcome, 'passed', `version 2 saved and checked (${save2.text?.slice(0, 600)})`);
    assert.deepEqual(effectiveAssets(fx.home, p.id), effBefore, '(d) the effective set unchanged by a save');
    assert.ok(!JSON.stringify((await readDesign(fx, p.id)).effective_assets ?? []).includes(LOGO_B), '(d) GET …/design does not show the pending proposal as effective');
    const closed = await fx.engine.post(`/v1/projects/${p.id}/sessions/${s2.id}/close`, {});
    assert.equal(closed.status, 200, `the close (${closed.text?.slice(0, 400)})`);
    const obligationsBeforeV2 = assetObligations(fx, p.id).length;
    const effBeforeV2 = effectiveAssets(fx.home, p.id);
    const v2 = await approveTheBatch(fx, ctx, p.id, ['logo'], whileHeld);
    assert.notEqual(v2.id, v1.id, 'design revision 2 approved');
    // (g), (h) version 2 changes no effective version: its set recorded whole and unchanged; no event, no work.
    assert.deepEqual(tuples(effectiveAssets(fx.home, p.id)), tuples(effBeforeV2), '(g) the set after version 2: every row as before, the unchanged logo A and the placeholders included');
    assertNothingMoved(fx, p.id, v2.id, obligationsBeforeV2, '(h) version 2 (logo B held)');
    await retryApproval(fx, p.id, v2.id, { assets_held: ['logo'] });
    assertNothingMoved(fx, p.id, v2.id, obligationsBeforeV2, '(i) version 2 retried');
    const held = effectiveAssets(fx.home, p.id).find((e) => e.slot === 'logo' && e.variant === 'full');
    assert.deepEqual([held.source, held.digest, held.slot_version], ['approved', LOGO_A, logo1.slot_version], `logo B held: logo A stays effective, by slot@version and digest (${JSON.stringify(held)})`);
    assertOneRowPerSelected(fx, p.id, v2);
    assert.equal(slotOf(manifestOf(p), 'logo').variants.find((v) => v.name === 'full').digest, LOGO_B, 'the fixture is live: the manifest\'s latest at the head is logo B');

    // (f) A restart between the approval and the next package: no UI Builder launched before it.
    for (const n of [2, 3]) assert.deepEqual(fx.scripted.launches({ work_item: stageWork(fx.home, p.id, n).id }), [], `no stage ${n} Builder before the restart`);
    await fx.engine.kill();
    // The held Builder released only once the engine is down, so nothing dispatches before the
    // restart. Its run is recovered at the start and its work held (D1's restart); the owner
    // resumes it, and its next attempt builds.
    fx.scripted.release(api.id, 'until-restart');
    await fx.start();
    assert.deepEqual(tuples(effectiveAssets(fx.home, p.id)), tuples(effBeforeV2), '(g) the recorded set the same across the restart');
    await resumeWork(fx.engine, p.id, api.id);
    await pump(fx, ctx, () => ([2, 3].every((n) => fx.scripted.launches({ work_item: stageWork(fx.home, p.id, n).id }).length > 0) ? true : undefined), { what: 'both UI Builders launched after the restart', max: 80 });
    for (const n of [2, 3]) {
      const got = packageLogo(fx, p.id, n);
      assert.deepEqual([got.logo?.source, got.logo?.slot_version, got.logo?.digest], ['approved', logo1.slot_version, LOGO_A], `stage ${n}: the package holds logo A by slot@version and digest (${JSON.stringify(got.logo)})`);
      assert.equal(got.file?.sha256, LOGO_A, `stage ${n}: its file is logo A`);
      assert.deepEqual(got.carries(LOGO_B), [], `stage ${n}: (c) logo B's digest in no file or text of the package`);
    }
    // The checks' asset inputs and the projections.
    await pump(fx, ctx, () => ([2, 3].every((n) => stageRow(fx.home, p.id, n)?.status === 'verified') ? true : undefined), { what: 'both UI stages verified', max: 120 });
    for (const k of PARITY) {
      const rs = resultsOfKey(fx.home, p.id, k);
      assert.ok(rs.length > 0, `${k} has results`);
      for (const r of rs) assert.deepEqual(r.asset_inputs, [{ slot: 'logo', variant: 'full', slot_version: logo1.slot_version }], `${k}: its asset inputs name logo@${logo1.slot_version}, never the held version (G14) (${JSON.stringify(r.asset_inputs)})`);
    }
    const design = await readDesign(fx, p.id);
    const shown = (design.effective_assets ?? []).find((e) => e.slot === 'logo' && e.variant === 'full');
    assert.deepEqual([shown?.source, shown?.slot_version, shown?.digest], ['approved', logo1.slot_version, LOGO_A], `GET …/design shows logo A (${JSON.stringify(shown)})`);
    assert.ok(!JSON.stringify(design.effective_assets ?? []).includes(LOGO_B), 'GET …/design: (c) no held digest among the effective set');

    // (e) The held logo approved later by an asset-only approval.
    const approvedEvents = designEvents(fx.home, 'design.assets_approved', p.id).length;
    const submit = assetsSubmit(fx, p.id);
    assert.equal(submit.status, 0, `surety design assets submit (${submit.stdout.slice(0, 300)} ${submit.stderr.slice(0, 300)})`);
    const approval = await pump(fx, ctx, () => openApproval(fx.home, p.id) ?? undefined, { what: 'the asset-only approval', max: 20 });
    assert.equal((await answerWith(fx, p.id, approval, 'approve')).status, 200, 'approved');
    const now = await pump(fx, ctx, () => effectiveAssets(fx.home, p.id).find((e) => e.slot === 'logo' && e.variant === 'full' && e.digest === LOGO_B) ?? undefined, { what: 'logo B effective', max: 20 });
    assert.deepEqual([now.source, now.slot_version], ['approved', b.manifest.slots.find((s) => s.key === 'logo').slot_version], 'logo B effective at its slot@version');
    assert.ok(designEvents(fx.home, 'design.assets_approved', p.id).length > approvedEvents, 'design.assets_approved');
    // (g) the asset-only approval's set: one row per selected slot and variant, the placeholders kept.
    const assetOnly = approval.subject_id;
    assert.deepEqual(effectiveAssets(fx.home, p.id).filter((e) => e.slot !== 'logo').map((e) => [e.slot, e.variant, e.source, e.slot_version, e.digest]), effBeforeV2.filter((e) => e.slot !== 'logo').map((e) => [e.slot, e.variant, e.source, e.slot_version, e.digest]), '(g) every other slot as before, its placeholder included');
    // (i) one event and one asset_updated item for it; the answer sent again and a restart duplicate neither.
    assert.equal(approvedEventsOf(fx, p.id, assetOnly).length, 1, 'one design.assets_approved for the asset-only approval');
    const fixes = assetUpdatesOf(fx, p.id, assetOnly);
    assert.equal(fixes.length, 1, `one asset_updated item (${JSON.stringify(fixes.map((w) => [w.id, w.trigger_id]))})`);
    const obligations = assetObligations(fx, p.id).length;
    await retryApproval(fx, p.id, assetOnly);
    await tick(fx.engine, p.id, { rounds: 2 });
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, p.id, { rounds: 3 });
    await waitForIdle(fx.home, p.id);
    assert.equal(approvedEventsOf(fx, p.id, assetOnly).length, 1, '(i) the retried approval and a restart: still one design.assets_approved');
    assert.deepEqual(assetUpdatesOf(fx, p.id, assetOnly).map((w) => w.id), fixes.map((w) => w.id), '(i) still the one asset_updated item');
    assert.equal(assetObligations(fx, p.id).length, obligations, '(i) no asset_version_changed obligation recorded again');
  });

  test('(b), (c) a design approved with its logo held and no logo ever approved: the placeholder in every package, check input and projection', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await toPublished(fx, { policy: BEFORE_BUILD, name: 'pantry-held' });
    designScripts(fx);
    scriptBuilders(fx, p.id, { dump: [2, 3] });
    const ctx = journeyContext(fx, p, { lane: 'kernel' });
    ctx.answerKinds = [...OWNER, 'check_correction_tightening'];
    const placeholders = manifestOf(p);
    const ph = slotOf(placeholders, 'logo').variants.find((v) => v.name === 'full');
    await designerSession(fx, p.id, [{ files: designFiles(inventoryOf(p), placeholders), say: 'Draw Pantry with its logo.', result: { done: true } }]);
    const effAtDerivation = effectiveAssets(fx.home, p.id);
    assert.ok(effAtDerivation.length > 0 && effAtDerivation.every((e) => e.source === 'placeholder'), `the fixture is live: the placeholders effective before any approval (${JSON.stringify(tuples(effAtDerivation))})`);
    const v1 = await approveTheBatch(fx, ctx, p.id, ['logo']);
    // (g), (h) the first approval with its logo held changes no effective version: the set recorded whole
    // for its selection, each row the placeholder as it stood; no event, no work; (i) the answer sent
    // again changes nothing. (A variant the selection leaves out has no row, assertOneRowPerSelected.)
    const selected = new Set((v1.selection?.slots ?? []).flatMap((s) => s.variants.map((v) => `${s.kind}/${v}`)));
    const effAfter = effectiveAssets(fx.home, p.id);
    assert.deepEqual(tuples(effAfter), tuples(effAtDerivation.filter((e) => selected.has(`${e.slot}/${e.variant}`))), '(g) the set after the approval: every selected placeholder row recorded, unchanged');
    assertNothingMoved(fx, p.id, v1.id, 0, '(h) the first approval, the logo held');
    await retryApproval(fx, p.id, v1.id, { assets_held: ['logo'] });
    assertNothingMoved(fx, p.id, v1.id, 0, '(i) the first approval retried');
    const eff = effectiveAssets(fx.home, p.id).find((e) => e.slot === 'logo' && e.variant === 'full');
    assert.deepEqual([eff?.source, eff?.slot_version, eff?.digest], ['placeholder', slotOf(placeholders, 'logo').slot_version, ph.digest], `the placeholder effective (${JSON.stringify(eff)})`);
    assertOneRowPerSelected(fx, p.id, v1);
    await pump(fx, ctx, () => ([2, 3].every((n) => stageRow(fx.home, p.id, n)?.status === 'verified') ? true : undefined), { what: 'both UI stages verified', max: 160 });
    for (const n of [2, 3]) {
      const got = packageLogo(fx, p.id, n);
      assert.deepEqual([got.logo?.source, got.logo?.digest], ['placeholder', ph.digest], `stage ${n}: the placeholder (${JSON.stringify(got.logo)})`);
      assert.deepEqual(got.carries(LOGO_A), [], `stage ${n}: the held proposal's digest in nothing`);
    }
    for (const k of PARITY) for (const r of resultsOfKey(fx.home, p.id, k)) assert.deepEqual(r.asset_inputs, [{ slot: 'logo', variant: 'full', slot_version: eff.slot_version }], `${k}: the placeholder's slot@version (${JSON.stringify(r.asset_inputs)})`);
    const design = await readDesign(fx, p.id);
    const shown = (design.effective_assets ?? []).find((e) => e.slot === 'logo' && e.variant === 'full');
    assert.deepEqual([shown?.source, shown?.digest], ['placeholder', ph.digest], 'GET …/design shows the placeholder');
    assert.ok(!JSON.stringify(design.effective_assets ?? []).includes(LOGO_A), 'and not the held proposal');
    // (h) after the build: still nothing moved by the approval, no event of the project at all.
    assertNothingMoved(fx, p.id, v1.id, 0, '(h) after the UI stages built');
    assert.deepEqual(designEvents(fx.home, 'design.assets_approved', p.id), [], '(h) no design.assets_approved in the project');
    await fx.engine.kill();
    await fx.start();
    assert.deepEqual(tuples(effectiveAssets(fx.home, p.id)), tuples(effAfter), '(g) the recorded set the same across a restart');
  });
});
