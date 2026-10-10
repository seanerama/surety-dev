// M310, the `service` profile (slice 24; sandbox lane). M4 plan §3.2 M310;
// D4 §9.2, D4-T01; J2; Q6; E110; E121 item 4 (the domain cgroup is the
// unit's own); BS4 §4.1; SEAM.md §§256 to 259.
//
// Host-side reads of a running fixture service, made while the round's
// post-deploy check holds between the two identity reads; the project's
// writable bounds lowered to their minimums by policy (1 MiB, 256 inodes).
//   (a) the mount plan: /usr, /bin, /lib, /lib64 and the pinned runtime
//       read-only; /surety/app read-only from the sealed directory (the
//       same directory, by device and inode); volatile /surety/home, /tmp,
//       /surety/state; a private /proc; a minimal /dev; the engine home, the
//       test's root, the repository and the operator's home absent (but for
//       the path to the pinned runtime);
//   (b) every component up to /surety/app on a read-only mount with no
//       writable layer; the service's own writes there refused while its
//       /tmp write succeeds, and that write gone after a redeploy
//       (generation 2 of the same environment; generation 1's check exits 1
//       so the candidate stays `developing` and the redeploy is an ordinary
//       request);
//   (c) only a loopback in its network namespace, no host interface, the
//       host unable to reach its port; it is reached through the link;
//   (d) no descriptor of the application is a unix socket or names a path
//       of the engine home: nothing of the init's control channel;
//   (e) the unit: `Delegate=yes`, no automatic restart, the limits as
//       properties and in its cgroup, read back before the grant (the
//       grant's event carries them); the unit's journal carries nothing of
//       the application's output; the domain's cgroup is the unit's own and
//       holds every process of the domain;
//   (f) admission: the service domain's reservation is `service_memory_max`
//       and one check domain's memory;
//   (g) the writable bounds: the service's writes to /tmp refused at the
//       bound, in bytes and in inodes, and nothing of them on the host.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §§257, 258). The only units are the
// engine's, under this test's home's prefix. The test acts on no unit and
// signals nothing. Two of the fixture service's acts are guarded and are
// released only after `assertServiceContained` (the test's half) has read
// the service's containment from the host, and the service refuses them
// unless it reads itself contained (its half): `fill-tmp` and `fill-inodes`
// write inside the service's own volatile /tmp up to the bounds the policy
// lowered to their minimums (BS4 §4.1 rule 10: set low, never by filling a
// disk). The file ends with the operator's guard (row M313). Its first
// engine start carries the real-adapter switch.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, sep } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { interfacesOfPid, mountAt, mountsOfPid } from './harness/checks/fixtures.mjs';
import { CGROUP_ROOT, cgroupOfPid, procsOf } from './harness/sandbox/cgroup.mjs';
import { hostConnects } from './harness/sandbox/egress.mjs';
import { hostNamespaces, namespacesOf } from './harness/scripted.mjs';
import { artifactsOf, deploy, environmentLeases } from './harness/deploy/kernel.mjs';
import {
  RUNTIME,
  UNIT_PROPS,
  heldCheck,
  hostDeployable,
  hostEnvironment,
  journalOf,
  newestOperation,
  operatorGuard,
  releaseCheck,
  serviceOf,
  targetReport,
  teardownOnHost,
  ticksUntil,
  unitShow,
  verificationOf,
} from './harness/deploy/host.mjs';

const MiB = 1024 * 1024;
const POLICY = Object.freeze({ service_writable_bytes: MiB, service_writable_inodes: 256 });
const readOnly = (m) => m.options.includes('ro') || m.superopts.split(',').includes('ro');
const rootOf = (pid) => `/proc/${pid}/root`;
const hostReadable = (path) => {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (err) {
    return `unread:${err.code}`;
  }
};

