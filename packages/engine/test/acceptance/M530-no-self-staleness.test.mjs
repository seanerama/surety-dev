// M530, no self-staleness (slice 44; kernel lane). M6 plan §3.6 M530; D7
// §7.4, §10.6; Q1; G5; E156 Q3; BS6 §11.5; SEAM.md §§486, 517, 519.
//
// (a) the batch's `design_approval` binds the spec version its own change
//     creates (that change's diff hash and the version number) and the
//     inventory derived from that version;
// (b) approving the batch: the design revision current against n+1, in the
//     transaction that applies n+1; no screen stale; nothing re-raised;
// (c) another spec change approved after the batch's raise and before its
//     answer: the batch stale (n+1 is no longer the number it takes). Under
//     D6 §4.2's one-pending rule another change can be approved only once
//     the batch's own change has left (answered `reject`); that is the form
//     written (COVERAGE);
// (d) the n+1 inventory differing from n's at raise: the batch not raised,
//     the close's product recorded, `design_due` open naming the difference;
// (e) the batch's human-test requirements are never UI requirements of the
//     inventory: n+1's inventory equals n's (assigned only as M505 (h) to
//     (l), not repeated here);
// (f) the assignment's binding (E156 Q3): the roadmap and plan versions
//     bound beside the spec version and the inventory; a roadmap revision
//     (R3 moved to a new phase 3) between the raise and the answer: the
//     batch stale and re-raised with the new assignment, the design not
//     approved from the stale answer; between the answer and the effect
//     (barrier `design.approved`): the effect refused whole (no design, no
//     n+1, no assignment), the batch re-raised. M505 (j) has the same two
//     windows for a plan publication;
// (g) a first design at Alpha (M529's path), every phase complete, its
//     human tests assigned to the completed phase: the design approved and
//     current against n+1; the human tests pending, the phase not reopened,
//     no machine evidence created.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CODES, consume, decision, reachBarrier } from './harness/decisions.mjs';
import { releaseBarrier } from './harness/engine.mjs';
import { armBarrier } from './harness/journal.mjs';
import { alphaDeployed, alphaReady, journeyContext, planOfPhase, pump, requirementsOf, roadmapRevisions, specRevisions } from './harness/journey/drive.mjs';
import { phaseOneHistory } from './harness/journey/final153.mjs';
import { scriptedEngine, tick, waitForIdle } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { openSession, saveSession, sayAndSettle, scriptTurns, turnResult } from './harness/sessions.mjs';
import { postCloseRaw } from './harness/session-lane.mjs';
import { withStore } from './harness/store.mjs';
import { REQUIREMENTS } from './harness/design/reference.mjs';
import { answerWith, assertNoSilentHold, designScripts, inventoryOf, openDesignDue, openOfKind, readDesign, scriptBuilders, toPublished, variantSpec } from './harness/design/drive.mjs';
import { BEFORE_BUILD, KERNEL_KINDS, approveBatch, checkSession, designModel, filesOf, scriptVariant } from './harness/design/check41.mjs';
import {
  approveReviewBatch,
  authoringByPhase,
  batchSpec,
  currentRevision,
  designedPantry,
  latestRequest,
  ownerChange,
  replanWith,
  revisionsOf,
  roadmapRevision,
  specOf,
  specWriter,
  staleEvents,
  staleKeys,
} from './harness/design/plan44.mjs';

