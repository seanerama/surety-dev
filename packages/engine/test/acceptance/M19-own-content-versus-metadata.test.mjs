// M19 (slice 3). Plan §3.3 M19 ("own content versus metadata"); D1 §§7.3,
// 7.6, 17(6); build spec §6 correction 15 (Review B05); D1-10, D1-11;
// SEAM.md §§28, 32; ../contract/snapshot-validation.json.
//
// D1 §7.3 step 4 rejected "any managed checkout the role altered", and the
// run's own workspace is a managed checkout: a lawful edit failed. In force
// instead: for the run's own workspace, file content is judged by the
// captured diff and by nothing else, while its HEAD, its index, the git
// metadata and the identity file stay invariant. So
//   - a permitted edit is committed, exactly, and is never a ref violation
//     or an out-of-band observation, during the run or at validation;
//   - an alteration outside the diff rejects the whole result, the permitted
//     edit that came with it included: dirty content in the workspace does
//     not switch the metadata protections off;
//   - a change to the project's identity file rejects the whole result.
// Integrity runs during the execution (ticks while the role is holding with
// its edits on disk) as well as at snapshot validation.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { PERMITTED_EDIT, addGitProject, addItem, permittedEdit, roleThat, roleThatHolds, runToEnd, runToHold } from './harness/gitruns.mjs';
import { VALIDATION, acceptanceState, assertCommitted, assertNothingAccepted, eventsOfType, outOfBand, registryOf } from './harness/journal.mjs';
import { commitOnRef, gitQuiet, listTree, refOid } from './harness/repos.mjs';
import { addWork, getRow, run as runRow, scriptedEngine, tick, waitForRun, waitForWork, workItem } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';

const ROLES = VALIDATION.roles;

describe('M19 a permitted edit is content, judged by the captured diff', () => {
  test('a Builder that adds, changes, deletes and renames files and links one to another has exactly that committed, and is never out of band while it works', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx, { files: { 'old/name.txt': 'rename me\n', 'doomed.txt': 'delete me\n', 'keep.txt': 'leave me\n' } });
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [
      roleThatHolds([
        permittedEdit(),
        step.write('README.md', '# fixture, changed by the Builder\n'),
        step.delete('doomed.txt'),
        step.rename('old/name.txt', 'new/name.txt'),
        step.symlink('link-inside', PERMITTED_EDIT.path),
      ]),
    ]);
    const { run, workspace } = await runToHold(fx, project.id, item);
    assert.ok(existsSync(join(workspace.path, PERMITTED_EDIT.path)), 'the role has written into its workspace');

    // Integrity during execution: the workspace is dirty, and ticks run their integrity step.
    for (let i = 0; i < 2; i++) await tick(fx.engine, project.id);
    assert.deepEqual(outOfBand(fx.home, project.id), [], "an active run's own edits are no out-of-band observation");
    assert.equal(eventsOfType(fx.home, 'repo.out_of_band').length, 0);
    assert.deepEqual([runRow(fx.home, run.id).state, runRow(fx.home, run.id).outcome], ['executing', null], 'and the run goes on');

    fx.scripted.release(item);
    await waitForRun(fx.home, item, { state: 'ended' });
    const committed = assertCommitted(fx, run.id, {
      kind: ROLES.builder.revision_kind,
      parent: project.base,
      integrated: true,
      changes: { [PERMITTED_EDIT.path]: 'A', 'README.md': 'M', 'doomed.txt': 'D', 'old/name.txt': 'D', 'new/name.txt': 'A', 'link-inside': 'A' },
    });
    const tree = listTree(project.repo.path, committed.sha);
    assert.match(tree['link-inside'], /^120000 blob /, 'a link to a path inside the workspace is committed as a link');
    assert.ok('keep.txt' in tree && !('doomed.txt' in tree), 'what the role left alone is still there, what it deleted is gone');

    // Nor afterwards: the integration was the engine's own move.
    for (let i = 0; i < 2; i++) await tick(fx.engine, project.id);
    assert.deepEqual(outOfBand(fx.home, project.id), [], 'a permitted edit, committed and integrated, is never out of band');
  });

  test('an Architect that writes its own artifacts has them committed as an intent revision', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'replan');
    fx.scripted.script(item, [roleThat(ROLES.architect.permitted.map((path) => step.write(path, `# ${path}\n`)))]);
    const run = await runToEnd(fx, project.id, item);
    assertCommitted(fx, run.id, {
      kind: ROLES.architect.revision_kind,
      parent: project.base,
      integrated: true,
      changes: Object.fromEntries(ROLES.architect.permitted.map((path) => [path, 'A'])),
    });
  });
});

