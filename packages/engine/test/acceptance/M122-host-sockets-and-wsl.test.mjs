// M122, host sockets, the user bus, Docker, WSL interop and host mounts
// (M2 slice 12, sandbox lane). M2 plan §3.4 M122; D2 §2.3, §2.4, §6 H10,
// A.6 P9 to P12, P17 (D2-I08, D2-I09); Q3; AR P10, P11, P12, P17; E59 item
// 4; SEAM.md §§132, 133, 136, 141.
//
// A role reaches no socket of the host: a host abstract socket is in
// another network namespace, a pathname socket in a proposed read path
// refuses the plan, the user bus, the Docker socket, WSL's interop sockets
// and the host's /dev/shm are not in its view, `systemd-run --user` fails,
// a Windows executable that runs on the host does not run inside, and its
// mount table holds no 9p, DrvFs or virtiofs entry and no /mnt/c.
//
// Every endpoint is verified from the host first, by `stat` and without
// connecting to anything that is not the test's own; nothing a role prints
// is evidence by itself: the test's own sockets count their connections.
//
// SAFETY (the Verifier's brief; SEAM.md §141).
//  - The host sockets the role is pointed at are the test's own (an abstract
//    name and a path under the test's directory), uniquely named and closed
//    by the test. The user bus, the Docker socket and /run/WSL are only
//    `stat`ed, by the host and by the role; nothing connects to them.
//  - The host's /dev/shm gets one sentinel file of the test's own, removed
//    by the test.
//  - The host controls: `systemd-run --user` runs /usr/bin/true once in a
//    transient unit of the test's own name, collected at once; on WSL2,
//    `cmd.exe /c echo <marker>` runs once. Nothing else on the Windows side
//    is executed, read or written.
//  - The role's acting probes (connect, exec, its own /dev/shm file) are
//    guarded: the role program refuses them outside a sandbox and the role
//    is released into them only after the host has read that it is
//    contained.
//
// On the engine these tests were written against the cases pass or fail as
// COVERAGE.md, "M2 slice 12", records.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { makeTempDir, removeDir } from './harness/engine.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { changePolicy } from './harness/journal.mjs';
import { addProject, addWork, getRow } from './harness/runs.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { addProfiledWork, approveWidening, assertMountTableIsPlan, byPath, hostMounts, mountPlanOf, probedRun, refusedBeforeLaunch } from './harness/sandbox/view.mjs';
import { step } from './harness/scripted.mjs';
import { PARK_ON_REFUSAL } from './harness/trust.mjs';

const hex = (n = 6) => randomBytes(n).toString('hex');
const isWsl2 = () => /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8'));
const uid = process.getuid();
const CMD_EXE = '/mnt/c/Windows/System32/cmd.exe';

// A unix socket of the test's own, counting its connections.
async function listening(t, address) {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { connections: () => connections };
}

