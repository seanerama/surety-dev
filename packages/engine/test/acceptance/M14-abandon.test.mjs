// M14 (slice 2). Plan §3.2 M14; D1 §§4.3, 4.5, 8.4; E7; build spec §6
// corrections 1 and 11; D1-08; SEAM.md §§14, 16, 17. Abandon from every
// status in which a run owns the work and which slice 2 can reach with a real
// run: claimed and executing, for each kind that is dispatched. Termination
// is confirmed before anything is discarded; the workspace is then discarded,
// the work returns to its recorded prior status under a durable dispatch
// hold, and nothing buys the work again until an explicit Resume or a new
// trigger generation. Nothing the old run still holds is reused.
// Deferred (COVERAGE.md): Abandon from integrating, integrated and
// verifying, and with a journal operation in flight (slice 3); from
// awaiting_decision while a run still owns the work (slice 5).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { releaseBarrier } from './harness/engine.mjs';
import { assertWorkHistory } from './harness/invariants.mjs';
import {
  abandonRun,
  addProject,
  addWorkOfKind,
  assertRunDispatched,
  assertRunEnded,
  assertRunQuarantined,
  getRow,
  observeTrigger,
  requestTick,
  resumeWork,
  runsOf,
  scriptedEngine,
  tick,
  waitForQuarantine,
  waitForRun,
  waitForRunState,
  waitForWork,
  workItem,
} from './harness/runs.mjs';
import { BOUNDARY, lateSuccess, script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { owningStatuses } from './harness/transitions.mjs';

const DISPATCHED = ['stage_build', 'fix', 'verification', 'review', 'replan', 'assessment'];
const COMPLETES_IN_SLICE_2 = ['verification', 'review'];

// After an Abandon: the work is back where it was before the run, on hold,
// and the scheduler leaves it alone until someone resumes it.
async function assertOnHoldUntilResumed(fx, project, item, abandoned, kind) {
  const row = await waitForWork(fx.home, item, 'eligible');
  assert.equal(row.dispatch_hold, 1, 'the work returns to its prior status under a dispatch hold');
  for (let i = 0; i < 2; i++) await tick(fx.engine, project);
  assert.equal(runsOf(fx.home, item).length, 1, 'no automatic repurchase, however often the scheduler runs');
  assert.equal(workItem(fx.home, item).dispatch_hold, 1, 'the hold is durable');

  await resumeWork(fx.engine, project, item);
  assert.equal(workItem(fx.home, item).dispatch_hold, 0, 'an explicit Resume clears the hold');
  await tick(fx.engine, project);
  const completes = COMPLETES_IN_SLICE_2.includes(kind);
  const second = await waitForRun(fx.home, item, { index: 1, state: completes ? 'ended' : 'executing' });
  const facts = completes ? assertRunEnded(fx.home, second.id, { outcome: 'completed', launched: true, recovery: false }) : assertRunDispatched(fx.home, second.id, 'launched');
  assert.notEqual(facts.workspaces[0].id, abandoned.workspaces[0].id, 'the new run has a workspace of its own');
  assert.notEqual(facts.workspaces[0].path, abandoned.workspaces[0].path, 'at a path of its own');
  assert.notEqual(facts.grants[0].id, abandoned.grants[0].id);
  assert.notEqual(facts.receipts[0].id, abandoned.receipts[0].id);
  if (completes) await waitForWork(fx.home, item, 'complete');
  withStore(fx.home, (db) => assertWorkHistory(db, item));
}

describe('M14 Abandon from executing', () => {
  for (const kind of DISPATCHED) {
    test(`${kind}: termination is confirmed, the workspace is discarded, and the work waits under a dispatch hold`, async (t) => {
      assert.ok(owningStatuses(kind).includes('executing'));
      const fx = await scriptedEngine(t);
      const project = (await addProject(fx)).id;
      const item = await addWorkOfKind(fx.engine, project, kind);
      fx.scripted.script(item, [
        script.hold('gate', { before: [step.write('draft/notes.txt', 'work in progress'), step.usage({ input_tokens: 31 })], on_term: lateSuccess('exit') }),
        COMPLETES_IN_SLICE_2.includes(kind) ? script.complete() : script.hold('gate'),
      ]);
      await tick(fx.engine, project);
      const launch = await fx.scripted.waitForHolding({ work_item: item });
      const first = await waitForRun(fx.home, item, { state: 'executing' });
      const workspace = getRow(fx.home, 'workspaces', first.workspace);
      assert.ok(existsSync(`${workspace.path}/draft/notes.txt`), 'the role wrote into its workspace');

      const { decision } = await abandonRun(fx.engine, project, first.id);
      const confirm = getRow(fx.home, 'decisions', decision);
      assert.deepEqual([confirm.kind, confirm.subject_type, confirm.subject_id, confirm.status], ['abandon_confirm', 'run', first.id, 'consumed']);
      await waitForRunState(fx.home, first.id, 'ended');
      // assertRunEnded checks the discard on disk and in git as well as in the store.
      const abandoned = assertRunEnded(fx.home, first.id, { outcome: 'abandoned', reason_class: 'human_abandon', workspace: 'discarded', launched: true, recovery: false });
      assert.equal(fx.scripted.isLive(launch), false, 'the role process is gone');
      assert.equal(abandoned.receipts[0].usage.length, 1, 'usage observed before the Abandon is kept');
      assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, item)), ['eligible', 'claimed', 'executing', 'eligible'], 'not complete, whatever the role sent on its way out');
      await assertOnHoldUntilResumed(fx, project, item, abandoned, kind);
    });
  }
});

