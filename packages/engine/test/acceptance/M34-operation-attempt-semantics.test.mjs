// M34 (slice 3). Plan §3.3 M34 ("operation attempt semantics": "First attempt,
// failure before any effect, failure with ambiguous effect, reconciled
// absent/partial/succeeded, interval before an allowed retry, and linked
// successor. ... Every state has a defined operation projection. First attempt
// is allowed once; retry follows positive reconciliation and keeps logical
// identity. Failed never means proven absent automatically, and
// failed/partial/ambiguous/superseded never completes operation-backed
// work"); build spec §6 correction 16 (Review B17: "State first-attempt
// admission, reconciliation of failed/uncertain attempts, and a total
// operation-status derivation including the interval before an allowed retry.
// Never equate failed with proven absence"); D1 §§2.5, 4.4, 4.5 step 4, 6.2,
// 16, A.5; D1-06, D1-37; SEAM.md §§44, 45; ../contract/journal.json
// (`attempts`).
//
// Every repository mutation is an operation, and each execution of it an
// attempt. An operation's status is not written by hand: it follows from its
// latest attempt, its journal state and whether a linked successor is
// recorded. D1's table left three holes: nothing admitted the first attempt;
// an attempt reconciled absent, with a retry permitted, derived no status;
// and a recorded failure could not be told from proven absence. In force:
//
//   - the operation is committed before its first attempt, attempt 1 is
//     admitted once, and the store refuses a second attempt with a number
//     already used;
//   - a retry is a new attempt of the same operation, admitted only after the
//     previous one was positively reconciled absent, or partial with its
//     remainder declared. Between the reconciliation and the retry the
//     operation is `intended` again (absent) or `partial`;
//   - a failed attempt is never retried on the strength of having failed, and
//     an ambiguous one never before a probe has reconciled it;
//   - a new operation that does what a failed one was to do names it in
//     `linked_prior`, and the failed one is then `superseded`;
//   - only a succeeded, finalized operation completes what depends on it.
//
// The cases take one operation each through one of these, and read its
// attempts, its status against the contract table's derivation, and what
// depended on it. assertOperation, applied to every operation the store
// holds, checks the derivation, the admission rule and the journal's
// legality for all of them.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { releaseBarrier } from './harness/engine.mjs';
import { addGitProject, addItem, permittedEdit, roleThat, roleThatHolds, runToEnd, runToHold } from './harness/gitruns.mjs';
import { armBarrier, assertCommitted, assertOperation, assertOperations, derivedStatus, journalBarrier, operationDetail, operationDetails, recoveryBarrier, registryOf, revisionsOf } from './harness/journal.mjs';
import { ambiguousWorktreeAdd, arrange, effectOf, killedAt, reach } from './harness/probes.mjs';
import { addLinkedWorktree, gitQuiet, refOid } from './harness/repos.mjs';
import { answerDecision, decisionsAbout, run as runRow, runsOf, scriptedEngine, tick, tickUntil, waitForRun, waitForWork, workItem } from './harness/runs.mjs';
import { seedAttempt, seedJournalEvent } from './harness/seed.mjs';
import { assertConstraint } from './harness/store-cases.mjs';
import { step } from './harness/scripted.mjs';
import { openStore, storePath } from './harness/store.mjs';

const statuses = (op) => op.attempts.map((a) => a.status);

