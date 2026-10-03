// M119, the validated mount plan has the authority (M2 slice 12, sandbox
// lane). M2 plan §3.4 M119; D2 §2.3, §2.7, A.6 P12, A.7 (D2-I16); AR B02;
// E58 item 3; SEAM.md §§132, 133, 134, 141.
//
// What a role can see is what the engine's validated plan mounts and nothing
// else: the role's own mount table equals the published plan entry by
// entry, with no file system that carries the host in and every bind the
// very directory the plan names; /etc holds the enumerated files, /dev the
// enumerated nodes and a private devpts, /dev/shm is empty and private; a
// widening's symbolic link is bound at its real path and an alias into the
// engine home is refused; a directory holding a socket or a FIFO is refused;
// a host submount under a permitted tree is not bound; every operator
// credential location is absent by its host path and by its aliases, and
// refused as a widening; no descriptor is inherited; a repository with
// alternates is refused.
//
// SAFETY: the operator's home here is a disposable directory the engine is
// started with as HOME (seedOperatorHome), never the user's own. The one
// acting probe, a file written in the role's /dev/shm, is guarded: the role
// program refuses it outside a sandbox and the role is released into it
// only after the host has read that it is contained (SEAM.md §141).
//
// Every case here is expected to fail on the engine these tests were
// written against, which publishes no plan (COVERAGE.md, "M2 slice 12").

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';

import { installProject, makeTempDir, removeDir, sha256Hex } from './harness/engine.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { changePolicy } from './harness/journal.mjs';
import { makeProjectRepo } from './harness/repos.mjs';
import { addProject, addWork, getRow } from './harness/runs.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import {
  aliasesOf,
  approveWidening,
  armedRole,
  assertMountTableIsPlan,
  byPath,
  hostMounts,
  inheritedDescriptors,
  mountPlanOf,
  probedRun,
  refusedBeforeLaunch,
  seedOperatorHome,
  seedSentinel,
} from './harness/sandbox/view.mjs';
import { step } from './harness/scripted.mjs';
import { PARK_ON_REFUSAL } from './harness/trust.mjs';

// D2 §2.3: the files of /etc a role sees, beside the engine's own `hosts`
// and `resolv.conf`; those this host has.
const ETC_ENUMERATED = ['passwd', 'group', 'nsswitch.conf', 'ld.so.cache', 'localtime', 'ssl/certs/ca-certificates.crt'].filter((name) => existsSync(join('/etc', name)));
const DEV_NODES = ['null', 'zero', 'full', 'random', 'urandom'];
const SYSTEM_TREES = ['/usr', '/bin', '/lib', '/lib64'];

const workspaceOf = (fx, run) => getRow(fx.home, 'workspaces', run.workspace).path;
const ctxOf = (fx, run, domain) => ({ home: realpathSync(fx.home), domain: domain.id, workspace: workspaceOf(fx, run) });

