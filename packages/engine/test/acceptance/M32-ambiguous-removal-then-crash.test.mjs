// M32 and M33, a workspace removal left ambiguous (slice 3, second session).
// The slice-2 review confirmed, on the slice-2 engine: after a
// `worktree_remove` settles ambiguous and the engine crashes before the run
// has finished, a second removal intent for the same run collides on the
// operation's unique key, and recovery fails on every restart. Plan §3.3 M32
// ("Removal is not reported complete while owned residue remains; completed
// removal is not repeated destructively"), M33, M34 ("retry follows positive
// reconciliation and keeps logical identity"); build spec §6 corrections 14
// and 16; D1 §§2.5, 4.5, 7.10, 16; SEAM.md §§34, 45; COVERAGE.md,
// "Obligations recorded after the slice-2 review".
//
// The removal of an abandoned run's workspace is held open past
// `git_deadline`: the engine kills the command and the operation is
// ambiguous. The run cannot end, because an abandoned run ends with its
// workspace discarded and nothing says it is. What must happen next is the
// journal's ordinary recovery: the same operation is probed, found absent
// (the worktree is still there), reconciled, and retried as a new attempt.
// No second operation is recorded for the same removal. That holds when the
// engine is still running and its next tick finds the repository readable,
// and when the engine crashed in between: recovery completes and the engine
// reaches full mode.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { assertWorkHistory } from './harness/invariants.mjs';
import { addGitProject, addItem, permittedEdit, roleThat } from './harness/gitruns.mjs';
import { assertCommitted, assertOperation, assertOperations, operationDetails, receiptSnapshot } from './harness/journal.mjs';
import { holdGit, workspaceState } from './harness/repos.mjs';
import { abandonRun, assertRunEnded, getRow, resumeWork, run as runRow, runsOf, scriptedEngine, tick, tickUntil, waitForRun, waitForRunState, workItem } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const GIT_DEADLINE = 2;
const removals = (fx, run) => operationDetails(fx.home, { run: run.id, journalKind: 'worktree_remove' });

// An abandoned run whose workspace removal was killed at its deadline:
// {fx, project, item, run, workspace, letGo}.
async function ambiguousRemoval(t) {
  const fx = await scriptedEngine(t, { config: { git_deadline: GIT_DEADLINE } });
  const project = await addGitProject(fx);
  const item = await addItem(fx, project.id, 'fix');
  fx.scripted.script(item, [script.hold('gate', { before: [permittedEdit(), step.usage({ input_tokens: 4 })] }), roleThat([step.write('src/second.js', 'export const second = 2;\n')])]);
  await tick(fx.engine, project.id);
  await fx.scripted.waitForHolding({ work_item: item });
  const run = await waitForRun(fx.home, item, { state: 'executing' });
  const workspace = getRow(fx.home, 'workspaces', run.workspace);
  // From here every git command on the repository waits.
  const letGo = holdGit(project.repo.path);
  fx.beforeCleanup.push(letGo);
  await abandonRun(fx.engine, project.id, run.id);
  await waitFor(() => removals(fx, run)[0]?.events.some((e) => e.kind === 'ambiguous'), { timeoutMs: (GIT_DEADLINE + 20) * 1000, what: 'the held removal to be killed at its deadline and marked ambiguous' });
  const [op] = removals(fx, run);
  assert.deepEqual([op.status, op.finalized, op.attempts.map((a) => a.status)], ['ambiguous', false, ['ambiguous']], 'the fixture is live: an ambiguous removal');
  const left = runRow(fx.home, run.id);
  assert.deepEqual([left.state, left.outcome], ['finalizing', 'abandoned'], 'the run has not ended: its workspace is not discarded');
  assert.ok(existsSync(workspace.path), 'the workspace is still there');
  assert.notEqual(getRow(fx.home, 'workspaces', workspace.id).disposition, 'discarded', 'and is not recorded discarded');
  return { fx, project, item, run, workspace, letGo, op };
}

