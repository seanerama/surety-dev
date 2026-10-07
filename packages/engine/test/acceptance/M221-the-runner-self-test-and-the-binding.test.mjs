// M221 (a) to (d), the runner self-test and the runner binding (M3 slice
// 18; sandbox lane). M3 plan §3.4 M221; D3 §2.8, §2.5 ("Binding at
// launch"), §2.2 (B01), A.3 `host_qualifications.check_runner`; T18, T19;
// E95; SEAM.md §§203, 208, 209. Case (e) is
// `M221-the-runner-fixture-only-in-harness-mode.test.mjs` (kernel lane).
//
// One history over four starts of one engine home, each running the
// self-test (SEAM.md §208), none using the runner qualification fixture:
//   start 1  the self-test qualifies `direct`: every case of D3 §2.8 and its
//            control recorded `passed` (a); the input case's evidence is the
//            structural reading E95 decided, the mount table of its check
//            read from the host, and it shows every input and each ancestor
//            up to /surety/workspace on a read-only mount of its own. A
//            project's three checks are registered at a nomination and run
//            one at a time: the first is recorded, the second is held
//            running, the third stays queued; the engine is killed.
//   start 2  a different check profile (the harness's profile variant): a
//            new qualification. The third registration, made under start 1,
//            is launched under start 2's qualification and records that
//            runner identity, qualification and program hash (c); the first
//            result keeps start 1's (d).
//   start 3  one mandatory case forced `failed` (b): `direct` unqualified,
//            an operator's request recorded `runner_unqualified`, `skipped`,
//            NOW `refused` with cause `check_unrunnable`.
//   start 4  one mandatory case forced `not_exercised` (b): the same.
//
// T02's attempt cases (rename, exchange, replacement, symlink and hard-link
// redirection by check code) are not written: E95 decided that the
// self-test's evidence for "a protected input cannot change" is structural,
// as M212's is (COVERAGE.md, "M3 slice 18").
//
// SAFETY: the project's check program is used only to hold at its release
// file and exit 0. The engine is killed through the test's own handle on
// it; recovery ends the held check through the boundary. The self-test's
// programs are the engine's.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture, stageGate } from './harness/gates.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import {
  GOVERNED_FILE,
  assertImmutableAt,
  buildStage,
  checkProject,
  defPath,
  executionRow,
  executionsOf,
  gateCheckEntries,
  entryByKey,
  heldExecution,
  holdArgs,
  installCheckProgram,
  release,
  requestChecks,
  resultRow,
  sandboxGoverned,
  smoke,
  terminalExecution,
  waitRecorded,
} from './harness/checks/fixtures.mjs';
import { SELF_TEST_CASES, mountsOfLines, projectNow, retriesOf, selfTestArgs, selfTestEntry, waitSelfTest } from './harness/checks/execution.mjs';

const KEYS = ['one', 'two', 'three'];
const prefixOf = (runnerId) => runnerId.split('/')[1];

