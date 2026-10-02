// M23 (slice 3). Plan §3.3 M23 ("two repositories and hostile ambient
// overrides"); D1 §§7.1, 7.2, 17(3), 17(4); D1-07; SEAM.md §31.
//
// Every git command the engine spawns names its repository and work tree
// explicitly and gets a constructed environment. Nothing the engine process
// inherited selects a repository, an index, an object store, a
// configuration, an identity, a credential or a program for it.
//
// The engine is started the way an operator's shell could leave it: with
// GIT_DIR and its relatives pointing at another repository, a global
// configuration and counted configuration that name hooks and a file-system
// monitor, ambient author and committer identities, editor, pager, diff,
// ssh, askpass and proxy programs, GitHub variables, and its working
// directory inside that other repository. Two projects, one created through
// the API and one installed as a fixture, each on a repository of its own
// with content that tells them apart, each run a Builder to its integrated
// commit. What each repository then holds is asserted, and so is the third
// repository, the one the ambient variables point at: nothing went there.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { addGitProject, addItem, roleThat, runToEnd } from './harness/gitruns.mjs';
import { assertCommitted, eventsOfType, outOfBand } from './harness/journal.mjs';
import { HOSTILE_IDENTITIES, checkoutState, fileAt, gitQuiet, hostileEnvironment, listTree, makeProjectRepo, readEvidence, refOid, repoFingerprint } from './harness/repos.mjs';
import { makeTempDir, removeDir } from './harness/engine.mjs';
import { getRow, resolvedPath, scriptedEngine, tick, unownedWorktrees } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';

const objectCount = (repo) => gitQuiet(repo, ['count-objects', '-v']);

describe('M23 two repositories under a hostile ambient environment', () => {
  test('with GIT_*, GH_* and editor variables pointing elsewhere and the engine started inside another repository, each project is committed and integrated in its own repository and nothing reaches the other or the third', async (t) => {
    // The third repository and the hostile programs live outside the fixture's own directory.
    const ambient = makeTempDir('ambient');
    t.after(() => removeDir(ambient));
    const decoy = makeProjectRepo(join(ambient, 'decoy'), { primary: 'integration', files: { 'DECOY.txt': 'the repository the ambient variables point at\n' } });
    const evidence = join(ambient, 'evidence.txt');
    const env = hostileEnvironment({ decoy: decoy.path, dir: join(ambient, 'programs'), evidence });
    const before = { repo: repoFingerprint(decoy.path), checkout: checkoutState(decoy.path), objects: objectCount(decoy.path) };

    const fx = await scriptedEngine(t, { env, cwd: decoy.path });
    const a = await addGitProject(fx, { via: 'api', name: 'project-a', files: { 'A.txt': 'only in repository A\n' } });
    const b = await addGitProject(fx, { via: 'fixture', name: 'project-b', files: { 'B.txt': 'only in repository B\n' } });
    assert.notEqual(resolvedPath(a.repo.path), resolvedPath(b.repo.path));

    const itemA = await addItem(fx, a.id, 'fix');
    const itemB = await addItem(fx, b.id, 'fix');
    fx.scripted.script(itemA, [roleThat([step.write('made-in-a.txt', 'written by the Builder of project A\n')])]);
    fx.scripted.script(itemB, [roleThat([step.write('made-in-b.txt', 'written by the Builder of project B\n')])]);
    const runA = await runToEnd(fx, [a.id, b.id], itemA);
    const runB = await runToEnd(fx, [a.id, b.id], itemB);

    // Each project's commit is in its own repository, made on its own base, and integrated there.
    const inA = assertCommitted(fx, runA.id, { kind: 'engine_commit', parent: a.base, integrated: true, changes: { 'made-in-a.txt': 'A' } });
    const inB = assertCommitted(fx, runB.id, { kind: 'engine_commit', parent: b.base, integrated: true, changes: { 'made-in-b.txt': 'A' } });
    const treeA = Object.keys(listTree(a.repo.path, refOid(a.repo.path, a.repo.ref)));
    const treeB = Object.keys(listTree(b.repo.path, refOid(b.repo.path, b.repo.ref)));
    assert.ok(treeA.includes('A.txt') && treeA.includes('made-in-a.txt') && !treeA.some((p) => /B\.txt|made-in-b|DECOY/.test(p)), `repository A holds A's content and nothing of B's or the decoy's (${treeA.join(', ')})`);
    assert.ok(treeB.includes('B.txt') && treeB.includes('made-in-b.txt') && !treeB.some((p) => /A\.txt|made-in-a|DECOY/.test(p)), `repository B holds B's content and nothing of A's or the decoy's (${treeB.join(', ')})`);
    for (const [repo, other] of [[a.repo.path, inB.sha], [b.repo.path, inA.sha]]) {
      assert.throws(() => gitQuiet(repo, ['cat-file', '-e', `${other}^{commit}`]), `the other project's commit does not exist in ${repo}`);
    }
    assert.equal(fileAt(a.repo.path, inA.sha, 'made-in-a.txt'), 'written by the Builder of project A\n');
    assert.deepEqual(unownedWorktrees(fx.home, a.id), [], "every worktree of repository A is one of A's workspaces");
    assert.deepEqual(unownedWorktrees(fx.home, b.id), [], "every worktree of repository B is one of B's workspaces");
    for (const [run, project] of [[runA, a], [runB, b]]) {
      const ws = getRow(fx.home, 'workspaces', run.workspace);
      assert.ok(gitQuiet(project.repo.path, ['worktree', 'list', '--porcelain']).includes(resolvedPath(ws.path)), `the workspace of ${project.id} is a worktree of its own repository`);
    }

    // The third repository is exactly as it was.
    for (let i = 0; i < 2; i++) await tick(fx.engine, a.id);
    assert.deepEqual({ repo: repoFingerprint(decoy.path), checkout: checkoutState(decoy.path), objects: objectCount(decoy.path) }, before, 'the repository the ambient variables point at has no new ref, worktree, object or file, and its index and configuration are untouched');

    // No program an ambient variable or ambient configuration names was run.
    assert.equal(readEvidence(evidence), null, `engine git ran a program the ambient environment names:\n${readEvidence(evidence)}`);
    assert.ok(!existsSync(join(ambient, 'programs', 'ambient-template')), 'the ambient template directory was not used');

    // No commit carries an ambient identity or an ambient date.
    for (const [repo, sha] of [[a.repo.path, inA.sha], [b.repo.path, inB.sha], [a.repo.path, a.base]]) {
      const identity = gitQuiet(repo, ['log', '-1', '--format=%an|%ae|%cn|%ce|%ad|%cd', '--date=iso-strict', sha]);
      for (const hostile of [...HOSTILE_IDENTITIES, '2001-01-01']) assert.ok(!identity.includes(hostile), `the commit ${sha} carries something ambient (${hostile}): ${identity}`);
    }

    // And the roles were not handed the ambient variables either.
    for (const launch of fx.scripted.launches()) {
      const leaked = launch.env_keys.filter((key) => /^(GIT_|GH_|GITHUB_|SSH_ASKPASS|EDITOR$|VISUAL$|PAGER$)/.test(key));
      assert.deepEqual(leaked, [], `a role's environment carries ambient variables: ${leaked.join(', ')}`);
    }
    assert.deepEqual(outOfBand(fx.home, a.id).concat(outOfBand(fx.home, b.id)), [], 'and nothing is reported out of band');
    assert.equal(eventsOfType(fx.home, 'repo.out_of_band').length, 0);
  });
});
