// M42, findings, dispositions and inherited applicability (slice 5). Plan
// §3.4 M42; D1 §§3.4, 9.3(5), 9.4, 9.5, D1-24; F §§6.1, 6.2; E19; RN R4;
// Review B02; SEAM.md §74.
//
// The gate asks about every finding that is open or dispositioned and
// applies to the candidate: the candidate it was raised on and every
// successor on the lineage chain. A planned fix resolves nothing. A
// deferral holds only with authority that matches the finding's current
// severity, an unexpired target, and a re-evaluation by this very
// evaluation. A human's accept holds. A resolution whose verification is
// invalidated reopens the finding. An exclusion that is proposed and
// assessed, and not approved, excludes nothing.
//
// The fourth case also pins what completes a fix's work (E36 item 4, which
// settles E34 item 2): the evaluation that resolves the finding it names,
// and nothing before it. Since E43 the fix it builds is the work the engine
// registered for the disposition, let through the chain boundary by a
// person, and no longer a fixture's.
//
// M3 slice 21 (F2 (c), L8; SEAM.md §233): the fourth and sixth cases'
// findings name the criterion their check covers, R1.1; without one a
// finding is never resolved (M235 (c) pins the former form as refused).
//
// The sixth case is E43: a Reviewer's "fix" disposition is recorded at once,
// and the engine registers the fix work itself, in that transaction: one
// `fix` item naming the finding, not a fixture, chained like the review the
// engine queues (E36 item 3), so it waits at the chain boundary for a
// person; one still after ticks and a restart; none before the disposition.
//
// The last case is the slice-5 review's finding (E41 item 3): a Verifier
// whose domain the boundary could not at first report as terminated is
// quarantined with the outcome it earned, and what it reported is recorded
// like any other run's. The engine the review ran dropped the report: a
// Critical finding vanished, the verification completed, and the gate was
// satisfied.
//
// Findings, dispositions and assessments are reported by scripted Reviewer
// and Verifier runs, as agents would report them; the engine records them.
// Medium and Low findings are read at the stage gate; the High finding of
// the last case at the Alpha authorization gate, whose severity ladder F
// §6.1 gives.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { consume, decisionsOn, openDecision } from './harness/decisions.mjs';
import {
  acceptedRun,
  alphaTarget,
  assessmentsOf,
  check,
  checkResult,
  evaluationsOf,
  finding,
  findingsOf,
  installChecks,
  nominated,
  passAll,
  postResult,
  raiseFindings,
  reasonCodes,
  reasonSubjects,
  review,
  stageGate,
  successor,
} from './harness/gates.mjs';
import { roleThatHolds, runToHold } from './harness/gitruns.mjs';
import { assertWorkHistory } from './harness/invariants.mjs';
import { eventsOfType, outOfBand, workItemsOf } from './harness/journal.mjs';
import { commitOnRef } from './harness/repos.mjs';
import { advanceClock, answerDecision, assertRunEnded, assertRunQuarantined, runsOf, scriptedEngine, tick, tickUntil, waitForQuarantine, waitForRunState, workItem } from './harness/runs.mjs';
import { BOUNDARY } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { WORK } from './harness/transitions.mjs';

const DAY = 86_400;
const inDays = (n) => new Date(Date.now() + n * DAY * 1000).toISOString();
const defect = (severity, message, extra = {}) => ({ category: 'defect', severity, message, ...extra });

// A T1 candidate with one required check, passed: its stage gate is
// satisfied until a finding says otherwise. `policy` is changed before the
// build (gates.mjs `nominated`).
async function clean(t, checks = [check('login', { requirements: ['R1'] })], { policy } = {}) {
  const fx = await scriptedEngine(t);
  const ctx = await nominated(fx, { policy });
  const project = ctx.project.id;
  const k = (await installChecks(fx.engine, project, checks)).id;
  return { fx, ctx, project, k, c1: ctx.candidate };
}

const onlyReason = (evaluation, code, subject) => {
  assert.deepEqual(reasonCodes(evaluation), [code], `the gate's one reason is ${code}`);
  assert.deepEqual(reasonSubjects(evaluation, code), [subject], 'and it names the finding');
};

