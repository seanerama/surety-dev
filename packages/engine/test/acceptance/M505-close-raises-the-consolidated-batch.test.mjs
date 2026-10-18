// M505, close raises the consolidated batch (slice 40; kernel lane). M6
// plan §3.2 M505; D7 §7.1, §7.3, §7.4; Q1; G5; E156 Q3; BS6 §11.5;
// SEAM.md §§485, 486.
//
// (a) close with a passing design check: a Spec Writer one-shot writes the
//     criteria and one human-test requirement per target on its side ref;
//     the impact computed; design_approval and spec_change under one
//     batch_key, launching nothing else;
// (b) the design approval's preview: the mockups, the design_check record,
//     the criteria diff, the asset manifest with every narrowing, the impact;
// (c) close with a failing check; with --refuse;
// (d) design_approval answered first, the spec_change still open; the
//     spec_change first;
// (e) the option blockers: a finding the session raised open against an
//     interface its screens use; the spec_change answered reject;
// (f) revise; reject;
// (g) a save after the decisions' preview;
// (h) a batch whose web and android last UI stages are in phase 2 while
//     phase 1 is active;
// (i) a target whose last UI stage cannot be determined;
// (j) a plan publication between the raise and the answer; between the
//     answer and the effect (barrier design.approved);
// (k) a design criterion with requirement "new" and an ordinary new
//     requirement in the same batch's spec change;
// (l) after the assignment: the human tests' status, the evidence tables,
//     and a target whose last UI stage is in a completed phase.
//
// M519's finding F1 (SEAM.md §549; the driver's ruling of 2026-10-17):
// (b), (l) design criteria of kind `human`, written by the Spec Writer as
//     plain criteria: never uncovered in the impact (at raise and as
//     applied), never owed a check by the correction, carried by their
//     target's human test on GET …/design.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CODES, consume, decision, reachBarrier } from './harness/decisions.mjs';
import { releaseBarrier } from './harness/engine.mjs';
import { armBarrier, changePolicy } from './harness/journal.mjs';
import { journeyContext, phasePlansOf, planOfPhase, pump, requirementsOf, roadmapRevisions, specRevisions, workOf } from './harness/journey/drive.mjs';
import { fileAt, refsOf } from './harness/repos.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { CRITERIA, REQUIREMENTS, specV2For } from './harness/design/reference.mjs';
import { CHECKABLE_IDS, CRITERIA_WITH_HUMAN, HUMAN_IDS, HUMAN_KIND_IDS, assertV2Shape, checksCovering, designChange, readinessFacts } from './harness/design/ready.mjs';
import {
  VARIANTS,
  answerWith,
  batchOf,
  designRevisions,
  designScripts,
  designerSession,
  openDesignDue,
  openOfKind,
  readDesign,
  replanScriptFor,
  scriptBuilders,
  specChangeScriptFor,
  toPublished,
  validDesign,
  variantSpec,
} from './harness/design/drive.mjs';

