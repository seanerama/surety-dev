// M31, a workspace path that is itself a symbolic link is refused (slice 3;
// carried from the second slice-2 review, E27). Plan §3.3 M31 ("foreign or
// conflicting occupancy ... unrelated contents are never removed or
// absorbed"); D1 §§7.3, 7.10; SEAM.md §§16, 35.
//
// The slice-2 fix for an engine home behind a symbolic link compares paths
// with their links resolved. The reviewer showed what that opened: a link
// planted at a new run's workspace path, pointing at another run's retained
// worktree, makes the failed `git worktree add` look as if the worktree
// were there, the role is launched in the other run's worktree, and an
// Abandon would remove it. A run's workspace is at
// $SURETY_HOME/workspaces/<run id>; whatever is already at that path when
// the engine comes to create the workspace is not the engine's, and a
// symbolic link in particular is refused: the operation does not succeed,
// no role is launched there, and what the link points to is left alone.
//
// The other outcomes of the worktree-add probe at recovery are the second
// slice-3 session's.

import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { releaseBarrier } from './harness/engine.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { operationsOf } from './harness/journal.mjs';
import { gitQuiet } from './harness/repos.mjs';
import { addWork, countOf, getRow, requestTick, resolvedPath, runsOf, scriptedEngine, tick, waitForRun, waitForWork } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';

describe('M31 a workspace path that is occupied by a symbolic link', () => {
  test("a link at a new run's workspace path, pointing at another run's retained worktree, is refused: the worktree add does not succeed, no role runs there, and the other worktree is untouched", async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    // An earlier run, whose workspace is retained.
    const earlier = await addWork(fx.engine, project.id, 'verification');
    fx.scripted.script(earlier, [script.complete()]);
    await tick(fx.engine, project.id);
    await waitForWork(fx.home, earlier, 'complete');
    const first = await waitForRun(fx.home, earlier, { state: 'ended' });
    const retained = getRow(fx.home, 'workspaces', first.workspace);
    assert.equal(retained.path, join(fx.home, 'workspaces', first.id), "a run's workspace is at $SURETY_HOME/workspaces/<run id>");
    const untouched = () => ({
      listed: gitQuiet(project.repo.path, ['worktree', 'list', '--porcelain']).includes(resolvedPath(retained.path)),
      head: gitQuiet(retained.path, ['rev-parse', 'HEAD']),
      readme: readFileSync(join(retained.path, 'README.md'), 'utf8'),
      row: getRow(fx.home, 'workspaces', retained.id).disposition,
    });
    const before = untouched();
    assert.equal(before.listed, true);

    // The next run is stopped once it exists and before its workspace is created.
    await fx.engine.stop();
    await fx.start({ barriers: ['dispatch.run_created=pause'] });
    // A Builder's item: its first launch writes a file, which shows where that role ran. (A Verifier may
    // write no ordinary file, SEAM.md §68, so the item is a `fix`.)
    const item = await addWork(fx.engine, project.id, 'fix');
    fx.scripted.script(item, [{ steps: [step.write('written-by-the-second-run.txt', 'x\n'), step.result()] }, script.complete()]);
    await requestTick(fx.engine, project.id);
    await fx.engine.waitUntil('barrier:dispatch.run_created');
    const second = await waitForRun(fx.home, item);
    const path = join(fx.home, 'workspaces', second.id);
    assert.ok(!existsSync(path), 'the workspace of the new run does not exist yet');
    symlinkSync(retained.path, path);
    await releaseBarrier(fx.engine, 'dispatch.run_created');

    await waitForRun(fx.home, item, { state: 'ended' });
    const ended = getRow(fx.home, 'runs', second.id);
    assert.deepEqual([ended.outcome, ended.reason_class], ['failed', 'infra_error'], 'the run whose workspace could not be created fails');
    const adds = operationsOf(fx.home, { run: second.id, journalKind: 'worktree_add' });
    assert.ok(adds.every((op) => op.status !== 'succeeded'), `no worktree_add of the run succeeded (${adds.map((op) => `${op.status}: ${op.events.map((e) => e.kind).join(', ')}`).join(' | ') || 'none journaled'})`);
    assert.equal(fx.scripted.launches({ run: second.id }).length, 0, "no role was launched for it, in the other run's worktree or anywhere");
    assert.ok(!existsSync(join(retained.path, 'written-by-the-second-run.txt')), "nothing was written into the other run's worktree");
    assert.deepEqual(untouched(), before, "the other run's worktree is still registered, on its commit, with its files, and still retained");
    assert.equal(lstatSync(retained.path).isDirectory(), true);
    assert.equal(countOf(fx.home, 'workspaces', '"run" = ?', second.id), 0, "no workspace row claims the other run's worktree for the new run");

    // The work is repaired by a run with a workspace of its own, at its own path; what it wrote is integrated.
    await tick(fx.engine, project.id);
    await waitForWork(fx.home, item, 'integrated');
    const third = runsOf(fx.home, item)[1];
    const own = getRow(fx.home, 'workspaces', third.workspace);
    assert.equal(own.path, join(fx.home, 'workspaces', third.id));
    assert.ok(lstatSync(own.path).isDirectory() && !lstatSync(own.path).isSymbolicLink(), 'a real directory, not a link');
    assert.deepEqual(untouched(), before, "and the other run's worktree is still as it was");
  });
});
