// M133, resource limits, each alone and under aggregate pressure; and P20
// at start (M2 slice 13 part 3; EXHAUSTION LANE ONLY). M2 plan §3.6 M133;
// D2 §3.7, §6 H11, H12, A.6 P20, A.7; AR B09, P20; E58 item 1; E64 item 2;
// E69; SEAM.md §§138, 141, 155.
//
// NEVER RUN ON THE DEVELOPMENT WORKSTATION. This file is listed under the
// manifest's `exhaust` key; `node scripts/run-tests.mjs acceptance --lane
// exhaust` runs it only where SURETY_EXHAUSTION_HOST equals the host's name
// (mini-hp01, E69 item 2). Do not run it with `node --test` by hand anywhere
// else.
//
// Each limit, in a domain capped at Sean's values (E69 item 1: pids.max 64,
// memory.max 64 MiB, 1 MiB and 64 inodes of volatile storage, set through
// the trigger fixture's harness-only `domain_limits`), stops a role that
// tries to exceed it, with the role's control first and the host
// unaffected: a fork fails and pids_max is recorded; an allocation is
// OOM-killed; a write stops near the bound; a creation fails at the inode
// limit. Admission holds work by configuration (max_concurrent_domains 1,
// host_reserve_memory and host_reserve_disk above what is free), never by
// consuming the host. Two domains at their limits leave a third dispatch
// held while a Stop, a refusal, the ledger and /v1/health go on. A line or
// a queue of output over its bound cancels the run. A host where H11 fails
// refuses real dispatch. A start with isolation_probe_exhaustion true runs
// P20 and passes it with every box's limits read back.
//
// SAFETY, two halves and self-bounds (E64 item 2, E69; SEAM.md §155): every
// instrument is a guarded action the role program refuses unless it is in
// namespaces of its own, sees at most 16 processes, pid 1 is no system
// init, its caps are at or below Sean's and the volatile filesystem it can
// read is no larger than the case's; the test releases it only after
// reading from the host the role contained and the domain's pids.max,
// memory.max, memory.swap.max 0 and volatile bounds exactly the case's
// (limitedRole). Each loop stops itself: at most 96 `sleep` forks, 128 MiB
// allocated, twice the storage bound written, 128 files, 4 MiB of output.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { armFault, waitFor } from './harness/engine.mjs';
import { CONTRACT } from './harness/fixtures.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { getLedger } from './harness/ledger.mjs';
import { listWork } from './harness/reads.mjs';
import { holdSecret, recordFile, recordRow } from './harness/records.mjs';
import { addProject, assertRunEnded, requestTick, runsOf, stopRun, waitForRunState } from './harness/runs.mjs';
import { counterOf, pidsCurrent } from './harness/sandbox/cgroup.mjs';
import { checkOf, domainRow, hostSection, receiptOf, roleHolding, sandboxEngine, terminalObservation } from './harness/sandbox/lane.mjs';
import { CAPS, addLimitedWork, limitedRole } from './harness/sandbox/limits.mjs';
import { refusedBeforeLaunch } from './harness/sandbox/view.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { BACKENDS, PARK_ON_REFUSAL, StandIn, apiKeyRef, installTrustEntry, useBackend } from './harness/trust.mjs';
import { assertRefused } from './harness/fixtures.mjs';

const MIB = 1024 * 1024;
const LATENCY = CONTRACT.engine.api_latency_bound.default;
// Memory admission (option B; E75 item 3; SEAM.md §168) reserves the
// configured domain_memory_max for every admitted domain, beside
// host_reserve_memory: at the defaults (8 GiB, 2 GiB) one domain needs
// 10 GiB available and (f)'s two need 18. The cases mean their own limits,
// so they configure domain_memory_max at the contract's minimum (512 MiB,
// above the harness cap of 64 MiB the domains run under): one domain then
// needs 2.5 GiB available, two 3 GiB, which mini-hp01 (16 GB) has (E85
// item 8). host_reserve_memory keeps its default. The engine's admission is
// unchanged; what each case holds or admits is what it names.
const ADMIT = Object.freeze({ domain_memory_max: CONTRACT.engine.domain_memory_max.min });
assert.ok(ADMIT.domain_memory_max >= CAPS.memory_max, 'the configured domain_memory_max is at least the harness cap');