describe('M14 Abandon from claimed', () => {
  for (const kind of DISPATCHED) {
    test(`${kind}: a run abandoned before its role was spawned leaves nothing behind and holds the work`, async (t) => {
      assert.ok(owningStatuses(kind).includes('claimed'));
      const fx = await scriptedEngine(t, { barriers: ['launch.before_spawn=pause'] });
      const project = (await addProject(fx)).id;
      const item = await addWorkOfKind(fx.engine, project, kind);
      fx.scripted.defaultScript(COMPLETES_IN_SLICE_2.includes(kind) ? script.complete() : script.hold('gate'));
      await requestTick(fx.engine, project);
      await fx.engine.waitUntil('barrier:launch.before_spawn');
      const first = await waitForRun(fx.home, item, { state: 'claimed' });
      assertRunDispatched(fx.home, first.id, 'before_spawn');

      await abandonRun(fx.engine, project, first.id);
      await releaseBarrier(fx.engine, 'launch.before_spawn');
      await waitForRunState(fx.home, first.id, 'ended');
      const abandoned = assertRunEnded(fx.home, first.id, { outcome: 'abandoned', reason_class: 'human_abandon', workspace: 'discarded', recovery: false });
      await sleep(500);
      for (const launch of fx.scripted.launches({ run: first.id })) assert.equal(fx.scripted.isLive(launch), false, 'no role survives an abandoned run');
      assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, item)), ['eligible', 'claimed', 'eligible']);
      await assertOnHoldUntilResumed(fx, project, item, abandoned, kind);
    });
  }
});

describe('M14 nothing is discarded or reused before termination is confirmed', () => {
  test('while the boundary reports the domain running, the workspace stays, and no new trigger is dispatched onto the project', async (t) => {
    const fx = await scriptedEngine(t, { config: { terminate_grace: 1, kill_grace: 1 } });
    const project = (await addProject(fx)).id;
    const trigger = { project, kind: 'verification', source: 'test', id: 'abandoned-work' };
    const item = (await observeTrigger(fx.engine, { ...trigger, generation: 1 })).workItem;
    fx.scripted.script(item, [script.hold('gate', { before: [step.write('draft/notes.txt', 'work in progress')] })]);
    fx.scripted.defaultScript(script.complete());
    await tick(fx.engine, project);
    await fx.scripted.waitForHolding({ work_item: item });
    const first = await waitForRun(fx.home, item, { state: 'executing' });
    const workspace = getRow(fx.home, 'workspaces', first.workspace);
    const domain = withStore(fx.home, (db) => db.prepare('SELECT * FROM "execution_domains" WHERE "run" = ?').get(first.id));

    // Cancellation fails: the boundary keeps reporting the domain running.
    fx.scripted.boundary({ domains: { [domain.id]: BOUNDARY.running } });
    await abandonRun(fx.engine, project, first.id);
    await waitForQuarantine(fx.home, first.id);
    assertRunQuarantined(fx.home, first.id, { outcome: 'abandoned' });
    assert.ok(existsSync(`${workspace.path}/draft/notes.txt`), 'nothing is discarded while a writer may survive');
    const during = workItem(fx.home, item);
    assert.ok(!(during.status === 'eligible' && during.dispatch_hold === 0), 'the work is not free to be bought again');

    // A new trigger generation is a new item, and it may not run on what the old run still holds.
    const next = (await observeTrigger(fx.engine, { ...trigger, generation: 2 })).workItem;
    assert.notEqual(next, item);
    for (let i = 0; i < 2; i++) await tick(fx.engine, project);
    assert.equal(runsOf(fx.home, next).length, 0, 'nothing is dispatched onto a project with a quarantined run');
    assert.equal(runsOf(fx.home, item).length, 1);

    // Termination is observed: the abandon completes, once.
    fx.scripted.boundary({ domains: { [domain.id]: BOUNDARY.terminated } });
    await tick(fx.engine, project);
    await waitForRunState(fx.home, first.id, 'ended');
    assertRunEnded(fx.home, first.id, { outcome: 'abandoned', reason_class: 'human_abandon', workspace: 'discarded', launched: true, recovery: false });
    const row = await waitForWork(fx.home, item, 'eligible');
    assert.equal(row.dispatch_hold, 1);

    // With the old run gone, the new generation is dispatched: new work is
    // one of the two explicit ways on (D1 §4.3). Whether observing it also
    // lifts the hold on the old item is not pinned.
    await tick(fx.engine, project);
    await waitForWork(fx.home, next, 'complete');
    assert.equal(fx.scripted.launches({ work_item: next }).length, 1);
    withStore(fx.home, (db) => {
      assertWorkHistory(db, item);
      assertWorkHistory(db, next);
    });
  });
});
