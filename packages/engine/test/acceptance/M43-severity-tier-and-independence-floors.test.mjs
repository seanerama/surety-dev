// M43, severity, tier and independence floors (slice 5). Plan §3.4 M43; D1
// §§9.1, 9.3(5), 9.3(6), D1-09, D1-24; F §§5.7, 6.1, 6.3; E12; SEAM.md §75.
//
// A tier's obligations are cumulative: T2 requires what T1 requires and
// more, T3 what T2 requires and more, and every sign-off the tier names is
// needed, bound to what was reviewed. At Alpha a Critical finding blocks; a
// High finding blocks unless its exception is recorded, and still blocks in
// a sensitive area; the exception waives no check. The outcome is computed
// from what the engine recorded, never from what a role says.
//
// The check executions and the Alpha exception's evidence are fixtures and
// are labelled as such. Who may lower a severity is row M51.
//
// The last group pins who schedules the review a tier requires (E36 item 3,
// which closes E35; SEAM.md §70): the engine, once the candidate's
// verification has completed with its required checks passed. It is here
// because this row is the one that says which tiers need the Reviewer's
// sign-off. The cases above make their Reviewer's work with the trigger
// fixture and never let the candidate's verification run, so no review is
// queued in them.
//
// Objection 209 at T2 and T3 (Sean's request of 2026-10-23 on the D-2 ruling,
// errata E180; SEAM.md §564): a plain fix on a stage verified earlier makes
// the engine evaluate that stage's gate again, on the fix's candidate (D-2).
// The review that evaluation queues is the one the fix's candidate needs: its
// acceptance content (the fix) is new and unreviewed, and every gate of it at
// T2 and T3 needs a Reviewer's sign-off bound to that content (D1 §9.3 (6);
// E36 item 3: the engine queues a candidate's review once its verification
// passes; E41 item 4: a sign-off binds the content reviewed; E43: on the
// fix's candidate "the engine queues its review and the Reviewer signs it
// off"). Exactly one is queued per candidate and content (the trigger
// identity, reviewGeneration); the verified stage's own candidate gets no new
// one; ticks, a restart, a stale re-evaluation, evaluations asked for, an
// evaluation after the sign-off and a second fix on the same stage queue no
// duplicate; a fix no evaluation can judge (D-3) gets none, before or after
// retry; and an `asset_updated` fix (D7 §6.5) on the same stage queues the
// same, one for its candidate, observed in the same project.
//
// The group before it is the slice-5 review's finding (E41 item 4): a
// sign-off binds the acceptance content its Reviewer's run was started on.
// The engine the review ran bound it to the content in force when the report
// was recorded, so a check added while the review was under way was covered
// by a sign-off that never saw it.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { consume, decisionsOn, openDecision } from './harness/decisions.mjs';
import { waitFor } from './harness/engine.mjs';
import {
  PROTECTED_FILES,
  acceptedRun,
  alphaException,
  alphaTarget,
  check,
  classify,
  effectiveVersion,
  installChecks,
  nominated,
  passAll,
  postResult,
  raiseFindings,
  reasonCodes,
  reasonSubjects,
  review,
  scopeOf,
  signoffsOf,
  stageGate,
} from './harness/gates.mjs';
import { addGitProject, roleThatHolds, runToHold } from './harness/gitruns.mjs';
import { changePolicy, eventsOfType, workItemsOf } from './harness/journal.mjs';
import { addWork, runsOf, scriptedEngine, tick, tickUntil, waitForRunState, workItem } from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';
import { withStore as withStoreReadOnly } from './harness/store.mjs';
import { step } from './harness/scripted.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { successor } from './harness/gates.mjs';
import { buildAndNominate, findingRow, repairProject } from './harness/checks/repair.mjs';
import { def, inventoryDefs } from './harness/checks/scope.mjs';
import { operatorRequest, recordExit } from './harness/checks/selection.mjs';
import { fixUnjudged, ownerFix, verified } from './harness/checks/stuck-fix.mjs';

