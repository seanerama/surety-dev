// M13, Stop while the run's work is integrating or integrated (slice 3,
// second session). Plan §3.2 M13 ("At every reachable state still owning a
// Run—including integrated/awaiting-decision if reachable—request Stop. ...
// New role effects are fenced immediately; cleanup can persist usage. The Run
// cannot report ended until termination is observed. Workspace retained, work
// held, grant revoked and execution lease released only through cleanup. ...
// Resume requires an explicit command and a new Run"); D1 §§4.5 (step 4:
// "Reconcile issued effects"), 8.3, 8.4, 15.3; build spec §6 corrections 11
// and 14; SEAM.md §§17, 33, 47; ../contract/work-items.json (Stop from
// `integrating` and from `integrated`).
//
// Slice 2 stopped runs that were claimed or executing. A Builder's run owns
// its work for longer: while its commit is being integrated (`integrating`)
// and after the integration's finalizer has run, until the run has ended
// (`integrated`). A Stop is admitted in both. What it finds under way is a
// journaled ref update, and the run-end protocol reconciles what the run
// issued before the run ends (D1 §4.5 step 4):
//
//   - an integration whose effect has not been made is not made: the lease is
//     closing, and an effect on behalf of a closing lease is refused. The
//     operation is failed, the branch is where it was, the work is held;
//   - an integration whose effect was made is recorded and finalized: the
//     branch has moved, and the registry and the work item must say so. The
//     work is integrated, and then held;
//   - nothing is undone, and the run is not ended while its operation is in
//     flight.
//
// `verifying` is not reached by a Stop: when a Builder's work is being
// verified, its own run has ended, and the run that is under way belongs to
// the candidate's verification work. The last case pins that.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { releaseBarrier } from './harness/engine.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { assertWorkHistory } from './harness/invariants.mjs';
import { PERMITTED_EDIT, addStagedProject, pausedIntegration, permittedEdit, roleThat, runToEnd, waitForCandidates } from './harness/gitruns.mjs';
import { assertCommitted, assertOperation, assertOperations, operationDetails, outOfBand, registryOf, revisionsOf, workItemsOf } from './harness/journal.mjs';
import { changedPaths, refOid, refsContaining } from './harness/repos.mjs';
import { answerDecision, assertRunEnded, decisionsAbout, leasesOf, resumeWork, run as runRow, runsOf, scriptedEngine, stopRun, tick, tickUntil, waitForRun, waitForRunState, workItem } from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const integration = (fx, run) => operationDetails(fx.home, { run: run.id, journalKind: 'ref_update' })[0];

// Stop while the integration waits at its barrier, then let the barrier go.
// The run is not ended while its operation is in flight.
async function stopAtBarrier(ctx) {
  const { fx, project, run, barrier } = ctx;
  await stopRun(fx.engine, project.id, run.id);
  for (const lease of leasesOf(fx.home, run.id)) assert.ok(lease.closing === 1 || lease.released_at !== null, 'when Stop is answered the run lease is closing or already released');
  await sleep(1500);
  assert.notEqual(runRow(fx.home, run.id).state, 'ended', 'the run is not ended while an operation it issued is in flight: issued effects are reconciled first');
  await releaseBarrier(fx.engine, barrier);
  await waitForRunState(fx.home, run.id, 'ended');
  return assertRunEnded(fx.home, run.id, { outcome: 'stopped', reason_class: 'human_stop', workspace: 'retained', launched: true, recovery: false });
}