describe('M42 the findings a gate asks about', () => {
  test('an unresolved finding stays in the query through a planned fix and across two successor lineages: a fix that is only planned resolves nothing', async (t) => {
    const { fx, ctx, project, k, c1 } = await clean(t);
    await passAll(fx.engine, project, c1.id, [k.login]);
    const [found] = await raiseFindings(fx, project, c1.id, [defect('medium', 'the logout link is missing on the settings page')]);
    assert.deepEqual([found.status, found.effective_severity, found.candidate], ['open', 'medium', c1.id]);
    onlyReason(await stageGate(fx, ctx), 'FINDING_UNSATISFIED', found.id);

    await review(fx, project, c1.id, { dispositions: [{ finding: found.id, disposition: 'fix' }] });
    assert.deepEqual([finding(fx.home, found.id).status, finding(fx.home, found.id).disposition], ['dispositioned', 'fix'], 'the fix is a disposition, not a resolution');
    onlyReason(await stageGate(fx, ctx), 'FINDING_UNSATISFIED', found.id);

    // Two nominations later, in the second successor lineage, the finding is still asked about.
    await successor(fx, ctx);
    const c3 = await successor(fx, ctx);
    await passAll(fx.engine, project, c3.id, [k.login]);
    onlyReason(await stageGate(fx, ctx, c3), 'FINDING_UNSATISFIED', found.id);
    assert.equal(finding(fx.home, found.id).status, 'dispositioned', 'and it is not resolved');
  });

  test('a deferral holds while its authority matches the current severity and its target has not passed, and each evaluation re-evaluates it', async (t) => {
    const { fx, ctx, project, k, c1 } = await clean(t);
    await passAll(fx.engine, project, c1.id, [k.login]);
    const [raised, aging] = await raiseFindings(fx, project, c1.id, [defect('low', 'a label is misaligned'), defect('low', 'a tooltip is truncated')]);
    await review(fx, project, c1.id, {
      dispositions: [
        { finding: raised.id, disposition: 'defer', linked_issue: 'ISSUE-7', defer_target: inDays(1) },
        { finding: aging.id, disposition: 'defer', linked_issue: 'ISSUE-8', defer_target: inDays(1) },
      ],
    });
    assert.deepEqual([finding(fx.home, raised.id).disposition, finding(fx.home, raised.id).disposition_authority], ['defer', 'reviewer'], 'a Reviewer may defer a Low finding');

    // Each evaluation re-evaluates the deferral and says so on the finding.
    const first = await stageGate(fx, ctx);
    const second = await stageGate(fx, ctx);
    assert.deepEqual([first.outcome, second.outcome], ['satisfied', 'satisfied']);
    const reevaluated = JSON.parse(finding(fx.home, raised.id).reevaluations).map((entry) => entry.evaluation);
    for (const evaluation of [first, second]) assert.ok(reevaluated.includes(evaluation.id), `the deferral was re-evaluated by evaluation ${evaluation.id}`);

    // The severity is raised: the Reviewer's authority no longer covers the deferral.
    await review(fx, project, c1.id, { severity_changes: [{ finding: raised.id, to: 'medium' }] });
    assert.equal(finding(fx.home, raised.id).effective_severity, 'medium');
    onlyReason(await stageGate(fx, ctx), 'FINDING_UNSATISFIED', raised.id);

    // The target passes: a deferral cannot age past a gate.
    await advanceClock(fx.engine, 2 * DAY);
    const late = await stageGate(fx, ctx);
    assert.ok(reasonSubjects(late, 'FINDING_DEFER_EXPIRED').includes(aging.id), `an expired deferral is reported as expired (reasons: ${reasonCodes(late).join(', ')})`);
  });

  test("the human owner's accept of a Medium finding satisfies the gate", async (t) => {
    const { fx, ctx, project, k, c1 } = await clean(t);
    await passAll(fx.engine, project, c1.id, [k.login]);
    const [found] = await raiseFindings(fx, project, c1.id, [defect('medium', 'the export omits the header row')]);
    await review(fx, project, c1.id, { dispositions: [{ finding: found.id, disposition: 'accept' }] });
    assert.equal(finding(fx.home, found.id).status, 'open', 'a Reviewer cannot accept: the finding is as it was until the human decides');
    onlyReason(await stageGate(fx, ctx), 'FINDING_UNSATISFIED', found.id);

    await consume(fx, project, await openDecision(fx, project, 'finding_disposition', found.id), 'approve');
    const accepted = finding(fx.home, found.id);
    assert.deepEqual([accepted.status, accepted.disposition, accepted.disposition_authority], ['dispositioned', 'accept', 'human']);
    assert.equal((await stageGate(fx, ctx)).outcome, 'satisfied');
  });

  test("a fix is resolved by a verification on the candidate that holds it, and the fix's work is complete with that resolution and not before; a resolution whose verification is invalidated reopens the finding", async (t) => {
    // The failure of `regress` on candidate 1 is recorded while the stage's work is verifying there, so under Q2 (D3 §2.10; E90 item 2) it would send
    // the stage back to its Builder. This case is about the fix the finding gets, not the stage's repair: at repair_attempts_max 0 the stage's work is parked instead (objection 030).
    const { fx, ctx, project, k, c1 } = await clean(t, [check('login', { requirements: ['R1'] }), check('regress', { requirements: ['R1'] })], { policy: { repair_attempts_max: 0 } });
    await passAll(fx.engine, project, c1.id, [k.login]);
    await postResult(fx.engine, project, { candidate: c1.id, check: k.regress, exit_status: 1 });
    const [found] = await raiseFindings(fx, project, c1.id, [defect('medium', 'a session survives logout', { check: 'regress', criterion: 'R1.1' })]);
    await review(fx, project, c1.id, { dispositions: [{ finding: found.id, disposition: 'fix' }] });

    // The fix is the work the engine registered for the disposition (E43; the sixth case): a person lets it through the chain boundary, its Builder builds it and asks for the nomination.
    const fix = workItemsOf(fx.home, project).find((work) => work.kind === 'fix' && work.subject?.finding === found.id);
    assert.ok(fix, 'the engine registered fix work naming the finding (the sixth case pins it)');
    const c2 = await successor(fx, ctx, { work: fix.id });
    assert.equal(workItem(fx.home, fix.id).status, 'verifying', 'the fix is integrated and held by candidate 2');

    // An evaluation in which the check the finding names has not passed resolves nothing, and the fix stays open.
    await passAll(fx.engine, project, c2.id, [k.login]);
    await stageGate(fx, ctx, c2);
    assert.deepEqual([finding(fx.home, found.id).status, workItem(fx.home, fix.id).status], ['dispositioned', 'verifying'], 'no execution of the named check on candidate 2: the finding is not resolved and its fix is not complete');

    // The check that showed the defect passes on candidate 2: the evaluation resolves the finding and completes the fix.
    const [proof] = await passAll(fx.engine, project, c2.id, [k.regress]);
    const verified = await stageGate(fx, ctx, c2);
    assert.equal(verified.outcome, 'satisfied', `reasons: ${reasonCodes(verified).join(', ')}`);
    const resolved = finding(fx.home, found.id);
    assert.equal(resolved.status, 'resolved');
    assert.deepEqual(JSON.parse(resolved.resolution_verification), { evaluation: verified.id, check_result: proof.id }, 'the resolution names the evaluation and the execution that verified it');
    assert.equal(eventsOfType(fx.home, 'finding.resolved').length, 1);
    assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, fix.id)), WORK.kinds.fix.path, "the fix's work is complete with the evaluation that resolved its finding");

    // The verification is invalidated: a developer's commit on the integration branch is adopted.
    commitOnRef(ctx.project.repo.path, ctx.project.repo.ref, { 'src/hotfix.js': 'export const hotfix = true;\n' }, { message: 'developer: a commit the engine did not make' });
    await tick(fx.engine, project);
    const [observed] = outOfBand(fx.home, project);
    await answerDecision(fx.engine, project, observed.decision.id, 'adopt');
    await waitFor(() => checkResult(fx.home, proof.id).invalidated_at !== null, { what: 'the verifying result to be invalidated' });
    await waitFor(() => finding(fx.home, found.id).status === 'open', { what: 'the finding to be reopened' });
    assert.equal(eventsOfType(fx.home, 'finding.reopened').length, 1);
    const reopened = await stageGate(fx, ctx, c2);
    assert.ok(reasonSubjects(reopened, 'FINDING_UNSATISFIED').includes(found.id), `the reopened finding is asked about again (reasons: ${reasonCodes(reopened).join(', ')})`);
  });

  test('an exclusion that is proposed, and then assessed, excludes nothing before its required approval', async (t) => {
    const { fx, ctx, project, k, c1 } = await clean(t);
    const [found] = await raiseFindings(fx, project, c1.id, [defect('high', 'totals are wrong for refunded orders')]);
    const c2 = await successor(fx, ctx);
    await passAll(fx.engine, project, c2.id, [k.login]);
    const alpha = await alphaTarget(fx, ctx, c2);
    onlyReason(await alpha.evaluate(), 'FINDING_BLOCKING', found.id);

    // The Verifier proposes that the finding no longer applies to candidate 2.
    await acceptedRun(fx, project, 'verification', { subject: { candidate: c2.id }, result: { applicability: [{ finding: found.id, candidate: c2.id, reason: 'the refund path was removed', evidence: 'no caller of refund() remains in candidate 2' }] } });
    const [proposed] = assessmentsOf(fx.home, project);
    assert.deepEqual([proposed?.status, proposed?.finding, proposed?.candidate], ['proposed', found.id, c2.id]);
    onlyReason(await alpha.evaluate(), 'FINDING_BLOCKING', found.id);

    // An independent Reviewer assesses it and agrees.
    await review(fx, project, c2.id, { assessments: [{ assessment: proposed.id, verdict: 'not_applicable' }] });
    assert.equal(assessmentsOf(fx.home, project)[0].status, 'assessed', 'assessed is not approved: this finding blocks a gate, so the human owner must authorize the exclusion');
    onlyReason(await alpha.evaluate(), 'FINDING_BLOCKING', found.id);
  });

  test("a Reviewer's fix disposition is recorded at once, and the engine registers the fix work with it: one fix item naming the finding, no fixture, chained and waiting at the chain boundary; one still after ticks and a restart; none before the disposition", async (t) => {
    const { fx, ctx, project, k, c1 } = await clean(t);
    await passAll(fx.engine, project, c1.id, [k.login]);
    const [found] = await raiseFindings(fx, project, c1.id, [defect('medium', 'a session survives logout', { check: 'login', criterion: 'R1.1' })]);
    const fixes = () => workItemsOf(fx.home, project).filter((work) => work.kind === 'fix');

    // An open finding with no disposition has no fix work, however many ticks run.
    await tick(fx.engine, project);
    await tick(fx.engine, project);
    assert.deepEqual(fixes(), [], 'no fix work before a fix disposition is recorded');

    // The Reviewer proposes to fix it. Asking to fix relaxes nothing, so the disposition is recorded with the Reviewer's authority and no decision (E43); the engine registers the fix work in the same transaction.
    await review(fx, project, c1.id, { dispositions: [{ finding: found.id, disposition: 'fix' }] });
    const row = finding(fx.home, found.id);
    assert.deepEqual([row.status, row.disposition, row.disposition_authority], ['dispositioned', 'fix', 'reviewer'], 'the fix is a disposition the Reviewer records');
    const registered = fixes();
    assert.equal(registered.length, 1, 'with the disposition recorded, exactly one fix item exists, and no tick was needed');
    const [fix] = registered;
    assert.deepEqual(
      [fix.project, fix.subject?.finding, fix.status, fix.trigger_source, fix.trigger_id, fix.trigger_generation],
      [project, found.id, 'eligible', 'finding', found.id, 1],
      "the fix is on the candidate's project, names the finding it fixes, is eligible, and its trigger is the finding",
    );
    const created = eventsOfType(fx.home, 'work.created').find((event) => event.subject.work_item === fix.id);
    assert.ok(created && created.payload?.test_fixture !== true, 'the engine registered it: it is no fixture');
    assert.deepEqual(decisionsOn(fx.home, 'finding_disposition', found.id), [], 'no decision was asked of the human for the disposition');

    // It is work that a run's outcome created: at the default chain limit it waits for a person, with no run.
    const boundary = await openDecision(fx, project, 'blocker', fix.id);
    assert.deepEqual(boundary.options.map((option) => option.key).sort(), ['cancel', 'continue'], 'the fix waits at the chain boundary');
    assert.deepEqual([fixes()[0].status, fixes()[0].blocker?.reason, runsOf(fx.home, fix.id).length], ['eligible', 'max_chained_roles', 0], 'eligible, blocked at the chain limit, and not dispatched without a human step');

    // Once: further ticks and a restart register no second fix and ask no second question.
    await tick(fx.engine, project);
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, project);
    assert.deepEqual(fixes().map((work) => work.id), [fix.id], 'one fix item for the disposition, however many ticks run and across a restart');
    assert.deepEqual(decisionsOn(fx.home, 'blocker', fix.id).map((row) => row.id), [boundary.id], 'and one decision about it');
    assert.equal(runsOf(fx.home, fix.id).length, 0, 'still no run');
  });
});

