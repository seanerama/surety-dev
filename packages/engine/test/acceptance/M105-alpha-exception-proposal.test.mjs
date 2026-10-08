// M105, the Alpha exception proposal (M2 slice 10, kernel lane). M2 plan
// §3.1 M105; D2 §5 C1 (D2-C01); E36 item 5; D1 §§3.4, 9.3, 10.5; spec R14;
// SEAM.md §§74, 76, 77, 119.
//
// A Reviewer's result may propose an Alpha exception for a High finding
// that has no sensitive area and is open against the candidate it
// reviewed. The engine resolves every reference the argument makes, to a
// workspace path at the reviewed revision or to a record, into retained
// content, publishes it as a `containment_evidence` record with provenance
// `claimed`, and raises `finding_disposition` with the option
// `alpha_exception`, whose manifest binds the finding's status, severity and
// sensitive area and the candidate with its acceptance content hash. Only
// the human consumes it; its effect writes `findings.alpha_exception` bound
// to that hash, after which the Alpha gate no longer blocks on the finding
// while a non-passed check still blocks. A proposal for any other finding
// is refused before anything is raised, and the run read says so; the
// field from a Builder or a Verifier makes the result invalid; a change to
// what the manifest binds, before the answer or between the answer and the
// effect, stales it with no write; a rejection leaves the finding blocking.
//
// Every case here is expected to fail on the engine these tests were
// written against, which knows no such result field (COVERAGE.md, "M2
// slice 10").
//
// The last case is the slice-10 review's S1 (E31: one Verifier case, one
// Builder fix): the exception bound content the Reviewer never reviewed.
// The manifest's hash is the content in force when the Reviewer's run was
// started (as a sign-off's, SEAM.md §70); a proposal made against content
// that has since changed is refused `content_changed`; an open decision
// whose content changes is withdrawn, not asked again on content nobody
// reviewed; a granted exception lifts the block only while the content is
// the one it was granted on (SEAM.md §119). Case (e)'s first step is
// changed with it: after the content change the question is withdrawn.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CODES, answer, assertStaleAnswer, consume, decision, decisionsOn, intentsOf, nextGeneration, openDecision, reject, untilKilled } from './harness/decisions.mjs';
import { alphaTarget, check, checkResult, finding, installChecks, nominated, passAll, postResult, raiseFindings, reasonSubjects, review, roleRun, scopeOf, stageGate, successor } from './harness/gates.mjs';
import { changePolicy } from './harness/journal.mjs';
import { permittedEdit, roleThatHolds, runToHold } from './harness/gitruns.mjs';
import { armBarrier } from './harness/journal.mjs';
import { readRun } from './harness/reads.mjs';
import { readRecord, recordRow, recordsOf } from './harness/records.mjs';
import { fileAt } from './harness/repos.mjs';
import { addWork, scriptedEngine, tick, tickUntil, waitForRunState } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';

const KIND = 'finding_disposition';
const OPTION = 'alpha_exception';
const CHECK_OUTPUT = 'login check: 200 OK, the importer rejected nothing\n';
const ARGUMENT = 'The alpha target reads the fixture database only; src/app.js never reaches a production record.';
const PURPOSE = 'Exercise the import path with real-shaped data before the fix lands.';

// A T1 candidate with one check passed (with output) and one failed, and
// the findings a Verifier raised on it: a High with no sensitive area, a
// Medium, a High in a sensitive area; and a successor candidate with a High
// finding of its own. Returns everything a proposal needs to name.
// The failure is recorded while the stage's work is verifying on candidate
// 1, so under Q2 (D3 §2.10; E90 item 2) it would send the stage back to its
// Builder; this row is not about that repair, so at repair_attempts_max 0 the
// work is parked instead (objection 030).
async function reviewed(t) {
  const fx = await scriptedEngine(t);
  const ctx = await nominated(fx, { policy: { repair_attempts_max: 0 } });
  const project = ctx.project.id;
  const k = (await installChecks(fx.engine, project, [check('login', { requirements: ['R1'] }), check('import', { requirements: ['R1'] })])).id;
  const [login] = await passAll(fx.engine, project, ctx.candidate.id, [k.login], { output: CHECK_OUTPUT });
  await postResult(fx.engine, project, { candidate: ctx.candidate.id, check: k.import, exit_status: 1 });
  const outputRecord = checkResult(fx.home, login.id).output;
  assert.ok(outputRecord, 'the fixture is live: the passing execution has an output record');
  const [high, medium, sensitive] = await raiseFindings(
    fx,
    project,
    ctx.candidate.id,
    [
      { category: 'defect', severity: 'high', message: 'the importer rejects files over 1 MB' },
      { category: 'defect', severity: 'medium', message: 'the export omits the header row' },
      { category: 'defect', severity: 'high', message: 'a reset link stays valid after use', sensitive_area: 'authentication' },
    ],
    { kind: 'verification' },
  );
  const other = await successor(fx, ctx);
  const [elsewhere] = await raiseFindings(fx, project, other.id, [{ category: 'defect', severity: 'high', message: 'the successor double-counts refunds' }], { kind: 'verification' });
  const proposal = (findingId, extra = {}) => ({ finding: findingId, containment_text: ARGUMENT, references: [{ path: 'src/app.js' }, { record: outputRecord }], testing_purpose: PURPOSE, ...extra });
  const propose = (proposals) => review(fx, project, ctx.candidate.id, { alpha_exception_proposals: proposals });
  return { fx, ctx, project, k, high, medium, sensitive, elsewhere, other, outputRecord, proposal, propose };
}

