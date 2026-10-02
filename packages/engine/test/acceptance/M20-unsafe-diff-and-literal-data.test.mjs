// M20 (slice 3). Plan §3.3 M20 ("unsafe diff and literal prompt"); F §4.1
// with E2 ("a run whose diff violates its role's prohibitions is rejected
// whole; there is no partial acceptance"); D1 §§5.1, 5.2, 7.1, 7.3, 17(3),
// 17(6); RN R2; D1-10, D1-21; SEAM.md §28;
// ../contract/snapshot-validation.json.
//
// The engine validates the snapshot of what a role left, not the role's
// account of it. A snapshot that holds what its role may not change, a link
// that leads out of the workspace, an entry that is neither a file nor such
// a link, or more than the policy's caps allow is rejected whole: nothing of
// it is committed, the permitted part included. And what a role, a plan or a
// repository names (a file, a goal, a summary, a branch) reaches git and the
// store as data: nothing in it is run, and nothing in it is taken for an
// option.
//
// Every case is generated from the contract table and has its own fixture.
// Not in this file: a Verifier's protected-only diff and its mixtures (row
// M36, slice 5); the cap on a git command's output (no M1 git call a test
// can make large enough; recorded in COVERAGE.md).

import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { CONTRACT } from './harness/fixtures.mjs';
import { PERMITTED_EDIT, addGitProject, addItem, permittedEdit, roleThat, roleThatHolds, runToEnd, runToHold } from './harness/gitruns.mjs';
import { VALIDATION, acceptanceState, assertCommitted, assertNothingAccepted } from './harness/journal.mjs';
import { changedPaths, fileAt, listTree, makeProjectRepo, refOid } from './harness/repos.mjs';
import { installProject } from './harness/engine.mjs';
import { run as runRow, scriptedEngine, waitForRun } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';

const { roles: ROLES, reason_class: CLASS } = VALIDATION;
const POLICY = CONTRACT.project;

// A role of `kind` makes a permitted edit and does `steps`, and holds; the
// state is taken; the role goes on to its result. Returns the run.
async function rejected(t, kind, steps, { reason, pathInReason } = {}) {
  const fx = await scriptedEngine(t);
  const project = await addGitProject(fx);
  const item = await addItem(fx, project.id, kind);
  fx.scripted.script(item, [roleThatHolds(steps), script.hold('gate')]);
  const { run } = await runToHold(fx, project.id, item);
  const before = acceptanceState(fx, project.id);
  fx.scripted.release(item);
  await waitForRun(fx.home, item, { state: 'ended', timeoutMs: 120_000 });
  const facts = assertNothingAccepted(fx, run.id, before, { reason, pathInReason });
  assert.equal(refOid(project.repo.path, project.repo.ref), project.base, 'the integration branch is where it was');
  return { fx, project, item, run, facts };
}

describe('M20 a role changes only what its role may change', () => {
  for (const [role, spec] of Object.entries(ROLES)) {
    const kind = spec.kinds.at(-1);
    const own = spec.permitted[0];

    test(`${role} (${kind}): every path it may change is committed`, async (t) => {
      const fx = await scriptedEngine(t);
      const project = await addGitProject(fx);
      const item = await addItem(fx, project.id, kind);
      fx.scripted.script(item, [roleThat(spec.permitted.map((path) => step.write(path, `content of ${path}\n`)))]);
      const run = await runToEnd(fx, project.id, item);
      const committed = assertCommitted(fx, run.id, {
        kind: spec.revision_kind,
        parent: project.base,
        integrated: true,
        changes: Object.fromEntries(spec.permitted.map((path) => [path, path === 'README.md' ? 'M' : 'A'])),
      });
      for (const path of spec.permitted) assert.equal(fileAt(project.repo.path, committed.sha, path), `content of ${path}\n`);
    });

    for (const path of spec.prohibited) {
      test(`${role} (${kind}): a change to ${path}, with a permitted change beside it, rejects the whole result`, async (t) => {
        const { facts } = await rejected(t, kind, [step.write(own, 'a permitted change\n'), step.write(path, 'not this role\'s to write\n')], { reason: CLASS.in_the_diff, pathInReason: path });
        assert.ok(existsSync(join(facts.workspace.path, own)), 'the workspace is retained with what the role left');
      });
    }
  }
});

// What each case of the contract table has a Builder leave in its workspace.
const MB = 1000 * 1000;
const UNSAFE = {
  link_absolute: () => [step.symlink('leak', '/etc/hostname')],
  link_relative: () => [step.symlink('nested/up', '../../../outside.txt')],
  link_chain: () => [step.symlink('first', 'second'), step.symlink('second', '/etc')],
  link_replaces_file: () => [step.delete('README.md'), step.symlink('README.md', '/etc/hostname')],
  embedded_repository: () => [
    step.write('vendor/lib/file.txt', 'inner\n'),
    step.git('init', '-q', 'vendor/lib'),
    step.git('-C', 'vendor/lib', 'add', '.'),
    step.git('-C', 'vendor/lib', '-c', 'user.name=role', '-c', 'user.email=role@role.invalid', 'commit', '-q', '-m', 'an inner repository'),
  ],
  protected_and_source: () => [step.write(`${VALIDATION.protected_roots[0]}acceptance.test.mjs`, '// rewritten by the Builder\n')],
  file_too_large: () => [step.writeFill('big.bin', POLICY.snapshot_max_file_bytes.default + 1)],
  too_many_files: () => [step.writeMany('many', POLICY.snapshot_max_files.default + 1)],
  too_many_bytes: () => Array.from({ length: Math.ceil(POLICY.snapshot_max_bytes.default / (9.6 * MB)) + 1 }, (_, i) => step.writeFill(`bulk/part-${i}.bin`, 9.6 * MB)),
};