// Held work is not dispatched by itself; an explicit Resume gives it a new
// run, linked to the stopped one, which is committed and integrated on
// whatever the branch then holds.
async function assertResumeIntegrates(ctx, { parent }) {
  const { fx, project, item, run } = ctx;
  await tick(fx.engine, project.id);
  assert.deepEqual([runsOf(fx.home, item).length, workItem(fx.home, item).status], [1, 'held'], 'held work is not dispatched again by the scheduler');
  await resumeWork(fx.engine, project.id, item);
  const second = await tickUntil(fx.engine, project.id, () => (runsOf(fx.home, item)[1]?.state === 'ended' ? runsOf(fx.home, item)[1] : undefined), { max: 6, what: 'the resumed work to have run' });
  assert.equal(second.parent_run, run.id, 'the new run is linked to the run that was stopped');
  assertCommitted(fx, second.id, { kind: 'engine_commit', parent, integrated: true, changes: { 'src/second.js': 'A' } });
  assert.equal(fx.scripted.launches({ work_item: item }).length, 2, 'one launch more');
  withStore(fx.home, (db) => assertWorkHistory(db, item));
  assertOperations(fx.home, { project: project.id });
  assert.deepEqual(outOfBand(fx.home, project.id), []);
}

describe('M13 Stop while the work is integrating', () => {
  test('before the swap: the integration is not made, its operation is failed, the branch stays where it was, the work is held, and Resume integrates a new run', async (t) => {
    const ctx = await pausedIntegration(t, 'intent_committed');
    const { fx, project, item, run } = ctx;
    assert.equal(workItem(fx.home, item).status, 'integrating', 'the fixture is live: the work is integrating');
    assert.deepEqual(integration(fx, run).events.map((e) => e.kind), ['intended']);
    const stopped = await stopAtBarrier(ctx);

    const op = assertOperation(integration(fx, run), 'the integration that was stopped');
    assert.deepEqual([op.events.map((e) => e.kind), op.status, op.finalized, op.attempts.map((a) => a.status)], [['intended', 'failed'], 'failed', false, op.attempts.length === 0 ? [] : ['failed']], 'the effect was refused before it was made');
    assert.equal(refOid(project.repo.path, project.repo.ref), project.base, 'the integration branch has not moved');
    assert.equal(registryOf(fx.home, project.id)[project.repo.ref].expected_oid, project.base);
    assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, item)), ['eligible', 'claimed', 'executing', 'integrating', 'held'], 'the work was integrating, and is held');
    // Nothing is undone: the commit the run made stays recorded and reachable, off the branch.
    const [revision] = revisionsOf(fx.home, { run: run.id });
    assert.ok(revision && refsContaining(project.repo.path, revision.sha).some((ref) => ref.startsWith('refs/surety/keep/')), "the run's commit is kept");
    assert.deepEqual(stopped.receipts[0].usage.map((u) => JSON.parse(u.raw)), [{ input_tokens: 11 }], 'usage observed before the Stop is kept');
    assertRefused(await fx.engine.post(`/v1/projects/${project.id}/runs/${run.id}/stop`, {}), 409, 'illegal_transition', 'Stop on a run that has ended');
    await assertResumeIntegrates(ctx, { parent: project.base });
  });

  test('with the swap made and not yet recorded: the operation in flight is reconciled and finalized, the work is integrated and then held, and nothing is undone', async (t) => {
    const ctx = await pausedIntegration(t, 'effect_applied');
    const { fx, project, item, run } = ctx;
    const moved = integration(fx, run);
    assert.deepEqual([moved.events.map((e) => e.kind), refOid(project.repo.path, project.repo.ref)], [['intended'], moved.payload.new_oid], 'the fixture is live: the branch has moved and nothing records it');
    await stopAtBarrier(ctx);

    const op = assertOperation(integration(fx, run), 'the integration that was in flight');
    assert.deepEqual([op.state, op.status, op.finalized], ['finalized', 'succeeded', true], `an effect that was made is recorded and finalized (events: ${op.events.map((e) => e.kind).join(', ')})`);
    assert.equal(op.attempts.length, 1, 'by the attempt that made it: the swap was not repeated');
    const sha = moved.payload.new_oid;
    assert.equal(refOid(project.repo.path, project.repo.ref), sha, 'the branch is where the swap put it');
    assert.equal(registryOf(fx.home, project.id)[project.repo.ref].expected_oid, sha, 'and the registry expects it there');
    assert.deepEqual(changedPaths(project.repo.path, project.base, sha), { [PERMITTED_EDIT.path]: 'A' });
    assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, item)), ['eligible', 'claimed', 'executing', 'integrating', 'integrated', 'held'], 'the work was integrated by the finalizer, and then held by the Stop');
    await assertResumeIntegrates(ctx, { parent: sha });
  });
});