describe('M119 the validated mount plan has the authority', () => {
  test("(a) the role's mount table equals the validated plan entry by entry (published as a qualification_evidence record, its fingerprint on the run read): no DrvFs, 9p or host submount, no alias; /etc holds only the enumerated files; /dev only the enumerated nodes and a private devpts; /dev/shm is empty and private, and the role's file there is invisible on the host", async (t) => {
    const fx = await sandboxEngine(t);
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const shmName = `surety-role-${randomBytes(6).toString('hex')}`;
    t.after(() => rmSync(join('/dev/shm', shmName), { force: true }));
    // Objection 007 (a correction of this case's own, made with it): the
    // table is compared with the plan while the domain lives. A bind source in
    // the domain's area is the engine's to keep or remove at termination,
    // which this case does not pin; the role holds after its steps and the run
    // is stopped once the comparison is made.
    const first = await armedRole(fx, project, item, {
      before: [
        step.probe('mount_table'),
        step.probe('context_dump', { root: '/etc', label: 'etc' }),
        step.probe('list_dirs', { paths: ['/dev', '/dev/shm'] }),
      ],
      acts: (act) => [act.shm(shmName)],
      thenHold: true,
    });
    await first.release();
    const { run, domain, launch, probe } = first;
    assert.deepEqual([launch.cwd, launch.workspace], ['/surety/workspace', '/surety/workspace'], 'the role runs in /surety/workspace, and its request names that as its workspace');

    // The plan, published, and the table against it.
    const plan = await mountPlanOf(fx, project, run.id);
    assert.equal(plan.profile, 'role');
    const table = probe('mount_table');
    const mounts = assertMountTableIsPlan(table, plan, ctxOf(fx, run, domain));
    for (const tree of SYSTEM_TREES.filter((p) => existsSync(p) && !lstatSync(p).isSymbolicLink())) {
      assert.ok(plan.entries.some((e) => e.target === tree || e.target.startsWith(`${tree}/`)), `the plan binds the permitted tree ${tree}`);
    }
    for (const e of plan.entries.filter((x) => x.kind === 'bind' && SYSTEM_TREES.some((tree) => x.target === tree || x.target.startsWith(`${tree}/`)))) {
      assert.ok(e.options.includes('ro'), `a system tree is bound read-only (${e.target})`);
      assert.equal(e.source, e.target, `a system tree is bound at its own path, no alias (${e.target} from ${e.source})`);
    }
    for (const target of ['/surety/context', '/surety/workspace', '/surety/home', '/surety/out', '/tmp', '/proc', '/dev/pts', '/dev/shm']) {
      assert.ok(plan.entries.some((e) => e.target === target), `the plan has an entry for ${target}`);
    }
    assert.ok(plan.entries.find((e) => e.target === '/surety/context').options.includes('ro'), 'the context package is mounted read-only');
    assert.deepEqual(plan.entries.filter((e) => e.kind === 'cgroup'), [], 'the role profile binds no cgroup directory');
    assert.equal(plan.entries.find((e) => e.target === '/surety/workspace').kind, 'overlay', 'the workspace is an overlay');
    assert.equal(realpathSync(plan.entries.find((e) => e.target === '/surety/workspace').source), realpathSync(workspaceOf(fx, run)), 'whose lower layer is the run\'s checkout');
    assert.ok(mounts.length >= 10, 'the fixture is live');

    // /etc: the enumerated files and the engine's own two.
    const etc = probe('context_dump', 'etc');
    assert.equal(etc.outcome, 'dumped', `the role listed /etc (${etc.error})`);
    const files = etc.files.filter((f) => f.type !== 'dir');
    assert.deepEqual(files.map((f) => f.name).sort(), [...ETC_ENUMERATED, 'hosts', 'resolv.conf'].sort(), '/etc holds exactly the enumerated files and the engine-written hosts and resolv.conf');
    assert.deepEqual(etc.files.filter((f) => f.type === 'dir').map((f) => f.name).filter((n) => !['ssl', 'ssl/certs'].includes(n)), [], '/etc holds no directory but the CA bundle\'s');
    const etcFile = (name) => files.find((f) => f.name === name);
    assert.equal(etcFile('resolv.conf').size, 0, 'resolv.conf is empty');
    const hostsLines = etcFile('hosts').text.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
    for (const line of hostsLines) assert.match(line.split(/\s+/)[0], /^(127\.\d+\.\d+\.\d+|::1)$/, `the engine-written hosts names loopback only (${line})`);
    assert.equal(etcFile('passwd').sha256, sha256Hex(readFileSync('/etc/passwd')), 'host-read: the enumerated passwd is the host\'s own file');

    // /dev: the enumerated nodes, a private devpts, a private empty /dev/shm.
    const dev = byPath(probe('list_dirs'));
    const devNames = dev['/dev'].entries.map((e) => e.name).sort();
    for (const name of [...DEV_NODES, 'pts', 'shm']) assert.ok(devNames.includes(name), `/dev holds ${name} (it holds ${devNames.join(', ')})`);
    assert.deepEqual(devNames.filter((n) => ![...DEV_NODES, 'pts', 'shm', 'ptmx'].includes(n)), [], '/dev holds nothing but the enumerated nodes, pts (with its ptmx) and shm');
    for (const name of DEV_NODES) assert.equal(dev['/dev'].entries.find((e) => e.name === name).type, 'char', `/dev/${name} is a character device`);
    assert.notEqual(table.points['/dev/pts'].dev, String(statSync('/dev/pts').dev), 'host-read: the devpts instance is not the host\'s');
    assert.deepEqual(dev['/dev/shm'].entries, [], '/dev/shm is empty when the role starts');
    assert.notEqual(table.points['/dev/shm'].dev, String(statSync('/dev/shm').dev), 'host-read: /dev/shm is not the host\'s');
    const shm = probe('shm_roundtrip');
    assert.equal(shm.outcome, 'round_trip', `control: the role writes and reads its own /dev/shm file (${shm.error})`);
    assert.deepEqual(shm.after, [shmName]);
    assert.equal(existsSync(join('/dev/shm', shmName)), false, 'host-witnessed: the role\'s file is not in the host\'s /dev/shm');

    // The fingerprint: the same plan gives the same one; a widening another.
    await first.stop();
    const again = await addWork(fx.engine, project, 'verification');
    const second = await probedRun(fx, project, again, {});
    assert.equal((await mountPlanOf(fx, project, second.run.id)).fingerprint, plan.fingerprint, 'a second run of the same project and profile has the same plan fingerprint (the domain\'s own paths are not part of it)');
  });

  test('(b) sandbox_read_paths entries that are symbolic links: one to a permitted directory is bound at its real path, read-only, and its plan has another fingerprint; the alias into the engine home is refused mount_plan_refused', async (t) => {
    const fx = await sandboxEngine(t);
    const project = await addGitProject(fx);
    const id = project.id;
    await changePolicy(fx.engine, id, PARK_ON_REFUSAL);
    const scratch = makeTempDir('m119-links');
    t.after(() => removeDir(scratch));
    const real = join(realpathSync(scratch), 'toolchain');
    const tool = seedSentinel(join(real, 'tool.txt'), 'a harmless toolchain file');
    symlinkSync(real, join(scratch, 'link-to-toolchain'));
    symlinkSync(fx.home, join(scratch, 'link-to-home'));

    const plain = await probedRun(fx, id, await addWork(fx.engine, id, 'verification'), {});
    const unwidened = await mountPlanOf(fx, id, plain.run.id);

    const link = join(scratch, 'link-to-toolchain');
    await approveWidening(fx, id, { sandbox_read_paths: [link] });
    const item = await addWork(fx.engine, id, 'verification');
    // Objection 007 (a correction of this case's own, made with it): the
    // table is compared with the plan while the domain lives. A bind source in
    // the domain's area is the engine's to keep or remove at termination,
    // which this case does not pin; the role holds after its steps and the run
    // is stopped once the comparison is made.
    const widened = await armedRole(fx, id, item, {
      before: [step.probe('mount_table'), step.probe('open_paths', { paths: [join(real, 'tool.txt'), join(link, 'tool.txt')] }), step.probe('stat_paths', { paths: [link], follow: false })],
      acts: (act) => [act.write(join(real, 'written-by-the-role.txt'))],
      thenHold: true,
    });
    await widened.release();
    const { run, domain, probe } = widened;
    const plan = await mountPlanOf(fx, id, run.id);
    assertMountTableIsPlan(probe('mount_table'), plan, ctxOf(fx, run, domain));
    const entry = plan.entries.find((e) => e.target === real);
    assert.ok(entry, `the plan binds the widening at its real path ${real} (targets under it: ${plan.entries.filter((e) => e.target.includes('toolchain')).map((e) => e.target).join(', ') || 'none'})`);
    assert.deepEqual([entry.kind, entry.source, entry.options.includes('ro')], ['bind', real, true], 'resolved to the real path, read-only');
    assert.equal(plan.entries.some((e) => e.target === link), false, 'nothing is mounted at the link\'s own path');
    const opened = byPath(probe('open_paths'));
    assert.deepEqual([opened[join(real, 'tool.txt')].outcome, opened[join(real, 'tool.txt')].sha256], ['opened', tool.sha256], 'the role reads the permitted file at its real path');
    assert.equal(byPath(probe('stat_paths'))[link].outcome, 'failed', 'the link itself is not in the role\'s view');
    assert.equal(probe('write_probe').outcome, 'refused', `the widening is read-only to the role (${JSON.stringify(probe('write_probe'))})`);
    assert.deepEqual(readdirSync(real), ['tool.txt'], 'host-witnessed: nothing was written into the permitted directory');
    assert.notEqual(plan.fingerprint, unwidened.fingerprint, 'a widening changes the plan\'s fingerprint');

    await widened.stop();

    const alias = join(scratch, 'link-to-home');
    await approveWidening(fx, id, { sandbox_read_paths: [alias] });
    const refusedItem = await addWork(fx.engine, id, 'verification');
    const { shown } = await refusedBeforeLaunch(fx, id, refusedItem, 'mount_plan_refused', 'an alias into the engine home');
    assert.deepEqual([shown.refusal.subject.path, shown.refusal.subject.reason], [alias, 'engine_home'], 'the refusal names the path as the policy gave it and what it resolves to');
    assert.equal(shown.mount_plan ?? null, null, 'a refused launch has no validated plan');
  });

  test('(c) a permitted directory holding a seeded listening socket, and one holding a FIFO, are each refused mount_plan_refused special_file, with no launcher started', async (t) => {
    const fx = await sandboxEngine(t);
    const id = (await addGitProject(fx)).id;
    await changePolicy(fx.engine, id, PARK_ON_REFUSAL);
    const scratch = makeTempDir('m119-special');
    t.after(() => removeDir(scratch));
    mkdirSync(join(scratch, 'with-socket'));
    let connections = 0;
    const server = net.createServer(() => {
      connections++;
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(join(scratch, 'with-socket', 'listener.sock'), resolve);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    assert.ok(statSync(join(scratch, 'with-socket', 'listener.sock')).isSocket(), 'the target is seeded: a listening socket, host-read without connecting');
    mkdirSync(join(scratch, 'with-fifo'));
    assert.equal(spawnSync('mkfifo', [join(scratch, 'with-fifo', 'pipe')]).status, 0);
    assert.ok(statSync(join(scratch, 'with-fifo', 'pipe')).isFIFO(), 'the target is seeded: a FIFO');

    for (const [what, path] of [
      ['a directory holding a listening socket', join(scratch, 'with-socket')],
      ['a directory holding a FIFO', join(scratch, 'with-fifo')],
    ]) {
      await approveWidening(fx, id, { sandbox_read_paths: [path] });
      const item = await addWork(fx.engine, id, 'verification');
      const { shown } = await refusedBeforeLaunch(fx, id, item, 'mount_plan_refused', what);
      assert.deepEqual([shown.refusal.subject.path, shown.refusal.subject.reason], [path, 'special_file'], `${what}: the refusal names the path and the reason`);
    }
    assert.equal(connections, 0, 'host-witnessed: nothing connected to the socket');

    // Control: the same directories without their special files are accepted.
    await new Promise((resolve) => server.close(resolve));
    rmSync(join(scratch, 'with-socket', 'listener.sock'), { force: true });
    writeFileSync(join(scratch, 'with-socket', 'plain.txt'), 'a plain file\n');
    await approveWidening(fx, id, { sandbox_read_paths: [join(scratch, 'with-socket')] });
    const ok = await probedRun(fx, id, await addWork(fx.engine, id, 'verification'), {});
    assert.equal(ok.ended.outcome, 'completed', 'control: a directory of plain files is bound and the run completes');
  });

  test('(d) a host submount under a permitted tree is not bound: the role sees nothing of what the host has there, and no mount of it ([not_exercised], with the reason, on a host with no such submount)', async (t) => {
    const fx = await sandboxEngine(t);
    const project = (await addProject(fx)).id;
    const trees = SYSTEM_TREES.map((p) => realpathSync(p));
    const submounts = hostMounts()
      .filter((m) => trees.some((tree) => m.point.startsWith(`${tree}/`)))
      .map((m) => ({ ...m, holds: (() => { try { return readdirSync(m.point); } catch { return null; } })() }));
    if (submounts.length === 0) {
      t.diagnostic('[not_exercised] this host has no mount under /usr, /bin, /lib or /lib64: the non-recursive bind has nothing to leave out (M2 plan §2.5)');
      assert.deepEqual(submounts, [], 'host fact: no submount under a permitted tree');
      return;
    }
    const seeded = submounts.filter((m) => m.holds !== null && m.holds.length > 0);
    assert.ok(seeded.length > 0, `the target is seeded: at least one host submount under a permitted tree holds something the host can list (${submounts.map((m) => `${m.point} (${m.fstype})`).join(', ')})`);
    const item = await addWork(fx.engine, project, 'verification');
    const { probe } = await probedRun(fx, project, item, {
      before: [step.probe('mount_table'), step.probe('list_dirs', { paths: [...submounts.map((m) => m.point), ...new Set(submounts.map((m) => dirname(m.point))), '/usr/bin'] })],
    });
    const mounts = probe('mount_table').mountinfo.map((line) => line.split(' ')[4]);
    const listed = byPath(probe('list_dirs'));
    for (const m of submounts) {
      assert.equal(mounts.some((point) => point === m.point || point.startsWith(`${m.point}/`)), false, `${m.point} (${m.fstype} on the host) is not mounted in the role's view`);
      const inside = listed[m.point];
      assert.ok(inside.outcome === 'failed' || inside.entries.length === 0, `the role sees nothing under ${m.point} (the host lists ${m.holds?.length ?? '?'} entries; the role: ${JSON.stringify(inside.entries?.slice(0, 5) ?? inside.error)})`);
    }
    assert.ok(listed['/usr/bin'].outcome === 'listed' && listed['/usr/bin'].entries.length > 10, 'control: the permitted tree itself is in the view');
  });

  test('(e) every credential location D2 §2.3 enumerates, each seeded under the operator\'s home: absent by its host path and by its /proc/self/root and .. aliases; named in sandbox_read_paths, each is refused mount_plan_refused credential_location', async (t) => {
    const operator = seedOperatorHome(t);
    const fx = await sandboxEngine(t, { env: { HOME: operator.home } });
    const id = (await addGitProject(fx)).id;
    const paths = operator.seeded.flatMap((s) => aliasesOf(s.sentinel));
    const { probe } = await probedRun(fx, id, await addWork(fx.engine, id, 'verification'), {
      before: [
        step.probe('open_paths', { paths, label: 'credentials' }),
        step.probe('stat_paths', { paths: [operator.home, ...operator.seeded.map((s) => s.path)] }),
        step.probe('open_paths', { paths: ['/surety/workspace/README.md'], label: 'control' }),
      ],
    });
    const opened = byPath(probe('open_paths', 'credentials'));
    for (const s of operator.seeded) {
      for (const path of aliasesOf(s.sentinel)) assert.deepEqual([opened[path].outcome, opened[path].error], ['failed', 'ENOENT'], `${s.rel}: not found by ${path}`);
      assert.equal(sha256Hex(readFileSync(s.sentinel)), s.sha256, `control: the host reads the seeded ${s.rel}`);
    }
    for (const r of probe('stat_paths').results) assert.deepEqual([r.outcome, r.error], ['failed', 'ENOENT'], `${r.path} does not exist in the role's view`);
    assert.equal(probe('open_paths', 'control').results[0].outcome, 'opened', 'control: the role opens a file of its own workspace the same way');

    await changePolicy(fx.engine, id, PARK_ON_REFUSAL);
    for (const s of operator.seeded) {
      await approveWidening(fx, id, { sandbox_read_paths: [s.path] });
      const item = await addWork(fx.engine, id, 'verification');
      const { shown } = await refusedBeforeLaunch(fx, id, item, 'mount_plan_refused', `~/${s.rel}`);
      assert.deepEqual([shown.refusal.subject.path, shown.refusal.subject.reason], [s.path, 'credential_location'], `~/${s.rel}: the refusal names the path and the reason`);
    }
  });

  test("(f) the role's /proc/self/fd holds 0 to 2 and nothing inherited: every other descriptor is the runtime's own", async (t) => {
    const fx = await sandboxEngine(t);
    const project = (await addProject(fx)).id;
    const { probe } = await probedRun(fx, project, await addWork(fx.engine, project, 'verification'), { before: [step.probe('self_status')] });
    const { fds } = probe('self_status');
    for (const fd of ['0', '1', '2']) assert.ok(fd in fds, `descriptor ${fd} is open`);
    assert.deepEqual(inheritedDescriptors(fds), [], `no descriptor beyond 0 to 2 is inherited (${JSON.stringify(fds)})`);
    const home = realpathSync(fx.home);
    assert.deepEqual(
      Object.entries(fds).filter(([fd, target]) => target.startsWith(home) || target.includes('cgroup') || (Number(fd) > 2 && target.startsWith('socket:'))),
      [],
      'none names the engine home or a cgroup, and none beyond 0 to 2 is a socket',
    );
  });

  test('(g) a repository with objects/info/alternates: that project\'s dispatch is refused mount_plan_refused, with no launcher started', async (t) => {
    const fx = await sandboxEngine(t);
    const other = makeProjectRepo(join(fx.root, 'repo-borrowed-from'));
    const repo = makeProjectRepo(join(fx.root, 'repo-with-alternates'));
    const id = await installProject(fx.engine, { repoPath: repo.path, name: 'with-alternates' });
    await changePolicy(fx.engine, id, PARK_ON_REFUSAL);
    // The alternate is added once the project stands: the plan is validated
    // before every launch, so this launch is the one that must see it.
    const alternates = join(repo.path, '.git', 'objects', 'info', 'alternates');
    mkdirSync(dirname(alternates), { recursive: true });
    writeFileSync(alternates, `${join(other.path, '.git', 'objects')}\n`);
    assert.ok(readFileSync(alternates, 'utf8').includes(other.path), 'the target is seeded: the repository names an alternate object store');
    const item = await addWork(fx.engine, id, 'verification');
    const { shown } = await refusedBeforeLaunch(fx, id, item, 'mount_plan_refused', 'a repository with alternates');
    assert.deepEqual([shown.refusal.subject.path, shown.refusal.subject.reason], [repo.path, 'alternates'], 'the refusal names the repository and the reason');

    // Control: the same engine dispatches a project whose repository has none.
    const plain = (await addProject(fx)).id;
    const ok = await probedRun(fx, plain, await addWork(fx.engine, plain, 'verification'), {});
    assert.equal(ok.ended.outcome, 'completed', 'control: a repository without alternates is dispatched');
  });
});
