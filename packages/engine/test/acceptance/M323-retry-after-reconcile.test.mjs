// M323, retry after reconcile; a failure keeps the last verified (slice 26).
// M4 plan §3.4 M323 (a) to (g); D4-O05, D4-O06; D4 §§2.4, 4.4; Q8, Q9; E112;
// SEAM.md §§247, 250, 255, 273 to 276.
//
// Kernel lane, on the scripted deployment adapter. A retry is a new attempt
// of the same operation, with a new generation and its own frozen intent,
// and happens only after `reconciled_absent` (by itself, at most
// `deploy_auto_retries_max` times) or the human's `retry` on
// `rollout_partial`, and only after quiescence; never with a different
// artifact or configuration, never after an ambiguous attempt. The partial
// retry's preview names the reconciled state and the bounded remaining
// effects and is staled by a change to what it binds. A failed, partial or
// ambiguous attempt writes `attempted` and never touches `last_verified`.
// The human's `retry` itself (two attempts, the cleanup exactly the first's)
// is M321 (c); on a real unit, M323-the-partial-retry-on-a-real-unit.
//
// SAFETY: no unit, no systemctl, no host process; nothing is signalled.

import assert from 'node:assert/strict';
import { appendFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { DECISIONS, assertPreview, assertStaleAnswer, decision } from './harness/decisions.mjs';
import { changePolicy } from './harness/journal.mjs';
import { requestTick, scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import {
  adapterState,
  artifactsOf,
  attemptIntent,
  attemptsOf,
  authorizationRow,
  completeRound,
  configContent,
  deploy,
  deployToRound,
  deployable,
  effectCalls,
  environmentRead,
  environmentRecord,
  operationsOf,
  putConfig,
  scriptCall,
  setTarget,
  unitName,
} from './harness/deploy/kernel.mjs';
import { answerOn, atReceipt, attemptWhen, firstRead, leaseHeld, openDecisionOn, optionKeys, readsOf, releaseBarrier, armBarrier, scriptedUnit, unitsNamedIn, waitingAt } from './harness/deploy/recover.mjs';

const ended = (ctx, op) =>
  tickUntil(ctx.fx.engine, ctx.project, () => {
    const o = operationsOf(ctx.fx.home, ctx.project, 'deploy').find((x) => x.id === op);
    return o && ['failed', 'succeeded'].includes(o.status) && o.orchestration_stage === 'ended' ? o : undefined;
  }, { max: 24, what: 'the operation to end' });

async function deployedAndComplete(t) {
  const fx = await scriptedEngine(t);
  const ctx = await deployable(fx);
  const { execution } = await deployToRound(ctx);
  await completeRound(ctx, execution);
  await tick(fx.engine, ctx.project, { rounds: 2 });
  return ctx;
}

// A first deploy left partial: g1's unit there but failed (no prior).
async function partialFirst(t) {
  const fx = await scriptedEngine(t);
  const ctx = await deployable(fx);
  await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued' }, { result: 'issued', apply: true }]);
  await scriptCall(fx.engine, ctx.env.id, 'teardown', [{ result: 'issued', apply: true }]);
  const g1 = unitName(fx.home, ctx.env.id, 1);
  const request = { value: null };
  const op = await atReceipt(
    ctx,
    'deploy',
    async () => {
      request.value = await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    },
    (target) => ({ ...target, units: [scriptedUnit(g1, 1, { state: 'failed', instance: 'unread', init: 'unread', tree: 'unread' })] }),
  );
  const a1 = await firstRead(ctx, op.id);
  assert.equal(readsOf(a1)[0], 'partial', `the fixture is live: attempt 1 is partial (${JSON.stringify(readsOf(a1))})`);
  const row = await openDecisionOn(ctx, 'rollout_partial', op.id);
  return { ...ctx, fx, op, a1, g1, row, request: request.value };
}

describe('M323 (a) reconciled_absent retried by itself, at most deploy_auto_retries_max times', () => {
  for (const max of [1, 0, 3]) {
    test(`deploy_auto_retries_max ${max}: ${max + 1} attempt${max === 0 ? '' : 's'}, each absent, each with a new generation and its own frozen intent, then the operation fails`, async (t) => {
      const fx = await scriptedEngine(t);
      const ctx = await deployable(fx);
      if (max !== 1) await changePolicy(fx.engine, ctx.project, { deploy_auto_retries_max: max });
      await scriptCall(fx.engine, ctx.env.id, 'deploy', Array.from({ length: max + 2 }, () => ({ result: 'issued' })));
      await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
      const op = await tickUntil(fx.engine, ctx.project, () => operationsOf(fx.home, ctx.project, 'deploy')[0], { what: 'the deploy to be intended' });
      const done = await ended(ctx, op.id);
      await tick(fx.engine, ctx.project, { rounds: 2 });
      const attempts = attemptsOf(fx.home, op.id);
      assert.equal(attempts.length, max + 1, `one attempt and ${max} automatic retr${max === 1 ? 'y' : 'ies'} (Q9)`);
      assert.ok(attempts.every((a) => a.status === 'reconciled_absent'), `each reconciled_absent (${JSON.stringify(attempts.map((a) => a.status))})`);
      assert.deepEqual(attempts.map((a) => a.deployment_generation), attempts.map((_, i) => i + 1), 'each with a new generation');
      assert.deepEqual(attempts.map((a) => attemptIntent(fx.home, a.id).create_units), attempts.map((_, i) => [unitName(fx.home, ctx.env.id, i + 1)]), 'each with its own frozen intent');
      assert.equal(done.status, 'failed', 'the operation then fails');
      assert.equal(effectCalls(await adapterState(fx.engine, ctx.env.id), 'deploy').length, max + 1, 'no effect call beyond the setting');
    });
  }
});

describe('M323 (b) reconciled_partial and the human\'s answers', () => {
  test('abandon: the operation fails by the answer, the authorization stays consumed, the lease is released, and no rollback is offered', async (t) => {
    const ctx = await partialFirst(t);
    assert.ok(!optionKeys(ctx.row).includes('rollback'), `no rollback offered (Q8) (${JSON.stringify(optionKeys(ctx.row))})`);
    await answerOn(ctx, ctx.row, 'abandon');
    const op = await ended(ctx, ctx.op.id);
    assert.equal(op.status, 'failed');
    assert.equal(op.outcome_detail?.code, 'abandoned', `the outcome names the abandonment (SEAM.md §276) (${JSON.stringify(op.outcome_detail)})`);
    assert.equal(authorizationRow(ctx.fx.home, ctx.request.authorization.id).status, 'consumed', 'the authorization stays consumed');
    assert.equal(leaseHeld(ctx.fx.home, ctx.env.id), false, 'the lease is released');
    assert.equal(attemptsOf(ctx.fx.home, ctx.op.id).length, 1, 'no further attempt');
  });

  test('teardown: a teardown of the environment, naming only what the store owns, and no further deploy attempt', async (t) => {
    const ctx = await partialFirst(t);
    await answerOn(ctx, ctx.row, 'teardown');
    const down = await tickUntil(ctx.fx.engine, ctx.project, () => operationsOf(ctx.fx.home, ctx.project, 'teardown').find((o) => o.finalized_at), { max: 16, what: 'the teardown to be finalized' });
    const call = effectCalls(await adapterState(ctx.fx.engine, ctx.env.id), 'teardown').at(-1);
    assert.deepEqual(unitsNamedIn(call.capability), [ctx.g1], 'the teardown stops exactly the attempt\'s unit');
    assert.ok(down.id);
    assert.equal(attemptsOf(ctx.fx.home, ctx.op.id).length, 1, 'no further deploy attempt');
  });
});

describe('M323 (c) the partial retry\'s preview', () => {
  test('it names the reconciled state and the bounded remaining effects (the cleanup of g1 and the start of g2), and a change to what it binds stales it', async (t) => {
    const ctx = await partialFirst(t);
    assertPreview(ctx.row);
    assert.ok(DECISIONS.kinds.rollout_partial, 'rollout_partial is in the decision contract (SEAM.md §276)');
    assert.ok(JSON.stringify(ctx.row.manifest).includes('partial'), `the manifest names the reconciled state (${JSON.stringify(ctx.row.manifest)})`);
    const retry = ctx.row.options.find((o) => o.key === 'retry');
    assert.deepEqual(unitsNamedIn(retry.effect_plan).sort(), [ctx.g1, unitName(ctx.fx.home, ctx.env.id, 2)].sort(), `the retry's effect plan names the cleanup of g1 and the start of g2, and nothing else (${JSON.stringify(retry.effect_plan)})`);
    // The configuration the preview binds changes before the answer.
    const res = await putConfig(ctx.fx.engine, ctx.project, ctx.env.name, configContent({ port: 9091 }));
    assert.ok([200, 201].includes(res.status), `the fixture is live: a new configuration version (→ ${res.status})`);
    await tick(ctx.fx.engine, ctx.project, { rounds: 2 });
    await assertStaleAnswer(ctx.fx, ctx.project, ctx.row, 'retry');
    assert.equal(attemptsOf(ctx.fx.home, ctx.op.id).length, 1, 'no retry from the stale preview');
    assert.notEqual(decision(ctx.fx.home, ctx.row.id).status, 'consumed');
  });
});

describe('M323 (d) a retry with a different artifact or configuration is refused', () => {
  async function absentThenChange(t, change) {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued' }, { result: 'issued', apply: true }]);
    await armBarrier(fx.engine, 'deploy.receipt_recorded', 'pause');
    await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    for (let i = 0; i < 10; i++) {
      await requestTick(fx.engine, ctx.project);
      try {
        await waitingAt(fx.engine, 'deploy.receipt_recorded', { timeoutMs: 3000 });
        break;
      } catch {
        // another tick
      }
    }
    const [op] = operationsOf(fx.home, ctx.project, 'deploy');
    await change(ctx);
    await releaseBarrier(fx.engine, 'deploy.receipt_recorded');
    const done = await ended({ ...ctx, fx }, op.id);
    return { ctx: { ...ctx, fx }, op: done };
  }

  test('the configuration changed before the retry: the retry is refused before its effect, naming configuration_changed', async (t) => {
    const { ctx, op } = await absentThenChange(t, async (c) => {
      const res = await putConfig(c.fx.engine, c.project, c.env.name, configContent({ port: 9092 }));
      assert.ok([200, 201].includes(res.status));
    });
    assert.deepEqual([op.status, op.outcome_detail?.code, op.outcome_detail?.fact], ['failed', 'EFFECT_PRECONDITION_CHANGED', 'configuration_changed'], `${JSON.stringify(op.outcome_detail)}`);
    assert.equal(effectCalls(await adapterState(ctx.fx.engine, ctx.env.id), 'deploy').length, 1, 'no effect call with the other configuration');
    for (const a of attemptsOf(ctx.fx.home, op.id)) assert.equal(a.capability?.config_identity, ctx.config.config_identity, 'no attempt carries another configuration');
  });

  test('the sealed artifact changed before the retry: the retry is refused before its effect, naming artifact_integrity', async (t) => {
    const { ctx, op } = await absentThenChange(t, async (c) => {
      const [artifact] = artifactsOf(c.fx.home, c.project);
      const path = join(artifact.path, 'server.js');
      chmodSync(path, 0o644);
      appendFileSync(path, '// changed\n');
    });
    assert.deepEqual([op.status, op.outcome_detail?.code, op.outcome_detail?.fact], ['failed', 'EFFECT_PRECONDITION_CHANGED', 'artifact_integrity'], `${JSON.stringify(op.outcome_detail)}`);
    assert.equal(effectCalls(await adapterState(ctx.fx.engine, ctx.env.id), 'deploy').length, 1, 'no effect call with another artifact');
  });
});

describe('M323 (e) an ambiguous attempt is never retried', () => {
  test('with deploy_auto_retries_max 3, an attempt read unknown at every tick: one attempt, one effect call, still ambiguous', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await changePolicy(fx.engine, ctx.project, { deploy_auto_retries_max: 3 });
    await scriptCall(fx.engine, ctx.env.id, 'deploy', Array.from({ length: 4 }, () => ({ result: 'issued', apply: true })));
    const op = await atReceipt(ctx, 'deploy', () => deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name), (target) => ({ ...target, complete: false }));
    await firstRead(ctx, op.id);
    await tick(fx.engine, ctx.project, { rounds: 4 });
    const attempts = attemptsOf(fx.home, op.id);
    assert.deepEqual(attempts.map((a) => a.status), ['ambiguous'], 'one attempt, ambiguous');
    assert.equal(effectCalls(await adapterState(fx.engine, ctx.env.id), 'deploy').length, 1, 'one effect call');
  });
});

