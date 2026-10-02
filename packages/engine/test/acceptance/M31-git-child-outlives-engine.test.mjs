// M31 and M33, a git child that outlives its engine (slice 3, second
// session). The slice-2 review found: an engine killed during `git worktree
// add` leaves the git child running; recovery can then probe `absent` while
// the child is still writing, and the worktree appears afterwards as one no
// row names. Plan §3.3 M31, M33 ("no duplicate external effect"); build spec
// §6 correction 14; D1 §§7.1, 7.10, 16.1; SEAM.md §46; COVERAGE.md,
// "Obligations recorded after the slice-2 review".
//
// A probe says what git holds now. It says nothing about what a process that
// is still alive is about to write. So before recovery trusts a probe, it has
// to account for the git children of the engine that died: either none of
// them is alive any more when the probe is acted on, or the operation is not
// reconciled on that probe (it blocks, as for `unknown`).
//
// The case makes the window as wide as it can be. The engine's `git worktree
// add` is held before it has written anything (the repository's
// configuration is a pipe) and then stopped (SIGSTOP), so that it stays alive
// and silent for as long as the test wants. The engine is killed, the
// repository is put back in order, and the engine is restarted. The child is
// then continued: if it is still there, it now creates the worktree, at a
// path the store may already have judged.
//
// The second case is the other side of the same rule (E41 item 1; the
// slice-5 review's finding): what an engine may end are the processes of its
// own home, and no others. The engine the review ran sent SIGKILL, whenever
// it reconciled a journal operation, to every process on the machine that
// carried what another engine gives its git children, whatever home or
// repository that engine had. So two engines on one machine killed each
// other's git reads and writes. The case plants a process that sleeps, with
// exactly the environment a git child of another engine home carries, and
// requires it alive after this engine has reconciled.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { releaseBarrier, waitFor } from './harness/engine.mjs';
import { addGitProject, addItem, permittedEdit, roleThat, runToEnd } from './harness/gitruns.mjs';
import { assertCommitted, assertOperation, assertOperations, changePolicy, operationDetails } from './harness/journal.mjs';
import { procStartTime } from './harness/proc.mjs';
import { gitProcessesNaming, holdGit, workspaceState, worktreeList } from './harness/repos.mjs';
import { assertRunEnded, countOf, requestTick, resolvedPath, resumeWork, runsOf, scriptedEngine, tick, tickUntil, unownedWorktrees, waitForRun, workItem } from './harness/runs.mjs';
import { processIsLive } from './harness/scripted.mjs';

describe('M31 a git child that outlived its engine', () => {
  test('an engine killed during `git worktree add` leaves the child alive: recovery does not act on a probe while that child lives, and no worktree appears afterwards that no row names', async (t) => {
    const fx = await scriptedEngine(t, { config: { git_deadline: 6 }, barriers: ['dispatch.receipt_committed=pause'] });
    const project = await addGitProject(fx);
    const repo = project.repo.path;
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThat([permittedEdit()])]);
    await requestTick(fx.engine, project.id);
    await fx.engine.waitUntil('barrier:dispatch.receipt_committed');
    const run = await waitForRun(fx.home, item, { state: 'claimed' });
    const workspace = join(fx.home, 'workspaces', run.id);

    // The engine's `git worktree add` is held before it has written anything, and stopped there.
    const letGo = holdGit(repo);
    fx.beforeCleanup.push(letGo);
    await releaseBarrier(fx.engine, 'dispatch.receipt_committed');
    const child = await waitFor(() => gitProcessesNaming(workspace).find((p) => p.argv.includes('worktree') && p.argv.includes('add')), { timeoutMs: 15_000, what: 'the engine to spawn its git worktree add' });
    const started = procStartTime(child.pid);
    process.kill(child.pid, 'SIGSTOP');
    t.after(() => {
      if (processIsLive(child.pid, started)) process.kill(child.pid, 'SIGKILL');
    });
    await fx.engine.kill();
    // The repository answers again. The stopped child has read nothing yet: continued, it would go on and add the worktree.
    letGo();
    assert.ok(processIsLive(child.pid, started), 'the fixture is live: the git child outlived its engine');
    assert.equal(workspaceState(repo, workspace), 'absent', 'and has written nothing so far');
    const [left] = operationDetails(fx.home, { run: run.id, journalKind: 'worktree_add' });
    assert.deepEqual(left.events.map((e) => e.kind), ['intended'], 'the journal holds the intent, and no receipt');

    await fx.start();
    const alive = processIsLive(child.pid, started);
    const judged = assertOperation(operationDetails(fx.home, { run: run.id, journalKind: 'worktree_add' })[0], 'the operation after recovery');
    if (alive) {
      // The child was left alive: then nothing may have been concluded from a probe.
      assert.deepEqual(
        [judged.status, judged.finalized, judged.blockers.filter((d) => d.status === 'open').length],
        ['ambiguous', false, 1],
        `recovery reached full mode with the dead engine's git child still alive, and reconciled the operation all the same (it is ${judged.status}; events: ${judged.events.map((e) => e.kind).join(', ')}): a probe was trusted while a writer lived`,
      );
      assert.equal(countOf(fx.home, 'workspaces', '"run" = ?', run.id), 0);
    }

    // Whatever is left of the child runs on now, and ends.
    try {
      process.kill(child.pid, 'SIGCONT');
    } catch {
      // gone
    }
    await waitFor(() => !processIsLive(child.pid, started), { timeoutMs: 15_000, what: 'the git child to be gone' });
    for (let i = 0; i < 2; i++) await tick(fx.engine, project.id);

    // The store and the repository agree about the path, and no worktree is nobody's.
    const op = assertOperation(operationDetails(fx.home, { run: run.id, journalKind: 'worktree_add' })[0], 'the operation in the end');
    const state = workspaceState(repo, workspace, project.base);
    const rows = countOf(fx.home, 'workspaces', '"run" = ?', run.id);
    assert.deepEqual(unownedWorktrees(fx.home, project.id), [], 'no worktree is registered in the repository that no workspaces row names');
    assert.ok(worktreeList(repo).filter((w) => resolvedPath(w.path) === resolvedPath(workspace)).length <= 1);
    if (op.state === 'finalized') assert.deepEqual([state, rows], ['complete', 1], 'a finalized operation has its complete worktree and its one workspace row');
    else assert.deepEqual([op.state, state, rows], ['failed', 'absent', 0], 'an operation that was withdrawn left nothing at the path and no workspace row');
    assertRunEnded(fx.home, run.id, { outcome: 'recovered', reason_class: 'recovered' });
    assert.equal(fx.scripted.launches({ work_item: item }).length, 0, 'no role was launched by any of it');
    assert.equal(workItem(fx.home, item).status, 'held');

    // The work goes on by an explicit Resume, in a workspace of its own.
    await resumeWork(fx.engine, project.id, item);
    const second = await tickUntil(fx.engine, project.id, () => (runsOf(fx.home, item)[1]?.state === 'ended' ? runsOf(fx.home, item)[1] : undefined), { max: 6, what: 'the resumed work to have run' });
    assertCommitted(fx, second.id, { kind: 'engine_commit', parent: project.base, integrated: true });
    assert.deepEqual(unownedWorktrees(fx.home, project.id), []);
    assertOperations(fx.home, { project: project.id });
  });
});

