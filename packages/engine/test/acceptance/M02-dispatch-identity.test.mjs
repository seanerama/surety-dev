// M02, engine cases (slice 2). Plan §3.1 M02; D1 §§2.6, 6.2, 13.1; build
// spec §6 correction 10; Review B11; D1-01, D1-26; SEAM.md §§13, 16, 18. Two
// legitimate runs of the same role have identities of their own: run,
// invocation, execution domain, workspace, grant, lease, process. Allocating
// the receipt of one run again, repeatedly, concurrently and after a
// restart, returns the same receipt and launches nothing. An invocation is
// charged once, however often its run is finalized.
// The store constraints behind this are in
// M02-receipt-store-constraints.test.mjs (slice 1). Deferred (COVERAGE.md):
// distinct record identities (transcript, result), which need the record path
// of slice 4.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { releaseBarrier } from './harness/engine.mjs';
import { assertWorkHistory, eventsAbout, runFacts } from './harness/invariants.mjs';
import {
  addProject,
  addWork,
  allocate,
  assertLaunchMatchesStore,
  assertRunEnded,
  countOf,
  requestTick,
  runsOf,
  runsOfProject,
  scriptedEngine,
  tick,
  tickUntil,
  waitForRun,
  waitForWork,
  workItem,
} from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

