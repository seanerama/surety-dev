// M23, the rule that engine git runs no code from the repository, extended
// from the workspace's creation (M23-engine-git-runs-no-repository-code,
// slice 2) to every git call slice 3 adds: the snapshot, the commit, the ref
// update and the integrity reads. Plan §3.3 M23; D1 §§7.1, 7.3, 7.5, 7.6;
// E25 item 3; E27 item 4; E29 item 1; SEAM.md §§16, 31.
//
// A role runs as the engine's user and can write to the repository's hooks
// directory and to its configuration; whatever those ask git to execute
// would run in the engine's own process tree, outside every execution
// domain. So nothing they name runs: no hook, no file-system monitor, no
// filter driver, no external diff or textconv program, no signing program,
// no editor. Each case first shows, with ordinary git on the same fixture,
// that git would run the program; then a Builder's run is taken through
// workspace creation, snapshot, commit and integration, ticks run their
// integrity step, and the program has left no evidence.
//
// A repository that needs a filter driver (Git LFS, for one) is not
// supported in M1: its files are checked out and committed unfiltered
// (E29 item 1).

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { installProject } from './harness/engine.mjs';
import { git, plantFsmonitor, plantHook } from './harness/git.mjs';
import { addItem, roleThat, runToEnd } from './harness/gitruns.mjs';
import { assertCommitted } from './harness/journal.mjs';
import { ALL_HOOKS, fileAt, gitQuiet, makeProjectRepo, plantAllHooks, plantConfiguredPrograms, plantFilter, readEvidence, refOid } from './harness/repos.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';

// A Builder's whole course in the project: workspace, snapshot, commit, ref
// update, and two ticks with their integrity step. Returns the commit.
async function builderCourse(fx, project, files) {
  const item = await addItem(fx, project.id, 'fix');
  fx.scripted.script(item, [roleThat(Object.entries(files).map(([path, content]) => step.write(path, content)))]);
  const run = await runToEnd(fx, project.id, item);
  const committed = assertCommitted(fx, run.id, { kind: 'engine_commit', parent: project.base, integrated: true });
  for (let i = 0; i < 2; i++) await tick(fx.engine, project.id);
  return committed;
}

// A repository prepared by `plant` before the project is installed on it.
async function plantedProject(fx, plant) {
  const repo = makeProjectRepo(join(fx.root, 'repo-planted'));
  const planted = plant(repo) ?? {};
  const id = await installProject(fx.engine, { repoPath: repo.path });
  return { id, repo, base: refOid(repo.path, repo.ref), ...planted };
}

const assertNoEvidence = (evidence, what) => {
  const ran = readEvidence(evidence);
  assert.ok(ran === null, `engine git executed ${what}:\n${ran}`);
};

