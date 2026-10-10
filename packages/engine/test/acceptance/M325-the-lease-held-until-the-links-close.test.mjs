// M325 (e), (d): the lease held until the operation's links close (slice 26;
// sandbox lane). M4 plan §3.4 M325; D4-O13, D4-O12; D4 §§4.7, 5.2; E115;
// SEAM.md §§18, 256 to 259, 268, 272 to 276.
//
// On the real `local_service` adapter and the engine's controlled clock. A
// round's post-deploy check holds in its `check` domain, its service link
// open, when the orchestration deadline passes: the verification is
// recorded `unknown` (`missing` naming the deadline and the execution), no
// result is synthesized for the check, and the environment lease is
// released only once the operation's ingress is closed, never before the
// check's domain is terminated (D4 §4.7: "released only once ... no service
// link of its check executions remains open"). The kernel file
// M325-the-lease-and-the-orchestration-deadline holds the rest of the row.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §257). The only unit is the engine's,
// under this test's home's prefix; the held check is the benign target-check
// program (no act); the test acts on no unit and signals nothing; the clock
// is the engine's controlled clock and no engine is restarted after it moves.
// The environment is ended in `finally`; the file ends with `operatorGuard`.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { advanceClock } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { environmentLeases, roundsOf, verificationsOf } from './harness/deploy/kernel.mjs';
import { deployHeld, domainRowOf, endEnvironment, hostDeployable, hostEnvironment, hostUntil, operatorGuard, procInstance, ticksUntil } from './harness/deploy/host.mjs';

const POLICY = Object.freeze({ deploy_auto_retries_max: 0, service_memory_max: 67108864 });
const ms = (iso) => Date.parse(iso);

describe('M325 (e) the lease is not released before the operation\'s links close', () => {
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

  test('the deadline passes while the round\'s check holds its link: the round unknown, no result synthesized, and the lease released only after the check\'s domain, and its link, are closed', async () => {
    const env = await hostEnvironment(ctx, 'link');
    try {
      const { op, held } = await deployHeld(ctx, env);
      const member = procInstance(held.member.pid);
      assert.ok(member, 'the fixture is live: the check holds in its domain, its link open');
      await advanceClock(ctx.fx.engine, 1801);
      const row = await ticksUntil(ctx.fx, ctx.project, () => verificationsOf(ctx.fx.home, roundsOf(ctx.fx.home, op.id).at(-1).id)[0], { what: 'the round to be recorded at the deadline' });
      assert.equal(row.outcome, 'unknown');
      assert.ok((row.missing ?? []).some((m) => m.kind === 'deadline'), `missing names the deadline (${JSON.stringify(row.missing)})`);
      assert.ok((row.missing ?? []).some((m) => m.id === held.execution.id), `and the execution (${JSON.stringify(row.missing)})`);
      const lease = await ticksUntil(ctx.fx, ctx.project, () => environmentLeases(ctx.fx.home, env.id).find((l) => l.released_at !== null), { what: 'the lease to be released' });
      const domain = domainRowOf(ctx.fx.home, held.domain.id);
      assert.equal(domain.status, 'terminated', `the check's domain is closed (${domain.status})`);
      assert.ok(domain.terminated_at && ms(lease.released_at) >= ms(domain.terminated_at), `the lease was released no earlier than the check's domain was closed, its link with it (D4 §4.7) (${lease.released_at} vs ${domain.terminated_at})`);
      await hostUntil(() => procInstance(held.member.pid) === null || procInstance(held.member.pid).start_time !== member.start_time, { timeoutMs: 30_000, what: 'the check\'s process to be gone' });
      const results = withStore(ctx.fx.home, (db) => db.prepare('SELECT * FROM "check_results" WHERE "execution" = ? AND "execution_established" = 1 AND "exit_status" = 0').all(held.execution.id));
      assert.deepEqual(results, [], 'no passing result is synthesized for the check, which never exited by itself');
      assert.ok(!existsSync(held.domain.cgroup_path), 'host-read: the check domain\'s cgroup is gone');
    } finally {
      await endEnvironment(ctx, env);
    }
  });
});