const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const count = (home, table, where = '1 = 1', ...params) => withStore(home, (db) => db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${where}`).get(...params).n);
const stale = (res) => res.status === 409 && [CODES.stale, CODES.invalidated].includes(res.body?.code);
const engineRoadmaps = (fx, p) => roadmapRevisions(fx.home, p.id).filter((r) => r.approved_by === 'engine:design_approval');
const TO_ALPHA = Object.freeze({ autonomy: 'phase', alpha_deploy: 'on_phase_complete', phase_size: { min: 1, max: 5 } });

// The late variant (phase 1 the API; phase 2 the two UI stages), as M505's.
const LATE = Object.freeze({ ...variantSpec('late'), base: REQUIREMENTS.map((r) => ({ ...r, phase: r.key === 'R1' ? 1 : 2 })), phaseOf: () => 2 });
const LATE_STAGES = Object.freeze([
  { number: 2, goal: 'the web page', tasks: ['write web/index.html and web/app.css from the approved design'], modules: ['web'], implements: ['R2'], adrs: ['ADR-001'], depends_on: [], validation: { criteria: ['R2.1'], kinds: ['acceptance', 'smoke', 'integration', 'security_lint'], sensitive_areas: [] }, integration_obligations: [] },
]);
// The replan after phase 1: a roadmap revision moving R3 (and the Android module) to a new phase 3; phase 2 the web page.
function movingReplan(fx, p) {
  const roadmap = roadmapRevision(fx.home, p.id, (phases) => [
    ...phases.map((x) => (x.number === 2 ? { ...x, modules: x.modules.filter((m) => m !== 'mobile'), requirement_ids: x.requirement_ids.filter((k) => k !== 'R3') } : x)),
    { number: 3, goal: 'the pantry on Android', modules: ['mobile'], requirement_ids: ['R3'], depends_on: [2] },
  ], { moved: [{ key: 'R3', from: 2, to: 3 }] });
  return replanWith({ phase: 2, stages: LATE_STAGES, spec_version: 1, roadmap_version: 1, roadmap });
}
const assignmentOf = (row, target) => (row.evidence?.human_test_assignments ?? []).find((a) => a.target === target) ?? null;

describe('M530 no self-staleness', () => {
  test('(a) the batch binds the version its own change creates and the inventory from it; (b) approved: current against n+1 in the transaction applying it, nothing stale, nothing re-raised; (e) n+1\'s inventory equals n\'s', async (t) => {
    const fx = await scriptedEngine(t);
    const d = await designedPantry(fx, { name: 'pantry-self', approve: false });
    const { p, ctx, batch, v2 } = d;
    const n = inventoryOf(p);
    const m = batch.design_approval.manifest ?? {};
    assert.equal(specRevisions(fx.home, p.id).length, 1, 'the fixture is live: the current spec is version 1');
    assert.equal(m.spec_version, 2, `(a) bound to version 2, the number the batched change takes (D7 §7.4) (${JSON.stringify(m)})`);
    const request = rows(fx.home, 'SELECT * FROM "spec_change_requests" WHERE "id" = ?', batch.spec_change.subject_id)[0];
    assert.equal(request.source, 'design', 'the batched change');
    assert.equal(m.spec_change_diff_hash, request.proposal_blob, '(a) and to its diff (SEAM.md §517)');
    assert.equal(m.inventory_digest, n.inventory_digest, '(a) and the inventory derived from version 2 (equal to version 1\'s)');
    // (b)
    const approved = await approveBatch(fx, ctx, batch);
    const v2row = specRevisions(fx.home, p.id).find((r) => r.version === 2);
    assert.ok(v2row, 'version 2 applied');
    assert.ok([v2row.id, 2].includes(approved.current_against_spec), `(b) design_revisions current against version 2 (${approved.current_against_spec})`);
    assert.equal(approved.approved_at, v2row.created_at, `(b) in the transaction that applies version 2: the design's approved_at is version 2's created_at (SEAM.md §519) (${approved.approved_at}; ${v2row.created_at})`);
    await tick(fx.engine, p.id, { rounds: 3 });
    await waitForIdle(fx.home, p.id);
    assert.deepEqual(staleKeys(fx.home, approved.id), [], '(b) no screen stale');
    assert.deepEqual(staleEvents(fx.home, p.id), [], '(b) no design.stale');
    assert.deepEqual(openOfKind(fx.home, p.id, 'design_approval'), [], '(b) nothing re-raised');
    assert.notEqual(openDesignDue(fx.home, p.id)?.evidence?.stage, 'revise', '(b) no design_due revise');
    // (e) the human tests are not UI requirements of the inventory.
    const after = inventoryOf(p);
    assert.equal(after.inventory_digest, n.inventory_digest, '(e) n+1\'s inventory equals n\'s (D7 §7.4)');
    const humanKeys = Object.values(v2.humanKeys);
    assert.deepEqual((after.ui_requirements ?? []).map((r) => r.key).filter((k) => humanKeys.includes(k)), [], `(e) the human-test requirements (${humanKeys}) are never UI requirements of the inventory, though marked **Surface:** ui`);
    assert.equal(currentRevision(fx.home, p.id).inventory_digest ?? n.inventory_digest, n.inventory_digest, '(e) the approved revision recorded against that inventory');
    assertNoSilentHold(fx.home, p.id, '(b)');
  });

  test('(c) another spec change approved after the raise and before the design approval\'s answer: the batch stale', async (t) => {
    const fx = await scriptedEngine(t);
    const { p, ctx, batch } = await designedPantry(fx, { name: 'pantry-other-change', approve: false });
    // The batch's own change leaves (D6 §4.2: one pending at a time), the design approval unanswered.
    await consume(fx, p.id, batch.spec_change, 'reject');
    await tick(fx.engine, p.id, { rounds: 2 });
    const open = await pump(fx, ctx, () => openOfKind(fx.home, p.id, 'design_approval').at(-1), { what: 'the design approval still open', max: 6 });
    const reqs = REQUIREMENTS.map((r) => (r.key === 'R1' ? { ...r, statement: 'The service lists the pantry\'s items and adds an item, over HTTP with JSON bodies, on loopback only.' } : r));
    await ownerChange(fx, ctx, { text: specOf({ version: 2, requirements: reqs }), changes: [{ key: 'R1', kind: 'text_changed', reason: 'loopback only' }], say: 'The API listens on loopback only.' });
    assert.equal(specRevisions(fx.home, p.id).at(-1).version, 2, 'the fixture is live: another change took version 2');
    const res = await answerWith(fx, p.id, decision(fx.home, open.id), 'approve_without_criteria');
    assert.ok(stale(res), `the design approval answered with its earlier preview is refused stale (→ ${res.status} ${res.text?.slice(0, 400)})`);
    assert.equal(currentRevision(fx.home, p.id), null, 'nothing approved from it');
    assertNoSilentHold(fx.home, p.id, '(c)');
  });

  test('(d) the n+1 inventory differing from n\'s at raise: the batch not raised, the close\'s product recorded, design_due open naming the difference', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await toPublished(fx, { policy: BEFORE_BUILD, name: 'pantry-differs' });
    const model = designModel(inventoryOf(p));
    // The batch's Spec Writer also marks R1 as a web UI requirement: n+1's inventory gains R1.
    const v2 = batchSpec({ base: REQUIREMENTS.map((r) => (r.key === 'R1' ? { ...r, surface: 'ui (web)' } : r)), criteria: model.criteria });
    const ctx = scriptVariant(fx, p, null);
    fx.scripted.kindScript('spec_change', specWriter(v2.text, [...v2.changes, { key: 'R1', kind: 'text_changed', reason: 'R1 on the web page too' }]));
    authoringByPhase(fx);
    ctx.answerKinds = [...KERNEL_KINDS];
    const out = await checkSession(fx, p.id, [{ name: 'the design', model }]);
    const closed = await postCloseRaw(fx, p.id, out.run.id, {});
    assert.equal(closed.status, 200, `the close (${closed.text?.slice(0, 400)})`);
    const due = await pump(fx, ctx, () => {
      const x = openDesignDue(fx.home, p.id);
      return x && /R1/.test(JSON.stringify(x.evidence?.inventory_difference ?? '')) ? x : undefined;
    }, { what: 'design_due naming the inventory\'s difference (SEAM.md §519)', max: 40 });
    assert.ok(due, 'design_due open naming the difference: never silent');
    assert.deepEqual(openOfKind(fx.home, p.id, 'design_approval'), [], 'the batch not raised: no design_approval');
    const product = revisionsOf(fx.home, p.id).at(-1);
    assert.ok(product && product.status === 'proposed', `the close's product recorded (${JSON.stringify(product)})`);
    assert.equal(specRevisions(fx.home, p.id).length, 1, 'no version 2');
    assertNoSilentHold(fx.home, p.id, '(d)');
  });

  test('(f) a roadmap revision between the raise and the answer: the roadmap and plan versions bound; the answer stale, the batch re-raised with the new assignment, nothing approved or assigned from it', async (t) => {
    const fx = await scriptedEngine(t);
    const { p, ctx, batch } = await designedPantry(fx, { name: 'pantry-roadmap-a', variant: LATE, approve: false });
    const m = batch.design_approval.manifest ?? {};
    assert.equal(m.roadmap_version, 1, `the roadmap version bound beside the spec version and the inventory (${JSON.stringify(m)})`);
    assert.ok(Array.isArray(m.plan_versions) && m.plan_versions.length > 0, 'and the plan versions');
    assert.ok(m.spec_version === 2 && m.inventory_digest, 'beside the spec version and the inventory');
    assert.equal(assignmentOf(batch.design_approval, 'android')?.phase, 2, 'android\'s human test proposed for phase 2');
    fx.scripted.kindScript('replan', [movingReplan(fx, p), movingReplan(fx, p), movingReplan(fx, p)]);
    await pump(fx, ctx, () => (roadmapRevisions(fx.home, p.id).some((r) => r.version === 2) && planOfPhase(fx.home, p.id, 2).some((x) => x.published_at) ? true : undefined), { what: 'roadmap version 2 and phase 2 published', max: 200 });
    const res = await answerWith(fx, p.id, batch.design_approval, 'approve');
    assert.ok(stale(res), `the answer on the earlier versions is refused stale (→ ${res.status} ${res.text?.slice(0, 400)})`);
    assert.equal(currentRevision(fx.home, p.id), null, 'the design not approved from the stale answer');
    assert.deepEqual(engineRoadmaps(fx, p), [], 'nothing assigned');
    const next = await pump(fx, ctx, () => openOfKind(fx.home, p.id, 'design_approval').find((x) => x.id !== batch.design_approval.id), { what: 'the batch re-raised', max: 10 });
    assert.equal(next.manifest?.roadmap_version, 2, 'bound to roadmap version 2');
    assert.equal(assignmentOf(next, 'android')?.phase, 3, `android's human test now proposed for phase 3, the phase of its last UI stage (${JSON.stringify(next.evidence?.human_test_assignments)})`);
    assertNoSilentHold(fx.home, p.id, '(f)');
  });

  test('(f) a roadmap revision between the answer and the effect (barrier design.approved): the effect refused whole, the batch re-raised', async (t) => {
    const fx = await scriptedEngine(t);
    const { p, ctx, batch } = await designedPantry(fx, { name: 'pantry-roadmap-b', variant: LATE, approve: false });
    fx.scripted.kindScript('replan', [movingReplan(fx, p), movingReplan(fx, p), movingReplan(fx, p)]);
    await armBarrier(fx.engine, 'design.approved', 'pause');
    const answered = [answerWith(fx, p.id, batch.design_approval, 'approve').catch((e) => e), answerWith(fx, p.id, batch.spec_change, 'approve').catch((e) => e)];
    await reachBarrier(fx, p.id, 'design.approved');
    await pump(fx, ctx, () => (roadmapRevisions(fx.home, p.id).some((r) => r.version === 2) ? true : undefined), { what: 'roadmap version 2 published while the effect waits', max: 200 });
    await releaseBarrier(fx.engine, 'design.approved');
    await Promise.all(answered);
    await tick(fx.engine, p.id, { rounds: 2 });
    await waitForIdle(fx.home, p.id);
    assert.equal(currentRevision(fx.home, p.id), null, 'the design not approved');
    assert.equal(specRevisions(fx.home, p.id).length, 1, 'n+1 not applied');
    assert.deepEqual(engineRoadmaps(fx, p), [], 'no assignment applied');
    const next = await pump(fx, ctx, () => openOfKind(fx.home, p.id, 'design_approval').find((x) => x.id !== batch.design_approval.id), { what: 'the batch re-raised', max: 10 });
    assert.equal(next.manifest?.roadmap_version, 2, 'against the new roadmap version');
    assertNoSilentHold(fx.home, p.id, '(f) effect');
  });

  test('(g) a first design at Alpha, every phase complete: approved current against n+1, its human tests assigned to the completed phase and pending, the phase not reopened, no machine evidence created', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await toPublished(fx, { policy: { ...TO_ALPHA, design: 'at_alpha' }, name: 'pantry-first-at-alpha' });
    designScripts(fx);
    scriptBuilders(fx, p.id, { noDesign: true });
    const ctx = journeyContext(fx, p, { lane: 'kernel' });
    ctx.answerKinds = [...KERNEL_KINDS];
    await alphaReady(fx, ctx);
    await alphaDeployed(fx, ctx, { max: 200 });
    await pump(fx, ctx, () => (openDesignDue(fx.home, p.id)?.evidence?.stage === 'alpha_review' ? true : undefined), { what: 'design_due alpha_review', max: 20 });
    await waitForIdle(fx.home, p.id);
    const history = phaseOneHistory(fx.home, p.id);
    // The review session produces the first design (D7 §10.6): origin observed.
    const model = designModel(inventoryOf(p));
    model.design.origin = 'observed';
    const v2 = batchSpec({ base: REQUIREMENTS, criteria: model.criteria });
    fx.scripted.kindScript('spec_change', specWriter(v2.text, v2.changes));
    const run = await openSession(fx, p.id, 'designer', { mode: 'review' });
    const review = `${JSON.stringify({ subject: { kind: 'candidate' }, screens: [], revised_design: false, first_design: true }, null, 2)}\n`;
    const files = { ...filesOf(model), '.surety/design/reviews/review-1.json': review };
    scriptTurns(fx, run.id, [{ steps: [...Object.entries(files).map(([path, content]) => step.write(path, content)), step.result(turnResult({ reply: 'The first design, drawn from the Alpha.', artifact_changed: true, done: true }))] }]);
    await sayAndSettle(fx, p.id, run.id, 'There is no design yet: draw it from what runs.');
    await saveSession(fx, p.id, run.id);
    const closed = await postCloseRaw(fx, p.id, run.id, {});
    assert.equal(closed.status, 200, `the review's close (${closed.text?.slice(0, 400)})`);
    const before = {
      checks: count(fx.home, 'checks', '"project" = ?', p.id),
      results: count(fx.home, 'check_results', '"project" = ?', p.id),
      evaluations: count(fx.home, 'gate_evaluations', '"project" = ?', p.id),
      signoffs: rows(fx.home, 'SELECT s."id" FROM "signoffs" s JOIN "candidates" k ON k."id" = s."candidate" WHERE k."project" = ?', p.id).length,
      scopes: count(fx.home, 'acceptance_scopes'),
    };
    await approveReviewBatch(fx, ctx, { verdicts: 'any' });
    const rev = await pump(fx, ctx, () => currentRevision(fx.home, p.id) ?? undefined, { what: 'the first design approved', max: 20 });
    assert.equal(rev.scope, 'initial_review', 'approved as an initial design (D7 §10.6)');
    const v2row = specRevisions(fx.home, p.id).find((r) => r.version === 2);
    assert.ok(v2row && [v2row.id, 2].includes(rev.current_against_spec), `current against version 2 (${rev.current_against_spec})`);
    await tick(fx.engine, p.id, { rounds: 3 });
    await waitForIdle(fx.home, p.id);
    const reqs = requirementsOf(fx.home, p.id);
    for (const key of Object.values(v2.humanKeys)) assert.equal(reqs.find((r) => r.key === key)?.assigned_phase, 1, `${key} assigned to phase 1, the completed phase holding its target's last UI stage`);
    const design = await readDesign(fx, p.id);
    for (const target of ['web', 'android']) assert.equal((design.human_tests ?? []).find((h) => h.target === target)?.status, 'pending', `${target}'s human test pending`);
    assert.equal(count(fx.home, 'checks', '"project" = ?', p.id), before.checks, 'no check created');
    assert.equal(count(fx.home, 'check_results', '"project" = ?', p.id), before.results, 'no check result');
    assert.equal(count(fx.home, 'gate_evaluations', '"project" = ?', p.id), before.evaluations, 'no gate evaluation');
    assert.equal(rows(fx.home, 'SELECT s."id" FROM "signoffs" s JOIN "candidates" k ON k."id" = s."candidate" WHERE k."project" = ?', p.id).length, before.signoffs, 'no sign-off');
    assert.equal(count(fx.home, 'acceptance_scopes'), before.scopes, 'no acceptance scope');
    const now = phaseOneHistory(fx.home, p.id);
    assert.deepEqual(now.plan, history.plan, 'phase 1 not reopened: its plan row unchanged');
    assert.deepEqual(now.signoffs, history.signoffs, 'its sign-offs unchanged');
    assert.deepEqual(now.phaseEvaluations, history.phaseEvaluations, 'its evaluations unchanged');
    assertNoSilentHold(fx.home, p.id, '(g)');
    void latestRequest;
    void BEFORE_BUILD;
  });
});
