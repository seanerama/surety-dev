// M15, leases (slice 2, after the two slice-2 reviews). Plan §3.2 M15
// ("deadlines and stale generations"); D1 §§4.5, 8.1 step 1, 8.3; E25 item 1;
// E27 items 2, 3 and 5; SEAM.md §§13, 15, 16, 18. A run lease is what makes
// an engine's hold on a run finite. The engine renews it by itself at least
// every third of its lifetime while it prepares the run and while it
// supervises the run's live process, so a slow workspace or a role that sends
// no heartbeat does not lose the run. A lease that is not renewed expires,
// and expiry is final: a lease past its expiry is not renewed, a callback
// that presents it is refused, and the tick's first step reconciles it
// through the run-end protocol. A run ended that way, with no outcome decided
// before the expiry, is treated as recovered: its work is held for an
// explicit Resume and no repair attempt is charged. An outcome decided before
// the expiry stands. Once the engine has decided to end a run, nothing renews
// that run's lease, the role's heartbeats included, so the expiry is also the
// backstop under the run-end protocol itself: a run whose end was interrupted
// by one failed store transaction is not left holding its project until the
// next restart, whatever its role goes on doing.
// The clock is the controlled clock; nothing here waits out a real lease.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { armFault, releaseBarrier, waitFor } from './harness/engine.mjs';
import { CONTRACT } from './harness/fixtures.mjs';
import { assertOneRunAtATime, assertWorkHistory, eventsAbout } from './harness/invariants.mjs';
import {
  addProject,
  addWork,
  advanceClock,
  advanceClockInSteps,
  assertRunEnded,
  decisionsAbout,
  leasesOf,
  requestTick,
  resumeWork,
  run as runRow,
  runsOf,
  scriptedEngine,
  tick,
  tickUntil,
  waitForRun,
  waitForRunState,
  waitForWork,
  workItem,
} from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { LIFECYCLE } from './harness/transitions.mjs';

// The shortest lease, so the clock moves little. Every advance below stays far inside a role deadline.
const LEASE_TTL = CONTRACT.engine.lease_ttl.min;
assert.ok(LEASE_TTL * 8 < CONTRACT.project.deadline_reviewer.min, 'the cases need a lease lifetime much shorter than any role deadline');

const ms = (iso) => Date.parse(iso);
// The engine's clock is the host's wall clock plus the offset the tests give
// it, and a host's wall clock can step back: the host these tests were
// written on stepped back by about three quarters of a second every half
// minute, when its time is synchronised, and by 2.93 s when it was measured
// again (E65 addendum). A timestamp the engine takes just after it answered
// a clock advance can therefore be seconds earlier than the `now` of that
// answer. Where a test asks "was this done after the clock moved", it does
// not compare the timestamp with that `now` and an allowance: it asks
// whether the row moved on from what it held before the clock moved, or it
// compares across a margin of five seconds or a third of lease_ttl, which
// every comparison below has.
const runLease = (home, runId) => leasesOf(home, runId).find((l) => l.resource_kind === 'run' && l.released_at === null);
const describeLease = (l) => (l ? `renewed_at ${l.renewed_at}, expires_at ${l.expires_at}, closing ${l.closing}` : 'no unreleased run lease');

// E27 item 3 (../contract/run-lifecycle.json, `lease_expiry`): what a run
// lease that expires leaves when no outcome had been decided before it did.
const EXPIRED = LIFECYCLE.lease_expiry;
assert.deepEqual([EXPIRED.outcome, EXPIRED.work, EXPIRED.repair_attempts], ['recovered', 'held', 'unchanged'], 'the contract table carries the consequence of a lease expiry');

