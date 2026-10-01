// M11, the counters slice 2 can reach (slice 2). Plan §3.2 M11; D1 §§4.3,
// 13.3, 15.1; D1-31; Review B10; SEAM.md §§13, 15, 16. A run that fails
// returns its work for another attempt, each re-dispatch is counted once, and
// at the limit the work parks with a visible cause. A small repair that
// succeeds completes. A run refused before launch is counted separately and
// parks at its own limit.
// Deferred (COVERAGE.md): the no-progress count, whose progress key is taken
// over a snapshot tree and findings (slices 3 and 5); a typed conflict routed
// to a decision (slice 5); a repair that completes work which integrates
// (slice 3).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CONTRACT } from './harness/fixtures.mjs';
import { assertWorkHistory } from './harness/invariants.mjs';
import {
  addProject,
  addWork,
  assertRunEnded,
  decisionsAbout,
  pauseProject,
  requestTick,
  resumeProject,
  runsOf,
  scriptedEngine,
  tick,
  tickOnce,
  tickUntil,
  waitForRun,
  waitForWork,
  workItem,
} from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const REPAIRS = CONTRACT.project.repair_attempts_max.default;
const REFUSALS = CONTRACT.project.preflight_refusals_max.default;

describe('M11 repair and refusal limits', () => {
  test('work whose every run fails is launched once plus the permitted repairs, then parks with its cause', async (t) => {
    const fx = await scriptedEngine(t);
    const project = (await addProject(fx)).id;
    // Let the scheduler settle before there is work, so that from here on
    // one request is exactly one tick and each launch can be looked at before
    // the next.
    await tick(fx.engine, project);
    const item = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(item, Array.from({ length: REPAIRS + 3 }, () => script.crash(3, [step.usage({ input_tokens: 5 })])));

    // After each failed run the item is eligible again and its count is the
    // number of re-dispatches so far.
    for (let launch = 1; launch <= 1 + REPAIRS; launch++) {
      await tickOnce(fx.engine, project);
      const run = await waitForRun(fx.home, item, { index: launch - 1, state: 'ended' });
      assertRunEnded(fx.home, run.id, { outcome: 'failed', reason_class: 'infra_error', workspace: 'retained', launched: true, recovery: false });
      const row = await waitForWork(fx.home, item, launch <= REPAIRS ? 'eligible' : 'parked');
      assert.equal(row.repair_attempts, launch - 1, `after launch ${launch}: ${launch - 1} re-dispatch(es) counted`);
    }
    assert.equal(fx.scripted.launches({ work_item: item }).length, 1 + REPAIRS);
    const row = workItem(fx.home, item);
    assert.equal(row.repair_attempts, REPAIRS);
    assert.equal(JSON.parse(row.blocker).reason, 'repair_attempts_max', 'the cause is visible on the item');
    const [decision] = decisionsAbout(fx.home, item, 'blocker');
    assert.equal(decision?.status, 'open', 'and in the attention queue');
    assert.equal(JSON.parse(row.blocker).decision, decision.id);

    // Parked work is not repaired again.
    await tick(fx.engine, project);
    assert.equal(fx.scripted.launches({ work_item: item }).length, 1 + REPAIRS, 'no launch past the limit');
    assert.equal(runsOf(fx.home, item).length, 1 + REPAIRS);
    const history = withStore(fx.home, (db) => assertWorkHistory(db, item));
    assert.equal(history.filter((s) => s === 'parked').length, 1);
    assert.equal(history.at(-1), 'parked');
  });

  test('a result that is not valid is a failed run, counted once however often it is sent, and a repair that succeeds completes', async (t) => {
    const fx = await scriptedEngine(t);
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    assert.ok(REPAIRS >= 3, 'this case uses three repairs');
    fx.scripted.script(item, [
      { steps: [step.result('the gate passed'), step.result('the gate passed')] },
      script.invalid({ summary: 'a result without a status' }),
      script.invalid({ status: 7, summary: 'a status that is not a string' }),
      script.complete(),
    ]);
    await tickUntil(fx.engine, project, () => workItem(fx.home, item).status === 'complete', { what: 'the repaired item to complete' });

    const runs = runsOf(fx.home, item);
    assert.deepEqual(runs.map((r) => [r.outcome, r.reason_class]), [
      ['failed', 'invalid_result'],
      ['failed', 'invalid_result'],
      ['failed', 'invalid_result'],
      ['completed', 'none'],
    ]);
    for (const run of runs) assertRunEnded(fx.home, run.id, { launched: true, recovery: false });
    assert.equal(workItem(fx.home, item).repair_attempts, 3, 'one count per re-dispatch; the result sent twice counted once');
    assert.equal(fx.scripted.launches({ work_item: item }).length, 4);
    assert.equal(decisionsAbout(fx.home, item, 'blocker').length, 0, 'no blocker for work that completed within its limit');
    assert.deepEqual(
      withStore(fx.home, (db) => assertWorkHistory(db, item)),
      ['eligible', 'claimed', 'executing', 'eligible', 'claimed', 'executing', 'eligible', 'claimed', 'executing', 'eligible', 'claimed', 'executing', 'complete'],
    );
  });

  test('runs refused before launch are counted on their own and park the work at their limit', async (t) => {
    const fx = await scriptedEngine(t);
    const project = (await addProject(fx)).id;
    await pauseProject(fx.engine, project);
    const item = await addWork(fx.engine, project, 'verification');
    await fx.engine.stop();

    // Without the harness no backend is qualified: every dispatch is refused.
    const plain = await fx.start({ harness: false });
    await resumeProject(plain, project);
    for (let refusal = 1; refusal <= REFUSALS; refusal++) {
      await requestTick(plain, project);
      const run = await waitForRun(fx.home, item, { index: refusal - 1, state: 'ended' });
      assertRunEnded(fx.home, run.id, { outcome: 'refused', reason_class: 'preflight_refused', launched: false, recovery: false });
      const row = await waitForWork(fx.home, item, refusal < REFUSALS ? 'eligible' : 'parked');
      assert.equal(row.preflight_refusals, refusal, `refusal ${refusal} counted`);
      assert.equal(row.repair_attempts, 0, 'a refusal is not a repair attempt');
    }
    const row = workItem(fx.home, item);
    assert.equal(JSON.parse(row.blocker).reason, 'preflight_refusals_max');
    assert.equal(decisionsAbout(fx.home, item, 'blocker')[0]?.status, 'open');

    await requestTick(plain, project);
    await requestTick(plain, project);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(runsOf(fx.home, item).length, REFUSALS, 'parked work is not dispatched again');
    assert.equal(fx.scripted.launches().length, 0, 'nothing was ever launched');
    assert.equal(withStore(fx.home, (db) => assertWorkHistory(db, item)).at(-1), 'parked');
  });
});