// What each case of the contract table has the role do, besides its
// permitted edit, and how the test sees that the role really did it.
const ALTERATIONS = {
  head_moved: {
    steps: () => [step.git('-c', 'user.name=role', '-c', 'user.email=role@role.invalid', 'commit', '-q', '--allow-empty', '-m', 'a commit made by the role')],
    done: ({ workspace, project }) => assert.notEqual(gitQuiet(workspace.path, ['rev-parse', 'HEAD']), project.base, "the workspace's HEAD has moved"),
  },
  head_on_branch: {
    steps: () => [step.git('checkout', '-q', '-b', 'role/branch')],
    done: ({ workspace }) => assert.equal(gitQuiet(workspace.path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'role/branch', "the workspace's HEAD is on a branch"),
  },
  index_staged: {
    steps: () => [step.git('add', PERMITTED_EDIT.path)],
    done: ({ workspace }) => assert.match(gitQuiet(workspace.path, ['diff-index', '--cached', '--name-status', 'HEAD']), /^A\s+src\/app\.js$/m, "the file is staged in the workspace's real index"),
  },
  repository_config: {
    steps: () => [step.git('config', 'surety.injected', 'by-the-role')],
    done: ({ project }) => assert.equal(gitQuiet(project.repo.path, ['config', 'surety.injected']), 'by-the-role', "the repository's configuration has changed"),
  },
  hook_planted: {
    steps: ({ project }) => [step.write(join(project.repo.path, '.git', 'hooks', 'post-commit'), '#!/bin/sh\nexit 0\n')],
    done: ({ project }) => assert.ok(existsSync(join(project.repo.path, '.git', 'hooks', 'post-commit')), "the hook is in the repository's hooks directory"),
  },
  gitlink_rewritten: {
    steps: () => [step.write('.git', 'gitdir: /nonexistent/somewhere/else\n')],
    done: ({ workspace }) => assert.equal(readFileSync(join(workspace.path, '.git'), 'utf8'), 'gitdir: /nonexistent/somewhere/else\n', "the workspace's .git file was rewritten"),
  },
  registered_ref_moved: {
    steps: ({ elsewhere }) => [step.git('update-ref', 'refs/heads/main', elsewhere)],
    done: ({ project, elsewhere }) => assert.equal(refOid(project.repo.path, 'refs/heads/main'), elsewhere, 'the integration branch was moved'),
    ref: 'moved',
  },
  registered_ref_deleted: {
    steps: () => [step.git('update-ref', '-d', 'refs/heads/main')],
    done: ({ project }) => assert.equal(refOid(project.repo.path, 'refs/heads/main'), null, 'the integration branch is gone'),
    ref: 'deleted',
  },
  other_workspace: {
    steps: ({ other }) => [step.write(join(other.path, 'README.md'), '# changed by another run\n')],
    done: ({ other }) => assert.equal(readFileSync(join(other.path, 'README.md'), 'utf8'), '# changed by another run\n', "the other run's workspace was edited"),
  },
};

describe('M19 what lies outside the diff must be as the engine left it', () => {
  assert.deepEqual(VALIDATION.metadata.cases.map((c) => c.key).sort(), Object.keys(ALTERATIONS).sort(), 'every case of the contract table has its script here, and no other');

  for (const c of VALIDATION.metadata.cases) {
    test(`a Builder that makes a permitted edit and ${c.what} has the whole result rejected as a ref violation`, async (t) => {
      const fx = await scriptedEngine(t);
      const project = await addGitProject(fx);
      const alteration = ALTERATIONS[c.key];
      // A commit the role can move the integration branch to, on a developer branch the engine does not track.
      const elsewhere = commitOnRef(project.repo.path, 'refs/heads/dev/elsewhere', { 'elsewhere.txt': 'elsewhere\n' }, { parent: project.base });
      // Another run's retained workspace: a verification run that completed.
      let other = null;
      if (c.key === 'other_workspace') {
        const earlier = await addWork(fx.engine, project.id, 'verification');
        fx.scripted.script(earlier, [script.complete()]);
        await tick(fx.engine, project.id);
        await waitForWork(fx.home, earlier, 'complete');
        other = getRow(fx.home, 'workspaces', (await waitForRun(fx.home, earlier, { state: 'ended' })).workspace);
        assert.equal(other.disposition, 'retained');
      }
      const item = await addItem(fx, project.id, 'fix');
      const ctx = { project, elsewhere, other };
      fx.scripted.script(item, [roleThatHolds([permittedEdit(), ...alteration.steps(ctx)]), script.hold('gate')]);

      const { run, workspace } = await runToHold(fx, project.id, item);
      // The fixture is live: the role did what the case is about.
      alteration.done({ ...ctx, workspace });
      assert.ok(existsSync(join(workspace.path, PERMITTED_EDIT.path)), 'and it made its permitted edit');
      const before = acceptanceState(fx, project.id);

      fx.scripted.release(item);
      await waitForRun(fx.home, item, { state: 'ended' });
      assertNothingAccepted(fx, run.id, before, { reason: VALIDATION.reason_class.outside_the_diff });
      assert.ok(existsSync(join(workspace.path, PERMITTED_EDIT.path)), 'the workspace is retained with what the role left');
      const work = workItem(fx.home, item);
      assert.notEqual(work.status, 'integrated', 'the work is not integrated');
      assert.notEqual(work.status, 'complete');

      // What the role altered is neither undone nor absorbed.
      alteration.done({ ...ctx, workspace });
      if (alteration.ref) {
        await tick(fx.engine, project.id);
        const observed = outOfBand(fx.home, project.id).filter((o) => o.subject_kind === 'ref' && o.ref_name === 'refs/heads/main');
        assert.equal(observed.length, 1, 'the integration branch the role altered is an out-of-band change of its own');
        assert.deepEqual([observed[0].expected, observed[0].found], [project.base, alteration.ref === 'moved' ? elsewhere : null]);
        assert.equal(registryOf(fx.home, project.id)['refs/heads/main'].expected_oid, project.base, 'the registry still expects what it expected');
      }
    });
  }
});

describe('M19 the project identity file is not a role\'s to change', () => {
  const IDENTITY = VALIDATION.identity_file;

  test('a Builder that changes the identity file of a project created through the API has the whole result rejected', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx, { via: 'api' });
    assert.ok(IDENTITY in listTree(project.repo.path, project.base), 'bootstrap committed the identity file');
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThatHolds([permittedEdit(), step.write(IDENTITY, '{"id": "proj_00000000000000000000000000"}\n')]), script.hold('gate')]);
    const { run } = await runToHold(fx, project.id, item);
    const before = acceptanceState(fx, project.id);
    fx.scripted.release(item);
    await waitForRun(fx.home, item, { state: 'ended' });
    assertNothingAccepted(fx, run.id, before, { reason: VALIDATION.reason_class.in_the_diff, pathInReason: IDENTITY });
  });

  test('a Builder that creates the identity file in a project that has none has the whole result rejected', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    assert.ok(!(IDENTITY in listTree(project.repo.path, project.base)), 'a project installed as a fixture has no identity file');
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThatHolds([permittedEdit(), step.write(IDENTITY, '{"id": "proj_00000000000000000000000000"}\n')]), script.hold('gate')]);
    const { run } = await runToHold(fx, project.id, item);
    const before = acceptanceState(fx, project.id);
    fx.scripted.release(item);
    await waitForRun(fx.home, item, { state: 'ended' });
    assertNothingAccepted(fx, run.id, before, { reason: VALIDATION.reason_class.in_the_diff, pathInReason: IDENTITY });
  });
});
