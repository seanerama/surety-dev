// M15, what decides a run's outcome when two causes meet (slice 3; the final
// slice-2 review, E28). Plan §3.2 M13 and M15; D1 §§4.1, 4.5, 8.1 step 1,
// 8.3, 8.4; E27 items 3, 5 and 7; E28 item 2; SEAM.md §§16, 17 and 24.
//
// A run has one outcome, set once. Slice 2 pinned which cause wins when a
// lease expires after something else had decided the run's end. The final
// review of slice 2 found three more meetings of two causes that no test
// pinned:
//
//   - a Stop confirmed while the engine is retrying a deadline end. The
//     deadline was acted on first: the run ends timed_out and its work is
//     parked behind the deadline blocker. The Stop is refused, as for a run
//     that has ended;
//   - a Stop or an Abandon confirmed after the lease has expired and before a
//     tick has acted on the expiry. Nothing had decided the run's end yet, so
//     the operator's command is recorded as given (E28 item 2);
//   - a role that exited 0 after its result was accepted, with the clock
//     jumping past lease_ttl before the engine has acted on the exit. The
//     result was accepted on a live lease and the role exited cleanly before
//     the expiry: the run ends completed.
// The clock is the controlled clock.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { armFault, waitFor } from './harness/engine.mjs';
import { CONTRACT, assertRefused } from './harness/fixtures.mjs';
import { assertOneRunAtATime, assertWorkHistory, eventsAbout } from './harness/invariants.mjs';
import {
  abandonRun,
  addProject,
  addWork,
  advanceClock,
  advanceClockInSteps,
  assertRunEnded,
  getRow,
  leasesOf,
  run as runRow,
  runsOf,
  scriptedEngine,
  stopRun,
  tick,
  tickUntil,
  waitForRun,
  waitForRunState,
  waitForWork,
  workItem,
} from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const ms = (iso) => Date.parse(iso);
const SHORT_TTL = CONTRACT.engine.lease_ttl.min;
const runLease = (home, runId) => leasesOf(home, runId).find((l) => l.resource_kind === 'run' && l.released_at === null);

