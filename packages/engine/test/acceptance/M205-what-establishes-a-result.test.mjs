// M205, what establishes a result; the exit mapping (M3 slice 15; sandbox
// lane). M3 plan §3.1 M205; D3 §2.6, §2.7, A.3, A.5; D1 §9.2; T07; SEAM.md
// §§177 to 185.
//
// One project, one candidate, six checks, each a test-owned check program
// run by the engine in a real `check` domain:
//   (a) exit 0                                      passed
//   (b) exit 3                                      failed, exit_status 3
//   (c) prints "passed", exits 1                    failed, exit_status 1
//   (e) a program the exec refuses (mode 0644)      not established, exec_failed, skipped
//   (f) exit 0 with the init's exit report lost     established, exit_status null, failed
//   (h) past timeout_s, exits 0 on the TERM         never passed, exit_status null
// and for every case: execution_established only with the engine's
// authorized launch, its `started` report and termination with closure.
//
// Not in this file (COVERAGE.md, "M3 slice 15"): (d) a foreign signal and
// (i) forged reports on the control descriptors, deferred because the M2
// instruments that make them cannot run as a check program without a new
// harness capability; (g) the OOM kill, the exhaustion lane's, deferred for
// the same reason.
//
// The cases read one history (M39's form), made in the `before` hook.
//
// SAFETY: the check program (harness/checks/program.mjs) is benign: it exits
// with a status, prints, waits for a release file, or waits for SIGTERM and
// exits 0. It signals nothing and writes no file.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { armFault } from './harness/engine.mjs';
import { installGatedPlan, sharedFixture, stageGate } from './harness/gates.mjs';
import { permittedEdit, roleThat, runToEnd, waitForCandidates } from './harness/gitruns.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import {
  GOVERNED_FILE,
  checkProject,
  defPath,
  domainOfExecution,
  executionsOf,
  heldExecution,
  holdArgs,
  installCheckProgram,
  outputText,
  qualifyRunnerByFixture,
  release,
  resultRow,
  sandboxGoverned,
  smoke,
  waitRecorded,
} from './harness/checks/fixtures.mjs';

const CASES = {
  exit0: { command: ['probe', 'exit', '0'] },
  exit3: { command: ['probe', 'exit', '3'] },
  saypassed: { command: ['probe', '--say', 'passed', 'exit', '1'] },
  noexec: { command: ['noexec'] },
  lost: { command: null }, // filled with the hold below
  term: { command: ['probe', 'term-exit0', '60000'], timeout: 2 },
};
const KEYS = Object.keys(CASES);

const kinds = (x) => (x.init_reports ?? []).map((r) => r.kind);

async function history(t) {
  const fx = await sandboxEngine(t);
  const prog = installCheckProgram(fx.root);
  CASES.lost.command = ['probe', ...holdArgs(prog, 'lost'), 'exit', '0'];
  const files = { [GOVERNED_FILE]: sandboxGoverned(prog) };
  for (const [key, c] of Object.entries(CASES)) files[defPath(key)] = smoke(key, { command: c.command, gates: ['stage'], timeout: c.timeout ?? 120 });
  const project = await checkProject(fx, { files, tier: 'T1' });
  await qualifyRunnerByFixture(fx.engine);
  const plan = await installGatedPlan(fx.engine, project.id, { requirements: [], stages: [{ number: 1, goal: 'the first stage', implements: [] }] });
  const [stage] = plan.stages;
  fx.scripted.script(stage.work_item, [roleThat([permittedEdit()], { nominate: true })]);
  const build = await runToEnd(fx, project.id, stage.work_item);
  assert.deepEqual([build.outcome, build.reason_class], ['completed', 'none'], `the Builder's run was accepted (${build.reason_text})`);
  const [candidate] = await waitForCandidates(fx, project.id);

  // (f): while the `lost` check's program holds in its domain, the next exit report of a domain init is made to be lost; then it is released.
  const held = await heldExecution(fx, project.id, candidate.id, { lost: 'lost' });
  await armFault(fx.engine, { point: 'init_report_lost' });
  release(prog, 'lost');

  const recorded = await waitRecorded(fx, project.id, candidate.id, KEYS);
  const evaluation = await stageGate(fx, { project, candidate, stage: stage.id });
  return { fx, project, candidate, held, recorded, evaluation };
}

