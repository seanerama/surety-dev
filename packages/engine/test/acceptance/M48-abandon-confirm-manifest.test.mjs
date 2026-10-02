// M48, the `abandon_confirm` manifest (slice 5). Plan §3.5 M48; build spec
// §6 correction 22; RN §3 B12; D1 §§4.5, 8.4, 10.5; E25 item 4; SEAM.md
// §§17, 47, 76, 80.
//
// An Abandon confirmation binds the discard of one run's workspace: which
// run, which workspace and what it holds, and where the work goes. If a git
// operation of the run intervenes between preview and confirmation (its
// snapshot is committed and integrated), the discard is no longer the one
// that was previewed, and the confirmation is refused. A valid confirmation
// discards nothing before the run's termination is observed, and leaves the
// work exactly where the preview said: its prior status, under the dispatch
// hold.
//
// An Abandon's removal is made by the run-end protocol and is guarded by
// its own probe (row M32); it records no effect intent, so there is no
// after-the-answer case here.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, test } from 'node:test';

import { releaseBarrier } from './harness/engine.mjs';
import { CODES, confirmRequired, decision } from './harness/decisions.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { addGitProject, addItem, permittedEdit, roleThatHolds, runToHold } from './harness/gitruns.mjs';
import { armBarrier, journalBarrier } from './harness/journal.mjs';
import { assertRunEnded, assertRunQuarantined, getRow, scriptedEngine, tick, waitForQuarantine, waitForRunState, workItem } from './harness/runs.mjs';
import { BOUNDARY } from './harness/scripted.mjs';

// A Builder at work on a fix, held, and the preview of abandoning its run.
async function previewedAbandon(t, config = {}) {
  const fx = await scriptedEngine(t, { config });
  const project = await addGitProject(fx);
  const item = await addItem(fx, project.id, 'fix');
  fx.scripted.script(item, [roleThatHolds([permittedEdit()])]);
  const { run, workspace } = await runToHold(fx, project.id, item);
  const path = `/v1/projects/${project.id}/runs/${run.id}/abandon`;
  return { fx, project, item, run, workspace, path, previewed: await confirmRequired(fx, path) };
}

describe('M48 the abandon_confirm manifest', () => {
  test('a valid confirmation discards nothing before termination is observed, then discards the previewed workspace and leaves the work exactly where the preview said', async (t) => {
    const { fx, project, item, run, workspace, path, previewed } = await previewedAbandon(t, { terminate_grace: 1, kill_grace: 1 });
    assert.deepEqual(
      { kind: previewed.kind, run: previewed.manifest.run, stoppable: previewed.manifest.stoppable, workspace: previewed.manifest.workspace, snapshot: previewed.manifest.workspace_snapshot, fate: previewed.manifest.workspace_fate, work: previewed.manifest.work_fate },
      { kind: 'abandon_confirm', run: run.id, stoppable: true, workspace: workspace.id, snapshot: null, fate: 'discarded', work: { status: 'eligible', dispatch_hold: true } },
      'the preview binds the run, its workspace and what it holds, the discard, and where the work goes',
    );

    // The boundary goes on reporting the domain running: termination is not observed.
    fx.scripted.boundary({ default: BOUNDARY.running });
    const confirmed = await fx.engine.post(path, { preview_hash: previewed.preview_hash });
    assert.equal(confirmed.status, 200, `body: ${confirmed.text}`);
    await waitForQuarantine(fx.home, run.id);
    assertRunQuarantined(fx.home, run.id, { outcome: 'abandoned' });
    assert.ok(existsSync(workspace.path), 'the workspace is not discarded while termination is not observed');
    assert.deepEqual([workItem(fx.home, item).status === 'eligible', workItem(fx.home, item).dispatch_hold], [false, 0], 'and the work is not released');

    // Termination is observed. The discard and the work's fate are the previewed ones.
    fx.scripted.boundary({ default: BOUNDARY.auto });
    await tick(fx.engine, project.id);
    await waitForRunState(fx.home, run.id, 'ended');
    assertRunEnded(fx.home, run.id, { outcome: 'abandoned', reason_class: 'human_abandon', workspace: 'discarded' });
    const work = workItem(fx.home, item);
    assert.deepEqual({ status: work.status, dispatch_hold: work.dispatch_hold === 1 }, previewed.manifest.work_fate, 'the work is at its prior status under the dispatch hold, as previewed');
    assert.equal(getRow(fx.home, 'workspaces', workspace.id).disposition, previewed.manifest.workspace_fate);
    assert.equal(decision(fx.home, previewed.id).status, 'consumed');
  });

  test("the run's commit is integrated between preview and confirmation: the discard is no longer the previewed one, and the confirmation is refused with nothing discarded", async (t) => {
    const { fx, item, run, workspace, path, previewed } = await previewedAbandon(t);
    const barrier = journalBarrier('ref_update', 'effect_applied');
    await armBarrier(fx.engine, barrier, 'pause');
    fx.scripted.release(item);
    await fx.engine.waitUntil(`barrier:${barrier}`);

    assertRefused(await fx.engine.post(path, { preview_hash: previewed.preview_hash }), 409, [CODES.stale, CODES.invalidated], 'confirming with the preview taken before the integration');
    assert.ok(existsSync(workspace.path), 'nothing was discarded');
    const next = await confirmRequired(fx, path);
    assert.deepEqual([next.id !== previewed.id, next.semantic_generation, decision(fx.home, previewed.id).status], [true, previewed.semantic_generation + 1, 'invalidated'], 'asking again raises the next generation');
    assert.equal(next.manifest.workspace_snapshot, getRow(fx.home, 'workspaces', workspace.id).snapshot_tree, 'whose preview binds what the workspace now holds');

    await releaseBarrier(fx.engine, barrier);
    await waitForRunState(fx.home, run.id, 'ended');
    assertRunEnded(fx.home, run.id, { outcome: 'completed', reason_class: 'none', workspace: 'retained' });
  });
});
