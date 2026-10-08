// M218 (e), a record removed after recording (M3 slice 18; kernel lane).
// M3 plan §3.4 M218 (e); D3 §2.6 ("Output"); D1 §9.3 input 8; T09; SEAM.md
// §§58, 72, 190, 207. The rest of the row is
// `M218-output-and-evidence-presence.test.mjs` (sandbox lane), where the
// other half of (e), a record refused by the secret screen, is read.
//
// An engine-recorded result names its output record; the stage and Alpha
// gates are satisfied on it (the control). The record's bytes are then
// removed from the engine home while the engine is stopped; at the next
// start the audit finds them missing, and every evaluation that selects the
// result carries EVIDENCE_MISSING naming the record. No finding exists in
// the project at any point, so the reason is the evidence's own, asserted
// apart from any finding (T09).
//
// Kernel lane: the result is recorded through the scripted check boundary
// (SEAM.md §190), the engine's own transition.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { describe, test } from 'node:test';

import { alphaTarget, findingsOf, reasonSubjects, stageGate } from './harness/gates.mjs';
import { permittedEdit, roleThat, runToEnd, waitForCandidates } from './harness/gitruns.mjs';
import { recordFile, recordRow } from './harness/records.mjs';
import { scriptedEngine, tickUntil } from './harness/runs.mjs';
import { GOVERNED_FILE, KERNEL_COMMANDS, acceptance, checkProject, defPath, executionsOf, governedText, installIndexedPlan, resultRow, smoke } from './harness/checks/fixtures.mjs';
import { recordExit } from './harness/checks/selection.mjs';

describe('M218 (e) evidence missing, apart from the finding', () => {
  test('a result whose output record was removed after recording is EVIDENCE_MISSING on every evaluation that selects it, with no finding in the project', async (t) => {
    const fx = await scriptedEngine(t);
    // M3 slice 20 (L3, B04; SEAM.md §226): a T1 scope is complete with its
    // requirement's one criterion covered by an acceptance check and the
    // smoke check beside it; the stage implements R1. Both are recorded with
    // output; the smoke check's record is the one removed.
    const p = await checkProject(fx, {
      files: { [GOVERNED_FILE]: governedText({ check_commands: KERNEL_COMMANDS }), [defPath('sm')]: smoke('sm'), [defPath('acc')]: acceptance('acc', ['R1.1']) },
      tier: 'T1',
    });
    const plan = await installIndexedPlan(fx.engine, p.id, { index: [{ key: 'R1', criteria: ['R1.1'] }], stages: [{ number: 1, goal: 'the first stage', implements: ['R1'] }] });
    fx.scripted.script(plan.stages[0].work_item, [roleThat([permittedEdit()], { nominate: true })]);
    await runToEnd(fx, p.id, plan.stages[0].work_item);
    const [c] = await waitForCandidates(fx, p.id);
    const stage = plan.stages[0].id;
    const ctx = { project: p, stage, candidate: c };
    const registered = await tickUntil(fx.engine, p.id, () => {
      const rows = executionsOf(fx.home, c.id);
      return ['sm', 'acc'].every((key) => rows.some((e) => e.key === key)) ? rows : undefined;
    }, { max: 6, what: 'the nomination to register both checks' });
    const [x] = registered.filter((e) => e.key === 'sm');
    const [y] = registered.filter((e) => e.key === 'acc');
    const recorded = await recordExit(fx.engine, x.id, 0, { output: 'the check passed with output\n' });
    await recordExit(fx.engine, y.id, 0, { output: 'the acceptance check passed\n' });
    const result = resultRow(fx.home, recorded.id);
    assert.ok(result.output, 'the result names its output record');

    // The control: the gates are satisfied on it.
    const alpha = await alphaTarget(fx, ctx);
    assert.equal((await stageGate(fx, ctx)).outcome, 'satisfied', 'the fixture is live: the stage gate is satisfied on the recorded result');
    assert.equal((await alpha.evaluate()).outcome, 'satisfied', 'and so is alpha_authorize');

    // The record's bytes are removed while the engine is stopped.
    const record = recordRow(fx.home, result.output);
    await fx.engine.stop();
    rmSync(recordFile(fx.home, record));
    await fx.start();

    assert.deepEqual(findingsOf(fx.home, p.id), [], 'no finding exists in the project');
    for (const [what, evaluation] of [['stage', await stageGate(fx, ctx)], ['alpha_authorize', await alpha.evaluate()]]) {
      assert.equal(evaluation.outcome, 'not_satisfied', `${what}: not satisfied`);
      assert.ok(reasonSubjects(evaluation, 'EVIDENCE_MISSING').includes(record.id), `${what}: EVIDENCE_MISSING names the removed record (D1 §9.3 input 8; reasons ${JSON.stringify(evaluation.reasons)})`);
      assert.deepEqual(reasonSubjects(evaluation, 'FINDING_BLOCKING'), [], `${what}: and no finding blocks it: the reason is the evidence's own (T09)`);
    }
  });
});