describe('M15 a Stop confirmed while a deadline end is being retried does not replace the outcome already decided (final review)', () => {
  // The longest lease and a role that heartbeats four times a second: nothing
  // here expires because the clock moved.
  const TTL = CONTRACT.engine.lease_ttl.max;
  const STEP = Math.floor(TTL / 2);
  const DEADLINE = CONTRACT.project.deadline_reviewer.default;
  // Each of the engine's attempts to enter finalizing fails, this many times,
  // so that the end it decided at the deadline is still unrecorded, and being
  // retried, when the Stop arrives.
  const FAULTS = 8;
  // The clock is taken to this many seconds before the deadline in steps, and
  // across it in one last, short step, so the moment the deadline passes is known.
  const SHORT_OF_DEADLINE = 60;

  test('the Stop is refused with illegal_transition, the run ends timed_out and the work is parked behind the deadline blocker', async (t) => {
    const fx = await scriptedEngine(t, { config: { lease_ttl: TTL } });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'review');
    fx.scripted.script(item, [script.hold('gate', { heartbeat_ms: 250 })]);
    fx.scripted.defaultScript(script.complete());
    await tick(fx.engine, project);
    const launch = await fx.scripted.waitForHolding({ work_item: item });
    const first = await waitForRun(fx.home, item, { state: 'executing' });
    const next = await addWork(fx.engine, project, 'verification');

    // The confirmation is raised while the run is under way, before its deadline.
    const stopPath = `/v1/projects/${project}/runs/${first.id}/stop`;
    const asked = await fx.engine.post(stopPath, {});
    assertRefused(asked, 409, 'confirm_required', 'Stop without a preview hash');
    const { decision, preview_hash: previewHash } = asked.body.subject;

    for (let i = 0; i < FAULTS; i++) await armFault(fx.engine, { point: 'before_event', event_type: 'run.finalizing' });
    await advanceClockInSteps(fx.engine, DEADLINE - SHORT_OF_DEADLINE, { stepSeconds: STEP, pauseMs: 1200 });
    assert.deepEqual([runRow(fx.home, first.id).state, runRow(fx.home, first.id).outcome], ['executing', null], 'short of its deadline the run goes on');
    const { now } = (await advanceClock(fx.engine, SHORT_OF_DEADLINE + 5)).body;
    assert.ok(ms(first.deadline_at) < ms(now), `the clock (${now}) is past the deadline of the run (${first.deadline_at})`);
    // What became due is acted on within two seconds (SEAM.md §18): after
    // this the engine has decided to end the run, and has failed to record it.
    await sleep(2500);
    const pending = runRow(fx.home, first.id);
    assert.deepEqual(
      [pending.state, pending.outcome],
      ['executing', null],
      `two and a half seconds past its deadline, with ${FAULTS} faults armed on run.finalizing, the run has already recorded its end (${pending.state}, ${pending.outcome}): the engine attempted it more than ${FAULTS} times in that time, and this case cannot reach the state it is about`,
    );
    // E27 item 5, where it can be seen: the end is decided and not yet
    // recorded, the role is alive and sends a heartbeat four times a second,
    // and nothing renews the lease.
    const decided = runLease(fx.home, first.id);
    await sleep(1000);
    const later = runLease(fx.home, first.id);
    assert.ok(fx.scripted.isLive(launch), 'the role is still alive and heartbeating');
    if (decided && later && runRow(fx.home, first.id).outcome === null) {
      assert.deepEqual(
        [later.renewed_at, later.expires_at],
        [decided.renewed_at, decided.expires_at],
        'once the engine has decided to end a run, nothing renews its lease, the role\'s heartbeats included, also while the record of that decision keeps failing',
      );
    }

    // The Stop is confirmed now. A request whose own transaction meets one of
    // the armed faults is refused with a store error and has changed nothing;
    // the operator sends it again.
    let answer;
    for (let i = 0; i <= FAULTS; i++) {
      answer = await fx.engine.post(stopPath, { preview_hash: previewHash });
      if (answer.status !== 500) break;
      assertRefused(answer, 500, 'store_error', 'a Stop whose transaction failed');
    }
    assertRefused(answer, 409, 'illegal_transition', 'a Stop confirmed after the engine had decided to end the run for its deadline');
    assert.notEqual(getRow(fx.home, 'decisions', decision).status, 'consumed', 'the refused confirmation is not consumed');

    // The engine goes on retrying the end it decided. Give it ticks, and let
    // the lease that nothing renews any more expire, until the faults are used up.
    const ended = () => runRow(fx.home, first.id).state === 'ended';
    for (let round = 0; round < FAULTS + 4 && !ended(); round++) {
      if (round < 3) await advanceClock(fx.engine, STEP);
      await tick(fx.engine, project);
      await waitFor(ended, { timeoutMs: 3000, what: 'the run to end' }).catch(() => {});
    }
    const row = runRow(fx.home, first.id);
    assert.deepEqual(
      [row.state, row.outcome, row.reason_class],
      ['ended', 'timed_out', 'deadline'],
      'the deadline was acted on before the Stop was confirmed: its outcome stands',
    );
    assertRunEnded(fx.home, first.id, { outcome: 'timed_out', reason_class: 'deadline', workspace: 'retained', launched: true, recovery: false });
    assert.equal(fx.scripted.isLive(launch), false, 'the role past its deadline was terminated');
    const parked = await waitForWork(fx.home, item, 'parked');
    assert.equal(JSON.parse(parked.blocker).reason, 'deadline', 'the work is parked behind the deadline blocker');
    withStore(fx.home, (db) => {
      assert.equal(eventsAbout(db, 'work_item', item, 'work.held').length, 0, 'the work was never held: the Stop did not take effect');
      assert.deepEqual(assertWorkHistory(db, item), ['eligible', 'claimed', 'executing', 'parked']);
    });
    assert.notEqual(getRow(fx.home, 'decisions', decision).status, 'consumed', 'and the confirmation was never consumed');

    await tickUntil(fx.engine, project, () => workItem(fx.home, next).status === 'complete', { max: 6, what: 'the next item of the project to be dispatched and to complete' });
    assert.equal(runsOf(fx.home, item).length, 1);
    withStore(fx.home, (db) => assertOneRunAtATime(db, project));
  });
});

