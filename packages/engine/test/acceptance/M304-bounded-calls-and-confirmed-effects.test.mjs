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
//
// The slice-23 review's S2 and S3 (SEAM.md §§247, 255): the read that settles
// an effect is D4 §2.4's mapping of the whole inventory (units, domain
// cgroups, link sockets, runtime directories) and of the launches the engine
// granted, never of the units alone. Their resources are set on the scripted
// target at `deploy.receipt_recorded`, after the effect and before its read.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { scriptedEngine, tickUntil } from './harness/runs.mjs';
import { recordExit } from './harness/checks/selection.mjs';
import {
  adapterState,
  armBarrier,
  attemptsOf,
  completeRound,
  deploy,
  deployToRound,
  deployable,
  effectCalls,
  operationsOf,
  operationsRead,
  postDeployExecutions,
  releaseBarrier,
  roundsOf,
  scriptCall,
  setTarget,
  teardown,
  tickSome,
  tickToBarrier,
  unitName,
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

// ---- the slice-23 review: the mapping of the whole inventory (S2, S3; SEAM.md §255) ----

const PARTIAL_OR_WORSE = ['partial', 'conflicting', 'unknown'];
const resource = (kind, home, env, generation, state) => ({
  kind,
  path: kind === 'cgroup' ? `/user.slice/app.slice/${unitName(home, env, generation)}/service` : `${home}/run/deploy/${env}/g${generation}${kind === 'socket' ? '.sock' : ''}`,
  generation,
  state,
});

// The operation `op`'s first attempt, once it has a reconcile read.
const firstRead = (ctx, op, what) =>
  tickUntil(
    ctx.fx.engine,
    ctx.project,
    () => {
      const [a] = attemptsOf(ctx.fx.home, op);
      return a && a.reconciliation_reads.length > 0 ? a : undefined;
    },
    { max: 16, what },
  );

// Pause at the effect's receipt, set the target with `change(target)`, and
// let the read be made. Returns the operation's id (`kind`, the newest).
async function atReceipt(ctx, kind, start, change) {
  const { fx, project, env } = ctx;
  await armBarrier(fx.engine, 'deploy.receipt_recorded', 'pause');
  await start();
  await tickToBarrier(fx, project, 'deploy.receipt_recorded');
  const op = operationsOf(fx.home, project, kind).at(-1);
  const { target } = await adapterState(fx.engine, env.id);
  await setTarget(fx.engine, env.id, change({ complete: target.complete, units: target.units, resources: target.resources ?? [] }));
  await releaseBarrier(fx.engine, 'deploy.receipt_recorded');
  return op.id;
}

// A deployment of generation 1 verified and complete, so the lease is free
// for the next operation.
async function deployedAndComplete(t) {
  const fx = await scriptedEngine(t);
  const ctx = await deployable(fx);
  const { execution } = await deployToRound(ctx);
  await completeRound(ctx, execution);
  return ctx;
}

describe('M304 (c) the read that settles an effect maps the whole inventory and the launches granted (D4 §2.4; the slice-23 review, S2 and S3)', () => {
  test("S2: a launch for g granted (its init and application recorded) whose unit is gone after a restart is partial, never absent; no new attempt starts without the human's answer", async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    // A second applying answer queued: a retry, were one started, would be made and would succeed.
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }, { result: 'issued', apply: true }]);
    await armBarrier(fx.engine, 'deploy.receipt_recorded', 'pause');
    await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    await tickToBarrier(fx, ctx.project, 'deploy.receipt_recorded');
    const [op] = operationsOf(fx.home, ctx.project, 'deploy');
    const [held] = attemptsOf(fx.home, op.id);
    assert.ok(held.init_instance && held.app_instance, `the launch for g1 was granted: the init and the application are recorded on the attempt (${JSON.stringify([held.init_instance, held.app_instance])})`);
    // The unit goes; the engine dies before its read and starts again.
    await setTarget(fx.engine, ctx.env.id, { complete: true, units: [] });
    await fx.engine.kill();
    await fx.start();
    const attempt = await tickUntil(
      fx.engine,
      ctx.project,
      () => {
        const [a] = attemptsOf(fx.home, op.id);
        return a && a.reconciliation_reads.some((r) => r.result !== 'unknown') ? a : undefined;
      },
      { max: 16, what: 'the attempt to be read after the restart' },
    );
    await tickSome(fx, ctx.project, 4);
    const settledBy = attempt.reconciliation_reads.find((r) => r.result !== 'unknown').result;
    assert.equal(settledBy, 'partial', `a launch for g granted and its unit gone is partial (D4 §2.4), never absent: absent requires that no launch for g was granted (reads ${JSON.stringify(reads(attempt))})`);
    const attempts = attemptsOf(fx.home, op.id);
    assert.equal(attempts[0].status, 'reconciled_partial', `the attempt is reconciled_partial (status ${attempts[0].status})`);
    assert.equal(attempts.length, 1, `no new attempt without the rollout_partial decision (attempts ${JSON.stringify(attempts.map((a) => a.status))})`);
    assert.equal(effectCalls(await adapterState(fx.engine, ctx.env.id), 'deploy').length, 0, 'no deploy effect call in the new incarnation');
  });

  test('S3: beyond units: a teardown leaving a populated domain cgroup and a socket is partial, never applied', async (t) => {
    const ctx = await deployedAndComplete(t);
    const { fx, project, env } = ctx;
    await scriptCall(fx.engine, env.id, 'teardown', [{ result: 'issued', apply: true }]);
    const op = await atReceipt(
      ctx,
      'teardown',
      async () => {
        const res = await teardown(fx.engine, project, env.name);
        assert.ok(res.status >= 200 && res.status < 300, `the teardown is accepted (→ ${res.status} ${res.text})`);
      },
      (target) => ({ ...target, resources: [resource('cgroup', fx.home, env.id, 1, 'populated'), resource('socket', fx.home, env.id, 1, 'present')] }),
    );
    const a = await firstRead(ctx, op, "the teardown's read");
    assert.deepEqual((await adapterState(fx.engine, env.id)).target.units, [], 'no unit is left');
    assert.equal(reads(a)[0], 'partial', `owned resources survive: partial, never applied (D4 §2.4, D4-A03) (reads ${JSON.stringify(reads(a))})`);
    assert.notEqual(a.status, 'succeeded');
  });

  test('S3: beyond units: a required resource left unread makes the read unknown, never applied', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }]);
    const op = await atReceipt(
      ctx,
      'deploy',
      () => deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name),
      (target) => ({ ...target, resources: [resource('cgroup', fx.home, ctx.env.id, 1, 'unread')] }),
    );
    const a = await firstRead(ctx, op, "the deploy's read");
    assert.equal(reads(a)[0], 'unknown', `g1's domain cgroup unread: unknown, which takes precedence over applied (D4 §2.4) (reads ${JSON.stringify(reads(a))})`);
    assert.notEqual(a.status, 'succeeded');
  });

  test('S3: beyond active units: a teardown with every recorded unit unchanged and an extra prefixed unit, failed, is conflicting, never absent', async (t) => {
    const ctx = await deployedAndComplete(t);
    const { fx, project, env } = ctx;
    await scriptCall(fx.engine, env.id, 'teardown', [{ result: 'issued' }]);
    const extra = { name: unitName(fx.home, env.id, 9), state: 'failed', invocation_id: 'e'.repeat(32), pending_job: false, generation: 9, instance: 'unread', init: 'unread', tree: 'unread' };
    const op = await atReceipt(
      ctx,
      'teardown',
      async () => {
        const res = await teardown(fx.engine, project, env.name);
        assert.ok(res.status >= 200 && res.status < 300, `the teardown is accepted (→ ${res.status} ${res.text})`);
      },
      (target) => ({ ...target, units: [...target.units, extra] }),
    );
    const a = await firstRead(ctx, op, "the teardown's read");
    assert.ok((await adapterState(fx.engine, env.id)).target.units.some((u) => u.name === unitName(fx.home, env.id, 1) && u.state === 'active'), 'g1 is unchanged');
    assert.equal(reads(a)[0], 'conflicting', `a prefixed unit no intent names, in any state, is ownership unexpected: conflicting (D4 §2.4) (reads ${JSON.stringify(reads(a))})`);
  });

  test("S3: beyond units: a deploy whose g has no unit but whose domain cgroup is still populated is not absent, and no retry starts", async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued' }, { result: 'issued', apply: true }]);
    const op = await atReceipt(
      ctx,
      'deploy',
      () => deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name),
      (target) => ({ ...target, units: [], resources: [resource('cgroup', fx.home, ctx.env.id, 1, 'populated')] }),
    );
    const a = await firstRead(ctx, op, "the deploy's read");
    await tickSome(fx, ctx.project, 3);
    assert.ok(PARTIAL_OR_WORSE.includes(reads(a)[0]), `absent requires g's unit and domain absent in every state (D4 §2.4): not absent, not applied (reads ${JSON.stringify(reads(a))})`);
    assert.equal(attemptsOf(fx.home, op).length, 1, 'no new attempt');
    assert.equal(effectCalls(await adapterState(fx.engine, ctx.env.id), 'deploy').length, 1, 'one deploy effect call');
  });

  test('S3: beyond names: a prior unit running under another invocation and instance than its frozen ones is not "prior exactly as frozen": the read is not absent', async (t) => {
    const ctx = await deployedAndComplete(t);
    const { fx, project, candidate, env } = ctx;
    const g1 = unitName(fx.home, env.id, 1);
    // Generation 2 asked for; its effect makes no change, and meanwhile g1 has been restarted by hand.
    await scriptCall(fx.engine, env.id, 'deploy', [{ result: 'issued' }, { result: 'issued', apply: true }]);
    const op = await atReceipt(
      ctx,
      'deploy',
      () => deploy(fx.engine, project, candidate.id, env.name),
      (target) => ({ ...target, units: target.units.map((u) => (u.name === g1 ? { ...u, invocation_id: 'f'.repeat(32), instance: { pid: 999999, start_time: 1 } } : u)) }),
    );
    const [attempt] = attemptsOf(fx.home, op);
    assert.equal(attempt.deployment_generation, 2, 'the attempt is generation 2');
    const frozen = attempt.capability?.prior ?? [];
    assert.ok(frozen.some((p) => p.unit === g1), `its frozen prior names g1 (${JSON.stringify(frozen)})`);
    const a = await firstRead(ctx, op, "the second deploy's read");
    await tickSome(fx, project, 3);
    assert.ok(PARTIAL_OR_WORSE.includes(reads(a)[0]), `absent requires prior exactly as frozen (D4 §2.4), its invocation and instance included: not absent (reads ${JSON.stringify(reads(a))})`);
    assert.equal(attemptsOf(fx.home, op).length, 1, 'no new attempt');
  });
});
