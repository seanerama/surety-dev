// M204 (f), a nomination that owes its registration (M3 slice 20; kernel
// lane). M3 plan §3.1 M204 (f), deferred from slice 15 to slice 20 (SEAM.md
// §185: the required set depends on modules only once the sensitivity
// floors exist); D3 §2.5 ("When registration happens"), §4.1; L2; D3-R13;
// SEAM.md §§183, 224.
//
// A nomination whose required set needs facts read from the candidate's tree
// (its module presence, which decides the deployment scope's floors) either
// registers from facts frozen at intent or records `checks_due` on the
// candidate; while checks are due, every evaluation treats each check of the
// due registration as `missing`, naming it, so no gate consumes evidence
// older than a registration the trigger owes. The case makes the presence
// read fail across the nomination (SEAM.md §224's fault), records a passing
// fixture result for every check, and evaluates both gates before any
// registration: each check is missing, its entry names the candidate's
// `checks_due`, and neither gate is satisfied.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { alphaTarget, evaluate } from './harness/gates.mjs';
import { armFault, clearFaults } from './harness/engine.mjs';
import { scriptedEngine, tickUntil } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { entryByKey, executionsOf, gateCheckEntries } from './harness/checks/fixtures.mjs';
import { buildStages, candidatesOfProject, def, passKeys, scopeProject } from './harness/checks/scope.mjs';

describe('M204 (f) a nomination whose required set needs the candidate\'s module facts, evaluated before registration', () => {
  test('every check of the due registration is missing, naming checks_due, and neither gate is satisfied', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await scopeProject(fx, {
      defs: { acc: def('acceptance', { criteria: ['R1.1'] }), smoke: def('smoke'), fpay: def('sensitivity_floor', { areas: ['payments_financial_data'] }) },
      files: { 'billing/pay.js': 'export const pay = () => 0;\n' },
      index: [{ key: 'R1', criteria: ['R1.1'] }],
      modules: [{ name: 'billing', paths: ['billing/'], sensitive_areas: ['payments_financial_data'] }],
      stages: [{ number: 1, goal: 'R1', implements: ['R1'] }],
    });
    // The presence read fails from before the nomination until the case lifts it.
    await armFault(fx.engine, { point: 'module_presence_read', project: p.id, times: 100 });
    await buildStages(fx, p, { nominate: [true] });
    const [c] = await tickUntil(fx.engine, p.id, () => {
      const found = candidatesOfProject(fx.home, p.id);
      return found.length > 0 ? found : undefined;
    }, { max: 6, what: 'the candidate' });
    const due = withStore(fx.home, (db) => db.prepare('SELECT "checks_due" FROM "candidates" WHERE "id" = ?').get(c.id)).checks_due;
    assert.ok(due, 'the nomination could not register from its facts: the candidate records checks_due (D3 §2.5)');
    const dueValue = JSON.parse(due);
    assert.deepEqual([dueValue.trigger?.source, dueValue.trigger?.id, typeof dueValue.at], ['nomination', c.id, 'string'], `checks_due is {trigger, at}, naming the nomination's trigger (SEAM.md §224) (${due})`);
    assert.deepEqual(executionsOf(fx.home, c.id).filter((x) => x.trigger?.source === 'nomination'), [], 'nothing is registered by the nomination yet');

    await passKeys(fx, p.id, c.id, ['acc', 'smoke', 'fpay']);
    const target = await alphaTarget(fx, { project: p, candidate: c });
    for (const [gate, evaluation] of [
      ['stage', await evaluate(fx.engine, p.id, c.id, 'stage', { stage: p.stages[0].id })],
      ['alpha_authorize', await target.evaluate()],
    ]) {
      assert.equal(evaluation.outcome, 'not_satisfied', `${gate}: not satisfied while the registration is owed`);
      const entries = gateCheckEntries(evaluation);
      for (const key of ['acc', 'smoke']) {
        const entry = entryByKey(entries, key);
        assert.ok(entry, `${gate}: ${key} has an entry`);
        assert.equal(entry.state, 'missing', `${gate}: ${key}, though a passing fixture result is recorded, is missing: the trigger owes a registration (D3 §2.5)`);
        assert.ok(entry.due && entry.due.trigger !== undefined && entry.due.at !== undefined, `${gate}: ${key}'s entry names the candidate's checks_due (SEAM.md §183) (entry: ${JSON.stringify(entry)})`);
      }
    }
    await clearFaults(fx.engine);
  });
});
