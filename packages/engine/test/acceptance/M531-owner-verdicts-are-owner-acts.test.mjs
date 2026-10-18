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
// F4 (M519's engine finding; Sean's rulings, 2026-10-18; D7 B.14 as E166
// amends it): a confirmed implementation difference is linked to a criterion
// and a check only by what its delta names (`criterion`, `check`, proposed in
// the review file or set by the owner's confirmation edit, validated again
// against current state before the confirmation takes effect); else it is
// filed with neither. Nothing is associated from another criterion of the
// same target. `fix` is offered only where a check named by the finding can
// verify it (b7249bb's rule, for every finding): an unlinked finding is
// offered the ordinary non-fix options, its disposition preview's
// `manifest.verification` and the reviews read's `finding_verification`
// saying verification is missing and fix unavailable, and an `accept` leaves
// it honestly unresolved (accept is not repair). R3.2's check,
// `marker-android`, is made to pass first, so android has a mapped criterion
// covered by a passing required acceptance check (M519's shape: its favicon
// criterion and `design-asset-favicon`):
// (h) an unmapped difference on android, and a `both` delta, each filed with
//     no criterion and no check; a `design` delta files none; `both` stays a
//     design delta; neither is offered `fix` (answered, refused 400), each
//     preview and the reviews read saying verification is missing and fix
//     unavailable; the owner's `accept` registers no fix and no
//     check_correction work, leaves it dispositioned `accept` (never
//     resolved), and a pass of `marker-android` registered after it changes
//     nothing;
// (i) the owner's edit naming an unknown criterion, an unknown check, a check
//     that does not cover the criterion, or a check without a criterion:
//     refused naming the field, nothing filed; his edit adding R3.2 and
//     `marker-android`: the finding names exactly those, verifiable, `fix`
//     offered; a pass before the `fix` disposition resolves nothing, a pass
//     after it resolves it;
// (j) the Designer's review file proposing R3.2 and `marker-android` on a
//     delta: its check passes; the owner's edit leaving that verdict's deltas
//     untouched keeps the proposed link, judged again, and the finding names
//     it; one proposing a check that does not cover its criterion: the close
//     refused, nothing recorded or filed;
// (k) the owner's edit removing the link the Designer proposed: the finding
//     carries none; his edit naming a criterion without a check: the finding
//     names the criterion only; each `missing`, no `fix`, accepted and
//     unresolved, no work registered;
// (l) a proposed link valid when the review was recorded made stale before
//     the confirmation by a protected-version change through the engine's
//     own routes (a check_correction run whose approved proposal moves
//     `marker-android` off R3.2): the plain confirm, and an edit leaving the
//     deltas untouched, refused naming the field, nothing consumed,
//     confirmed or filed; the owner's edit dropping the link confirms.
//
// No unit (kernel lane). No browser, emulator or device: the owner's words
// are the evidence of these reviews (rule 22).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { decisionsOn } from './harness/decisions.mjs';
import { evaluate, sharedFixture } from './harness/gates.mjs';
import { findingRow, missingFor, workFor } from './harness/checks/repair.mjs';
import { operatorRequest, recordExit } from './harness/checks/selection.mjs';
import { definitionText } from './harness/checks/fixtures.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { step } from './harness/scripted.mjs';
import { candidatesOfProject, evaluationsOfKind, pump, resultsOf } from './harness/journey/drive.mjs';
import { addWork, scriptedEngine, tick, waitForIdle } from './harness/runs.mjs';
import { transcriptEntries } from './harness/sessions.mjs';
import { withStore } from './harness/store.mjs';
import { REQUIREMENTS } from './harness/design/reference.mjs';
import { assertHoldsAccounted, inventoryOf, stageRow, toPublished } from './harness/design/drive.mjs';
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
  consume,
  decision,
  designVerdicts,
  driveReview,
  findingsOf,
  humanTestOf,
  markerFails,
  openVerdicts,
  postReview,
  readDesign,
  reviewInDesign,
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

// F4's reads: the effective protected version's checks, each with the
// criteria it covers; the newest candidate not superseded; a finding by the
// owner's words; the open disposition question about a finding.
const effectiveChecks = (home, project) =>
  rows(
    home,
    `SELECT c.* FROM "checks" c JOIN "protected_versions" v ON v."id" = c."protected_version"
     WHERE v."project" = ? AND v."authorized" = 1 AND v."effective_from" IS NOT NULL AND v."superseded_by" IS NULL ORDER BY c."key"`,
    project,
  ).map((c) => ({ ...c, criteria: JSON.parse(c.criteria ?? '[]') }));