describe('M15 a Stop or Abandon confirmed after a lease has expired, before a tick has acted on it, is recorded as given (E28 item 2)', () => {
  // A run whose role is alive and whose lease has just expired: one jump of
  // the clock past the lease's whole lifetime, and no tick since.
  async function expiredAndNotYetReconciled(t) {
    const fx = await scriptedEngine(t, { config: { lease_ttl: SHORT_TTL } });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(item, [script.hold('gate', { before: [step.usage({ input_tokens: 3 })], heartbeat_ms: 250 }), script.complete()]);
    fx.scripted.defaultScript(script.complete());
    await tick(fx.engine, project);
    const launch = await fx.scripted.waitForHolding({ work_item: item });
    const first = await waitForRun(fx.home, item, { state: 'executing' });
    const next = await addWork(fx.engine, project, 'review');
    const before = runLease(fx.home, first.id);
    const { now } = (await advanceClock(fx.engine, SHORT_TTL + 5)).body;
    assert.ok(ms(before.expires_at) < ms(now), 'the clock is past the expiry of the lease');
    const row = runRow(fx.home, first.id);
    assert.deepEqual([row.state, row.outcome], ['executing', null], 'no tick has run: nothing has acted on the expiry');
    return { fx, project, item, next, launch, first };
  }

  // After the command, ticks reconcile whatever is left: they must not turn the run into a recovered one.
  async function settleAndGoOn({ fx, project, next, first }) {
    await tick(fx.engine, project);
    await waitForRunState(fx.home, first.id, 'ended');
    await tickUntil(fx.engine, project, () => workItem(fx.home, next).status === 'complete', { max: 6, what: 'the next item of the project to be dispatched and to complete' });
  }

  test('Stop: the run ends stopped, not recovered, and its work is held', async (t) => {
    const s = await expiredAndNotYetReconciled(t);
    const { fx, project, item, launch, first } = s;
    const { decision } = await stopRun(fx.engine, project, first.id);
    assert.equal(getRow(fx.home, 'decisions', decision).status, 'consumed', 'the confirmation was consumed');
    await settleAndGoOn(s);
    const row = runRow(fx.home, first.id);
    assert.deepEqual([row.outcome, row.reason_class], ['stopped', 'human_stop'], 'the operator\'s Stop is recorded as given: the explicit command wins over the recovery outcome');
    const facts = assertRunEnded(fx.home, first.id, { outcome: 'stopped', reason_class: 'human_stop', workspace: 'retained', launched: true, recovery: false });
    assert.equal(facts.receipts[0].usage.length, 1, 'usage observed before the Stop is kept');
    assert.equal(fx.scripted.isLive(launch), false, 'the role is gone');
    assert.equal((await waitForWork(fx.home, item, 'held')).status, 'held');
    withStore(fx.home, (db) => {
      assert.deepEqual(assertWorkHistory(db, item), ['eligible', 'claimed', 'executing', 'held']);
      assertOneRunAtATime(db, project);
    });
  });

  test('Abandon: the run ends abandoned, not recovered, its workspace is discarded and its work waits under a dispatch hold', async (t) => {
    const s = await expiredAndNotYetReconciled(t);
    const { fx, project, item, launch, first } = s;
    const { decision } = await abandonRun(fx.engine, project, first.id);
    assert.equal(getRow(fx.home, 'decisions', decision).status, 'consumed', 'the confirmation was consumed');
    await settleAndGoOn(s);
    const row = runRow(fx.home, first.id);
    assert.deepEqual([row.outcome, row.reason_class], ['abandoned', 'human_abandon'], 'the operator\'s Abandon is recorded as given: the explicit command wins over the recovery outcome');
    // assertRunEnded checks the discard on disk and in git as well as in the store.
    assertRunEnded(fx.home, first.id, { outcome: 'abandoned', reason_class: 'human_abandon', workspace: 'discarded', launched: true, recovery: false });
    assert.equal(fx.scripted.isLive(launch), false, 'the role is gone');
    const work = await waitForWork(fx.home, item, 'eligible');
    assert.equal(work.dispatch_hold, 1, 'the work is back at its prior status, on dispatch hold, not held as after a recovery');
    assert.equal(runsOf(fx.home, item).length, 1, 'and it was not dispatched again');
    withStore(fx.home, (db) => {
      assert.deepEqual(assertWorkHistory(db, item), ['eligible', 'claimed', 'executing', 'eligible']);
      assertOneRunAtATime(db, project);
    });
  });
});

