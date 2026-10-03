// M53, the `check_correction_tightening` manifest (slice 5). Plan §3.5 M53;
// RN R4 and §3 B12; build spec §6 corrections 5 and 22; D1 §7.9; E13; F
// §5.3; Review B12, B18; SEAM.md §§69, 76, 77.
//
// A correction classified as tightening has two authorized approvers: the
// human owner, through a decision kind of its own, and a Reviewer's run.
// Each leaves its provenance on the proposal and on the version. The
// human's approval binds the proposal (status, tree, diff, base), the
// integration revision it would be applied to, the classification and its
// evidence, the effective protected version, the approved spec and the
// policy: a change of any of them between preview and answer, or between
// answer and effect, refuses or invalidates it. The Verifier never approves
// a correction, and a correction the classifier could not classify never
// takes this path.
//
// The last case (M2 slice 1 review, S1; SEAM.md §104) moves the integration
// branch at the latest moment of all: after the answer, after the
// application's commit, before its branch update. The update's
// compare-and-swap is the effect's conditional execution (D1 §10.5), so it
// fails without effect and the intent is invalidated like any other.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CODES, answer, answerAndHoldEffect, approvalsOf, assertEffectInvalidated, assertQuestionClosed, assertStaleAnswer, consume, decision, decisionsOfKind, decisionsOn, intentsOf, nextGeneration, openDecision, reject } from './harness/decisions.mjs';
import { releaseBarrier, waitFor } from './harness/engine.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { PROTECTED_FILES, askingForTicks, assertApplied, assertNotApplied, assertProposalRejected, capturedProposal, classify, correction, effectiveVersion, governedEdit, proposalsOf, protectedVersions, reviewerApproves, roleRun, waitApplied } from './harness/gates.mjs';
import { addGitProject, addItem, permittedEdit, roleThat, roleThatHolds, runToEnd, runToHold, step } from './harness/gitruns.mjs';
import { armBarrier, changePolicy, journalBarrier, operationsOf } from './harness/journal.mjs';
import { parentsOf, refOid } from './harness/repos.mjs';
import { runsOf, scriptedEngine, tick, waitForRun, workItem } from './harness/runs.mjs';
import { contentAndSpecChange } from './harness/stale-correction.mjs';

const KIND = 'check_correction_tightening';
const head = (project) => refOid(project.repo.path, project.repo.ref);

// Tick until `read()` satisfies `done`, at most `max` times, and return the
// last reading whatever it is: the assertion that follows says what it was.
async function settle(fx, project, read, done, { max = 4 } = {}) {
  for (let i = 0; ; i++) {
    const value = read();
    if (done(value) || i === max) return value;
    await tick(fx.engine, project);
  }
}