describe('M23 engine git runs no code from the repository: snapshot, commit, ref update, integrity', () => {
  test("none of git's hooks in the repository's hooks directory is run", async (t) => {
    const fx = await scriptedEngine(t);
    const evidence = join(fx.root, 'hook-evidence.txt');
    const project = await plantedProject(fx, (repo) => {
      plantAllHooks(repo.path, evidence);
      // The fixture is live: ordinary git runs the planted hooks on an index write and on a ref update.
      const probe = join(fx.root, 'probe-worktree');
      git(repo.path, ['worktree', 'add', '--quiet', '--detach', probe, 'HEAD']);
      git(repo.path, ['update-ref', 'refs/heads/probe', 'HEAD']);
      const ran = readEvidence(evidence) ?? '';
      for (const hook of ['post-checkout', 'reference-transaction', 'post-index-change']) assert.ok(ran.includes(`hook ${hook} ran`), `ordinary git runs the planted ${hook} hook`);
      git(repo.path, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'remove', '--force', probe]);
      git(repo.path, ['-c', 'core.hooksPath=/dev/null', 'update-ref', '-d', 'refs/heads/probe']);
      rmSync(evidence);
    });
    assert.ok(ALL_HOOKS.includes('reference-transaction') && ALL_HOOKS.includes('post-index-change'));
    await builderCourse(fx, project, { 'src/app.js': 'export {};\n' });
    assertNoEvidence(evidence, "a hook from the repository's hooks directory");
  });

  test("no hook in a directory the repository's configuration names as core.hooksPath is run", async (t) => {
    const fx = await scriptedEngine(t);
    const evidence = join(fx.root, 'hook-evidence.txt');
    const project = await plantedProject(fx, (repo) => {
      for (const hook of ['reference-transaction', 'post-index-change', 'post-checkout']) plantHook(repo.path, hook, evidence, { where: 'hooksPath', dir: join(fx.root, 'planted-hooks') });
      git(repo.path, ['update-ref', 'refs/heads/probe', 'HEAD']);
      assert.ok((readEvidence(evidence) ?? '').includes('reference-transaction ran'), 'ordinary git runs the hook the configured directory holds');
      git(repo.path, ['-c', 'core.hooksPath=/dev/null', 'update-ref', '-d', 'refs/heads/probe']);
      rmSync(evidence);
    });
    await builderCourse(fx, project, { 'src/app.js': 'export {};\n' });
    assertNoEvidence(evidence, 'a hook from the directory the repository names as core.hooksPath');
  });

  test("the program the repository's configuration names as core.fsmonitor is not run", async (t) => {
    const fx = await scriptedEngine(t);
    const evidence = join(fx.root, 'fsmonitor-evidence.txt');
    const project = await plantedProject(fx, (repo) => {
      plantFsmonitor(repo.path, evidence, { dir: join(fx.root, 'planted-fsmonitor') });
      // The fixture is live: ordinary git runs it when it refreshes the index, also with hooks off.
      git(repo.path, ['-c', 'core.hooksPath=/dev/null', 'status', '--porcelain']);
      assert.ok((readEvidence(evidence) ?? '').includes('fsmonitor ran'), 'ordinary git runs the planted core.fsmonitor program when it refreshes an index');
      rmSync(evidence);
    });
    await builderCourse(fx, project, { 'src/app.js': 'export {};\n', 'README.md': '# changed\n' });
    assertNoEvidence(evidence, "the program the repository's configuration names as core.fsmonitor");
  });

  for (const withProcess of [false, true]) {
    test(`a filter driver named in the repository's configuration (${withProcess ? 'a long-running process filter' : 'clean and smudge programs'}) is not run on workspace creation, snapshot or commit, and its files are committed unfiltered`, async (t) => {
      const fx = await scriptedEngine(t);
      const evidence = join(fx.root, 'filter-evidence.txt');
      const project = await plantedProject(fx, (repo) => {
        const filter = plantFilter(repo.path, repo.ref, evidence, { dir: join(fx.root, 'planted-filter') });
        if (withProcess) git(repo.path, ['config', `filter.${filter.name}.process`, filter.process]);
        // The fixture is live: ordinary git runs the driver when it checks the attributed file out.
        // (The planted process filter leaves its evidence and hangs up, which fails that checkout.)
        const probe = join(fx.root, 'probe-worktree');
        try {
          git(repo.path, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--quiet', '--detach', probe, repo.ref]);
        } catch (err) {
          assert.ok(withProcess, `the ordinary checkout failed: ${err.message}`);
        }
        const ran = readEvidence(evidence) ?? '';
        assert.ok(ran.includes(withProcess ? 'filter process ran' : 'filter smudge ran'), `ordinary git runs the planted filter driver on a checkout (evidence: ${ran})`);
        rmSync(probe, { recursive: true, force: true });
        git(repo.path, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'prune']);
        rmSync(evidence);
        return { filter };
      });
      const committed = await builderCourse(fx, project, { 'data/new.dat': 'new data, as the Builder wrote it\n', 'data/seed.dat': 'seed, changed by the Builder\n' });
      assertNoEvidence(evidence, "a filter driver named in the repository's configuration");
      assert.equal(fileAt(project.repo.path, committed.sha, 'data/new.dat'), 'new data, as the Builder wrote it\n', 'the file is committed as the role left it, unfiltered');
      assert.equal(fileAt(project.repo.path, committed.sha, 'data/seed.dat'), 'seed, changed by the Builder\n');
    });
  }

  test("an external diff program, a textconv program, a signing program, an editor and a pager named in the repository's configuration are not run", async (t) => {
    const fx = await scriptedEngine(t);
    const evidence = join(fx.root, 'program-evidence.txt');
    const project = await plantedProject(fx, (repo) => {
      plantConfiguredPrograms(repo.path, evidence, { dir: join(fx.root, 'planted-programs') });
      // The fixture is live: ordinary git runs the external diff program for a diff between two commits.
      const second = gitQuiet(repo.path, ['commit-tree', `${repo.head}^{tree}`, '-p', repo.head, '-m', 'probe']);
      const blob = gitQuiet(repo.path, ['hash-object', '-w', '--stdin'], { input: 'probe\n' });
      const tree = gitQuiet(repo.path, ['mktree'], { input: `100644 blob ${blob}\tREADME.md\n` });
      const third = gitQuiet(repo.path, ['commit-tree', tree, '-p', second, '-m', 'probe, changed']);
      git(repo.path, ['-c', 'core.hooksPath=/dev/null', 'diff', second, third]);
      assert.ok((readEvidence(evidence) ?? '').includes('diff.external ran'), 'ordinary git runs the planted external diff program');
      rmSync(evidence);
    });
    await builderCourse(fx, project, { 'src/app.js': 'export {};\n', 'README.md': '# changed\n' });
    assertNoEvidence(evidence, "a program the repository's configuration names (external diff, textconv, signing, editor or pager)");
  });
});
