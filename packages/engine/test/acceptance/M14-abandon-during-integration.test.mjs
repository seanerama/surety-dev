// M14, Abandon while the run's work is integrating or integrated (slice 3,
// second session). Plan §3.2 M14 ("Abandon from each reachable owning state
// with a recorded prior state; include an in-flight journal operation. Tick
// repeatedly before explicit new-work/resume. ... Owned effects reconcile and
// termination is confirmed before discard. Work returns to its permitted
// prior state with dispatch hold; no automatic repurchase occurs. No resource
// held/quarantined by the old Run is reused"); D1 §§4.3, 4.5, 8.4; build spec
// §6 corrections 11 and 14; SEAM.md §§17, 33, 47; ../contract/work-items.json
// (Abandon from `integrating` and from `integrated`).
//
// As for Stop (M13-stop-during-integration.test.mjs), an Abandon that arrives
// while the run's integration is journaled finds an operation in flight, and
// the run-end protocol reconciles it before anything is discarded:
//
//   - not yet made, it is not made: the operation is failed, the branch
//     stays where it was;
//   - made, it is recorded and finalized: the work is integrated before it is
//     given back.
//
// Then the abandon takes its course: the workspace is removed through the
// journal, the run ends `abandoned`, and the work returns to its recorded
// prior status, `eligible`, under a dispatch hold that only an explicit
// Resume lifts. What was integrated stays integrated: an Abandon discards a
// workspace, not history.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { releaseBarrier } from './harness/engine.mjs';
import { assertWorkHistory } from './harness/invariants.mjs';
import { PERMITTED_EDIT, pausedIntegration } from './harness/gitruns.mjs';
import { assertCommitted, assertOperation, assertOperations, assertOrdinaryCourse, operationDetails, operationsOf, outOfBand, registryOf } from './harness/journal.mjs';
import { changedPaths, refOid, workspaceState } from './harness/repos.mjs';
import { abandonRun, assertRunEnded, getRow, resolvedPath, resumeWork, run as runRow, runsOf, tick, tickUntil, waitForRunState, workItem } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';

const integration = (fx, run) => operationDetails(fx.home, { run: run.id, journalKind: 'ref_update' })[0];

// Abandon while the integration waits at its barrier, then let the barrier
// go. Nothing is discarded and the run is not ended while its operation is
// in flight.
async function abandonAtBarrier(ctx) {
  const { fx, project, run, barrier } = ctx;
  const workspace = getRow(fx.home, 'workspaces', run.workspace);
  await abandonRun(fx.engine, project.id, run.id);
  await sleep(1500);
  assert.notEqual(runRow(fx.home, run.id).state, 'ended', 'the run is not ended while an operation it issued is in flight');
  assert.ok(existsSync(workspace.path), 'and its workspace is not discarded before that operation is reconciled');
  await releaseBarrier(fx.engine, barrier);
  await waitForRunState(fx.home, run.id, 'ended');
  assertRunEnded(fx.home, run.id, { outcome: 'abandoned', reason_class: 'human_abandon', workspace: 'discarded', launched: true, recovery: false });
  assert.equal(workspaceState(project.repo.path, workspace.path), 'absent', 'the workspace is gone, directory and metadata');
  const [removal] = operationsOf(fx.home, { run: run.id, journalKind: 'worktree_remove' });
  assertOrdinaryCourse(removal, 'the removal of the workspace');
  return workspace;
}

// The work waits under its dispatch hold; an explicit Resume gives it a new
// run in a workspace of its own, which is committed and integrated.
async function assertResumeIntegrates(ctx, workspace, { parent }) {
  const { fx, project, item } = ctx;
  for (let i = 0; i < 2; i++) await tick(fx.engine, project.id);
  const waiting = workItem(fx.home, item);
  assert.deepEqual([waiting.status, waiting.dispatch_hold, runsOf(fx.home, item).length], ['eligible', 1, 1], 'the work is eligible under a dispatch hold, and is not bought again by a tick');
  await resumeWork(fx.engine, project.id, item);
  const second = await tickUntil(fx.engine, project.id, () => (runsOf(fx.home, item)[1]?.state === 'ended' ? runsOf(fx.home, item)[1] : undefined), { max: 6, what: 'the resumed work to have run' });
  assertCommitted(fx, second.id, { kind: 'engine_commit', parent, integrated: true, changes: { 'src/second.js': 'A' } });
  assert.notEqual(resolvedPath(getRow(fx.home, 'workspaces', second.workspace).path), resolvedPath(workspace.path), "the new run does not reuse the abandoned run's workspace");
  withStore(fx.home, (db) => assertWorkHistory(db, item));
  assertOperations(fx.home, { project: project.id });
  assert.deepEqual(outOfBand(fx.home, project.id), []);
}

