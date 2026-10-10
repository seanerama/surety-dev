// M320, reconcile outcomes from the target (slice 26). M4 plan §3.4 M320;
// D4-A03, D4-A04; D4 §2.4; E111; SEAM.md §§247, 250, 255, 273 to 276.
//
// Kernel lane, on the scripted deployment adapter. Each target state of
// D4 §2.4's table, for a deploy and for a teardown, set on the scripted
// target at `deploy.receipt_recorded` (after the effect, before its read),
// maps to exactly one outcome, `unknown` and then `conflicting` taking
// precedence, beside a successful-read control; and each outcome takes its
// way on: `applied` finalizes, `absent` permits a retry, `partial` raises
// `rollout_partial`, `conflicting` and `unknown` raise a blocker naming what
// was read, are read again at every tick, are never retried, and hold the
// lease. No success predicate rests on a failed query's empty result. After
// a restart that loses the adapter's memory, with the receipt never recorded
// or false, the read is the target's, its inventory included. The prefix
// listing is a read: an unrecorded unit is listed and nothing stops it.
//
// Pinned elsewhere and not repeated (COVERAGE.md "M4 slice 26"): the
// teardown's `partial` (an owned socket and a populated cgroup left) and its
// `conflicting` (an extra prefixed unit, every recorded unit unchanged), and
// an unread required resource (`unknown`), are M304's S3 cases (slice 23's
// review). The sandbox file M320-reconcile-on-a-real-unit reads (c) on a
// real unit with the manager unreadable.
//
// SAFETY: no unit, no systemctl, no host process. The only process
// signalled is the test's own engine, by itself at a barrier (SEAM.md §274).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import {
  adapterState,
  attemptIntent,
  attemptsOf,
  completeRound,
  deploy,
  deployToRound,
  deployable,
  effectCalls,
  environmentRecord,
  operationsOf,
  operationsRead,
  roundsOf,
  scriptCall,
  setTarget,
  teardown,
  unitName,
} from './harness/deploy/kernel.mjs';
import { atReceipt, attemptWhen, firstRead, inventoryOf, killAt, leaseHeld, openDecisionOn, openOn, optionKeys, readsOf, scriptedUnit, unitsNamedIn } from './harness/deploy/recover.mjs';

// A deployment of generation 1 verified and complete, so the lease is free
// for the next operation (as M304's S3 cases do).
async function deployedAndComplete(t) {
  const fx = await scriptedEngine(t);
  const ctx = await deployable(fx);
  const { execution } = await deployToRound(ctx);
  await completeRound(ctx, execution);
  await tick(fx.engine, ctx.project, { rounds: 2 });
  return ctx;
}

const requestTeardown = async (ctx) => {
  const res = await teardown(ctx.fx.engine, ctx.project, ctx.env.name);
  assert.ok(res.status >= 200 && res.status < 300, `the teardown is accepted (→ ${res.status} ${res.text})`);
};

const requestDeploy = (ctx) => () => deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);

// The way on of an outcome that blocks (D4 §2.4): the attempt ambiguous, an
// open blocker on the operation naming the outcome, the read made again at
// later ticks, no retry, the lease held.
async function assertBlocks(ctx, op, outcome) {
  const { fx, project, env } = ctx;
  const blocker = await openDecisionOn(ctx, 'blocker', op);
  assert.ok(`${JSON.stringify(blocker.manifest)} ${blocker.question}`.includes(outcome), `the blocker names what was read, ${outcome} (SEAM.md §276) (${JSON.stringify(blocker.manifest)})`);
  const reconcilesBefore = effectCalls(await adapterState(fx.engine, env.id), 'reconcile').length;
  const deploysBefore = effectCalls(await adapterState(fx.engine, env.id), 'deploy').length;
  await tick(fx.engine, project, { rounds: 3 });
  const state = await adapterState(fx.engine, env.id);
  assert.ok(effectCalls(state, 'reconcile').length > reconcilesBefore, 'the target is read again at later ticks (D4 §2.4: reread each tick)');
  assert.equal(effectCalls(state, 'deploy').length, deploysBefore, 'never retried: no further deploy effect call');
  assert.equal(attemptsOf(fx.home, op).length, 1, 'no new attempt');
  assert.equal(attemptsOf(fx.home, op)[0].status, 'ambiguous', 'the attempt stays ambiguous');
  assert.ok(leaseHeld(fx.home, env.id), 'the environment lease stays held');
}

