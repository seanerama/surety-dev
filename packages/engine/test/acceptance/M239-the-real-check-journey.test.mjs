// M239, the real check journey (M3 slice 22, REAL LANE, manifest `real`).
// M3 plan §3.8 M239 and question 5 (E92 item 3: included); E89, E91; NC "a
// check's execution in the real journey is a fixture"; SEAM.md §§159 to 166,
// 171, 237. PAID, ONLY BY SEAN'S COMMAND (docs/acceptance/reports/M3-real-lane/
// README.md), on his subscription token, never in `npm test` or a slice.
//
// Before anything is started, M2's preflight (lane.mjs) refuses unless Sean
// has set the run directory, the token's reference, the pinned binary and
// M3's own spend confirmation (CONFIRM_PHRASE_M3). The qualification attempt
// (if the run directory has no active entry) waits for his
// `qualification_approval`, and the entry for his `trust_activation`
// (attempt.mjs); the journey (harness/real/checks-journey.mjs) waits for his
// answer to the classification's decision about the checks the real Verifier
// wrote. Nothing here answers any of them for him outside the rehearsal.
//
// (a) A real Verifier writes the stage's checks (definitions and programs
//     under .surety/checks/) in `check_correction` work; the engine
//     classifies the proposal; Sean answers; the checks are discovered with
//     no error.
// (b) A real Builder builds the stage; the engine runs the checks; every
//     check result is an engine execution in a `check` domain, bound to the
//     runner self-test's qualification; both gates satisfied on them.
// (c) Path two: the seeded defect; the real Verifier's finding names R2.1
//     and a check; the Reviewer's `fix`; the fix; the finding resolved only
//     through the covering required check (as M235).
// (d) No check result of the journey written by a fixture; the token in no
//     file of the run directory and no git object.
//
// The dress rehearsal (SURETY_REAL_REHEARSAL=1 with the fake claude, SEAM.md
// §171) runs this file with `node --test` directly; it is never evidence.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { activation, homeOf } from './harness/real/attempt.mjs';
import { CONFIRM_PHRASE_M3, REAL_TEST_TIMEOUT_MS, judged, observe, readObserved, realPreflight, secretHits, stepValue } from './harness/real/lane.mjs';
import { M239, checksPathOne, checksPathTwo, projectResults } from './harness/real/checks-journey.mjs';

const preflight = () => realPreflight({ confirm: CONFIRM_PHRASE_M3 });

// Every result of the journey: an engine execution, established, in a check domain of its own, bound to a self-tested qualification.
function assertEngineExecution(f, qualification, what) {
  assert.ok(f.result, `${what}: a result was recorded (${JSON.stringify(f)})`);
  assert.equal(f.result.execution, f.execution, `${what}: the result names its engine execution`);
  assert.equal(f.result.execution_established, 1, `${what}: established by the engine's own observations`);
  assert.notEqual(f.result.runner_id, 'test_fixture', `${what}: not the fixture's runner id`);
  assert.equal(f.result.runner_qualification, qualification.id, `${what}: bound to this start's self-tested qualification`);
  assert.deepEqual([f.domain?.profile, f.domain?.check_execution], ['check', f.execution], `${what}: in a check domain of its own execution`);
  assert.ok(f.result.output, `${what}: with its output record`);
}

