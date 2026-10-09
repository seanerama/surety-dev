// M304, bounded calls; an effect confirmed by a read (slice 23). M4 plan
// §3.1 M304; D4-A01, D4-A02; D4 §§2.1 to 2.4; J1; SEAM.md §§247, 250, 251.
//
// On the scripted deployment adapter: an effect past `adapter_effect_deadline`
// or `adapter_output_max_bytes` is `ambiguous` and only a read settles it
// (the attempt `reconciled_succeeded`, never `succeeded` from the call); a
// read past `adapter_read_deadline` or its output bound, or failing with any
// `AdapterReadFailure`, is `unknown` and never a success; `issued` is a claim
// held before reconcile; `refused` and `not_issued` end the attempt `failed`
// with nothing applied; `uncertain` is reconciled. The bounds are set to the
// bottom of their ranges in the engine's configuration, so a hung call costs
// at most ten seconds. The deploy journal is `deploy_apply`, its events a
// path through D1 A.5's table; git's kinds are rows M26 and M29 to M34,
// unchanged and run as they are.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { scriptedEngine, tickUntil } from './harness/runs.mjs';
import { recordExit } from './harness/checks/selection.mjs';
import {
  adapterState,
  armBarrier,
  attemptsOf,
  deploy,
  deployable,
  effectCalls,
  operationsOf,
  operationsRead,
  postDeployExecutions,
  releaseBarrier,
  roundsOf,
  scriptCall,
  tickToBarrier,
  verificationsOf,
} from './harness/deploy/kernel.mjs';

const BOUNDS = { adapter_effect_deadline: 10, adapter_read_deadline: 1, adapter_output_max_bytes: 65536 };
const OVER = 65536 + 4096;

async function requested(t, { config = {}, answers = {} } = {}) {
  const fx = await scriptedEngine(t, { config });
  const ctx = await deployable(fx);
  for (const [call, list] of Object.entries(answers)) await scriptCall(fx.engine, ctx.env.id, call, list);
  await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
  return ctx;
}

// Ticks until the deploy operation's first attempt satisfies `done`.
const attemptWhen = (ctx, done, what) =>
  tickUntil(
    ctx.fx.engine,
    ctx.project,
    () => {
      const [op] = operationsOf(ctx.fx.home, ctx.project, 'deploy');
      const [a] = op ? attemptsOf(ctx.fx.home, op.id) : [];
      return a && done(a, op) ? { op, attempt: a } : undefined;
    },
    { max: 20, what },
  );

const settled = (a) => !['started', 'ambiguous'].includes(a.status);
const reads = (a) => a.reconciliation_reads.map((r) => r.result);

describe('M304 (a) every call is bounded: an effect past its deadline or output bound is ambiguous; a read past its deadline or output bound is unknown', () => {
  test('a deploy call past adapter_effect_deadline (its effect made) is ambiguous, and only reconcile confirms it: reconciled_succeeded, never succeeded', async (t) => {
    const ctx = await requested(t, { config: BOUNDS, answers: { deploy: [{ result: 'issued', apply: true, hang: true }] } });
    const { attempt } = await attemptWhen(ctx, settled, 'the attempt to be settled');
    assert.equal(attempt.status, 'reconciled_succeeded', `the call never returned: the attempt was ambiguous until the read (status ${attempt.status})`);
    assert.equal(reads(attempt).at(-1), 'applied');
  });

  test('a deploy call whose output passes adapter_output_max_bytes is ambiguous (output_exceeded), and only reconcile confirms it', async (t) => {
    const ctx = await requested(t, { config: BOUNDS, answers: { deploy: [{ result: 'issued', apply: true, output_bytes: OVER }] } });
    const { attempt } = await attemptWhen(ctx, settled, 'the attempt to be settled');
    assert.equal(attempt.status, 'reconciled_succeeded', `status ${attempt.status}`);
  });

  for (const [what, answer] of [
    ['past adapter_read_deadline', { hang: true }],
    ['whose output passes adapter_output_max_bytes', { output_bytes: OVER }],
  ]) {
    test(`a reconcile read ${what} is unknown, never applied or absent; the attempt stays ambiguous until a later read`, async (t) => {
      const ctx = await requested(t, { config: BOUNDS, answers: { deploy: [{ result: 'issued', apply: true }], reconcile: [answer] } });
      const { attempt } = await attemptWhen(ctx, settled, 'the attempt to be settled by a later read');
      assert.deepEqual(reads(attempt).slice(0, 1), ['unknown'], 'the first read is unknown');
      assert.equal(reads(attempt).at(-1), 'applied', 'a later complete read settles it');
      assert.equal(attempt.status, 'reconciled_succeeded', 'it was ambiguous, never succeeded on the unknown read');
    });
  }
});