describe('M320 (a), (f) the deploy column of D4 §2.4, each outcome with its way on', () => {
  test('control: applied — the attempt succeeded, confirmed and finalized, with one round', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    const { operation } = await deployToRound(ctx);
    const [a] = attemptsOf(fx.home, operation.id);
    assert.deepEqual([a.status, readsOf(a)], ['succeeded', ['applied']], `applied finalizes (${JSON.stringify(readsOf(a))})`);
    const journal = (await operationsRead(fx.engine, ctx.project)).find((o) => o.id === operation.id).journal.map((e) => e.event_kind);
    assert.deepEqual(journal, ['intended', 'applied', 'confirmed', 'finalized'], 'confirmed and finalized');
    assert.equal(roundsOf(fx.home, operation.id).length, 1, 'one round');
  });

  test('absent: reconciled_absent, then a new attempt with a new generation and its own frozen intent', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued' }, { result: 'issued', apply: true }]);
    await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    const op = await tickUntil(fx.engine, ctx.project, () => operationsOf(fx.home, ctx.project, 'deploy')[0], { what: 'the deploy to be intended' });
    const a2 = await attemptWhen(ctx, op.id, 2, (a) => !['started', 'ambiguous'].includes(a.status), 'the second attempt to settle');
    const [a1] = attemptsOf(fx.home, op.id);
    assert.deepEqual([a1.status, readsOf(a1)], ['reconciled_absent', ['absent']], `nothing applied and nothing else there: absent (${JSON.stringify(readsOf(a1))})`);
    assert.deepEqual([a1.deployment_generation, a2.deployment_generation], [1, 2], 'the retry has a new generation');
    assert.deepEqual([attemptIntent(fx.home, a1.id).create_units, attemptIntent(fx.home, a2.id).create_units], [[unitName(fx.home, ctx.env.id, 1)], [unitName(fx.home, ctx.env.id, 2)]], 'each attempt has its own frozen intent');
    assert.equal(a2.status, 'succeeded');
  });

  test('partial (the prior stopped and g absent): reconciled_partial, a rollout_partial decision offering retry, teardown and abandon, and no new attempt', async (t) => {
    const ctx = await deployedAndComplete(t);
    const { fx, env } = ctx;
    await scriptCall(fx.engine, env.id, 'deploy', [{ result: 'issued' }, { result: 'issued', apply: true }]);
    const op = await atReceipt(ctx, 'deploy', requestDeploy(ctx), (target) => ({ ...target, units: [] }));
    const a = await firstRead(ctx, op.id);
    assert.equal(readsOf(a)[0], 'partial', `the prior gone and g absent is partial (D4 §2.4) (${JSON.stringify(readsOf(a))})`);
    const row = await openDecisionOn(ctx, 'rollout_partial', op.id);
    assert.deepEqual(optionKeys(row), ['abandon', 'retry', 'teardown'], 'the decision offers retry, teardown and abandon, and no rollback (D4 §4.4; Q8)');
    await tick(fx.engine, ctx.project, { rounds: 3 });
    assert.equal(attemptsOf(fx.home, op.id).length, 1, 'no new attempt without the human\'s answer');
    assert.equal(attemptsOf(fx.home, op.id)[0].status, 'reconciled_partial');
    assert.equal(effectCalls(await adapterState(fx.engine, env.id), 'deploy').length, 2, 'one deploy call for generation 1 and one for this attempt, none more');
  });

  test('conflicting (g active with a tree that differs): ambiguous, a blocker naming conflicting, read again each tick, never retried, the lease held', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }, { result: 'issued', apply: true }]);
    const op = await atReceipt(ctx, 'deploy', requestDeploy(ctx), (target) => ({ ...target, units: target.units.map((u) => ({ ...u, tree: `sha256:${'d'.repeat(64)}` })) }));
    const a = await firstRead(ctx, op.id);
    assert.equal(readsOf(a)[0], 'conflicting', `g active with an identity that differs is conflicting (${JSON.stringify(readsOf(a))})`);
    await assertBlocks(ctx, op.id, 'conflicting');
  });

  test('unknown (an incomplete inventory): ambiguous, a blocker naming unknown, read again each tick, never retried, the lease held', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }, { result: 'issued', apply: true }]);
    const op = await atReceipt(ctx, 'deploy', requestDeploy(ctx), (target) => ({ ...target, complete: false }));
    const a = await firstRead(ctx, op.id);
    assert.equal(readsOf(a)[0], 'unknown', `an incomplete inventory is unknown, which takes precedence over applied (${JSON.stringify(readsOf(a))})`);
    await assertBlocks(ctx, op.id, 'unknown');
  });
});