async function history(t) {
  const fx = await sandboxEngine(t, { start: false });

  // Start 1.
  await fx.start({ args: selfTestArgs() });
  const q1 = await waitSelfTest(fx);
  const prog = installCheckProgram(fx.root);
  const files = { [GOVERNED_FILE]: sandboxGoverned(prog) };
  for (const key of KEYS) files[defPath(key)] = smoke(key, { command: ['probe', ...holdArgs(prog, key), 'exit', '0'], gates: ['stage'], timeout: 300 });
  const project = await checkProject(fx, { files });
  const { stage, candidate } = await buildStage(fx, project);
  const first = await heldExecution(fx, project.id, candidate.id, Object.fromEntries(KEYS.map((k) => [k, k])));
  release(prog, first.key);
  const historical = (await waitRecorded(fx, project.id, candidate.id, [first.key]))[first.key];
  const historicalResult = resultRow(fx.home, historical.result);
  const rest = KEYS.filter((k) => k !== first.key);
  const second = await heldExecution(fx, project.id, candidate.id, Object.fromEntries(rest.map((k) => [k, k])));
  const thirdKey = rest.find((k) => k !== second.key);
  const thirdBefore = executionsOf(fx.home, candidate.id).find((x) => x.key === thirdKey);
  await fx.engine.kill();

  // Start 2: another check profile.
  await fx.start({ args: [...selfTestArgs(), '--harness-check-profile-variant', 'm221-b'] });
  const q2 = await waitSelfTest(fx, { notRow: q1.id });
  const third = await heldExecution(fx, project.id, candidate.id, { [thirdKey]: thirdKey });
  release(prog, thirdKey);
  const thirdRecorded = (await waitRecorded(fx, project.id, candidate.id, [thirdKey]))[thirdKey];
  release(prog, second.key);
  const secondEnded = executionRow(fx.home, second.execution.id);
  const retried = retriesOf(executionsOf(fx.home, candidate.id), second.execution);
  if (retried.length > 0) await waitRecorded(fx, project.id, candidate.id, [second.key], { what: 'the retry of the interrupted check to be recorded' });
  await fx.engine.stop();

  // Starts 3 and 4: one mandatory case forced failed, then not_exercised.
  const forced = [];
  let previous = q2.id;
  for (const [name, result] of [['exit_nonzero', 'failed'], ['input_immutable', 'not_exercised']]) {
    await fx.start({ args: selfTestArgs({ [name]: result }) });
    const q = await waitSelfTest(fx, { notRow: previous });
    previous = q.id;
    const asked = await requestChecks(fx.engine, project.id, candidate.id, { keys: [first.key] });
    assert.equal(asked.status, 202, `an operator re-runs ${first.key} (body: ${asked.text})`);
    const ran = await terminalExecution(fx, project.id, candidate.id, first.key, `the re-run of ${first.key} under the unqualified runner to end`);
    const now = await projectNow(fx.engine, project.id);
    const evaluation = await stageGate(fx, { project, stage }, candidate);
    forced.push({ name, result, q, ran, now, evaluation });
    await fx.engine.stop();
  }
  return { fx, project, candidate, q1, q2, first, historical, historicalResult, second, secondEnded, thirdBefore, third, thirdRecorded, forced };
}

