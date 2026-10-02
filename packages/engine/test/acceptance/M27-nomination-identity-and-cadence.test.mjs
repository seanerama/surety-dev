// M27 (slice 3). Plan §3.3 M27 ("nomination identity and cadence": "T2 stage
// completion, T1 explicit nomination request, and a T2 Builder request before
// the cadence point. ... Engine nominates only at allowed points;
// candidate/ref/lineage succession agree and are immutable. Early T2 request
// cannot bypass cadence. Source changes after nomination retain the old
// candidate/evidence and create successor lineage work"); E11 (a candidate is
// a revision the engine has nominated; checkpoints are never candidates;
// nomination at build-stage completion for T2 and T3, at phase completion or
// on the Builder's request for T1); E18 (nomination refs are immutable
// engine-owned refs); D1 §§3.3, 7.2, 7.7; D1-18; build spec §6 correction 14;
// SEAM.md §§26, 40, 42; ../contract/journal.json (`finalizers`).
//
// A nomination is journaled: the immutable ref refs/surety/cand/<seq> is
// written by a ref update, and that operation's finalizer writes the
// candidate, registers the ref, closes the candidate's lineage and opens its
// successor, creates the candidate's verification work and moves the
// Builder's integrated work to `verifying`. The Builder asks with the result
// field `nominate: true`; the engine performs it, and only where the tier's
// cadence allows.
//
// Nothing here asserts a gate: M1 computes the `stage` and `alpha_authorize`
// gates in slice 5. T1's nomination at phase completion is not pinned: phase
// verification is not in M1 (COVERAGE.md).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { releaseBarrier, within } from './harness/engine.mjs';
import { assertWorkHistory } from './harness/invariants.mjs';
import { addGitProject, addItem, addStagedProject, permittedEdit, roleThat, roleThatHolds, runToEnd, runToHold, waitForCandidates } from './harness/gitruns.mjs';
import {
  armBarrier,
  assertCommitted,
  assertOperation,
  assertOperations,
  assertOrdinaryCourse,
  candidatesOf,
  journalBarrier,
  lineagesOf,
  operationDetails,
  outOfBand,
  receiptSnapshot,
  registryOf,
  revisionsOf,
  workItemsOf,
} from './harness/journal.mjs';
import { refOid, refsOf } from './harness/repos.mjs';
import { requestTick, run as runRow, runsOf, scriptedEngine, tick, workItem } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const candidateRefs = (repo) =>
  Object.entries(refsOf(repo))
    .filter(([ref]) => ref.startsWith('refs/surety/cand/'))
    .sort();
const nominationOps = (home, project) => operationDetails(home, { project, journalKind: 'ref_update' }).filter((op) => op.payload.ref.startsWith('refs/surety/cand/'));
const ticks = async (fx, project, n = 2) => {
  for (let i = 0; i < n; i++) await tick(fx.engine, project);
};