describe('M320 (a) the teardown column of D4 §2.4', () => {
  test('control: applied — closure and removal of everything it covers; attempted teardown_applied', async (t) => {
    const ctx = await deployedAndComplete(t);
    await scriptCall(ctx.fx.engine, ctx.env.id, 'teardown', [{ result: 'issued', apply: true }]);
    const op = await atReceipt(ctx, 'teardown', () => requestTeardown(ctx), (target) => target);
    const a = await firstRead(ctx, op.id);
    assert.equal(readsOf(a)[0], 'applied');
    await tickUntil(ctx.fx.engine, ctx.project, () => environmentRecord(ctx.fx.home, ctx.env.id).attempted?.outcome === 'teardown_applied' || undefined, { what: 'attempted teardown_applied' });
  });

  test('absent: the whole frozen pre-state unchanged (nothing stopped) is absent, never applied', async (t) => {
    const ctx = await deployedAndComplete(t);
    await scriptCall(ctx.fx.engine, ctx.env.id, 'teardown', [{ result: 'issued' }]);
    const op = await atReceipt(ctx, 'teardown', () => requestTeardown(ctx), (target) => target);
    const a = await firstRead(ctx, op.id);
    assert.equal(readsOf(a)[0], 'absent', `every unit it stops still active: absent (D4 §2.4) (${JSON.stringify(readsOf(a))})`);
    assert.notEqual(a.status, 'succeeded');
  });

  test('unknown: an owned unit whose state was not read is unknown, never applied', async (t) => {
    const ctx = await deployedAndComplete(t);
    await scriptCall(ctx.fx.engine, ctx.env.id, 'teardown', [{ result: 'issued' }]);
    const op = await atReceipt(ctx, 'teardown', () => requestTeardown(ctx), (target) => ({ ...target, units: target.units.map((u) => ({ ...u, state: 'unread' })) }));
    const a = await firstRead(ctx, op.id);
    assert.equal(readsOf(a)[0], 'unknown', `${JSON.stringify(readsOf(a))}`);
    assert.notEqual(a.status, 'succeeded');
  });
});

describe('M320 (b) an unexpected active generation with the prior intact', () => {
  test('a deploy of g2 that changed nothing, with g1 (its prior) intact and an active g7 no intent names: conflicting, never absent, and never retried', async (t) => {
    const ctx = await deployedAndComplete(t);
    const { fx, env } = ctx;
    await scriptCall(fx.engine, env.id, 'deploy', [{ result: 'issued' }, { result: 'issued', apply: true }]);
    const g7 = scriptedUnit(unitName(fx.home, env.id, 7), 7);
    const op = await atReceipt(ctx, 'deploy', requestDeploy(ctx), (target) => ({ ...target, units: [...target.units, g7] }));
    const a = await firstRead(ctx, op.id);
    assert.ok(a.capability?.prior?.some((p) => p.unit === unitName(fx.home, env.id, 1)), 'the fixture is live: g1 is the attempt\'s frozen prior');
    assert.equal(readsOf(a)[0], 'conflicting', `an active unit of a generation the intent does not name, whether or not prior is intact, is conflicting (D4 §2.4) (${JSON.stringify(readsOf(a))})`);
    await tick(fx.engine, ctx.project, { rounds: 3 });
    assert.equal(attemptsOf(fx.home, op.id).length, 1, 'never retried');
    assert.ok(!readsOf(attemptsOf(fx.home, op.id)[0]).includes('absent'), 'never absent');
  });
});

describe('M320 (c) no success predicate uses a failed query\'s empty result', () => {
  test('a teardown whose inventory query failed and returned nothing: unknown, never applied; a complete read then settles it', async (t) => {
    const ctx = await deployedAndComplete(t);
    await scriptCall(ctx.fx.engine, ctx.env.id, 'teardown', [{ result: 'issued', apply: true }]);
    const op = await atReceipt(ctx, 'teardown', () => requestTeardown(ctx), () => ({ complete: false, units: [], resources: [] }));
    const a = await firstRead(ctx, op.id);
    assert.equal(readsOf(a)[0], 'unknown', `an empty result from an incomplete query is unknown (${JSON.stringify(readsOf(a))})`);
    assert.notEqual(a.status, 'succeeded');
    await setTarget(ctx.fx.engine, ctx.env.id, { complete: true, units: [], resources: [] });
    const settled = await attemptWhen(ctx, op.id, 1, (x) => readsOf(x).includes('applied'), 'a complete read to settle the teardown');
    assert.equal(settled.status, 'reconciled_succeeded', 'applied only from a complete read');
  });

  test('a deploy whose inventory query failed and returned nothing: unknown, never absent, and no retry until a complete read', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued' }, { result: 'issued', apply: true }]);
    const op = await atReceipt(ctx, 'deploy', requestDeploy(ctx), () => ({ complete: false, units: [], resources: [] }));
    const a = await firstRead(ctx, op.id);
    assert.equal(readsOf(a)[0], 'unknown', `${JSON.stringify(readsOf(a))}`);
    await tick(fx.engine, ctx.project, { rounds: 3 });
    assert.equal(attemptsOf(fx.home, op.id).length, 1, 'no retry on an empty result');
    assert.ok(!readsOf(attemptsOf(fx.home, op.id)[0]).includes('absent'), 'never absent on an incomplete read');
  });
});

