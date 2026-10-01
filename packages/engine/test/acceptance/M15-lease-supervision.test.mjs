// M15, leases (slice 2, after the slice-2 review). Plan §3.2 M15 ("deadlines
// and stale generations"); D1 §§4.5, 8.1 step 1, 8.3; E25 item 1; SEAM.md
// §§13, 15, 16, 18. A run lease is what makes an engine's hold on a run
// finite. The engine renews it by itself at least every third of its
// lifetime while it supervises the run's live process, so a role that sends
// no heartbeat does not lose its result. A lease that is not renewed
// expires, and expiry is final: a lease past its expiry is not renewed, a
// callback that presents it is refused, and the tick's first step reconciles
// it through the run-end protocol. That is also the safety net under the
// run-end protocol itself: a run whose end was interrupted by one failed
// store transaction is not left holding its project until the next restart.
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
  assertRunEnded,
  leasesOf,
  requestTick,
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

// The shortest lease, so the clock moves little. Every advance below stays far inside a role deadline.
const LEASE_TTL = CONTRACT.engine.lease_ttl.min;
assert.ok(LEASE_TTL * 8 < CONTRACT.project.deadline_reviewer.min, 'the cases need a lease lifetime much shorter than any role deadline');

const ms = (iso) => Date.parse(iso);
const runLease = (home, runId) => leasesOf(home, runId).find((l) => l.resource_kind === 'run' && l.released_at === null);
const describeLease = (l) => (l ? `renewed_at ${l.renewed_at}, expires_at ${l.expires_at}, closing ${l.closing}` : 'no unreleased run lease');

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
  const CASES = [
    { event: 'run.finalizing', title: 'the transaction that enters finalizing', keeps: null },
    { event: 'run.ended', title: 'the transaction that ends the run', keeps: 'completed' },
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

      await endsWithinBoundedTicks(fx, project, first.id);
      // Ended as every run ends: one run.ended, one ledger row, lease released, grant revoked, a legal path.
      const facts = assertRunEnded(fx.home, first.id, { launched: true, recovery: false, workspace: 'retained', ...(c.keeps ? { outcome: c.keeps, reason_class: 'none' } : {}) });
      assert.equal(facts.receipts[0].usage.length, 1, 'the usage the role reported is kept');
      if (c.keeps) {
        // The outcome was recorded before the failure, and it stands.
        assert.equal((await waitForWork(fx.home, item, 'complete')).status, 'complete');
        assert.equal(runsOf(fx.home, item).length, 1, 'the work is not bought a second time');
      }

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
      const { now } = (await advanceClock(fx.engine, third)).body;
      const due = runLease(fx.home, first.id);
      assert.ok(due && ms(due.expires_at) > ms(now), `the lease of a supervised role is never found expired (step ${i}: clock ${now}; ${describeLease(due)})`);
      await waitFor(() => ms(runLease(fx.home, first.id)?.renewed_at ?? 0) >= ms(now), { timeoutMs: 5000, what: 'the engine to renew the lease' }).catch(() => {});
      const lease = runLease(fx.home, first.id);
      assert.ok(
        lease && ms(lease.renewed_at) >= ms(now),
        `the engine renews the lease of a role it supervises at least every lease_ttl/3 (${third} s): ${i * third} s into a role that sends no heartbeat, clock ${now}, the lease has not been renewed (${describeLease(lease)})`,
      );
      assert.ok(ms(lease.expires_at) >= ms(now) + LEASE_TTL * 1000, `a renewal gives the lease its whole lifetime again (${describeLease(lease)})`);
      assert.equal(lease.closing, 0);
    }
    assert.ok(steps * third > 2 * LEASE_TTL, 'the role has been silent for more than twice lease_ttl');
    assert.equal(runRow(fx.home, first.id).state, 'executing', 'and its run goes on');

    fx.scripted.release(item);
    await waitForWork(fx.home, item, 'complete');
    assertRunEnded(fx.home, first.id, { outcome: 'completed', reason_class: 'none', launched: true, recovery: false });
  });

  test('a lease nobody renews expires, and the next tick ends its run, although the engine that owns it is alive', async (t) => {
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
    // D1 §8.1 step 1: the tick reconciles a lease past its expiry. The domain was never spawned into, so the run ends.
    await tick(fx.engine, project);
    await waitFor(() => runRow(fx.home, first.id).state === 'ended', { timeoutMs: 10_000, what: 'the run to end' }).catch(() => {});
    const row = runRow(fx.home, first.id);
    assert.equal(
      row.state,
      'ended',
      `the lease of run ${first.id} expired at ${before.expires_at} and the clock is at ${now}, but two ticks later the run is still ${row.state} (${describeLease(runLease(fx.home, first.id))}): the tick did not reconcile it`,
    );
    const facts = assertRunEnded(fx.home, first.id, { launched: false, recovery: false });
    assert.notEqual(facts.run.outcome, 'completed');

    // The stalled launch comes back to a run that is over, and spawns nothing.
    await releaseBarrier(fx.engine, 'launch.before_spawn');
    await sleep(700);
    assert.equal(fx.scripted.launches({ run: first.id }).length, 0, 'no role is spawned for a run whose lease expired while its launch waited');
    await tickUntil(fx.engine, project, () => workItem(fx.home, next).status === 'complete', { max: 6, what: 'the next item of the project to be dispatched and to complete' });
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
    const facts = assertRunEnded(fx.home, first.id, { launched: true, recovery: false, workspace: 'retained' });
    assert.notEqual(facts.run.outcome, 'completed', 'a result presented on an expired lease has no effect: the run did not complete');
    assert.equal(fx.scripted.isLive(launch), false, 'the role of a run whose lease expired is not left running');

    // The project goes on.
    await tickUntil(fx.engine, project, () => workItem(fx.home, next).status === 'complete', { max: 6, what: 'the next item of the project to be dispatched and to complete' });
    withStore(fx.home, (db) => {
      assertWorkHistory(db, item);
      assertOneRunAtATime(db, project);
    });
  });
});
