// M513, the policy and its keys (slice 44; kernel lane). M6 plan §3.6 M513;
// D7 §2, §11, A.7; BS6 §11.1; E143 item 1; SEAM.md §§480, 491, 499, 509, 516.
//
// (a) `before_build` set mid-project: only undispatched UI stages held;
//     nothing integrated touched; no `policy_widening`;
// (b) `off` with UI stages held and the design's human tests approved: the
//     holds released, `design.waived` per stage, the human tests pending;
// (c) `at_alpha` with UI stages held: the holds released, the review at
//     Alpha kept (`design_due` stage `alpha_review` on `alpha_complete`);
// (d) no `ui` module, under each value: inert, nothing raised, `GET
//     …/design` saying so;
// (e) the change's classification: on is a tightening, off is not a
//     widening of autonomy (E143 item 1 unchanged): each applied directly;
// (f) every A.7 key at its default, and a value outside its range refused
//     at configuration naming the key and its range, nothing changed.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { decisionsOfKind } from './harness/decisions.mjs';
import { changePolicy, getPolicy, policyRevisions } from './harness/journal.mjs';
import { alphaDeployed, alphaReady, journeyContext, phaseCompleted, planOfPhase, pump } from './harness/journey/drive.mjs';
import { scriptedEngine, tick, waitForIdle } from './harness/runs.mjs';
import { assertHoldsAccounted, createPantry, designEvents, designScripts, openDesignDue, readDesign, replanScriptFor, scriptBuilders, stageRow, stageWork, toPublished, variantSpec } from './harness/design/drive.mjs';
import { BEFORE_BUILD, KERNEL_KINDS } from './harness/design/check41.mjs';
import { API_ONLY, authoringByPhase, designWithCriterion, designedPantry, stageIdsOf, waivedEvents } from './harness/design/plan44.mjs';

const OFF = Object.freeze({ autonomy: 'phase', phase_size: { min: 1, max: 5 } });
const TO_ALPHA = Object.freeze({ autonomy: 'phase', alpha_deploy: 'on_phase_complete', phase_size: { min: 1, max: 5 } });
const OWNER_NO_TIGHTENING = Object.freeze(['check_correction_unclassifiable', 'check_correction_loosening', 'plan_approval']);
const MiB = 1024 * 1024;

// D7 A.7's keys at their defaults (BS6 §11.1; the units of SEAM.md §§491, 499, 509, 516).
const DEFAULTS = Object.freeze({
  design: 'off',
  design_preview: 'static',
  design_widths: [360, 720, 1280],
  design_orientations: ['portrait', 'landscape'],
  design_external_urls: ['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com'],
  assets_required_for: 'live',
  model_designer: 'opus',
  deadline_designer: 1800,
  designer_session_budget_billable_tokens: 3_000_000,
  design_tree_max_bytes: 32 * MiB,
  design_tree_max_files: 800,
  preview_memory_max: 256 * MiB,
  design_preview_ttl: 86_400,
  design_due_max_defer: 604_800,
  design_review_evidence_max_bytes: 64 * MiB,
});
// Values outside each key's range, and the bounds its refusal names (integers in the key's own unit).
const OUT_OF_RANGE = Object.freeze([
  ['design', 'always', []],
  ['design_preview', 'stack', []],
  ['design_widths', [], []],
  ['design_widths', [200], []],
  ['design_widths', [4000], []],
  ['design_widths', [360, 480, 600, 720, 960, 1280, 1600], []],
  ['design_orientations', [], []],
  ['design_orientations', ['sideways'], []],
  ['design_external_urls', 'cdn.jsdelivr.net', []],
  ['assets_required_for', 'alpha', []],
  ['deadline_designer', 299, [300, 10800]],
  ['deadline_designer', 10801, [300, 10800]],
  ['designer_session_budget_billable_tokens', 249_999, [250000, 20000000]],
  ['designer_session_budget_billable_tokens', 20_000_001, [250000, 20000000]],
  ['design_tree_max_bytes', MiB - 1, [1048576, 134217728]],
  ['design_tree_max_bytes', 128 * MiB + 1, [1048576, 134217728]],
  ['design_tree_max_files', 49, [50, 8000]],
  ['design_tree_max_files', 8001, [50, 8000]],
  ['preview_memory_max', 64 * MiB - 1, [67108864]],
  ['design_preview_ttl', 3599, [3600, 1209600]],
  ['design_preview_ttl', 1_209_601, [3600, 1209600]],
  ['design_due_max_defer', 3599, [3600, 2592000]],
  ['design_due_max_defer', 2_592_001, [3600, 2592000]],
  ['design_review_evidence_max_bytes', MiB - 1, [1048576, 2147483648]],
  ['design_review_evidence_max_bytes', 2 * 1024 * MiB + 1, [1048576, 2147483648]],
]);

