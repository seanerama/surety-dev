// M52, the `finding_applicability_exclusion` manifest (slice 5). Plan §3.5
// M52; RN R4; build spec §6 corrections 5 and 22; E19; Review B18; D1 §§3.4,
// 9.3(5); SEAM.md §§74, 76, 77.
//
// An unresolved finding applies to every successor candidate until an
// approved assessment excludes one. The Verifier proposes, an independent
// Reviewer assesses, and if the finding would block any gate for that
// candidate the human owner must authorize the exclusion. So an agent's
// proposal and an agent's assessment, together, remove nothing. The human's
// approval binds the exact assessment, finding and candidate: it excludes
// the finding for that candidate and for no other, and it cannot be given
// on a preview taken before the finding changed.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { approvalsOf, assertQuestionClosed, assertStaleAnswer, consume, decision, decisionsOn, nextGeneration, openDecision, reject } from './harness/decisions.mjs';
import { acceptedRun, alphaTarget, assessmentsOf, check, finding, findingState, installChecks, nominated, passAll, raiseFindings, reasonCodes, reasonSubjects, review, successor } from './harness/gates.mjs';
import { candidatesOf, eventsOfType, lineagesOf } from './harness/journal.mjs';
import { recordRow, registerDetector, waitForPostScan } from './harness/records.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';

// A High finding raised on candidate 1; candidate 2, its successor, with its
// check passed; the Verifier's proposal that the finding does not apply to
// candidate 2; an independent Reviewer's assessment that agrees; and the
// decision the engine raised for the human owner.
async function assessedExclusion(t) {
  const fx = await scriptedEngine(t);
  const ctx = await nominated(fx);
  const project = ctx.project.id;
  const c1 = ctx.candidate;
  const k = (await installChecks(fx.engine, project, [check('login', { requirements: ['R1'] })])).id;
  const [found] = await raiseFindings(fx, project, c1.id, [{ category: 'defect', severity: 'high', message: 'totals are wrong for refunded orders' }]);
  const c2 = await successor(fx, ctx);
  await passAll(fx.engine, project, c2.id, [k.login]);
  const alpha = await alphaTarget(fx, ctx, c2);
  await acceptedRun(fx, project, 'verification', {
    subject: { candidate: c2.id },
    result: { applicability: [{ finding: found.id, candidate: c2.id, reason: 'the refund path was removed', evidence: 'no caller of refund() remains in candidate 2' }] },
  });
  const [proposed] = assessmentsOf(fx.home, project);
  await review(fx, project, c2.id, { assessments: [{ assessment: proposed.id, verdict: 'not_applicable' }] });
  const [assessment] = assessmentsOf(fx.home, project);
  const previewed = await openDecision(fx, project, 'finding_applicability_exclusion', assessment.id);
  return { fx, ctx, project, k, c1, c2, found, alpha, assessment, previewed };
}

const blockedBy = (evaluation, found) => {
  assert.deepEqual(reasonCodes(evaluation), ['FINDING_BLOCKING']);
  assert.deepEqual(reasonSubjects(evaluation, 'FINDING_BLOCKING'), [found.id]);
};

