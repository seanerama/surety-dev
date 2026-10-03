// M15, a git write that overruns its deadline while the engine runs (M2
// slice 2, entry B6; `docs/spec/M2-slice-2-legibility.md`). Plan §3.2 M15
// ("possible writes become ambiguous, dependent integration/dispatch stays
// suppressed"); D1 §§7.1, 7.5, 7.10, 8.1 step 2, 8.5; build spec §6
// corrections 14 and 16; SEAM.md §§34, 44, 45, 47, 110; ../contract/journal.json.
//
// Slice 3 pinned a `git worktree add` killed at `git_deadline` (M15-git-
// deadline-and-integrity-step) and what follows for it (M15-ambiguous-git-
// call-reconciled). The two writes that carry accepted work, a run's commit
// and the branch update that integrates it, were reached only through a
// restart (rows M29, M30): the tool that held git held every call, and the
// engine reads before it writes. This file holds the writes alone
// (harness/held-writes.mjs) and pins, for a running engine:
//
//   - a commit object write held past the deadline is killed, its operation
//     is recorded ambiguous and nothing of it is taken for made or failed:
//     the run is not ended on the strength of a timer, no second run is
//     started, and nothing of the project is dispatched while the journal
//     has not established what git did;
//   - the next tick's journal step probes it: the object is absent, the
//     attempt is reconciled absent, and one new attempt makes the commit,
//     with the identity the frozen intent fixed, exactly once;
//   - the branch update that follows, held the same way, goes the same way:
//     ambiguous, probed (the ref at its old commit), retried once, the
//     branch moved exactly once;
//   - the run then ends completed and its work is integrated: nothing
//     appears twice (one commit naming the run, one revision, one run of the
//     item, no repair) and nothing is lost (the edit is on the branch).
//
// The second case is the slice-2 review's (S3; SEAM.md §112): a Stop
// confirmed while the run's branch update is ambiguous does not end the run
// before the journal has established what git did. The killed write is made
// to have landed by hand (a late completion the tool cannot produce); the
// probe then finds it applied, the integration is finalized and the work
// integrated, and only then does the Stop take its course: the run stopped,
// the work held, nothing done twice.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { reachBarrier } from './harness/decisions.mjs';
import { assertWorkHistory } from './harness/invariants.mjs';
import { releaseBarrier, waitFor } from './harness/engine.mjs';
import { askingForTicks } from './harness/gates.mjs';
import { PERMITTED_EDIT, addGitProject, addItem, permittedEdit, roleThat } from './harness/gitruns.mjs';
import { heldGitWrites } from './harness/held-writes.mjs';
import { assertOperation, assertOperations, eventsOfType, operationDetails, recoveryBarrier, registryOf, revisionsOf } from './harness/journal.mjs';
import { changedPaths, commitsNaming, gitQuiet, parentsOf, refOid, refsContaining, treeOf } from './harness/repos.mjs';
import { assertRunEnded, leasesOf, requestTick, run as runRow, runsOf, scriptedEngine, stopRun, tick, tickUntil, waitForRun, workItem } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { sleep } from './harness/mono.mjs';
import { script } from './harness/scripted.mjs';

const GIT_DEADLINE = 2;
const KILL_WAIT_MS = (GIT_DEADLINE + 8) * 1000;