describe('M323 (f) no retry before quiescence', () => {
  test('g\'s unit inactive with a manager job pending: not absent and no retry; once the job is done and the unit gone, absent and then the retry', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued' }, { result: 'issued', apply: true }]);
    const g1 = unitName(fx.home, ctx.env.id, 1);
    const op = await atReceipt(ctx, 'deploy', () => deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name), (target) => ({ ...target, units: [scriptedUnit(g1, 1, { state: 'inactive', pending_job: true, instance: 'unread', init: 'unread', tree: 'unread' })] }));
    await firstRead(ctx, op.id);
    await tick(fx.engine, ctx.project, { rounds: 3 });
    assert.ok(!readsOf(attemptsOf(fx.home, op.id)[0]).includes('absent'), `a pending job: no quiescence, so never absent (D4 §2.4) (${JSON.stringify(readsOf(attemptsOf(fx.home, op.id)[0]))})`);
    assert.equal(attemptsOf(fx.home, op.id).length, 1, 'no retry before quiescence');
    await setTarget(fx.engine, ctx.env.id, { complete: true, units: [], resources: [] });
    const a2 = await attemptWhen(ctx, op.id, 2, (a) => a.status === 'succeeded' || a.status === 'reconciled_succeeded', 'the retry after quiescence');
    assert.equal(readsOf(attemptsOf(fx.home, op.id)[0]).at(-1), 'absent', 'the first attempt read absent once quiescent');
    assert.equal(a2.deployment_generation, 2);
  });
});