describe('M53 the check_correction_tightening manifest', () => {
  test('the human owner approves a tightening through its own kind: the bound proposal is applied, with the human as its approver', async (t) => {
    const ctx = await correction(t, 'tightening');
    const { fx, project, proposal, decision: previewed } = ctx;
    assert.deepEqual(
      {
        kind: previewed.kind,
        status: previewed.manifest.proposal_status,
        tree: previewed.manifest.tree,
        diff: previewed.manifest.diff_hash,
        base: previewed.manifest.base_revision,
        head: previewed.manifest.integration_revision,
        classification: previewed.manifest.classification,
        version: previewed.manifest.effective_protected_version,
      },
      { kind: KIND, status: 'classified', tree: proposal.tree_id, diff: proposal.diff_hash, base: proposal.base_revision, head: ctx.headBefore, classification: 'tightening', version: ctx.previous.id },
      'the preview binds the proposal, where it would be applied, its classification and the effective version',
    );

    await consume(fx, project.id, previewed, 'approve');
    await waitApplied(fx, project, proposal);
    assertApplied(fx, project, { proposal, previous: ctx.previous, headBefore: ctx.headBefore, authority: 'human', changeKind: 'tightening' });
    assert.deepEqual(approvalsOf(fx.home, previewed.id).map((row) => [row.subject_type, row.subject_id, row.result_hash]), [['protected_proposal', proposal.id, proposal.diff_hash]], 'the approval is of that proposal and that diff');
  });

  test('a Reviewer approves a tightening: the proposal is applied with the Reviewer as its approver, and the human decision about it is closed', async (t) => {
    const ctx = await correction(t, 'tightening');
    const { fx, project, proposal, decision: previewed } = ctx;
    const { run } = await reviewerApproves(fx, project, proposal);
    await waitApplied(fx, project, proposal);
    assertApplied(fx, project, { proposal, previous: ctx.previous, headBefore: ctx.headBefore, authority: 'reviewer', changeKind: 'tightening' });
    assert.equal(proposalsOf(fx.home, project.id)[0].approver, run.id, "the proposal names the Reviewer's run as its approver");
    await tick(fx.engine, project.id);
    assert.equal(decision(fx.home, previewed.id).status, 'invalidated', 'the human was not needed: the question is closed');
    assertRefused(await answer(fx.engine, project.id, previewed, 'approve'), 409, CODES.invalidated, 'answering a decision another path has settled');
    assert.equal(approvalsOf(fx.home, previewed.id).length, 0);
  });

  test('the integration branch moves between preview and answer: the approval is stale although the correction can still be approved; the next generation is bound to the new revision and is applied onto it', async (t) => {
    const ctx = await correction(t, 'tightening');
    const { fx, project, proposal, decision: previewed } = ctx;
    const fix = await addItem(fx, project.id, 'fix');
    fx.scripted.script(fix, [roleThat([permittedEdit()])]);
    await runToEnd(fx, project.id, fix);
    const moved = head(project);
    assert.notEqual(moved, ctx.headBefore, 'the fixture is live: a source commit was integrated');

    await assertStaleAnswer(fx, project.id, previewed, 'approve');
    assertNotApplied(fx, ctx, moved);
    const next = await nextGeneration(fx, project.id, previewed, { changed: 'integration_revision' });
    assert.equal(next.manifest.integration_revision, moved);
    await consume(fx, project.id, next, 'approve');
    await waitApplied(fx, project, proposal);
    assertApplied(fx, project, { proposal, previous: ctx.previous, headBefore: moved, authority: 'human', changeKind: 'tightening' });
  });

  test('the policy changes after the answer and before the effect: the effect is invalidated, nothing is applied, the approval is withdrawn and the question is asked again', async (t) => {
    const ctx = await correction(t, 'tightening');
    const { fx, project, proposal, decision: previewed } = ctx;
    const held = await answerAndHoldEffect(fx, project.id, previewed, 'approve');
    await changePolicy(fx.engine, project.id, { deadline_reviewer: 600 });
    const moved = head(project);
    await assertEffectInvalidated(fx, previewed, held);
    assert.equal(assertNotApplied(fx, ctx, moved).status, 'classified', 'the proposal awaits an approval again');
    const next = await openDecision(fx, project.id, KIND, proposal.id);
    assert.deepEqual([next.id !== previewed.id, approvalsOf(fx.home, next.id).length], [true, 0], 'the next generation has no approval: none was carried over');
  });

  test('a Verifier approves nothing, and a correction the classifier could not classify cannot take the tightening path', async (t) => {
    const ctx = await correction(t, 'tightening');
    const { fx, project, proposal } = ctx;
    await roleRun(fx, project.id, 'verification', { result: { proposal_approval: { proposal: proposal.id, reason: 'I wrote it, and it is right.' } } });
    await tick(fx.engine, project.id);
    assert.equal(assertNotApplied(fx, ctx, ctx.headBefore).status, 'classified', "the Verifier's approval of a proposal approved nothing");

    const unknown = await capturedProposal(fx, project, { changeKind: 'unclassifiable', content: '{"expect": [200, 204]}\n' });
    await reviewerApproves(fx, project, unknown);
    await tick(fx.engine, project.id);
    assert.equal(assertNotApplied(fx, { ...ctx, proposal: unknown }, ctx.headBefore).status, 'awaiting_human', 'a Reviewer cannot approve what the classifier could not classify');
    assert.equal(decisionsOn(fx.home, KIND, unknown.id).length, 0, 'and no tightening decision exists for it');
    await openDecision(fx, project.id, 'check_correction_unclassifiable', unknown.id);
  });

  // M2 slice 1, A3 (SEAM.md §101).
  test("the proposal's content, and then the approved specification, change between preview and answer: each refuses the earlier preview, applies nothing, and is a new generation that shows the change", async (t) => {
    await contentAndSpecChange(t, 'tightening');
  });

  // M2 slice 1, A4 (SEAM.md §102).
  test("reject: the proposal is rejected and nothing is applied; a Reviewer's approval afterwards approves nothing; the decision is closed with the answer recorded, and the question is not raised again", async (t) => {
    const ctx = await correction(t, 'tightening');
    const { fx, project, proposal, decision: previewed } = ctx;
    assert.deepEqual(previewed.options.map((option) => option.key).sort(), ['approve', 'reject'], 'the fixture is live: the correction offers reject');

    await reject(fx, project.id, previewed);
    assertProposalRejected(fx, ctx);
    // The human's rejection stands against the other authorized approver of a tightening.
    await reviewerApproves(fx, project, proposal);
    await tick(fx.engine, project.id);
    assertProposalRejected(fx, ctx);
    await assertQuestionClosed(fx, project.id, previewed);
    assertProposalRejected(fx, ctx);
  });

  // M2 slice 1 review, S1 (SEAM.md §104). The staging is the Reviewer's: a
  // Builder held in its workspace; a human tightening, open; the Builder's
  // integration intended with old = H and paused; the answer, whose
  // application's commit intent is paused in turn; the integration released
  // first, so it moves the branch H → R before the application's branch
  // update, intended with old = H, is attempted. No tick is asked for while
  // a journal barrier is paused: the order of the two drives is the lock's.
  test("the integration branch moves after the answer, between the application's commit and its branch update: the update fails without effect, the effect is invalidated, the approval and the intended version are withdrawn, nothing is left blocked, the project dispatches again, and the question is asked again against the new head", async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx, { tier: 'T1', files: PROTECTED_FILES });
    const previous = effectiveVersion(fx.home, project.id);
    const H = head(project);

    const fix = await addItem(fx, project.id, 'fix');
    fx.scripted.script(fix, [roleThatHolds([permittedEdit()])]);
    await runToHold(fx, project.id, fix);

    const proposal = await governedEdit(fx, project, { protected_paths: ['.surety/checks/', 'docs/policy/'] });
    await classify(fx.engine, proposal.id, 'tightening');
    const previewed = await askingForTicks(fx, project.id, () => decisionsOn(fx.home, KIND, proposal.id).find((row) => row.status === 'open'), 'the tightening to be offered for approval');
    assert.equal(previewed.manifest.integration_revision, H, 'the fixture is live: the preview is against the head the Builder started from');
    const ctx = { project, previous, proposal };

    // 1. The Builder's integration is intended, old = H, and waits before its swap.
    const swap = journalBarrier('ref_update', 'intent_committed');
    await armBarrier(fx.engine, swap, 'pause');
    fx.scripted.release(fix);
    await fx.engine.waitUntil(`barrier:${swap}`);

    // 2. The human approves while the branch is still at H: consumed, one intent.
    const commit = journalBarrier('commit_tree', 'intent_committed');
    await armBarrier(fx.engine, commit, 'pause');
    const pending = answer(fx.engine, project.id, previewed, 'approve').catch((err) => err);
    await waitFor(() => (intentsOf(fx.home, previewed.id).length === 1 ? true : undefined), { what: 'the approval to record its effect intent' });

    // 3. The integration goes on; the application's commit is intended with the branch at H.
    await releaseBarrier(fx.engine, swap);
    await fx.engine.waitUntil(`barrier:${commit}`);
    assert.equal(head(project), H, "the fixture is live: the application's commit is intended against H, which the integration is about to move");

    // 4. Both go on. The integration, queued first, moves the branch H → R.
    await releaseBarrier(fx.engine, commit);
    await pending;
    await waitForRun(fx.home, fix, { state: 'ended' });
    const R = head(project);
    assert.deepEqual([parentsOf(project.repo.path, R), workItem(fx.home, fix).status], [[H], 'integrated'], "the fixture is live: the Builder's commit is integrated on H");

    // The branch update's compare-and-swap found R, not H: the effect's conditional execution failed, and that is a changed precondition.
    const intent = await settle(fx, project.id, () => intentsOf(fx.home, previewed.id)[0], (row) => ['invalidated', 'done'].includes(row.status));
    assert.deepEqual([intent.status, intent.invalidated_reason], ['invalidated', CODES.intent_invalidated], "the application's branch update found the branch moved off its old commit: the effect is invalidated, not left executing");

    // Withdrawn: the proposal awaits an approval again, and the version intended for it is not authorized.
    assert.equal(assertNotApplied(fx, ctx, R).status, 'classified', 'the approval is withdrawn with the effect: the proposal awaits an approval again');
    const unauthorized = (version) => version.authorized === 0 && version.effective_from === null;
    assert.ok(protectedVersions(fx.home, project.id).filter((version) => version.proposal === proposal.id).every(unauthorized), 'no version of the proposal is authorized or effective');

    // Nothing is left for a person to unblock or for recovery to carry.
    assert.deepEqual(decisionsOfKind(fx.home, project.id, 'blocker').filter((row) => row.status === 'open').map((row) => [row.subject_type, row.question]), [], 'no blocker is open: a failed compare-and-swap is not an ambiguity');
    assert.deepEqual(operationsOf(fx.home, { project: project.id }).filter((op) => !['finalized', 'failed'].includes(op.state)).map((op) => [op.journal_kind, op.state]), [], 'every operation of the project is finalized or failed: none is left ambiguous or in flight');

    // The question is asked again, against R, with no approval; and the project goes on.
    const next = await openDecision(fx, project.id, KIND, proposal.id);
    assert.deepEqual([next.id !== previewed.id, next.manifest.integration_revision, approvalsOf(fx.home, next.id).length], [true, R, 0], 'the next generation is bound to the new head and starts with no approval');
    const second = await addItem(fx, project.id, 'fix');
    fx.scripted.script(second, [roleThat([step.write('src/second.js', 'export const second = 2;\n')])]);
    await tick(fx.engine, project.id);
    assert.equal(runsOf(fx.home, second).length, 1, 'the next work item is dispatched on the next tick');
    await runToEnd(fx, project.id, second);
    assert.deepEqual([parentsOf(project.repo.path, head(project)), workItem(fx.home, second).status], [[R], 'integrated'], "the integrated work stayed on the branch: the second item's commit is on R");
    assert.ok(protectedVersions(fx.home, project.id).filter((version) => version.proposal === proposal.id).every(unauthorized), 'and the withdrawn version never became authorized');
  });
});
