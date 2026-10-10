// M320 (c), (a): reconcile on a real unit with the manager unreadable
// (slice 26; sandbox lane). M4 plan §3.4 M320; D4-A03; D4 §§2.3, 2.4, 2.6
// (`unreadable`); BS4 §4.1 rule 4; SEAM.md §§256, 257, 262, 273, 277.
//
// On the real `local_service` adapter. A failed query's empty result is
// never a success: with the user manager unreadable for one reconcile read
// (the adapter's bus address pointed at a path that does not exist, the
// fault `bus_address_missing`; never by stopping the manager), a deploy's
// read is `unknown`, never `applied` or `absent`, and a teardown's read is
// `unknown`, never `applied`, although nothing of the environment is left;
// the next read, the manager readable again, settles each (`applied`), the
// control. The kernel file M320-reconcile-outcomes-on-the-scripted-target
// holds the rest of the row.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §257). The only unit is the engine's own,
// under this test's home's prefix; the test acts on no unit and signals
// nothing; the fault changes the address the adapter's next read uses, and
// the manager is read `running` before and after (the operator's guard).
// The file ends with `operatorGuard`; its first engine start carries the
// real-adapter switch (`hostDeployable`).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { attemptsOf, deploy, operationsOf, teardown } from './harness/deploy/kernel.mjs';
import { armDeployFault, endEnvironment, hostDeployable, hostEnvironment, listUnits, managerState, newestOperation, operatorGuard, settleRound, ticksUntil } from './harness/deploy/host.mjs';
import { readsOf } from './harness/deploy/recover.mjs';
import { unitPrefix } from './harness/deploy/kernel.mjs';

describe('M320 (c) a failed query\'s empty result on a real unit', () => {
  const shared = sharedFixture();
  let guard;
  let ctx;
  before(async () => {
    guard = operatorGuard();
    ctx = await hostDeployable(shared.context, guard, {});
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('the manager unreadable for one read: the deploy\'s read unknown, then applied; the teardown\'s read unknown though nothing is left, then applied', async () => {
    const env = await hostEnvironment(ctx, 'unread');
    try {
      await armDeployFault(ctx, env, 'bus_address_missing');
      await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
      const op = await ticksUntil(ctx.fx, ctx.project, () => newestOperation(ctx, env), { what: 'the deploy to be intended' });
      const a = await ticksUntil(ctx.fx, ctx.project, () => {
        const [x] = attemptsOf(ctx.fx.home, op.id);
        return x && readsOf(x).some((r) => r !== 'unknown') ? x : undefined;
      }, { what: 'the deploy\'s attempt to be read after the unreadable read' });
      assert.equal(readsOf(a)[0], 'unknown', `the read made with the manager unreadable is unknown (D4 §2.3), never applied or absent (${JSON.stringify(readsOf(a))})`);
      assert.equal(readsOf(a).find((r) => r !== 'unknown'), 'applied', 'the next read, readable, settles it: applied (the control)');
      assert.equal(managerState(), 'running', 'the manager was never stopped');
      await settleRound(ctx, env, op, { plan: { get: ['/hello'], exit: 1 } });

      await armDeployFault(ctx, env, 'bus_address_missing');
      const asked = await teardown(ctx.fx.engine, ctx.project, env.name);
      assert.ok(asked.status >= 200 && asked.status < 300, `the teardown is accepted (→ ${asked.status} ${asked.text})`);
      const down = await ticksUntil(ctx.fx, ctx.project, () => {
        const o = operationsOf(ctx.fx.home, ctx.project, 'teardown').filter((x) => x.target?.environment === env.id).at(-1);
        const [x] = o ? attemptsOf(ctx.fx.home, o.id) : [];
        return x && readsOf(x).some((r) => r !== 'unknown') ? x : undefined;
      }, { what: 'the teardown\'s attempt to be read after the unreadable read' });
      assert.equal(readsOf(down)[0], 'unknown', `nothing of the environment may be left, but an unread listing is unknown, never applied (${JSON.stringify(readsOf(down))})`);
      assert.equal(readsOf(down).find((r) => r !== 'unknown'), 'applied', 'the next read settles it: applied');
      assert.deepEqual((listUnits() ?? []).filter((u) => u.unit.startsWith(unitPrefix(ctx.fx.home, env.id))), [], 'host-read: no unit of the environment is left');
    } finally {
      await endEnvironment(ctx, env);
    }
  });
});
