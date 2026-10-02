// M42, findings, dispositions and inherited applicability (slice 5). Plan
// §3.4 M42; D1 §§3.4, 9.3(5), 9.4, 9.5, D1-24; F §§6.1, 6.2; E19; RN R4;
// Review B02; SEAM.md §74.
//
// The gate asks about every finding that is open or dispositioned and
// applies to the candidate: the candidate it was raised on and every
// successor on the lineage chain. A planned fix resolves nothing. A
// deferral holds only with authority that matches the finding's current
// severity, an unexpired target, and a re-evaluation by this very
// evaluation. A human's accept holds. A resolution whose verification is
// invalidated reopens the finding. An exclusion that is proposed and
// assessed, and not approved, excludes nothing.
//
// Findings, dispositions and assessments are reported by scripted Reviewer
// and Verifier runs, as agents would report them; the engine records them.
// Medium and Low findings are read at the stage gate; the High finding of
// the last case at the Alpha authorization gate, whose severity ladder F
// §6.1 gives.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { consume, openDecision } from './harness/decisions.mjs';
import {
  acceptedRun,
  alphaTarget,
  assessmentsOf,
  check,
  checkResult,
  finding,
  installChecks,
  nominated,
  passAll,
  postResult,
  raiseFindings,
  reasonCodes,
  reasonSubjects,
  review,
  stageGate,
  successor,
} from './harness/gates.mjs';
import { eventsOfType, outOfBand } from './harness/journal.mjs';
import { commitOnRef } from './harness/repos.mjs';
import { advanceClock, answerDecision, scriptedEngine, tick } from './harness/runs.mjs';

const DAY = 86_400;
const inDays = (n) => new Date(Date.now() + n * DAY * 1000).toISOString();
const defect = (severity, message, extra = {}) => ({ category: 'defect', severity, message, ...extra });

// A T1 candidate with one required check, passed: its stage gate is
// satisfied until a finding says otherwise.
async function clean(t, checks = [check('login', { requirements: ['R1'] })]) {
  const fx = await scriptedEngine(t);
  const ctx = await nominated(fx);
  const project = ctx.project.id;
  const k = (await installChecks(fx.engine, project, checks)).id;
  return { fx, ctx, project, k, c1: ctx.candidate };
}

const onlyReason = (evaluation, code, subject) => {
  assert.deepEqual(reasonCodes(evaluation), [code], `the gate's one reason is ${code}`);
  assert.deepEqual(reasonSubjects(evaluation, code), [subject], 'and it names the finding');
};

