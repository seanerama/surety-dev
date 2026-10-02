// M31, one case moved forward to slice 2 after the slice-2 review. Plan §3.3
// M31 ("complete valid worktree ... Complete effect is adopted once"); D1
// §§7.3, 7.10; build spec §5 ("Engine home") and §6 correction 14; SEAM.md
// §§16, 19. Slice 2 creates workspaces through the journal's ordinary path,
// and the journal decides whether `git worktree add` took effect by probing
// the repository's worktree list. Git prints the paths in that list with
// their symbolic links resolved. An engine whose home is reached through a
// symbolic link must still recognise the worktree it has just made: the
// operation is recorded as succeeded, the role is launched in it, and no
// worktree stays registered in the repository that no `workspaces` row names.
// The rest of row M31 (the five probe outcomes at recovery) is slice 3.

import assert from 'node:assert/strict';
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { git } from './harness/git.mjs';
import {
  addProject,
  addWork,
  assertRunEnded,
  resolvedPath,
  scriptedEngine,
  tick,
  unownedWorktrees,
  waitForRun,
  waitForWork,
  worktreeOperations,
} from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';

const registeredWorktrees = (repo) =>
  git(repo, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));

describe('M31 a worktree the engine made is recognised however the engine home is reached (review)', () => {
  test('with the engine home behind a symbolic link, a dispatch launches, its worktree_add is recorded as succeeded, and no worktree is left without a workspaces row', async (t) => {
    const fx = await scriptedEngine(t, { homeSymlink: true });
    assert.ok(lstatSync(fx.home).isSymbolicLink(), '$SURETY_HOME is a symbolic link');
    assert.notEqual(realpathSync(fx.home), fx.home, 'to a directory with another path');
    const project = await addProject(fx);
    const item = await addWork(fx.engine, project.id, 'verification');
    fx.scripted.defaultScript(script.complete());

    await tick(fx.engine, project.id);
    const first = await waitForRun(fx.home, item, { state: 'ended' });
    // What the journal recorded, what became of the run, and what the repository holds, read together.
    // The project has no other work, so no dispatch is under way while this is read.
    const observed = {
      worktree_add: worktreeOperations(fx.home, first.id, 'worktree_add').map((op) => `${op.status} (${op.events.join(', ')})`),
      run: `${first.outcome} / ${first.reason_class}`,
      role_launches: fx.scripted.launches({ run: first.id }).length,
      worktrees_no_workspaces_row_names: unownedWorktrees(fx.home, project.id).length,
    };
    assert.deepEqual(
      { ...observed, worktree_add: observed.worktree_add.map((text) => text.split(' ')[0]) },
      { worktree_add: ['succeeded'], run: 'completed / none', role_launches: 1, worktrees_no_workspaces_row_names: 0 },
      `a worktree that git added must be recorded as added. Observed: ${JSON.stringify(observed)}`,
    );

    // The workspace row names the worktree git registered, and the role ran in it.
    const facts = assertRunEnded(fx.home, first.id, { outcome: 'completed', reason_class: 'none', workspace: 'retained', launched: true, recovery: false });
    const workspace = facts.workspaces[0];
    const registered = registeredWorktrees(project.repo.path);
    assert.ok(registered.includes(resolvedPath(workspace.path)), `the workspace ${workspace.path} is a registered worktree of the repository (registered: ${registered.join(', ')})`);
    assert.ok(resolvedPath(workspace.path).startsWith(`${join(realpathSync(fx.home), 'workspaces')}/`), 'and lies under the engine home');
    const [launch] = fx.scripted.launches({ run: first.id });
    assert.equal(resolvedPath(launch.cwd), resolvedPath(workspace.path), 'the role ran in the workspace');
    await waitForWork(fx.home, item, 'complete');

    // The next dispatch of the project is no different, and nothing accumulates.
    const next = await addWork(fx.engine, project.id, 'review');
    await tick(fx.engine, project.id);
    await waitForWork(fx.home, next, 'complete');
    assert.deepEqual(unownedWorktrees(fx.home, project.id), [], 'every worktree registered in the repository is a workspace the store knows');
    assert.equal(registeredWorktrees(project.repo.path).length, 3, 'two dispatches registered two worktrees beside the main work tree, and no more');
  });
});