// The run ended because its lease expired, and nothing had decided its
// outcome before that: it is treated as recovered, like a run found after a
// crash. Its work is held, and no repair attempt is charged for it.
function assertEndedByLeaseExpiry(fx, runId, item, { launched }) {
  const row = runRow(fx.home, runId);
  assert.deepEqual(
    [row.outcome, row.reason_class],
    [EXPIRED.outcome, EXPIRED.reason_class],
    `run ${runId} ended because its lease expired, with no outcome decided before the expiry: it is treated as recovered (E27 item 3), not as a failure of the work`,
  );
  // Not ended by a startup recovery: the incarnation that held the run is the one that ended it.
  const facts = assertRunEnded(fx.home, runId, { outcome: EXPIRED.outcome, reason_class: EXPIRED.reason_class, launched, recovery: false, workspace: 'retained' });
  const work = workItem(fx.home, item);
  assert.equal(work.status, EXPIRED.work, `the work of a run that ended because its lease expired is ${EXPIRED.work} until an explicit Resume (it is ${work.status})`);
  assert.equal(work.repair_attempts, 0, 'no repair attempt is charged for a lease that expired');
  assert.equal(decisionsAbout(fx.home, item, 'blocker').length, 0, 'and the work is not parked');
  return facts;
}

// The work stays held through ticks that dispatch other work, and an explicit
// Resume gives it a new run linked to the one whose lease expired.
async function assertHeldUntilResume(fx, project, item, firstRunId) {
  const work = workItem(fx.home, item);
  assert.deepEqual([work.status, work.repair_attempts, runsOf(fx.home, item).length], ['held', 0, 1], 'the held work was not dispatched again by itself, and nothing was charged to it');
  await resumeWork(fx.engine, project, item);
  assert.equal(workItem(fx.home, item).status, 'eligible', 'Resume makes the work eligible again');
  await tickUntil(fx.engine, project, () => workItem(fx.home, item).status === 'complete', { max: 6, what: 'the resumed work to be dispatched and to complete' });
  const runs = runsOf(fx.home, item);
  assert.equal(runs.length, 2, 'one new run after the Resume');
  assert.equal(runs[1].parent_run, firstRunId, 'the new run is linked to the run whose lease expired');
  assert.equal(workItem(fx.home, item).repair_attempts, 0, 'a Resume is not a repair attempt');
}

// D1 §8.1 step 1: a lease past its expiry is reconciled by the tick. Whatever
// else the engine does by itself, give it exactly that, a bounded number of
// times: move the clock past the lease's lifetime, then tick. Nothing of the
// project is under way but the run in question.
async function endsWithinBoundedTicks(fx, project, runId, { rounds = 4 } = {}) {
  const ended = () => runRow(fx.home, runId).state === 'ended';
  for (let round = 0; round < rounds && !ended(); round++) {
    await advanceClock(fx.engine, LEASE_TTL + 1);
    await tick(fx.engine, project);
    await waitFor(ended, { timeoutMs: 5000, what: 'the run to end' }).catch(() => {});
  }
  const row = runRow(fx.home, runId);
  assert.equal(
    row.state,
    'ended',
    `after ${rounds} rounds, each moving the clock past lease_ttl and running two ticks, run ${runId} is still ${row.state} (outcome ${row.outcome}, quarantined ${row.quarantined}; ${describeLease(runLease(fx.home, runId))}): nothing reconciled it`,
  );
}

