// M133 (e)'s memory admission under option B (M2 slice 14, SANDBOX LANE,
// manifest slice 14). E75 item 3 (Sean): "Admission reserves enough memory
// for every admitted domain to grow to its configured limit while keeping
// the host reserve, and holds additional work when that capacity is
// unavailable", amending E71 item 6; D2 §3.7, A.7 `resource_envelope`;
// SEAM.md §§156, 168.
//
// NOT EXHAUSTING. Nothing here allocates memory: the condition is made by
// configuration only. The test reads the host's `MemAvailable` and chooses
// `domain_memory_max` (M) and `host_reserve_memory` (R) so that one domain's
// reservation fits (M + R well within what is available) and two do not
// (2M + R well beyond it). The first project's role is held running and
// idle; the second project's work must then be held `resource_envelope`
// naming `host_reserve_memory`, with no run, although the first domain uses
// almost none of its M. Under the reading E75 replaces (only the new
// domain's M against the memory available now), the second is admitted.
// The single-run setting stays (`max_concurrent_runs` 1 per project, E18):
// the two domains belong to two projects, with `max_concurrent_domains` 2.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { listWork } from './harness/reads.mjs';
import { addProject, addWork, requestTick, runsOf, stopRun, waitForRunState } from './harness/runs.mjs';
import { roleHolding, sandboxEngine } from './harness/sandbox/lane.mjs';
import { script } from './harness/scripted.mjs';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const memAvailable = () => Number(/^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'))[1]) * 1024;

// M and R from what the host has available now (the contract's ranges:
// R 512 MiB to 64 GiB, M 512 MiB to 64 GiB and above domain_writable_bytes).
function sizes(available) {
  let reserve = 512 * MIB;
  let max = Math.floor((0.7 * (available - reserve)) / MIB) * MIB;
  if (max > 64 * GIB) {
    max = 64 * GIB;
    reserve = Math.ceil((available - 1.4 * max) / MIB) * MIB;
  }
  assert.ok(max >= 512 * MIB && reserve >= 512 * MIB && reserve <= 64 * GIB, `the host's available memory (${available} bytes) allows sizes within the contract's ranges (M ${max}, R ${reserve})`);
  return { max, reserve };
}

async function workRead(fx, project, item) {
  return (await listWork(fx.engine, project)).work_items.find((w) => w.id === item);
}

describe('M133 memory admission reserves every admitted domain\'s configured limit plus the host reserve (option B, E75 item 3; sandbox lane, not exhausting)', () => {
  test('one domain running and idle; a second domain whose limit, with the first\'s and the reserve, exceeds the available memory is held resource_envelope (host_reserve_memory), with no run; admitted once the first ends', async (t) => {
    const before = memAvailable();
    const { max, reserve } = sizes(before);
    const fx = await sandboxEngine(t, { config: { max_concurrent_domains: 2, domain_memory_max: max, host_reserve_memory: reserve, domain_writable_bytes: 64 * MIB } });
    fx.scripted.defaultScript(script.complete());
    const a = (await addProject(fx)).id;
    const b = (await addProject(fx)).id;

    // The first domain: admitted, its role held running and idle.
    const first = await roleHolding(fx, a, await addWork(fx.engine, a, 'verification'), { on_term: 'exit' });
    const available = memAvailable();
    const facts = { MemAvailable_before: before, MemAvailable_now: available, domain_memory_max: max, host_reserve_memory: reserve, one: max + reserve, two: 2 * max + reserve };
    assert.ok(max + reserve <= available, `the fixture is live: one domain's limit plus the reserve fits (${JSON.stringify(facts)})`);
    assert.ok(2 * max + reserve > available, `and two domains' limits plus the reserve do not (${JSON.stringify(facts)})`);

    // The second project's work.
    const held = await addWork(fx.engine, b, 'verification');
    await requestTick(fx.engine, b);
    const seen = await waitFor(
      async () => {
        const w = await workRead(fx, b, held);
        return runsOf(fx.home, held).length > 0 || w?.dispatch_hold ? { w, runs: runsOf(fx.home, held) } : undefined;
      },
      { timeoutMs: 30_000, what: 'the second item to be either held or dispatched' },
    );
    assert.deepEqual(
      [seen.runs.length, seen.w?.status, seen.w?.dispatch_hold?.code, seen.w?.dispatch_hold?.subject?.limit],
      [0, 'eligible', 'resource_envelope', 'host_reserve_memory'],
      `option B (E75 item 3): every admitted domain reserves its configured domain_memory_max, not its current use, plus host_reserve_memory; with one domain admitted, a second (2 x ${max} + ${reserve} = ${2 * max + reserve} bytes > ${available} available) is held resource_envelope naming host_reserve_memory and gets no run (${JSON.stringify({ runs: seen.runs.map((r) => r.id), work: seen.w })})`,
    );

    // Control: once the first domain has ended, the second is admitted.
    await stopRun(fx.engine, a, first.run.id);
    await waitForRunState(fx.home, first.run.id, 'ended', { timeoutMs: 60_000 });
    await requestTick(fx.engine, b);
    await waitFor(() => runsOf(fx.home, held).length > 0 || undefined, { timeoutMs: 60_000, what: 'the second item to be dispatched once the first domain has ended' });
  });
});
