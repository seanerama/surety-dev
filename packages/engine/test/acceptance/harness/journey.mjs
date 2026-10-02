// The kernel journey of row M01 (Plan §3.1 M01; SEAM.md §86), made once and
// read by two files: M01-kernel-journey.test.mjs (slice 5), which reads it
// from the store, git and the routes slice 5 has, and
// M01-journey-through-the-api.test.mjs (slice 7), which reads the same
// journey through the reads and the event stream slice 6 adds.
//
// One journey at tier T2, and nothing new: every step is one an earlier row
// pins by itself. A project is created through the public route in a
// disposable repository that already holds its protected checks. The
// approved baseline and plan, the declared check, the check's execution and
// the Alpha test target enter as fixtures, labelled as test setup (Plan §1).
// One scripted Builder builds the plan's stage; the engine commits what it
// left, integrates it and nominates the commit. The candidate's verification
// runs once a person lets it through the chain boundary. When the check's
// execution has been observed, the engine queues the review T2 requires, by
// itself (E36 item 3); a person lets that through too, and the Reviewer signs
// the candidate off. The stage gate and the Alpha authorization are evaluated
// through the public routes.

import assert from 'node:assert/strict';
import { join } from 'node:path';

import { consume, openDecision } from './decisions.mjs';
import { PROTECTED_FILES, alphaTarget, check, installChecks, installGatedPlan, passAll, stageGate } from './gates.mjs';
import { permittedEdit, roleThat, runToEnd, waitForCandidates } from './gitruns.mjs';
import { createProject, workItemsOf } from './journal.mjs';
import { checkoutState, makeProjectRepo, refOid } from './repos.mjs';
import { runsOf, scriptedEngine, tickUntil, workItem } from './runs.mjs';
import { script } from './scripted.mjs';

// Make the journey on a new engine that `t` cleans up (a test context, or a
// shared fixture's). `decisionAbout(fx, project, kind, subjectId)` is how the
// person at a chain boundary finds the open decision to answer: by default
// from the store, with its preview checked against the contract
// (decisions.mjs); the slice-7 file passes one that reads it from the API.
// The decision is answered with the `id` and `preview_hash` that function
// returned.
export async function journey(t, { decisionAbout = openDecision } = {}) {
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
  const answered = [];
  const letThrough = async (work) => {
    const found = await decisionAbout(fx, id, 'blocker', work.id);
    await consume(fx, id, found, 'continue');
    answered.push({ work: work.id, decision: found });
  };
  await letThrough(verification);
  await tickUntil(fx.engine, id, () => workItem(fx.home, verification.id).status === 'complete', { what: "the candidate's verification to complete" });

  // 5. The stage gate before any execution of the check is observed. Verified, and its check not passed, the candidate has no review yet.
  const ctx = { project, candidate, stage: stage.id };
  const reviews = () => workItemsOf(fx.home, id).filter((work) => work.kind === 'review');
  const unproven = { evaluation: await stageGate(fx, ctx), work: workItem(fx.home, stage.work_item).status, reviews: reviews().length };

  // 6. The check's execution is observed. The engine now queues the review T2 requires, by itself: the journey creates none.
  //    It waits at the chain boundary like the verification; a person lets it through, and the Reviewer signs the candidate off.
  await passAll(fx.engine, id, candidate.id, [checks.login]);
  const queued = await tickUntil(fx.engine, id, () => reviews()[0], { max: 4, what: "the engine to queue the candidate's review" });
  fx.scripted.script(queued.id, [roleThat([], { signoffs: [{ scope: 'candidate' }] })]);
  await letThrough(queued);
  const reviewRun = await tickUntil(
    fx.engine,
    id,
    () => {
      const [first] = runsOf(fx.home, queued.id);
      return first?.state === 'ended' ? first : undefined;
    },
    { what: "the Reviewer's run to end" },
  );
  assert.deepEqual([reviewRun.outcome, reviewRun.reason_class], ['completed', 'none'], `the Reviewer's run was accepted (${reviewRun.reason_text})`);
  const reviewed = { item: queued.id, run: reviewRun };

  // 7. The stage gate again, with the execution observed and the sign-off recorded.
  const stageEvaluation = await stageGate(fx, ctx);

  // 8. The Alpha authorization for a test target: proposed first, then evaluated.
  const alpha = await alphaTarget(fx, ctx);
  const alphaEvaluation = await alpha.evaluate();

  return { fx, project, checkout, stage, checks, build, candidate, verification, reviewed, answered, unproven, stageEvaluation, alpha, alphaEvaluation };
}
