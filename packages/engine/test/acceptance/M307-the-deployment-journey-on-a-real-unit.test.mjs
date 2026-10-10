// M307, the deployment journey on a real unit (slice 24; sandbox lane). M4
// plan §3.2 M307; D4 §§1, 3.4, 5, 9.2, 9.3; E40; E110; E121 item 4; BS4
// §§4.1, 8; SEAM.md §§256 to 259.
//
// The whole of D4 §1 again, as M301 made it on the scripted adapter, now
// with the real `local_service` adapter (`--harness-deploy-adapter real`),
// a test-built fixture service (harness/deploy/fixture-service.cjs, as the
// revision's `server.js`) and a test-owned `post_deploy_behavior` check
// program calling SURETY_TARGET_APP (harness/deploy/target-check.mjs), in
// a real `check` domain, under the adapter qualification stand-in (SEAM.md
// §248). Made once in the `before` hook; each case reads one clause of the
// row from what was recorded and read from the host on the way.
//   (a) the deploy: one unit `surety-<h>-<env>-g1.service`, its name derived
//       from the test's home and recorded in the attempt intent before the
//       unit existed (read at `adapter.before_host_call`); `MainPID` the
//       launcher; one launch authorization; the init's pid and start time
//       recorded at the grant and the application instance at `started`,
//       each equal to the host's read;
//   (b) `/proc/<pid>/root/surety/app` hashes to the sealed digest;
//   (c) the round: the check's process in its own `check` domain, reaching
//       the service only through the link; both reads `match`; `verified`;
//   (d) `alpha_deployed`;
//   (e) teardown `applied`; afterwards no unit, cgroup, socket or directory
//       of the prefix (host-read).
// (f), the same with the adapter qualified by `qualify-adapter` and no
// stand-in, is slice 29's (the plan's "from slice 29"; COVERAGE.md).
//
// SAFETY (BS4 §4.1; E64; SEAM.md §257). The only unit is the one the engine
// creates under this test's own home's prefix; the test acts on no unit and
// signals nothing. The fixture service is used in its benign routes only
// (no act). The check program only asks the service for /hello. The file
// ends with the operator's guard (row M313), which reports any leftover by
// exact name. Its first engine start carries the real-adapter switch, so an
// engine without it refuses to start before anything is created.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { interfacesOfPid } from './harness/checks/fixtures.mjs';
import { namespacesOf } from './harness/scripted.mjs';
import { CGROUP_ROOT } from './harness/sandbox/cgroup.mjs';
import { hostProcess } from './harness/sandbox/procs.mjs';
import {
  armBarrier,
  artifactsOf,
  attemptIntent,
  attemptsOf,
  candidateRow,
  deploy,
  releaseBarrier,
  tickToBarrier,
  unitName,
  unitPrefix,
} from './harness/deploy/kernel.mjs';
import {
  RUNTIME,
  UNIT_PROPS,
  appRoot,
  cgroupsNamed,
  cmdlineOf,
  exeShaOf,
  heldCheck,
  hostDeployable,
  hostEnvironment,
  manifestDigest,
  newestOperation,
  operatorGuard,
  ppidOf,
  procInstance,
  releaseCheck,
  serviceOf,
  targetReport,
  teardownOnHost,
  ticksUntil,
  treeManifest,
  unitShow,
  unitsOfHome,
  verificationOf,
} from './harness/deploy/host.mjs';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';