const liveCandidate = (home, project) => candidatesOfProject(home, project).filter((c) => c.superseded_by === null).at(-1);
const findingBy = (home, project, words) => findingsOf(home, project).filter((f) => (f.message ?? '').includes(words));
const openDisposition = (home, finding) => decisionsOn(home, 'finding_disposition', finding).find((d) => d.status === 'open');
// A pass of `marker-android` on the newest candidate, registered now through
// the operator route (SEAM.md §180) and recorded with exit 0; the stage
// gate of the Android stage evaluated on that candidate right after.
async function markerPass(fx, project) {
  await waitForIdle(fx.home, project);
  const candidate = liveCandidate(fx.home, project);
  const executions = await operatorRequest(fx.engine, project, candidate.id, [MARKER]);
  assert.ok(executions[MARKER], `an execution of ${MARKER} registered on ${candidate.id} (${JSON.stringify(executions)})`);
  const result = await recordExit(fx.engine, executions[MARKER], 0);
  return { candidate, result };
}
async function androidGate(fx, project, candidate) {
  const stage = stageRow(fx.home, project, 3);
  const marker = effectiveChecks(fx.home, project).find((c) => c.key === MARKER);
  const evaluation = await evaluate(fx.engine, project, candidate.id, 'stage', { stage: stage.id });
  assert.equal(evaluation.check_states?.[marker.id], 'passed', `the fixture is live: ${MARKER} is in the Android stage's scope and passed there (${JSON.stringify(evaluation.check_states)})`);
  return evaluation;
}
// The confirmation's answer, raw: {status, body, text}.
const confirmWith = (fx, project, verdicts, extra = {}) => fx.engine.post(`/v1/projects/${project}/decisions/${verdicts.id}/answer`, { option: 'confirm', preview_hash: verdicts.preview_hash, ...extra });

