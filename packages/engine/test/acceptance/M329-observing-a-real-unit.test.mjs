// M329 (a), (b), (e): the observation job on a real unit (slice 27;
// sandbox lane). M4 plan §3.5 M329; D4-N02, D4-N05; D4 §§6.2, 9.2; E110;
// BS4 §11.1 CD2; SEAM.md §§257, 274, 290 to 292.
//
// On the real `local_service` adapter, `identity_observation_every` 1 so
// each observation also reads the target's identity.
//   (a), (b) the job on a real unit, at its cadence: a status and an
//       identity read of the running generation, `healthy` (the control of
//       the kernel file's precedence cases: a real read can succeed);
//   (e) CD2: the test's own engine killed and started again, the service
//       surviving with supervision `unknown` and its reads still matching:
//       `degraded`, detail `supervision_unknown`, never `healthy`.
// The kernel file M329-the-observation-job-on-the-scripted-target holds the
// rest of the row.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §§257, 274). The only process signalled is
// this test's own engine child, by `killOwnEngine` (SIGKILL through the
// ChildProcess handle the harness spawned, after reading from /proc that it
// is the engine of this test's home). The only unit is the engine's own,
// under this test's home's prefix, removed by the engine's teardown; the
// test acts on no unit. The environment is ended in `finally`; the file
// ends with `operatorGuard`; every engine start carries the real-adapter
// switch (`hostDeployable`, `realAdapterStarts`).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { environmentRead } from './harness/deploy/kernel.mjs';
import { deployHeld, endEnvironment, hostDeployable, hostEnvironment, operatorGuard, procInstance, releaseCheck, ticksUntil, verificationOf } from './harness/deploy/host.mjs';
import { killOwnEngine } from './harness/deploy/recover.mjs';
import { observeOnHost } from './harness/deploy/observe.mjs';

const POLICY = Object.freeze({ deploy_auto_retries_max: 0, service_memory_max: 67108864, identity_observation_every: 1 });

describe('M329 the observation job on a real unit', () => {
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

  test('(a), (b) a status and an identity read of the running generation: healthy; (e) after the engine is killed and started again, the surviving service: degraded, detail supervision_unknown, never healthy', async () => {
    const env = await hostEnvironment(ctx, 'observed');
    try {
      const { op, svc } = await deployHeld(ctx, env);
      releaseCheck(ctx, svc, { get: ['/hello'], exit: 1 });
      await verificationOf(ctx, op);
      const row = await observeOnHost(ctx, env, ticksUntil);
      assert.equal(row.condition, 'healthy', `a real read of the running generation: healthy (${JSON.stringify(row)})`);
      assert.equal(row.deployment_generation, 1);
      assert.ok(row.facts?.status?.at && row.facts?.identity?.observation === row.id && row.facts.identity.match === 'match', `it made a status and a matching identity read (${JSON.stringify(row.facts)})`);

      // (e) The test's own engine killed; the service survives it.
      await killOwnEngine(ctx.fx);
      await ctx.fx.start({ args: ['--harness-clock-offset', String(ctx.fx.clockAdvanced)] });
      assert.equal(procInstance(svc.app.pid)?.start_time, svc.app.start_time, 'host-read: the application survived the engine');
      const after = await observeOnHost(ctx, env, ticksUntil);
      assert.equal(after.condition, 'degraded', `supervision unknown never reads healthy: degraded (CD2) (${after.condition})`);
      assert.equal(after.detail?.code, 'supervision_unknown', `the detail names supervision_unknown (${JSON.stringify(after.detail)})`);
      assert.equal(after.facts?.identity?.match, 'match', 'its reads still match');
      const read = await environmentRead(ctx.fx.engine, ctx.project, env.name);
      assert.deepEqual([read.supervision, read.observed?.condition], ['unknown', 'degraded']);
    } finally {
      await endEnvironment(ctx, env);
    }
  });
});
