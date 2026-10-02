// M41, typed evidence reuse (slice 5). Plan §3.4 M41; build spec §6
// correction 18; RN §3 B17; D1 §§9.1, 9.2; F §3.8; Review B17; SEAM.md §73.
//
// A result recorded for an earlier candidate counts for a later one only
// under a typed, assessed reuse entry that names that result. The entry
// lets the result's candidate and source revision differ; it lets nothing
// else differ: a result bound to another runner class or another
// environment does not pass by way of reuse. Reuse never removes a check
// from the required set. An entry that is not assessed, that offers a
// generic record instead of a result, or that offers nothing at all is
// refused, and the check stays unsatisfied: applicability is never invented.
//
// One history: candidate 1 with executions of several checks, candidate 2
// nominated after a source change, reuse entries for candidate 2, and one
// evaluation of candidate 2's Alpha authorization gate. The reuse entries
// are fixtures: M1 has no process that assesses reuse (F §3.8's is a later
// design's). With it, the half of row M27 that needed evidence: a source
// change after a nomination leaves the old candidate's evidence as it was.
// A reused result bound to another protected version needs a second
// version; it is not written (COVERAGE.md).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { ARTIFACT, addEnvironment, alphaTarget, check, checkResult, installChecks, nominated, postResult, reasonSubjects, reuseEvidence, scopeOf, sharedFixture, successor } from './harness/gates.mjs';
import { scriptedEngine } from './harness/runs.mjs';

const CASES = ['plain', 'reused', 'runner', 'environment', 'unassessed', 'record_only', 'waived'];

async function reuseHistory(t) {
  const fx = await scriptedEngine(t);
  const ctx = await nominated(fx);
  const project = ctx.project.id;
  const alpha1 = await alphaTarget(fx, ctx);
  const elsewhere = await addEnvironment(fx.engine, project, { name: 'elsewhere', targets: ['other-1'] });
  const k = (
    await installChecks(
      fx.engine,
      project,
      CASES.map((key) => check(key, { gates: ['alpha_authorize'], requirements: ['R1'], runner_class: 'direct', ...(key === 'environment' ? { requires: ['environment', 'artifact_digest'] } : {}) })),
    )
  ).id;

  // Candidate 1's executions. Each exits zero; two are bound to a runner class or an environment the scope does not have.
  const prior = {};
  const execute = async (key, fields = {}) => (prior[key] = await postResult(fx.engine, project, { candidate: ctx.candidate.id, check: k[key], exit_status: 0, ...fields }));
  await execute('plain', { output: 'plain: ok\n' });
  await execute('reused');
  await execute('runner', { runner_class: 'container' });
  await execute('environment', { environment: elsewhere, artifact_digest: ARTIFACT });
  await execute('unassessed');
  const stored = Object.fromEntries(Object.entries(prior).map(([key, result]) => [key, checkResult(fx.home, result.id)]));

  // A source change, a new candidate, and the reuse entries offered for it.
  const c2 = await successor(fx, ctx);
  const offer = (key, fields) => reuseEvidence(fx.engine, { project, candidate: c2.id, check: k[key], ...fields });
  await offer('reused', { check_result: prior.reused.id, assessed: true });
  await offer('runner', { check_result: prior.runner.id, assessed: true });
  await offer('environment', { check_result: prior.environment.id, assessed: true });
  await offer('unassessed', { check_result: prior.unassessed.id, assessed: false });
  await offer('record_only', { record: stored.plain.output, assessed: true });
  await offer('waived', { assessed: true });

  const evaluation = await (await alphaTarget(fx, ctx, c2, { environment: alpha1.environment })).evaluate();
  return { fx, k, prior, stored, c1: ctx.candidate, c2, evaluation, scope: scopeOf(fx.home, evaluation), state: (key) => evaluation.check_states[k[key]] };
}

describe('M41 a result of an earlier candidate counts only under a typed, assessed reuse entry', () => {
  const shared = sharedFixture();
  let S;
  before(async () => {
    S = await reuseHistory(shared.context);
  });
  after(() => shared.cleanup());

  test("without a reuse entry an earlier candidate's result is not the later candidate's, and the earlier candidate keeps its evidence as it was", () => {
    assert.equal(S.state('plain'), 'missing');
    for (const [key, row] of Object.entries(S.stored)) {
      assert.deepEqual(checkResult(S.fx.home, row.id), row, `the result of "${key}" recorded for candidate 1 is unchanged by the later nomination`);
      assert.deepEqual([row.candidate, row.source_revision], [S.c1.id, S.c1.revision]);
    }
  });

  test('an assessed entry that names the result lets it count, and removes nothing from the required set', () => {
    assert.equal(S.state('reused'), 'passed');
    assert.deepEqual([...S.scope.required].sort(), Object.values(S.k).sort(), 'every check is still required of candidate 2');
    assert.equal(S.evaluation.outcome, 'not_satisfied');
    assert.deepEqual([...new Set(reasonSubjects(S.evaluation, 'CHECK_NOT_PASSED'))].sort(), CASES.filter((key) => key !== 'reused').map((key) => S.k[key]).sort(), 'and every other check is still not passed');
  });

  test('a reused result bound to another runner class, or to another environment, does not pass', () => {
    assert.deepEqual([S.state('runner'), S.state('environment')], ['stale', 'stale']);
  });

  test('an entry that is not assessed, one that offers a generic record, and one that offers no result leave the check unsatisfied', () => {
    assert.deepEqual([S.state('unassessed'), S.state('record_only'), S.state('waived')], ['missing', 'missing', 'missing']);
  });
});
