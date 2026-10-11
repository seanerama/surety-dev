// M342, the real deployment journey (M4 slice 30, REAL LANE, manifest
// `real`). M4 plan §3.8 M342; D4-T04; D4 §9.4; E95 Q10; BS4 §12; E121
// item 4 (questions 5 and 6 as recommended); SEAM.md §336. PAID, ONLY BY
// SEAN'S COMMAND (docs/acceptance/reports/M4-real-lane/README.md), on his
// subscription token, never in `npm test` or a slice, and run alone with
// `node --test` (question 5), never with `run-tests.mjs --lane real`, which
// would run M2's and M3's paid files too.
//
// Before anything is started, the real lane's preflight (lane.mjs) refuses
// unless Sean has set the run directory, the token's reference (a 0600 file
// of its own), the pinned binary and M4's own confirmation
// (CONFIRM_PHRASE_M4); the run then states what it can cost at most. The
// qualification attempt (if the run directory has no active entry) waits for
// his `qualification_approval`, the entry for his `trust_activation`
// (attempt.mjs), the checks for his answer to the classification's decision;
// the qualification and the deployment for his own commands, `surety
// qualify-adapter local_service` and `surety deploy` (question 6), which the
// runner prints and waits for. Nothing here answers or runs any of them for
// him outside the rehearsal.
//
// (a) A real Verifier writes the workspace acceptance checks and the
//     `post_deploy_behavior` check through `check_correction` work; the
//     engine classifies the proposal; Sean answers; applied, the checks are
//     discovered with no error, a `post_deploy_behavior` check among them.
// (b) A real Builder builds the reference service; every check result is an
//     engine execution in a `check` domain; the stage gate and the Alpha
//     authorization gate are satisfied on them.
// (c) Sean's `surety qualify-adapter local_service` and `surety deploy`: the
//     adapter qualified; the service deployed on a real unit; the real check
//     passing through the link within one round between two matching reads;
//     `verified`; `alpha_deployed`.
// (d) Teardown `applied`, nothing of the prefix left; no check result
//     written by a fixture; the token in no file of the run directory, no git
//     object, no unit property and no journal output (searched with the
//     value read from the token's own file, in memory; never printed).
//
// The dress rehearsal (SURETY_REAL_REHEARSAL=1 with the fake claude, SEAM.md
// §171) runs this file with `node --test` directly; it is never evidence.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { activation } from './harness/real/attempt.mjs';
import { CONFIRM_PHRASE_M4, REAL_TEST_TIMEOUT_MS, judged, observe, readObserved, realPreflight, secretHits, stepValue } from './harness/real/lane.mjs';
import { ADAPTER_CASES, M342_JOURNEY, M342_STEPS, homeOf, journeyResults, m4Build, m4Checks, m4Deploy, m4Qualify, showCost } from './harness/real/deploy-journey.mjs';

const preflight = () => {
  const ctx = realPreflight({ confirm: CONFIRM_PHRASE_M4, order: M342_STEPS });
  showCost(ctx);
  return ctx;
};
const activated = (ctx) => activation(ctx, { journey: M342_JOURNEY, step: 'm4_activation', attemptStep: 'm4_attempt' });

// Every result of the journey's workspace checks: an engine execution, established, in a check domain of its own, bound to a self-tested qualification.
function assertEngineExecution(f, qualification, what) {
  assert.ok(f.result, `${what}: a result was recorded (${JSON.stringify(f)})`);
  assert.equal(f.result.execution, f.execution, `${what}: the result names its engine execution`);
  assert.equal(f.result.execution_established, 1, `${what}: established by the engine's own observations`);
  assert.notEqual(f.result.runner_id, 'test_fixture', `${what}: not the fixture's runner id`);
  assert.equal(f.result.runner_qualification, qualification.id, `${what}: bound to this start's self-tested qualification`);
  assert.deepEqual([f.domain?.profile, f.domain?.check_execution], ['check', f.execution], `${what}: in a check domain of its own execution`);
  assert.ok(f.result.output, `${what}: with its output record`);
}

