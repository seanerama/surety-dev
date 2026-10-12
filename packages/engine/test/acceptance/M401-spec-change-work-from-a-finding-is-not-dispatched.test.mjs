// M401 (h), the 31b review's S5 (slice 31; kernel lane). D3 §5 X2 (a
// `change_spec` answer raises `spec_change` work, recorded, which waits),
// D6 §4.2 (the request from a finding is not built in this slice; the thin
// path is the owner's request), SEAM §§353, 374.
//
// A Builder's objection fails its check and D3 §5 X2's blocker is answered
// `change_spec`: one `spec_change` item is raised about the finding. It is
// not dispatched: no Spec Writer run starts for it, whatever ticks follow,
// and the run slot stays free: a fix item added afterwards is dispatched and
// ends.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { consume } from './harness/decisions.mjs';
import { addItem, permittedEdit, roleThat } from './harness/gitruns.mjs';
import { runsOf, scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { recordExit } from './harness/checks/selection.mjs';
import { buildAndNominate, findingsBy, repairProject, workFor, x2Blocker } from './harness/checks/repair.mjs';

const objection = { check: 'acc', criterion: 'R1.1', category: 'contract_conflict', message: 'S5: the acceptance check contradicts the interface' };

describe('M401 (h) S5: spec_change work raised from a finding', () => {
  test('is recorded and not dispatched: no Spec Writer run, and the run slot stays free for other work', async (t) => {
    const fx = await scriptedEngine(t);
    fx.scripted.defaultScript(script.complete());
    const p = await repairProject(fx, { policy: { autonomy: 'step' } });
    const b = await buildAndNominate(fx, p, { scripts: [roleThat([permittedEdit()], { nominate: true, objections: [objection] })] });
    const [f] = findingsBy(fx.home, p.id, (row) => row.source_run === b.run.id);
    await recordExit(fx.engine, b.reg.acc.id, 1, { output: 'S5: the objected check failed\n' });
    const blocker = await x2Blocker(fx, p.id, b.item);
    await consume(fx, p.id, blocker, 'change_spec');
    const [item] = workFor(fx.home, p.id, 'spec_change', f.id);
    assert.ok(item, 'the fixture is live: one spec_change item, raised about the finding');
    await tick(fx.engine, p.id, { rounds: 4 });
    assert.deepEqual(runsOf(fx.home, item.id), [], 'no run is dispatched for it');
    assert.deepEqual(fx.scripted.launches({ work_kind: 'spec_change' }), [], 'no Spec Writer is launched');
    // The run slot is free: other work is dispatched and ends.
    const fix = await addItem(fx, p.id, 'fix');
    fx.scripted.script(fix, [roleThat([step.write('src/s5.js', 'export const s5 = 1;\n')])]);
    const ran = await tickUntil(fx.engine, p.id, () => runsOf(fx.home, fix)[0]?.state === 'ended' && runsOf(fx.home, fix)[0], { what: 'the fix to be dispatched and end', max: 6 });
    assert.equal(ran.state, 'ended');
    assert.deepEqual(runsOf(fx.home, item.id), [], 'and still no run for the spec_change item');
  });
});
