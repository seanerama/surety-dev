// M12 (slice 2). Plan §3.2 M12; D1 §§1.5, 8.1–8.4; E18; SEAM.md §15. Two
// projects have ready work and one of them has a reason not to be dispatched,
// one reason per case: it is paused, its item is held, its item is on
// dispatch hold, its item waits for another item. In every case the
// ineligible work never launches and the other project's work progresses.
// One run per work item; engine-wide concurrency is bounded by the domain
// slots; simultaneous tick requests do not multiply anything; pausing lets
// the run under way finish.
// M5 slice 37 (D6 K2, C.2; SEAM.md §437): "a project has one run at a time"
// and "concurrency across projects is bounded by the engine setting" were
// accepted under the project and engine run counts K2 removes. They are
// narrowed to one run per work item (two items of one project now run at
// once) and to the bound that stays, `max_concurrent_domains` (applied on the
// kernel lane too, the driver's ruling Q2); the engine key
// `max_concurrent_runs` is refused at start (M07).
// Deferred (COVERAGE.md): the over-budget project (slice 4); the chaining
// boundary of max_chained_roles (slice 3).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertOneRunAtATime, assertOneRunPerItem, assertWorkHistory, eventsAbout, maxConcurrentDomains, maxConcurrentRuns } from './harness/invariants.mjs';
import {
  abandonRun,
  addProject,
  addWork,
  driveTo,
  pauseProject,
  requestTick,
  resumeProject,
  resumeWork,
  runsOf,
  runsOfProject,
  scriptedEngine,
  tick,
  waitForIdle,
  waitForRun,
  waitForRunState,
  waitForWork,
  workItem,
} from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

// Two projects, each with one eligible verification item that completes as
// soon as it is launched unless a test gives it another script.
async function twoProjects(t, opts) {
  const fx = await scriptedEngine(t, opts);
  fx.scripted.defaultScript(script.complete());
  const a = (await addProject(fx)).id;
  const b = (await addProject(fx)).id;
  return { fx, a, b, both: [a, b] };
}

const launchesOf = (fx, item) => fx.scripted.launches({ work_item: item }).length;

