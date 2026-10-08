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
import { eventsOfType, workItemsOf } from './harness/journal.mjs';
import { addWork, runsOf, scriptedEngine, tick, tickUntil, waitForRunState, workItem } from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';

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
      const ctx = await nominated(fx, { tier, modules: MODULES, stages: [{ number: 1, goal: 'the first stage', implements: ['R1'], modules: MODULES.map((m) => m.name) }] });
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
    const ctx = await nominated(fx);
    const project = ctx.project.id;
    const k = (await installChecks(fx.engine, project, [check('login', { requirements: ['R1'] }), check('import', { requirements: ['R1'] })])).id;
    await passAll(fx.engine, project, ctx.candidate.id, [k.login]);
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
    const ctx = await nominated(fx, { tier: 'T2', project: repo });
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
  const ctx = await nominated(fx, { tier, policy });
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