describe('M307 the deployment journey on a real unit: deploy, read from the host, verify through the link, complete, tear down', () => {
  const shared = sharedFixture();
  let guard;
  let J;
  before(async () => {
    guard = operatorGuard();
    const ctx = await hostDeployable(shared.context, guard);
    const env = await hostEnvironment(ctx, 'alpha');
    const { fx, project } = ctx;
    J = { ctx, env, fx };
    const unit = unitName(fx.home, env.id, 1);

    // The request; the effect held before its first host call.
    await armBarrier(fx.engine, 'adapter.before_host_call', 'pause');
    J.request = await deploy(fx.engine, project, ctx.candidate.id, env.name);
    await tickToBarrier(fx, project, 'adapter.before_host_call', { attempts: 20 });
    const op = newestOperation(ctx, env);
    const [attempt] = attemptsOf(fx.home, op.id);
    J.beforeHost = { unit, intent: attemptIntent(fx.home, attempt?.id), show: unitShow(unit, ['LoadState']) };
    await releaseBarrier(fx.engine, 'adapter.before_host_call');

    // The round's check held between its two reads: the host read now.
    J.held = await ticksUntil(fx, project, () => heldCheck(ctx, env), { what: "the round's post-deploy check to hold" });
    J.op = newestOperation(ctx, env);
    const svc = serviceOf(ctx, env, J.op);
    J.svc = svc;
    J.show = unitShow(svc.unit, UNIT_PROPS);
    J.init = svc.init?.pid ? { now: procInstance(svc.init.pid), ppid: ppidOf(svc.init.pid), proc: hostProcess(svc.init.pid) } : null;
    J.app = svc.app?.pid ? { now: procInstance(svc.app.pid), ppid: ppidOf(svc.app.pid), proc: hostProcess(svc.app.pid), exe: exeShaOf(svc.app.pid), argv: cmdlineOf(svc.app.pid) } : null;
    J.mainPid = Number(J.show?.MainPID);
    J.mainArgv = J.mainPid > 1 ? cmdlineOf(J.mainPid) : null;
    J.tree = svc.app?.pid ? treeManifest(appRoot(svc.app.pid)) : null;
    J.check = { netIfs: interfacesOfPid(J.held.member.pid), ns: namespacesOf(J.held.member.pid), appNs: svc.app?.pid ? namespacesOf(svc.app.pid) : null, target: J.held.member.environ?.get('SURETY_TARGET_APP') ?? null };
    releaseCheck(ctx, svc, { get: ['/hello'], exit: 0 });
    J.verification = await verificationOf(ctx, J.op);
    J.report = targetReport(ctx, J.held.execution);

    // Completion.
    J.completed = await ticksUntil(fx, project, () => (candidateRow(fx.home, ctx.candidate.id).progress === 'alpha_deployed' ? true : undefined), { what: 'the candidate to be alpha_deployed' });

    // The teardown.
    J.teardown = await teardownOnHost(ctx, env);
    J.afterTeardown = {
      units: unitsOfHome(fx.home).filter((u) => u.unit.startsWith(unitPrefix(fx.home, env.id))),
      show: unitShow(svc.unit, ['LoadState']),
      cgroups: cgroupsNamed(unitPrefix(fx.home, env.id)),
      runFiles: (() => {
        try {
          return readdirSync(join(fx.home, 'run'), { recursive: true }).filter((n) => String(n).includes(env.id));
        } catch {
          return [];
        }
      })(),
    };
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('(a) one unit surety-<h>-<env>-g1.service, named in the attempt intent before it existed; MainPID the launcher; one launch authorization; the init and the application instance recorded, each equal to the host read', () => {
    const { fx, env, beforeHost, svc, show, init, app, mainPid, mainArgv } = J;
    assert.deepEqual(beforeHost.intent?.create_units, [beforeHost.unit], "the attempt intent names g1's unit, derived from this test's home");
    assert.equal(beforeHost.show?.LoadState, 'not-found', 'at adapter.before_host_call the unit does not exist yet: its name was recorded first');
    assert.equal(svc.unit, unitName(fx.home, env.id, 1), 'the unit deployed is that name');
    assert.deepEqual([show?.LoadState, show?.ActiveState], ['loaded', 'active'], `the manager has the unit active (${JSON.stringify(show)})`);
    assert.ok(init && app, 'the init and the application are recorded and exist on the host');
    assert.ok(mainPid > 1 && mainPid !== svc.app.pid && mainPid !== svc.init.pid, `MainPID (${mainPid}) is neither the init (${svc.init.pid}) nor the application (${svc.app.pid})`);
    assert.notDeepEqual(mainArgv, env.content.start, 'MainPID is not running the start command: it is the launcher');
    assert.equal(init.ppid, mainPid, 'the init is a child of the launcher (D4 §3.4 step 2)');
    assert.equal(init.proc?.innerPid, 1, 'the init has innermost NSpid 1');
    assert.equal(app.ppid, svc.init.pid, 'the application is a child of the recorded init (§3.4 step 3)');
    assert.deepEqual(svc.init, init.now, 'the init instance recorded at the grant is the host read (pid, start time)');
    assert.deepEqual([svc.app.pid, svc.app.start_time], [app.now.pid, app.now.start_time], 'the application instance recorded at started is the host read');
    assert.deepEqual([svc.app.exe, svc.app.exe_sha256], [RUNTIME.path, RUNTIME.sha256], "its executable is the configured runtime, by path and the host read's hash");
    assert.equal(app.exe, RUNTIME.sha256, "the host's hash of /proc/<pid>/exe");
    assert.deepEqual(svc.app.argv, env.content.start, 'its arguments recorded are the start command');
    assert.deepEqual(app.argv, env.content.start, "and /proc/<pid>/cmdline says so");
    const granted = eventsOfType(fx.home, 'deploy.launch_authorized').filter((e) => e.subject?.attempt === svc.attempt.id);
    assert.equal(granted.length, 1, 'one launch authorization');
    assert.deepEqual(granted[0].payload?.init, svc.init, "the grant's event names the init instance it accepted");
  });

  test('(b) /proc/<pid>/root/surety/app, walked from the host, hashes to the sealed digest', () => {
    const { ctx, op, tree } = J;
    const [artifact] = artifactsOf(ctx.fx.home, ctx.project);
    assert.ok(tree, 'the tree was read');
    assert.deepEqual(tree.odd, [], 'no link or special file in it');
    assert.equal(manifestDigest(tree.entries), op.subject?.artifact_digest, "the running tree's canonical manifest has the operation's digest");
    assert.equal(op.subject?.artifact_digest, artifact.digest, "which is the sealed artifact's");
  });

  test('(c) the round: the check runs in its own check domain and reaches the service only through the link; both identity reads match; verified', () => {
    const { held, svc, check, verification, report, env } = J;
    assert.notEqual(held.domain.cgroup_path, join(CGROUP_ROOT, J.show.ControlGroup), "the check's domain is not the service's");
    assert.ok(held.domain.check_execution, 'its domain is a check domain');
    assert.deepEqual(check.netIfs, ['lo'], 'the check has only a loopback in its network namespace');
    assert.notEqual(check.ns.net, check.appNs?.net, "and that namespace is not the service's");
    assert.match(check.target ?? '', /^http:\/\/127\.0\.0\.1:\d+$/, 'SURETY_TARGET_APP names a loopback address in its own namespace (D4 §5.2)');
    const hello = report.report.results.find((r) => r.path === '/hello');
    assert.equal(hello?.status, 200, `the check reached the service (${JSON.stringify(report.report)})`);
    assert.equal(JSON.parse(hello.body).mark, env.content.env.MARK, "and it was this environment's service that answered");
    const { row, round } = verification;
    assert.equal(row.outcome, 'verified', `verified (${JSON.stringify({ outcome: row.outcome, missing: row.missing })})`);
    assert.deepEqual(row.identity_reads.map((r) => [r.bracket, r.match, r.generation]), [['first', 'match', 1], ['second', 'match', 1]]);
    for (const r of row.identity_reads) assert.deepEqual([r.instance?.pid, r.instance?.start_time], [svc.app.pid, svc.app.start_time], 'with the original application instance');
    assert.equal(round.round, 1);
  });

  test('(d) alpha_deployed', () => {
    assert.equal(J.completed, true);
    assert.equal(candidateRow(J.fx.home, J.ctx.candidate.id).progress, 'alpha_deployed');
  });

  test('(e) teardown applied; afterwards no unit, cgroup, socket or directory of the prefix, read from the host', () => {
    const { teardown, afterTeardown } = J;
    const [attempt] = attemptsOf(J.fx.home, teardown.id);
    assert.equal(teardown.status, 'succeeded');
    assert.equal(attempt?.reconciliation_reads?.at(-1)?.result, 'applied', "the teardown's reconcile read applied");
    assert.deepEqual(afterTeardown.units, [], 'no unit of the prefix is loaded');
    assert.equal(afterTeardown.show?.LoadState, 'not-found', 'the unit is gone');
    assert.deepEqual(afterTeardown.cgroups, [], 'no cgroup of the prefix');
    assert.deepEqual(afterTeardown.runFiles, [], 'no socket or runtime directory of the environment under $SURETY_HOME/run/');
  });
});