// The role's probe entries of one action, in order.
const entries = (fx, armed, action) => fx.scripted.eventsOfInvocation(armed.launch.invocation, 'probe').filter((e) => e.action === action);
const at = (fx, armed, action, stepName) => entries(fx, armed, action).find((e) => e.step === stepName);
const waitStep = (fx, armed, action, stepName, timeoutMs = 60_000) => waitFor(() => at(fx, armed, action, stepName), { timeoutMs, what: `the role's ${action} to log ${stepName}` });
const terminalOf = (fx, runId) => terminalObservation(fx.home, receiptOf(fx.home, runId).id);

async function workRead(fx, project, item) {
  const work = await listWork(fx.engine, project);
  return work.work_items.find((w) => w.id === item);
}

describe('M133 resource limits, each alone and under aggregate pressure', () => {
  test('(a) pids.max 64: the fork fails, pids_max recorded, the host unaffected; control: one fork', async (t) => {
    const fx = await sandboxEngine(t);
    const sentinel = spawn('sleep', ['600'], { stdio: 'ignore' });
    t.after(() => sentinel.kill('SIGKILL'));
    const project = (await addProject(fx)).id;
    const item = await addLimitedWork(fx, project);
    const armed = await limitedRole(fx, project, item, CAPS, { acts: (act) => [act.forkToLimit(CAPS, { hold_ms: 5000 })] });
    fx.scripted.release(item, 'armed');
    const atLimit = await waitStep(fx, armed, 'fork_to_limit', 'at_limit');
    // While the role's children hold the domain at its limit: the host.
    const hostFork = spawnSync('true');
    const maxEvents = counterOf(armed.domain.cgroup_path, 'pids.events', 'max');
    const current = pidsCurrent(armed.domain.cgroup_path);
    assert.equal(atLimit.control, 'spawned', 'control: one fork succeeded first');
    assert.ok(typeof atLimit.failure === 'string' && atLimit.forks < atLimit.ceiling, `the fork failed at the limit, short of the role's own ceiling (${JSON.stringify(atLimit)})`);
    assert.ok(maxEvents >= 1, `host-read: pids.events max rose (${maxEvents})`);
    assert.ok(current <= CAPS.pids_max, `host-read: pids.current ${current} within pids.max`);
    assert.equal(hostFork.status, 0, 'the host forks as before: unaffected');
    assert.equal(sentinel.exitCode, null, 'a host process outside every domain is untouched');
    const ended = await waitForRunState(fx.home, armed.run.id, 'ended', { timeoutMs: 90_000 });
    assert.deepEqual([ended.outcome, ended.reason_class], ['completed', 'none'], `a limit the role survived fails nothing (${ended.reason_text})`);
    assert.ok(terminalOf(fx, armed.run.id).exit_evidence.resource_events.pids_max >= 1, 'pids_max recorded in exit_evidence');
    assert.ok(domainRow(fx.home, armed.domain.id).resource_events?.pids_max >= 1, 'and on the domain');
  });

  test('(b) memory.max 64 MiB: the allocation is OOM-killed (as M130 (f)); control: a 1 MiB allocation', async (t) => {
    const fx = await sandboxEngine(t);
    const project = (await addProject(fx)).id;
    const item = await addLimitedWork(fx, project);
    const armed = await limitedRole(fx, project, item, CAPS, { acts: (act) => [act.allocateToLimit(CAPS)], result: false });
    const ended = await armed.release();
    assert.ok(at(fx, armed, 'allocate_to_limit', 'control'), 'control: the role allocated 1 MiB first');
    assert.equal(at(fx, armed, 'allocate_to_limit', 'done'), undefined, 'the role never reached its own ceiling of 128 MiB: the kernel ended it');
    const progress = entries(fx, armed, 'allocate_to_limit').filter((e) => e.step === 'progress').map((e) => e.allocated);
    assert.ok(progress.every((a) => a <= CAPS.memory_max), `nothing logged past memory.max (${progress.at(-1)})`);
    assertRunEnded(fx.home, armed.run.id, { outcome: 'failed', reason_class: 'infra_error', launched: true, recovery: false });
    const terminal = terminalOf(fx, armed.run.id);
    assert.equal(terminal.exit_class, 'resource_limit', `exit class (${JSON.stringify(terminal)})`);
    assert.ok(terminal.exit_evidence.resource_events.oom_kill >= 1, 'oom_kill recorded');
    assert.match(ended.reason_text ?? '', /resource_limit/, 'the run names the class');
  });

  test('(c) domain_writable_bytes 1 MiB: the write stops near the bound; control: 4 KiB', async (t) => {
    const fx = await sandboxEngine(t);
    const project = (await addProject(fx)).id;
    const item = await addLimitedWork(fx, project);
    const armed = await limitedRole(fx, project, item, CAPS, { acts: (act) => [act.writeToLimit(CAPS)] });
    const ended = await armed.release();
    const r = at(fx, armed, 'write_to_limit', 'at_limit');
    assert.equal(r?.control, 'written', `control: 4 KiB written first (${JSON.stringify(r)})`);
    assert.equal(r.stop, 'ENOSPC', 'the write stopped for want of space');
    assert.ok(r.written <= CAPS.writable_bytes + 64 * 1024 && r.written < r.ceiling, `near the bound: ${r.written} bytes of a ${CAPS.writable_bytes}-byte volatile filesystem`);
    assert.deepEqual([ended.outcome, ended.reason_class], ['completed', 'none'], `the role, its fill removed, finishes (${ended.reason_text})`);
  });

  test('(d) domain_writable_inodes 64: creation fails at the limit; control: one file', async (t) => {
    const fx = await sandboxEngine(t);
    const project = (await addProject(fx)).id;
    const item = await addLimitedWork(fx, project);
    const armed = await limitedRole(fx, project, item, CAPS, { acts: (act) => [act.createToLimit(CAPS)] });
    const ended = await armed.release();
    const r = at(fx, armed, 'create_to_limit', 'at_limit');
    assert.equal(r?.control, 'created', `control: one file created first (${JSON.stringify(r)})`);
    assert.equal(r.stop, 'ENOSPC', 'creation stopped for want of inodes');
    assert.ok(r.made < CAPS.writable_inodes, `at the limit: ${r.made} files on a ${CAPS.writable_inodes}-inode volatile filesystem`);
    assert.deepEqual([ended.outcome, ended.reason_class], ['completed', 'none'], `the role, its files removed, finishes (${ended.reason_text})`);
  });

  test('(e) admission, by configuration only: max_concurrent_domains 1 with two projects; host_reserve_memory above the free memory; host_reserve_disk above the free space: the work held as resource_envelope, nothing admitted beyond the reserve', async (t) => {
    // max_concurrent_domains 1.
    {
      const fx = await sandboxEngine(t, { config: { max_concurrent_domains: 1, ...ADMIT } });
      const a = (await addProject(fx)).id;
      const b = (await addProject(fx)).id;
      const first = await roleHolding(fx, a, await addLimitedWork(fx, a), { on_term: 'exit' });
      const held = await addLimitedWork(fx, b);
      await requestTick(fx.engine, b);
      await waitFor(async () => (await workRead(fx, b, held))?.dispatch_hold ?? undefined, { timeoutMs: 30_000, what: 'the second item to show its hold' });
      const w = await workRead(fx, b, held);
      assert.deepEqual([w.status, w.dispatch_hold?.code, w.dispatch_hold?.subject?.limit], ['eligible', 'resource_envelope', 'max_concurrent_domains'], `the work stays eligible, held by the envelope (${JSON.stringify(w)})`);
      assert.deepEqual(runsOf(fx.home, held), [], 'no run is created for it');
      await stopRun(fx.engine, a, first.run.id);
      await waitForRunState(fx.home, first.run.id, 'ended', { timeoutMs: 60_000 });
    }
    // The reserves, each above what the host has free (read here first).
    const memAvailable = Number(/^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'))[1]) * 1024;
    const reserveMemory = CONTRACT.engine.host_reserve_memory.max;
    for (const [key, value, free] of [
      ['host_reserve_memory', reserveMemory, memAvailable],
      ['host_reserve_disk', CONTRACT.engine.host_reserve_disk.max, null],
    ]) {
      const fx = await sandboxEngine(t, { config: { ...ADMIT, [key]: value } });
      const freeNow = free ?? Number(statfsSync(fx.home).bavail) * Number(statfsSync(fx.home).bsize);
      assert.ok(value > freeNow, `the fixture is live: ${key} ${value} is above what the host has free (${freeNow})`);
      const project = (await addProject(fx)).id;
      const item = await addLimitedWork(fx, project);
      await requestTick(fx.engine, project);
      await waitFor(async () => (await workRead(fx, project, item))?.dispatch_hold ?? undefined, { timeoutMs: 30_000, what: `the item to show its hold (${key})` });
      const w = await workRead(fx, project, item);
      assert.deepEqual([w.status, w.dispatch_hold?.code, w.dispatch_hold?.subject?.limit], ['eligible', 'resource_envelope', key], `${key}: held (${JSON.stringify(w.dispatch_hold)})`);
      assert.deepEqual(runsOf(fx.home, item), [], `${key}: nothing admitted beyond the reserve`);
    }
  });

  test('(f) aggregate: two domains at their memory, storage and output limits; a third project held; a Stop, a refusal and the ledger recorded meanwhile; /v1/health within api_latency_bound', async (t) => {
    const fx = await sandboxEngine(t, { config: { max_concurrent_domains: 2, ...ADMIT } });
    const roles = [];
    for (let i = 0; i < 2; i++) {
      const project = (await addGitProject(fx)).id;
      const item = await addLimitedWork(fx, project);
      const armed = await limitedRole(fx, project, item, CAPS, {
        // Self-bounded: storage to ENOSPC and kept; 24 MiB held, below
        // memory.max with the role's own; 1 MiB of output in 4 KiB lines.
        acts: (act) => [act.writeToLimit(CAPS, { keep: true }), act.allocateToLimit(CAPS, { hold_bytes: 24 * MIB }), act.stdoutFlood(CAPS, { lines: 256, line_bytes: 4096 })],
        thenHold: true,
      });
      await armed.release();
      roles.push({ project, item, armed });
    }
    for (const { armed } of roles) assert.equal(at(fx, armed, 'write_to_limit', 'at_limit')?.stop, 'ENOSPC', 'the fixture is live: each domain\'s storage is full');
    const third = (await addGitProject(fx)).id;
    const thirdItem = await addLimitedWork(fx, third);
    await requestTick(fx.engine, third);
    await waitFor(async () => (await workRead(fx, third, thirdItem))?.dispatch_hold ?? undefined, { timeoutMs: 30_000, what: 'the third item to be held' });
    assert.equal((await workRead(fx, third, thirdItem)).dispatch_hold.code, 'resource_envelope', 'the third is held');
    // While the pressure lasts.
    for (let i = 0; i < 5; i++) {
      const began = performance.now();
      const res = await fx.engine.get('/v1/health');
      const took = performance.now() - began;
      assert.equal(res.status, 200, 'GET /v1/health answers');
      assert.ok(took <= LATENCY, `GET /v1/health within api_latency_bound (${LATENCY} ms): ${Math.round(took)} ms`);
    }
    const refusal = await fx.engine.post(`/v1/projects/${third}/policy`, { budget_hard_maximum: true });
    assertRefused(refusal, 400, ['hard_cap_unenforceable'], 'a refusal while two domains are at their limits');
    await stopRun(fx.engine, roles[0].project, roles[0].armed.run.id);
    await waitForRunState(fx.home, roles[0].armed.run.id, 'ended', { timeoutMs: 60_000 });
    assertRunEnded(fx.home, roles[0].armed.run.id, { outcome: 'stopped', reason_class: 'human_stop', launched: true, recovery: false });
    const ledger = await getLedger(fx.engine, roles[0].project);
    assert.ok(ledger.rows.some((r) => r.run === roles[0].armed.run.id), 'the stopped run\'s ledger row is recorded while the other domain is at its limits');
    assert.equal(runRowState(fx, roles[1].armed.run.id), 'executing', 'the other domain was untouched');
    await stopRun(fx.engine, roles[1].project, roles[1].armed.run.id);
    await waitForRunState(fx.home, roles[1].armed.run.id, 'ended', { timeoutMs: 60_000 });
  });

  test('(g) stream_line_max_bytes and stream_queue_max_bytes: a line over the bound, and a queue over the bound, each cancels the run with the transcript truncated', async (t) => {
    const fx = await sandboxEngine(t, { config: { stream_line_max_bytes: CONTRACT.engine.stream_line_max_bytes.min, stream_queue_max_bytes: CONTRACT.engine.stream_queue_max_bytes.min, ...ADMIT } });
    const cases = [
      { key: 'stream_line_max_bytes', flood: { lines: 1, line_bytes: CONTRACT.engine.stream_line_max_bytes.min + 2 } },
      { key: 'stream_queue_max_bytes', flood: { lines: 2048, line_bytes: 1024 }, fault: { point: 'stream_slow', delay_ms: 20, times: 1_000_000 } },
    ];
    for (const c of cases) {
      const project = (await addProject(fx)).id;
      const item = await addLimitedWork(fx, project);
      if (c.fault) await armFault(fx.engine, c.fault);
      const armed = await limitedRole(fx, project, item, CAPS, { acts: (act) => [act.stdoutFlood(CAPS, c.flood)], after: [step.hold('after_flood')], result: false });
      const ended = await armed.release();
      assert.deepEqual([ended.outcome, ended.reason_class], ['failed', 'infra_error'], `${c.key}: the run is cancelled (${ended.reason_text})`);
      assert.match(ended.reason_text ?? '', new RegExp(c.key), `${c.key}: its reason names the bound`);
      assert.equal(terminalOf(fx, armed.run.id).exit_class, 'engine_signaled', `${c.key}: cancelled by the engine`);
      const transcript = recordRow(fx.home, withStore(fx.home, (db) => db.prepare('SELECT "transcript" FROM "runs" WHERE "id" = ?').get(armed.run.id).transcript));
      assert.ok(transcript, `${c.key}: the transcript is kept`);
      assert.ok(transcript.bytes < c.flood.lines * c.flood.line_bytes, `${c.key}: and truncated (${transcript.bytes} of ${c.flood.lines * c.flood.line_bytes} bytes)`);
    }
  });

  test('(h) a host where H11 fails (harness-forced): real dispatch refused isolation_unqualified', async (t) => {
    const fx = await sandboxEngine(t, { start: false });
    await fx.start({ args: ['--harness-host-check', 'H11=failed'] });
    assert.equal(checkOf(hostSection(await fx.engine.engineInfo()), 'H11').result, 'failed', 'the fixture is live: H11 is failed');
    const standIn = new StandIn(join(fx.root, 'standin'), { logDir: fx.scripted.dir });
    const project = (await addGitProject(fx)).id;
    await useBackend(fx.engine, project, BACKENDS.claude, { roles: ['verifier'], extra: PARK_ON_REFUSAL });
    await holdSecret(fx.engine, apiKeyRef(BACKENDS.claude), `sk-test-key-for-the-stand-in-${randomBytes(6).toString('hex')}`);
    await installTrustEntry(fx.engine, standIn, { status: 'active' });
    const item = await addLimitedWork(fx, project);
    const { shown } = await refusedBeforeLaunch(fx, project, item, 'isolation_unqualified', 'with H11 failed');
    assert.ok((shown.refusal?.subject?.failed_checks ?? []).includes('H11'), `the refusal names H11 (${JSON.stringify(shown.refusal)})`);
    assert.equal(standIn.launches().length, 0, 'the real backend never ran');
  });

  test('P20 at start, on a host designated for it (isolation_probe_exhaustion true): passed, its target seeded, its negative recorded, its control run; each box built with its limits read back', async (t) => {
    const fx = await sandboxEngine(t, { config: { isolation_probe_exhaustion: true } });
    const host = hostSection(await fx.engine.engineInfo());
    const row = withStore(fx.home, (db) => db.prepare(`SELECT * FROM "host_qualifications" WHERE "status" = 'active'`).get());
    assert.ok(row, `an active host qualification (H9 ${checkOf(host, 'H9').observed})`);
    const p20 = JSON.parse(row.probes).find((p) => p.id === 'P20');
    assert.deepEqual([p20?.result, p20?.target_seeded, p20?.control], ['passed', true, true], `P20 passed against its seeded target with its control run (${JSON.stringify(p20)})`);
    assert.ok(typeof p20.negative === 'string' && p20.negative.length > 0, 'its negative is recorded');
    const doc = JSON.parse(readFileSync(recordFile(fx.home, recordRow(fx.home, row.evidence)), 'utf8'));
    assert.deepEqual((doc.p20 ?? []).map((p) => p.kind), ['pids', 'memory', 'bytes', 'inodes'], `the evidence holds each limit's box (${JSON.stringify(doc.p20)})`);
    for (const part of doc.p20) {
      assert.deepEqual([part.seeded, part.held, part.control], [true, true, true], `${part.kind}: its box built with its limits read back from the host, the limit held, the control run (${JSON.stringify(part)})`);
      assert.match(part.detail, new RegExp(`pids\\.max 64, memory\\.max ${64 * MIB}`), `${part.kind}: at the caps (${part.detail})`);
    }
  });
});

const runRowState = (fx, runId) => withStore(fx.home, (db) => db.prepare('SELECT "state" FROM "runs" WHERE "id" = ?').get(runId).state);
