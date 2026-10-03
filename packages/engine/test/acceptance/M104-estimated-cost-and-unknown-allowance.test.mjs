// M104, estimated cost counts toward the day; the unknown allowance (M2
// slice 10, kernel lane). M2 plan §3.1 M104; D2 §1.5, §5 C4, K6, A.3
// (D2-C04, D2-C05); SEAM.md §§53 to 55, 120; AR B07; E58 item 9.
//
// The daily limit `budget_day_verified_usd` is checked against reported and
// estimated cost together, while the ledger read shows the two apart and
// never calls the estimate verified; a correction that reports the cost of
// an estimated invocation keeps both rows with their provenance. An
// invocation whose usage is incomplete keeps what was observed and is
// charged, once, an unknown allowance against `budget_day_unknown_tokens`:
// the run's token limit less the billable tokens observed, not below zero,
// recorded on its original row; a fault and a restart charge it no second
// time; a later correction that carries the terminal usage reconciles it
// without touching the original; and at dispatch the day counts the known
// usage plus the remaining allowance. The concurrent clause of C05 is class
// A for M2 (E59 item 7) and has no case.
//
// Every case here is expected to fail on the engine these tests were
// written against, which charges no allowance and does not count an
// estimate toward the verified day (COVERAGE.md, "M2 slice 10").

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { armFault } from './harness/engine.mjs';
import { changePolicy } from './harness/journal.mjs';
import { PRICES, awayFromMidnight, correct, getLedger, invocationOf, ledgerRows, originalRowOf } from './harness/ledger.mjs';
import { addProject, addWork, assertRunEnded, runsOf, scriptedEngine, stopRun, tick, tickOnce, tickUntil, waitForRun, waitForRunState, workItem } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';

// The estimate the price table gives 400,000 billable input, 100,000 cached
// and 500,000 output tokens: 0.8 + 0.05 + 4 USD.
const ESTIMATED_RAW = { input_tokens: 400_000, cache_read_tokens: 100_000, output_tokens: 500_000, model: PRICES.model };
const ESTIMATED_USD = 4.85;
const REPORTED_RAW = { input_tokens: 100, output_tokens: 50, cost_usd: 5.5 };

const pick = (row, keys) => Object.fromEntries(keys.map((key) => [key, row[key]]));

// A run of a role that sends one observation and waits, cancelled by a Stop
// once the observation is stored. Returns the ended run.
async function cancelledAfter(fx, project, item, raw) {
  fx.scripted.script(item, [script.hold('gate', { before: [step.usage(raw)] })]);
  await tick(fx.engine, project);
  const run = await waitForRun(fx.home, item, { state: 'executing' });
  await fx.scripted.waitForHolding({ run: run.id });
  await stopRun(fx.engine, project, run.id);
  return waitForRunState(fx.home, run.id, 'ended', { timeoutMs: 60_000 });
}

