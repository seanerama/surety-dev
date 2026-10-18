// M507, design readiness and the third milestone (slice 40; kernel lane).
// M6 plan §3.2 M507; D7 §7.5, §8.2; G6; Q1; SEAM.md §§485, 487.
//
// (a) `before_build`: a phase with an API stage and UI stages, no design:
//     the UI stages' stage_build held `design_pending`; the API stage
//     builds, verifies and pipelines;
// (b) a stage depending on a UI stage: waits on its code milestone only;
// (c) the design and its spec change approved (the logo held, every slot a
//     placeholder, (e)): the correction captured, not applied: no
//     readiness; applied: design_ready_at, design.ready, work.dependency_met;
//     rejected: no readiness, the item's repair or blocker;
// (d) approved without criteria: ready at approval;
// (e) every slot a placeholder: ready; no asset status read in readiness;
// (f) `at_alpha` and `off`: no hold;
// (g) gates while the design criteria's checks do not exist:
//     ACCEPTANCE_SCOPE_INCOMPLETE naming the design criteria.
//
// M519's finding F1 (SEAM.md §549; the driver's ruling of 2026-10-17):
// (c), (g) a design whose criteria include kind `human`, written by the
//     Spec Writer as plain criteria, the correction covering only the
//     checkable ones and approved: ready; the UI stages released and built;
//     no gate names a human-kind criterion ACCEPTANCE_SCOPE_INCOMPLETE;
// (c) the same while the correction is pending, then while its proposal is
//     unapplied: no readiness, and GET …/design (and design_due when open)
//     names what readiness waits on and the next action.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { consume, decision, decisionsOfKind } from './harness/decisions.mjs';
import { eventsAbout, evaluationsOfKind, journeyContext, pump, specRevisions } from './harness/journey/drive.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { REQUIREMENTS, ROADMAP_JSON, STAGES, specText } from './harness/design/reference.mjs';
import { CHECKABLE_IDS, CRITERIA_WITH_HUMAN, HUMAN_IDS, HUMAN_KIND_IDS, V2_WITH_HUMAN, assertV2Shape, checksCovering, criterionMapOf, designChange, readinessFacts, scopeIncompleteNaming } from './harness/design/ready.mjs';
import {
  answerWith,
  assertHoldsAccounted,
  batchOf,
  builderScript,
  designRevisions,
  designScripts,
  designerSession,
  effectiveAssets,
  openOfKind,
  readDesign,
  scriptBuilders,
  specChangeScriptFor,
  stageRow,
  stageWork,
  toPublished,
  validDesign,
} from './harness/design/drive.mjs';

const BEFORE_BUILD = Object.freeze({ design: 'before_build', autonomy: 'phase', phase_size: { min: 1, max: 5 } });
const OWNER = ['check_correction_unclassifiable', 'check_correction_loosening', 'plan_approval'];
const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));

async function project(fx, { policy = BEFORE_BUILD, name, spec, files, noDesign = false } = {}) {
  const { p } = await toPublished(fx, { policy, name, spec, files });
  designScripts(fx);
  scriptBuilders(fx, p.id, { noDesign });
  const ctx = journeyContext(fx, p, { lane: 'kernel' });
  ctx.answerKinds = [...OWNER, 'check_correction_tightening'];
  return { p, ctx };
}
const untilBatch = (fx, ctx) =>
  pump(fx, ctx, () => {
    const b = batchOf(fx.home, ctx.project);
    return b?.spec_change ? b : undefined;
  }, { what: 'the batch', max: 40 });
