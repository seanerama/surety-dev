// M01, the minimum successful kernel journey (slice 5). Plan §3.1 M01; D1
// §§3.1, 7.7, 7.8, 9, 19.3 and the M1 parts of D1-01, D1-18 and D1-25; RN §4;
// build spec §3 and §5 ("engine home"); SEAM.md §§27, 28, 30, 40, 42, 67,
// 68, 70, 75, 86; E36 item 3.
//
// The journey is the central target of the slice-5 build: it is the one
// place where the parts slices 1 to 5 build are made to work together, from
// a project's creation to an issued Alpha authorization. It needs nothing of
// slice 6. harness/journey.mjs makes it and says what its steps are.
//
// The journey is made once, in the `before` hook, and each case reads one
// clause of the row's required result from it. If the journey cannot be
// made, every case fails.
//
// Pinned only as far as slice 5 reaches (COVERAGE.md says more):
//   - The plan is a fixture, as the row says, so the work the engine itself
//     registers here is the candidate's verification. A committed plan that
//     registers its stages is row M26.
//   - The review's work item is the engine's: the journey makes none with
//     the trigger fixture, and fails if the engine queues none.
//   - In this file the event history is the store's `events` table, and the
//     API is the run read and the answers of the gate and authorization
//     commands. The same journey read through the event stream and the
//     project, candidate and decisions reads, which slice 6 builds, is
//     M01-journey-through-the-api.test.mjs (slice 7).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { authorizationsOf, reasonCodes, sharedFixture, signoffsOf } from './harness/gates.mjs';
import { PERMITTED_EDIT } from './harness/gitruns.mjs';
import { assertWorkHistory } from './harness/invariants.mjs';
import { assertCommitted, assertOperations, candidatesOf, eventsOfType, workItemsOf } from './harness/journal.mjs';
import { journey } from './harness/journey.mjs';
import { changedPaths, checkoutState, refOid, refsOf } from './harness/repos.mjs';
import { assertRunEnded, countOf, getRow, runsOfProject } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { WORK } from './harness/transitions.mjs';

