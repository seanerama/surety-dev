// M09, paths taken by real runs (slice 2). Plan §3.2 M09; D1 §§4.1, 4.3,
// 8.1 step 9, 15.1; build spec §6 corrections 10 and 11; SEAM.md §§13, 15, 16.
// A verification and a review run their whole path, eligible → claimed →
// executing → complete, on the scripted backend, with no integration step
// invented for them. The kinds whose path integrates are dispatched and reach
// executing; what follows a valid result for them is slice 3.
// Deferred (COVERAGE.md): the integrating part of stage_build, fix, replan and
// assessment (slice 3); a dispatched check_correction (slice 5).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CONTRACT } from './harness/fixtures.mjs';
import { git } from './harness/git.mjs';
import { assertWorkHistory, eventsAbout } from './harness/invariants.mjs';
import {
  addProject,
  addWork,
  assertLaunchMatchesStore,
  assertRunDispatched,
  assertRunEnded,
  installPlan,
  runsOf,
  scriptedEngine,
  tick,
  waitForRun,
  waitForWork,
} from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { roleOf } from './harness/transitions.mjs';

const deadlineOf = (role) => CONTRACT.project[`deadline_${role}`].default;

describe('M09 work that does not integrate completes without an integration step', () => {
  for (const kind of ['verification', 'review']) {
    test(`a ${kind} item runs eligible → claimed → executing → complete`, async (t) => {
      const fx = await scriptedEngine(t);
      const project = await addProject(fx);
      const item = await addWork(fx.engine, project.id, kind);
      fx.scripted.script(item, [script.holdThenComplete('gate', [step.usage({ input_tokens: 40, output_tokens: 9 })])]);

      await tick(fx.engine, project.id);
      await fx.scripted.waitForHolding({ work_item: item });
      const run = await waitForRun(fx.home, item, { state: 'executing' });
      const info = await fx.engine.engineInfo();
      assert.deepEqual(info.backends, ['scripted'], 'the scripted backend is qualified in harness mode');
      assertRunDispatched(fx.home, run.id, 'launched', {
        incarnation: info.incarnation,
        base: git(project.repo.path, ['rev-parse', 'refs/heads/main']),
        deadline_s: deadlineOf(roleOf(kind)),
      });
      const launch = assertLaunchMatchesStore(fx, run.id);
      assert.equal(launch.role, roleOf(kind), `a ${kind} run is a ${roleOf(kind)} run`);

      fx.scripted.release(item);
      await waitForWork(fx.home, item, 'complete');
      const facts = assertRunEnded(fx.home, run.id, { outcome: 'completed', reason_class: 'none', workspace: 'retained', launched: true, recovery: false });
      assert.deepEqual(
        facts.receipts[0].usage.map((u) => [u.seq, u.semantics, JSON.parse(u.raw)]),
        [[1, 'cumulative', { input_tokens: 40, output_tokens: 9 }]],
        'the usage the role reported is recorded as it was sent',
      );
      withStore(fx.home, (db) => {
        assert.deepEqual(assertWorkHistory(db, item), ['eligible', 'claimed', 'executing', 'complete'], 'no fictitious integration');
        assert.equal(eventsAbout(db, 'work_item', item, 'work.integrated').length, 0, 'no work.integrated event');
        assert.equal(eventsAbout(db, 'work_item', item, 'work.complete').length, 1, 'completed once');
      });
      assert.equal(fx.scripted.isLive(launch), false, 'the role process is gone once the run has ended');

      // A finished item is not dispatched again.
      await tick(fx.engine, project.id);
      assert.equal(runsOf(fx.home, item).length, 1);
      assert.equal(fx.scripted.launches({ work_item: item }).length, 1);
    });
  }
});

describe('M09 work that integrates is dispatched and reaches executing', () => {
  for (const kind of ['stage_build', 'fix', 'replan', 'assessment']) {
    test(`a ${kind} item runs eligible → claimed → executing`, async (t) => {
      const fx = await scriptedEngine(t);
      const project = await addProject(fx);
      let item;
      if (kind === 'stage_build') {
        const plan = await installPlan(fx.engine, project.id, [{ number: 1, goal: 'first stage' }]);
        item = plan.stages[0].work_item;
        const stage = withStore(fx.home, (db) => db.prepare('SELECT * FROM "stages" WHERE "id" = ?').get(plan.stages[0].id));
        assert.equal(stage.work_item, item, 'the stage names its work item');
        assert.equal(stage.status, 'planned');
        const row = withStore(fx.home, (db) => db.prepare('SELECT * FROM "work_items" WHERE "id" = ?').get(item));
        assert.equal(row.kind, 'stage_build');
        assert.equal(JSON.parse(row.subject).stage, plan.stages[0].id, 'the work item names its stage');
        assert.deepEqual([row.trigger_source, row.trigger_id, row.trigger_generation], ['plan', plan.stages[0].id, 1]);
        const created = withStore(fx.home, (db) => eventsAbout(db, 'work_item', item, 'work.created'));
        assert.equal(created[0]?.payload.test_fixture, true, 'fixture work is labelled as test setup');
      } else {
        item = await addWork(fx.engine, project.id, kind);
      }
      fx.scripted.script(item, [script.hold('gate')]);

      await tick(fx.engine, project.id);
      await fx.scripted.waitForHolding({ work_item: item });
      const run = await waitForRun(fx.home, item, { state: 'executing' });
      const role = roleOf(kind);
      assertRunDispatched(fx.home, run.id, 'launched', {
        incarnation: (await fx.engine.engineInfo()).incarnation,
        base: git(project.repo.path, ['rev-parse', 'refs/heads/main']),
        ...(role === null ? {} : { deadline_s: deadlineOf(role) }),
      });
      const launch = assertLaunchMatchesStore(fx, run.id);
      assert.equal(launch.work_kind, kind);
      assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, item)), ['eligible', 'claimed', 'executing']);
    });
  }
});
