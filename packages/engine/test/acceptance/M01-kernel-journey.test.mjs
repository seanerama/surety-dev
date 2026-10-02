// M01, the minimum successful kernel journey (slice 5). Plan §3.1 M01; D1
// §§3.1, 7.7, 7.8, 9, 19.3 and the M1 parts of D1-01, D1-18 and D1-25; RN §4;
// build spec §3 and §5 ("engine home"); SEAM.md §§27, 28, 30, 40, 42, 67,
// 68, 70, 74, 75, 86; E36 items 3 and 4; E43.
//
// The journey is the central target of the slice-5 build: it is the one
// place where the parts slices 1 to 5 build are made to work together, from
// a project's creation to an issued Alpha authorization. It needs nothing of
// slice 6. harness/journey.mjs makes it and says what its steps are.
//
// Two paths (E43), each made once in the `before` hook of its own group,
// and each case reads one clause of the row's required result from it. If
// a path cannot be made, every case of its group fails.
//
//   - The first path is the one where nothing goes wrong: built, verified,
//     the check observed, reviewed, both gates satisfied.
//   - The second is the fix loop: the Verifier reports a Critical finding
//     naming the check; the Reviewer proposes to fix it and signs nothing
//     off; the engine registers the fix work itself, which waits at the
//     chain boundary like the review; a person lets it through; a Builder
//     fixes it; the engine commits and integrates the fix and nominates the
//     fix's candidate; that candidate is verified and its check passes; the
//     finding is resolved by that evaluation and the fix's work completes;
//     the engine queues its review and the Reviewer signs it off; the stage
//     gate and the Alpha authorization are satisfied on the fix's
//     candidate, and the stage's work completes there.
//
// Pinned only as far as slice 5 reaches (COVERAGE.md says more):
//   - The plan is a fixture, as the row says, so the work the engine itself
//     registers here is the candidate's verification. A committed plan that
//     registers its stages is row M26.
//   - The review's work item is the engine's, and so is the fix's: the
//     journey makes neither with the trigger fixture, and fails if the
//     engine registers neither.
//   - In this file the event history is the store's `events` table, and the
//     API is the run read and the answers of the gate and authorization
//     commands. The same journey read through the event stream and the
//     project, candidate and decisions reads, which slice 6 builds, is
//     M01-journey-through-the-api.test.mjs (slice 7).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { authorizationsOf, evaluationsOf, finding, reasonCodes, reasonSubjects, sharedFixture, signoffsOf } from './harness/gates.mjs';
import { PERMITTED_EDIT } from './harness/gitruns.mjs';
import { assertWorkHistory } from './harness/invariants.mjs';
import { assertCommitted, assertOperations, candidatesOf, eventsOfType, lineagesOf, workItemsOf } from './harness/journal.mjs';
import { FIX_EDIT, FINDING, fixLoop, journey } from './harness/journey.mjs';
import { changedPaths, checkoutState, refOid, refsOf } from './harness/repos.mjs';
import { assertRunEnded, countOf, getRow, runsOf, runsOfProject } from './harness/runs.mjs';
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

