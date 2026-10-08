// M222, runner classes, developer checks, the reserved environment (M3
// slice 18; written in the sandbox lane, SEAM.md §211 says why). M3 plan
// §3.4 M222; D3-R18, D3-R19, D3-X03; D3 §§2.7 to 2.9, §5 X3; E89 item 2;
// D1 §9.2; SEAM.md §§203, 209, 211.
//
// One project, five checks:
//   plain     direct, exit 0                                   stage
//   dev       origin developer: compares the Builder's own
//             `tests/value.txt` with a protected expectation    stage
//   boxed     runner_class container                          alpha_authorize
//   far       runner_class remote                             alpha_authorize
//   deployed  post_deploy_behavior, requires environment and
//             artifact_digest                                 alpha_authorize
// (a) `container` and `remote` are discovered; their executions are
//     `runner_unqualified`; a result of class `direct` recorded for one of
//     them never decides it.
// (b) The developer check is required: it fails on the first candidate,
//     whose Builder wrote a wrong `tests/value.txt`, and blocks the stage
//     gate; a second candidate whose Builder changed that file (outside the
//     protected roots, so no proposal) passes it, and the gate is satisfied.
//     "Counts toward no kind" is slice 20's kind inventory (COVERAGE.md).
// (c) The environment-requiring check from every trigger it can have here
//     (nomination, an operator's request, a protected application) is
//     `environment_unbound`, with no environment, artifact or secret bound.
//
// SAFETY: the check program only compares two files and exits with a
// status; the classes it cannot run are never launched.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { alphaTarget, askingForTicks, capturedProposal, humanApplies, installGatedPlan, postResult, proposalsOf, reasonSubjects, stageGate } from './harness/gates.mjs';
import { addItem, roleThat, runToEnd, waitForCandidates } from './harness/gitruns.mjs';
import { step } from './harness/scripted.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { CONTRACT } from './harness/fixtures.mjs';
import { changePolicy } from './harness/journal.mjs';
import { runsOf, tickUntil } from './harness/runs.mjs';
import {
  GOVERNED_FILE,
  acceptance,
  checkProject,
  defPath,
  definitionText,
  entryByKey,
  executionsOf,
  gateCheckEntries,
  installCheckProgram,
  qualifyRunnerByFixture,
  requestChecks,
  resultRow,
  sandboxGoverned,
  smoke,
  terminalExecution,
} from './harness/checks/fixtures.mjs';

const EXPECT = '.surety/checks/expect/value.txt';
const VALUE = 'tests/value.txt';

async function assertUnbound(fx, project, candidate, x, source) {
  const ended = await terminalExecution(fx, project.id, candidate.id, 'deployed', `the ${source} registration of deployed to end`);
  assert.equal(ended.id, x.id, `the ${source} registration`);
  assert.equal(ended.trigger?.source, source);
  const r = resultRow(fx.home, ended.result);
  assert.deepEqual([r.execution_established, r.not_run_reason], [0, 'environment_unbound'], `${source}: environment_unbound (D3 §5 X3)`);
  assert.deepEqual([ended.environment, ended.artifact_digest, r.environment ?? null, r.artifact_digest ?? null], [null, null, null, null], `${source}: no environment or artifact is bound`);
}