describe('M320 (d) a restart that loses the adapter\'s memory: the read is the target\'s, the inventory included', () => {
  test('the receipt never recorded (the engine killed after the host call): the read after the restart is applied, from the target, its inventory naming g1\'s unit', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }]);
    await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    await killAt(fx, ctx.project, 'adapter.after_host_call');
    const [op] = operationsOf(fx.home, ctx.project, 'deploy');
    assert.equal(attemptsOf(fx.home, op.id)[0].receipt ?? null, null, 'the fixture is live: no receipt was recorded before the kill');
    await fx.start();
    const a = await attemptWhen(ctx, op.id, 1, (x) => readsOf(x).some((r) => r !== 'unknown'), 'the read after the restart');
    const read = a.reconciliation_reads.find((r) => r.result !== 'unknown');
    assert.equal(read.result, 'applied', 'the outcome is the target\'s, not a receipt\'s');
    assert.ok(inventoryOf(read).includes(unitName(fx.home, ctx.env.id, 1)), `the read records its inventory, naming g1's unit (SEAM.md §275) (${JSON.stringify(read.read)})`);
  });

  test('a false receipt (issued, nothing applied) and a restart: the read is absent, never applied', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued' }, { result: 'issued', apply: true }]);
    await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    await killAt(fx, ctx.project, 'deploy.receipt_recorded');
    const [op] = operationsOf(fx.home, ctx.project, 'deploy');
    assert.equal(attemptsOf(fx.home, op.id)[0].receipt?.result, 'issued', 'the fixture is live: the receipt claims the effect was issued');
    await fx.start();
    const a = await attemptWhen(ctx, op.id, 1, (x) => readsOf(x).some((r) => r !== 'unknown'), 'the read after the restart');
    const read = a.reconciliation_reads.find((r) => r.result !== 'unknown');
    assert.equal(read.result, 'absent', `the target holds nothing of g1: absent, whatever the receipt claimed (${JSON.stringify(readsOf(a))})`);
    assert.ok(!readsOf(a).includes('applied'));
    assert.deepEqual(inventoryOf(read), [], 'its inventory is the target\'s: empty, from a complete read');
  });
});

describe('M320 (e) the prefix listing is a read', () => {
  test('a teardown that finds a prefixed unit no intent names: conflicting; the unit listed in the read, and nothing stops it', async (t) => {
    const ctx = await deployedAndComplete(t);
    const { fx, env } = ctx;
    await scriptCall(fx.engine, env.id, 'teardown', [{ result: 'issued', apply: true }, { result: 'issued', apply: true }]);
    const g9 = scriptedUnit(unitName(fx.home, env.id, 9), 9);
    const op = await atReceipt(ctx, 'teardown', () => requestTeardown(ctx), (target) => ({ ...target, units: [...target.units, g9] }));
    const a = await firstRead(ctx, op.id);
    assert.equal(readsOf(a)[0], 'conflicting', `${JSON.stringify(readsOf(a))}`);
    assert.ok(inventoryOf(a.reconciliation_reads[0]).includes(g9.name), `the unit is listed in the read's inventory (${JSON.stringify(a.reconciliation_reads[0].read)})`);
    await tick(fx.engine, ctx.project, { rounds: 3 });
    const state = await adapterState(fx.engine, env.id);
    assert.ok(state.target.units.some((u) => u.name === g9.name && u.state === 'active'), 'the unrecorded unit still runs');
    for (const call of state.calls.filter((c) => c.capability)) assert.ok(!unitsNamedIn(call.capability).includes(g9.name), `no effect call's capability names it (${call.call})`);
    assert.equal(openOn(fx.home, 'blocker', op.id).length, 1, 'the teardown blocks');
  });
});