describe('M02 distinct work and duplicate allocation in the engine', () => {
  test('two dispatched runs of one role have identities of their own', async (t) => {
    const fx = await scriptedEngine(t);
    const project = (await addProject(fx)).id;
    const items = [await addWork(fx.engine, project, 'verification'), await addWork(fx.engine, project, 'verification')];
    fx.scripted.defaultScript(script.complete([step.usage({ input_tokens: 21, output_tokens: 4 })]));
    await tickUntil(fx.engine, project, () => items.every((id) => workItem(fx.home, id).status === 'complete'), { what: 'both items to complete' });

    const runs = items.map((id) => runsOf(fx.home, id)[0]);
    const facts = runs.map((r) => assertRunEnded(fx.home, r.id, { outcome: 'completed', launched: true, recovery: false }));
    const launches = runs.map((r) => assertLaunchMatchesStore(fx, r.id));
    assert.deepEqual(runs.map((r) => r.role), ['verifier', 'verifier'], 'the same role twice');
    const distinct = (what, values) => assert.equal(new Set(values).size, values.length, `${what} are distinct: ${values.join(', ')}`);
    distinct('runs', runs.map((r) => r.id));
    distinct('run numbers', runs.map((r) => r.seq));
    distinct('invocations', facts.map((f) => f.receipts[0].id));
    distinct('execution domains', facts.map((f) => f.domains[0].id));
    distinct('ownership rows', facts.map((f) => f.ownership[0].id));
    distinct('workspaces', facts.map((f) => f.workspaces[0].id));
    distinct('workspace paths', facts.map((f) => f.workspaces[0].path));
    distinct('grants', facts.map((f) => f.grants[0].id));
    distinct('leases', facts.flatMap((f) => f.leases.map((l) => l.id)));
    distinct('ledger rows', facts.map((f) => f.receipts[0].ledger[0].id));
    distinct('processes', launches.map((l) => `${l.pid}/${l.start_time}`));
    for (const f of facts) {
      assert.equal(f.receipts.length, 1, 'one invocation per one-shot run');
      assert.equal(f.receipts[0].ledger.length, 1, 'one charge per invocation');
      assert.equal(f.receipts[0].ledger[0].invocation, f.receipts[0].id);
      assert.equal(f.receipts[0].usage.length, 1, 'each run has its own usage observation');
    }
    assert.equal(countOf(fx.home, 'ledger_rows'), 2, 'two invocations, two ledger rows');
    assert.equal(fx.scripted.launches().length, 2, 'two launches');
  });

  test('allocating the receipt of one run again, repeatedly and concurrently, returns that receipt and launches nothing', async (t) => {
    const fx = await scriptedEngine(t, { barriers: ['launch.before_spawn=pause'] });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    fx.scripted.defaultScript(script.complete());
    await requestTick(fx.engine, project);
    await fx.engine.waitUntil('barrier:launch.before_spawn');
    const run = await waitForRun(fx.home, item, { state: 'claimed' });
    const [receipt] = withStore(fx.home, (db) => runFacts(db, run.id).receipts);
    assert.equal(receipt.turn, null);

    for (let i = 0; i < 3; i++) assert.equal(await allocate(fx.engine, run.id), receipt.id, 'a repeated allocation returns the existing receipt');
    const racing = await Promise.all(Array.from({ length: 8 }, () => allocate(fx.engine, run.id)));
    assert.deepEqual([...new Set(racing)], [receipt.id], 'concurrent allocations return the existing receipt');
    assert.equal(countOf(fx.home, 'invocation_receipts', '"run" = ?', run.id), 1, 'one stored receipt');
    assert.equal(fx.scripted.launches().length, 0, 'allocation launches nothing');
    assert.equal(runsOfProject(fx.home, project).length, 1, 'and creates no run');

    // The dispatch goes on with that one receipt.
    await releaseBarrier(fx.engine, 'launch.before_spawn');
    await waitForWork(fx.home, item, 'complete');
    const facts = assertRunEnded(fx.home, run.id, { outcome: 'completed', launched: true });
    assert.deepEqual(facts.receipts.map((r) => r.id), [receipt.id]);
    assert.equal(fx.scripted.launches().length, 1, 'one launch for one receipt');
    assert.equal(fx.scripted.launches()[0].invocation, receipt.id);
    assert.equal(await allocate(fx.engine, run.id), receipt.id, 'after the run has ended the allocation still returns its receipt');
    assert.equal(fx.scripted.launches().length, 1);
  });

  test('after a restart the allocation still returns the same receipt, with no second receipt and no launch', async (t) => {
    const fx = await scriptedEngine(t, { barriers: ['dispatch.receipt_committed=kill'] });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    fx.scripted.defaultScript(script.complete());
    const dead = fx.engine;
    await requestTick(dead, project).catch(() => {});
    assert.deepEqual(await dead.exited, { code: null, signal: 'SIGKILL' });
    const [run] = runsOf(fx.home, item);
    const [receipt] = withStore(fx.home, (db) => runFacts(db, run.id).receipts);
    assert.ok(receipt, 'the receipt was durable when the engine died');

    const engine = await fx.start();
    assert.equal(await allocate(engine, run.id), receipt.id, 'the allocation is the same receipt after the restart');
    const racing = await Promise.all(Array.from({ length: 4 }, () => allocate(engine, run.id)));
    assert.deepEqual([...new Set(racing)], [receipt.id]);
    assert.equal(countOf(fx.home, 'invocation_receipts', '"run" = ?', run.id), 1, 'one stored receipt');
    assert.equal(fx.scripted.launches().length, 0, 'no launch: not before the kill, not by recovery, not by the allocation');
    const facts = assertRunEnded(fx.home, run.id, { outcome: 'recovered', launched: false });
    assert.equal(facts.receipts[0].ledger.length, 0, 'an invocation that was never launched is not charged');
  });

  test('a result sent twice is one completion and one charge', async (t) => {
    const fx = await scriptedEngine(t);
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(item, [{ steps: [step.usage({ input_tokens: 8 }), step.result(), step.result(), step.sleep(300)] }]);
    await tick(fx.engine, project);
    await waitForWork(fx.home, item, 'complete');
    const [run] = runsOf(fx.home, item);
    const facts = assertRunEnded(fx.home, run.id, { outcome: 'completed', launched: true, recovery: false });
    assert.equal(facts.receipts[0].ledger.length, 1, 'one ledger row');
    assert.equal(facts.receipts[0].statuses.filter((s) => s === 'ended').length, 1, 'one terminal observation');
    withStore(fx.home, (db) => {
      assert.equal(eventsAbout(db, 'work_item', item, 'work.complete').length, 1, 'completed once');
      assert.deepEqual(assertWorkHistory(db, item), ['eligible', 'claimed', 'executing', 'complete']);
    });
    await tick(fx.engine, project);
    assert.equal(countOf(fx.home, 'ledger_rows'), 1);
    assert.equal(runsOf(fx.home, item).length, 1);
  });

  test('finalization repeated by recovery, and repeated again, charges once', async (t) => {
    const fx = await scriptedEngine(t, { barriers: ['run_end.before_ended=kill'] });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    fx.scripted.defaultScript(script.complete([step.usage({ input_tokens: 8 })]));
    const dead = fx.engine;
    await requestTick(dead, project).catch(() => {});
    assert.deepEqual(await dead.exited, { code: null, signal: 'SIGKILL' });
    const [run] = runsOf(fx.home, item);
    assert.equal(run.state, 'finalizing');

    for (let restart = 1; restart <= 2; restart++) {
      const engine = await fx.start();
      await tick(engine, project);
      const facts = assertRunEnded(fx.home, run.id, { outcome: 'completed', launched: true });
      assert.equal(facts.receipts[0].ledger.length, 1, `restart ${restart}: one ledger row`);
      assert.equal(countOf(fx.home, 'ledger_rows'), 1, `restart ${restart}: one charge in all`);
      assert.equal(runsOf(fx.home, item).length, 1, `restart ${restart}: no second run`);
      assert.equal(fx.scripted.launches().length, 1, `restart ${restart}: no second launch`);
      await engine.kill();
    }
  });
});
