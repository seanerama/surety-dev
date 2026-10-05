// M115, every unknown quarantines; the user manager interrupted (M2 slice
// 11, sandbox lane). M2 plan §3.3 M115; D2 §3.3, §3.4 (D2-B07, D2-B15); BS
// §6 corrections 2 and 13; AR B01; plan question 6, E59 item 5; SEAM.md
// §§16, 122, 128, 129. Rows M16 and M17 repeated through the real boundary.
//
// Each condition of D2 §3.4 that keeps closure or emptiness from being
// established makes the domain unknown and the run quarantined in M16's
// shape, with nothing collected; the quarantine holds across ticks, and
// across a restart wherever the restart still cannot establish termination;
// it ends only when a tick observes populated 0 with the launch closed, and
// a directory recreated by the test or a path under another scope is never
// termination; a daemon re-exec of the user manager changes nothing, and
// under a manager the engine cannot reach nothing is signalled and the
// quarantine holds until the role is gone. Two things this host cannot do
// are reported not_exercised with their reason.
//
// Every case here but the two not_exercised ones is expected to fail on the
// engine these tests were written against, which has no cgroup boundary
// (COVERAGE.md, "M2 slice 11").
//
// The case "(e) the launcher-exit tick" (E79 item 2; SEAM.md §170) was added
// after M2 slice 14: it sends no tick after the launcher's release and fails
// on an engine that does not tick when its launcher of a quarantined domain
// exits.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { armFault, clearFaults, waitFor } from './harness/engine.mjs';
import { now } from './harness/mono.mjs';
import { recordsOf } from './harness/records.mjs';
import { addProject, addWork, answerDecision, assertRunEnded, assertRunQuarantined, requestTick, run as runRow, runsOf, stopRun, tick, waitForQuarantine, waitForRun, waitForRunState, waitForWork, workItem } from './harness/runs.mjs';
import { cgroupExists, cgroupOfPid, daemonReexec, makeLeaf, makeUnreadable, moveIntoCgroup, populated, procsOf, removeCgroup, restoreReadable, waitCgroupGone } from './harness/sandbox/cgroup.mjs';
import { assertEngineInScope, domainOf, eventsOf, roleAlive, roleHolding, SANDBOX_CONFIG, sandboxEngine, updateDomain, waitForEvent } from './harness/sandbox/lane.mjs';
import { hostProcess, memberByInnerPid, waitHostGone } from './harness/sandbox/procs.mjs';
import { cgroupSentinel } from './harness/sandbox/sentinel.mjs';
import { script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const GRACE = { terminate_grace: 3, kill_grace: 2 };
const ignoring = { on_term: 'ignore', before: [step.descendant({ holds_stdout: false, on_term: 'ignore' })] };
const COLLECTED = ['result', 'unaccepted_result', 'provider_files'];

// M16's quarantine shape, D2's observation, and nothing collected.
function assertUnknownQuarantine(fx, project, runId, { outcome, blocker } = {}) {
  const facts = assertRunQuarantined(fx.home, runId, { outcome, blocker });
  const d = facts.domains.find((x) => x.status === 'quarantined');
  assert.equal(d.observation, 'unknown', `the domain's observation is unknown (${d.observation})`);
  assert.ok(d.observed_at, 'observed_at is set');
  assert.equal(d.launch_state, 'closed', 'the launch is closed');
  const collected = recordsOf(fx.home, project).filter((r) => r.run === runId && COLLECTED.includes(r.kind));
  assert.deepEqual(collected, [], 'nothing is collected from an unknown domain');
  assert.deepEqual(eventsOf(fx.home, 'domain', d.id, 'domain.terminated'), [], 'never terminated');
  return facts;
}

// Still quarantined after `n` ticks: the same reservation, the same blocker.
async function assertHoldsAcrossTicks(fx, project, runId, before, n = 2) {
  for (let i = 0; i < n; i++) await tick(fx.engine, project);
  const after = assertUnknownQuarantine(fx, project, runId, { outcome: before.run.outcome, blocker: 'any' });
  const reservation = (f) => f.leases.find((l) => l.resource_kind === 'quarantine' && l.released_at === null)?.id;
  assert.equal(reservation(after), reservation(before), 'the same reservation is held');
  assert.deepEqual(after.decisions.filter((d) => d.kind === 'blocker').map((d) => d.id), before.decisions.filter((d) => d.kind === 'blocker').map((d) => d.id), 'the same blocker, not asked twice');
  return after;
}

// M17's clearance, once: terminated, the reservation released, the run
// ended with its outcome, and the project free. `launched` false: the run's
// launch was never authorized, so no role code ever ran: its invocation is
// recorded refused, never launched, and is not charged (SEAM.md §§24, 125).
async function assertClearedOnce(fx, project, runId, outcome, { launched = true } = {}) {
  await waitForRunState(fx.home, runId, 'ended');
  const ended = assertRunEnded(fx.home, runId, { outcome, launched, recovery: false });
  if (!launched) {
    assert.deepEqual(ended.receipts.map((r) => r.statuses), [['dispatch_started', 'refused']], 'a run whose launch was never authorized is recorded refused, never launched, also when it ends by a quarantine\'s clearance');
    assert.deepEqual(ended.receipts.flatMap((r) => r.ledger), [], 'and is not charged');
  }
  assert.equal(ended.domains[0].status, 'terminated');
  assert.equal(ended.domains[0].observation, 'terminated');
  assert.equal(eventsOf(fx.home, 'domain', ended.domains[0].id, 'domain.quarantined').length, 1);
  assert.equal(ended.leases.filter((l) => l.resource_kind === 'quarantine').length, 1, 'one reservation ever');
  assert.ok(ended.leases.find((l) => l.resource_kind === 'quarantine').released_at, 'released');
  assert.equal(cgroupExists(ended.domains[0].cgroup_path), false, 'the directory is removed on clearance');
  return ended;
}

// A cgroup directory that reads populated 0 ('empty'), or that is gone
// ('removed'); false while it is populated. Any other failure to read it is
// a failure: only a missing directory is absence (objection 005).
function emptyOrRemoved(dir) {
  try {
    return populated(dir) === 0 ? 'empty' : false;
  } catch (err) {
    if (err.code === 'ENOENT') return 'removed';
    throw err;
  }
}

// The seqs of every engine.tick event, in order (SEAM.md §15).
const recordedTicks = (home) => withStore(home, (db) => db.prepare(`SELECT "seq" FROM "events" WHERE "type" = 'engine.tick' ORDER BY "seq"`).all().map((r) => r.seq));

// The tests' own privilege, read without asking for any: the effective uid
// and the effective capability set of this process.
const capEff = () => readFileSync('/proc/self/status', 'utf8').split('\n').find((l) => l.startsWith('CapEff:'))?.split(/\s+/)[1] ?? null;
const unprivileged = () => process.geteuid() !== 0 && /^0+$/.test(capEff() ?? '');

describe('M115 every unknown quarantines', () => {
  test('(a) cgroup.events unreadable: unknown, M16\'s quarantine, nothing collected, across ticks and a restart whose observation still cannot read it', async (t) => {
    const fx = await sandboxEngine(t, { config: GRACE });
    const scope = await assertEngineInScope(fx);
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const waiting = await addWork(fx.engine, project, 'review');
    const { run, domain } = await roleHolding(fx, project, item, ignoring);
    await stopRun(fx.engine, project, run.id);
    await waitForEvent(fx.home, 'domain', domain.id, 'domain.launch_closed');
    makeUnreadable(domain.cgroup_path, 'cgroup.events');
    t.after(() => {
      try {
        restoreReadable(domain.cgroup_path, 'cgroup.events');
      } catch {
        // gone
      }
    });
    await waitForQuarantine(fx.home, run.id, { timeoutMs: 30_000 });
    const before = assertUnknownQuarantine(fx, project, run.id, { outcome: 'stopped' });
    await assertHoldsAcrossTicks(fx, project, run.id, before);
    assert.equal(runsOf(fx.home, waiting).length, 0, 'nothing else of the project is dispatched');

    // A restart that still cannot read the file: the scope is kept alive by
    // a leaf of the test's own, since an emptied scope would be removed and
    // absence in the verified hierarchy would be termination (SEAM.md §128).
    const keep = makeLeaf(scope.path, 'test_keep');
    await cgroupSentinel(t, keep);
    await fx.engine.kill();
    await fx.start();
    const after = await assertHoldsAcrossTicks(fx, project, run.id, before);
    assert.equal(after.run.outcome, 'stopped');
    for (const g of after.grants) assert.ok(g.revoked_at, 'no grant is live after the restart');
    const blocker = after.decisions.find((d) => d.kind === 'blocker');
    await answerDecision(fx.engine, project, blocker.id, 'acknowledge');
    await assertHoldsAcrossTicks(fx, project, run.id, { ...before, decisions: after.decisions }, 1);
  });

  test('(b) the manager_unreachable fault: nothing is signalled, the domain is unknown and quarantined with the role alive, across ticks', async (t) => {
    const fx = await sandboxEngine(t, { config: GRACE });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const { run, domain, launch } = await roleHolding(fx, project, item, { on_term: 'exit' });
    await armFault(fx.engine, { point: 'manager_unreachable', times: 1_000_000 });
    await stopRun(fx.engine, project, run.id);
    await waitForQuarantine(fx.home, run.id, { timeoutMs: 30_000 });
    const before = assertUnknownQuarantine(fx, project, run.id, { outcome: 'stopped' });
    assert.equal(roleAlive(domain, launch), true, 'nothing was signalled to a domain the engine could not verify: the role, which would exit on TERM, is alive');
    assert.deepEqual(fx.scripted.eventsOfInvocation(launch.invocation, 'signal'), [], 'the role saw no signal');
    assert.equal(populated(domain.cgroup_path), 1);
    await assertHoldsAcrossTicks(fx, project, run.id, before);
    assert.equal(roleAlive(domain, launch), true, 'still alive after the ticks');
    await clearFaults(fx.engine);
  });

  test('(c) a recorded path outside the verified hierarchy: unknown and quarantined at the restart and at the next, the real role untouched', async (t) => {
    const fx = await sandboxEngine(t, { config: GRACE });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const { run, domain, launch } = await roleHolding(fx, project, item, ignoring);
    await fx.engine.kill();
    const other = await cgroupSentinel(t);
    const elsewhere = makeLeaf(cgroupOfPid(other.pid), 'dom_elsewhere');
    moveIntoCgroup(other.pid, elsewhere);
    updateDomain(fx.home, domain.id, { cgroup_path: elsewhere });
    await fx.start();
    await waitForQuarantine(fx.home, run.id);
    const before = assertUnknownQuarantine(fx, project, run.id, { outcome: 'recovered' });
    assert.equal(roleAlive(domain, launch), true, 'the real role was not touched');
    assert.equal(other.alive(), true, "the other scope's process was not touched");
    await assertHoldsAcrossTicks(fx, project, run.id, before);
    await fx.engine.kill();
    await fx.start();
    await assertHoldsAcrossTicks(fx, project, run.id, before);
    assert.equal(roleAlive(domain, launch), true);
    assert.equal(other.alive(), true);
  });

  test("(d) a prior supervisor leaf that cannot be killed (cgroup.kill unwritable): unknown and quarantined, the role alive, across a further restart", async (t) => {
    const fx = await sandboxEngine(t, { config: GRACE });
    const scope = await assertEngineInScope(fx);
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const { run, domain, launch } = await roleHolding(fx, project, item, ignoring);
    await fx.engine.kill();
    makeUnreadable(scope.supervisor, 'cgroup.kill');
    t.after(() => {
      try {
        restoreReadable(scope.supervisor, 'cgroup.kill');
      } catch {
        // gone
      }
    });
    await fx.start();
    await waitForQuarantine(fx.home, run.id);
    const before = assertUnknownQuarantine(fx, project, run.id, { outcome: 'recovered' });
    assert.equal(roleAlive(domain, launch), true, 'a prior supervisor leaf that cannot be killed stops recovery before the domain: the role is alive');
    await assertHoldsAcrossTicks(fx, project, run.id, before);
    await fx.engine.kill();
    await fx.start();
    await assertHoldsAcrossTicks(fx, project, run.id, before);
    assert.equal(roleAlive(domain, launch), true);
  });

  test("(e) the launcher_wait fault: a launcher's exit that cannot be established is unknown and quarantined; the launcher released and refused, the next tick clears it", async (t) => {
    const fx = await sandboxEngine(t, { config: GRACE, barriers: ['launcher.before_placement=pause'] });
    const scope = await assertEngineInScope(fx);
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(item, [script.complete()]);
    await requestTick(fx.engine, project);
    await fx.engine.waitUntil('barrier:launcher.before_placement');
    const run = await waitForRun(fx.home, item);
    const domain = domainOf(fx.home, run.id);
    const launchers = procsOf(scope.supervisor).filter((p) => p !== fx.engine.pid && /node$/.test(hostProcess(p)?.cmdline[0] ?? ''));
    assert.equal(launchers.length, 1, `the launcher waits in the supervisor leaf (members: ${procsOf(scope.supervisor).join(', ')})`);
    const [launcher] = launchers;
    await armFault(fx.engine, { point: 'launcher_wait' });
    await stopRun(fx.engine, project, run.id);
    await waitForQuarantine(fx.home, run.id, { timeoutMs: 30_000 });
    const facts = assertUnknownQuarantine(fx, project, run.id, { outcome: 'stopped' });
    assert.equal(facts.domains[0].status, 'quarantined');
    assert.deepEqual(fx.scripted.launches({ run: run.id }), [], 'no role was launched');
    const res = await fx.engine.post('/v1/harness/barriers/launcher.before_placement/release', {});
    assert.ok([200, 404, 409].includes(res.status), `the launcher is released (or is already gone): ${res.status}`);
    // Objection 018: the released launcher may place itself after closure
    // (D2 §3.2; not pinned, SEAM.md §131) and is refused its grant; until it
    // has exited the domain is populated and its launcher outstanding, which
    // is not termination (slice 11's S1). So the next tick is asked for once
    // the launcher is gone (host-read) and the domain is empty or removed,
    // as S1 does; "the next tick clears it" then holds by construction.
    await waitHostGone(launcher, { timeoutMs: 20_000 });
    await waitFor(() => emptyOrRemoved(domain.cgroup_path) || undefined, { timeoutMs: 10_000, what: 'the domain to be empty or removed once the launcher is gone' });
    await tick(fx.engine, project);
    await assertClearedOnce(fx, project, run.id, 'stopped', { launched: false });
    assert.deepEqual(eventsOf(fx.home, 'domain', domain.id, 'domain.launch_authorized'), [], 'the released launcher got no grant');
    assert.deepEqual(fx.scripted.launches({ run: run.id }), [], 'and ran nothing');
    await waitForWork(fx.home, item, 'held');
  });

  // The slice-11 review's S1 (E31: one case per confirmed serious finding).
  // D2 §3.2: "populated 0 on a domain whose launcher is outstanding is not
  // termination"; §3.4: each tick observes a quarantined domain again "under
  // the same closure prerequisites". The launcher here is this engine's
  // child, alive in the supervisor leaf, never placed, its exit never
  // established (the launcher_wait fault left it so): the domain's cgroup is
  // empty and stays empty, and a tick that took populated 0 for termination
  // would end the run while a launcher can still enter the domain.
  test("S1 (the slice-11 review): while this engine's launcher is outstanding (alive, unplaced, its exit not established) a tick keeps the domain unknown and the run quarantined and records no termination; once the launcher is released and gone, having been granted nothing and having run nothing, the next tick clears the quarantine once", async (t) => {
    const fx = await sandboxEngine(t, { config: GRACE, barriers: ['launcher.before_placement=pause'] });
    const scope = await assertEngineInScope(fx);
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const waiting = await addWork(fx.engine, project, 'review');
    fx.scripted.script(item, [script.complete()]);
    fx.scripted.script(waiting, [script.complete()]);
    await requestTick(fx.engine, project);
    await fx.engine.waitUntil('barrier:launcher.before_placement');
    const run = await waitForRun(fx.home, item);
    const domain = domainOf(fx.home, run.id);
    const launchers = procsOf(scope.supervisor).filter((p) => p !== fx.engine.pid && /node$/.test(hostProcess(p)?.cmdline[0] ?? ''));
    assert.equal(launchers.length, 1, `the launcher waits in the supervisor leaf (members: ${procsOf(scope.supervisor).join(', ')})`);
    const [launcher] = launchers;

    // The Stop cannot establish the launcher's exit: unknown, quarantine.
    await armFault(fx.engine, { point: 'launcher_wait' });
    await stopRun(fx.engine, project, run.id);
    await waitForQuarantine(fx.home, run.id, { timeoutMs: 30_000 });
    const before = assertUnknownQuarantine(fx, project, run.id, { outcome: 'stopped' });

    // The launcher is outstanding: alive, still in the supervisor leaf, not a
    // member of the domain, whose cgroup is there and empty.
    const outstanding = (when) => {
      assert.ok(hostProcess(launcher) !== null, `${when}: the launcher (host pid ${launcher}) is alive`);
      assert.ok(procsOf(scope.supervisor).includes(launcher), `${when}: it is still in the supervisor leaf`);
      assert.equal(cgroupExists(domain.cgroup_path), true, `${when}: the domain's directory is there`);
      assert.deepEqual(procsOf(domain.cgroup_path), [], `${when}: the launcher is not a member of the domain`);
      assert.equal(populated(domain.cgroup_path), 0, `${when}: the domain reads populated 0`);
      assert.deepEqual(eventsOf(fx.home, 'domain', domain.id, 'domain.placed'), [], `${when}: it never placed itself`);
    };
    outstanding('the fixture is live, after the Stop');

    // Ticks, with the launcher outstanding: populated 0 is not termination.
    for (let i = 1; i <= 2; i++) {
      await tick(fx.engine, project);
      assert.deepEqual(
        eventsOf(fx.home, 'domain', domain.id, 'domain.terminated').map((e) => e.seq),
        [],
        `tick ${i} recorded domain.terminated while this engine's launcher is outstanding: alive, unplaced, its exit not established. D2 §3.2: "populated 0 on a domain whose launcher is outstanding is not termination"; a tick observes under the same closure prerequisites (§3.4)`,
      );
      const row = domainOf(fx.home, run.id);
      assert.deepEqual([row.status, row.observation, row.launch_state], ['quarantined', 'unknown', 'closed'], `tick ${i}: the domain stays quarantined and unknown, its launch closed`);
      await assertHoldsAcrossTicks(fx, project, run.id, before, 0);
      outstanding(`after tick ${i} (a tick signals nothing)`);
      assert.equal(runsOf(fx.home, waiting).length, 0, `tick ${i}: nothing else of the project is dispatched`);
    }

    // The launcher is released. Closure forbids the grant, so it gets none
    // and runs nothing of the role; it leaves by itself. Whether it placed
    // itself on the way (D2 §3.2 lets a launcher be "itself a member" after
    // closure) is not pinned; that it is gone and the domain empty is.
    const res = await fx.engine.post('/v1/harness/barriers/launcher.before_placement/release', {});
    assert.equal(res.status, 200, `the waiting launcher is released (${res.status} ${res.text})`);
    await waitHostGone(launcher, { timeoutMs: 20_000 });
    await waitFor(() => (populated(domain.cgroup_path) === 0 ? true : undefined), { timeoutMs: 10_000, what: 'the domain to read populated 0 once the launcher is gone' });
    assert.deepEqual(eventsOf(fx.home, 'domain', domain.id, 'domain.launch_authorized'), [], 'the released launcher was granted nothing');
    assert.deepEqual(fx.scripted.launches({ run: run.id }), [], 'and ran nothing of the role');
    // Gone, and the domain empty; the engine clears nothing without observing.
    assert.deepEqual(eventsOf(fx.home, 'domain', domain.id, 'domain.terminated'), [], 'no termination is recorded before the tick that observes it');
    assertUnknownQuarantine(fx, project, run.id, { outcome: 'stopped' });

    // The condition is lifted: the launcher has exited and the domain is
    // empty with its launch closed. The next tick clears it, once.
    await tick(fx.engine, project);
    const ended = await assertClearedOnce(fx, project, run.id, 'stopped', { launched: false });
    const terminated = eventsOf(fx.home, 'domain', domain.id, 'domain.terminated');
    assert.equal(terminated.length, 1, 'one domain.terminated');
    assert.ok(eventsOf(fx.home, 'domain', domain.id, 'domain.placed').every((e) => e.seq < terminated[0].seq), 'no placement is recorded after the termination (B12)');
    assert.deepEqual(eventsOf(fx.home, 'domain', domain.id, 'domain.launch_authorized'), [], 'never authorized');
    assert.deepEqual(fx.scripted.launches({ run: run.id }), [], 'no role was ever launched for the run');
    await waitForWork(fx.home, item, 'held');
    assert.equal(ended.run.outcome, 'stopped');
    const settled = JSON.stringify(assertRunEnded(fx.home, run.id, { outcome: 'stopped', launched: false, recovery: false }));
    // The project is free again, and repeating the observation writes nothing.
    await tick(fx.engine, project);
    await waitForWork(fx.home, waiting, 'complete');
    assert.equal(JSON.stringify(assertRunEnded(fx.home, run.id, { outcome: 'stopped', launched: false, recovery: false })), settled, 'further ticks write nothing more about the cleared run');
  });

  // The launcher-exit tick (E79 item 2, decided by Sean; E77 item 1;
  // objection 018's "not taken"; SEAM.md §170). (e)'s fixture, with one
  // difference: once the launcher is released the test sends no tick. When
  // this engine's launcher of a quarantined domain exits, the engine asks for
  // a tick itself, so the re-observation of section 128 follows the exit
  // instead of waiting for the next scheduled tick (`tick_interval` 600 s
  // here). Everything (e) asserts holds.
  test("(e) the launcher-exit tick (E79 item 2): the launcher of a quarantined domain released and gone, the engine ticks by itself; with no tick sent by the test the domain is terminated and the quarantine cleared once within 30 s, no grant, no role, the invocation refused and uncharged, the work held", async (t) => {
    const fx = await sandboxEngine(t, { config: GRACE, barriers: ['launcher.before_placement=pause'] });
    assert.equal({ ...SANDBOX_CONFIG, ...GRACE }.tick_interval, 600, 'the fixture is live: the scheduled tick is 600 s away');
    const scope = await assertEngineInScope(fx);
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(item, [script.complete()]);
    await requestTick(fx.engine, project);
    await fx.engine.waitUntil('barrier:launcher.before_placement');
    const run = await waitForRun(fx.home, item);
    const domain = domainOf(fx.home, run.id);
    const launchers = procsOf(scope.supervisor).filter((p) => p !== fx.engine.pid && /node$/.test(hostProcess(p)?.cmdline[0] ?? ''));
    assert.equal(launchers.length, 1, `the launcher waits in the supervisor leaf (members: ${procsOf(scope.supervisor).join(', ')})`);
    const [launcher] = launchers;
    await armFault(fx.engine, { point: 'launcher_wait' });
    await stopRun(fx.engine, project, run.id);
    await waitForQuarantine(fx.home, run.id, { timeoutMs: 30_000 });
    const facts = assertUnknownQuarantine(fx, project, run.id, { outcome: 'stopped' });
    assert.equal(facts.domains[0].status, 'quarantined');
    assert.deepEqual(fx.scripted.launches({ run: run.id }), [], 'no role was launched');
    assert.ok(hostProcess(launcher) !== null, `the fixture is live: the quarantine stands while the launcher (host pid ${launcher}) is outstanding`);

    // The release; from here on the test sends no tick.
    const res = await fx.engine.post('/v1/harness/barriers/launcher.before_placement/release', {});
    assert.equal(res.status, 200, `the waiting launcher is released (${res.status} ${res.text})`);
    await waitHostGone(launcher, { timeoutMs: 20_000 });
    const gone = now();
    const ended = await waitForRunState(fx.home, run.id, 'ended', { timeoutMs: 30_000 }).catch((err) => err);
    assert.ok(
      !(ended instanceof Error),
      `with no tick sent by the test, the quarantine was not cleared within 30 s of the launcher's exit (host pid ${launcher}): when this engine's launcher of a quarantined domain exits, the engine requests a tick itself, so the domain is re-observed and the quarantine cleared without waiting for the scheduled tick (tick_interval 600 s; E79 item 2; SEAM.md §170). Run state ${runRow(fx.home, run.id)?.state}, domain ${JSON.stringify((({ status, observation, launch_state }) => ({ status, observation, launch_state }))(domainOf(fx.home, run.id)))}, the domain's directory ${String(emptyOrRemoved(domain.cgroup_path))}`,
    );
    t.diagnostic(`(e) launcher-exit tick: the run ended ${Math.round(now() - gone)} ms after the launcher's exit was read on the host`);

    // The clearance, once, as (e) and S1 require it.
    await assertClearedOnce(fx, project, run.id, 'stopped', { launched: false });
    const terminated = eventsOf(fx.home, 'domain', domain.id, 'domain.terminated');
    assert.equal(terminated.length, 1, 'one domain.terminated');
    await waitFor(() => recordedTicks(fx.home).some((seq) => seq > terminated[0].seq) || undefined, { timeoutMs: 10_000, what: 'the engine.tick of the tick the engine asked for, after the domain.terminated it wrote (SEAM.md §15: a tick writes engine.tick after everything else it wrote)' });
    assert.ok(eventsOf(fx.home, 'domain', domain.id, 'domain.placed').every((e) => e.seq < terminated[0].seq), 'no placement is recorded after the termination (B12)');
    assert.deepEqual(eventsOf(fx.home, 'domain', domain.id, 'domain.launch_authorized'), [], 'the released launcher got no grant');
    assert.deepEqual(fx.scripted.launches({ run: run.id }), [], 'and ran nothing');
    await waitForWork(fx.home, item, 'held');
  });

  test('(f) cgroup.kill refused during termination: unknown and quarantined with the role alive, across a restart; writable again, a tick observes populated 1 and keeps the quarantine; the role gone, the next tick clears it', async (t) => {
    const fx = await sandboxEngine(t, { config: GRACE });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const { run, domain, launch, member } = await roleHolding(fx, project, item, ignoring);
    // The host pids of the role and of its descendant, read while both live:
    // "gone" is later read from the process table, not from a directory.
    const descendant = await fx.scripted.waitForDescendant({ invocation: launch.invocation });
    const descendantPid = memberByInnerPid(domain.cgroup_path, descendant.pid)?.pid;
    assert.ok(descendantPid, 'the fixture is live: the descendant is a member of the domain');
    // The scope of the incarnation this case kills below: the domain's parent.
    const firstScope = dirname(domain.cgroup_path);
    await stopRun(fx.engine, project, run.id);
    await waitForEvent(fx.home, 'domain', domain.id, 'domain.launch_closed');
    makeUnreadable(domain.cgroup_path, 'cgroup.kill');
    t.after(() => {
      try {
        restoreReadable(domain.cgroup_path, 'cgroup.kill');
      } catch {
        // gone
      }
    });
    await waitForQuarantine(fx.home, run.id, { timeoutMs: 30_000 });
    const before = assertUnknownQuarantine(fx, project, run.id, { outcome: 'stopped' });
    assert.equal(roleAlive(domain, launch), true, 'the kill could not be written: the role, which ignores TERM, is alive');
    await assertHoldsAcrossTicks(fx, project, run.id, before);
    await fx.engine.kill();
    await fx.start();
    await assertHoldsAcrossTicks(fx, project, run.id, before);
    assert.equal(roleAlive(domain, launch), true, 'still alive after the restart: the kill is still refused');

    restoreReadable(domain.cgroup_path, 'cgroup.kill');
    await tick(fx.engine, project);
    assertUnknownQuarantine(fx, project, run.id, { outcome: 'stopped', blocker: 'any' });
    assert.equal(roleAlive(domain, launch), true, "a tick's re-observation signals nothing: populated 1 keeps the quarantine with the role alive");
    fx.scripted.release(item);
    // The role exits by itself and its init with it (SEAM.md §126), which
    // ends the namespace's last member, the descendant that ignored TERM.
    // Host-read from the process table.
    await waitHostGone(member.pid);
    await waitHostGone(descendantPid);
    // The domain is in the scope of the incarnation this case killed, whose
    // supervisor leaf is empty: with the role gone that scope has no member,
    // and the user manager removes an emptied scope with its empty children
    // (SEAM.md §§124, 128; objection 005). So the domain now reads populated
    // 0, or is gone together with its whole scope, and nothing else.
    const left = await waitFor(() => emptyOrRemoved(domain.cgroup_path), { timeoutMs: 15_000, what: 'the domain to be empty, or removed with its emptied scope' });
    t.diagnostic(`(f) after the release the domain's directory was ${left === 'removed' ? 'removed with the emptied scope of the dead incarnation' : 'present and empty (populated 0)'}`);
    if (left === 'removed') {
      await waitCgroupGone(firstScope, { timeoutMs: 10_000 });
      assert.equal(cgroupExists(firstScope), false, "the domain's directory is absent because the manager removed the emptied scope of the dead incarnation with its children: the scope is absent too");
    }
    // None of it is the engine's doing: no tick has run since the release,
    // so nothing is terminated yet and the run is still quarantined.
    assert.deepEqual(eventsOf(fx.home, 'domain', domain.id, 'domain.terminated'), [], 'the engine has recorded no termination before the tick');
    assertUnknownQuarantine(fx, project, run.id, { outcome: 'stopped', blocker: 'any' });
    // The tick observes populated 0, or absence inside the verified
    // hierarchy (D2 §3.3), with the launch closed: terminated, once.
    await tick(fx.engine, project);
    await assertClearedOnce(fx, project, run.id, 'stopped');
  });

  test('(f) [not_exercised] a member the kill cannot end (uninterruptible sleep): this host has no unprivileged way to make one', () => {
    assert.equal(unprivileged(), true, `the tests run without privilege (euid ${process.geteuid()}, CapEff ${capEff()}): a process in D state cannot be made on demand (M2 plan §2.5)`);
  });

  test('(g) release ticks: the condition lifted with the launch closed and populated 0 clears the quarantine once; a directory removed and recreated with a sentinel inside, and a path under another scope, are never termination', async (t) => {
    // (g1) and (g2) from (a)'s condition on one engine, two runs.
    const fx = await sandboxEngine(t, { config: GRACE });
    const scope = await assertEngineInScope(fx);
    const project = (await addProject(fx)).id;
    const quarantine = async (what) => {
      const item = await addWork(fx.engine, project, 'verification');
      const held = await roleHolding(fx, project, item, ignoring);
      await stopRun(fx.engine, project, held.run.id);
      await waitForEvent(fx.home, 'domain', held.domain.id, 'domain.launch_closed');
      makeUnreadable(held.domain.cgroup_path, 'cgroup.events');
      t.after(() => {
        try {
          restoreReadable(held.domain.cgroup_path, 'cgroup.events');
        } catch {
          // gone
        }
      });
      await waitForQuarantine(fx.home, held.run.id, { timeoutMs: 30_000 });
      await sleep((GRACE.terminate_grace + GRACE.kill_grace + 2) * 1000);
      assert.equal(roleAlive(held.domain, held.launch), false, `${what}: the fixture is live: the role was killed, the domain is empty`);
      return { item, ...held, before: assertUnknownQuarantine(fx, project, held.run.id, { outcome: 'stopped' }) };
    };

    // (g1) lifted: terminated and clearance, once.
    const one = await quarantine('(g1)');
    restoreReadable(one.domain.cgroup_path, 'cgroup.events');
    await tick(fx.engine, project);
    const ended = await assertClearedOnce(fx, project, one.run.id, 'stopped');
    const settled = JSON.stringify(ended);
    for (let i = 0; i < 2; i++) await tick(fx.engine, project);
    assert.equal(JSON.stringify(assertRunEnded(fx.home, one.run.id, { outcome: 'stopped' })), settled, 'repeating the observation writes nothing');
    await waitForWork(fx.home, one.item, 'held');

    // (g2) removed and recreated by the test with a sentinel inside: never
    // termination, still quarantined, the sentinel untouched.
    const two = await quarantine('(g2)');
    removeCgroup(two.domain.cgroup_path);
    assert.equal(cgroupExists(two.domain.cgroup_path), false);
    assert.equal(makeLeaf(scope.path, two.domain.id), two.domain.cgroup_path, 'the directory is recreated at the recorded path');
    const sentinel = await cgroupSentinel(t, two.domain.cgroup_path);
    assert.equal(populated(two.domain.cgroup_path), 1, 'the fixture is live: the recreated directory is populated by the sentinel');
    for (let i = 0; i < 3; i++) await tick(fx.engine, project);
    assertUnknownQuarantine(fx, project, two.run.id, { outcome: 'stopped' });
    assert.equal(sentinel.alive(), true, 'the sentinel in the recreated directory is untouched');
    assert.ok(procsOf(two.domain.cgroup_path).includes(sentinel.pid));

    // (g3) the path now under another scope: still quarantined, the
    // process there untouched. The store is edited with the engine stopped.
    await fx.engine.kill();
    const other = await cgroupSentinel(t);
    const elsewhere = makeLeaf(cgroupOfPid(other.pid), two.domain.id);
    moveIntoCgroup(other.pid, elsewhere);
    updateDomain(fx.home, two.domain.id, { cgroup_path: elsewhere });
    await fx.start();
    for (let i = 0; i < 2; i++) await tick(fx.engine, project);
    assertUnknownQuarantine(fx, project, two.run.id, { outcome: 'stopped', blocker: 'any' });
    assert.equal(other.alive(), true, "a process under another scope's path is untouched");
    assert.equal(workItem(fx.home, two.item).status !== 'held', true, 'the work is not released');
  });

  test('(h) a daemon re-exec of the user manager during a run: the role survives and the run completes; the manager_unreachable fault while the role lives, then lifted: unknown and quarantined, then populated 1 keeps the quarantine until the role is gone', async (t) => {
    const fx = await sandboxEngine(t, { config: GRACE });
    const project = (await addProject(fx)).id;
    const first = await addWork(fx.engine, project, 'verification');
    const held = await roleHolding(fx, project, first, { on_term: 'exit', after: [step.result()] });
    daemonReexec();
    await sleep(1500);
    assert.equal(roleAlive(held.domain, held.launch), true, "the role's process survived the manager's re-exec");
    assert.equal(populated(held.domain.cgroup_path), 1);
    assert.equal((await fx.engine.get('/v1/health')).status, 200, 'the engine survived it');
    fx.scripted.release(first);
    await waitForRunState(fx.home, held.run.id, 'ended');
    assertRunEnded(fx.home, held.run.id, { outcome: 'completed', launched: true, recovery: false });
    await waitForWork(fx.home, first, 'complete');

    const second = await addWork(fx.engine, project, 'verification');
    const { run, domain, launch } = await roleHolding(fx, project, second, { on_term: 'exit' });
    await armFault(fx.engine, { point: 'manager_unreachable', times: 1_000_000 });
    await stopRun(fx.engine, project, run.id);
    await waitForQuarantine(fx.home, run.id, { timeoutMs: 30_000 });
    assertUnknownQuarantine(fx, project, run.id, { outcome: 'stopped' });
    assert.equal(roleAlive(domain, launch), true, 'under the fault nothing was signalled');
    await clearFaults(fx.engine);
    await tick(fx.engine, project);
    const kept = assertUnknownQuarantine(fx, project, run.id, { outcome: 'stopped', blocker: 'any' });
    assert.equal(roleAlive(domain, launch), true, 'lifted, the next tick observed populated 1 and kept the quarantine; the role is alive');
    assert.equal(populated(domain.cgroup_path), 1);
    assert.equal(kept.domains[0].observation, 'unknown', 'a manager restart is never evidence that domains died');
    fx.scripted.release(second);
    for (let i = 0; i < 20 && populated(domain.cgroup_path) !== 0; i++) await sleep(500);
    assert.equal(populated(domain.cgroup_path), 0, 'the fixture is live: the role exited by itself and the domain is empty');
    await tick(fx.engine, project);
    await assertClearedOnce(fx, project, run.id, 'stopped');
    await waitForWork(fx.home, second, 'held');
  });

  test('(h) [not_exercised] a real stop of the user manager: it ends the login session the tests run in and needs privilege to restore (plan question 6, E59 item 5)', () => {
    assert.equal(unprivileged(), true, `the tests run without privilege (euid ${process.geteuid()}, CapEff ${capEff()}): the real stop is not made; a daemon re-exec and the manager_unreachable fault stand in`);
    assert.ok(process.env.XDG_RUNTIME_DIR, 'the tests themselves run in the login session a stop would end');
  });
});
