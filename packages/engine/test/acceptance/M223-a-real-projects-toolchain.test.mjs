// M223, a real project's toolchain (M3 slice 18; project lane, run with
// `npm test`, E92 item 2 (1)). M3 plan §3.4 M223; D3-J01, D3-J03, D3-J04;
// D3 §§2.3, 2.7, 2.8, Appendix B; Q6; SEAM.md §§203, 213.
//
// The reference project (`harness/project/reference.mjs`): its protected
// checks run Node's built-in test runner, from the engine's own Node
// installation named in `read_paths`, through a protective wrapper.
// (a) A Builder's correct `src/sum.mjs`: the acceptance check passes, exit
//     0; a second candidate with a broken one: it fails with the real
//     runner's exit status, 1, the runner's own report in the output.
// (b) The same check through a pinned copy of node: it passes; the copy's
//     bytes changed, an operator's re-run is `toolchain_missing` with the
//     hash found recorded; the copy removed from the host, the next re-run
//     is `toolchain_missing`; NOW `refused`, `check_unrunnable`.
// (c) A test that never settles: the check's `timeout_s` is reached, and
//     afterwards no process it started is left on the host.
//
// SAFETY: the project's tests only add two numbers or sleep (300 s at most);
// the engine ends the sleeping one at 5 s. The toolchain the case changes
// and removes is the test's own copy of node under its temporary directory;
// the engine's Node installation is only read.

import assert from 'node:assert/strict';
import { appendFileSync, rmSync } from 'node:fs';
import { describe, test } from 'node:test';

import { askingForTicks, reasonSubjects, stageGate } from './harness/gates.mjs';
import { addItem, roleThat, runToEnd, waitForCandidates } from './harness/gitruns.mjs';
import { runsOf, tickUntil } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { BROKEN_SUM, SUM, SUM_PATH, referenceProject } from './harness/project/reference.mjs';
import {
  checkProject,
  domainOfExecution,
  executionsOf,
  installIndexedPlan,
  outputText,
  qualifyRunnerByFixture,
  requestChecks,
  resultRow,
  waitRecorded,
} from './harness/checks/fixtures.mjs';
import { hostProcessesWith, projectNow } from './harness/checks/execution.mjs';

const KEYS = ['accept', 'copied', 'hangs'];

async function rerun(fx, project, candidate, key) {
  const asked = await requestChecks(fx.engine, project.id, candidate.id, { keys: [key] });
  assert.equal(asked.status, 202, `an operator re-runs ${key} (body: ${asked.text})`);
  const id = asked.body.executions[0].id;
  return askingForTicks(
    fx,
    project.id,
    () => {
      const x = executionsOf(fx.home, candidate.id).find((e) => e.id === id);
      return x && ['recorded', 'cancelled', 'interrupted'].includes(x.status) ? x : undefined;
    },
    `the re-run of ${key} to end`,
  );
}

