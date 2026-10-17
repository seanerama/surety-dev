// M531, owner verdicts are owner acts (slice 45; kernel lane). M6 plan §3.7
// M531; D7 §10.3, §3.3, §10.5, §15 class C; G5; Q4; BS6 §4.1 rule 26;
// SEAM.md §§502, 517, 521 to 526.
//
// Pantry designed before build with one design criterion on android (R3.2,
// `state_marker_present`, M517's), built, its R3.2 check failing on every
// candidate: the Android stage's gate unsatisfied. The owner reviews his
// Android builds (D7 §10.5) four times:
// (a) a review file whose verdict carries a `status` field:
//     `DESIGN_SCHEMA_INVALID`, refused;
// (b) close with a review whose every verdict says `matches`: every verdict
//     `proposed`, no owner evidence;
// (c) the transcript recording the owner saying "confirmed": none either;
// (d) `design_verdicts` answered `reject`: none recorded; answered
//     `confirm`, and `surety design verdicts <review> confirm --edit …`:
//     the confirmed verdicts recorded with `confirmed_by` and the decision;
// (e) a review's design delta and implementation defect before
//     confirmation: nothing routed (no finding; the batched
//     `design_approval` blocked);
// (f) a confirmed verdict against the failed required check: the check's
//     failure stands, the gate unsatisfied;
// (g) a confirmed verdict whose design version is later superseded: kept as
//     history with its bindings, not counted for the new version.
//
// No unit (kernel lane). No browser, emulator or device: the owner's words
// are the evidence of these reviews (rule 22).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { decisionsOn } from './harness/decisions.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { candidatesOfProject, evaluationsOfKind, pump, resultsOf } from './harness/journey/drive.mjs';
import { scriptedEngine, tick, waitForIdle } from './harness/runs.mjs';
import { transcriptEntries } from './harness/sessions.mjs';
import { withStore } from './harness/store.mjs';
import { REQUIREMENTS } from './harness/design/reference.mjs';
import { assertNoSilentHold, inventoryOf, stageRow, toPublished } from './harness/design/drive.mjs';
import { BEFORE_BUILD, KERNEL_KINDS, approveBatch, assertPassed, checkSession, designModel, filesOf, scriptVariant, untilBatch, variantOf } from './harness/design/check41.mjs';
import { postCloseRaw } from './harness/session-lane.mjs';
import { approveReviewBatch, authoringByPhase, batchSpec, currentRevision, revisedHumanTests, specWriter } from './harness/design/plan44.mjs';
import {
  MARKER,
  MARKER_CORRECTION,
  MARKER_CRITERION,
  REVIEW_FILE,
  batchMembers,
  blockersOf,
  decision,
  designVerdicts,
  driveReview,
  findingsOf,
  humanTestOf,
  markerFails,
  openVerdicts,
  postReview,
  readDesign,
  reviewJson,
  reviewRow,
  verdictOf,
} from './harness/design/review45.mjs';

const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const S2 = 'S2';
const subjectOf = (build, candidate) => ({ kind: 'owner_build', target: 'android', build_ref: build, ...(candidate ? { candidate } : {}) });
const matches = (observed_on = 'device', extra = {}) => ({ target: 'android', key: S2, verdict: 'matches', observed_on, evidence: [], deltas: [], ...extra });
// The marker check's results by candidate (the latest first).
const markerResults = (home, project) =>
  rows(home, 'SELECT r.* FROM "check_results" r JOIN "check_executions" x ON x."id" = r."execution" JOIN "checks" c ON c."id" = x."check" WHERE r."project" = ? AND c."key" = ? ORDER BY r."execution_seq" DESC', project, MARKER);

// The owner's review of his Android build: POST …/design/reviews, the turns
// given, closed. Returns {run, review (its id), out}.
async function ownerReviewOf(fx, project, { build, candidate, turns }) {
  const opened = await postReview(fx, project, { target: 'android', build_ref: build, ...(candidate ? { candidate } : {}) });
  assert.equal(opened.status, 201, `POST …/design/reviews (→ ${opened.status} ${opened.text?.slice(0, 300)})`);
  const out = await driveReview(fx, project, opened.body.run, turns);
  const review = opened.body?.review?.id ?? opened.body?.review ?? null;
  return { run: opened.body.run, review, out };
}

