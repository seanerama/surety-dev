// M325, the environment lease and the orchestration deadline (slice 26).
// M4 plan §3.4 M325 (a), (c) to (f); D4-O07, D4-O12, D4-O13; D4 §§4.5, 4.7;
// J9; E115; BS4 §11.1 CD1; SEAM.md §§18, 247, 250, 266, 267, 269 to 275.
//
// Kernel lane, on the scripted deployment adapter and the engine's
// controlled clock. (a) A second deploy and an ordinary teardown wait for
// the lease (`environment_busy`) while an operation holds it, until its
// verification is computed and its completion evaluated. (c) The
// orchestration deadline survives a restart made near it and is never
// renewed by a tick or a retry. (d) Reaching it with a registration missing,
// a check quarantined, a check's admission starved or a read outstanding
// records the verification `unknown` with `missing` naming each, synthesizes
// no result, claims no termination, and emits `deploy.orchestration_deadline`.
// (e) Each way out of D4 §4.7 releases the lease by its rule, never before
// the effect is quiescent. (f) CD1 (b): a re-verification requested after
// the operation's deadline has its own `deadline_at`, takes the lease again,
// and on reaching it is recorded `unknown` naming `deadline`.
//
// Pinned elsewhere (COVERAGE.md "M4 slice 26"): reaching the deadline before
// the effect (admission not granted) is M306's last case and M319 (a);
// abandonment of a partial deploy releasing the lease is M323 (b); a link
// still open at a way out is M325-the-lease-held-until-the-links-close
// (sandbox); a domain of unknown termination keeping its quarantine and
// reservation is M322 (c) (sandbox). Deferred: (b), an observation during the
// operation, needs slice 27's observation job; a preempting teardown during
// verification (D4-O13's last way out) is M327 (b), slice 27.
//
// SAFETY: no unit, no systemctl, no host process. The only kill is of this
// test's own engine child (killOwnEngine reads its /proc first), in (c).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { successor } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { executionsOf } from './harness/checks/fixtures.mjs';
import { changePolicy } from './harness/journal.mjs';
import { advanceClock, scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import {
  adapterState,
  attemptsOf,
  deploy,
  deployToRound,
  deployable,
  effectCalls,
  environmentLeases,
  operationsOf,
  operationRow,
  scriptCall,
  setAdmission,
  setTarget,
  teardown,
  unitName,
} from './harness/deploy/kernel.mjs';
import { alphaCompleteRows, executionsOfRound, recordExit, requestVerify, roundRow, roundsOf, rowOf, rowWhen, stepExecution, verifyAgain, workEntry } from './harness/deploy/rounds.mjs';
import { CLOCK_OFFSET, armBarrier, atReceipt, attemptWhen, firstRead, killOwnEngine, leaseHeld, releaseBarrier, scriptedUnit, waitingAt } from './harness/deploy/recover.mjs';
import { requestTick } from './harness/runs.mjs';

const DEADLINE = 1800;
const ms = (iso) => Date.parse(iso);

async function pausedAt(fx, project, name) {
  for (let i = 0; i < 12; i++) {
    await requestTick(fx.engine, project);
    try {
      await waitingAt(fx.engine, name, { timeoutMs: 3000 });
      return;
    } catch {
      // another tick
    }
  }
  assert.fail(`the engine never waited at ${name}`);
}

const opNow = (ctx, id) => operationRow(ctx.fx.home, id);
const resultsOf = (home, execution) => withStore(home, (db) => db.prepare('SELECT * FROM "check_results" WHERE "execution" = ?').all(execution));
const deadlineEvents = (home, op) => eventsOfType(home, 'deploy.orchestration_deadline').filter((e) => e.subject?.operation === op);

// The row of a round reached by the deadline: unknown, `missing` naming the
// deadline and `what` (kinds, and an id where one is given), the event
// emitted, the lease released.
function assertDeadlineRow(ctx, op, row, { kinds = [], ids = [] }) {
  assert.equal(row.outcome, 'unknown', `the deadline reached: the verification is unknown (D4 §4.7) (${row.outcome})`);
  const missing = row.missing ?? [];
  for (const kind of kinds) assert.ok(missing.some((m) => m.kind === kind), `missing names ${kind} (${JSON.stringify(missing)})`);
  for (const id of ids) assert.ok(missing.some((m) => m.id === id), `missing names ${id} (${JSON.stringify(missing)})`);
  assert.equal(deadlineEvents(ctx.fx.home, op).length, 1, 'deploy.orchestration_deadline is emitted once for the operation');
  assert.equal(leaseHeld(ctx.fx.home, ctx.env.id), false, 'the lease is released (D4 §4.7: verification unknown)');
}

describe('M325 (a) the lease is held from the intent until completion is evaluated', () => {
  test('an ordinary teardown requested while the deploy is in verification waits, and is intended only after the completion\'s evaluation released the lease', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    const { operation: op1, execution } = await deployToRound(ctx);
    await scriptCall(fx.engine, ctx.env.id, 'teardown', [{ result: 'issued', apply: true }]);
    const asked = await teardown(fx.engine, ctx.project, ctx.env.name);
    assert.ok(asked.status >= 200 && asked.status < 300, `the teardown is accepted (→ ${asked.status} ${asked.text})`);
    await tick(fx.engine, ctx.project, { rounds: 3 });
    assert.deepEqual(operationsOf(fx.home, ctx.project, 'teardown'), [], 'no teardown operation while the deploy holds the lease (environment_busy)');
    assert.ok(leaseHeld(fx.home, ctx.env.id));
    await recordExit(fx.engine, execution.id, 0);
    const down = await tickUntil(fx.engine, ctx.project, () => operationsOf(fx.home, ctx.project, 'teardown')[0], { max: 16, what: 'the teardown to be intended' });
    const [lease1] = environmentLeases(fx.home, ctx.env.id);
    const evaluated = alphaCompleteRows(fx.home, ctx.candidate.id).at(-1);
    assert.ok(evaluated, 'completion was evaluated');
    assert.ok(lease1.released_at && ms(down.created_at) >= ms(lease1.released_at), 'the teardown was intended after the deploy\'s lease was released');
    assert.ok(ms(lease1.released_at) >= ms(evaluated.created_at), 'and the lease was released no earlier than completion\'s evaluation');
    assert.ok(op1.id);
  });

  test('a second deploy (of a successor) waits environment_busy while the first is in verification, and is intended only once its completion was evaluated (here refused: the first candidate superseded)', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    const { operation: op1, execution } = await deployToRound(ctx);
    await stepExecution(fx.engine, execution.id, 'materializing');
    await stepExecution(fx.engine, execution.id, 'running');
    const next = await successor(fx, { project: { id: ctx.project } });
    for (const x of executionsOf(fx.home, next.id).filter((e) => ['acc', 'smoke'].includes(e.key) && e.status === 'queued')) await recordExit(fx.engine, x.id, 0);
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }]);
    const request2 = await deploy(fx.engine, ctx.project, next.id, ctx.env.name);
    await tick(fx.engine, ctx.project, { rounds: 3 });
    assert.equal(operationsOf(fx.home, ctx.project, 'deploy').length, 1, 'the second deploy is not intended while the first holds the lease');
    const waiting = await workEntry(fx.engine, ctx.project, request2.work_item.id);
    assert.ok(JSON.stringify(waiting).includes('environment_busy'), `its work item shows environment_busy (D4 §4.5, A.2) (SEAM.md §276) (${JSON.stringify(waiting)})`);
    await stepExecution(fx.engine, execution.id, 'collecting');
    await stepExecution(fx.engine, execution.id, 'recorded', { exit_status: 0 });
    const op2 = await tickUntil(fx.engine, ctx.project, () => operationsOf(fx.home, ctx.project, 'deploy').find((o) => o.id !== op1.id), { max: 16, what: 'the second deploy to be intended' });
    const [lease1] = environmentLeases(fx.home, ctx.env.id);
    const evaluated = alphaCompleteRows(fx.home, ctx.candidate.id).at(-1);
    assert.ok(evaluated, 'the first operation\'s completion was evaluated');
    assert.ok(ms(lease1.released_at) >= ms(evaluated.created_at), 'its lease was released no earlier than that evaluation');
    assert.ok(ms(op2.created_at) >= ms(lease1.released_at), 'and the second was intended after the release');
  });
});

