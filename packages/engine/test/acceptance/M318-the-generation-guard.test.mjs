// M318, the generation guard; a candidate superseded meanwhile (slice 25).
// M4 plan §3.3 M318; D4-V08, D4-O08; D4 §§4.5, 5.3, 5.5; J5, J9; E114,
// E121 CD1; SEAM.md §§246, 247, 249, 250, 265, 266, 269.
//
// Kernel lane. Every write that speaks for the environment checks, in its
// own transaction, the environment's current generation and, for
// verification, the deciding round (D4 §4.5).
//
// (a), (b) are reached through CD1 (SEAM.md §269): an older operation's
// operator round (`POST …/operations/:o/verify`) takes the environment lease
// again, so it waits (`environment_busy`) while a later deploy of the same
// candidate, issued after the older operation ended, takes the lease and
// generation 2. Generation 1's unit is scripted back onto the target, so the
// older round's reads match when it finally runs: its row is recorded with
// its computed outcome and `generation_superseded`, writes neither
// `last_verified` nor `attempted`, and a late completion evaluation of the
// older operation is refused `DEPLOY_GENERATION_SUPERSEDED`. The form of (a)
// with a preempting teardown is slice 27's (M327; COVERAGE.md "M4 slice 25").
//
// (c) a candidate superseded after its attempt's effect: the deployment
// completes and is verified as an environment fact (`last_verified`, J5),
// `alpha_complete` is refused `CANDIDATE_SUPERSEDED`, the candidate stays
// `developing`. The round's check is already running when the successor is
// nominated, since D3 cancels a superseded candidate's queued checks (D4
// §4.7). "Before the effect: nothing deployed" is M306's case "the candidate
// superseded by a later nomination on its lineage" (slice 23), the same
// observation.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { successor } from './harness/gates.mjs';
import { scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { armBarrier, attemptsOf, deploy, deployable, deployToRound, operationsOf, releaseBarrier, scriptCall, tickToBarrier, unitName } from './harness/deploy/kernel.mjs';
import {
  changeTarget,
  completion,
  environmentRecord,
  executionsOfRound,
  progressOf,
  reasonCodesOf,
  recordExit,
  roundExecutions,
  roundsOf,
  rowOf,
  rowWhen,
  stepExecution,
  verifyAgain,
} from './harness/deploy/rounds.mjs';

describe('M318 (a), (b) an older operation\'s round arriving after a newer generation', () => {
  test('operation 1\'s operator round waits for the lease while operation 2 takes generation 2; recorded after it with generation_superseded, it writes neither last_verified nor attempted, and a late completion evaluation of operation 1 is refused DEPLOY_GENERATION_SUPERSEDED', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    // Operation 1: generation 1, its first round failed (so the candidate stays developing and the lease is released).
    const { operation: op1, execution: x11 } = await deployToRound(ctx);
    const [r11] = roundsOf(fx.home, op1.id);
    await recordExit(fx.engine, x11.id, 1);
    await rowWhen({ fx, project: ctx.project }, r11.id);
    await tick(fx.engine, ctx.project, { rounds: 2 });
    const g1 = (await changeTarget(fx.engine, ctx.env.id, (target) => target)).units.find((u) => u.generation === 1);
    assert.ok(g1, 'the fixture is live: generation 1 runs');

    // Operation 2, a deliberate new request after operation 1 ended, held right after its intent (it holds the lease).
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }]);
    await armBarrier(fx.engine, 'deploy.intended', 'pause');
    const request2 = await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    await tickToBarrier(fx, ctx.project, 'deploy.intended');
    const op2 = operationsOf(fx.home, ctx.project, 'deploy').find((o) => o.id !== op1.id);
    assert.ok(op2 && op2.finalizer_inputs.authorization === request2.authorization.id, 'the fixture is live: operation 2 is intended under a new authorization');

    // Operation 1's operator round, registered now; it must wait for the lease (CD1).
    const r12 = await verifyAgain(fx.engine, ctx.project, op1.id);
    await releaseBarrier(fx.engine, 'deploy.intended');
    const x2 = await tickUntil(fx.engine, ctx.project, () => {
      const r = roundsOf(fx.home, op2.id)[0];
      return r ? executionsOfRound(fx.home, ctx.candidate.id, r.id)[0] : undefined;
    }, { max: 16, what: 'operation 2 to reach its round' });
    const [a2] = attemptsOf(fx.home, op2.id);
    assert.equal(a2.deployment_generation, 2, 'operation 2\'s attempt is generation 2');
    assert.equal(executionsOfRound(fx.home, ctx.candidate.id, r12.id).length, 0, 'while operation 2 holds the lease, operation 1\'s round registers nothing (it waits, environment_busy)');

    // Generation 1's unit scripted back beside generation 2, so operation 1's reads will match.
    await changeTarget(fx.engine, ctx.env.id, (target) => ({ ...target, units: [...target.units.filter((u) => u.name !== unitName(fx.home, ctx.env.id, 1)), g1] }));
    await recordExit(fx.engine, x2.id, 1);
    const attemptedByOp2 = await tickUntil(fx.engine, ctx.project, () => {
      const a = environmentRecord(fx.home, ctx.env.id).attempted;
      return a?.operation === op2.id && a.outcome === 'verification_failed' ? a : undefined;
    }, { max: 12, what: 'operation 2\'s verification to be recorded' });

    // Operation 1's round now runs, under generation 1, after generation 2 became current.
    const [x12] = await roundExecutions({ fx, project: ctx.project, candidate: ctx.candidate }, r12.id, { max: 20 });
    await recordExit(fx.engine, x12.id, 0);
    const row = await rowWhen({ fx, project: ctx.project }, r12.id);
    assert.equal(row.deployment_generation, 1, 'the row is generation 1\'s');
    assert.equal(row.outcome, 'verified', `it is recorded with its computed outcome (D4 §4.5) (${row.outcome})`);
    assert.equal(row.invalidated_reason, 'generation_superseded', `and invalidated generation_superseded in that transaction (${row.invalidated_reason})`);
    assert.ok(row.invalidated_at, 'invalidated_at is set');
    await tick(fx.engine, ctx.project, { rounds: 2 });
    const record = environmentRecord(fx.home, ctx.env.id);
    assert.equal(record.last_verified ?? null, null, '(b) last_verified is not written from a generation no longer current');
    assert.deepEqual([record.attempted?.operation, record.attempted?.generation, record.attempted?.outcome], [op2.id, 2, attemptedByOp2.outcome], `(b) attempted is still operation 2's, generation 2 (${JSON.stringify(record.attempted)})`);
    const late = await completion(fx.engine, ctx.project, ctx.candidate.id, op1.id);
    assert.equal(late.outcome, 'not_satisfied');
    assert.ok(reasonCodesOf(late).includes('DEPLOY_GENERATION_SUPERSEDED'), `a late completion evaluation of operation 1 is refused (${JSON.stringify(late.reasons)})`);
    assert.equal(progressOf(fx.home, ctx.candidate.id), 'developing', 'the candidate stays developing');
    assert.ok(rowOf(fx.home, r12.id), 'the older row is kept as history');
  });
});

