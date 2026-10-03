// M110, the host checks recorded; the engine runs in its scope or starts
// unqualified (M2 slice 11, sandbox lane). M2 plan §3.2 M110 (a), (b), (c),
// (f); D2 §3.1, §6, §7.1, K2, N05, A.3 (D2-H01, D2-H02, part of D2-H03);
// SEAM.md §§114, 122 to 124, 129.
//
// A sandbox-lane engine runs the host checks at every start and reports
// each as passed, failed or not exercised with the value it observed, never
// passed by default; it enters a transient delegated scope of the user
// manager before it takes the lock, moves itself into a supervisor leaf and
// records the scope's path; without a reachable manager it starts all the
// same, with H3 failed, its scope null, real dispatch refused and a prior
// incarnation's domain unknown; a check the harness forces to fail refuses
// real dispatch naming that check; the checks run within tick_step_budget
// with the health route answering throughout, as a startup step between
// integrity and full.
//
// What this slice passes (SEAM.md §123): H1 to H8, H11 and H12. H9 and H10
// are the probe suite's, which slice 12 builds, and H13 is the observer's
// (E57), so in this slice they are `not_exercised`, the host is not
// eligible and no host_qualifications row is written. The rest of the row,
// (a)'s active row with its probes and (d), (e), is
// M110-qualification-per-start.test.mjs under manifest slice 12, where H9
// and H10 pass for the first time (M2 build spec §9). EXPECTED_IN_SLICE_11
// is what the slice-12 Verifier changes.
//
// Every case here is expected to fail on the engine these tests were
// written against, which creates no scope and runs no check (COVERAGE.md,
// "M2 slice 11").

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { CONTRACT } from './harness/fixtures.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { ledgerRows } from './harness/ledger.mjs';
import { readRun } from './harness/reads.mjs';
import { holdSecret } from './harness/records.mjs';
import { addProject, addWork, assertRunEnded, assertRunQuarantined, requestTick, runsOf, scriptedEngine, tick, waitForQuarantine, waitForRun, waitForWork } from './harness/runs.mjs';
import { listScopes, scopeUnitPrefix } from './harness/sandbox/cgroup.mjs';
import { HOST_CHECK_IDS, assertEngineInScope, checkOf, domainOf, hostSection, incarnationRow, roleAlive, roleHolding, sandboxEngine, scopeOf } from './harness/sandbox/lane.mjs';
import { script } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { BACKENDS, PARK_ON_REFUSAL, StandIn, apiKeyRef, eventsNamed, installTrustEntry, useBackend } from './harness/trust.mjs';

const isWsl2Host = () => /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8'));

// What a sandbox-lane start on this host reports in this slice (SEAM.md
// §123). Slice 12 turns H9 and H10 to `passed` and adds the active row.
const EXPECTED_IN_SLICE_11 = Object.freeze({
  H1: 'passed',
  H2: 'passed',
  H3: 'passed',
  H4: 'passed',
  H5: 'passed',
  H6: 'passed',
  H7: 'passed',
  H8: 'passed',
  // Slice 12 (the probe suite): H9 and H10 pass. Changed by the slice-12
  // Verifier as COVERAGE.md "M2 slice 11" permits in advance (SEAM.md §138).
  H9: 'passed',
  H10: isWsl2Host() ? 'passed' : 'not_exercised',
  H11: 'passed',
  H12: 'passed',
  H13: 'not_exercised',
});
const BLOCKING_NOT_EXERCISED = [];

const STEPS_UNDER_RUN = ['scope', 'lock', 'listen', 'store', 'recovery', 'integrity', 'host_qualification', 'full', 'scheduler'];
const M1_STEPS = ['lock', 'listen', 'store', 'recovery', 'integrity', 'full', 'scheduler'];

