// M124, a probe needs its seeded target and its control (M2 slice 12,
// sandbox lane). M2 plan §3.4 M124; D2 §2.8, §6 H9, §7.1, A.3 (D2-I14,
// D2-I14-OBS); AR §8.1, B05; E57; SEAM.md §§138, 139.
//
// The engine's isolation probe suite runs at every start (H9). A probe
// passes only when its target was seeded and verified, its negative was
// attempted and denied, and its control ran: a probe whose target is
// absent, whose control fails, or whose negative was never attempted while
// an unrelated control succeeded is `failed`; one that could not run is
// `not_exercised` and fails qualification unless the host class excuses it
// (SEAM.md §139). Any of these leaves no active host qualification, so a
// real dispatch is refused `isolation_unqualified`, and the engine read
// names the probe. The observer case reports not_exercised on this host.
//
// The overrides are the harness's (`--harness-isolation-probe`, SEAM.md
// §139); everything the probe suite runs is the engine's own, in its own
// probe domain; the tests here start engines and read what they report.
//
// Every case here is expected to fail on the engine these tests were
// written against, which has no probe suite (COVERAGE.md, "M2 slice 12").

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { addGitProject } from './harness/gitruns.mjs';
import { readRun } from './harness/reads.mjs';
import { holdSecret } from './harness/records.mjs';
import { addWork, assertRunEnded, requestTick, waitForRun } from './harness/runs.mjs';
import { checkOf, hostSection, sandboxEngine } from './harness/sandbox/lane.mjs';
import { withStore } from './harness/store.mjs';
import { BACKENDS, PARK_ON_REFUSAL, StandIn, apiKeyRef, eventsNamed, installTrustEntry, useBackend } from './harness/trust.mjs';

const PROBE_IDS = Array.from({ length: 20 }, (_, i) => `P${i + 1}`);
const isWsl2 = () => /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8'));
const override = (probe, how) => ['--harness-isolation-probe', `${probe}=${how}`];
const activeRows = (home) => withStore(home, (db) => db.prepare(`SELECT "id" FROM "host_qualifications" WHERE "status" = 'active'`).all());

// A sandbox-lane engine started with one probe overridden; returns the
// fixture, the host section and the probe as the engine read reports it.
async function startOverridden(t, probe, how) {
  const fx = await sandboxEngine(t, { start: false });
  await fx.start({ args: override(probe, how) });
  const host = hostSection(await fx.engine.engineInfo());
  assert.ok(Array.isArray(host.probes), `the host section lists the probes (keys: ${Object.keys(host).join(', ')})`);
  assert.deepEqual(host.probes.map((p) => p.id), PROBE_IDS, 'P1 to P20, in order');
  const shown = host.probes.find((p) => p.id === probe);
  return { fx, host, shown };
}

// No active row, the host not eligible, H9 blocking and naming the probe.
function assertUnqualifiedBy(fx, host, probe, h9) {
  assert.deepEqual(activeRows(fx.home), [], `no host qualification is active while ${probe} is not passed`);
  assert.deepEqual([host.eligible, host.host_qualification], [false, null], 'the host is not eligible');
  const check = checkOf(host, 'H9');
  assert.equal(check.result, h9, `H9 is ${h9} (observed ${check.observed})`);
  assert.ok(check.observed.includes(probe), `H9's observed value names ${probe} (${check.observed})`);
  assert.ok([...host.failed_checks, ...host.not_exercised_checks].includes('H9'), 'H9 is among the blocking checks');
  assert.match(host.message ?? '', /^isolation unqualified: H9 (failed|not_exercised): /, `the message names H9 (${host.message})`);
  assert.deepEqual(eventsNamed(fx.home, 'host.qualified'), [], 'no host.qualified');
}

// The other probes of the same suite ran: an unrelated control succeeded.
function assertOthersRan(host, probe) {
  const others = host.probes.filter((p) => p.id !== probe && !['P11', 'P20'].includes(p.id));
  for (const p of others) assert.deepEqual([p.result, p.control], ['passed', true], `the suite ran: ${p.id} passed with its control (${JSON.stringify(p)})`);
}

