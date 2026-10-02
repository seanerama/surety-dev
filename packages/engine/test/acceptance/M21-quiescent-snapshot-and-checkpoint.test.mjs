// M21 (slice 3). Plan §3.3 M21 ("quiescent snapshot and checkpoint"); D1
// §§7.3, 7.4; build spec §6 correction 1 (RN R3; Review B08, B04, B15, N06);
// E2 ("checkpoints confer no git authority"); E11 ("a checkpoint is always a
// working revision"); D1-10, D1-32; SEAM.md §§28, 29.
//
// A snapshot is admitted only once the run's domain has been shown empty:
// while the boundary still reports the domain running, nothing is captured,
// however long ago the role's own process exited. Once termination is
// observed the workspace is snapshotted, and the validated, recorded and
// committed trees are one and the same tree.
//
// A checkpoint is such a commit, asked for by the role's result. It stays a
// working revision: the integration branch does not move, nothing is
// nominated, the workspace's current base advances and the run's original
// base is kept. The work continues in a new run, from the checkpoint; that
// run's own commit is integrated in the ordinary way.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { waitFor } from './harness/engine.mjs';
import { assertWorkHistory } from './harness/invariants.mjs';
import { addGitProject, addItem, roleThat, roleThatHolds, runToEnd, runToHold } from './harness/gitruns.mjs';
import { acceptanceState, assertCommitted, operationsOf, revisionsOf } from './harness/journal.mjs';
import { gitQuiet, isAncestor, refOid, refsOf } from './harness/repos.mjs';
import { getRow, resolvedPath, run as runRow, runsOf, scriptedEngine, waitForRun, workItem } from './harness/runs.mjs';
import { BOUNDARY, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const candidateRefs = (repo) => Object.keys(refsOf(repo)).filter((ref) => ref.startsWith('refs/surety/cand/'));

describe('M21 no snapshot of a workspace that may still have a writer', () => {
  test('while the boundary reports the domain running nothing is captured; once it reports terminated the checkpoint is taken, and the validated, recorded and committed trees agree', async (t) => {
    // Long grace periods: the engine is still waiting for the boundary when the report changes.
    const fx = await scriptedEngine(t, { config: { terminate_grace: 60, kill_grace: 30 } });
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThatHolds([step.write('src/part-one.js', 'export const one = 1;\n'), step.write('docs/progress.md', 'half way\n')], [], { checkpoint: true })]);
    const { run, launch, workspace } = await runToHold(fx, project.id, item);
    const domain = withStore(fx.home, (db) => db.prepare('SELECT "id" FROM "execution_domains" WHERE "run" = ?').get(run.id).id);
    const before = acceptanceState(fx, project.id);

    // The role's process will exit; the boundary goes on reporting its domain running.
    fx.scripted.boundary({ domains: { [domain]: BOUNDARY.running } });
    fx.scripted.release(item);
    await waitFor(() => !fx.scripted.isLive(launch), { what: 'the role to send its result and exit' });
    await sleep(3000);
    const waiting = runRow(fx.home, run.id);
    assert.notEqual(waiting.state, 'ended', 'the run has not ended: termination is not established');
    assert.equal(waiting.quarantined, 0, 'and the grace periods have not run out');
    assert.equal(getRow(fx.home, 'workspaces', workspace.id).snapshot_tree, null, 'no snapshot is admitted while the domain may have a live process');
    assert.deepEqual(operationsOf(fx.home, { run: run.id, journalKind: 'commit_tree' }), [], 'nothing was committed');
    assert.deepEqual(revisionsOf(fx.home, { run: run.id }), []);
    assert.deepEqual(acceptanceState(fx, project.id), before, 'no ref moved, the registry is as it was');

    // Termination is observed: now the workspace is quiescent, and is captured.
    fx.scripted.boundary({ domains: { [domain]: BOUNDARY.terminated } });
    await waitForRun(fx.home, item, { state: 'ended' });
    const checkpoint = assertCommitted(fx, run.id, {
      kind: 'checkpoint',
      parent: project.base,
      integrated: false,
      branchAt: project.base,
      changes: { 'src/part-one.js': 'A', 'docs/progress.md': 'A' },
    });

    // A checkpoint is a working revision.
    assert.deepEqual(candidateRefs(project.repo.path), [], 'nothing was nominated');
    const ws = getRow(fx.home, 'workspaces', workspace.id);
    const [revision] = revisionsOf(fx.home, { run: run.id });
    assert.equal(ws.current_base, checkpoint.sha, "the workspace's current base advanced to the checkpoint");
    assert.equal(ws.base_revision, project.base, "the workspace's original base is kept");
    assert.equal(runRow(fx.home, run.id).base_revision, project.base, "the run's original base is not rewritten");
    assert.deepEqual(JSON.parse(ws.checkpoints), [revision.id], 'the workspace names its checkpoint');
    const work = workItem(fx.home, item);
    assert.deepEqual([work.status, work.repair_attempts], ['eligible', 0], 'the work is to be continued, and no repair is charged for a checkpoint');
    assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, item)), ['eligible', 'claimed', 'executing', 'eligible'], 'it was never integrating: a checkpoint integrates nothing');
  });
});

