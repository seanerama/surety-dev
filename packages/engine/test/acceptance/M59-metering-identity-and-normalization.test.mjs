// M59, metering identity and normalization (slice 4). Plan §3.6 M59; D1
// §§3.6, 13.1, 13.2, D1-01, D1-26; E16b; SEAM.md §§53, 54.
//
// One original ledger row per invocation that was launched, and none for a
// dispatch refused before launch. What the provider reported is kept raw
// beside the normalized amounts; cache reads are counted apart from
// billable input; a cost is reported, estimated by the one labeled rule,
// unknown, or a measured zero, and an unknown is never shown as zero. The
// totals the API gives are the numbers stated in the fixture below.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { NORMALIZATION, PRICES, assertRowsMatchStore, getLedger, invocationOf, ledgerRows, originalRowOf } from './harness/ledger.mjs';
import { addProject, addWork, assertRunEnded, runsOf, scriptedEngine, tick, tickUntil, waitForRun, workItem } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';

// What each role reports, once, and the ledger row it must leave. The
// estimate is the price table's: 1,000,000 × 2 + 2,000,000 × 0.5 +
// 500,000 × 8, per million tokens.
const FIXTURE = [
  { name: 'a reported cost', raw: { input_tokens: 1200, cache_read_tokens: 30_000, output_tokens: 800, cost_usd: 0.42 }, row: { billable_in: 1200, cached_in: 30_000, out: 800, cost_status: 'reported', cost_usd: 0.42 }, model_observed: null },
  { name: 'an estimated cost', raw: { input_tokens: 1_000_000, cache_read_tokens: 2_000_000, output_tokens: 500_000, model: PRICES.model }, row: { billable_in: 1_000_000, cached_in: 2_000_000, out: 500_000, cost_status: 'estimated', cost_usd: 7 }, model_observed: PRICES.model },
  { name: 'an unknown cost', raw: { input_tokens: 700, output_tokens: 90 }, row: { billable_in: 700, cached_in: null, out: 90, cost_status: 'unknown', cost_usd: null }, model_observed: null },
  { name: 'a measured zero', raw: { input_tokens: 0, cache_read_tokens: 0, output_tokens: 0, cost_usd: 0 }, row: { billable_in: 0, cached_in: 0, out: 0, cost_status: 'measured_zero', cost_usd: 0 }, model_observed: null },
];

// The totals of those four invocations. The invocation that reported no
// cache read adds nothing to cached_in, and its cost is counted as unknown,
// with its 790 billable tokens, not as zero.
const TOTALS = { invocations: 4, billable_in: 1_001_900, cached_in: 2_030_000, out: 500_890, usage_incomplete: 0, reported_usd: 0.42, estimated_usd: 7, unknown_cost_invocations: 1, unknown_cost_tokens: 790 };

// A project that dispatched nothing has no amounts at all.
const NO_DISPATCH = { invocations: 0, billable_in: null, cached_in: null, out: null, usage_incomplete: 0, reported_usd: null, estimated_usd: null, unknown_cost_invocations: 0, unknown_cost_tokens: null };

describe('M59 metering identity and normalization', () => {
  test('each launched invocation has one original ledger row with its raw usage and its normalized amounts, and the API totals are the fixture\'s', async (t) => {
    const fx = await scriptedEngine(t);
    const project = (await addProject(fx)).id;
    const items = [];
    for (const one of FIXTURE) {
      const item = await addWork(fx.engine, project, 'verification');
      fx.scripted.script(item, [script.complete([step.usage(one.raw)])]);
      items.push(item);
    }
    await tickUntil(fx.engine, project, () => items.every((id) => workItem(fx.home, id).status === 'complete'), { what: 'the four items to complete' });

    for (const [i, one] of FIXTURE.entries()) {
      const [run] = runsOf(fx.home, items[i]);
      const row = originalRowOf(fx.home, run.id);
      assert.ok(row, `${one.name}: the invocation has an original ledger row`);
      assert.equal(row.invocation, invocationOf(fx.home, run.id), `${one.name}: the row names the run's one invocation`);
      assert.deepEqual({ billable_in: row.billable_in, cached_in: row.cached_in, out: row.out, cost_status: row.cost_status, cost_usd: row.cost_usd }, one.row, `${one.name}: normalized amounts`);
      assert.deepEqual(JSON.parse(row.raw_usage), one.raw, `${one.name}: the provider's raw usage is kept`);
      assert.equal(row.provider, 'scripted', `${one.name}: provider`);
      assert.ok(row.normalization_version.startsWith(NORMALIZATION), `${one.name}: the normalization is named (${row.normalization_version})`);
      assert.equal(row.model_observed, one.model_observed, `${one.name}: the model the provider reported`);
      assert.equal(row.usage_complete, 1, `${one.name}: the role ended by itself, so its usage is complete`);
    }
    const estimated = originalRowOf(fx.home, runsOf(fx.home, items[1])[0].id);
    assert.ok(estimated.normalization_version.includes(PRICES.version), `an estimate names the price table it came from (${estimated.normalization_version})`);
    assert.equal(ledgerRows(fx.home, project).length, 4, 'four invocations, four rows');

    const ledger = await getLedger(fx.engine, project);
    assertRowsMatchStore(ledger, fx.home, project);
    assert.deepEqual(ledger.totals, TOTALS, 'the totals stated in the fixture');
    assert.deepEqual(ledger.by_role, { verifier: TOTALS }, 'every invocation was the Verifier\'s');
    assert.deepEqual(ledger.budget, { exhausted: [] });
  });

  test('a dispatch refused before launch has no ledger row, and a project that launched nothing reports no dispatch, not zero', async (t) => {
    const fx = await scriptedEngine(t, { start: false });
    await fx.start({ withScripted: false });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    await tick(fx.engine, project);
    const run = await waitForRun(fx.home, item, { state: 'ended' });
    assertRunEnded(fx.home, run.id, { outcome: 'refused', launched: false });
    assert.deepEqual(ledgerRows(fx.home, project), [], 'no row claims a dispatch that never happened');

    const ledger = await getLedger(fx.engine, project);
    assert.deepEqual(ledger.rows, []);
    assert.deepEqual(ledger.totals, NO_DISPATCH, 'no invocation: every amount is null, none is zero');
    assert.deepEqual(ledger.by_role, {});
  });
});