const designed = async (fx, p) => designerSession(fx, p.id, [{ files: validDesign(p), say: 'Draw Pantry.', result: { done: true } }]);
// M519's shape (SEAM.md §549): the design with two human-kind criteria, the
// Spec Writer writing them as plain criteria R2.4 and R3.3.
const designedWithHuman = async (fx, p) => {
  fx.scripted.kindScript('spec_change', specChangeScriptFor(V2_WITH_HUMAN));
  return designerSession(fx, p.id, [{ files: validDesign(p, { criteria: CRITERIA_WITH_HUMAN }), say: 'Draw Pantry; the look is judged by a person.', result: { done: true } }]);
};
// The approved revision's entry on GET …/design.
const revisionRead = (read, id) => (read.revisions ?? []).find((r) => r.id === id) ?? null;
const readyAt = (home, project) => designRevisions(home, project).find((r) => r.ready_at)?.ready_at ?? null;
const uiLaunches = (fx, p) => [2, 3].flatMap((n) => fx.scripted.launches({ work_item: stageWork(fx.home, p.id, n)?.id }));

describe('M507 design readiness and the third milestone', () => {
  test('(a) before_build, no design: the UI stages\' work held design_pending; the API stage builds, verifies and pipelines', async (t) => {
    const fx = await scriptedEngine(t);
    const { p, ctx } = await project(fx);
    await pump(fx, ctx, () => (stageRow(fx.home, p.id, 1)?.status === 'verified' ? true : undefined), { what: 'the API stage verified', max: 80 });
    for (const n of [2, 3]) {
      const w = stageWork(fx.home, p.id, n);
      assert.ok((w.depends_on ?? []).some((d) => d.milestone === 'design_ready'), `stage ${n} depends on design_ready (G6) (${JSON.stringify(w.depends_on)})`);
      assert.equal(w.held, 'design_pending', `stage ${n} held design_pending (${w.held})`);
      assert.ok(w.held_intervals.some((i) => i.reason === 'design_pending'), 'a recorded interval');
    }
    assert.deepEqual(uiLaunches(fx, p), [], 'no UI Builder');
    assert.equal((stageWork(fx.home, p.id, 1).depends_on ?? []).some((d) => d.milestone === 'design_ready'), false, 'the API stage never waits on design');
    await assertHoldsAccounted(fx, p.id, '(a)');
  });

  test('(b) a stage depending on a UI stage waits on its code milestone only', async (t) => {
    const fx = await scriptedEngine(t);
    const R4 = { key: 'R4', title: 'The page\'s favicon route', phase: 1, statement: 'The API serves the web page\'s favicon.', criteria: [{ id: 'R4.1', text: 'Given the service is running, when a client requests GET /favicon.ico, then it answers 200.' }] };
    const S4 = { number: 4, goal: 'the favicon route', tasks: ['serve GET /favicon.ico'], modules: ['api'], implements: ['R4'], adrs: ['ADR-001'], depends_on: [2], validation: { criteria: ['R4.1'], kinds: STAGES[0].validation.kinds, sensitive_areas: [] }, integration_obligations: [] };
    const roadmap = { ...ROADMAP_JSON, phases: [{ ...ROADMAP_JSON.phases[0], requirement_ids: ['R1', 'R2', 'R3', 'R4'] }] };
    const { p } = await project(fx, { spec: specText({ requirements: [...REQUIREMENTS, R4] }), files: { stages: [...STAGES, S4], roadmap } });
    const w4 = stageWork(fx.home, p.id, 4);
    const stage2 = stageRow(fx.home, p.id, 2);
    const deps = w4.depends_on ?? [];
    assert.ok(deps.some((d) => d.milestone === 'stage_code' && d.stage === stage2.id), `stage 4 waits on stage 2's code milestone (${JSON.stringify(deps)})`);
    assert.equal(deps.some((d) => d.milestone === 'design_ready'), false, 'and not on design');
  });

  test('(c), (e) the batch approved with the logo held, every slot a placeholder: the correction captured, no readiness; applied: design_ready_at, design.ready, the UI stages\' work.dependency_met; no asset status read', async (t) => {
    const fx = await scriptedEngine(t);
    const { p, ctx } = await project(fx);
    ctx.answerKinds = [...OWNER];
    await designed(fx, p);
    const batch = await untilBatch(fx, ctx);
    assert.equal((await answerWith(fx, p.id, batch.design_approval, 'approve', { assets_held: ['logo'] })).status, 200);
    await consume(fx, p.id, batch.spec_change, 'approve');
    const captured = await pump(fx, ctx, () => openOfKind(fx.home, p.id, 'check_correction_tightening').find((d) => d) ?? undefined, { what: 'the design criteria\'s correction captured', max: 40 });
    assert.equal(readyAt(fx.home, p.id), null, 'captured, not applied: no readiness');
    assert.deepEqual(uiLaunches(fx, p), [], 'no UI Builder');
    assert.ok(effectiveAssets(fx.home, p.id).length > 0 && effectiveAssets(fx.home, p.id).every((e) => e.source === 'placeholder'), `(e) every effective slot a placeholder (${JSON.stringify(effectiveAssets(fx.home, p.id))})`);
    await consume(fx, p.id, decision(fx.home, captured.id), 'approve');
    const ready = await pump(fx, ctx, () => readyAt(fx.home, p.id) ?? undefined, { what: 'readiness', max: 20 });
    assert.ok(ready, 'design_ready_at set on the application');
    assert.equal(eventsAbout(fx.home, 'design.ready', p.id).length, 1, 'design.ready');
    await tick(fx.engine, p.id, { rounds: 1 });
    for (const n of [2, 3]) {
      const w = stageWork(fx.home, p.id, n);
      assert.ok(w.milestones_met.includes('design_ready'), `stage ${n}'s design_ready milestone met (${JSON.stringify(w.milestones_met)})`);
    }
    const met = eventsAbout(fx.home, 'work.dependency_met', p.id).filter((e) => [2, 3].some((n) => e.subject?.work_item === stageWork(fx.home, p.id, n).id));
    assert.ok(met.length >= 1, 'work.dependency_met for the UI stages');
    const readySeq = eventsAbout(fx.home, 'design.ready', p.id)[0].seq;
    assert.ok(met.every((e) => e.seq >= readySeq), 'no earlier than readiness (by event order)');
  });

  test('(c) the correction rejected: no readiness; the item\'s repair or blocker', async (t) => {
    const fx = await scriptedEngine(t);
    const { p, ctx } = await project(fx);
    ctx.answerKinds = [...OWNER];
    await designed(fx, p);
    const batch = await untilBatch(fx, ctx);
    await consume(fx, p.id, batch.design_approval, 'approve');
    await consume(fx, p.id, batch.spec_change, 'approve');
    const captured = await pump(fx, ctx, () => openOfKind(fx.home, p.id, 'check_correction_tightening')[0], { what: 'the correction captured', max: 40 });
    await consume(fx, p.id, decision(fx.home, captured.id), 'reject');
    await tick(fx.engine, p.id, { rounds: 3 });
    assert.equal(readyAt(fx.home, p.id), null, 'no readiness');
    const item = rows(fx.home, 'SELECT * FROM "work_items" WHERE "project" = ? AND "kind" = \'check_correction\' ORDER BY "seq" DESC LIMIT 1', p.id)[0];
    const runs = rows(fx.home, 'SELECT * FROM "runs" WHERE "work_item" = ?', item.id);
    assert.ok(runs.length >= 2 || item.blocker, `the item's repair or blocker (${runs.length} runs; blocker ${item.blocker})`);
    assert.deepEqual(uiLaunches(fx, p), [], 'no UI Builder');
  });

  test('(d) approved without criteria: ready at approval', async (t) => {
    const fx = await scriptedEngine(t);
    const { p, ctx } = await project(fx);
    await designed(fx, p);
    const batch = await untilBatch(fx, ctx);
    await consume(fx, p.id, batch.spec_change, 'reject');
    const d = await pump(fx, ctx, () => openOfKind(fx.home, p.id, 'design_approval').find((x) => (x.options ?? []).some((o) => o.key === 'approve_without_criteria' && (o.blockers ?? []).length === 0)), { what: 'approve_without_criteria open', max: 6 });
    await consume(fx, p.id, d, 'approve_without_criteria');
    const ready = await pump(fx, ctx, () => readyAt(fx.home, p.id) ?? undefined, { what: 'readiness', max: 4 });
    assert.ok(ready, 'ready at approval');
    assert.equal(specRevisions(fx.home, p.id).length, 1, 'no spec change applied');
  });

  test('(f) at_alpha and off: no hold', async (t) => {
    const fx = await scriptedEngine(t);
    for (const [name, policy] of [['pantry-alpha', { ...BEFORE_BUILD, design: 'at_alpha' }], ['pantry-off', { autonomy: 'phase', phase_size: { min: 1, max: 5 } }]]) {
      const { p, ctx } = await project(fx, { name, policy, noDesign: true });
      await pump(fx, ctx, () => (uiLaunches(fx, p).length >= 2 ? true : undefined), { what: `${name}: the UI Builders launched`, max: 80 });
      for (const n of [2, 3]) {
        const w = stageWork(fx.home, p.id, n);
        assert.equal((w.depends_on ?? []).some((d) => d.milestone === 'design_ready'), false, `${name}: stage ${n} does not wait on design`);
        assert.equal(w.held_intervals.some((i) => ['design_pending', 'design_stale'].includes(i.reason)), false, `${name}: never held for design`);
      }
    }
  });

  test('(g) gates while the design criteria\'s checks do not exist: ACCEPTANCE_SCOPE_INCOMPLETE naming the design criteria', async (t) => {
    const fx = await scriptedEngine(t);
    const { p, ctx } = await project(fx, { policy: { ...BEFORE_BUILD, design: 'at_alpha' } });
    // No UI stage builds against no design: the API stage's Builder waits at a hold until the
    // batch is answered, and the UI stages wait on its code milestone (objection 169). Phase 1's
    // correction is answered first, as the owner must: the batch is not raised while it is
    // pending (objection 166). The design criteria's own correction stays unanswered.
    const api = stageWork(fx.home, p.id, 1);
    fx.scripted.script(api.id, [{ steps: [step.hold('until-batch'), ...builderScript(1).steps] }, builderScript(1), builderScript(1)]);
    ctx.answerKinds = [];
    await designed(fx, p);
    // The pump waits for every run to end, and the held Builder does not: this wait ticks, and
    // answers phase 1's correction by hand, until the batch is raised.
    let batch = null;
    for (let i = 0; i < 160 && !batch; i++) {
      for (const d of decisionsOfKind(fx.home, p.id, 'check_correction_unclassifiable').filter((x) => x.status === 'open')) await consume(fx, p.id, d, 'approve');
      const b = batchOf(fx.home, p.id);
      if (b?.spec_change) batch = b;
      else {
        await tick(fx.engine, p.id);
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    assert.ok(batch, `the batch raised once phase 1's correction is answered (decisions: ${JSON.stringify(rows(fx.home, 'SELECT "kind", "status" FROM "decisions" WHERE "project" = ? ORDER BY rowid', p.id))})`);
    await consume(fx, p.id, batch.design_approval, 'approve');
    await consume(fx, p.id, batch.spec_change, 'approve');
    for (const n of [2, 3]) assert.deepEqual(fx.scripted.launches({ work_item: stageWork(fx.home, p.id, n).id }), [], `no UI stage (${n}) launched before the batch is answered`);
    fx.scripted.release(api.id, 'until-batch');
    const v2 = await pump(fx, ctx, () => specRevisions(fx.home, p.id).find((r) => r.version === 2), { what: 'version 2', max: 20 });
    void v2;
    const mark = rows(fx.home, 'SELECT COALESCE(MAX(rowid), 0) AS r FROM "gate_evaluations"')[0].r;
    ctx.answerKinds = [...OWNER];
    const after = () => rows(fx.home, 'SELECT rowid AS r, * FROM "gate_evaluations" WHERE "project" = ? AND rowid > ? ORDER BY rowid', p.id, mark);
    const named = (e) => e.reasons.includes('ACCEPTANCE_SCOPE_INCOMPLETE') && e.reasons.includes('R2.2');
    const gate = await pump(fx, ctx, () => after().find((e) => e.gate_kind === 'stage' && e.stage === stageRow(fx.home, p.id, 2)?.id), { what: 'the web stage\'s gate after version 2', max: 80 });
    assert.ok(named(gate), `ACCEPTANCE_SCOPE_INCOMPLETE naming the design criterion R2.2 (${gate.reasons})`);
    // "Delivers R2" is read from the engine's records, never from the snapshot's text, whose ids
    // hold "R2" by chance (objection 168): a stage gate delivers R2 when its stage implements R2
    // (a stage gate's scope lists the whole candidate's requirements, R1 to R3 for every stage);
    // any other gate when its acceptance scope's delivered requirements hold R2. Either list holds
    // the requirement's id, or its key.
    const r2 = rows(fx.home, 'SELECT "id" FROM "requirements" WHERE "project" = ? AND "key" = \'R2\'', p.id)[0]?.id;
    assert.ok(r2, 'R2 is a requirement of the project');
    const holdsR2 = (text) => {
      const list = JSON.parse(text ?? '[]');
      return list.includes(r2) || list.includes('R2');
    };
    const delivers = (e) =>
      e.gate_kind === 'stage'
        ? holdsR2(rows(fx.home, 'SELECT "implements" AS l FROM "stages" WHERE "id" = ?', e.stage)[0]?.l)
        : holdsR2(rows(fx.home, 'SELECT "delivered_requirement_ids" AS l FROM "acceptance_scopes" WHERE "id" = ?', e.scope)[0]?.l);
    assert.ok(delivers(gate), `the fixture is live: the web stage's gate delivers R2 (stage ${gate.stage})`);
    assert.equal(holdsR2(stageRow(fx.home, p.id, 1)?.implements), false, 'and the API stage does not implement R2');
    const applied = rows(fx.home, 'SELECT COUNT(*) AS n FROM "checks" WHERE "project" = ? AND "key" = \'accept-r2-tokens\'', p.id)[0].n;
    if (applied === 0) for (const e of after().filter(delivers)) assert.ok(named(e), `every gate delivering R2 names it while its checks do not exist (${e.gate_kind}: ${e.reasons})`);
  });
  test('(c), (g) M519 F1: human-kind criteria written as plain criteria, the correction covering the checkable ones applied: ready; the UI stages released and built; no gate names a human-kind criterion ACCEPTANCE_SCOPE_INCOMPLETE', async (t) => {
    assertV2Shape(assert);
    const fx = await scriptedEngine(t);
    const { p, ctx } = await project(fx);
    await designedWithHuman(fx, p);
    const batch = await untilBatch(fx, ctx);
    await consume(fx, p.id, batch.design_approval, 'approve');
    await consume(fx, p.id, batch.spec_change, 'approve');
    const mark = rows(fx.home, 'SELECT COALESCE(MAX(rowid), 0) AS r FROM "gate_evaluations"')[0].r;
    // The engine identifies the human-kind criteria from the design (its criterion map), never from the wording.
    const map = criterionMapOf(fx.home, p.id);
    for (const [target, id] of Object.entries(HUMAN_KIND_IDS)) {
      const e = map.find((x) => x.id === id);
      assert.ok(e && e.kind === 'human' && (e.targets ?? []).includes(target), `the fixture: the criterion map records ${id} kind human on ${target} (${JSON.stringify(map.map((x) => [x.id, x.kind, x.targets]))})`);
    }
    // The correction (auto-approved, a tightening) covers the checkable criteria only.
    let ready;
    try {
      ready = await pump(fx, ctx, () => readyAt(fx.home, p.id) ?? undefined, { what: 'readiness', max: 40 });
    } catch (err) {
      assert.fail(`the approved design never became ready though its correction ended with its proposal applied: readiness must not wait on the human-kind criteria ${HUMAN_IDS.join(', ')} (D7 §7.5 and §7.3; the driver's ruling, M519 F1) (${err.message.split('\n')[0]}; facts ${readinessFacts(fx.home, p.id)})`);
    }
    assert.ok(ready, 'design_ready_at set');
    const markReady = rows(fx.home, 'SELECT COALESCE(MAX(rowid), 0) AS r FROM "gate_evaluations"')[0].r;
    const change = designChange(fx.home, p.id);
    assert.ok(change.correction && change.correction.status === 'complete', `the correction ended (${change.correction?.status})`);
    assert.ok(change.proposals.some((x) => x.status === 'applied'), `its proposal applied (${JSON.stringify(change.proposals)})`);
    for (const id of CHECKABLE_IDS) assert.ok(checksCovering(fx.home, p.id, id).length > 0, `${id} covered by a check`);
    for (const id of HUMAN_IDS) assert.deepEqual(checksCovering(fx.home, p.id, id), [], `the fixture: no check covers ${id}`);
    assert.equal(eventsAbout(fx.home, 'design.ready', p.id).length, 1, 'design.ready once');
    // The UI stages released and built.
    await pump(fx, ctx, () => ([2, 3].every((n) => stageRow(fx.home, p.id, n)?.status === 'verified') ? true : undefined), { what: 'both UI stages verified', max: 120 });
    for (const n of [2, 3]) {
      const w = stageWork(fx.home, p.id, n);
      assert.ok(w.milestones_met.includes('design_ready'), `stage ${n}'s design_ready milestone met (${JSON.stringify(w.milestones_met)})`);
      assert.ok(fx.scripted.launches({ work_item: w.id }).length >= 1, `stage ${n}'s Builder launched`);
    }
    await pump(fx, ctx, () => (eventsAbout(fx.home, 'baseline.phase_complete', p.id).length > 0 ? true : undefined), { what: 'phase 1 complete', max: 120 });
    // No gate names a human-kind criterion (or a covered one) ACCEPTANCE_SCOPE_INCOMPLETE.
    const evaluated = rows(fx.home, 'SELECT "gate_kind", "stage" FROM "gate_evaluations" WHERE "project" = ? AND rowid > ?', p.id, mark);
    for (const n of [2, 3]) assert.ok(evaluated.some((e) => e.gate_kind === 'stage' && e.stage === stageRow(fx.home, p.id, n).id), `the fixture is live: stage ${n}'s gate evaluated after version 2`);
    assert.ok(evaluated.some((e) => e.gate_kind === 'phase'), 'the fixture is live: the phase gate evaluated');
    assert.deepEqual(scopeIncompleteNaming(fx.home, p.id, HUMAN_IDS, { afterRowid: mark }), [], 'no gate carries ACCEPTANCE_SCOPE_INCOMPLETE for a human-kind criterion (D7 §7.3; the ruling)');
    assert.deepEqual(scopeIncompleteNaming(fx.home, p.id, CHECKABLE_IDS, { afterRowid: markReady }), [], 'nor for a checkable one once its check exists');
    await assertHoldsAccounted(fx, p.id, '(c), (g) M519 F1');
  });

  test('(c) M519 F1: readiness waits while the correction is pending, then while its proposal is unapplied; GET …/design names what it waits on and the next action', async (t) => {
    const fx = await scriptedEngine(t);
    const { p, ctx } = await project(fx);
    ctx.answerKinds = [...OWNER];
    await designedWithHuman(fx, p);
    const batch = await untilBatch(fx, ctx);
    await consume(fx, p.id, batch.design_approval, 'approve');
    await consume(fx, p.id, batch.spec_change, 'approve');
    const rev = designRevisions(fx.home, p.id).find((r) => r.status === 'approved');
    assert.ok(rev, 'the design approved');
    const change = designChange(fx.home, p.id);
    assert.ok(change?.correction, `the change registered its correction (${readinessFacts(fx.home, p.id)})`);
    // (1) The correction pending: not ready; the read names it.
    const sameOnDue = (read, readiness, how) => {
      if (read.design_due) assert.deepEqual(read.design_due.readiness?.waits_on, readiness.waits_on, `${how}: the open design_due's evidence names the same wait (${JSON.stringify(read.design_due)})`);
    };
    assert.equal(readyAt(fx.home, p.id), null, 'the correction pending: no readiness');
    let read = await readDesign(fx, p.id);
    let r = revisionRead(read, rev.id)?.readiness;
    assert.ok(r && r.waits_on, `the correction pending: GET …/design names what readiness waits on (revisions[].readiness; the ruling's item 3) (${JSON.stringify(revisionRead(read, rev.id))})`);
    assert.deepEqual({ kind: r.waits_on.kind, work_item: r.waits_on.work_item }, { kind: 'check_correction', work_item: change.correction.id }, `the correction pending: waits on the check_correction ${change.correction.id} (${JSON.stringify(r)})`);
    assert.ok(typeof r.next_action === 'string' && r.next_action.length > 0, `and states the next action (${JSON.stringify(r)})`);
    sameOnDue(read, r, 'the correction pending');
    // (2) Its proposal captured, awaiting the owner: not ready; the read names the proposal and the decision.
    const captured = await pump(fx, ctx, () => openOfKind(fx.home, p.id, 'check_correction_tightening')[0], { what: 'the correction\'s proposal captured', max: 40 });
    const proposal = designChange(fx.home, p.id).proposals.find((x) => x.status !== 'applied' && x.status !== 'rejected');
    assert.ok(proposal, `the proposal unapplied (${JSON.stringify(designChange(fx.home, p.id).proposals)})`);
    assert.equal(readyAt(fx.home, p.id), null, 'the proposal unapplied: no readiness');
    assert.deepEqual(uiLaunches(fx, p), [], 'no UI Builder');
    read = await readDesign(fx, p.id);
    r = revisionRead(read, rev.id)?.readiness;
    assert.ok(r && r.waits_on, `the proposal unapplied: GET …/design names what readiness waits on (${JSON.stringify(revisionRead(read, rev.id))})`);
    assert.deepEqual({ kind: r.waits_on.kind, proposal: r.waits_on.proposal, decision: r.waits_on.decision }, { kind: 'proposal', proposal: proposal.id, decision: captured.id }, `the proposal unapplied: waits on proposal ${proposal.id} and the owner's ${captured.id} (${JSON.stringify(r)})`);
    assert.ok(typeof r.next_action === 'string' && r.next_action.length > 0, `and states the next action (${JSON.stringify(r)})`);
    sameOnDue(read, r, 'the proposal unapplied');
    await assertHoldsAccounted(fx, p.id, '(c) the proposal unapplied');
    // (3) Approved and applied: ready, and the read names no wait.
    await consume(fx, p.id, decision(fx.home, captured.id), 'approve');
    const ready = await pump(fx, ctx, () => readyAt(fx.home, p.id) ?? undefined, { what: 'readiness once the proposal is applied', max: 20 }).catch((err) => assert.fail(`${err.message.split('\n')[0]} (${readinessFacts(fx.home, p.id)})`));
    assert.ok(ready, 'ready once applied');
    read = await readDesign(fx, p.id);
    assert.equal(revisionRead(read, rev.id)?.readiness ?? null, null, `ready: no wait named (${JSON.stringify(revisionRead(read, rev.id))})`);
  });
});
