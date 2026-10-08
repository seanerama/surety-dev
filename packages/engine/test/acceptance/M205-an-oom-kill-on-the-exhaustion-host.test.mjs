// M205 (g), an OOM kill (M3 slice 18; EXHAUSTION LANE ONLY). M3 plan §3.1
// M205 (g), question 7 (a); E92 item 2 (7); D3-R06; D3 §2.6; E69; SEAM.md
// §§155, 212. The other cases of the row are
// `M205-what-establishes-a-result.test.mjs` (slice 15) and
// `M205-a-foreign-signal-and-forged-reports.test.mjs` (slice 18).
//
// NEVER RUN ON THE DEVELOPMENT WORKSTATION: listed under the manifest's
// `exhaust` key and run only by `--lane exhaust` where
// SURETY_EXHAUSTION_HOST names the host (mini-hp01, E69 item 2), by Sean or
// by the driver at his request.
//
// A check domain under Sean's caps (64 MiB memory, no swap, 64 tasks, a
// 1 MiB volatile filesystem of 64 inodes; the harness flag of SEAM.md §212)
// runs the program's `alloc` mode, which allocates past memory.max: the
// kernel kills it. The result is `signaled`, `exit_status` null, `failed`,
// with no deadline; the domain's resource events record the OOM kill.
//
// SAFETY (E64 item 2, E69; SEAM.md §§155, 212). Three stops, as M130's:
//   1. the program's guard: it acts only inside a check domain (its pid,
//      network and mount namespaces not the host's, pid 1 no system init, at
//      most 16 processes visible);
//   2. its own bounds: a cap above 64 MiB is refused, so is a memory.max it
//      can read above the cap, and it stops by itself at twice the cap
//      (128 MiB), 1 MiB at a time;
//   3. the test's half: the program holds until the host has read it
//      contained and its domain's pids.max, memory.max, memory.swap.max and
//      volatile filesystem exactly the caps; anything else fails the case
//      before the release.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { stageGate } from './harness/gates.mjs';
import { CAPS, assertDomainCaps } from './harness/sandbox/limits.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { assertContained } from './harness/sandbox/view.mjs';
import {
  GOVERNED_FILE,
  buildStage,
  checkProject,
  defPath,
  domainOfExecution,
  guardArgs,
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

const LIMITS = `pids_max=${CAPS.pids_max},memory_max=${CAPS.memory_max},writable_bytes=${CAPS.writable_bytes},writable_inodes=${CAPS.writable_inodes}`;

describe('M205 (g) an OOM kill (exhaustion lane)', () => {
  test('a check allocating past memory.max 64 MiB is OOM-killed: signaled, exit_status null, failed, the OOM kill recorded', async (t) => {
    const fx = await sandboxEngine(t, { start: false });
    await fx.start({ args: ['--harness-check-domain-limits', LIMITS] });
    const prog = installCheckProgram(fx.root);
    await qualifyRunnerByFixture(fx.engine);
    const files = {
      [GOVERNED_FILE]: sandboxGoverned(prog),
      [defPath('oom')]: smoke('oom', { command: ['probe', ...holdArgs(prog, 'oom'), ...guardArgs(), 'alloc', String(CAPS.memory_max)], gates: ['stage'], timeout: 120 }),
    };
    const project = await checkProject(fx, { files });
    const { stage, candidate } = await buildStage(fx, project);

    const held = await heldExecution(fx, project.id, candidate.id, { oom: 'oom' });
    assertContained(held.domain, held.member, 'the oom check program');
    assertDomainCaps(held.domain, held.member, CAPS);
    release(prog, 'oom');

    const { oom } = await waitRecorded(fx, project.id, candidate.id, ['oom']);
    const r = resultRow(fx.home, oom.result);
    const text = outputText(fx.home, r);
    assert.match(text, /SURETY-CHECK-ALLOC \d+/, 'the fixture is live: the program allocated');
    assert.doesNotMatch(text, /reached its ceiling/, 'the program never reached its own ceiling: the kernel ended it');
    assert.deepEqual([r.execution_established, r.exit_status, r.signaled, r.deadline_hit], [1, null, 1, 0], 'signaled by a signal the engine did not send, exit_status null, no deadline');
    const evaluation = await stageGate(fx, { project, stage }, candidate);
    assert.equal(evaluation.check_states[oom.check], 'failed');
    const domain = domainOfExecution(fx.home, oom);
    const events = typeof domain.resource_events === 'string' ? JSON.parse(domain.resource_events) : domain.resource_events;
    assert.ok(events?.oom_kill >= 1, `the domain's resource events record the OOM kill (SEAM.md §§145, 212) (${JSON.stringify(events)})`);
  });
});