// The removal went through by a retry of the same operation, once.
function assertRemoved(ctx, { recovery }) {
  const { fx, project, item, run, workspace } = ctx;
  const ops = removals(fx, run);
  assert.equal(ops.length, 1, 'one removal operation for the run: no second intent was recorded');
  const op = assertOperation(ops[0], 'the removal');
  assert.deepEqual([op.id, op.state, op.status, op.finalized], [ctx.op.id, 'finalized', 'succeeded', true], `the same operation, finalized (events: ${op.events.map((e) => e.kind).join(', ')})`);
  assert.deepEqual(op.attempts.map((a) => [a.attempt_number, a.status]), [[1, 'reconciled_absent'], [2, 'succeeded']], 'the ambiguous attempt was reconciled absent, and the retry is attempt 2');
  assert.equal(workspaceState(project.repo.path, workspace.path), 'absent', 'the workspace is gone, directory and metadata');
  assertRunEnded(fx.home, run.id, { outcome: 'abandoned', reason_class: 'human_abandon', workspace: 'discarded', launched: true, ...(recovery ? {} : { recovery: false }) });
  const work = workItem(fx.home, item);
  assert.deepEqual([work.status, work.dispatch_hold], ['eligible', 1], 'the work is back at its prior status under a dispatch hold');
  withStore(fx.home, (db) => assertWorkHistory(db, item));
  assertOperations(fx.home, { project: project.id });
}

async function assertResumes(ctx) {
  const { fx, project, item } = ctx;
  await resumeWork(fx.engine, project.id, item);
  const second = await tickUntil(fx.engine, project.id, () => (runsOf(fx.home, item)[1]?.state === 'ended' ? runsOf(fx.home, item)[1] : undefined), { max: 6, what: 'the resumed work to have run' });
  assertCommitted(fx, second.id, { kind: 'engine_commit', parent: project.base, integrated: true, changes: { 'src/second.js': 'A' } });
}

describe('M32 a workspace removal that a git deadline left ambiguous', () => {
  test('followed by a crash before the run had ended: recovery completes, the engine reaches full mode, the same operation is retried and the workspace discarded once, and the run ends abandoned', async (t) => {
    const ctx = await ambiguousRemoval(t);
    const { fx, project } = ctx;
    await fx.engine.kill();
    ctx.letGo();

    // fx.start waits for full mode: an engine whose recovery fails stays restricted, and this fails.
    const engine = await fx.start();
    assert.equal((await engine.engineInfo()).mode, 'full');
    assertRemoved(ctx, { recovery: true });

    // A second restart finds nothing to do, and still reaches full mode.
    const receipts = receiptSnapshot(fx.home, project.id);
    await engine.kill();
    const again = await fx.start();
    assert.equal((await again.engineInfo()).mode, 'full');
    assert.deepEqual(receiptSnapshot(fx.home, project.id), receipts, 'nothing is written again');
    await assertResumes(ctx);
  });

  test('with the engine still running: while the repository does not answer the removal stays blocked and the run is not ended; once it answers, the next tick retries the same operation and the run ends abandoned', async (t) => {
    const ctx = await ambiguousRemoval(t);
    const { fx, project, run, workspace } = ctx;
    await tick(fx.engine, project.id);
    const blocked = removals(fx, run)[0];
    assert.deepEqual([blocked.status, blocked.attempts.map((a) => a.status), runRow(fx.home, run.id).state], ['ambiguous', ['ambiguous'], 'finalizing'], 'no attempt is issued on top of an ambiguous one, and the run waits');
    assert.equal(blocked.blockers.filter((d) => d.status === 'open').length, 1, 'one open blocker names the operation');
    assert.ok(existsSync(workspace.path));

    ctx.letGo();
    await tick(fx.engine, project.id);
    await waitForRunState(fx.home, run.id, 'ended', { timeoutMs: 20_000 });
    assertRemoved(ctx, { recovery: false });
    assert.deepEqual(removals(fx, run)[0].blockers.filter((d) => d.status === 'open'), [], 'the blocker is closed');
    await assertResumes(ctx);
  });
});