describe('M42 the findings a gate asks about', () => {
  test('an unresolved finding stays in the query through a planned fix and across two successor lineages: a fix that is only planned resolves nothing', async (t) => {
    const { fx, ctx, project, k, c1 } = await clean(t);
    await passAll(fx.engine, project, c1.id, [k.login]);
    const [found] = await raiseFindings(fx, project, c1.id, [defect('medium', 'the logout link is missing on the settings page')]);
    assert.deepEqual([found.status, found.effective_severity, found.candidate], ['open', 'medium', c1.id]);
    onlyReason(await stageGate(fx, ctx), 'FINDING_UNSATISFIED', found.id);

    await review(fx, project, c1.id, { dispositions: [{ finding: found.id, disposition: 'fix' }] });
    assert.deepEqual([finding(fx.home, found.id).status, finding(fx.home, found.id).disposition], ['dispositioned', 'fix'], 'the fix is a disposition, not a resolution');
    onlyReason(await stageGate(fx, ctx), 'FINDING_UNSATISFIED', found.id);

    // Two nominations later, in the second successor lineage, the finding is still asked about.
    await successor(fx, ctx);
    const c3 = await successor(fx, ctx);
    await passAll(fx.engine, project, c3.id, [k.login]);
    onlyReason(await stageGate(fx, ctx, c3), 'FINDING_UNSATISFIED', found.id);
    assert.equal(finding(fx.home, found.id).status, 'dispositioned', 'and it is not resolved');
  });

  test('a deferral holds while its authority matches the current severity and its target has not passed, and each evaluation re-evaluates it', async (t) => {
    const { fx, ctx, project, k, c1 } = await clean(t);
    await passAll(fx.engine, project, c1.id, [k.login]);
    const [raised, aging] = await raiseFindings(fx, project, c1.id, [defect('low', 'a label is misaligned'), defect('low', 'a tooltip is truncated')]);
    await review(fx, project, c1.id, {
      dispositions: [
        { finding: raised.id, disposition: 'defer', linked_issue: 'ISSUE-7', defer_target: inDays(1) },
        { finding: aging.id, disposition: 'defer', linked_issue: 'ISSUE-8', defer_target: inDays(1) },
      ],
    });
    assert.deepEqual([finding(fx.home, raised.id).disposition, finding(fx.home, raised.id).disposition_authority], ['defer', 'reviewer'], 'a Reviewer may defer a Low finding');

    // Each evaluation re-evaluates the deferral and says so on the finding.
    const first = await stageGate(fx, ctx);
    const second = await stageGate(fx, ctx);
    assert.deepEqual([first.outcome, second.outcome], ['satisfied', 'satisfied']);
    const reevaluated = JSON.parse(finding(fx.home, raised.id).reevaluations).map((entry) => entry.evaluation);
    for (const evaluation of [first, second]) assert.ok(reevaluated.includes(evaluation.id), `the deferral was re-evaluated by evaluation ${evaluation.id}`);

    // The severity is raised: the Reviewer's authority no longer covers the deferral.
    await review(fx, project, c1.id, { severity_changes: [{ finding: raised.id, to: 'medium' }] });
    assert.equal(finding(fx.home, raised.id).effective_severity, 'medium');
    onlyReason(await stageGate(fx, ctx), 'FINDING_UNSATISFIED', raised.id);

    // The target passes: a deferral cannot age past a gate.
    await advanceClock(fx.engine, 2 * DAY);
    const late = await stageGate(fx, ctx);
    assert.ok(reasonSubjects(late, 'FINDING_DEFER_EXPIRED').includes(aging.id), `an expired deferral is reported as expired (reasons: ${reasonCodes(late).join(', ')})`);
  });

  test("the human owner's accept of a Medium finding satisfies the gate", async (t) => {
    const { fx, ctx, project, k, c1 } = await clean(t);
    await passAll(fx.engine, project, c1.id, [k.login]);
    const [found] = await raiseFindings(fx, project, c1.id, [defect('medium', 'the export omits the header row')]);
    await review(fx, project, c1.id, { dispositions: [{ finding: found.id, disposition: 'accept' }] });
    assert.equal(finding(fx.home, found.id).status, 'open', 'a Reviewer cannot accept: the finding is as it was until the human decides');
    onlyReason(await stageGate(fx, ctx), 'FINDING_UNSATISFIED', found.id);

    await consume(fx, project, await openDecision(fx, project, 'finding_disposition', found.id), 'approve');
    const accepted = finding(fx.home, found.id);
    assert.deepEqual([accepted.status, accepted.disposition, accepted.disposition_authority], ['dispositioned', 'accept', 'human']);
    assert.equal((await stageGate(fx, ctx)).outcome, 'satisfied');
  });

  test('a fix is resolved by a verification on the candidate that holds it, and a resolution whose verification is invalidated reopens the finding', async (t) => {
    const { fx, ctx, project, k, c1 } = await clean(t, [check('login', { requirements: ['R1'] }), check('regress', { requirements: ['R1'] })]);
    await passAll(fx.engine, project, c1.id, [k.login]);
    await postResult(fx.engine, project, { candidate: c1.id, check: k.regress, exit_status: 1 });
    const [found] = await raiseFindings(fx, project, c1.id, [defect('medium', 'a session survives logout', { check: 'regress' })]);
    await review(fx, project, c1.id, { dispositions: [{ finding: found.id, disposition: 'fix' }] });

    // The fix is built and nominated, and the check that showed the defect passes on it.
    const c2 = await successor(fx, ctx);
    const [, proof] = await passAll(fx.engine, project, c2.id, [k.login, k.regress]);
    const verified = await stageGate(fx, ctx, c2);
    assert.equal(verified.outcome, 'satisfied', `reasons: ${reasonCodes(verified).join(', ')}`);
    const resolved = finding(fx.home, found.id);
    assert.equal(resolved.status, 'resolved');
    assert.deepEqual(JSON.parse(resolved.resolution_verification), { evaluation: verified.id, check_result: proof.id }, 'the resolution names the evaluation and the execution that verified it');
    assert.equal(eventsOfType(fx.home, 'finding.resolved').length, 1);

    // The verification is invalidated: a developer's commit on the integration branch is adopted.
    commitOnRef(ctx.project.repo.path, ctx.project.repo.ref, { 'src/hotfix.js': 'export const hotfix = true;\n' }, { message: 'developer: a commit the engine did not make' });
    await tick(fx.engine, project);
    const [observed] = outOfBand(fx.home, project);
    await answerDecision(fx.engine, project, observed.decision.id, 'adopt');
    await waitFor(() => checkResult(fx.home, proof.id).invalidated_at !== null, { what: 'the verifying result to be invalidated' });
    await waitFor(() => finding(fx.home, found.id).status === 'open', { what: 'the finding to be reopened' });
    assert.equal(eventsOfType(fx.home, 'finding.reopened').length, 1);
    const reopened = await stageGate(fx, ctx, c2);
    assert.ok(reasonSubjects(reopened, 'FINDING_UNSATISFIED').includes(found.id), `the reopened finding is asked about again (reasons: ${reasonCodes(reopened).join(', ')})`);
  });

  test('an exclusion that is proposed, and then assessed, excludes nothing before its required approval', async (t) => {
    const { fx, ctx, project, k, c1 } = await clean(t);
    const [found] = await raiseFindings(fx, project, c1.id, [defect('high', 'totals are wrong for refunded orders')]);
    const c2 = await successor(fx, ctx);
    await passAll(fx.engine, project, c2.id, [k.login]);
    const alpha = await alphaTarget(fx, ctx, c2);
    onlyReason(await alpha.evaluate(), 'FINDING_BLOCKING', found.id);

    // The Verifier proposes that the finding no longer applies to candidate 2.
    await acceptedRun(fx, project, 'verification', { subject: { candidate: c2.id }, result: { applicability: [{ finding: found.id, candidate: c2.id, reason: 'the refund path was removed', evidence: 'no caller of refund() remains in candidate 2' }] } });
    const [proposed] = assessmentsOf(fx.home, project);
    assert.deepEqual([proposed?.status, proposed?.finding, proposed?.candidate], ['proposed', found.id, c2.id]);
    onlyReason(await alpha.evaluate(), 'FINDING_BLOCKING', found.id);

    // An independent Reviewer assesses it and agrees.
    await review(fx, project, c2.id, { assessments: [{ assessment: proposed.id, verdict: 'not_applicable' }] });
    assert.equal(assessmentsOf(fx.home, project)[0].status, 'assessed', 'assessed is not approved: this finding blocks a gate, so the human owner must authorize the exclusion');
    onlyReason(await alpha.evaluate(), 'FINDING_BLOCKING', found.id);
  });
});