describe('M124 a probe needs its seeded target and its control', () => {
  test("(a) a probe's target absent: that probe failed with target_seeded false; no active host qualification; a real dispatch refused isolation_unqualified; GET /v1/engine names the probe", async (t) => {
    const { fx, host, shown } = await startOverridden(t, 'P1', 'target_absent');
    assert.deepEqual([shown.result, shown.target_seeded], ['failed', false], `P1 failed for want of its target (${JSON.stringify(shown)})`);
    assertUnqualifiedBy(fx, host, 'P1', 'failed');
    assertOthersRan(host, 'P1');

    const standIn = new StandIn(join(fx.root, 'standin'));
    const project = (await addGitProject(fx)).id;
    await holdSecret(fx.engine, apiKeyRef(BACKENDS.claude), 'sk-test-key-for-the-stand-in-0124');
    await useBackend(fx.engine, project, BACKENDS.claude, { roles: ['verifier'], extra: PARK_ON_REFUSAL });
    await installTrustEntry(fx.engine, standIn, { status: 'active' });
    const item = await addWork(fx.engine, project, 'verification');
    await requestTick(fx.engine, project);
    const run = await waitForRun(fx.home, item, { state: 'ended' });
    assertRunEnded(fx.home, run.id, { outcome: 'refused', reason_class: 'preflight_refused', launched: false, recovery: false });
    const read = await readRun(fx.engine, project, run.id);
    assert.equal(read.code, 'isolation_unqualified');
    assert.ok(read.refusal.subject.failed_checks.includes('H9'), `the refusal names H9 (${JSON.stringify(read.refusal.subject)})`);
    assert.equal(standIn.launches().length, 0, 'nothing of the backend ran');
  });

  test("(b) a probe's control failing: that probe failed with control false", async (t) => {
    const { fx, host, shown } = await startOverridden(t, 'P3', 'control_failing');
    assert.deepEqual([shown.result, shown.control, shown.target_seeded], ['failed', false, true], `P3 failed because its control failed (${JSON.stringify(shown)})`);
    assertUnqualifiedBy(fx, host, 'P3', 'failed');
  });

  test('(c) a probe\'s negative never attempted while an unrelated control succeeds: that probe failed, never passed', async (t) => {
    const { fx, host, shown } = await startOverridden(t, 'P6', 'negative_unattempted');
    assert.deepEqual([shown.result, shown.negative], ['failed', 'not_attempted'], `P6 failed: its negative was never attempted (${JSON.stringify(shown)})`);
    assertOthersRan(host, 'P6');
    assertUnqualifiedBy(fx, host, 'P6', 'failed');
  });

  test('(d) a probe that cannot run is not_exercised and fails qualification unless the host class excuses it; on this host neither P5 nor (on WSL2) P11 is excused', async (t) => {
    const { fx, host, shown } = await startOverridden(t, 'P5', 'cannot_run');
    assert.equal(shown.result, 'not_exercised', `P5 is not_exercised, never passed (${JSON.stringify(shown)})`);
    assert.ok(typeof shown.reason === 'string' && shown.reason.length > 0, 'and the engine says why');
    assertUnqualifiedBy(fx, host, 'P5', 'not_exercised');
    await fx.engine.stop();

    if (!isWsl2()) {
      t.diagnostic('[not_exercised] the WSL2 half: off WSL2, P11 is excused by the host class (SEAM.md §139)');
      return;
    }
    const engine = await fx.start({ args: override('P11', 'cannot_run') });
    const again = hostSection(await engine.engineInfo());
    assert.equal(again.probes.find((p) => p.id === 'P11').result, 'not_exercised');
    assert.deepEqual(activeRows(fx.home), [], 'on a WSL2 host P11 is not excused: no active row');
    assert.equal(again.eligible, false);
  });

  test('(e) [not_exercised] lost observation with the observer: H13 is not exercised on this host and no observer evidence exists, so no probe cites any', async (t) => {
    const fx = await sandboxEngine(t);
    const host = hostSection(await fx.engine.engineInfo());
    const h13 = checkOf(host, 'H13');
    assert.equal(h13.result, 'not_exercised', `the observer is not exercised on this host (${h13.observed})`);
    assert.ok(typeof h13.observed === 'string' && h13.observed.length > 0, 'and the engine says why');
    for (const p of host.probes ?? []) assert.equal(p.observer ?? null, null, `${p.id} cites no observer evidence`);
  });
});