describe('M325 (c) the orchestration deadline survives a restart and is never renewed', () => {
  test('a restart made near the deadline (the clock carried across it), then ticks: the deadline unchanged; reached, the operation fails before its effect with nothing applied', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await setAdmission(fx.engine, ctx.env.id, 'held');
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }]);
    await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    const op = await tickUntil(fx.engine, ctx.project, () => operationsOf(fx.home, ctx.project, 'deploy')[0], { what: 'the deploy to be intended' });
    const deadline = op.orchestration_deadline_at;
    assert.equal(ms(deadline) - ms(op.created_at), DEADLINE * 1000, 'the deadline is the intent plus deploy_orchestration_deadline');
    await advanceClock(fx.engine, DEADLINE - 60);
    // SIGKILL to this test's own engine child, then a start with the clock carried across (SEAM.md §273).
    await killOwnEngine(fx);
    await fx.start({ args: [CLOCK_OFFSET, String(DEADLINE - 60)] });
    assert.equal(opNow(ctx, op.id).orchestration_deadline_at, deadline, 'unchanged across the restart');
    await tick(fx.engine, ctx.project, { rounds: 3 });
    assert.equal(opNow(ctx, op.id).orchestration_deadline_at, deadline, 'unchanged by ticks');
    await advanceClock(fx.engine, 61);
    const done = await tickUntil(fx.engine, ctx.project, () => (opNow(ctx, op.id).status === 'failed' ? opNow(ctx, op.id) : undefined), { max: 12, what: 'the operation to fail at its deadline' });
    assert.deepEqual([done.outcome_detail?.code, done.outcome_detail?.fact], ['EFFECT_PRECONDITION_CHANGED', 'orchestration_deadline'], `reached before the effect: failed, nothing applied (${JSON.stringify(done.outcome_detail)})`);
    assert.equal(effectCalls(await adapterState(fx.engine, ctx.env.id), 'deploy').length, 0, 'no effect call');
    assert.equal(done.orchestration_deadline_at, deadline);
  });

  test('a retry near the deadline (attempt 1 read absent at deadline minus 60 s): attempt 2 runs under the same, unrenewed deadline', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued' }, { result: 'issued', apply: true }]);
    await armBarrier(fx.engine, 'deploy.receipt_recorded', 'pause');
    await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    await pausedAt(fx, ctx.project, 'deploy.receipt_recorded');
    const [op] = operationsOf(fx.home, ctx.project, 'deploy');
    const deadline = op.orchestration_deadline_at;
    await advanceClock(fx.engine, DEADLINE - 60);
    await releaseBarrier(fx.engine, 'deploy.receipt_recorded');
    const a2 = await attemptWhen(ctx, op.id, 2, (a) => a.status !== 'started', 'the retry near the deadline');
    assert.equal(a2.deployment_generation, 2);
    assert.equal(opNow(ctx, op.id).orchestration_deadline_at, deadline, 'the retry renewed nothing');
  });
});

