// M51, the `severity_lower` manifest (slice 5). Plan §3.5 M51; build spec §6
// correction 22; RN §3 B12; Review B12; D1 §9.4; F §§6.1, 6.3; SEAM.md §§74,
// 76, 77.
//
// Lowering a severity is asymmetric (F §6.3). A Reviewer may lower within
// the nonblocking range, Medium to Low, by its own authority. Lowering out
// of the blocking range needs the human owner: the Reviewer's request
// changes nothing and raises a decision, whose approval binds the finding's
// severity, sensitivity and scope as previewed. If the sensitivity changes
// in between, the approval cannot be reused. No change of severity changes
// a check state.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertQuestionClosed, assertStaleAnswer, consume, decisionsOn, nextGeneration, openDecision, reject } from './harness/decisions.mjs';
import { acceptedRun, assessmentsOf, check, finding, findingState, installChecks, nominated, passAll, passedInventory, postResult, raiseFindings, review, stageGate } from './harness/gates.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';

// A T1 candidate with one check passed and one failed, and a finding of the
// given severity that a Reviewer raised on it. The failure is recorded while
// the stage's work is verifying on the candidate, so under Q2 (D3 §2.10; E90
// item 2) it would send the stage back to its Builder; this row is not about
// that repair, so at repair_attempts_max 0 the work is parked instead
// (objection 030).
async function findingOf(t, severity) {
  const fx = await scriptedEngine(t);
  const ctx = await nominated(fx, { policy: { repair_attempts_max: 0 } });
  const project = ctx.project.id;
  const k = (await installChecks(fx.engine, project, [check('login', { requirements: ['R1'] }), check('import', { requirements: ['R1'] })])).id;
  await passAll(fx.engine, project, ctx.candidate.id, [k.login]);
  await postResult(fx.engine, project, { candidate: ctx.candidate.id, check: k.import, exit_status: 1 });
  const [found] = await raiseFindings(fx, project, ctx.candidate.id, [{ category: 'defect', severity, message: 'totals are wrong for refunded orders' }]);
  const lower = (to) => review(fx, project, ctx.candidate.id, { severity_changes: [{ finding: found.id, to }] });
  const checkStates = async () => (await stageGate(fx, ctx)).check_states;
  return { fx, ctx, project, k, found, lower, checkStates };
}

const lastChange = (fx, found) => {
  const { authority, from, to } = JSON.parse(finding(fx.home, found.id).severity_history).at(-1) ?? {};
  return { authority, from, to };
};

