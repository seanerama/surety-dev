// M321, the crash matrix, kernel half (slice 26). M4 plan §3.4 M321 (a),
// (c), (d), (f), (g); D4-O03; D4 §§4.2, 4.3, 4.4; E110, E112; BS4 §11.1
// CD3; SEAM.md §§247, 250, 251, 262, 270, 273 to 276.
//
// Kernel lane, on the scripted deployment adapter, whose target survives an
// engine restart as a real one would (SEAM.md §247). A kill at each point of
// D4 §4.3's table recovers as its right-hand column says, and after each the
// invariants of D4 §4.3 hold (`assertInvariants`, M321 (f)): no generation
// used twice, no unit started twice, no attempt lost, every attempt terminal
// or ambiguous with a decision, every journal complete, no duplicate
// deployment.
//
// Two points of the table are pinned by earlier rows and not repeated here
// (COVERAGE.md "M4 slice 26"): after the intent, before the attempt, is
// M305 (a) (a kill at `deploy.intended`: one operation, one consumption, one
// effect call); after the verification row, before completion, is M305 (d)'s
// control (a kill at `deploy.before_completion`: completion recomputed). The
// real profile's kills are M321-kills-with-a-real-service (sandbox).
//
// SAFETY (BS4 §4.1; E64; SEAM.md §274). Every kill is of this test's own
// engine child: either the engine kills itself at an armed barrier (its
// `kill` action), or `killOwnEngine` sends SIGKILL through the ChildProcess
// handle the harness spawned, after reading from /proc that it is the
// engine of this test's own home. No unit, no systemctl, no other process.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { eventsOfType } from './harness/journal.mjs';
import { scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import {
  adapterState,
  attemptIntent,
  attemptsOf,
  authorizationRow,
  deploy,
  deployable,
  effectCalls,
  environmentRecord,
  operationsOf,
  operationsRead,
  postDeployExecutions,
  requestDeployment,
  roundsOf,
  scriptCall,
  unitName,
  verificationsOf,
} from './harness/deploy/kernel.mjs';
import { executionsOfRound, recordExit } from './harness/deploy/rounds.mjs';
import { answerOn, assertInvariants, atReceipt, attemptWhen, killAt, killOwnEngine, leaseHeld, openDecisionOn, optionKeys, readsOf, scriptedUnit, unitsNamedIn } from './harness/deploy/recover.mjs';
import { withStore } from './harness/store.mjs';

const settled = (a) => !['started', 'ambiguous'].includes(a.status);

// The round of the operation's latest attempt to record its row, recording
// any of its queued post-deploy executions passing meanwhile (so that only
// what the kill left can keep the row from `verified`, as M305 (c) does).
const rowAfterRestart = (ctx, op) =>
  tickUntil(
    ctx.fx.engine,
    ctx.project,
    async () => {
      const round = roundsOf(ctx.fx.home, op).at(-1);
      const [v] = round ? verificationsOf(ctx.fx.home, round.id) : [];
      if (v) return v;
      for (const x of postDeployExecutions(ctx.fx.home, ctx.candidate.id)) if (x.status === 'queued') await recordExit(ctx.fx.engine, x.id, 0);
      return undefined;
    },
    { max: 24, what: 'the round to record its verification after the restart' },
  );

async function deployingTo(t, answers = [{ result: 'issued', apply: true }]) {
  const fx = await scriptedEngine(t);
  const ctx = await deployable(fx);
  await scriptCall(fx.engine, ctx.env.id, 'deploy', answers);
  const request = await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
  return { ...ctx, fx, request };
}

describe('M321 (a), (d), (f) a kill at each point of D4 §4.3, on the scripted target', () => {
  test('before the intent (the request answered, no tick yet): the next incarnation intends exactly once, and a repeated request coalesces', async (t) => {
    const ctx = await deployingTo(t);
    const { fx } = ctx;
    // SIGKILL to this test's own engine child (killOwnEngine reads its /proc first).
    await killOwnEngine(fx);
    await fx.start();
    const again = await requestDeployment(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    assert.equal(again.status, 200, `a repeated request coalesces (D4 §4.1) (→ ${again.status} ${again.text})`);
    assert.equal(again.body.authorization.id, ctx.request.authorization.id, 'it names the pending authorization');
    const op = await tickUntil(fx.engine, ctx.project, () => operationsOf(fx.home, ctx.project, 'deploy')[0]?.finalized_at ? operationsOf(fx.home, ctx.project, 'deploy')[0] : undefined, { max: 16, what: 'the operation to be finalized' });
    await tick(fx.engine, ctx.project, { rounds: 2 });
    assert.equal(operationsOf(fx.home, ctx.project, 'deploy').length, 1, 'one operation');
    assert.equal(eventsOfType(fx.home, 'authorization.consumed').length, 1, 'one consumption');
    assert.equal(effectCalls(await adapterState(fx.engine, ctx.env.id), 'deploy').length, 1, 'one effect call');
    assert.equal(attemptsOf(fx.home, op.id)[0].status, 'succeeded');
    await assertInvariants(ctx);
  });

  test('after the attempt row, before the effect (adapter.before_host_call): its launch closed first, the attempt read absent, and a retry with a new generation; generation 1 never issued', async (t) => {
    const ctx = await deployingTo(t, [{ result: 'issued', apply: true }]);
    const { fx } = ctx;
    await killAt(fx, ctx.project, 'adapter.before_host_call');
    const [op] = operationsOf(fx.home, ctx.project, 'deploy');
    assert.equal(attemptsOf(fx.home, op.id)[0].status, 'started', 'the fixture is live: the attempt was started by the dead incarnation');
    await fx.start();
    const a2 = await attemptWhen(ctx, op.id, 2, settled, 'the retry to settle');
    const [a1] = attemptsOf(fx.home, op.id);
    assert.equal(a1.launch_state, 'closed', 'the earlier incarnation\'s launch is closed (D4 §9.2)');
    assert.equal(a1.status, 'reconciled_absent', `ambiguous, then read absent (${a1.status}, ${JSON.stringify(readsOf(a1))})`);
    assert.equal(a2.deployment_generation, 2, 'the retry has a new generation');
    const calls = effectCalls(await adapterState(fx.engine, ctx.env.id), 'deploy');
    assert.equal(calls.length, 1, 'one effect call in all');
    assert.deepEqual(unitsNamedIn(calls[0].capability), [unitName(fx.home, ctx.env.id, 2)], 'and it is generation 2\'s: nothing of generation 1 was ever issued');
    await assertInvariants(ctx);
  });

  test('after the effect, before its receipt (adapter.after_host_call): the read finds it applied, nothing deployed twice, and the round on the survivor ends unknown naming supervision', async (t) => {
    const ctx = await deployingTo(t, [{ result: 'issued', apply: true }, { result: 'issued', apply: true }]);
    const { fx } = ctx;
    await killAt(fx, ctx.project, 'adapter.after_host_call');
    await fx.start();
    const [op] = operationsOf(fx.home, ctx.project, 'deploy');
    const a = await attemptWhen(ctx, op.id, 1, settled, 'the attempt to be reconciled');
    assert.equal(a.status, 'reconciled_succeeded', `ambiguous after the restart, then applied by the read (${a.status})`);
    const row = await rowAfterRestart(ctx, op.id);
    assert.equal(row.outcome, 'unknown', 'no verification passes on a service whose supervision is unknown (E110)');
    assert.ok((row.missing ?? []).some((m) => m.kind === 'supervision'), `missing names supervision (${JSON.stringify(row.missing)})`);
    // The scripted adapter's call list is the running engine process's (objection 042): the dead
    // engine's deploy call is not in it, so "nothing deployed twice" is no deploy call by this one.
    assert.equal(effectCalls(await adapterState(fx.engine, ctx.env.id), 'deploy').length, 0, 'nothing deployed twice: the restarted engine makes no deploy call');
    assert.equal((await adapterState(fx.engine, ctx.env.id)).target.units.filter((u) => u.state === 'active').length, 1, 'and the target holds the one unit the dead engine\'s call made');
    await assertInvariants(ctx);
  });

  test('after confirmation, before the finalizer (deploy.before_finalizer): the finalizer runs once after the restart; attempted written once; one round', async (t) => {
    const ctx = await deployingTo(t);
    const { fx } = ctx;
    await killAt(fx, ctx.project, 'deploy.before_finalizer');
    const [op] = operationsOf(fx.home, ctx.project, 'deploy');
    assert.equal(roundsOf(fx.home, op.id).length, 0, 'the fixture is live: no round before the finalizer');
    await fx.start();
    await rowAfterRestart(ctx, op.id);
    await tick(fx.engine, ctx.project, { rounds: 2 });
    assert.equal(roundsOf(fx.home, op.id).length, 1, 'one round, created once');
    const journal = (await operationsRead(fx.engine, ctx.project)).find((o) => o.id === op.id).journal.map((e) => e.event_kind);
    assert.equal(journal.filter((k) => k === 'finalized').length, 1, `finalized once (${JSON.stringify(journal)})`);
    assert.equal(environmentRecord(fx.home, ctx.env.id).attempted?.attempt, attemptsOf(fx.home, op.id)[0].id, 'attempted names the attempt');
    await assertInvariants(ctx);
  });

  test('after the finalizer (deploy.round_registered): one round and the same receipts after the restart', async (t) => {
    const ctx = await deployingTo(t);
    const { fx } = ctx;
    await killAt(fx, ctx.project, 'deploy.round_registered');
    const [op] = operationsOf(fx.home, ctx.project, 'deploy');
    const before = { receipt: attemptsOf(fx.home, op.id)[0].receipt, rounds: roundsOf(fx.home, op.id).map((r) => r.id) };
    assert.equal(before.rounds.length, 1, 'the fixture is live: the finalizer made its round before the kill');
    await fx.start();
    await rowAfterRestart(ctx, op.id);
    await tick(fx.engine, ctx.project, { rounds: 2 });
    assert.deepEqual(roundsOf(fx.home, op.id).map((r) => r.id), before.rounds, 'no second round: the replay returns the same one (D4 §4.2)');
    assert.deepEqual(attemptsOf(fx.home, op.id)[0].receipt, before.receipt, 'the same receipts');
    await assertInvariants(ctx);
  });

  test('during verification (verify.after_first_read): the round on the survivor ends unknown naming supervision; no result is synthesized; the lease is released', async (t) => {
    const ctx = await deployingTo(t);
    const { fx } = ctx;
    await killAt(fx, ctx.project, 'verify.after_first_read');
    const [op] = operationsOf(fx.home, ctx.project, 'deploy');
    await fx.start();
    const row = await tickUntil(fx.engine, ctx.project, () => {
      const round = roundsOf(fx.home, op.id).at(-1);
      return round ? verificationsOf(fx.home, round.id)[0] : undefined;
    }, { max: 24, what: 'the interrupted round\'s row' });
    assert.equal(row.outcome, 'unknown', `the round open at the kill ends unknown (D4 §4.3) (${row.outcome})`);
    assert.ok((row.missing ?? []).some((m) => m.kind === 'supervision'), `missing names supervision (${JSON.stringify(row.missing)})`);
    // By the round's binding, whatever the trigger: a recovery retry keeps it (rounds.mjs; objection 039).
    const executions = roundsOf(fx.home, op.id).flatMap((r) => executionsOfRound(fx.home, ctx.candidate.id, r.id));
    const results = withStore(fx.home, (db) => executions.flatMap((x) => db.prepare('SELECT * FROM "check_results" WHERE "execution" = ? AND "execution_established" = 1').all(x.id)));
    assert.deepEqual(results, [], 'no check result is synthesized for the round (the test recorded none)');
    await tick(fx.engine, ctx.project, { rounds: 2 });
    assert.equal(leaseHeld(fx.home, ctx.env.id), false, 'the lease is released (D4 §4.7: verification unknown)');
    await assertInvariants(ctx);
  });
});

describe('M321 (c) two attempts of one operation, the second after partial, each with its own frozen intent', () => {
  test('attempt 1 partial (g1 left failed); the human\'s retry: attempt 2 creates g2, cleans up exactly attempt 1\'s unit, and the operation\'s frozen intent is unchanged', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued' }, { result: 'issued', apply: true }]);
    const g1 = unitName(fx.home, ctx.env.id, 1);
    const op = await atReceipt(ctx, 'deploy', () => deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name), (target) => ({ ...target, units: [scriptedUnit(g1, 1, { state: 'failed', instance: 'unread', init: 'unread', tree: 'unread' })] }));
    const frozen = op.finalizer_inputs;
    const a1 = await attemptWhen(ctx, op.id, 1, (a) => a.reconciliation_reads.length > 0, 'attempt 1\'s read');
    assert.equal(readsOf(a1)[0], 'partial', `g present but failed is partial (D4 §2.4) (${JSON.stringify(readsOf(a1))})`);
    const intent1 = attemptIntent(fx.home, a1.id);
    const row = await openDecisionOn(ctx, 'rollout_partial', op.id);
    await answerOn(ctx, row, 'retry');
    const a2 = await attemptWhen(ctx, op.id, 2, settled, 'attempt 2 to settle');
    const intent2 = attemptIntent(fx.home, a2.id);
    assert.deepEqual(intent2.create_units, [unitName(fx.home, ctx.env.id, 2)], 'attempt 2 creates generation 2\'s unit');
    assert.deepEqual(intent2.cleanup.map((c) => [c.resource, c.attempt]), [[g1, a1.id]], `its cleanup is exactly attempt 1's unit, named with attempt 1 (D4 A.3) (${JSON.stringify(intent2.cleanup)})`);
    assert.deepEqual(unitsNamedIn(a2.capability).sort(), [g1, unitName(fx.home, ctx.env.id, 2)].sort(), 'its capability names those units and no other');
    assert.deepEqual(attemptIntent(fx.home, a1.id), intent1, 'attempt 1\'s intent is unchanged');
    assert.deepEqual(operationsOf(fx.home, ctx.project, 'deploy')[0].finalizer_inputs, frozen, 'the operation\'s frozen intent is unchanged');
    assert.equal(a2.status, 'succeeded');
    await assertInvariants(ctx);
  });
});

