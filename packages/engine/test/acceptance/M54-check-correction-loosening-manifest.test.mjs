// M54, the `check_correction_loosening` manifest (slice 5). Plan §3.5 M54;
// E13; RN R2 and §3 B12; build spec §6 corrections 3 and 22; D1 §7.9,
// D1-12, D1-15, D1-35; F §§3.3, 5.3; Review B12; SEAM.md §§69, 76, 77.
//
// Only the human owner approves a correction that loosens. A loosening that
// changes the required set is also a validation-scope change and needs that
// authority besides. The approval is of one exact proposal applied to one
// exact state: if the source moves between preview and answer the preview
// is stale, and if it moves between answer and effect the effect is
// invalidated and nothing is applied. (That a governed edit cannot be
// applied by an ordinary policy confirmation is rows M35 and M49.)

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer, answerAndHoldEffect, assertEffectInvalidated, assertQuestionClosed, assertStaleAnswer, consume, decision, nextGeneration, reject } from './harness/decisions.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { GOVERNED_FILE, assertApplied, assertNotApplied, assertProposalRejected, correction, reviewerApproves, scopeApproval, waitApplied } from './harness/gates.mjs';
import { addItem, permittedEdit, roleThat, runToEnd } from './harness/gitruns.mjs';
import { commitOnRef, refOid } from './harness/repos.mjs';
import { tick } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { contentAndSpecChange } from './harness/stale-correction.mjs';

const WIDER = '{"expect": [200, 500]}\n';
const head = (project) => refOid(project.repo.path, project.repo.ref);
const applied = (ctx, headBefore = ctx.headBefore) => assertApplied(ctx.fx, ctx.project, { proposal: ctx.proposal, previous: ctx.previous, headBefore, authority: 'human', changeKind: 'loosening' });

describe('M54 the check_correction_loosening manifest', () => {
  test('a Reviewer cannot approve a loosening; the human owner can, and exactly the bound proposal is applied', async (t) => {
    const ctx = await correction(t, 'loosening', { content: WIDER });
    const { fx, project, proposal, decision: previewed } = ctx;
    assert.deepEqual([proposal.status, previewed.manifest.proposal_status, previewed.manifest.classification], ['awaiting_human', 'awaiting_human', 'loosening']);

    await reviewerApproves(fx, project, proposal);
    await tick(fx.engine, project.id);
    assert.equal(assertNotApplied(fx, ctx, ctx.headBefore).status, 'awaiting_human', "the Reviewer's approval approved nothing");

    await consume(fx, project.id, decision(fx.home, previewed.id), 'approve');
    await waitApplied(fx, project, proposal);
    applied(ctx);
  });

  test('the source moves between preview and answer: the preview is stale, nothing is applied, and the next generation is bound to the new revision', async (t) => {
    const ctx = await correction(t, 'loosening', { content: WIDER });
    const { fx, project, proposal, decision: previewed } = ctx;
    const fix = await addItem(fx, project.id, 'fix');
    fx.scripted.script(fix, [roleThat([permittedEdit()])]);
    await runToEnd(fx, project.id, fix);
    const moved = head(project);

    await assertStaleAnswer(fx, project.id, previewed, 'approve');
    assertNotApplied(fx, ctx, moved);
    const next = await nextGeneration(fx, project.id, previewed, { changed: 'integration_revision' });
    await consume(fx, project.id, next, 'approve');
    await waitApplied(fx, project, proposal);
    applied(ctx, moved);
  });

  test('the integration branch is moved by hand after the answer and before the effect: the effect is invalidated and nothing is applied over the commit that is there', async (t) => {
    const ctx = await correction(t, 'loosening', { content: WIDER });
    const { fx, project, decision: previewed } = ctx;
    const held = await answerAndHoldEffect(fx, project.id, previewed, 'approve');
    const stray = commitOnRef(project.repo.path, project.repo.ref, { 'src/hotfix.js': 'export const hotfix = true;\n' }, { message: 'developer: a commit the engine did not make' });
    await assertEffectInvalidated(fx, previewed, held);
    assertNotApplied(fx, ctx, stray);
  });

  test('a loosening that changes the required set also needs the validation-scope authority: without it the approval is not on offer, with it the proposal is applied', async (t) => {
    const fewer = step.write(GOVERNED_FILE, '{"protected_paths": [".surety/checks/"], "required_checks": []}\n');
    const ctx = await correction(t, 'loosening', { steps: [fewer] });
    const { fx, project, proposal, decision: previewed } = ctx;
    const approve = (row) => row.options.find((option) => option.key === 'approve');
    assert.deepEqual([previewed.manifest.scope_approval, approve(previewed).blockers], [null, ['APPROVAL_MISSING']], 'the preview says what is missing');
    assertRefused(await answer(fx.engine, project.id, previewed, 'approve'), 409, 'illegal_transition', 'approving a required-set change that has no scope approval');
    assert.equal(assertNotApplied(fx, ctx, ctx.headBefore).status, 'awaiting_human');

    // The scope authority approves it: a baseline approval, installed as a fixture.
    await scopeApproval(fx.engine, project.id, proposal.id);
    const next = await nextGeneration(fx, project.id, previewed, { changed: 'scope_approval' });
    assert.deepEqual(approve(next).blockers, [], 'the approval is now on offer');
    await consume(fx, project.id, next, 'approve');
    await waitApplied(fx, project, proposal);
    applied(ctx);
  });

  // M2 slice 1, A3 (SEAM.md §101).
  test("the proposal's content, and then the approved specification, change between preview and answer: each refuses the earlier preview, applies nothing, and is a new generation that shows the change", async (t) => {
    await contentAndSpecChange(t, 'loosening', { content: WIDER });
  });

  // M2 slice 1, A4 (SEAM.md §102).
  test('reject: the proposal is rejected and nothing is applied, the decision is closed with the answer recorded, and the question is not raised again', async (t) => {
    const ctx = await correction(t, 'loosening', { content: WIDER });
    const { fx, project, decision: previewed } = ctx;
    assert.deepEqual(previewed.options.map((option) => option.key).sort(), ['approve', 'reject'], 'the fixture is live: the correction offers reject');

    await reject(fx, project.id, previewed);
    assertProposalRejected(fx, ctx);
    await assertQuestionClosed(fx, project.id, previewed);
    assertProposalRejected(fx, ctx);
  });
});
