// M137 (b), the cancellation canary's negatives, without a model (M2 slice
// 14, SANDBOX LANE, manifest slice 14). M2 plan §3.8 M137 (b); D2 §7.2; AR
// B04, T09; SEAM.md §§148, 149.
//
// The plan says these negatives are "established without a model in M135 (i)
// and by the engine's rule". M135 (i) is the containment canary's; no merged
// case makes a cancellation canary finish early or miss its barrier (the
// slice-13 not-claimed list: "`barrier_not_reached` ... has no sandbox-lane
// case"). This file is that case, in the sandbox lane: a `scripted`
// attempt (SEAM.md §148) whose cancellation canary's role either ends with
// its result and no barrier, or holds without writing it until the canary's
// deadline ends it. Each must fail `barrier_not_reached`, whatever usage it
// reported, and the attempt must write no entry. No model, no key, no
// network beyond the engine's proxy; nothing here writes outside the role's
// own result file, so no guarded instrument is used.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { approveAttempt, attemptFixture, canaryOf, canaryRuns, obeyingCanaries, qualify, scriptedBody, waitAttempt } from './harness/sandbox/qualify.mjs';
import { receiptOf, terminalObservation } from './harness/sandbox/lane.mjs';
import { step } from './harness/scripted.mjs';
import { trustEntries } from './harness/trust.mjs';

const USAGE = { input_tokens: 120, output_tokens: 40 };

describe('M137 (b) the cancellation canary fails barrier_not_reached when the backend finishes early or never reaches the barrier (sandbox lane, no model)', () => {
  test('(b) finishing early: a cancellation canary that reports usage and ends with its result, writing no barrier, fails barrier_not_reached; no entry; no later canary', async (t) => {
    const { fx, standIn, fixtureProject } = await attemptFixture(t);
    obeyingCanaries(fx, { cancellation: [{ steps: [step.usage(USAGE), step.canary('finish_early')] }] });
    const attempt = await qualify(fx, scriptedBody(standIn, fixtureProject));
    await approveAttempt(fx, fixtureProject, attempt.id);
    const done = await waitAttempt(fx.home, attempt.id, ['succeeded', 'failed', 'invalidated']);
    assert.equal(canaryOf(done, 'positive')?.passed, true, `the fixture is live: the positive canary passed (${JSON.stringify(done.canaries)})`);
    const k = canaryOf(done, 'cancellation');
    assert.deepEqual([done.status, k?.passed, k?.failure_class], ['failed', false, 'barrier_not_reached'], `a canary that finished without the barrier fails barrier_not_reached (D2 §7.2), whatever usage it reported (${JSON.stringify(k)})`);
    assert.equal(canaryOf(done, 'containment'), undefined, 'no later canary is dispatched (SEAM.md §148)');
    assert.equal(canaryRuns(fx.home, attempt.id).length, 2, 'two canary runs only');
    assert.equal(trustEntries(fx.home).filter((e) => e.qualification_attempt === attempt.id).length, 0, 'no entry');
  });

  test("(b) never reaching the barrier: a cancellation canary that reports usage and holds without writing it is ended at the canary's deadline and fails barrier_not_reached; no entry", async (t) => {
    const { fx, standIn, fixtureProject } = await attemptFixture(t);
    obeyingCanaries(fx, { cancellation: [{ steps: [step.usage(USAGE), step.hold('never')], on_term: 'exit' }] });
    const attempt = await qualify(fx, scriptedBody(standIn, fixtureProject, { canary_deadlines: { positive: 300, cancellation: 20, containment: 300 } }));
    await approveAttempt(fx, fixtureProject, attempt.id);
    const done = await waitAttempt(fx.home, attempt.id, ['succeeded', 'failed', 'invalidated'], { timeoutMs: 240_000 });
    assert.equal(canaryOf(done, 'positive')?.passed, true, `the fixture is live: the positive canary passed (${JSON.stringify(done.canaries)})`);
    const k = canaryOf(done, 'cancellation');
    assert.deepEqual([done.status, k?.passed, k?.failure_class], ['failed', false, 'barrier_not_reached'], `a canary that never reached the barrier before its deadline fails barrier_not_reached (${JSON.stringify(k)})`);
    assert.equal(terminalObservation(fx.home, receiptOf(fx.home, k.run).id)?.exit_class, 'engine_signaled', 'the engine ended it at the deadline');
    assert.equal(canaryOf(done, 'containment'), undefined, 'no later canary is dispatched');
    assert.equal(trustEntries(fx.home).filter((e) => e.qualification_attempt === attempt.id).length, 0, 'no entry');
  });
});
