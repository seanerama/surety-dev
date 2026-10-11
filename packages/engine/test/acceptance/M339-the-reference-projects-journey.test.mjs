// M339, the reference project's journey (slice 29; project lane, run with
// `npm test` like the sandbox lane, E92 item 2 (1)). M4 plan §3.7 M339;
// D4-T03; D4 §§1, 2.6, 5, 6.2, 6.3, 9.2; E40; BS4 §3 (the reference
// project); SEAM.md §§291 to 293, 321, 322, 325.
//
// D4 §1 end to end with the reference project (harness/project/service.mjs),
// scripted roles and no model, on a real unit, with no stand-in for the
// adapter or the runner: the check runner qualified by its own self-test at
// start (SEAM §208), the adapter by `surety qualify-adapter local_service` in
// the test's home. The Builder writes the service; the candidate is
// nominated; its workspace checks run in `check` domains; the owner
// configures `alpha` (the engine's own node, `server.mjs`, the one disposable
// secret by reference); the request is authorized and deployed; the round's
// `post_deploy_behavior` check exercises the specified user operation through
// the link; `verified`, `alpha_deployed`; the observation job reads it
// `healthy`; the test restarts the unit by hand (its launcher refused, the
// change recorded out of band, the decision raised); the decision is
// answered `teardown`; the teardown is `applied` and nothing of the prefix is
// left (M313's guard).
//
// SAFETY (BS4 §4.1 rules 1, 2, 7, 8; E64; SEAM.md §§257, 297). The test acts
// on one unit, once: the engine's own `-g1` unit of this test's home's prefix,
// named in its store's attempt intent, restarted by its exact name only after
// `assertServiceContained` read from the host that the unit carries this
// home's prefix and the recorded application is in its cgroup and in none of
// the host's namespaces (`restartOwnUnit`). It signals nothing. The service
// has no act; the secret is a disposable random value in a 0600 file of the
// test's own directory, never printed. The environment is ended in
// `finally`; the file ends with `operatorGuard`; every engine start carries
// the real-adapter switch.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { attemptsOf, candidateRow, deploy, environmentRecord, operationsOf, unitPrefix } from './harness/deploy/kernel.mjs';
import { cgroupsNamed, endEnvironment, hostUntil, operatorGuard, restartOwnUnit, ticksUntil, unitShow, unitsOfHome } from './harness/deploy/host.mjs';
import { answerOn } from './harness/deploy/recover.mjs';
import { historyOf, observeOnHost, oobDecision, oobRows } from './harness/deploy/observe.mjs';
import { qualificationRow } from './harness/deploy/qualify.mjs';
import { activeQualification } from './harness/checks/execution.mjs';
import { outputText } from './harness/checks/fixtures.mjs';
import { referenceDeployable, referenceEnvironment, reportOf, roundChecks, roundRow } from './harness/project/service.mjs';
import { withStore } from './harness/store.mjs';

const executionsWithResults = (home, candidate) =>
  withStore(home, (db) =>
    db
      .prepare(`SELECT x."id", x."status", x."domain", x."trigger", c."key" AS "key", r."execution_established", r."exit_status", r."runner_qualification" FROM "check_executions" x JOIN "checks" c ON c."id" = x."check" LEFT JOIN "check_results" r ON r."execution" = x."id" WHERE x."candidate" = ? ORDER BY x."execution_seq"`)
      .all(candidate),
  );
const domainRow = (home, id) => withStore(home, (db) => db.prepare('SELECT * FROM "execution_domains" WHERE "id" = ?').get(id));

