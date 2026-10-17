// M515, staleness: the design class (slice 44; kernel lane). M6 plan §3.6
// M515; D7 §9, §8.1, §8.2, §11; G8; D6 §4.4; SEAM.md §§418, 485, 515.
//
// Pantry of four screens (S1 web list R2, S2 android list R3, S3 web add R4,
// S4 android add R5; R1 and R6 the API's), its design approved:
// (a) a spec change making R2 `text_changed`, R3 `criteria_changed`, R4
//     `withdrawn` and R6 newly UI: the impact's design class names exactly
//     S1, S2 and S3; those screens `stale`, `design.stale` naming them, the
//     inventory recomputed, `design_due` stage `revise` naming them; S4
//     current;
// (b) an interface's shape changed by an architecture revision (add-item's
//     request): the screens using it (S3, S4) stale and no other; a revision
//     leaving `inventory_digest` unchanged: nothing stale;
// (c) a target added (ios): its slots and placeholders derived, no screen
//     stale; removed again: its slots' platforms marked stale, no screen
//     stale; a technology changed (web to three_js): the web screens stale,
//     the android ones current;
// (d) a replan moving a requirement between phases: nothing stale,
//     `stage_screens` recomputed at the publication (one assigning a UI
//     requirement to a UI stage with no screen is M508 (c)'s case);
// (e) an asset-only revision: nothing stale;
// (f) the undispatched UI stage bound to a stale screen held
//     `design_stale`, the other proceeding; integrated UI stages keep their
//     history;
// (g) a covering revision approved: the screens current, `design_revisions`
//     keeping every version;
// (h) the batch's own spec change: no screen stale (M530 (b)).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { phaseCompleted, planOfPhase, pump, stagesOfPlan } from './harness/journey/drive.mjs';
import { scriptedEngine, waitForIdle } from './harness/runs.mjs';
import { MODULES_JSON } from './harness/design/reference.mjs';
import { answerWith, assertNoSilentHold, designEvents, inventoryOf, manifestOf, openDesignDue, readDesign, scriptBuilders, stageRow, stageWork, variantSpec } from './harness/design/drive.mjs';
import { KERNEL_KINDS, approveBatch, designModel, untilBatch } from './harness/design/check41.mjs';
import { assetAdd, assetsSubmit, openApproval, pngOf } from './harness/design/assets43.mjs';
import {
  FOUR,
  PHASE_TWO_STAGES,
  TWO_PHASE,
  architectureMd,
  batchSpec,
  currentRevision,
  currentRoadmap,
  designClassOf,
  designedPantry,
  fourScreenModel,
  laterArchitect,
  laterDesign,
  latestRequest,
  modulesJson,
  ownerChange,
  replanWith,
  revisedHumanTests,
  revisionsOf,
  roadmapRevision,
  screenPairs,
  screenStatus,
  specOf,
  specWriter,
  stageIdsOf,
  stageScreens,
  staleEvents,
  staleKeys,
} from './harness/design/plan44.mjs';

// Phase 1 built to the end before a case's changes, so nothing is in flight (E147 item 4) and no stage is held.
const pairsOfDue = (due) => (due?.evidence?.stale_screens ?? []).map((s) => `${s.screen}/${s.target}`).sort();
const allCurrent = (fx, p, what) => {
  const rev = currentRevision(fx.home, p.id);
  assert.deepEqual(staleKeys(fx.home, rev.id), [], `${what}: no screen stale (${JSON.stringify(screenStatus(fx.home, rev.id))})`);
};

async function fourDesigned(t, name) {
  const fx = await scriptedEngine(t);
  const d = await designedPantry(fx, { name, variant: FOUR, model: fourScreenModel });
  await pump(fx, d.ctx, () => ([1, 2, 3].every((n) => stageRow(fx.home, d.p.id, n)?.status === 'verified') ? true : undefined), { what: 'the three stages verified', max: 200 });
  await waitForIdle(fx.home, d.p.id);
  const rev = currentRevision(fx.home, d.p.id);
  assert.deepEqual(Object.keys(screenStatus(fx.home, rev.id)).sort(), ['S1', 'S2', 'S3', 'S4'], 'the fixture is live: four approved screens');
  return { fx, ...d, rev };
}

