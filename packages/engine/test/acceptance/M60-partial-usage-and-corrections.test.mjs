// M60, partial usage and idempotent delta corrections (slice 4). Plan §3.6
// M60; D1 §§3.6, 13.1, 16, D1-26; Review N04; SEAM.md §§53, 54.
//
// Usage arrives as observations, cumulative or delta, and is folded into the
// invocation's one original ledger row. When the engine dies mid-invocation
// what was observed survives, and the row says that the rest is unknown.
// Finalizing again writes nothing. A later correction is a delta row with a
// fixed identity, linked to the original: it is applied once however often
// it is sent, and the fold of original and corrections gives the totals and
// what is still uncertain.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { correct, getLedger, invocationOf, ledgerRows, originalRowOf } from './harness/ledger.mjs';
import { addProject, addWork, assertRunEnded, countOf, runsOf, scriptedEngine, tick, tickUntil, waitForRun, waitForRunState, workItem } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';

// An invocation whose engine was killed after two cumulative observations:
// 500 input and 70 output tokens are known, the rest is not.
async function interrupted(t) {
  const fx = await scriptedEngine(t);
  const project = (await addProject(fx)).id;
  const item = await addWork(fx.engine, project, 'verification');
  fx.scripted.script(item, [script.hold('gate', { before: [step.usage({ input_tokens: 300, output_tokens: 40 }), step.usage({ input_tokens: 500, output_tokens: 70 })] })]);
  await tick(fx.engine, project);
  const run = await waitForRun(fx.home, item, { state: 'executing' });
  const invocation = invocationOf(fx.home, run.id);
  await waitFor(() => countOf(fx.home, 'usage_observations', '"invocation" = ?', invocation) === 2, { what: 'both usage observations to be stored' });
  await fx.engine.kill();
  await fx.start();
  await waitForRunState(fx.home, run.id, 'ended');
  return { fx, project, run, invocation };
}

const KNOWN_SO_FAR = { billable_in: 500, cached_in: null, out: 70, usage_complete: 0, cost_status: 'unknown', cost_usd: null };
const pick = (row, keys = Object.keys(KNOWN_SO_FAR)) => Object.fromEntries(keys.map((key) => [key, row[key]]));