describe('M15 a failed store transaction in the run-end path does not strand the run (review)', () => {
  // In both, the role's valid result was accepted on a live lease and the
  // role exited 0 before anything failed: the outcome was decided before the
  // lease expired, and it stands (E27 item 3).
  const CASES = [
    { event: 'run.finalizing', title: 'the transaction that enters finalizing' },
    { event: 'run.ended', title: 'the transaction that ends the run' },
  ];
  for (const c of CASES) {
    test(`${c.title} fails once: the run still ends, and the project dispatches its next item`, async (t) => {
      const fx = await scriptedEngine(t, { config: { lease_ttl: LEASE_TTL } });
      const project = (await addProject(fx)).id;
      const item = await addWork(fx.engine, project, 'verification');
      const next = await addWork(fx.engine, project, 'review');
      fx.scripted.defaultScript(script.complete([step.usage({ input_tokens: 7 })]));
      // One-shot: the next transaction about to write this event fails after its domain writes.
      await armFault(fx.engine, { point: 'before_event', event_type: c.event });

      await tick(fx.engine, project);
      const first = await waitForRun(fx.home, item);
      const [launch] = await fx.scripted.waitForLaunch({ run: first.id });
      await waitFor(() => !fx.scripted.isLive(launch), { what: 'the role to exit' });
      assert.ok(fx.scripted.eventsOf(launch.pid, 'exit').some((e) => e.code === 0), 'the role sent its result and exited 0');
      // The case's premise is that the result was accepted on a live lease.
      // The role's exit can be seen here before the engine has recorded the
      // result it sent; the clock is moved only once that record exists.
      await waitFor(() => withStore(fx.home, (db) => eventsAbout(db, 'run', first.id, 'run.validating').length) === 1, { what: 'the role\'s result to be accepted' });

      await endsWithinBoundedTicks(fx, project, first.id);
      // Ended as every run ends: one run.ended, one ledger row, lease released, grant revoked, a legal path.
      const ended = runRow(fx.home, first.id);
      assert.deepEqual(
        [ended.outcome, ended.reason_class],
        ['completed', 'none'],
        'the outcome decided before the lease expired stands: a valid result was accepted on a live lease and the role exited 0',
      );
      const facts = assertRunEnded(fx.home, first.id, { launched: true, recovery: false, workspace: 'retained', outcome: 'completed', reason_class: 'none' });
      assert.equal(facts.receipts[0].usage.length, 1, 'the usage the role reported is kept');
      assert.equal((await waitForWork(fx.home, item, 'complete')).status, 'complete');
      assert.equal(runsOf(fx.home, item).length, 1, 'the work is not bought a second time');
      assert.equal(workItem(fx.home, item).repair_attempts, 0, 'and no repair attempt is charged');

      // The project was not left behind a run that never ends.
      await tickUntil(fx.engine, project, () => workItem(fx.home, next).status === 'complete', { max: 6, what: 'the next item of the project to be dispatched and to complete' });
      withStore(fx.home, (db) => {
        assertWorkHistory(db, item);
        assertWorkHistory(db, next);
        assertOneRunAtATime(db, project);
        assert.equal(eventsAbout(db, 'run', first.id, 'run.ended').length, 1);
      });
    });
  }
});

