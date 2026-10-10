// M323 (b), (c): the partial retry on a real unit (slice 26; sandbox lane).
// M4 plan §3.4 M323; D4-O05; D4 §§2.4, 4.4; E112; SEAM.md §§256 to 259,
// 273 to 277.
//
// On the real `local_service` adapter. A first attempt whose launch was
// granted and whose application never started (the fault
// `service_exec_failed`, one-shot) leaves its unit gone and its grant
// recorded: `reconciled_partial`, and a `rollout_partial` decision whose
// retry preview names the cleanup of exactly that attempt's unit and the
// start of the next generation. The human's `retry` makes attempt 2, with
// its own frozen intent: generation 2's unit runs (host-read), attempt 1's
// unit stays gone, and no other unit of the environment exists. The kernel
// file M323-retry-after-reconcile holds the rest of the row; M321 (c) the
// kernel form of two attempts with cleanup.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §257). Every unit is the engine's, under
// this test's home's prefix; the test acts on no unit and signals nothing.
// The environment is ended in `finally`; the file ends with
// `operatorGuard`; its engine starts carry the real-adapter switch.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { attemptIntent, attemptsOf, deploy, unitPrefix } from './harness/deploy/kernel.mjs';
import { armDeployFault, endEnvironment, hostDeployable, hostEnvironment, listUnits, newestOperation, operatorGuard, settleRound, ticksUntil, unitShow } from './harness/deploy/host.mjs';
import { answerOn, openOn, readsOf, unitsNamedIn } from './harness/deploy/recover.mjs';

const POLICY = Object.freeze({ deploy_auto_retries_max: 0, service_memory_max: 67108864 });

describe('M323 the partial retry on a real unit', () => {
  const shared = sharedFixture();
  let guard;
  let ctx;
  before(async () => {
    guard = operatorGuard();
    ctx = await hostDeployable(shared.context, guard, { policy: POLICY });
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('attempt 1 partial (granted, its application never started); the retry cleans up exactly its unit and starts generation 2, with its own frozen intent', async () => {
    const env = await hostEnvironment(ctx, 'retry');
    try {
      await armDeployFault(ctx, env, 'service_exec_failed');
      await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
      const op = await ticksUntil(ctx.fx, ctx.project, () => newestOperation(ctx, env), { what: 'the deploy' });
      const row = await ticksUntil(ctx.fx, ctx.project, () => openOn(ctx.fx.home, 'rollout_partial', op.id)[0], { timeoutMs: 300_000, what: 'the rollout_partial decision' });
      const [a1] = attemptsOf(ctx.fx.home, op.id);
      assert.equal(a1.status, 'reconciled_partial', `a granted launch whose unit is gone is partial (D4 §2.4) (${a1.status}, ${JSON.stringify(readsOf(a1))})`);
      const g1 = attemptIntent(ctx.fx.home, a1.id).create_units[0];
      const retry = row.options.find((o) => o.key === 'retry');
      assert.ok(unitsNamedIn(retry?.effect_plan).includes(g1), `the preview names the cleanup of attempt 1's unit (${JSON.stringify(retry?.effect_plan)})`);
      await answerOn(ctx, row, 'retry');
      const a2 = await ticksUntil(ctx.fx, ctx.project, () => {
        const a = attemptsOf(ctx.fx.home, op.id)[1];
        return a && !['started', 'ambiguous'].includes(a.status) ? a : undefined;
      }, { timeoutMs: 300_000, what: 'attempt 2 to settle' });
      const intent2 = attemptIntent(ctx.fx.home, a2.id);
      assert.equal(a2.deployment_generation, 2);
      assert.deepEqual(intent2.cleanup.map((c) => c.resource), [g1], 'its cleanup names exactly attempt 1\'s unit');
      const g2 = intent2.create_units[0];
      assert.equal(a2.status, 'succeeded', `attempt 2 applied (${a2.status})`);
      assert.equal(unitShow(g2, ['ActiveState'])?.ActiveState, 'active', 'host-read: generation 2 runs');
      assert.equal(unitShow(g1, ['LoadState'])?.LoadState, 'not-found', 'host-read: attempt 1\'s unit is gone');
      const ofEnv = (listUnits() ?? []).filter((u) => u.unit.startsWith(unitPrefix(ctx.fx.home, env.id))).map((u) => u.unit);
      assert.deepEqual(ofEnv, [g2], 'no other unit of the environment');
      await settleRound(ctx, env, op, { plan: { get: ['/hello'], exit: 1 } });
    } finally {
      await endEnvironment(ctx, env);
    }
  });
});
