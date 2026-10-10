// M315, bound to the attempt and the round; the newest round decides (slice
// 25). M4 plan §3.3 M315; D4-V01, D4-V09; D4 §§5.1, 5.3, 5.5; E114; SEAM.md
// §§190, 247, 249, 250, 265 to 268, 270.
//
// Kernel lane, the scripted deployment adapter. A round is registered before
// any identity read, freezing its bindings and staling the dependent
// `alpha_complete` evaluations in that transaction; the operator's
// `POST …/operations/:o/verify` registers the next round (SEAM.md §266); the
// newest registered round decides whatever order rounds complete in; a
// result bound to one round, or to no deployment, is never selected for
// another; a protected change or a changed required set between the reads
// supersedes the round, and the next round takes fresh reads and
// registrations; recovery relabels nothing. Completion is evaluated at the
// tick after a verification row (SEAM.md §270): the barrier
// `deploy.before_completion` holds that tick where a case must act between
// the row and the evaluation.
//
// Not written, a question for Sean (COVERAGE.md "M4 slice 25"): (b), "a new
// attempt: earlier rows invalidated `later_attempt`". No M4 path makes an
// attempt of an operation once one of its attempts is confirmed: a retry
// follows only `reconciled_absent` or `reconciled_partial` (D4 §4.4), and a
// round, hence a row, follows only a confirmed effect (D4 §4.2). The rule is
// unreachable by the engine as designed; no case can observe it.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertRefused } from './harness/fixtures.mjs';
import { capturedProposal, effectiveVersion, humanApplies } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { drive } from './harness/checks/selection.mjs';
import { advanceClock, scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { definitionText, defPath } from './harness/checks/fixtures.mjs';
import { withStore } from './harness/store.mjs';
import {
  POST_DEPLOY,
  adapterState,
  armBarrier,
  artifactsOf,
  atBarrier,
  deploy,
  deployable,
  deployToRound,
  mappingsOf,
  operationsOf,
  releaseBarrier,
  scriptCall,
  setAdmission,
  tickToBarrier,
} from './harness/deploy/kernel.mjs';
import {
  alphaCompleteRows,
  completion,
  executionsOfRound,
  progressOf,
  reasonCodesOf,
  recordExit,
  requestVerify,
  roundExecutions,
  roundRow,
  rowOf,
  rowWhen,
  roundsOf,
  stepExecution,
  verifyAgain,
  environmentRecord,
} from './harness/deploy/rounds.mjs';

// A deploy whose round 1 has its post-deploy execution registered. Returns ctx with {operation, round1, x1}.
async function atRound1(t, opts = {}) {
  const fx = await scriptedEngine(t);
  const ctx = await deployable(fx, opts);
  const { operation, execution } = await deployToRound(ctx);
  const [round1] = roundsOf(fx.home, operation.id);
  return { ...ctx, operation, round1, x1: execution };
}

// Round 1 passed and its row recorded verified; the engine held at
// deploy.before_completion; a second round requested by the operator, not yet
// read. Returns ctx with {round2}.
async function passedThenAgain(t) {
  const ctx = await atRound1(t);
  await armBarrier(ctx.fx.engine, 'deploy.before_completion', 'pause');
  await recordExit(ctx.fx.engine, ctx.x1.id, 0);
  await tickToBarrier(ctx.fx, ctx.project, 'deploy.before_completion');
  assert.equal(rowOf(ctx.fx.home, ctx.round1.id)?.outcome, 'verified', 'the fixture is live: round 1 is verified');
  const round2 = await verifyAgain(ctx.fx.engine, ctx.project, ctx.operation.id);
  return { ...ctx, round2 };
}

describe('M315 (i) a round is registered before any read: its bindings frozen, the dependent evaluations stale', () => {
  test('the finalizer registers round 1 with the candidate, mapping, operation, attempt, generation, configuration identity, protected version, required set and qualification frozen, stales the alpha_complete evaluation in that transaction, and reads nothing before deploy.round_registered', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }]);
    await armBarrier(fx.engine, 'deploy.receipt_recorded', 'pause');
    await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    await tickToBarrier(fx, ctx.project, 'deploy.receipt_recorded');
    const [op] = operationsOf(fx.home, ctx.project, 'deploy');
    const before = await completion(fx.engine, ctx.project, ctx.candidate.id, op.id);
    assert.ok(reasonCodesOf(before).includes('DEPLOY_VERIFICATION_MISSING'), `the fixture is live: an evaluation exists before the round (${JSON.stringify(before.reasons)})`);
    const evaluation = alphaCompleteRows(fx.home, ctx.candidate.id).at(-1);
    assert.equal(evaluation.stale, 0, 'that evaluation is current');

    await armBarrier(fx.engine, 'deploy.round_registered', 'pause');
    await releaseBarrier(fx.engine, 'deploy.receipt_recorded');
    await atBarrier(fx.engine, 'deploy.round_registered');
    const [round] = roundsOf(fx.home, op.id);
    assert.ok(round, 'the round is registered');
    const [attempt] = withStore(fx.home, (db) => db.prepare('SELECT * FROM "operation_attempts" WHERE "operation" = ?').all(op.id));
    const [artifact] = artifactsOf(fx.home, ctx.project);
    const [mapping] = mappingsOf(fx.home, artifact.id);
    const behaves = withStore(fx.home, (db) => db.prepare(`SELECT "id" FROM "checks" WHERE "key" = 'behaves' AND "protected_version" = ?`).get(effectiveVersion(fx.home, ctx.project).id))?.id;
    assert.deepEqual(
      [round.round, round.status, round.candidate, round.mapping, round.operation, round.attempt, round.deployment_generation, round.config_identity, round.protected_version, round.adapter_qualification],
      [1, 'open', ctx.candidate.id, mapping.id, op.id, attempt.id, 1, ctx.config.config_identity, effectiveVersion(fx.home, ctx.project).id, ctx.qualification],
      `the round freezes its bindings (D4 §5.3 item 1; E114 item 2) (${JSON.stringify(round)})`,
    );
    assert.ok(Array.isArray(round.required_checks) && round.required_checks.includes(behaves), `the required set names the post-deploy check (${JSON.stringify(round.required_checks)})`);
    assert.equal(alphaCompleteRows(fx.home, ctx.candidate.id).find((e) => e.id === evaluation.id).stale, 1, 'the dependent alpha_complete evaluation is stale in the registering transaction');
    const registered = eventsOfType(fx.home, 'deploy.round_registered').filter((e) => e.subject?.round === round.id);
    assert.equal(registered.length, 1, 'deploy.round_registered names the round once');
    assert.equal((await adapterState(fx.engine, ctx.env.id)).calls.filter((c) => c.call === 'verify').length, 0, 'no identity read was made before the registration (counted at the scripted adapter)');
    await releaseBarrier(fx.engine, 'deploy.round_registered');
  });
});

