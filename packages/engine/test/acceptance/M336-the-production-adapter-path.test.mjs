// M336 (c), the production adapter path outside harness mode (slice 28;
// sandbox lane). M4 plan §3.6 M336 (c); D4-R02; D4 §§2.5, 2.6, 8; J4;
// E92 item 2; SEAM.md §§247, 248, 256, 310, 316, 318.
//
// A project built, nominated and configured on a sandbox-lane home in
// harness mode; then the same home's engine started outside harness mode,
// where the real `local_service` adapter is the only one (SEAM §247: there
// is no switch) and no qualification stand-in exists (SEAM §248, 404). The
// negative control executed there: a deployment request is refused before
// any intent because the adapter is not qualified (`ADAPTER_UNQUALIFIED`,
// D4 §2.6; J4), with no authorization issued, no operation, and no unit of
// the environment's prefix on the host (read before and after).
//
// The plan's other control, "a refused capability", cannot be made outside
// harness mode without a seam that forges one (the Release Operator mints
// capabilities only from the attempt's frozen intent, D4 §2.2): the
// production path's refused-capability control is the adapter
// qualification's `refused` case (D4 §2.6), which runs outside harness mode
// by `surety qualify-adapter`, slice 29 (M338). Deferred there (SEAM §318;
// COVERAGE "M4 slice 28"). The harness-mode refusals of every forged member
// are M335.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §257). This file creates no unit: the only
// deployment it asks for is refused before its intent. Nothing is
// signalled; the engine is stopped in order. The file ends with
// `operatorGuard`.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { withStore } from './harness/store.mjs';
import { operationsOf, unitPrefix } from './harness/deploy/kernel.mjs';
import { hostDeployable, hostEnvironment, listUnits, operatorGuard } from './harness/deploy/host.mjs';

const authorizations = (home) => withStore(home, (db) => db.prepare(`SELECT "status" FROM "deployment_authorizations"`).all());

describe('M336 (c) the production adapter path outside harness mode', () => {
  const shared = sharedFixture();
  let guard;
  let ctx;
  before(async () => {
    guard = operatorGuard();
    ctx = await hostDeployable(shared.context, guard, { qualify: false });
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('outside harness mode a deployment is refused before its intent, the adapter unqualified; nothing authorized, no operation, no unit', async () => {
    const env = await hostEnvironment(ctx, 'prod');
    const prefix = unitPrefix(ctx.fx.home, env.id);
    await ctx.fx.engine.stop();
    await ctx.fx.start({ harness: false });
    const info = await ctx.fx.engine.engineInfo();
    assert.notEqual(info.harness, true, 'the fixture is live: the engine runs outside harness mode, on the production adapter path');
    const fixture = await ctx.fx.engine.post('/v1/harness/fixtures/adapter-qualification', { adapter: 'local_service', adapter_version: '1' });
    assert.equal(fixture.status, 404, `no qualification stand-in outside harness mode (${fixture.text})`);

    const unitsBefore = (listUnits() ?? []).filter((u) => u.unit.startsWith(prefix));
    assert.deepEqual(unitsBefore, [], 'no unit of the environment before the request');
    const res = await ctx.fx.engine.post(`/v1/projects/${ctx.project}/deployments`, { candidate: ctx.candidate.id, environment: env.name });
    assert.equal(res.status, 409, `the request is refused (${res.text})`);
    const reasons = (res.body?.subject?.reasons ?? []).map((r) => r.code ?? r);
    assert.ok(res.body?.code === 'adapter_unqualified' || reasons.includes('ADAPTER_UNQUALIFIED'), `because the adapter is not qualified (D4 §2.6: adapter_unqualified; J4: ADAPTER_UNQUALIFIED) (${res.text})`);
    assert.ok(authorizations(ctx.fx.home).every((a) => a.status !== 'issued' && a.status !== 'consumed'), 'nothing is authorized');
    assert.deepEqual(operationsOf(ctx.fx.home, ctx.project, 'deploy'), [], 'no operation is intended');
    const unitsAfter = listUnits();
    assert.ok(unitsAfter !== null, 'the user units can be listed');
    assert.deepEqual(unitsAfter.filter((u) => u.unit.startsWith(prefix)), [], 'no unit of the environment\'s prefix exists on the host');
  });
});
