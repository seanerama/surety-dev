// M01, the minimum successful kernel journey (slice 7). Plan §3.1 M01; D1
// §§3.1, 7.7, 7.8, 9, 19.3 and the M1 parts of D1-01, D1-18 and D1-25; RN §4;
// build spec §3 and §5 ("engine home"); SEAM.md §§27, 28, 30, 40, 42, 67,
// 68, 70, 75, 86.
//
// One journey at tier T2, and nothing new: every step is one an earlier row
// pins by itself. A project is created through the public route in a
// disposable repository that already holds its protected checks. The
// approved baseline and plan, the declared check, the check's execution and
// the Alpha test target enter as fixtures, labelled as test setup (Plan §1).
// One scripted Builder builds the plan's stage; the engine commits what it
// left, integrates it and nominates the commit. The candidate's verification
// runs once a person lets it through the chain boundary, and a Reviewer
// signs the candidate off, which T2 requires. The stage gate and the Alpha
// authorization are then evaluated through the public routes.
//
// The journey is made once, in the `before` hook, and each case reads one
// clause of the row's required result from it. If the journey cannot be
// made, every case fails.
//
// Pinned only as far as the seam reaches (COVERAGE.md says more):
//   - The plan is a fixture, as the row says, so the work the engine itself
//     registers here is the candidate's verification. A committed plan that
//     registers its stages is row M26.
//   - The review's work item is made with the trigger fixture: nothing in M1
//     creates review work.
//   - The event history is the store's `events` table, and the API is the
//     run read and the answers of the gate and authorization commands.
//     SEAM.md has no event-stream route and no candidate read.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { consume, openDecision } from './harness/decisions.mjs';
import { PROTECTED_FILES, alphaTarget, authorizationsOf, check, installChecks, installGatedPlan, passAll, reasonCodes, review, sharedFixture, signoffsOf, stageGate } from './harness/gates.mjs';
import { PERMITTED_EDIT, permittedEdit, roleThat, runToEnd, waitForCandidates } from './harness/gitruns.mjs';
import { assertWorkHistory } from './harness/invariants.mjs';
import { assertCommitted, assertOperations, candidatesOf, createProject, eventsOfType, workItemsOf } from './harness/journal.mjs';
import { changedPaths, checkoutState, makeProjectRepo, refOid, refsOf } from './harness/repos.mjs';
import { assertRunEnded, countOf, getRow, runsOfProject, scriptedEngine, tickUntil, workItem } from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { WORK } from './harness/transitions.mjs';

async function journey(t) {
  const fx = await scriptedEngine(t);
  // A role with no script of its own changes nothing and reports completion: the Verifier, below.
  fx.scripted.defaultScript(script.complete());

  // 1. A disposable repository, and a project created in it through the public route.
  const repo = makeProjectRepo(join(fx.root, 'repo'), { files: PROTECTED_FILES });
  const checkout = checkoutState(repo.path);
  const { id } = await createProject(fx.engine, { repoPath: repo.path, name: 'journey', tier: 'T2' });
  const project = { id, repo, base: refOid(repo.path, repo.ref) };

  // 2. Fixtures: the approved baseline and plan (one requirement, one stage that implements it), and the protected check that covers the requirement.
  const plan = await installGatedPlan(fx.engine, id, { requirements: ['R1'], stages: [{ number: 1, goal: 'the first stage', implements: ['R1'] }] });
  const [stage] = plan.stages;
  const checks = (await installChecks(fx.engine, id, [check('login', { requirements: ['R1'] })])).id;

  // 3. One scripted Builder builds the stage. At T2 the engine nominates what it integrated.
  fx.scripted.script(stage.work_item, [roleThat([permittedEdit()])]);
  const build = await runToEnd(fx, id, stage.work_item);
  assert.deepEqual([build.outcome, build.reason_class], ['completed', 'none'], `the Builder's run was accepted (${build.reason_text})`);
  const [candidate] = await waitForCandidates(fx, id);

  // 4. Independent verification: the candidate's verification work waits for a person at the chain boundary, who lets it through.
  const verification = workItemsOf(fx.home, id).find((work) => work.kind === 'verification' && work.subject?.candidate === candidate.id);
  assert.ok(verification, 'the nomination registered verification work for the candidate');
  await consume(fx, id, await openDecision(fx, id, 'blocker', verification.id), 'continue');
  await tickUntil(fx.engine, id, () => workItem(fx.home, verification.id).status === 'complete', { what: "the candidate's verification to complete" });

  // 5. Review, which T2 requires: a Reviewer signs the candidate off.
  const reviewed = await review(fx, id, candidate.id, { signoffs: [{ scope: 'candidate' }] });

  // 6. The stage gate, before and after an execution of the check is observed.
  const ctx = { project, candidate, stage: stage.id };
  const unproven = { evaluation: await stageGate(fx, ctx), work: workItem(fx.home, stage.work_item).status };
  await passAll(fx.engine, id, candidate.id, [checks.login]);
  const stageEvaluation = await stageGate(fx, ctx);

  // 7. The Alpha authorization for a test target: proposed first, then evaluated.
  const alpha = await alphaTarget(fx, ctx);
  const alphaEvaluation = await alpha.evaluate();

  return { fx, project, checkout, stage, checks, build, candidate, reviewed, unproven, stageEvaluation, alpha, alphaEvaluation };
}

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
        ['review', 'test', candidate.id, true],
      ],
      "three work items: the plan fixture's stage, the candidate's verification, which the engine registered at the nomination and which is no fixture, and the review",
    );
  });

  test('the stage gate is satisfied by the observed execution of its check, and not before it', () => {
    const { fx, candidate, checks, stage, unproven, stageEvaluation } = J;
    assert.deepEqual(
      [unproven.evaluation.outcome, reasonCodes(unproven.evaluation), unproven.evaluation.check_states, unproven.work],
      ['not_satisfied', ['CHECK_NOT_PASSED'], { [checks.login]: 'missing' }, 'verifying'],
      "built, verified and signed off, with no execution of the check on record: the gate is not satisfied and the stage's work is not complete",
    );
    assert.deepEqual([stageEvaluation.outcome, stageEvaluation.check_states], ['satisfied', { [checks.login]: 'passed' }], `with a passing execution recorded the gate is satisfied (reasons: ${reasonCodes(stageEvaluation).join(', ')})`);
    assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, stage.work_item)), WORK.kinds.stage_build.path, "and the stage's work is complete");
    assert.deepEqual(
      signoffsOf(fx.home, candidate.id).map((row) => [row.role, row.scope, row.revision, row.run]),
      [['reviewer', 'candidate', candidate.revision, J.reviewed.run.id]],
      "the sign-off T2 requires is the Reviewer's, from a run of its own, on the nominated revision",
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