describe('M315 (a) a result is selected only for its own round', () => {
  test("round 1's passing result is never selected for round 2: round 2's own execution fails, round 2 is failed and decides, and completion is refused although round 1 passed", async (t) => {
    const ctx = await passedThenAgain(t);
    await releaseBarrier(ctx.fx.engine, 'deploy.before_completion');
    const [x2] = await roundExecutions(ctx, ctx.round2.id);
    assert.notEqual(x2.id, ctx.x1.id, 'round 2 registers an execution of its own');
    assert.deepEqual([x2.trigger.source, x2.trigger.generation], ['deployment_verification', 2], `its trigger names round 2 (${JSON.stringify(x2.trigger)})`);
    await recordExit(ctx.fx.engine, x2.id, 1);
    const row2 = await rowWhen(ctx, ctx.round2.id);
    assert.equal(row2.outcome, 'failed', `round 2 is failed on its own result (${row2.outcome})`);
    const results = JSON.stringify(row2.behavioral_results ?? '');
    const r1 = withStore(ctx.fx.home, (db) => db.prepare('SELECT "id" FROM "check_results" WHERE "execution" = ?').get(ctx.x1.id)).id;
    assert.ok(!results.includes(r1), `round 2's row does not name round 1's result (${results})`);
    await tick(ctx.fx.engine, ctx.project, { rounds: 3 });
    const evaluation = await completion(ctx.fx.engine, ctx.project, ctx.candidate.id, ctx.operation.id);
    assert.equal(evaluation.outcome, 'not_satisfied');
    assert.ok(reasonCodesOf(evaluation).includes('DEPLOY_VERIFICATION_FAILED'), `the newest round decides: failed (${JSON.stringify(evaluation.reasons)})`);
    assert.equal(progressOf(ctx.fx.home, ctx.candidate.id), 'developing');
  });

  test('a post-deploy result with no deployment binding (the check-result fixture) is never selected: completion waits for the round\'s own execution, and that execution\'s failure decides', async (t) => {
    const ctx = await atRound1(t);
    const fixture = await ctx.fx.engine.post('/v1/harness/fixtures/check-result', {
      project: ctx.project,
      check: ctx.x1.check,
      candidate: ctx.candidate.id,
      exit_status: 0,
      environment: ctx.env.id,
      artifact_digest: ctx.x1.artifact_digest,
    });
    assert.equal(fixture.status, 201, `the fixture records an unbound post-deploy result (body: ${fixture.text})`);
    await tick(ctx.fx.engine, ctx.project, { rounds: 4 });
    assert.equal(rowOf(ctx.fx.home, ctx.round1.id), undefined, 'no row: the unbound result is not the round\'s');
    const pending = await completion(ctx.fx.engine, ctx.project, ctx.candidate.id, ctx.operation.id);
    assert.ok(reasonCodesOf(pending).includes('DEPLOY_VERIFICATION_PENDING'), `completion still waits for the round (${JSON.stringify(pending.reasons)})`);
    await recordExit(ctx.fx.engine, ctx.x1.id, 1);
    const row = await rowWhen(ctx, ctx.round1.id);
    assert.equal(row.outcome, 'failed', `the round's own result decides (${row.outcome})`);
    assert.ok(!JSON.stringify(row.behavioral_results ?? '').includes(fixture.body.check_result.id), 'the fixture\'s result is not among the round\'s');
  });
});