describe('M223 a real project\'s toolchain', () => {
  test('(a) the real runner passes correct source and fails a broken one; (c) a hanging test reaches timeout_s and leaves nothing; (b) a changed or removed toolchain is toolchain_missing', async (t) => {
    const fx = await sandboxEngine(t, { config: { terminate_grace: 3, kill_grace: 2 } });
    await qualifyRunnerByFixture(fx.engine);
    const ref = referenceProject(fx.root);
    const project = await checkProject(fx, { files: ref.files, tier: 'T1' });
    const plan = await installIndexedPlan(fx.engine, project.id, { index: [{ key: 'R1', criteria: ['R1.1'] }], stages: [{ number: 1, goal: 'sum', implements: ['R1'] }] });
    const [stage] = plan.stages;
    fx.scripted.script(stage.work_item, [roleThat([step.write(SUM_PATH, SUM)], { nominate: true })]);
    const build = await runToEnd(fx, project.id, stage.work_item);
    assert.deepEqual([build.outcome, build.reason_class], ['completed', 'none'], `the Builder's run was accepted (${build.reason_text})`);
    const [first] = await waitForCandidates(fx, project.id);
    const recorded = await waitRecorded(fx, project.id, first.id, KEYS);

    // (a) correct source.
    const accept = resultRow(fx.home, recorded.accept.result);
    const acceptOut = outputText(fx.home, accept);
    assert.match(acceptOut, /^ok 1 - R1\.1: sum adds/m, `the fixture is live: Node's test runner ran the protected test (output ${JSON.stringify(acceptOut.slice(0, 300))})`);
    assert.deepEqual([accept.execution_established, accept.exit_status], [1, 0], '(a) correct source: passed, exit 0');
    assert.equal(recorded.accept.toolchain?.path, process.execPath, "(a) the engine's own node ran it, recorded with its hash");
    const copied = resultRow(fx.home, recorded.copied.result);
    assert.deepEqual([copied.execution_established, copied.exit_status], [1, 0], '(b) through the pinned copy of node: passed');
    assert.equal(recorded.copied.toolchain?.sha256, ref.copySha, '(b) the pinned hash was the one found');

    // (c) the hanging test.
    const hangs = resultRow(fx.home, recorded.hangs.result);
    assert.deepEqual([hangs.execution_established, hangs.exit_status, hangs.deadline_hit, hangs.signaled], [1, null, 1, 1], '(c) timeout_s reached: deadline_hit and signaled');
    const hangDomain = domainOfExecution(fx.home, recorded.hangs);
    assert.deepEqual([hangDomain.status, hangDomain.launch_state], ['terminated', 'closed'], '(c) its domain terminated with closure');
    assert.deepEqual(hostProcessesWith(ref.hangToken), [], '(c) host-read: no process it started is left');

    // (a) a broken candidate: the real runner's exit status.
    const fix = await addItem(fx, project.id, 'fix');
    fx.scripted.script(fix, [roleThat([step.write(SUM_PATH, BROKEN_SUM)], { nominate: true })]);
    await tickUntil(fx.engine, project.id, () => runsOf(fx.home, fix)[0]?.state === 'ended', { what: 'the fix to be built' });
    const second = (await waitForCandidates(fx, project.id, 2)).at(-1);
    const broken = (await waitRecorded(fx, project.id, second.id, ['accept'], { what: "the broken candidate's acceptance check" })).accept;
    const brokenRow = resultRow(fx.home, broken.result);
    assert.match(outputText(fx.home, brokenRow), /^not ok 1 - R1\.1: sum adds/m, "the runner's own report of the failure is in the output");
    assert.deepEqual([brokenRow.execution_established, brokenRow.exit_status], [1, 1], "(a) a broken source: failed with the real runner's exit status, 1");
    const evaluation = await stageGate(fx, { project, stage: stage.id }, second);
    assert.ok(reasonSubjects(evaluation, 'CHECK_NOT_PASSED').includes(broken.check), 'the stage gate is not satisfied: CHECK_NOT_PASSED names the acceptance check');

    // (b) the copy's bytes changed, then the copy removed.
    appendFileSync(ref.copy, Buffer.from([0]));
    const changed = await rerun(fx, project, second, 'copied');
    assert.deepEqual([resultRow(fx.home, changed.result).execution_established, changed.not_run_reason], [0, 'toolchain_missing'], '(b) the pinned hash changed: toolchain_missing');
    assert.ok(changed.toolchain?.sha256 && changed.toolchain.sha256 !== ref.copySha, `(b) the hash found is recorded (${JSON.stringify(changed.toolchain)})`);
    rmSync(ref.copy);
    const removed = await rerun(fx, project, second, 'copied');
    assert.deepEqual([resultRow(fx.home, removed.result).execution_established, removed.not_run_reason], [0, 'toolchain_missing'], '(b) the toolchain path removed from the host: toolchain_missing');
    const now = await projectNow(fx.engine, project.id);
    assert.deepEqual([now.state, now.cause], ['refused', 'check_unrunnable'], `(b) NOW refused, check_unrunnable (now: ${JSON.stringify(now)})`);
  });
});