// One candidate, in full: its row, its ref in git and in the registry, its
// lineage closed and the successor opened from it, the revision it names
// recorded on the lineage it closed, its journaled ref update, its
// verification work. `expect`: {seq, revision, by, from}; `from` is the
// candidate whose successor lineage this one's revision was recorded on
// (null for the first).
function assertCandidate(fx, project, candidate, expect) {
  const what = `candidate ${expect.seq}`;
  const ref = `refs/surety/cand/${expect.seq}`;
  assert.deepEqual(
    { seq: candidate.seq, revision: candidate.revision, nominated_by: candidate.nominated_by, progress: candidate.progress },
    { seq: expect.seq, revision: expect.revision, nominated_by: expect.by, progress: 'developing' },
    `${what}: its row names the nominated revision and who nominated`,
  );
  assert.equal(refOid(project.repo.path, ref), expect.revision, `${what}: ${ref} points at the nominated revision`);
  assert.deepEqual(registryOf(fx.home, project.id)[ref], { kind: 'nomination', expected_oid: expect.revision, immutable: 1 }, `${what}: the ref is registered as an immutable nomination ref`);

  const lineages = lineagesOf(fx.home, project.id);
  const own = lineages.find((lineage) => lineage.id === candidate.lineage);
  assert.ok(own, `${what}: its lineage exists`);
  assert.deepEqual([own.open, own.started_from_candidate], [0, expect.from], `${what}: its lineage is closed, and was started from ${expect.from ?? 'no candidate'}`);
  const successors = lineages.filter((lineage) => lineage.started_from_candidate === candidate.id);
  assert.equal(successors.length, 1, `${what}: exactly one successor lineage was started from it`);
  const [revision] = revisionsOf(fx.home, { project: project.id }).filter((row) => row.sha === expect.revision);
  assert.equal(revision.lineage, own.id, `${what}: the nominated revision was recorded on the lineage the nomination closed`);

  const ops = nominationOps(fx.home, project.id).filter((op) => op.payload.ref === ref);
  assert.equal(ops.length, 1, `${what}: one journaled ref update wrote the ref`);
  assertOperation(ops[0], `${what}, its ref update`);
  assert.deepEqual([ops[0].events.map((e) => e.kind), ops[0].status], [['intended', 'applied', 'confirmed', 'finalized'], 'succeeded'], `${what}: the ref update ran its course`);
  assert.deepEqual({ old_oid: ops[0].payload.old_oid ?? null, new_oid: ops[0].payload.new_oid }, { old_oid: null, new_oid: expect.revision }, `${what}: it creates the ref at the revision`);
  assert.ok(ops[0].payload.run === undefined || ops[0].payload.run === null, `${what}: the nomination is the engine's act: its journal names no run`);

  const verification = workItemsOf(fx.home, project.id).filter((work) => work.kind === 'verification' && work.subject?.candidate === candidate.id);
  assert.equal(verification.length, 1, `${what}: exactly one verification work item is the candidate's`);
  assert.deepEqual(
    { source: verification[0].trigger_source, id: verification[0].trigger_id, generation: verification[0].trigger_generation },
    { source: 'nomination', id: candidate.id, generation: 1 },
    `${what}: its verification work is triggered by the nomination`,
  );
  return { ref, lineage: own, successor: successors[0], verification: verification[0] };
}