describe("M01 the kernel journey, second path: a finding, the fix the engine registers, and the gates satisfied on the fix's candidate (E43)", () => {
  const shared = sharedFixture();
  let F;
  before(async () => {
    F = await fixLoop(shared.context);
  });
  after(() => shared.cleanup());

  test("the finding and its disposition are recorded from the roles' reports, and the fix work is the engine's: one item naming the finding, no fixture, let through the chain boundary by a person and built once", () => {
    const { fx, project, first, verification, finding: found, dispositioned, firstReview, fix, fixRun, answered } = F;
    const [verifierRun] = runsOf(fx.home, verification.id);
    assert.deepEqual([found.effective_severity, found.category, found.candidate, found.source_run], [FINDING.severity, FINDING.category, first.id, verifierRun.id], "the finding is the one the first candidate's Verifier reported, recorded with its run");
    assert.deepEqual([dispositioned.status, dispositioned.disposition, dispositioned.disposition_authority], ['dispositioned', 'fix', 'reviewer'], "the Reviewer's fix was recorded as a disposition with its own authority, once its run had ended");
    assert.deepEqual(signoffsOf(fx.home, first.id), [], 'the Reviewer signed nothing off on the first candidate');

    const fixes = workItemsOf(fx.home, project.id).filter((work) => work.kind === 'fix');
    const created = eventsOfType(fx.home, 'work.created').find((event) => event.subject.work_item === fix.id);
    assert.deepEqual(
      fixes.map((work) => [work.id, work.subject?.finding, work.trigger_source, work.trigger_id, created?.payload?.test_fixture === true]),
      [[fix.id, found.id, 'finding', found.id, false]],
      'one fix item in the project: the one the engine registered for the disposition, naming the finding, with the finding as its trigger, and no fixture',
    );
    const boundary = answered.find((entry) => entry.work === fix.id)?.decision;
    assert.ok(boundary?.kind === 'blocker' && boundary.options.some((option) => option.key === 'continue'), 'the fix waited at the chain boundary, and a person answered "continue" there');
    assert.deepEqual(runsOf(fx.home, fix.id).map((run) => [run.id, run.role, run.outcome]), [[fixRun.id, 'builder', 'completed']], "one run of the fix, the Builder's, accepted");
    assert.equal(firstReview.run.role, 'reviewer', 'the disposition came from the run of the review the engine queued');
  });

  test("the engine commits and integrates the fix and nominates the fix's candidate: the fix's commit on the first candidate's revision, the second candidate at it, nominated by the engine at the fix's integration on the lineage the first opened, with verification and review work of its own", () => {
    const { fx, project, first, second, fixRun } = F;
    const fixed = assertCommitted(fx, fixRun.id, { kind: 'engine_commit', parent: first.revision, integrated: true, changes: { [FIX_EDIT.path]: 'A' } });
    assert.deepEqual(
      candidatesOf(fx.home, project.id).map((row) => [row.id, row.seq, row.revision, row.nominated_by]),
      [
        [first.id, 1, first.revision, 'engine_cadence'],
        [second.id, 2, fixed.sha, 'engine_cadence'],
      ],
      "two candidates: the stage's, and the fix's at the fix's commit, nominated by the engine when the fix was integrated (SEAM.md §42)",
    );
    assert.equal(lineagesOf(fx.home, project.id).find((lineage) => lineage.id === second.lineage)?.started_from_candidate, first.id, "the fix's candidate is on the lineage the first nomination opened: the finding applies to it");
    assert.deepEqual(Object.entries(refsOf(project.repo.path)).filter(([ref]) => ref.startsWith('refs/surety/cand/')), [['refs/surety/cand/1', first.revision], ['refs/surety/cand/2', fixed.sha]], 'and one nomination ref each');
    assert.deepEqual(
      workItemsOf(fx.home, project.id).map((work) => [work.kind, work.trigger_source, work.subject?.finding ?? work.subject?.candidate ?? work.subject?.stage ?? null]),
      [
        ['stage_build', 'plan', F.stage.id],
        ['verification', 'nomination', first.id],
        ['review', 'verification', first.id],
        ['fix', 'finding', F.finding.id],
        ['verification', 'nomination', second.id],
        ['review', 'verification', second.id],
      ],
      "six work items, in order: the plan fixture's stage, then five the engine registered: the first candidate's verification and review, the fix, and the fix candidate's verification and review",
    );
  });

  test("the finding is resolved by the evaluation of the fix's candidate in which its check passed, and the fix's work is complete with it; neither held before that execution", () => {
    const { fx, finding: found, fix, second, secondReview, beforeProof } = F;
    assert.deepEqual(beforeProof, { finding: 'dispositioned', fix: 'verifying' }, "with the fix's candidate verified and its check not yet executed, the finding stood and the fix was open work held by that candidate");
    const resolved = finding(fx.home, found.id);
    assert.equal(resolved.status, 'resolved', 'the finding is resolved');
    const by = JSON.parse(resolved.resolution_verification);
    const evaluation = getRow(fx.home, 'gate_evaluations', by.evaluation);
    assert.deepEqual([by.check_result, evaluation?.candidate, evaluation?.gate_kind], [secondReview.execution.id, second.id, 'stage'], "by a stage evaluation of the fix's candidate, with the execution of the named check recorded on that candidate");
    assert.equal(eventsOfType(fx.home, 'finding.resolved').length, 1, 'once');
    assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, fix.id)), WORK.kinds.fix.path, "and the fix's work is complete");
  });

  test("the stage gate was blocked by the finding on the first candidate and never satisfied there; on the fix's candidate it is satisfied and completes the stage's work, and the Alpha authorization proposed for that candidate is issued", () => {
    const { fx, first, second, finding: found, checks, stage, blocked, stageEvaluation, alpha, alphaEvaluation } = F;
    assert.deepEqual([blocked.outcome, reasonCodes(blocked), reasonSubjects(blocked, 'FINDING_BLOCKING')], ['not_satisfied', ['FINDING_BLOCKING', 'SIGNOFF_MISSING'], [found.id]], 'with the check passed on the first candidate, the Critical finding blocks its stage gate, and the sign-off the Reviewer withheld is missing');
    assert.deepEqual(evaluationsOf(fx.home, first.id, 'stage').filter((row) => row.outcome === 'satisfied'), [], "no evaluation of the first candidate's stage gate was ever satisfied");
    assert.deepEqual([stageEvaluation.outcome, stageEvaluation.check_states], ['satisfied', { [checks.login]: 'passed' }], `on the fix's candidate the stage gate is satisfied (reasons: ${reasonCodes(stageEvaluation).join(', ')})`);
    assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, stage.work_item)), WORK.kinds.stage_build.path, "and the stage's work is complete: the fix's candidate holds it by ancestry (SEAM.md §74)");
    assert.deepEqual(signoffsOf(fx.home, second.id).map((row) => [row.role, row.scope, row.revision]), [['reviewer', 'candidate', second.revision]], "the sign-off T2 requires is on the fix's candidate, from the review the engine queued for it");
    assert.deepEqual([alphaEvaluation.outcome, alphaEvaluation.check_states], ['satisfied', { [checks.login]: 'passed' }], `the Alpha-authorization gate is satisfied on it (reasons: ${reasonCodes(alphaEvaluation).join(', ')})`);
    assert.deepEqual(authorizationsOf(fx.home, second.id).map((row) => [row.id, row.status, row.evaluation]), [[alpha.authorization.id, 'issued', alphaEvaluation.id]], 'and the one authorization proposed for it is issued by that evaluation');
    assert.deepEqual([authorizationsOf(fx.home, first.id), eventsOfType(fx.home, 'authorization.issued').length], [[], 1], 'the first candidate has none; one authorization was issued in all');
    assert.deepEqual(fx.scripted.launches().map((launch) => launch.role), ['builder', 'verifier', 'reviewer', 'builder', 'verifier', 'reviewer'], 'the six roles of the two rounds are the only processes the engine launched');
  });
});