// One check of each kind F §5.7 names, with the tier from which it is required.
const CHECKS = [
  check('acceptance', { kind: 'acceptance', requirements: ['R1'] }),
  check('smoke', { kind: 'smoke' }),
  check('integration', { kind: 'integration', tier_floor: 'T2' }),
  check('security_lint', { kind: 'security_lint', tier_floor: 'T2' }),
  check('property', { kind: 'property', tier_floor: 'T3' }),
  check('failure_recovery', { kind: 'failure_recovery', tier_floor: 'T3' }),
];
const MODULES = [{ name: 'core', paths: ['src/'] }, { name: 'billing', paths: ['billing/'] }];
// What each tier requires, and the sign-offs it needs, in the order the case records them.
const TIERS = {
  T1: { required: ['acceptance', 'smoke'], signoffs: [] },
  T2: { required: ['acceptance', 'smoke', 'integration', 'security_lint'], signoffs: [[{ scope: 'candidate' }]] },
  T3: {
    required: ['acceptance', 'smoke', 'integration', 'security_lint', 'property', 'failure_recovery'],
    signoffs: [[{ scope: 'candidate' }], [{ scope: 'module', module: 'core' }, { scope: 'module', module: 'billing' }, { scope: 'security' }]],
  },
};

describe('M43 the obligations of a tier are cumulative, and every sign-off it names is needed', () => {
  for (const [tier, expect] of Object.entries(TIERS)) {
    test(`${tier}: requires ${expect.required.join(', ')}; ${expect.signoffs.flat().length === 0 ? 'no sign-off' : `sign-offs ${expect.signoffs.flat().map((s) => s.module ?? s.scope).join(', ')}`}`, async (t) => {
      const fx = await scriptedEngine(t);
      // The stage lists both modules: a stage scope's modules are its stage's (D3 §4.1; M3 slice 20, SEAM.md §226), so T3 asks a sign-off of each.
      const ctx = await nominated(fx, { autonomy: 'step', tier, modules: MODULES, stages: [{ number: 1, goal: 'the first stage', implements: ['R1'], modules: MODULES.map((m) => m.name) }] });
      const project = ctx.project.id;
      const k = (await installChecks(fx.engine, project, CHECKS)).id;
      // Every check passes, including those this tier does not require.
      await passAll(fx.engine, project, ctx.candidate.id, Object.values(k));

      let evaluation = await stageGate(fx, ctx);
      const scope = scopeOf(fx.home, evaluation);
      assert.deepEqual([...scope.required].sort(), expect.required.map((key) => k[key]).sort(), `the required set at ${tier}`);
      for (const step of expect.signoffs) {
        assert.deepEqual(reasonCodes(evaluation), ['SIGNOFF_MISSING'], `with ${step.map((s) => s.module ?? s.scope).join(', ')} not yet recorded, a sign-off is missing and nothing else is`);
        await review(fx, project, ctx.candidate.id, { signoffs: step });
        evaluation = await stageGate(fx, ctx);
      }
      assert.equal(evaluation.outcome, 'satisfied', `with every sign-off of ${tier} recorded the gate is satisfied (reasons: ${reasonCodes(evaluation).join(', ')})`);

      const recorded = signoffsOf(fx.home, ctx.candidate.id);
      const listed = (entries) => entries.map((entry) => JSON.stringify(entry)).sort();
      assert.deepEqual(listed(recorded.map((row) => [row.role, row.scope, row.module ?? null])), listed(expect.signoffs.flat().map((s) => ['reviewer', s.scope, s.module ?? null])), 'the sign-offs recorded are the Reviewer\'s, one per obligation');
      for (const row of recorded) assert.deepEqual([row.revision, row.acceptance_content_hash], [ctx.candidate.revision, scope.acceptance_content_hash], 'each is bound to the revision and to the content that was reviewed');
    });
  }
});

