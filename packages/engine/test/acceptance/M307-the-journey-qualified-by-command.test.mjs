// M307 (f), the deployment journey on a real unit with the adapter qualified
// by command and no stand-in (slice 29, deferred here by slice 24; sandbox
// lane). M4 plan §3.2 M307 (f); D4 §§1, 2.6, 3.4, 5, 9.2; E40; E127 item 9;
// SEAM.md §§248, 256 to 259, 321, 322.
//
// As M307-the-deployment-journey-on-a-real-unit (cases (a) to (e)), but the
// adapter is qualified in the test's own home by POST /v1/adapters/:a/qualify
// (the route `surety qualify-adapter` is the client of; the CLI itself is
// M338's and M339's), and the qualification stand-in of SEAM §248 is never
// called: no row labelled `test_fixture` exists in the home. Made once in
// the `before` hook; each case reads clauses of the row:
//   (f)(a) one unit `surety-<h>-<env>-g1.service`, named in the attempt
//          intent; `MainPID` the launcher; one launch authorization; the init
//          and the application instance recorded, each equal to the host read;
//   (f)(b) `/proc/<pid>/root/surety/app` hashes to the sealed digest;
//   (f)(c) the check in its own `check` domain; both reads `match`; `verified`;
//   (f)(d) `alpha_deployed`;
//   (f)(e) teardown `applied`, nothing of the prefix left;
//   (f)    the qualification `current` with no fixture label, the one the
//          round and the verification row name.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §257). The only units are the engine's,
// under this test's own home's prefix: the qualification's (created and
// removed by the engine) and the deployment's. The test acts on no unit and
// signals nothing; the fixture service is used in its benign routes only and
// the check program only asks for /hello. The file ends with the operator's
// guard; every engine start carries the real-adapter switch.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { CGROUP_ROOT } from './harness/sandbox/cgroup.mjs';
import { artifactsOf, attemptsOf, candidateRow, deploy, unitName, unitPrefix } from './harness/deploy/kernel.mjs';
import {
  RUNTIME,
  UNIT_PROPS,
  appRoot,
  cgroupsNamed,
  cmdlineOf,
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
  teardownOnHost,
  ticksUntil,
  treeManifest,
  unitShow,
  unitsOfHome,
  verificationOf,
} from './harness/deploy/host.mjs';
import { adapterQualifications, qualificationRow, qualifyAdapter } from './harness/deploy/qualify.mjs';

