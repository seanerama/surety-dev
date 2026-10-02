// M16, "no snapshot while quarantined" (slice 3). Plan §3.2 M16 ("snapshot,
// ended status, discard and resource reuse remain forbidden"); D1 §§4.5,
// 7.3; build spec §6 corrections 1 and 2 (RN R3; Review B08); SEAM.md §§14,
// 16, 28.
//
// A snapshot is admitted only once the run's domain has been shown empty.
// A Builder that sent a valid result and exited, but whose domain the
// boundary cannot read, is quarantined before anything is captured: the
// outcome recorded with the quarantine is failed / infra_error, because the
// engine could not establish what the role left. It is not snapshotted
// while it is quarantined, an acknowledgement changes nothing, and when the
// quarantine clears it ends with the outcome it had, still unsnapshotted.
// Its work is then repaired by a new run, which is committed and integrated
// in the ordinary way.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { PERMITTED_EDIT, addGitProject, addItem, permittedEdit, roleThat, roleThatHolds, runToEnd, runToHold } from './harness/gitruns.mjs';
import { acceptanceState, assertCommitted, assertNothingAccepted, operationsOf, revisionsOf } from './harness/journal.mjs';
import { answerDecision, assertRunQuarantined, getRow, pauseProject, resumeProject, run as runRow, scriptedEngine, tick, waitForQuarantine, waitForRunState, workItem } from './harness/runs.mjs';
import { BOUNDARY } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

describe('M16 no snapshot of a quarantined run', () => {
  test('a Builder whose domain cannot be read after its valid result is quarantined as failed, is never snapshotted, and its work is repaired by a new run', async (t) => {
    const fx = await scriptedEngine(t, { config: { terminate_grace: 1, kill_grace: 1 } });
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThatHolds([permittedEdit()]), roleThat([permittedEdit()])]);
    const { run, launch, workspace } = await runToHold(fx, project.id, item);
    const domain = withStore(fx.home, (db) => db.prepare('SELECT "id" FROM "execution_domains" WHERE "run" = ?').get(run.id).id);
    const before = acceptanceState(fx, project.id);

    // The role sends its result and exits; the boundary cannot say whether its domain is empty.
    fx.scripted.boundary({ domains: { [domain]: BOUNDARY.unknown } });
    fx.scripted.release(item);
    await waitFor(() => !fx.scripted.isLive(launch), { what: 'the role to send its result and exit' });
    await waitForQuarantine(fx.home, run.id);
    const quarantined = assertRunQuarantined(fx.home, run.id, { outcome: 'failed' });
    assert.equal(quarantined.run.reason_class, 'infra_error', 'what the role left could not be established: that is the outcome recorded, not completed');

    const untouched = () => {
      assert.equal(getRow(fx.home, 'workspaces', workspace.id).snapshot_tree, null, 'no snapshot of a workspace whose domain may have a live process');
      assert.deepEqual(operationsOf(fx.home, { run: run.id, journalKind: 'commit_tree' }), [], 'nothing was committed');
      assert.deepEqual(revisionsOf(fx.home, { run: run.id }), []);
      assert.deepEqual(acceptanceState(fx, project.id), before, 'no ref moved');
    };
    untouched();

    // More ticks and an acknowledgement establish nothing.
    for (let i = 0; i < 2; i++) await tick(fx.engine, project.id);
    const blocker = quarantined.decisions.find((d) => d.kind === 'blocker' && d.status === 'open');
    await answerDecision(fx.engine, project.id, blocker.id, 'acknowledge');
    await tick(fx.engine, project.id);
    assert.equal(runRow(fx.home, run.id).quarantined, 1, 'an acknowledgement is not observed termination');
    untouched();

    // Termination is observed: the run ends with the outcome it had, and is still not snapshotted.
    // (The project is paused meanwhile, so that the repair does not start before this is looked at.)
    await pauseProject(fx.engine, project.id);
    fx.scripted.boundary({ domains: { [domain]: BOUNDARY.terminated } });
    await tick(fx.engine, project.id);
    await waitForRunState(fx.home, run.id, 'ended');
    assertNothingAccepted(fx, run.id, before, { reason: 'infra_error' });
    assert.equal(getRow(fx.home, 'workspaces', workspace.id).snapshot_tree, null, 'a cleared quarantine does not turn into a snapshot after the fact');
    assert.ok(existsSync(join(workspace.path, PERMITTED_EDIT.path)), 'the workspace is retained as the role left it');

    // The work is repaired by a new run in a workspace of its own, and that one is accepted.
    await resumeProject(fx.engine, project.id);
    const second = await runToEnd(fx, project.id, item, { index: 1 });
    assertCommitted(fx, second.id, { kind: 'engine_commit', parent: project.base, integrated: true, changes: { [PERMITTED_EDIT.path]: 'A' } });
    assert.equal(workItem(fx.home, item).repair_attempts, 1, 'the second run is a repair');
    assert.notEqual(second.workspace, run.workspace);
  });
});