describe('M104 estimated cost and the unknown allowance', () => {
  test('(a) a reported and an estimated invocation together reach the verified day limit: the next dispatch is held, and the ledger shows reported and estimated apart, the estimate with its price-table version and nothing estimated under a verified key; (b) a correction reporting the estimated cost keeps both rows with their provenance', async (t) => {
    await awayFromMidnight();
    const fx = await scriptedEngine(t);
    const project = (await addProject(fx)).id;
    await changePolicy(fx.engine, project, { budget_day_verified_usd: 10 });
    const reported = await addWork(fx.engine, project, 'verification');
    const estimated = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(reported, [script.complete([step.usage(REPORTED_RAW)])]);
    fx.scripted.script(estimated, [script.complete([step.usage(ESTIMATED_RAW)])]);
    await tickUntil(fx.engine, project, () => [reported, estimated].every((id) => workItem(fx.home, id).status === 'complete'), { what: 'the reported and the estimated invocations to complete' });
    const estimatedRow = originalRowOf(fx.home, runsOf(fx.home, estimated)[0].id);
    assert.deepEqual(pick(estimatedRow, ['cost_status', 'cost_usd']), { cost_status: 'estimated', cost_usd: ESTIMATED_USD }, 'the fixture is live: the second invocation\'s cost is the price table\'s estimate');
    assert.ok(estimatedRow.normalization_version.includes(PRICES.version), `the estimated row keeps its price table's version (${estimatedRow.normalization_version})`);

    // (a) 5.5 reported and 4.85 estimated: 10.35 against a limit of 10.
    const third = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(third, [script.complete()]);
    for (let i = 0; i < 2; i++) await tickOnce(fx.engine, project);
    assert.equal(runsOf(fx.home, third).length, 0, 'the next dispatch is held: the estimate counts toward the verified day');
    assert.equal(workItem(fx.home, third).status, 'eligible');
    const ledger = await getLedger(fx.engine, project);
    assert.deepEqual(ledger.budget, { exhausted: ['budget_day_verified_usd'] }, 'the hold names the verified day limit');
    assert.deepEqual(pick(ledger.totals, ['invocations', 'reported_usd', 'estimated_usd', 'unknown_cost_invocations']), { invocations: 2, reported_usd: 5.5, estimated_usd: ESTIMATED_USD, unknown_cost_invocations: 0 }, 'the read shows reported and estimated apart, and the estimate is not under the verified key');

    // (b) The provider later reports the estimated invocation's cost.
    const invocation = invocationOf(fx.home, runsOf(fx.home, estimated)[0].id);
    const corrected = await correct(fx.engine, { invocation, seq: 1, raw: { cost_usd: 0.15 } });
    assert.equal(corrected.status, 201, `the correction is appended (body: ${corrected.text})`);
    const rows = ledgerRows(fx.home, project);
    const original = rows.find((row) => row.id === estimatedRow.id);
    const correction = rows.find((row) => row.corrects === estimatedRow.id);
    assert.deepEqual(original, estimatedRow, 'the original row is as it was: estimated, with its price-table version');
    assert.deepEqual(pick(correction, ['cost_status', 'cost_usd', 'correction_seq']), { cost_status: 'reported', cost_usd: 0.15, correction_seq: 1 }, 'the correction row is reported, and names the row it corrects');
    const after = await getLedger(fx.engine, project);
    assert.deepEqual(pick(after.totals, ['reported_usd', 'estimated_usd']), { reported_usd: 10.5, estimated_usd: null }, 'folded, the invocation\'s cost is reported: the provider\'s word replaces the estimate in the totals, and both rows stand');
    assert.deepEqual(after.rows.map((row) => [row.id, row.cost_status]), rows.map((row) => [row.id, row.cost_status]), 'the read lists both rows with their provenance');
  });

  test('(c) a run cancelled after one observation keeps the observed tokens with the allowance of the unobserved remainder, not below zero; (f) at dispatch the day counts the known usage plus the remaining allowance; (e) a later correction with the terminal usage reconciles the allowance and leaves the original row unchanged', async (t) => {
    await awayFromMidnight();
    const fx = await scriptedEngine(t);
    const project = (await addProject(fx)).id;
    await changePolicy(fx.engine, project, { budget_run_billable_tokens: 10_000 });

    // (c) 5,000 billable tokens observed of a 10,000 limit: an allowance of 5,000.
    const first = await addWork(fx.engine, project, 'verification');
    const stopped = await cancelledAfter(fx, project, first, { input_tokens: 4000, output_tokens: 1000 });
    assertRunEnded(fx.home, stopped.id, { outcome: 'stopped', reason_class: 'human_stop', launched: true });
    const charged = originalRowOf(fx.home, stopped.id);
    assert.deepEqual(pick(charged, ['billable_in', 'out', 'usage_complete', 'cost_status', 'unknown_allowance_tokens']), { billable_in: 4000, out: 1000, usage_complete: 0, cost_status: 'unknown', unknown_allowance_tokens: 5000 }, 'the original row keeps what was observed and carries the allowance of the remainder');
    // 15,000 observed of 10,000: the run is stopped at its limit (SEAM.md §55) and its allowance is zero, not negative.
    const second = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(second, [script.hold('gate', { before: [step.usage({ input_tokens: 9000, output_tokens: 6000 })] })]);
    await tick(fx.engine, project);
    const over = await waitForRunState(fx.home, (await waitForRun(fx.home, second)).id, 'ended', { timeoutMs: 60_000 });
    assertRunEnded(fx.home, over.id, { outcome: 'stopped', reason_class: 'budget', launched: true });
    assert.deepEqual(pick(originalRowOf(fx.home, over.id), ['billable_in', 'out', 'usage_complete', 'unknown_allowance_tokens']), { billable_in: 9000, out: 6000, usage_complete: 0, unknown_allowance_tokens: 0 }, 'an observation past the limit leaves no allowance: zero, never below');

    // (f) Known unknown-cost usage 20,000 and an allowance of 5,000 against a day limit of 24,000: the next dispatch is held, although the known usage alone is within the limit.
    await changePolicy(fx.engine, project, { budget_day_unknown_tokens: 24_000 });
    const third = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(third, [script.complete([step.usage({ input_tokens: 10, output_tokens: 5 })])]);
    for (let i = 0; i < 2; i++) await tickOnce(fx.engine, project);
    assert.equal(runsOf(fx.home, third).length, 0, 'the next dispatch is held: the allowance counts');
    const ledger = await getLedger(fx.engine, project);
    assert.deepEqual(pick(ledger.totals, ['unknown_cost_invocations', 'unknown_cost_tokens', 'unknown_allowance_tokens', 'usage_incomplete']), { unknown_cost_invocations: 2, unknown_cost_tokens: 20_000, unknown_allowance_tokens: 5000, usage_incomplete: 2 }, 'the read shows the known usage and the allowance in force apart');
    assert.deepEqual(ledger.budget, { exhausted: ['budget_day_unknown_tokens'] }, 'the hold names the unknown-token day limit');
    assert.equal(ledger.rows.find((row) => row.id === charged.id)?.unknown_allowance_tokens, 5000, 'each row shows its allowance');

    // (e) The provider's terminal usage for the cancelled invocation: 700 more tokens, complete.
    const corrected = await correct(fx.engine, { invocation: invocationOf(fx.home, stopped.id), seq: 1, raw: { input_tokens: 500, output_tokens: 200 }, usage_complete: true });
    assert.equal(corrected.status, 201, `the correction is appended (body: ${corrected.text})`);
    assert.deepEqual(originalRowOf(fx.home, stopped.id), charged, 'the original row is unchanged, its allowance included');
    const settled = await getLedger(fx.engine, project);
    assert.deepEqual(pick(settled.totals, ['unknown_cost_tokens', 'unknown_allowance_tokens', 'usage_incomplete']), { unknown_cost_tokens: 20_700, unknown_allowance_tokens: 0, usage_incomplete: 1 }, 'the day\'s unknown tokens fall to the corrected remainder: the known usage, and no allowance for an invocation whose usage is complete');
    assert.deepEqual(settled.budget, { exhausted: [] }, 'the day is within its limit again');
    await tickUntil(fx.engine, project, () => workItem(fx.home, third).status === 'complete', { what: 'the held work to be dispatched once the allowance is reconciled' });
    assert.equal(runsOf(fx.home, third).length, 1);
  });

  test('(d) a fault once on the ledger write, the retry and a restart: one original row, the allowance charged once', async (t) => {
    await awayFromMidnight();
    const fx = await scriptedEngine(t);
    const project = (await addProject(fx)).id;
    await changePolicy(fx.engine, project, { budget_run_billable_tokens: 10_000 });
    const item = await addWork(fx.engine, project, 'verification');
    await armFault(fx.engine, { point: 'before_event', event_type: 'ledger.row' });
    const stopped = await cancelledAfter(fx, project, item, { input_tokens: 4000, output_tokens: 1000 });
    assertRunEnded(fx.home, stopped.id, { outcome: 'stopped', reason_class: 'human_stop', launched: true });
    const expected = { billable_in: 4000, out: 1000, usage_complete: 0, unknown_allowance_tokens: 5000 };
    assert.deepEqual(ledgerRows(fx.home, project).map((row) => pick(row, Object.keys(expected))), [expected], 'after the fault and the retry: one original row with the allowance');

    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, project);
    assert.deepEqual(ledgerRows(fx.home, project).map((row) => pick(row, Object.keys(expected))), [expected], 'after a restart and a tick: still the one row, the allowance charged once');
    const { totals } = await getLedger(fx.engine, project);
    assert.deepEqual(pick(totals, ['invocations', 'unknown_cost_tokens', 'unknown_allowance_tokens']), { invocations: 1, unknown_cost_tokens: 5000, unknown_allowance_tokens: 5000 });
  });
});