describe('M42 the report of a run that was quarantined', () => {
  test("a Verifier whose domain could not at first be shown empty has its report recorded all the same: the Critical finding it reported is there when its verification completes, and the stage gate is not satisfied", async (t) => {
    const fx = await scriptedEngine(t, { config: { terminate_grace: 1, kill_grace: 1 } });
    const ctx = await nominated(fx);
    const project = ctx.project.id;
    const c1 = ctx.candidate;
    const stageWork = ctx.items[0];
    const k = (await installChecks(fx.engine, project, [check('login', { requirements: ['R1'] })])).id;
    // The one required check has passed: nothing but a finding can stand between this candidate and its stage gate.
    await passAll(fx.engine, project, c1.id, [k.login]);

    // The candidate's own verification, let through the chain boundary by a person. Its Verifier reports a Critical finding.
    const verification = workItemsOf(fx.home, project).find((work) => work.kind === 'verification' && work.subject?.candidate === c1.id);
    assert.ok(verification, 'the fixture is live: the nomination registered verification work');
    fx.scripted.script(verification.id, [roleThatHolds([], [], { findings: [{ category: 'security', severity: 'critical', message: 'the login accepts any password' }] })]);
    await consume(fx, project, await openDecision(fx, project, 'blocker', verification.id), 'continue');
    const { run, launch } = await runToHold(fx, project, verification.id);
    const domain = withStore(fx.home, (db) => db.prepare('SELECT "id" FROM "execution_domains" WHERE "run" = ?').get(run.id).id);

    // Whenever the verification work is found complete, the report is already recorded.
    const neverCompleteUnreported = () =>
      assert.ok(workItem(fx.home, verification.id).status !== 'complete' || findingsOf(fx.home, project).length === 1, "the verification work is complete and the finding its Verifier reported is not recorded");

    // The role sends its valid result and exits; the boundary cannot say whether its domain is empty.
    fx.scripted.boundary({ domains: { [domain]: BOUNDARY.unknown } });
    fx.scripted.release(verification.id);
    await waitFor(() => !fx.scripted.isLive(launch), { what: 'the role to send its result and exit' });
    await waitForQuarantine(fx.home, run.id);
    assertRunQuarantined(fx.home, run.id, { outcome: 'completed' });
    neverCompleteUnreported();

    // Termination is observed: the run ends with the outcome it had, and its work completes.
    fx.scripted.boundary({ domains: { [domain]: BOUNDARY.terminated } });
    await tick(fx.engine, project);
    await waitForRunState(fx.home, run.id, 'ended');
    assertRunEnded(fx.home, run.id, { outcome: 'completed', reason_class: 'none' });
    neverCompleteUnreported();
    await tickUntil(fx.engine, project, () => workItem(fx.home, verification.id).status === 'complete', { max: 4, what: "the candidate's verification to complete" });

    // What the Verifier reported is recorded, as it is for a run that was never quarantined.
    const reported = findingsOf(fx.home, project);
    assert.equal(reported.length, 1, 'the Critical finding the quarantined Verifier reported is recorded');
    const [found] = reported;
    assert.deepEqual([found.status, found.effective_severity, found.candidate, found.source_run], ['open', 'critical', c1.id, run.id]);

    // The stage gate the engine evaluates by itself when the verification completes counts the finding, and so does one asked for.
    const own = await tickUntil(fx.engine, project, () => evaluationsOf(fx.home, c1.id, 'stage').at(-1), { max: 4, what: 'the engine to evaluate the stage gate' });
    assert.deepEqual(evaluationsOf(fx.home, c1.id, 'stage').filter((evaluation) => evaluation.outcome === 'satisfied'), [], 'no evaluation of the stage gate was satisfied');
    assert.equal(own.outcome, 'not_satisfied');
    onlyReason(await stageGate(fx, ctx), 'FINDING_BLOCKING', found.id);
    assert.equal(workItem(fx.home, stageWork).status, 'verifying', "the stage's work is not complete");
  });
});
