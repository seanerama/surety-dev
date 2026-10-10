// M327 (b), (e): the preempting teardown on a real unit (slice 27; sandbox
// lane); (b) is also D4-O13's preemption during verification, deferred by
// slice 26. M4 plan §3.5 M327; D4-O10, D4-O13; D4 §§2.6, 4.6, 4.7; RV4;
// E111, E115; BS4 §4.1 rule 4; SEAM.md §§257, 290, 293, 295 to 297.
//
// On the real `local_service` adapter.
//   (b) a confirmed deploy waiting in verification, its post-deploy check
//       running and holding its link: `POST …/teardown {"preempt": true}`;
//       every launch closed and the lease passed in the request's
//       transaction; the running check cancelled, its domain closed and its
//       process gone; the open round recorded `unknown` naming it; the
//       service's unit stopped by D2's closure and nothing of the
//       environment left; the deploy `superseded`, the teardown's
//       `linked_prior`, `deploy.preempted`, its attempt as it was;
//   (e) the same with the manager unreadable (the adapter's bus address
//       pointed at a missing path until cleared, SEAM.md §297): launch
//       authority closed; nothing stopped (the same invocation and
//       application process, host-read); the teardown's attempt
//       `ambiguous`; observations `unknown` and no out-of-band fact; once
//       the address is restored a read succeeds (the control).
// (a), (c) and (d) are the kernel file's (M327-preempting-teardown-on-the-scripted-target).
//
// SAFETY (BS4 §4.1; E64; SEAM.md §§257, 297). Every unit is the engine's own,
// under this test's home's prefix, and only the engine stops it; the test
// acts on no unit until the end of (e), where a unit the engine could not
// tear down would be stopped by its exact name (`endEnvironment`). The
// unreadable case changes only the address the adapter's own calls use;
// the manager is read `running` before and after and is never stopped,
// restarted or reloaded. Nothing is signalled. Every environment is ended
// in `finally`; the file ends with `operatorGuard`; every engine start
// carries the real-adapter switch (`hostDeployable`).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { procsOf } from './harness/sandbox/cgroup.mjs';
import { attemptsOf, environmentLeases, environmentRead, operationRow, roundsOf, unitPrefix, verificationsOf } from './harness/deploy/kernel.mjs';
import { armDeployFault, deployHeld, domainRowOf, endEnvironment, hostDeployable, hostEnvironment, listUnits, managerState, operatorGuard, procInstance, ticksUntil, unitShow } from './harness/deploy/host.mjs';
import { answerOn, openOn } from './harness/deploy/recover.mjs';
import { assertPreemption, observeOnHost, oobRows, preempt } from './harness/deploy/observe.mjs';
import { withStore } from './harness/store.mjs';

const POLICY = Object.freeze({ deploy_auto_retries_max: 0, service_memory_max: 67108864 });
const heldLease = (home, env) => environmentLeases(home, env).find((l) => l.released_at === null);
const loadedOfPrefix = (home, env) => (listUnits() ?? []).filter((u) => u.unit.startsWith(unitPrefix(home, env))).map((u) => u.unit);
const executionRow = (home, id) => withStore(home, (db) => db.prepare('SELECT * FROM "check_executions" WHERE "id" = ?').get(id));

