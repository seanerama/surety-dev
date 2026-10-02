// M15 (slice 2). Plan §3.2 M15; D1 §§8.1, 8.3, 8.5; D1-20; build spec §6
// correction 1; SEAM.md §§14–16, 18. A run past its deadline is cancelled:
// its role is terminated, its generation is closed, and a "success" that
// arrives afterwards changes nothing, so work that depends on it stays
// undispatched. A deadline is a timer, not an observation: if the boundary
// does not report the domain terminated, the run is quarantined, not ended.
// A scheduler prerequisite that overruns its step budget, or a tick that
// uses up its budget, suppresses that project's dispatch for that tick, late
// completion included, while other projects and control requests go on.
// Deferred (COVERAGE.md): a git call past its deadline and the writes it may
// have made becoming ambiguous; repository integrity as the overrunning
// prerequisite step (slice 3).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { armFault, waitFor } from './harness/engine.mjs';
import { CONTRACT } from './harness/fixtures.mjs';
import { assertWorkHistory, eventsAbout } from './harness/invariants.mjs';
import {
  addProject,
  addWork,
  advanceClockInSteps,
  answerDecision,
  assertRunEnded,
  assertRunQuarantined,
  decisionsAbout,
  requestTick,
  run as runRow,
  runsOf,
  scriptedEngine,
  stopRun,
  tick,
  waitForQuarantine,
  waitForRun,
  waitForRunState,
  waitForWork,
  workItem,
} from './harness/runs.mjs';
import { BOUNDARY, lateSuccess, script } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const REVIEWER_DEADLINE = CONTRACT.project.deadline_reviewer.default;
const BUILDER_DEADLINE = CONTRACT.project.deadline_builder.default;

// The longest lease TTL, and clock steps well inside it: a held role
// heartbeats several times in the real time between two steps.
const LEASE_TTL = CONTRACT.engine.lease_ttl.max;
const CLOCK = { stepSeconds: Math.floor(LEASE_TTL / 2), pauseMs: 1200 };
const HOLD = { heartbeat_ms: 250 };

const tickEvents = (home) => withStore(home, (db) => db.prepare(`SELECT "seq" FROM "events" WHERE "type" = 'engine.tick' ORDER BY "seq"`).all().map((e) => e.seq));
const createdSeq = (home, runId) => withStore(home, (db) => eventsAbout(db, 'run', runId, 'run.created')[0]?.seq);

// Request one tick and return the seq of the engine.tick event that ends it.
// A tick is engine-wide, so one request is enough for every project. No tick
// is under way when this is called.
async function oneTick(fx, project) {
  const before = tickEvents(fx.home).at(-1) ?? 0;
  await requestTick(fx.engine, project);
  return waitFor(() => tickEvents(fx.home).find((seq) => seq > before), { what: 'the requested tick to finish' });
}