describe('M323 (g) failed, partial and ambiguous attempts on an environment with a last_verified', () => {
  test('each writes attempted with its outcome; last_verified unchanged and never erased; after the partial one, which leaves nothing running, nothing is shown running', async (t) => {
    const ctx = await deployedAndComplete(t);
    const { fx, env } = ctx;
    const lv = environmentRecord(fx.home, env.id).last_verified;
    assert.ok(lv?.round, 'the fixture is live: generation 1 is the last verified');
    const opsBefore = () => operationsOf(fx.home, ctx.project, 'deploy').length;

    // Failed: the effect refused.
    await scriptCall(fx.engine, env.id, 'deploy', [{ result: 'refused' }]);
    const n1 = opsBefore();
    await deploy(fx.engine, ctx.project, ctx.candidate.id, env.name);
    const failedOp = await tickUntil(fx.engine, ctx.project, () => operationsOf(fx.home, ctx.project, 'deploy')[n1], { what: 'the failed deploy to be intended' });
    await ended(ctx, failedOp.id);
    let record = environmentRecord(fx.home, env.id);
    assert.deepEqual([record.attempted?.operation, record.attempted?.outcome], [failedOp.id, 'failed'], `attempted: failed (${JSON.stringify(record.attempted)})`);
    assert.deepEqual(record.last_verified, lv, 'last_verified unchanged');

    // Partial, leaving nothing running: the prior stopped and g absent; then abandoned.
    await scriptCall(fx.engine, env.id, 'deploy', [{ result: 'issued' }]);
    const partialOp = await atReceipt(ctx, 'deploy', () => deploy(fx.engine, ctx.project, ctx.candidate.id, env.name), (target) => ({ ...target, units: [] }));
    await firstRead(ctx, partialOp.id);
    record = await tickUntil(fx.engine, ctx.project, () => {
      const r = environmentRecord(fx.home, env.id);
      return r.attempted?.operation === partialOp.id ? r : undefined;
    }, { what: 'attempted to name the partial attempt' });
    assert.equal(record.attempted.outcome, 'partial');
    assert.deepEqual(record.last_verified, lv, 'last_verified unchanged');
    const read = await environmentRead(fx.engine, ctx.project, env.name);
    assert.deepEqual([read.running ?? null, read.supervision ?? null], [null, null], `nothing runs, and nothing is shown running; last_verified is never read as running (D4 §4.4) (${JSON.stringify(read)})`);
    assert.deepEqual(read.last_verified, lv, 'the read keeps last_verified as a fact apart');
    await answerOn(ctx, await openDecisionOn(ctx, 'rollout_partial', partialOp.id), 'abandon');
    await ended(ctx, partialOp.id);

    // Ambiguous: the read unknown.
    await scriptCall(fx.engine, env.id, 'deploy', [{ result: 'issued', apply: true }]);
    const ambiguousOp = await atReceipt(ctx, 'deploy', () => deploy(fx.engine, ctx.project, ctx.candidate.id, env.name), (target) => ({ ...target, complete: false }));
    await firstRead(ctx, ambiguousOp.id);
    record = await tickUntil(fx.engine, ctx.project, () => {
      const r = environmentRecord(fx.home, env.id);
      return r.attempted?.operation === ambiguousOp.id ? r : undefined;
    }, { what: 'attempted to name the ambiguous attempt' });
    assert.equal(record.attempted.outcome, 'ambiguous');
    assert.deepEqual(record.last_verified, lv, 'last_verified unchanged and never erased');
  });
});
