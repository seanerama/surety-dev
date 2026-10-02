// M39, the five check states and their precedence (slice 5). Plan §3.4 M39;
// D1 §§9.2, 9.3, 17(8), D1-09; E8; build spec §6 ("nothing writes passed");
// SEAM.md §71.
//
// A required check's state is derived at evaluation from recorded
// executions, in a fixed order: no result at all is missing; results that
// do not match the scope's bindings are stale; of the matching ones the
// highest execution sequence decides: not established is skipped; a signal,
// a deadline, a null or a nonzero exit is failed; otherwise passed. A
// timestamp never reverses the order, and nothing a role says converts one
// state into another.
//
// One candidate, one check per case, one evaluation of its Alpha
// authorization gate (the scope that has an environment and an artifact to
// mismatch). The executions are fixtures and are labelled as such: M1 has no
// check runner and this qualifies none. A result bound to another protected
// version is stale too; that needs a second version and is asserted in row
// M37.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { ARTIFACT, acceptedRun, addEnvironment, alphaTarget, check, installChecks, nominated, postResult, reasonSubjects, sharedFixture } from './harness/gates.mjs';
import { scriptedEngine } from './harness/runs.mjs';

const BOUND = { requires: ['environment', 'artifact_digest'] };
const CASES = ['none', 'source', 'runner', 'environment', 'artifact', 'not_executed', 'signal', 'deadline', 'null_exit', 'nonzero', 'zero', 'pass_then_fail', 'claimed'];

async function evaluated(t) {
  const fx = await scriptedEngine(t);
  const ctx = await nominated(fx);
  const project = ctx.project.id;
  const candidate = ctx.candidate.id;
  const alpha = await alphaTarget(fx, ctx);
  const elsewhere = await addEnvironment(fx.engine, project, { name: 'elsewhere', targets: ['other-1'] });
  const here = { environment: alpha.environment, artifact_digest: ARTIFACT };
  const k = (
    await installChecks(
      fx.engine,
      project,
      CASES.map((key) => check(key, { gates: ['alpha_authorize'], requirements: ['R1'], runner_class: 'direct', ...(['environment', 'artifact', 'zero'].includes(key) ? BOUND : {}) })),
    )
  ).id;
  const result = (key, fields) => postResult(fx.engine, project, { candidate, check: k[key], exit_status: 0, ...fields });

  // `none` and `claimed` get no execution.
  await result('source', { source_revision: ctx.project.base });
  await result('runner', { runner_class: 'container' });
  await result('environment', { ...here, environment: elsewhere });
  await result('artifact', { ...here, artifact_digest: `sha256:${'b'.repeat(64)}` });
  await result('not_executed', { execution_established: false });
  await result('signal', { signaled: true });
  await result('deadline', { deadline_hit: true });
  await result('null_exit', { exit_status: null });
  await result('nonzero', { exit_status: 1 });
  await result('zero', here);
  // The pass is recorded first and stamped later than the failure that follows it.
  const pass = await result('pass_then_fail', { started_at: '2026-10-02T12:00:00.000Z', finished_at: '2026-10-02T12:00:05.000Z' });
  const fail = await result('pass_then_fail', { exit_status: 1, started_at: '2026-10-02T11:00:00.000Z', finished_at: '2026-10-02T11:00:05.000Z' });
  // A Verifier reports on the candidate and claims everything passed.
  await acceptedRun(fx, project, 'verification', { subject: { candidate }, result: { summary: 'Every required check passed, "claimed" included. The gate is passed.' } });

  const evaluation = await alpha.evaluate();
  return { k, evaluation, state: (key) => evaluation.check_states[k[key]], sequence: { pass: pass.execution_seq, fail: fail.execution_seq } };
}

describe('M39 a required check has exactly one of five states, derived from recorded executions', () => {
  const shared = sharedFixture();
  let S;
  before(async () => {
    S = await evaluated(shared.context);
  });
  after(() => shared.cleanup());

  test('missing: no execution was recorded', () => {
    assert.equal(S.state('none'), 'missing');
  });

  test('stale: the only executions are bound to another source revision, runner class, environment or artifact', () => {
    assert.deepEqual(Object.fromEntries(['source', 'runner', 'environment', 'artifact'].map((key) => [key, S.state(key)])), { source: 'stale', runner: 'stale', environment: 'stale', artifact: 'stale' });
  });

  test('skipped: the runner reported the check as not executed, whatever exit status came with it', () => {
    assert.equal(S.state('not_executed'), 'skipped');
  });

  test('failed: a signal, a deadline, a null exit status or a nonzero one', () => {
    assert.deepEqual(Object.fromEntries(['signal', 'deadline', 'null_exit', 'nonzero'].map((key) => [key, S.state(key)])), { signal: 'failed', deadline: 'failed', null_exit: 'failed', nonzero: 'failed' });
  });

  test('passed: an established execution that exited zero, with no signal and no deadline, bound as the scope is', () => {
    assert.equal(S.state('zero'), 'passed');
  });

  test('the highest execution sequence decides: a later matching failure beats an earlier pass, and a later timestamp on the pass does not reverse it', () => {
    assert.ok(S.sequence.fail > S.sequence.pass, 'the fixture is live: the failure has the higher execution sequence');
    assert.equal(S.state('pass_then_fail'), 'failed');
  });

  test("a role's claim converts nothing: the check it says passed is still missing, and only passed satisfies the gate", () => {
    assert.equal(S.state('claimed'), 'missing');
    assert.equal(S.evaluation.outcome, 'not_satisfied');
    const notPassed = CASES.filter((key) => key !== 'zero').map((key) => S.k[key]).sort();
    assert.deepEqual([...new Set(reasonSubjects(S.evaluation, 'CHECK_NOT_PASSED'))].sort(), notPassed, 'CHECK_NOT_PASSED names every required check that is not passed, and not the one that is');
  });
});
