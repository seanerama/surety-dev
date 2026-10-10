// M327, the preempting teardown (slice 27; kernel lane); D4-O13's
// preemption during verification (deferred by slice 26) as (b); and M318
// (a)'s preempting form (deferred by slice 25). M4 plan §3.5 M327, §3.3
// M318, §3.4 M325; D4-O10, D4-O13, D4-V08; D4 §§2.4, 4.5, 4.6, 4.7; RV4;
// E111, E114, E115; SEAM.md §§247, 250, 274, 276, 295, 296, 298.
//
// On the scripted deployment adapter. `POST …/teardown {"preempt": true}`
// (SEAM.md §296); in its transaction, before any host call: every launch of
// the environment closed, the lease passed to the teardown with a higher
// generation, pending executions of an open round cancelled and the round
// recorded `unknown` naming them, the deploy the teardown's `linked_prior`,
// `deploy.preempted`. Then the teardown stops only positively owned units.
//   (a) a deploy attempt held `ambiguous` by a `conflicting` read, and by
//       an `unknown` one: the deploy `superseded`, its attempt as it was;
//   (b) a confirmed deploy waiting in verification (D4-O13);
//   (c) a deploy whose effect call is in flight: cancelled and awaited, the
//       teardown's effect only after it, well before the call's deadline;
//   (d) a prefixed unit no intent names, and the attempt's unit with a
//       cgroup other than the one recorded: listed, untouched, never named
//       by the teardown's capability;
// (e), the manager unreadable, is the sandbox file's.
// M318 (a), the preempting form: a round's check result arriving after a
// preempting teardown and a newer generation changes nothing: no row of
// the older operation is verified and current, it writes neither
// last_verified nor attempted, alpha_complete refuses it, and its rows stay
// as history (SEAM.md §298 reading 5).
//
// SAFETY: no unit, no systemctl, no host process; nothing is signalled.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { stepExecution } from './harness/checks/selection.mjs';
import { waitFor } from './harness/engine.mjs';
import { requestTick, scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { adapterState, attemptsOf, candidateRow, deploy, deployable, deployToRound, effectCalls, environmentLeases, environmentRecord, operationRow, operationsOf, postDeployExecutions, scriptCall, setTarget, unitName } from './harness/deploy/kernel.mjs';
import { completion, executionsOfRound, reasonCodesOf, recordExit, roundRow, roundsOf, rowOf, verificationsOf } from './harness/deploy/rounds.mjs';
import { atReceipt, firstRead, inventoryOf, openDecisionOn, openOn, scriptedUnit } from './harness/deploy/recover.mjs';
import { assertPreemption, preempt } from './harness/deploy/observe.mjs';

const heldLease = (home, env) => environmentLeases(home, env).find((l) => l.released_at === null);
const requestDeploy = (ctx) => () => deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
const finalized = (ctx, id) => tickUntil(ctx.fx.engine, ctx.project, () => (operationRow(ctx.fx.home, id)?.finalized_at ? operationRow(ctx.fx.home, id) : undefined), { max: 20, what: `the teardown ${id} to be finalized` });
const teardownCaps = async (ctx) => effectCalls(await adapterState(ctx.fx.engine, ctx.env.id), 'teardown').map((c) => c.capability?.stop_units ?? []);

// A deploy whose attempt is ambiguous after `change` was applied to the target at its receipt.
async function ambiguous(t, change) {
  const fx = await scriptedEngine(t);
  const ctx = await deployable(fx);
  await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }]);
  const op = await atReceipt(ctx, 'deploy', requestDeploy(ctx), change);
  const a = await firstRead(ctx, op.id);
  await openDecisionOn(ctx, 'blocker', op.id);
  assert.equal(attemptsOf(fx.home, op.id)[0].status, 'ambiguous', `the fixture is live: the attempt is ambiguous (${a.status})`);
  return { ...ctx, op };
}

