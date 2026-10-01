// M08, scheduler and backend cases (slice 2). Plan §3.1 M08; build spec §3;
// RN §4; D1 §§15.1, 17(11), 19.3; SEAM.md §§15, 16. Work kinds outside M1
// cannot become work through the engine's trigger path, and a work item of
// such a kind that is in the store anyway is never launched. No backend but
// the scripted one exists, and that one only in harness mode: every other
// start refuses each dispatch before launch with `backend_refused`, and
// fabricates no invocation, usage or charge.
// The API refusals are in M08-api-capability-refusals.test.mjs (slice 1).
// Deferred (COVERAGE.md): refusal of gate kinds and of reserved decision
// kinds (slice 5).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertRefused, assertNoEffect, maxEventSeq, storeState } from './harness/fixtures.mjs';
import {
  addProject,
  addWork,
  assertRunEnded,
  countOf,
  observeTrigger,
  pauseProject,
  requestTick,
  resumeProject,
  runsOf,
  scriptedEngine,
  tick,
  waitForRun,
  waitForWork,
  workItem,
} from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';
import { seedWorkItem } from './harness/seed.mjs';
import { openStore, storePath } from './harness/store.mjs';
import { WORK, m1Kinds } from './harness/transitions.mjs';

const EXCLUDED = Object.keys(WORK.kinds).filter((kind) => !m1Kinds().includes(kind));

describe('M08 excluded work never launches, and no real backend exists', () => {
  test('a trigger for a work kind outside M1 is refused and creates nothing', async (t) => {
    const fx = await scriptedEngine(t);
    const project = (await addProject(fx)).id;
    assert.deepEqual(
      [...EXCLUDED].sort(),
      ['adoption_baseline', 'conformance', 'deploy', 'export', 'phase_verification', 'publish', 'rollback', 'spec_change', 'triage_accept'],
      'the kinds D1 names and build spec §3 leaves out of M1',
    );
    const before = storeState(fx.home);
    const seq = maxEventSeq(fx.home);
    for (const kind of EXCLUDED) {
      const seen = await observeTrigger(fx.engine, { project, kind, id: `excluded-${kind}` });
      assertRefused(seen.res, 501, 'unsupported', `a ${kind} trigger`);
    }
    assertRefused((await observeTrigger(fx.engine, { project, kind: 'teleport', id: 'no-such-kind' })).res, 400, 'invalid_value', 'a trigger of no known kind');
    assertNoEffect(fx.home, before, seq, 'refused triggers');
    assert.equal(countOf(fx.home, 'work_items'), 0);
  });

  test('a work item of an excluded kind that is in the store anyway is never launched, while permitted work is', async (t) => {
    const fx = await scriptedEngine(t);
    fx.scripted.defaultScript(script.complete());
    const project = (await addProject(fx)).id;
    await fx.engine.stop();
    // No transition creates these; they are written straight into the stopped engine's store.
    const db = openStore(storePath(fx.home));
    const seeded = [];
    try {
      for (const kind of ['deploy', 'publish', 'export', 'rollback', 'conformance']) seeded.push(seedWorkItem(db, project, { kind, status: 'eligible' }).id);
    } finally {
      db.close();
    }

    const engine = await fx.start();
    const permitted = await addWork(engine, project, 'verification');
    for (let i = 0; i < 3; i++) await tick(engine, project);
    await waitForWork(fx.home, permitted, 'complete');
    for (let i = 0; i < 2; i++) await tick(engine, project);
    for (const id of seeded) {
      const row = workItem(fx.home, id);
      assert.equal(runsOf(fx.home, id).length, 0, `no run for the ${row.kind} item`);
      assert.notEqual(row.status, 'complete', `the ${row.kind} item is not reported done`);
    }
    assert.equal(fx.scripted.launches().length, 1, 'only the permitted item was launched');
    assert.equal(countOf(fx.home, 'invocation_receipts'), 1, 'no invocation was fabricated for excluded work');
    assert.equal(countOf(fx.home, 'ledger_rows'), 1);
  });

  // In M1 the only backend is `scripted`, and only with --harness and
  // --harness-scripted. Every other start is the "real backend" case: the
  // engine has no qualified backend and must refuse before launch.
  for (const [name, startOpts] of [
    ['without the harness', { harness: false }],
    ['in harness mode without a scripted directory', { harness: true, withScripted: false }],
  ]) {
    test(`${name}, a dispatch is refused before launch with backend_refused`, async (t) => {
      const fx = await scriptedEngine(t);
      const project = (await addProject(fx)).id;
      await pauseProject(fx.engine, project);
      const item = await addWork(fx.engine, project, 'verification');
      await fx.engine.stop();

      const engine = await fx.start(startOpts);
      const info = await engine.engineInfo();
      assert.deepEqual(info.backends, [], 'no backend is qualified');
      await resumeProject(engine, project);
      await requestTick(engine, project);
      const run = await waitForRun(fx.home, item, { state: 'ended' });
      const facts = assertRunEnded(fx.home, run.id, { outcome: 'refused', reason_class: 'preflight_refused', launched: false, recovery: false });
      assert.deepEqual(facts.receipts.flatMap((r) => r.statuses).filter((s) => s === 'launched'), [], 'nothing was launched');
      assert.equal(facts.receipts.every((r) => r.usage.length === 0 && r.ledger.length === 0), true, 'no usage and no charge were fabricated');
      assert.equal(countOf(fx.home, 'ledger_rows'), 0);
      assert.equal(fx.scripted.launches().length, 0, 'no role process was started');

      const shown = await engine.get(`/v1/projects/${project}/runs/${run.id}`);
      assert.equal(shown.status, 200, shown.text);
      assert.deepEqual(
        [shown.body.run?.id, shown.body.run?.state, shown.body.run?.outcome, shown.body.run?.reason_class, shown.body.run?.code],
        [run.id, 'ended', 'refused', 'preflight_refused', 'backend_refused'],
        'the run reports the declared refusal',
      );
      const other = await engine.get(`/v1/projects/proj_00000000000000000000000000/runs/${run.id}`);
      assertRefused(other, 404, 'not_found', 'the run read through another project');

      const row = await waitForWork(fx.home, item, 'eligible');
      assert.equal(row.preflight_refusals, 1, 'the refusal is counted on the work item');
      assert.notEqual(row.status, 'complete');
    });
  }
});
