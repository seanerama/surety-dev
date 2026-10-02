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

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { consume, decisionsOn, openDecision } from './harness/decisions.mjs';
import { acceptedRun, alphaException, alphaTarget, check, installChecks, nominated, passAll, postResult, raiseFindings, reasonCodes, reasonSubjects, review, scopeOf, signoffsOf, stageGate } from './harness/gates.mjs';
import { eventsOfType, workItemsOf } from './harness/journal.mjs';
import { runsOf, scriptedEngine, tick, tickUntil, workItem } from './harness/runs.mjs';
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
      const ctx = await nominated(fx, { tier, modules: MODULES });
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

// ---- who schedules the review (E36 item 3) --------------------------------------------

const reviewsOf = (fx, project) => workItemsOf(fx.home, project).filter((work) => work.kind === 'review');

// A nominated candidate of `tier` with one required check declared, and the
// verification work its nomination registered, which waits at the chain
// boundary. `verify()` is the person letting it through, and its run, which
// changes nothing and reports completion.
async function verifiable(t, tier) {
  const fx = await scriptedEngine(t);
  fx.scripted.defaultScript(script.complete());
  const ctx = await nominated(fx, { tier });
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
    const { fx, ctx, project, c, k, verify } = await verifiable(t, 'T2');

    // The check has passed and the Verifier has not run: nothing is queued at the nomination, or by the check alone.
    await passAll(fx.engine, project, c.id, [k.login]);
    await tick(fx.engine, project);
    assert.deepEqual(reviewsOf(fx, project), [], "no review before the candidate's verification has completed");

    // The candidate is verified with its required check failed: it gets no review, however many ticks run.
    await postResult(fx.engine, project, { candidate: c.id, check: k.login, exit_status: 1 });
    await verify();
    await tick(fx.engine, project);
    await tick(fx.engine, project);
    assert.deepEqual(reviewsOf(fx, project), [], 'a candidate whose verification fails gets no review');

    // A later execution passes. The engine queues the review itself.
    await passAll(fx.engine, project, c.id, [k.login]);
    const queued = await tickUntil(fx.engine, project, () => reviewsOf(fx, project)[0], { max: 4, what: "the engine to queue the candidate's review" });
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