// The environment of a live process, as /proc gives it: {NAME: value}.
function environOf(pid) {
  const pairs = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter((pair) => pair.includes('='));
  return Object.fromEntries(pairs.map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
}

describe('M31 a process of another engine home', () => {
  test("an engine never signals a process that another engine home started: a process carrying what that home's engine gives its git children is alive after this engine's policy change, a run it commits and integrates, and its restart", async (t) => {
    // Another engine, with a home and a repository of its own. One of its git
    // reads is held at the repository's configuration, and what that child
    // carries is read from it.
    const other = await scriptedEngine(t, { config: { git_deadline: 30 } });
    const theirs = await addGitProject(other);
    const letGo = holdGit(theirs.repo.path);
    other.beforeCleanup.push(letGo);
    await requestTick(other.engine, theirs.id);
    const carried = await waitFor(
      () => {
        const [child] = gitProcessesNaming(theirs.repo.path);
        const environment = child ? environOf(child.pid) : {};
        return Object.keys(environment).length > 0 ? environment : undefined;
      },
      { timeoutMs: 15_000, what: 'a git child of the other engine, held at its repository' },
    );
    letGo();

    // A process with exactly that environment. Neither engine started it, and it does nothing but sleep.
    const sleeper = spawn('sleep', ['600'], { env: carried, stdio: 'ignore' });
    let ended = null;
    sleeper.once('exit', (code, signal) => {
      ended = { code, signal };
    });
    sleeper.once('error', (err) => {
      ended = { error: err.message };
    });
    t.after(() => sleeper.kill('SIGKILL'));
    assert.ok(Number.isInteger(sleeper.pid), 'the fixture is live: the process was started');
    const started = procStartTime(sleeper.pid);
    const assertAlive = async (after) => {
      const alive = processIsLive(sleeper.pid, started);
      if (!alive) await waitFor(() => ended !== null, { timeoutMs: 2000, what: 'the exit of the planted process to be reported' }).catch(() => {});
      assert.ok(alive, `after ${after}, the process that carries another engine home's environment is gone (${JSON.stringify(ended)}): an engine may end only processes of its own home`);
    };

    // This engine, in a home of its own. An ordinary policy change: its commit and its ref update go through the journal.
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    await changePolicy(fx.engine, project.id, { budget_run_billable_tokens: 500_000 });
    await tick(fx.engine, project.id);
    await assertAlive('an ordinary policy change and a tick');

    // A Builder's run: a workspace is added, a commit made, the branch moved.
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThat([permittedEdit()])]);
    const run = await runToEnd(fx, project.id, item);
    assert.deepEqual([run.outcome, run.reason_class], ['completed', 'none'], `the fixture is live: the run was committed and integrated (${run.reason_text})`);
    await assertAlive('a run that was committed and integrated');

    // A restart: recovery, and a tick of the next incarnation of this home.
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, project.id);
    await assertAlive('a restart of this engine');
  });
});
