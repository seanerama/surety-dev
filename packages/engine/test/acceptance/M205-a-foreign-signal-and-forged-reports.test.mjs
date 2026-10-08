// M205 (d) and (i), a foreign signal and forged reports (M3 slice 18;
// sandbox lane; a destructive file, listed last in its slice). M3 plan §3.1
// M205; D3-R05, D3-R06; D3 §2.6; T07; SEAM.md §§182, 203, 205, 207. The
// slice-15 cases of the row are `M205-what-establishes-a-result.test.mjs`;
// (g), the OOM kill, is the exhaustion lane's
// `M205-an-oom-kill-on-the-exhaustion-host.test.mjs`. Slice 15 deferred
// these cases for want of an instrument; the coordinator's rulings for
// slice 18 give them one each (COVERAGE.md, "M3 slice 18").
//
// (d) A signal the engine did not send: while the check program holds in
//     its domain, the TEST sends SIGKILL, host-side, to that program's pid,
//     read from the domain's cgroup.procs and confirmed by its command line,
//     as M201 (b) finds it: `signaled`, `exit_status` null, `failed`, and no
//     deadline.
// (i) Text that imitates the init's reports: the program prints lines in
//     the shapes of a `started` and an `exit` report, claiming exit status
//     7 and a second start, then exits 0. The result is the program's own
//     exit, 0; the init's reports are one `started` and one `exit`; the
//     printed text is in the output record as plain output and set no
//     field.
//
// SAFETY (E64): the test signals exactly one pid, the check program it has
// just read from its domain's cgroup.procs, whose containment it read from
// the host and whose command line it confirmed (killVerifiedProgram): never
// a negative pid, 0, 1 or -1, never another process. The program's `print`
// mode is guarded and released only after the host-side containment read.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture, stageGate } from './harness/gates.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import {
  GOVERNED_FILE,
  buildStage,
  checkProject,
  defPath,
  executionRow,
  guardArgs,
  heldExecution,
  holdArgs,
  installCheckProgram,
  outputText,
  qualifyRunnerByFixture,
  resultRow,
  sandboxGoverned,
  smoke,
  waitRecorded,
} from './harness/checks/fixtures.mjs';
import { killVerifiedProgram, releaseContained } from './harness/checks/execution.mjs';

// Lines in the shapes of the init's reports (D3 A.2 InitReport), and a plain claim.
const FORGED = [
  '{"kind":"started","at":"2026-01-01T00:00:00Z","detail":{}}',
  '{"kind":"exit","at":"2026-01-01T00:00:01Z","detail":{"status":7}}',
  'SURETY-INIT started',
  'SURETY-INIT exit 7',
];

async function history(t) {
  const fx = await sandboxEngine(t);
  const prog = installCheckProgram(fx.root);
  await qualifyRunnerByFixture(fx.engine);
  const files = {
    [GOVERNED_FILE]: sandboxGoverned(prog),
    [defPath('foreign')]: smoke('foreign', { command: ['probe', ...holdArgs(prog, 'foreign'), 'exit', '0'], gates: ['stage'], timeout: 120 }),
    [defPath('forger')]: smoke('forger', { command: ['probe', ...holdArgs(prog, 'forger'), ...guardArgs(), 'print', ...FORGED], gates: ['stage'], timeout: 120 }),
  };
  const project = await checkProject(fx, { files });
  const { stage, candidate } = await buildStage(fx, project);
  let signalled = null;
  const pending = { foreign: 'foreign', forger: 'forger' };
  while (Object.keys(pending).length > 0) {
    const held = await heldExecution(fx, project.id, candidate.id, pending);
    if (held.key === 'foreign') signalled = killVerifiedProgram(held, 'foreign');
    else releaseContained(prog, held, 'forger');
    delete pending[held.key];
  }
  const recorded = await waitRecorded(fx, project.id, candidate.id, ['foreign', 'forger']);
  const evaluation = await stageGate(fx, { project, stage }, candidate);
  return { fx, recorded, signalled, evaluation };
}

describe('M205 (d), (i) a foreign signal and forged reports', () => {
  const shared = sharedFixture();
  let H;
  before(async () => {
    H = await history(shared.context);
  });
  after(() => shared.cleanup());

  test('(d) a SIGKILL the engine did not send: signaled, exit_status null, failed, no deadline', () => {
    assert.ok(Number.isInteger(H.signalled), 'the fixture is live: the test signalled the verified check program');
    const r = resultRow(H.fx.home, H.recorded.foreign.result);
    assert.deepEqual([r.execution_established, r.exit_status, r.signaled, r.deadline_hit], [1, null, 1, 0], 'established, signaled, exit_status null, no deadline');
    assert.equal(H.evaluation.check_states[H.recorded.foreign.check], 'failed');
  });

  test("(i) text in the shapes of the init's reports is plain output: the program's own exit decides, one started and one exit report, no field set by it", () => {
    const x = executionRow(H.fx.home, H.recorded.forger.id);
    const r = resultRow(H.fx.home, x.result);
    const text = outputText(H.fx.home, r);
    for (const line of FORGED) assert.ok(text.includes(line), `the fixture is live: the output record holds the printed line ${line}`);
    assert.deepEqual([r.execution_established, r.exit_status, r.signaled, r.deadline_hit], [1, 0, 0, 0], 'the exit status is the program\'s own, 0, not the 7 it printed');
    const kinds = (x.init_reports ?? []).map((e) => e.kind);
    assert.equal(kinds.filter((k) => k === 'started').length, 1, `one started report (${JSON.stringify(x.init_reports)})`);
    assert.equal(kinds.filter((k) => k === 'exit').length, 1, 'one exit report');
    assert.ok(!JSON.stringify(x.init_reports).includes('2026-01-01T00:00'), 'no report carries the forged text');
    assert.equal(H.evaluation.check_states[H.recorded.forger.check], 'passed');
  });
});