const kernelRelease = () => spawnSync('uname', ['-r'], { encoding: 'utf8' }).stdout.trim();
const toolPath = (name) => spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
const isWsl2 = () => /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8'));
const hostRows = (home) => withStore(home, (db) => db.prepare('SELECT * FROM "host_qualifications" ORDER BY rowid').all());

// The checks as the engine read reports them, against the slice's table and
// the host's own facts.
function assertChecksOfThisSlice(host, what) {
  for (const id of HOST_CHECK_IDS) {
    const c = checkOf(host, id);
    assert.equal(c.result, EXPECTED_IN_SLICE_11[id], `${what}: ${id} is ${EXPECTED_IN_SLICE_11[id]} in this slice (observed ${JSON.stringify(c.observed)})`);
    if (c.result === 'passed') assert.ok(typeof c.observed === 'string' && c.observed.length > 0, `${what}: a passed ${id} carries the value it observed`);
    else assert.ok(typeof c.remedy === 'string' && c.remedy.length > 0, `${what}: ${id} ${c.result} carries a remedy`);
  }
  assert.ok(checkOf(host, 'H1').observed.includes(kernelRelease()), `H1 observed the kernel release ${kernelRelease()} (observed ${checkOf(host, 'H1').observed})`);
  assert.ok(checkOf(host, 'H2').observed.includes('nsdelegate'), `H2 observed the nsdelegate mount option (observed ${checkOf(host, 'H2').observed})`);
  for (const c of ['memory', 'pids']) assert.ok(checkOf(host, 'H4').observed.includes(c), `H4 observed the ${c} controller (observed ${checkOf(host, 'H4').observed})`);
  for (const tool of ['unshare', 'setpriv', 'ip']) {
    assert.ok(checkOf(host, 'H6').observed.includes(toolPath(tool)), `H6 observed ${tool} at ${toolPath(tool)} (observed ${checkOf(host, 'H6').observed})`);
  }
  assert.ok(typeof checkOf(host, 'H13').observed === 'string' && checkOf(host, 'H13').observed.length > 0, 'H13 says why the observer is not exercised');
  assert.equal(host.wsl2, isWsl2(), 'the engine judges the host a WSL2 host as /proc/version does');
}