describe('M531 owner verdicts are owner acts (shared: Pantry with R3.2 failing on every candidate)', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    J.fx = fx;
    const { p } = await toPublished(fx, { policy: BEFORE_BUILD, name: 'pantry-verdicts' });
    const model = variantOf(designModel(inventoryOf(p)), (m) => {
      m.criteria.criteria = [{ ...MARKER_CRITERION }];
    });
    const v2 = batchSpec({ base: REQUIREMENTS, criteria: model.criteria });
    const ctx = scriptVariant(fx, p, v2);
    authoringByPhase(fx);
    fx.scripted.kindScript('check_correction', MARKER_CORRECTION);
    ctx.answerKinds = [...KERNEL_KINDS];
    const session = await checkSession(fx, p.id, [{ name: 'the design with R3.2', model }]);
    assertPassed(session.saves[0].res, 'the design');
    const closed = await postCloseRaw(fx, p.id, session.run.id, {});
    assert.equal(closed.status, 200, `the close (${closed.text?.slice(0, 300)})`);
    J.approved = await approveBatch(fx, ctx, await untilBatch(fx, ctx));
    // Built, R3.2's check failing on every candidate: the Android stage's gate unsatisfied.
    J.failing = await pump(fx, ctx, () => {
      const r = markerResults(fx.home, p.id)[0];
      const stage3 = stageRow(fx.home, p.id, 3);
      const evaluated = stage3 && evaluationsOfKind(fx.home, p.id, 'stage').some((e) => e.stage === stage3.id);
      return r && r.exit_status !== 0 && evaluated ? r : undefined;
    }, { what: 'R3.2\'s check failing on a candidate of the Android stage, and its stage gate evaluated', max: 160, exits: markerFails() });
    await waitForIdle(fx.home, p.id);
    Object.assign(J, { p, ctx, model, v2 });
  });
  after(shared.cleanup);

  test('(a) a verdict carrying a status field: DESIGN_SCHEMA_INVALID, refused; (b) close with every verdict matches: every verdict proposed, no owner evidence; (c) the owner saying "confirmed" in the session: none either; (d) design_verdicts answered reject: none recorded', async () => {
    const { fx, p } = J;
    const forged = reviewJson({ subject: subjectOf('pantry-android 0.1.0 (build 7)'), screens: [matches('device', { status: 'confirmed' })] });
    const honest = reviewJson({ subject: subjectOf('pantry-android 0.1.0 (build 7)'), screens: [matches()] });
    const r = await ownerReviewOf(fx, p.id, {
      build: 'pantry-android 0.1.0 (build 7)',
      turns: [
        { files: { [REVIEW_FILE(1)]: forged }, say: 'It all matches on my phone.' },
        { files: { [REVIEW_FILE(1)]: honest }, say: 'Confirmed. Every verdict is right; I confirm them all.', done: true },
      ],
    });
    const [first, second] = r.out.saves;
    assert.equal(first.status, 200, `the save answers with its check (${first.text?.slice(0, 300)})`);
    assert.equal(first.body?.design_check?.outcome, 'refused', `a verdict with a status field refused (B.14) (${JSON.stringify(first.body?.design_check)})`);
    assert.ok((first.body.design_check.reasons ?? []).some((x) => x.code === 'DESIGN_SCHEMA_INVALID' && JSON.stringify(x.subjects).includes('status')), 'DESIGN_SCHEMA_INVALID naming status');
    assert.equal(second.body?.design_check?.outcome, 'passed', 'the review without it passes');
    assert.equal(r.out.close.status, 200, `the close (${r.out.close.text?.slice(0, 300)})`);
    const review = reviewRow(fx.home, r.review);
    assert.ok(review, 'the review recorded');
    assert.ok(review.verdicts.length > 0 && review.verdicts.every((v) => v.status === 'proposed'), `(b) every verdict proposed (${JSON.stringify(review.verdicts)})`);
    assert.equal(review.confirmed_by ?? null, null, '(b) not confirmed by the close');
    const said = transcriptEntries(fx.home, r.run.id).filter((e) => e.speaker === 'owner' && /Confirmed/.test(e.text ?? ''));
    assert.ok(said.length > 0, '(c) the transcript records the owner saying "confirmed"');
    let design = await readDesign(fx, p.id);
    assert.equal(humanTestOf(design, 'android')?.status, 'pending', '(b), (c) the android human test pending');
    assert.deepEqual((humanTestOf(design, 'android')?.evidence ?? []).filter((e) => e.review === review.id), [], '(b), (c) no owner evidence from the review');
    const verdicts = openVerdicts(fx.home, p.id, review.id);
    assert.ok(verdicts, 'design_verdicts open: the only way the verdicts become his');
    const rejected = await fx.engine.post(`/v1/projects/${p.id}/decisions/${verdicts.id}/answer`, { option: 'reject', preview_hash: verdicts.preview_hash });
    assert.equal(rejected.status, 200, `(d) design_verdicts answered reject (${rejected.text})`);
    const after_ = reviewRow(fx.home, review.id);
    assert.ok(!after_.verdicts.some((v) => v.status === 'confirmed'), `(d) reject records none (${JSON.stringify(after_.verdicts)})`);
    assert.equal(after_.confirmed_by ?? null, null, '(d) and no confirmer');
    design = await readDesign(fx, p.id);
    assert.equal(humanTestOf(design, 'android')?.status, 'pending', '(d) the human test still pending');
  });

  test('(d) design_verdicts answered confirm: the verdict recorded with confirmed_by and the decision; (f) against the failed required check: the check\'s failure stands, the gate unsatisfied', async () => {
    const { fx, p, ctx, failing } = J;
    const candidate = candidatesOfProject(fx.home, p.id).find((c) => c.id === failing.candidate);
    const r = await ownerReviewOf(fx, p.id, { build: 'pantry-android 0.1.1 (build 8)', candidate: candidate.id, turns: [{ files: { [REVIEW_FILE(2)]: reviewJson({ subject: subjectOf('pantry-android 0.1.1 (build 8)', candidate.id), screens: [matches()] }) }, say: 'It matches on my phone.', done: true }] });
    assert.equal(r.out.close.status, 200, 'the close');
    const verdicts = openVerdicts(fx.home, p.id, r.review);
    const res = await fx.engine.post(`/v1/projects/${p.id}/decisions/${verdicts.id}/answer`, { option: 'confirm', preview_hash: verdicts.preview_hash });
    assert.equal(res.status, 200, `design_verdicts answered confirm (${res.text})`);
    const review = reviewRow(fx.home, r.review);
    assert.equal(verdictOf(review, 'android', S2)?.status, 'confirmed', 'the verdict confirmed');
    assert.ok(review.confirmed_by, `(d) recorded with confirmed_by (${JSON.stringify(review)})`);
    assert.equal(review.confirmation_decision, verdicts.id, '(d) and the decision');
    assert.equal(decision(fx.home, verdicts.id).answer?.actor ?? 'human', 'human', '(d) answered by the owner');
    J.confirmedReview = review;
    const design = await readDesign(fx, p.id);
    assert.equal(humanTestOf(design, 'android')?.status, 'owner_accepted', 'the android human test owner-accepted (Q4)');
    // (f) the failure stands.
    const evaluationsBefore = evaluationsOfKind(fx.home, p.id, 'stage').length;
    await tick(fx.engine, p.id, { rounds: 3 });
    await waitForIdle(fx.home, p.id);
    assert.notEqual(markerResults(fx.home, p.id)[0]?.exit_status, 0, '(f) R3.2\'s latest result still failing');
    const stage3 = stageRow(fx.home, p.id, 3);
    assert.notEqual(stage3.status, 'verified', `(f) the Android stage not verified (${stage3.status})`);
    const stageEvals = evaluationsOfKind(fx.home, p.id, 'stage').filter((e) => e.stage === stage3.id);
    assert.ok(stageEvals.length > 0 && !stageEvals.some((e) => e.outcome === 'satisfied'), `(f) no stage gate of the Android stage satisfied (${JSON.stringify(stageEvals.map((e) => [e.id, e.outcome]))})`);
    assert.ok(!JSON.stringify(evaluationsOfKind(fx.home, p.id, 'stage').slice(evaluationsBefore)).includes(review.id), '(f) the verdict is no input of any gate');
    assert.ok(!resultsOf(fx.home, p.id).some((x) => JSON.stringify(x).includes(review.id)), '(f) nor a check result');
    void ctx;
  });

  test('(e) a review\'s design delta and implementation defect before confirmation: nothing routed; (d) surety design verdicts … confirm --edit …: recorded as edited, with confirmed_by and the decision; then routed', async () => {
    const { fx, p, ctx, model, v2 } = J;
    const revised = revisedHumanTests(model, 2);
    const v3 = batchSpec({ base: v2.requirements.filter((x) => !Object.values(v2.humanKeys).includes(x.key)), criteria: { criteria: [], human_tests: revised.criteria.human_tests }, version: 3, humanKind: 'text_changed', humanKeys: v2.humanKeys });
    fx.scripted.kindScript('spec_change', specWriter(v3.text, v3.changes));
    const screens = [
      {
        target: 'android',
        key: S2,
        verdict: 'deltas',
        observed_on: 'device',
        evidence: [],
        deltas: [
          { owner_words: 'Judge the list on a tablet too.', kind: 'design' },
          { owner_words: 'The rows overlap the status bar on my phone.', kind: 'implementation' },
        ],
      },
    ];
    const findingsBefore = findingsOf(fx.home, p.id).length;
    const r = await ownerReviewOf(fx, p.id, { build: 'pantry-android 0.1.2 (build 9)', turns: [{ clear: true, files: { ...filesOf(revised), [REVIEW_FILE(3)]: reviewJson({ subject: subjectOf('pantry-android 0.1.2 (build 9)'), screens, revised_design: true }) }, say: 'Two things on my phone.', done: true }] });
    assert.equal(r.out.close.status, 200, `the close (${r.out.close.text?.slice(0, 300)})`);
    const verdicts = await pump(fx, ctx, () => openVerdicts(fx.home, p.id, r.review) ?? undefined, { what: 'design_verdicts', max: 10 });
    const members = await pump(fx, ctx, () => {
      const m = batchMembers(fx.home, p.id, decision(fx.home, verdicts.id).batch_key);
      return m.design_approval && m.spec_change ? m : undefined;
    }, { what: 'the review\'s batch', max: 40 });
    assert.ok(blockersOf(members.design_approval).some((b) => String(b).startsWith('DESIGN_VERDICTS_UNCONFIRMED')), `(e) the design delta not routed: approve blocked (${JSON.stringify(blockersOf(members.design_approval))})`);
    await tick(fx.engine, p.id, { rounds: 2 });
    await waitForIdle(fx.home, p.id);
    assert.equal(findingsOf(fx.home, p.id).length, findingsBefore, '(e) the implementation defect not routed: no finding');
    const edited = { target: 'android', screen: S2, observed_on: 'emulator' };
    const res = designVerdicts(fx, p.id, r.review, 'confirm', { edits: [edited] });
    assert.equal(res.status, 0, `surety design verdicts … confirm --edit (${res.stdout} ${res.stderr})`);
    const review = reviewRow(fx.home, r.review);
    const v = verdictOf(review, 'android', S2);
    assert.deepEqual([v?.status, v?.observed_on], ['confirmed', 'emulator'], `(d) confirmed as he edited it (${JSON.stringify(v)})`);
    assert.ok(review.confirmed_by, '(d) with confirmed_by');
    assert.equal(review.confirmation_decision, verdicts.id, '(d) and the decision');
    const found = await pump(fx, ctx, () => findingsOf(fx.home, p.id).slice(findingsBefore).find((f) => /status bar/.test(f.message ?? '')), { what: 'the defect routed after the confirmation', max: 10 });
    assert.equal(found.proposed_severity, 'medium', 'routed now: a finding, Medium');
    const unblocked = await pump(fx, ctx, () => decisionsOn(fx.home, 'design_approval', members.design_approval.subject_id).find((d) => d.status === 'open' && !blockersOf(d).some((b) => String(b).startsWith('DESIGN_VERDICTS_UNCONFIRMED'))), { what: 'the approval unblocked', max: 10 });
    assert.ok(unblocked, 'routed now: approve no longer waits on the verdicts');
  });

  test('(g) a confirmed verdict whose design version is superseded: kept as history with its bindings, not counted for the new version', async () => {
    const { fx, p, ctx, confirmedReview, approved } = J;
    await approveReviewBatch(fx, ctx, { verdicts: 'any' });
    const v2 = await pump(fx, ctx, () => {
      const c = currentRevision(fx.home, p.id);
      return c && c.id !== approved.id ? c : undefined;
    }, { what: 'design version 2 approved', max: 20 });
    assert.equal(v2.version, 2, 'design version 2');
    const kept = reviewRow(fx.home, confirmedReview.id);
    assert.equal(verdictOf(kept, 'android', S2)?.status, 'confirmed', 'the confirmed verdict kept as history');
    assert.equal(kept.design_revision, approved.id, 'bound to the version it was given on');
    assert.equal(kept.subject?.candidate, confirmedReview.subject?.candidate, 'and to its candidate');
    const design = await readDesign(fx, p.id);
    const android = humanTestOf(design, 'android');
    assert.equal(android?.status, 'pending', `not counted for version 2: the android human test pending (${JSON.stringify(android)})`);
    assert.ok(!(android?.evidence ?? []).some((e) => e.review === confirmedReview.id && e.design_version === 2), 'no evidence of version 2 from it');
    assertNoSilentHold(fx.home, p.id, '(g)');
  });
});