describe('M325 (d) the deadline reached in verification', () => {
  test('a registration missing (the clock passes the deadline right after the round is registered): unknown, missing naming the check execution and the deadline; no result synthesized', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }]);
    await armBarrier(fx.engine, 'deploy.round_registered', 'pause');
    await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    await pausedAt(fx, ctx.project, 'deploy.round_registered');
    const [op] = operationsOf(fx.home, ctx.project, 'deploy');
    const [round] = roundsOf(fx.home, op.id);
    assert.equal(executionsOfRound(fx.home, ctx.candidate.id, round.id).length, 0, 'the fixture is live: nothing registered yet');
    await advanceClock(fx.engine, DEADLINE + 1);
    await releaseBarrier(fx.engine, 'deploy.round_registered');
    const row = await rowWhen(ctx, round.id);
    assertDeadlineRow(ctx, op.id, row, { kinds: ['deadline', 'check_execution'] });
    for (const x of executionsOfRound(fx.home, ctx.candidate.id, round.id)) assert.deepEqual(resultsOf(fx.home, x.id).filter((r) => r.execution_established), [], 'no result synthesized');
  });

  test('a check quarantined: unknown, missing naming the execution; the execution stays quarantined (no termination claimed) and has no result', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    const { operation: op, execution } = await deployToRound(ctx);
    await stepExecution(fx.engine, execution.id, 'materializing');
    await stepExecution(fx.engine, execution.id, 'quarantined');
    await advanceClock(fx.engine, DEADLINE + 1);
    const row = await rowWhen(ctx, roundsOf(fx.home, op.id)[0].id);
    assertDeadlineRow(ctx, op.id, row, { kinds: ['deadline'], ids: [execution.id] });
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT "status" FROM "check_executions" WHERE "id" = ?').get(execution.id)).status, 'quarantined', 'no termination is claimed');
    assert.deepEqual(resultsOf(fx.home, execution.id), [], 'no result synthesized');
  });

  test('a check\'s admission starved (its execution never admitted): unknown, missing naming the execution; no result synthesized', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    const { operation: op, execution } = await deployToRound(ctx);
    await advanceClock(fx.engine, DEADLINE + 1);
    const row = await rowWhen(ctx, roundsOf(fx.home, op.id)[0].id);
    assertDeadlineRow(ctx, op.id, row, { kinds: ['deadline'], ids: [execution.id] });
    assert.deepEqual(resultsOf(fx.home, execution.id).filter((r) => r.execution_established), [], 'no result synthesized');
  });

  test('a read outstanding (the deadline passes before the second identity read): unknown, missing naming the identity read; no second read recorded as a match', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    const { operation: op, execution } = await deployToRound(ctx);
    await armBarrier(fx.engine, 'verify.before_second_read', 'pause');
    await recordExit(fx.engine, execution.id, 0);
    await pausedAt(fx, ctx.project, 'verify.before_second_read');
    await advanceClock(fx.engine, DEADLINE + 1);
    await releaseBarrier(fx.engine, 'verify.before_second_read');
    const row = await rowWhen(ctx, roundsOf(fx.home, op.id)[0].id);
    assertDeadlineRow(ctx, op.id, row, { kinds: ['deadline', 'identity_read'] });
    assert.ok(!(row.identity_reads ?? []).some((r) => r.bracket === 'second' && r.match === 'match'), `no second read recorded as a match (${JSON.stringify(row.identity_reads)})`);
  });
});