describe('M34 the first attempt', () => {
  test('an operation is committed before its first attempt is issued; the attempt is number 1, admitted once, and succeeds when the probe confirms its effect', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThatHolds([permittedEdit()])]);
    const { run } = await runToHold(fx, project.id, item);
    const barrier = journalBarrier('ref_update', 'intent_committed');
    await armBarrier(fx.engine, barrier, 'pause');
    fx.scripted.release(item);
    await fx.engine.waitUntil(`barrier:${barrier}`);

    // The intent is durable and the effect has not been attempted.
    const [intended] = operationDetails(fx.home, { run: run.id, journalKind: 'ref_update' });
    assertOperation(intended, 'the operation at its intent');
    assert.deepEqual(intended.events.map((e) => e.kind), ['intended']);
    assert.ok(intended.attempts.length <= 1, 'at most the first attempt has been issued');
    assert.deepEqual([intended.status, statuses(intended)], intended.attempts.length === 0 ? ['intended', []] : ['in_progress', ['started']], 'with no attempt the operation is intended; with its first attempt started it is in progress');
    assert.equal(refOid(project.repo.path, project.repo.ref), project.base, 'nothing was applied');
    assert.notEqual(workItem(fx.home, item).status, 'integrated', 'and nothing that depends on it is complete');

    await releaseBarrier(fx.engine, barrier);
    await waitForRun(fx.home, item, { state: 'ended' });
    assertCommitted(fx, run.id, { kind: 'engine_commit', parent: project.base, integrated: true });
    const done = assertOperation(operationDetail(fx.home, intended.id), 'the operation after its ordinary course');
    assert.deepEqual([done.attempts.map((a) => [a.attempt_number, a.status]), done.status, done.finalized], [[[1, 'succeeded']], 'succeeded', true], 'one attempt, number 1, succeeded');
    assert.equal(done.attempts[0].finished_at !== null, true);
    // Every operation the run needed took exactly its first attempt.
    for (const op of assertOperations(fx.home, { project: project.id })) {
      assert.deepEqual(op.attempts.map((a) => [a.attempt_number, a.status]), [[1, 'succeeded']], `the ${op.journal_kind} operation took one attempt`);
    }
  });

  test('the store refuses a second attempt with a number already used, and a second journal event with a sequence number already used', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThat([permittedEdit()])]);
    const run = await runToEnd(fx, project.id, item);
    const [op] = operationDetails(fx.home, { run: run.id, journalKind: 'ref_update' });
    assert.deepEqual(statuses(op), ['succeeded'], 'the fixture is live: an operation with its first attempt');
    await fx.engine.stop();
    const db = openStore(storePath(fx.home));
    try {
      assertConstraint(() => seedAttempt(db, project.id, op.id, 1), 'a second attempt 1 of one operation');
      assertConstraint(() => seedAttempt(db, project.id, op.id, 1, 'succeeded'), 'a second attempt 1, whatever its status');
      assertConstraint(() => seedJournalEvent(db, project.id, op.id, 1), 'a second journal event 1 of one operation');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "operation_attempts" WHERE "operation" = ?').get(op.id).n, 1, 'no attempt was added');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "git_journal_events" WHERE "operation" = ?').get(op.id).n, op.events.length, 'no journal event was added');
    } finally {
      db.close();
    }
  });
});