describe('M60 partial usage and idempotent corrections', () => {
  test('cumulative observations and delta observations of the same usage fold to the same original row', async (t) => {
    const fx = await scriptedEngine(t);
    const project = (await addProject(fx)).id;
    const cumulative = await addWork(fx.engine, project, 'verification');
    const delta = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(cumulative, [script.complete([step.usage({ input_tokens: 100, output_tokens: 10 }), step.usage({ input_tokens: 250, cache_read_tokens: 40, output_tokens: 30 }), step.usage({ input_tokens: 400, cache_read_tokens: 40, output_tokens: 55 })])]);
    fx.scripted.script(delta, [script.complete([step.usage({ input_tokens: 100, output_tokens: 10 }, 'delta'), step.usage({ input_tokens: 150, cache_read_tokens: 40, output_tokens: 20 }, 'delta'), step.usage({ input_tokens: 150, output_tokens: 25 }, 'delta')])]);
    await tickUntil(fx.engine, project, () => [cumulative, delta].every((id) => workItem(fx.home, id).status === 'complete'), { what: 'both items to complete' });

    for (const item of [cumulative, delta]) {
      const [run] = runsOf(fx.home, item);
      assert.equal(countOf(fx.home, 'usage_observations', '"invocation" = ?', invocationOf(fx.home, run.id)), 3, 'each observation is stored as it came');
      assert.deepEqual(pick(originalRowOf(fx.home, run.id), ['billable_in', 'cached_in', 'out', 'usage_complete']), { billable_in: 400, cached_in: 40, out: 55, usage_complete: 1 });
    }
    const { totals } = await getLedger(fx.engine, project);
    assert.deepEqual(totals, { invocations: 2, billable_in: 800, cached_in: 80, out: 110, usage_incomplete: 0, reported_usd: null, estimated_usd: null, unknown_cost_invocations: 2, unknown_cost_tokens: 910 });
  });

  test('usage observed before the engine was killed survives with the rest marked unknown, and finalizing again adds nothing', async (t) => {
    const { fx, project, run } = await interrupted(t);
    assertRunEnded(fx.home, run.id, { outcome: 'recovered', launched: true });
    const row = originalRowOf(fx.home, run.id);
    assert.deepEqual(pick(row), KNOWN_SO_FAR, 'what was observed is kept; the remainder is unknown, not zero');

    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, project);
    assert.deepEqual(ledgerRows(fx.home, project).map((r) => r.id), [row.id], 'a second recovery and a tick leave the one original row');
    const { totals } = await getLedger(fx.engine, project);
    assert.deepEqual(totals, { invocations: 1, billable_in: 500, cached_in: null, out: 70, usage_incomplete: 1, reported_usd: null, estimated_usd: null, unknown_cost_invocations: 1, unknown_cost_tokens: 570 });
  });

  test('a later correction is a delta row linked to the original, applied once however often it is sent, and it settles what was uncertain', async (t) => {
    const { fx, project, run, invocation } = await interrupted(t);
    const original = originalRowOf(fx.home, run.id);
    const first = { invocation, seq: 1, raw: { input_tokens: 120, cache_read_tokens: 60, output_tokens: 30, cost_usd: 0.75 }, usage_complete: true };

    const created = await correct(fx.engine, first);
    assert.equal(created.status, 201, `the correction is appended (body: ${created.text})`);
    assert.equal(created.body.created, true);
    const [, row] = ledgerRows(fx.home, project);
    assert.equal(created.body.ledger_row.id, row.id);
    assert.deepEqual(
      pick(row, ['invocation', 'run', 'corrects', 'correction_seq', 'billable_in', 'cached_in', 'out', 'usage_complete', 'cost_status', 'cost_usd']),
      { invocation, run: run.id, corrects: original.id, correction_seq: 1, billable_in: 120, cached_in: 60, out: 30, usage_complete: 1, cost_status: 'reported', cost_usd: 0.75 },
      'the correction row holds the deltas and names the row it corrects',
    );
    assert.deepEqual(JSON.parse(row.raw_usage), first.raw);

    const replayed = await correct(fx.engine, first);
    assert.deepEqual([replayed.status, replayed.body?.created, replayed.body?.ledger_row?.id], [200, false, row.id], `the same correction again is the row that exists (body: ${replayed.text})`);
    await fx.engine.stop();
    await fx.start();
    const afterRestart = await correct(fx.engine, first);
    assert.deepEqual([afterRestart.status, afterRestart.body?.created, afterRestart.body?.ledger_row?.id], [200, false, row.id], 'and after a restart');
    assert.equal(ledgerRows(fx.home, project).length, 2, 'one original and one correction');
    assert.equal(eventsOfType(fx.home, 'ledger.correction').length, 1, 'recorded once');
    assert.deepEqual(pick(originalRowOf(fx.home, run.id)), KNOWN_SO_FAR, 'the original row is as it was');
    assert.deepEqual((await getLedger(fx.engine, project)).totals, { invocations: 1, billable_in: 620, cached_in: 60, out: 100, usage_incomplete: 0, reported_usd: 0.75, estimated_usd: null, unknown_cost_invocations: 0, unknown_cost_tokens: null }, 'original plus correction, each once; nothing is uncertain any more');

    // A second correction that says nothing about cost or completeness changes neither.
    const second = await correct(fx.engine, { invocation, seq: 2, raw: { output_tokens: 5 } });
    assert.deepEqual([second.status, second.body?.created], [201, true], `a second correction (body: ${second.text})`);
    assert.deepEqual((await getLedger(fx.engine, project)).totals, { invocations: 1, billable_in: 620, cached_in: 60, out: 105, usage_incomplete: 0, reported_usd: 0.75, estimated_usd: null, unknown_cost_invocations: 0, unknown_cost_tokens: null });
  });
});