describe('M27 the engine nominates at the cadence point of the tier', () => {
  test('T2: the completion of a stage nominates the integrated revision: candidate, immutable ref and lineage succession agree, and the work is being verified', async (t) => {
    const fx = await scriptedEngine(t);
    const { project, items } = await addStagedProject(fx, { tier: 'T2' });
    fx.scripted.script(items[0], [roleThat([permittedEdit()])]);
    const run = await runToEnd(fx, project.id, items[0]);
    const committed = assertCommitted(fx, run.id, { kind: 'engine_commit', parent: project.base, integrated: true });
    const candidates = await waitForCandidates(fx, project.id);
    assert.equal(candidates.length, 1, 'one candidate');
    const made = assertCandidate(fx, project, candidates[0], { seq: 1, revision: committed.sha, by: 'engine_cadence', from: null });
    assert.deepEqual(candidateRefs(project.repo.path), [[made.ref, committed.sha]], 'one nomination ref');
    assert.deepEqual(lineagesOf(fx.home, project.id).filter((lineage) => lineage.open === 1).map((lineage) => lineage.id), [made.successor.id], 'exactly one lineage is open: the successor');
    assert.equal(made.verification.status, 'eligible');
    const path = withStore(fx.home, (db) => assertWorkHistory(db, items[0]));
    assert.deepEqual(path.slice(-2), ['integrated', 'verifying'], `the stage's work is being verified (path ${path.join(' → ')})`);
    assert.deepEqual(revisionsOf(fx.home, { run: run.id }).map((row) => row.kind), ['engine_commit'], "the run's revision keeps the kind it was recorded with");

    // The engine's own nomination is not out of band, and is made once.
    await ticks(fx, project.id);
    await fx.engine.kill();
    await fx.start();
    await ticks(fx, project.id);
    assert.deepEqual(outOfBand(fx.home, project.id), []);
    assert.equal(candidatesOf(fx.home, project.id).length, 1, 'ticks and a restart nominate nothing again');
    assertOperations(fx.home, { project: project.id });
  });

  test('T1: the completion of a stage nominates nothing; the work stays integrated', async (t) => {
    const fx = await scriptedEngine(t);
    const { project, items } = await addStagedProject(fx, { tier: 'T1' });
    fx.scripted.script(items[0], [roleThat([permittedEdit()])]);
    const run = await runToEnd(fx, project.id, items[0]);
    assertCommitted(fx, run.id, { kind: 'engine_commit', parent: project.base, integrated: true });
    await ticks(fx, project.id);
    assert.deepEqual([candidatesOf(fx.home, project.id), candidateRefs(project.repo.path)], [[], []], 'no candidate, no nomination ref');
    assert.equal(lineagesOf(fx.home, project.id).filter((lineage) => lineage.open === 1).length, 1, 'the lineage is still open');
    assert.equal(workItem(fx.home, items[0]).status, 'integrated', 'the work is integrated, and not yet being verified');
    assert.deepEqual(workItemsOf(fx.home, project.id).filter((work) => work.kind === 'verification'), [], 'no verification work was created');
  });

  test("T1: a Builder's request, `nominate: true`, is performed by the engine: the integrated revision is nominated by builder_request", async (t) => {
    const fx = await scriptedEngine(t);
    const { project, items } = await addStagedProject(fx, { tier: 'T1' });
    fx.scripted.script(items[0], [roleThat([permittedEdit()], { nominate: true })]);
    const run = await runToEnd(fx, project.id, items[0]);
    const committed = assertCommitted(fx, run.id, { kind: 'engine_commit', parent: project.base, integrated: true });
    const candidates = await waitForCandidates(fx, project.id);
    assert.equal(candidates.length, 1);
    assertCandidate(fx, project, candidates[0], { seq: 1, revision: committed.sha, by: 'builder_request', from: null });
    assert.equal(workItem(fx.home, items[0]).status, 'verifying');
    await ticks(fx, project.id);
    assert.equal(candidatesOf(fx.home, project.id).length, 1);
  });

  test("T2: a Builder's request before the cadence point is not a nomination: the run is integrated as usual and no candidate exists", async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx, { tier: 'T2' });
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThat([permittedEdit()], { nominate: true })]);
    const run = await runToEnd(fx, project.id, item);
    assertCommitted(fx, run.id, { kind: 'engine_commit', parent: project.base, integrated: true });
    await ticks(fx, project.id);
    assert.deepEqual([candidatesOf(fx.home, project.id), candidateRefs(project.repo.path), nominationOps(fx.home, project.id)], [[], [], []], 'the request did not bypass the cadence: no candidate, no ref, no journaled nomination');
    assert.equal(workItem(fx.home, item).status, 'integrated');
  });

  test('T1: a checkpoint is never a candidate, although the Builder asked for a nomination with it', async (t) => {
    const fx = await scriptedEngine(t);
    const { project, items } = await addStagedProject(fx, { tier: 'T1' });
    fx.scripted.script(items[0], [roleThat([step.write('src/part-one.js', 'export const one = 1;\n')], { checkpoint: true, nominate: true })]);
    const run = await runToEnd(fx, project.id, items[0]);
    assertCommitted(fx, run.id, { kind: 'checkpoint', parent: project.base, integrated: false, branchAt: project.base });
    assert.deepEqual([candidatesOf(fx.home, project.id), candidateRefs(project.repo.path)], [[], []], 'a checkpoint is a working revision');
    assert.equal(lineagesOf(fx.home, project.id).filter((lineage) => lineage.open === 1).length, 1);
  });

  test('a `nominate` that is not a boolean makes the result invalid', async (t) => {
    const fx = await scriptedEngine(t, { config: {} });
    const { project, items } = await addStagedProject(fx, { tier: 'T1' });
    fx.scripted.script(items[0], [roleThat([permittedEdit()], { nominate: 'yes' })]);
    const run = await runToEnd(fx, project.id, items[0]);
    assert.deepEqual([run.outcome, run.reason_class], ['failed', 'invalid_result']);
    assert.equal(refOid(project.repo.path, project.repo.ref), project.base, 'nothing was integrated');
    assert.deepEqual(candidatesOf(fx.home, project.id), []);
  });
});

