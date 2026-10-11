// M338 (d) and (f) in the kernel lane: an unqualified adapter refuses before
// intent, and a changed engine build, adapter version or `service` profile
// fingerprint lapses the row (slice 29; kernel lane). M4 plan §3.7 M338;
// D4-A06, D4-A07; D4 §2.6, §4.1, A.2 (WorkItem hold `adapter_unqualified`),
// A.5; J4; SEAM.md §§248, 249, 321, 324.
//
// On the scripted adapter, with the labelled qualification facts of SEAM
// §248 (a kernel engine has no host and no real adapter to qualify; the
// lapse rule is the engine's, whatever wrote the row: D4-A07 is a kernel
// statement):
//   (d) as the coordinator ruled from D4 §2.6, A.6 and A.2's WorkItem hold:
//       no current row, a deployment request is 409 `authorization_not_issued`
//       naming `ADAPTER_UNQUALIFIED` (J4); a request holding an authorization
//       issued while the adapter was qualified, after the row lapsed, is 409
//       `adapter_unqualified` before any intent, the authorization not
//       consumed; an accepted deployment whose row lapses before its intent
//       is held `adapter_unqualified` and writes no intent;
//   (f) a restart with the engine's build, the adapter's version or the
//       `service` profile's fingerprint changed (SEAM §324's switches): the
//       row `lapsed`, `lapsed_reason` that fact, `adapter.qualification_lapsed`
//       once; a request then carries `ADAPTER_UNQUALIFIED`. The control: a
//       restart with none of them changed keeps the row current (in the kernel
//       lane there is no host qualification, so this control does not touch
//       E129 item 8; the sandbox file M338-lapse-on-a-changed-host does).
// The host-qualification change of (f) is the sandbox file's (a kernel
// engine has none to change).
//
// SAFETY: kernel lane. No unit, no systemctl or systemd-run, no host process
// read, nothing signalled; engines are stopped in order.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { tick, scriptedEngine } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { authorizationRow, deploy, deployable, deployWork, lapseByFixture, operationsOf, requestDeployment } from './harness/deploy/kernel.mjs';
import { workEntry } from './harness/deploy/rounds.mjs';
import { lapsedEvents, probeEnvironment, probeReasons, qualificationRow } from './harness/deploy/qualify.mjs';

const authorizations = (home) => withStore(home, (db) => db.prepare('SELECT "id", "status" FROM "deployment_authorizations" ORDER BY rowid').all());

// The fact each restart changes, and the switch that changes it (SEAM.md §324 †).
const FACTS = Object.freeze([
  ['engine_build', ['--harness-engine-build-variant', 'm338-f']],
  ['adapter_version', ['--harness-adapter-version', 'local_service=2']],
  ['profile_fingerprint', ['--harness-service-profile-variant', 'm338-f']],
]);

