// M37, applying an approved protected proposal (slice 5). Plan §3.4 M37; D1
// §§2.4, 7.9, 7.10, 9.3, D1-22, D1-35; RN R2, R4; E13; F §5.3; build spec §6
// corrections 14 and 17; SEAM.md §69.
//
// Only an authorized proposal is applied. The intended version is recorded,
// not authorized, before any git effect; while the application or its
// finalizer is pending, gates are blocked; the finalizer authorizes exactly
// one effective version and invalidates the evidence that depended on the
// old one. A candidate nominated before the change keeps its identity; the
// next nomination is a successor under the new version.
//
// This file takes the authorized Reviewer path through a normal application
// and the human tightening path through the two crashes. The provenance of
// each human path (tightening, loosening, unclassifiable) is asserted with
// the same judgement, `assertApplied`, in rows M53, M54 and M55. The
// classification is a fixture and says so: it qualifies no classifier.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer, openDecision, reachBarrier, untilKilled } from './harness/decisions.mjs';
import {
  PROTECTED_FILES,
  assertApplied,
  capturedProposal,
  check,
  checkResult,
  effectiveVersion,
  installChecks,
  nominated,
  passAll,
  protectedVersions,
  reasonCodes,
  reviewerApproves,
  stageGate,
  successor,
  waitApplied,
} from './harness/gates.mjs';
import { armBarrier, assertOperations, eventsOfType, journalBarrier } from './harness/journal.mjs';
import { refOid } from './harness/repos.mjs';
import { getRow, scriptedEngine, tick } from './harness/runs.mjs';

const LOGIN = check('login', { requirements: ['R1'] });

// A candidate whose stage gate is satisfied by one passing check, in a
// project with a protected set, and a tightening proposal captured after it.
async function proposalAfterPass(t) {
  const fx = await scriptedEngine(t);
  const ctx = await nominated(fx, { files: PROTECTED_FILES });
  const checks = await installChecks(fx.engine, ctx.project.id, [LOGIN]);
  const [result] = await passAll(fx.engine, ctx.project.id, ctx.candidate.id, [checks.id.login]);
  const evaluation = await stageGate(fx, ctx);
  assert.equal(evaluation.outcome, 'satisfied', `the fixture is live: the stage gate is satisfied (reasons: ${reasonCodes(evaluation).join(', ')})`);
  const previous = effectiveVersion(fx.home, ctx.project.id);
  const proposal = await capturedProposal(fx, ctx.project, { changeKind: 'tightening' });
  return { fx, ...ctx, result, evaluation, previous, proposal, headBefore: refOid(ctx.project.repo.path, ctx.project.repo.ref) };
}

const head = (ctx) => refOid(ctx.project.repo.path, ctx.project.repo.ref);