describe('M321 (g) CD3: a kill between the launch grant and the init\'s started report', () => {
  test('no instance recorded: reconcile unknown and a blocker offering teardown; the teardown removes exactly the attempt\'s unit; a new request makes a new authorization; nothing found is recorded as the instance', async (t) => {
    const ctx = await deployingTo(t);
    const { fx } = ctx;
    await scriptCall(fx.engine, ctx.env.id, 'teardown', [{ result: 'issued', apply: true }]);
    await killAt(fx, ctx.project, 'init.app_started');
    const [op] = operationsOf(fx.home, ctx.project, 'deploy');
    const [held] = attemptsOf(fx.home, op.id);
    assert.ok(held.init_instance, 'the fixture is live: the launch was granted (the init recorded)');
    assert.equal(held.app_instance ?? null, null, 'and the application instance was not recorded');
    await fx.start();
    const a = await attemptWhen(ctx, op.id, 1, (x) => x.reconciliation_reads.length > 0, 'the read after the restart');
    assert.equal(readsOf(a)[0], 'unknown', `no instance recorded: the binding is unread, so unknown (D4 §2.4; CD3 (a)) (${JSON.stringify(readsOf(a))})`);
    const blocker = await openDecisionOn(ctx, 'blocker', op.id);
    assert.ok(optionKeys(blocker).includes('teardown'), `the blocker offers the preempting teardown (D4 §4.6) (${JSON.stringify(optionKeys(blocker))})`);
    assert.equal(attemptsOf(fx.home, op.id).length, 1, 'no retry (E111: unknown blocks, never retried)');
    await answerOn(ctx, blocker, 'teardown');
    const down = await tickUntil(fx.engine, ctx.project, () => operationsOf(fx.home, ctx.project, 'teardown').find((o) => o.finalized_at), { max: 16, what: 'the teardown to be finalized' });
    const call = effectCalls(await adapterState(fx.engine, ctx.env.id), 'teardown').at(-1);
    assert.deepEqual(unitsNamedIn(call.capability), [unitName(fx.home, ctx.env.id, 1)], 'the teardown names exactly the attempt\'s unit');
    assert.equal(attemptsOf(fx.home, down.id)[0].status, 'succeeded', 'and removes it');
    assert.equal(attemptsOf(fx.home, op.id)[0].app_instance ?? null, null, 'nothing found by enumeration is recorded as the instance (CD3; E110)');
    const next = await requestDeployment(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    assert.equal(next.status, 201, `a new request makes a new authorization (→ ${next.status} ${next.text})`);
    assert.notEqual(next.body.authorization.id, ctx.request.authorization.id);
    assert.equal(authorizationRow(fx.home, ctx.request.authorization.id).status, 'consumed', 'the first stays consumed');
  });
});

describe('M321 (g) the blocker\'s teardown with a manager job pending (the slice-26 review\'s S1)', () => {
  test('a read unknown for a pending job, then the blocker\'s teardown: before its effect the engine reads the pending job, so the teardown\'s attempt is ambiguous, no teardown call is made, and the owned unit is untouched', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }]);
    await scriptCall(fx.engine, ctx.env.id, 'teardown', [{ result: 'issued', apply: true }]);
    const g1 = unitName(fx.home, ctx.env.id, 1);
    const op = await atReceipt(ctx, 'deploy', () => deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name), (target) => ({ ...target, units: target.units.map((u) => (u.name === g1 ? { ...u, pending_job: true } : u)) }));
    const a = await attemptWhen(ctx, op.id, 1, (x) => x.reconciliation_reads.length > 0, 'the deploy\'s read');
    assert.equal(readsOf(a)[0], 'unknown', `a pending manager job: no quiescence, unknown (D4 §2.4) (${JSON.stringify(readsOf(a))})`);
    const unitBefore = (await adapterState(fx.engine, ctx.env.id)).target.units.find((u) => u.name === g1);
    assert.equal(unitBefore?.pending_job, true, 'the fixture is live: the job is still pending');
    const blocker = await openDecisionOn(ctx, 'blocker', op.id);
    await answerOn(ctx, blocker, 'teardown');
    const down = await tickUntil(fx.engine, ctx.project, () => {
      const o = operationsOf(fx.home, ctx.project, 'teardown')[0];
      const [x] = o ? attemptsOf(fx.home, o.id) : [];
      return x && x.status !== 'started' ? { o, x } : undefined;
    }, { max: 16, what: 'the teardown\'s attempt to settle' });
    await tick(fx.engine, ctx.project, { rounds: 2 });
    assert.equal(attemptsOf(fx.home, down.o.id)[0].status, 'ambiguous', `the teardown's attempt is ambiguous: a job is pending under the prefix (D4 §§2.4, 4.6 step 1; SEAM.md §281) (${down.x.status})`);
    const calls = (await adapterState(fx.engine, ctx.env.id)).calls;
    assert.deepEqual(calls.filter((c) => c.call === 'teardown'), [], 'no teardown (stop) call is made');
    assert.deepEqual((await adapterState(fx.engine, ctx.env.id)).target.units.find((u) => u.name === g1), unitBefore, 'the owned unit is untouched');
  });
});