// What every preemption of a deploy with an attempt reads afterwards.
async function assertSuperseded(ctx, op, attemptsBefore) {
  const after = operationRow(ctx.fx.home, op.id);
  assert.equal(after.status, 'superseded', `the preempted deploy is superseded (D1 A.5; D4 §4.6) (${after.status})`);
  assert.deepEqual(
    attemptsOf(ctx.fx.home, op.id).map((a) => [a.status, a.reconciliation_reads]),
    attemptsBefore.map((a) => [a.status, a.reconciliation_reads]),
    'its attempts are kept as they were, never relabelled succeeded or absent',
  );
  assert.deepEqual(openOn(ctx.fx.home, 'blocker', op.id), [], 'no blocker on the preempted deploy is left open');
}

describe('M327 (a) a deploy attempt held ambiguous', () => {
  for (const [kind, change, restore] of [
    ['conflicting (its unit\'s tree differs)', (target) => ({ ...target, units: target.units.map((u) => ({ ...u, tree: `sha256:${'d'.repeat(64)}` })) }), null],
    ['unknown (an incomplete inventory)', (target) => ({ ...target, complete: false }), (target) => ({ ...target, complete: true })],
  ]) {
    test(`${kind}: preempted, every launch closed, the lease passed, the deploy superseded with its attempt as it was; the teardown stops exactly the attempt's unit`, async (t) => {
      const ctx = await ambiguous(t, change);
      const { fx, env, op } = ctx;
      const leaseBefore = heldLease(fx.home, env.id);
      const attemptsBefore = attemptsOf(fx.home, op.id);
      await scriptCall(fx.engine, env.id, 'teardown', [{ result: 'issued', apply: true }]);
      const teardownId = await preempt(fx.engine, ctx.project, env.name);
      assertPreemption(ctx, { deploy: op, teardownId, leaseBefore });
      // The unknown case: the target readable again after the preemption, so the teardown's read can settle.
      if (restore) await setTarget(fx.engine, env.id, restore((await adapterState(fx.engine, env.id)).target));
      const td = await finalized(ctx, teardownId);
      await assertSuperseded(ctx, op, attemptsBefore);
      assert.deepEqual(await teardownCaps(ctx), [[unitName(fx.home, env.id, 1)]], 'the teardown\'s capability names exactly the attempt\'s unit');
      assert.equal(attemptsOf(fx.home, td.id)[0]?.status, 'succeeded', 'the teardown is reconciled applied');
      assert.deepEqual((await adapterState(fx.engine, env.id)).target.units, [], 'nothing of the environment is left');
    });
  }
});

describe('M327 (b) a confirmed deploy waiting in verification (D4-O13, deferred by slice 26)', () => {
  test('its queued check cancelled, its open round recorded unknown naming it, the lease passed, the deploy superseded with its attempt succeeded as it was; nothing verified', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    const { operation: op, execution } = await deployToRound(ctx);
    const [round] = roundsOf(fx.home, op.id);
    const leaseBefore = heldLease(fx.home, ctx.env.id);
    const attemptsBefore = attemptsOf(fx.home, op.id);
    assert.equal(attemptsBefore[0].status, 'succeeded', 'the fixture is live: the effect is confirmed');
    await scriptCall(fx.engine, ctx.env.id, 'teardown', [{ result: 'issued', apply: true }]);
    const teardownId = await preempt(fx.engine, ctx.project, ctx.env.name);
    assertPreemption(ctx, { deploy: op, teardownId, leaseBefore });
    const [x] = executionsOfRound(fx.home, ctx.candidate.id, round.id);
    assert.equal(x.status, 'cancelled', `the pending verification execution is cancelled (${x.status})`);
    const row = rowOf(fx.home, round.id);
    assert.equal(roundRow(fx.home, round.id).status, 'decided', 'the open round is decided');
    assert.equal(row?.outcome, 'unknown', `recorded unknown (${row?.outcome})`);
    assert.ok((row.missing ?? []).some((m) => m.id === execution.id), `naming the cancelled execution (${JSON.stringify(row.missing)})`);
    await finalized(ctx, teardownId);
    await assertSuperseded(ctx, op, attemptsBefore);
    assert.equal(environmentRecord(fx.home, ctx.env.id).last_verified ?? null, null, 'nothing is verified');
    assert.equal(candidateRow(fx.home, ctx.candidate.id).progress, 'developing');
  });
});

