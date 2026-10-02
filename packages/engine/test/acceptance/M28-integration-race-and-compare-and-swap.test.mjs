// M28 (slice 3). Plan §3.3 M28 ("integration race and CAS": "Move integration
// after snapshot and before CAS; exercise a safely rebased/revalidated result
// and an irreconcilable conflict separately. ... Successful path validates the
// rebased tree, parent and protected set; conflict parks without an agent
// silently resolving it. CAS never overwrites the unexpected head;
// journal/registry reflect the actual effect"); D1 §§7.3, 7.5 ("If the base is
// behind HEAD, the engine rebases in a scratch worktree, re-runs §7.3
// validation on the rebased tree, and journals that commit instead. A CAS
// failure is integration_conflict: the run ends failed and the item parks; no
// agent resolves it"); D1-19; E25 item 3; SEAM.md §§30, 43.
//
// Integration is a compare-and-swap of the integration branch. The branch can
// have moved since the run's base was taken, in two ways that differ:
//
//   - before the engine comes to integrate, by a commit the engine itself
//     made or adopted (a policy change; an out-of-band commit a person
//     adopted). The run's base is then behind the head. The run's changes are
//     rebased onto the head; if they apply, the rebased tree is validated and
//     committed on the head, and that commit is the one swapped in. If they
//     do not, nothing is integrated and the work parks: no role is asked to
//     resolve it.
//   - between the journaled intent and the swap, behind the engine's back.
//     The swap then fails, as a compare-and-swap must: the unexpected head is
//     not overwritten, the operation is recorded as failed, and the registry
//     goes on expecting what it expected, so that the move is observed as
//     what it is, an out-of-band change.
//
// A rebase is a merge, and a merge can be given a program to run by the
// repository's configuration (a merge driver). Engine git runs no code from
// the repository (E25 item 3); the last case pins that for the rebase.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { releaseBarrier, waitFor } from './harness/engine.mjs';
import { assertWorkHistory } from './harness/invariants.mjs';
import { PERMITTED_EDIT, addGitProject, addItem, permittedEdit, roleThat, roleThatHolds, runToEnd, runToHold } from './harness/gitruns.mjs';
import { armBarrier, assertCommitted, assertOperation, assertOperations, assertOrdinaryCourse, changePolicy, journalBarrier, operationDetails, operationsOf, outOfBand, registryOf, revisionsOf, workItemsOf } from './harness/journal.mjs';
import { changedPaths, commitOnRef, evidenceProgram, fileAt, gitQuiet, isAncestor, parentsOf, readEvidence, refOid, trailersOf, treeOf } from './harness/repos.mjs';
import { answerDecision, decisionsAbout, run as runRow, runsOf, scriptedEngine, tick, waitForRun, waitForWork, workItem } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const ticks = async (fx, project, n = 2) => {
  for (let i = 0; i < n; i++) await tick(fx.engine, project);
};

// The one unreconciled observation of the integration branch at `found`.
function movedBranchObserved(fx, project, found) {
  const observed = outOfBand(fx.home, project.id).filter((o) => o.disposition === null);
  assert.equal(observed.length, 1, `one unreconciled observation (found ${observed.length})`);
  assert.deepEqual({ kind: observed[0].subject_kind, ref: observed[0].ref_name, found: observed[0].found }, { kind: 'ref', ref: project.repo.ref, found }, 'it is the integration branch, at the commit someone else put there');
  return observed[0];
}

// The run failed with an integration conflict, nothing of it is on the
// branch, and its work is parked for a person: no role was asked to resolve it.
async function assertConflictParked(fx, project, item, runId, { branchAt, expected }) {
  const run = runRow(fx.home, runId);
  assert.deepEqual([run.state, run.outcome, run.reason_class], ['ended', 'failed', 'integration_conflict'], `the run ends failed with an integration conflict (${run.reason_text})`);
  assert.ok(typeof run.reason_text === 'string' && run.reason_text.length > 0, 'and says why');
  assert.equal((await fx.engine.get(`/v1/projects/${project.id}/runs/${runId}`)).body?.run?.code, 'integration_conflict', 'the run is reported with the public code');
  assert.equal(refOid(project.repo.path, project.repo.ref), branchAt, 'the integration branch is where it was: nothing of the run is on it');
  assert.equal(registryOf(fx.home, project.id)[project.repo.ref].expected_oid, expected, 'the registry expects what it expected');
  assert.deepEqual(operationsOf(fx.home, { run: runId, journalKind: 'ref_update' }).filter((op) => op.status === 'succeeded'), [], 'no ref update of the run succeeded');
  const parked = await waitForWork(fx.home, item, 'parked');
  assert.equal(JSON.parse(parked.blocker).reason, 'integration_conflict', 'the work is parked with its cause');
  const [decision] = decisionsAbout(fx.home, item, 'blocker').filter((d) => d.status === 'open');
  assert.ok(decision && decision.question.length > 0, 'an open blocker names the work item and says what happened');
  withStore(fx.home, (db) => assertWorkHistory(db, item));
  return decision;
}

