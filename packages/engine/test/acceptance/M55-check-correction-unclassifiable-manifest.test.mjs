// M55, the `check_correction_unclassifiable` manifest (slice 5). Plan §3.5
// M55; E13; D1 §7.9; RN §3 B12; build spec §6 correction 22; SEAM.md §§69,
// 76, 77.
//
// A correction the classifier cannot call strictly tightening goes to the
// human owner, under a decision kind of its own. The approval is of one
// proposal on one set of inputs: if its classification, its evidence or its
// base is replaced, the approval is refused or its effect is invalidated,
// and nothing is applied. It waives no check, and it is no permission to
// apply a later diff.
//
// The uncertain classification is a fixture: M1 has no classifier, and none
// is qualified here.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answerAndHoldEffect, approvalsOf, assertEffectInvalidated, assertStaleAnswer, consume, decision, decisionsOn, openDecision } from './harness/decisions.mjs';
import { PROPOSAL_RATIONALE, PROTECTED_FILES, assertApplied, assertNotApplied, capturedProposal, check, classify, correction, effectiveVersion, installChecks, nominated, passAll, reasonCodes, stageGate, waitApplied } from './harness/gates.mjs';
import { registerDetector, waitForPostScan } from './harness/records.mjs';
import { refOid } from './harness/repos.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';

const KIND = 'check_correction_unclassifiable';
const LOGIN = check('login', { requirements: ['R1'] });

describe('M55 the check_correction_unclassifiable manifest', () => {
  test('an unclassifiable correction goes to the human owner; the approval applies that proposal, waives no check, and applies no later diff', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await nominated(fx, { files: PROTECTED_FILES });
    const project = ctx.project;
    const before = await installChecks(fx.engine, project.id, [LOGIN]);
    await passAll(fx.engine, project.id, ctx.candidate.id, [before.id.login]);
    assert.equal((await stageGate(fx, ctx)).outcome, 'satisfied', 'the fixture is live: the stage gate is satisfied');
    const previous = effectiveVersion(fx.home, project.id);

    const proposal = await capturedProposal(fx, project, { changeKind: 'unclassifiable' });
    assert.equal(proposal.status, 'awaiting_human', 'uncertainty routes to the human');
    const previewed = await openDecision(fx, project.id, KIND, proposal.id);
    for (const other of ['check_correction_tightening', 'check_correction_loosening']) assert.equal(decisionsOn(fx.home, other, proposal.id).length, 0, `it is not offered as a ${other}`);
    const headBefore = refOid(project.repo.path, project.repo.ref);
    await consume(fx, project.id, previewed, 'approve');
    await waitApplied(fx, project, proposal);
    const version = assertApplied(fx, project, { proposal, previous, headBefore, authority: 'human', changeKind: 'unclassifiable' });
    assert.deepEqual(approvalsOf(fx.home, previewed.id).map((row) => [row.subject_id, row.result_hash]), [[proposal.id, proposal.diff_hash]], 'the approval is of that proposal and that diff');

    // The approval waived no check: the gate needs the check to pass under the new version.
    const after = await installChecks(fx.engine, project.id, [LOGIN]);
    const again = await stageGate(fx, ctx);
    assert.deepEqual([again.check_states[after.id.login], reasonCodes(again).includes('CHECK_NOT_PASSED')], ['stale', true]);

    // A later diff needs its own approval.
    const applied = refOid(project.repo.path, project.repo.ref);
    const later = await capturedProposal(fx, project, { changeKind: 'unclassifiable', content: '{"expect": "anything"}\n' });
    await tick(fx.engine, project.id);
    assertNotApplied(fx, { project, previous: version, proposal: later }, applied);
    const second = await openDecision(fx, project.id, KIND, later.id);
    assert.deepEqual([second.id !== previewed.id, approvalsOf(fx.home, second.id).length], [true, 0]);
  });

  test('the classification is replaced before the answer: the approval is refused with no effect, and the question is now the one of the new class', async (t) => {
    const ctx = await correction(t, 'unclassifiable');
    const { fx, project, proposal, decision: previewed } = ctx;
    await classify(fx.engine, proposal.id, 'loosening');

    await assertStaleAnswer(fx, project.id, previewed, 'approve');
    assertNotApplied(fx, ctx, ctx.headBefore);
    const now = await openDecision(fx, project.id, 'check_correction_loosening', proposal.id);
    assert.equal(now.manifest.classification, 'loosening');
    assert.equal(decision(fx.home, previewed.id).status, 'invalidated', 'the decision of the old class is closed');
  });

  test('the evidence is replaced after the answer and before the effect: the effect is invalidated and nothing is applied', async (t) => {
    const ctx = await correction(t, 'unclassifiable');
    const { fx, project, proposal, decision: previewed } = ctx;
    await waitForPostScan(fx.home, proposal.rationale, 'clean');
    const held = await answerAndHoldEffect(fx, project.id, previewed, 'approve');
    // A detector registered now matches the proposal's rationale: the evidence the approval was given on is quarantined.
    await registerDetector(fx.engine, 'fixture-rationale', PROPOSAL_RATIONALE);
    await waitForPostScan(fx.home, proposal.rationale, 'hit');
    await assertEffectInvalidated(fx, previewed, held);
    assertNotApplied(fx, ctx, ctx.headBefore);
  });
});