describe('M304 (b) each AdapterReadFailure is unknown', () => {
  test('reconcile failing unavailable, deadline, output_exceeded and invalid_response: each read unknown; the success comes only from a complete read', async (t) => {
    const classes = ['unavailable', 'deadline', 'output_exceeded', 'invalid_response'];
    const ctx = await requested(t, { answers: { deploy: [{ result: 'issued', apply: true }], reconcile: classes.map((failure) => ({ failure })) } });
    const { attempt } = await attemptWhen(ctx, settled, 'the attempt to be settled');
    assert.deepEqual(reads(attempt), [...classes.map(() => 'unknown'), 'applied'], 'four unknown reads, then applied');
    assert.equal(attempt.status, 'reconciled_succeeded');
  });

  test('a first identity read failing unavailable: every value it should have returned is unread, never a match or a default; the verification is unknown, naming the read', async (t) => {
    const ctx = await requested(t, { answers: { deploy: [{ result: 'issued', apply: true }], verify: [{ failure: 'unavailable' }] } });
    const { fx, project, candidate } = ctx;
    const row = await tickUntil(
      fx.engine,
      project,
      async () => {
        const [op] = operationsOf(fx.home, project, 'deploy');
        const [round] = op ? roundsOf(fx.home, op.id) : [];
        const [v] = round ? verificationsOf(fx.home, round.id) : [];
        if (v) return v;
        const [x] = postDeployExecutions(fx.home, candidate.id);
        if (x && x.status === 'queued') await recordExit(fx.engine, x.id, 0);
        return undefined;
      },
      { max: 20, what: 'the round to record its verification' },
    );
    const first = row.identity_reads.find((r) => r.bracket === 'first');
    assert.deepEqual([first?.read, first?.match, first?.instance, first?.generation], ['unread', 'unread', 'unread', 'unread'], `every value of the failed read is unread (${JSON.stringify(first)})`);
    assert.equal(row.outcome, 'unknown');
    assert.ok((row.missing ?? []).some((m) => m.kind === 'identity_read'), `missing names the identity read (${JSON.stringify(row.missing)})`);
  });
});

describe('M304 (c) an adapter result is a claim: only a confirming read makes an attempt succeeded', () => {
  test('issued is held before reconcile: the attempt is started, its receipt claimed; succeeded only after applied', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }]);
    await armBarrier(fx.engine, 'deploy.receipt_recorded', 'pause');
    await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    await tickToBarrier(fx, ctx.project, 'deploy.receipt_recorded');
    const [op] = operationsOf(fx.home, ctx.project, 'deploy');
    const [held] = attemptsOf(fx.home, op.id);
    assert.deepEqual([held.status, held.receipt?.result, held.receipt?.provenance, held.reconciliation_reads], ['started', 'issued', 'claimed', []], 'with the receipt recorded and no read made, the attempt is started');
    await releaseBarrier(fx.engine, 'deploy.receipt_recorded');
    const { attempt } = await attemptWhen(ctx, settled, 'the attempt to be confirmed');
    assert.deepEqual([attempt.status, reads(attempt).at(-1)], ['succeeded', 'applied']);
    const done = await tickUntil(fx.engine, ctx.project, async () => (await operationsRead(fx.engine, ctx.project)).find((o) => o.id === op.id && o.state === 'finalized'), { max: 12, what: 'the operation to be finalized' });
    assert.deepEqual([done.journal_kind, done.journal.map((e) => e.event_kind)], ['deploy_apply', ['intended', 'applied', 'confirmed', 'finalized']], '(d) the deploy journal runs its ordinary course');
    assert.deepEqual(done.journal.map((e) => e.seq), [1, 2, 3, 4], 'numbered from 1 without a gap');
  });

  for (const result of ['refused', 'not_issued']) {
    test(`${result} ends the attempt failed with nothing applied and nothing reconciled; the operation failed, its journal intended then failed`, async (t) => {
      const ctx = await requested(t, { answers: { deploy: [{ result }] } });
      const { attempt, op } = await attemptWhen(ctx, (a) => a.status !== 'started', `the ${result} attempt to end`);
      assert.deepEqual([attempt.status, attempt.reconciliation_reads], ['failed', []]);
      const ended = await tickUntil(ctx.fx.engine, ctx.project, async () => (await operationsRead(ctx.fx.engine, ctx.project)).find((o) => o.id === op.id && o.status === 'failed'), { max: 8, what: 'the operation to be failed' });
      assert.deepEqual(ended.journal.map((e) => e.event_kind), ['intended', 'failed'], '(d) the journal: intended, failed');
      const state = await adapterState(ctx.fx.engine, ctx.env.id);
      assert.deepEqual(state.target.units, [], 'nothing was applied to the target');
      assert.equal(effectCalls(state, 'reconcile').length, 0, 'no read was taken as its outcome');
      assert.equal(operationsOf(ctx.fx.home, ctx.project, 'deploy').length, 1, 'and nothing was retried as a new operation');
    });
  }

  test('uncertain is reconciled: the applied effect is confirmed by the read, never by the call', async (t) => {
    const ctx = await requested(t, { answers: { deploy: [{ result: 'uncertain', apply: true }] } });
    const { attempt } = await attemptWhen(ctx, settled, 'the attempt to be settled');
    assert.ok(['succeeded', 'reconciled_succeeded'].includes(attempt.status), `status ${attempt.status}`);
    assert.equal(reads(attempt).at(-1), 'applied', 'by a reconcile read');
    assert.ok(effectCalls(await adapterState(ctx.fx.engine, ctx.env.id), 'reconcile').length >= 1);
  });
});