describe('M325 (e) each way out of D4 §4.7 releases the lease by its rule', () => {
  test('a reconciled failure (absent, not retried) with the effect not yet quiescent: the lease held while a manager job is pending, released only after the absent read', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await changePolicy(fx.engine, ctx.project, { deploy_auto_retries_max: 0 });
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued' }]);
    const g1 = unitName(fx.home, ctx.env.id, 1);
    const op = await atReceipt(ctx, 'deploy', () => deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name), (target) => ({ ...target, units: [scriptedUnit(g1, 1, { state: 'inactive', pending_job: true, instance: 'unread', init: 'unread', tree: 'unread' })] }));
    await firstRead(ctx, op.id);
    await tick(fx.engine, ctx.project, { rounds: 3 });
    assert.ok(leaseHeld(fx.home, ctx.env.id), 'not quiescent: the lease is held');
    await setTarget(fx.engine, ctx.env.id, { complete: true, units: [], resources: [] });
    const a = await attemptWhen(ctx, op.id, 1, (x) => x.status === 'reconciled_absent', 'the absent read');
    await tick(fx.engine, ctx.project, { rounds: 2 });
    assert.equal(opNow(ctx, op.id).status, 'failed', 'absent, not retried (deploy_auto_retries_max 0): the operation fails');
    const [lease] = environmentLeases(fx.home, ctx.env.id);
    const absentAt = a.reconciliation_reads.find((r) => r.result === 'absent').at;
    assert.ok(lease.released_at && ms(lease.released_at) >= ms(absentAt), 'released, and only after the read that established quiescence and absence');
  });

  test('verification failed: the lease released; the work waits on a blocker naming the cause; re-verification and an ordinary teardown are then available', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    const { operation: op, execution, request } = await deployToRound(ctx);
    await recordExit(fx.engine, execution.id, 1);
    await rowWhen(ctx, roundsOf(fx.home, op.id)[0].id);
    await tick(fx.engine, ctx.project, { rounds: 2 });
    assert.equal(leaseHeld(fx.home, ctx.env.id), false, 'released');
    const work = await workEntry(fx.engine, ctx.project, request.work_item.id);
    assert.ok(/VERIFICATION_FAILED|verification_failed/.test(JSON.stringify(work)), `the work item waits on a blocker naming the cause (${JSON.stringify(work)})`);
    const round2 = await verifyAgain(fx.engine, ctx.project, op.id);
    assert.equal(round2.round, 2, 're-verification is offered');
  });

  test('a candidate superseded meanwhile, its queued check cancelled: the lease released', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    const { operation: op, execution } = await deployToRound(ctx);
    await successor(fx, { project: { id: ctx.project } });
    await tickUntil(fx.engine, ctx.project, () => (withStore(fx.home, (db) => db.prepare('SELECT "status" FROM "check_executions" WHERE "id" = ?').get(execution.id)).status === 'cancelled' ? true : undefined), { max: 8, what: 'the queued check to be cancelled (D3)' });
    await tick(fx.engine, ctx.project, { rounds: 3 });
    assert.equal(leaseHeld(fx.home, ctx.env.id), false, 'released (D4 §4.7)');
    assert.notEqual(rowOf(fx.home, roundsOf(fx.home, op.id)[0].id)?.outcome, 'verified', 'nothing verified');
  });

  test('a refused completion (the candidate superseded while its check ran, then verified): the lease released; the work waits on a blocker naming CANDIDATE_SUPERSEDED', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    const { operation: op, execution, request } = await deployToRound(ctx);
    await stepExecution(fx.engine, execution.id, 'materializing');
    await stepExecution(fx.engine, execution.id, 'running');
    await successor(fx, { project: { id: ctx.project } });
    await stepExecution(fx.engine, execution.id, 'collecting');
    await stepExecution(fx.engine, execution.id, 'recorded', { exit_status: 0 });
    await rowWhen(ctx, roundsOf(fx.home, op.id)[0].id);
    await tick(fx.engine, ctx.project, { rounds: 3 });
    assert.equal(leaseHeld(fx.home, ctx.env.id), false, 'released after the refused completion');
    const work = await workEntry(fx.engine, ctx.project, request.work_item.id);
    assert.ok(JSON.stringify(work).includes('CANDIDATE_SUPERSEDED'), `the blocker names the cause (${JSON.stringify(work)})`);
  });
});

