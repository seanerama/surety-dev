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

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CODES, answer, answerAndHoldEffect, approvalsOf, assertEffectInvalidated, assertQuestionClosed, assertStaleAnswer, consume, decision, decisionsOn, nextGeneration, openDecision, reject } from './harness/decisions.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { assertApplied, assertNotApplied, assertProposalRejected, capturedProposal, correction, proposalsOf, reviewerApproves, roleRun, waitApplied } from './harness/gates.mjs';
import { addItem, permittedEdit, roleThat, runToEnd } from './harness/gitruns.mjs';
import { changePolicy } from './harness/journal.mjs';
import { refOid } from './harness/repos.mjs';
import { tick } from './harness/runs.mjs';
import { contentAndSpecChange } from './harness/stale-correction.mjs';

const KIND = 'check_correction_tightening';
const head = (project) => refOid(project.repo.path, project.repo.ref);

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
});