describe('M221 the runner self-test and the runner binding', () => {
  const shared = sharedFixture();
  let H;
  before(async () => {
    H = await history(shared.context);
  });
  after(() => shared.cleanup());

  test("(a) an engine start: every case of D3 §2.8 and its control recorded passed on host_qualifications.check_runner, and direct qualified", () => {
    const runner = H.q1.check_runner;
    assert.deepEqual(runner.self_test.map((e) => e.case), SELF_TEST_CASES, `exactly the mandatory cases, in order (SEAM.md §208) (got ${JSON.stringify(runner.self_test.map((e) => e.case))})`);
    for (const e of runner.self_test) {
      assert.equal(e.result, 'passed', `${e.case}: passed, its control included (${JSON.stringify(e).slice(0, 300)})`);
      assert.ok(typeof e.control === 'string' && e.control.length > 0, `${e.case}: names the control run beside it`);
    }
    assert.equal(runner.qualified, true, 'direct is qualified');
    assert.notEqual(runner.test_fixture, true, 'by the self-test, not the fixture');
    assert.match(runner.profile_fingerprint ?? '', /^[0-9a-f]{16,}$/, 'the check profile fingerprint is recorded');
  });

  test("(a) the input case's evidence is structural (E95): every input and each ancestor up to /surety/workspace lies on a read-only mount of its own in its check's mount table", () => {
    const evidence = selfTestEntry(H.q1, 'input_immutable')?.evidence;
    assert.ok(evidence && Array.isArray(evidence.inputs) && Array.isArray(evidence.mountinfo), `the input case records its inputs and its check's mount table (SEAM.md §208) (evidence: ${JSON.stringify(evidence).slice(0, 400)})`);
    assert.ok(evidence.inputs.length > 0 && evidence.mountinfo.length > 0, 'neither is empty');
    assert.ok(evidence.inputs.some((p) => p.split('/').length >= 3), `an input lies at least two directories below the workspace, so an ancestor is a mount target only (B01; inputs ${JSON.stringify(evidence.inputs)})`);
    const mounts = mountsOfLines(evidence.mountinfo);
    assert.ok(mounts.some((m) => m.point === '/surety/workspace'), 'the recorded table is a check domain\'s: it has /surety/workspace');
    for (const input of evidence.inputs) assertImmutableAt(mounts, input, `the self-test's input ${input}`);
  });

  test('(c) a registration made under one qualification and launched after a restart under another profile uses the qualification current at launch and records the runner identity, qualification and program hash it used', () => {
    assert.notEqual(H.q2.check_runner.profile_fingerprint, H.q1.check_runner.profile_fingerprint, 'the fixture is live: the profile variant changed the check profile fingerprint');
    assert.equal(H.q2.check_runner.qualified, true, 'start 2 qualified direct by its own self-test');
    assert.equal(H.thirdBefore.status, 'queued', 'the fixture is live: the third check was registered and still queued when start 1 ended');
    assert.equal(H.third.execution.id, H.thirdBefore.id, 'the same registration was launched under start 2');
    const x = executionRow(H.fx.home, H.thirdRecorded.id);
    const r = resultRow(H.fx.home, x.result);
    assert.deepEqual([r.execution_established, r.exit_status], [1, 0], 'it ran to its end');
    assert.equal(r.runner_qualification, H.q2.id, "its result is bound to start 2's qualification, current at launch (T19)");
    assert.equal(x.runner_qualification, H.q2.id, 'and so is its execution');
    assert.ok(H.q2.check_runner.profile_fingerprint.startsWith(prefixOf(r.runner_id)), `its runner_id names start 2's profile (${r.runner_id})`);
    assert.ok(!H.q1.check_runner.profile_fingerprint.startsWith(prefixOf(r.runner_id)), "and not start 1's");
    assert.equal(x.runner_id, r.runner_id, 'the execution persists the runner identity it used');
    assert.ok(x.toolchain && typeof x.toolchain.path === 'string' && /^[0-9a-f]{64}$/.test(x.toolchain.sha256 ?? ''), `the execution persists the resolved program and its hash (${JSON.stringify(x.toolchain)})`);
    assert.equal(H.secondEnded.status, 'interrupted', 'the check held when start 1 was killed ended interrupted (D3 §2.6)');
    assert.equal(H.secondEnded.result, null, 'with no result row');
  });

  test('(d) a result recorded under the first qualification is not relabelled after requalification', () => {
    const now = resultRow(H.fx.home, H.historical.result);
    assert.deepEqual(now, H.historicalResult, 'the result row is unchanged across three requalifications');
    assert.equal(now.runner_qualification, H.q1.id, "it names start 1's qualification");
    assert.ok(H.q1.check_runner.profile_fingerprint.startsWith(prefixOf(now.runner_id)), "and start 1's profile");
  });

  for (const [n, name, result] of [[0, 'exit_nonzero', 'failed'], [1, 'input_immutable', 'not_exercised']]) {
    test(`(b) the mandatory case ${name} forced ${result}: direct unqualified; an execution records runner_unqualified, skipped; NOW refused, check_unrunnable`, () => {
      const f = H.forced[n];
      assert.equal(selfTestEntry(f.q, name)?.result, result, `the case is recorded ${result} (${JSON.stringify(selfTestEntry(f.q, name))})`);
      assert.equal(f.q.check_runner.qualified, false, 'one mandatory case not passed leaves direct unqualified (T18)');
      const r = resultRow(H.fx.home, f.ran.result);
      assert.ok(r, `the operator's re-run is recorded (execution ${JSON.stringify(f.ran).slice(0, 300)})`);
      assert.deepEqual([r.execution_established, r.not_run_reason], [0, 'runner_unqualified'], 'not established, runner_unqualified (D3 §2.7)');
      const entry = entryByKey(gateCheckEntries(f.evaluation), H.first.key);
      assert.deepEqual([entry.state, entry.not_run_reason], ['skipped', 'runner_unqualified'], 'the gate read shows it skipped with its reason');
      assert.deepEqual([f.now.state, f.now.cause], ['refused', 'check_unrunnable'], `NOW is refused with cause check_unrunnable (SEAM.md §209) (now: ${JSON.stringify(f.now)})`);
    });
  }
});