describe('M15 deadlines', () => {
  test('a run past its deadline is cancelled, a late success changes nothing, and other work is not disturbed', async (t) => {
    assert.ok(REVIEWER_DEADLINE < BUILDER_DEADLINE, 'the case needs a reviewer deadline shorter than a builder deadline');
    const fx = await scriptedEngine(t, { config: { lease_ttl: LEASE_TTL } });
    const a = (await addProject(fx)).id;
    const b = (await addProject(fx)).id;
    const review = await addWork(fx.engine, a, 'review');
    const dependent = await addWork(fx.engine, a, 'verification', { depends_on: [review] });
    const build = await addWork(fx.engine, b, 'fix');
    // On SIGTERM the reviewer sends the success it was about to send.
    fx.scripted.script(review, [script.hold('gate', { ...HOLD, on_term: lateSuccess('exit') }), script.complete()]);
    fx.scripted.script(build, [script.hold('gate', HOLD)]);
    fx.scripted.defaultScript(script.complete());
    await tick(fx.engine, [a, b]);
    const reviewLaunch = await fx.scripted.waitForHolding({ work_item: review });
    const buildLaunch = await fx.scripted.waitForHolding({ work_item: build });
    const reviewRun = await waitForRun(fx.home, review, { state: 'executing' });
    const buildRun = await waitForRun(fx.home, build, { state: 'executing' });

    // Past the reviewer's deadline, not the builder's. No real waiting.
    await advanceClockInSteps(fx.engine, REVIEWER_DEADLINE + 5, CLOCK);
    await waitForRunState(fx.home, reviewRun.id, 'ended');
    assertRunEnded(fx.home, reviewRun.id, { outcome: 'timed_out', reason_class: 'deadline', workspace: 'retained', launched: true, recovery: false });
    assert.equal(fx.scripted.isLive(reviewLaunch), false, 'the role past its deadline was terminated');
    assert.ok(fx.scripted.eventsOf(reviewLaunch.pid, 'signal').length >= 1, 'it was signalled, and so sent its late success');

    // The late success did not complete the work, and what depends on it stays undispatched.
    const parked = await waitForWork(fx.home, review, 'parked');
    assert.equal(JSON.parse(parked.blocker).reason, 'deadline', 'the work is parked with its cause');
    assert.equal(withStore(fx.home, (db) => eventsAbout(db, 'work_item', review, 'work.complete').length), 0);
    for (let i = 0; i < 2; i++) await tick(fx.engine, [a, b]);
    assert.equal(runsOf(fx.home, dependent).length, 0, 'dispatch that depends on the timed-out work stays suppressed');
    assert.equal(runsOf(fx.home, review).length, 1, 'the parked work is not dispatched again by itself');

    // The other project and control requests are not disturbed.
    assert.equal(runRow(fx.home, buildRun.id).state, 'executing', 'a run within its deadline goes on');
    assert.equal(fx.scripted.isLive(buildLaunch), true);
    assert.equal((await fx.engine.get('/v1/health')).status, 200);
    await stopRun(fx.engine, b, buildRun.id);
    await waitForRunState(fx.home, buildRun.id, 'ended');
    assertRunEnded(fx.home, buildRun.id, { outcome: 'stopped', launched: true });

    // Continuation: the blocker is answered, a new run does the review, and the dependent work follows.
    const [blocker] = decisionsAbout(fx.home, review, 'blocker');
    await answerDecision(fx.engine, a, blocker.id, 'retry');
    await waitForWork(fx.home, review, 'eligible');
    await tick(fx.engine, a);
    await waitForWork(fx.home, review, 'complete');
    const second = runsOf(fx.home, review)[1];
    assert.equal(second.parent_run, reviewRun.id, 'the new run is linked to the one that timed out');
    await tick(fx.engine, a);
    await waitForWork(fx.home, dependent, 'complete');
    withStore(fx.home, (db) => assertWorkHistory(db, review));
  });

  test('a deadline is not observed termination: with the boundary still reporting the domain running, the run is quarantined', async (t) => {
    const fx = await scriptedEngine(t, { config: { terminate_grace: 1, kill_grace: 1, lease_ttl: LEASE_TTL } });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'review');
    fx.scripted.script(item, [script.hold('gate', HOLD)]);
    await tick(fx.engine, project);
    const launch = await fx.scripted.waitForHolding({ work_item: item });
    const first = await waitForRun(fx.home, item, { state: 'executing' });
    fx.scripted.boundary({ default: BOUNDARY.running });

    await advanceClockInSteps(fx.engine, REVIEWER_DEADLINE + 5, CLOCK);
    await waitForQuarantine(fx.home, first.id);
    assertRunQuarantined(fx.home, first.id, { outcome: 'timed_out' });
    await sleep(1000);
    assert.equal(fx.scripted.isLive(launch), false, 'the process the engine spawned is gone');
    assert.equal(runRow(fx.home, first.id).state, 'finalizing', 'and the run is still not ended: a timer and an exit are not an observation');
    assert.notEqual(workItem(fx.home, item).status, 'complete');
  });

  test('a prerequisite step that overruns its budget suppresses that project for the tick, late completion included', async (t) => {
    const fx = await scriptedEngine(t, { config: { tick_step_budget: 1, tick_budget: 20 } });
    fx.scripted.defaultScript(script.complete());
    const a = (await addProject(fx)).id;
    const b = (await addProject(fx)).id;
    await tick(fx.engine, [a, b]);
    const itemA = await addWork(fx.engine, a, 'verification');
    const itemB = await addWork(fx.engine, b, 'verification');

    const delay = 4000;
    await armFault(fx.engine, { point: 'tick_step', step: 'recover', project: a, delay_ms: delay });
    const requested = Date.now();
    const tickSeq = await oneTick(fx, a);
    assert.equal((await fx.engine.get('/v1/health')).status, 200, 'the API answers while a step is overrunning');

    // In that tick: B was dispatched, A was not.
    const runB = await waitForRun(fx.home, itemB);
    assert.ok(createdSeq(fx.home, runB.id) < tickSeq, 'the other project was dispatched in the same tick');
    assert.equal(runsOf(fx.home, itemA).length, 0, 'the project whose prerequisite overran was not dispatched in that tick');

    // The slow step completes late. Nothing is dispatched on the strength of it.
    await sleep(Math.max(0, requested + delay + 1500 - Date.now()));
    assert.equal(runsOf(fx.home, itemA).length, 0, 'a late completion does not dispatch');
    assert.equal(workItem(fx.home, itemA).status, 'eligible');
    await waitForWork(fx.home, itemB, 'complete');

    // The next tick, with its prerequisites in time, dispatches it.
    await tick(fx.engine, [a, b]);
    await waitForWork(fx.home, itemA, 'complete');
    assert.equal(fx.scripted.launches({ work_item: itemA }).length, 1);
  });

  test('a tick that has used up its budget dispatches nothing more', async (t) => {
    const fx = await scriptedEngine(t, { config: { tick_step_budget: 5, tick_budget: 5 } });
    fx.scripted.defaultScript(script.complete());
    const a = (await addProject(fx)).id;
    await tick(fx.engine, a);
    const item = await addWork(fx.engine, a, 'verification');

    // Two prerequisite steps, each within its step budget, together over the tick budget
    // by three seconds: more than the host's wall clock steps back at a time
    // (measured at 1.7 to 1.8 s on 2026-10-02; SEAM.md §39). With one second to
    // spare, an engine that times its tick by the wall clock saw the tick as
    // within budget whenever a step back fell inside it.
    await armFault(fx.engine, { point: 'tick_step', step: 'recover', project: a, delay_ms: 4000 });
    await armFault(fx.engine, { point: 'tick_step', step: 'journal', project: a, delay_ms: 4000 });
    const tickSeq = await oneTick(fx, a);
    assert.equal(runsOf(fx.home, item).length, 0, 'the over-budget tick dispatched nothing');
    assert.equal(workItem(fx.home, item).status, 'eligible');
    assert.ok(tickSeq > 0);

    await tick(fx.engine, a);
    await waitForWork(fx.home, item, 'complete');
    assert.equal(fx.scripted.launches({ work_item: item }).length, 1);
  });
});