describe('M43 severity at Alpha', () => {
  test("a Critical finding blocks; a High finding blocks unless its exception is recorded, and still blocks in a sensitive area; the exception waives no check; and a role's verdict decides nothing", async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await nominated(fx, { autonomy: 'step' });
    const project = ctx.project.id;
    const k = (await installChecks(fx.engine, project, [check('login', { requirements: ['R1'] }), check('import', { requirements: ['R1'] })])).id;
    await passAll(fx.engine, project, ctx.candidate.id, [k.login]);
    // M5 slice 37 (D6 K1, K2; objection 100, with objection 030's remedy;
    // SEAM.md §447): the failed result below sends the stage's work to its
    // repair, which K1's requested tick would dispatch beside the fixture
    // roles' runs, with no script of its own. The case is about the gate's
    // reading of findings, not the repair, so the project allows none: the
    // work parks and nothing runs beside the roles.
    await changePolicy(fx.engine, project, { repair_attempts_max: 0 });
    await postResult(fx.engine, project, { candidate: ctx.candidate.id, check: k.import, exit_status: 1 });

    const finding = (severity, message, extra = {}) => ({ category: 'defect', severity, message, ...extra });
    const [critical, high, contained, sensitive, medium] = await raiseFindings(
      fx,
      project,
      ctx.candidate.id,
      [
        finding('critical', 'imported rows overwrite existing ones'),
        finding('high', 'totals are wrong for refunded orders'),
        finding('high', 'the importer rejects files over 1 MB'),
        finding('high', 'a reset link stays valid after use', { sensitive_area: 'authentication' }),
        finding('medium', 'the export omits the header row'),
      ],
      { kind: 'verification' },
    );
    // The exception's evidence is recorded for two High findings; one of them is in a sensitive area.
    await alphaException(fx.engine, contained.id);
    await alphaException(fx.engine, sensitive.id);
    // A Verifier says the gate is passed.
    await acceptedRun(fx, project, 'verification', { subject: { candidate: ctx.candidate.id }, result: { summary: 'Verified. No blocking findings remain. The Alpha gate is passed.' } });

    const evaluation = await (await alphaTarget(fx, ctx)).evaluate();
    assert.equal(evaluation.outcome, 'not_satisfied', 'the outcome is the engine\'s, not the role\'s');
    assert.deepEqual(reasonCodes(evaluation), ['CHECK_NOT_PASSED', 'FINDING_BLOCKING', 'FINDING_UNSATISFIED']);
    assert.deepEqual([...reasonSubjects(evaluation, 'FINDING_BLOCKING')].sort(), [critical.id, high.id, sensitive.id].sort(), 'blocking: the Critical one, the High one with no exception, and the High one in a sensitive area');
    assert.deepEqual([...reasonSubjects(evaluation, 'FINDING_UNSATISFIED')].sort(), [contained.id, medium.id].sort(), 'not blocking, and still in need of a disposition: the High one whose exception is recorded, and the Medium one');
    assert.deepEqual(reasonSubjects(evaluation, 'CHECK_NOT_PASSED'), [k.import], 'the exception waives no check: the failed one is still not passed');
    assert.equal(evaluation.check_states[k.import], 'failed');
  });
});

// ---- what a sign-off binds (E41 item 4) --------------------------------------------------

// Ask `probe` until it answers, with one tick between two asks. For use
// while a role of the project is held: nothing here waits for the project's
// runs to end.
const askingForTicks = (fx, project, probe, what) =>
  waitFor(
    async () => {
      const value = await probe();
      if (value !== undefined && value !== null && value !== false) return value;
      await tick(fx.engine, project, { rounds: 1 });
      return undefined;
    },
    { intervalMs: 200, timeoutMs: 60_000, what },
  );