describe('M52 the finding_applicability_exclusion manifest', () => {
  test("proposed and assessed, the exclusion removes nothing; the human owner's approval excludes the finding for the assessed candidate and for no other", async (t) => {
    const { fx, ctx, project, k, c1, c2, found, alpha, assessment, previewed } = await assessedExclusion(t);
    assert.deepEqual([assessment.status, assessment.proposed_by_run !== assessment.assessed_by_run], ['assessed', true], 'the fixture is live: assessed, by a run that is not the proposing one');
    assert.deepEqual(
      {
        subject: [previewed.subject_type, previewed.subject_id],
        status: previewed.manifest.assessment_status,
        finding: previewed.manifest.finding,
        candidate: previewed.manifest.candidate,
        proposer: previewed.manifest.proposed_by_run,
        assessor: previewed.manifest.assessed_by_run,
        severity: previewed.manifest.effective_severity,
        blocks: previewed.manifest.blocks_gate,
      },
      { subject: ['applicability_assessment', assessment.id], status: 'assessed', finding: found.id, candidate: c2.id, proposer: assessment.proposed_by_run, assessor: assessment.assessed_by_run, severity: 'high', blocks: true },
      'the preview binds the exact assessment, finding and candidate, who proposed and who assessed, and that the finding blocks a gate',
    );
    blockedBy(await alpha.evaluate(), found);

    await consume(fx, project, previewed, 'approve');
    const [approved] = assessmentsOf(fx.home, project);
    assert.equal(approved.status, 'approved');
    assert.ok(approved.authorized_by, 'the assessment records who authorized it');
    assert.deepEqual(approvalsOf(fx.home, previewed.id).map((row) => [row.subject_type, row.subject_id]), [['applicability_assessment', assessment.id]], 'the approval is of that assessment');
    assert.equal((await alpha.evaluate()).outcome, 'satisfied', 'candidate 2 is no longer blocked by the finding');

    // The finding is what it was, and candidate 1 is still blocked by it.
    assert.deepEqual([finding(fx.home, found.id).status, finding(fx.home, found.id).effective_severity], ['open', 'high'], 'an exclusion changes no severity and resolves nothing');
    await passAll(fx.engine, project, c1.id, [k.login]);
    blockedBy(await (await alphaTarget(fx, ctx, c1, { environment: alpha.environment })).evaluate(), found);
  });

  test('the finding is raised to Critical between preview and answer: the approval is refused, nothing is excluded, and the next generation binds the finding as it now is', async (t) => {
    const { fx, project, c2, found, alpha, previewed } = await assessedExclusion(t);
    await review(fx, project, c2.id, { severity_changes: [{ finding: found.id, to: 'critical' }] });

    await assertStaleAnswer(fx, project, previewed, 'approve');
    assert.equal(assessmentsOf(fx.home, project)[0].status, 'assessed', 'the assessment is not approved');
    blockedBy(await alpha.evaluate(), found);
    const next = await nextGeneration(fx, project, previewed, { changed: 'effective_severity' });
    assert.equal(next.manifest.effective_severity, 'critical');
  });

  // M2 slice 1, A4 (SEAM.md §102).
  test('reject: the assessment is rejected and authorizes nobody, the finding is as it was and still blocks the candidate, the decision is closed with the answer recorded, and the question is not raised again', async (t) => {
    const { fx, project, found, alpha, assessment, previewed } = await assessedExclusion(t);
    const before = findingState(finding(fx.home, found.id));
    assert.deepEqual(previewed.options.map((option) => option.key).sort(), ['approve', 'reject'], 'the fixture is live: the exclusion offers reject');

    await reject(fx, project, previewed);
    const [rejected] = assessmentsOf(fx.home, project);
    assert.deepEqual([rejected.id, rejected.status, rejected.authorized_by], [assessment.id, 'rejected', null], 'the assessment is in the rejected state D1 names, and nobody authorized it');
    assert.equal(eventsOfType(fx.home, 'assessment.rejected').filter((event) => event.subject?.assessment === assessment.id).length, 1, 'one assessment.rejected names it');
    assert.deepEqual(findingState(finding(fx.home, found.id)), before, 'the finding is as it was: open and High');
    blockedBy(await alpha.evaluate(), found);
    await assertQuestionClosed(fx, project, previewed);
    assert.deepEqual([assessmentsOf(fx.home, project).map((row) => row.status), findingState(finding(fx.home, found.id))], [['rejected'], before], 'and the ticks changed nothing of either');
  });

  // M2 slice 2, B1 (SEAM.md §105): the exclusion's evidence.
  test("the exclusion's evidence is quarantined between preview and answer (a detector registered later matches it): the old preview is stale, nothing is excluded, and the next generation binds the evidence as it now is", async (t) => {
    const { fx, project, found, alpha, assessment, previewed } = await assessedExclusion(t);
    const record = recordRow(fx.home, assessment.evidence);
    assert.deepEqual([record?.kind, record?.post_scan], ['assessment_evidence', 'clean'], "the fixture is live: the Verifier's evidence is a published record, scanned clean");
    assert.deepEqual([previewed.manifest.evidence?.record, previewed.manifest.evidence?.quarantined], [assessment.evidence, false], 'the preview binds the evidence record and that it is not quarantined');

    // A detector registered later matches the evidence (SEAM.md §57): the
    // record the exclusion rests on is quarantined.
    await registerDetector(fx.engine, 'refund-call', 'refund\\(\\)');
    await waitForPostScan(fx.home, assessment.evidence, 'hit');

    await assertStaleAnswer(fx, project, previewed, 'approve');
    assert.equal(assessmentsOf(fx.home, project)[0].status, 'assessed', 'the assessment is not approved');
    // The finding still blocks the candidate (the hit also raises the Critical
    // findings of D1 §14.2 about the records it matched, which are not pinned here).
    assert.ok(reasonSubjects(await alpha.evaluate(), 'FINDING_BLOCKING').includes(found.id), 'the finding still blocks the candidate: nothing was excluded');
    const next = await nextGeneration(fx, project, previewed, { changed: 'evidence' });
    assert.deepEqual([next.manifest.evidence?.record, next.manifest.evidence?.quarantined], [assessment.evidence, true], 'the next preview shows the evidence as quarantined');
  });

  // M2 slice 2, B1 (SEAM.md §105): the candidate's ancestry.
  test("the assessed candidate's ancestry changes between preview and answer: the old preview is stale, nothing is excluded, and any question still open about the assessment binds the ancestry as it now is", async (t) => {
    const { fx, project, c1, c2, found, assessment, previewed } = await assessedExclusion(t);
    const lineageOf = (candidate) => lineagesOf(fx.home, project).find((row) => row.id === candidatesOf(fx.home, project).find((c) => c.id === candidate.id).lineage);
    assert.equal(lineageOf(c2).started_from_candidate, c1.id, 'the fixture is live: candidate 2 descends from candidate 1, the candidate the finding was raised on');
    assert.ok('ancestry' in previewed.manifest, 'the preview binds the ancestry');

    // No engine path rewrites a lineage in M1; the store does, with the
    // engine stopped (SEAM.md §65): candidate 2 no longer descends from the
    // finding's candidate, so the exclusion that was previewed is about
    // another situation.
    await fx.engine.stop();
    withStore(fx.home, (db) => db.prepare('UPDATE "lineages" SET "started_from_candidate" = NULL WHERE "id" = ?').run(lineageOf(c2).id), { readonly: false });
    await fx.start();
    assert.equal(lineageOf(c2).started_from_candidate, null, 'the fixture is live: the lineage no longer names candidate 1');

    await assertStaleAnswer(fx, project, previewed, 'approve');
    assert.deepEqual([assessmentsOf(fx.home, project)[0].status, assessmentsOf(fx.home, project)[0].authorized_by], ['assessed', null], 'the assessment is not approved, by nobody');
    assert.deepEqual([finding(fx.home, found.id).status, finding(fx.home, found.id).effective_severity], ['open', 'high'], 'the finding is as it was');

    // Whether the question still stands is not pinned: an exclusion of a
    // finding that no longer applies may be withdrawn, or asked again about
    // what is there now. Either way the earlier preview is closed and no
    // open question carries it.
    for (let i = 0; i < 3; i++) await tick(fx.engine, project);
    assert.notEqual(decision(fx.home, previewed.id).status, 'open', 'the earlier question is closed');
    const open = decisionsOn(fx.home, 'finding_applicability_exclusion', assessment.id).filter((row) => row.status === 'open');
    assert.ok(open.length <= 1, `at most one exclusion question about the assessment is open (found ${open.length})`);
    if (open.length === 1) {
      assert.notEqual(open[0].preview_hash, previewed.preview_hash, 'an open question is another preview');
      assert.notDeepEqual(open[0].manifest.ancestry, previewed.manifest.ancestry, 'whose ancestry is the one there now');
      assert.equal(approvalsOf(fx.home, open[0].id).length, 0, 'with no approval carried over');
    }
  });
});
