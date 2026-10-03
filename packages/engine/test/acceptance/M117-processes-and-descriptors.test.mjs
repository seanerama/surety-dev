// M117, the role's view of processes and descriptors (M2 slice 11, sandbox
// lane). M2 plan §3.3 M117; D2 §2.2, §2.3, A.6 P13, P14 (D2-I10); AR P13,
// P14; SEAM.md §§122, 127.
//
// A role that signals every pid it can see and calls kill(-1, SIGKILL)
// kills its own child and nothing else: a host sentinel survives, the init
// still answers (it relays the role's result and exit, and the run ends
// normally), the engine survives; the init's descriptors are unreadable and
// no abstract socket but the role's own is in its network namespace; after
// exec the role has no capability, no_new_privs, uid 1000, no descriptor
// but its own beyond 0 to 2, and cannot mount; it can write its workspace.
// Whether a new user namespace can be created inside is not pinned (AR P14).
//
// Every case here is expected to fail on the engine these tests were
// written against, which has no sandbox (COVERAGE.md, "M2 slice 11"). On
// that engine case (a), as first written, ran its kill storm on the host
// and ended every process of the user; it is now held behind a host-side
// check and a guard in the role program (see the note above the case).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { addProject, addWork, assertRunEnded, runsOf, tick, waitForWork } from './harness/runs.mjs';
import { cgroupOfPid } from './harness/sandbox/cgroup.mjs';
import { domainOf, roleHolding, sandboxEngine } from './harness/sandbox/lane.mjs';
import { hostSentinel } from './harness/sandbox/sentinel.mjs';
import { hostPidNamespace, pidNamespaceOf, script, step } from './harness/scripted.mjs';

// One scripted verification run through to completion, with the probe
// actions given; returns the run and the probe entries by action.
async function probedRun(fx, project, actions) {
  const item = await addWork(fx.engine, project, 'verification');
  fx.scripted.script(item, [script.complete(actions)]);
  await tick(fx.engine, project);
  await waitForWork(fx.home, item, 'complete');
  const [run] = runsOf(fx.home, item);
  assertRunEnded(fx.home, run.id, { outcome: 'completed', reason_class: 'none', launched: true, recovery: false });
  const [launch] = fx.scripted.launches({ run: run.id });
  const probes = Object.fromEntries(fx.scripted.probes(launch.invocation).map((p) => [p.action, p]));
  return { item, run, launch, probes };
}

