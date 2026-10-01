// M13 (slice 2). Plan §3.2 M13; D1 §§4.5, 8.3–8.4, 15.3; E7; build spec §6
// corrections 1 and 11; D1-08; SEAM.md §§14, 16, 17. Stop from every status
// in which a run owns the work and which slice 2 can reach with a real run:
// claimed (the run is dispatched and not yet spawned) and executing, for each
// kind that is dispatched. The role is fenced at once, cleanup keeps what was
// observed, the run does not end before termination is observed, a late
// success changes nothing, the work is held, and only an explicit Resume
// continues it, with a new run.
// Deferred (COVERAGE.md): Stop from integrating, integrated and verifying,
// and with a journal operation in flight (slice 3); from awaiting_decision
// while a run still owns the work (slice 5).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { releaseBarrier } from './harness/engine.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { assertWorkHistory, eventsAbout } from './harness/invariants.mjs';
import {
  addProject,
  addWork,
  addWorkOfKind,
  assertLaunchMatchesStore,
  assertRunDispatched,
  assertRunEnded,
  getRow,
  leasesOf,
  requestTick,
  resumeWork,
  run as runRow,
  runsOf,
  scriptedEngine,
  stopRun,
  tick,
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

// Resume is explicit and creates a new run linked to the stopped one, with
// identities of its own. For a kind that completes in slice 2 the new run
// finishes the work.
async function assertResumeContinues(fx, project, item, stopped, kind) {
  await tick(fx.engine, project);
  assert.equal(runsOf(fx.home, item).length, 1, 'held work is not dispatched again by the scheduler');
  assert.equal(workItem(fx.home, item).status, 'held');

  await resumeWork(fx.engine, project, item);
  assert.equal(workItem(fx.home, item).status, 'eligible', 'Resume returns held work to eligible');
  await tick(fx.engine, project);
  const completes = COMPLETES_IN_SLICE_2.includes(kind);
  const second = await waitForRun(fx.home, item, { index: 1, state: completes ? 'ended' : 'executing' });
  assert.notEqual(second.id, stopped.run.id, 'a new run');
  assert.equal(second.parent_run, stopped.run.id, 'linked to the run that was stopped');
  const facts = completes
    ? assertRunEnded(fx.home, second.id, { outcome: 'completed', launched: true, recovery: false })
    : assertRunDispatched(fx.home, second.id, 'launched');
  assert.notEqual(facts.receipts[0].id, stopped.receipts[0].id, 'a new invocation');
  assert.notEqual(facts.domains[0].id, stopped.domains[0].id, 'a new execution domain');
  assert.notEqual(facts.grants[0].id, stopped.grants[0].id, 'a new grant');
  assert.notEqual(facts.workspaces[0].id, stopped.workspaces[0].id, 'a new workspace');
  assert.ok(getRow(fx.home, 'capability_grants', stopped.grants[0].id).revoked_at, 'the old grant stays revoked');
  if (completes) await waitForWork(fx.home, item, 'complete');
  withStore(fx.home, (db) => assertWorkHistory(db, item));
}

describe('M13 Stop from executing', () => {
  for (const kind of DISPATCHED) {
    test(`${kind}: the role is fenced, the run ends stopped, the work is held, and Resume starts a new run`, async (t) => {
      assert.ok(owningStatuses(kind).includes('executing'));
      const fx = await scriptedEngine(t);
      const project = (await addProject(fx)).id;
      const item = await addWorkOfKind(fx.engine, project, kind);
      fx.scripted.script(item, [
        // Reports usage, then waits. On SIGTERM it sends a success, as a role
        // that finishes just too late would.
        script.hold('gate', { before: [step.usage({ input_tokens: 70, output_tokens: 2 })], on_term: lateSuccess('exit') }),
        COMPLETES_IN_SLICE_2.includes(kind) ? script.complete() : script.hold('gate'),
      ]);
      await tick(fx.engine, project);
      const launch = await fx.scripted.waitForHolding({ work_item: item });
      const first = await waitForRun(fx.home, item, { state: 'executing' });
      assertLaunchMatchesStore(fx, first.id);

      const { decision } = await stopRun(fx.engine, project, first.id);
      // D1 §8.3: once Stop is admitted the lease is closing, so nothing the
      // role sends from here on has effect.
      for (const lease of leasesOf(fx.home, first.id)) {
        assert.ok(lease.closing === 1 || lease.released_at !== null, 'when Stop is answered the run lease is closing or already released');
      }
      const confirm = getRow(fx.home, 'decisions', decision);
      assert.deepEqual([confirm.kind, confirm.subject_type, confirm.subject_id, confirm.status], ['stop_confirm', 'run', first.id, 'consumed']);

      await waitForRunState(fx.home, first.id, 'ended');
      const stopped = assertRunEnded(fx.home, first.id, { outcome: 'stopped', reason_class: 'human_stop', workspace: 'retained', launched: true, recovery: false });
      assert.deepEqual(
        stopped.receipts[0].usage.map((u) => JSON.parse(u.raw)),
        [{ input_tokens: 70, output_tokens: 2 }],
        'usage observed before the Stop is kept',
      );
      assert.equal(fx.scripted.isLive(launch), false, 'the role process is gone');
      assert.ok(fx.scripted.eventsOf(launch.pid, 'signal').length >= 1, 'the role was asked to terminate');

      // The late success had no effect: the work is held, not complete.
      const row = await waitForWork(fx.home, item, 'held');
      assert.equal(row.status, 'held');
      withStore(fx.home, (db) => {
        assert.deepEqual(assertWorkHistory(db, item), ['eligible', 'claimed', 'executing', 'held']);
        assert.equal(eventsAbout(db, 'work_item', item, 'work.complete').length, 0, 'a success that arrives after Stop completes nothing');
      });

      assertRefused(await fx.engine.post(`/v1/projects/${project}/runs/${first.id}/stop`, {}), 409, 'illegal_transition', 'Stop on a run that has ended');
      await assertResumeContinues(fx, project, item, stopped, kind);
    });
  }
});

describe('M13 Stop from claimed', () => {
  for (const kind of DISPATCHED) {
    test(`${kind}: a run stopped before its role was spawned leaves no role running and holds the work`, async (t) => {
      assert.ok(owningStatuses(kind).includes('claimed'));
      const fx = await scriptedEngine(t, { barriers: ['launch.before_spawn=pause'] });
      const project = (await addProject(fx)).id;
      const item = await addWorkOfKind(fx.engine, project, kind);
      fx.scripted.defaultScript(COMPLETES_IN_SLICE_2.includes(kind) ? script.complete() : script.hold('gate'));
      await requestTick(fx.engine, project);
      await fx.engine.waitUntil('barrier:launch.before_spawn');
      const first = await waitForRun(fx.home, item, { state: 'claimed' });
      assertRunDispatched(fx.home, first.id, 'before_spawn', { incarnation: (await fx.engine.engineInfo()).incarnation });

      await stopRun(fx.engine, project, first.id);
      await releaseBarrier(fx.engine, 'launch.before_spawn');
      await waitForRunState(fx.home, first.id, 'ended');
      const stopped = assertRunEnded(fx.home, first.id, { outcome: 'stopped', reason_class: 'human_stop', workspace: 'retained', recovery: false });
      await waitForWork(fx.home, item, 'held');
      assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, item)), ['eligible', 'claimed', 'held']);

      // Whether or not the engine got as far as spawning, no role survives a stopped run.
      await sleep(500);
      for (const launch of fx.scripted.launches({ run: first.id })) {
        assert.equal(fx.scripted.isLive(launch), false, 'a role spawned for a stopped run does not stay alive');
      }
      assert.equal(runRow(fx.home, first.id).state, 'ended');
      await assertResumeContinues(fx, project, item, stopped, kind);
    });
  }
});