describe('M01 the kernel journey: a T2 project from its creation to an issued Alpha authorization', () => {
  const shared = sharedFixture();
  let J;
  before(async () => {
    J = await journey(shared.context);
  });
  after(() => shared.cleanup());

  test('runtime data stays outside tracked source', () => {
    const { repo } = J.project;
    assert.deepEqual(
      changedPaths(repo.path, repo.head, refOid(repo.path, repo.ref)),
      { '.surety/project.json': 'A', [PERMITTED_EDIT.path]: 'A' },
      "all the journey added to the integration branch is the project's identity file and the Builder's edit",
    );
    assert.deepEqual(checkoutState(repo.path), J.checkout, "the developer's checkout holds exactly what it held before the project existed");
  });

  test('the engine commits the permitted output of the Builder', () => {
    // The commit is the tree of what the role left, on the base it ran on, and the integration branch is still at it.
    assertCommitted(J.fx, J.build.id, { kind: 'engine_commit', parent: J.project.base, integrated: true, changes: { [PERMITTED_EDIT.path]: 'A' } });
  });

  test('the engine registers the work that follows the build and nominates once', () => {
    const { fx, project, candidate } = J;
    const head = refOid(project.repo.path, project.repo.ref);
    assert.deepEqual(candidatesOf(fx.home, project.id).map((row) => [row.id, row.seq, row.revision, row.nominated_by]), [[candidate.id, 1, head, 'engine_cadence']], "one candidate, nominated by the engine at the stage's integration: the Builder's commit");
    assert.deepEqual(Object.entries(refsOf(project.repo.path)).filter(([ref]) => ref.startsWith('refs/surety/cand/')), [['refs/surety/cand/1', head]], 'and one nomination ref, at that commit');

    const created = eventsOfType(fx.home, 'work.created');
    const asFixture = (work) => created.find((event) => event.subject.work_item === work.id)?.payload?.test_fixture === true;
    assert.deepEqual(
      workItemsOf(fx.home, project.id).map((work) => [work.kind, work.trigger_source, work.subject?.candidate ?? null, asFixture(work)]),
      [
        ['stage_build', 'plan', null, true],
        ['verification', 'nomination', candidate.id, false],
        ['review', 'verification', candidate.id, false],
      ],
      "three work items: the plan fixture's stage; the candidate's verification, which the engine registered at the nomination; and the candidate's review, which the engine queued once the verification had completed and the check had passed. Neither of the last two is a fixture",
    );
  });

  test('the stage gate is satisfied by the observed execution of its check, and not before it', () => {
    const { fx, candidate, checks, stage, unproven, stageEvaluation } = J;
    assert.deepEqual(
      [unproven.evaluation.outcome, reasonCodes(unproven.evaluation), unproven.evaluation.check_states, unproven.work, unproven.reviews],
      ['not_satisfied', ['CHECK_NOT_PASSED', 'SIGNOFF_MISSING'], { [checks.login]: 'missing' }, 'verifying', 0],
      "built and verified, with no execution of the check on record: the gate is not satisfied, the stage's work is not complete, and no review has been queued, so the sign-off is missing too",
    );
    assert.deepEqual([stageEvaluation.outcome, stageEvaluation.check_states], ['satisfied', { [checks.login]: 'passed' }], `with a passing execution recorded, and the sign-off of the review that execution let the engine queue, the gate is satisfied (reasons: ${reasonCodes(stageEvaluation).join(', ')})`);
    assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, stage.work_item)), WORK.kinds.stage_build.path, "and the stage's work is complete");
    assert.deepEqual(
      signoffsOf(fx.home, candidate.id).map((row) => [row.role, row.scope, row.revision, row.run]),
      [['reviewer', 'candidate', candidate.revision, J.reviewed.run.id]],
      "the sign-off T2 requires is the Reviewer's, from the run of the review the engine queued, on the nominated revision",
    );
  });

  test('the Alpha-authorization gate is satisfied from the same evidence and issues the authorization proposed for the test target', () => {
    const { fx, candidate, checks, alpha, alphaEvaluation } = J;
    assert.equal(alpha.authorization.status, 'proposed', 'the authorization was recorded first, as proposed');
    assert.deepEqual([alphaEvaluation.outcome, alphaEvaluation.check_states], ['satisfied', { [checks.login]: 'passed' }], `the gate is satisfied (reasons: ${reasonCodes(alphaEvaluation).join(', ')})`);
    assert.deepEqual(
      authorizationsOf(fx.home, candidate.id).map((row) => [row.id, row.status, row.environment, row.evaluation]),
      [[alpha.authorization.id, 'issued', alpha.environment, alphaEvaluation.id]],
      'one authorization: the proposed one, issued for its target by that evaluation',
    );
  });

  test('the candidate remains Developing, and no deployment or publication is attempted', () => {
    const { fx, candidate } = J;
    assert.equal(getRow(fx.home, 'candidates', candidate.id).progress, 'developing', 'the candidate is still developing');
    assert.equal(eventsOfType(fx.home, 'candidate.advanced').length, 0, 'no candidate advanced');
    assert.equal(countOf(fx.home, 'operations', `"kind" IN ('deploy', 'publish', 'rollback', 'teardown')`), 0, 'no deployment or publication operation was recorded');
    assert.deepEqual(fx.scripted.launches().map((launch) => launch.role), ['builder', 'verifier', 'reviewer'], 'the three roles are the only processes the engine launched');
  });

  test('the API and the event history agree with the durable rows', async () => {
    const { fx, project, candidate } = J;

    // The API: each run as its row has it, and each evaluation as it was answered.
    const runs = runsOfProject(fx.home, project.id);
    assert.deepEqual(runs.map((run) => run.role), ['builder', 'verifier', 'reviewer'], 'three runs, one for each role');
    for (const run of runs) {
      const shown = (await fx.engine.get(`/v1/projects/${project.id}/runs/${run.id}`)).body?.run;
      assert.deepEqual([shown?.id, shown?.state, shown?.outcome, shown?.reason_class], [run.id, run.state, run.outcome, run.reason_class], `the API reports the ${run.role}'s run as its row has it`);
    }
    for (const [evaluation, kind] of [[J.stageEvaluation, 'stage'], [J.alphaEvaluation, 'alpha_authorize']]) {
      const row = getRow(fx.home, 'gate_evaluations', evaluation.id);
      assert.deepEqual([row?.candidate, row?.gate_kind, row?.outcome], [candidate.id, kind, evaluation.outcome], `the ${kind} evaluation the API answered with is the row recorded`);
    }

    // The event history: each run's events end where its row is, each work item's too, and each journal event of each git operation is in the log.
    for (const run of runs) assertRunEnded(fx.home, run.id, { outcome: 'completed', reason_class: 'none', launched: true, recovery: false });
    for (const work of workItemsOf(fx.home, project.id)) withStore(fx.home, (db) => assertWorkHistory(db, work.id));
    assertOperations(fx.home, { project: project.id });
    const created = eventsOfType(fx.home, 'project.created');
    const [registered] = eventsOfType(fx.home, 'project.registered');
    assert.deepEqual(created.map((event) => [event.subject.project, event.payload?.test_fixture === true]), [[project.id, false]], 'one project was created, through the public route and not as a fixture');
    assert.ok(registered?.subject.project === project.id && registered.seq > created[0].seq, 'and was registered after it');
    assert.equal(eventsOfType(fx.home, 'authorization.issued').length, 1, 'one authorization was issued');
  });
});
