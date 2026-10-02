// M23, one case moved forward to slice 2 after the slice-2 review (E25 item
// 3). Plan §3.3 M23 ("Every read/write stays within its resolved target");
// D1 §§7.1, 7.3, 17; SEAM.md §16 "Engine git". The engine performs git on a
// repository that a role, running as the same user, can write to: its hooks
// directory and its configuration included. Whatever such a repository asks
// git to execute would run inside the engine's own process tree, outside
// every execution domain, with the engine's environment. So engine git runs
// no code from the repository: hooks, in the repository's hooks directory or
// in one its configuration names, are disabled on every engine git call.
// Slice 2's only git effect is the workspace (`git worktree add`), which is
// a checkout, and git runs `post-checkout` and `reference-transaction` for
// it. Slice 3 extends this file to commits, ref updates and the other
// repository-configured ways of running a program.
// Two-repository isolation and hostile ambient variables, the rest of row
// M23, are slice 3.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { git, plantHook } from './harness/git.mjs';
import { addProject, addWork, assertRunEnded, scriptedEngine, tick, waitForRun, waitForWork } from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';

const PLACES = {
  hooks: "in the repository's hooks directory",
  hooksPath: "in a directory the repository's configuration names as core.hooksPath",
};

describe('M23 engine git runs no code from the repository (review)', () => {
  for (const [where, described] of Object.entries(PLACES)) {
    test(`a post-checkout hook ${described} is not run when the engine creates a workspace`, async (t) => {
      const fx = await scriptedEngine(t);
      const project = await addProject(fx);
      const repo = project.repo.path;
      // The hooks leave their evidence outside the repository and outside the engine home.
      const evidence = join(fx.root, 'hook-evidence.txt');
      for (const hook of ['post-checkout', 'reference-transaction']) plantHook(repo, hook, evidence, { where, dir: join(fx.root, 'planted-hooks') });

      // The fixture is live: run the ordinary way, git executes the planted hook on a checkout.
      const probe = join(fx.root, 'probe-worktree');
      git(repo, ['worktree', 'add', '--quiet', '--detach', probe, 'HEAD']);
      assert.ok(existsSync(evidence) && readFileSync(evidence, 'utf8').includes('post-checkout ran'), 'the planted post-checkout hook runs when git adds a worktree the ordinary way');
      git(repo, ['worktree', 'remove', '--force', probe]);
      rmSync(evidence);

      // The engine creates a workspace in that repository and runs a role in it.
      const item = await addWork(fx.engine, project.id, 'verification');
      fx.scripted.defaultScript(script.complete());
      await tick(fx.engine, project.id);
      const run = await waitForRun(fx.home, item, { state: 'ended' });
      const ran = existsSync(evidence) ? readFileSync(evidence, 'utf8').trim() : null;
      assert.ok(ran === null, `engine git executed code from the repository (${described}):\n${ran}`);

      // And the workspace was in fact checked out: the call the hook hangs on was made.
      const facts = assertRunEnded(fx.home, run.id, { outcome: 'completed', workspace: 'retained', launched: true, recovery: false });
      assert.ok(existsSync(join(facts.workspaces[0].path, 'README.md')), 'the workspace holds the checked-out tree');
      await waitForWork(fx.home, item, 'complete');
      assert.equal(existsSync(evidence), false, 'nothing ran later either');
    });
  }
});