describe('M37 an approved protected proposal is applied through the journal', () => {
  test('authorized by a Reviewer: one protected commit, one new effective version, the old evidence invalidated, the old candidate as it was, and the next nomination under the new version', async (t) => {
    const ctx = await proposalAfterPass(t);
    const { fx, project, proposal, previous } = ctx;
    assert.equal(eventsOfType(fx.home, 'protected.classified').at(-1).payload.test_fixture, true, 'the classification is a fixture and is labelled as one');

    // Classified is not approved: ticks apply nothing.
    await tick(fx.engine, project.id);
    assert.deepEqual([effectiveVersion(fx.home, project.id).id, head(ctx)], [previous.id, ctx.headBefore], 'a proposal nobody has approved is not applied');

    await reviewerApproves(fx, project, proposal);
    await waitApplied(fx, project, proposal);
    const version = assertApplied(fx, project, { proposal, previous, headBefore: ctx.headBefore, authority: 'reviewer', changeKind: 'tightening' });
    assert.equal(eventsOfType(fx.home, 'protected.applied').length, 1, 'one protected.applied');

    // The evidence that depended on the old version.
    assert.ok(checkResult(fx.home, ctx.result.id).invalidated_at, 'the passing result recorded under the old version is invalidated');
    assert.equal(getRow(fx.home, 'gate_evaluations', ctx.evaluation.id).stale, 1, 'and the evaluation it satisfied is stale');
    const checks = await installChecks(fx.engine, project.id, [LOGIN]);
    assert.equal(checks.version, version.id, 'the fixture is live: the checks now declared are those of the new version');
    const again = await stageGate(fx, ctx);
    assert.equal(again.check_states[checks.id.login], 'stale', 'a result bound to another protected version is stale');
    assert.ok(reasonCodes(again).includes('CHECK_NOT_PASSED'), `the gate needs a new execution (reasons: ${reasonCodes(again).join(', ')})`);

    // The candidate nominated before the change is the candidate it was.
    assert.deepEqual(getRow(fx.home, 'candidates', ctx.candidate.id), ctx.candidate, 'the old candidate\'s row is unchanged');
    assert.equal(ctx.candidate.nominated_protected_version, previous.id, 'it keeps the version it was nominated under, as a historical fact');
    // Changed source nominates a successor, under the new version.
    const next = await successor(fx, ctx);
    assert.notEqual(next.id, ctx.candidate.id);
    assert.equal(next.nominated_protected_version, version.id, 'the next nomination is a new candidate under the new version');
  });

  test('the engine is killed before the application: the intended version is there, unauthorized, with no git effect; recovery applies the proposal once', async (t) => {
    const ctx = await proposalAfterPass(t);
    const { fx, project, proposal, previous } = ctx;
    const decision = await openDecision(fx, project.id, 'check_correction_tightening', proposal.id);
    await armBarrier(fx.engine, journalBarrier('commit_tree', 'intent_committed'), 'kill');
    answer(fx.engine, project.id, decision, 'approve').catch(() => null);
    await untilKilled(fx, project.id);

    const intended = protectedVersions(fx.home, project.id).filter((row) => row.proposal === proposal.id);
    assert.deepEqual(intended.map((row) => [row.authorized, row.effective_from]), [[0, null]], 'the intended version precedes the effect: it is recorded, and it is not authorized');
    assert.deepEqual([effectiveVersion(fx.home, project.id).id, head(ctx)], [previous.id, ctx.headBefore], 'the old version is still the effective one and git holds no effect');

    await fx.start();
    await waitApplied(fx, project, proposal);
    assertApplied(fx, project, { proposal, previous, headBefore: ctx.headBefore, authority: 'human', changeKind: 'tightening' });
    assert.equal(eventsOfType(fx.home, 'protected.applied').length, 1);
    assertOperations(fx.home, { project: project.id });
  });

  test('git has applied the proposal and the finalizer has not run: gates are blocked; killed there, recovery finalizes once, authorizes one version and invalidates the old evidence', async (t) => {
    const ctx = await proposalAfterPass(t);
    const { fx, project, proposal, previous } = ctx;
    const decision = await openDecision(fx, project.id, 'check_correction_tightening', proposal.id);
    const barrier = journalBarrier('ref_update', 'effect_applied');
    await armBarrier(fx.engine, barrier, 'pause');
    const pending = answer(fx.engine, project.id, decision, 'approve').catch((err) => err);
    await reachBarrier(fx, project.id, barrier);

    const applied = head(ctx);
    assert.notEqual(applied, ctx.headBefore, 'the fixture is live: the integration branch has moved');
    assert.equal(effectiveVersion(fx.home, project.id).id, previous.id, 'an applied tree is not an authorized version: the old one is still the effective one');
    const blocked = await stageGate(fx, ctx);
    assert.ok(reasonCodes(blocked).includes('GIT_JOURNAL_PENDING'), `while the application is not finalized the gate is blocked (reasons: ${reasonCodes(blocked).join(', ') || 'none'})`);

    await fx.engine.kill();
    await pending;
    await fx.start();
    await waitApplied(fx, project, proposal);
    assert.equal(head(ctx), applied, 'recovery did not apply the proposal a second time');
    assertApplied(fx, project, { proposal, previous, headBefore: ctx.headBefore, authority: 'human', changeKind: 'tightening' });
    assert.ok(checkResult(fx.home, ctx.result.id).invalidated_at, 'the finalizer invalidated the evidence of the old version');
    assert.equal(eventsOfType(fx.home, 'protected.applied').length, 1);
    assertOperations(fx.home, { project: project.id });
  });
});
