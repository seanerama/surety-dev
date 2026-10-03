// M112, placement and launch authorization (M2 slice 11, sandbox lane). M2
// plan §3.3 M112; D2 §3.2, K1, A.3 to A.5 (D2-B03, D2-B03-OBS); AR B01;
// E57; SEAM.md §§122, 125, 126.
//
// A domain becomes launched only when its launcher, placed in the domain's
// cgroup, holds an authorization bound to the domain, the invocation, the
// incarnation and the lease generation; a stale lease, a confirmed Stop and
// an engine that died and was restarted each refuse the grant, and the
// launcher then runs nothing of the role; a launcher killed before placement
// never launches the domain; ownership's containment_id is the cgroup path.
// The optional observer case reports not_exercised on this host (H13).
//
// Every case here but (g) is expected to fail on the engine these tests
// were written against, which has no launcher (COVERAGE.md, "M2 slice 11").

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { CONTRACT } from './harness/fixtures.mjs';
import { releaseBarrier, waitFor } from './harness/engine.mjs';
import { addProject, addWork, advanceClock, assertRunEnded, leasesOf, requestTick, runsOf, stopRun, tick, waitForRun, waitForRunState, waitForWork, workItem } from './harness/runs.mjs';
import { cgroupExists, cgroupOfPid, populated, procsOf, waitCgroupGone, waitPopulated } from './harness/sandbox/cgroup.mjs';
import { assertEngineInScope, checkOf, domainOf, domainRow, eventsOf, hostSection, ownershipOf, receiptOf, roleProcess, sandboxEngine, scopeOf, waitForEvent } from './harness/sandbox/lane.mjs';
import { hostProcess, members, scriptedMembers } from './harness/sandbox/procs.mjs';
import { script } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const LEASE_TTL = CONTRACT.engine.lease_ttl.min;
// Long enough to release a paused launcher during the grace, so that its
// request's refusal is what ends the domain, not the kill (SEAM.md §125).
const LONG_GRACE = { terminate_grace: 20, kill_grace: 2, lease_ttl: LEASE_TTL };

const runLease = (home, runId) => leasesOf(home, runId).find((l) => l.resource_kind === 'run');

// Dispatch one verification item with the launcher paused at `barrier`.
async function launcherPausedAt(fx, barrier, { project, item } = {}) {
  project ??= (await addProject(fx)).id;
  item ??= await addWork(fx.engine, project, 'verification');
  fx.scripted.script(item, [script.holdThenComplete('gate')]);
  await requestTick(fx.engine, project);
  await fx.engine.waitUntil(`barrier:${barrier}`);
  const run = await waitForRun(fx.home, item);
  const domain = domainOf(fx.home, run.id);
  assert.ok(domain, 'the run has a domain');
  assert.ok(domain.cgroup_path, 'the domain has a cgroup path');
  return { project, item, run, domain };
}

// The grant was never given: no domain.launch_authorized, the launch state
// never authorized, the launcher gone from the domain, no role ever
// launched, the receipt refused.
function assertGrantRefused(fx, run, domain, what) {
  assert.deepEqual(eventsOf(fx.home, 'domain', domain.id, 'domain.launch_authorized'), [], `${what}: no domain.launch_authorized`);
  const row = domainRow(fx.home, domain.id);
  assert.equal(row.launch_state, 'closed', `${what}: the launch is closed (${row.launch_state})`);
  assert.equal(row.launch_binding, null, `${what}: no binding was ever written`);
  assert.equal(row.status, 'terminated', `${what}: the domain is terminated`);
  assert.equal(cgroupExists(domain.cgroup_path), false, `${what}: the domain directory is removed`);
  assert.deepEqual(fx.scripted.launches({ run: run.id }), [], `${what}: no scripted launch was recorded`);
  assert.deepEqual(fx.scripted.killStrays(), [], `${what}: no role process of this fixture is alive`);
  const receipt = receiptOf(fx.home, run.id);
  const statuses = withStore(fx.home, (db) => db.prepare('SELECT "status" FROM "invocation_status_observations" WHERE "invocation" = ? ORDER BY "seq"').all(receipt.id)).map((s) => s.status);
  assert.deepEqual(statuses, ['dispatch_started', 'refused'], `${what}: a run never authorized is recorded refused, never launched`);
}

