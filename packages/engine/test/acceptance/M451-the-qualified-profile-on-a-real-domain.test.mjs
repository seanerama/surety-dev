// M451, the profile is part of the qualification, on the real boundary (M5
// slice 37; SANDBOX lane: real domains, the stand-in, the scripted role
// program, the test's check program, no model). M5 plan §3.7 M451 (c), (d),
// (f); D6-X09; D6 §2.6, §6.4; D2 §4.1, §7.2; D3 §2.4 (the runner's
// qualification); K2; B09; Q1, Q7 (the driver's approval, 2026-10-13);
// SEAM.md §§148, 149, 181, 392, 443 Its kernel cases are
// `M451-the-profile-is-part-of-the-qualification`.
//   (c) a qualification attempt for the 768 MiB role profile (`role_memory_max`
//       on `POST /v1/trust/qualify` †) runs its canaries, the continuation
//       canary included, in domains admitted at 768 MiB; the attempt records
//       the profile (`profile` †) and the entry it writes is that profile's,
//       `session_qualified` from the passing canary;
//   (d) a project's `check_memory_max` changed to 640 MiB: the runner, qualified
//       for the default check profile, has not qualified that one, so an
//       execution under it stays queued, held `runner_unqualified` naming the
//       profile †, no domain; once the runner's qualification covers it (the
//       fixture's `check_memory_max` †) it runs in a domain at 640 MiB;
//   (f) the qualified profile's `memory.max` and writable-storage bound on a
//       real domain: a dispatch to the entry qualified at 768 MiB runs in a
//       domain whose memory.max, volatile filesystem size and inodes and
//       pids.max are the entry's recorded profile.
//
// SAFETY (BS5 §4.1; E64): the ceiling is 1 GiB and the profiles 768 MiB and
// 640 MiB, set through configuration; nothing allocates toward a limit. The
// containment canary's guarded actions are released only after the host
// reads its role contained (armedCanary). The stand-in records, holds at a
// file and exits. The provider key is a test-made string.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { addGitProject, pinStep } from './harness/gitruns.mjs';
import { changePolicy } from './harness/journal.mjs';
import { holdSecret } from './harness/records.mjs';
import { addWork, requestTick, tick, waitForRun } from './harness/runs.mjs';
import { procsOf } from './harness/sandbox/cgroup.mjs';
import { volatileBoundsOf } from './harness/sandbox/limits.mjs';
import { approveAttempt, armedCanary, attemptFixture, attemptOf, canaryRuns, obeyingCanaries, qualify, scriptedBody, waitAttempt } from './harness/sandbox/qualify.mjs';
import { domainOf, sandboxEngine } from './harness/sandbox/lane.mjs';
import { step } from './harness/scripted.mjs';
import { BACKENDS, PARK_ON_REFUSAL, StandIn, apiKeyRef, installTrustEntry, trustEntries, trustEntry, useBackend } from './harness/trust.mjs';
import {
  GOVERNED_FILE,
  buildStage,
  checkProject,
  defPath,
  executionRow,
  installCheckProgram,
  listExecutions,
  qualifyRunnerByFixture,
  requestChecks,
  resultRow,
  sandboxGoverned,
  smoke,
  waitRecorded,
} from './harness/checks/fixtures.mjs';
import { GIB, MIB, domainById, entryProfile, hostMemoryMax } from './harness/exec37/peak.mjs';

// The ceiling at 1 GiB, so the per-profile defaults are capped there (Q1)
// and the cases' 768 MiB and 640 MiB are within range; small volatile bounds.
const CONFIG = Object.freeze({ domain_memory_max: GIB, domain_writable_bytes: 64 * MIB, max_concurrent_domains: 2 });
const ROLE = 768 * MIB;
const CHECK = 640 * MIB;
const KEY = `sk-test-key-for-the-stand-in-${randomBytes(6).toString('hex')}`;
const times = (one) => Array.from({ length: 8 }, () => one);