describe('M315 (c) the newest round decides, whatever order rounds finish in', () => {
  test('round 1 running when round 2 is registered; round 2 finishes first, failed; round 1 then passes: its row is round_superseded (or the round superseded with no row), it writes no last_verified, and completion is refused', async (t) => {
    const ctx = await atRound1(t);
    await stepExecution(ctx.fx.engine, ctx.x1.id, 'materializing');
    await stepExecution(ctx.fx.engine, ctx.x1.id, 'running');
    const round2 = await verifyAgain(ctx.fx.engine, ctx.project, ctx.operation.id);
    assert.equal(round2.round, 2);
    const [x2] = await roundExecutions(ctx, round2.id);
    await recordExit(ctx.fx.engine, x2.id, 1);
    assert.equal((await rowWhen(ctx, round2.id)).outcome, 'failed');
    await drive(ctx.fx.engine, ctx.x1.id, ['collecting', 'recorded'], { exit_status: 0 });
    await tick(ctx.fx.engine, ctx.project, { rounds: 4 });
    const row1 = rowOf(ctx.fx.home, ctx.round1.id);
    if (row1) assert.equal(row1.invalidated_reason, 'round_superseded', `round 1's late row is recorded round_superseded (D4 §4.5) (${JSON.stringify(row1)})`);
    else assert.equal(roundRow(ctx.fx.home, ctx.round1.id).status, 'superseded', 'round 1, with no row, is superseded');
    assert.equal(environmentRecord(ctx.fx.home, ctx.env.id).last_verified ?? null, null, 'last_verified is not written from the older round');
    const evaluation = await completion(ctx.fx.engine, ctx.project, ctx.candidate.id, ctx.operation.id);
    assert.ok(reasonCodesOf(evaluation).includes('DEPLOY_VERIFICATION_FAILED'), `round 2 decides (${JSON.stringify(evaluation.reasons)})`);
    assert.equal(progressOf(ctx.fx.home, ctx.candidate.id), 'developing');
  });
});