describe('M15 a git write past its deadline while the engine runs', () => {
  test('the commit object write and then the branch update, each held past git_deadline: each is killed and recorded ambiguous, blocks the project until a probe has established that git made nothing, and is then made exactly once; the run completes and its work is integrated once', async (t) => {
    const writes = heldGitWrites(t);
    const commitReconciled = recoveryBarrier('commit_tree');
    const integrationReconciled = recoveryBarrier('ref_update');
    const fx = await scriptedEngine(t, { env: writes.env, config: { git_deadline: GIT_DEADLINE }, barriers: [`${commitReconciled}=pause`, `${integrationReconciled}=pause`] });
    const project = await addGitProject(fx);
    const repo = project.repo.path;
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThat([permittedEdit()])]);

    // The writes are held from here: the commit object, and any update of a
    // branch. Reads, probes and the keep ref's update go through.
    writes.holdCommit();
    writes.holdRefUpdate(project.repo.ref);
    await requestTick(fx.engine, project.id);
    const run = await waitForRun(fx.home, item);
    // A second item of the project, added once the run exists (the scheduler
    // would dispatch verification work first), to show what is and is not
    // dispatched meanwhile.
    const later = await addItem(fx, project.id, 'verification');
    fx.scripted.script(later, [script.complete()]);
    const opOf = (kind) => operationDetails(fx.home, { project: project.id, run: run.id, journalKind: kind })[0];
    const withEvent = (kind, event) =>
      waitFor(
        () => {
          const op = opOf(kind);
          return op && op.events.some((e) => e.kind === event) ? op : undefined;
        },
        { timeoutMs: 30_000 + KILL_WAIT_MS, what: `the run's ${kind} operation to have a ${event} event` },
      );

    // ---- the commit --------------------------------------------------------------------
    // The role has exited, its snapshot was validated, the commit was intended
    // and its object write held: past the deadline the engine kills the write
    // and records the operation ambiguous.
    const ambiguousCommit = await withEvent('commit_tree', 'ambiguous');
    assert.deepEqual([ambiguousCommit.state, ambiguousCommit.status, ambiguousCommit.attempts.map((a) => a.status)], ['ambiguous', 'ambiguous', ['ambiguous']], 'the commit operation is ambiguous: its one attempt was killed at the deadline, neither failed nor succeeded');
    assert.ok(!ambiguousCommit.events.some((e) => e.kind === 'applied' || e.kind === 'confirmed'), 'nothing recorded the commit as applied');
    assert.deepEqual(commitsNaming(repo, `Surety-Run: ${run.id}`), [], 'the fixture is live: the held write never ran, so no commit names the run');
    assert.deepEqual(writes.heldLog().map((line) => line.split(' ')[1]), ['hash-object'], 'the fixture is live: one write was held, the commit object');
    // Nothing is taken for failed or made on the strength of the timer.
    const window = () => {
      const now = runRow(fx.home, run.id);
      assert.notEqual(now.state, 'ended', `the run is not ended while an operation it issued is unresolved (SEAM.md §47): it ended ${now.outcome} / ${now.reason_class} (${now.reason_text})`);
      assert.equal(runsOf(fx.home, item).length, 1, 'no second run of the work was started');
      assert.ok(!['integrated', 'complete', 'eligible', 'parked'].includes(workItem(fx.home, item).status), `the work is neither integrated nor given up (it is ${workItem(fx.home, item).status})`);
      assert.equal(runsOf(fx.home, later).length, 0, 'nothing else of the project is dispatched while the journal has an unresolved operation');
    };
    window();

    // The next tick's journal step probes it: the object is positively
    // absent, the attempt is reconciled absent, and the engine pauses before
    // the retry (the `reconciled` barrier, SEAM.md §45).
    await reachBarrier(fx, project.id, commitReconciled);
    const reconciledCommit = opOf('commit_tree');
    assert.deepEqual([reconciledCommit.state, reconciledCommit.attempts.map((a) => a.status), reconciledCommit.attempts.at(-1)?.reads.at(-1)?.result], ['ambiguous', ['reconciled_absent'], 'absent'], 'the probe found the commit absent and reconciled the killed attempt as absent; the journal is still ambiguous');
    assert.deepEqual(commitsNaming(repo, `Surety-Run: ${run.id}`), [], 'still no commit names the run: the probe made nothing');
    window();

    // The hold is lifted and the engine goes on: one new attempt makes the
    // commit, with the identity the intent fixed, and the operation completes.
    writes.release('hash-object');
    await releaseBarrier(fx.engine, commitReconciled);
    const madeCommit = await withEvent('commit_tree', 'finalized');
    assertOperation(madeCommit, "the run's commit after the retry");
    assert.deepEqual([madeCommit.events.map((e) => e.kind), madeCommit.attempts.map((a) => a.status), madeCommit.status], [['intended', 'ambiguous', 'applied', 'confirmed', 'finalized'], ['reconciled_absent', 'succeeded'], 'succeeded'], 'the commit went ambiguous, then applied by the second attempt, confirmed and finalized');
    const named = commitsNaming(repo, `Surety-Run: ${run.id}`);
    assert.equal(named.length, 1, `exactly one commit names the run (found ${named.length})`);
    assert.deepEqual([treeOf(repo, named[0]), parentsOf(repo, named[0])], [madeCommit.payload.tree, [madeCommit.payload.old_oid]], 'and it is the commit the frozen intent fixed: its tree and its parent (SEAM.md §45: identity stable across a retry)');
    assert.ok(refsContaining(repo, named[0]).some((ref) => ref.startsWith('refs/surety/keep/')), 'published under its keep ref');

    // ---- the branch update ---------------------------------------------------------------
    // The integration follows: its compare-and-swap is held, killed at the
    // deadline, and recorded ambiguous; the branch has not moved.
    const ambiguousMove = await withEvent('ref_update', 'ambiguous');
    assert.deepEqual([ambiguousMove.state, ambiguousMove.status, ambiguousMove.attempts.map((a) => a.status)], ['ambiguous', 'ambiguous', ['ambiguous']], 'the branch update is ambiguous: its one attempt was killed at the deadline');
    assert.deepEqual([ambiguousMove.payload.ref, ambiguousMove.payload.old_oid, ambiguousMove.payload.new_oid], [project.repo.ref, project.base, named[0]], 'its intent: the integration branch, from the base to the commit');
    assert.equal(refOid(repo, project.repo.ref), project.base, 'the fixture is live: the held update never ran, so the branch is where it was');
    assert.deepEqual(writes.heldLog().map((line) => line.split(' ')[1]), ['hash-object', 'update-ref'], 'the fixture is live: the second write held is the branch update; the keep ref went through');
    window();

    await reachBarrier(fx, project.id, integrationReconciled);
    const reconciledMove = opOf('ref_update');
    assert.deepEqual([reconciledMove.state, reconciledMove.attempts.map((a) => a.status), reconciledMove.attempts.at(-1)?.reads.at(-1)?.result], ['ambiguous', ['reconciled_absent'], 'absent'], 'the probe found the ref at its old commit and reconciled the killed attempt as absent');
    assert.equal(refOid(repo, project.repo.ref), project.base, 'the probe moved nothing');
    window();

    writes.release('update-ref');
    await releaseBarrier(fx.engine, integrationReconciled);
    const madeMove = await withEvent('ref_update', 'finalized');
    assertOperation(madeMove, "the run's integration after the retry");
    assert.deepEqual([madeMove.events.map((e) => e.kind), madeMove.attempts.map((a) => a.status), madeMove.status], [['intended', 'ambiguous', 'applied', 'confirmed', 'finalized'], ['reconciled_absent', 'succeeded'], 'succeeded'], 'the branch update went ambiguous, then applied by the second attempt, confirmed and finalized');

    // ---- what the project holds afterwards -----------------------------------------------
    // The run ends completed and its work is integrated: once, with nothing lost.
    await askingForTicks(fx, project.id, () => runRow(fx.home, run.id).state === 'ended', 'the run to end once its operations are finalized');
    assertRunEnded(fx.home, run.id, { outcome: 'completed', reason_class: 'none', workspace: 'retained', launched: true });
    assert.deepEqual([workItem(fx.home, item).status, workItem(fx.home, item).repair_attempts, runsOf(fx.home, item).length], ['integrated', 0, 1], 'the work is integrated by its one run, with no repair');
    assert.equal(refOid(repo, project.repo.ref), named[0], 'the integration branch is at the commit');
    assert.equal(registryOf(fx.home, project.id)[project.repo.ref].expected_oid, named[0], 'and the registry expects it there');
    assert.deepEqual(parentsOf(repo, named[0]), [project.base], 'on top of the base: the branch gained exactly one commit');
    assert.deepEqual(changedPaths(repo, project.base, named[0]), { [PERMITTED_EDIT.path]: 'A' }, "holding the role's edit, once");
    assert.deepEqual(commitsNaming(repo, `Surety-Run: ${run.id}`), named, 'still exactly one commit names the run');
    assert.deepEqual(revisionsOf(fx.home, { run: run.id }).map((row) => [row.kind, row.sha]), [['engine_commit', named[0]]], 'one revision records it');
    assertOperations(fx.home, { project: project.id });
    assert.deepEqual(writes.heldLog().map((line) => line.split(' ')[1]), ['hash-object', 'update-ref'], 'two writes were held in all; every retry ran');

    // The project goes on: the item that waited is dispatched and completes.
    await tick(fx.engine, project.id);
    await tickUntil(fx.engine, project.id, () => workItem(fx.home, later).status === 'complete', { what: 'the second item to complete once the project is unblocked' });
    assert.equal(runsOf(fx.home, item).length, 1, 'and the integrated work was never run again');
  });

  // The slice-2 review, S3 (SEAM.md §112).
  test('a Stop confirmed while the branch update is ambiguous, the killed write having in fact landed: the run is not ended before the journal has established it, the integration is finalized and the work integrated, and only then is the run stopped and the work held', async (t) => {
    const writes = heldGitWrites(t);
    const fx = await scriptedEngine(t, { env: writes.env, config: { git_deadline: GIT_DEADLINE } });
    const project = await addGitProject(fx);
    const repo = project.repo.path;
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThat([permittedEdit()])]);
    writes.holdRefUpdate(project.repo.ref);
    await requestTick(fx.engine, project.id);
    const run = await waitForRun(fx.home, item);
    const opOf = () => operationDetails(fx.home, { project: project.id, run: run.id, journalKind: 'ref_update' })[0];

    // The commit is made; the branch update is held and killed at the deadline.
    const ambiguous = await waitFor(
      () => {
        const op = opOf();
        return op && op.events.some((e) => e.kind === 'ambiguous') ? op : undefined;
      },
      { timeoutMs: 30_000 + KILL_WAIT_MS, what: "the run's branch update to be ambiguous" },
    );
    assert.deepEqual([ambiguous.state, ambiguous.attempts.map((a) => a.status), refOid(repo, project.repo.ref)], ['ambiguous', ['ambiguous'], project.base], 'the fixture is live: the branch update was killed, recorded ambiguous, and the branch has not moved');
    const { old_oid: base, new_oid: sha } = ambiguous.payload;
    assert.deepEqual([base, commitsNaming(repo, `Surety-Run: ${run.id}`)], [project.base, [sha]], "the intent moves the branch from the base to the run's one commit");
    const before = runRow(fx.home, run.id);
    assert.notEqual(before.state, 'ended', `the fixture is live: the run waits on its ambiguous write (SEAM.md §110); it is ${before.state}${before.state === 'ended' ? ` (${before.outcome} / ${before.reason_class}: ${before.reason_text})` : ''}`);

    // The killed write lands after all: made by hand with the same
    // compare-and-swap, which stands in for a late completion the tool
    // cannot produce. This is exactly what ambiguity covers.
    gitQuiet(repo, ['update-ref', project.repo.ref, sha, base]);
    writes.release('update-ref');
    assert.equal(refOid(repo, project.repo.ref), sha, 'the fixture is live: the branch is at the commit, as the killed write would have left it');

    // A Stop is confirmed. The end is decided: nothing renews the lease
    // (E27 item 5). But the run is not ended while its operation is
    // unresolved (D1 §4.5 step 4; SEAM.md §47): with no tick, nothing is
    // reconciled and nothing ends.
    await stopRun(fx.engine, project.id, run.id);
    const leaseAfterStop = leasesOf(fx.home, run.id).filter((lease) => lease.resource_kind === 'run').map((lease) => [lease.renewed_at, lease.expires_at]);
    await sleep(3000);
    const waiting = runRow(fx.home, run.id);
    assert.deepEqual(
      [waiting.state === 'ended', opOf().state, workItem(fx.home, item).status === 'held'],
      [false, 'ambiguous', false],
      `three seconds after the Stop the run has not ended and the work is not held while the operation is still ambiguous (the run is ${waiting.state}${waiting.state === 'ended' ? `, ${waiting.outcome} / ${waiting.reason_class}` : ''}, the work ${workItem(fx.home, item).status})`,
    );
    assert.deepEqual(leasesOf(fx.home, run.id).filter((lease) => lease.resource_kind === 'run').map((lease) => [lease.renewed_at, lease.expires_at]), leaseAfterStop, 'the lease was not renewed once the end was decided');

    // The next tick's journal step probes: applied. The integration is
    // finalized, the work integrated, and then the Stop takes its course.
    await tick(fx.engine, project.id);
    await tickUntil(fx.engine, project.id, () => runRow(fx.home, run.id).state === 'ended', { max: 6, what: 'the run to end once its operation is finalized' });
    const made = opOf();
    assertOperation(made, "the run's integration after the probe");
    assert.deepEqual([made.state, made.status, made.attempts.map((a) => a.status)], ['finalized', 'succeeded', ['reconciled_succeeded']], 'the probe found the write applied and finalized the operation without a new attempt');
    assertRunEnded(fx.home, run.id, { outcome: 'stopped', reason_class: 'human_stop', workspace: 'retained', launched: true });
    const path = withStore(fx.home, (db) => assertWorkHistory(db, item));
    assert.deepEqual([workItem(fx.home, item).status, path.slice(path.lastIndexOf('integrating'))], ['held', ['integrating', 'integrated', 'held']], 'the work went integrating, integrated by the finalizer, then held by the Stop');
    assert.equal(eventsOfType(fx.home, 'work.integrated').filter((event) => event.subject?.work_item === item).length, 1, 'one work.integrated event names the item');
    assert.deepEqual([refOid(repo, project.repo.ref), registryOf(fx.home, project.id)[project.repo.ref].expected_oid, revisionsOf(fx.home, { run: run.id }).map((row) => [row.kind, row.sha])], [sha, sha, [['engine_commit', sha]]], 'the branch is at the commit, the registry expects it there, and one revision records it');
    assert.deepEqual([runsOf(fx.home, item).length, workItem(fx.home, item).repair_attempts], [1, 0], 'one run, no repair: nothing is done twice');
    assertOperations(fx.home, { project: project.id });
    assert.deepEqual(writes.heldLog().map((line) => line.split(' ')[1]), ['update-ref'], 'one write was held in all');
  });
});
