// M330, `identity_observation_every` (slice 27). M4 plan §3.5 M330; E120
// item 2; AR §8.1; D4 §6.2, A.7; BS4 §11.2; SEAM.md §§2, 247, 274, 291, 298.
//
// Kernel lane, on the scripted deployment adapter, the engine's clock
// controlled. The k-th observation of an environment (k counted from 1 over
// its observation_history) makes a `status` read, and also a `verify` read
// when k is a multiple of the setting and an application instance is
// expected (SEAM.md §291). The observation job's calls are told from an
// operation's by their `by` (SEAM.md §247, amended).
//   (a) the setting at 3: two status-only observations, then one with an
//       identity read (counted at the scripted adapter);
//   (b) an engine restart between the second and third: the count goes on
//       from durable history, so the first due observation after the
//       restart makes the identity read, neither reset nor skipped;
//   (c) a status-only observation after a matching identity read shows the
//       status read's own `at` and the last identity read's own `at` (and
//       the row that made it), never the old identity read as its own;
//       `healthy` as D4 §6.2 rule 4 allows;
//   (d) 0, 101 and a non-integer refused, nothing changed; unset, the
//       default 10. The plan's Expected says `config_invalid`; the setting
//       is a project policy key, whose refusals SEAM §2 fixes as 400
//       `invalid_value` naming the field, as M07 pins for every other key
//       (SEAM.md §298 reading 1, a wording for Sean).
//
// SAFETY: no unit, no systemctl, no host process; the only engine stopped
// is the test's own, in order.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertRefused } from './harness/fixtures.mjs';
import { getPolicy } from './harness/journal.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';
import { adapterState, deployable, deployToRound } from './harness/deploy/kernel.mjs';
import { recordExit, roundsOf, rowWhen } from './harness/deploy/rounds.mjs';
import { callsBy, historyOf, observe, scriptObservation, statusValue, verifyValue } from './harness/deploy/observe.mjs';

async function running(t, policy = {}) {
  const fx = await scriptedEngine(t);
  const ctx = await deployable(fx, { policy });
  const { operation, execution } = await deployToRound(ctx);
  await recordExit(fx.engine, execution.id, 1);
  await rowWhen(ctx, roundsOf(fx.home, operation.id)[0].id);
  await tick(fx.engine, ctx.project, { rounds: 2 });
  return ctx;
}

// Did the history row make an identity read itself?
const madeIdentity = (row) => row.facts?.identity?.observation === row.id;

// Observations until the next one would be the k-th with k % every === want.
async function observeUntil(ctx, every, want) {
  for (let i = 0; i < every + 1 && (historyOf(ctx.fx.home, ctx.env.id).length + 1) % every !== want; i++) await observe(ctx);
}

const counts = async (ctx) => {
  const state = await adapterState(ctx.fx.engine, ctx.env.id);
  return { status: callsBy(state, 'status', 'observation').length, verify: callsBy(state, 'verify', 'observation').length };
};

describe('M330 (a) the setting at 3', () => {
  test('every third observation makes a status and a verify read; the others a status read only (counted)', async (t) => {
    const ctx = await running(t, { identity_observation_every: 3 });
    const before = await counts(ctx);
    const first = historyOf(ctx.fx.home, ctx.env.id).length;
    for (let i = 0; i < 6; i++) await observe(ctx);
    const rows = historyOf(ctx.fx.home, ctx.env.id);
    const fresh = rows.slice(first);
    assert.equal(fresh.length, 6, 'six observations');
    for (const [i, row] of fresh.entries()) {
      const k = first + i + 1;
      assert.equal(madeIdentity(row), k % 3 === 0, `observation ${k}: ${k % 3 === 0 ? 'a status and a verify read' : 'a status read only'} (facts ${JSON.stringify(row.facts)})`);
    }
    const after = await counts(ctx);
    assert.equal(after.status - before.status, 6, 'six status reads by the observation job');
    assert.equal(after.verify - before.verify, fresh.filter(madeIdentity).length, 'one verify read per identity observation, and no other');
    assert.equal(fresh.filter(madeIdentity).length, 2, 'two of six');
  });
});