describe('M515 staleness: the design class', () => {
  test('(h) the batch\'s own change stales nothing; (a) R2 text_changed, R3 criteria_changed, R4 withdrawn, R6 newly UI: exactly S1, S2, S3 stale, design.stale, the inventory recomputed, design_due revise', async (t) => {
    const { fx, p, ctx, v2, rev } = await fourDesigned(t, 'pantry-class');
    // (h)
    allCurrent(fx, p, '(h) after the batch');
    assert.deepEqual(staleEvents(fx.home, p.id), [], '(h) no design.stale from the batch\'s own change');
    // (a) one change of four kinds.
    const reqs = v2.requirements
      .filter((r) => r.key !== 'R4')
      .map((r) => {
        if (r.key === 'R2') return { ...r, statement: 'A user sees every item of the pantry, with its quantity, in a web browser.' };
        if (r.key === 'R3') return { ...r, criteria: [{ id: 'R3.1', text: 'Given the mobile module, when mobile/App.js is read, then it exports a default function component named App that renders a FlatList.' }] };
        if (r.key === 'R6') return { ...r, surface: 'ui (web)' };
        return r;
      });
    const changes = [
      { key: 'R2', kind: 'text_changed', reason: 'the list shows quantities' },
      { key: 'R3', kind: 'criteria_changed', reason: 'R3.1 names the list component' },
      { key: 'R4', kind: 'withdrawn', reason: 'adding moves to the Android app only' },
      { key: 'R6', kind: 'text_changed', reason: 'the health shown on the web page' },
    ];
    await ownerChange(fx, ctx, { text: specOf({ version: 3, requirements: reqs }), changes, say: 'Quantities on the list, R3 names the list, adding on Android only, the health on the page.' });
    const cls = designClassOf(fx.home, latestRequest(fx.home, p.id).id);
    assert.deepEqual(screenPairs(cls), ['S1/web', 'S2/android', 'S3/web'], `the design class names exactly S1, S2 and S3 (D7 §9.1; SEAM.md §515) (${JSON.stringify(cls)})`);
    assert.match(JSON.stringify(cls.requirements ?? cls), /R6/, `and R6, newly UI (${JSON.stringify(cls)})`);
    await pump(fx, ctx, () => (staleKeys(fx.home, rev.id).length > 0 ? true : undefined), { what: 'the screens marked stale', max: 6 });
    assert.deepEqual(staleKeys(fx.home, rev.id), ['S1', 'S2', 'S3'], `exactly S1, S2, S3 stale; S4 current (${JSON.stringify(screenStatus(fx.home, rev.id))})`);
    const events = staleEvents(fx.home, p.id);
    assert.equal(events.length, 1, `one design.stale (${JSON.stringify(events.map((e) => e.payload))})`);
    for (const k of ['S1', 'S2', 'S3']) assert.match(JSON.stringify(events[0].payload), new RegExp(`"${k}"`), `design.stale names ${k}`);
    assert.doesNotMatch(JSON.stringify(events[0].payload), /"S4"/, 'and not S4');
    const inventory = inventoryOf(p);
    assert.equal(inventory.spec_version, 3, 'the inventory recomputed from version 3');
    const uiKeys = (inventory.ui_requirements ?? []).map((r) => r.key);
    assert.ok(uiKeys.includes('R6') && !uiKeys.includes('R4'), `R6 now a UI requirement, R4 withdrawn (${JSON.stringify(uiKeys)})`);
    const due = await pump(fx, ctx, () => (openDesignDue(fx.home, p.id)?.evidence?.stage === 'revise' ? openDesignDue(fx.home, p.id) : undefined), { what: 'design_due stage revise', max: 6 });
    assert.deepEqual(pairsOfDue(due), ['S1/web', 'S2/android', 'S3/web'], `naming the stale screens with their targets (${JSON.stringify(due.evidence)})`);
    assertNoSilentHold(fx.home, p.id, '(a)');
  });

  test('(e) an asset-only revision stales nothing; (b) an architecture revision leaving the inventory unchanged stales nothing; add-item\'s request changed: S3 and S4 stale, S1 and S2 current', async (t) => {
    const { fx, p, ctx, rev } = await fourDesigned(t, 'pantry-shape');
    // (e)
    const added = assetAdd(fx, p.id, 'favicon', 'default', 'favicon.png', pngOf(48, 48));
    assert.equal(added.status, 0, `the owner's favicon added (${added.stdout} ${added.stderr})`);
    const submitted = assetsSubmit(fx, p.id);
    assert.equal(submitted.status, 0, `surety design assets submit (${submitted.stdout} ${submitted.stderr})`);
    const approval = await pump(fx, ctx, () => openApproval(fx.home, p.id) ?? undefined, { what: 'the asset-only approval', max: 10 });
    assert.equal((await answerWith(fx, p.id, approval, 'approve')).status, 200, 'approved');
    await pump(fx, ctx, () => (designEvents(fx.home, 'design.assets_approved', p.id).length >= 2 ? true : undefined), { what: 'the asset-only approval\'s effect', max: 10 });
    allCurrent(fx, p, '(e) after an asset-only revision');
    assert.deepEqual(staleEvents(fx.home, p.id), [], '(e) no design.stale');
    // (b) a revision leaving the inventory as it was.
    await waitForIdle(fx.home, p.id);
    const digest = inventoryOf(p).inventory_digest;
    await laterArchitect(fx, p.id, { '.surety/architecture/architecture.md': architectureMd('The API logs each request to standard error.') });
    await pump(fx, ctx, () => undefined, { what: 'a few ticks', max: 3 }).catch(() => null);
    assert.equal(inventoryOf(p).inventory_digest, digest, 'the fixture is live: the inventory digest unchanged');
    allCurrent(fx, p, '(b) a revision leaving the inventory unchanged');
    // (b) add-item's request gains a property.
    await waitForIdle(fx.home, p.id);
    const modules = modulesJson((m) => {
      const add = m.modules.find((x) => x.name === 'api').interfaces.find((i) => i.name === 'add-item');
      add.request = { ...add.request, properties: { ...add.request.properties, note: { type: 'string', maxLength: 80 } } };
    });
    await laterArchitect(fx, p.id, { '.surety/architecture/modules.json': modules, '.surety/architecture/architecture.md': architectureMd('An item may carry a note.') });
    await pump(fx, ctx, () => (inventoryOf(p).inventory_digest !== digest && staleKeys(fx.home, rev.id).length > 0 ? true : undefined), { what: 'the inventory re-derived and the screens using add-item stale', max: 20 });
    assert.deepEqual(staleKeys(fx.home, rev.id), ['S3', 'S4'], `the screens using add-item stale and no other (${JSON.stringify(screenStatus(fx.home, rev.id))})`);
    const due = openDesignDue(fx.home, p.id);
    assert.deepEqual(pairsOfDue(due), ['S3/web', 'S4/android'], `design_due revise naming them (${JSON.stringify(due?.evidence)})`);
    assertNoSilentHold(fx.home, p.id, '(b)');
  });

  test('(c) ios added: its slots derived, no screen stale; removed again: its slots\' platforms marked stale, no screen stale', async (t) => {
    const { fx, p, ctx, v2, rev } = await fourDesigned(t, 'pantry-targets');
    const withIos = (on) => modulesJson((m) => {
      const mobile = m.modules.find((x) => x.name === 'mobile');
      if (on) mobile.targets.push({ target: 'ios', ui_technology: 'react_native', form_factors: ['phone'] });
    });
    await ownerChange(fx, ctx, { text: specOf({ version: 3, requirements: v2.requirements, targets: '**Targets:** web, android, ios' }), changes: [], say: 'Ship on iOS too.' });
    await waitForIdle(fx.home, p.id);
    await laterArchitect(fx, p.id, { '.surety/architecture/modules.json': withIos(true), '.surety/architecture/architecture.md': architectureMd('The mobile app also targets iOS.') });
    await pump(fx, ctx, () => ((inventoryOf(p).targets ?? []).some((x) => x.target === 'ios') ? true : undefined), { what: 'the inventory with ios', max: 20 });
    const splash = (manifestOf(p).slots ?? []).find((s) => s.kind === 'splash');
    assert.ok(splash && (splash.platforms ?? []).includes('ios') && splash.status === 'placeholder', `ios's slots and placeholders derived (D7 §9.1) (${JSON.stringify(splash)})`);
    allCurrent(fx, p, '(c) ios added');
    await ownerChange(fx, ctx, { text: specOf({ version: 4, requirements: v2.requirements }), changes: [], say: 'No iOS after all.' });
    await pump(fx, ctx, async () => (((await readDesign(fx, p.id)).stale_platforms ?? []).length > 0 ? true : undefined), { what: 'the removed target\'s platforms marked stale', max: 10 });
    const marked = (await readDesign(fx, p.id)).stale_platforms ?? [];
    assert.ok(marked.some((x) => x.slot === splash.key && x.target === 'ios'), `ios's slots' platforms marked stale on GET …/design (SEAM.md §515) (${JSON.stringify(marked)})`);
    assert.ok(marked.every((x) => x.target === 'ios'), 'and no other target\'s');
    allCurrent(fx, p, '(c) ios removed');
    await waitForIdle(fx.home, p.id);
    await laterArchitect(fx, p.id, { '.surety/architecture/modules.json': withIos(false), '.surety/architecture/architecture.md': architectureMd('The mobile app targets Android only.') });
    allCurrent(fx, p, '(c) ios removed from the map');
    assert.equal(rev.id, currentRevision(fx.home, p.id).id, 'the same approved revision throughout');
    assertNoSilentHold(fx.home, p.id, '(c) targets');
  });

  test('(c) a technology changed (web from html_css to three_js): the web screens stale, the android ones current', async (t) => {
    const { fx, p, ctx, rev } = await fourDesigned(t, 'pantry-technology');
    await waitForIdle(fx.home, p.id);
    const modules = modulesJson((m) => {
      m.modules.find((x) => x.name === 'web').targets = [{ target: 'web', ui_technology: 'three_js' }];
    });
    await laterArchitect(fx, p.id, { '.surety/architecture/modules.json': modules, '.surety/architecture/architecture.md': architectureMd('The web page draws the pantry as a scene.') });
    await pump(fx, ctx, () => (staleKeys(fx.home, rev.id).length > 0 ? true : undefined), { what: 'the web screens stale', max: 20 });
    assert.deepEqual(staleKeys(fx.home, rev.id), ['S1', 'S3'], `the web screens stale, the android ones current (${JSON.stringify(screenStatus(fx.home, rev.id))})`);
    assert.deepEqual(pairsOfDue(openDesignDue(fx.home, p.id)), ['S1/web', 'S3/web'], 'design_due revise naming them');
    assertNoSilentHold(fx.home, p.id, '(c) technology');
    void MODULES_JSON;
  });

  test('(d) a replan moving R4 from phase 2 to a new phase 3: nothing stale, stage_screens recomputed at the publication', async (t) => {
    const fx = await scriptedEngine(t);
    const d = await designedPantry(fx, { name: 'pantry-moved', variant: TWO_PHASE });
    const { p, ctx } = d;
    const rev = currentRevision(fx.home, p.id);
    const roadmap = roadmapRevision(fx.home, p.id, (phases) => {
      const two = phases.find((x) => x.number === 2);
      two.requirement_ids = two.requirement_ids.filter((k) => k !== 'R4');
      return [...phases, { number: 3, goal: 'the pantry\'s count', modules: ['api'], requirement_ids: ['R4'], depends_on: [2] }];
    }, { moved: [{ key: 'R4', from: 2, to: 3 }] });
    const replan = replanWith({ stages: [PHASE_TWO_STAGES.android], roadmap });
    fx.scripted.kindScript('replan', [replan, replan, replan]);
    await phaseCompleted(fx, ctx, 1, { max: 200 });
    const published = await pump(fx, ctx, () => planOfPhase(fx.home, p.id, 2).find((x) => x.published_at), { what: 'phase 2 published with R4 moved to phase 3', max: 60 });
    assert.deepEqual(stagesOfPlan(fx.home, published.id).map((s) => s.number), [3], 'phase 2 holds the Android stage');
    assert.deepEqual(staleKeys(fx.home, rev.id), [], 'nothing stale (D7 §9.1)');
    assert.deepEqual(staleEvents(fx.home, p.id), [], 'no design.stale');
    const [s3] = stageIdsOf(fx.home, p.id, [3], 2);
    assert.deepEqual(stageScreens(fx.home, p.id).filter((b) => b.stage === s3).map((b) => [b.screen, b.target, b.design_revision]), [['S2', 'android', rev.id]], 'stage_screens recomputed at the publication');
    assertNoSilentHold(fx.home, p.id, '(d)');
  });

  test('(f) the undispatched Android stage bound to a stale screen held design_stale, the web stage proceeding; (g) a covering revision approved: S2 current, design_revisions keeping every version', async (t) => {
    const fx = await scriptedEngine(t);
    const late = { ...variantSpec('late'), base: LATE_REQUIREMENTS(), phaseOf: () => 2 };
    const d = await designedPantry(fx, { name: 'pantry-held-stale', variant: late });
    const { p, ctx, v2, model } = d;
    const rev = currentRevision(fx.home, p.id);
    // R3 reworded during phase 1: S2 stale before phase 2 is planned.
    const v3reqs = v2.requirements.map((r) => (r.key === 'R3' ? { ...r, statement: 'A user sees every item of the pantry, with its quantity, in the Android app.' } : r));
    await ownerChange(fx, ctx, { text: specOf({ version: 3, requirements: v3reqs }), changes: [{ key: 'R3', kind: 'text_changed', reason: 'quantities on Android' }], say: 'Show quantities on Android.' });
    await pump(fx, ctx, () => (staleKeys(fx.home, rev.id).includes('S2') ? true : undefined), { what: 'S2 stale', max: 6 });
    assert.deepEqual(staleKeys(fx.home, rev.id), ['S2'], 'only S2 stale');
    const replan = replanWith({ spec_version: 3, roadmap_version: currentRoadmap(fx.home, p.id).version, stages: [{ ...LATE_STAGE(2) }, { ...LATE_STAGE(3) }] });
    fx.scripted.kindScript('replan', [replan, replan, replan]);
    await phaseCompleted(fx, ctx, 1, { max: 200 });
    await pump(fx, ctx, () => planOfPhase(fx.home, p.id, 2).find((x) => x.published_at), { what: 'phase 2 published', max: 60 });
    scriptBuilders(fx, p.id, { phase: 2, numbers: [2, 3] });
    // (f) after phase 2's authoring: the web stage dispatched, the Android stage held design_stale.
    await pump(fx, ctx, () => (fx.scripted.launches({ work_item: stageWork(fx.home, p.id, 2, 2)?.id }).length > 0 && stageWork(fx.home, p.id, 3, 2)?.held === 'design_stale' ? true : undefined), { what: 'the web stage dispatched and the Android stage held design_stale', max: 60 });
    assert.deepEqual(fx.scripted.launches({ work_item: stageWork(fx.home, p.id, 3, 2)?.id }), [], 'the Android stage not dispatched');
    const due = openDesignDue(fx.home, p.id);
    assert.deepEqual(due?.evidence?.held_stages, stageIdsOf(fx.home, p.id, [3], 2), `design_due names the held stage (${JSON.stringify(due?.evidence)})`);
    assert.deepEqual(pairsOfDue(due), ['S2/android'], 'and the stale screen');
    assertNoSilentHold(fx.home, p.id, '(f)');
    // (f) integrated stages keep their history: phase 1's API stage untouched.
    assert.equal(stageRow(fx.home, p.id, 1).status, 'verified', 'phase 1\'s stage keeps its status');
    // (g) a covering revision: the design redrawn (its human tests revised, so its batch carries a change).
    fx.scripted.kindScript('spec_change', specWriter(batchSpec({ base: v3reqs.filter((r) => !Object.values(v2.humanKeys).includes(r.key)), criteria: revisedHumanTests(model).criteria, version: 4, phaseOf: () => 2, humanKind: 'text_changed', humanKeys: v2.humanKeys }).text, Object.values(v2.humanKeys).map((key) => ({ key, kind: 'text_changed', reason: 'the revised design\'s human tests' }))));
    const later = await laterDesign(fx, p.id, revisedHumanTests(designModel(inventoryOf(p))));
    assert.equal(later.close.status, 200, `the revised design's close (${later.close.text?.slice(0, 400)})`);
    await approveBatch(fx, ctx, await untilBatch(fx, ctx));
    const now = await pump(fx, ctx, () => {
      const r = currentRevision(fx.home, p.id);
      return r && r.id !== rev.id ? r : undefined;
    }, { what: 'the covering revision approved', max: 20 });
    assert.deepEqual(staleKeys(fx.home, now.id), [], `the covering revision's screens current (${JSON.stringify(screenStatus(fx.home, now.id))})`);
    const all = revisionsOf(fx.home, p.id);
    assert.ok(all.some((r) => r.id === rev.id) && all.some((r) => r.id === now.id), 'design_revisions keeps every version');
    await pump(fx, ctx, () => (fx.scripted.launches({ work_item: stageWork(fx.home, p.id, 3, 2)?.id }).length > 0 ? true : undefined), { what: 'the Android stage released', max: 40 });
    assertNoSilentHold(fx.home, p.id, '(g)');
    void KERNEL_KINDS;
  });
});

// The late variant's requirements (R1 phase 1; R2, R3 phase 2) and its phase-2 stages.
function LATE_REQUIREMENTS() {
  return FOUR.base.filter((r) => ['R1', 'R2', 'R3'].includes(r.key)).map((r) => ({ ...r, phase: r.key === 'R1' ? 1 : 2 }));
}
function LATE_STAGE(n) {
  const s = n === 2
    ? { number: 2, goal: 'the web page', tasks: ['write web/index.html and web/app.css from the approved design'], modules: ['web'], implements: ['R2'], validation: { criteria: ['R2.1'] } }
    : { number: 3, goal: 'the Android app', tasks: ['write mobile/App.js from the approved design'], modules: ['mobile'], implements: ['R3'], validation: { criteria: ['R3.1'] } };
  return { ...PHASE_TWO_STAGES.android, ...s, validation: { ...PHASE_TWO_STAGES.android.validation, ...s.validation } };
}
