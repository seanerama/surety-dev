// M12, the over-budget case (slice 4; deferred from slice 2). Plan §3.2 M12
// ("two projects with ready work; one ... over budget"); D1 §§8.1, 13.3;
// E16b; SEAM.md §55. A project whose day budget is used up dispatches
// nothing, and the other project's work goes on.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { addGitProject, runToEnd } from './harness/gitruns.mjs';
import { changePolicy } from './harness/journal.mjs';
import { awayFromMidnight, getLedger } from './harness/ledger.mjs';
import { addWork, assertRunEnded, runsOf, scriptedEngine, tick, tickUntil, workItem } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';

describe('M12 scheduling boundaries: a project that is over budget', () => {
  test('its ready work is never launched while the other project progresses', async (t) => {
    await awayFromMidnight();
    const fx = await scriptedEngine(t);
    const over = await addGitProject(fx, { name: 'over-budget' });
    const other = await addGitProject(fx, { name: 'within-budget' });
    await changePolicy(fx.engine, over.id, { budget_day_verified_usd: 1 });
    fx.scripted.defaultScript(script.complete([step.usage({ input_tokens: 10, output_tokens: 5, cost_usd: 0.1 })]));

    // One run of the first project reports a cost of 2.5 against a day limit of 1.
    const spender = await addWork(fx.engine, over.id, 'verification');
    fx.scripted.script(spender, [script.hold('gate', { before: [step.usage({ input_tokens: 10, output_tokens: 5, cost_usd: 2.5 })] })]);
    const spent = await runToEnd(fx, [over.id, other.id], spender);
    assertRunEnded(fx.home, spent.id, { outcome: 'stopped', reason_class: 'budget' });
    assert.deepEqual((await getLedger(fx.engine, over.id)).budget, { exhausted: ['budget_day_verified_usd'] });

    const waiting = await addWork(fx.engine, over.id, 'verification');
    const going = [await addWork(fx.engine, other.id, 'verification'), await addWork(fx.engine, other.id, 'verification')];
    await tickUntil(fx.engine, [other.id, over.id], () => going.every((id) => workItem(fx.home, id).status === 'complete'), { what: 'the other project\'s work to complete' });
    for (let i = 0; i < 2; i++) await tick(fx.engine, other.id);

    assert.equal(runsOf(fx.home, waiting).length, 0, 'no run was created for the over-budget project');
    assert.equal(fx.scripted.launches({ work_item: waiting }).length, 0);
    assert.equal(workItem(fx.home, waiting).status, 'eligible', 'its work is still ready');
    assert.deepEqual((await getLedger(fx.engine, other.id)).budget, { exhausted: [] });
  });
});
