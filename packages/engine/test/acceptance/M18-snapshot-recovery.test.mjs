// M18, recovery after a normal result: the snapshot is recovered (slice 3).
// Plan §3.2 M18 ("kill at ... normal result before snapshot"); D1 §§7.3,
// 16.1, 16.2; E7 §3.9.4; D1-32 ("completed work, response lost before run
// completion: snapshot and receipts recovered; reconciled before any new
// invocation"); SEAM.md §§16, 28.
//
// Slice 2 killed the engine when a role's valid result had arrived and
// before the engine acted on it, and asserted the run recovered, its work
// held and its workspace retained with the role's files. In slice 3 the
// recovery also captures what the role left: once it has established that
// the run's domain is empty, it records the snapshot tree of the workspace.
// It validates, commits and integrates nothing: a recovery is not an
// acceptance. The receipts are as slice 2 pinned them: one terminal
// observation, one ledger row.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { assertRecoveredStore, assertWorkHistory } from './harness/invariants.mjs';
import { addGitProject, addItem, roleThat } from './harness/gitruns.mjs';
import { acceptanceState, operationsOf, revisionsOf } from './harness/journal.mjs';
import { refOid, snapshotTree } from './harness/repos.mjs';
import { assertRunEnded, getRow, requestTick, runsOf, scriptedEngine, tick, waitForRun, workItem } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

describe('M18 an engine killed after a normal result and before the snapshot', () => {
  test('recovery ends the run as recovered, records the snapshot tree of what the role left, and accepts nothing', async (t) => {
    const fx = await scriptedEngine(t, { barriers: ['run.result_received=kill'] });
    const project = await addGitProject(fx, { files: { 'old.txt': 'to be deleted\n' } });
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThat([step.write('src/done.js', 'export const done = true;\n'), step.delete('old.txt'), step.usage({ input_tokens: 9 })])]);
    const before = acceptanceState(fx, project.id);
    await requestTick(fx.engine, project.id);
    // The engine kills itself when the valid result arrives, before it has acted on it.
    await fx.engine.exited;
    const run = runsOf(fx.home, item)[0];
    const [launch] = fx.scripted.launches({ run: run.id });
    await waitFor(() => !fx.scripted.isLive(launch), { what: 'the role to exit' });
    const workspace = getRow(fx.home, 'workspaces', run.workspace);
    assert.equal(workspace.snapshot_tree, null, 'nothing was captured before the kill');
    // What the role left, computed here while no engine runs.
    const expected = snapshotTree(workspace.path, project.base);

    const engine = await fx.start();
    const incarnation = (await engine.engineInfo()).incarnation;
    await waitForRun(fx.home, item, { state: 'ended' });
    withStore(fx.home, (db) => assertRecoveredStore(db));
    const facts = assertRunEnded(fx.home, run.id, { outcome: 'recovered', reason_class: 'recovered', workspace: 'retained', launched: true, recovery: incarnation });
    assert.equal(facts.receipts[0].usage.length, 1, 'the usage observed before the kill is kept');

    const recovered = getRow(fx.home, 'workspaces', run.workspace);
    assert.equal(recovered.snapshot_tree, expected, 'the recovery captured the snapshot of what the role left');
    assert.ok(existsSync(join(workspace.path, 'src/done.js')) && !existsSync(join(workspace.path, 'old.txt')), 'the workspace is retained as the role left it');

    // A recovery accepts nothing.
    assert.deepEqual(revisionsOf(fx.home, { run: run.id }), [], 'no revision was recorded');
    for (const journalKind of ['commit_tree', 'ref_update']) assert.deepEqual(operationsOf(fx.home, { run: run.id, journalKind }), [], `no ${journalKind} operation`);
    assert.deepEqual(acceptanceState(fx, project.id), before, 'no ref moved, the registry expects what it expected');
    assert.equal(refOid(project.repo.path, project.repo.ref), project.base);
    assert.equal(recovered.current_base, project.base);

    // The work is held, and nothing replaces the run by itself.
    assert.equal(workItem(fx.home, item).status, 'held');
    for (let i = 0; i < 2; i++) await tick(fx.engine, project.id);
    assert.equal(runsOf(fx.home, item).length, 1, 'no replacement is launched before an explicit Resume');
    assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, item)), ['eligible', 'claimed', 'executing', 'held']);
  });
});
