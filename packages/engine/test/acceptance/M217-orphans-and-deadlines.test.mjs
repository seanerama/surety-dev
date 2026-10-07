// M217, orphans and deadlines (M3 slice 18; sandbox lane; a destructive
// file, listed last but two in its slice). M3 plan §3.4 M217; D3-R08,
// D3-R09; D3 §2.6, §7.1 L4; T08; SEAM.md §§203, 206.
//
// One candidate, four checks, run one at a time:
//   (a) `orphan`   exits 0 at once, leaving one detached descendant with its
//                  standard output closed that sleeps 60 s: `orphans`,
//                  `failed`, observed at the program's exit; afterwards no
//                  process of it is left on the host.
//   (b) `brief`    the same with a descendant that sleeps 0.5 s, so it ends
//                  by itself during the domain's teardown: still `orphans`
//                  (the observation was made at the exit, not after the
//                  output drained).
//   (c) `alone`    the control: no descendant, exit 0: `passed`, no orphans.
//   (d) `stubborn` ignores TERM and waits; its `timeout_s` passes: TERM, then
//                  the kill: `deadline_hit` and `signaled`, `exit_status`
//                  null; the row stays as recorded.
//
// SAFETY (E64; BS3 §4 rule 1): `detach-child` and `ignore-term` are guarded
// modes of the test's check program (SEAM.md §§198, 206): each acts only once
// it has established that it is in a check domain, and the test releases it
// only after reading its containment from the host (assertContained). The
// descendant only sleeps (at most 60 s) and exits; nothing signals anything.
// The program that ignores TERM waits at most 120 s; the engine's kill ends
// it at its deadline.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture, stageGate } from './harness/gates.mjs';
import { tick } from './harness/runs.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import {
  GOVERNED_FILE,
  buildStage,
  checkProject,
  defPath,
  domainOfExecution,
  executionRow,
  guardArgs,
  heldExecution,
  holdArgs,
  installCheckProgram,
  outputText,
  programLine,
  qualifyRunnerByFixture,
  resultRow,
  sandboxGoverned,
  smoke,
  waitRecorded,
} from './harness/checks/fixtures.mjs';
import { hostProcessesWith, releaseContained } from './harness/checks/execution.mjs';

// Long enough that the test has released the program into its mode well
// before the deadline; the deadline then falls while it ignores TERM.
const TIMEOUT_S = 20;

const CHECKS = (prog) => ({
  orphan: ['probe', ...holdArgs(prog, 'orphan'), ...guardArgs(), 'detach-child', '60000'],
  brief: ['probe', ...holdArgs(prog, 'brief'), ...guardArgs(), 'detach-child', '500'],
  alone: ['probe', 'exit', '0'],
  stubborn: ['probe', ...holdArgs(prog, 'stubborn'), ...guardArgs(), 'ignore-term', '120000'],
});
const GUARDED = ['orphan', 'brief', 'stubborn'];

async function history(t) {
  const fx = await sandboxEngine(t, { config: { terminate_grace: 3, kill_grace: 2 } });
  const prog = installCheckProgram(fx.root);
  await qualifyRunnerByFixture(fx.engine);
  const files = { [GOVERNED_FILE]: sandboxGoverned(prog) };
  for (const [key, command] of Object.entries(CHECKS(prog))) files[defPath(key)] = smoke(key, { command, gates: ['stage'], timeout: key === 'stubborn' ? TIMEOUT_S : 120 });
  const project = await checkProject(fx, { files });
  const { stage, candidate } = await buildStage(fx, project);

  // Each guarded program is released only after its containment is read from the host.
  const pending = Object.fromEntries(GUARDED.map((k) => [k, k]));
  while (Object.keys(pending).length > 0) {
    const held = await heldExecution(fx, project.id, candidate.id, pending);
    releaseContained(prog, held, held.key);
    delete pending[held.key];
  }
  const recorded = await waitRecorded(fx, project.id, candidate.id, Object.keys(CHECKS(prog)));
  const stubbornRow = resultRow(fx.home, recorded.stubborn.result);
  await tick(fx.engine, project.id, { rounds: 2 });
  const evaluation = await stageGate(fx, { project, stage }, candidate);
  return { fx, prog, project, candidate, recorded, stubbornRow, evaluation };
}

describe('M217 orphans and deadlines', () => {
  const shared = sharedFixture();
  let H;
  before(async () => {
    H = await history(shared.context);
  });
  after(() => shared.cleanup());

  const result = (key) => resultRow(H.fx.home, H.recorded[key].result);
  const state = (key) => H.evaluation.check_states[H.recorded[key].check];
  const reports = (key) => (executionRow(H.fx.home, H.recorded[key].id).init_reports ?? []).map((r) => r.kind);

  test('(a) exit 0 leaving a detached descendant with standard output closed: orphans, failed, observed at the exit; the descendant gone afterwards', () => {
    const r = result('orphan');
    const detached = programLine(outputText(H.fx.home, r), 'SURETY-CHECK-DETACHED');
    assert.ok(Number.isInteger(detached.pid), `the fixture is live: the program started its descendant (${JSON.stringify(detached)})`);
    assert.deepEqual([r.execution_established, r.exit_status, r.orphans, r.signaled, r.deadline_hit], [1, 0, 1, 0, 0], 'established, exit 0, orphans (L4)');
    assert.ok(reports('orphan').includes('orphans'), `the init reported the orphans (${reports('orphan').join(', ')})`);
    assert.equal(state('orphan'), 'failed', 'a check that leaves work running did not finish it: failed');
    const domain = domainOfExecution(H.fx.home, H.recorded.orphan);
    assert.deepEqual([domain.status, domain.launch_state], ['terminated', 'closed'], 'its domain was terminated with closure');
    assert.deepEqual(hostProcessesWith(H.prog.program).filter((pid) => pid !== process.pid), [], 'host-read: no process of the check program, its descendant included, is left');
  });

  test('(b) the descendant ends by itself during the teardown: still orphans', () => {
    const r = result('brief');
    assert.deepEqual([r.execution_established, r.exit_status, r.orphans], [1, 0, 1], 'orphans stands: observed at the exit, not after the output drained (T08)');
    assert.equal(state('brief'), 'failed');
  });

  test('(c) the control, no descendant: passed, no orphans', () => {
    const r = result('alone');
    assert.deepEqual([r.execution_established, r.exit_status, r.orphans], [1, 0, 0], 'exit 0, no orphans');
    assert.equal(state('alone'), 'passed');
  });

  test('(d) past timeout_s a program that ignores TERM: TERM, then the kill; deadline_hit and signaled, exit_status null; no later report changes the row', () => {
    const r = result('stubborn');
    assert.match(outputText(H.fx.home, r), /ignored SIGTERM/, 'the fixture is live: the TERM reached the program and it went on');
    assert.deepEqual([r.execution_established, r.exit_status, r.deadline_hit, r.signaled], [1, null, 1, 1], 'deadline_hit and signaled, exit_status null');
    assert.equal(state('stubborn'), 'failed');
    assert.deepEqual(r, H.stubbornRow, 'the row is as it was recorded, ticks later');
  });
});