describe('M239 the real check journey (real lane, paid)', () => {
  test("(a) a real Verifier writes the stage's checks in check_correction work; the classification's decision is Sean's; applied, the checks are discovered with no error", { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = preflight();
    await judged(ctx, 'M239 (a)', async () => {
      await activation(ctx);
      const one = await checksPathOne(ctx);
      assert.deepEqual(one.initial_version.checks, [], 'the project began with no check');
      assert.deepEqual([one.correction.run.role, one.correction.run.outcome, one.correction.run.reason_class], ['verifier', 'completed', 'none'], `the real Verifier's check_correction run was accepted (${one.correction.run.reason_text})`);
      assert.ok(['tightening', 'loosening', 'unclassifiable'].includes(one.proposal.class), `the engine classified the proposal (${one.proposal.class})`);
      assert.deepEqual(one.proposal.discovery_errors, [], 'the proposal had no discovery error');
      assert.deepEqual([one.proposal.decision_kind, one.proposal.answer], [`check_correction_${one.proposal.class}`, 'approve'], 'the decision of its class was answered approve');
      if (!ctx.rehearsal) assert.notEqual(one.proposal.decision, null, "Sean's answer");
      assert.equal(one.proposal.status, 'applied', 'the proposal was applied');
      assert.equal(one.version.id, one.proposal.resulting_version, 'its version is the effective one');
      assert.deepEqual(one.version.discovery_errors, [], 'the effective version has no discovery error');
      assert.ok(one.version.checks.length > 0, `the checks were discovered (${JSON.stringify(one.version.checks)})`);
    });
  });

  test('(b) a real Builder builds the stage; every check result is an engine execution in a check domain, bound to the self-test; both gates satisfied on them', { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = preflight();
    await judged(ctx, 'M239 (b)', async () => {
      await activation(ctx);
      const one = await checksPathOne(ctx);
      assert.equal(one.qualification.cases.length > 0, true, 'the runner self-test ran at the start');
      const last = one.rounds.at(-1);
      assert.ok(last.executions.length > 0, 'the engine registered checks for the candidate');
      for (const f of last.executions) assertEngineExecution(f, one.qualification, `${f.key} on ${last.candidate}`);
      for (const [what, g] of [['stage', last.stage_gate], ['alpha_authorize', last.alpha_gate]]) {
        assert.deepEqual([g.outcome, g.reasons], ['satisfied', []], `${what}: satisfied`);
        const deciding = Object.values(g.checks ?? {}).map((e) => e.deciding?.execution).filter(Boolean);
        assert.ok(deciding.length > 0 && deciding.every((id) => last.executions.some((f) => f.execution === id)), `${what}: decided by the engine's executions of the candidate (${JSON.stringify(g.checks)})`);
      }
    });
  });

  test('(c) path two: the seeded defect; the real Verifier\'s finding names a criterion and a check; fix; resolved only through the covering required check', { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = preflight();
    await judged(ctx, 'M239 (c)', async () => {
      await activation(ctx);
      await checksPathOne(ctx);
      const two = await checksPathTwo(ctx);
      assert.equal(two.finding.criterion, M239.defectCriterion, 'the finding names the criterion the defect breaks');
      assert.equal(two.finding.disposition, 'fix', "the Reviewer's disposition is fix");
      assert.ok(two.named_check, `the check it names is a check of the effective version (${two.finding.check})`);
      assert.deepEqual([two.named_check.origin, two.named_check.required], ['acceptance', true], `of origin acceptance and required (${JSON.stringify(two.named_check)})`);
      assert.ok(two.named_check.criteria.includes(M239.defectCriterion), `covering ${M239.defectCriterion} (${JSON.stringify(two.named_check)})`);
      assert.equal(two.resolved.status, 'resolved', 'the finding is resolved');
      assert.ok(two.resolving, `resolution_verification names a result of the fix's candidate (${JSON.stringify(two.resolved)})`);
      assert.equal(two.resolving.key, two.finding.check, 'the resolving result is the named check\'s');
      assert.ok(two.resolving.execution_seq > two.finding.disposition_seq, `registered after the disposition (${two.resolving.execution_seq} > ${two.finding.disposition_seq})`);
      assertEngineExecution(two.resolving, two.qualification, 'the resolving execution');
      assert.equal(two.resolving.result.exit_status, 0, 'which passed');
      assert.equal(two.resolved.resolution_verification.check_result, two.resolving.result.id, 'resolution_verification names that result');
      assert.notEqual(two.blocked_on_first.stage.outcome, 'satisfied', 'the stage gate on the first candidate was blocked');
      for (const f of two.fix_executions) assertEngineExecution(f, two.qualification, `${f.key} on the fix's candidate`);
      assert.deepEqual([two.stage_gate.outcome, two.alpha_gate.outcome], ['satisfied', 'satisfied'], `both gates satisfied on the fix's candidate (${JSON.stringify([two.stage_gate.reasons, two.alpha_gate.reasons])})`);
    });
  });

  test('(d) no check result of the journey written by a fixture; the token in no file of the run directory and no git object', { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = preflight();
    await judged(ctx, 'M239 (d)', async () => {
      const one = stepValue(ctx, 'm3_path_one');
      const results = projectResults(ctx, one.project);
      assert.ok(results.length > 0, 'the journey recorded check results');
      const fixture = results.filter((r) => r.execution === null || r.runner_id === 'test_fixture');
      assert.deepEqual(fixture.map((r) => r.id), [], 'every result names an engine execution, none the fixture runner');
      const repos = [one.repo, readObserved(ctx, 'attempt').host_witness?.before?.repo].filter(Boolean);
      const hits = secretHits(ctx.keyValue, { roots: [ctx.runDir], repos });
      observe(ctx, 'M239', 'key_search', { roots: [ctx.runDir], repos, hits: hits.length });
      assert.deepEqual(hits, [], `the ${ctx.authMode} credential is in no file and no git object`);
      assert.ok(homeOf(ctx, 'home'), 'the journey home');
    });
  });
});