describe('M13 Stop while the work is integrated and its run has not ended', () => {
  test('the run ends stopped, the integrated work is held, the integration stands, and Resume starts a new run from the new head', async (t) => {
    const ctx = await pausedIntegration(t, 'finalizer_committed');
    const { fx, project, item, run } = ctx;
    assert.equal(workItem(fx.home, item).status, 'integrated', 'the fixture is live: the work is integrated and its run has not ended');
    assert.notEqual(runRow(fx.home, run.id).state, 'ended');
    const before = integration(fx, run);
    await stopAtBarrier(ctx);
    const op = assertOperation(integration(fx, run));
    assert.deepEqual([op.events.map((e) => e.kind), op.status], [before.events.map((e) => e.kind), 'succeeded'], 'the finalized integration is as it was');
    assert.equal(refOid(project.repo.path, project.repo.ref), before.payload.new_oid);
    assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, item)), ['eligible', 'claimed', 'executing', 'integrating', 'integrated', 'held']);
    await assertResumeIntegrates(ctx, { parent: before.payload.new_oid });
  });
});

describe('M13 work that is being verified is owned by no run of its own', () => {
  test("stopping a candidate's verification run holds the verification work; the Builder's work stays verifying, its ended run cannot be stopped, and it is still verifying once a resumed verification completes", async (t) => {
    const fx = await scriptedEngine(t);
    const { project, items } = await addStagedProject(fx, { tier: 'T2' });
    fx.scripted.script(items[0], [roleThat([permittedEdit()])]);
    const built = await runToEnd(fx, project.id, items[0]);
    const [candidate] = await waitForCandidates(fx, project.id);
    const verification = workItemsOf(fx.home, project.id).find((work) => work.kind === 'verification' && work.subject?.candidate === candidate.id);
    fx.scripted.script(verification.id, [script.hold('gate'), script.complete()]);
    assert.equal(workItem(fx.home, items[0]).status, 'verifying');
    assertRefused(await fx.engine.post(`/v1/projects/${project.id}/runs/${built.id}/stop`, {}), 409, 'illegal_transition', "Stop on the Builder's run, which has ended");

    // The human step at the chain boundary lets the verification run; it is then stopped.
    const [boundary] = (await tickUntil(fx.engine, project.id, () => { const open = decisionsAbout(fx.home, verification.id, 'blocker').filter((d) => d.status === 'open'); return open.length > 0 ? open : undefined; }, { max: 4, what: 'the chain boundary decision' }));
    await answerDecision(fx.engine, project.id, boundary.id, 'continue');
    await tick(fx.engine, project.id);
    const verifying = await waitForRun(fx.home, verification.id, { state: 'executing' });
    await fx.scripted.waitForHolding({ work_item: verification.id });
    await stopRun(fx.engine, project.id, verifying.id);
    await waitForRunState(fx.home, verifying.id, 'ended');
    assert.deepEqual([workItem(fx.home, verification.id).status, workItem(fx.home, items[0]).status], ['held', 'verifying'], 'the verification work is held; the work it verifies is still being verified');

    await resumeWork(fx.engine, project.id, verification.id);
    await tickUntil(fx.engine, project.id, () => workItem(fx.home, verification.id).status === 'complete', { max: 6, what: 'the resumed verification to complete' });
    assert.equal(workItem(fx.home, items[0]).status, 'verifying', "the resumed verification's completion does not complete the stage's work: that is its stage gate's (row M44), and this fixture declares no check");
    assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, items[0])), ['eligible', 'claimed', 'executing', 'integrating', 'integrated', 'verifying']);
  });
});