describe("M339 the reference project's journey on a real unit, no stand-in", () => {
  const shared = sharedFixture();
  let guard;
  let J;
  before(async () => {
    guard = operatorGuard();
    const ctx = await referenceDeployable(shared.context, guard, { runnerSelfTest: true, qualify: 'command' });
    const env = await referenceEnvironment(ctx, 'alpha');
    J = { ctx, env, fx: ctx.fx };
    try {
      J.request = await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
      J.round = await roundRow(ctx, env);
      J.checks = roundChecks(ctx, J.round.round);
      J.completed = await ticksUntil(ctx.fx, ctx.project, () => (candidateRow(ctx.fx.home, ctx.candidate.id).progress === 'alpha_deployed' ? true : undefined), { what: 'the candidate to be alpha_deployed' });
      J.observed = await observeOnHost(ctx, env, ticksUntil);

      // The test's own act: the unit restarted by hand, after the containment read.
      const svc = J.round.svc;
      J.grantsBefore = eventsOfType(ctx.fx.home, 'deploy.launch_authorized').filter((e) => e.subject?.attempt === svc.attempt.id).length;
      const invocation = unitShow(svc.unit, ['InvocationID'])?.InvocationID;
      J.restart = restartOwnUnit(ctx, svc);
      await hostUntil(() => unitShow(svc.unit, ['InvocationID'])?.InvocationID !== invocation, { timeoutMs: 60_000, what: 'a new invocation of the unit' });
      J.grantsAfter = () => eventsOfType(ctx.fx.home, 'deploy.launch_authorized').filter((e) => e.subject?.attempt === svc.attempt.id).length;
      for (let i = 0; i < 4 && !J.oob; i++) {
        J.oob = oobRows(ctx.fx.home, env.id).find((r) => r.disposition === null && r.closed_at === null);
        if (!J.oob) await observeOnHost(ctx, env, ticksUntil);
      }
      J.decision = J.oob ? oobDecision(ctx.fx.home, J.oob) : null;
      if (J.decision) {
        J.answered = await answerOn(ctx, J.decision, 'teardown');
        J.teardown = await ticksUntil(
          ctx.fx,
          ctx.project,
          () => {
            const op = operationsOf(ctx.fx.home, ctx.project, 'teardown').find((o) => o.target?.environment === env.id && o.finalized_at);
            const latest = op ? attemptsOf(ctx.fx.home, op.id).at(-1) : undefined;
            return latest && ['succeeded', 'reconciled_succeeded'].includes(latest.status) ? { op, attempt: latest } : undefined;
          },
          { what: 'the teardown the decision asked for to be applied' },
        );
        J.afterTeardown = {
          units: unitsOfHome(ctx.fx.home).filter((u) => u.unit.startsWith(unitPrefix(ctx.fx.home, env.id))),
          cgroups: cgroupsNamed(unitPrefix(ctx.fx.home, env.id)),
          runFiles: (() => {
            try {
              return readdirSync(join(ctx.fx.home, 'run'), { recursive: true }).filter((n) => String(n).includes(env.id));
            } catch {
              return [];
            }
          })(),
        };
      }
    } finally {
      if (!J.afterTeardown) await endEnvironment(ctx, env);
    }
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('qualified by command in the test\'s home, no stand-in: the runner by its self-test, the adapter by surety qualify-adapter; neither row labelled a fixture', () => {
    const { fx, ctx } = J;
    const host = activeQualification(fx.home);
    assert.equal(host?.check_runner?.qualified, true, 'the check runner qualified by this start\'s self-test');
    assert.notEqual(host.check_runner.test_fixture, true, 'not by the runner fixture');
    const row = qualificationRow(fx.home, ctx.qualification.adapter_qualification);
    assert.deepEqual([row?.status, row?.label], ['current', null], 'the adapter\'s row current, labelled by nothing');
  });

  test('nomination and workspace checks: the reference candidate\'s acceptance and smoke checks run by the engine in check domains, passed, no result from a fixture', () => {
    const { fx, ctx } = J;
    const host = activeQualification(fx.home);
    for (const key of ['accept', 'smoke']) {
      const x = executionsWithResults(fx.home, ctx.candidate.id).filter((e) => e.key === key).at(-1);
      assert.ok(x, `${key} was registered at the nomination`);
      assert.deepEqual([x.status, x.execution_established, x.exit_status], ['recorded', 1, 0], `${key}: run and passed (${JSON.stringify(x)})`);
      const domain = domainRow(fx.home, x.domain);
      assert.equal(domain?.check_execution, x.id, `${key} ran in a check domain of its own`);
      assert.ok(domain.cgroup_path, 'a real cgroup');
      assert.equal(x.runner_qualification, host.id, `${key}'s result names the self-tested runner qualification`);
    }
    const out = outputText(fx.home, withStore(fx.home, (db) => db.prepare('SELECT * FROM "check_results" WHERE "execution" = ?').get(executionsWithResults(fx.home, ctx.candidate.id).filter((e) => e.key === 'accept').at(-1).id)));
    assert.match(out, /^ok 1 - R1\.1: sum adds/m, 'the fixture is live: Node\'s test runner ran the protected test of the Builder\'s library');
  });

  test('the request, the authorization and the deploy: issued, one deploy work item, one operation, the service started on g1', () => {
    const { request, round } = J;
    assert.equal(request.authorization.status, 'issued', 'the authorization issued (alpha_authorize satisfied)');
    assert.match(request.work_item.id, /^wi_/, 'one deploy work item');
    assert.equal(round.op.finalizer_inputs?.authorization, request.authorization.id, 'the operation consumed it');
    assert.equal(round.svc.unit, `${unitPrefix(J.fx.home, J.env.id)}g1.service`, 'the unit is g1 under this home\'s prefix');
    assert.ok(round.svc.app?.pid > 1, 'the application started and was recorded');
  });

  test('verification: the post-deploy check exercised the specified user operation through the link, run by the engine in its check domain; both reads match; verified; alpha_deployed', () => {
    const { fx, round, checks } = J;
    assert.equal(round.row.outcome, 'verified', `verified (${JSON.stringify({ outcome: round.row.outcome, missing: round.row.missing })})`);
    assert.deepEqual(round.row.identity_reads.map((r) => [r.bracket, r.match]), [['first', 'match'], ['second', 'match']]);
    const op = checks.find((c) => c.key === 'operation');
    assert.ok(op?.result, 'the operation check has a result in the round');
    assert.deepEqual([op.result.execution_established, op.result.exit_status], [1, 0], 'it ran and passed');
    assert.equal(op.domain?.check_execution, op.id, 'in a check domain of its own');
    const report = reportOf(outputText(fx.home, op.result), 'REF-OPERATION');
    const sum = report?.find((r) => r.path.startsWith('/sum'));
    assert.deepEqual([sum?.status, sum?.body && JSON.parse(sum.body)], [200, { sum: 5 }], `the fixture is live: the service answered the specified operation (${JSON.stringify(report)})`);
    assert.equal(J.completed, true, 'alpha_deployed');
    assert.equal(environmentRecord(fx.home, J.env.id)?.last_verified?.verification, round.row.id, 'last_verified is this row');
  });

  test('observation: healthy after verification, with a matching identity read', () => {
    assert.equal(J.observed?.condition, 'healthy', `the observation job reads the verified service healthy (${JSON.stringify(J.observed)})`);
    assert.equal(J.observed.facts?.identity?.match, 'match');
  });

  test('an out-of-band restart: detected, its launcher refused (no second grant), the decision raised with teardown and acknowledge, answered teardown', () => {
    assert.equal(J.restart, 0, 'the test restarted the unit by its exact name');
    assert.equal(J.grantsAfter(), J.grantsBefore, 'the launch is single-use: the restarted unit\'s launcher was refused, no second grant (D4 §9.2)');
    assert.ok(J.oob, `the restart is recorded out of band (${JSON.stringify(historyOf(J.fx.home, J.env.id).slice(-2))})`);
    assert.ok(JSON.stringify(J.oob.found).includes(J.round.svc.unit), 'its record names the unit');
    assert.deepEqual((J.decision?.options ?? []).map((o) => o.key).sort(), ['acknowledge', 'teardown'], 'the decision offers teardown and acknowledge');
    assert.equal(J.answered?.answer?.option, 'teardown', 'answered teardown');
  });

  test('teardown applied; nothing of the prefix left (M313)', () => {
    assert.ok(J.teardown, 'the teardown the decision asked for was applied');
    assert.equal(J.teardown.attempt.reconciliation_reads?.at(-1)?.result, 'applied');
    assert.deepEqual(J.afterTeardown.units, [], 'no unit of the prefix');
    assert.deepEqual(J.afterTeardown.cgroups, [], 'no cgroup of the prefix');
    assert.deepEqual(J.afterTeardown.runFiles, [], 'no socket or runtime directory of the environment');
  });
});
