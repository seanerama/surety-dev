// M10 (slice 2). Plan §3.2 M10; D1 §§6.2, 8.2; D1-05; Review B10; SEAM.md
// §15. One trigger identity (source, id, generation) has one work item
// through everything that can happen to it: observed again while it waits,
// while it runs, after a refused run, after a restart and after it has
// completed, it creates nothing and raises no error. A new generation is a
// new item, and it is still subject to the project's holds and to the one
// run a project may have.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertWorkHistory } from './harness/invariants.mjs';
import {
  addProject,
  countOf,
  observeTrigger,
  pauseProject,
  requestTick,
  resumeProject,
  runsOf,
  scriptedEngine,
  tick,
  waitForIdle,
  waitForRun,
  waitForWork,
  workItem,
} from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const TRIGGER = { kind: 'verification', source: 'stage-integrated', id: 'stage-7' };

describe('M10 one trigger identity, one work item', () => {
  test('a trigger observed again before completion, after a refusal, after a restart and after success creates nothing', async (t) => {
    const fx = await scriptedEngine(t);
    const project = (await addProject(fx)).id;
    await pauseProject(fx.engine, project);
    const observe = async (generation = 1) => observeTrigger(fx.engine, { project, ...TRIGGER, generation });
    const items = () => countOf(fx.home, 'work_items', '"project" = ?', project);

    const first = await observe();
    assert.deepEqual([first.status, first.created], [201, true]);
    const item = first.workItem;
    const row = workItem(fx.home, item);
    assert.deepEqual(
      [row.kind, row.status, row.trigger_source, row.trigger_id, row.trigger_generation],
      ['verification', 'eligible', TRIGGER.source, TRIGGER.id, 1],
    );

    // Before completion: waiting.
    const waiting = await observe();
    assert.deepEqual([waiting.status, waiting.created, waiting.workItem], [200, false, item]);
    assert.equal(items(), 1);

    // After a refusal: without the harness no backend is qualified, so the
    // item's run is refused before launch and the item returns to eligible.
    await fx.engine.stop();
    const plain = await fx.start({ harness: false });
    await resumeProject(plain, project);
    await requestTick(plain, project);
    const refusedRun = await waitForRun(fx.home, item, { state: 'ended' });
    assert.equal(refusedRun.outcome, 'refused');
    await waitForWork(fx.home, item, 'eligible');
    await plain.post(`/v1/projects/${project}/pause`, {});
    await plain.stop();

    // After the refusal and after two restarts.
    const engine = await fx.start();
    const afterRefusal = await observe();
    assert.deepEqual([afterRefusal.status, afterRefusal.created, afterRefusal.workItem], [200, false, item], 'after a refusal and a restart');
    assert.equal(items(), 1);
    assert.equal(workItem(fx.home, item).status, 'eligible', 'observing changes nothing');

    // Before completion: running.
    fx.scripted.script(item, [script.holdThenComplete('gate')]);
    await resumeProject(engine, project);
    await tick(engine, project);
    await fx.scripted.waitForHolding({ work_item: item });
    const running = await observe();
    assert.deepEqual([running.status, running.created, running.workItem], [200, false, item], 'while its run executes');
    assert.equal(runsOf(fx.home, item).length, 2, 'observing a trigger does not start another run');

    // After success: the item is terminal. No error, no new item, no replanning.
    fx.scripted.release(item);
    await waitForWork(fx.home, item, 'complete');
    const eventsBefore = withStore(fx.home, (db) => db.prepare(`SELECT COUNT(*) AS n FROM "events" WHERE "type" LIKE 'work.%'`).get().n);
    const afterSuccess = await observe();
    assert.deepEqual([afterSuccess.status, afterSuccess.created, afterSuccess.workItem], [200, false, item], 'after success');
    await tick(engine, project);
    assert.equal(items(), 1, 'a consumed trigger in a terminal item creates nothing');
    assert.equal(workItem(fx.home, item).status, 'complete');
    assert.equal(runsOf(fx.home, item).length, 2, 'and is not planned or run again');
    assert.equal(withStore(fx.home, (db) => db.prepare(`SELECT COUNT(*) AS n FROM "events" WHERE "type" LIKE 'work.%'`).get().n), eventsBefore);
    assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, item)).slice(-3), ['claimed', 'executing', 'complete']);

    // A new generation is a distinct item, and it runs.
    const second = await observe(2);
    assert.deepEqual([second.status, second.created], [201, true]);
    assert.notEqual(second.workItem, item);
    assert.equal(workItem(fx.home, second.workItem).trigger_generation, 2);
    assert.equal(items(), 2);
    fx.scripted.script(second.workItem, [script.complete()]);
    await tick(engine, project);
    await waitForWork(fx.home, second.workItem, 'complete');
    assert.equal(workItem(fx.home, item).status, 'complete', 'the first generation is untouched');
  });

  test('a new generation stays subject to the project pause and to the one run a project may have', async (t) => {
    const fx = await scriptedEngine(t);
    const project = (await addProject(fx)).id;
    const observe = (generation) => observeTrigger(fx.engine, { project, ...TRIGGER, generation });
    const first = (await observe(1)).workItem;
    fx.scripted.script(first, [script.holdThenComplete('gate')]);
    await tick(fx.engine, project);
    await fx.scripted.waitForHolding({ work_item: first });

    // While generation 1 runs, generation 2 waits for the project's one run.
    const second = (await observe(2)).workItem;
    fx.scripted.script(second, [script.complete()]);
    await tick(fx.engine, project);
    assert.equal(runsOf(fx.home, second).length, 0, 'no second run in a project that has one');
    assert.equal(workItem(fx.home, second).status, 'eligible');

    // Paused: the first run finishes, and the new generation is still not dispatched.
    await pauseProject(fx.engine, project);
    fx.scripted.release(first);
    await waitForWork(fx.home, first, 'complete');
    await tick(fx.engine, project);
    assert.equal(runsOf(fx.home, second).length, 0, 'a paused project dispatches nothing, new generation or not');

    await resumeProject(fx.engine, project);
    await tick(fx.engine, project);
    await waitForWork(fx.home, second, 'complete');
    await waitForIdle(fx.home, project);
    assert.equal(fx.scripted.launches({ work_item: second }).length, 1);
  });
});