describe('M327 (c) an adapter call in flight', () => {
  test('the deploy\'s effect call hanging: cancelled and awaited, the teardown\'s effect made after it and well before the call\'s deadline; the deploy\'s attempt never succeeded or absent', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true, hang: true }]);
    await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    // A tick that makes the hanging call may not end until the call does, so the call is waited for by polling, not by ticks.
    await requestTick(fx.engine, ctx.project);
    await waitFor(async () => effectCalls(await adapterState(fx.engine, ctx.env.id), 'deploy').length === 1, { timeoutMs: 60_000, what: 'the deploy\'s effect call to be made' });
    const [op] = operationsOf(fx.home, ctx.project, 'deploy');
    const leaseBefore = heldLease(fx.home, ctx.env.id);
    await scriptCall(fx.engine, ctx.env.id, 'teardown', [{ result: 'issued', apply: true }]);
    const asked = Date.now();
    const teardownId = await preempt(fx.engine, ctx.project, ctx.env.name);
    assertPreemption(ctx, { deploy: op, teardownId, leaseBefore });
    await finalized(ctx, teardownId);
    const state = await adapterState(fx.engine, ctx.env.id);
    const [deployCall] = effectCalls(state, 'deploy');
    const [teardownCall] = effectCalls(state, 'teardown');
    assert.ok(teardownCall && Date.parse(teardownCall.at) >= Date.parse(deployCall.at), 'the teardown\'s effect comes after the deploy\'s call');
    assert.ok(Date.parse(teardownCall.at) - asked < 60_000, `the in-flight call was cancelled, not left to its 120 s deadline (${Date.parse(teardownCall.at) - asked} ms)`);
    assert.equal(operationRow(fx.home, op.id).status, 'superseded');
    for (const a of attemptsOf(fx.home, op.id)) assert.ok(!['succeeded', 'reconciled_succeeded', 'reconciled_absent'].includes(a.status), `the attempt is never relabelled succeeded or absent (${a.status})`);
    assert.deepEqual(effectCalls(state, 'teardown').map((c) => c.capability?.stop_units), [[unitName(fx.home, ctx.env.id, 1)]], 'the teardown stops exactly the attempt\'s unit');
  });
});

describe('M327 (d) units the store does not positively own', () => {
  test('a prefixed unit no intent names, and the attempt\'s unit under another cgroup: listed, left with a reason, untouched, never in a capability', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx0 = await deployable(fx);
    await scriptCall(fx.engine, ctx0.env.id, 'deploy', [{ result: 'issued', apply: true }]);
    const strayUnit = scriptedUnit(unitName(fx.home, ctx0.env.id, 7), 7);
    const op = await atReceipt(ctx0, 'deploy', requestDeploy(ctx0), (target) => ({
      ...target,
      units: [...target.units.map((u) => ({ ...u, cgroup: `/user.slice/app.slice/other-${u.name}` })), strayUnit],
    }));
    await firstRead(ctx0, op.id);
    await openDecisionOn(ctx0, 'blocker', op.id);
    const ctx = { ...ctx0, op };
    const before = (await adapterState(fx.engine, ctx.env.id)).target.units;
    await scriptCall(fx.engine, ctx.env.id, 'teardown', [{ result: 'issued', apply: true }]);
    const teardownId = await preempt(fx.engine, ctx.project, ctx.env.name);
    const td = await tickUntil(fx.engine, ctx.project, () => attemptsOf(fx.home, teardownId)[0]?.reconciliation_reads?.[0] ? attemptsOf(fx.home, teardownId)[0] : undefined, { max: 16, what: 'the teardown\'s read' });
    const g1 = unitName(fx.home, ctx.env.id, 1);
    for (const stopUnits of await teardownCaps(ctx)) assert.ok(!stopUnits.includes(g1) && !stopUnits.includes(strayUnit.name), `no capability names a unit the store does not positively own (${JSON.stringify(stopUnits)})`);
    assert.deepEqual((await adapterState(fx.engine, ctx.env.id)).target.units, before, 'both units are untouched');
    assert.notEqual(td.reconciliation_reads[0].result, 'applied', `the teardown is not applied (${td.reconciliation_reads[0].result})`);
    const listed = inventoryOf(td.reconciliation_reads[0]);
    assert.ok(listed.includes(g1) && listed.includes(strayUnit.name), `both are listed in the teardown's read (${JSON.stringify(listed)})`);
    const left = (environmentRecord(fx.home, ctx.env.id).attempted?.cleanup?.left ?? []).map((l) => l.resource);
    assert.ok(left.includes(g1) && left.includes(strayUnit.name), `and left, with a reason, on the cleanup record (SEAM.md §295) (${JSON.stringify(environmentRecord(fx.home, ctx.env.id).attempted)})`);
  });
});

