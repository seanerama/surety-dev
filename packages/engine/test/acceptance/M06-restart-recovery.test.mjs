// M06, the recovery case (slice 2). Plan §3.1 M06; D1 §§1.4, 16.1; E23 item
// 1; SEAM.md §§4, 14, 16. Slice 1 could only show that the startup step named
// `recovery` is listed before `full`, because it had nothing to recover. Here
// the engine is killed while a run is executing and its role is alive. The
// restart must have done the recovery before it lifts to full mode: the run
// ended, its domain terminated, its lease released, its grant revoked, its
// role process gone. Nothing is dispatched until that is done; afterwards
// other work is dispatched and the recovered work continues by Resume.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertRecoveredStore, assertWorkHistory, eventsAbout } from './harness/invariants.mjs';
import {
  addProject,
  addWork,
  assertLaunchMatchesStore,
  assertRunEnded,
  pauseProject,
  resumeProject,
  resumeWork,
  runsOf,
  runsOfProject,
  scriptedEngine,
  tick,
  waitForRun,
  waitForWork,
} from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const STARTUP_STEPS = ['lock', 'listen', 'store', 'recovery', 'integrity', 'full', 'scheduler'];
const maxSeq = (home) => withStore(home, (db) => db.prepare('SELECT COALESCE(MAX("seq"), 0) AS n FROM "events"').get().n);
const eventsAfter = (home, seq, type) => withStore(home, (db) => db.prepare('SELECT * FROM "events" WHERE "seq" > ? AND "type" = ? ORDER BY "seq"').all(seq, type));

describe('M06 a restart recovers owned runs and domains before any dispatch', () => {
  test('the recovery step ends a run that was executing and terminates its domain before full mode', async (t) => {
    const fx = await scriptedEngine(t);
    const a = (await addProject(fx)).id;
    const b = (await addProject(fx)).id;
    const running = await addWork(fx.engine, a, 'verification');
    fx.scripted.script(running, [script.hold('gate', { before: [step.usage({ input_tokens: 15 })] }), script.complete()]);
    fx.scripted.defaultScript(script.complete());
    await tick(fx.engine, a);
    const launch = await fx.scripted.waitForHolding({ work_item: running });
    const run = await waitForRun(fx.home, running, { state: 'executing' });
    assertLaunchMatchesStore(fx, run.id);
    // Work that is ready in another project, held back by a pause so that the
    // store can be read between recovery and the first dispatch.
    await pauseProject(fx.engine, b);
    const ready = await addWork(fx.engine, b, 'verification');
    const firstIncarnation = (await fx.engine.engineInfo()).incarnation;

    await fx.engine.kill();
    const killedAt = maxSeq(fx.home);
    assert.equal(fx.scripted.isLive(launch), true, 'the role outlived the engine');
    assert.equal(runsOf(fx.home, running)[0].state, 'executing', 'the dead engine left a run that has not ended');

    const engine = await fx.start();
    const info = await engine.engineInfo();
    assert.notEqual(info.incarnation, firstIncarnation);
    assert.deepEqual(info.startup.completed.slice(0, 6), STARTUP_STEPS.slice(0, 6));
    assert.equal(info.startup.failed, null);

    // Real work was done: the run, the domain, the lease, the grant, the process.
    withStore(fx.home, (db) => assertRecoveredStore(db));
    const facts = assertRunEnded(fx.home, run.id, { outcome: 'recovered', reason_class: 'recovered', workspace: 'retained', launched: true, recovery: info.incarnation });
    assert.equal(fx.scripted.isLive(launch), false, 'the surviving role process was terminated');
    assert.equal(facts.receipts[0].usage.length, 1, 'usage observed before the kill is kept');
    assert.equal((await waitForWork(fx.home, running, 'held')).status, 'held');

    // And it was done before full mode, and before anything was dispatched.
    const lifted = eventsAfter(fx.home, killedAt, 'engine.mode_changed');
    assert.equal(lifted.length, 1, 'the new incarnation lifted to full mode once');
    withStore(fx.home, (db) => {
      const [ended] = eventsAbout(db, 'run', run.id, 'run.ended');
      const [terminated] = eventsAbout(db, 'domain', facts.domains[0].id, 'domain.terminated');
      assert.ok(ended.seq > killedAt && ended.seq < lifted[0].seq, 'the run was ended by the new incarnation before it lifted to full mode');
      assert.ok(terminated.seq > killedAt && terminated.seq < lifted[0].seq, 'its domain was terminated before full mode');
    });
    assert.equal(eventsAfter(fx.home, killedAt, 'run.created').length, 0, 'nothing has been dispatched yet');
    assert.equal(runsOfProject(fx.home, b).length, 0);

    // Dispatch resumes after recovery.
    await resumeProject(engine, b);
    await tick(engine, [a, b]);
    await waitForWork(fx.home, ready, 'complete');
    const [created] = eventsAfter(fx.home, killedAt, 'run.created');
    assert.ok(created.seq > lifted[0].seq, 'the first dispatch comes after recovery and full mode');
    assert.equal(runsOf(fx.home, running).length, 1, 'the recovered work is not dispatched again by the scheduler');

    // Continuation of the recovered work: Resume, a new run, complete.
    await resumeWork(engine, a, running);
    await tick(engine, [a, b]);
    await waitForWork(fx.home, running, 'complete');
    assert.equal(runsOf(fx.home, running)[1].parent_run, run.id);
    withStore(fx.home, (db) => assertWorkHistory(db, running));
  });
});