describe('M14 Abandon while the work is integrating', () => {
  test('before the swap: the integration is not made, its operation is failed, the workspace is discarded, and the work returns to eligible under a dispatch hold', async (t) => {
    const ctx = await pausedIntegration(t, 'intent_committed');
    const { fx, project, item, run } = ctx;
    assert.equal(workItem(fx.home, item).status, 'integrating', 'the fixture is live: the work is integrating');
    const workspace = await abandonAtBarrier(ctx);
    const op = assertOperation(integration(fx, run), 'the integration that was abandoned');
    assert.deepEqual([op.events.map((e) => e.kind), op.status, op.finalized], [['intended', 'failed'], 'failed', false], 'the effect was refused before it was made');
    assert.equal(refOid(project.repo.path, project.repo.ref), project.base, 'the integration branch has not moved');
    assert.equal(registryOf(fx.home, project.id)[project.repo.ref].expected_oid, project.base);
    assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, item)), ['eligible', 'claimed', 'executing', 'integrating', 'eligible'], 'the work returns to its recorded prior status');
    await assertResumeIntegrates(ctx, workspace, { parent: project.base });
  });

  test('with the swap made and not yet recorded: the operation in flight is reconciled and finalized before anything is discarded; the work is integrated, then given back under a dispatch hold', async (t) => {
    const ctx = await pausedIntegration(t, 'effect_applied');
    const { fx, project, item, run } = ctx;
    const sha = integration(fx, run).payload.new_oid;
    assert.equal(refOid(project.repo.path, project.repo.ref), sha, 'the fixture is live: the branch has moved and nothing records it');
    const workspace = await abandonAtBarrier(ctx);
    const op = assertOperation(integration(fx, run), 'the integration that was in flight');
    assert.deepEqual([op.state, op.status, op.finalized, op.attempts.length], ['finalized', 'succeeded', true, 1], `an effect that was made is recorded and finalized, by the attempt that made it (events: ${op.events.map((e) => e.kind).join(', ')})`);
    assert.equal(refOid(project.repo.path, project.repo.ref), sha, 'what was integrated stays integrated');
    assert.equal(registryOf(fx.home, project.id)[project.repo.ref].expected_oid, sha);
    assert.deepEqual(changedPaths(project.repo.path, project.base, sha), { [PERMITTED_EDIT.path]: 'A' });
    assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, item)), ['eligible', 'claimed', 'executing', 'integrating', 'integrated', 'eligible']);
    await assertResumeIntegrates(ctx, workspace, { parent: sha });
  });
});

describe('M14 Abandon while the work is integrated and its run has not ended', () => {
  test('the run ends abandoned, its workspace is discarded, the integration stands, and the work returns to eligible under a dispatch hold', async (t) => {
    const ctx = await pausedIntegration(t, 'finalizer_committed');
    const { fx, project, item, run } = ctx;
    assert.equal(workItem(fx.home, item).status, 'integrated', 'the fixture is live: the work is integrated and its run has not ended');
    const sha = integration(fx, run).payload.new_oid;
    const workspace = await abandonAtBarrier(ctx);
    assert.deepEqual([integration(fx, run).status, refOid(project.repo.path, project.repo.ref)], ['succeeded', sha], 'the finalized integration is as it was');
    assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, item)), ['eligible', 'claimed', 'executing', 'integrating', 'integrated', 'eligible']);
    await assertResumeIntegrates(ctx, workspace, { parent: sha });
  });
});
