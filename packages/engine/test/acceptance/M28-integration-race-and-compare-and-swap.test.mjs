// M28 (slice 3). Plan §3.3 M28 ("integration race and CAS": "Move integration
// after snapshot and before CAS; exercise a safely rebased/revalidated result
// and an irreconcilable conflict separately. ... Successful path validates the
// rebased tree, parent and protected set; conflict parks without an agent
// silently resolving it. CAS never overwrites the unexpected head;
// journal/registry reflect the actual effect"); D1 §§7.3, 7.5 ("If the base is
// behind HEAD, the engine rebases in a scratch worktree, re-runs §7.3
// validation on the rebased tree, and journals that commit instead. A CAS
// failure is integration_conflict: the run ends failed and the item parks; no
// agent resolves it"); D1-19; E25 item 3; SEAM.md §§30, 43, 470.
//
// E152 item 4 (Sean, 2026-10-16) amends D1 §7.5 and D1-19: a rebase whose
// changes no longer apply to a moved integration branch (not a
// compare-and-swap failure) sends the item back to its Builder once on the
// new head, the conflict named in its context, within repair_attempts_max;
// it parks only when that budget is spent or the compare-and-swap failure
// persists.
//
// Integration is a compare-and-swap of the integration branch. The branch can
// have moved since the run's base was taken, in two ways that differ:
//
//   - before the engine comes to integrate, by a commit the engine itself
//     made or adopted (a policy change; an out-of-band commit a person
//     adopted). The run's base is then behind the head. The run's changes are
//     rebased onto the head; if they apply, the rebased tree is validated and
//     committed on the head, and that commit is the one swapped in. If they
//     do not, nothing of that run is integrated and the work goes back to
//     its Builder once, on the new head, with the conflict named in its
//     context, counted against repair_attempts_max (E152 item 4). Only when
//     that budget is spent does the work park, with no role asked to
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
import { packageOf } from './harness/sessions.mjs';
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

// The run failed with an integration conflict and nothing of it is on the branch.
async function assertConflictFailed(fx, project, runId, { branchAt, expected }) {
  const run = runRow(fx.home, runId);
  assert.deepEqual([run.state, run.outcome, run.reason_class], ['ended', 'failed', 'integration_conflict'], `the run ends failed with an integration conflict (${run.reason_text})`);
  assert.ok(typeof run.reason_text === 'string' && run.reason_text.length > 0, 'and says why');
  assert.equal((await fx.engine.get(`/v1/projects/${project.id}/runs/${runId}`)).body?.run?.code, 'integration_conflict', 'the run is reported with the public code');
  assert.equal(refOid(project.repo.path, project.repo.ref), branchAt, 'the integration branch is where it was: nothing of the run is on it');
  assert.equal(registryOf(fx.home, project.id)[project.repo.ref].expected_oid, expected, 'the registry expects what it expected');
  assert.deepEqual(operationsOf(fx.home, { run: runId, journalKind: 'ref_update' }).filter((op) => op.status === 'succeeded'), [], 'no ref update of the run succeeded');
  return run;
}

// The context package a run's role dumped names the integration conflict on
// `path`: one file of it names the path and says it conflicts or does not
// apply (E152 item 4: "the conflict named in its context"). The wording is
// the engine's; the path and the fact are what is pinned (SEAM.md §470).
const CONFLICT_WORDS = /conflict|do(?:es)? not apply|no longer appl/i;
const namesConflict = (pkg, path) => Object.values(pkg ?? {}).some((text) => typeof text === 'string' && text.includes(path) && CONFLICT_WORDS.test(text));