const exceptionOf = (fx, findingId) => JSON.parse(finding(fx.home, findingId).alpha_exception ?? 'null');

// The candidate's acceptance content hash as the stage gate computes it now (SEAM.md §70).
const contentNow = async (fx, ctx) => scopeOf(fx.home, await stageGate(fx, ctx)).acceptance_content_hash;

// The question an open decision asked no longer stands (SEAM.md §76, §119):
// within four ticks the decision is `invalidated`, and after three more no
// finding_disposition about the finding is open and none was raised anew.
async function assertWithdrawn(fx, project, previewed, findingId) {
  const count = decisionsOn(fx.home, KIND, findingId).length;
  await tickUntil(fx.engine, project, () => decision(fx.home, previewed.id).status === 'invalidated', { what: `the ${previewed.kind} decision to be invalidated` });
  for (let i = 0; i < 3; i++) await tick(fx.engine, project);
  const open = decisionsOn(fx.home, KIND, findingId).filter((row) => row.status === 'open');
  assert.deepEqual(open.map((row) => row.id), [], 'no exception is asked about on content the Reviewer did not review');
  assert.equal(decisionsOn(fx.home, KIND, findingId).length, count, 'no decision was raised in place of the withdrawn one');
}

describe('M105 the Alpha exception proposal', () => {
  test('(a) a High finding with no sensitive area, open against the reviewed candidate: claimed containment evidence with the referenced content retained, and a finding_disposition offering alpha_exception whose manifest binds the finding and the candidate; the run completes', async (t) => {
    const { fx, ctx, project, high, outputRecord, proposal, propose } = await reviewed(t);
    const { run } = await propose([proposal(high.id)]);
    assert.deepEqual([run.outcome, run.reason_class], ['completed', 'none']);

    const [record] = recordsOf(fx.home, project, 'containment_evidence');
    assert.ok(record, 'one containment_evidence record was published');
    assert.equal(record.published, 1, 'published');
    const served = await readRecord(fx.engine, project, record.id);
    assert.equal(served.status, 200, `the record is served (body: ${served.text.slice(0, 200)})`);
    const content = JSON.parse(served.text);
    assert.deepEqual({ finding: content.finding, candidate: content.candidate, revision: content.revision, argument: content.containment_text, purpose: content.testing_purpose }, { finding: high.id, candidate: ctx.candidate.id, revision: ctx.candidate.revision, argument: ARGUMENT, purpose: PURPOSE }, 'the record holds the argument, bound to the finding and the reviewed candidate');
    const byPath = content.references.find((reference) => reference.path === 'src/app.js');
    assert.equal(byPath?.content, fileAt(ctx.project.repo.path, ctx.candidate.revision, 'src/app.js'), 'the workspace reference is resolved to the file\'s content at the reviewed revision');
    const byRecord = content.references.find((reference) => reference.record === outputRecord);
    assert.deepEqual([byRecord?.content, byRecord?.sha256], [CHECK_OUTPUT, recordRow(fx.home, outputRecord).sha256], 'the record reference is resolved to the record\'s bytes and their hash');

    const previewed = await openDecision(fx, project, KIND, high.id);
    assert.deepEqual(previewed.options.map((option) => option.key).sort(), [OPTION, 'reject'], 'the decision offers the exception and its refusal');
    const m = previewed.manifest;
    assert.deepEqual(
      { proposed: m.proposed_disposition, status: m.finding_status, severity: m.effective_severity, sensitive: m.sensitive_area, candidate: m.candidate, evidence: m.evidence?.record },
      { proposed: OPTION, status: 'open', severity: 'high', sensitive: null, candidate: ctx.candidate.id, evidence: record.id },
      'the manifest binds the finding\'s status, severity and sensitive area, the candidate and the evidence',
    );
    assert.ok(typeof m.acceptance_content_hash === 'string' && m.acceptance_content_hash.length > 0, 'and the candidate\'s acceptance content hash');
    assert.deepEqual(previewed.evidence, [{ record: record.id, provenance: 'claimed' }], 'the decision\'s evidence is that record, with provenance claimed (D1 §3.4)');
    assert.equal(exceptionOf(fx, high.id), null, 'nothing is written on the finding before the human answers');
  });

  test('(b) a Medium finding, a High one in a sensitive area, and one open against another candidate: no decision and no record; the run completes and the run read shows each refusal', async (t) => {
    const { fx, project, medium, sensitive, elsewhere, proposal, propose } = await reviewed(t);
    const { run } = await propose([proposal(medium.id), proposal(sensitive.id), proposal(elsewhere.id)]);
    assert.deepEqual([run.outcome, run.reason_class], ['completed', 'none']);
    for (const id of [medium.id, sensitive.id, elsewhere.id]) assert.deepEqual(decisionsOn(fx.home, KIND, id), [], `no finding_disposition was raised about ${id}`);
    assert.deepEqual(recordsOf(fx.home, project, 'containment_evidence'), [], 'no containment_evidence record was published');
    const shown = await readRun(fx.engine, project, run.id);
    const outcomes = Object.fromEntries((shown.alpha_exception_proposals ?? []).map((item) => [item.finding, [item.outcome, item.reason]]));
    assert.deepEqual(outcomes, { [medium.id]: ['refused', 'not_high'], [sensitive.id]: ['refused', 'sensitive_area'], [elsewhere.id]: ['refused', 'not_open_against_candidate'] }, 'the run read names each refused proposal and why');
  });

  test('(c) the field from a Builder and from a Verifier makes the result invalid', async (t) => {
    const { fx, ctx, project, high, proposal } = await reviewed(t);
    // A rejected run parks its work at once, so the second role can run.
    await changePolicy(fx.engine, project, { repair_attempts_max: 0 });
    const builder = await roleRun(fx, project, 'fix', { steps: [permittedEdit()], result: { alpha_exception_proposals: [proposal(high.id)] } });
    assert.deepEqual([builder.run.outcome, builder.run.reason_class], ['failed', 'invalid_result'], 'a Builder\'s result carrying the field is invalid');
    const verifier = await roleRun(fx, project, 'verification', { subject: { candidate: ctx.candidate.id }, result: { alpha_exception_proposals: [proposal(high.id)] } });
    assert.deepEqual([verifier.run.outcome, verifier.run.reason_class], ['failed', 'invalid_result'], 'a Verifier\'s result carrying the field is invalid');
    assert.deepEqual(decisionsOn(fx.home, KIND, high.id), [], 'neither raised a decision');
    assert.deepEqual(recordsOf(fx.home, project, 'containment_evidence'), [], 'and neither published evidence');
  });

  test('(d) the human approves: the exception is written on the finding, bound to the candidate\'s acceptance content hash; the Alpha gate no longer blocks on it, and a non-passed required check still blocks', async (t) => {
    const { fx, ctx, project, k, high, medium, sensitive, proposal, propose } = await reviewed(t);
    await propose([proposal(high.id)]);
    const previewed = await openDecision(fx, project, KIND, high.id);
    const before = await (await alphaTarget(fx, ctx)).evaluate();
    assert.ok(reasonSubjects(before, 'FINDING_BLOCKING').includes(high.id), 'the fixture is live: before the answer the High finding blocks Alpha');

    await consume(fx, project, previewed, OPTION);
    const intent = await tickUntil(fx.engine, project, () => intentsOf(fx.home, previewed.id).find((row) => row.status === 'done'), { what: 'the exception\'s effect to be done' });
    assert.equal(intent.invalidated_reason ?? null, null);
    const written = exceptionOf(fx, high.id);
    assert.deepEqual({ candidate: written?.candidate, hash: written?.acceptance_content_hash, decision: written?.decision }, { candidate: ctx.candidate.id, hash: previewed.manifest.acceptance_content_hash, decision: previewed.id }, 'the exception is written, bound to the candidate\'s acceptance content hash');

    const evaluation = await (await alphaTarget(fx, ctx)).evaluate();
    assert.equal(evaluation.outcome, 'not_satisfied');
    assert.ok(!reasonSubjects(evaluation, 'FINDING_BLOCKING').includes(high.id), `the High finding no longer blocks Alpha (blocking: ${reasonSubjects(evaluation, 'FINDING_BLOCKING').join(', ')})`);
    assert.ok(reasonSubjects(evaluation, 'FINDING_UNSATISFIED').includes(high.id), 'it still needs a disposition');
    assert.deepEqual([...reasonSubjects(evaluation, 'FINDING_BLOCKING')].sort(), [sensitive.id].sort(), 'the High one in a sensitive area still blocks');
    assert.ok(reasonSubjects(evaluation, 'FINDING_UNSATISFIED').includes(medium.id));
    assert.deepEqual(reasonSubjects(evaluation, 'CHECK_NOT_PASSED'), [k.import], 'the exception waives no check: the failed one still blocks');
    assert.equal(evaluation.check_states[k.import], 'failed');
  });

  test('(e) a change to what the manifest binds: the acceptance content before the answer (the question is withdrawn), the finding\'s status before the answer, and the sensitive area between the answer and the effect; each stales it with no write', async (t) => {
    const { fx, ctx, project, high, proposal, propose } = await reviewed(t);
    await propose([proposal(high.id)]);
    const first = await openDecision(fx, project, KIND, high.id);
    assert.equal(first.manifest.acceptance_content_hash, await contentNow(fx, ctx), 'the fixture is live: the preview binds the content the Reviewer reviewed, which is the content in force');

    // 1. The candidate's acceptance content changes: another check covers
    // R1. The earlier answer is stale, and the question is withdrawn rather
    // than asked again: nobody has reviewed the new content (the review's S1).
    await installChecks(fx.engine, project, [check('export', { requirements: ['R1'] })]);
    await assertStaleAnswer(fx, project, first, OPTION);
    assert.equal(exceptionOf(fx, high.id), null, 'nothing was written on the earlier preview');
    await assertWithdrawn(fx, project, first, high.id);
    assert.ok(reasonSubjects(await (await alphaTarget(fx, ctx)).evaluate(), 'FINDING_BLOCKING').includes(high.id), 'the finding blocks Alpha under the new content');
    // The Reviewer reviews the new content and proposes again: a new question, bound to it.
    await propose([proposal(high.id)]);
    const second = await openDecision(fx, project, KIND, high.id);
    assert.deepEqual([second.id !== first.id, second.manifest.acceptance_content_hash, second.manifest.proposed_disposition], [true, await contentNow(fx, ctx), OPTION], 'the new proposal is bound to the content now in force');

    // 2. The finding's status changes: a Reviewer dispositions it fix (E43).
    // The content is unchanged, so the question stands and is asked again.
    await review(fx, project, ctx.candidate.id, { dispositions: [{ finding: high.id, disposition: 'fix' }] });
    assert.equal(finding(fx.home, high.id).status, 'dispositioned', 'the fixture is live: the finding changed');
    await assertStaleAnswer(fx, project, second, OPTION);
    assert.equal(exceptionOf(fx, high.id), null);
    const third = await nextGeneration(fx, project, second, { changed: 'finding_status' });
    assert.deepEqual([third.manifest.finding_status, third.manifest.acceptance_content_hash], ['dispositioned', second.manifest.acceptance_content_hash]);

    // 3. After the answer and before the effect the finding turns out to be
    // in a sensitive area: the engine is killed at the intent, the store
    // changed, and the pending intent is revalidated on restart (SEAM.md §76).
    await armBarrier(fx.engine, 'intent.recorded', 'kill');
    answer(fx.engine, project, third, OPTION).catch(() => null);
    await untilKilled(fx, project);
    assert.equal(decision(fx.home, third.id).status, 'consumed', 'the answer was consumed before the kill');
    assert.equal(intentsOf(fx.home, third.id)[0]?.status, 'pending', 'its effect is pending');
    withStore(fx.home, (db) => db.prepare(`UPDATE "findings" SET "sensitive_area" = 'authentication' WHERE "id" = ?`).run(high.id), { readonly: false });
    await fx.start();
    const intent = await tickUntil(fx.engine, project, () => intentsOf(fx.home, third.id).find((row) => row.status !== 'pending' && row.status !== 'executing'), { what: 'the pending effect to be revalidated' });
    assert.deepEqual([intent.status, intent.invalidated_reason], ['invalidated', CODES.intent_invalidated], 'the effect is invalidated, not made');
    assert.equal(exceptionOf(fx, high.id), null, 'and nothing is written on the finding');
    assert.ok(reasonSubjects(await (await alphaTarget(fx, ctx)).evaluate(), 'FINDING_BLOCKING').includes(high.id), 'the finding still blocks Alpha');
  });

  test('(f) reject: nothing is written and the finding still blocks Alpha', async (t) => {
    const { fx, ctx, project, high, proposal, propose } = await reviewed(t);
    await propose([proposal(high.id)]);
    const previewed = await openDecision(fx, project, KIND, high.id);
    await reject(fx, project, previewed);
    assert.equal(exceptionOf(fx, high.id), null, 'no exception is recorded');
    const evaluation = await (await alphaTarget(fx, ctx)).evaluate();
    assert.ok(reasonSubjects(evaluation, 'FINDING_BLOCKING').includes(high.id), 'the finding still blocks Alpha');
    assert.equal(decision(fx.home, previewed.id).status, 'consumed');
  });

  // The slice-10 review's S1 (E31; SEAM.md §119 "What the Reviewer reviewed").
  test("S1: the acceptance content changes while the Reviewer's run is under way: the proposal is refused content_changed, nothing is raised and the finding still blocks; an exception granted on one content lifts no block under another", async (t) => {
    const { fx, ctx, project, high, proposal, propose } = await reviewed(t);
    const reviewedHash = await contentNow(fx, ctx);

    // A. The Reviewer's run is started on that content and held before it
    // reports; the content changes meanwhile (another check covers R1).
    const item = await addWork(fx.engine, project, 'review', { subject: { candidate: ctx.candidate.id } });
    fx.scripted.script(item, [roleThatHolds([], [], { alpha_exception_proposals: [proposal(high.id)] })]);
    const { run } = await runToHold(fx, project, item);
    await installChecks(fx.engine, project, [check('export', { requirements: ['R1'] })]);
    const current = await contentNow(fx, ctx);
    assert.notEqual(current, reviewedHash, 'the fixture is live: the acceptance content changed while the review was under way');
    fx.scripted.release(item);
    const ended = await waitForRunState(fx.home, run.id, 'ended', { timeoutMs: 60_000 });
    assert.deepEqual([ended.outcome, ended.reason_class], ['completed', 'none'], 'a refused proposal is not an invalid result: the run completes');
    assert.deepEqual(decisionsOn(fx.home, KIND, high.id), [], 'no finding_disposition was raised: the Reviewer reviewed content that is no longer in force');
    assert.deepEqual(recordsOf(fx.home, project, 'containment_evidence'), [], 'no containment evidence was published');
    const shown = await readRun(fx.engine, project, run.id);
    assert.deepEqual((shown.alpha_exception_proposals ?? []).map((entry) => [entry.finding, entry.outcome, entry.reason, entry.decision]), [[high.id, 'refused', 'content_changed', null]], 'the run read says why');
    assert.equal(exceptionOf(fx, high.id), null, 'nothing is written on the finding');
    assert.ok(reasonSubjects(await (await alphaTarget(fx, ctx)).evaluate(), 'FINDING_BLOCKING').includes(high.id), 'the finding still blocks Alpha under the content nobody reviewed');

    // B. The Reviewer reviews the content now in force and proposes again;
    // the human grants the exception; then the content changes once more.
    await propose([proposal(high.id)]);
    const previewed = await openDecision(fx, project, KIND, high.id);
    assert.equal(previewed.manifest.acceptance_content_hash, current, 'the fixture is live: the new proposal is bound to the content the Reviewer reviewed, now in force');
    await consume(fx, project, previewed, OPTION);
    await tickUntil(fx.engine, project, () => intentsOf(fx.home, previewed.id).find((row) => row.status === 'done'), { what: "the exception's effect to be done" });
    assert.equal(exceptionOf(fx, high.id)?.acceptance_content_hash, current, 'the exception is written, bound to the content it was granted on');
    assert.ok(!reasonSubjects(await (await alphaTarget(fx, ctx)).evaluate(), 'FINDING_BLOCKING').includes(high.id), 'under that content the finding no longer blocks Alpha');
    await installChecks(fx.engine, project, [check('report', { requirements: ['R1'] })]);
    assert.notEqual(await contentNow(fx, ctx), current, 'the fixture is live: the content changed again');
    assert.ok(reasonSubjects(await (await alphaTarget(fx, ctx)).evaluate(), 'FINDING_BLOCKING').includes(high.id), 'under content the Reviewer did not review the finding blocks Alpha again');
    assert.equal(exceptionOf(fx, high.id)?.acceptance_content_hash, current, 'the written exception is as it was, bound to the content it was granted on, and lifts nothing elsewhere');
  });
});
