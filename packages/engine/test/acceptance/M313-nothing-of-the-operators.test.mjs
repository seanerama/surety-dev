// M313, nothing of the operator's (slice 24; sandbox lane). M4 plan §3.2
// M313; D4 §9.5, D4-T02; BS4 §4.1 rules 1, 2, 4 and 7; SEAM.md §257.
//
// Every slice-24 file (kernel and sandbox) ends with the operator's guard
// of harness/deploy/host.mjs, this row's before-and-after check: every unit,
// cgroup, socket and directory the file touched carries its own home's
// prefix and none remains; a leftover fails the file and is reported by
// exact name, never cleaned by pattern; the user manager reports `running`
// before and after; every service unit outside the prefix that was active
// before is active after. This file adds the decoys:
//   (a) a decoy unit outside every Surety prefix and a unit of a second test
//       home's prefix (the same environment id, another home's hash), each
//       created by this test under an exact name, through a deploy, an
//       engine restart (recovery) and a teardown: both untouched;
//   (b) the manager `running` before and after, and the units outside the
//       prefix in the state they were in.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §257). The decoys are created by
// `systemd-run --user` under exact names that the test refuses if they
// exist, run `/usr/bin/sleep`, and are stopped by those exact names at the
// end. They are created only after this file's engine has deployed a real
// unit, so an engine that cannot (no real adapter) fails the file before any
// decoy exists. The engine's own units carry this test's home's prefix; the
// test signals nothing but its own engine child (an engine restart, by its
// child handle). Nothing stops, restarts or reloads the user manager.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { makeTempDir, removeDir } from './harness/engine.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { tick } from './harness/runs.mjs';
import { deploy, unitName, unitPrefix } from './harness/deploy/kernel.mjs';
import {
  REAL_ADAPTER,
  createDecoy,
  decoyName,
  heldCheck,
  hostDeployable,
  hostEnvironment,
  listUnits,
  managerState,
  newestOperation,
  operatorGuard,
  releaseCheck,
  removeDecoy,
  serviceOf,
  teardownOnHost,
  ticksUntil,
  unitShow,
  unitsOfHome,
  verificationOf,
} from './harness/deploy/host.mjs';

const DECOY_PROPS = ['LoadState', 'ActiveState', 'SubState', 'InvocationID', 'MainPID'];

describe("M313 nothing of the operator's: decoys through a deploy, a recovery and a teardown", () => {
  const shared = sharedFixture();
  let guard;
  let M;
  before(async () => {
    guard = operatorGuard();
    const ctx = await hostDeployable(shared.context, guard);
    const alpha = await hostEnvironment(ctx, 'alpha');
    const beta = await hostEnvironment(ctx, 'beta');
    const { fx, project } = ctx;
    M = { ctx, alpha, beta, before: { manager: managerState() } };

    // First, the engine deploys a real unit (alpha): only then does the test create anything itself.
    // The check exits 1 so the candidate stays developing and beta's request is an ordinary one.
    await deploy(fx.engine, project, ctx.candidate.id, alpha.name);
    await ticksUntil(fx, project, () => heldCheck(ctx, alpha), { what: "alpha's round to hold its check" });
    const opA = newestOperation(ctx, alpha);
    M.svcA = serviceOf(ctx, alpha, opA);
    releaseCheck(ctx, M.svcA, { get: ['/hello'], exit: 1 });
    await verificationOf(ctx, opA);

    // The decoys, by exact name: one outside every Surety prefix; one of a second test home's prefix, beta's id.
    const second = guard.root(makeTempDir('m313-second-home'));
    shared.context.after(() => removeDir(second));
    M.decoys = [decoyName(), unitName(second, beta.id, 1)];
    assert.ok(!M.decoys[0].startsWith('surety-'), 'the first decoy is outside every Surety prefix');
    assert.ok(M.decoys[1].startsWith('surety-') && !M.decoys[1].startsWith(unitPrefix(fx.home, beta.id)), "the second carries a second home's prefix, not this home's");
    for (const name of M.decoys) {
      guard.decoy(name);
      createDecoy(name, M.decoys);
    }
    M.decoysBefore = Object.fromEntries(M.decoys.map((n) => [n, unitShow(n, DECOY_PROPS)]));

    // Through a deploy (beta), a recovery (the engine killed and started again) and a teardown of each.
    await deploy(fx.engine, project, ctx.candidate.id, beta.name);
    await ticksUntil(fx, project, () => heldCheck(ctx, beta), { what: "beta's round to hold its check" });
    const opB = newestOperation(ctx, beta);
    M.svcB = serviceOf(ctx, beta, opB);
    releaseCheck(ctx, M.svcB, { get: ['/hello'], exit: 1 });
    await verificationOf(ctx, opB);
    M.afterDeploy = Object.fromEntries(M.decoys.map((n) => [n, unitShow(n, DECOY_PROPS)]));

    await fx.engine.kill();
    await fx.start({ args: [...REAL_ADAPTER] });
    await tick(fx.engine, project, { rounds: 3, timeoutMs: 180_000 });
    M.afterRecovery = Object.fromEntries(M.decoys.map((n) => [n, unitShow(n, DECOY_PROPS)]));
    M.survivors = unitsOfHome(fx.home).map((u) => u.unit).sort();

    M.teardowns = [await teardownOnHost(ctx, beta), await teardownOnHost(ctx, alpha)];
    M.afterTeardown = Object.fromEntries(M.decoys.map((n) => [n, unitShow(n, DECOY_PROPS)]));
    M.ownLeft = unitsOfHome(fx.home).map((u) => u.unit);
    M.unitsNow = listUnits();
    M.removed = Object.fromEntries(M.decoys.map((n) => [n, removeDecoy(n, M.decoys)]));
    M.after = { manager: managerState() };
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('(a) the decoy outside every prefix and the unit of a second home\'s prefix are untouched through a deploy, a recovery and a teardown, then removed by exact name', () => {
    for (const name of M.decoys) {
      const was = M.decoysBefore[name];
      assert.deepEqual([was.LoadState, was.ActiveState], ['loaded', 'active'], `${name} was created and is active`);
      for (const [when, now] of [['the deploy', M.afterDeploy[name]], ['the recovery', M.afterRecovery[name]], ['the teardowns', M.afterTeardown[name]]]) {
        assert.deepEqual([now.ActiveState, now.InvocationID, now.MainPID], [was.ActiveState, was.InvocationID, was.MainPID], `${name} is untouched by ${when} (same state, invocation and main process)`);
      }
      assert.equal(M.removed[name], 'not-found', `${name} is removed by its exact name`);
    }
    assert.deepEqual(M.survivors, [M.svcA.unit, M.svcB.unit].sort(), "after the recovery the engine's own units survived, and only they carry its prefix");
    assert.deepEqual(M.teardowns.map((op) => op.status), ['succeeded', 'succeeded'], 'both teardowns succeeded');
    assert.deepEqual(M.ownLeft, [], "nothing of this home's prefix remains");
  });

  test('(b) the user manager reports running before and after; every service unit outside the prefix active before is active after', () => {
    assert.equal(M.before.manager, 'running');
    assert.equal(M.after.manager, 'running');
    const changed = guard.before.units
      .filter((u) => u.unit.endsWith('.service') && u.active === 'active' && !u.unit.startsWith('surety-'))
      .filter((u) => (M.unitsNow ?? []).find((x) => x.unit === u.unit)?.active !== 'active')
      .map((u) => u.unit);
    assert.deepEqual(changed, [], 'no unit of the operator\'s changed state');
  });
});