// The run failed with an integration conflict, nothing of it is on the
// branch, and its work is parked for a person: no role was asked to resolve
// it. Under E152 item 4 a rebase conflict parks only at the end of the repair
// budget, so its cause may be named as the conflict or as the budget
// (`reasons`; SEAM.md §470). A compare-and-swap failure parks as the conflict.
async function assertConflictParked(fx, project, item, runId, { branchAt, expected, reasons = ['integration_conflict'] }) {
  await assertConflictFailed(fx, project, runId, { branchAt, expected });
  const parked = await waitForWork(fx.home, item, 'parked');
  assert.ok(reasons.includes(JSON.parse(parked.blocker).reason), `the work is parked with its cause, one of ${reasons.join(', ')} (${parked.blocker})`);
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

  test("moved to an adopted commit that changes the same file another way: the rebase conflicts, nothing of the run is integrated, and the work goes back to its Builder once, on the new head, the conflict named in its context; that repair is integrated on the head (E152 item 4)", async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const repo = project.repo.path;
    const item = await addItem(fx, project.id, 'fix');
    const REPAIRED = 'export const answer = 49;\n';
    fx.scripted.script(item, [
      roleThatHolds([step.probe('context_dump'), permittedEdit()]),
      roleThatHolds([step.probe('context_dump')], [step.write(PERMITTED_EDIT.path, REPAIRED)]),
    ]);
    const { run, launch } = await runToHold(fx, project.id, item);
    assert.ok(packageOf(fx, run.id), 'the fixture is live: the first role dumped its context package');
    assert.equal(namesConflict(packageOf(fx, run.id), PERMITTED_EDIT.path), false, "the fixture is live: the first run's context names no conflict on the path");

    // Someone else commits another version of the same file to the branch; a person adopts it.
    const theirs = commitOnRef(repo, project.repo.ref, { [PERMITTED_EDIT.path]: 'export const answer = 7;\n' }, { message: 'a commit that conflicts with the run' });
    await ticks(fx, project.id);
    await answerDecision(fx.engine, project.id, movedBranchObserved(fx, project, theirs).decision.id, 'adopt');
    await waitFor(() => registryOf(fx.home, project.id)[project.repo.ref].expected_oid === theirs, { what: 'the adopted commit to be the expected one' });
    const work = workItemsOf(fx.home, project.id).length;

    // The first run's hold is released by its invocation, so the repair's own hold stands.
    fx.scripted.release(launch.invocation);
    await waitForRun(fx.home, item, { state: 'ended' });

    // The work goes back to its Builder once, on the new head: a second run of the same item, not new work.
    const { run: repair, launch: repairLaunch } = await runToHold(fx, project.id, item, { index: 1 });
    await assertConflictFailed(fx, project, run.id, { branchAt: theirs, expected: theirs });
    assert.equal(fileAt(repo, refOid(repo, project.repo.ref), PERMITTED_EDIT.path), 'export const answer = 7;\n', 'the adopted version of the file is untouched by the conflicting run');
    assert.equal(repair.base_revision, theirs, 'the repair starts from the moved head');
    assert.equal(repairLaunch.work_item, item, "it is the item's own Builder, sent back");
    assert.equal(workItemsOf(fx.home, project.id).length, work, 'no work was created to resolve the conflict');
    assert.equal(workItem(fx.home, item).repair_attempts, 1, 'the send-back is counted against repair_attempts_max');
    assert.deepEqual(decisionsAbout(fx.home, item, 'blocker'), [], 'the work did not park: no blocker');
    const pkg = packageOf(fx, repair.id);
    assert.ok(namesConflict(pkg, PERMITTED_EDIT.path), `the conflict on ${PERMITTED_EDIT.path} is named in the repair's context (files: ${JSON.stringify(Object.keys(pkg ?? {}))}; prompt: ${JSON.stringify(pkg?.['prompt.md'] ?? null)})`);

    // The repair, made on the head, is integrated on it.
    fx.scripted.release(repairLaunch.invocation);
    const ended = await waitForRun(fx.home, item, { index: 1, state: 'ended' });
    assertCommitted(fx, ended.id, { kind: 'engine_commit', parent: theirs, integrated: true, changes: { [PERMITTED_EDIT.path]: 'M' } });
    assert.equal(fileAt(repo, refOid(repo, project.repo.ref), PERMITTED_EDIT.path), REPAIRED, "the branch holds the repair's version");
    assert.equal(fx.scripted.launches({ work_item: item }).length, 2, 'one launch and one repair');
    assert.ok(!withStore(fx.home, (db) => assertWorkHistory(db, item)).includes('parked'), 'the work never parked');
    assertOperations(fx.home, { project: project.id });
  });

  test('the repair after a rebase conflict conflicts again with a second adopted move: the budget (repair_attempts_max 1) is spent, nothing is integrated, the work parks, and no role is launched to resolve it; a person lets the work run again from the new head (E152 item 4)', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const repo = project.repo.path;
    await changePolicy(fx.engine, project.id, { repair_attempts_max: 1 });
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [
      roleThatHolds([permittedEdit()]),
      roleThatHolds([], [step.write(PERMITTED_EDIT.path, 'export const answer = 49;\n')]),
      roleThat([step.write('src/other.js', 'export const other = 1;\n')]),
    ]);
    const { run, launch } = await runToHold(fx, project.id, item);

    // A commit to the same file, made by someone else and adopted by a person.
    const adopt = async (content, message) => {
      const at = commitOnRef(repo, project.repo.ref, { [PERMITTED_EDIT.path]: content }, { message });
      await ticks(fx, project.id);
      await answerDecision(fx.engine, project.id, movedBranchObserved(fx, project, at).decision.id, 'adopt');
      await waitFor(() => registryOf(fx.home, project.id)[project.repo.ref].expected_oid === at, { what: 'the adopted commit to be the expected one' });
      return at;
    };
    const first = await adopt('export const answer = 7;\n', 'a commit that conflicts with the run');
    fx.scripted.release(launch.invocation);
    await waitForRun(fx.home, item, { state: 'ended' });
    const { run: repair, launch: repairLaunch } = await runToHold(fx, project.id, item, { index: 1 });
    await assertConflictFailed(fx, project, run.id, { branchAt: first, expected: first });
    assert.equal(repair.base_revision, first, 'the fixture is live: the repair starts from the first moved head');

    // The branch moves again under the repair, in the same file.
    const second = await adopt('export const answer = 8;\n', 'a second commit that conflicts with the repair');
    const work = workItemsOf(fx.home, project.id).length;
    fx.scripted.release(repairLaunch.invocation);
    await waitForRun(fx.home, item, { index: 1, state: 'ended' });
    const decision = await assertConflictParked(fx, project, item, repair.id, { branchAt: second, expected: second, reasons: ['integration_conflict', 'repair_attempts_max'] });
    assert.equal(fileAt(repo, refOid(repo, project.repo.ref), PERMITTED_EDIT.path), 'export const answer = 8;\n', 'the adopted version of the file is untouched');
    assert.equal(workItem(fx.home, item).repair_attempts, 1, 'one send-back, the whole budget');
    await ticks(fx, project.id);
    assert.deepEqual({ launches: fx.scripted.launches({ work_item: item }).length, work: workItemsOf(fx.home, project.id).length }, { launches: 2, work }, 'no role was launched and no work created past the budget');
    assert.equal(runsOf(fx.home, item).length, 2);

    // The continuation: a person answers the blocker, and the work runs again from the head.
    await answerDecision(fx.engine, project.id, decision.id, 'retry');
    const third = await runToEnd(fx, project.id, item, { index: 2 });
    assert.equal(third.base_revision, second, 'the next run starts from the adopted head');
    assertCommitted(fx, third.id, { kind: 'engine_commit', parent: second, integrated: true, changes: { 'src/other.js': 'A' } });
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
    // A conflict sends the work back to its Builder on the head (E152 item 4): the repair writes both changes.
    fx.scripted.script(item, [roleThatHolds([step.write('notes.txt', ours)]), roleThat([step.write('notes.txt', 'line one, by someone else\nline two\nline three, by the role\n')])]);
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
    if (ended.outcome === 'completed') {
      const tip = refOid(repo, project.repo.ref);
      assert.deepEqual(parentsOf(repo, tip), [theirs]);
      assert.equal(fileAt(repo, tip, 'notes.txt'), 'line one, by someone else\nline two\nline three, by the role\n', 'both changes are in the integrated file');
    } else {
      assert.deepEqual([ended.outcome, ended.reason_class], ['failed', 'integration_conflict'], 'or the rebase is a conflict');
      assert.deepEqual(operationsOf(fx.home, { run: run.id, journalKind: 'ref_update' }).filter((op) => op.status === 'succeeded'), [], 'and nothing of the run moved the branch');
      // E152 item 4: the work goes back to its Builder on the head, not to a person.
      const repair = await waitForRun(fx.home, item, { index: 1, state: 'ended' });
      assert.equal(repair.base_revision, theirs, 'the repair starts from the moved head');
      assert.ok(!withStore(fx.home, (db) => assertWorkHistory(db, item)).includes('parked'), 'the work did not park');
      assert.equal(readEvidence(evidence), null, `the repair's integration ran the repository's merge driver:\n${readEvidence(evidence)}`);
    }
  });
});
