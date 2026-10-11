// M340 (a) and (b), the Switchboard mutant and its control (slice 29;
// project lane). M4 plan §3.7 M340; E120 item 2; AR §7; BS4 §11.2; D4 §§5.3,
// 5.4, 5.5; SEAM.md §§321, 322, 325.
//
// The reference project (harness/project/service.mjs), its required
// `post_deploy_behavior` check exercising the specified user operation
// (GET /sum?a=2&b=3 answers {"sum": 5}); the adapter qualified by command,
// no stand-in.
//   (a) The first candidate is the Switchboard mutant: its library is
//       correct, so its workspace checks pass; deployed, its /health answers
//       and both identity reads `match`, but its /sum hands the library the
//       query's strings and answers {"sum": "23"}: the check `failed`, the
//       verification `failed`, `alpha_complete` refused
//       (`DEPLOY_VERIFICATION_FAILED`), the candidate `developing`,
//       `last_verified` unchanged. Then torn down.
//   (b) The control: a fix whose Builder writes the correct service, a second
//       candidate, deployed to a fresh environment: `verified`,
//       `alpha_deployed`.
// (c), the mutant under a check that only probes health, is
// M340-a-check-that-only-probes-health.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §257). The test acts on no unit and
// signals nothing: the units are the engine's (the qualification's and the
// deployments'), under this test's home's prefix, removed by the engine. The
// services have no act; the secret is a disposable random value in a 0600
// file of the test's own, never printed. Every environment is ended in
// `finally`; the file ends with `operatorGuard`.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { addItem, roleThat, waitForCandidates } from './harness/gitruns.mjs';
import { runsOf } from './harness/runs.mjs';
import { candidateRow, deploy, environmentRecord } from './harness/deploy/kernel.mjs';
import { completion, reasonCodesOf } from './harness/deploy/rounds.mjs';
import { endEnvironment, operatorGuard, teardownOnHost, ticksUntil } from './harness/deploy/host.mjs';
import { outputText, resultRow, waitRecorded } from './harness/checks/fixtures.mjs';
import { SERVER, SWITCHBOARD, builderSteps, referenceDeployable, referenceEnvironment, reportOf, roundChecks, roundRow } from './harness/project/service.mjs';

const answerOf = (report, prefix) => report?.find((r) => r.path.startsWith(prefix));

describe('M340 the Switchboard mutant, and the correct service', () => {
  const shared = sharedFixture();
  let guard;
  let ctx;
  const A = {};
  const B = {};
  before(async () => {
    guard = operatorGuard();
    ctx = await referenceDeployable(shared.context, guard, { service: SWITCHBOARD });

    // (a) the mutant.
    const envA = await referenceEnvironment(ctx, 'mutant');
    try {
      A.request = await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, envA.name);
      A.round = await roundRow(ctx, envA);
      A.checks = roundChecks(ctx, A.round.round);
      A.completion = await completion(ctx.fx.engine, ctx.project, ctx.candidate.id, A.round.op.id);
      A.progress = candidateRow(ctx.fx.home, ctx.candidate.id).progress;
      A.record = environmentRecord(ctx.fx.home, envA.id);
      A.teardown = await teardownOnHost(ctx, envA);
    } finally {
      if (!A.teardown) await endEnvironment(ctx, envA);
    }

    // (b) the correct service, from a fix.
    const fix = await addItem(ctx.fx, ctx.project, 'fix');
    ctx.fx.scripted.script(fix, [roleThat(builderSteps({ service: SERVER }), { nominate: true })]);
    const built = await ticksUntil(ctx.fx, ctx.project, () => (runsOf(ctx.fx.home, fix)[0]?.state === 'ended' ? runsOf(ctx.fx.home, fix)[0] : undefined), { timeoutMs: 300_000, what: "the fix's Builder run to end" });
    assert.deepEqual([built.outcome, built.reason_class], ['completed', 'none'], `the fix's Builder run was accepted (${built.reason_text})`);
    B.candidate = (await waitForCandidates(ctx.fx, ctx.project, 2)).at(-1);
    await waitRecorded(ctx.fx, ctx.project, B.candidate.id, ['accept', 'smoke'], { what: "the correct candidate's workspace checks" });
    const envB = await referenceEnvironment(ctx, 'alpha');
    try {
      B.request = await deploy(ctx.fx.engine, ctx.project, B.candidate.id, envB.name);
      B.round = await roundRow(ctx, envB);
      B.checks = roundChecks(ctx, B.round.round);
      B.completed = await ticksUntil(ctx.fx, ctx.project, () => (candidateRow(ctx.fx.home, B.candidate.id).progress === 'alpha_deployed' ? true : undefined), { what: 'the correct candidate to be alpha_deployed' });
    } finally {
      await endEnvironment(ctx, envB);
    }
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('(a) the mutant passes its workspace checks and both identity reads match; its health answers', () => {
    for (const key of ['accept', 'smoke']) {
      const r = resultRow(ctx.fx.home, ctx.workspace[key]?.result);
      assert.deepEqual([r?.execution_established, r?.exit_status], [1, 0], `the mutant's ${key} check passed: the library is correct`);
    }
    assert.deepEqual(A.round.row.identity_reads.map((r) => [r.bracket, r.match]), [['first', 'match'], ['second', 'match']], 'both identity reads match: the tree is what was sealed');
    const op = A.checks.find((c) => c.key === 'operation');
    const report = reportOf(outputText(ctx.fx.home, op.result), 'REF-OPERATION');
    assert.equal(answerOf(report, '/health')?.status, 200, `the fixture is live: the mutant's health route answers (${JSON.stringify(report)})`);
  });

  test('(a) the specified user operation fails: the post-deploy check failed, the verification failed, alpha_complete DEPLOY_VERIFICATION_FAILED, the candidate developing, last_verified unchanged', () => {
    const op = A.checks.find((c) => c.key === 'operation');
    assert.ok(op?.result, 'the operation check has a result in the round');
    assert.deepEqual([op.result.execution_established, op.result.exit_status], [1, 1], 'it ran and failed');
    const sum = answerOf(reportOf(outputText(ctx.fx.home, op.result), 'REF-OPERATION'), '/sum');
    assert.deepEqual([sum?.status, sum?.body && JSON.parse(sum.body)], [200, { sum: '23' }], `the mutant answers the operation wrongly (${JSON.stringify(sum)})`);
    assert.equal(A.round.row.outcome, 'failed', `the verification is failed (${JSON.stringify({ outcome: A.round.row.outcome, missing: A.round.row.missing })})`);
    assert.ok(reasonCodesOf(A.completion).includes('DEPLOY_VERIFICATION_FAILED'), `alpha_complete refused, DEPLOY_VERIFICATION_FAILED (${reasonCodesOf(A.completion).join(', ')})`);
    assert.equal(A.progress, 'developing', 'the candidate stays developing');
    assert.equal(A.record?.last_verified ?? null, null, 'last_verified unchanged (never written)');
  });

  test('(b) the control, the correct service: verified; alpha_deployed', () => {
    const op = B.checks.find((c) => c.key === 'operation');
    const sum = answerOf(reportOf(outputText(ctx.fx.home, op.result), 'REF-OPERATION'), '/sum');
    assert.deepEqual([sum?.status, sum?.body && JSON.parse(sum.body)], [200, { sum: 5 }], `the correct service answers the operation (${JSON.stringify(sum)})`);
    assert.deepEqual([op.result.execution_established, op.result.exit_status], [1, 0], 'the check passed');
    assert.equal(B.round.row.outcome, 'verified');
    assert.equal(B.completed, true, 'alpha_deployed');
  });
});