describe('M27 a candidate is immutable, and later source changes land on its successor lineage', () => {
  test('a second stage integrated after a nomination is recorded on the successor lineage and nominated as the next candidate; the first candidate, its ref and its lineage are as they were', async (t) => {
    const fx = await scriptedEngine(t);
    const { project, items } = await addStagedProject(fx, { tier: 'T2', stages: 2 });
    fx.scripted.script(items[0], [roleThat([step.write('src/stage-one.js', 'export const stage = 1;\n')])]);
    fx.scripted.script(items[1], [roleThat([step.write('src/stage-two.js', 'export const stage = 2;\n')])]);
    const firstRun = await runToEnd(fx, project.id, items[0]);
    const one = assertCommitted(fx, firstRun.id, { kind: 'engine_commit', parent: project.base, integrated: true });
    const [first] = await waitForCandidates(fx, project.id);
    const firstMade = assertCandidate(fx, project, first, { seq: 1, revision: one.sha, by: 'engine_cadence', from: null });

    // The source changes: the second stage is built on the nominated revision.
    const secondRun = await runToEnd(fx, project.id, items[1]);
    const two = assertCommitted(fx, secondRun.id, { kind: 'engine_commit', parent: one.sha, integrated: true });
    const candidates = await waitForCandidates(fx, project.id, 2);
    assert.equal(candidates.length, 2);
    assert.deepEqual(
      (({ id, seq, revision, lineage, nominated_by, nominated_at }) => ({ id, seq, revision, lineage, nominated_by, nominated_at }))(candidates[0]),
      (({ id, seq, revision, lineage, nominated_by, nominated_at }) => ({ id, seq, revision, lineage, nominated_by, nominated_at }))(first),
      'the first candidate is as it was nominated',
    );
    assertCandidate(fx, project, candidates[0], { seq: 1, revision: one.sha, by: 'engine_cadence', from: null });
    const secondMade = assertCandidate(fx, project, candidates[1], { seq: 2, revision: two.sha, by: 'engine_cadence', from: first.id });
    assert.equal(secondMade.lineage.id, firstMade.successor.id, "the second candidate's lineage is the successor the first nomination opened");
    assert.deepEqual(candidateRefs(project.repo.path), [['refs/surety/cand/1', one.sha], ['refs/surety/cand/2', two.sha]], 'both nomination refs are where they were written');
    assert.deepEqual(lineagesOf(fx.home, project.id).filter((lineage) => lineage.open === 1).map((lineage) => lineage.id), [secondMade.successor.id], 'one lineage is open: the newest successor');
    assert.equal(lineagesOf(fx.home, project.id).length, 3, 'three lineages: two closed by their candidates, one open');
    assert.notEqual(firstMade.verification.id, secondMade.verification.id, 'each candidate has verification work of its own');
    assert.deepEqual([workItem(fx.home, items[0]).status, workItem(fx.home, items[1]).status], ['verifying', 'verifying']);
    assertOperations(fx.home, { project: project.id });
  });
});