describe('M325 (f) CD1: a re-verification requested after the operation\'s deadline', () => {
  test('the round has its own deadline_at, takes the lease again, and reaching it records the round unknown naming deadline; the operation\'s deadline is unchanged', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    const { operation: op, execution } = await deployToRound(ctx);
    await recordExit(fx.engine, execution.id, 1);
    await rowWhen(ctx, roundsOf(fx.home, op.id)[0].id);
    await tick(fx.engine, ctx.project, { rounds: 2 });
    const opDeadline = opNow(ctx, op.id).orchestration_deadline_at;
    const leasesBefore = environmentLeases(fx.home, ctx.env.id).length;
    await advanceClock(fx.engine, DEADLINE + 1);
    const res = await requestVerify(fx.engine, ctx.project, op.id);
    assert.equal(res.status, 202, `CD1 (b): a re-verification after the operation's deadline is registered (→ ${res.status} ${res.text})`);
    const round = roundRow(fx.home, res.body.round.id);
    assert.equal(ms(round.deadline_at) - ms(round.registered_at), DEADLINE * 1000, `its own deadline_at: its registration plus deploy_orchestration_deadline (${round.registered_at} → ${round.deadline_at})`);
    await tickUntil(fx.engine, ctx.project, () => (environmentLeases(fx.home, ctx.env.id).length > leasesBefore ? true : undefined), { max: 8, what: 'the round to take the lease again' });
    await advanceClock(fx.engine, DEADLINE + 1);
    const row = await rowWhen(ctx, round.id);
    assert.equal(row.outcome, 'unknown');
    assert.ok((row.missing ?? []).some((m) => m.kind === 'deadline'), `missing names deadline (${JSON.stringify(row.missing)})`);
    assert.equal(opNow(ctx, op.id).orchestration_deadline_at, opDeadline, 'the operation\'s deadline is unchanged and never reopened');
    assert.equal(roundRow(fx.home, round.id).deadline_at, round.deadline_at, 'the round\'s deadline was never renewed');
    await tick(fx.engine, ctx.project, { rounds: 2 });
    assert.equal(leaseHeld(fx.home, ctx.env.id), false, 'the round released the lease');
    assert.ok(attemptsOf(fx.home, op.id).length === 1);
  });
});