describe('M34 a failed attempt is not proven absence', () => {
  test('a failure before any effect leaves the attempt and the operation failed; nothing retries it, not a tick and not a restart; a new operation that does its work names it as its prior and supersedes it', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const repo = project.repo.path;
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThatHolds([permittedEdit()]), roleThat([step.write('src/other.js', 'export const other = 1;\n')])]);
    const { run } = await runToHold(fx, project.id, item);
    // The integration is refused before its effect: the branch is checked out behind the journaled intent (correction 6).
    const barrier = journalBarrier('ref_update', 'intent_committed');
    await armBarrier(fx.engine, barrier, 'pause');
    fx.scripted.release(item);
    await fx.engine.waitUntil(`barrier:${barrier}`);
    const linked = addLinkedWorktree(repo, join(fx.root, 'developer-late'), { branch: 'main' });
    await releaseBarrier(fx.engine, barrier);
    await waitForRun(fx.home, item, { state: 'ended' });
    const parked = await waitForWork(fx.home, item, 'parked');

    const [first] = operationDetails(fx.home, { run: run.id, journalKind: 'ref_update' });
    assertOperation(first, 'the refused integration');
    assert.deepEqual([first.events.map((e) => e.kind), statuses(first), first.status, first.finalized], [['intended', 'failed'], ['failed'], 'failed', false], 'the attempt failed before any effect, and so did the operation');
    assert.equal(refOid(repo, project.repo.ref), project.base, 'nothing was applied');
    assert.deepEqual([parked.status, runRow(fx.home, run.id).outcome], ['parked', 'failed'], 'a failed operation completes nothing: the work is not integrated');

    // Failed is not absent: no tick and no restart issues another attempt.
    for (let i = 0; i < 2; i++) await tick(fx.engine, project.id);
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, project.id);
    const still = assertOperation(operationDetail(fx.home, first.id), 'the failed operation after ticks and a restart');
    assert.deepEqual([statuses(still), still.status, still.events.length], [['failed'], 'failed', 2], 'it is as it was: one failed attempt, no retry');
    assert.equal(refOid(repo, project.repo.ref), project.base);

    // The work is done again by a person's decision: a new run, a new operation, linked to the failed one.
    gitQuiet(linked, ['checkout', '-q', '--detach']);
    const [blocker] = decisionsAbout(fx.home, item, 'blocker').filter((d) => d.status === 'open');
    await answerDecision(fx.engine, project.id, blocker.id, 'retry');
    const second = await runToEnd(fx, project.id, item, { index: 1 });
    assertCommitted(fx, second.id, { kind: 'engine_commit', parent: project.base, integrated: true, changes: { 'src/other.js': 'A' } });
    const [successor] = operationDetails(fx.home, { run: second.id, journalKind: 'ref_update' });
    assertOperation(successor, 'the successor');
    assert.notEqual(successor.id, first.id, 'a new operation, not a second attempt of the failed one');
    assert.equal(successor.linked_prior, first.id, 'it names the operation it replaces');
    const superseded = assertOperation(operationDetail(fx.home, first.id), 'the superseded operation');
    assert.deepEqual([superseded.status, superseded.successor, superseded.finalized, statuses(superseded)], ['superseded', true, false, ['failed']], 'the failed operation is superseded, and is never finalized');
    assert.equal(registryOf(fx.home, project.id)[project.repo.ref].expected_oid, successor.payload.new_oid, 'the work was integrated by the successor, once');
    assertOperations(fx.home, { project: project.id });
  });

  test('an attempt whose command was killed at its deadline is ambiguous, and so is its operation: it is not retried before a probe has reconciled it, and it completes nothing', async (t) => {
    const ctx = await ambiguousWorktreeAdd(t);
    const { fx, project, item } = ctx;
    const op = assertOperation(operationDetail(fx.home, ctx.op.id), 'the operation after the deadline');
    assert.deepEqual([statuses(op), op.status, op.state, op.finalized], [['ambiguous'], 'ambiguous', 'ambiguous', false], 'the attempt is ambiguous, not failed and not absent');
    assert.equal(fx.scripted.launches({ work_item: item }).length, 0, 'what depended on it did not go on');
    // While the probe cannot tell, no new attempt is issued.
    for (let i = 0; i < 2; i++) await tick(fx.engine, project.id);
    assert.deepEqual(statuses(operationDetail(fx.home, op.id)), ['ambiguous'], 'no attempt was issued on top of an ambiguous one');
    ctx.letGo();
    await tickUntil(fx.engine, project.id, () => runsOf(fx.home, item)[1]?.state === 'ended', { max: 6, what: 'the repair run to have run' });
    const reconciled = assertOperation(operationDetail(fx.home, op.id), 'the operation after its reconciliation');
    assert.deepEqual([statuses(reconciled), reconciled.attempts[0].reads.at(-1).result], [['reconciled_absent'], 'absent'], 'the probe reconciled it: absent, on the record');
    assertOperations(fx.home, { project: project.id });
  });
});

