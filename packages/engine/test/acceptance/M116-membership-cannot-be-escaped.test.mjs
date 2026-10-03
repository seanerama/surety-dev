// M116, membership cannot be escaped; no migration; a daemon dies with the
// domain (M2 slice 11, sandbox lane). M2 plan §3.3 M116; D2 §3.1, §4.4, A.6
// P15, P16 (D2-B01, D2-B02, D2-T07, D2-B01-OBS); AR B01, P15, P16; E57;
// SEAM.md §§122, 126, 127.
//
// A descendant that setsid()s, clears its environment and double-forks is
// still a member of the domain's cgroup, host-witnessed, and after
// cgroup.kill it never writes its witness file again; a role that starts
// such a daemon and exits 0 does not end the run at its exit: the run
// completes only after the cgroup reads populated 0, and nothing is ever
// open_idle; in the probe profile a write of the role's pid into a real
// sibling cgroup is refused and the host still sees the pid in the domain,
// and in the role profile no cgroupfs is mounted. The observer case reports
// not_exercised on this host.
//
// Every case here but (d) is expected to fail on the engine these tests
// were written against, which has no sandbox and no cgroup boundary
// (COVERAGE.md, "M2 slice 11").

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { waitFor } from './harness/engine.mjs';
import { newId } from './harness/ids.mjs';
import { addProject, addWork, assertRunEnded, runsOf, stopRun, tick, waitForRun, waitForRunState, waitForWork } from './harness/runs.mjs';
import { cgroupExists, cgroupOfPid, populated, procsOf, waitCgroupGone } from './harness/sandbox/cgroup.mjs';
import { checkOf, domainOf, domainRow, eventsOf, hostSection, receiptOf, roleHolding, roleProcess, sandboxEngine, scopeOf, terminalObservation } from './harness/sandbox/lane.mjs';
import { hostProcess, memberByInnerPid } from './harness/sandbox/procs.mjs';
import { script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const seqOf = (events) => events[0]?.seq ?? null;

// The daemon as the role logged it and as the host sees it in the domain.
async function daemonWitnessed(fx, domain, launch, name) {
  const daemon = await waitFor(() => fx.scripted.daemons(launch.invocation).find((d) => d.name === name), { what: `the role to log its daemon ${name}` });
  assert.equal(daemon.ready, true, 'the daemon reported ready');
  assert.equal(daemon.daemon_session, daemon.daemon_pid, 'the daemon leads its own session (setsid) as it sees itself');
  assert.equal(daemon.daemon_env_count, 0, 'its environment is empty as it sees it');
  assert.notEqual(daemon.daemon_parent, launch.pid, 'its parent is not the role: it was double-forked');
  const host = await waitFor(() => memberByInnerPid(domain.cgroup_path, daemon.daemon_pid), { what: `the daemon (pid ${daemon.daemon_pid} in the sandbox) as a member of ${domain.cgroup_path}` });
  assert.equal(host.environ?.size ?? null, 0, `host-read: /proc/${host.pid}/environ is empty (${host.environ === null ? host.environError : [...host.environ.keys()].join(', ')})`);
  assert.equal(host.session, host.pid, `host-read: its session id is its own pid (session ${host.session}, pid ${host.pid})`);
  assert.equal(cgroupOfPid(host.pid), domain.cgroup_path, 'host-read: its cgroup is the domain');
  assert.ok(host.cmdline.some((a) => a === 'daemon'), `it is the daemon process (${host.cmdline.join(' ')})`);
  return { daemon, host };
}

// The witness file grows while the daemon lives, and never again after.
async function assertPinging(fx, name) {
  const n = fx.scripted.pings(name).length;
  await waitFor(() => (fx.scripted.pings(name).length > n ? true : undefined), { what: `daemon ${name} to keep writing its witness file` });
}
async function assertStoppedPinging(fx, name) {
  await sleep(500);
  const n = fx.scripted.pings(name).length;
  await sleep(1500);
  assert.equal(fx.scripted.pings(name).length, n, `after cgroup.kill the witness file of ${name} is never written again`);
}

describe('M116 membership cannot be escaped', () => {
  test('(a) P16: a descendant that setsid()s, clears its environment and double-forks is a member before the kill (host-read: empty environ, its own session); after cgroup.kill populated 0 and its witness file is never written again; the run ends with closure', async (t) => {
    const fx = await sandboxEngine(t);
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const { run, domain, launch } = await roleHolding(fx, project, item, { on_term: 'exit', before: [step.daemon('p16', { on_term: 'ignore', ping_ms: 100 })] });
    const { host } = await daemonWitnessed(fx, domain, launch, 'p16');
    await assertPinging(fx, 'p16');

    await stopRun(fx.engine, project, run.id);
    await waitForRunState(fx.home, run.id, 'ended', { timeoutMs: 40_000 });
    assertRunEnded(fx.home, run.id, { outcome: 'stopped', reason_class: 'human_stop', launched: true, recovery: false });
    assert.equal(hostProcess(host.pid), null, 'the daemon, which ignored TERM and had escaped the role\'s session and environment, is gone with the domain');
    await waitCgroupGone(domain.cgroup_path);
    await assertStoppedPinging(fx, 'p16');
    const closed = seqOf(eventsOf(fx.home, 'domain', domain.id, 'domain.launch_closed'));
    const terminated = seqOf(eventsOf(fx.home, 'domain', domain.id, 'domain.terminated'));
    assert.ok(closed !== null && terminated !== null && closed < terminated, `closure (${closed}) before termination (${terminated})`);
    await waitForWork(fx.home, item, 'held');
  });

  test('(b) a role that starts such a daemon and exits 0 with a valid result: the daemon is a member, the run completes only after populated 0 with closure, exit class clean; no open_idle anywhere', async (t) => {
    const fx = await sandboxEngine(t);
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const { run, domain, launch } = await roleHolding(fx, project, item, { on_term: 'exit', before: [step.daemon('p16b', { on_term: 'ignore', ping_ms: 100 })], after: [step.result()] });
    const { host } = await daemonWitnessed(fx, domain, launch, 'p16b');
    await assertPinging(fx, 'p16b');
    fx.scripted.release(item);
    await waitFor(() => fx.scripted.eventsOfInvocation(launch.invocation, 'exit').some((e) => e.code === 0), { what: 'the role to exit 0' });

    await waitForRunState(fx.home, run.id, 'ended', { timeoutMs: 40_000 });
    assertRunEnded(fx.home, run.id, { outcome: 'completed', reason_class: 'none', launched: true, recovery: false });
    const terminal = terminalObservation(fx.home, receiptOf(fx.home, run.id).id);
    assert.equal(terminal.exit_class, 'clean', `the role's exit is clean (${JSON.stringify(terminal)})`);
    assert.equal(terminal.exit_evidence.status, 0);
    assert.equal(hostProcess(host.pid), null, 'the daemon died with the domain');
    await waitCgroupGone(domain.cgroup_path);
    await assertStoppedPinging(fx, 'p16b');
    const terminated = seqOf(eventsOf(fx.home, 'domain', domain.id, 'domain.terminated'));
    const ended = seqOf(eventsOf(fx.home, 'run', run.id, 'run.ended'));
    assert.ok(terminated < ended, `completed only after the domain was observed terminated (${terminated} < ${ended})`);
    assert.equal(domainRow(fx.home, domain.id).launch_state, 'closed');
    withStore(fx.home, (db) => {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM "turns"`).get().n, 0, 'no turn exists: sessions are refused');
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM "events" WHERE "type" LIKE '%open_idle%' OR "payload" LIKE '%open_idle%'`).get().n, 0, 'open_idle is claimed nowhere');
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM "runs" WHERE "state" = 'open_idle'`).get().n, 0);
    });
    await waitForWork(fx.home, item, 'complete');
  });

  test("(c) P15 in the probe profile: the role's write of its pid into the sibling's cgroup.procs is refused and the host still sees the pid in the domain; control: the host sees the probe pid in the domain; in the role profile the mount table has no cgroup2 entry", async (t) => {
    const fx = await sandboxEngine(t);
    const scope = await scopeOf(fx);
    const project = (await addProject(fx)).id;
    const res = await fx.engine.post('/v1/harness/fixtures/trigger', { project, kind: 'verification', trigger_source: 'test', trigger_id: newId('trg_'), trigger_generation: 1, profile: 'probe' });
    assert.equal(res.status, 201, `a trigger with profile probe (body: ${res.text})`);
    const item = res.body.work_item.id;
    fx.scripted.script(item, [{ steps: [step.probe('mountinfo'), step.probe('cgroup_migrate', { to: '/surety/cgroup/sibling' }), step.hold('gate'), step.result()] }]);
    await tick(fx.engine, project);
    const launch = await fx.scripted.waitForHolding({ work_item: item });
    const run = await waitForRun(fx.home, item, { state: 'executing' });
    const domain = domainOf(fx.home, run.id);
    assert.equal(domain.profile, 'probe', 'the domain runs under the probe profile');
    const member = await roleProcess(fx, domain, launch);
    const sibling = join(scope.path, `sibling_${domain.id}`);
    assert.ok(cgroupExists(sibling), `the sibling cgroup exists beside the domain (${sibling})`);

    const [mounts] = fx.scripted.probes(launch.invocation, 'mountinfo');
    const cgroupMounts = mounts.mountinfo.filter((l) => / - cgroup2 /.test(l));
    for (const at of ['/surety/cgroup/domain', '/surety/cgroup/sibling']) assert.ok(cgroupMounts.some((l) => l.split(' ')[4] === at), `the probe profile binds a cgroup2 directory at ${at} (cgroup2 mounts: ${cgroupMounts.join(' | ') || 'none'})`);
    const [migrate] = fx.scripted.probes(launch.invocation, 'cgroup_migrate');
    assert.equal(migrate.outcome, 'refused', `the migration is refused (${JSON.stringify(migrate)})`);
    assert.ok(typeof migrate.error === 'string' && migrate.error.length > 0, `with an error (${migrate.error})`);
    assert.equal(migrate.before, migrate.after, "the role's own cgroup is unchanged as it sees it");
    assert.ok(procsOf(domain.cgroup_path).includes(member.pid), 'control and negative, host-read: the role\'s pid is in the domain');
    assert.deepEqual(procsOf(sibling), [], 'and not in the sibling');
    assert.equal(populated(sibling), 0);
    fx.scripted.release(item);
    await waitForRunState(fx.home, run.id, 'ended');
    assertRunEnded(fx.home, run.id, { outcome: 'completed', launched: true });
    await waitCgroupGone(sibling);

    // The role profile: no cgroupfs in the mount table.
    const plain = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(plain, [script.complete([step.probe('mountinfo')])]);
    await tick(fx.engine, project);
    await waitForWork(fx.home, plain, 'complete');
    const [plainRun] = runsOf(fx.home, plain);
    assert.equal(domainOf(fx.home, plainRun.id).profile, 'role');
    const [plainLaunch] = fx.scripted.launches({ run: plainRun.id });
    const [plainMounts] = fx.scripted.probes(plainLaunch.invocation, 'mountinfo');
    assert.ok(plainMounts.mountinfo.length > 0, 'the fixture is live: the role read its mount table');
    assert.deepEqual(plainMounts.mountinfo.filter((l) => /cgroup/.test(l)), [], 'in the role profile no cgroupfs is mounted');
  });

  test('(d) [not_exercised] attribution with the observer: H13 is not exercised on this host and no observer evidence exists', async (t) => {
    const fx = await sandboxEngine(t);
    const h13 = checkOf(hostSection(await fx.engine.engineInfo()), 'H13');
    assert.equal(h13.result, 'not_exercised', `the observer is not exercised on this host (${h13.observed})`);
    assert.ok(typeof h13.observed === 'string' && h13.observed.length > 0, 'and the engine says why');
    assert.deepEqual(withStore(fx.home, (db) => db.prepare(`SELECT "id" FROM "records" WHERE "kind" = 'qualification_evidence'`).all()), [], 'no observer evidence envelope exists');
  });
});
