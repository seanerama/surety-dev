// M439, the memory peak recorded (M5 slice 37; SANDBOX lane: real role and
// check domains on D2's launcher and init, the scripted role program and the
// test's check program, no model). M5 plan §3.7 M439; D6-X08; D6 §6.4, §7.6,
// A.2 (`domain.peak_recorded`), A.3 (`execution_domains.memory_peak`,
// `memory_max`); K2; N01; SEAM.md §432
//   (a) a role domain (a stage's Builder) and a check domain at termination:
//       `memory_peak` and `memory_max` on `execution_domains`, the peak read
//       before the cgroup is removed and bound to the domain's identity and
//       observation time (`domain.peak_recorded`), at least what the host read
//       of the cgroup while it ran;
//   (b) the pace read shows them per run (`runs[].domain`), per domain, and
//       the host block's peak number of domains at once;
//   (c) a peak that could not be read, and a memory.peak read only after the
//       cgroup's removal (the one-shot `domain_peak` fault †): `unknown`,
//       never zero and never a value read late; a domain after them, with no
//       fault, records its peak;
//   (d) two role domains ending together: each its own value, never the
//       other's, made distinct by the bounded `hold_bytes` step †.
//
// SAFETY (BS5 §4.1 rules 8 and 10; E64): nothing here exhausts anything.
// `domain_memory_max` is the contract's minimum, so every domain is admitted
// at 512 MiB (Q1: the per-profile defaults capped by the ceiling). The
// `hold_bytes` step allocates 4 MiB and 24 MiB once, far below the 512 MiB
// memory.max, which the test reads from the host before it releases a role
// into that step; the step itself refuses above 32 MiB or where the
// domain's memory.max is under eight times the amount. The check program
// holds at a release file and exits 0. No unit, no signal by the test.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { CONTRACT } from './harness/fixtures.mjs';
import { pinStep } from './harness/gitruns.mjs';
import { readPace } from './harness/journey/drive.mjs';
import { addProject, addWork, runsOfProject, tick, waitForRun, waitForRunState } from './harness/runs.mjs';
import { waitCgroupGone } from './harness/sandbox/cgroup.mjs';
import { domainOf, sandboxEngine } from './harness/sandbox/lane.mjs';
import { script, step } from './harness/scripted.mjs';
import {
  GOVERNED_FILE,
  buildStage,
  checkProject,
  defPath,
  heldExecution,
  holdArgs,
  installCheckProgram,
  qualifyRunnerByFixture,
  release,
  sandboxGoverned,
  smoke,
  waitRecorded,
} from './harness/checks/fixtures.mjs';
import { MIB, armPeakFault, assertPeakRecorded, assertUnknown, domainById, domainEvents, hostMemoryMax, hostMemoryPeak } from './harness/exec37/peak.mjs';

// Every domain at 512 MiB: the ceiling at the contract's minimum caps the
// per-profile defaults (role 4 GiB, check 2 GiB; Q1), so two fit beside the
// reserve on this host.
const CEILING = CONTRACT.engine.domain_memory_max.min;
const CONFIG = Object.freeze({ domain_memory_max: CEILING, max_concurrent_domains: 2 });

const domainsOfProject = (fx, project) => runsOfProject(fx.home, project).map((r) => ({ run: r, domain: domainOf(fx.home, r.id) }));

// A role that completes at once in its domain; returns its run and domain once both are ended.
async function oneRoleRun(fx, project) {
  const item = await addWork(fx.engine, project, 'verification');
  fx.scripted.script(item, [script.complete()]);
  await tick(fx.engine, project);
  const run = await waitForRun(fx.home, item, { state: 'ended', timeoutMs: 60_000 });
  const domain = domainOf(fx.home, run.id);
  assert.ok(domain?.cgroup_path, `the run had a real domain (${JSON.stringify(domain)})`);
  await waitFor(() => (domainById(fx.home, domain.id)?.status === 'terminated' ? true : undefined), { timeoutMs: 60_000, what: `domain ${domain.id} to be terminated` });
  return { run, domain: domainById(fx.home, domain.id) };
}