describe('M451 the profile is part of the qualification (sandbox lane)', () => {
  test('(c) an attempt for the 768 MiB role profile runs its canaries in domains at 768 MiB, records the profile, and writes that profile\'s entry, session_qualified from the continuation canary', async (t) => {
    const { fx, standIn, fixtureProject } = await attemptFixture(t, { config: CONFIG });
    obeyingCanaries(fx);
    fx.scripted.canaryScript('continuation', times({ steps: [step.canary('obey')] }));
    const attempt = await qualify(fx, scriptedBody(standIn, fixtureProject, { mode: 'session_headless', role_memory_max: ROLE }));
    assert.equal(attemptOf(fx.home, attempt.id).profile && JSON.parse(attemptOf(fx.home, attempt.id).profile).memory_max, ROLE, `(c) the attempt records the profile it qualifies (${attemptOf(fx.home, attempt.id).profile})`);
    await approveAttempt(fx, fixtureProject, attempt.id);
    await armedCanary(fx, 'containment');
    const done = await waitAttempt(fx.home, attempt.id, ['succeeded', 'failed', 'invalidated']);
    assert.equal(done.status, 'succeeded', `(c) the canaries pass (${JSON.stringify(done.canaries)})`);

    const runs = canaryRuns(fx.home, attempt.id);
    assert.ok(runs.length >= 4, `(c) the four canaries ran, the continuation canary included (${runs.length})`);
    const domains = withDomains(fx, runs);
    assert.ok(domains.length >= 4 && domains.every((d) => d.memory_max === ROLE), `(c) every canary's domain was admitted at the attempt's profile, 768 MiB (${JSON.stringify(domains.map((d) => d.memory_max))})`);

    const entry = trustEntries(fx.home).find((e) => e.qualification_attempt === attempt.id);
    assert.ok(entry, '(c) the attempt wrote an entry');
    assert.equal(entryProfile(entry)?.memory_max, ROLE, `(c) the entry's identity is the 768 MiB profile (${JSON.stringify(entry.profile)})`);
    assert.equal(Boolean(entry.session_qualified), true, '(c) session_qualified, recorded against that profile, from the passing continuation canary');
  });

  test('(d) a check_memory_max change: an execution under the unqualified check profile is held runner_unqualified naming it, with no domain; once the runner qualifies it, it runs at 640 MiB', async (t) => {
    const fx = await sandboxEngine(t, { config: CONFIG });
    const prog = installCheckProgram(fx.root);
    await qualifyRunnerByFixture(fx.engine);
    const files = { [GOVERNED_FILE]: sandboxGoverned(prog), [defPath('quick')]: smoke('quick', { command: ['probe', 'exit', '0'], gates: ['stage'], timeout: 120 }) };
    const project = await pinStep(fx, await checkProject(fx, { files }));
    const { candidate } = await buildStage(fx, project);
    await waitRecorded(fx, project.id, candidate.id, ['quick'], { what: 'the check to run under the qualified default check profile' });

    await changePolicy(fx.engine, project.id, { check_memory_max: CHECK });
    const asked = await requestChecks(fx.engine, project.id, candidate.id, { keys: ['quick'] });
    assert.equal(asked.status, 202, `an operator requests the check again (body: ${asked.text})`);
    const id = asked.body.executions[0].id;
    const entry = await waitFor(
      async () => {
        await tick(fx.engine, project.id, { rounds: 1 });
        const e = (await listExecutions(fx.engine, project.id, candidate.id)).find((x) => x.id === id);
        return e?.hold ? e : undefined;
      },
      { timeoutMs: 30_000, what: 'the execution to show its hold' },
    );
    assert.deepEqual([entry.status, entry.hold?.code, entry.hold?.subject?.profile?.memory_max], ['queued', 'runner_unqualified', CHECK], `(d) queued, held runner_unqualified naming the 640 MiB check profile (${JSON.stringify(entry)})`);
    assert.equal(executionRow(fx.home, id).domain, null, '(d) no domain was allocated for it');

    const res = await fx.engine.post('/v1/harness/fixtures/runner-qualification', { runner_class: 'direct', check_memory_max: CHECK });
    assert.equal(res.status, 201, `the runner qualification fixture covers the 640 MiB check profile (body: ${res.text})`);
    await waitFor(
      async () => {
        await tick(fx.engine, project.id, { rounds: 1 });
        return executionRow(fx.home, id).status === 'recorded' ? true : undefined;
      },
      { timeoutMs: 60_000, what: 'the held execution to run once its profile is qualified' },
    );
    const x = executionRow(fx.home, id);
    const r = resultRow(fx.home, x.result);
    assert.deepEqual([r.execution_established, r.exit_status], [1, 0], '(d) it ran and passed');
    assert.equal(domainById(fx.home, x.domain)?.memory_max, CHECK, '(d) in a domain admitted at the project\'s check_memory_max');
  });

  test('(f) a dispatch to the entry qualified at 768 MiB runs in a domain whose memory.max, volatile filesystem and pids.max are the entry\'s recorded profile', async (t) => {
    const fx = await sandboxEngine(t, { config: CONFIG });
    const standIn = new StandIn(join(fx.root, 'standin'), { logDir: fx.scripted.dir });
    const project = (await addGitProject(fx)).id;
    await useBackend(fx.engine, project, BACKENDS.claude, { roles: ['verifier'], extra: { ...PARK_ON_REFUSAL, repair_attempts_max: 0, role_memory_max: ROLE } });
    await holdSecret(fx.engine, apiKeyRef(BACKENDS.claude), KEY);
    const installed = await installTrustEntry(fx.engine, standIn, { status: 'active', role_memory_max: ROLE });
    const profile = entryProfile(trustEntry(fx.home, installed.id));
    assert.deepEqual(profile, { memory_max: ROLE, writable_bytes: CONFIG.domain_writable_bytes, writable_inodes: profile?.writable_inodes, tasks_max: profile?.tasks_max }, `(f) the entry records the 768 MiB profile with the engine's volatile bound (${JSON.stringify(profile)})`);
    assert.ok(Number.isSafeInteger(profile.writable_inodes) && Number.isSafeInteger(profile.tasks_max), '(f) and its inode and task bounds');

    standIn.hold();
    const item = await addWork(fx.engine, project, 'verification');
    await requestTick(fx.engine, project);
    await standIn.waitForLaunch({}, { timeoutMs: 60_000 });
    const run = await waitForRun(fx.home, item, { state: 'executing' });
    const domain = domainOf(fx.home, run.id);
    assert.ok(domain?.cgroup_path, 'the dispatch runs in a real domain');
    assert.equal(hostMemoryMax(domain.cgroup_path), String(profile.memory_max), '(f) host-read: memory.max is the qualified profile\'s');
    assert.equal(readFileSync(join(domain.cgroup_path, 'pids.max'), 'utf8').trim(), String(profile.tasks_max), '(f) host-read: pids.max is the qualified profile\'s');
    const pid = procsOf(domain.cgroup_path).find((p) => {
      try {
        return readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0').some((a) => a === standIn.path);
      } catch {
        return false;
      }
    });
    assert.ok(pid, `the stand-in's process is a member of the domain (${procsOf(domain.cgroup_path).join(', ')})`);
    const vol = volatileBoundsOf(pid);
    assert.deepEqual([vol.fstype, vol.bytes, vol.inodes], ['tmpfs', profile.writable_bytes, profile.writable_inodes], `(f) host-read from its mount table: the volatile filesystem is the qualified profile's (${JSON.stringify(vol)})`);
    standIn.release();
    await waitForRun(fx.home, item, { state: 'ended', timeoutMs: 60_000 });
  });
});

function withDomains(fx, runs) {
  return runs.flatMap((r) => {
    const d = domainOf(fx.home, r.run);
    return d ? [d] : [];
  });
}