describe('M34 reconciliation, and the interval before an allowed retry', () => {
  test('reconciled succeeded: an attempt whose effect was applied and never recorded is reconciled, not repeated, and its operation has succeeded', async (t) => {
    // Killed after the swap and before its receipt: the attempt was issued, and the journal knows nothing of its effect.
    const ctx = await killedAt(t, 'ref_update', 'effect_applied');
    assert.deepEqual([statuses(ctx.op), ctx.op.status, ctx.op.events.map((e) => e.kind)], [['started'], 'in_progress', ['intended']], 'the fixture is live: one attempt in flight, nothing recorded of its effect');
    assert.equal(effectOf(ctx), 'applied');
    await ctx.fx.start();
    const op = assertOperation(operationDetail(ctx.fx.home, ctx.op.id));
    assert.deepEqual([op.attempts.map((a) => [a.attempt_number, a.status]), op.status, op.finalized], [[[1, 'reconciled_succeeded']], 'succeeded', true], 'the same attempt, reconciled as succeeded: nothing was executed again');
    assert.equal(op.attempts[0].reads.at(-1).result, 'applied', 'the reconciliation records what the probe found');
    assert.equal(workItem(ctx.fx.home, ctx.item).status, 'integrated', 'a succeeded, finalized operation completes what depends on it');
  });

  test('reconciled absent: between the reconciliation and the retry the operation is intended again, with no attempt in flight; the retry is attempt 2 of the same operation', async (t) => {
    // Killed after the swap and its receipt; the branch is then put back by hand: an attempt that was issued, whose effect is positively absent.
    const ctx = await reach(t, 'ref_update', 'applied');
    arrange(ctx, 'absent');
    assert.deepEqual(statuses(ctx.op), ['started'], 'the fixture is live: one attempt, in flight when the engine died');
    const barrier = recoveryBarrier('ref_update');
    const engine = await ctx.fx.start({ barriers: [`${barrier}=pause`], until: `barrier:${barrier}` });

    const interval = assertOperation(operationDetail(ctx.fx.home, ctx.op.id), 'the operation in the interval');
    assert.deepEqual(statuses(interval), ['reconciled_absent'], 'the attempt is reconciled absent, and no second attempt has been issued');
    assert.equal(interval.attempts[0].reads.at(-1).result, 'absent', 'the reconciliation records what the probe found');
    assert.deepEqual([interval.status, derivedStatus(interval), interval.finalized], ['intended', 'intended', false], 'in the interval the operation is intended: the effect is absent and nothing is in flight');
    assert.equal(effectOf(ctx), 'absent', 'nothing has been applied again yet');
    assert.notEqual(workItem(ctx.fx.home, ctx.item).status, 'integrated', 'and nothing that depends on it is complete');

    await releaseBarrier(engine, barrier);
    await engine.waitUntil('full');
    const done = assertOperation(operationDetail(ctx.fx.home, ctx.op.id), 'the operation after its retry');
    assert.deepEqual([done.attempts.map((a) => [a.attempt_number, a.status]), done.status, done.finalized], [[[1, 'reconciled_absent'], [2, 'succeeded']], 'succeeded', true], 'the retry is attempt 2');
    assert.deepEqual([done.id, done.idempotency_key], [ctx.op.id, ctx.op.idempotency_key], 'of the same operation: it keeps its logical identity');
    assert.equal(operationDetails(ctx.fx.home, { run: ctx.run.id, journalKind: 'ref_update' }).length, 1, 'no second operation was recorded');
    assert.equal(effectOf(ctx), 'applied');
    assert.equal(workItem(ctx.fx.home, ctx.item).status, 'integrated');
  });

  test('reconciled partial: with the remainder declared the operation is partial, and completes nothing, until a new attempt has completed it', async (t) => {
    // The commit exists and its keep ref does not: the publication is the bounded remainder.
    const ctx = await reach(t, 'commit_tree', 'applied');
    arrange(ctx, 'partial');
    assert.deepEqual(statuses(ctx.op), ['started']);
    const barrier = recoveryBarrier('commit_tree');
    const engine = await ctx.fx.start({ barriers: [`${barrier}=pause`], until: `barrier:${barrier}` });

    const interval = assertOperation(operationDetail(ctx.fx.home, ctx.op.id), 'the operation in the interval');
    assert.deepEqual([statuses(interval), interval.attempts[0].reads.at(-1).result], [['reconciled_partial'], 'partial']);
    assert.deepEqual([interval.status, derivedStatus(interval), interval.finalized], ['partial', 'partial', false], 'the operation is partial');
    assert.ok(interval.remaining_scope !== null && typeof interval.remaining_scope === 'object' && Object.keys(interval.remaining_scope).length > 0, `the remaining effect is declared (remaining_scope: ${JSON.stringify(interval.remaining_scope)})`);
    assert.deepEqual(revisionsOf(ctx.fx.home, { run: ctx.run.id }), [], 'a partial operation completes nothing: no revision records the commit');

    await releaseBarrier(engine, barrier);
    await engine.waitUntil('full');
    const done = assertOperation(operationDetail(ctx.fx.home, ctx.op.id), 'the operation after its completion');
    assert.deepEqual([done.attempts.map((a) => [a.attempt_number, a.status]), done.status, done.finalized], [[[1, 'reconciled_partial'], [2, 'succeeded']], 'succeeded', true]);
    assert.equal(done.id, ctx.op.id);
    assert.deepEqual(revisionsOf(ctx.fx.home, { run: ctx.run.id }).map((r) => r.sha), [ctx.sha], 'the commit the first attempt made is the one recorded');
  });
});