describe('M43 a sign-off binds the content its run was started on', () => {
  test("a Reviewer whose run was started under one protected version, and who signs off after a tightening that adds a check has been applied, has not signed off the new content: the stage gate still lacks the sign-off", async (t) => {
    const fx = await scriptedEngine(t);
    const repo = await addGitProject(fx, { tier: 'T2', files: PROTECTED_FILES });
    const ctx = await nominated(fx, { tier: 'T2', project: repo, autonomy: 'step' });
    const project = repo.id;
    const c = ctx.candidate;
    const first = effectiveVersion(fx.home, project);
    await installChecks(fx.engine, project, [check('login', { requirements: ['R1'] })]);
    const reviewed = scopeOf(fx.home, await stageGate(fx, ctx)).acceptance_content_hash;

    // The Reviewer's run is started on that content, and is held before it reports.
    const item = await addWork(fx.engine, project, 'review', { subject: { candidate: c.id } });
    fx.scripted.script(item, [roleThatHolds([], [], { signoffs: [{ scope: 'candidate' }] })]);
    const { run } = await runToHold(fx, project, item);

    // Meanwhile the owner tightens the protected checks: a governed edit, classified, approved and applied.
    const edit = await fx.engine.post(`/v1/projects/${project}/policy`, { check_commands: { login: { path: '/usr/bin/node' }, audit: { path: '/usr/bin/node' } } });
    assert.equal(edit.status, 202, `a governed edit becomes a proposal (body: ${edit.text})`);
    const proposal = edit.body.proposal.id;
    await classify(fx.engine, proposal, 'tightening');
    const decision = await askingForTicks(fx, project, () => decisionsOn(fx.home, 'check_correction_tightening', proposal).find((row) => row.status === 'open'), 'the tightening to be offered for approval');
    await consume(fx, project, decision, 'approve');
    await askingForTicks(fx, project, () => effectiveVersion(fx.home, project).id !== first.id, 'the approved tightening to be applied');
    // The new version's checks (what D3 would discover in it): the one there was, and a new one. Both pass.
    const k = (await installChecks(fx.engine, project, [check('login', { requirements: ['R1'] }), check('audit', { requirements: ['R1'] })])).id;
    await passAll(fx.engine, project, c.id, Object.values(k));
    const changed = await stageGate(fx, ctx);
    assert.notEqual(scopeOf(fx.home, changed).acceptance_content_hash, reviewed, 'the fixture is live: the acceptance content changed while the review was under way');
    assert.deepEqual(reasonCodes(changed), ['SIGNOFF_MISSING'], "the fixture is live: the Reviewer's sign-off is all the gate lacks under the new content");

    // The Reviewer, whose run was started on the earlier content, now signs off.
    fx.scripted.release(item);
    await waitForRunState(fx.home, run.id, 'ended');
    for (const row of signoffsOf(fx.home, c.id)) {
      assert.equal(row.acceptance_content_hash, reviewed, 'a sign-off is bound to the content its run was started on, not to the content in force when its report was recorded');
    }
    assert.deepEqual(reasonCodes(await stageGate(fx, ctx)), ['SIGNOFF_MISSING'], 'a sign-off given on the earlier content does not count toward the new content');
    assert.equal(workItem(fx.home, ctx.items[0]).status, 'verifying', "and the stage's work is not complete");
  });
});

// ---- who schedules the review (E36 item 3) --------------------------------------------

const reviewsOf = (fx, project) => workItemsOf(fx.home, project).filter((work) => work.kind === 'review');

// A nominated candidate of `tier` with one required check declared, and the
// verification work its nomination registered, which waits at the chain
// boundary. `verify()` is the person letting it through, and its run, which
// changes nothing and reports completion.
async function verifiable(t, tier, { policy } = {}) {
  const fx = await scriptedEngine(t);
  fx.scripted.defaultScript(script.complete());
  const ctx = await nominated(fx, { tier, policy, autonomy: 'step' });
  const project = ctx.project.id;
  const k = (await installChecks(fx.engine, project, [check('login', { requirements: ['R1'] })])).id;
  const verification = workItemsOf(fx.home, project).find((work) => work.kind === 'verification' && work.subject?.candidate === ctx.candidate.id);
  assert.ok(verification, "the fixture is live: the nomination registered the candidate's verification work");
  const verify = async () => {
    await consume(fx, project, await openDecision(fx, project, 'blocker', verification.id), 'continue');
    await tickUntil(fx.engine, project, () => workItem(fx.home, verification.id).status === 'complete', { what: "the candidate's verification to complete" });
  };
  return { fx, ctx, project, c: ctx.candidate, k, verify };
}