describe('M222 runner classes, developer checks, the reserved environment', () => {
  test('(a) container and remote unqualified, never matched by a direct result; (b) a required developer check blocks until it passes, its files changing with no proposal; (c) an environment-requiring check is environment_unbound from every trigger', async (t) => {
    // domain_memory_max at its minimum, so a role's domain and a check's fit together (SEAM.md §168).
    const fx = await sandboxEngine(t, { config: { domain_memory_max: CONTRACT.engine.domain_memory_max.min } });
    const prog = installCheckProgram(fx.root);
    await qualifyRunnerByFixture(fx.engine);
    const alphaOnly = ['alpha_authorize'];
    const files = {
      [GOVERNED_FILE]: sandboxGoverned(prog),
      [EXPECT]: 'right\n',
      [defPath('plain')]: smoke('plain', { command: ['probe', 'exit', '0'], gates: ['stage'] }),
      // M3 slice 20 (L3, B04; SEAM.md §226): the stage implements R1, whose one criterion this acceptance check covers, so the stage scope is complete beside the smoke check.
      [defPath('acc')]: acceptance('acc', ['R1.1'], { command: ['probe', 'exit', '0'], gates: ['stage'] }),
      [defPath('dev')]: definitionText('dev', { origin: 'developer', kind: 'smoke', command: ['probe', 'expect', VALUE, EXPECT], timeout_s: 60, gate_kinds: ['stage'], inputs: [EXPECT] }),
      [defPath('boxed')]: smoke('boxed', { command: ['probe', 'exit', '0'], gates: alphaOnly, runner_class: 'container' }),
      [defPath('far')]: smoke('far', { command: ['probe', 'exit', '0'], gates: alphaOnly, runner_class: 'remote' }),
      [defPath('deployed')]: definitionText('deployed', { kind: 'post_deploy_behavior', command: ['probe', 'exit', '0'], timeout_s: 60, gate_kinds: alphaOnly, requires: ['environment', 'artifact_digest'] }),
    };
    const project = await checkProject(fx, { files });
    // The developer check fails on the first candidate while the stage's work is verifying there, so under Q2 (D3 §2.10; E90 item 2; E100 S1) it would
    // send the stage back to its Builder. This row is about runner classes, developer checks and the environment, not the repair: at
    // repair_attempts_max 0, set before the build so every candidate holds its commit, the stage's work is parked instead (objection 030's ruling).
    await changePolicy(fx.engine, project.id, { repair_attempts_max: 0 });
    const plan = await installGatedPlan(fx.engine, project.id, { requirements: ['R1'], stages: [{ number: 1, goal: 'the first stage', implements: ['R1'] }] });
    const [stage] = plan.stages;
    fx.scripted.script(stage.work_item, [roleThat([step.write(VALUE, 'wrong\n')], { nominate: true })]);
    const build = await runToEnd(fx, project.id, stage.work_item);
    assert.deepEqual([build.outcome, build.reason_class], ['completed', 'none'], `the Builder's run was accepted (${build.reason_text})`);
    const [first] = await waitForCandidates(fx, project.id);
    const registered = await askingForTicks(fx, project.id, () => {
      const keys = new Set(executionsOf(fx.home, first.id).map((x) => x.key));
      return ['plain', 'dev', 'boxed', 'far', 'deployed'].every((k) => keys.has(k)) ? executionsOf(fx.home, first.id) : undefined;
    }, 'the nomination to register all five checks, container, remote and the environment-requiring one included');
    assert.deepEqual(registered.map((x) => x.trigger?.source), registered.map(() => 'nomination'), 'each by the nomination');
    const ended = {};
    for (const key of ['plain', 'dev', 'boxed', 'far', 'deployed']) ended[key] = await terminalExecution(fx, project.id, first.id, key);

    // (a)
    for (const key of ['boxed', 'far']) {
      const r = resultRow(fx.home, ended[key].result);
      assert.deepEqual([ended[key].runner_class, r.execution_established, r.not_run_reason], [key === 'boxed' ? 'container' : 'remote', 0, 'runner_unqualified'], `(a) ${key}: discovered and registered under its class, runner_unqualified`);
    }
    const directForBoxed = await postResult(fx.engine, project.id, { candidate: first.id, check: ended.boxed.check, exit_status: 0, runner_class: 'direct' });
    assert.equal(resultRow(fx.home, directForBoxed.id).runner_class, 'direct', 'the fixture is live: a passing result of class direct is recorded for boxed, later in the sequence');
    const alpha = await alphaTarget(fx, { project, candidate: first, stage: stage.id });
    const boxedEntry = entryByKey(gateCheckEntries(await alpha.evaluate()), 'boxed');
    assert.notEqual(boxedEntry.state, 'passed', `(a) a direct result never matches a container check (D1 §9.2: a result matches only its own class) (entry ${JSON.stringify(boxedEntry)})`);
    assert.notEqual(boxedEntry.deciding?.result, directForBoxed.id, '(a) and never decides it');
    const stageFirst = await stageGate(fx, { project, stage: stage.id }, first);

    // (b) the developer check failed on the first candidate and blocks the stage gate.
    assert.deepEqual([resultRow(fx.home, ended.dev.result).execution_established, resultRow(fx.home, ended.dev.result).exit_status], [1, 1], '(b) the developer check ran and failed on the wrong value');
    assert.ok(reasonSubjects(stageFirst, 'CHECK_NOT_PASSED').includes(ended.dev.check), '(b) the required developer check blocks the stage gate');
    assert.deepEqual(resultRow(fx.home, ended.plain.result).exit_status, 0, 'the control: plain passed');

    // (c) nomination, then an operator's request.
    await assertUnbound(fx, project, first, ended.deployed, 'nomination');
    const asked = await requestChecks(fx.engine, project.id, first.id, { keys: ['deployed'] });
    assert.equal(asked.status, 202, `an operator requests the environment-requiring check (body: ${asked.text})`);
    await assertUnbound(fx, project, first, { id: asked.body.executions[0].id }, 'operator_request');

    // (b) the Builder changes its own test file: no proposal; the developer check passes.
    assert.deepEqual(proposalsOf(fx.home, project.id), [], 'no proposal exists before the change');
    const fix = await addItem(fx, project.id, 'fix');
    fx.scripted.script(fix, [roleThat([step.write(VALUE, 'right\n')], { nominate: true })]);
    await tickUntil(fx.engine, project.id, () => runsOf(fx.home, fix)[0]?.state === 'ended', { what: 'the fix to be built' });
    const second = (await waitForCandidates(fx, project.id, 2)).at(-1);
    const dev2 = await terminalExecution(fx, project.id, second.id, 'dev');
    const plain2 = await terminalExecution(fx, project.id, second.id, 'plain');
    const acc2 = await terminalExecution(fx, project.id, second.id, 'acc');
    assert.equal(resultRow(fx.home, acc2.result).exit_status, 0, 'the acceptance check of R1.1 passed');
    assert.deepEqual([resultRow(fx.home, dev2.result).execution_established, resultRow(fx.home, dev2.result).exit_status], [1, 0], '(b) on the changed file the developer check passes');
    assert.equal(resultRow(fx.home, plain2.result).exit_status, 0);
    assert.deepEqual(proposalsOf(fx.home, project.id), [], "(b) the Builder's test file changed with no proposal");
    const stageSecond = await stageGate(fx, { project, stage: stage.id }, second);
    assert.deepEqual([stageSecond.outcome, stageSecond.reasons], ['satisfied', []], '(b) the stage gate is satisfied once the developer check passes');
    const devEntry = entryByKey(gateCheckEntries(stageSecond), 'dev');
    assert.equal(devEntry.state, 'passed');

    // (c) a protected application registers the new version's checks for the unsuperseded candidate.
    const proposal = await capturedProposal(fx, project, { changeKind: null, steps: [step.write(defPath('later'), smoke('later', { command: ['probe', 'exit', '0'], gates: ['stage'] }))] });
    await humanApplies(fx, project, proposal, 'tightening');
    const applied = await tickUntil(
      fx.engine,
      project.id,
      () => executionsOf(fx.home, second.id).find((x) => x.key === 'deployed' && x.trigger?.source === 'protected_application'),
      { max: 10, what: "the application's registration of deployed for the second candidate" },
    );
    await assertUnbound(fx, project, second, applied, 'protected_application');
  });
});