describe('M27 a nomination that a crash interrupts is completed by its finalizer, once', () => {
  test('killed after the nomination ref was written and confirmed, before the finalizer: the restart writes the candidate, registers the ref and succeeds the lineage, and a second restart writes nothing again (D1-18)', async (t) => {
    const fx = await scriptedEngine(t);
    const { project, items } = await addStagedProject(fx, { tier: 'T2' });
    fx.scripted.script(items[0], [roleThatHolds([permittedEdit()])]);
    await runToHold(fx, project.id, items[0]);
    // Let the integration through, then kill the engine at the next ref update's confirmation: the nomination's.
    const integrated = journalBarrier('ref_update', 'finalizer_committed');
    const confirmed = journalBarrier('ref_update', 'probe_confirmed');
    await armBarrier(fx.engine, integrated, 'pause');
    fx.scripted.release(items[0]);
    await fx.engine.waitUntil(`barrier:${integrated}`);
    assert.deepEqual(nominationOps(fx.home, project.id), [], 'the fixture is live: the integration is finalized and nothing is nominated yet');
    await armBarrier(fx.engine, confirmed, 'kill');
    const dead = fx.engine;
    await releaseBarrier(dead, integrated);
    await requestTick(dead, project.id).catch(() => {});
    assert.deepEqual(await within(dead.exited, 20_000), { code: null, signal: 'SIGKILL' }, `the engine kills itself at ${confirmed}, in the nomination`);

    const [left] = nominationOps(fx.home, project.id);
    assert.ok(left, 'the nomination was journaled');
    assert.deepEqual(left.events.slice(0, 3).map((e) => e.kind), ['intended', 'applied', 'confirmed']);
    assert.equal(refOid(project.repo.path, left.payload.ref), left.payload.new_oid, 'the ref is written');
    assert.equal(candidatesOf(fx.home, project.id).length, left.finalized ? 1 : 0, 'the candidate exists exactly when the journal says finalized');

    await fx.start();
    const [run] = runsOf(fx.home, items[0]);
    // The recovery step visits a confirmed operation and runs its finalizer: before full mode, with no tick.
    const candidates = candidatesOf(fx.home, project.id);
    assert.equal(candidates.length, 1, 'the candidate was written by the finalizer during recovery, before full mode');
    const made = assertCandidate(fx, project, candidates[0], { seq: 1, revision: left.payload.new_oid, by: 'engine_cadence', from: null });
    assert.equal(workItem(fx.home, items[0]).status, 'verifying');
    assert.equal(runRow(fx.home, run.id).state, 'ended');

    const receipts = receiptSnapshot(fx.home, project.id);
    await fx.engine.kill();
    await fx.start();
    await ticks(fx, project.id);
    assert.deepEqual(receiptSnapshot(fx.home, project.id), receipts, 'a second restart and further ticks write nothing again: the same candidate, ref, lineages and verification work');
    assert.equal(made.verification.id, workItemsOf(fx.home, project.id).find((work) => work.kind === 'verification').id);
    assert.deepEqual(outOfBand(fx.home, project.id), [], "the engine's own nomination ref is not out of band");
  });

  test('killed after a T2 stage was integrated and before it was nominated: the stage is still nominated after the restart, once', async (t) => {
    const barrier = journalBarrier('ref_update', 'finalizer_committed');
    const fx = await scriptedEngine(t, { barriers: [`${barrier}=kill`] });
    const { project, items } = await addStagedProject(fx, { tier: 'T2' });
    fx.scripted.script(items[0], [roleThat([permittedEdit()])]);
    const dead = fx.engine;
    await requestTick(dead, project.id).catch(() => {});
    assert.deepEqual(await within(dead.exited, 20_000), { code: null, signal: 'SIGKILL' }, `the engine kills itself at ${barrier}, in the integration`);
    const integrated = refOid(project.repo.path, project.repo.ref);
    assert.notEqual(integrated, project.base, 'the stage is integrated');
    assert.deepEqual(candidatesOf(fx.home, project.id), [], 'and not yet nominated');

    await fx.start();
    const candidates = await waitForCandidates(fx, project.id);
    assert.equal(candidates.length, 1);
    assertCandidate(fx, project, candidates[0], { seq: 1, revision: integrated, by: 'engine_cadence', from: null });
    await ticks(fx, project.id);
    assert.equal(candidatesOf(fx.home, project.id).length, 1, 'once');
    assert.equal(workItem(fx.home, items[0]).status, 'verifying');
    assertOperations(fx.home, { project: project.id });
    assert.deepEqual(operationDetails(fx.home, { project: project.id }).filter((op) => !op.finalized).map((op) => op.id), [], 'every journaled operation is finalized');
    assertOrdinaryCourse(nominationOps(fx.home, project.id)[0], 'the nomination');
  });
});
