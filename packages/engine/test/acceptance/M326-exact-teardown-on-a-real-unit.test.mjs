// M326, exact teardown; cleanup is not the condition (slice 27; sandbox
// lane). M4 plan §3.5 M326; D4-O09, D4-O11; D4 §§2.4, 4.6, 6.2, 6.3, 9.5;
// E111; SEAM.md §§257, 290 to 295, 297.
//
// On the real `local_service` adapter.
//   (a) a teardown with M313's decoys present (a unit outside every Surety
//       prefix and a unit of a second home's prefix): only the
//       environment's positively owned unit is stopped, the decoys are
//       untouched, and afterwards no unit, cgroup, socket or runtime
//       directory of the environment remains; the teardown is `applied`;
//   (b) a teardown while a unit of the environment's own prefix that no
//       intent names runs (the test's own stray, SEAM.md §297): the owned
//       unit removed and listed on `cleanup.removed`, the stray under
//       `cleanup.left` with its reason, the read `conflicting`, no
//       `observed` written, an out-of-band row recorded;
//   (c) the next observation: `degraded` with the row open, never `down`.
//       The stray then removed by the test: the teardown's later read is
//       `applied` and the row is closed without a disposition (the
//       driver's ruling), the control.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §§257, 297). The engine's units carry this
// test's home's prefix and are stopped only by the engine. The test creates
// three units itself, each under an exact name it first reads `not-found`:
// two decoys (M313's) and one stray of its own prefix and its own
// environment, generation 90, which no intent names; each is stopped by
// that exact name only (`removeDecoy`, `removeStrayUnit`). No process is
// signalled, the user manager is never stopped, restarted or reloaded, and
// nothing is cleaned by pattern. The file ends with `operatorGuard`; every
// engine start carries the real-adapter switch (`hostDeployable`).

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { makeTempDir, removeDir } from './harness/engine.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { attemptsOf, environmentRecord, operationsOf, teardown, unitName, unitPrefix } from './harness/deploy/kernel.mjs';
import {
  cgroupsNamed,
  createDecoy,
  decoyName,
  deployHeld,
  endEnvironment,
  hostDeployable,
  hostEnvironment,
  listUnits,
  operatorGuard,
  releaseCheck,
  removeDecoy,
  teardownOnHost,
  ticksUntil,
  unitShow,
  verificationOf,
} from './harness/deploy/host.mjs';
import { createStrayUnit, observedOf, observeOnHost, oobRows, removeStrays, removeStrayUnit } from './harness/deploy/observe.mjs';

const POLICY = Object.freeze({ deploy_auto_retries_max: 0, service_memory_max: 67108864, observation_cadence: 3600 });
const PROPS = ['LoadState', 'ActiveState', 'InvocationID', 'MainPID'];

// The environment deployed, its round's check exiting 1 (the candidate stays developing).
async function deployed(ctx, env) {
  const { op, svc } = await deployHeld(ctx, env);
  releaseCheck(ctx, svc, { get: ['/hello'], exit: 1 });
  await verificationOf(ctx, op);
  return { op, svc };
}

// Files under $SURETY_HOME/run/ whose name carries the environment's id or prefix.
function runFilesOf(home, env) {
  const found = [];
  const walk = (dir) => {
    let names;
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      const full = join(dir, e.name);
      if (e.name.includes(env) || e.name.startsWith(unitPrefix(home, env))) found.push(full);
      if (e.isDirectory()) walk(full);
    }
  };
  walk(join(home, 'run'));
  return found;
}

const loadedOfPrefix = (home, env) => (listUnits() ?? []).filter((u) => u.unit.startsWith(unitPrefix(home, env))).map((u) => u.unit);

