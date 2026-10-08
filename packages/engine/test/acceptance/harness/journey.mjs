// The kernel journey of row M01 (Plan §3.1 M01; SEAM.md §86), made once and
// read by two files: M01-kernel-journey.test.mjs (slice 5), which reads it
// from the store, git and the routes slice 5 has, and
// M01-journey-through-the-api.test.mjs (slice 7), which reads the same
// journey through the reads and the event stream slice 6 adds.
//
// Two paths, one project shape, at tier T2. `journey` is the path where
// nothing goes wrong; `fixLoop` is the path with a finding (E43). Both
// start the same way (`start`): a project is created through the public
// route in a disposable repository that already holds its protected checks.
// The approved baseline and plan, the declared check, the check's execution
// and the Alpha test target enter as fixtures, labelled as test setup (Plan
// §1). One scripted Builder builds the plan's stage; the engine commits what
// it left, integrates it and nominates the commit. The candidate's
// verification runs once a person lets it through the chain boundary. When
// the check's execution has been observed, the engine queues the review T2
// requires, by itself (E36 item 3); a person lets that through too.
//
// In the first path the Reviewer signs the candidate off, and the stage gate
// and the Alpha authorization are evaluated through the public routes. In
// the second the Verifier reported a Critical finding naming the check; the
// Reviewer proposes to fix it and signs nothing off; the engine registers
// the fix work itself (E43), which waits at the chain boundary like the
// review; a person lets it through; a scripted Builder fixes it; the engine
// commits and integrates the fix and nominates the fix's candidate; that
// candidate is verified, its check passes, the finding is resolved by the
// evaluation in which it passes and the fix's work completes (E36 item 4);
// the engine queues its review, the Reviewer signs it off, and the stage
// gate and the Alpha authorization are satisfied on it.

import assert from 'node:assert/strict';
import { join } from 'node:path';

import { consume, openDecision } from './decisions.mjs';
import { PROTECTED_FILES, alphaTarget, check, finding as findingRow, findingsOf, installChecks, installGatedPlan, passAll, stageGate } from './gates.mjs';
import { permittedEdit, roleThat, runToEnd, waitForCandidates } from './gitruns.mjs';
import { createProject, workItemsOf } from './journal.mjs';
import { checkoutState, makeProjectRepo, refOid } from './repos.mjs';
import { runsOf, scriptedEngine, tickUntil, workItem } from './runs.mjs';
import { script, step } from './scripted.mjs';

// What the journey's Verifier reports in the second path: a Critical finding
// in the login, naming the check whose passing on a later candidate resolves
// it (SEAM.md §74, "Resolution"), and, from M3 slice 21 (F2 (c), L8; SEAM.md
// §§230, 233), the criterion it breaks, R1.1, which that check covers.
export const FINDING = Object.freeze({ category: 'security', severity: 'critical', message: 'the login accepts an expired session', check: 'login', criterion: 'R1.1' });

// The edit the fix's Builder makes: one new source file, beside the stage's.
export const FIX_EDIT = Object.freeze({ path: 'src/session.js', content: 'export const expiresSessions = true;\n' });

// Steps 1 to 5, shared by both paths, on a new engine that `t` cleans up (a
// test context, or a shared fixture's). `decisionAbout(fx, project, kind,
// subjectId)` is how the person at a chain boundary finds the open decision
// to answer: by default from the store, with its preview checked against the
// contract (decisions.mjs); the slice-7 file passes one that reads it from
// the API. The decision is answered with the `id` and `preview_hash` that
// function returned. `verifier` is what the first candidate's Verifier
// reports (nothing, by default: its run changes nothing and completes).
async function start(t, { decisionAbout, verifier }) {
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

  // The person at a chain boundary: finds the decision about the waiting work and lets it through.
  const answered = [];
  const letThrough = async (work) => {
    const found = await decisionAbout(fx, id, 'blocker', work.id);
    await consume(fx, id, found, 'continue');
    answered.push({ work: work.id, decision: found });
  };

  // A candidate's verification: the work its nomination registered waits at the chain boundary; a person lets it through, and it completes. `report` is what its Verifier reports.
  const verified = async (which, report) => {
    const verification = workItemsOf(fx.home, id).find((work) => work.kind === 'verification' && work.subject?.candidate === which.id);
    assert.ok(verification, `the nomination registered verification work for candidate ${which.seq}`);
    if (report !== undefined) fx.scripted.script(verification.id, [roleThat([], report)]);
    await letThrough(verification);
    await tickUntil(fx.engine, id, () => workItem(fx.home, verification.id).status === 'complete', { what: `the verification of candidate ${which.seq} to complete` });
    return verification;
  };

  // A candidate's review: the check's execution is observed, the engine queues the review T2 requires by itself (the journey creates none), it waits at the chain boundary like the verification, a person lets it through, and the Reviewer reports `report`. Returns {item, run, execution}.
  const reviews = () => workItemsOf(fx.home, id).filter((work) => work.kind === 'review');
  const reviewed = async (which, report) => {
    const [execution] = await passAll(fx.engine, id, which.id, [checks.login]);
    const queued = await tickUntil(fx.engine, id, () => reviews().find((work) => work.subject?.candidate === which.id), { max: 4, what: `the engine to queue the review of candidate ${which.seq}` });
    fx.scripted.script(queued.id, [roleThat([], report)]);
    await letThrough(queued);
    const run = await tickUntil(
      fx.engine,
      id,
      () => {
        const [first] = runsOf(fx.home, queued.id);
        return first?.state === 'ended' ? first : undefined;
      },
      { what: `the Reviewer's run on candidate ${which.seq} to end` },
    );
    assert.deepEqual([run.outcome, run.reason_class], ['completed', 'none'], `the Reviewer's run was accepted (${run.reason_text})`);
    return { item: queued.id, run, execution };
  };

  // 4. Independent verification: the candidate's verification work waits for a person at the chain boundary, who lets it through.
  const verification = await verified(candidate, verifier);

  // 5. The stage gate before any execution of the check is observed. Verified, and its check not passed, the candidate has no review yet.
  const ctx = { project, candidate, stage: stage.id };
  const unproven = { evaluation: await stageGate(fx, ctx), work: workItem(fx.home, stage.work_item).status, reviews: reviews().length };

  return { fx, project, checkout, stage, checks, build, candidate, verification, answered, unproven, ctx, letThrough, verified, reviewed };
}