describe('M112 placement and launch authorization', () => {
  test('(a) normal, paused at launcher.placed: the domain is authorizable with cgroup_path and placed_at, the launcher alone in the cgroup, no role; released, domain.launch_authorized binds invocation, incarnation and lease generation, the domain is launched and the role runs; (f) containment_id is the cgroup path', async (t) => {
    const fx = await sandboxEngine(t, { barriers: ['launcher.placed=pause'] });
    const scope = await scopeOf(fx);
    const { project, item, run, domain } = await launcherPausedAt(fx, 'launcher.placed');

    assert.equal(domain.status, 'allocated', 'the domain is allocated, not launched');
    assert.equal(domain.launch_state, 'authorizable', 'authorizable');
    assert.match(domain.id, /^dom_/, 'a domain id carries the dom_ prefix');
    assert.equal(domain.cgroup_path, join(scope.path, domain.id), 'cgroup_path is <scope_cgroup>/<domain id>: the child cgroup dom_<ULID> of D2 §3.1');
    assert.ok(domain.placed_at, 'placed_at is set');
    assert.equal(domain.launch_authorized_at, null);
    const placed = eventsOf(fx.home, 'domain', domain.id, 'domain.placed');
    assert.equal(placed.length, 1, 'one domain.placed');
    assert.equal(placed[0].payload.cgroup_path, domain.cgroup_path, 'domain.placed names the cgroup path');
    const pids = procsOf(domain.cgroup_path);
    assert.equal(pids.length, 1, `the launcher's pid is the only one in cgroup.procs (${pids.join(', ')})`);
    assert.equal(cgroupOfPid(pids[0]), domain.cgroup_path, "the launcher's /proc/<pid>/cgroup names the domain");
    assert.equal(placed[0].payload.launcher_pid, pids[0], 'domain.placed names the launcher');
    assert.deepEqual(scriptedMembers(domain.cgroup_path, 'child.mjs'), [], 'no role process exists before the grant');
    assert.deepEqual(fx.scripted.launches({ run: run.id }), [], 'no scripted launch yet');
    assert.equal((await waitForRun(fx.home, item)).state, 'claimed', 'the run is claimed until the grant');
    const lease = runLease(fx.home, run.id);
    const info = await fx.engine.engineInfo();

    await releaseBarrier(fx.engine, 'launcher.placed');
    const [authorized] = await waitForEvent(fx.home, 'domain', domain.id, 'domain.launch_authorized');
    const binding = { invocation: receiptOf(fx.home, run.id).id, incarnation: info.incarnation, lease_generation: lease.generation };
    assert.deepEqual(authorized.payload.launch_binding, binding, 'the authorization binds the current invocation, incarnation and lease generation');
    const after = domainRow(fx.home, domain.id);
    assert.deepEqual([after.status, after.launch_state, after.launch_binding], ['launched', 'authorized', binding]);
    assert.ok(after.launch_authorized_at, 'launch_authorized_at is set');
    const launch = await fx.scripted.waitForHolding({ work_item: item });
    const member = await roleProcess(fx, domain, launch);
    assert.equal(cgroupOfPid(member.pid), domain.cgroup_path, 'the role runs in the domain');
    assert.equal((await waitForRunState(fx.home, run.id, 'executing')).state, 'executing');

    // (f) ownership: the launcher's host process, contained by the cgroup path.
    const own = ownershipOf(fx.home, domain.id);
    assert.equal(own.containment_id, domain.cgroup_path, '(f) process_ownership.containment_id is the cgroup path');
    assert.equal(own.pid, pids[0], "(f) ownership's pid is the launcher's host pid");
    assert.ok(procsOf(domain.cgroup_path).includes(own.pid), '(f) that process is a member of the domain while the role runs');
    assert.equal(String(own.pid_start_time), hostProcess(own.pid).startTime, '(f) its start time is recorded');

    fx.scripted.release(item);
    await waitForRunState(fx.home, run.id, 'ended');
    assertRunEnded(fx.home, run.id, { outcome: 'completed', launched: true, recovery: false });
    await waitForWork(fx.home, item, 'complete');
    void project;
  });

  test('(b) a stale lease generation: the clock expires the lease while the launcher waits before authorization; released, the grant is refused and the launcher exits having run nothing; a tick ends the run recovered', async (t) => {
    const fx = await sandboxEngine(t, { barriers: ['launcher.before_authorization=pause'], config: LONG_GRACE });
    const { project, item, run, domain } = await launcherPausedAt(fx, 'launcher.before_authorization');
    assert.equal(populated(domain.cgroup_path), 1, 'the launcher is placed');
    await advanceClock(fx.engine, LEASE_TTL + 1);
    const lease = runLease(fx.home, run.id);
    assert.ok(Date.parse(lease.expires_at) < Date.now() + (LEASE_TTL + 1) * 1000, 'the fixture is live: the lease has expired on the controlled clock');

    await releaseBarrier(fx.engine, 'launcher.before_authorization');
    await waitPopulated(domain.cgroup_path, 0);
    assert.deepEqual(eventsOf(fx.home, 'domain', domain.id, 'domain.launch_authorized'), [], 'an expired lease is not current: no grant');
    await tick(fx.engine, project);
    await waitForRunState(fx.home, run.id, 'ended');
    assertRunEnded(fx.home, run.id, { outcome: 'recovered', reason_class: 'recovered', launched: false, recovery: false });
    assertGrantRefused(fx, run, domain, '(b)');
    assert.equal((await waitForWork(fx.home, item, 'held')).status, 'held');
  });

  test('(c) a Stop confirmed while the launcher waits before authorization: the launch is closed, the released launcher\'s request is refused, it exits having run nothing, the run ends stopped', async (t) => {
    const fx = await sandboxEngine(t, { barriers: ['launcher.before_authorization=pause'], config: LONG_GRACE });
    const { project, item, run, domain } = await launcherPausedAt(fx, 'launcher.before_authorization');
    const stoppedAt = performance.now();
    await stopRun(fx.engine, project, run.id);
    await waitForEvent(fx.home, 'domain', domain.id, 'domain.launch_closed');
    assert.equal(domainRow(fx.home, domain.id).launch_state, 'closed', 'closed before anything else');
    assert.equal(members(domain.cgroup_path).length, 1, 'the paused launcher is still a member when released (it is not ended by TERM)');

    await releaseBarrier(fx.engine, 'launcher.before_authorization');
    await waitForRunState(fx.home, run.id, 'ended');
    assert.ok(performance.now() - stoppedAt < LONG_GRACE.terminate_grace * 1000, 'the refusal ended the domain well before the kill would have');
    assertRunEnded(fx.home, run.id, { outcome: 'stopped', reason_class: 'human_stop', launched: false, recovery: false });
    assertGrantRefused(fx, run, domain, '(c)');
    await waitForWork(fx.home, item, 'held');
  });

  test('(d) the engine killed while the launcher waits before authorization, restarted, the launcher then released: recovery closes the domain, the request is refused, no domain.launch_authorized, no role process', async (t) => {
    const fx = await sandboxEngine(t, { barriers: ['launcher.before_authorization=pause'], config: LONG_GRACE });
    const { item, run, domain } = await launcherPausedAt(fx, 'launcher.before_authorization');
    const [launcherPid] = procsOf(domain.cgroup_path);
    await fx.engine.kill();
    assert.equal(hostProcess(launcherPid) !== null, true, 'the fixture is live: the paused launcher outlived its engine');

    // The restart lists the waiting launcher's barrier (its wait survives
    // the engine) and recovery closes the domain before any signal.
    const engine = await fx.start({ until: 'listening' });
    await waitFor(
      async () => {
        const res = await engine.get('/v1/harness/barriers');
        return res.status === 200 && res.body.barriers.some((b) => b.name === 'launcher.before_authorization' && b.state === 'waiting') ? true : undefined;
      },
      { what: "the new incarnation to list the old launcher's barrier as waiting" },
    );
    await waitForEvent(fx.home, 'domain', domain.id, 'domain.launch_closed');
    assert.equal(hostProcess(launcherPid) !== null, true, 'the launcher is alive when released, after the closure');
    await releaseBarrier(engine, 'launcher.before_authorization');
    await engine.waitUntil('full');
    const info = await engine.engineInfo();
    await waitForRunState(fx.home, run.id, 'ended');
    assertRunEnded(fx.home, run.id, { outcome: 'recovered', reason_class: 'recovered', launched: false, recovery: info.incarnation });
    assertGrantRefused(fx, run, domain, '(d)');
    assert.equal(hostProcess(launcherPid), null, 'the launcher is gone');
    await waitForWork(fx.home, item, 'held');
  });

  test('(e) a launcher killed before placement: the domain is never launched, the run ends failed and is repaired', async (t) => {
    const fx = await sandboxEngine(t, { barriers: ['launcher.before_placement=pause'] });
    const scope = await assertEngineInScope(fx);
    const { project, item, run, domain } = await launcherPausedAt(fx, 'launcher.before_placement');
    const launchers = procsOf(scope.supervisor).filter((p) => p !== fx.engine.pid);
    assert.equal(launchers.length, 1, `the launcher waits in the supervisor leaf (members: ${procsOf(scope.supervisor).join(', ')})`);
    assert.equal(populated(domain.cgroup_path), 0, 'the domain is not populated before placement');
    process.kill(launchers[0], 'SIGKILL');
    const res = await fx.engine.post('/v1/harness/barriers/launcher.before_placement/release', {});
    assert.ok([200, 404, 409].includes(res.status), `releasing a dead launcher's barrier is a no-op (${res.status} ${res.text})`);

    await waitForRunState(fx.home, run.id, 'ended');
    assertRunEnded(fx.home, run.id, { outcome: 'failed', reason_class: 'infra_error', launched: false, recovery: false });
    assert.deepEqual(eventsOf(fx.home, 'domain', domain.id, 'domain.placed'), [], 'never placed');
    assertGrantRefused(fx, run, domain, '(e)');
    await waitCgroupGone(domain.cgroup_path);

    // Repaired like any failed run (SEAM.md §§15, 125). The repair run's role
    // is the item's first scripted launch, since the killed launcher's run
    // launched none, so it follows the item's first script and holds at the
    // gate (objection 004): the case reads it there, in a domain of its own,
    // placed and authorized, and then lets it finish.
    await tick(fx.engine, project);
    const repairLaunch = await fx.scripted.waitForHolding({ work_item: item });
    const repair = await waitForRun(fx.home, item, { index: 1, state: 'executing' });
    assert.equal(repairLaunch.run, repair.id, 'the role that holds is the repair run\'s');
    assert.equal(repairLaunch.launch_index, 0, "it is the item's first scripted launch: the run whose launcher was killed launched no role");
    assert.equal(fx.scripted.launches({ work_item: item }).length, 1, 'one scripted launch for the item, the repair\'s');
    const repairDomain = domainOf(fx.home, repair.id);
    assert.notEqual(repairDomain.id, domain.id, 'the repair run has a domain of its own');
    assert.deepEqual([repairDomain.status, repairDomain.launch_state], ['launched', 'authorized'], 'placed and authorized like any launch');
    assert.equal(eventsOf(fx.home, 'domain', repairDomain.id, 'domain.placed').length, 1);
    assert.equal(eventsOf(fx.home, 'domain', repairDomain.id, 'domain.launch_authorized').length, 1);
    assert.equal((await roleProcess(fx, repairDomain, repairLaunch)).pid > 0, true, 'host-read: the repair role is a member of its domain');
    assert.equal(workItem(fx.home, item).repair_attempts, 1, 'the re-dispatch after the failed run is one repair attempt');
    assert.deepEqual(eventsOf(fx.home, 'domain', domain.id, 'domain.placed'), [], 'the first domain was still never placed');
    assert.equal(cgroupExists(domain.cgroup_path), false, 'and its directory stays gone');

    fx.scripted.release(item);
    await waitForWork(fx.home, item, 'complete');
    assertRunEnded(fx.home, repair.id, { outcome: 'completed', reason_class: 'none', launched: true, recovery: false });
    assert.equal(runsOf(fx.home, item).length, 2, 'the failed run and its one repair');
  });

  test('(g) [not_exercised] the observer\'s record of a late launcher: H13 is not exercised on this host and no observer evidence exists', async (t) => {
    const fx = await sandboxEngine(t);
    const h13 = checkOf(hostSection(await fx.engine.engineInfo()), 'H13');
    assert.equal(h13.result, 'not_exercised', `the observer is not exercised on this host (${h13.observed})`);
    assert.ok(typeof h13.observed === 'string' && h13.observed.length > 0, 'and the engine says why');
    const envelopes = withStore(fx.home, (db) => db.prepare(`SELECT "id" FROM "records" WHERE "kind" = 'qualification_evidence'`).all());
    assert.deepEqual(envelopes, [], 'no observer evidence envelope exists (no qualification_evidence record at all)');
  });
});