describe('M307 (f) the deployment journey on a real unit, the adapter qualified by command, no stand-in', () => {
  const shared = sharedFixture();
  let guard;
  let J;
  before(async () => {
    guard = operatorGuard();
    const ctx = await hostDeployable(shared.context, guard, { qualify: false });
    const { fx, project } = ctx;
    J = { ctx, fx };
    J.qualification = await qualifyAdapter(fx.engine);
    const env = await hostEnvironment(ctx, 'alpha', { adapter_version: J.qualification.adapter_version });
    J.env = env;

    J.request = await deploy(fx.engine, project, ctx.candidate.id, env.name);
    J.held = await ticksUntil(fx, project, () => heldCheck(ctx, env), { what: "the round's post-deploy check to hold" });
    J.op = newestOperation(ctx, env);
    const svc = serviceOf(ctx, env, J.op);
    J.svc = svc;
    J.show = unitShow(svc.unit, UNIT_PROPS);
    J.init = svc.init?.pid ? { now: procInstance(svc.init.pid), ppid: ppidOf(svc.init.pid) } : null;
    J.app = svc.app?.pid ? { now: procInstance(svc.app.pid), ppid: ppidOf(svc.app.pid), argv: cmdlineOf(svc.app.pid) } : null;
    J.mainPid = Number(J.show?.MainPID);
    J.tree = svc.app?.pid ? treeManifest(appRoot(svc.app.pid)) : null;
    releaseCheck(ctx, svc, { get: ['/hello'], exit: 0 });
    J.verification = await verificationOf(ctx, J.op);
    J.completed = await ticksUntil(fx, project, () => (candidateRow(fx.home, ctx.candidate.id).progress === 'alpha_deployed' ? true : undefined), { what: 'the candidate to be alpha_deployed' });
    // Objection 220 (S3; SEAM.md §576): the candidate as it stands at completion, before the teardown.
    J.atCompletion = candidateRow(fx.home, ctx.candidate.id);

    J.teardown = await teardownOnHost(ctx, env);
    J.afterTeardown = {
      units: unitsOfHome(fx.home).filter((u) => u.unit.startsWith(unitPrefix(fx.home, env.id))),
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

  test('(f) the qualification: current, by command, no fixture label; the stand-in never called; the round and the verification row name it', () => {
    const { fx } = J;
    assert.equal(J.qualification.qualified, true, `qualified by the route in the test's home (${JSON.stringify(J.qualification).slice(0, 400)})`);
    const row = qualificationRow(fx.home, J.qualification.adapter_qualification);
    assert.equal(row?.status, 'current', 'its row is current');
    assert.equal(row.label, null, 'with no fixture label');
    assert.deepEqual(adapterQualifications(fx.home).filter((r) => r.label !== null), [], 'no labelled row exists: the stand-in of SEAM.md §248 was never called');
    const qualified = eventsOfType(fx.home, 'adapter.qualified');
    assert.ok(qualified.length > 0 && qualified.every((e) => e.payload?.test_fixture !== true), 'no adapter.qualified carries a fixture label');
    assert.equal(J.verification.round.adapter_qualification, row.id, 'the round froze this qualification (D4 §5.3 item 1)');
    assert.equal(J.verification.row.adapter_qualification, row.id, 'the verification row names it');
  });

  test('(f)(a) one unit surety-<h>-<env>-g1.service named in the attempt intent; MainPID the launcher; one launch authorization; the init and the application instance each equal to the host read', () => {
    const { fx, env, svc, show, init, app, mainPid } = J;
    assert.equal(svc.unit, unitName(fx.home, env.id, 1), 'the unit deployed is g1 under this home\'s prefix');
    assert.deepEqual([show?.LoadState, show?.ActiveState], ['loaded', 'active'], `the manager has the unit active (${JSON.stringify(show)})`);
    assert.ok(init && app, 'the init and the application are recorded and exist on the host');
    assert.ok(mainPid > 1 && mainPid !== svc.app.pid && mainPid !== svc.init.pid, 'MainPID is the launcher, neither the init nor the application');
    assert.equal(init.ppid, mainPid, 'the init is a child of the launcher');
    assert.equal(app.ppid, svc.init.pid, 'the application is a child of the recorded init');
    assert.deepEqual(svc.init, init.now, 'the init instance recorded at the grant is the host read');
    assert.deepEqual([svc.app.pid, svc.app.start_time], [app.now.pid, app.now.start_time], 'the application instance recorded at started is the host read');
    assert.deepEqual([svc.app.exe, svc.app.argv], [RUNTIME.path, env.content.start], 'its executable and arguments are the configuration\'s');
    assert.deepEqual(app.argv, env.content.start, '/proc/<pid>/cmdline says so');
    assert.equal(eventsOfType(fx.home, 'deploy.launch_authorized').filter((e) => e.subject?.attempt === svc.attempt.id).length, 1, 'one launch authorization');
  });

  test('(f)(b) /proc/<pid>/root/surety/app, walked from the host, hashes to the sealed digest', () => {
    const [artifact] = artifactsOf(J.fx.home, J.ctx.project);
    assert.ok(J.tree, 'the tree was read');
    assert.deepEqual(J.tree.odd, [], 'no link or special file in it');
    assert.equal(manifestDigest(J.tree.entries), J.op.subject?.artifact_digest, "the running tree's canonical manifest has the operation's digest");
    assert.equal(J.op.subject?.artifact_digest, artifact.digest, "which is the sealed artifact's");
  });

  test('(f)(c) the check in its own check domain; both identity reads match with the original instance; verified', () => {
    const { held, svc, verification } = J;
    assert.notEqual(held.domain.cgroup_path, join(CGROUP_ROOT, J.show.ControlGroup), "the check's domain is not the service's");
    assert.ok(held.domain.check_execution, 'its domain is a check domain');
    const { row } = verification;
    assert.equal(row.outcome, 'verified', `verified (${JSON.stringify({ outcome: row.outcome, missing: row.missing })})`);
    assert.deepEqual(row.identity_reads.map((r) => [r.bracket, r.match, r.generation]), [['first', 'match', 1], ['second', 'match', 1]]);
    for (const r of row.identity_reads) assert.deepEqual([r.instance?.pid, r.instance?.start_time], [svc.app.pid, svc.app.start_time], 'with the original application instance');
  });

  // Objection 220 (the owner's ruling S3 of 2026-10-28; SEAM.md §576): the
  // historical completion read at completion; current availability after
  // the teardown, which withdraws it.
  test('(f)(d) alpha_deployed (at completion, before the teardown)', () => {
    assert.equal(J.completed, true);
    assert.equal(J.atCompletion.progress, 'alpha_deployed');
    const advanced = eventsOfType(J.fx.home, 'candidate.advanced').filter((e) => e.subject?.candidate === J.ctx.candidate.id);
    assert.deepEqual(advanced.map((e) => [e.payload?.from, e.payload?.to]), [['developing', 'alpha_deployed']], 'the historical record: candidate.advanced once');
  });

  test('(f)(d) after the teardown: no claim of current availability; the candidate developing, withdrawn once by the teardown; candidate.advanced kept', () => {
    assert.equal(candidateRow(J.fx.home, J.ctx.candidate.id).progress, 'developing');
    const withdrawn = eventsOfType(J.fx.home, 'candidate.alpha_withdrawn').filter((e) => e.subject?.candidate === J.ctx.candidate.id);
    assert.deepEqual(withdrawn.map((e) => [e.payload?.from, e.payload?.to, e.payload?.environment, e.payload?.operation]), [['alpha_deployed', 'developing', J.env.id, J.teardown.id]], 'one candidate.alpha_withdrawn naming the environment and the teardown operation');
    assert.equal(eventsOfType(J.fx.home, 'candidate.advanced').filter((e) => e.subject?.candidate === J.ctx.candidate.id).length, 1, 'the historical record kept');
  });

  test('(f)(e) teardown applied; afterwards no unit, cgroup, socket or directory of the prefix, read from the host', () => {
    const { teardown, afterTeardown } = J;
    const [attempt] = attemptsOf(J.fx.home, teardown.id);
    assert.equal(attempt?.reconciliation_reads?.at(-1)?.result, 'applied', "the teardown's reconcile read applied");
    assert.deepEqual(afterTeardown.units, [], 'no unit of the prefix is loaded');
    assert.deepEqual(afterTeardown.cgroups, [], 'no cgroup of the prefix');
    assert.deepEqual(afterTeardown.runFiles, [], 'no socket or runtime directory of the environment under $SURETY_HOME/run/');
  });
});