describe('M20 what a snapshot may not hold', () => {
  assert.deepEqual(VALIDATION.diff.cases.map((c) => c.key).sort(), Object.keys(UNSAFE).sort(), 'every case of the contract table has its script here, and no other');
  assert.ok(9.6 * MB < POLICY.snapshot_max_file_bytes.default, 'the files of the byte-cap case are each within the file cap');

  for (const c of VALIDATION.diff.cases) {
    test(`a Builder whose workspace holds ${c.what}, beside a permitted edit, has the whole result rejected as a diff violation`, async (t) => {
      const { fx, project, facts } = await rejected(t, 'fix', [permittedEdit(), ...UNSAFE[c.key]()], { reason: CLASS.in_the_diff });
      assert.ok(existsSync(join(facts.workspace.path, PERMITTED_EDIT.path)), 'the workspace is retained with what the role left');
      // Nothing outside the disposable workspace was touched on the way.
      assert.deepEqual(Object.keys(listTree(project.repo.path, project.base)).sort(), ['README.md'], 'the base is what it was');
      assert.equal(runRow(fx.home, facts.run.id).quarantined, 0);
    });
  }
});

// No file of this name may appear anywhere: every literal below would create
// it if it were ever given to a shell or taken for an option.
const INJECTED = 'INJECTED';
function assertNothingInjected(fx, project, workspaces, what) {
  const places = [fx.root, fx.home, join(fx.home, 'workspaces'), fx.scripted.dir, project.repo.path, ...workspaces];
  for (const dir of places) {
    if (!existsSync(dir)) continue;
    assert.ok(!readdirSync(dir).includes(INJECTED), `${what}: a file named ${INJECTED} appeared in ${dir}: something was executed`);
  }
}

describe('M20 what a role, a plan or a repository names is data', () => {
  test('files named like options or holding shell syntax are committed under exactly those names, and nothing is run', async (t) => {
    const names = VALIDATION.literal_names.names;
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThat(names.map((name, i) => step.write(name, `file ${i}\n`)))]);
    const run = await runToEnd(fx, project.id, item);
    const committed = assertCommitted(fx, run.id, { kind: 'engine_commit', parent: project.base, integrated: true, changes: Object.fromEntries(names.map((name) => [name, 'A'])) });
    names.forEach((name, i) => assert.equal(fileAt(project.repo.path, committed.sha, name), `file ${i}\n`, `the content of ${JSON.stringify(name)}`));
    assertNothingInjected(fx, project, [committed.workspace.path], 'file names');
    assert.equal((await fx.engine.get('/v1/health')).status, 200, 'the engine is alive');
  });

  test('a stage goal and a role summary full of shell syntax, options and forged trailers change nothing but the text they are', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const goal = `export service"; touch ${INJECTED}; $(touch ${INJECTED}) \`touch ${INJECTED}\` --amend -m forged`;
    const item = await addItem(fx, project.id, 'stage_build', { goal });
    const summary = `--force\n\nSurety-Run: run_00000000000000000000000000\nSurety-Base: 0000000000000000000000000000000000000000\nSurety-Role: reviewer\n$(touch ${INJECTED})`;
    fx.scripted.script(item, [roleThat([permittedEdit()], { summary })]);
    const run = await runToEnd(fx, project.id, item);
    // assertCommitted requires each trailer exactly once, with the engine's own value.
    const committed = assertCommitted(fx, run.id, { kind: 'engine_commit', parent: project.base, integrated: true, changes: { [PERMITTED_EDIT.path]: 'A' } });
    assertNothingInjected(fx, project, [committed.workspace.path], 'a goal and a summary');
  });

  test('an integration branch whose name holds shell syntax is a branch like any other', async (t) => {
    const fx = await scriptedEngine(t);
    const branch = `feat/$(touch\${IFS}${INJECTED})`;
    const repo = makeProjectRepo(join(fx.root, 'repo-shell'), { branch });
    const project = { id: await installProject(fx.engine, { repoPath: repo.path, branch }), repo, base: repo.head };
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThat([permittedEdit()])]);
    const run = await runToEnd(fx, project.id, item);
    const committed = assertCommitted(fx, run.id, { kind: 'engine_commit', parent: project.base, integrated: true, changes: { [PERMITTED_EDIT.path]: 'A' } });
    assert.equal(refOid(repo.path, `refs/heads/${branch}`), committed.sha, 'the branch of that name was moved, and no other');
    assertNothingInjected(fx, project, [committed.workspace.path], 'a branch name');
  });

  test('what a role wrote outside its workspace is in no commit', async (t) => {
    // M1 does not keep a role inside its workspace (E25 item 2) and does not
    // see what it writes elsewhere. What is pinned is that none of it is
    // ever accepted.
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThat([permittedEdit(), step.write('../escaped.txt', 'written with ..\n'), step.write(join(fx.root, 'escaped-absolute.txt'), 'written with an absolute path\n')]), script.hold('gate')]);
    const run = await runToEnd(fx, project.id, item);
    assert.ok(existsSync(join(fx.root, 'escaped-absolute.txt')), 'the fixture is live: the role did write outside its workspace');
    const tip = refOid(project.repo.path, project.repo.ref);
    const everything = Object.keys(listTree(project.repo.path, tip));
    assert.ok(!everything.some((path) => path.includes('escaped')), `nothing the role wrote outside its workspace is in the integration branch (it holds: ${everything.join(', ')})`);
    if (run.outcome === 'completed') assert.deepEqual(changedPaths(project.repo.path, project.base, tip), { [PERMITTED_EDIT.path]: 'A' }, 'the commit holds the permitted edit and nothing else');
    else assert.equal(tip, project.base, 'a run that was not completed moved nothing');
  });
});