describe('M439 the memory peak recorded', () => {
  test('(a) a role domain and a check domain at termination record memory_peak and memory_max, read before removal, with domain.peak_recorded; (b) the pace read shows them per run, per domain and the peak domains at once', async (t) => {
    const fx = await sandboxEngine(t, { config: CONFIG });
    const prog = installCheckProgram(fx.root);
    await qualifyRunnerByFixture(fx.engine);
    const files = { [GOVERNED_FILE]: sandboxGoverned(prog), [defPath('peak')]: smoke('peak', { command: ['probe', ...holdArgs(prog, 'peak'), 'exit', '0'], gates: ['stage'], timeout: 300 }) };
    const project = await pinStep(fx, await checkProject(fx, { files }));

    // The role domain: the stage's Builder.
    const { candidate } = await buildStage(fx, project);
    const builder = runsOfProject(fx.home, project.id).find((r) => r.role === 'builder' && r.state === 'ended');
    assert.ok(builder, 'the Builder ran and ended');
    const roleDomain = domainOf(fx.home, builder.id);
    assert.ok(roleDomain?.cgroup_path, 'the Builder ran in a real domain');
    await waitCgroupGone(roleDomain.cgroup_path, { timeoutMs: 60_000 });

    // The check domain, held while the host reads its cgroup, then released.
    const held = await heldExecution(fx, project.id, candidate.id, { peak: 'peak' });
    const checkCg = held.domain.cgroup_path;
    assert.equal(hostMemoryMax(checkCg), String(CEILING), 'host-read: the check domain runs at the 512 MiB maximum');
    const seenWhileRunning = hostMemoryPeak(checkCg);
    assert.ok(Number.isSafeInteger(seenWhileRunning) && seenWhileRunning > 0, `host-read: the check domain's memory.peak while it runs (${seenWhileRunning})`);
    release(prog, 'peak');
    await waitRecorded(fx, project.id, candidate.id, ['peak']);
    await waitCgroupGone(checkCg, { timeoutMs: 60_000 });
    await waitFor(() => (domainById(fx.home, held.domain.id)?.status === 'terminated' ? true : undefined), { timeoutMs: 60_000, what: 'the check domain to be terminated' });

    // (a)
    const role = assertPeakRecorded(fx.home, roleDomain.id, { memoryMax: CEILING, what: "(a) the Builder's role domain" });
    const check = assertPeakRecorded(fx.home, held.domain.id, { memoryMax: CEILING, atLeast: seenWhileRunning, what: '(a) the check domain' });

    // (b)
    const pace = await readPace(fx, project.id);
    const run = (pace.runs ?? []).find((r) => r.id === builder.id);
    assert.ok(run, `(b) the pace read lists the Builder's run (${JSON.stringify(pace.runs?.map((r) => r.id))})`);
    assert.deepEqual(run.domain, { id: roleDomain.id, memory_peak: role.memory_peak, memory_max: CEILING }, `(b) the run shows its domain's peak and maximum as recorded (${JSON.stringify(run.domain)})`);
    for (const [d, row, what] of [
      [roleDomain.id, role, 'role'],
      [held.domain.id, check, 'check'],
    ]) {
      const shown = (pace.domains ?? []).find((x) => x.id === d);
      assert.ok(shown, `(b) the pace read lists the ${what} domain`);
      assert.deepEqual([shown.memory_peak, shown.memory_max], [row.memory_peak, row.memory_max], `(b) the ${what} domain's peak and maximum as recorded (${JSON.stringify(shown)})`);
    }
    assert.ok(Number.isSafeInteger(pace.host?.peak_domains) && pace.host.peak_domains >= 1, `(b) the host block names the peak number of domains running at once (${JSON.stringify(pace.host?.peak_domains)})`);
  });

  test('(c) a peak that could not be read, and a memory.peak read after the cgroup was removed: unknown, never zero, never a late value; the next domain, with no fault, records its peak', async (t) => {
    const fx = await sandboxEngine(t, { config: CONFIG });
    const project = (await addProject(fx)).id;
    const cases = [];
    for (const mode of ['unreadable', 'after_removal']) {
      await armPeakFault(fx.engine, project, mode);
      cases.push({ mode, ...(await oneRoleRun(fx, project)) });
    }
    const control = await oneRoleRun(fx, project);

    for (const { mode, domain } of cases) {
      assert.equal(domain.memory_peak, null, `(c) ${mode}: no peak is recorded as a value: memory_peak is null, never 0 or a value read late (${JSON.stringify(domain.memory_peak)})`);
      assert.equal(domain.memory_max, CEILING, `(c) ${mode}: the maximum it was admitted at is still recorded`);
      const events = domainEvents(fx.home, 'domain.peak_recorded', domain.id);
      assert.equal(events.length, 1, `(c) ${mode}: one domain.peak_recorded for the domain (${events.length})`);
      assertUnknown(events[0].payload?.memory_peak, `(c) ${mode}: the event's memory_peak`);
    }
    const pace = await readPace(fx, project);
    for (const { mode, domain } of cases) {
      const shown = (pace.domains ?? []).find((x) => x.id === domain.id);
      assert.ok(shown, `(c) ${mode}: the pace read lists the domain`);
      assertUnknown(shown.memory_peak, `(c) ${mode}: the pace read's peak`);
      const run = (pace.runs ?? []).find((r) => r.domain?.id === domain.id);
      assert.ok(run, `(c) ${mode}: the pace read shows the run with its domain`);
      assertUnknown(run.domain.memory_peak, `(c) ${mode}: the run's peak in the pace read`);
    }
    // The fault was one-shot: the next domain's peak is recorded.
    assertPeakRecorded(fx.home, control.domain.id, { memoryMax: CEILING, what: '(c) the control domain after the two faults' });
  });

  test('(d) two role domains ending together: each records its own peak, never the other\'s', async (t) => {
    const fx = await sandboxEngine(t, { config: CONFIG });
    // Two projects, so that the two roles run at once on any build (one run
    // per project as built before K2, one per work item after it).
    const sizes = [4 * MIB, 24 * MIB];
    const roles = [];
    for (const bytes of sizes) {
      const project = (await addProject(fx)).id;
      const item = await addWork(fx.engine, project, 'verification');
      fx.scripted.script(item, [{ steps: [step.hold('gate'), step.holdBytes(bytes, CEILING), step.hold('gate2'), step.result()], on_term: 'exit' }]);
      roles.push({ project, item, bytes });
    }
    await tick(fx.engine, roles.map((r) => r.project));
    for (const r of roles) {
      r.launch = await fx.scripted.waitForHolding({ work_item: r.item }, 'gate', { timeoutMs: 60_000 });
      r.run = await waitForRun(fx.home, r.item, { state: 'executing' });
      r.domain = domainOf(fx.home, r.run.id);
      assert.ok(r.domain?.cgroup_path, 'the role runs in a real domain');
      // The test's half before the release (E64): the domain carries this
      // home's scope and its memory.max is the value the step is given.
      assert.ok(r.domain.cgroup_path.includes(r.domain.id), `host-read: the cgroup is the domain's own (${r.domain.cgroup_path})`);
      assert.equal(hostMemoryMax(r.domain.cgroup_path), String(CEILING), `host-read: the domain's memory.max is ${CEILING} before the role is released into hold_bytes`);
    }
    for (const r of roles) fx.scripted.release(r.launch.invocation, 'gate');
    for (const r of roles) {
      await fx.scripted.waitForHolding({ work_item: r.item }, 'gate2', { timeoutMs: 60_000 });
      const logged = fx.scripted.eventsOfInvocation(r.launch.invocation, 'hold_bytes');
      assert.deepEqual(logged.map((e) => [e.outcome, e.bytes]), [['holding', r.bytes]], `the role holds ${r.bytes} bytes (${JSON.stringify(logged)})`);
      r.hostPeak = hostMemoryPeak(r.domain.cgroup_path);
    }
    const [small, large] = roles;
    assert.ok(Number.isSafeInteger(small.hostPeak) && Number.isSafeInteger(large.hostPeak) && large.hostPeak - small.hostPeak >= 12 * MIB, `the fixture is live: host-read peaks differ by at least 12 MiB (${small.hostPeak}, ${large.hostPeak})`);

    // Released together.
    fx.scripted.release('all', 'gate2');
    for (const r of roles) {
      await waitForRunState(fx.home, r.run.id, 'ended', { timeoutMs: 60_000 });
      await waitCgroupGone(r.domain.cgroup_path, { timeoutMs: 60_000 });
      await waitFor(() => (domainById(fx.home, r.domain.id)?.status === 'terminated' ? true : undefined), { timeoutMs: 60_000, what: `domain ${r.domain.id} to be terminated` });
    }
    const a = assertPeakRecorded(fx.home, small.domain.id, { memoryMax: CEILING, atLeast: small.hostPeak, what: '(d) the 4 MiB role' });
    const b = assertPeakRecorded(fx.home, large.domain.id, { memoryMax: CEILING, atLeast: large.hostPeak, what: '(d) the 24 MiB role' });
    assert.ok(a.memory_peak < large.hostPeak, `(d) the smaller role's recorded peak (${a.memory_peak}) is its own, below what the host read of the other (${large.hostPeak})`);
    assert.notEqual(a.memory_peak, b.memory_peak, '(d) two values, never one copied to the other');

    const pace = await readPace(fx, large.project);
    assert.ok(Number.isSafeInteger(pace.host?.peak_domains) && pace.host.peak_domains >= 2, `(d) the host block's peak number of domains at once counts the two (${JSON.stringify(pace.host?.peak_domains)})`);
  });
});