describe('M327 the preempting teardown on a real unit', () => {
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

  test('(b) a confirmed deploy waiting in verification: its running check cancelled and its domain closed, its round unknown naming it, its unit stopped, the deploy superseded', async () => {
    const env = await hostEnvironment(ctx, 'verifying');
    try {
      const { op, held, svc } = await deployHeld(ctx, env);
      const [round] = roundsOf(ctx.fx.home, op.id);
      const leaseBefore = heldLease(ctx.fx.home, env.id);
      const attemptsBefore = attemptsOf(ctx.fx.home, op.id);
      const teardownId = await preempt(ctx.fx.engine, ctx.project, env.name);
      assertPreemption(ctx, { deploy: op, teardownId, leaseBefore, envId: env.id });
      assert.equal(executionRow(ctx.fx.home, held.execution.id).status, 'cancelled', 'the running verification execution is cancelled in the preemption\'s transaction');
      const row = verificationsOf(ctx.fx.home, round.id)[0];
      assert.equal(row?.outcome, 'unknown', `the open round is recorded unknown (${row?.outcome})`);
      assert.ok((row.missing ?? []).some((m) => m.id === held.execution.id), `naming the cancelled execution (${JSON.stringify(row.missing)})`);

      await ticksUntil(ctx.fx, ctx.project, () => (operationRow(ctx.fx.home, teardownId)?.finalized_at ? true : undefined), { what: 'the preempting teardown to be finalized' });
      const [ta] = attemptsOf(ctx.fx.home, teardownId);
      assert.equal(ta.reconciliation_reads.at(-1)?.result, 'applied', 'the teardown is applied');
      assert.deepEqual(loadedOfPrefix(ctx.fx.home, env.id), [], 'host-read: no unit of the environment remains');
      assert.equal(procInstance(svc.app.pid)?.start_time === svc.app.start_time, false, 'host-read: the application is gone');
      const checkDomain = await ticksUntil(ctx.fx, ctx.project, () => {
        const d = domainRowOf(ctx.fx.home, held.domain.id);
        return d?.status === 'terminated' ? d : undefined;
      }, { what: 'the check\'s domain to be closed' });
      assert.ok(checkDomain);
      let members = [];
      try {
        members = procsOf(held.domain.cgroup_path);
      } catch {
        members = [];
      }
      assert.deepEqual(members, [], 'host-read: nothing of the check remains in its cgroup (its link is closed with it)');
      assert.equal(operationRow(ctx.fx.home, op.id).status, 'superseded', 'the deploy is superseded');
      assert.deepEqual(attemptsOf(ctx.fx.home, op.id).map((a) => a.status), attemptsBefore.map((a) => a.status), 'its attempt is kept as it was');
    } finally {
      await endEnvironment(ctx, env);
    }
  });

  test('(e) the manager unreadable: launch authority closed, nothing stopped, the teardown ambiguous, observations unknown with no out-of-band fact; restored, a read succeeds', async () => {
    const env = await hostEnvironment(ctx, 'unreadable');
    let teardownId;
    try {
      assert.equal(managerState(), 'running', 'the manager is running before');
      const { op, svc } = await deployHeld(ctx, env);
      const before = unitShow(svc.unit, ['ActiveState', 'InvocationID']);
      const leaseBefore = heldLease(ctx.fx.home, env.id);
      await armDeployFault(ctx, env, 'bus_address_missing_until_cleared');
      teardownId = await preempt(ctx.fx.engine, ctx.project, env.name);
      assertPreemption(ctx, { deploy: op, teardownId, leaseBefore, envId: env.id });
      const ta = await ticksUntil(ctx.fx, ctx.project, () => {
        const [a] = attemptsOf(ctx.fx.home, teardownId);
        return a?.status === 'ambiguous' ? a : undefined;
      }, { what: 'the teardown\'s attempt to be ambiguous' });
      assert.ok(ta);
      assert.deepEqual(unitShow(svc.unit, ['ActiveState', 'InvocationID']), before, 'host-read: the unit is untouched (same state and invocation)');
      assert.equal(procInstance(svc.app.pid)?.start_time, svc.app.start_time, 'host-read: the application process still runs: nothing of uncertain ownership is stopped');
      const unread = await observeOnHost(ctx, env, ticksUntil);
      assert.equal(unread.condition, 'unknown', `the environment is unknown while the manager cannot be read (${unread.condition})`);
      assert.equal((await environmentRead(ctx.fx.engine, ctx.project, env.name)).observed?.condition, 'unknown');
      assert.deepEqual(oobRows(ctx.fx.home, env.id), [], 'a read failure creates no out-of-band fact');
      assert.equal(managerState(), 'running', 'the manager is running after: never stopped or reloaded');

      await armDeployFault(ctx, env, 'bus_address_cleared');
      const readable = await observeOnHost(ctx, env, ticksUntil);
      assert.notEqual(readable.condition, 'unknown', `restored, a read succeeds (the control) (${readable.condition})`);
    } finally {
      if (teardownId) {
        await armDeployFault(ctx, env, 'bus_address_cleared').catch(() => undefined);
        // The teardown, readable again, settles or waits on a decision; its preempting option ends it.
        await ticksUntil(ctx.fx, ctx.project, async () => {
          if (operationRow(ctx.fx.home, teardownId)?.finalized_at && loadedOfPrefix(ctx.fx.home, env.id).length === 0) return true;
          for (const ops of [teardownId]) {
            const [d] = [...openOn(ctx.fx.home, 'blocker', ops), ...openOn(ctx.fx.home, 'rollout_partial', ops)];
            if (d) await answerOn(ctx, d, d.options.some((o) => o.key === 'teardown') ? 'teardown' : 'retry');
          }
          return loadedOfPrefix(ctx.fx.home, env.id).length === 0 ? true : undefined;
        }, { timeoutMs: 180_000, what: 'the environment to be torn down once readable' }).catch(() => undefined);
      }
      await endEnvironment(ctx, env, { engineTeardown: loadedOfPrefix(ctx.fx.home, env.id).length > 0 });
    }
  });
});