// One connection from the host: the socket is alive (the host's control).
const hostConnects = (address) =>
  new Promise((resolve) => {
    const socket = net.connect({ path: address });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

describe('M122 host sockets, the user bus, Docker, WSL interop and host mounts', () => {
  test('(a) P9: a host abstract socket, verified listening, is unreachable from the role\'s network namespace; a host pathname socket inside a proposed sandbox_read_paths directory refuses the plan mount_plan_refused; control: the role connects to a socket it creates', async (t) => {
    const fx = await sandboxEngine(t);
    const id = (await addGitProject(fx)).id;
    await changePolicy(fx.engine, id, PARK_ON_REFUSAL);
    const name = `surety-test-abstract-${hex()}`;
    const abstract = await listening(t, `\0${name}`);
    assert.equal(await hostConnects(`\0${name}`), true, 'the target is seeded: the abstract socket is listening (the host connects to it)');
    const scratch = makeTempDir('m122-socket');
    t.after(() => removeDir(scratch));
    mkdirSync(join(scratch, 'proposed'));
    const pathname = await listening(t, join(scratch, 'proposed', 'listener.sock'));
    assert.equal(await hostConnects(join(scratch, 'proposed', 'listener.sock')), true, 'the target is seeded: the pathname socket is listening');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual([abstract.connections(), pathname.connections()], [1, 1], 'each socket has seen the host\'s one connection');

    const { probe } = await probedRun(fx, id, await addWork(fx.engine, id, 'verification'), {
      acts: (act) => [act.unixConnect({ abstract: name }, { label: 'host-abstract' }), act.unixConnect({ own: true }, { label: 'own' })],
    });
    const negative = probe('unix_connect', 'host-abstract');
    assert.notEqual(negative.outcome, 'connected', `the host's abstract socket is unreachable from the role (${JSON.stringify(negative)})`);
    assert.equal(probe('unix_connect', 'own').outcome, 'connected', `control: the role connects to a socket it creates (${JSON.stringify(probe('unix_connect', 'own'))})`);
    assert.equal(abstract.connections(), 1, 'host-witnessed: the abstract socket saw no connection but the host\'s own');

    await approveWidening(fx, id, { sandbox_read_paths: [join(scratch, 'proposed')] });
    const { shown } = await refusedBeforeLaunch(fx, id, await addWork(fx.engine, id, 'verification'), 'mount_plan_refused', 'a directory holding a listening socket');
    assert.deepEqual([shown.refusal.subject.path, shown.refusal.subject.reason], [join(scratch, 'proposed'), 'special_file']);
    assert.equal(pathname.connections(), 1, 'host-witnessed: the pathname socket saw no connection but the host\'s own');
  });

  test('(b) P10: the user bus, the Docker socket, /run/WSL and a sentinel in the host\'s /dev/shm, each verified from the host by stat without connecting, are not found inside; control: the role writes and reads its own /dev/shm file', async (t) => {
    const fx = await sandboxEngine(t);
    const project = (await addProject(fx)).id;
    const sentinel = join('/dev/shm', `surety-test-sentinel-${hex()}`);
    writeFileSync(sentinel, 'a sentinel of the test in the host\'s /dev/shm\n');
    t.after(() => rmSync(sentinel, { force: true }));
    const roleFile = `surety-role-${hex()}`;
    t.after(() => rmSync(join('/dev/shm', roleFile), { force: true }));

    const targets = [];
    const seeded = (what, path, check) => {
      const st = statSync(path, { throwIfNoEntry: false });
      assert.ok(st && check(st), `the target is seeded: ${what} at ${path}, verified by stat without connecting`);
      targets.push({ what, path });
    };
    seeded('the user bus', `/run/user/${uid}/bus`, (st) => st.isSocket());
    seeded('the host /dev/shm sentinel', sentinel, (st) => st.isFile());
    const docker = ['/var/run/docker.sock', '/run/docker.sock'].filter((p) => statSync(p, { throwIfNoEntry: false })?.isSocket());
    if (docker.length === 0) t.diagnostic('[not_exercised] P10\'s Docker path: this host has no Docker socket (M2 plan §2.5)');
    for (const path of docker) seeded('the Docker socket', path, (st) => st.isSocket());
    if (isWsl2()) {
      seeded('/run/WSL', '/run/WSL', (st) => st.isDirectory());
      for (const name of readdirSync('/run/WSL')) targets.push({ what: `the WSL interop entry ${name}`, path: join('/run/WSL', name) });
    } else t.diagnostic('[not_exercised] P10\'s /run/WSL: not a WSL2 host');

    const paths = [...targets.map((x) => x.path), '/run/user', `/run/user/${uid}`];
    const { probe } = await probedRun(fx, project, await addWork(fx.engine, project, 'verification'), {
      before: [step.probe('stat_paths', { paths, follow: false }), step.probe('list_dirs', { paths: ['/dev/shm'] })],
      acts: (act) => [act.shm(roleFile)],
    });
    const stats = byPath(probe('stat_paths'));
    for (const target of targets) assert.deepEqual([stats[target.path].outcome, stats[target.path].error], ['failed', 'ENOENT'], `${target.what}: not found inside (${target.path})`);
    for (const path of ['/run/user', `/run/user/${uid}`]) assert.equal(stats[path].outcome, 'failed', `${path} is not in the role's view`);
    assert.deepEqual(probe('list_dirs').results[0].entries, [], 'the role\'s /dev/shm holds nothing of the host\'s');
    const shm = probe('shm_roundtrip');
    assert.deepEqual([shm.outcome, shm.after], ['round_trip', [roleFile]], `control: the role writes and reads its own /dev/shm file (${JSON.stringify(shm)})`);
    assert.equal(existsSync(join('/dev/shm', roleFile)), false, 'host-witnessed: the role\'s file is not in the host\'s /dev/shm');
    assert.equal(readFileSync(sentinel, 'utf8'), 'a sentinel of the test in the host\'s /dev/shm\n', 'host-witnessed: the sentinel is unchanged');
  });

  test('(c) P17: `systemd-run --user true` fails inside; control: the test runs it successfully on the host', async (t) => {
    const fx = await sandboxEngine(t);
    const project = (await addProject(fx)).id;
    const hostUnit = `surety-test-p17-${hex()}`;
    const control = spawnSync('systemd-run', ['--user', '--quiet', '--wait', '--collect', `--unit=${hostUnit}`, 'true'], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(control.status, 0, `control: systemd-run --user true succeeds on the host (${control.stderr})`);

    const roleUnit = `surety-test-role-${hex()}`;
    const env = { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` };
    const { probe } = await probedRun(fx, project, await addWork(fx.engine, project, 'verification'), {
      acts: (act) => [act.exec(['systemd-run', '--user', '--quiet', '--collect', `--unit=${roleUnit}`, 'true'], { env, timeout_ms: 10_000 })],
    });
    const p = probe('exec_probe');
    assert.equal(p.outcome, 'ran', JSON.stringify(p));
    assert.ok(p.status !== 0 || p.error !== null, `systemd-run --user fails inside (status ${p.status}, error ${p.error}: ${p.stderr})`);
    const shown = spawnSync('systemctl', ['--user', 'show', '-p', 'LoadState', '--value', `${roleUnit}.service`], { encoding: 'utf8' });
    assert.equal(shown.stdout.trim(), 'not-found', 'host-witnessed: the user manager knows no unit of the role\'s');
    assert.equal(spawnSync('systemctl', ['--user', 'show', '-p', 'LoadState', '--value', `${hostUnit}.service`], { encoding: 'utf8' }).stdout.trim(), 'not-found', 'the host control\'s unit was collected: nothing of the test is left in the manager');
  });

  test('(d) P11, WSL2 only: a valid harmless Windows executable prints its marker in the host control and fails to execute inside ([not_exercised] off WSL2)', async (t) => {
    if (!isWsl2()) {
      t.diagnostic('[not_exercised] P11: not a WSL2 host; there is no interop to reach (M2 plan §2.5)');
      assert.equal(existsSync('/run/WSL'), false, 'host fact: no WSL interop on this host');
      return;
    }
    const fx = await sandboxEngine(t);
    const project = (await addProject(fx)).id;
    assert.ok(statSync(CMD_EXE, { throwIfNoEntry: false })?.isFile(), `the target is seeded: ${CMD_EXE} is present (the engine's named Windows executable, E59 item 4)`);
    const marker = `surety-p11-${hex()}`;
    // The one execution on the Windows side: the host control.
    const control = spawnSync(CMD_EXE, ['/c', 'echo', marker], { encoding: 'utf8', timeout: 30_000, cwd: '/mnt/c/Windows/System32' });
    assert.ok(control.status === 0 && control.stdout.includes(marker), `control: the executable prints the marker on the host (status ${control.status}, error ${control.error?.code}, stdout ${JSON.stringify(control.stdout)})`);
    const interop = ['/init', '/run/WSL', '/mnt/c'];
    for (const path of interop) assert.ok(existsSync(path), `host fact: ${path} exists on this WSL2 host`);

    const { probe } = await probedRun(fx, project, await addWork(fx.engine, project, 'verification'), {
      before: [step.probe('stat_paths', { paths: [...interop, CMD_EXE] })],
      acts: (act) => [act.exec([CMD_EXE, '/c', 'echo', marker], { timeout_ms: 10_000 })],
    });
    const p = probe('exec_probe');
    assert.equal(p.outcome, 'ran', JSON.stringify(p));
    assert.ok(p.error !== null || (p.status !== 0 && p.status !== null), `the executable fails to execute inside (status ${p.status}, error ${p.error})`);
    assert.ok(!`${p.stdout}${p.stderr}`.includes(marker), 'and its marker is not printed');
    for (const r of probe('stat_paths').results) assert.deepEqual([r.outcome, r.error], ['failed', 'ENOENT'], `${r.path} is not in the role's view: neither the executable nor the interop's interpreter and sockets`);
  });

  test("(e) P12 on the full mount table, under the probe profile: it equals the validated plan, with no 9p, DrvFs or virtiofs entry and no /mnt/c (off WSL2 the comparison still runs and only the WSL claim is not exercised)", async (t) => {
    const fx = await sandboxEngine(t);
    const project = (await addProject(fx)).id;
    const host = hostMounts();
    const hostForeign = host.filter((m) => /^(9p|drvfs|virtiofs)$/.test(m.fstype) || /drvfs/i.test(m.superopts));
    if (isWsl2()) assert.ok(hostForeign.length > 0 && existsSync('/mnt/c'), `the target is seeded: this WSL2 host has 9p or DrvFs mounts and /mnt/c (${hostForeign.map((m) => m.point).join(', ')})`);
    else t.diagnostic('[not_exercised] P12\'s WSL claim: not a WSL2 host; the plan comparison still runs');

    const item = await addProfiledWork(fx, project, 'verification', { profile: 'probe' });
    const { run, domain, probe } = await probedRun(fx, project, item, { before: [step.probe('mount_table'), step.probe('stat_paths', { paths: ['/mnt/c', '/mnt'] })] });
    assert.equal(domain.profile, 'probe');
    const plan = await mountPlanOf(fx, project, run.id);
    assert.equal(plan.profile, 'probe');
    const mounts = assertMountTableIsPlan(probe('mount_table'), plan, { home: realpathSync(fx.home), domain: domain.id, workspace: getRow(fx.home, 'workspaces', run.workspace).path });
    assert.deepEqual(mounts.filter((m) => /^(9p|drvfs|virtiofs)$/.test(m.fstype) || /drvfs/i.test(`${m.source} ${m.superopts}`)).map((m) => m.line), [], 'no 9p, DrvFs or virtiofs entry');
    assert.equal(byPath(probe('stat_paths'))['/mnt/c'].outcome, 'failed', 'no /mnt/c');
    assert.deepEqual(plan.entries.filter((e) => e.kind === 'cgroup').map((e) => e.target).sort(), ['/surety/cgroup/domain', '/surety/cgroup/sibling'], 'the probe profile\'s plan carries its two cgroup directories (SEAM.md §127), which the table matched');
  });
});
