// M15, the reconciliation of a write that a deadline made ambiguous (slice 3,
// second session). Plan §3.2 M15 ("possible writes become ambiguous,
// dependent integration/dispatch stays suppressed after late completion. ...
// No timer result is mistaken for observed process termination"); D1 §§7.1,
// 7.10, 8.1 step 2, 8.5 ("A deadline on owned work cancels it: the child is
// killed, issued writes are marked ambiguous, the generation is closed, and
// any late completion is rejected"); build spec §6 corrections 14 and 16;
// SEAM.md §§34, 45; ../contract/journal.json.
//
// The first session pinned that a `git worktree add` held past `git_deadline`
// is killed, that its operation is marked ambiguous, and that no role is
// launched on the strength of a timer. This file pins what follows:
//
//   - the run whose workspace it was is ended, like one whose workspace could
//     not be made: failed, infra_error, its invocation never launched and not
//     charged. The work is repaired by a new run, in a workspace of its own;
//   - the operation stays ambiguous, with one open blocker, for as long as
//     the probe cannot tell what the killed command left. Nothing of the
//     project is dispatched meanwhile;
//   - once the repository answers, the journal step of the next tick probes
//     the operation. Found absent, it is reconciled and withdrawn: the engine
//     does not add a workspace for a run that is over. Found complete (the
//     killed command had in fact finished: a late completion), the worktree
//     is adopted as the ended run's retained workspace, and still no role is
//     launched in it.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertWorkHistory } from './harness/invariants.mjs';
import { assertCommitted, assertOperation, assertOperations, operationDetail } from './harness/journal.mjs';
import { EDITS, ambiguousWorktreeAdd } from './harness/probes.mjs';
import { addWorktreeByHand, workspaceState } from './harness/repos.mjs';
import { assertRunEnded, countOf, getRow, resolvedPath, run as runRow, runsOf, tick, tickUntil, waitForRunState, workItem } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';

const openBlockers = (op) => op.blockers.filter((d) => d.status === 'open');

// The run whose workspace command was killed is over, and nothing was launched for it.
async function assertRunGivenUp(ctx) {
  const { fx, item, run } = ctx;
  await waitForRunState(fx.home, run.id, 'ended', { timeoutMs: 20_000 });
  assertRunEnded(fx.home, run.id, { outcome: 'failed', reason_class: 'infra_error', launched: false });
  assert.equal(fx.scripted.launches({ run: run.id }).length, 0, 'no role was launched for it');
  assert.equal(workItem(fx.home, item).status, 'eligible', 'its work is to be repaired by a new run');
}

