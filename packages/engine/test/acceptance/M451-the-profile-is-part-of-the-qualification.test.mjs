// M451, the profile is part of the qualification (M5 slice 37; KERNEL lane:
// the scripted engine with a stand-in bound to a real backend's name, as
// M101's). M5 plan §3.7 M451 (a), (b), (e); D6-X09; D6 §2.6, §6.4; D2 §4.1,
// §7.2; K2; B09; Q1, Q7 (the driver's approval, 2026-10-13); SEAM.md §§116,
// 150, 443. Its sandbox cases, (c), (d) and (f), which need real canaries,
// a qualified check runner and a real domain, are
// `M451-the-qualified-profile-on-a-real-domain`.
//   (a) a trust entry qualified at `role_memory_max` 8 GiB, the project set
//       to 4 GiB: the entry's identity names the 8 GiB profile (`profile` †,
//       {memory_max, writable_bytes, writable_inodes, tasks_max}); the 4 GiB
//       profile is qualified by no entry;
//   (b) a real dispatch under the unqualified profile is refused
//       `backend_refused` before launch, the refusal naming the profile
//       (`refusal.subject.profile` †); the 8 GiB entry is not revoked (a
//       project's setting revokes nothing) and a project at 8 GiB is
//       dispatched to it;
//   (e) revocation follows D2 §7.2's protocol unchanged: an entry for the
//       4 GiB profile, used by the 4 GiB project, is revoked when its
//       binary's bytes change, and the next dispatch is refused.
//
// SAFETY: the stand-in records and exits; it runs nothing. The provider key
// is a test-made string. No domain, no unit, no signal.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { CONTRACT } from './harness/fixtures.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { changePolicy } from './harness/journal.mjs';
import { readRun } from './harness/reads.mjs';
import { addWork, requestTick, runsOf, waitForRun, waitForWork } from './harness/runs.mjs';
import { BACKENDS, PARK_ON_REFUSAL, installTrustEntry, realBackendProject, trustEntry, trustEvents, useBackend } from './harness/trust.mjs';
import { GIB, entryProfile } from './harness/exec37/peak.mjs';

const POLICY = Object.freeze({ ...PARK_ON_REFUSAL, repair_attempts_max: 0 });
// The profile an entry records, beside its maximum: the engine's volatile
// bounds and task limit as configured (the contract's defaults here).
const profileAt = (memory_max) => ({
  memory_max,
  writable_bytes: CONTRACT.engine.domain_writable_bytes.default,
  writable_inodes: CONTRACT.engine.domain_writable_inodes.default,
  tasks_max: CONTRACT.engine.domain_tasks_max.default,
});

// One verification item of `project` dispatched: its run once ended, and
// whether it reached the stand-in.
async function dispatchOnce(fx, standIn, project) {
  const before = standIn.launches().length;
  const item = await addWork(fx.engine, project, 'verification');
  await requestTick(fx.engine, project);
  const run = await waitForRun(fx.home, item, { state: 'ended', timeoutMs: 60_000 });
  return { item, run, reached: standIn.launches().length > before };
}

async function assertRefusedForProfile(fx, standIn, project, memoryMax, what) {
  const { item, run, reached } = await dispatchOnce(fx, standIn, project);
  assert.equal(reached, false, `${what}: the stand-in was not launched`);
  assert.deepEqual([run.outcome, run.reason_class], ['refused', 'preflight_refused'], `${what}: refused before launch (${run.outcome}/${run.reason_class})`);
  const shown = await readRun(fx.engine, project, run.id);
  assert.equal(shown.code, 'backend_refused', `${what}: backend_refused (${JSON.stringify(shown.refusal ?? null)})`);
  assert.equal(shown.refusal?.subject?.profile?.memory_max, memoryMax, `${what}: the refusal names the unqualified profile's memory maximum (${JSON.stringify(shown.refusal?.subject)})`);
  await waitForWork(fx.home, item, 'parked');
  assert.equal(runsOf(fx.home, item).length, 1, `${what}: one run`);
  return shown;
}

describe('M451 the profile is part of the qualification (kernel lane)', () => {
  test('(a) an entry qualified at role_memory_max 8 GiB names that profile; the 4 GiB profile is unqualified; (b) a dispatch under it is refused backend_refused naming the profile, the entry not revoked, an 8 GiB project dispatched to it', async (t) => {
    const { fx, standIn, project } = await realBackendProject(t, { policy: POLICY });

    // (a)
    const entry = await installTrustEntry(fx.engine, standIn, { status: 'active', role_memory_max: 8 * GIB });
    const row = trustEntry(fx.home, entry.id);
    assert.equal(row.status, 'active', 'the fixture is live: the entry is active');
    assert.deepEqual(entryProfile(row), profileAt(8 * GIB), `(a) the entry's identity names the 8 GiB profile (${JSON.stringify(row.profile)})`);
    await changePolicy(fx.engine, project, { role_memory_max: 4 * GIB });

    // (b)
    await assertRefusedForProfile(fx, standIn, project, 4 * GIB, '(b) the 4 GiB project');
    const still = trustEntry(fx.home, entry.id);
    assert.equal(still.status, 'active', '(b) a project\'s setting revokes nothing: the 8 GiB entry stays active');
    assert.deepEqual(trustEvents(fx.home, entry.id, 'trust.revoked'), [], '(b) no trust.revoked');

    const other = (await addGitProject(fx)).id;
    await useBackend(fx.engine, other, BACKENDS.claude, { roles: ['verifier'], extra: { ...POLICY, role_memory_max: 8 * GIB } });
    const ok = await dispatchOnce(fx, standIn, other);
    assert.equal(ok.reached, true, `(b) a project at 8 GiB is dispatched to the entry that qualified its profile (run: ${JSON.stringify(ok.run)})`);
    const launched = standIn.launches().at(-1);
    assert.ok(launched, 'the stand-in recorded the launch');
  });

  test('(e) revocation follows the existing protocol: an entry for the 4 GiB profile serves the 4 GiB project, then its binary changes: trust.revoked (binary_changed), the next dispatch backend_refused', async (t) => {
    const { fx, standIn, project } = await realBackendProject(t, { policy: { ...POLICY, role_memory_max: 4 * GIB } });
    const entry = await installTrustEntry(fx.engine, standIn, { status: 'active', role_memory_max: 4 * GIB });
    assert.deepEqual(entryProfile(trustEntry(fx.home, entry.id)), profileAt(4 * GIB), `the entry names the 4 GiB profile (${JSON.stringify(trustEntry(fx.home, entry.id).profile)})`);
    const first = await dispatchOnce(fx, standIn, project);
    assert.equal(first.reached, true, `the 4 GiB project is dispatched to the 4 GiB entry (run: ${JSON.stringify(first.run)})`);

    standIn.changeBytes('M451 (e)');
    const { run } = await dispatchOnce(fx, standIn, project);
    assert.deepEqual([run.outcome, run.reason_class], ['refused', 'preflight_refused'], `(e) the next dispatch is refused before launch (${run.outcome}/${run.reason_class})`);
    assert.equal((await readRun(fx.engine, project, run.id)).code, 'backend_refused', '(e) backend_refused');
    const revoked = await waitFor(() => (trustEntry(fx.home, entry.id).status === 'revoked' ? trustEntry(fx.home, entry.id) : undefined), { what: 'the entry to be revoked' });
    assert.equal(revoked.revoked_reason, 'binary_changed', `(e) revoked binary_changed (${revoked.revoked_reason})`);
    assert.equal(trustEvents(fx.home, entry.id, 'trust.revoked').length, 1, '(e) one trust.revoked');
  });
});