describe('M51 the severity_lower manifest', () => {
  test('a Reviewer lowers Medium to Low by its own authority: applied, recorded with its authority, and no decision is raised', async (t) => {
    const { fx, found, lower } = await findingOf(t, 'medium');
    await lower('low');
    assert.equal(finding(fx.home, found.id).effective_severity, 'low');
    assert.deepEqual(lastChange(fx, found), { authority: 'reviewer', from: 'medium', to: 'low' });
    assert.equal(decisionsOn(fx.home, 'severity_lower', found.id).length, 0);
  });

  test("a Reviewer's lowering of High to Medium changes nothing until the human owner approves it; the approval lowers the severity and changes no check state", async (t) => {
    const { fx, project, k, found, lower, checkStates } = await findingOf(t, 'high');
    const before = await checkStates();
    assert.deepEqual(before, { ...passedInventory(k), [k.login]: 'passed', [k.import]: 'failed' }, 'the fixture is live (beside the inventory of the tier, passed: M3 slice 20, SEAM.md §226)');
    await lower('medium');
    assert.equal(finding(fx.home, found.id).effective_severity, 'high', 'out of the blocking range a Reviewer lowers nothing');

    const previewed = await openDecision(fx, project, 'severity_lower', found.id);
    assert.deepEqual({ severity: previewed.manifest.effective_severity, to: previewed.manifest.to, sensitive: previewed.manifest.sensitive_area }, { severity: 'high', to: 'medium', sensitive: null });
    await consume(fx, project, previewed, 'approve');
    assert.equal(finding(fx.home, found.id).effective_severity, 'medium');
    assert.deepEqual(lastChange(fx, found), { authority: 'human', from: 'high', to: 'medium' });
    assert.deepEqual(await checkStates(), before, 'no check state changed');
  });

  test('the finding turns out to be in a sensitive area between preview and answer: the approval cannot be reused, and the severity stays', async (t) => {
    const { fx, project, found, lower } = await findingOf(t, 'high');
    await lower('medium');
    const previewed = await openDecision(fx, project, 'severity_lower', found.id);
    await fx.engine.stop();
    withStore(fx.home, (db) => db.prepare(`UPDATE "findings" SET "sensitive_area" = 'authentication' WHERE "id" = ?`).run(found.id), { readonly: false });
    await fx.start();

    await assertStaleAnswer(fx, project, previewed, 'approve');
    assert.equal(finding(fx.home, found.id).effective_severity, 'high');
    const next = await nextGeneration(fx, project, previewed, { changed: 'sensitive_area' });
    assert.equal(next.manifest.sensitive_area, 'authentication');
  });

  // M2 slice 1, A4 (SEAM.md §102).
  test('reject: the severity and its history are as they were, no check state changes, the decision is closed with the answer recorded, and the question is not raised again', async (t) => {
    const { fx, project, found, lower, checkStates } = await findingOf(t, 'high');
    const before = findingState(finding(fx.home, found.id));
    const states = await checkStates();
    await lower('medium');
    const previewed = await openDecision(fx, project, 'severity_lower', found.id);
    assert.deepEqual(previewed.options.map((option) => option.key).sort(), ['approve', 'reject'], 'the fixture is live: the lowering offers reject');

    await reject(fx, project, previewed);
    assert.deepEqual(findingState(finding(fx.home, found.id)), before, 'the finding is as it was: High, with the history it had');
    assert.deepEqual(await checkStates(), states, 'no check state changed');
    await assertQuestionClosed(fx, project, previewed);
    assert.deepEqual(findingState(finding(fx.home, found.id)), before, 'and the ticks changed nothing of it');
  });

  // M2 slice 2, B1 (SEAM.md §105): the finding's status.
  test("the finding's status changes between preview and answer (a Reviewer dispositions it fix): the old preview is stale, the severity stays, and the next generation binds the status as it now is", async (t) => {
    const { fx, ctx, project, found, lower } = await findingOf(t, 'high');
    await lower('medium');
    const previewed = await openDecision(fx, project, 'severity_lower', found.id);
    assert.equal(previewed.manifest.finding_status, 'open', 'the fixture is live: the preview binds the finding as open');

    // A Reviewer's fix is recorded at once, with its own authority (E43): the
    // finding is dispositioned while the lowering is still being asked about.
    await review(fx, project, ctx.candidate.id, { dispositions: [{ finding: found.id, disposition: 'fix' }] });
    assert.deepEqual([finding(fx.home, found.id).status, finding(fx.home, found.id).disposition], ['dispositioned', 'fix'], 'the fixture is live: the finding changed');

    await assertStaleAnswer(fx, project, previewed, 'approve');
    assert.equal(finding(fx.home, found.id).effective_severity, 'high', 'nothing was lowered on the earlier preview');
    const next = await nextGeneration(fx, project, previewed, { changed: 'finding_status' });
    assert.deepEqual([next.manifest.finding_status, next.manifest.to], ['dispositioned', 'medium'], 'the next preview binds the finding as dispositioned, and still asks the same lowering');
    await consume(fx, project, next, 'approve');
    assert.deepEqual([finding(fx.home, found.id).effective_severity, finding(fx.home, found.id).disposition], ['medium', 'fix'], 'the current preview can be answered: the severity is lowered, and the disposition stands');
  });

  // M2 slice 2, B1 (SEAM.md §105): the scope the finding applies to.
  test("the finding stops applying to the candidate between preview and answer (an approved exclusion): the old preview is stale, the severity stays, and the next generation binds the applicability as it now is", async (t) => {
    const { fx, ctx, project, found, lower } = await findingOf(t, 'high');
    const candidate = ctx.candidate;
    await lower('medium');
    const previewed = await openDecision(fx, project, 'severity_lower', found.id);
    assert.deepEqual([previewed.manifest.applicable, previewed.manifest.candidate_revision], [true, candidate.revision], 'the fixture is live: the preview binds the finding as applying to its candidate');

    // The Verifier proposes that the finding does not apply to the candidate,
    // an independent Reviewer agrees, and the human owner approves the
    // exclusion (row M52): the finding then applies to the candidate no more.
    await acceptedRun(fx, project, 'verification', {
      subject: { candidate: candidate.id },
      result: { applicability: [{ finding: found.id, candidate: candidate.id, reason: 'the totals path is not in this candidate', evidence: 'refund totals are computed elsewhere' }] },
    });
    const [proposed] = assessmentsOf(fx.home, project);
    await review(fx, project, candidate.id, { assessments: [{ assessment: proposed.id, verdict: 'not_applicable' }] });
    await consume(fx, project, await openDecision(fx, project, 'finding_applicability_exclusion', proposed.id), 'approve');
    assert.equal(assessmentsOf(fx.home, project)[0].status, 'approved', 'the fixture is live: the exclusion is approved');

    await assertStaleAnswer(fx, project, previewed, 'approve');
    assert.equal(finding(fx.home, found.id).effective_severity, 'high', 'nothing was lowered on the earlier preview');
    const next = await nextGeneration(fx, project, previewed, { changed: 'applicable' });
    assert.deepEqual([next.manifest.applicable, next.manifest.effective_severity, next.manifest.to], [false, 'high', 'medium'], 'the next preview binds the finding as no longer applying, and still asks the same lowering');
  });
});
