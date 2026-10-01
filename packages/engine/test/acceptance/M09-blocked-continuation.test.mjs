// M09, the blocked continuation (slice 2). Plan §3.2 M09; D1 §§4.3, 10.5,
// 11.5; build spec §6 correction 11; Review B10; SEAM.md §§15, 17. An item
// parked at its repair limit has a visible blocker. Answering it resumes only
// the continuation the item recorded, a return to eligible: the answer itself
// launches nothing and completes nothing, and no other item is touched.
// The source of the park here is the one slice 2 has, the repair limit. An
// item that leaves awaiting_decision for its stored continuation is pinned at
// the table (M09-work-transitions.test.mjs); an engine-raised
// awaiting_decision answered through the queue is deferred (COVERAGE.md).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertRefused, CONTRACT } from './harness/fixtures.mjs';
import { assertWorkHistory } from './harness/invariants.mjs';
import {
  addProject,
  addWork,
  answerDecision,
  decisionsAbout,
  driveTo,
  getRow,
  runsOf,
  scriptedEngine,
  tick,
  tickUntil,
  waitForWork,
  workItem,
} from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const REPAIRS = CONTRACT.project.repair_attempts_max.default;

// A verification item whose every run crashes until it parks, and a second
// item of the same project that is held and must stay out of everything.
async function parkedItem(t) {
  const fx = await scriptedEngine(t);
  const project = (await addProject(fx)).id;
  const bystander = await addWork(fx.engine, project, 'review');
  await driveTo(fx.engine, bystander, ['claimed', 'held']);
  const item = await addWork(fx.engine, project, 'verification');
  fx.scripted.script(item, [...Array.from({ length: 1 + REPAIRS }, () => script.crash(3)), script.complete()]);
  await tickUntil(fx.engine, project, () => workItem(fx.home, item).status === 'parked', { what: 'the item to park' });
  const row = workItem(fx.home, item);
  const blocker = JSON.parse(row.blocker);
  const decisions = decisionsAbout(fx.home, item, 'blocker');
  assert.equal(decisions.length, 1, 'one blocker decision for the parked item');
  return { fx, project, item, bystander, row, blocker, decision: decisions[0] };
}

describe('M09 an answered blocker resumes only the recorded continuation', () => {
  test('retry returns the parked item to eligible, and only the next tick launches it', async (t) => {
    const { fx, project, item, bystander, row, blocker, decision } = await parkedItem(t);
    assert.equal(fx.scripted.launches({ work_item: item }).length, 1 + REPAIRS, 'parked after the first launch and every permitted repair');
    assert.equal(row.repair_attempts, REPAIRS);
    assert.equal(blocker.reason, 'repair_attempts_max', 'the blocker names its cause');
    assert.equal(blocker.decision, decision.id, 'the item names its blocker decision');
    assert.ok(blocker.raised_at);
    assert.deepEqual([decision.status, decision.subject_type, decision.project], ['open', 'work_item', project]);
    assert.ok(JSON.parse(decision.blocked_while_open).work_items.includes(item), 'the decision holds the item while it is open');
    const options = JSON.parse(decision.options).map((o) => o.key);
    assert.ok(options.includes('retry') && options.includes('cancel'), `options: ${options.join(', ')}`);

    // Parked work is not dispatched, however often the scheduler runs.
    await tick(fx.engine, project);
    assert.equal(fx.scripted.launches({ work_item: item }).length, 1 + REPAIRS);

    // A stale preview has no effect.
    assertRefused(
      await fx.engine.post(`/v1/projects/${project}/decisions/${decision.id}/answer`, { option: 'retry', preview_hash: `${decision.preview_hash}-stale` }),
      409,
      'decision_stale',
      'an answer with another preview hash',
    );
    assert.equal(workItem(fx.home, item).status, 'parked');
    assert.equal(getRow(fx.home, 'decisions', decision.id).status, 'open');

    await answerDecision(fx.engine, project, decision.id, 'retry');
    const after = await waitForWork(fx.home, item, 'eligible');
    assert.equal(after.status, 'eligible', 'the recorded continuation of a parked item is eligible');
    assert.equal(after.blocker, null, 'the blocker is cleared');
    assert.equal(getRow(fx.home, 'decisions', decision.id).status, 'consumed');
    assert.equal(runsOf(fx.home, item).length, 1 + REPAIRS, 'the answer itself created no run');
    assert.equal(fx.scripted.launches({ work_item: item }).length, 1 + REPAIRS, 'and launched nothing');

    // The decision is consumed once.
    assertRefused(
      await fx.engine.post(`/v1/projects/${project}/decisions/${decision.id}/answer`, { option: 'retry', preview_hash: decision.preview_hash }),
      409,
      'decision_consumed',
      'a second answer',
    );

    // The continuation is carried out by the scheduler like any eligible item.
    await tick(fx.engine, project);
    await waitForWork(fx.home, item, 'complete');
    assert.equal(fx.scripted.launches({ work_item: item }).length, 2 + REPAIRS, 'exactly one more launch');
    const history = withStore(fx.home, (db) => assertWorkHistory(db, item));
    assert.deepEqual(history.slice(-5), ['parked', 'eligible', 'claimed', 'executing', 'complete']);

    // Nothing unrelated was launched or completed.
    assert.equal(workItem(fx.home, bystander).status, 'held');
    assert.equal(runsOf(fx.home, bystander).length, 0);
    assert.equal(fx.scripted.launches({ work_item: bystander }).length, 0);
  });

  test('cancel ends the parked item without another launch', async (t) => {
    const { fx, project, item, bystander, decision } = await parkedItem(t);
    await answerDecision(fx.engine, project, decision.id, 'cancel');
    assert.equal((await waitForWork(fx.home, item, 'cancelled')).status, 'cancelled');
    assert.equal(getRow(fx.home, 'decisions', decision.id).status, 'consumed');
    await tick(fx.engine, project);
    assert.equal(fx.scripted.launches({ work_item: item }).length, 1 + REPAIRS, 'a cancelled item is never launched again');
    assert.equal(withStore(fx.home, (db) => assertWorkHistory(db, item)).at(-1), 'cancelled');
    assert.equal(workItem(fx.home, bystander).status, 'held');
    assert.equal(runsOf(fx.home, bystander).length, 0);
  });
});