const designHeld = (w) => ['design_pending', 'design_stale'].includes(w?.held) || (w?.held_intervals ?? []).some((i) => ['design_pending', 'design_stale'].includes(i.reason));
const launchesOf = (fx, p, n, phase = 1) => fx.scripted.launches({ work_item: stageWork(fx.home, p.id, n, phase)?.id });
const lastRevision = (fx, p) => policyRevisions(fx.home, p.id).at(-1);
const sortedIds = (ids) => [...ids].sort();

describe('M513 the policy and its keys', () => {
  test('(f) every A.7 key at its default; a value outside its range refused at configuration naming the key and its range, nothing changed', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createPantry(fx, { policy: OFF, name: 'pantry-keys' });
    const { effective } = await getPolicy(fx.engine, p.id);
    for (const [key, value] of Object.entries(DEFAULTS)) assert.deepEqual(effective[key], value, `${key} defaults to ${JSON.stringify(value)} (D7 A.7; BS6 §11.1) (${JSON.stringify(effective[key])})`);
    const before = policyRevisions(fx.home, p.id).length;
    const memory = effective.domain_memory_max;
    const cases = [...OUT_OF_RANGE, ...(Number.isFinite(memory) ? [['preview_memory_max', memory + 1, [67108864]]] : [])];
    for (const [key, value, bounds] of cases) {
      const res = await fx.engine.post(`/v1/projects/${p.id}/policy`, { [key]: value });
      assert.equal(res.status, 400, `${key} = ${JSON.stringify(value)} refused at configuration (→ ${res.status} ${res.text})`);
      assert.equal(res.body?.code, 'invalid_value', `${key}: invalid_value (${res.text})`);
      assert.ok((res.text ?? '').includes(key), `the refusal names ${key} (${res.text})`);
      for (const b of bounds) assert.ok((res.text ?? '').includes(String(b)), `the refusal names ${key}'s range (${b}) (${res.text})`);
    }
    assert.equal(policyRevisions(fx.home, p.id).length, before, 'no policy revision from any refusal');
    assert.deepEqual((await getPolicy(fx.engine, p.id)).effective.design, 'off', 'the defaults still in force');
  });

  test('(a) before_build set mid-project: only the undispatched UI stage held, the integrated one untouched, no policy_widening; (e) on and off each applied directly, neither a widening', async (t) => {
    const fx = await scriptedEngine(t);
    const v = variantSpec('webFirst');
    const { p } = await toPublished(fx, { policy: OFF, name: 'pantry-mid', spec: v.spec, files: v.files });
    designScripts(fx);
    authoringByPhase(fx);
    const replan = replanScriptFor('webFirst');
    fx.scripted.kindScript('replan', [replan, replan, replan]);
    scriptBuilders(fx, p.id, { noDesign: true });
    const ctx = journeyContext(fx, p, { lane: 'kernel' });
    // Phase 2's authoring (a tightening) is left for the owner, so its Android stage stays undispatched.
    ctx.answerKinds = [...OWNER_NO_TIGHTENING];
    await phaseCompleted(fx, ctx, 1, { max: 200 });
    await pump(fx, ctx, () => planOfPhase(fx.home, p.id, 2).find((x) => x.published_at), { what: 'phase 2 published', max: 40 });
    const [s2] = stageIdsOf(fx.home, p.id, [2]);
    const [s3] = stageIdsOf(fx.home, p.id, [3], 2);
    assert.deepEqual(launchesOf(fx, p, 3, 2), [], 'the fixture is live: the Android stage not dispatched');
    const integrated = { status: stageRow(fx.home, p.id, 2).status, work: stageWork(fx.home, p.id, 2) };
    assert.equal(integrated.work.status, 'complete', 'the fixture is live: the web stage integrated in phase 1');
    // (a), (e) on: a tightening, applied directly.
    const res = await fx.engine.post(`/v1/projects/${p.id}/policy`, { design: 'before_build' });
    assert.equal(res.status, 200, `design: before_build applied directly, no confirmation (D7 §2) (→ ${res.status} ${res.text})`);
    assert.equal(lastRevision(fx, p).widens_authority, 0, 'recorded as not widening authority');
    assert.deepEqual(decisionsOfKind(fx.home, p.id, 'policy_widening'), [], 'no policy_widening');
    await pump(fx, ctx, () => (designEvents(fx.home, 'design.inventory_derived', p.id).length > 0 ? true : undefined), { what: 'the inventory derived on the policy revision', max: 6 });
    ctx.answerKinds = [...KERNEL_KINDS];
    const held = await pump(fx, ctx, () => (stageWork(fx.home, p.id, 3, 2)?.held === 'design_pending' ? stageWork(fx.home, p.id, 3, 2) : undefined), { what: 'the undispatched Android stage held design_pending', max: 30 });
    assert.ok(held, 'held');
    assert.deepEqual(launchesOf(fx, p, 3, 2), [], 'and not dispatched');
    assert.equal(stageRow(fx.home, p.id, 2).status, integrated.status, 'the integrated web stage keeps its status');
    assert.equal(stageWork(fx.home, p.id, 2).status, 'complete', 'its work stays complete');
    assert.equal(designHeld(stageWork(fx.home, p.id, 2)), false, 'and is never held for design');
    assert.deepEqual(openDesignDue(fx.home, p.id)?.evidence?.held_stages, [s3], 'design_due names the Android stage only');
    assert.ok(s2, 'stage 2 exists');
    await assertHoldsAccounted(fx, p.id, '(a)');
    // (e) off: applied directly, not a widening (E143 item 1 unchanged); the hold released with a waiver.
    const off = await fx.engine.post(`/v1/projects/${p.id}/policy`, { design: 'off' });
    assert.equal(off.status, 200, `design: off applied directly, not a widening of autonomy (E143 item 1) (→ ${off.status} ${off.text})`);
    assert.equal(lastRevision(fx, p).widens_authority, 0, 'recorded as not widening authority');
    assert.deepEqual(decisionsOfKind(fx.home, p.id, 'policy_widening'), [], 'still no policy_widening');
    await pump(fx, ctx, () => (launchesOf(fx, p, 3, 2).length > 0 ? true : undefined), { what: 'the Android stage released and dispatched', max: 30 });
    assert.deepEqual(waivedEvents(fx.home, p.id).map((e) => e.subject?.stage), [s3], 'design.waived on the released stage');
    await assertHoldsAccounted(fx, p.id, '(e)');
  });

  test('(b) off with the UI stages held and the design\'s human tests approved: the holds released, design.waived per stage, the human tests pending', async (t) => {
    const fx = await scriptedEngine(t);
    const d = await designedPantry(fx, { name: 'pantry-off', model: designWithCriterion, answerKinds: OWNER_NO_TIGHTENING });
    const { p, ctx } = d;
    await pump(fx, ctx, () => ([2, 3].every((n) => stageWork(fx.home, p.id, n)?.held === 'design_pending') ? true : undefined), { what: 'the UI stages held, the design approved and not ready', max: 80 });
    const ui = stageIdsOf(fx.home, p.id, [2, 3]);
    await changePolicy(fx.engine, p.id, { design: 'off' });
    scriptBuilders(fx, p.id, { noDesign: true });
    await pump(fx, ctx, () => ([2, 3].every((n) => launchesOf(fx, p, n).length > 0) ? true : undefined), { what: 'both UI stages released and dispatched', max: 40 });
    assert.deepEqual(sortedIds(waivedEvents(fx.home, p.id).map((e) => e.subject?.stage)), sortedIds(ui), 'design.waived once per released stage (D7 §2)');
    const design = await readDesign(fx, p.id);
    for (const target of ['web', 'android']) assert.equal((design.human_tests ?? []).find((h) => h.target === target)?.status, 'pending', `${target}'s design human test stays visibly pending (D7 §2)`);
    await assertHoldsAccounted(fx, p.id, '(b)');
  });

  test('(c) at_alpha with the UI stages held: the holds released, the review at Alpha kept', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await toPublished(fx, { policy: { ...TO_ALPHA, design: 'before_build' }, name: 'pantry-to-at-alpha' });
    designScripts(fx);
    scriptBuilders(fx, p.id, { noDesign: true });
    const ctx = journeyContext(fx, p, { lane: 'kernel' });
    ctx.answerKinds = [...KERNEL_KINDS];
    await pump(fx, ctx, () => ([2, 3].every((n) => stageWork(fx.home, p.id, n)?.held === 'design_pending') ? true : undefined), { what: 'the UI stages held', max: 80 });
    await alphaReady(fx, ctx);
    await changePolicy(fx.engine, p.id, { design: 'at_alpha' });
    await pump(fx, ctx, () => ([2, 3].every((n) => launchesOf(fx, p, n).length > 0) ? true : undefined), { what: 'both UI stages released and dispatched', max: 40 });
    await assertHoldsAccounted(fx, p.id, '(c) released');
    await alphaDeployed(fx, ctx, { max: 200 });
    const due = await pump(fx, ctx, () => (openDesignDue(fx.home, p.id)?.evidence?.stage === 'alpha_review' ? openDesignDue(fx.home, p.id) : undefined), { what: 'design_due alpha_review on alpha_complete', max: 20 });
    assert.ok(due, 'the review at Alpha kept (D7 §2)');
  });

  test('(d) no ui module under each value: inert, nothing raised, GET …/design saying so', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await toPublished(fx, { policy: BEFORE_BUILD, name: 'pantry-api-only', spec: API_ONLY.spec, files: API_ONLY.files });
    designScripts(fx);
    const ctx = journeyContext(fx, p, { lane: 'kernel' });
    ctx.answerKinds = [...KERNEL_KINDS];
    for (const value of ['before_build', 'at_alpha', 'both', 'off']) {
      if (value !== 'before_build') await changePolicy(fx.engine, p.id, { design: value });
      await tick(fx.engine, p.id, { rounds: 2 });
      await waitForIdle(fx.home, p.id);
      const read = await readDesign(fx, p.id);
      if (value !== 'off') {
        assert.equal(read.inert, true, `${value}: GET …/design says the policy is inert (D7 §2; SEAM.md §480) (${JSON.stringify(read).slice(0, 400)})`);
        assert.ok(typeof read.inert_reason === 'string' && read.inert_reason.length > 0, `${value}: and why`);
      }
      assert.deepEqual(decisionsOfKind(fx.home, p.id, 'design_due'), [], `${value}: nothing raised`);
      assert.equal(designHeld(stageWork(fx.home, p.id, 1)), false, `${value}: nothing held`);
    }
    void ctx;
  });
});