// F4, second ruling: what the disposition preview and the reviews read say
// of a finding's verification (the contract's shape: {state, fix_available,
// criterion, check, reason}).
const optionKeysOf = (row) => (row?.options ?? []).map((o) => o.key);
// An unlinked finding (no check, or a criterion without one): `missing`,
// fix unavailable, the reason saying so in words, and (no check) that no
// route in M6 adds a check to an existing finding.
function assertMissing(v, { criterion = null, check = null } = {}, what) {
  assert.ok(v && typeof v === 'object', `${what}: its verification is stated (${JSON.stringify(v)})`);
  assert.deepEqual([v.state, v.fix_available, v.criterion ?? null, v.check ?? null], ['missing', false, criterion, check], `${what}: verification missing, fix unavailable, the links as filed (${JSON.stringify(v)})`);
  const reason = String(v.reason ?? '');
  assert.match(reason, /verification/i, `${what}: the reason names the verification (${reason})`);
  assert.match(reason, /missing/i, `${what}: and says it is missing (${reason})`);
  assert.match(reason, /\bfix\b/i, `${what}: the reason names fix (${reason})`);
  assert.match(reason, /unavailable|not available|not offered/i, `${what}: and says it is unavailable (${reason})`);
  if (check === null) assert.ok(/\broute\b/i.test(reason) && /\badd/i.test(reason), `${what}: and that no route in M6 adds a check to an existing finding (${reason})`);
}
function assertVerifiable(v, { criterion, check }, what) {
  assert.ok(v && typeof v === 'object', `${what}: its verification is stated (${JSON.stringify(v)})`);
  assert.deepEqual([v.state, v.fix_available, v.criterion, v.check], ['verifiable', true, criterion, check], `${what}: verifiable through the check it names (${JSON.stringify(v)})`);
  assert.equal(typeof v.reason, 'string', `${what}: with a reason`);
}
// The owner's open question about an unlinked finding: no fix (answered,
// refused as no option of it), no correct_check where it names no check,
// accept (Medium) offered; the preview's manifest and its words say why.
async function assertNoFix(fx, project, question, links, what) {
  assert.ok(!optionKeysOf(question).includes('fix'), `${what}: fix is not offered where no check named by the finding can verify it (b7249bb's rule, no exception; F4 second ruling) (${JSON.stringify(optionKeysOf(question))})`);
  if ((links.check ?? null) === null) assert.ok(!optionKeysOf(question).includes('correct_check'), `${what}: nor correct_check, naming no check`);
  assert.ok(optionKeysOf(question).includes('accept'), `${what}: the ordinary accept offered (${JSON.stringify(optionKeysOf(question))})`);
  assertMissing(question.manifest?.verification, links, `${what}: the preview's manifest.verification`);
  const words = [question.question, ...Object.entries(question.manifest ?? {}).filter(([k]) => k !== 'verification').map(([, x]) => (typeof x === 'string' ? x : ''))].join(' ');
  assert.ok(/verification/i.test(words) && /missing/i.test(words) && /unavailable|not available|not offered/i.test(words), `${what}: the question says in words that verification is missing and fix unavailable (${question.question})`);
  const refused = await fx.engine.post(`/v1/projects/${project}/decisions/${question.id}/answer`, { option: 'fix', preview_hash: question.preview_hash });
  assert.equal(refused.status, 400, `${what}: fix answered is refused (${refused.status} ${refused.text})`);
  assert.equal(refused.body?.code, 'invalid_value', `${what}: as no option of the question (${refused.text})`);
  assert.equal(refused.body?.subject?.field, 'option', `${what}: naming the option (${JSON.stringify(refused.body?.subject)})`);
  assert.equal(decision(fx.home, question.id).status, 'open', `${what}: nothing consumed by the refused fix`);
}
// The reviews read's `finding_verification`, one entry per filed finding.
async function verificationRead(fx, project, review) {
  const read = reviewInDesign(await readDesign(fx, project), review);
  assert.ok(read, `the review in the design read (${review})`);
  const list = read.finding_verification;
  assert.ok(Array.isArray(list), `the reviews read carries finding_verification (${JSON.stringify(Object.keys(read))})`);
  assert.deepEqual(list.map((x) => x.finding).sort(), [...(read.findings ?? [])].sort(), `one entry per filed finding (${JSON.stringify(list)} vs ${JSON.stringify(read.findings)})`);
  return (finding) => list.find((x) => x.finding === finding);
}
// After the owner's accept: dispositioned accept, never resolved, no fix
// and no check_correction work registered for it.
function assertAcceptedUnresolved(fx, project, finding, what) {
  const now = findingRow(fx.home, finding);
  assert.deepEqual([now.status, now.disposition], ['dispositioned', 'accept'], `${what}: dispositioned accept, not resolved (accept is not repair) (${JSON.stringify({ status: now.status, disposition: now.disposition })})`);
  assert.equal(now.resolution_verification ?? null, null, `${what}: no resolving result recorded`);
  assert.deepEqual(workFor(fx.home, project, 'fix', finding), [], `${what}: no fix work registered`);
  assert.deepEqual(workFor(fx.home, project, 'check_correction', finding), [], `${what}: no check_correction work registered`);
  return now;
}

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
    await assertHoldsAccounted(fx, p.id, '(g)');
  });

  // ---- F4 (Sean's ruling, 2026-10-18) ----------------------------------------------------------

  const UNMAPPED = 'The rows overlap the status bar on the tablet.';
  const BOTH = 'An empty pantry shows a blank screen: say "Nothing in the pantry".';
  const DESIGN_ONLY = 'Show the list as a grid on a tablet.';
  const LABEL = 'The rows carry no accessibility label for the screen reader.';
  const PROPOSED = 'The rows announce nothing when the screen reader reaches them.';
  const UNCOVERED = 'The list never says how many items it holds.';

  test('(h) F4: an unmapped difference and a both delta, on a target whose mapped criterion R3.2 is covered by a passing required acceptance check, are filed with no criterion and no check; a design delta files none and both stays a design delta; neither is offered fix, the preview and the reviews read saying verification is missing and fix unavailable; accepted, no work registered, never resolved, and a pass of the unrelated check after the disposition changes nothing', async () => {
    const { fx, p, ctx } = J;
    // M519's shape: android's mapped criterion R3.2, covered by a required acceptance check that passes.
    const marker = effectiveChecks(fx.home, p.id).find((c) => c.key === MARKER);
    assert.ok(marker && marker.required === 1 && (marker.origin ?? 'acceptance') === 'acceptance' && marker.criteria.includes('R3.2'), `the fixture is live: ${MARKER} is a required acceptance check covering R3.2 (${JSON.stringify(marker)})`);
    const before = await markerPass(fx, p.id);
    const findingsBefore = findingsOf(fx.home, p.id).length;
    const build = 'pantry-android 0.1.3 (build 10)';
    const screens = [
      {
        target: 'android',
        key: S2,
        verdict: 'deltas',
        observed_on: 'device',
        evidence: [],
        deltas: [
          { owner_words: UNMAPPED, kind: 'implementation' },
          { owner_words: DESIGN_ONLY, kind: 'design' },
          { owner_words: BOTH, kind: 'both' },
        ],
      },
    ];
    const r = await ownerReviewOf(fx, p.id, { build, candidate: before.candidate.id, turns: [{ files: { [REVIEW_FILE(4)]: reviewJson({ design_version: 2, subject: subjectOf(build, before.candidate.id), screens }) }, say: 'Three things on my tablet.', done: true }] });
    assert.equal(r.out.saves[0]?.body?.design_check?.outcome, 'passed', `the review file passes its check (${JSON.stringify(r.out.saves[0]?.body?.design_check)})`);
    assert.equal(r.out.close.status, 200, `the close (${r.out.close.text?.slice(0, 300)})`);
    const verdicts = await pump(fx, ctx, () => openVerdicts(fx.home, p.id, r.review) ?? undefined, { what: 'design_verdicts', max: 10 });
    const res = await confirmWith(fx, p.id, verdicts);
    assert.equal(res.status, 200, `design_verdicts confirmed as proposed (${res.text})`);
    const filed = findingsOf(fx.home, p.id).slice(findingsBefore);
    // (e) the kinds: implementation and both file one finding each; design files none.
    assert.deepEqual(filed.map((f) => [UNMAPPED, BOTH, DESIGN_ONLY].find((w) => (f.message ?? '').includes(w)) ?? f.message).sort(), [BOTH, UNMAPPED].sort(), `one finding each for the implementation and the both delta, none for the design delta (${JSON.stringify(filed.map((f) => f.message))})`);
    const review = reviewRow(fx.home, r.review);
    const kinds = (verdictOf(review, 'android', S2)?.deltas ?? []).map((d) => [d.owner_words, d.kind]);
    assert.deepEqual(kinds, [[UNMAPPED, 'implementation'], [DESIGN_ONLY, 'design'], [BOTH, 'both']], `(e) the confirmed verdict keeps every delta and its kind: both stays a design delta beside its finding (${JSON.stringify(kinds)})`);
    // (a), (c): no relationship established, none manufactured from R3.2 on the same target.
    const [unmapped] = findingBy(fx.home, p.id, UNMAPPED);
    const [both] = findingBy(fx.home, p.id, BOTH);
    for (const [what, f] of [['the unmapped implementation difference', unmapped], ['the both delta', both]]) {
      assert.deepEqual([f.criterion, f.check], [null, null], `${what}: filed with no criterion and no check, nothing taken from R3.2 or ${MARKER} (F4) (${JSON.stringify({ criterion: f.criterion, check: f.check })})`);
      assert.deepEqual([f.scope, f.candidate, f.category], ['candidate', before.candidate.id, 'defect'], `${what}: a defect against the candidate the owner named`);
    }
    // No fix where no check can verify it: the ordinary options, and the preview and the reviews read say why.
    for (const [what, f] of [['the unmapped implementation difference', unmapped], ['the both delta', both]]) {
      const q = await pump(fx, ctx, () => openDisposition(fx.home, f.id), { what: `the disposition owed on ${what}`, max: 10 });
      await assertNoFix(fx, p.id, q, { criterion: null, check: null }, what);
      assertMissing((await verificationRead(fx, p.id, r.review))(f.id), { criterion: null, check: null }, `${what}: the reviews read's finding_verification`);
    }
    // The owner's accept: recorded, honestly unresolved, nothing dispatched.
    await consume(fx, p.id, openDisposition(fx.home, unmapped.id), 'accept');
    const accepted = assertAcceptedUnresolved(fx, p.id, unmapped.id, 'the unmapped finding accepted');
    // A pass of the unrelated check, registered after the disposition, changes nothing.
    const after_ = await markerPass(fx, p.id);
    assert.ok(after_.result.execution_seq > accepted.disposition_seq, 'the fixture is live: the pass was registered after the disposition');
    await androidGate(fx, p.id, after_.candidate);
    const now = assertAcceptedUnresolved(fx, p.id, unmapped.id, `after ${MARKER}'s later pass`);
    assert.deepEqual([now.criterion, now.check], [null, null], `still no criterion and no check: nothing associated from ${MARKER}'s pass (${JSON.stringify({ criterion: now.criterion, check: now.check })})`);
    J.f4 = { unmapped, both };
  });

  test('(i) F4: the owner\'s edit naming an unknown criterion, an unknown check, a check not covering the criterion, or a check without a criterion is refused naming the field and files nothing; his edit adding R3.2 and its covering check files a finding naming exactly those, verifiable and offered fix; a pass before the fix disposition resolves nothing, a pass after it resolves it', async () => {
    const { fx, p, ctx } = J;
    const checks = effectiveChecks(fx.home, p.id);
    const other = checks.find((c) => c.key !== MARKER && !c.criteria.includes('R3.2') && c.criteria.length > 0);
    assert.ok(other, `the fixture is live: a check of the effective version covering criteria other than R3.2 (${JSON.stringify(checks.map((c) => [c.key, c.criteria]))})`);
    const candidate = liveCandidate(fx.home, p.id);
    const build = 'pantry-android 0.1.4 (build 11)';
    const proposed = { target: 'android', key: S2, verdict: 'deltas', observed_on: 'device', evidence: [], deltas: [{ owner_words: LABEL, kind: 'implementation' }] };
    const r = await ownerReviewOf(fx, p.id, { build, candidate: candidate.id, turns: [{ files: { [REVIEW_FILE(5)]: reviewJson({ design_version: 2, subject: subjectOf(build, candidate.id), screens: [proposed] }) }, say: 'The screen reader says nothing on the rows.', done: true }] });
    assert.equal(r.out.close.status, 200, `the close (${r.out.close.text?.slice(0, 300)})`);
    const verdicts = await pump(fx, ctx, () => openVerdicts(fx.home, p.id, r.review) ?? undefined, { what: 'design_verdicts', max: 10 });
    const findingsBefore = findingsOf(fx.home, p.id).length;
    const edit = (delta) => ({ edits: [{ target: 'android', screen: S2, deltas: [{ owner_words: LABEL, kind: 'implementation', ...delta }] }] });
    // (d) each refused naming its field, as an invalid value of the edit (not as an unknown field).
    for (const [what, delta, fields] of [
      ['an unknown criterion', { criterion: 'R9.9', check: MARKER }, ['edits[0].deltas[0].criterion']],
      ['an unknown check', { criterion: 'R3.2', check: 'no-such-check' }, ['edits[0].deltas[0].check']],
      [`a check (${other.key}) that does not cover the criterion`, { criterion: 'R3.2', check: other.key }, ['edits[0].deltas[0].check']],
      ['a check without a criterion', { check: MARKER }, ['edits[0].deltas[0].check', 'edits[0].deltas[0].criterion']],
    ]) {
      const res = await confirmWith(fx, p.id, verdicts, edit(delta));
      assert.equal(res.status, 422, `${what}: refused (${res.status} ${res.text})`);
      assert.equal(res.body?.code, 'invalid_value', `${what}: an invalid answer (${res.text})`);
      assert.ok(fields.includes(res.body?.subject?.field), `${what}: the refusal names the field, one of ${fields.join(' or ')} (${JSON.stringify(res.body?.subject)})`);
      assert.doesNotMatch(res.body?.reason ?? '', /is not a field/, `${what}: refused for its value, the fields being the delta's (${res.body?.reason})`);
      assert.equal(decision(fx.home, verdicts.id).status, 'open', `${what}: nothing consumed`);
      assert.equal(findingsOf(fx.home, p.id).length, findingsBefore, `${what}: nothing filed`);
      assert.equal(reviewRow(fx.home, r.review).confirmed_by ?? null, null, `${what}: nothing confirmed`);
    }
    // (b) the relationship the owner establishes: R3.2 and the required acceptance check covering it.
    const res = await confirmWith(fx, p.id, verdicts, edit({ criterion: 'R3.2', check: MARKER }));
    assert.equal(res.status, 200, `the owner's edit naming R3.2 and ${MARKER} confirmed (${res.text})`);
    const kept = verdictOf(reviewRow(fx.home, r.review), 'android', S2)?.deltas?.[0];
    assert.deepEqual([kept?.criterion, kept?.check], ['R3.2', MARKER], `the confirmed delta carries what the owner confirmed (${JSON.stringify(kept)})`);
    const filed = findingsOf(fx.home, p.id).slice(findingsBefore);
    assert.equal(filed.length, 1, `one finding (${JSON.stringify(filed.map((f) => f.message))})`);
    const [label] = filed;
    assert.ok((label.message ?? '').includes(LABEL), 'from the edited delta');
    assert.deepEqual([label.criterion, label.check], ['R3.2', MARKER], `the finding names exactly the criterion and check the owner confirmed (${JSON.stringify({ criterion: label.criterion, check: label.check })})`);
    // A pass of the check registered before the disposition resolves nothing.
    const early = await markerPass(fx, p.id);
    const question = await pump(fx, ctx, () => openDisposition(fx.home, label.id), { what: 'the disposition owed on the linked finding', max: 10 });
    // A valid link the owner added: verifiable, fix offered, as for any verifiable finding.
    assert.ok(optionKeysOf(question).includes('fix'), `fix offered: its named check can verify it (${JSON.stringify(optionKeysOf(question))})`);
    assertVerifiable(question.manifest?.verification, { criterion: 'R3.2', check: MARKER }, 'the preview\'s manifest.verification');
    assertVerifiable((await verificationRead(fx, p.id, r.review))(label.id), { criterion: 'R3.2', check: MARKER }, 'the reviews read\'s finding_verification');
    await consume(fx, p.id, question, 'fix');
    assert.ok(early.result.execution_seq <= findingRow(fx.home, label.id).disposition_seq, 'the fixture is live: that pass was registered before the disposition');
    assert.deepEqual(workFor(fx.home, p.id, 'check_correction', label.id), [], `a finding its named check can verify routes no check_correction (D3 §2.11)`);
    await waitForIdle(fx.home, p.id);
    const unresolved = await androidGate(fx, p.id, liveCandidate(fx.home, p.id));
    assert.notEqual(findingRow(fx.home, label.id).status, 'resolved', 'the pass before the disposition does not resolve it');
    assert.deepEqual(missingFor(unresolved, label.id), [], 'and no missing verification is named for it');
    // A pass registered after the disposition, evidence intact: resolved through its named check.
    const late = await markerPass(fx, p.id);
    assert.ok(late.result.execution_seq > findingRow(fx.home, label.id).disposition_seq, 'the fixture is live: this pass was registered after the disposition');
    await androidGate(fx, p.id, late.candidate);
    const resolved = findingRow(fx.home, label.id);
    assert.equal(resolved.status, 'resolved', `a pass of ${MARKER} after the fix disposition resolves it (${JSON.stringify({ status: resolved.status })})`);
    assert.ok(JSON.stringify(resolved.resolution_verification ?? null).includes(late.result.id), `resolved by that pass (${JSON.stringify(resolved.resolution_verification)})`);
    // (h)'s unmapped finding, accepted, stays as it was through the same pass.
    if (J.f4) assertAcceptedUnresolved(fx, p.id, J.f4.unmapped.id, '(h)\'s unmapped finding after the pass that resolved this one');
  });

  test('(j) F4: the Designer\'s review file proposing R3.2 and its covering check: the file passes its check; the owner\'s edit leaving the verdict\'s deltas untouched keeps the proposed link, judged again, and the finding names it; one proposing a check that does not cover its criterion: the close refused, nothing recorded or filed', async () => {
    const { fx, p, ctx } = J;
    const other = effectiveChecks(fx.home, p.id).find((c) => c.key !== MARKER && !c.criteria.includes('R3.2') && c.criteria.length > 0);
    const candidate = liveCandidate(fx.home, p.id);
    const screen = (delta) => ({ target: 'android', key: S2, verdict: 'deltas', observed_on: 'device', evidence: [], deltas: [delta] });
    let build = 'pantry-android 0.1.5 (build 12)';
    const findingsBefore = findingsOf(fx.home, p.id).length;
    const r = await ownerReviewOf(fx, p.id, { build, candidate: candidate.id, turns: [{ files: { [REVIEW_FILE(6)]: reviewJson({ design_version: 2, subject: subjectOf(build, candidate.id), screens: [screen({ owner_words: PROPOSED, kind: 'implementation', criterion: 'R3.2', check: MARKER })] }) }, say: 'The rows are silent to the screen reader: that is R3.2.', done: true }] });
    assert.equal(r.out.saves[0]?.body?.design_check?.outcome, 'passed', `a delta proposing a criterion and its covering check passes the review file's check (B.14) (${JSON.stringify(r.out.saves[0]?.body?.design_check)})`);
    assert.equal(r.out.close.status, 200, `the close (${r.out.close.text?.slice(0, 300)})`);
    const proposedDelta = verdictOf(reviewRow(fx.home, r.review), 'android', S2)?.deltas?.[0];
    assert.deepEqual([proposedDelta?.criterion, proposedDelta?.check], ['R3.2', MARKER], `recorded as proposed (${JSON.stringify(proposedDelta)})`);
    assert.equal(findingsOf(fx.home, p.id).length, findingsBefore, 'nothing filed before the owner confirms');
    const verdicts = await pump(fx, ctx, () => openVerdicts(fx.home, p.id, r.review) ?? undefined, { what: 'design_verdicts', max: 10 });
    // The owner edits the verdict's observed_on only: its deltas untouched, the proposed link kept and judged again.
    const res = await confirmWith(fx, p.id, verdicts, { edits: [{ target: 'android', screen: S2, observed_on: 'emulator' }] });
    assert.equal(res.status, 200, `confirmed with an edit leaving the deltas untouched (${res.text})`);
    const confirmed = verdictOf(reviewRow(fx.home, r.review), 'android', S2);
    assert.equal(confirmed?.observed_on, 'emulator', `the edit applied (${JSON.stringify(confirmed)})`);
    assert.deepEqual([confirmed?.deltas?.[0]?.criterion, confirmed?.deltas?.[0]?.check], ['R3.2', MARKER], `the proposed link kept on the confirmed delta (${JSON.stringify(confirmed?.deltas)})`);
    const [found] = findingBy(fx.home, p.id, PROPOSED);
    assert.ok(found, 'the confirmed delta filed');
    assert.deepEqual([found.criterion, found.check], ['R3.2', MARKER], `the finding names what the owner confirmed of the Designer's proposal (${JSON.stringify({ criterion: found.criterion, check: found.check })})`);
    const question = await pump(fx, ctx, () => openDisposition(fx.home, found.id), { what: 'the disposition owed on the proposed-link finding', max: 10 });
    assert.ok(optionKeysOf(question).includes('fix'), `fix offered (${JSON.stringify(optionKeysOf(question))})`);
    assertVerifiable(question.manifest?.verification, { criterion: 'R3.2', check: MARKER }, 'the preview\'s manifest.verification');
    // A proposal whose check does not cover its criterion: refused at the close.
    build = 'pantry-android 0.1.6 (build 13)';
    const reviewsBefore = reviewsCount(fx.home, p.id);
    const findingsMid = findingsOf(fx.home, p.id).length;
    const bad = await ownerReviewOf(fx, p.id, { build, candidate: candidate.id, turns: [{ files: { [REVIEW_FILE(7)]: reviewJson({ design_version: 2, subject: subjectOf(build, candidate.id), screens: [screen({ owner_words: UNCOVERED, kind: 'implementation', criterion: 'R3.2', check: other.key })] }) }, say: 'The list never says how many items it holds.', done: true }] });
    assert.equal(bad.out.close.status, 422, `a delta naming ${other.key}, which does not cover R3.2: the close refused (${bad.out.close.status} ${bad.out.close.text?.slice(0, 300)})`);
    assert.equal(bad.out.close.body?.code, 'design_check_failed', `refused as an invalid review file is (${bad.out.close.text?.slice(0, 300)})`);
    const recorded = reviewRow(fx.home, bad.review);
    assert.ok(!recorded || (recorded.verdicts ?? []).length === 0, `no verdict recorded from it (${JSON.stringify(recorded?.verdicts)})`);
    assert.equal(reviewsCount(fx.home, p.id, true), reviewsBefore.withVerdicts, 'no review recorded with verdicts');
    assert.equal(openVerdicts(fx.home, p.id, bad.review), null, 'no design_verdicts asked');
    assert.equal(findingsOf(fx.home, p.id).length, findingsMid, 'nothing filed');
  });

  const REMOVED = 'The rows flicker when the list scrolls.';
  const CRITERION_ONLY = 'The rows read their label twice to the screen reader.';
  const STALE = 'The rows lose their label after a refresh.';

  test('(k) F4: the owner\'s edit removing the link the Designer proposed files a finding with none; his edit naming a criterion without a check files it with the criterion only; each missing, no fix, accepted and unresolved, no work registered', async () => {
    const { fx, p, ctx } = J;
    const candidate = liveCandidate(fx.home, p.id);
    const build = 'pantry-android 0.1.7 (build 14)';
    const screen = { target: 'android', key: S2, verdict: 'deltas', observed_on: 'device', evidence: [], deltas: [{ owner_words: REMOVED, kind: 'implementation', criterion: 'R3.2', check: MARKER }, { owner_words: CRITERION_ONLY, kind: 'implementation' }] };
    const r = await ownerReviewOf(fx, p.id, { build, candidate: candidate.id, turns: [{ files: { [REVIEW_FILE(8)]: reviewJson({ design_version: 2, subject: subjectOf(build, candidate.id), screens: [screen] }) }, say: 'Two more on the rows.', done: true }] });
    assert.equal(r.out.saves[0]?.body?.design_check?.outcome, 'passed', `the review file passes its check (${JSON.stringify(r.out.saves[0]?.body?.design_check)})`);
    assert.equal(r.out.close.status, 200, `the close (${r.out.close.text?.slice(0, 300)})`);
    const proposed = verdictOf(reviewRow(fx.home, r.review), 'android', S2)?.deltas ?? [];
    assert.deepEqual([proposed[0]?.criterion, proposed[0]?.check], ['R3.2', MARKER], `the fixture is live: the Designer proposed a valid link (${JSON.stringify(proposed)})`);
    const verdicts = await pump(fx, ctx, () => openVerdicts(fx.home, p.id, r.review) ?? undefined, { what: 'design_verdicts', max: 10 });
    const findingsBefore = findingsOf(fx.home, p.id).length;
    // The owner's edit supplies the verdict's deltas: the first without the proposed link, the second naming R3.2 only.
    const res = await confirmWith(fx, p.id, verdicts, { edits: [{ target: 'android', screen: S2, deltas: [{ owner_words: REMOVED, kind: 'implementation' }, { owner_words: CRITERION_ONLY, kind: 'implementation', criterion: 'R3.2' }] }] });
    assert.equal(res.status, 200, `confirmed as the owner edited it (${res.text})`);
    const kept = verdictOf(reviewRow(fx.home, r.review), 'android', S2)?.deltas ?? [];
    assert.deepEqual(kept.map((d) => [d.owner_words, d.criterion ?? null, d.check ?? null]), [[REMOVED, null, null], [CRITERION_ONLY, 'R3.2', null]], `the confirmed deltas carry exactly what the owner's edit names (${JSON.stringify(kept)})`);
    const filed = findingsOf(fx.home, p.id).slice(findingsBefore);
    assert.equal(filed.length, 2, `two findings (${JSON.stringify(filed.map((f) => f.message))})`);
    const [removed] = findingBy(fx.home, p.id, REMOVED);
    const [criterionOnly] = findingBy(fx.home, p.id, CRITERION_ONLY);
    assert.deepEqual([removed.criterion, removed.check], [null, null], `the link the owner removed is absent: no criterion, no check (${JSON.stringify({ criterion: removed.criterion, check: removed.check })})`);
    assert.deepEqual([criterionOnly.criterion, criterionOnly.check], ['R3.2', null], `the criterion the owner named, and no check: none inferred from ${MARKER}, which covers R3.2 (${JSON.stringify({ criterion: criterionOnly.criterion, check: criterionOnly.check })})`);
    for (const [what, f, links] of [['the finding whose link was removed', removed, { criterion: null, check: null }], ['the finding naming a criterion without a check', criterionOnly, { criterion: 'R3.2', check: null }]]) {
      const q = await pump(fx, ctx, () => openDisposition(fx.home, f.id), { what: `the disposition owed on ${what}`, max: 10 });
      await assertNoFix(fx, p.id, q, links, what);
      assertMissing((await verificationRead(fx, p.id, r.review))(f.id), links, `${what}: the reviews read's finding_verification`);
      await consume(fx, p.id, openDisposition(fx.home, f.id), 'accept');
      assertAcceptedUnresolved(fx, p.id, f.id, `${what}, accepted`);
    }
    // A pass of the check covering R3.2, registered after both dispositions, changes neither.
    const later = await markerPass(fx, p.id);
    assert.ok(later.result.execution_seq > findingRow(fx.home, criterionOnly.id).disposition_seq, 'the fixture is live: the pass was registered after the dispositions');
    await androidGate(fx, p.id, later.candidate);
    assertAcceptedUnresolved(fx, p.id, removed.id, `the removed-link finding after ${MARKER}'s later pass`);
    assertAcceptedUnresolved(fx, p.id, criterionOnly.id, `the criterion-only finding after ${MARKER}'s later pass`);
  });

  test('(l) F4: a proposed link valid when the review was recorded, made stale before the confirmation by a protected-version change (the check moved off the criterion through a check_correction run and its approved proposal): the plain confirm and an edit leaving the deltas untouched refused naming the field, nothing consumed, confirmed or filed; the owner\'s edit dropping the link confirms', async () => {
    const { fx, p, ctx } = J;
    const candidate = liveCandidate(fx.home, p.id);
    const build = 'pantry-android 0.1.8 (build 15)';
    const screen = { target: 'android', key: S2, verdict: 'deltas', observed_on: 'device', evidence: [], deltas: [{ owner_words: STALE, kind: 'implementation', criterion: 'R3.2', check: MARKER }] };
    const r = await ownerReviewOf(fx, p.id, { build, candidate: candidate.id, turns: [{ files: { [REVIEW_FILE(9)]: reviewJson({ design_version: 2, subject: subjectOf(build, candidate.id), screens: [screen] }) }, say: 'The label goes after a refresh: R3.2.', done: true }] });
    assert.equal(r.out.saves[0]?.body?.design_check?.outcome, 'passed', `valid when recorded: the review file passes its check (${JSON.stringify(r.out.saves[0]?.body?.design_check)})`);
    assert.equal(r.out.close.status, 200, `the close (${r.out.close.text?.slice(0, 300)})`);
    await pump(fx, ctx, () => openVerdicts(fx.home, p.id, r.review) ?? undefined, { what: 'design_verdicts', max: 10 });
    // The staleness, through the engine's own routes: check_correction work whose run moves marker-android's
    // declared coverage from R3.2 to R3.1, its proposal approved by the owner's answer and applied.
    const versionsBefore = protectedVersions(fx.home, p.id).length;
    fx.scripted.kindScript('check_correction', roleThat(
      [step.write(`.surety/checks/defs/${MARKER}.json`, definitionText(MARKER, { inputs: ['.surety/checks/wrapper.mjs', `.surety/checks/tests/${MARKER}.test.mjs`], kind: 'acceptance', command: ['node', '.surety/checks/wrapper.mjs', `.surety/checks/tests/${MARKER}.test.mjs`], timeout_s: 120, gate_kinds: ['stage', 'alpha_authorize'], covers: { criteria: ['R3.1'] } }))],
      { proposal: { rationale: 'marker-android is moved to R3.1.', requested_change_kind: 'loosening' } },
    ));
    await addWork(fx.engine, p.id, 'check_correction');
    await pump(fx, ctx, () => protectedVersions(fx.home, p.id).slice(versionsBefore).find((v) => v.authorized === 1 && v.effective_from !== null), { what: 'the correction applied and effective', max: 40 });
    const moved = effectiveChecks(fx.home, p.id).find((c) => c.key === MARKER);
    assert.ok(moved && !moved.criteria.includes('R3.2'), `the fixture is live: ${MARKER} in the effective version no longer covers R3.2 (${JSON.stringify(moved)})`);
    const findingsBefore = findingsOf(fx.home, p.id).length;
    for (const [what, extra] of [['the plain confirm', {}], ['an edit leaving the deltas untouched', { edits: [{ target: 'android', screen: S2, observed_on: 'emulator' }] }]]) {
      const verdicts = await pump(fx, ctx, () => openVerdicts(fx.home, p.id, r.review) ?? undefined, { what: 'design_verdicts', max: 10 });
      const res = await confirmWith(fx, p.id, verdicts, extra);
      assert.equal(res.status, 422, `${what}: the stale link refused before the confirmation takes effect (${res.status} ${res.text})`);
      assert.equal(res.body?.code, 'invalid_value', `${what}: an invalid answer (${res.text})`);
      assert.match(String(res.body?.subject?.field ?? ''), /screens\[0\]\.deltas\[0\]\.check$/, `${what}: naming the field of the review file (${JSON.stringify(res.body?.subject)})`);
      assert.equal(decision(fx.home, verdicts.id).status, 'open', `${what}: nothing consumed`);
      assert.equal(reviewRow(fx.home, r.review).confirmed_by ?? null, null, `${what}: nothing confirmed`);
      assert.equal(findingsOf(fx.home, p.id).length, findingsBefore, `${what}: nothing filed`);
    }
    // The owner corrects the link through the confirmation edit, before confirming.
    const verdicts = await pump(fx, ctx, () => openVerdicts(fx.home, p.id, r.review) ?? undefined, { what: 'design_verdicts', max: 10 });
    const res = await confirmWith(fx, p.id, verdicts, { edits: [{ target: 'android', screen: S2, deltas: [{ owner_words: STALE, kind: 'implementation' }] }] });
    assert.equal(res.status, 200, `the owner's edit dropping the stale link confirms (${res.text})`);
    const [stale] = findingBy(fx.home, p.id, STALE);
    assert.deepEqual([stale?.criterion, stale?.check], [null, null], `filed with exactly the confirmed links: none (${JSON.stringify(stale)})`);
  });
});

// The project's protected versions, oldest first.
function protectedVersions(home, project) {
  return rows(home, 'SELECT * FROM "protected_versions" WHERE "project" = ? ORDER BY rowid', project);
}

// The project's reviews, and those holding verdicts.
function reviewsCount(home, project, withVerdictsOnly = false) {
  const all = rows(home, 'SELECT "verdicts" FROM "design_reviews" WHERE "project" = ?', project);
  const withVerdicts = all.filter((r) => (JSON.parse(r.verdicts ?? '[]') ?? []).length > 0).length;
  return withVerdictsOnly ? withVerdicts : { all: all.length, withVerdicts };
}