describe('M318 (a), the preempting form (deferred by slice 25)', () => {
  test('operation 1\'s check result arriving after a preempting teardown and generation 2: no row of operation 1 verified and current, neither last_verified nor attempted written by it, alpha_complete refused, its rows kept', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    const { operation: op1, execution: x1 } = await deployToRound(ctx);
    await stepExecution(fx.engine, x1.id, 'materializing');
    await stepExecution(fx.engine, x1.id, 'running');
    await scriptCall(fx.engine, ctx.env.id, 'teardown', [{ result: 'issued', apply: true }]);
    const teardownId = await preempt(fx.engine, ctx.project, ctx.env.name);
    await finalized(ctx, teardownId);

    // Generation 2: a new request after the teardown.
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }]);
    await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    const x2 = await tickUntil(fx.engine, ctx.project, () => postDeployExecutions(fx.home, ctx.candidate.id).find((x) => x.deployment?.operation !== op1.id), { max: 16, what: 'operation 2\'s round' });
    await recordExit(fx.engine, x2.id, 1);
    await tick(fx.engine, ctx.project, { rounds: 3 });
    const current = environmentRecord(fx.home, ctx.env.id);
    assert.ok(current.attempted?.generation > 1, `the fixture is live: a newer generation is current (${JSON.stringify(current.attempted)})`);

    // The older operation's delayed callback: its check's result now (accepted or refused, it changes nothing).
    await fx.engine.post('/v1/harness/fixtures/check-execution', { execution: x1.id, to: 'collecting' });
    await fx.engine.post('/v1/harness/fixtures/check-execution', { execution: x1.id, to: 'recorded', exit_status: 0 });
    await tick(fx.engine, ctx.project, { rounds: 3 });

    const rows = roundsOf(fx.home, op1.id).flatMap((r) => verificationsOf(fx.home, r.id));
    assert.ok(rows.length >= 1, 'operation 1\'s rows are kept as history');
    for (const row of rows) assert.ok(row.outcome !== 'verified' || row.invalidated_reason === 'generation_superseded', `no row of operation 1 is a verified row of the current generation (${row.outcome}, ${row.invalidated_reason})`);
    const record = environmentRecord(fx.home, ctx.env.id);
    assert.ok(!roundsOf(fx.home, op1.id).some((r) => r.id === record.last_verified?.round), 'last_verified is never operation 1\'s');
    assert.notEqual(record.attempted?.operation, op1.id, 'attempted is never operation 1\'s');
    const late = await completion(fx.engine, ctx.project, ctx.candidate.id, op1.id);
    assert.equal(late.outcome, 'not_satisfied');
    assert.ok(reasonCodesOf(late).some((c) => ['DEPLOY_GENERATION_SUPERSEDED', 'DEPLOY_VERIFICATION_UNKNOWN'].includes(c)), `alpha_complete refuses operation 1 (${JSON.stringify(late.reasons)})`);
    assert.equal(candidateRow(fx.home, ctx.candidate.id).progress, 'developing');
  });
});
