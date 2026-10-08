// M201 (f), the check journey with no runner qualification fixture (M3
// slice 18; sandbox lane). M3 plan §3.1 M201 (f), question 2; E92 item 2;
// D3 §§2.5, 2.6, 2.8; SEAM.md §§181, 203, 208. Cases (a) to (e) are
// `M201-check-journey-path-one.test.mjs` (slice 15), which ran under the
// harness-only runner qualification fixture; this file runs the same
// journey with `check_runner` qualified by this start's runner self-test.
//
// The engine starts with the self-test switched on (SEAM.md §208) and the
// fixture route is never called. The self-test qualifies `direct`; the
// project's acceptance and smoke checks then run in real `check` domains at
// the nomination; both gates are satisfied on those results alone; a second
// candidate whose source makes the acceptance check exit 1 fails it. Every
// result is the engine's and is bound to the self-tested qualification.
//
// SAFETY: the check program (harness/checks/program.mjs) is used only in
// its benign modes here: it reads its workspace, compares two files and
// exits with a status. The self-test's own programs are the engine's.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { alphaTarget, authorizationsOf, reasonSubjects, sharedFixture, stageGate } from './harness/gates.mjs';
import { PERMITTED_EDIT, addItem, permittedEdit, roleThat, runToEnd, waitForCandidates } from './harness/gitruns.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { runsOf, tickUntil } from './harness/runs.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { step } from './harness/scripted.mjs';
import {
  GOVERNED_FILE,
  acceptance,
  checkProject,
  defPath,
  domainOfExecution,
  entryByKey,
  gateCheckEntries,
  installCheckProgram,
  installIndexedPlan,
  machineId,
  resultRow,
  resultsOfProject,
  sandboxGoverned,
  smoke,
  waitRecorded,
} from './harness/checks/fixtures.mjs';
import { SELF_TEST_CASES, selfTestArgs, waitSelfTest } from './harness/checks/execution.mjs';

const EXPECT = '.surety/checks/expect/app.js';
const BROKEN = 'export const answer = 41;\n';
const KEYS = ['accept', 'smoke'];

async function journey(t) {
  const fx = await sandboxEngine(t, { start: false });
  await fx.start({ args: selfTestArgs() });
  const qualification = await waitSelfTest(fx);
  const prog = installCheckProgram(fx.root);
  const files = {
    [GOVERNED_FILE]: sandboxGoverned(prog),
    [EXPECT]: PERMITTED_EDIT.content,
    [defPath('accept')]: acceptance('accept', ['R1.1', 'R1.2'], { command: ['probe', 'expect', PERMITTED_EDIT.path, EXPECT], inputs: [EXPECT], timeout: 120 }),
    [defPath('smoke')]: smoke('smoke', { command: ['probe', '--report', 'exit', '0'], inputs: [EXPECT], timeout: 120 }),
  };
  const project = await checkProject(fx, { files, tier: 'T1' });
  const plan = await installIndexedPlan(fx.engine, project.id, { index: [{ key: 'R1', criteria: ['R1.1', 'R1.2'] }], stages: [{ number: 1, goal: 'the first stage', implements: ['R1'] }] });
  const [stage] = plan.stages;
  fx.scripted.script(stage.work_item, [roleThat([permittedEdit()], { nominate: true })]);
  const build = await runToEnd(fx, project.id, stage.work_item);
  assert.deepEqual([build.outcome, build.reason_class], ['completed', 'none'], `the Builder's run was accepted (${build.reason_text})`);
  const [candidate] = await waitForCandidates(fx, project.id);
  const recorded = await waitRecorded(fx, project.id, candidate.id, KEYS);
  const ctx = { project, candidate, stage: stage.id };
  const stageEval = await stageGate(fx, ctx);
  const alpha = await alphaTarget(fx, ctx);
  const alphaEval = await alpha.evaluate();

  const fix = await addItem(fx, project.id, 'fix');
  fx.scripted.script(fix, [roleThat([step.write(PERMITTED_EDIT.path, BROKEN)], { nominate: true })]);
  await tickUntil(fx.engine, project.id, () => runsOf(fx.home, fix)[0]?.state === 'ended', { what: 'the fix to be built' });
  const second = (await waitForCandidates(fx, project.id, 2)).at(-1);
  const secondRecorded = await waitRecorded(fx, project.id, second.id, KEYS, { what: "the second candidate's checks to be recorded" });
  const secondStage = await stageGate(fx, { project, candidate: second, stage: stage.id });
  return { fx, project, qualification, candidate, recorded, stageEval, alpha, alphaEval, second, secondRecorded, secondStage };
}