describe('M318 (c) a candidate superseded after its attempt\'s effect', () => {
  test('the round\'s check running when a successor is nominated: verified as the environment\'s fact (last_verified names the superseded candidate), alpha_complete refused CANDIDATE_SUPERSEDED, the candidate developing, the successor not deployed', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    const { operation, execution } = await deployToRound(ctx);
    const [round] = roundsOf(fx.home, operation.id);
    await stepExecution(fx.engine, execution.id, 'materializing');
    await stepExecution(fx.engine, execution.id, 'running');
    const next = await successor(fx, { project: { id: ctx.project } });
    assert.notEqual(next.id, ctx.candidate.id, 'the fixture is live: a successor is nominated');
    await stepExecution(fx.engine, execution.id, 'collecting');
    await stepExecution(fx.engine, execution.id, 'recorded', { exit_status: 0 });
    const row = await rowWhen({ fx, project: ctx.project }, round.id);
    assert.equal(row.outcome, 'verified', `the deployment is verified as an environment fact (D4 §4.5) (${row.outcome})`);
    await tick(fx.engine, ctx.project, { rounds: 3 });
    const record = environmentRecord(fx.home, ctx.env.id);
    assert.deepEqual([record.last_verified?.candidate, record.last_verified?.round], [ctx.candidate.id, round.id], 'last_verified names the superseded candidate and its round (J5)');
    const evaluation = await completion(fx.engine, ctx.project, ctx.candidate.id, operation.id);
    assert.ok(reasonCodesOf(evaluation).includes('CANDIDATE_SUPERSEDED'), `alpha_complete is refused (D3 Q9) (${JSON.stringify(evaluation.reasons)})`);
    assert.equal(progressOf(fx.home, ctx.candidate.id), 'developing', 'the superseded candidate stays developing: the environment fact and the candidate fact are distinct (M70)');
    assert.notEqual(progressOf(fx.home, next.id), 'alpha_deployed', 'the successor is not deployed by it');
  });
});
