// M04, the git journal's state projection (slice 3, second session). Plan
// §3.1 M04 ("permitted mutable projections change only with their new
// facts"; "a failed transition leaves neither a partial domain change nor an
// orphan event"); D1 §3.5 ("events are immutable facts ...; state is a
// mutable projection updated only in the same transaction as a new event"),
// §§6.2, 6.3, 12.1; A.3 (`git_journal_state`); build spec §6 correction 14;
// SEAM.md §44; ../contract/journal.json (`transitions`).
//
// The journal's events are append-only (slice 1 pinned that at the store).
// `git_journal_state` is the one mutable thing about a journal: per
// operation, the state it is in and the number of the event that put it
// there. It may move only with a new event, in that event's transaction. So,
// whenever the store is looked at, every operation has exactly one projection
// row, its state is the kind of the operation's last journal event, and its
// `last_event_seq` is that event's number; and a transaction that fails takes
// its event and its projection change with it.
//
// These cases look after histories that end well, end badly and are
// interrupted by a failing transaction. The same is asserted of a store
// reopened after a kill at each of the twenty journal boundaries (row M33:
// every crash case reads the projection before the engine is restarted).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { armFault } from './harness/engine.mjs';
import { addGitProject, addItem, permittedEdit, roleThat, roleThatHolds, runToEnd, runToHold } from './harness/gitruns.mjs';
import { JOURNAL, assertCommitted, assertJournalPath, assertOperations, changePolicy, operationDetails } from './harness/journal.mjs';
import { makeProjectRepo } from './harness/repos.mjs';
import { abandonRun, scriptedEngine, waitForRun, waitForRunState, waitForWork } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const projectionRows = (home) => withStore(home, (db) => db.prepare('SELECT "operation", "journal_kind", "state", "last_event_seq" FROM "git_journal_state" ORDER BY "operation"').all());

describe('M04 the journal state projection moves only with a journal event', () => {
  test('after operations of every journal kind, ended well and ended failed, each operation has one projection row at its last journal event', async (t) => {
    const fx = await scriptedEngine(t);
    // A bootstrap and a policy change: commits and ref updates that are not a run's.
    const repo = makeProjectRepo(join(fx.root, 'repo-api'));
    const created = await fx.engine.post('/v1/projects', { name: 'projection', tier: 'T2', dev_repo_path: repo.path, integration_branch: 'main' });
    assert.equal(created.status, 201, created.text);
    const api = created.body.project.id;
    await changePolicy(fx.engine, api, { repair_attempts_max: 1 });
    // A run that is committed and integrated; one that is checkpointed; one that is abandoned.
    const project = await addGitProject(fx);
    const integrated = await addItem(fx, project.id, 'fix');
    fx.scripted.script(integrated, [roleThat([permittedEdit()])]);
    const first = await runToEnd(fx, project.id, integrated);
    const checkpointed = await addItem(fx, project.id, 'fix');
    fx.scripted.script(checkpointed, [roleThat([step.write('src/part.js', 'export const part = 1;\n')], { checkpoint: true }), script.hold('gate', { before: [step.write('src/rest.js', 'export const rest = 2;\n')] })]);
    await runToEnd(fx, project.id, checkpointed);
    const { run: abandoned } = await runToHold(fx, project.id, checkpointed, { index: 1 });
    await abandonRun(fx.engine, project.id, abandoned.id);
    await waitForRunState(fx.home, abandoned.id, 'ended');
    // An integration that is refused: the branch is checked out in the developer's own work tree.
    const refused = await addGitProject(fx, { primary: 'integration' });
    const parked = await addItem(fx, refused.id, 'fix');
    fx.scripted.script(parked, [roleThat([permittedEdit()])]);
    await runToEnd(fx, refused.id, parked);
    await waitForWork(fx.home, parked, 'parked');

    const ops = assertOperations(fx.home);
    assert.deepEqual([...new Set(ops.map((op) => op.journal_kind))].sort(), Object.keys(JOURNAL.kinds).sort(), 'the fixture is live: operations of all four journal kinds');
    assert.ok(ops.length >= 10, `several operations (${ops.length})`);
    const rows = projectionRows(fx.home);
    assert.equal(rows.length, ops.length, 'one projection row per operation, and none without an operation');
    for (const op of ops) {
      assert.deepEqual(rows.filter((row) => row.operation === op.id), [{ operation: op.id, journal_kind: op.journal_kind, state: op.events.at(-1).kind, last_event_seq: op.events.length }], `the projection of ${op.id} (${op.journal_kind}) is at its last event, ${op.events.at(-1).kind}`);
    }
    assertCommitted(fx, first.id, { kind: 'engine_commit', parent: project.base, integrated: true });
  });

  for (const eventKind of ['applied', 'confirmed', 'finalized']) {
    test(`the transaction that appends \`${eventKind}\` fails once: neither a second event nor a projection that ran ahead is left, and the journal goes on from where it was`, async (t) => {
      const fx = await scriptedEngine(t);
      const project = await addGitProject(fx);
      const item = await addItem(fx, project.id, 'fix');
      fx.scripted.script(item, [roleThatHolds([permittedEdit()])]);
      const { run } = await runToHold(fx, project.id, item);
      // The next transaction that is about to write this journal event fails after its writes and before the event.
      await armFault(fx.engine, { point: 'before_event', event_type: `git.journal_${eventKind}` });
      fx.scripted.release(item);
      await waitForRun(fx.home, item, { state: 'ended' });
      assertCommitted(fx, run.id, { kind: 'engine_commit', parent: project.base, integrated: true });

      const ops = assertOperations(fx.home, { project: project.id });
      const rows = projectionRows(fx.home);
      for (const op of ops) {
        const kinds = op.events.map((e) => e.kind);
        assertJournalPath(kinds, `${op.journal_kind} after the failed transaction`);
        assert.deepEqual(kinds, JOURNAL.ordinary_events, `the ${op.journal_kind} operation has each event of its course once: the failed transaction left no event behind, and its repeat wrote one`);
        assert.deepEqual(rows.filter((row) => row.operation === op.id).map((row) => [row.state, row.last_event_seq]), [['finalized', kinds.length]], 'and its projection is at its last event');
      }
      assert.equal(operationDetails(fx.home, { run: run.id }).length, 3, 'the run has its three operations, each once: workspace, commit, integration');
    });
  }
});