describe('M201 (f) the check journey, qualified by the runner self-test', () => {
  const shared = sharedFixture();
  let J;
  before(async () => {
    J = await journey(shared.context);
  });
  after(() => shared.cleanup());

  test("check_runner is qualified by this start's self-test, every case passed, with no fixture label; the fixture route was never used", () => {
    const runner = J.qualification.check_runner;
    assert.equal(runner.qualified, true, `direct is qualified (check_runner: ${JSON.stringify(runner).slice(0, 400)})`);
    assert.notEqual(runner.test_fixture, true, 'and not by the fixture');
    assert.deepEqual(runner.self_test.map((e) => [e.case, e.result]), SELF_TEST_CASES.map((c) => [c, 'passed']), 'every mandatory case and its control passed (SEAM.md §208)');
    assert.deepEqual(eventsOfType(J.fx.home, 'check.result').filter((e) => e.payload?.test_fixture === true), [], 'no event of the journey carries the fixture label');
  });

  test('(a) to (c) the checks ran in real check domains at the nomination and both gates are satisfied on those results, each bound to the self-tested qualification', () => {
    for (const key of KEYS) {
      const x = J.recorded[key];
      assert.equal(x.trigger?.source, 'nomination', `${key}: registered by the nomination`);
      const r = resultRow(J.fx.home, x.result);
      assert.deepEqual([r.execution, r.execution_established, r.exit_status, r.signaled], [x.id, 1, 0, 0], `${key}: established, exit 0`);
      assert.equal(r.runner_qualification, J.qualification.id, `${key}: bound to the self-tested host qualification`);
      assert.match(r.runner_id, new RegExp(`^direct@${machineId()}/[0-9a-f]{8,}$`), `${key}: runner_id names this host and the check profile`);
      assert.ok(J.qualification.check_runner.profile_fingerprint.startsWith(r.runner_id.split('/')[1]), `${key}: its runner_id's prefix is of the qualified profile's fingerprint`);
      const domain = domainOfExecution(J.fx.home, x);
      assert.deepEqual([domain?.profile, domain?.check_execution], ['check', x.id], `${key}: from a check domain of its execution`);
    }
    for (const [what, evaluation] of [['stage', J.stageEval], ['alpha_authorize', J.alphaEval]]) {
      assert.deepEqual([evaluation.outcome, evaluation.reasons], ['satisfied', []], `${what}: satisfied`);
      const entries = gateCheckEntries(evaluation);
      for (const key of KEYS) assert.equal(entryByKey(entries, key)?.deciding?.execution, J.recorded[key].id, `${what}: ${key} decided by the engine's execution`);
    }
    assert.equal(authorizationsOf(J.fx.home, J.candidate.id).find((a) => a.id === J.alpha.authorization.id)?.status, 'issued', 'the Alpha authorization was issued');
  });

  test('(d), (e) the second candidate fails the acceptance check; every result of the journey is an engine execution', () => {
    const accept = J.secondRecorded.accept;
    assert.deepEqual([resultRow(J.fx.home, accept.result).execution_established, resultRow(J.fx.home, accept.result).exit_status], [1, 1], 'the acceptance check is established and exited 1');
    assert.equal(J.secondStage.outcome, 'not_satisfied');
    assert.deepEqual(reasonSubjects(J.secondStage, 'CHECK_NOT_PASSED'), [accept.check], 'CHECK_NOT_PASSED names the acceptance check');
    const results = resultsOfProject(J.fx.home, J.project.id);
    assert.equal(results.length, 4, 'two candidates, two checks each');
    for (const r of results) {
      assert.ok(r.execution, `result ${r.id} names its execution`);
      assert.equal(r.runner_qualification, J.qualification.id, `result ${r.id} is bound to the self-tested qualification`);
    }
  });
});
