// M331 (c), a disposition's way on, on the scripted target (slice 27; the
// slice-27 review's S1). M4 plan §3.5 M331; D4-N03; D4 §§4.6, 5.3, 6.3; J6;
// SEAM.md §§247, 291, 293.
//
// Kernel lane. An out-of-band row answered `teardown` requests an ordinary
// teardown (the driver's ruling). Once that teardown has applied, what the
// row was about is gone and the row is closed (`closed_at`). It is never
// left open for a later deployment of the environment: a new deploy whose
// round finds nothing out of band is `verified`, with no `missing` entry of
// kind `out_of_band`. The real-unit forms of the row's options are in
// M331-out-of-band-changes-on-a-real-unit.
//
// SAFETY: no unit, no systemctl, no host process; nothing is signalled.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { deploy, deployable, deployToRound, operationsOf, postDeployExecutions, scriptCall } from './harness/deploy/kernel.mjs';
import { changeTarget, recordExit, roundsOf, rowWhen } from './harness/deploy/rounds.mjs';
import { answerOn } from './harness/deploy/recover.mjs';
import { observe, oobDecision, oobRows, openOob } from './harness/deploy/observe.mjs';

describe('M331 (c) a row answered teardown, then a new deployment (the review\'s S1)', () => {
  test('a manual stop answered teardown: the ordinary teardown applies and the row is closed; a new deploy\'s round, nothing out of band, is verified with no missing out_of_band', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    const { project, env } = ctx;
    const { operation: op1, execution } = await deployToRound(ctx);
    await recordExit(fx.engine, execution.id, 1);
    await rowWhen(ctx, roundsOf(fx.home, op1.id)[0].id);
    await tick(fx.engine, project, { rounds: 2 });

    await changeTarget(fx.engine, env.id, (target) => ({ ...target, units: target.units.map((u) => (u.generation === 1 ? { ...u, state: 'inactive', instance: null } : u)) }));
    await observe(ctx);
    const [row] = openOob(fx.home, env.id);
    assert.ok(row, 'the fixture is live: the manual stop is an open out-of-band row');

    await scriptCall(fx.engine, env.id, 'teardown', [{ result: 'issued', apply: true }]);
    await answerOn(ctx, oobDecision(fx.home, row), 'teardown');
    const td = await tickUntil(fx.engine, project, () => operationsOf(fx.home, project, 'teardown').find((o) => o.target?.environment === env.id && o.finalized_at), { max: 16, what: 'the ordinary teardown to be finalized' });
    assert.equal(td.linked_prior ?? null, null, 'an ordinary teardown');
    await tick(fx.engine, project, { rounds: 2 });
    const closed = oobRows(fx.home, env.id).find((r) => r.id === row.id);
    assert.equal(closed.disposition, 'teardown');
    assert.ok(closed.closed_at, `the row is closed once its teardown has applied, never left open (${JSON.stringify(closed)})`);

    await scriptCall(fx.engine, env.id, 'deploy', [{ result: 'issued', apply: true }]);
    await deploy(fx.engine, project, ctx.candidate.id, env.name);
    const x2 = await tickUntil(fx.engine, project, () => postDeployExecutions(fx.home, ctx.candidate.id).find((x) => x.deployment?.operation !== op1.id), { max: 16, what: 'the new deploy\'s round' });
    await recordExit(fx.engine, x2.id, 0);
    const v = await rowWhen(ctx, x2.deployment.round);
    assert.deepEqual(oobRows(fx.home, env.id).filter((r) => r.closed_at === null).map((r) => r.id), [], 'no row is open or unresolved');
    assert.ok(!(v.missing ?? []).some((m) => m.kind === 'out_of_band'), `no missing entry of kind out_of_band (${JSON.stringify(v.missing)})`);
    assert.equal(v.outcome, 'verified', `nothing out of band: the round is verified (${v.outcome} ${JSON.stringify(v.missing)})`);
  });
});
