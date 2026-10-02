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

import { approvalsOf, assertStaleAnswer, consume, nextGeneration, openDecision } from './harness/decisions.mjs';
import { acceptedRun, alphaTarget, assessmentsOf, check, finding, installChecks, nominated, passAll, raiseFindings, reasonCodes, reasonSubjects, review, successor } from './harness/gates.mjs';
import { scriptedEngine } from './harness/runs.mjs';

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
});