describe('M12 scheduling boundaries', () => {
  test('a paused project dispatches nothing while the other progresses', async (t) => {
    const { fx, a, b, both } = await twoProjects(t);
    await pauseProject(fx.engine, a);
    const itemA = await addWork(fx.engine, a, 'verification');
    const itemB = await addWork(fx.engine, b, 'verification');
    await tick(fx.engine, both);
    await waitForWork(fx.home, itemB, 'complete');
    await tick(fx.engine, both);
    assert.equal(runsOf(fx.home, itemA).length, 0, 'no run in the paused project');
    assert.equal(launchesOf(fx, itemA), 0);
    assert.equal(workItem(fx.home, itemA).status, 'eligible');

    await resumeProject(fx.engine, a);
    await tick(fx.engine, both);
    await waitForWork(fx.home, itemA, 'complete');
    assert.equal(launchesOf(fx, itemA), 1);
  });

  test('pausing lets the run under way finish and holds back what would follow it', async (t) => {
    const { fx, a, both } = await twoProjects(t);
    // Objection 095 (D6 K1, K2): new eligible work requests a tick, and a
    // project's second item no longer waits for its first; so `first` is
    // scripted while the project is paused, and `next` is made once the pause
    // is in force, so that only the pause holds it back.
    await pauseProject(fx.engine, a);
    const first = await addWork(fx.engine, a, 'verification');
    fx.scripted.script(first, [script.holdThenComplete('gate')]);
    await resumeProject(fx.engine, a);
    await tick(fx.engine, both);
    await fx.scripted.waitForHolding({ work_item: first });

    await pauseProject(fx.engine, a);
    const next = await addWork(fx.engine, a, 'review');
    await tick(fx.engine, both);
    const run = runsOf(fx.home, first)[0];
    assert.equal(run.state, 'executing', 'a pause does not stop the run under way');
    fx.scripted.release(first);
    await waitForWork(fx.home, first, 'complete');
    assert.equal((await waitForRunState(fx.home, run.id, 'ended')).outcome, 'completed', 'it finishes normally');

    await tick(fx.engine, both);
    assert.equal(runsOf(fx.home, next).length, 0, 'nothing new is dispatched while paused');
    await resumeProject(fx.engine, a);
    await tick(fx.engine, both);
    await waitForWork(fx.home, next, 'complete');
  });

  test('a held item is never launched while the other project progresses', async (t) => {
    const { fx, a, b, both } = await twoProjects(t);
    const itemA = await addWork(fx.engine, a, 'verification');
    await driveTo(fx.engine, itemA, ['claimed', 'held']);
    const itemB = await addWork(fx.engine, b, 'verification');
    await tick(fx.engine, both);
    await waitForWork(fx.home, itemB, 'complete');
    await tick(fx.engine, both);
    assert.equal(runsOf(fx.home, itemA).length, 0, 'held work is not dispatched');
    assert.equal(workItem(fx.home, itemA).status, 'held');

    // Held work leaves only by an explicit Resume.
    await resumeWork(fx.engine, a, itemA);
    await tick(fx.engine, both);
    await waitForWork(fx.home, itemA, 'complete');
  });

  test('an item on dispatch hold is never launched while the other project progresses', async (t) => {
    const { fx, a, b, both } = await twoProjects(t);
    const itemA = await addWork(fx.engine, a, 'verification');
    fx.scripted.script(itemA, [script.hold('gate'), script.complete()]);
    await tick(fx.engine, both);
    await fx.scripted.waitForHolding({ work_item: itemA });
    const run = await waitForRun(fx.home, itemA, { state: 'executing' });
    await abandonRun(fx.engine, a, run.id);
    await waitForRunState(fx.home, run.id, 'ended');
    const held = await waitForWork(fx.home, itemA, 'eligible');
    assert.equal(held.dispatch_hold, 1, 'Abandon leaves a durable dispatch hold');

    const itemB = await addWork(fx.engine, b, 'verification');
    await tick(fx.engine, both);
    await waitForWork(fx.home, itemB, 'complete');
    await tick(fx.engine, both);
    assert.equal(runsOf(fx.home, itemA).length, 1, 'eligible work on dispatch hold is not dispatched');
    assert.equal(launchesOf(fx, itemA), 1);

    await resumeWork(fx.engine, a, itemA);
    assert.equal(workItem(fx.home, itemA).dispatch_hold, 0);
    await tick(fx.engine, both);
    await waitForWork(fx.home, itemA, 'complete');
    assert.equal(launchesOf(fx, itemA), 2);
  });

  test('an item is not launched before the work it depends on is complete', async (t) => {
    const { fx, a, b, both } = await twoProjects(t);
    const first = await addWork(fx.engine, a, 'verification');
    await driveTo(fx.engine, first, ['claimed', 'held']);
    const blocked = await addWork(fx.engine, a, 'review', { depends_on: [first] });
    const itemB = await addWork(fx.engine, b, 'verification');
    await tick(fx.engine, both);
    await waitForWork(fx.home, itemB, 'complete');
    await tick(fx.engine, both);
    // Project A has no run under way, so only the dependency holds this back.
    assert.equal(runsOfProject(fx.home, a).length, 0, 'nothing of project A was dispatched');
    assert.equal(workItem(fx.home, blocked).status, 'eligible');

    await resumeWork(fx.engine, a, first);
    await tick(fx.engine, both);
    await waitForWork(fx.home, first, 'complete');
    await tick(fx.engine, both);
    await waitForWork(fx.home, blocked, 'complete');
    withStore(fx.home, (db) => {
      const [completed] = eventsAbout(db, 'work_item', first, 'work.complete');
      const [created] = eventsAbout(db, 'run', runsOf(fx.home, blocked)[0].id, 'run.created');
      assert.ok(created.seq > completed.seq, 'the dependent run was created after the work it waited for completed');
      assertOneRunAtATime(db, a);
    });
  });

  test('one run per work item: two eligible items of one project run at once, each with one run (K2)', async (t) => {
    const { fx, a, both } = await twoProjects(t);
    const first = await addWork(fx.engine, a, 'verification');
    const second = await addWork(fx.engine, a, 'review');
    fx.scripted.script(first, [script.holdThenComplete('gate')]);
    fx.scripted.script(second, [script.holdThenComplete('gate')]);
    await tick(fx.engine, both);
    await tick(fx.engine, both);
    await fx.scripted.waitForHolding({ work_item: first });
    await fx.scripted.waitForHolding({ work_item: second });
    const active = runsOfProject(fx.home, a).filter((r) => r.state !== 'ended');
    assert.equal(active.length, 2, 'two eligible items of one project, two runs at once (the former one run per project no longer holds)');
    assert.equal(runsOf(fx.home, first).length, 1, 'one run for the first item');
    assert.equal(runsOf(fx.home, second).length, 1, 'one run for the second item');

    fx.scripted.release('all');
    await waitForWork(fx.home, first, 'complete');
    await waitForWork(fx.home, second, 'complete');
    await waitForIdle(fx.home, a);
    withStore(fx.home, (db) => {
      assertOneRunPerItem(db, a);
      assert.equal(maxConcurrentRuns(db, { project: a }), 2);
      for (const id of [first, second]) assertWorkHistory(db, id);
    });
  });

  test('concurrency across projects is bounded by the domain slots (max_concurrent_domains 1), not by a run count (K2)', async (t) => {
    const { fx, a, b, both } = await twoProjects(t, { config: { max_concurrent_domains: 1 } });
    const itemA = await addWork(fx.engine, a, 'verification');
    const itemB = await addWork(fx.engine, b, 'verification');
    for (const id of [itemA, itemB]) fx.scripted.script(id, [script.holdThenComplete('gate')]);
    await tick(fx.engine, both);
    await tick(fx.engine, both);
    const active = [...runsOfProject(fx.home, a), ...runsOfProject(fx.home, b)].filter((r) => r.state !== 'ended');
    assert.equal(active.length, 1, 'two projects with ready work, one domain slot: one run');
    const running = active[0].work_item;
    const waiting = running === itemA ? itemB : itemA;

    fx.scripted.release(running);
    await waitForWork(fx.home, running, 'complete');
    await tick(fx.engine, both);
    await fx.scripted.waitForHolding({ work_item: waiting });
    fx.scripted.release(waiting);
    await waitForWork(fx.home, waiting, 'complete');
    await waitForIdle(fx.home, both);
    // The slot is the domain's: it is freed when the domain terminates, before
    // the run records its end, so the bound is read on domains (objection 095).
    assert.equal(withStore(fx.home, (db) => maxConcurrentDomains(db)), 1, 'never more than one domain holding a slot at a time');
  });

  test('simultaneous tick requests run one scheduler and dispatch each item once', async (t) => {
    const { fx, a, b, both } = await twoProjects(t);
    const itemA = await addWork(fx.engine, a, 'verification');
    const itemB = await addWork(fx.engine, b, 'verification');
    for (const id of [itemA, itemB]) fx.scripted.script(id, [script.holdThenComplete('gate')]);
    const ticksBefore = withStore(fx.home, (db) => db.prepare(`SELECT COUNT(*) AS n FROM "events" WHERE "type" = 'engine.tick'`).get().n);
    const requests = 24;
    await Promise.all(Array.from({ length: requests }, (_, i) => requestTick(fx.engine, both[i % 2])));
    await tick(fx.engine, both);
    for (const id of [itemA, itemB]) {
      await fx.scripted.waitForHolding({ work_item: id });
      assert.equal(runsOf(fx.home, id).length, 1, 'one run per item, however many ticks were requested');
      assert.equal(launchesOf(fx, id), 1, 'one launch per item');
    }
    const ticks = withStore(fx.home, (db) => db.prepare(`SELECT COUNT(*) AS n FROM "events" WHERE "type" = 'engine.tick'`).get().n) - ticksBefore;
    assert.ok(ticks >= 1 && ticks <= requests + 4, `requests set a flag; they do not each run the scheduler in their own call (${ticks} ticks for ${requests + 4} requests)`);
    fx.scripted.release('all');
    await waitForWork(fx.home, itemA, 'complete');
    await waitForWork(fx.home, itemB, 'complete');
    await waitForIdle(fx.home, both);
    withStore(fx.home, (db) => {
      assertOneRunAtATime(db, a);
      assertOneRunAtATime(db, b);
    });
  });
});