describe('M315 (d), (e) an older pass never stands in for a newer round', () => {
  test('(d) an old pass, then a new request held before its first read: completion is not satisfied, DEPLOY_VERIFICATION_PENDING; the candidate stays developing', async (t) => {
    const ctx = await passedThenAgain(t);
    assert.equal((await adapterState(ctx.fx.engine, ctx.env.id)).calls.filter((c) => c.call === 'verify').length, 2, 'round 2 has made no read yet (round 1\'s two only)');
    const evaluation = await completion(ctx.fx.engine, ctx.project, ctx.candidate.id, ctx.operation.id);
    assert.equal(evaluation.outcome, 'not_satisfied');
    assert.ok(reasonCodesOf(evaluation).includes('DEPLOY_VERIFICATION_PENDING'), `the newest round is open (${JSON.stringify(evaluation.reasons)})`);
    await releaseBarrier(ctx.fx.engine, 'deploy.before_completion');
    await tick(ctx.fx.engine, ctx.project, { rounds: 2 });
    assert.equal(progressOf(ctx.fx.home, ctx.candidate.id), 'developing', 'the tick that was held does not advance the candidate on round 1');
  });

  test('(e) the newest round\'s execution cancelled: the older pass does not satisfy completion', async (t) => {
    const ctx = await passedThenAgain(t);
    await releaseBarrier(ctx.fx.engine, 'deploy.before_completion');
    const [x2] = await roundExecutions(ctx, ctx.round2.id);
    await stepExecution(ctx.fx.engine, x2.id, 'cancelled');
    await tick(ctx.fx.engine, ctx.project, { rounds: 4 });
    const row2 = rowOf(ctx.fx.home, ctx.round2.id);
    assert.notEqual(row2?.outcome, 'verified', 'round 2 is not verified');
    const evaluation = await completion(ctx.fx.engine, ctx.project, ctx.candidate.id, ctx.operation.id);
    assert.equal(evaluation.outcome, 'not_satisfied', `the older pass does not satisfy (${JSON.stringify(evaluation.reasons)})`);
    assert.equal(progressOf(ctx.fx.home, ctx.candidate.id), 'developing');
  });

  test('(e) the newest round\'s execution quarantined: the older pass does not satisfy completion', async (t) => {
    const ctx = await passedThenAgain(t);
    await releaseBarrier(ctx.fx.engine, 'deploy.before_completion');
    const [x2] = await roundExecutions(ctx, ctx.round2.id);
    await stepExecution(ctx.fx.engine, x2.id, 'materializing');
    await stepExecution(ctx.fx.engine, x2.id, 'quarantined');
    await tick(ctx.fx.engine, ctx.project, { rounds: 4 });
    assert.notEqual(rowOf(ctx.fx.home, ctx.round2.id)?.outcome, 'verified', 'round 2 is not verified');
    const evaluation = await completion(ctx.fx.engine, ctx.project, ctx.candidate.id, ctx.operation.id);
    assert.equal(evaluation.outcome, 'not_satisfied', `the older pass does not satisfy (${JSON.stringify(evaluation.reasons)})`);
    assert.equal(progressOf(ctx.fx.home, ctx.candidate.id), 'developing');
  });
});

