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

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CODES, answer, assertStaleAnswer, consume, decision, decisionsOn, intentsOf, nextGeneration, openDecision, reject, untilKilled } from './harness/decisions.mjs';
import { alphaTarget, check, checkResult, finding, installChecks, nominated, passAll, postResult, raiseFindings, reasonSubjects, review, roleRun, successor } from './harness/gates.mjs';
import { changePolicy } from './harness/journal.mjs';
import { permittedEdit } from './harness/gitruns.mjs';
import { armBarrier } from './harness/journal.mjs';
import { readRun } from './harness/reads.mjs';
import { readRecord, recordRow, recordsOf } from './harness/records.mjs';
import { fileAt } from './harness/repos.mjs';
import { scriptedEngine, tickUntil } from './harness/runs.mjs';
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
async function reviewed(t) {
  const fx = await scriptedEngine(t);
  const ctx = await nominated(fx);
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

  test('(e) a change to what the manifest binds: the acceptance content before the answer, the finding\'s status before the answer, and the sensitive area between the answer and the effect; each stales it with no write', async (t) => {
    const { fx, ctx, project, high, proposal, propose } = await reviewed(t);
    await propose([proposal(high.id)]);
    const first = await openDecision(fx, project, KIND, high.id);

    // 1. The candidate's acceptance content changes: another check covers R1.
    await installChecks(fx.engine, project, [check('export', { requirements: ['R1'] })]);
    await assertStaleAnswer(fx, project, first, OPTION);
    assert.equal(exceptionOf(fx, high.id), null, 'nothing was written on the earlier preview');
    const second = await nextGeneration(fx, project, first, { changed: 'acceptance_content_hash' });
    assert.deepEqual([second.manifest.proposed_disposition, second.manifest.finding_status], [OPTION, 'open'], 'the next generation asks the same exception');

    // 2. The finding's status changes: a Reviewer dispositions it fix (E43).
    await review(fx, project, ctx.candidate.id, { dispositions: [{ finding: high.id, disposition: 'fix' }] });
    assert.equal(finding(fx.home, high.id).status, 'dispositioned', 'the fixture is live: the finding changed');
    await assertStaleAnswer(fx, project, second, OPTION);
    assert.equal(exceptionOf(fx, high.id), null);
    const third = await nextGeneration(fx, project, second, { changed: 'finding_status' });
    assert.equal(third.manifest.finding_status, 'dispositioned');

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
});
