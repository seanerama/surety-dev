// M57, own consumption versus external preconditions (slice 5). Plan §3.5
// M57; D1 §10.5, D1-04, D1-15; RN §3 B12; build spec §6 correction 22;
// Review B12; SEAM.md §76.
//
// Consuming a decision changes rows the decision was bound to: approving a
// correction moves its proposal from awaiting the human to approved. An
// effect intent therefore binds the state as it is after that consumption,
// and its own consumption does not invalidate it. A change that is not its
// own (here, a policy change between consumption and dispatch) does: the
// effect never runs and the approval stays with the decision it was given
// on. What was performed is what the consumed option's plan said, down to
// the actor and the resources.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answerAndHoldEffect, approvalsOf, assertEffectDone, assertEffectInvalidated, decision, openDecision } from './harness/decisions.mjs';
import { assertApplied, assertNotApplied, correction, proposalsOf, waitApplied } from './harness/gates.mjs';
import { changePolicy, operationDetail } from './harness/journal.mjs';
import { refOid, treeOf } from './harness/repos.mjs';

const KIND = 'check_correction_loosening';
const loosening = (t) => correction(t, 'loosening', { content: '{"expect": [200, 500]}\n' });

describe('M57 an effect and the changes around it', () => {
  test('the consumption changes a status the decision was bound to, and the effect still runs: its intent binds the state after its own consumption, and what is performed is what the plan said', async (t) => {
    const ctx = await loosening(t);
    const { fx, project, proposal, decision: previewed } = ctx;
    assert.equal(previewed.manifest.proposal_status, 'awaiting_human', 'the preview is bound to a proposal that awaits the human');
    const plan = previewed.options.find((option) => option.key === 'approve').effect_plan;
    assert.deepEqual({ proposal: plan.proposal, tree: plan.tree, ref: plan.ref }, { proposal: proposal.id, tree: proposal.tree_id, ref: project.repo.ref }, 'the plan names what will be applied and where');

    const held = await answerAndHoldEffect(fx, project.id, previewed, 'approve');
    assert.equal(proposalsOf(fx.home, project.id)[0].status, 'approved', 'the consumption itself moved the proposal to approved');
    assert.equal(held.intent.preconditions.proposal_status, 'approved', 'and the intent expects that state, not the one the preview showed');

    const intent = await assertEffectDone(fx, previewed, held);
    await waitApplied(fx, project, proposal);
    const version = assertApplied(fx, project, { proposal, previous: ctx.previous, headBefore: ctx.headBefore, authority: 'human', changeKind: 'loosening' });

    // The performed consequence is the recorded plan: the tree, the ref, the operation and the actor.
    const head = refOid(project.repo.path, project.repo.ref);
    assert.equal(treeOf(project.repo.path, head), plan.tree, 'the commit on the planned ref holds the planned tree');
    const operation = operationDetail(fx.home, intent.operation);
    assert.equal(operation.status, 'succeeded', 'the operation the intent names is the one that was made');
    assert.ok(operation.payload.tree === plan.tree || operation.payload.ref === plan.ref, `it is the planned operation (its intent: ${JSON.stringify(operation.payload)})`);
    const actor = decision(fx.home, previewed.id).answer.actor;
    assert.ok(typeof actor === 'string' && actor.length > 0, 'the answer names its actor');
    assert.deepEqual([approvalsOf(fx.home, previewed.id).map((row) => row.actor), version.approved_by], [[actor], actor], 'the approval and the version name the actor who answered');
  });

  test('an unrelated policy change between consumption and dispatch invalidates the effect: nothing is applied, and the approval is not transferred', async (t) => {
    const ctx = await loosening(t);
    const { fx, project, proposal, decision: previewed } = ctx;
    const held = await answerAndHoldEffect(fx, project.id, previewed, 'approve');
    await changePolicy(fx.engine, project.id, { deadline_reviewer: 600 });
    const moved = refOid(project.repo.path, project.repo.ref);

    await assertEffectInvalidated(fx, previewed, held);
    assert.equal(assertNotApplied(fx, ctx, moved).status, 'awaiting_human', 'the proposal awaits the human again');
    const next = await openDecision(fx, project.id, KIND, proposal.id);
    assert.deepEqual([next.id !== previewed.id, approvalsOf(fx.home, next.id).length, approvalsOf(fx.home, previewed.id).length], [true, 0, 1], 'the approval stays with the decision it was given on');
  });
});
