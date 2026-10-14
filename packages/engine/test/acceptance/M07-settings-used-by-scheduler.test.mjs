// M07, the scheduler case (slice 2; migrated in M5 slice 37 under D6 K2).
// Plan §3.1 M07; D1 §8.1 step 9, A.9; build spec §6 correction 20; E18;
// SEAM.md §§15, 16, 425.
//
// As accepted (M1 to M4) the effective settings the scheduler used were an
// engine-wide run count (`max_concurrent_runs`, 2 by default) and one run
// per project. D6 K2 (E139 item 4; B09) removes both caps: dispatch admits
// every eligible item the envelope admits, under three rules kept from D1:
// one run per work item, integration serial under its lease, and a session
// admitting no one-shot beside it on its project (M419). The domain slots
// (`max_concurrent_domains`, 4 by default) stay a bound, on the kernel lane
// too (the driver's ruling Q2, slice 37). So the cases are narrowed, as D6
// C.2 says, to one run per work item; the former cases are pinned as now
// refused or as no longer holding:
//   - three projects with ready work run all three at once (the former
//     "two by default, and no more" no longer holds);
//   - two items of one project run at once, each with one run;
//   - the engine key `max_concurrent_runs` is refused at start, naming it
//     (the former "a configured limit of three" now refused).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CONTRACT } from './harness/fixtures.mjs';
import { EXIT, freePort, makeTempDir, removeDir, startRefused, writeEngineConfig } from './harness/engine.mjs';
import { assertOneRunPerItem, maxConcurrentRuns } from './harness/invariants.mjs';
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

describe('M07 the scheduler uses the effective settings (D6 K2: no run count)', () => {
  test('no engine run count: three projects with ready work run all three at once, one run per item', async (t) => {
    assert.equal(CONTRACT.engine.max_concurrent_runs, undefined, 'the contract has no engine max_concurrent_runs (K2)');
    assert.ok(CONTRACT.engine.max_concurrent_domains.default >= 3, 'the default domain slots admit three');
    const { fx, projects, items } = await threeProjects(t, {});
    const info = await fx.engine.engineInfo();
    assert.equal(info.config.max_concurrent_runs, undefined, `the engine reports no max_concurrent_runs (${JSON.stringify(info.config.max_concurrent_runs)})`);
    await tick(fx.engine, projects);
    await tick(fx.engine, projects);
    assert.equal(active(fx, projects).length, 3, 'three projects with ready work: all three run at once (the former engine default of two no longer bounds)');

    fx.scripted.release('all');
    await tickUntil(fx.engine, projects, () => items.every((item) => workItem(fx.home, item).status === 'complete'), { what: 'every item to complete' });
    await waitForIdle(fx.home, projects);
    withStore(fx.home, (db) => {
      assert.equal(maxConcurrentRuns(db), 3, 'three at once');
      for (const p of projects) assertOneRunPerItem(db, p);
    });
  });

  test('no project run count: two items of one project run at once, each with one run', async (t) => {
    const { fx, projects, items } = await threeProjects(t, {});
    const extra = await addWork(fx.engine, projects[0], 'review');
    await tick(fx.engine, projects);
    await tick(fx.engine, projects);
    assert.equal(runsOfProject(fx.home, projects[0]).filter((r) => r.state !== 'ended').length, 2, 'the project runs both its items at once (the former one run per project no longer holds)');
    assert.equal(runsOf(fx.home, extra).length, 1, 'one run for the second item');
    assert.equal(runsOf(fx.home, items[0]).length, 1, 'one run for the first item');

    fx.scripted.release('all');
    await tickUntil(fx.engine, projects, () => [...items, extra].every((item) => workItem(fx.home, item).status === 'complete'), { what: 'every item to complete' });
    await waitForIdle(fx.home, projects);
    withStore(fx.home, (db) => {
      assert.equal(maxConcurrentRuns(db, { project: projects[0] }), 2);
      for (const p of projects) assertOneRunPerItem(db, p);
    });
  });

  test('the engine key max_concurrent_runs is refused at start, naming it (the former configured limit, now refused)', async (t) => {
    for (const value of [1, 2, 3, 8]) {
      const home = makeTempDir('m07-runs');
      t.after(() => removeDir(home));
      writeEngineConfig(home, { api_port: await freePort(), max_concurrent_runs: value });
      const result = await startRefused({ home });
      assert.equal(result.code, EXIT.config, `max_concurrent_runs ${value}: the start is refused (stderr: ${result.stderr})`);
      assert.equal(result.refusal?.code, 'unknown_field', `max_concurrent_runs ${value}: unknown_field (stderr: ${result.stderr})`);
      assert.equal(result.refusal?.subject?.field, 'max_concurrent_runs', 'the refusal names the field');
    }
  });
});