describe('M110 the host checks recorded; the engine in its scope', () => {
  test('(a) a start from a login session with the user manager: H1 to H13 each reported with the observed value, the engine in its scope\'s supervisor leaf with memory and pids delegated, scope_cgroup recorded; H9 and H10 passed from slice 12 (H13 not exercised), so one active row and the host eligible', async (t) => {
    const fx = await sandboxEngine(t);
    const info = await fx.engine.engineInfo();
    assert.deepEqual(info.startup.completed, STEPS_UNDER_RUN, 'the scope step runs before the lock and the host_qualification step between integrity and full');
    assert.equal(info.startup.failed, null, 'neither step is a startup failure');

    const host = hostSection(info);
    assert.equal(host.mode, 'run', 'the switch is on');
    assertChecksOfThisSlice(host, '(a)');
    assert.ok(checkOf(host, 'H3').observed.includes((await scopeOf(fx)).unit), `H3 observed the scope unit (observed ${checkOf(host, 'H3').observed})`);

    // The scope: the manager's, delegated, the engine inside it in place.
    const scope = await assertEngineInScope(fx);
    assert.equal(host.scope_cgroup, scope.path, 'the host section shows the scope path the store records');
    assert.equal(listScopes(scopeUnitPrefix(fx.home)).length, 1, 'the manager lists one scope for this home');

    // Slice 12: every required check passed, so the host is eligible on
    // one active row (its shape is M110-qualification-per-start.test.mjs's).
    // Changed from slice 11's "not eligible, no row" as COVERAGE.md "M2
    // slice 11" permits in advance (SEAM.md §138).
    assert.equal(host.eligible, true, 'the host is eligible once H9 and H10 pass');
    assert.equal(host.source, 'qualification', 'the eligibility rests on a qualification, not on the harness');
    assert.deepEqual(host.failed_checks, [], 'no check failed');
    assert.deepEqual(host.not_exercised_checks, BLOCKING_NOT_EXERCISED, 'no blocking check is unexercised');
    const rows = hostRows(fx.home).filter((r) => r.status === 'active');
    assert.equal(rows.length, 1, 'one active host_qualifications row');
    assert.equal(host.host_qualification, rows[0].id, 'and the engine read names it');
    assert.equal(host.message, null, 'no message while eligible');
    assert.equal(eventsNamed(fx.home, 'host.qualified').length, 1, 'one host.qualified');

    // The kernel lane is untouched: an unrun engine creates no scope, runs no
    // check and lists the M1 steps (M06).
    const kernel = await scriptedEngine(t);
    const kinfo = await kernel.engine.engineInfo();
    assert.deepEqual(kinfo.startup.completed, M1_STEPS, 'under unrun neither step runs nor is listed');
    assert.equal(incarnationRow(kernel.home, kinfo.incarnation).scope_cgroup, null, 'an unrun engine has no scope');
    assert.equal(hostSection(kinfo).mode, 'unrun');
    assert.equal(listScopes(scopeUnitPrefix(kernel.home)).length, 0, 'the manager lists no scope for the kernel-lane home');
  });

  test('(b) a start with XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS unset: full mode, scope_cgroup null, H3 failed with check, observed value and remedy in the message\'s shape, no row, real dispatch refused isolation_unqualified, a prior incarnation\'s domain unknown; the kernel lane still dispatches', async (t) => {
    // A first, qualified-as-far-as-this-slice-goes incarnation with a role
    // holding in a domain, and a second project whose verifier is a real
    // backend bound to the stand-in.
    const fx = await sandboxEngine(t);
    const standIn = new StandIn(join(fx.root, 'standin'));
    const { project, item, launch, domain } = await (async () => {
      const project = (await addProject(fx)).id;
      const item = await addWork(fx.engine, project, 'verification');
      const held = await roleHolding(fx, project, item, { on_term: 'ignore' });
      return { project, item, ...held };
    })();
    const real = (await addGitProject(fx)).id;
    await holdSecret(fx.engine, apiKeyRef(BACKENDS.claude), 'sk-test-key-for-the-stand-in-0110');
    await useBackend(fx.engine, real, BACKENDS.claude, { roles: ['verifier'], extra: PARK_ON_REFUSAL });
    await installTrustEntry(fx.engine, standIn, { status: 'active' });
    const firstIncarnation = (await fx.engine.engineInfo()).incarnation;
    await fx.engine.kill();
    assert.equal(roleAlive(domain, launch), true, 'the fixture is live: the role outlived its engine in its domain');

    // The restart cannot reach the user manager.
    const engine = await fx.start({ env: { XDG_RUNTIME_DIR: undefined, DBUS_SESSION_BUS_ADDRESS: undefined } });
    const info = await engine.engineInfo();
    assert.equal(info.mode, 'full', 'the engine reaches full mode with H3 failed: never a startup refusal (K2)');
    assert.equal(info.startup.failed, null);
    assert.ok(info.startup.completed.includes('scope') && info.startup.completed.includes('host_qualification'), `both steps ran and are listed (${info.startup.completed.join(', ')})`);
    assert.equal(incarnationRow(fx.home, info.incarnation).scope_cgroup, null, 'engine_incarnations.scope_cgroup is null when the scope could not be created');
    const host = hostSection(info);
    const h3 = checkOf(host, 'H3');
    assert.equal(h3.result, 'failed', `H3 failed (observed ${h3.observed})`);
    assert.ok(h3.observed.includes('XDG_RUNTIME_DIR'), `H3's observed value names the variable that is missing (observed ${h3.observed})`);
    assert.ok(typeof h3.remedy === 'string' && /login session/.test(h3.remedy), `H3's remedy says to start from a login session (remedy ${h3.remedy})`);
    assert.match(host.message ?? '', /^isolation unqualified: H3 failed: .*XDG_RUNTIME_DIR.*; .*login session.*; real backends are refused until then\.$/, `the message in D2 §6's shape (message: ${host.message})`);
    assert.ok(host.failed_checks.includes('H3'), `failed_checks names H3 (${host.failed_checks.join(', ')})`);
    assert.equal(host.scope_cgroup, null);
    assert.equal(host.eligible, false);
    assert.deepEqual(hostRows(fx.home).filter((r) => r.status === 'active'), [], 'no active row');

    // The prior incarnation's domain: unknown, never terminated, the role untouched.
    const first = runsOf(fx.home, item)[0];
    await waitForQuarantine(fx.home, first.id);
    const facts = assertRunQuarantined(fx.home, first.id, { outcome: 'recovered' });
    assert.equal(facts.domains[0].observation, 'unknown', 'the observation of a domain the engine cannot verify without the manager is unknown');
    assert.equal(roleAlive(domain, launch), true, 'nothing was signalled to a domain the engine could not verify: the role is still there');
    assert.equal(withStore(fx.home, (db) => db.prepare(`SELECT COUNT(*) AS n FROM "events" WHERE "type" = 'domain.terminated' AND json_extract("subject", '$.domain') = ?`).get(domain.id).n), 0);

    // A real dispatch is refused isolation_unqualified before launch.
    const work = await addWork(engine, real, 'verification');
    await requestTick(engine, real);
    const refused = await waitForRun(fx.home, work, { state: 'ended' });
    const ended = assertRunEnded(fx.home, refused.id, { outcome: 'refused', reason_class: 'preflight_refused', launched: false, recovery: false });
    assert.deepEqual(ended.receipts.map((r) => r.statuses), [['refused']]);
    assert.deepEqual(ledgerRows(fx.home, real).filter((r) => r.run === refused.id), [], 'no ledger row');
    const read = await readRun(engine, real, refused.id);
    assert.equal(read.code, 'isolation_unqualified', `the run read reports isolation_unqualified (read: ${JSON.stringify(read.refusal)})`);
    assert.ok(read.refusal?.subject?.failed_checks?.includes('H3'), `the refusal's subject names H3 among the failed checks (${JSON.stringify(read.refusal?.subject)})`);
    assert.equal(standIn.launches().length, 0, 'the stand-in was never launched');
    assert.deepEqual(eventsNamed(fx.home, 'domain.placed').filter((e) => e.subject?.run === refused.id), [], 'no domain was placed for the refused run');
    await waitForWork(fx.home, work, 'parked');

    // The kernel lane: an unrun engine without the manager's variables
    // dispatches a scripted role as M1 does (its constructed environment
    // never had them).
    const kernel = await scriptedEngine(t);
    const kproject = (await addProject(kernel)).id;
    const kitem = await addWork(kernel.engine, kproject, 'verification');
    kernel.scripted.script(kitem, [script.complete()]);
    await tick(kernel.engine, kproject);
    await waitForWork(kernel.home, kitem, 'complete');
    assert.equal(incarnationRow(kernel.home, (await kernel.engine.engineInfo()).incarnation).scope_cgroup, null, 'the kernel-lane engine has no scope and needs none');

    void firstIncarnation;
  });

  test('(c) a harness-forced H6 failure: the check reported failed with its forced value, the engine still in its scope, and a real dispatch refused isolation_unqualified naming H6', async (t) => {
    const fx = await sandboxEngine(t, { start: false });
    await fx.start({ args: ['--harness-host-check', 'H6=failed'] });
    const info = await fx.engine.engineInfo();
    const host = hostSection(info);
    const h6 = checkOf(host, 'H6');
    assert.equal(h6.result, 'failed', 'the forced check is reported failed');
    assert.ok(/forced/.test(h6.observed ?? ''), `its observed value says it was forced (${h6.observed})`);
    assert.deepEqual(host.failed_checks, ['H6']);
    assert.equal(host.eligible, false);
    assert.match(host.message ?? '', /^isolation unqualified: H6 failed: /, `the message names H6, the first blocking check in H order (message: ${host.message})`);
    await assertEngineInScope(fx);

    const standIn = new StandIn(join(fx.root, 'standin'));
    const project = (await addGitProject(fx)).id;
    await holdSecret(fx.engine, apiKeyRef(BACKENDS.claude), 'sk-test-key-for-the-stand-in-0110');
    await useBackend(fx.engine, project, BACKENDS.claude, { roles: ['verifier'], extra: PARK_ON_REFUSAL });
    await installTrustEntry(fx.engine, standIn, { status: 'active' });
    const item = await addWork(fx.engine, project, 'verification');
    await requestTick(fx.engine, project);
    const run = await waitForRun(fx.home, item, { state: 'ended' });
    assertRunEnded(fx.home, run.id, { outcome: 'refused', reason_class: 'preflight_refused', launched: false, recovery: false });
    const read = await readRun(fx.engine, project, run.id);
    assert.equal(read.code, 'isolation_unqualified', `the run read reports isolation_unqualified (${JSON.stringify(read.refusal)})`);
    assert.ok(read.refusal?.subject?.failed_checks?.includes('H6'), `the refusal names H6 (${JSON.stringify(read.refusal?.subject)})`);
    assert.equal(standIn.launches().length, 0, 'the stand-in was never launched');
    assert.ok(!(await fx.engine.engineInfo()).backends.includes(BACKENDS.claude), 'a real backend is not among the dispatchable backends on an ineligible host');
  });

  test('(f) the start-up budget: the checks complete within tick_step_budget, GET /v1/health answers throughout, and the step is listed between integrity and full', async (t) => {
    const budget = CONTRACT.engine.tick_step_budget.default;
    const fx = await sandboxEngine(t, { start: false });
    const engine = await fx.start({ until: 'none' });
    // Poll the health route from the first answer until full mode: every
    // answer must come, within two seconds, in both modes.
    const polls = [];
    let mode = null;
    const started = performance.now();
    while (mode !== 'full' && performance.now() - started < 60_000) {
      const at = performance.now();
      let res = null;
      try {
        res = await engine.get('/v1/health');
      } catch {
        res = null; // not listening yet
      }
      if (res !== null) polls.push({ status: res.status, mode: res.body?.mode ?? null, ms: performance.now() - at });
      if (res?.status === 200) mode = res.body?.mode ?? null;
      await sleep(50);
    }
    assert.equal(mode, 'full', `the engine reached full mode (last poll: ${JSON.stringify(polls.at(-1))})`);
    assert.ok(polls.length >= 2, 'the fixture is live: the health route was polled more than once before full mode');
    const slow = polls.filter((p) => p.status !== 200 || p.ms > 2000);
    assert.deepEqual(slow, [], 'every health request was answered 200 within two seconds while the checks ran');

    const info = await engine.engineInfo();
    const steps = info.startup.completed;
    assert.ok(steps.indexOf('integrity') < steps.indexOf('host_qualification') && steps.indexOf('host_qualification') < steps.indexOf('full'), `host_qualification is between integrity and full (${steps.join(', ')})`);
    const host = hostSection(info);
    assert.ok(Number.isFinite(host.duration_ms) && host.duration_ms >= 0, `the step's duration is reported (${host.duration_ms})`);
    assert.ok(host.duration_ms <= budget * 1000, `the checks and probes completed within tick_step_budget (${budget} s): ${host.duration_ms} ms`);
    assertChecksOfThisSlice(host, '(f)');
    assert.equal(domainOf(fx.home, 'none'), null, 'no domain of a project exists after a bare start');
  });
});