describe('M315 (f) a protected change or a changed required set between the reads supersedes the round', () => {
  for (const [what, kind, file, content, reason, required] of [
    ['a protected change that leaves the required set', 'protected', '.surety/checks/notes.json', '{"note": "a protected file no definition reads"}\n', 'protected_change', ['behaves']],
    ['a protected change that adds a required post-deploy check', 'required set', defPath('behaves2'), definitionText('behaves2', POST_DEPLOY), 'required_set_changed', ['behaves', 'behaves2']],
  ]) {
    test(`${what}: round 1 superseded (${reason}, deploy.round_superseded), round 2 registered in that transaction with fresh reads and registrations under the new version; nothing of round 1 relabelled; round 2 verified decides`, async (t) => {
      const ctx = await atRound1(t);
      const proposal = await capturedProposal(ctx.fx, { id: ctx.project }, { changeKind: null, steps: [step.write(file, content)] });
      const version = await humanApplies(ctx.fx, { id: ctx.project }, proposal, 'tightening');
      await tick(ctx.fx.engine, ctx.project, { rounds: 2 });
      const r1 = roundRow(ctx.fx.home, ctx.round1.id);
      assert.deepEqual([r1.status, r1.superseded_reason], ['superseded', reason], `round 1 is superseded by the ${kind} change (D4 §5.3 item 7) (SEAM.md §267) (${JSON.stringify(r1)})`);
      const superseded = eventsOfType(ctx.fx.home, 'deploy.round_superseded').find((e) => e.subject?.round === r1.id);
      assert.ok(superseded, 'deploy.round_superseded names round 1');
      const round2 = roundsOf(ctx.fx.home, ctx.operation.id).find((r) => r.round === 2);
      assert.ok(round2, 'round 2 is registered');
      const registered = eventsOfType(ctx.fx.home, 'deploy.round_registered').find((e) => e.subject?.round === round2.id);
      assert.equal(registered?.tx, superseded.tx, 'round 2 is registered in the superseding transaction (SEAM.md §267)');
      assert.equal(round2.protected_version, version.id, 'round 2 is bound to the new protected version');
      const xs = await roundExecutions(ctx, round2.id, { n: required.length });
      assert.deepEqual(xs.map((x) => x.key).sort(), required, `round 2 registers its own required set (${xs.map((x) => x.key)})`);
      for (const x of xs) {
        assert.notEqual(x.id, ctx.x1.id, 'round 1\'s execution is never relabelled into round 2');
        assert.equal(x.trigger.generation, 2, 'each names round 2');
        assert.equal(x.protected_version, version.id, 'each is registered under the new version');
        await recordExit(ctx.fx.engine, x.id, 0);
      }
      assert.ok(executionsOfRound(ctx.fx.home, ctx.candidate.id, ctx.round1.id).every((x) => x.trigger.generation === 1), 'round 1\'s executions still name round 1');
      const row2 = await rowWhen(ctx, round2.id);
      const firstRead = (row2.identity_reads ?? []).find((r) => r.bracket === 'first');
      assert.ok(firstRead && Date.parse(firstRead.at) >= Date.parse(r1.registered_at) && Date.parse(firstRead.at) >= Date.parse(superseded.at), `round 2's first read is its own, made after the change (${JSON.stringify(firstRead)})`);
      assert.equal(row2.outcome, 'verified');
      await tickUntil(ctx.fx.engine, ctx.project, () => (progressOf(ctx.fx.home, ctx.candidate.id) === 'alpha_deployed' ? true : undefined), { max: 8, what: 'completion on round 2' });
      assert.equal(environmentRecord(ctx.fx.home, ctx.env.id).last_verified?.round, round2.id, 'last_verified names round 2');
    });
  }
});

describe('M315 (g) recovery during a round relabels nothing', () => {
  test('the engine killed while round 1\'s execution runs: after the restart the round is unknown naming supervision; the execution keeps its trigger; a later round registers its own executions and names none of round 1\'s', async (t) => {
    const ctx = await atRound1(t);
    await stepExecution(ctx.fx.engine, ctx.x1.id, 'materializing');
    await stepExecution(ctx.fx.engine, ctx.x1.id, 'running');
    await ctx.fx.engine.kill();
    await ctx.fx.start();
    // The scripted check boundary never moves an execution by itself, a
    // restart included (SEAM.md §190): the test interrupts the running one as
    // a real runner's recovery would, and records any retry the engine then
    // registers for round 1 passing, so only supervision can keep the round
    // from verified.
    await stepExecution(ctx.fx.engine, ctx.x1.id, 'interrupted');
    const row1 = await tickUntil(
      ctx.fx.engine,
      ctx.project,
      async () => {
        const v = rowOf(ctx.fx.home, ctx.round1.id);
        if (v) return v;
        for (const x of executionsOfRound(ctx.fx.home, ctx.candidate.id, ctx.round1.id)) if (x.status === 'queued') await recordExit(ctx.fx.engine, x.id, 0);
        return undefined;
      },
      { max: 24, what: 'round 1 on the survivor to record its row' },
    );
    assert.equal(row1.outcome, 'unknown', `the round on a survivor of the restart is unknown (E110) (${row1.outcome})`);
    assert.ok((row1.missing ?? []).some((m) => m.kind === 'supervision'), `missing names supervision (${JSON.stringify(row1.missing)})`);
    const trig = (x) => `${x.trigger.id}|${x.trigger.generation}`;
    const before = executionsOfRound(ctx.fx.home, ctx.candidate.id, ctx.round1.id);
    assert.ok(before.length >= 1 && before.length <= 3, `round 1's executions are its first and at most check_infra_retries_max retries (${before.length})`);
    assert.ok(before.every((x) => trig(x) === `${ctx.operation.id}:1|1`), `each keeps round 1's trigger (${before.map(trig)})`);
    const round2 = await verifyAgain(ctx.fx.engine, ctx.project, ctx.operation.id);
    await tick(ctx.fx.engine, ctx.project, { rounds: 4 });
    const xs2 = executionsOfRound(ctx.fx.home, ctx.candidate.id, round2.id);
    assert.ok(xs2.every((x) => !before.some((b) => b.id === x.id) && x.trigger.generation === round2.round), 'round 2 names none of round 1\'s executions');
    assert.deepEqual(executionsOfRound(ctx.fx.home, ctx.candidate.id, ctx.round1.id).map(trig), before.map(trig), 'round 1\'s executions are as they were');
  });
});

