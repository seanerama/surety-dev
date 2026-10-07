// M28, "a rebased tree that fails validation where the run's own snapshot
// passed (the protected set)" (M2 slice 1, entry A2). Plan §3.3 M28
// ("Successful path validates the rebased tree, parent and protected set");
// D1 §7.3 (validation), §7.5 ("re-runs §7.3 validation on the rebased
// tree"), §7.9; RN R2; SEAM.md §§28, 43, 66, 69, and §100 for this case.
//
// Slice 3 pinned the clean rebase, the conflict and the failed swap
// (M28-integration-race-and-compare-and-swap); whether validation is run
// again on the rebased tree was pinned by the clean result only. This case
// makes the second validation decisive: while a Builder works on a path
// nobody protects, the owner's tightening that adds that path's directory
// to the protected roots is approved and applied, so the integration branch
// has moved and the protected set in force at integration covers the
// Builder's edit. The result must be rejected as a protected change a
// Builder may not make, and nothing of it may reach the integration
// branch: a file that became protected while the Builder ran is not
// changed without the approval protected files require.
//
// How the change is landed mid-run: a governed edit of `protected_paths`
// through the policy route becomes a human proposal (SEAM.md §66), the
// fixture classifies it, the human approves it, and the application is a
// journaled commit on the integration branch that needs no run, so it can
// land while the one run of the project is held in its workspace (as row
// M43's sign-off case lands a tightening under a held Reviewer).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { GOVERNED_FILE, PROTECTED_FILES, effectiveVersion, governedEdit, humanApplies, protectedFingerprint, proposalsOf } from './harness/gates.mjs';
import { addGitProject, addItem, roleThatHolds, runToHold } from './harness/gitruns.mjs';
import { changePolicy, operationsOf, registryOf, revisionsOf } from './harness/journal.mjs';
import { changedPaths, fileAt, isAncestor, parentsOf, refOid } from './harness/repos.mjs';
import { run as runRow, scriptedEngine, waitForRun, workItem } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';

const RULES = 'docs/policy/rules.md';
const ORIGINAL = '# Rules\n\nEvery export is reviewed.\n';
const LOOSENED = '# Rules\n\nExports need no review.\n';
const ROOTS_AFTER = ['.surety/checks/', 'docs/policy/'];

describe('M28 a replayed result is validated against the protected set in force at integration', () => {
  test("a Builder's edit of a path that became protected after the run's base, by a tightening applied while the Builder worked, is rejected as a protected change at integration: the run fails diff_violation naming the path, and nothing of it is on the integration branch", async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx, { tier: 'T1', files: { ...PROTECTED_FILES, [RULES]: ORIGINAL } });
    const repo = project.repo.path;
    const head = () => refOid(repo, project.repo.ref);
    await changePolicy(fx.engine, project.id, { repair_attempts_max: 0 });
    const first = effectiveVersion(fx.home, project.id);
    assert.deepEqual(JSON.parse(fileAt(repo, head(), GOVERNED_FILE)).protected_paths, ['.surety/checks/'], 'the fixture is live: docs/policy/ is not a protected root');

    // The Builder edits the rules file and is held before it reports.
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThatHolds([step.write(RULES, LOOSENED)])]);
    const { run } = await runToHold(fx, project.id, item);
    const base = run.base_revision;
    assert.equal(base, head(), 'the fixture is live: the run was based on the integration branch as it is');

    // Meanwhile the owner widens the protected roots to cover docs/policy/: a governed edit, classified tightening, approved, applied.
    const proposal = await governedEdit(fx, project, { protected_paths: ROOTS_AFTER });
    const version = await humanApplies(fx, project, proposal, 'tightening');
    const applied = head();
    assert.notEqual(applied, base, 'the fixture is live: the integration branch moved under the run');
    assert.deepEqual(parentsOf(repo, applied), [base], 'by one protected commit on the run\'s base');
    assert.deepEqual(changedPaths(repo, base, applied), { [GOVERNED_FILE]: 'M' }, 'which changes the governed file and nothing else');
    assert.deepEqual(JSON.parse(fileAt(repo, applied, GOVERNED_FILE)).protected_paths, ROOTS_AFTER, 'the governed file now names docs/policy/ as a root');
    assert.equal(version.fingerprint, protectedFingerprint(repo, applied, ROOTS_AFTER), 'the new effective version covers both roots: the rules file is in the protected set in force at integration (its fingerprint over the L6 manifest, SEAM.md §196)');
    assert.deepEqual([version.superseded_by, effectiveVersion(fx.home, project.id).id], [null, version.id]);
    assert.equal(proposalsOf(fx.home, project.id).find((row) => row.id === proposal.id).resulting_version, version.id);
    const before = { registry: registryOf(fx.home, project.id), revisions: revisionsOf(fx.home, { project: project.id }).length };
    assert.equal(before.registry[project.repo.ref].expected_oid, applied);

    // The Builder reports. Its result has to be replayed onto the moved branch, and the replay is judged by the protected set now in force.
    fx.scripted.release(item);
    await waitForRun(fx.home, item, { state: 'ended' });
    const ended = runRow(fx.home, run.id);
    assert.deepEqual([ended.outcome, ended.reason_class], ['failed', 'diff_violation'], `the replayed result is rejected as a protected change (${ended.reason_text})`);
    assert.ok(ended.reason_text.includes(RULES), `the rejection names the path that became protected (it says: ${ended.reason_text})`);

    // Nothing of the run is on the integration branch, and the protected change stands.
    assert.equal(head(), applied, 'the integration branch is at the protected commit: the run moved it nowhere');
    assert.equal(fileAt(repo, head(), RULES), ORIGINAL, 'the rules file on the branch is as the owner left it');
    assert.deepEqual(registryOf(fx.home, project.id), before.registry, 'the registry expects what it expected');
    assert.deepEqual(operationsOf(fx.home, { run: run.id, journalKind: 'ref_update' }).filter((op) => op.status === 'succeeded'), [], 'no ref update of the run succeeded');
    for (const revision of revisionsOf(fx.home, { run: run.id })) {
      assert.equal(isAncestor(repo, revision.sha, head()), false, `no commit of the run is reachable from the integration branch (${revision.sha} is)`);
    }
    assert.equal(effectiveVersion(fx.home, project.id).id, version.id, 'the effective protected version is the tightened one');
    assert.notEqual(workItem(fx.home, item).status, 'integrated', 'the work is not integrated');
  });
});
