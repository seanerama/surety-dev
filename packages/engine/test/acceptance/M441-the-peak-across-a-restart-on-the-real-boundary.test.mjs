// M441 (f), the peak of a domain across a restart, on the real boundary (M5
// slice 37, the slice-37 review; SANDBOX LANE). M5 plan §3.7 M441 (f); D6
// §7.6 ("a domain removed before its peak was read is unknown"; "a
// historical run is reported with the host observation and settings
// recorded for it"); D6-M01, D6-X08; N01; SEAM.md §§442, 443, 449.
//
// The kernel lane has no memory.peak to read, so there every peak is unknown
// and that is all `M441-the-pace-read-from-recorded-observations` (f) can
// show. Here, on real domains:
//   - a role domain that ended before the restart keeps the peak recorded for
//     it, read before its cgroup was removed: after a restart with a changed
//     setting the pace read shows that same value, and its run names the host
//     observation of the incarnation it ran in, not the new one;
//   - a role domain under way when the engine is killed, and removed by the
//     restart's recovery, shows its peak as recorded (an integer the engine
//     read before removing its cgroup, with its `domain.peak_recorded`) or
//     unknown, never zero and never a value read after its removal.
//
// SAFETY (BS5 §4.1): the only domains are this home's, acted on by the engine
// alone; the test kills only its own engine and starts it again on the same
// home. Nothing allocates beyond a role's ordinary needs. No unit.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { waitFor, writeEngineConfig } from './harness/engine.mjs';
import { CONTRACT } from './harness/fixtures.mjs';
import { readPace } from './harness/journey/drive.mjs';
import { addProject, addWork, tick, waitForRun } from './harness/runs.mjs';
import { SANDBOX_CONFIG, domainOf, roleHolding, sandboxEngine } from './harness/sandbox/lane.mjs';
import { script } from './harness/scripted.mjs';
import { assertPeakRecorded, assertUnknown, domainById, domainEvents } from './harness/exec37/peak.mjs';

const CEILING = CONTRACT.engine.domain_memory_max.min;
const CONFIG = Object.freeze({ domain_memory_max: CEILING, max_concurrent_domains: 2, tick_interval: 600 });
const isUnknown = (v) => v !== null && typeof v === 'object' && typeof v.unknown === 'string';

describe('M441 (f) the peak across a restart, on real domains', () => {
  test('(f) an ended domain keeps the peak recorded for it and its run its own host observation after a restart with a changed setting; a domain removed by the restart\'s recovery is recorded or unknown, never zero', async (t) => {
    const fx = await sandboxEngine(t, { config: CONFIG });
    const project = (await addProject(fx)).id;

    // A role that completes: its domain's peak recorded before removal.
    const done = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(done, [script.complete()]);
    await tick(fx.engine, project);
    const endedRun = await waitForRun(fx.home, done, { state: 'ended', timeoutMs: 60_000 });
    const ended = domainOf(fx.home, endedRun.id);
    await waitFor(() => (domainById(fx.home, ended.id)?.status === 'terminated' ? true : undefined), { timeoutMs: 60_000, what: 'the first domain terminated' });
    assertPeakRecorded(fx.home, ended.id, { memoryMax: CEILING, what: '(f) the domain that ended before the restart' });
    const recordedPeak = domainById(fx.home, ended.id).memory_peak;
    const before = await readPace(fx, project);
    const runBefore = (before.runs ?? []).find((r) => r.id === endedRun.id);
    assert.ok(runBefore && typeof runBefore.host_observation === 'string', `the run names its host observation before the restart (${JSON.stringify(runBefore)})`);

    // A role under way when the engine is killed.
    const held = await roleHolding(fx, project, await addWork(fx.engine, project, 'verification'), { on_term: 'exit' });

    // The restart, with a changed setting (tick_interval 600 → 300).
    await fx.engine.kill();
    writeEngineConfig(fx.home, { api_port: fx.port, ...SANDBOX_CONFIG, ...CONFIG, tick_interval: 300 });
    await fx.start();
    await tick(fx.engine, project);
    await waitFor(() => (domainById(fx.home, held.domain.id)?.status === 'terminated' ? true : undefined), { timeoutMs: 90_000, what: 'the held run\'s domain removed by the restart\'s recovery' });

    const after = await readPace(fx, project);
    const endedShown = (after.domains ?? []).find((d) => d.id === ended.id);
    assert.equal(endedShown?.memory_peak, recordedPeak, `the ended domain's peak is the one recorded before the restart (${JSON.stringify(endedShown)})`);
    const runAfter = (after.runs ?? []).find((r) => r.id === endedRun.id);
    assert.equal(runAfter?.host_observation, runBefore.host_observation, 'its run keeps the host observation of the incarnation it ran in');
    assert.equal(runAfter?.domain?.memory_peak, recordedPeak, 'and its run shows that peak');

    const removed = domainById(fx.home, held.domain.id);
    const removedShown = (after.domains ?? []).find((d) => d.id === held.domain.id);
    assert.ok(removedShown, 'the pace read lists the removed domain');
    if (isUnknown(removedShown.memory_peak)) {
      assert.equal(removed.memory_peak, null, 'unknown in the read, no value in the row');
      assertUnknown(removedShown.memory_peak, '(f) the removed domain\'s peak');
    } else {
      assert.ok(Number.isInteger(removedShown.memory_peak) && removedShown.memory_peak > 0, `a recorded peak is a positive integer, never zero (${JSON.stringify(removedShown)})`);
      assert.equal(removedShown.memory_peak, removed.memory_peak, 'the value the row holds');
      const recorded = domainEvents(fx.home, 'domain.peak_recorded', held.domain.id);
      const terminated = domainEvents(fx.home, 'domain.terminated', held.domain.id);
      assert.equal(recorded.length, 1, 'one domain.peak_recorded for it');
      if (terminated.length > 0) assert.ok(recorded[0].seq < terminated[0].seq, 'read before its cgroup was removed');
    }
  });
});
