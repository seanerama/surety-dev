// M50, the `finding_disposition` manifest (slice 5). Plan §3.5 M50; build
// spec §6 correction 22; Review B12; D1 §§9.3(5), 10.5, D1-04, D1-24; F
// §6.2; SEAM.md §§74, 76, 77.
//
// A disposition beyond a Reviewer's authority (deferring a Medium finding,
// accepting any) is decided by the human owner. The answer binds the
// finding as it is now (its status, disposition, severity, sensitivity,
// evidence, the proposed deferral's target and issue, whether it applies)
// and the acceptance content of the candidate. A deferral proposed again
// with another target is still a deferral the human may approve, and it is
// another consequence: the old preview is stale. A deferral whose target has
// passed cannot be approved. (That a fix resolves nothing without
// verification is row M42.)

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CODES, answer, approvalsOf, assertStaleAnswer, consume, nextGeneration, openDecision } from './harness/decisions.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { check, finding, installChecks, nominated, passAll, raiseFindings, reasonSubjects, review, scopeOf, stageGate } from './harness/gates.mjs';
import { advanceClock, scriptedEngine } from './harness/runs.mjs';

const DAY = 86_400;
const inDays = (n) => new Date(Date.now() + n * DAY * 1000).toISOString();

// A T1 candidate whose one required check passes, and a Medium finding a Reviewer raised on it.
async function mediumFinding(t) {
  const fx = await scriptedEngine(t);
  const ctx = await nominated(fx);
  const project = ctx.project.id;
  const k = (await installChecks(fx.engine, project, [check('login', { requirements: ['R1'] })])).id;
  await passAll(fx.engine, project, ctx.candidate.id, [k.login]);
  const [found] = await raiseFindings(fx, project, ctx.candidate.id, [{ category: 'defect', severity: 'medium', message: 'the export omits the header row' }]);
  // A Reviewer proposes to defer it, and the engine asks the human owner.
  const proposeDefer = async (target) => {
    await review(fx, project, ctx.candidate.id, { dispositions: [{ finding: found.id, disposition: 'defer', linked_issue: 'ISSUE-9', defer_target: target }] });
  };
  return { fx, ctx, project, found, proposeDefer };
}

const undisposed = (fx, found) => assert.deepEqual([finding(fx.home, found.id).status, finding(fx.home, found.id).disposition], ['open', null], 'the finding has no disposition');

describe('M50 the finding_disposition manifest', () => {
  test("the human owner approves a Medium finding's deferral: the approval binds the finding as it is and the candidate's acceptance content, and the deferral is recorded as proposed", async (t) => {
    const { fx, ctx, project, found, proposeDefer } = await mediumFinding(t);
    const target = inDays(3);
    await proposeDefer(target);
    undisposed(fx, found);
    const unsatisfied = await stageGate(fx, ctx);
    assert.deepEqual(reasonSubjects(unsatisfied, 'FINDING_UNSATISFIED'), [found.id], "a Reviewer's deferral of a Medium finding is not a disposition");
    const scope = scopeOf(fx.home, unsatisfied);

    const previewed = await openDecision(fx, project, 'finding_disposition', found.id);
    assert.deepEqual(
      {
        status: previewed.manifest.finding_status,
        disposition: previewed.manifest.disposition,
        proposed: previewed.manifest.proposed_disposition,
        severity: previewed.manifest.effective_severity,
        target: previewed.manifest.defer_target,
        issue: previewed.manifest.linked_issue,
        revision: previewed.manifest.candidate_revision,
        content: previewed.manifest.acceptance_content_hash,
      },
      { status: 'open', disposition: null, proposed: 'defer', severity: 'medium', target, issue: 'ISSUE-9', revision: ctx.candidate.revision, content: scope.acceptance_content_hash },
      'the preview binds the current finding, the proposed deferral and the acceptance content',
    );

    await consume(fx, project, previewed, 'approve');
    const deferred = finding(fx.home, found.id);
    assert.deepEqual(
      [deferred.status, deferred.disposition, deferred.disposition_authority, deferred.linked_issue, deferred.defer_target],
      ['dispositioned', 'defer', 'human', 'ISSUE-9', target],
    );
    const approvals = approvalsOf(fx.home, previewed.id);
    assert.deepEqual(approvals.map((row) => row.acceptance_content_hash), [scope.acceptance_content_hash], 'one approval, bound to the acceptance content of the candidate');
    assert.equal((await stageGate(fx, ctx)).outcome, 'satisfied');
  });

  test('the deferral is proposed again with another target before the answer: still a deferral the human may approve, and a different consequence, so the old preview is stale', async (t) => {
    const { fx, project, found, proposeDefer } = await mediumFinding(t);
    await proposeDefer(inDays(3));
    const previewed = await openDecision(fx, project, 'finding_disposition', found.id);
    const later = inDays(30);
    await proposeDefer(later);

    await assertStaleAnswer(fx, project, previewed, 'approve');
    undisposed(fx, found);
    const next = await nextGeneration(fx, project, previewed, { changed: 'defer_target' });
    assert.equal(next.manifest.defer_target, later);
    await consume(fx, project, next, 'approve');
    assert.equal(finding(fx.home, found.id).defer_target, later, 'the approval that is given is of the consequence that was shown');
  });

  test('the target passes before the answer: an expired deferral cannot be approved', async (t) => {
    const { fx, project, found, proposeDefer } = await mediumFinding(t);
    await proposeDefer(inDays(1));
    const previewed = await openDecision(fx, project, 'finding_disposition', found.id);
    await advanceClock(fx.engine, 2 * DAY);
    assertRefused(await answer(fx.engine, project, previewed, 'approve'), 409, [CODES.stale, CODES.invalidated], 'approving a deferral whose target has passed');
    undisposed(fx, found);
    assert.equal(approvalsOf(fx.home, previewed.id).length, 0);
  });
});