describe('M326 exact teardown on a real unit', () => {
  const shared = sharedFixture();
  let guard;
  let ctx;
  before(async () => {
    guard = operatorGuard();
    ctx = await hostDeployable(shared.context, guard, { policy: POLICY });
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('(a) with the decoys present: only the owned unit stopped, the decoys untouched, nothing of the environment left, the teardown applied', async () => {
    const env = await hostEnvironment(ctx, 'exact');
    const decoys = [];
    try {
      const { svc } = await deployed(ctx, env);
      const second = guard.root(makeTempDir('m326-second-home'));
      shared.context.after(() => removeDir(second));
      decoys.push(decoyName(), unitName(second, env.id, 1));
      for (const name of decoys) {
        guard.decoy(name);
        createDecoy(name, decoys);
      }
      const decoysBefore = decoys.map((n) => unitShow(n, PROPS));
      const op = await teardownOnHost(ctx, env);
      const [a] = attemptsOf(ctx.fx.home, op.id);
      assert.deepEqual([op.status, a.reconciliation_reads.at(-1)?.result], ['succeeded', 'applied'], `the teardown is applied (${op.status})`);
      const attempted = environmentRecord(ctx.fx.home, env.id).attempted;
      assert.equal(attempted?.outcome, 'teardown_applied', `attempted records it (${JSON.stringify(attempted)})`);
      assert.ok((attempted.cleanup?.removed ?? []).includes(svc.unit), 'cleanup lists the unit removed');
      assert.deepEqual(attempted.cleanup?.left ?? [], [], 'and nothing left');
      assert.deepEqual(decoys.map((n) => unitShow(n, PROPS)), decoysBefore, 'host-read: both decoys untouched (state, invocation, main process)');
      assert.deepEqual(loadedOfPrefix(ctx.fx.home, env.id), [], 'host-read: no unit of the environment remains');
      assert.deepEqual(cgroupsNamed(unitPrefix(ctx.fx.home, env.id)), [], 'host-read: no cgroup of the environment remains');
      assert.deepEqual(runFilesOf(ctx.fx.home, env.id), [], 'no socket or runtime directory of the environment remains');
    } finally {
      for (const name of decoys) removeDecoy(name, decoys);
      await endEnvironment(ctx, env);
    }
  });

  test('(b), (c) an unowned unit of the prefix running: the owned unit removed and listed, the stray left with its reason, conflicting, no observed written, an out-of-band row; the next observation degraded, never down', async () => {
    const env = await hostEnvironment(ctx, 'unowned');
    try {
      const { svc } = await deployed(ctx, env);
      const stray = createStrayUnit(ctx.fx.home, env.id, 90);
      assert.equal(unitShow(stray, ['ActiveState']).ActiveState, 'active', 'the fixture is live: the stray runs');
      const observedBefore = JSON.stringify(observedOf(ctx.fx.home, env.id));
      const asked = await teardown(ctx.fx.engine, ctx.project, env.name);
      assert.ok(asked.status >= 200 && asked.status < 300, `the teardown is accepted (→ ${asked.status} ${asked.text})`);
      const read = await ticksUntil(ctx.fx, ctx.project, () => {
        const op = operationsOf(ctx.fx.home, ctx.project, 'teardown').filter((o) => o.target?.environment === env.id).at(-1);
        const [a] = op ? attemptsOf(ctx.fx.home, op.id) : [];
        return a?.reconciliation_reads?.length ? { op, a } : undefined;
      }, { what: 'the teardown\'s first read' });
      assert.equal(read.a.reconciliation_reads[0].result, 'conflicting', `an unowned unit of the prefix makes the teardown conflicting, never applied (D4 §4.6) (${JSON.stringify(read.a.reconciliation_reads.map((r) => r.result))})`);
      assert.notEqual(unitShow(svc.unit, ['ActiveState'])?.ActiveState, 'active', 'host-read: the owned unit is stopped');
      assert.equal(unitShow(stray, ['ActiveState']).ActiveState, 'active', 'host-read: the stray is untouched');
      const cleanup = environmentRecord(ctx.fx.home, env.id).attempted?.cleanup;
      assert.ok((cleanup?.removed ?? []).includes(svc.unit), `cleanup.removed lists the owned unit (${JSON.stringify(cleanup)})`);
      const left = (cleanup?.left ?? []).find((l) => l.resource === stray);
      assert.ok(left && typeof left.reason === 'string' && left.reason.length > 0, 'cleanup.left lists the stray with its reason');
      assert.equal(JSON.stringify(observedOf(ctx.fx.home, env.id)), observedBefore, 'the teardown writes no observed (D4 §4.6)');
      const [row] = oobRows(ctx.fx.home, env.id);
      assert.ok(row && JSON.stringify(row.found).includes(stray), `an out-of-band row records the stray (D4 §6.3) (${JSON.stringify(row)})`);

      const next = await observeOnHost(ctx, env, ticksUntil, { seconds: 3601 });
      assert.equal(next.condition, 'degraded', `the next observation: degraded with the row open, never down (D4-O11) (${next.condition})`);

      assert.equal(removeStrayUnit(ctx.fx.home, stray), 'not-found', 'the stray removed by its exact name');
      const settled = await ticksUntil(ctx.fx, ctx.project, () => (attemptsOf(ctx.fx.home, read.op.id).some((a) => a.reconciliation_reads.at(-1)?.result === 'applied') ? true : undefined), { what: 'the teardown to read applied once the stray is gone' });
      assert.ok(settled);
      const closed = oobRows(ctx.fx.home, env.id).find((r) => r.id === row.id);
      assert.ok(closed?.closed_at && closed.disposition === null, `the row of a unit now gone is closed and kept, with no disposition (${JSON.stringify(closed)})`);
    } finally {
      removeStrays(ctx.fx.home);
      await endEnvironment(ctx, env);
    }
  });
});