// The first path: nothing goes wrong.
export async function journey(t, { decisionAbout = openDecision } = {}) {
  const S = await start(t, { decisionAbout });
  const { fx, project, checkout, stage, checks, build, candidate, verification, answered, unproven, ctx } = S;

  // 6. The check's execution is observed. The engine queues the review; a person lets it through, and the Reviewer signs the candidate off.
  const reviewed = await S.reviewed(candidate, { signoffs: [{ scope: 'candidate' }] });

  // 7. The stage gate again, with the execution observed and the sign-off recorded.
  const stageEvaluation = await stageGate(fx, ctx);

  // 8. The Alpha authorization for a test target: proposed first, then evaluated.
  const alpha = await alphaTarget(fx, ctx);
  const alphaEvaluation = await alpha.evaluate();

  return { fx, project, checkout, stage, checks, build, candidate, verification, reviewed, answered, unproven, stageEvaluation, alpha, alphaEvaluation };
}

// The second path: a finding, the fix the engine registers, and the gates
// satisfied on the fix's candidate (E43).
export async function fixLoop(t, { decisionAbout = openDecision } = {}) {
  const S = await start(t, { decisionAbout, verifier: { findings: [FINDING] } });
  const { fx, project, checkout, stage, checks, build, candidate: first, verification, answered, ctx } = S;
  const id = project.id;

  // 6. The Verifier's finding is on record. The check's execution is observed and the engine queues the review; the Reviewer proposes to fix the finding and signs nothing off.
  const [found] = findingsOf(fx.home, id);
  assert.ok(found, "the finding the Verifier reported was recorded with its run (SEAM.md §68)");
  const firstReview = await S.reviewed(first, { dispositions: [{ finding: found.id, disposition: 'fix' }] });
  const dispositioned = findingRow(fx.home, found.id);

  // 7. The stage gate on the first candidate: blocked by the finding.
  const blocked = await stageGate(fx, ctx);

  // 8. The fix work the engine registered for the disposition (the journey creates none) waits at the chain boundary; a person lets it through; a scripted Builder fixes it; the engine commits and integrates the fix and nominates the fix's candidate.
  const fixes = () => workItemsOf(fx.home, id).filter((work) => work.kind === 'fix');
  const [fix] = fixes();
  assert.ok(fix, 'the engine registered fix work when the fix disposition was recorded (E43); the journey makes none');
  fx.scripted.script(fix.id, [roleThat([step.write(FIX_EDIT.path, FIX_EDIT.content)])]);
  await S.letThrough(fix);
  const fixRun = await runToEnd(fx, id, fix.id);
  assert.deepEqual([fixRun.outcome, fixRun.reason_class], ['completed', 'none'], `the fix's Builder run was accepted (${fixRun.reason_text})`);
  const [, second] = await waitForCandidates(fx, id, 2);

  // 9. The fix's candidate is verified (its Verifier reports nothing). Before its check is executed, the finding stands and the fix is open.
  const secondVerification = await S.verified(second);
  const beforeProof = { finding: findingRow(fx.home, found.id).status, fix: workItem(fx.home, fix.id).status };

  // 10. The check passes on the fix's candidate; the engine queues its review; the Reviewer signs it off.
  const secondReview = await S.reviewed(second, { signoffs: [{ scope: 'candidate' }] });

  // 11. The stage gate and the Alpha authorization, on the fix's candidate.
  const ctx2 = { project, candidate: second, stage: stage.id };
  const stageEvaluation = await stageGate(fx, ctx2);
  const alpha = await alphaTarget(fx, ctx2);
  const alphaEvaluation = await alpha.evaluate();

  return {
    fx,
    project,
    checkout,
    stage,
    checks,
    build,
    first,
    verification,
    finding: found,
    dispositioned,
    firstReview,
    blocked,
    fix,
    fixRun,
    second,
    secondVerification,
    beforeProof,
    secondReview,
    answered,
    stageEvaluation,
    alpha,
    alphaEvaluation,
  };
}