// The steps (c) and (d) read: Sean's qualification, then his deployment (whose `finally` is the teardown).
async function deployed(ctx) {
  await activated(ctx);
  await m4Checks(ctx);
  await m4Build(ctx);
  await m4Qualify(ctx);
  return m4Deploy(ctx);
}

describe('M342 the real deployment journey (real lane, paid)', () => {
  test("(a) a real Verifier writes the workspace acceptance checks and the post_deploy_behavior check in check_correction work; the classification's decision is Sean's; applied, the checks are discovered with no error, a post_deploy_behavior check among them", { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = preflight();
    await judged(ctx, 'M342 (a)', async () => {
      await activated(ctx);
      const a = await m4Checks(ctx);
      assert.deepEqual(a.initial_version.checks, [], 'the project began with no check');
      assert.deepEqual([a.correction.run.role, a.correction.run.outcome, a.correction.run.reason_class], ['verifier', 'completed', 'none'], `the real Verifier's check_correction run was accepted (${a.correction.run.reason_text})`);
      assert.ok(['tightening', 'loosening', 'unclassifiable'].includes(a.proposal.class), `the engine classified the proposal (${a.proposal.class})`);
      assert.deepEqual(a.proposal.discovery_errors, [], 'the proposal had no discovery error');
      assert.deepEqual([a.proposal.decision_kind, a.proposal.answer], [`check_correction_${a.proposal.class}`, 'approve'], "the decision of its class was answered approve");
      if (!ctx.rehearsal) assert.notEqual(a.proposal.decision, null, "Sean's answer");
      assert.equal(a.proposal.status, 'applied', 'the proposal was applied');
      assert.equal(a.version.id, a.proposal.resulting_version, 'its version is the effective one');
      assert.deepEqual(a.version.discovery_errors, [], 'the effective version has no discovery error');
      const workspace = a.version.checks.filter((c) => c.kind === 'acceptance');
      assert.ok(workspace.length > 0 && workspace.every((c) => (c.gate_kinds ?? []).every((g) => g !== 'alpha_complete')), `workspace acceptance checks were discovered (${JSON.stringify(a.version.checks)})`);
      const behaviour = a.version.checks.filter((c) => c.kind === 'post_deploy_behavior');
      assert.ok(behaviour.length > 0, `a post_deploy_behavior check was discovered (${JSON.stringify(a.version.checks)})`);
      assert.ok(behaviour.some((c) => c.required && (c.gate_kinds ?? []).includes('alpha_complete') && (c.requires ?? []).includes('environment')), `required, of gate kind alpha_complete, requiring the environment (D4 §5.1) (${JSON.stringify(behaviour)})`);
    });
  });

  test('(b) a real Builder builds the reference service; every check result is an engine execution in a check domain, bound to the self-test; the stage gate and the Alpha authorization gate satisfied on them', { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = preflight();
    await judged(ctx, 'M342 (b)', async () => {
      await activated(ctx);
      await m4Checks(ctx);
      const b = await m4Build(ctx);
      assert.ok(b.qualification.cases.length > 0, 'the runner self-test ran at the start');
      for (const round of b.rounds) {
        for (const f of round.all_executions) {
          if (f.result) assertEngineExecution(f, b.qualification, `${f.key} on ${round.candidate}`);
          else assert.ok(['cancelled', 'interrupted'].includes(f.status), `${f.key} on ${round.candidate}: no result, and not recorded (${f.status})`);
        }
      }
      const last = b.rounds.at(-1);
      assert.equal(last.candidate, b.candidate, 'the last round is the candidate deployed');
      assert.ok(last.executions.length > 0, 'the engine registered workspace checks for the candidate');
      const ids = new Set(last.executions.map((f) => f.execution));
      assert.deepEqual([last.stage_gate.outcome, last.stage_gate.reasons], ['satisfied', []], 'the stage gate: satisfied');
      const stageDeciding = Object.values(last.stage_gate.checks ?? {}).map((e) => e?.deciding?.execution).filter(Boolean);
      assert.ok(stageDeciding.length > 0 && stageDeciding.every((id) => ids.has(id)), `decided by the engine's executions of the candidate (${JSON.stringify(last.stage_gate.checks)})`);
      // The Alpha gate is evaluated by Sean's request (D4 §4.1): read from the authorization it issued.
      const c = await deployed(ctx);
      const alpha = c.request?.alpha_authorize;
      assert.equal(c.request?.authorization?.status_at_request, 'issued', `Sean's request issued the authorization (${JSON.stringify(c.request?.authorization)})`);
      assert.deepEqual([alpha?.gate_kind, alpha?.outcome, alpha?.reasons], ['alpha_authorize', 'satisfied', []], `alpha_authorize: satisfied (${JSON.stringify(alpha)})`);
      const alphaDeciding = Object.values(alpha.checks ?? {}).map((e) => e?.deciding?.execution).filter(Boolean);
      assert.ok(alphaDeciding.length > 0 && alphaDeciding.every((id) => ids.has(id)), `decided by the engine's executions of the candidate (${JSON.stringify(alpha.checks)})`);
    });
  });

  test("(c) Sean's surety qualify-adapter local_service and surety deploy: the adapter qualified; the service deployed on a real unit; the real check passing through the link within one round between two matching reads; verified; alpha_deployed", { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = preflight();
    await judged(ctx, 'M342 (c)', async () => {
      const c = await deployed(ctx);
      const q = stepValue(ctx, 'm4_qualify');
      // The qualification (D4 §2.6; SEAM.md §§322, 323).
      assert.deepEqual([q.row?.status, q.row?.label ?? null, q.row?.adapter], ['current', null, 'local_service'], `the adapter qualified by the command in the run's home, unlabelled (${JSON.stringify(q.row)})`);
      assert.deepEqual((q.row.cases ?? []).map((e) => [e.case, e.result, e.control]), ADAPTER_CASES.map((name) => [name, 'passed', 'passed']), 'every case of D4 §2.6 passed beside its control, in order');
      assert.ok(q.evidence?.tools?.['systemd-run']?.path && q.evidence?.tools?.systemctl?.path, `the evidence names the host tools by path and version (${JSON.stringify(q.evidence?.tools)})`);
      assert.ok(Number.isInteger(q.evidence?.host_time_ms), `the qualification's host time is recorded (${q.evidence?.host_time_ms})`);
      assert.deepEqual(q.left?.units ?? [], [], 'the qualification left no unit of its environment');
      assert.equal(q.roles_started, 0, 'the qualification started no role run (no model)');
      assert.equal(c.qualification_at_start?.status, 'current', `still current at the deployment's start (E131 item 9) (${JSON.stringify(c.qualification_at_start)})`);
      // The request and the operation.
      assert.equal(c.deploy_work.length, 1, 'one deploy work item, from the request');
      assert.equal(c.deploy_operations.length, 1, 'one deploy operation');
      assert.equal(c.operation.authorization, c.request.authorization.id, 'the operation consumed the request\'s authorization');
      assert.equal(c.authorization_after?.status, 'consumed', 'consumed once');
      // The service on a real unit, read from the host while it ran.
      assert.ok(c.service.unit_pattern, `the unit is g<n> under the run home's prefix for alpha (${c.service.unit})`);
      assert.equal(c.service.domain?.profile, 'service', 'a service domain');
      assert.ok(c.host, 'the host was read while the service ran');
      assert.deepEqual([c.host.props?.LoadState, c.host.props?.ActiveState], ['loaded', 'active'], `the unit loaded and active (${JSON.stringify(c.host.props)})`);
      assert.equal(c.host.props?.Delegate, 'yes', 'with Delegate=yes');
      assert.notEqual(String(c.host.props?.MainPID), String(c.service.app?.pid), 'the unit\'s main process is the launcher, not the application');
      assert.ok(c.host.app_in_unit_tree, `the recorded application is in the unit's cgroup tree, host-read (${c.host.app_cgroup})`);
      // One round, two matching reads, the real check through the link.
      assert.equal(c.verification.outcome, 'verified', `verified (${JSON.stringify({ outcome: c.verification.outcome, missing: c.verification.missing })})`);
      assert.deepEqual(c.verification.identity_reads.map((r) => [r.bracket, r.match]), [['first', 'match'], ['second', 'match']], 'between two matching identity reads of the round');
      const behaviour = c.post_deploy.filter((x) => c.kinds[x.key] === 'post_deploy_behavior');
      assert.ok(behaviour.length > 0, `the round ran the real Verifier's post_deploy_behavior check (${JSON.stringify(c.post_deploy)})`);
      for (const x of behaviour) {
        assert.ok(x.result, `${x.key}: a result in the round`);
        assert.deepEqual([x.result.execution, x.result.execution_established, x.result.exit_status], [x.execution, 1, 0], `${x.key}: run by the engine and passed`);
        assert.notEqual(x.result.runner_id, 'test_fixture', `${x.key}: not the fixture's runner`);
        assert.deepEqual([x.domain?.profile, x.domain?.check_execution], ['check', x.execution], `${x.key}: in a check domain of its own`);
        assert.ok(x.link.some((e) => e.decision === 'accepted'), `${x.key}: reached the service through the link (${JSON.stringify(x.link)})`);
      }
      // Completion.
      assert.equal(c.completed, true, `alpha_deployed (${JSON.stringify(c.completed)})`);
      assert.equal(c.progress, 'alpha_deployed', 'the candidate is alpha_deployed');
      assert.equal(c.alpha_complete?.outcome, 'satisfied', 'through a satisfied alpha_complete');
      assert.equal(c.last_verified?.verification, c.verification.id, 'last_verified is this row');
      assert.equal(c.roles_started, 0, 'the deployment started no role run (no model)');
    });
  });

  test('(d) teardown applied, nothing of the prefix left; no check result written by a fixture; the token in no file of the run directory, no git object, no unit property and no journal output', { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = preflight();
    await judged(ctx, 'M342 (d)', async () => {
      const a = stepValue(ctx, 'm4_checks');
      const c = stepValue(ctx, 'm4_deploy');
      const d = stepValue(ctx, 'm4_teardown');
      assert.equal(d.applied, true, `the teardown applied (${JSON.stringify({ request: d.request, attempt: d.attempt })})`);
      assert.equal(d.attempt?.last_read, 'applied', 'its last reconcile read applied');
      assert.deepEqual(d.left, { units: [], cgroups: [], run_files: [] }, 'nothing of the run home\'s prefix left: no unit, cgroup or runtime file');
      assert.equal(d.roles_started, 0, 'the teardown started no role run');
      const results = journeyResults(ctx, a.project);
      assert.ok(results.length > 0, 'the journey recorded check results');
      assert.deepEqual(results.filter((r) => r.execution === null || r.runner_id === 'test_fixture').map((r) => r.id), [], 'every result names an engine execution, none the fixture runner');
      // The token: files and git objects (searched in memory, never printed).
      const repos = [a.repo, readObserved(ctx, 'attempt').host_witness?.before?.repo].filter(Boolean);
      const hits = secretHits(ctx.keyValue, { roots: [ctx.runDir], repos });
      observe(ctx, 'M342', 'key_search', { roots: [ctx.runDir], repos, hits: hits.length });
      assert.deepEqual(hits, [], `the ${ctx.authMode} credential is in no file of the run directory and no git object`);
      // Unit properties and the transient unit file, read while the service ran; journals, read after.
      assert.equal(c.host?.unit_property_search?.read, true, 'the unit\'s properties were read while it ran');
      assert.equal(c.host.unit_property_search.hits, 0, 'the credential is in no unit property');
      // The transient unit file is a second form of the properties: searched where it could be read; an
      // unread file stays recorded as unread (observed/M342.json), never as clean, and the report says which.
      if (c.host.transient_file_search.read) assert.equal(c.host.transient_file_search.hits, 0, 'nor in the transient unit file');
      assert.equal(c.host.journal_search.hits, 0, 'nor in the unit\'s journal output while it ran');
      assert.ok(d.journal_search.length > 0, 'the journals of the units the store\'s intents name were read');
      assert.deepEqual(d.journal_search.filter((j) => j.hits !== 0).map((j) => j.unit), [], 'the credential is in no journal output of any of them');
      assert.ok(homeOf(ctx), 'the journey home');
    });
  });
});