describe('M338 (d) an unqualified adapter refuses before intent', () => {
  test('(d) no current row: a deployment request is refused 409 authorization_not_issued, alpha_authorize naming ADAPTER_UNQUALIFIED; nothing issued, no deploy work item', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await lapseByFixture(fx.engine, ctx.qualification);
    assert.equal(qualificationRow(fx.home, ctx.qualification)?.status, 'lapsed', 'the fixture is live: the only row is lapsed');
    const res = await requestDeployment(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    assert.deepEqual([res.status, res.body?.code], [409, 'authorization_not_issued'], `the request is refused at the gate (→ ${res.status} ${res.text})`);
    const codes = (res.body?.subject?.reasons ?? []).map((r) => r.code ?? r);
    assert.ok(codes.includes('ADAPTER_UNQUALIFIED'), `alpha_authorize names ADAPTER_UNQUALIFIED (J4) (${codes.join(', ')})`);
    assert.ok(authorizations(fx.home).every((a) => a.status !== 'issued' && a.status !== 'consumed'), 'nothing is issued');
    assert.deepEqual(deployWork(fx.home, ctx.project), [], 'no deploy work item');
    assert.deepEqual(operationsOf(fx.home, ctx.project, 'deploy'), [], 'no operation');
  });

  test('(d) a request holding an authorization issued while the adapter was qualified, after the row lapsed: 409 adapter_unqualified before any intent; the authorization not consumed', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    const issued = await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    await lapseByFixture(fx.engine, ctx.qualification);
    const res = await requestDeployment(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    assert.deepEqual([res.status, res.body?.code], [409, 'adapter_unqualified'], `the request is refused for the unqualified adapter (D4 §2.6, A.6) (→ ${res.status} ${res.text})`);
    assert.equal(authorizationRow(fx.home, issued.authorization.id)?.status, 'issued', 'the authorization is not consumed');
    assert.deepEqual(operationsOf(fx.home, ctx.project, 'deploy'), [], 'no operation is intended');
  });

  test('(d) an accepted deployment whose row lapses before its intent: held adapter_unqualified, no intent written, its authorization not consumed', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    const issued = await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    await lapseByFixture(fx.engine, ctx.qualification);
    await tick(fx.engine, ctx.project, { rounds: 3 });
    assert.deepEqual(operationsOf(fx.home, ctx.project, 'deploy'), [], 'no deploy operation is intended while no qualification is current');
    assert.equal(authorizationRow(fx.home, issued.authorization.id)?.status, 'issued', 'its authorization is not consumed');
    const waiting = await workEntry(fx.engine, ctx.project, issued.work_item.id);
    assert.ok(JSON.stringify(waiting ?? null).includes('adapter_unqualified'), `its work item shows the hold adapter_unqualified (D4 A.2 WorkItem hold; SEAM.md §324) (${JSON.stringify(waiting)})`);
  });
});

describe('M338 (f) a changed engine build, adapter version or service profile fingerprint lapses the row', () => {
  test('the control: a restart with none of them changed keeps the row current, with no lapse; a request carries no ADAPTER_UNQUALIFIED', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await probeEnvironment(fx.engine, ctx.project);
    assert.equal((await probeReasons(fx.engine, ctx.project, ctx.candidate.id)).unqualified, false, 'before the restart the row is current for the environment');
    await fx.engine.stop();
    await fx.start();
    assert.equal(qualificationRow(fx.home, ctx.qualification)?.status, 'current', 'the row is still current');
    assert.deepEqual(lapsedEvents(fx.home, ctx.qualification), [], 'no adapter.qualification_lapsed');
    const after = await probeReasons(fx.engine, ctx.project, ctx.candidate.id);
    assert.equal(after.unqualified, false, `a request after the restart carries no ADAPTER_UNQUALIFIED (${after.codes.join(', ')})`);
  });

  for (const [fact, args] of FACTS) {
    test(`(f) a restart with the ${fact} changed (${args.join(' ')}): the row lapsed, lapsed_reason ${fact}, adapter.qualification_lapsed once; a request carries ADAPTER_UNQUALIFIED`, async (t) => {
      const fx = await scriptedEngine(t);
      const ctx = await deployable(fx);
      await probeEnvironment(fx.engine, ctx.project);
      assert.equal((await probeReasons(fx.engine, ctx.project, ctx.candidate.id)).unqualified, false, 'the fixture is live: before the change the row is current for the environment');
      await fx.engine.stop();
      await fx.start({ args });
      const row = qualificationRow(fx.home, ctx.qualification);
      assert.equal(row?.status, 'lapsed', `the row is lapsed at the start that changed the ${fact} (D4-A07) (${JSON.stringify(row)})`);
      assert.equal(row.lapsed_reason, fact, `lapsed_reason names the fact that changed (SEAM.md §324)`);
      assert.ok(row.lapsed_at, 'with the time it lapsed');
      const events = lapsedEvents(fx.home, ctx.qualification);
      assert.equal(events.length, 1, 'adapter.qualification_lapsed once');
      assert.equal(events[0].payload?.reason, fact, 'naming the fact');
      const after = await probeReasons(fx.engine, ctx.project, ctx.candidate.id);
      assert.equal(after.unqualified, true, `a request now carries ADAPTER_UNQUALIFIED (${after.codes.join(', ')})`);
    });
  }
});