describe('M315 (h) concurrent requests for verification are ordered rounds; the route\'s refusals', () => {
  test('two simultaneous POST …/verify after round 1 failed: two rounds, numbered 2 and 3 in registration order, each with its own execution; the newest decides', async (t) => {
    const ctx = await atRound1(t);
    await recordExit(ctx.fx.engine, ctx.x1.id, 1);
    await rowWhen(ctx, ctx.round1.id);
    await tick(ctx.fx.engine, ctx.project, { rounds: 2 });
    const both = await Promise.all([1, 2].map(() => requestVerify(ctx.fx.engine, ctx.project, ctx.operation.id)));
    for (const res of both) assert.equal(res.status, 202, `each request registers a round (body: ${res.text})`);
    assert.deepEqual(both.map((r) => r.body.round.round).sort(), [2, 3], 'rounds 2 and 3');
    const rounds = roundsOf(ctx.fx.home, ctx.operation.id);
    assert.deepEqual(rounds.map((r) => r.round), [1, 2, 3], 'ordered rounds of the attempt');
    const r3 = rounds.find((r) => r.round === 3);
    const [x3] = await roundExecutions(ctx, r3.id);
    await recordExit(ctx.fx.engine, x3.id, 0);
    for (const x of executionsOfRound(ctx.fx.home, ctx.candidate.id, rounds[1].id)) if (x.status === 'queued') await recordExit(ctx.fx.engine, x.id, 1);
    await tickUntil(ctx.fx.engine, ctx.project, () => (progressOf(ctx.fx.home, ctx.candidate.id) === 'alpha_deployed' ? true : undefined), { max: 12, what: 'round 3, the newest, to decide' });
    assert.equal(environmentRecord(ctx.fx.home, ctx.env.id).last_verified?.round, r3.id, 'last_verified names round 3');
  });

  test('POST …/verify for an operation that is not the project\'s is 404; for a deploy that failed before its effect, 409 operation_not_verifiable, with no round', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    const unknown = await requestVerify(fx.engine, ctx.project, 'op_01J00000000000000000000000');
    assert.equal(unknown.status, 404, `an unknown operation (body: ${unknown.text})`);
    await setAdmission(fx.engine, ctx.env.id, 'held');
    await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    const op = await tickUntil(fx.engine, ctx.project, () => operationsOf(fx.home, ctx.project, 'deploy')[0], { max: 8, what: 'the deploy to be intended' });
    await advanceClock(fx.engine, 1801);
    await tickUntil(fx.engine, ctx.project, () => (operationsOf(fx.home, ctx.project, 'deploy')[0].status === 'failed' ? true : undefined), { max: 12, what: 'the deploy to fail at its deadline' });
    const res = await requestVerify(fx.engine, ctx.project, op.id);
    assertRefused(res, 409, 'operation_not_verifiable', 'a deploy with no confirmed attempt is not verifiable (SEAM.md §266):');
    assert.equal(roundsOf(fx.home, op.id).length, 0, 'no round');
  });
});