describe('M21 work continues from a checkpoint in a new run', () => {
  test('the next run starts from the checkpoint commit in a workspace of its own, and its commit, made on the checkpoint, is the one integrated', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [
      roleThat([step.write('src/part-one.js', 'export const one = 1;\n')], { checkpoint: true }),
      roleThatHolds([step.write('src/part-two.js', 'export const two = 2;\n')]),
    ]);
    const first = await runToEnd(fx, project.id, item);
    const checkpoint = assertCommitted(fx, first.id, { kind: 'checkpoint', parent: project.base, integrated: false, branchAt: project.base, changes: { 'src/part-one.js': 'A' } });
    assert.equal(workItem(fx.home, item).status, 'eligible');

    // The continuation: a new run, from the checkpoint.
    const { run: second, workspace } = await runToHold(fx, project.id, item, { index: 1 });
    assert.notEqual(second.id, first.id, 'a new run');
    assert.equal(second.parent_run, first.id, 'linked to the run that checkpointed');
    assert.equal(second.base_revision, checkpoint.sha, "its base is the checkpoint, not the first run's base");
    assert.notEqual(workspace.id, first.workspace, 'it has a workspace of its own');
    assert.notEqual(resolvedPath(workspace.path), resolvedPath(checkpoint.workspace.path));
    assert.deepEqual([workspace.base_revision, workspace.current_base], [checkpoint.sha, checkpoint.sha]);
    assert.equal(gitQuiet(workspace.path, ['rev-parse', 'HEAD']), checkpoint.sha, 'the new workspace is checked out at the checkpoint');
    assert.equal(gitQuiet(workspace.path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD', 'detached');
    assert.equal(readFileSync(join(workspace.path, 'src/part-one.js'), 'utf8'), 'export const one = 1;\n', 'and holds what was checkpointed');
    assert.equal(refOid(project.repo.path, project.repo.ref), project.base, 'the integration branch has still not moved');
    assert.equal(workItem(fx.home, item).repair_attempts, 0, 'continuing from a checkpoint is not a repair');

    fx.scripted.release(item);
    await waitForRun(fx.home, item, { index: 1, state: 'ended' });
    // The branch moves from where it was, the original base, to the commit made on the checkpoint.
    const final = assertCommitted(fx, second.id, { kind: 'engine_commit', parent: checkpoint.sha, branchWas: project.base, integrated: true, changes: { 'src/part-two.js': 'A' } });
    assert.ok(isAncestor(project.repo.path, checkpoint.sha, final.sha) && isAncestor(project.repo.path, project.base, final.sha), 'the checkpoint and the original base are ancestors of what was integrated');
    assert.ok(existsSync(join(checkpoint.workspace.path, 'src/part-one.js')), "the first run's workspace is retained");
    assert.deepEqual(candidateRefs(project.repo.path), [], 'a continuation implies no nomination');
    assert.equal(runsOf(fx.home, item).length, 2);
    assert.deepEqual(
      withStore(fx.home, (db) => assertWorkHistory(db, item)).slice(0, 8),
      ['eligible', 'claimed', 'executing', 'eligible', 'claimed', 'executing', 'integrating', 'integrated'],
    );
    assert.equal(workItem(fx.home, item).repair_attempts, 0);
  });
});
