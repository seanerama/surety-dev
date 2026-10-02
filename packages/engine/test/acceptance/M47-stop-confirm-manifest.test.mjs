// M47, the `stop_confirm` manifest (slice 5). Plan §3.5 M47; build spec §6
// correction 22; RN §3 B12; Review B12; D1 §§4.5, 8.4, 10.5, 11.5, D1-08,
// D1-15; E25 item 4; SEAM.md §§17, 76, 80.
//
// A Stop confirmation binds the run it is about, whether that run can still
// be stopped, and what stopping it would leave: the workspace and its fate,
// the work's fate. It does not bind the difference between a run that is
// claimed and one that is executing (E25 item 4, the owner's decision): the
// same preview confirms either. It does bind what the workspace holds: once
// the role has finished and its snapshot is committed and integrated, a
// Stop would no longer prevent what the preview said it would, and the old
// preview is stale although the run can still be stopped. A valid
// confirmation starts the run-end protocol once; termination is observed
// separately, as always.
//
// The last case settles the code slice 2 left open: Stop or Abandon of a
// quarantined run is refused `quarantined`.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { releaseBarrier } from './harness/engine.mjs';
import { CODES, confirmRequired, decision, decisionsOn } from './harness/decisions.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { addGitProject, addItem, permittedEdit, roleThatHolds, runToHold } from './harness/gitruns.mjs';
import { armBarrier, journalBarrier } from './harness/journal.mjs';
import { addProject, addWork, assertRunEnded, getRow, requestTick, runsOf, scriptedEngine, tick, waitForQuarantine, waitForRun, waitForRunState, waitForWork } from './harness/runs.mjs';
import { BOUNDARY, script } from './harness/scripted.mjs';

describe('M47 the stop_confirm manifest', () => {
  test('a preview taken while the run is claimed confirms it when it is executing; the confirmation starts one Stop, and the run ends stopped once termination is observed', async (t) => {
    const fx = await scriptedEngine(t, { barriers: ['launch.before_spawn=pause'] });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'review');
    fx.scripted.script(item, [script.hold('gate')]);
    await requestTick(fx.engine, project);
    await fx.engine.waitUntil('barrier:launch.before_spawn');
    const [run] = runsOf(fx.home, item);
    assert.equal(run.state, 'claimed', 'the fixture is live: the run is claimed and its role is not yet spawned');

    const path = `/v1/projects/${project}/runs/${run.id}/stop`;
    const previewed = await confirmRequired(fx, path);
    assert.deepEqual(
      { kind: previewed.kind, subject: previewed.subject_id, run: previewed.manifest.run, stoppable: previewed.manifest.stoppable, workspace: previewed.manifest.workspace, fate: previewed.manifest.workspace_fate, work: previewed.manifest.work_fate.status },
      { kind: 'stop_confirm', subject: run.id, run: run.id, stoppable: true, workspace: run.workspace, fate: 'retained', work: 'held' },
      'the preview binds the run, that it can be stopped, its workspace and what a Stop leaves',
    );

    // The role is spawned: claimed becomes executing. That is not a change of what a Stop does.
    await releaseBarrier(fx.engine, 'launch.before_spawn');
    await fx.scripted.waitForHolding({ work_item: item });
    await waitForRunState(fx.home, run.id, 'executing');
    const again = await confirmRequired(fx, path);
    assert.deepEqual([again.id, again.preview_hash], [previewed.id, previewed.preview_hash], 'asked again, it is the same decision with the same preview');

    const confirmed = await fx.engine.post(path, { preview_hash: previewed.preview_hash });
    assert.equal(confirmed.status, 200, `the preview taken while claimed confirms the Stop of the executing run (body: ${confirmed.text})`);
    await waitForRunState(fx.home, run.id, 'ended');
    assertRunEnded(fx.home, run.id, { outcome: 'stopped', reason_class: 'human_stop', workspace: 'retained', launched: true });
    await waitForWork(fx.home, item, 'held');
    assert.deepEqual(decisionsOn(fx.home, 'stop_confirm', run.id).map((row) => [row.id, row.status]), [[previewed.id, 'consumed']], 'one confirmation, consumed once: one Stop was started');
    assertRefused(await fx.engine.post(path, { preview_hash: previewed.preview_hash }), 409, ['illegal_transition', CODES.consumed], 'confirming a second time');
  });

  test("the role finishes and its work is integrated between preview and confirmation: the run can still be stopped, what a Stop would leave has changed, and the old preview is refused", async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThatHolds([permittedEdit()])]);
    const { run } = await runToHold(fx, project.id, item);
    const path = `/v1/projects/${project.id}/runs/${run.id}/stop`;
    const previewed = await confirmRequired(fx, path);
    assert.equal(previewed.manifest.workspace_snapshot, null, 'previewed while the role is at work: nothing of the workspace is captured yet');

    // The role finishes; its snapshot is committed and the integration's ref update is applied, and held there.
    const barrier = journalBarrier('ref_update', 'effect_applied');
    await armBarrier(fx.engine, barrier, 'pause');
    fx.scripted.release(item);
    await fx.engine.waitUntil(`barrier:${barrier}`);

    assertRefused(await fx.engine.post(path, { preview_hash: previewed.preview_hash }), 409, [CODES.stale, CODES.invalidated], 'confirming with the preview taken before the integration');
    const next = await confirmRequired(fx, path);
    assert.deepEqual([next.id !== previewed.id, next.semantic_generation, decision(fx.home, previewed.id).status], [true, previewed.semantic_generation + 1, 'invalidated'], 'the run can still be stopped: asking again raises the next generation, and the old decision is closed');
    assert.notEqual(next.preview_hash, previewed.preview_hash);
    assert.equal(next.manifest.workspace_snapshot, getRow(fx.home, 'workspaces', run.workspace).snapshot_tree, 'the new preview binds what the workspace now holds');

    // Nothing was stopped by the stale confirmation: the run completes.
    await releaseBarrier(fx.engine, barrier);
    await waitForRunState(fx.home, run.id, 'ended');
    assertRunEnded(fx.home, run.id, { outcome: 'completed', reason_class: 'none' });
  });

  test('Stop and Abandon of a quarantined run are refused `quarantined`, and raise no confirmation', async (t) => {
    const fx = await scriptedEngine(t, { config: { terminate_grace: 1, kill_grace: 1 } });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'review');
    fx.scripted.script(item, [script.complete()]);
    fx.scripted.boundary({ default: BOUNDARY.unknown });
    await tick(fx.engine, project);
    const run = await waitForRun(fx.home, item);
    await waitForQuarantine(fx.home, run.id);
    for (const command of ['stop', 'abandon']) {
      assertRefused(await fx.engine.post(`/v1/projects/${project}/runs/${run.id}/${command}`, {}), 409, 'quarantined', `${command} of a quarantined run`);
      assert.equal(decisionsOn(fx.home, `${command}_confirm`, run.id).length, 0, `no ${command}_confirm decision was raised`);
    }
  });
});