describe('M15 a role that exited 0 after its result was accepted ends completed (final review)', () => {
  test('a clock jump past lease_ttl that lands after the role has exited, and before the engine has acted on the exit, does not make the run recovered', async (t) => {
    const fx = await scriptedEngine(t, { config: { lease_ttl: SHORT_TTL } });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    // The role sends its result and exits 0. It leaves a descendant that
    // keeps the role's stdout open and keeps writing to it, so an engine that
    // goes on reading for a while after the exit has not yet acted on the
    // exit when the clock jumps.
    fx.scripted.script(item, [{ steps: [step.usage({ input_tokens: 5 }), step.result(), step.descendant({ holds_stdout: true, on_term: 'exit', chatter_ms: 100 })] }]);
    await tick(fx.engine, project);
    const [launch] = await fx.scripted.waitForLaunch({ work_item: item });
    const first = await waitForRun(fx.home, item);
    // The result was accepted while the lease was live, and the role has exited 0.
    await waitFor(() => withStore(fx.home, (db) => eventsAbout(db, 'run', first.id, 'run.validating').length) === 1, { what: 'the result to be accepted' });
    await waitFor(() => !fx.scripted.isLive(launch), { intervalMs: 5, what: 'the role to exit' });
    const { now } = (await advanceClock(fx.engine, SHORT_TTL + 5)).body;
    assert.ok(fx.scripted.eventsOf(launch.pid, 'exit').some((e) => e.code === 0), 'the role exited 0');
    const accepted = withStore(fx.home, (db) => eventsAbout(db, 'run', first.id, 'run.validating'))[0];
    assert.ok(ms(accepted.at) < ms(now) - SHORT_TTL * 1000, `the result was accepted (${accepted.at}) before the clock jumped to ${now}`);

    // The engine acts on the exit by itself; a tick reconciles what is left.
    const ended = () => runRow(fx.home, first.id).state === 'ended';
    await waitFor(ended, { timeoutMs: 6000, what: 'the run to end' }).catch(() => {});
    for (let round = 0; round < 3 && !ended(); round++) {
      await tick(fx.engine, project);
      await waitFor(ended, { timeoutMs: 5000, what: 'the run to end' }).catch(() => {});
    }
    const row = runRow(fx.home, first.id);
    assert.deepEqual(
      [row.state, row.outcome, row.reason_class],
      ['ended', 'completed', 'none'],
      'the role\'s result was accepted on a live lease and the role exited 0 before the lease expired: the run is completed, whenever the engine comes to act on the exit',
    );
    assertRunEnded(fx.home, first.id, { outcome: 'completed', reason_class: 'none', workspace: 'retained', launched: true, recovery: false });
    assert.equal((await waitForWork(fx.home, item, 'complete')).status, 'complete');
    const [descendant] = fx.scripted.descendants({ parent: launch.pid });
    assert.ok(descendant, 'the role left a descendant');
    await waitFor(() => !fx.scripted.isLive(descendant), { timeoutMs: 5000, what: 'the descendant to be terminated' });
    withStore(fx.home, (db) => assertWorkHistory(db, item));
  });
});
