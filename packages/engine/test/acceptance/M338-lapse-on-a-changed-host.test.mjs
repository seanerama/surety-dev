// M338 (f) on the host: a changed host qualification lapses the adapter's
// row; a plain restart on an unchanged host does not (slice 29; sandbox
// lane). M4 plan §3.7 M338 (f); D4-A07; D4 §2.6; J4; E129 item 8; SEAM.md
// §§249, 321, 322, 324.
//
// A sandbox-lane home in harness mode on the real `local_service` adapter,
// its project built and nominated; the adapter qualified by the route (the
// real qualification, no stand-in). A probe environment that declares no
// identity method is never satisfied, so a request to it deploys nothing,
// and its reasons say whether the adapter is qualified for it (SEAM §324):
//   the control: just after the qualification, no `ADAPTER_UNQUALIFIED`;
//   a plain restart on an unchanged host: the row still `current`, no
//       lapse, no `ADAPTER_UNQUALIFIED` (Sean's decision on E129 item 8:
//       the adapter's row is matched on the host qualification's content,
//       host id, kernel, tool versions and mechanism fingerprint, so each
//       start's new `host_qualifications` row does not by itself lapse it);
//   a restart whose host qualification differs in one of those facts (the
//       mechanism fingerprint, through section 150's
//       `--harness-mechanism-variant`): the row `lapsed`, `lapsed_reason`
//       `host_qualification`, `adapter.qualification_lapsed` once naming the
//       member `mechanism_fingerprint`, and `ADAPTER_UNQUALIFIED`.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §§257, 322). The test acts on no unit and
// signals nothing; no deployment is ever issued (the probe environment is
// refused at its gate). The qualification's units are the engine's, created
// and removed by its adapter under this test's home's prefix. Engines are
// stopped in order; every start carries the real-adapter switch. The file
// ends with `operatorGuard`.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { withStore } from './harness/store.mjs';
import { hostDeployable, hostNsValue, operatorGuard } from './harness/deploy/host.mjs';
import { currentRows, lapsedEvents, probeEnvironment, probeReasons, qualificationRow, qualifyAdapter } from './harness/deploy/qualify.mjs';
import { freePort } from './harness/engine.mjs';

const activeHost = (home) => withStore(home, (db) => db.prepare(`SELECT "id", "host_id", "kernel", "tool_versions", "mechanism_fingerprint" FROM "host_qualifications" WHERE "status" = 'active'`).get()) ?? null;

describe('M338 (f) the host qualification and the adapter\'s row', () => {
  const shared = sharedFixture();
  let guard;
  let ctx;
  let answer;
  const probe = () => probeReasons(ctx.fx.engine, ctx.project, ctx.candidate.id);
  before(async () => {
    guard = operatorGuard();
    ctx = await hostDeployable(shared.context, guard, { qualify: false });
    answer = await qualifyAdapter(ctx.fx.engine);
    assert.equal(answer.qualified, true, `the fixture is live: the adapter is qualified on this host (${JSON.stringify(answer).slice(0, 600)})`);
    await probeEnvironment(ctx.fx.engine, ctx.project, 'probe', { adapter_version: answer.adapter_version, port: await freePort(), env: { SURETY_TEST_HOST_NS: hostNsValue() } });
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('the control: just after the qualification, a request carries no ADAPTER_UNQUALIFIED', async () => {
    const reasons = await probe();
    assert.equal(reasons.unqualified, false, `the real row is current for the environment (${reasons.codes.join(', ')})`);
  });

  test('a plain restart on an unchanged host: the row still current, no lapse, no ADAPTER_UNQUALIFIED (E129 item 8, as Sean decided)', async () => {
    const before = activeHost(ctx.fx.home);
    await ctx.fx.engine.stop();
    await ctx.fx.start();
    const now = activeHost(ctx.fx.home);
    assert.ok(before && now, 'a host qualification is active before and after');
    assert.deepEqual([now.host_id, now.kernel, now.tool_versions, now.mechanism_fingerprint], [before.host_id, before.kernel, before.tool_versions, before.mechanism_fingerprint], 'the fixture is live: the host is unchanged in host id, kernel, tool versions and mechanism fingerprint');
    const row = qualificationRow(ctx.fx.home, answer.adapter_qualification);
    assert.equal(row?.status, 'current', `the adapter's row is still current after a restart on an unchanged host (E129 item 8: matched on the host's facts) (${JSON.stringify(row)?.slice(0, 300)})`);
    assert.deepEqual(lapsedEvents(ctx.fx.home, answer.adapter_qualification), [], 'no adapter.qualification_lapsed');
    const reasons = await probe();
    assert.equal(reasons.unqualified, false, `a request carries no ADAPTER_UNQUALIFIED (${reasons.codes.join(', ')})`);
  });

  test('(f) a restart whose host qualification differs (its mechanism fingerprint): the row lapsed, lapsed_reason host_qualification, adapter.qualification_lapsed once; ADAPTER_UNQUALIFIED', async () => {
    const id = answer.adapter_qualification;
    assert.equal(currentRows(ctx.fx.home).some((r) => r.id === id), true, 'the fixture is live: the row is current before the change');
    assert.equal((await probe()).unqualified, false, 'and current for the environment');
    const before = activeHost(ctx.fx.home);
    await ctx.fx.engine.stop();
    await ctx.fx.start({ args: ['--harness-mechanism-variant', 'm338-f'] });
    const now = activeHost(ctx.fx.home);
    assert.ok(now && now.mechanism_fingerprint !== before.mechanism_fingerprint, 'the fixture is live: the host qualification in force has another mechanism fingerprint');
    const row = qualificationRow(ctx.fx.home, id);
    assert.equal(row?.status, 'lapsed', `the row is lapsed (D4-A07) (${JSON.stringify(row)?.slice(0, 300)})`);
    assert.equal(row.lapsed_reason, 'host_qualification', 'lapsed_reason host_qualification (SEAM.md §324)');
    const events = lapsedEvents(ctx.fx.home, id);
    assert.equal(events.length, 1, 'adapter.qualification_lapsed once');
    assert.equal(events[0].payload?.reason, 'host_qualification');
    assert.equal(events[0].payload?.member, 'mechanism_fingerprint', `naming the member that changed (E129 item 8; SEAM.md §324) (${JSON.stringify(events[0].payload)})`);
    const reasons = await probe();
    assert.equal(reasons.unqualified, true, `a request carries ADAPTER_UNQUALIFIED (${reasons.codes.join(', ')})`);
  });
});
