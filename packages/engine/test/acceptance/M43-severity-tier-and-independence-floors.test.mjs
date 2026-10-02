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

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { acceptedRun, alphaException, alphaTarget, check, installChecks, nominated, passAll, postResult, raiseFindings, reasonCodes, reasonSubjects, review, scopeOf, signoffsOf, stageGate } from './harness/gates.mjs';
import { scriptedEngine } from './harness/runs.mjs';

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