describe('M15 the run lease: renewed by the engine, final once expired (review)', () => {
  test('a role that sends no heartbeat for longer than lease_ttl keeps its lease, because the engine renews it, and has its result accepted', async (t) => {
    const fx = await scriptedEngine(t, { config: { lease_ttl: LEASE_TTL } });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    // The role holds in silence: no heartbeat, no usage, nothing on its stdout until it is released.
    fx.scripted.script(item, [{ steps: [step.hold('gate', { heartbeat_ms: 0 }), step.result()] }]);
    await tick(fx.engine, project);
    await fx.scripted.waitForHolding({ work_item: item });
    const first = await waitForRun(fx.home, item, { state: 'executing' });

    // A third of the lease's lifetime at a time. After each step a renewal is
    // due, and what is due is acted on within two seconds (SEAM.md §18).
    const third = Math.floor(LEASE_TTL / 3);
    const steps = 7;
    for (let i = 1; i <= steps; i++) {
      // The lease as it stands before this step of the clock.
      const beforeStep = runLease(fx.home, first.id);
      const { now } = (await advanceClock(fx.engine, third)).body;
      const due = runLease(fx.home, first.id);
      assert.ok(due && ms(due.expires_at) > ms(now), `the lease of a supervised role is never found expired (step ${i}: clock ${now}; ${describeLease(due)})`);
      // Renewed since this step: the lease's last renewal has moved on from
      // what it was before the step (E65 addendum). This was read as
      // "renewed_at is no more than two seconds before the step's `now`";
      // the host's wall clock steps back by more than that, and a renewal
      // made a moment after the step could read as made before it. A renewal
      // after the step is at least `third` seconds, less one such step of
      // the host's clock, later than any made before it.
      const renewedSince = (l) => l && l.renewed_at !== beforeStep.renewed_at && ms(l.renewed_at) > ms(beforeStep.renewed_at);
      await waitFor(() => renewedSince(runLease(fx.home, first.id)), { timeoutMs: 5000, what: 'the engine to renew the lease' }).catch(() => {});
      const lease = runLease(fx.home, first.id);
      assert.ok(
        renewedSince(lease),
        `the engine renews the lease of a role it supervises at least every lease_ttl/3 (${third} s): ${i * third} s into a role that sends no heartbeat, clock ${now}, the lease has not been renewed (${describeLease(lease)})`,
      );
      assert.ok(ms(lease.expires_at) >= ms(lease.renewed_at) + LEASE_TTL * 1000, `a renewal gives the lease its whole lifetime again (${describeLease(lease)})`);
      assert.equal(lease.closing, 0);
    }
    assert.ok(steps * third > 2 * LEASE_TTL, 'the role has been silent for more than twice lease_ttl');
    assert.equal(runRow(fx.home, first.id).state, 'executing', 'and its run goes on');

    fx.scripted.release(item);
    await waitForWork(fx.home, item, 'complete');
    assertRunEnded(fx.home, first.id, { outcome: 'completed', reason_class: 'none', launched: true, recovery: false });
  });

  test('a lease nobody renews expires, and the next tick puts its run through the run-end protocol, although the engine that owns it is alive', async (t) => {
    // The launch stalls before the spawn: the run is claimed, its lease is live, and no process exists to supervise.
    const fx = await scriptedEngine(t, { config: { lease_ttl: LEASE_TTL }, barriers: ['launch.before_spawn=pause'] });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const next = await addWork(fx.engine, project, 'review');
    fx.scripted.defaultScript(script.complete());
    await requestTick(fx.engine, project);
    await fx.engine.waitUntil('barrier:launch.before_spawn');
    const first = await waitForRun(fx.home, item, { state: 'claimed' });
    const before = runLease(fx.home, first.id);
    assert.equal(before.closing, 0, 'the stalled run holds a live lease');

    const { now } = (await advanceClock(fx.engine, LEASE_TTL + 5)).body;
    assert.ok(ms(before.expires_at) < ms(now), 'the clock is past the expiry of the lease');
    // D1 §8.1 step 1: the tick takes a lease past its expiry to the run-end
    // protocol, although the launch that owns the run has not come back.
    await requestTick(fx.engine, project);
    const begun = (row) => row.state === 'finalizing' || row.state === 'ended';
    await waitFor(() => begun(runRow(fx.home, first.id)), { timeoutMs: 10_000, what: 'the run-end protocol to begin' }).catch(() => {});
    const row = runRow(fx.home, first.id);
    assert.ok(
      begun(row),
      `the lease of run ${first.id} expired at ${before.expires_at} and the clock is at ${now}, but ten seconds after a tick the run is still ${row.state} (${describeLease(runLease(fx.home, first.id))}): the tick did not reconcile it`,
    );

    // The stalled launch comes back to a run that is ending or over, and spawns nothing.
    await releaseBarrier(fx.engine, 'launch.before_spawn');
    await waitForRunState(fx.home, first.id, 'ended');
    // Nothing had decided this run's outcome when its lease expired: recovered, held, nothing charged.
    assertEndedByLeaseExpiry(fx, first.id, item, { launched: false });
    await sleep(700);
    assert.equal(fx.scripted.launches({ run: first.id }).length, 0, 'no role is spawned for a run whose lease expired while its launch waited');
    // The project goes on with its next item; the held one waits for its Resume.
    await tickUntil(fx.engine, project, () => workItem(fx.home, next).status === 'complete', { max: 6, what: 'the next item of the project to be dispatched and to complete' });
    assert.deepEqual([workItem(fx.home, item).status, runsOf(fx.home, item).length], ['held', 1], 'the held work was not dispatched again by itself');
    assert.equal(fx.scripted.launches({ work_item: item }).length, 0);
    withStore(fx.home, (db) => {
      assertWorkHistory(db, item);
      assertOneRunAtATime(db, project);
    });
  });

  test('a lease past its expiry is not renewed, the result presented on it is refused, and the tick reconciles the run', async (t) => {
    const fx = await scriptedEngine(t, { config: { lease_ttl: LEASE_TTL } });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const next = await addWork(fx.engine, project, 'review');
    // The role is alive and heartbeats four times a second until released; then it sends a valid result.
    fx.scripted.script(item, [{ steps: [step.hold('gate', { heartbeat_ms: 250 }), step.result()] }]);
    fx.scripted.defaultScript(script.complete());
    await tick(fx.engine, project);
    const launch = await fx.scripted.waitForHolding({ work_item: item });
    const first = await waitForRun(fx.home, item, { state: 'executing' });
    const before = runLease(fx.home, first.id);

    // One jump past the lease's whole lifetime: no renewal can have come in between, so the lease has expired.
    const { now } = (await advanceClock(fx.engine, LEASE_TTL + 5)).body;
    assert.ok(ms(before.expires_at) < ms(now), 'the clock is past the expiry of the lease as it was');

    // The role keeps heartbeating and the engine keeps supervising it. Neither brings an expired lease back.
    await sleep(1500);
    const revived = leasesOf(fx.home, first.id).filter((l) => l.resource_kind === 'run' && l.released_at === null && ms(l.expires_at) >= ms(now));
    assert.deepEqual(
      revived.map(describeLease),
      [],
      `a lease past its expiry was renewed (it expired at ${before.expires_at}; the clock was moved to ${now}): the store must accept a renewal, like any callback, only on an unexpired lease`,
    );

    // The role, if it is still there, now sends its result on that lease and exits.
    fx.scripted.release(item);
    await waitFor(() => !fx.scripted.isLive(launch), { what: 'the role to send its result and exit, or to have been terminated' });
    await tick(fx.engine, project);
    await waitForRunState(fx.home, first.id, 'ended');
    assert.notEqual(runRow(fx.home, first.id).outcome, 'completed', 'a result presented on an expired lease has no effect: the run did not complete');
    // The lease expired before anything had decided the run's outcome. What
    // the role did afterwards, a refused result and an exit, decides nothing:
    // the run is treated as recovered, its work is held, nothing is charged.
    assertEndedByLeaseExpiry(fx, first.id, item, { launched: true });
    assert.equal(fx.scripted.isLive(launch), false, 'the role of a run whose lease expired is not left running');

    // The project goes on with its next item. The held work is not retried by
    // itself; an explicit Resume gives it a new run.
    await tickUntil(fx.engine, project, () => workItem(fx.home, next).status === 'complete', { max: 6, what: 'the next item of the project to be dispatched and to complete' });
    await assertHeldUntilResume(fx, project, item, first.id);
    withStore(fx.home, (db) => {
      assertWorkHistory(db, item);
      assertOneRunAtATime(db, project);
    });
  });

  // E27 item 2. Preparing a run (its workspace, above all) may take longer
  // than a lease lasts. The engine holds the run while it prepares it, so it
  // renews the lease then as it does once the role is running. This does not
  // undo the case above in which a stalled launch loses its lease: there the
  // clock passes the whole lifetime in one jump, the lease has expired before
  // any renewal could be made, and expiry is final. Renewal prevents an
  // expiry; it never reverses one.
  test('the engine renews the lease of a run it is preparing: a launch held before the spawn for longer than lease_ttl keeps its lease, and the role is spawned and completes', async (t) => {
    const fx = await scriptedEngine(t, { config: { lease_ttl: LEASE_TTL }, barriers: ['launch.before_spawn=pause'] });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    fx.scripted.defaultScript(script.complete());
    await requestTick(fx.engine, project);
    await fx.engine.waitUntil('barrier:launch.before_spawn');
    const first = await waitForRun(fx.home, item, { state: 'claimed' });
    const before = runLease(fx.home, first.id);
    assert.equal(before.closing, 0, 'the run being prepared holds a live lease');

    // Steps shorter than a third of the lease's lifetime, so that at every
    // step either no renewal is due yet or one is due and is made within two
    // seconds (SEAM.md §18): the lease is never older than lease_ttl/3 when
    // the next step is taken, and is never found expired.
    const third = LEASE_TTL / 3;
    const stepSeconds = Math.floor(third) - 1;
    const steps = Math.ceil((2.5 * LEASE_TTL) / stepSeconds);
    assert.ok(stepSeconds > 0 && stepSeconds < third && steps * stepSeconds > 2 * LEASE_TTL, 'steps shorter than lease_ttl/3, more than twice lease_ttl in all');
    for (let i = 1; i <= steps; i++) {
      const { now } = (await advanceClock(fx.engine, stepSeconds)).body;
      const found = runLease(fx.home, first.id);
      assert.ok(
        found && found.closing === 0 && ms(found.expires_at) > ms(now),
        `the lease of a run the engine is preparing must not expire while the clock moves in steps shorter than lease_ttl/3: step ${i} of ${stepSeconds} s (${i * stepSeconds} s in all, lease_ttl ${LEASE_TTL} s), clock ${now}; ${describeLease(found)}; run ${runRow(fx.home, first.id).state}`,
      );
      const recent = (l) => l && ms(l.renewed_at) >= ms(now) - third * 1000;
      await waitFor(() => recent(runLease(fx.home, first.id)), { timeoutMs: 5000, what: 'the engine to renew the lease' }).catch(() => {});
      const lease = runLease(fx.home, first.id);
      assert.ok(
        recent(lease),
        `the engine renews the lease of a run it is preparing at least every lease_ttl/3 (${third} s): ${i * stepSeconds} s into a launch held before the spawn, clock ${now}, the last renewal is older than that (${describeLease(lease)})`,
      );
      assert.equal(lease.closing, 0);
    }
    const held = runRow(fx.home, first.id);
    assert.deepEqual([held.state, held.outcome], ['claimed', null], 'the run is still being prepared, and nothing has ended it');
    assert.ok(ms(runLease(fx.home, first.id).renewed_at) > ms(before.renewed_at), 'its lease was renewed meanwhile');
    assert.equal(fx.scripted.launches({ run: first.id }).length, 0, 'nothing was spawned while the launch was held');

    // The preparation finishes: the role is spawned on the lease that was kept, and completes.
    await releaseBarrier(fx.engine, 'launch.before_spawn');
    await waitForWork(fx.home, item, 'complete');
    assertRunEnded(fx.home, first.id, { outcome: 'completed', reason_class: 'none', launched: true, recovery: false });
    assert.equal(fx.scripted.launches({ run: first.id }).length, 1, 'the role was spawned once');
    assert.equal(runsOf(fx.home, item).length, 1);
    withStore(fx.home, (db) => assertWorkHistory(db, item));
  });
});