const BEFORE_BUILD = Object.freeze({ design: 'before_build', autonomy: 'phase', phase_size: { min: 1, max: 5 } });
const KERNEL_KINDS = Object.freeze(['check_correction_unclassifiable', 'check_correction_tightening', 'check_correction_loosening', 'plan_approval']);
const count = (home, table, where = '1 = 1', ...params) => withStore(home, (db) => db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${where}`).get(...params).n);
const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));

// A project of `variant` published under `policy`, its roles scripted.
async function published(fx, { variant = 'base', policy = BEFORE_BUILD, name, criteria = CRITERIA, extra = [] } = {}) {
  const v = variantSpec(variant);
  const { p } = await toPublished(fx, { policy, name, spec: v.spec, files: v.files });
  designScripts(fx);
  const base = REQUIREMENTS.map((r) => ({ ...r, phase: VARIANTS[variant].phases[r.key] }));
  const v2 = specV2For({ criteria, base, extra, phase: Math.max(...Object.values(VARIANTS[variant].phases)) });
  fx.scripted.kindScript('spec_change', specChangeScriptFor(v2));
  const replan = replanScriptFor(variant);
  if (replan) fx.scripted.kindScript('replan', [replan, replan, replan]);
  scriptBuilders(fx, p.id);
  const ctx = journeyContext(fx, p, { lane: 'kernel' });
  ctx.answerKinds = [...KERNEL_KINDS];
  return { p, ctx, v2 };
}
// The Designer's one session: the whole design, saved, closed (`close` its body; null leaves it open).
// Each save of a Designer session answers 200 (SEAM §483), behind its base
// too (rebased, G12; SEAM §§492, 521): a refused save fails here, naming why.
const assertSaved = (s, what) => s.saves.forEach((r, i) => assert.equal(r?.status, 200, `${what}: save ${i + 1} answered 200 (${r?.status} ${r?.text?.slice(0, 400)})`));
async function design(fx, p, { criteria = CRITERIA, result = {}, close = {} } = {}) {
  const s = await designerSession(fx, p.id, [{ files: validDesign(p, { criteria }), say: 'Draw Pantry.', result: { done: true, ...result } }], { close });
  assertSaved(s, 'the Designer\'s session');
  return s;
}
// The batch, once raised.
const untilBatch = (fx, ctx, { max = 40 } = {}) =>
  pump(fx, ctx, () => {
    const b = batchOf(fx.home, ctx.project);
    return b?.spec_change ? b : undefined;
  }, { what: 'the batch to be raised', max });
// The batch answered on a settled phase authoring (M505 (i); SEAM.md §530):
// the phase's check authoring and its protected proposal, which the pump
// approves as the owner (`ctx.answerKinds`), move the protected version, and
// a move between the batch's answer and its effect refuses the effect and
// asks again (D6 §4.4; D1 §4.6), which no case here is about. So a case that
// answers the batch for its effect first pumps until no check authoring is in
// flight, no question the pump answers is open, and no effect of the
// project's other decisions is pending; it then answers the batch open at
// that moment.
const AUTHORING_IN_FLIGHT = Object.freeze(['eligible', 'claimed', 'executing', 'integrating', 'integrated', 'verifying', 'awaiting_decision']);
function authoringSettled(home, ctx) {
  const inFlight = count(home, 'work_items', `"project" = ? AND "kind" = 'check_authoring' AND "status" IN (${AUTHORING_IN_FLIGHT.map(() => '?').join(', ')})`, ctx.project, ...AUTHORING_IN_FLIGHT);
  const asked = rows(home, 'SELECT "kind" FROM "decisions" WHERE "project" = ? AND "status" = \'open\'', ctx.project).filter((d) => ctx.answerKinds.includes(d.kind)).length;
  const effects = count(home, 'effect_intents', `"project" = ? AND "status" IN ('pending', 'executing') AND "decision" IN (SELECT "id" FROM "decisions" WHERE "kind" NOT IN ('design_approval', 'spec_change'))`, ctx.project);
  return inFlight === 0 && asked === 0 && effects === 0;
}
const settledBatch = (fx, ctx, { max = 40 } = {}) =>
  pump(fx, ctx, () => {
    if (!authoringSettled(fx.home, ctx)) return undefined;
    const b = batchOf(fx.home, ctx.project);
    return b?.spec_change ? b : undefined;
  }, { what: 'the phase authoring settled and the batch open', max });
const approvedRevision = (home, project) => designRevisions(home, project).find((r) => ['approved', 'approved_without_criteria'].includes(r.status)) ?? null;
const blockersOf = (row, option) => ((row.options ?? []).find((o) => o.key === option)?.blockers ?? []).map((b) => (typeof b === 'string' ? b : JSON.stringify(b)));

describe('M505 close raises the consolidated batch', () => {
  test('(a), (b) a close with a passing check: the Spec Writer one-shot\'s diff on its side ref, the impact, design_approval and spec_change under one batch_key, nothing else launched; the preview carries mockups, the check record, the criteria diff, the manifest with its narrowings and the impact', async (t) => {
    const fx = await scriptedEngine(t);
    const { p, ctx, v2 } = await published(fx);
    const s = await design(fx, p);
    assert.equal(s.closeRes.status, 200, `the close (${s.closeRes.text?.slice(0, 400)})`);
    const batch = await untilBatch(fx, ctx);
    assert.equal(batch.spec_change.batch_key, batch.design_approval.batch_key, 'one batch_key');
    const request = rows(fx.home, 'SELECT * FROM "spec_change_requests" WHERE "id" = ?', batch.spec_change.subject_id)[0];
    assert.equal(request?.source, 'design', 'the change request\'s source is design');
    assert.ok(request.impact, `the impact computed (${JSON.stringify(request)})`);
    const side = Object.keys(refsOf(p.repo.path)).filter((r) => r.startsWith('refs/surety/spec-change/'));
    assert.ok(side.some((ref) => fileAt(p.repo.path, ref, '.surety/spec/spec.md') === v2.text), `a Spec Writer one-shot wrote the diff on its side ref (${side.join(', ')})`);
    const writers = rows(fx.home, 'SELECT r.* FROM "runs" r JOIN "work_items" w ON w."id" = r."work_item" WHERE w."project" = ? AND w."kind" = \'spec_change\'', p.id);
    assert.ok(writers.length >= 1 && writers.every((r) => r.role === 'spec_writer'), 'the Spec Writer\'s one-shot');
    assert.equal(count(fx.home, 'runs', '"project" = ? AND "role" = \'designer\'', p.id), 1, 'no other Designer run');
    for (const n of [2, 3]) assert.deepEqual(fx.scripted.launches({ work_item: rows(fx.home, 'SELECT "work_item" FROM "stages" WHERE "project" = ? AND "number" = ?', p.id, n)[0].work_item }), [], 'no UI Builder');
    // (b) the preview.
    const ev = batch.design_approval.evidence ?? {};
    assert.deepEqual((ev.mockups ?? []).map((m) => m.path).sort(), ['mockups/android/s2.html', 'mockups/web/s1.html'], `the mockups list (SEAM.md §486) (${Object.keys(ev).join(', ')})`);
    assert.equal(ev.design_check?.outcome, 'passed', 'the design_check record');
    assert.ok(ev.criteria_diff && JSON.stringify(ev.criteria_diff).includes('R2'), 'the criteria diff');
    assert.ok(ev.asset_manifest?.version, 'the asset manifest');
    const narrowed = JSON.stringify(ev.narrowings ?? []);
    for (const v of ['compact', 'monochrome', 'on_light', 'on_dark']) assert.ok(narrowed.includes(v), `the narrowing of the logo's ${v} listed (${narrowed})`);
    assert.ok(ev.impact, 'the impact');
  });

  test('(c) a close with a failing check: refused design_check_failed with its reasons, the product recorded, nothing raised, design_due open; with --refuse likewise', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await published(fx);
    const files = validDesign(p, { omit: [{ target: 'web', interface: 'list-items', state: 'empty' }] });
    const s = await designerSession(fx, p.id, [{ files, say: 'Draw it.' }], { close: {} });
    assert.equal(s.closeRes.status, 422, `the close is refused (${s.closeRes.status} ${s.closeRes.text?.slice(0, 400)})`);
    assert.equal(s.closeRes.body?.code, 'design_check_failed', 'design_check_failed');
    assert.ok(JSON.stringify(s.closeRes.body).includes('DESIGN_STATE_UNCOVERED'), 'with its reasons');
    assert.equal(s.saves[0]?.status, 200, 'the product recorded (the save committed)');
    assert.deepEqual(openOfKind(fx.home, p.id, 'design_approval'), [], 'nothing raised');
    assert.ok(openDesignDue(fx.home, p.id), 'design_due open');
    const refused = await fx.engine.post(`/v1/projects/${p.id}/sessions/${s.run.id}/close`, { refuse: true });
    assert.equal(refused.status, 200, `--refuse closes (${refused.text})`);
    await tick(fx.engine, p.id, { rounds: 2 });
    assert.deepEqual(openOfKind(fx.home, p.id, 'design_approval'), [], '--refuse raises nothing');
    assert.ok(openDesignDue(fx.home, p.id), 'design_due still open');
  });

  for (const first of ['design_approval', 'spec_change']) {
    test(`(d) ${first} answered approve first: neither answer alone sets design_ready_at or releases UI work; each consumed separately; the effects after both`, async (t) => {
      const fx = await scriptedEngine(t);
      const { p, ctx } = await published(fx);
      await design(fx, p);
      const batch = await settledBatch(fx, ctx);
      const second = first === 'design_approval' ? 'spec_change' : 'design_approval';
      await consume(fx, p.id, batch[first], 'approve');
      await tick(fx.engine, p.id, { rounds: 2 });
      assert.equal(decision(fx.home, batch[second].id).status, 'open', `${second} still open`);
      assert.equal(approvedRevision(fx.home, p.id), null, 'no approved design revision after one answer');
      assert.equal(designRevisions(fx.home, p.id).some((r) => r.ready_at), false, 'no readiness');
      assert.equal(specRevisions(fx.home, p.id).length, 1, 'no spec version 2');
      await consume(fx, p.id, decision(fx.home, batch[second].id), 'approve');
      const rev = await pump(fx, ctx, () => approvedRevision(fx.home, p.id) ?? undefined, { what: 'the effects', max: 10 });
      assert.equal(rev.status, 'approved', 'the effects after both');
    });
  }

  test('(e) a finding the session raised open against an interface its screens use: approve blocked DESIGN_INTERFACE_DISPUTED naming it', async (t) => {
    const fx = await scriptedEngine(t);
    const { p, ctx } = await published(fx);
    await design(fx, p, { result: { findings: [{ category: 'contract_conflict', severity: 'medium', message: 'add-item declares no error for a full pantry', interface: 'add-item' }] } });
    const batch = await untilBatch(fx, ctx);
    const blockers = blockersOf(batch.design_approval, 'approve');
    assert.ok(blockers.some((b) => b.includes('DESIGN_INTERFACE_DISPUTED') && b.includes('add-item')), `approve blocked DESIGN_INTERFACE_DISPUTED naming add-item (${JSON.stringify(blockers)})`);
  });

  test('(e) the spec_change answered reject: approve blocked, approve_without_criteria open; its choice recorded on the revision and in every projection', async (t) => {
    const fx = await scriptedEngine(t);
    const { p, ctx } = await published(fx);
    await design(fx, p);
    const batch = await untilBatch(fx, ctx);
    await consume(fx, p.id, batch.spec_change, 'reject');
    const now = await pump(fx, ctx, () => {
      const d = openOfKind(fx.home, p.id, 'design_approval').at(-1);
      return d && blockersOf(d, 'approve').length > 0 ? d : undefined;
    }, { what: 'design_approval with approve blocked', max: 6 });
    assert.ok(blockersOf(now, 'approve').length > 0, 'approve blocked');
    assert.deepEqual(blockersOf(now, 'approve_without_criteria'), [], 'approve_without_criteria open');
    await consume(fx, p.id, now, 'approve_without_criteria');
    const rev = await pump(fx, ctx, () => approvedRevision(fx.home, p.id) ?? undefined, { what: 'the revision', max: 6 });
    assert.equal(rev.status, 'approved_without_criteria', 'recorded on the revision');
    const read = await readDesign(fx, p.id);
    assert.equal((read.revisions ?? []).find((r) => r.id === rev.id)?.status, 'approved_without_criteria', 'and in GET …/design');
  });

  test('(f) revise: design_due re-raised stage revise with the owner\'s note; reject: the revision rejected and kept, the holds kept, design_due open', async (t) => {
    const fx = await scriptedEngine(t);
    const { p, ctx } = await published(fx);
    await design(fx, p);
    const batch = await untilBatch(fx, ctx);
    const note = 'Make the add button larger.';
    const res = await answerWith(fx, p.id, batch.design_approval, 'revise', { note });
    assert.equal(res.status, 200, `revise (${res.text})`);
    const due = await pump(fx, ctx, () => {
      const d = openDesignDue(fx.home, p.id);
      return d?.evidence?.stage === 'revise' ? d : undefined;
    }, { what: 'design_due (revise)', max: 6 });
    assert.equal(due.evidence?.note, note, 'with the owner\'s note');
    // A second design, rejected.
    await design(fx, p);
    const again = await untilBatch(fx, ctx);
    await consume(fx, p.id, again.design_approval, 'reject');
    await tick(fx.engine, p.id, { rounds: 2 });
    const rejected = designRevisions(fx.home, p.id).filter((r) => r.status === 'rejected');
    assert.equal(rejected.length, 1, 'the revision rejected, kept as history');
    assert.ok(openDesignDue(fx.home, p.id), 'design_due open');
    assert.equal(approvedRevision(fx.home, p.id), null, 'nothing approved; the holds kept');
  });

  test('(g) a save after the decisions\' preview stales both', async (t) => {
    const fx = await scriptedEngine(t);
    const { p, ctx } = await published(fx);
    await design(fx, p);
    const batch = await untilBatch(fx, ctx);
    const files = validDesign(p);
    files['.surety/design/design.md'] = '# Pantry: design\n\nA later note.\n';
    assertSaved(await designerSession(fx, p.id, [{ files: { '.surety/design/design.md': files['.surety/design/design.md'] }, say: 'One more note.' }], { close: null }), 'the save after the preview');
    for (const kind of ['design_approval', 'spec_change']) {
      const res = await answerWith(fx, p.id, batch[kind], 'approve');
      assert.deepEqual([res.status, [CODES.stale, CODES.invalidated].includes(res.body?.code)], [409, true], `${kind} stale (${res.text})`);
    }
  });

  test('(h) the web and android last UI stages in phase 2 while phase 1 is active: each human test\'s phase shown and bound with the roadmap and plan versions; on approval assigned to phase 2, recorded engine-assigned', async (t) => {
    const fx = await scriptedEngine(t);
    const { p, ctx, v2 } = await published(fx, { variant: 'late' });
    await design(fx, p);
    const batch = await settledBatch(fx, ctx);
    const assignments = batch.design_approval.evidence?.human_test_assignments ?? [];
    assert.deepEqual(assignments.map((a) => [a.target, a.requirement, a.phase]).sort(), [['android', v2.humanKeys.android, 2], ['web', v2.humanKeys.web, 2]].sort(), `each human test's proposed phase on the preview (${JSON.stringify(assignments)})`);
    const m = batch.design_approval.manifest ?? {};
    assert.equal(m.roadmap_version, 1, `bound to the roadmap version (${Object.keys(m).join(', ')})`);
    assert.ok(m.plan_versions && JSON.stringify(m.plan_versions).includes(planOfPhase(fx.home, p.id, 1).at(-1).id), 'and the plan versions it was derived from');
    await consume(fx, p.id, batch.design_approval, 'approve');
    await consume(fx, p.id, batch.spec_change, 'approve');
    await pump(fx, ctx, () => approvedRevision(fx.home, p.id) ?? undefined, { what: 'the approval\'s effect', max: 10 });
    const reqs = requirementsOf(fx.home, p.id);
    for (const key of Object.values(v2.humanKeys)) assert.equal(reqs.find((r) => r.key === key)?.assigned_phase, 2, `${key} assigned to phase 2, never phase 1 because it is active`);
    const engineRoadmap = roadmapRevisions(fx.home, p.id).at(-1);
    assert.equal(engineRoadmap.approved_by, 'engine:design_approval', `recorded engine-assigned (SEAM.md §486) (${engineRoadmap.approved_by})`);
  });

  test('(i) a target whose last UI stage cannot be determined: no assignment proposed, the preview saying why; after approval REQUIREMENT_UNASSIGNED, never guessed', async (t) => {
    const fx = await scriptedEngine(t);
    const { p, ctx, v2 } = await published(fx, { variant: 'noAndroidStage' });
    await design(fx, p);
    const batch = await settledBatch(fx, ctx);
    const android = (batch.design_approval.evidence?.human_test_assignments ?? []).find((a) => a.target === 'android');
    assert.equal(android?.phase ?? null, null, `no phase proposed for android (${JSON.stringify(android)})`);
    assert.ok(typeof android?.reason === 'string' && android.reason.length > 0, 'the preview says why');
    await consume(fx, p.id, batch.design_approval, 'approve');
    await consume(fx, p.id, batch.spec_change, 'approve');
    await pump(fx, ctx, () => approvedRevision(fx.home, p.id) ?? undefined, { what: 'the approval\'s effect', max: 10 });
    const reqs = requirementsOf(fx.home, p.id);
    assert.equal(reqs.find((r) => r.key === v2.humanKeys.android)?.assigned_phase ?? null, null, 'android\'s human test unassigned');
    assert.equal(reqs.find((r) => r.key === v2.humanKeys.web)?.assigned_phase, 1, 'web\'s assigned to the phase of its last UI stage');
  });

  test('(j) a plan publication between the raise and the answer: the answer stale, nothing assigned, the batch re-raised against the new versions', async (t) => {
    const fx = await scriptedEngine(t);
    const { p, ctx } = await published(fx, { variant: 'late' });
    await design(fx, p);
    const batch = await untilBatch(fx, ctx);
    await pump(fx, ctx, () => planOfPhase(fx.home, p.id, 2).find((x) => x.published_at) ?? undefined, { what: 'phase 2 published', max: 80 });
    const res = await answerWith(fx, p.id, batch.design_approval, 'approve');
    assert.deepEqual([res.status, [CODES.stale, CODES.invalidated].includes(res.body?.code)], [409, true], `the answer stale (${res.text})`);
    assert.equal(roadmapRevisions(fx.home, p.id).filter((r) => r.approved_by === 'engine:design_approval').length, 0, 'nothing assigned');
    const next = await pump(fx, ctx, () => openOfKind(fx.home, p.id, 'design_approval').find((d) => d.id !== batch.design_approval.id), { what: 'the batch re-raised', max: 6 });
    assert.ok(JSON.stringify(next.manifest?.plan_versions).includes(planOfPhase(fx.home, p.id, 2).at(-1).id), 'against the new plan versions');
  });

  test('(j) a plan publication between the answer and the effect (barrier design.approved): the effect refused, nothing assigned from the old versions, the batch re-raised', async (t) => {
    const fx = await scriptedEngine(t);
    const { p, ctx } = await published(fx, { variant: 'late' });
    await design(fx, p);
    const batch = await untilBatch(fx, ctx);
    await armBarrier(fx.engine, 'design.approved', 'pause');
    const answered = [answerWith(fx, p.id, batch.design_approval, 'approve').catch((e) => e), answerWith(fx, p.id, batch.spec_change, 'approve').catch((e) => e)];
    await reachBarrier(fx, p.id, 'design.approved');
    await pump(fx, ctx, () => planOfPhase(fx.home, p.id, 2).find((x) => x.published_at) ?? undefined, { what: 'phase 2 published while the effect waits', max: 80 });
    await releaseBarrier(fx.engine, 'design.approved');
    await Promise.all(answered);
    await tick(fx.engine, p.id, { rounds: 2 });
    assert.equal(approvedRevision(fx.home, p.id), null, 'the effect refused whole');
    assert.equal(roadmapRevisions(fx.home, p.id).filter((r) => r.approved_by === 'engine:design_approval').length, 0, 'nothing assigned from the old versions');
    const next = await pump(fx, ctx, () => openOfKind(fx.home, p.id, 'design_approval').find((d) => d.id !== batch.design_approval.id), { what: 'the batch re-raised', max: 6 });
    assert.ok(next, 'the batch re-raised against the new versions');
  });

  test('(k) a design criterion with requirement "new" and an ordinary new requirement in the same change: both REQUIREMENT_UNASSIGNED until a roadmap revision, never engine-assigned', async (t) => {
    const fx = await scriptedEngine(t);
    const criteria = { ...CRITERIA, criteria: [...CRITERIA.criteria, { requirement: 'new', text: 'Given the web module, when web/index.html is read, then the empty state carries the marker data-state="empty".', kind: 'state_marker_present', targets: ['web'], paths: ['web/index.html'] }] };
    const extra = [{ title: 'Items sorted by name', statement: 'The list is sorted by name.', criteria: ['Given items b and a, when GET /api/items is requested, then a is listed first.'] }];
    const { p, ctx, v2 } = await published(fx, { criteria, extra });
    await design(fx, p, { criteria });
    const batch = await settledBatch(fx, ctx);
    await consume(fx, p.id, batch.design_approval, 'approve');
    await consume(fx, p.id, batch.spec_change, 'approve');
    await pump(fx, ctx, () => approvedRevision(fx.home, p.id) ?? undefined, { what: 'the approval\'s effect', max: 10 });
    const reqs = requirementsOf(fx.home, p.id);
    for (const key of [...v2.newKeys, ...v2.extraKeys]) assert.equal(reqs.find((r) => r.key === key)?.assigned_phase ?? null, null, `${key} unassigned (D6 reading 6), never engine-assigned`);
    for (const key of Object.values(v2.humanKeys)) assert.equal(reqs.find((r) => r.key === key)?.assigned_phase, 1, `${key}, a design human test, engine-assigned`);
  });

  test('(l) after the assignment: the human tests pending; no check, result, evaluation, sign-off or acceptance scope created by it; a target whose last UI stage is in a completed phase: that phase not reopened, no gate re-evaluated, no replan', async (t) => {
    const fx = await scriptedEngine(t);
    // The web page built in phase 1 under `design: off`; design turned on before phase 2's Android stage is dispatched.
    const androidOnly = { criteria: CRITERIA.criteria.filter((c) => c.targets.includes('android')), human_tests: CRITERIA.human_tests };
    const { p, ctx, v2 } = await published(fx, { variant: 'webFirst', policy: { autonomy: 'phase', phase_size: { min: 1, max: 5 } }, criteria: androidOnly });
    scriptBuilders(fx, p.id, { noDesign: true });
    const phase1 = await pump(fx, ctx, () => planOfPhase(fx.home, p.id, 1).find((x) => x.completed_at) ?? undefined, { what: 'phase 1 complete', max: 160 });
    await pump(fx, ctx, () => planOfPhase(fx.home, p.id, 2).find((x) => x.published_at) ?? undefined, { what: 'phase 2 published', max: 60 });
    await changePolicy(fx.engine, p.id, { design: 'before_build' });
    scriptBuilders(fx, p.id, { phase: 2, numbers: [3] });
    await design(fx, p, { criteria: androidOnly });
    const batch = await settledBatch(fx, ctx, { max: 60 });
    const assigned = (batch.design_approval.evidence?.human_test_assignments ?? []).find((a) => a.target === 'web');
    assert.equal(assigned?.phase, 1, `web's human test proposed for phase 1, the phase of its last UI stage, completed (${JSON.stringify(batch.design_approval.evidence?.human_test_assignments)})`);
    const before = {
      checks: count(fx.home, 'checks', '"project" = ?', p.id),
      results: count(fx.home, 'check_results', '"project" = ?', p.id),
      evaluations: count(fx.home, 'gate_evaluations', '"project" = ? AND "phase_plan" = ?', p.id, phase1.id),
      signoffs: rows(fx.home, 'SELECT s.* FROM "signoffs" s JOIN "candidates" k ON k."id" = s."candidate" WHERE k."project" = ?', p.id).length,
      scopes: count(fx.home, 'acceptance_scopes'),
      replans: workOf(fx.home, p.id, 'replan').length,
      phase1: JSON.stringify(phasePlansOf(fx.home, p.id).find((x) => x.id === phase1.id)),
    };
    await consume(fx, p.id, batch.design_approval, 'approve');
    await consume(fx, p.id, batch.spec_change, 'approve');
    for (let i = 0; i < 4 && !approvedRevision(fx.home, p.id); i++) await tick(fx.engine, p.id, { rounds: 1 });
    assert.ok(approvedRevision(fx.home, p.id), 'the batch approved');
    const reqs = requirementsOf(fx.home, p.id);
    assert.equal(reqs.find((r) => r.key === v2.humanKeys.web)?.assigned_phase, 1, 'web\'s human test assigned to the completed phase 1');
    const design_ = await readDesign(fx, p.id);
    for (const target of ['web', 'android']) assert.equal((design_.human_tests ?? []).find((h) => h.target === target)?.status, 'pending', `${target}'s human test pending, never verified`);
    const humanKeys = Object.values(v2.humanKeys);
    // A check's `covers` (D3 A.4) is stored as its `criteria` (criterion ids), its `requirement_ids`, and whole in its `definition` (objection 129).
    const names = (k, list) => (Array.isArray(list) ? list : []).some((x) => x === k || String(x).startsWith(`${k}.`));
    const covering = rows(fx.home, 'SELECT "key", "criteria", "requirement_ids", "definition" FROM "checks" WHERE "project" = ?', p.id).filter((c) =>
      humanKeys.some((k) => names(k, JSON.parse(c.criteria)) || names(k, JSON.parse(c.requirement_ids)) || names(k, JSON.parse(c.definition)?.covers?.criteria)),
    );
    assert.deepEqual(covering.map((c) => c.key), [], 'no check covers a human test');
    assert.equal(count(fx.home, 'acceptance_scopes'), before.scopes, 'no acceptance scope');
    assert.equal(count(fx.home, 'gate_evaluations', '"project" = ? AND "phase_plan" = ?', p.id, phase1.id), before.evaluations, 'no gate of the completed phase re-evaluated');
    assert.equal(rows(fx.home, 'SELECT s.* FROM "signoffs" s JOIN "candidates" k ON k."id" = s."candidate" WHERE k."project" = ?', p.id).length, before.signoffs, 'no sign-off');
    assert.equal(JSON.stringify(phasePlansOf(fx.home, p.id).find((x) => x.id === phase1.id)), before.phase1, 'phase 1\'s completed_at and completion binding unchanged');
    assert.equal(workOf(fx.home, p.id, 'replan').length, before.replans, 'no replan');
    void step;
  });
  test('(b), (l) M519 F1: human-kind criteria written as plain criteria are never uncovered in the impact, never owed a check, and are carried by their target\'s human test', async (t) => {
    assertV2Shape(assert);
    const fx = await scriptedEngine(t);
    const { p, ctx, v2 } = await published(fx, { criteria: CRITERIA_WITH_HUMAN });
    assert.deepEqual(v2.requirements.find((r) => r.key === 'R2').criteria.map((c) => c.id), ['R2.1', 'R2.2', 'R2.3', 'R2.4'], 'the fixture: the Spec Writer writes R2.4 as a plain criterion');
    await design(fx, p, { criteria: CRITERIA_WITH_HUMAN });
    const batch = await settledBatch(fx, ctx);
    // At raise: the impact lists the checkable criteria uncovered, never the human-kind ones.
    const atRaise = JSON.parse(rows(fx.home, 'SELECT "impact_value" FROM "spec_change_requests" WHERE "id" = ?', batch.spec_change.subject_id)[0]?.impact_value ?? 'null');
    const uncoveredAtRaise = atRaise?.checks?.uncovered ?? null;
    assert.ok(Array.isArray(uncoveredAtRaise), `the impact computed at raise (${JSON.stringify(atRaise?.checks)})`);
    for (const id of CHECKABLE_IDS) assert.ok(uncoveredAtRaise.includes(id), `the fixture is live: ${id} uncovered at raise (${uncoveredAtRaise})`);
    assert.deepEqual(uncoveredAtRaise.filter((id) => HUMAN_IDS.includes(id)), [], `at raise: no human-kind criterion uncovered in the impact (D7 §7.3; the ruling's item 2) (${uncoveredAtRaise})`);
    await consume(fx, p.id, batch.design_approval, 'approve');
    await consume(fx, p.id, batch.spec_change, 'approve');
    await pump(fx, ctx, () => approvedRevision(fx.home, p.id) ?? undefined, { what: 'the design approved', max: 10 });
    // As applied: the impact recomputed, and the correction it registered, owe nothing for them.
    const change = designChange(fx.home, p.id);
    assert.deepEqual((change.impact?.checks?.uncovered ?? []).filter((id) => HUMAN_IDS.includes(id)), [], `as applied: no human-kind criterion uncovered (${change.impact?.checks?.uncovered})`);
    assert.ok(change.correction, `the correction registered for the checkable criteria (${readinessFacts(fx.home, p.id)})`);
    const owed = change.correction.trigger_evidence?.criteria?.uncovered ?? [];
    assert.deepEqual([...owed].sort(), CHECKABLE_IDS, `the correction names the checkable criteria and no human-kind one (${owed})`);
    assert.equal(count(fx.home, 'check_obligations', '"project" = ? AND (' + HUMAN_IDS.map(() => '"criteria" LIKE ?').join(' OR ') + ')', p.id, ...HUMAN_IDS.map((id) => `%"${id}"%`)), 0, 'no obligation names a human-kind criterion');
    await pump(fx, ctx, () => designRevisions(fx.home, p.id).find((r) => r.ready_at) ?? undefined, { what: 'readiness', max: 40 }).catch((err) => assert.fail(`${err.message.split('\n')[0]} (${readinessFacts(fx.home, p.id)})`));
    for (const id of HUMAN_IDS) assert.deepEqual(checksCovering(fx.home, p.id, id), [], `no check of ${id} was owed or written`);
    // Carried by the target's human test (D7 §7.3): GET …/design human_tests[].criteria.
    const read = await readDesign(fx, p.id);
    for (const [target, id] of Object.entries(HUMAN_KIND_IDS)) {
      const h = (read.human_tests ?? []).find((x) => x.target === target);
      assert.ok(h, `the ${target} human test on GET …/design (${JSON.stringify(read.human_tests)})`);
      assert.ok(Array.isArray(h.criteria) && h.criteria.includes(id), `the ${target} human test carries ${id} (human_tests[].criteria; the ruling's item 2) (${JSON.stringify(h)})`);
      const other = Object.entries(HUMAN_KIND_IDS).filter(([t2]) => t2 !== target).map(([, x]) => x);
      assert.deepEqual(h.criteria.filter((x) => other.includes(x) || CHECKABLE_IDS.includes(x)), [], `and only its own target's human-kind criteria (${JSON.stringify(h.criteria)})`);
      assert.equal(h.status, 'pending', `still pending, never verified (${h.status})`);
    }
  });
});
