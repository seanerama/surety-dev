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
// version: the second describe block (M2 slice 1, entry A5; SEAM.md §103)
// lands an approved tightening between the two candidates and offers the
// first candidate's pass to the second under an assessed reuse entry.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { consume, openDecision } from './harness/decisions.mjs';
import {
  ARTIFACT,
  PROTECTED_FILES,
  addEnvironment,
  alphaTarget,
  assertApplied,
  capturedProposal,
  check,
  checkResult,
  effectiveVersion,
  installChecks,
  nominated,
  passAll,
  postResult,
  reasonCodes,
  reasonSubjects,
  reuseEvidence,
  scopeOf,
  sharedFixture,
  stageGate,
  successor,
  waitApplied,
} from './harness/gates.mjs';
import { refOid } from './harness/repos.mjs';
import { scriptedEngine } from './harness/runs.mjs';

const CASES = ['plain', 'reused', 'runner', 'environment', 'unassessed', 'record_only', 'waived'];

async function reuseHistory(t) {
  const fx = await scriptedEngine(t);
  const ctx = await nominated(fx);
  const project = ctx.project.id;
  const alpha1 = await alphaTarget(fx, ctx);
  const elsewhere = await addEnvironment(fx.engine, project, { name: 'elsewhere', targets: ['other-1'] });
  const declare = async (keys) =>
    (
      await installChecks(
        fx.engine,
        project,
        keys.map((key) => check(key, { gates: ['alpha_authorize'], requirements: ['R1'], runner_class: 'direct', ...(key === 'environment' ? { requires: ['environment', 'artifact_digest'] } : {}) })),
      )
    ).id;
  const prior = {};
  const execute = async (key, fields = {}) => (prior[key] = await postResult(fx.engine, project, { candidate: ctx.candidate.id, check: k[key], exit_status: 0, ...fields }));

  // Candidate 1's execution of a check declared before the source change. It exits zero.
  const k = await declare(['plain']);
  await execute('plain', { output: 'plain: ok\n' });
  const stored = { plain: checkResult(fx.home, prior.plain.id) };

  // A source change and a new candidate. The other checks are declared after
  // its nomination, so it registers none of them: a registration of the
  // later candidate would make each `missing` whatever is reused (L7; M3
  // slice 16, SEAM.md §§189, 191; COVERAGE.md "M3 slice 16"). Candidate 1's
  // executions of them follow; two are bound to a runner class or an
  // environment the scope does not have.
  const c2 = await successor(fx, ctx);
  Object.assign(k, await declare(CASES.filter((key) => key !== 'plain')));
  await execute('reused');
  await execute('runner', { runner_class: 'container' });
  await execute('environment', { environment: elsewhere, artifact_digest: ARTIFACT });
  await execute('unassessed');
  for (const key of ['reused', 'runner', 'environment', 'unassessed']) stored[key] = checkResult(fx.home, prior[key].id);

  // The reuse entries offered for the new candidate.
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

// M2 slice 1, A5 (SEAM.md §103). D1 §7.9 ("invalidates dependent evaluations
// and results"), §9.2; build spec §6 corrections 17 and 18.
describe('M41 a result is not reused across a change of the protected checks', () => {
  test('a pass recorded for an earlier candidate under the version before an approved tightening landed, offered to a later candidate nominated under the new version by an assessed reuse entry, does not pass: the check is stale, and only a new execution under the new version satisfies it', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await nominated(fx, { files: PROTECTED_FILES });
    const project = ctx.project.id;
    const c1 = ctx.candidate;
    const first = effectiveVersion(fx.home, project);
    const k1 = (await installChecks(fx.engine, project, [check('login', { requirements: ['R1'] })])).id;
    const [prior] = await passAll(fx.engine, project, c1.id, [k1.login]);
    assert.equal((await stageGate(fx, ctx)).outcome, 'satisfied', 'the fixture is live: the pass satisfies the stage gate of candidate 1');

    // Between the two candidates the protected checks change: a tightening a Verifier proposed is approved by the human and applied.
    const headBefore = refOid(ctx.project.repo.path, ctx.project.repo.ref);
    const proposal = await capturedProposal(fx, ctx.project, { changeKind: 'tightening' });
    await consume(fx, project, await openDecision(fx, project, 'check_correction_tightening', proposal.id), 'approve');
    await waitApplied(fx, ctx.project, proposal);
    const version = assertApplied(fx, ctx.project, { proposal, previous: first, headBefore, authority: 'human', changeKind: 'tightening' });
    assert.ok(checkResult(fx.home, prior.id).invalidated_at, 'the fixture is live: the application invalidated the pass recorded under the old version (row M37)');

    // Candidate 2 is nominated under the new version; the new version's checks are declared; candidate 1's pass is offered to it.
    const c2 = await successor(fx, ctx);
    assert.equal(c2.nominated_protected_version, version.id, 'the fixture is live: candidate 2 is nominated under the new version');
    const declared = await installChecks(fx.engine, project, [check('login', { requirements: ['R1'] })]);
    assert.equal(declared.version, version.id, 'the fixture is live: the check now declared is the new version\'s');
    await reuseEvidence(fx.engine, { project, candidate: c2.id, check: declared.id.login, check_result: prior.id, assessed: true });

    const evaluation = await stageGate(fx, ctx, c2);
    assert.equal(evaluation.check_states[declared.id.login], 'stale', 'the reused pass is bound to the superseded version: the check is stale, not passed');
    assert.deepEqual(reasonCodes(evaluation), ['CHECK_NOT_PASSED'], `the gate asks for an execution and nothing else (reasons: ${reasonCodes(evaluation).join(', ')})`);
    assert.deepEqual(reasonSubjects(evaluation, 'CHECK_NOT_PASSED'), [declared.id.login]);
    assert.equal(evaluation.outcome, 'not_satisfied');
    assert.deepEqual([...scopeOf(fx.home, evaluation).required], [declared.id.login], 'reuse removed nothing from the required set');

    // The honest way: an execution of the check for candidate 2 under the new version.
    await passAll(fx.engine, project, c2.id, [declared.id.login]);
    const renewed = await stageGate(fx, ctx, c2);
    assert.deepEqual([renewed.outcome, renewed.check_states[declared.id.login]], ['satisfied', 'passed'], 'a new execution under the new version satisfies the gate');
    assert.ok(checkResult(fx.home, prior.id).invalidated_at, 'and the old pass is still invalidated');
  });
});