describe('M205 what establishes a result; the exit mapping', () => {
  const shared = sharedFixture();
  let H;
  before(async () => {
    H = await history(shared.context);
  });
  after(() => shared.cleanup());

  const resultOf = (key) => resultRow(H.fx.home, H.recorded[key].result);
  const stateOf = (key) => H.evaluation.check_states[H.recorded[key].check];
  const fields = (r) => ({ established: r.execution_established, exit_status: r.exit_status, signaled: r.signaled, deadline_hit: r.deadline_hit, not_run_reason: r.not_run_reason ?? null });

  test('(a) exit 0: passed', () => {
    assert.deepEqual(fields(resultOf('exit0')), { established: 1, exit_status: 0, signaled: 0, deadline_hit: 0, not_run_reason: null });
    assert.equal(stateOf('exit0'), 'passed');
  });

  test('(b) exit 3: failed, exit_status as reported', () => {
    assert.deepEqual(fields(resultOf('exit3')), { established: 1, exit_status: 3, signaled: 0, deadline_hit: 0, not_run_reason: null });
    assert.equal(stateOf('exit3'), 'failed');
  });

  test('(c) prints "passed" and exits 1: failed, exit_status 1; what it printed is in its output and changes no field', () => {
    const r = resultOf('saypassed');
    assert.deepEqual(fields(r), { established: 1, exit_status: 1, signaled: 0, deadline_hit: 0, not_run_reason: null });
    assert.match(outputText(H.fx.home, r), /^passed$/m, 'the program wrote "passed"');
    assert.equal(stateOf('saypassed'), 'failed');
  });

  test('(e) a failed exec: execution_established false, exec_failed, skipped; the init reported the failed exec and no started', () => {
    const x = H.recorded.noexec;
    assert.deepEqual(fields(resultOf('noexec')), { established: 0, exit_status: null, signaled: 0, deadline_hit: 0, not_run_reason: 'exec_failed' });
    assert.ok(kinds(x).includes('exec_failed') && !kinds(x).includes('started'), `the init reported exec_failed and never started (${JSON.stringify(x.init_reports)})`);
    assert.equal(stateOf('noexec'), 'skipped');
  });

  test('(f) init_report_lost with closure observed: established, exit_status null, failed', () => {
    const x = H.recorded.lost;
    assert.equal(H.held.execution.id, x.id, 'the fixture is live: the fault was armed while this check held in its domain');
    assert.deepEqual(fields(resultOf('lost')), { established: 1, exit_status: null, signaled: 0, deadline_hit: 0, not_run_reason: null });
    assert.ok(kinds(x).includes('started') && !kinds(x).includes('exit'), `the init's started report was recorded and its exit report was not (${JSON.stringify(x.init_reports)})`);
    assert.equal(stateOf('lost'), 'failed');
  });

  test('(h) the engine cancels at timeout_s and the program handles TERM with exit 0: never passed, exit_status null', () => {
    const r = resultOf('term');
    assert.match(outputText(H.fx.home, r), /got SIGTERM, exiting 0/, 'the fixture is live: the program received the TERM and exited 0');
    assert.deepEqual(fields(r), { established: 1, exit_status: null, signaled: 1, deadline_hit: 1, not_run_reason: null });
    assert.equal(stateOf('term'), 'failed');
  });

  test('every case: execution_established only with the engine-authorized launch, the started report and termination with closure', () => {
    for (const key of KEYS) {
      const x = H.recorded[key];
      const r = resultOf(key);
      assert.equal(r.execution, x.id, `${key}: the result names its execution`);
      const domain = domainOfExecution(H.fx.home, x);
      assert.ok(domain, `${key}: the execution names its domain`);
      assert.deepEqual([domain.profile, domain.check_execution], ['check', x.id], `${key}: a check domain of this execution (L1)`);
      assert.deepEqual([domain.status, domain.observation, domain.launch_state], ['terminated', 'terminated', 'closed'], `${key}: the domain was terminated with closure observed`);
      if (r.execution_established === 1) {
        assert.equal(domain.launch_binding?.check_execution, x.id, `${key}: established, so the launch was authorized for this execution`);
        assert.ok(domain.launch_authorized_at, `${key}: and its authorization was recorded`);
        assert.ok(kinds(x).includes('started'), `${key}: and the init's started report was recorded`);
      } else {
        assert.ok(!kinds(x).includes('started'), `${key}: not established, and no started report`);
      }
    }
    assert.equal(executionsOf(H.fx.home, H.candidate.id).length, KEYS.length, 'one execution per check, none registered again');
  });
});