// E27 item 5, and the second review's first finding. The backstop above works
// only if the lease can expire. A role that is alive sends heartbeats, and a
// heartbeat renews the lease; so a run whose end the engine had decided, and
// had failed once to begin, was held for ever by its own role. Once the
// engine has decided to end a run, nothing renews that run's lease, the
// role's heartbeats included; the engine retries the end itself, and the
// expiry of the lease is the backstop.
describe('M15 once the engine has decided to end a run, nothing renews its lease (second review)', () => {
  // The longest lease, and a role that heartbeats many times between any two
  // steps of the clock: nothing here expires because the clock moved.
  const TTL = CONTRACT.engine.lease_ttl.max;
  const STEP = Math.floor(TTL / 2);
  const DEADLINE = CONTRACT.project.deadline_reviewer.default;

  // A review run whose role is alive, sends a heartbeat four times a second
  // and has no end of its own (only a signal ends it), taken past its
  // deadline with the one-shot fault armed on run.finalizing: the engine
  // decides to end the run, and the transaction that would begin the end fails.
  async function pastItsDeadlineWithAFailedEnd(t) {
    const fx = await scriptedEngine(t, { config: { lease_ttl: TTL } });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'review');
    fx.scripted.script(item, [script.hold('gate', { heartbeat_ms: 250 })]);
    fx.scripted.defaultScript(script.complete());
    await tick(fx.engine, project);
    const launch = await fx.scripted.waitForHolding({ work_item: item });
    const first = await waitForRun(fx.home, item, { state: 'executing' });
    // The project's next item arrives while the run is under way, so which of
    // the two the scheduler would have picked first does not matter here.
    const next = await addWork(fx.engine, project, 'verification');

    await armFault(fx.engine, { point: 'before_event', event_type: 'run.finalizing' });
    // Past the deadline, in steps shorter than lease_ttl, with real time for heartbeats between them.
    await advanceClockInSteps(fx.engine, DEADLINE, { stepSeconds: STEP, pauseMs: 1200 });
    const { now } = (await advanceClock(fx.engine, 5)).body;
    assert.ok(ms(first.deadline_at) < ms(now), `the clock (${now}) is past the deadline of the run (${first.deadline_at})`);
    // What became due is acted on within two seconds (SEAM.md §18): after
    // this the engine has decided to end the run.
    await sleep(3000);
    return { fx, project, item, next, launch, first };
  }

  test('after the engine has decided to end a run, a heartbeat of its role does not move the lease', async (t) => {
    const { fx, first, launch } = await pastItsDeadlineWithAFailedEnd(t);
    const decided = runLease(fx.home, first.id);
    // Eight more heartbeats, if the role is still there to send them.
    await sleep(2000);
    const later = runLease(fx.home, first.id);
    const row = runRow(fx.home, first.id);
    // If the engine's own retry has already ended the run, or is ending it,
    // the lease is closing or released, and there is nothing left to renew.
    if (decided && later) {
      assert.deepEqual(
        [later.renewed_at, later.expires_at],
        [decided.renewed_at, decided.expires_at],
        `once the engine has decided to end a run, nothing renews its lease, the role's heartbeats included: run ${first.id} is past its deadline (${first.deadline_at}), ` +
          `and two seconds of its role's heartbeats moved the lease from (${describeLease(decided)}) to (${describeLease(later)}); ` +
          `the run is ${row.state}, outcome ${row.outcome}, its role ${fx.scripted.isLive(launch) ? 'alive' : 'gone'}`,
      );
    } else {
      assert.ok(['finalizing', 'ended'].includes(row.state), `a run with no unreleased run lease is ending or over (it is ${row.state})`);
    }
    assert.notEqual(row.outcome, 'completed');
  });

  test('a run past its deadline whose entry into finalizing fails once still ends timed_out, although its role keeps sending heartbeats and never exits by itself', async (t) => {
    const { fx, project, item, next, launch, first } = await pastItsDeadlineWithAFailedEnd(t);

    // The run ends: by the engine's own retry or, at the latest, when the
    // lease that nothing renews has expired and a tick reconciles it. The
    // clock moves only in steps shorter than lease_ttl, and the role goes on
    // sending heartbeats for as long as it lives.
    const rounds = 4;
    const ended = () => runRow(fx.home, first.id).state === 'ended';
    for (let round = 0; round < rounds && !ended(); round++) {
      await advanceClock(fx.engine, STEP);
      await tick(fx.engine, project);
      await waitFor(ended, { timeoutMs: 8000, what: 'the run to end' }).catch(() => {});
    }
    const row = runRow(fx.home, first.id);
    assert.equal(
      row.state,
      'ended',
      `${rounds} rounds after its deadline passed, each moving the clock ${STEP} s (lease_ttl ${TTL} s) and running two ticks, run ${first.id} is still ${row.state} ` +
        `(outcome ${row.outcome}, quarantined ${row.quarantined}; ${describeLease(runLease(fx.home, first.id))}; its role ${fx.scripted.isLive(launch) ? 'alive' : 'gone'}): ` +
        `one failed run.finalizing transaction has stranded it`,
    );
    // The outcome the engine decided before any expiry stands.
    assertRunEnded(fx.home, first.id, { outcome: 'timed_out', reason_class: 'deadline', workspace: 'retained', launched: true, recovery: false });
    assert.equal(fx.scripted.isLive(launch), false, 'the role past its deadline was terminated');
    assert.ok(fx.scripted.eventsOf(launch.pid, 'signal').length >= 1, 'it was signalled: it had no end of its own');
    const parked = await waitForWork(fx.home, item, 'parked');
    assert.equal(JSON.parse(parked.blocker).reason, 'deadline', 'the work is parked with its cause, as after any deadline');
    assert.equal(parked.repair_attempts, 0);

    // The project was not left behind a run that never ends.
    await tickUntil(fx.engine, project, () => workItem(fx.home, next).status === 'complete', { max: 6, what: 'the next item of the project to be dispatched and to complete' });
    assert.equal(runsOf(fx.home, item).length, 1, 'the parked work is not dispatched again by itself');
    withStore(fx.home, (db) => {
      assertWorkHistory(db, item);
      assertWorkHistory(db, next);
      assertOneRunAtATime(db, project);
      assert.equal(eventsAbout(db, 'run', first.id, 'run.ended').length, 1);
    });
  });
});
