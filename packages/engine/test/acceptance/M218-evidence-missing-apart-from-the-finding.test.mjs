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
import { recordFile, recordRow } from './harness/records.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { executionsOf, resultRow } from './harness/checks/fixtures.mjs';
import { discoveredProject, nominateStage, recordExit } from './harness/checks/selection.mjs';

describe('M218 (e) evidence missing, apart from the finding', () => {
  test('a result whose output record was removed after recording is EVIDENCE_MISSING on every evaluation that selects it, with no finding in the project', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await discoveredProject(fx, ['sm']);
    const c = await nominateStage(fx, p, ['sm']);
    const ctx = { project: p, stage: p.stage.id, candidate: c };
    const [x] = executionsOf(fx.home, c.id).filter((e) => e.key === 'sm');
    const recorded = await recordExit(fx.engine, x.id, 0, { output: 'the check passed with output\n' });
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