describe('M43 the engine queues the review a tier requires', () => {
  test("T2: the candidate's review is queued by the engine once its verification has completed with its required check passed: not at the nomination, not while the check is failed, and once", async (t) => {
    // The failed check below is recorded while the stage's work is verifying on the candidate, so under Q2 (D3 §2.10; E90 item 2) it sends the stage
    // back to its Builder, whose repair's candidate supersedes this one. This case is about the review the engine queues, not the repair: at
    // repair_attempts_max 0 the stage's work is parked instead, and the candidate stays current (objection 030).
    const { fx, ctx, project, c, k, verify } = await verifiable(t, 'T2', { policy: { repair_attempts_max: 0 } });

    // The check has passed and the Verifier has not run: nothing is queued at the nomination, or by the check alone.
    await passAll(fx.engine, project, c.id, [k.login]);
    await tick(fx.engine, project);
    assert.deepEqual(reviewsOf(fx, project), [], "no review before the candidate's verification has completed");

    // The candidate is verified with its required check failed: it gets no review, however many ticks run, nor at an evaluation asked for.
    await postResult(fx.engine, project, { candidate: c.id, check: k.login, exit_status: 1 });
    await verify();
    await tick(fx.engine, project);
    await tick(fx.engine, project);
    assert.ok(reasonCodes(await stageGate(fx, ctx)).includes('CHECK_NOT_PASSED'), 'the fixture is live: an evaluation with the verification complete and the check failed');
    assert.deepEqual(reviewsOf(fx, project), [], 'a candidate whose verification fails gets no review');

    // A later execution passes. The engine queues the review itself, in the stage gate's evaluation. Under Q2 the ticks no longer evaluate this
    // candidate's stage gate by themselves (SEAM.md §70: they evaluate the gate of stage work still verifying, and the failure took it out of
    // verifying), so the evaluation is asked for: where this case had a tick queue it, the Q2 behaviour is pinned (objection 030).
    await passAll(fx.engine, project, c.id, [k.login]);
    await stageGate(fx, ctx);
    const [queued] = reviewsOf(fx, project);
    assert.ok(queued, "the engine queued the candidate's review in the evaluation");
    assert.deepEqual(
      [queued.subject?.candidate, queued.trigger_source, queued.trigger_id, queued.trigger_generation],
      [c.id, 'verification', c.id, 1],
      "the review is about the candidate, and its trigger is the candidate's verification",
    );
    const created = eventsOfType(fx.home, 'work.created').find((event) => event.subject.work_item === queued.id);
    assert.ok(created && created.payload?.test_fixture !== true, 'the engine registered it: it is no fixture');
    assert.deepEqual(reasonCodes(await stageGate(fx, ctx)), ['SIGNOFF_MISSING'], "the fixture is live: the Reviewer's sign-off is all the candidate's stage gate still lacks");

    // It is work that a run's outcome led to: at the default chain limit it waits for a person, and no role is launched for it.
    const boundary = await openDecision(fx, project, 'blocker', queued.id);
    assert.deepEqual(boundary.options.map((option) => option.key).sort(), ['cancel', 'continue'], 'the review waits at the chain boundary');
    assert.deepEqual([workItem(fx.home, queued.id).status, runsOf(fx.home, queued.id).length], ['eligible', 0], 'eligible, and not dispatched without a human step');

    // Once: further ticks and a restart queue no second review and ask no second question.
    await tick(fx.engine, project);
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, project);
    assert.deepEqual(reviewsOf(fx, project).map((work) => work.id), [queued.id], 'one review for the candidate, however many ticks run and across a restart');
    assert.deepEqual(decisionsOn(fx.home, 'blocker', queued.id).map((row) => row.id), [boundary.id], 'and one decision about it');
  });

  test('T1 requires no sign-off, and no review is queued: verified with its required check passed, the candidate has none', async (t) => {
    const { fx, ctx, project, c, k, verify } = await verifiable(t, 'T1');
    await passAll(fx.engine, project, c.id, [k.login]);
    await verify();
    await tick(fx.engine, project);
    await tick(fx.engine, project);
    assert.equal((await stageGate(fx, ctx)).outcome, 'satisfied', 'the fixture is live: the check has passed, and T1 asks for no sign-off');
    assert.deepEqual(reviewsOf(fx, project), [], 'a tier that needs no sign-off gets no review');
  });
});

