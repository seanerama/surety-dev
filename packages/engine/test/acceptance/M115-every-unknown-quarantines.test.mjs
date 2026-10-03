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

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { armFault, clearFaults, waitFor } from './harness/engine.mjs';
import { recordsOf } from './harness/records.mjs';
import { addProject, addWork, answerDecision, assertRunEnded, assertRunQuarantined, requestTick, runsOf, stopRun, tick, waitForQuarantine, waitForRun, waitForRunState, waitForWork, workItem } from './harness/runs.mjs';
import { cgroupExists, cgroupOfPid, daemonReexec, makeLeaf, makeUnreadable, moveIntoCgroup, populated, procsOf, removeCgroup, restoreReadable, waitCgroupGone } from './harness/sandbox/cgroup.mjs';
import { assertEngineInScope, domainOf, eventsOf, roleAlive, roleHolding, sandboxEngine, updateDomain, waitForEvent } from './harness/sandbox/lane.mjs';
import { memberByInnerPid, waitHostGone } from './harness/sandbox/procs.mjs';
import { cgroupSentinel } from './harness/sandbox/sentinel.mjs';
import { script, step } from './harness/scripted.mjs';

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
// ended with its outcome, and the project free.
async function assertClearedOnce(fx, project, runId, outcome) {
  await waitForRunState(fx.home, runId, 'ended');
  const ended = assertRunEnded(fx.home, runId, { outcome, launched: true, recovery: false });
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
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(item, [script.complete()]);
    await requestTick(fx.engine, project);
    await fx.engine.waitUntil('barrier:launcher.before_placement');
    const run = await waitForRun(fx.home, item);
    const domain = domainOf(fx.home, run.id);
    await armFault(fx.engine, { point: 'launcher_wait' });
    await stopRun(fx.engine, project, run.id);
    await waitForQuarantine(fx.home, run.id, { timeoutMs: 30_000 });
    const facts = assertUnknownQuarantine(fx, project, run.id, { outcome: 'stopped' });
    assert.equal(facts.domains[0].status, 'quarantined');
    assert.deepEqual(fx.scripted.launches({ run: run.id }), [], 'no role was launched');
    const res = await fx.engine.post('/v1/harness/barriers/launcher.before_placement/release', {});
    assert.ok([200, 404, 409].includes(res.status), `the launcher is released (or is already gone): ${res.status}`);
    await tick(fx.engine, project);
    await assertClearedOnce(fx, project, run.id, 'stopped');
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