describe('M13 a run does not end before termination is observed', () => {
  test('while the boundary still reports the domain running, the stopped run is not ended and the work is not held', async (t) => {
    // Long grace periods, so that the engine is still waiting when the
    // boundary's acknowledgement finally comes.
    const fx = await scriptedEngine(t, { config: { terminate_grace: 60, kill_grace: 30 } });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(item, [script.hold('gate', { on_term: lateSuccess('exit') }), script.complete()]);
    await tick(fx.engine, project);
    const launch = await fx.scripted.waitForHolding({ work_item: item });
    const first = await waitForRun(fx.home, item, { state: 'executing' });
    const domain = withStore(fx.home, (db) => db.prepare('SELECT * FROM "execution_domains" WHERE "run" = ?').get(first.id));

    // The boundary keeps reporting the domain running, whatever the role process does.
    fx.scripted.boundary({ domains: { [domain.id]: BOUNDARY.running } });
    await stopRun(fx.engine, project, first.id);
    const finalizing = await waitForRunState(fx.home, first.id, 'finalizing');
    assert.equal(finalizing.outcome, 'stopped', 'the outcome is recorded on entering finalizing');
    await sleep(3000);
    assert.equal(fx.scripted.isLive(launch), false, 'the role process itself has exited');
    const waiting = runRow(fx.home, first.id);
    assert.equal(waiting.state, 'finalizing', 'the exit of the process does not establish termination');
    assert.equal(waiting.quarantined, 0, 'the grace periods have not run out');
    assert.notEqual(workItem(fx.home, item).status, 'held', 'the work is held only once cleanup is established');
    assert.equal(getRow(fx.home, 'execution_domains', domain.id).status, 'launched');
    assert.equal(leasesOf(fx.home, first.id).filter((l) => l.released_at === null).length, 1, 'the lease is not released before termination');
    assert.equal(withStore(fx.home, (db) => eventsAbout(db, 'run', first.id, 'run.ended').length), 0);

    // The acknowledgement arrives: the boundary reports the domain empty.
    fx.scripted.boundary({ domains: { [domain.id]: BOUNDARY.terminated } });
    await waitForRunState(fx.home, first.id, 'ended');
    const stopped = assertRunEnded(fx.home, first.id, { outcome: 'stopped', reason_class: 'human_stop', workspace: 'retained', launched: true, recovery: false });
    await waitForWork(fx.home, item, 'held');
    assert.equal(withStore(fx.home, (db) => eventsAbout(db, 'work_item', item, 'work.complete').length), 0, 'the late success had no effect');
    await assertResumeContinues(fx, project, item, stopped, 'verification');
  });

  test('Stop needs its confirmation, a stale confirmation does nothing, and a run is stopped only through its own project', async (t) => {
    const fx = await scriptedEngine(t);
    const project = (await addProject(fx)).id;
    const other = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(item, [script.hold('gate')]);
    await tick(fx.engine, project);
    await fx.scripted.waitForHolding({ work_item: item });
    const first = await waitForRun(fx.home, item, { state: 'executing' });
    const path = `/v1/projects/${project}/runs/${first.id}/stop`;

    const asked = await fx.engine.post(path, {});
    assertRefused(asked, 409, 'confirm_required', 'Stop without a confirmation');
    assert.equal(getRow(fx.home, 'decisions', asked.body.subject.decision).status, 'open');
    assert.equal(runRow(fx.home, first.id).state, 'executing', 'asking does not stop anything');

    assertRefused(await fx.engine.post(path, { preview_hash: `${asked.body.subject.preview_hash}-stale` }), 409, 'decision_stale', 'Stop with another preview hash');
    assert.equal(runRow(fx.home, first.id).state, 'executing');
    assertRefused(await fx.engine.post(`/v1/projects/${other}/runs/${first.id}/stop`, {}), 404, 'not_found', 'Stop through another project');
    assert.equal(runRow(fx.home, first.id).state, 'executing');
    assert.equal(leasesOf(fx.home, first.id).filter((l) => l.released_at === null && l.closing === 0).length, 1, 'the lease is untouched');

    const ok = await fx.engine.post(path, { preview_hash: asked.body.subject.preview_hash });
    assert.equal(ok.status, 200, ok.text);
    await waitForRunState(fx.home, first.id, 'ended');
    assertRunEnded(fx.home, first.id, { outcome: 'stopped', reason_class: 'human_stop', launched: true });
    assert.equal((await waitForWork(fx.home, item, 'held')).status, 'held');
  });
});