describe("M117 the role's view of processes and descriptors", () => {
  // SAFETY (SEAM.md §127, "The guard"; COVERAGE.md, "M2 slice 11", "The
  // incident"). The role's action here kills every process it can see. It
  // is harmless only inside a sandbox's own pid namespace, so the role holds
  // before it and the test releases it only after it has seen, from the
  // host, that the role's process is a member of the domain's cgroup and in
  // a pid namespace other than the host's. On an engine that launches the
  // role without a sandbox the case fails there and the action never runs;
  // the role program refuses it as well, by its own check.
  test('(a) P13: the role signals every pid it sees and calls kill(-1, SIGKILL): the host sentinel survives, the init still answers and the run ends normally, the engine survives; control: the role killed its own child', async (t) => {
    const fx = await sandboxEngine(t);
    const sentinel = hostSentinel(t);
    const hostNs = hostPidNamespace();
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    // roleHolding finds the role's host process in the domain's cgroup by
    // its marker and NSpid; it throws where there is no such domain.
    const { run, domain, launch, member } = await roleHolding(fx, project, item, { name: 'armed', after: [step.signalAll(hostNs), step.result()] });
    assert.ok(domain.cgroup_path && cgroupOfPid(member.pid) === domain.cgroup_path, 'host-read: the role is a member of its domain\'s cgroup');
    assert.ok(member.nspid.length >= 2, `host-read: the role has a pid of its own in an inner pid namespace (NSpid ${member.nspid.join(' ')})`);
    const roleNs = pidNamespaceOf(member.pid);
    assert.ok(roleNs !== null && /^pid:\[\d+\]$/.test(roleNs), `host-read: the role's pid namespace can be read (${roleNs})`);
    assert.notEqual(roleNs, hostNs, 'host-read: the role is not in the host\'s pid namespace; only now is it released into the action');

    fx.scripted.release(item, 'armed');
    await waitForWork(fx.home, item, 'complete');
    assertRunEnded(fx.home, run.id, { outcome: 'completed', reason_class: 'none', launched: true, recovery: false });
    const [p] = fx.scripted.probes(launch.invocation, 'signal_all');
    assert.ok(p, 'the role ran the probe');
    assert.equal(p.outcome, 'ran', `the role program's own guard let it run inside the sandbox (${JSON.stringify(p.guard)})`);
    assert.ok(p.seen.includes(1), `the role sees the init as pid 1 (it saw ${p.seen.join(', ')})`);
    assert.equal(p.control.exit?.signal, 'SIGKILL', `control: the role's own child was killed (${JSON.stringify(p.control)})`);
    assert.equal(sentinel.alive(), true, 'host-witnessed: the sentinel outside every domain survived');
    assert.equal(fx.engine.isRunning(), true, 'the engine survived');
    assert.equal((await fx.engine.get('/v1/health')).status, 200, 'and answers');
    assert.equal(domainOf(fx.home, run.id).status, 'terminated', 'the init relayed the result and the exit after the kill storm: the run ended normally');
    assert.ok(!p.seen.some((pid) => pid === sentinel.pid), 'the sentinel\'s host pid is not what the role saw (a separate pid namespace)');
  });

  test("(b) the init's control channel: /proc/1/fd is unreadable; no abstract socket but the role's own in its network namespace", async (t) => {
    const fx = await sandboxEngine(t);
    const project = (await addProject(fx)).id;
    const { probes } = await probedRun(fx, project, [step.probe('init_fd'), step.probe('net_unix')]);
    const fd = probes.init_fd;
    assert.equal(fd.outcome, 'refused', `/proc/1/fd cannot be listed by the role (${JSON.stringify(fd)})`);
    assert.equal(fd.error, 'EACCES');
    const unix = probes.net_unix;
    assert.ok(unix.own.startsWith('surety-probe-'), 'the role listened on an abstract socket of its own');
    const abstract = unix.net_unix.filter((l) => /\s@\S+$/.test(l)).map((l) => l.trim().split(/\s+/).at(-1));
    assert.deepEqual(abstract, [`@${unix.own}`], `the only abstract socket in the role's network namespace is its own (${abstract.join(', ')})`);
  });

  test('(c) P14: after exec the role has CapEff 0, NoNewPrivs 1, uid 1000, no descriptor of anyone else beyond 0 to 2, and mount is refused; control: it writes and reads its workspace', async (t) => {
    const fx = await sandboxEngine(t);
    const project = (await addProject(fx)).id;
    const { probes } = await probedRun(fx, project, [
      step.probe('self_status'),
      step.write('p14.txt', 'written by the role'),
      step.probe('read_back', { path: 'p14.txt' }),
      step.probe('mount_attempt', { target: 'p14-mount' }),
    ]);
    const s = probes.self_status;
    assert.match(s.cap_eff, /^0+$/, `CapEff is all zero (${s.cap_eff})`);
    assert.equal(s.no_new_privs, '1', 'NoNewPrivs is 1');
    assert.deepEqual(s.uid.split(/\s+/), ['1000', '1000', '1000', '1000'], `uid 1000 in every position (${s.uid})`);
    const own = Object.entries(s.fds).filter(([fd]) => Number(fd) > 2);
    assert.ok(own.length > 0, 'the fixture is live: the runtime opened descriptors of its own');
    const pipeEnds = Object.values(s.fds).filter((v) => v.startsWith('pipe:'));
    const stdPipes = new Set(['0', '1', '2'].map((fd) => s.fds[fd]).filter((v) => v?.startsWith('pipe:')));
    const foreign = own.filter(([, target]) => {
      if (target.startsWith('anon_inode:')) return false;
      if (target === '/dev/null' || target === '/dev/urandom' || target === '/dev/random') return false;
      if (target.startsWith('unreadable:')) return false;
      if (target.startsWith('pipe:')) return !(pipeEnds.filter((v) => v === target).length >= 2 || stdPipes.has(target));
      return true;
    });
    assert.deepEqual(foreign, [], `no descriptor beyond 0 to 2 is inherited: every other one is the runtime's own (${JSON.stringify(s.fds)})`);
    const m = probes.mount_attempt;
    assert.notEqual(m.status, 0, `mount is refused (status ${m.status}: ${m.stderr})`);
    assert.equal(m.mounted, false, 'nothing was mounted');
    assert.equal(probes.read_back.outcome, 'read', 'control: the role writes its workspace');
    assert.equal(probes.read_back.content, 'written by the role');
  });
});