describe('M28 the integration branch moved while the run was under way', () => {
  test("moved by the engine's own commit: the result is rebased onto the head, the rebased tree is the head's tree plus the run's changes, it is committed on the head through the journal, and the swap is made from the head", async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const repo = project.repo.path;
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThatHolds([permittedEdit()])]);
    const { run } = await runToHold(fx, project.id, item);
    assert.equal(run.base_revision, project.base);

    // The branch moves under the run: the engine commits a policy change to it.
    await changePolicy(fx.engine, project.id, { repair_attempts_max: 1 });
    const head = refOid(repo, project.repo.ref);
    assert.notEqual(head, project.base, 'the fixture is live: the integration branch moved');
    assert.equal(registryOf(fx.home, project.id)[project.repo.ref].expected_oid, head);

    fx.scripted.release(item);
    await waitForRun(fx.home, item, { state: 'ended' });
    const ended = runRow(fx.home, run.id);
    assert.deepEqual([ended.outcome, ended.reason_class], ['completed', 'none'], `a result that rebases cleanly is integrated (${ended.reason_text})`);
    const tip = refOid(repo, project.repo.ref);
    assert.notEqual(tip, head, 'the branch moved on from the head');
    assert.deepEqual(parentsOf(repo, tip), [head], 'the integrated commit stands on the head the engine found, and on nothing else');
    assert.ok(isAncestor(repo, head, tip), 'what moved the branch is kept');
    // The rebased tree, computed here: the head's tree with the run's change applied.
    const expected = commitOnRef(repo, null, { [PERMITTED_EDIT.path]: PERMITTED_EDIT.content }, { parent: head, message: 'the expected rebase' });
    assert.equal(treeOf(repo, tip), treeOf(repo, expected), "the integrated tree is the head's tree plus the run's changes");
    assert.deepEqual(changedPaths(repo, head, tip), { [PERMITTED_EDIT.path]: 'A' }, 'against the head it changes exactly what the role wrote');
    assert.equal(fileAt(repo, tip, '.surety/policy.json'), fileAt(repo, head, '.surety/policy.json'), 'the policy file the engine committed meanwhile is in it, unchanged');

    // It is the run's commit: recorded, journaled, and labelled with the base it was validated against.
    const revision = revisionsOf(fx.home, { run: run.id }).find((row) => row.sha === tip);
    assert.ok(revision, 'a revision of the run records the integrated commit');
    assert.deepEqual([revision.kind, revision.parent_sha], ['engine_commit', head]);
    const trailers = trailersOf(repo, tip);
    assert.deepEqual({ run: trailers['Surety-Run'], base: trailers['Surety-Base'], work: trailers['Surety-WorkItem'] }, { run: [run.id], base: [head], work: [item] }, 'its trailers name the run and the head it was rebased onto');
    const commits = operationsOf(fx.home, { run: run.id, journalKind: 'commit_tree' });
    const rebased = commits.find((op) => op.events[0].payload.tree === treeOf(repo, tip) && op.events[0].payload.old_oid === head);
    assert.ok(rebased, 'the rebased commit was made through the journal, with the head as its parent and the rebased tree');
    assertOrdinaryCourse(rebased, 'the rebased commit');
    const moves = operationsOf(fx.home, { run: run.id, journalKind: 'ref_update' });
    assert.equal(moves.length, 1, 'one ref update of the run');
    assertOrdinaryCourse(moves[0], 'the integration');
    assert.deepEqual(
      { ref: moves[0].events[0].payload.ref, old_oid: moves[0].events[0].payload.old_oid, new_oid: moves[0].events[0].payload.new_oid },
      { ref: project.repo.ref, old_oid: head, new_oid: tip },
      'the compare-and-swap is from the head the engine found to the rebased commit',
    );
    assert.equal(registryOf(fx.home, project.id)[project.repo.ref].expected_oid, tip);
    assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, item)).slice(0, 5), ['eligible', 'claimed', 'executing', 'integrating', 'integrated']);
    await ticks(fx, project.id);
    assert.deepEqual(outOfBand(fx.home, project.id), [], 'nothing is out of band');
    assertOperations(fx.home, { project: project.id });
  });

  test('moved to an adopted commit that changes the same file another way: the rebase conflicts, nothing is integrated, the work parks, and no role is launched to resolve it; a person lets the work run again from the new head', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const repo = project.repo.path;
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThatHolds([permittedEdit()]), roleThat([step.write('src/other.js', 'export const other = 1;\n')])]);
    const { run } = await runToHold(fx, project.id, item);

    // Someone else commits another version of the same file to the branch; a person adopts it.
    const theirs = commitOnRef(repo, project.repo.ref, { [PERMITTED_EDIT.path]: 'export const answer = 7;\n' }, { message: 'a commit that conflicts with the run' });
    await ticks(fx, project.id);
    await answerDecision(fx.engine, project.id, movedBranchObserved(fx, project, theirs).decision.id, 'adopt');
    await waitFor(() => registryOf(fx.home, project.id)[project.repo.ref].expected_oid === theirs, { what: 'the adopted commit to be the expected one' });
    const before = { launches: fx.scripted.launches().length, work: workItemsOf(fx.home, project.id).length };

    fx.scripted.release(item);
    await waitForRun(fx.home, item, { state: 'ended' });
    const decision = await assertConflictParked(fx, project, item, run.id, { branchAt: theirs, expected: theirs });
    assert.equal(fileAt(repo, refOid(repo, project.repo.ref), PERMITTED_EDIT.path), 'export const answer = 7;\n', 'the adopted version of the file is untouched');
    await ticks(fx, project.id);
    assert.deepEqual({ launches: fx.scripted.launches().length, work: workItemsOf(fx.home, project.id).length }, before, 'no role was launched and no work created to resolve the conflict');
    assert.equal(runsOf(fx.home, item).length, 1);

    // The continuation: a person answers the blocker, and the work runs again from the head.
    await answerDecision(fx.engine, project.id, decision.id, 'retry');
    const second = await runToEnd(fx, project.id, item, { index: 1 });
    assert.equal(second.base_revision, theirs, 'the next run starts from the adopted head');
    assertCommitted(fx, second.id, { kind: 'engine_commit', parent: theirs, integrated: true, changes: { 'src/other.js': 'A' } });
  });

  test('moved between the journaled intent and the swap: the compare-and-swap fails, the unexpected head is not overwritten, the operation is failed, the registry is not told, and the move is observed out of band', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const repo = project.repo.path;
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThatHolds([permittedEdit()]), roleThat([step.write('src/other.js', 'export const other = 1;\n')])]);
    const { run } = await runToHold(fx, project.id, item);
    const barrier = journalBarrier('ref_update', 'intent_committed');
    await armBarrier(fx.engine, barrier, 'pause');
    fx.scripted.release(item);
    await fx.engine.waitUntil(`barrier:${barrier}`);
    const [intended] = operationDetails(fx.home, { run: run.id, journalKind: 'ref_update' });
    assert.deepEqual([intended.events.map((e) => e.kind), intended.payload.old_oid], [['intended'], project.base], 'the swap is journaled from the base, and not yet made');

    // Behind the engine's back, the branch moves.
    const theirs = commitOnRef(repo, project.repo.ref, { 'developer.txt': 'pushed while the engine was integrating\n' }, { message: 'a commit the engine did not expect' });
    await releaseBarrier(fx.engine, barrier);
    await waitForRun(fx.home, item, { state: 'ended' });
    const decision = await assertConflictParked(fx, project, item, run.id, { branchAt: theirs, expected: project.base });
    const failed = assertOperation(operationDetails(fx.home, { run: run.id, journalKind: 'ref_update' })[0], 'the failed swap');
    assert.deepEqual([failed.events.map((e) => e.kind), failed.status, failed.attempts.map((a) => a.status)], [['intended', 'failed'], 'failed', ['failed']], 'the journal and the attempt record the actual effect: none');
    assert.ok(isAncestor(repo, theirs, refOid(repo, project.repo.ref)) && !isAncestor(repo, intended.payload.new_oid, refOid(repo, project.repo.ref)), "the run's commit is not on the branch");

    // The registry did not absorb the move: integrity observes it, and the project waits for a person.
    await ticks(fx, project.id);
    const observed = movedBranchObserved(fx, project, theirs);
    assert.equal(observed.expected, project.base);
    assert.equal(runsOf(fx.home, item).length, 1);

    // The continuation: the move is adopted, the blocker answered, and the work is integrated on top of it.
    await answerDecision(fx.engine, project.id, observed.decision.id, 'adopt');
    await waitFor(() => registryOf(fx.home, project.id)[project.repo.ref].expected_oid === theirs, { what: 'the adopted commit to be the expected one' });
    await answerDecision(fx.engine, project.id, decision.id, 'retry');
    const second = await runToEnd(fx, project.id, item, { index: 1 });
    assertCommitted(fx, second.id, { kind: 'engine_commit', parent: theirs, integrated: true, changes: { 'src/other.js': 'A' } });
    assertOperations(fx.home, { project: project.id });
  });

  test("a merge driver the repository's configuration names is not run by the rebase", async (t) => {
    const fx = await scriptedEngine(t);
    const evidence = join(fx.root, 'evidence.log');
    const original = 'line one\nline two\nline three\n';
    const project = await addGitProject(fx, { files: { '.gitattributes': '*.txt merge=planted\n', 'notes.txt': original } });
    const repo = project.repo.path;
    const program = evidenceProgram(join(fx.root, 'programs', 'merge-driver'), evidence, 'merge driver');
    gitQuiet(repo, ['config', 'merge.planted.driver', `${program} %O %A %B`]);
    const ours = 'line one\nline two\nline three, by the role\n';
    const theirsText = 'line one, by someone else\nline two\nline three\n';

    // The fixture is live: an ordinary three-way merge of the two versions runs the planted program.
    const left = commitOnRef(repo, null, { 'notes.txt': ours }, { parent: project.base, message: 'fixture: one side' });
    const right = commitOnRef(repo, null, { 'notes.txt': theirsText }, { parent: project.base, message: 'fixture: the other side' });
    try {
      gitQuiet(repo, ['merge-tree', '--write-tree', `--merge-base=${project.base}`, right, left]);
    } catch {
      // whatever the planted program made of the merge, it ran
    }
    assert.match(readEvidence(evidence) ?? '', /merge driver ran/, 'ordinary git runs the merge driver the configuration names');
    rmSync(evidence);

    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThatHolds([step.write('notes.txt', ours)])]);
    const { run } = await runToHold(fx, project.id, item);
    const theirs = commitOnRef(repo, project.repo.ref, { 'notes.txt': theirsText }, { message: 'another change to the same file' });
    await ticks(fx, project.id);
    await answerDecision(fx.engine, project.id, movedBranchObserved(fx, project, theirs).decision.id, 'adopt');
    await waitFor(() => registryOf(fx.home, project.id)[project.repo.ref].expected_oid === theirs, { what: 'the adopted commit to be the expected one' });
    fx.scripted.release(item);
    await waitForRun(fx.home, item, { state: 'ended' });

    assert.equal(readEvidence(evidence), null, `the engine's rebase ran the repository's merge driver:\n${readEvidence(evidence)}`);
    // What the rebase makes of two changes to one file is the engine's: both
    // changes integrated, or a conflict. A repository that needs its merge
    // driver is not supported in M1, like one that needs a filter (E29 item 1).
    const ended = runRow(fx.home, run.id);
    const tip = refOid(repo, project.repo.ref);
    if (ended.outcome === 'completed') {
      assert.deepEqual(parentsOf(repo, tip), [theirs]);
      assert.equal(fileAt(repo, tip, 'notes.txt'), 'line one, by someone else\nline two\nline three, by the role\n', 'both changes are in the integrated file');
    } else {
      assert.deepEqual([ended.outcome, ended.reason_class, tip], ['failed', 'integration_conflict', theirs], 'or the rebase is a conflict, and nothing moved');
      assert.equal(workItem(fx.home, item).status, 'parked');
    }
  });
});