describe('M310 the service profile, read from the host', () => {
  const shared = sharedFixture();
  let guard;
  let S;
  before(async () => {
    guard = operatorGuard();
    const ctx = await hostDeployable(shared.context, guard, { policy: POLICY });
    const env = await hostEnvironment(ctx, 'alpha');
    const { fx, project } = ctx;
    const { config } = await fx.engine.engineInfo();

    // Generation 1, read while its round's check holds.
    await deploy(fx.engine, project, ctx.candidate.id, env.name);
    const held = await ticksUntil(fx, project, () => heldCheck(ctx, env), { what: "generation 1's round to hold its check" });
    const op1 = newestOperation(ctx, env);
    const svc = serviceOf(ctx, env, op1);
    const pid = svc.app.pid;
    const [artifact] = artifactsOf(fx.home, project);
    const show = unitShow(svc.unit, UNIT_PROPS);
    const unitCg = join(CGROUP_ROOT, show.ControlGroup);
    S = {
      ctx,
      env,
      svc,
      artifact,
      show,
      unitCg,
      domainMemory: config.domain_memory_max?.value,
      serviceMemory: 512 * MiB,
      mounts: mountsOfPid(pid),
      appDev: statSync(`${rootOf(pid)}/surety/app`),
      sealedDev: statSync(artifact.path),
      exists: Object.fromEntries([fx.home, fx.root, ctx.p.repo.path].map((p) => [p, existsSync(`${rootOf(pid)}${p}`)])),
      homeListing: (() => {
        try {
          return readdirSync(`${rootOf(pid)}${userInfo().homedir}`);
        } catch (err) {
          return `absent:${err.code}`;
        }
      })(),
      dev: (() => {
        try {
          return readdirSync(`${rootOf(pid)}/dev`);
        } catch (err) {
          return `unread:${err.code}`;
        }
      })(),
      netIfs: interfacesOfPid(pid),
      ns: namespacesOf(pid),
      hostReach: await hostConnects('127.0.0.1', env.content.port, 1500),
      fds: readdirSync(`/proc/${pid}/fd`).map((fd) => {
        try {
          return readlinkSync(`/proc/${pid}/fd/${fd}`);
        } catch {
          return 'unread';
        }
      }),
      unixInodes: new Set(readFileSync(`/proc/${pid}/net/unix`, 'utf8').split('\n').slice(1).map((l) => l.trim().split(/\s+/)[6]).filter(Boolean)),
      cgroupFiles: { memory: hostReadable(join(unitCg, 'memory.max')), swap: hostReadable(join(unitCg, 'memory.swap.max')), pids: hostReadable(join(unitCg, 'pids.max')) },
      members: { app: cgroupOfPid(pid), init: cgroupOfPid(svc.init.pid), main: cgroupOfPid(Number(show.MainPID)) },
      procs: procsOf(cgroupOfPid(pid)),
      granted: eventsOfType(fx.home, 'deploy.launch_authorized').filter((e) => e.subject?.attempt === svc.attempt.id),
      tmpMarker: hostReadable(`${rootOf(pid)}/tmp/fixture-marker`),
    };
    // The check fails (exit 1), so the candidate stays developing and generation 2 is an ordinary request.
    releaseCheck(ctx, svc, { get: ['/probe', '/act/fill-tmp', '/act/fill-inodes', '/hello'], exit: 1 });
    S.v1 = await verificationOf(ctx, op1);
    S.report1 = targetReport(ctx, held.execution).report;
    S.hostTmp = { fill: existsSync('/tmp/fill'), inodes: existsSync('/tmp/inodes') };
    S.journal = journalOf(svc.unit);
    S.domainRow = svc.domain;

    // Generation 2: a deliberate request after the first operation is terminal; its /tmp is new.
    await ticksUntil(fx, project, () => (environmentLeases(fx.home, env.id).every((l) => l.released_at !== null) ? true : undefined), { what: "the environment lease to be released after generation 1's verification" });
    await deploy(fx.engine, project, ctx.candidate.id, env.name);
    const held2 = await ticksUntil(fx, project, () => {
      const op = newestOperation(ctx, env);
      return op && op.id !== op1.id ? heldCheck(ctx, env) : undefined;
    }, { what: "generation 2's round to hold its check" });
    const op2 = newestOperation(ctx, env);
    const svc2 = serviceOf(ctx, env, op2);
    S.tmpMarker2 = hostReadable(`${rootOf(svc2.app.pid)}/tmp/fixture-marker`);
    releaseCheck(ctx, svc2, { get: ['/probe'], exit: 0 });
    S.v2 = await verificationOf(ctx, op2);
    S.report2 = targetReport(ctx, held2.execution).report;
    S.teardown = await teardownOnHost(ctx, env);
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('(a) the mount plan: system directories and the runtime read-only; /surety/app the sealed directory, read-only; volatile /surety/home, /tmp, /surety/state; private /proc; minimal /dev; nothing of the engine home, the repository or the operator\'s home', () => {
    const { mounts } = S;
    for (const path of ['/usr', '/bin', '/lib', '/lib64', RUNTIME.path]) {
      const m = mountAt(mounts, path);
      assert.ok(m, `${path} lies on a mount`);
      assert.ok(readOnly(m), `${path} lies on a read-only mount (${m.point} ${m.options.join(',')})`);
    }
    const app = mountAt(mounts, '/surety/app');
    assert.equal(app?.point, '/surety/app', '/surety/app is a mount of its own');
    assert.ok(readOnly(app), '/surety/app is read-only');
    assert.deepEqual([S.appDev.dev, S.appDev.ino], [S.sealedDev.dev, S.sealedDev.ino], '/surety/app is the sealed directory itself (device and inode)');
    for (const path of ['/surety/home', '/tmp', '/surety/state']) {
      const m = mountAt(mounts, path);
      assert.equal(m?.point, path, `${path} is a mount of its own`);
      assert.equal(m.fstype, 'tmpfs', `${path} is volatile (${m.fstype})`);
      assert.ok(!readOnly(m), `${path} is writable`);
    }
    assert.equal(mountAt(mounts, '/proc')?.fstype, 'proc', 'a /proc of its own');
    assert.ok(Array.isArray(S.dev) && !S.dev.some((n) => /^(sd|nvme|loop|vd|kmsg$|mem$|port$)/.test(n)), `a minimal /dev (${JSON.stringify(S.dev)})`);
    for (const [path, present] of Object.entries(S.exists)) assert.equal(present, false, `${path} is absent from the service's root`);
    const home = userInfo().homedir;
    const within = RUNTIME.path.startsWith(`${home}${sep}`) ? RUNTIME.path.slice(home.length + 1).split(sep)[0] : null;
    if (within === null) assert.match(String(S.homeListing), /^absent:/, "the operator's home is absent");
    else assert.deepEqual(S.homeListing, [within], `of the operator's home only the path to the pinned runtime (${within}) is visible`);
  });

  test('(b) every component up to /surety/app on a read-only mount with no writable layer; the service\'s writes there refused, its /tmp write made, and gone after a redeploy', () => {
    for (const path of ['/', '/surety', '/surety/app']) {
      const m = mountAt(S.mounts, path);
      assert.ok(m && readOnly(m), `${path} lies on a read-only mount (${m?.point} ${m?.options.join(',')})`);
      assert.ok(!(m.fstype === 'overlay' && /(^|,)upperdir=/.test(m.superopts)), `${path} has no writable layer`);
    }
    const probe = JSON.parse(S.report1.results.find((r) => r.path === '/probe')?.body ?? 'null');
    assert.deepEqual(probe?.guard, [], `the service read itself contained (${JSON.stringify(probe?.guard)})`);
    for (const key of ['write_app', 'write_surety', 'rename_app']) assert.notEqual(probe?.[key], 'ok', `${key} is refused (${probe?.[key]})`);
    for (const key of ['write_tmp', 'write_home', 'write_state']) assert.equal(probe?.[key], 'ok', `${key} succeeds`);
    assert.equal(S.tmpMarker, probe?.tmp_marker, "the host reads generation 1's /tmp marker where it wrote it");
    const probe2 = JSON.parse(S.report2.results.find((r) => r.path === '/probe')?.body ?? 'null');
    assert.equal(probe2?.write_tmp, 'ok', 'generation 2 found no marker in its /tmp and wrote its own');
    assert.notEqual(probe2?.tmp_marker, probe.tmp_marker, "generation 1's /tmp did not survive the redeploy");
    assert.equal(S.tmpMarker2, probe2.tmp_marker);
  });

  test('(c) only a loopback in its network namespace, not the host\'s; the host cannot reach its port; the check reached it through the link', () => {
    assert.deepEqual(S.netIfs, ['lo'], 'only a loopback');
    assert.notEqual(S.ns.net, hostNamespaces().net, 'a network namespace of its own');
    assert.equal(S.hostReach, false, `127.0.0.1:${S.env.content.port} on the host reaches nothing`);
    assert.equal(S.report1.results.find((r) => r.path === '/hello')?.status, 200, 'the check reached it through the link');
  });

  test('(d) nothing of the init\'s control channel among the application\'s descriptors: no unix socket, nothing of the engine home', () => {
    const sockets = S.fds.map((l) => /^socket:\[(\d+)\]$/.exec(l)?.[1]).filter(Boolean);
    assert.deepEqual(sockets.filter((ino) => S.unixInodes.has(ino)), [], `no descriptor is a unix socket (descriptors: ${JSON.stringify(S.fds)})`);
    assert.deepEqual(S.fds.filter((l) => l.startsWith(S.ctx.fx.home)), [], 'no descriptor names a path of the engine home');
    assert.ok(!S.fds.includes('unread'), 'every descriptor was read');
  });

  test('(e) the unit: Delegate=yes, no automatic restart, the limits as properties and in its cgroup, read back before the grant; nothing of the application in its journal; the domain cgroup is the unit\'s own and holds the domain', () => {
    const { show, cgroupFiles, granted, unitCg, members, domainRow } = S;
    assert.deepEqual([show.Delegate, show.Restart], ['yes', 'no'], `Delegate and Restart (${JSON.stringify(show)})`);
    assert.deepEqual([show.MemoryMax, show.MemorySwapMax, show.TasksMax], [String(S.serviceMemory), '0', '128'], 'the limits as unit properties (Q6)');
    assert.deepEqual(cgroupFiles, { memory: String(S.serviceMemory), swap: '0', pids: '128' }, "and in the unit's cgroup files");
    assert.equal(granted.length, 1, 'one grant');
    assert.deepEqual(granted[0].payload?.limits, { memory_max: S.serviceMemory, memory_swap_max: 0, pids_max: 128 }, 'the limits read back before the grant are on its event');
    assert.ok(!S.journal.text.includes(`APP-OUTPUT-${S.env.content.env.MARK}`), "the unit's journal carries none of the application's output");
    assert.equal(domainRow?.cgroup_path, unitCg, "the service domain's cgroup is the unit's own (E121 item 4)");
    for (const [who, cg] of Object.entries(members)) assert.ok(cg === unitCg || cg.startsWith(`${unitCg}/`), `the ${who} is in the unit's cgroup tree (${cg})`);
    assert.ok(S.procs.includes(S.svc.app.pid));
  });

  test('(f) admission: the reservation is service_memory_max and one check domain\'s memory', () => {
    assert.ok(Number.isInteger(S.domainMemory) && S.domainMemory > 0, 'a check domain\'s memory is read from the engine\'s configuration');
    assert.deepEqual(S.domainRow?.reservation, { memory: S.serviceMemory, check_capacity: S.domainMemory }, `the reservation (${JSON.stringify(S.domainRow?.reservation)})`);
  });

  test('(g) the writable bounds at their minimums: writes to /tmp refused at 1 MiB and at 256 inodes; nothing of them on the host', () => {
    const fill = JSON.parse(S.report1.results.find((r) => r.path === '/act/fill-tmp')?.body ?? 'null');
    const inodes = JSON.parse(S.report1.results.find((r) => r.path === '/act/fill-inodes')?.body ?? 'null');
    assert.ok(fill && ['ENOSPC', 'EDQUOT'].includes(fill.error), `the byte bound refused a write (${JSON.stringify(fill)})`);
    assert.ok(fill.bytes <= MiB, `within service_writable_bytes (${fill.bytes})`);
    assert.ok(inodes && ['ENOSPC', 'EDQUOT'].includes(inodes.error), `the inode bound refused a file (${JSON.stringify(inodes)})`);
    assert.ok(inodes.count <= 256, `within service_writable_inodes (${inodes.count})`);
    assert.deepEqual(S.hostTmp, { fill: false, inodes: false }, "nothing of it in the host's /tmp");
    assert.equal(S.teardown.status, 'succeeded', 'torn down');
  });
});
