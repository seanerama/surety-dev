// M07, the scheduler case (slice 2). Plan §3.1 M07; D1 §8.1 step 9, A.9;
// build spec §6 correction 20; E18; SEAM.md §§15, 16. The effective settings
// are the ones the scheduler uses: engine-wide concurrency is the configured
// bound, by default and when changed, and the per-project bound stays one
// whatever the engine allows. Role deadlines are pinned where a run is
// dispatched (M09-work-paths), the tick budgets in M15.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CONTRACT } from './harness/fixtures.mjs';
import { assertOneRunAtATime, maxConcurrentRuns } from './harness/invariants.mjs';
import { addProject, addWork, runsOf, runsOfProject, scriptedEngine, tick, tickUntil, waitForIdle, workItem } from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

// Three projects, each with an item whose role waits until released.
async function threeProjects(t, config) {
  const fx = await scriptedEngine(t, { config });
  fx.scripted.defaultScript(script.holdThenComplete('gate'));
  const projects = [];
  const items = [];
  for (let i = 0; i < 3; i++) {
    const project = (await addProject(fx)).id;
    projects.push(project);
    items.push(await addWork(fx.engine, project, 'verification'));
  }
  return { fx, projects, items };
}

const active = (fx, projects) => projects.flatMap((p) => runsOfProject(fx.home, p)).filter((r) => r.state !== 'ended');

describe('M07 the scheduler uses the effective settings', () => {
  test('by default the engine runs two projects at once and no more', async (t) => {
    const limit = CONTRACT.engine.max_concurrent_runs.default;
    assert.equal(limit, 2);
    const { fx, projects, items } = await threeProjects(t, {});
    const info = await fx.engine.engineInfo();
    assert.deepEqual(info.config.max_concurrent_runs, { value: limit, source: 'default' });
    await tick(fx.engine, projects);
    await tick(fx.engine, projects);
    assert.equal(active(fx, projects).length, limit, 'three projects with ready work, the default limit of two');

    // Release everything; the third is dispatched once a slot is free.
    fx.scripted.release('all');
    await tickUntil(fx.engine, projects, () => items.every((item) => workItem(fx.home, item).status === 'complete'), { what: 'every item to complete once slots are free' });
    await waitForIdle(fx.home, projects);
    assert.equal(withStore(fx.home, (db) => maxConcurrentRuns(db)), limit, 'never more than the limit at one time');
  });

  test('a configured engine limit of three runs three projects at once, and still one run per project', async (t) => {
    const { fx, projects, items } = await threeProjects(t, { max_concurrent_runs: 3 });
    const info = await fx.engine.engineInfo();
    assert.deepEqual(info.config.max_concurrent_runs, { value: 3, source: 'file' });
    // A second item in the first project: the engine has room, the project does not.
    const extra = await addWork(fx.engine, projects[0], 'review');
    await tick(fx.engine, projects);
    await tick(fx.engine, projects);
    assert.equal(active(fx, projects).length, 3, 'three projects at once');
    assert.equal(runsOfProject(fx.home, projects[0]).filter((r) => r.state !== 'ended').length, 1, 'project concurrency stays one');
    assert.equal(runsOf(fx.home, extra).length + runsOf(fx.home, items[0]).length, 1);

    fx.scripted.release('all');
    await tickUntil(fx.engine, projects, () => [...items, extra].every((item) => workItem(fx.home, item).status === 'complete'), { what: 'every item to complete once slots are free' });
    await waitForIdle(fx.home, projects);
    withStore(fx.home, (db) => {
      assert.equal(maxConcurrentRuns(db), 3);
      for (const p of projects) assertOneRunAtATime(db, p);
    });
  });
});