// The reviews the engine queued (trigger: the candidate's verification), of a candidate or all.
const engineReviews = (fx, project, candidate) =>
  workItemsOf(fx.home, project).filter((w) => w.kind === 'review' && w.trigger_source === 'verification' && (candidate === undefined || w.subject?.candidate === candidate));
const SIGNOFFS = Object.freeze({ T2: [{ scope: 'candidate' }], T3: [{ scope: 'candidate' }, { scope: 'security' }] });
const defect209 = (message, check = 'acc') => ({ category: 'defect', severity: 'medium', message, check, criterion: 'R1.1' });

// A queued review let through the chain boundary by a person, its Reviewer signing what the tier needs.
async function signedOff(fx, project, item, tier) {
  fx.scripted.script(item.id, [roleThat([], { signoffs: SIGNOFFS[tier] })]);
  await consume(fx, project, await openDecision(fx, project, 'blocker', item.id), 'continue');
  await tickUntil(fx.engine, project, () => workItem(fx.home, item.id).status === 'complete', { what: `the review ${item.id} to complete` });
}

describe('M43 the review a tier requires when a fix makes a verified stage gate evaluate again (objection 209, D-2; E180)', () => {
  for (const tier of ['T2', 'T3']) {
    test(`${tier}: a plain fix on a verified stage queues exactly one review, for the fix's candidate, whose content is new; the verified stage's candidate gets none; ticks, a restart, a stale re-evaluation, evaluations asked for, one after the sign-off and a second fix on the same stage queue no duplicate; an unjudgeable fix gets none, before or after retry; an asset_updated fix's candidate gets one, as the plain fix's`, async (t) => {
      const fx = await scriptedEngine(t);
      // The tier's inventory, all covering or beside R1.1, and `login` (R1.1) required at alpha_authorize only (D-3's check).
      const defs = { ...inventoryDefs(tier, ['R1.1']), login: def('acceptance', { criteria: ['R1.1'], gates: ['alpha_authorize'] }) };
      const keys = Object.keys(defs);
      const p = await repairProject(fx, { tier, defs, governed: { required_checks: keys }, index: [{ key: 'R1', criteria: ['R1.1'] }], policy: { autonomy: 'step' } });
      const { candidate: c1 } = await buildAndNominate(fx, p, { keys });
      const ctx = { project: p, stage: p.stages[0].id, candidate: c1 };
      const stage = p.stages[0].work_item;
      const count = (candidate) => engineReviews(fx, p.id, candidate).length;

      // The stage verified on candidate 1: its review queued once, signed, the stage complete.
      await verified(fx, p, c1, { required: keys });
      const [r1] = await tickUntil(fx.engine, p.id, () => (engineReviews(fx, p.id, c1.id).length > 0 ? engineReviews(fx, p.id, c1.id) : undefined), { max: 8, what: "candidate 1's review" });
      await signedOff(fx, p.id, r1, tier);
      await tickUntil(fx.engine, p.id, () => workItem(fx.home, stage).status === 'complete', { max: 12, what: 'the stage verified on candidate 1' });
      assert.equal(count(c1.id), 1, 'the fixture is live: one review of candidate 1, signed, the stage verified');

      // (a)/(b) A plain fix on the verified stage: D-2 evaluates the stage's gate again on the fix's candidate.
      const [f1] = await raiseFindings(fx, p.id, c1.id, [defect209(`${tier} fix 1`)], { kind: 'verification' });
      const { fix: fix1 } = await ownerFix(fx, p, f1);
      const c2 = await successor(fx, ctx, { work: fix1.id });
      await verified(fx, p, c2, { required: keys });
      await tick(fx.engine, p.id, { rounds: 4 });
      assert.deepEqual([findingRow(fx.home, f1.id).status, workItem(fx.home, fix1.id).status], ['resolved', 'complete'], "the fixture is live: D-2 evaluated the verified stage's gate on the fix's candidate, resolving the finding");
      const onC2 = engineReviews(fx, p.id, c2.id);
      assert.equal(onC2.length, 1, `${tier} (b): the fix's candidate, whose content (the fix) no Reviewer has signed, gets exactly one review (${JSON.stringify(onC2.map((w) => [w.id, w.trigger_generation, w.status]))})`);
      assert.deepEqual([onC2[0].trigger_id, onC2[0].trigger_generation], [c2.id, 1], "triggered by the fix candidate's verification, generation 1");
      assert.ok(eventsOfType(fx.home, 'work.created').some((e) => e.subject.work_item === onC2[0].id && e.payload?.test_fixture !== true), "the engine's, no fixture");
      assert.deepEqual([workItem(fx.home, onC2[0].id).status, runsOf(fx.home, onC2[0].id).length], ['eligible', 0], 'chained work: it waits at the chain boundary for a person, no Reviewer launched');
      assert.equal(count(c1.id), 1, "the verified stage's own candidate gets no new review");

      // (c) No duplicate: ticks, a restart, a stale re-evaluation (a new result), and evaluations asked for.
      await tick(fx.engine, p.id, { rounds: 3 });
      await fx.engine.kill();
      await fx.start();
      await tick(fx.engine, p.id);
      const { acc: again } = await operatorRequest(fx.engine, p.id, c2.id, ['acc']);
      await recordExit(fx.engine, again, 0, { output: 'acc passed again\n' });
      await tick(fx.engine, p.id, { rounds: 2 });
      await stageGate(fx, ctx, c2);
      await stageGate(fx, ctx, c2);
      assert.deepEqual(engineReviews(fx, p.id, c2.id).map((w) => w.id), [onC2[0].id], `${tier} (c): one review of the fix's candidate however many ticks, restarts and evaluations`);
      // Signed: an evaluation after it queues none (the content it signed is the content in force).
      await signedOff(fx, p.id, onC2[0], tier);
      await stageGate(fx, ctx, c2);
      await tick(fx.engine, p.id, { rounds: 2 });
      assert.deepEqual(engineReviews(fx, p.id, c2.id).map((w) => [w.id, w.status]), [[onC2[0].id, 'complete']], `${tier} (c): signed, an evaluation after the sign-off queues no second`);

      // (c) A second fix on the same stage: one review for its own candidate, none more for the earlier ones.
      const [f2] = await raiseFindings(fx, p.id, c2.id, [defect209(`${tier} fix 2`)], { kind: 'verification' });
      const { fix: fix2 } = await ownerFix(fx, p, f2);
      const c3 = await successor(fx, ctx, { work: fix2.id });
      await verified(fx, p, c3, { required: keys });
      await tick(fx.engine, p.id, { rounds: 4 });
      assert.deepEqual([findingRow(fx.home, f2.id).status, workItem(fx.home, fix2.id).status], ['resolved', 'complete'], 'the fixture is live: the second fix judged on its candidate');
      await stageGate(fx, ctx, c3);
      await tick(fx.engine, p.id, { rounds: 2 });
      assert.deepEqual([count(c1.id), count(c2.id), count(c3.id)], [1, 1, 1], `${tier} (c): a second fix on the same stage: one review for its candidate, none more for the earlier ones`);

      // The asset_updated path (D7 §6.5) on the same stage, observed: its candidate's stage gate evaluated by the engine, one review.
      const asset = await addWork(fx.engine, p.id, 'fix', { subject: { cause: 'asset_updated', slot: 'logo', bindings: [{ stage: p.stages[0].id, slot: 'logo' }] } });
      fx.scripted.script(asset, [roleThat([step.write('src/logo-ref.js', 'export const logo = 2;\n')], { nominate: true })]);
      const before = workItemsOf(fx.home, p.id).length;
      const c4 = await tickUntil(fx.engine, p.id, () => withStoreCandidates(fx, p.id)[3], { max: 12, what: "the asset_updated fix's candidate" });
      assert.ok(JSON.parse(c4.held_work).includes(asset), `the fixture is live: candidate 4 holds the asset_updated fix (${c4.held_work}; ${before} items before)`);
      await verified(fx, p, c4, { required: keys });
      await tick(fx.engine, p.id, { rounds: 4 });
      const assetEvaluations = withStoreEvaluations(fx, c4.id);
      assert.ok(assetEvaluations.length > 0, `the fixture is live: the engine evaluated the stage's gate on the asset fix's candidate (D7 §6.5) (${JSON.stringify(assetEvaluations)})`);
      await stageGate(fx, ctx, c4);
      await tick(fx.engine, p.id, { rounds: 2 });
      assert.equal(count(c4.id), 1, `${tier}: the asset_updated path queues one review for its candidate, as the plain fix's path does (${JSON.stringify(engineReviews(fx, p.id, c4.id).map((w) => [w.id, w.trigger_generation]))})`);
      assert.deepEqual([count(c1.id), count(c2.id), count(c3.id)], [1, 1, 1], 'and none more for the earlier candidates');
      // Its review signed (so that the next finding's disposition is owed to the owner, no review being due).
      await signedOff(fx, p.id, engineReviews(fx, p.id, c4.id)[0], tier);
      await tick(fx.engine, p.id, { rounds: 2 });
      assert.equal(count(c4.id), 1, 'signed: still one');

      // A fix no evaluation can judge (D-3; login at alpha_authorize only): no evaluation, no review, before or after retry.
      const [f3] = await raiseFindings(fx, p.id, c4.id, [defect209(`${tier} fix 3, alpha only`, 'login')], { kind: 'verification' });
      const { fix: fix3 } = await ownerFix(fx, p, f3);
      const c5 = await successor(fx, ctx, { work: fix3.id });
      await verified(fx, p, c5, { required: keys });
      const blocker = await tickUntil(fx.engine, p.id, () => fixUnjudged(fx.home, fix3.id, { open: true })[0], { max: 8, what: 'the fix_unjudged blocker' });
      assert.equal(count(c5.id), 0, `${tier}: an unjudgeable fix's candidate gets no review (no stage evaluation of it is made)`);
      const runs = runsOf(fx.home, fix3.id).length;
      await consume(fx, p.id, await openDecision(fx, p.id, 'blocker', fix3.id), 'retry');
      await tick(fx.engine, p.id, { rounds: 4 });
      assert.deepEqual([count(c5.id), runsOf(fx.home, fix3.id).length], [0, runs], `${tier}: after retry, still no review and no Builder run (${blocker.id})`);
      assert.deepEqual([count(c1.id), count(c2.id), count(c3.id), count(c4.id)], [1, 1, 1, 1], 'and none more anywhere');
    });
  }
});

const withStoreCandidates = (fx, project) => withStoreRead(fx, (db) => db.prepare('SELECT * FROM "candidates" WHERE "project" = ? ORDER BY "seq"').all(project));
const withStoreEvaluations = (fx, candidate) => withStoreRead(fx, (db) => db.prepare(`SELECT "id", "gate_kind", "stage", "outcome" FROM "gate_evaluations" WHERE "candidate" = ? AND "gate_kind" = 'stage'`).all(candidate));
const withStoreRead = (fx, fn) => withStoreReadOnly(fx.home, fn);