describe('M15 an operation that a git deadline left ambiguous', () => {
  test('stays ambiguous and blocks its project while the repository does not answer; once it does, the next tick reconciles it absent and withdraws it, and the work is repaired by a new run in a workspace of its own', async (t) => {
    const ctx = await ambiguousWorktreeAdd(t);
    const { fx, project, item, run } = ctx;
    await assertRunGivenUp(ctx);

    // While the repository is still held, the probe cannot tell: the operation blocks.
    await tick(fx.engine, project.id);
    const blocked = assertOperation(operationDetail(fx.home, ctx.op.id), 'the operation while the repository is held');
    assert.deepEqual([blocked.state, blocked.status, blocked.finalized], ['ambiguous', 'ambiguous', false]);
    assert.deepEqual(blocked.attempts.map((a) => a.status), ['ambiguous'], 'the attempt whose command was killed is ambiguous: neither failed nor absent');
    assert.equal(openBlockers(blocked).length, 1, 'one open blocker names the operation');
    assert.equal(runsOf(fx.home, item).length, 1, 'nothing of the project is dispatched while its journal has a blocked operation');
    assert.equal(countOf(fx.home, 'workspaces', '"run" = ?', run.id), 0);
    await tick(fx.engine, project.id);
    assert.equal(openBlockers(operationDetail(fx.home, ctx.op.id)).length, 1, 'the question is not asked a second time');

    // The repository answers again. The killed command wrote nothing.
    ctx.letGo();
    const second = await tickUntil(fx.engine, project.id, () => (runsOf(fx.home, item)[1]?.state === 'ended' ? runsOf(fx.home, item)[1] : undefined), { max: 6, what: 'the repair run to have run' });
    const settled = assertOperation(operationDetail(fx.home, ctx.op.id), 'the reconciled operation');
    assert.deepEqual([settled.state, settled.status, settled.finalized], ['failed', 'failed', false], `found absent, the operation is withdrawn (events: ${settled.events.map((e) => e.kind).join(', ')})`);
    assert.deepEqual(settled.attempts.map((a) => a.status), ['reconciled_absent'], 'the ambiguous attempt is reconciled absent, and no second attempt is made for a run that is over');
    assert.equal(settled.attempts[0].reads.at(-1).result, 'absent');
    assert.deepEqual(openBlockers(settled), [], 'the blocker is closed');
    assert.equal(workspaceState(ctx.repo, ctx.workspace), 'absent', "nothing was added at the first run's path");
    assert.equal(fx.scripted.launches({ run: run.id }).length, 0);

    // The repair: a new run, its own workspace operation, launched once, integrated.
    assert.notEqual(second.id, run.id);
    assertCommitted(fx, second.id, { kind: 'engine_commit', parent: project.base, integrated: true, changes: { [EDITS[0].path]: 'A' } });
    assert.equal(fx.scripted.launches({ work_item: item }).length, 1, 'the role was launched once in all, in the repair run');
    assert.deepEqual([workItem(fx.home, item).repair_attempts, runsOf(fx.home, item).length], [1, 2], 'one repair, counted once');
    assert.notEqual(resolvedPath(getRow(fx.home, 'workspaces', second.workspace).path), resolvedPath(ctx.workspace));
    withStore(fx.home, (db) => assertWorkHistory(db, item));
    assertOperations(fx.home, { project: project.id });
  });

  test('a late completion launches nothing: a worktree that turns out complete is adopted as the ended run\'s retained workspace, and the work is still repaired by a new run', async (t) => {
    const ctx = await ambiguousWorktreeAdd(t);
    const { fx, project, item, run } = ctx;
    await assertRunGivenUp(ctx);
    // The command that was killed had in fact done its work: the worktree is there, complete.
    ctx.letGo();
    addWorktreeByHand(ctx.repo, ctx.workspace, project.base);
    assert.equal(workspaceState(ctx.repo, ctx.workspace, project.base), 'complete', 'the fixture is live');

    const second = await tickUntil(fx.engine, project.id, () => (runsOf(fx.home, item)[1]?.state === 'ended' ? runsOf(fx.home, item)[1] : undefined), { max: 6, what: 'the repair run to have run' });
    const settled = assertOperation(operationDetail(fx.home, ctx.op.id), 'the reconciled operation');
    assert.deepEqual([settled.state, settled.status, settled.finalized], ['finalized', 'succeeded', true], `found applied, the operation is finalized (events: ${settled.events.map((e) => e.kind).join(', ')})`);
    assert.deepEqual(settled.attempts.map((a) => a.status), ['reconciled_succeeded'], 'the same attempt, reconciled: the command was not run again');
    const ws = withStore(fx.home, (db) => db.prepare('SELECT * FROM "workspaces" WHERE "run" = ?').all(run.id));
    assert.deepEqual(ws.map((row) => [resolvedPath(row.path), row.disposition]), [[resolvedPath(ctx.workspace), 'retained']], "it is the ended run's workspace, retained");
    assert.equal(fx.scripted.launches({ run: run.id }).length, 0, 'no role was launched in it: the dispatch that depended on the killed command stays suppressed');
    assert.deepEqual([runRow(fx.home, run.id).outcome, runRow(fx.home, run.id).reason_class], ['failed', 'infra_error'], 'and its run stays what it ended as');
    assertCommitted(fx, second.id, { kind: 'engine_commit', parent: project.base, integrated: true, changes: { [EDITS[0].path]: 'A' } });
    assert.equal(fx.scripted.launches({ work_item: item }).length, 1);
    assertOperations(fx.home, { project: project.id });
  });
});