describe('M330 (b) an engine restart between the second and third observations', () => {
  test('the count goes on from durable history: the first due observation after the restart makes the identity read, and the two after it do not', async (t) => {
    const ctx = await running(t, { identity_observation_every: 3 });
    const { fx } = ctx;
    for (let i = 0; i < 3; i++) await observe(ctx);
    await observeUntil(ctx, 3, 0);
    const last = historyOf(fx.home, ctx.env.id).at(-1);
    assert.ok(last === undefined || !madeIdentity(last), 'the fixture is live: the last observation before the restart made no identity read');
    await fx.engine.stop();
    await fx.start({ args: ['--harness-clock-offset', String(fx.clockAdvanced)] });
    const third = await observe(ctx);
    assert.equal(historyOf(fx.home, ctx.env.id).length % 3, 0, 'the observation after the restart is the third of its cycle');
    assert.ok(madeIdentity(third), `it makes the identity read: the count is neither reset nor skipped (${JSON.stringify(third.facts)})`);
    assert.equal((await counts(ctx)).verify, 1, 'one verify read by the observation job in the restarted engine');
    for (let i = 0; i < 2; i++) assert.equal(madeIdentity(await observe(ctx)), false, 'the next two are status-only');
  });
});

describe('M330 (c) each fact with its own source timestamp', () => {
  test('a status-only observation after a matching identity read shows the status read\'s own at and the last identity read\'s own at, never as its own; healthy', async (t) => {
    const ctx = await running(t, { identity_observation_every: 2 });
    const { fx, env } = ctx;
    await observeUntil(ctx, 2, 0);
    const { target } = await adapterState(fx.engine, env.id);
    const unit = target.units.find((u) => u.generation === 1);
    const base = Date.now();
    const S1 = new Date(base - 9000).toISOString();
    const T1 = new Date(base - 8000).toISOString();
    const S2 = new Date(base - 1000).toISOString();
    await scriptObservation(fx.engine, env.id, 'status', [{ value: statusValue(target, S1) }, { value: statusValue(target, S2) }]);
    await scriptObservation(fx.engine, env.id, 'verify', [{ value: verifyValue(unit, T1) }]);
    const a = await observe(ctx);
    assert.ok(madeIdentity(a), 'the fixture is live: this observation made the identity read');
    assert.deepEqual([a.facts.status?.at, a.facts.identity?.at, a.facts.identity?.match], [S1, T1, 'match'], `each fact with its own source timestamp (${JSON.stringify(a.facts)})`);
    const b = await observe(ctx);
    assert.equal(madeIdentity(b), false, 'the next is status-only');
    assert.equal(b.facts.status?.at, S2, 'the status read\'s own at');
    assert.deepEqual([b.facts.identity?.at, b.facts.identity?.observation], [T1, a.id], 'the last identity read\'s own at, and the earlier observation that made it: never shown as this observation\'s');
    assert.equal(b.condition, 'healthy', 'healthy, as D4 §6.2 rule 4 allows with the identity read where made');
  });
});

describe('M330 (d) the setting\'s range and default', () => {
  test('0, 101 and 2.5 refused naming the field, nothing changed; unset, the default 10: the tenth observation makes the identity read', async (t) => {
    const ctx = await running(t);
    const { fx, project } = ctx;
    for (const value of [0, 101, 2.5]) {
      const before = await getPolicy(fx.engine, project);
      const res = await fx.engine.post(`/v1/projects/${project}/policy`, { identity_observation_every: value });
      assertRefused(res, 400, 'invalid_value', `identity_observation_every ${value}`);
      assert.equal(res.body.subject?.field, 'identity_observation_every', 'the refusal names the field');
      const after = await getPolicy(fx.engine, project);
      assert.deepEqual([after.revision, after.effective.identity_observation_every], [before.revision, before.effective.identity_observation_every], `${value}: nothing changed`);
    }
    assert.equal((await getPolicy(fx.engine, project)).effective.identity_observation_every, 10, 'unset, it is 10');
    const first = historyOf(fx.home, ctx.env.id).length;
    for (let i = 0; i < 11 && !historyOf(fx.home, ctx.env.id).slice(first).some(madeIdentity); i++) await observe(ctx);
    const rows = historyOf(fx.home, ctx.env.id).slice(first);
    for (const [i, row] of rows.entries()) {
      const k = first + i + 1;
      assert.equal(madeIdentity(row), k % 10 === 0, `observation ${k}: identity read only when k is a multiple of 10`);
    }
    assert.ok(rows.some(madeIdentity), 'the fixture is live: an identity observation was reached');
  });
});
