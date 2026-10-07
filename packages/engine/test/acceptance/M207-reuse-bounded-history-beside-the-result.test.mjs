// M207, reuse bounded; history beside the deciding result (M3 slice 16;
// kernel lane). M3 plan §3.2 M207; D3-S06, D3-R27; D3 §2.6 ("History beside
// the deciding result"), §3.5; Q1, N03; SEAM.md §§72, 73, 103, 189 to 191.
//
// (c) Two failures, then a pass, at the same bindings: the gate read shows,
// beside the deciding pass, the count and identities of the earlier
// executions with their states and triggers, and a link to their ordered
// history; the pass relabels nothing. (b) A protected application then
// invalidates every result of the superseded version, the engine's own
// included; nothing crosses versions, and the engine creates no reuse entry.
//
// Case (a), a reuse entry at the same and at a changed fingerprint or
// version, is row M41's two blocks (SEAM.md §§73, 103): a check's
// fingerprint is a function of its version's tree (D3 §1.3), so a changed
// fingerprint at an unchanged version cannot be built. The infrastructure
// retry beside the operator request in (c) waits for slice 18's recovery
// registration (COVERAGE.md, "M3 slice 16").
//
// Kernel lane: the engine admits no execution (SEAM.md §177); the test
// moves each through the scripted check boundary (§190).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { capturedProposal, checkResult, humanApplies, stageGate } from './harness/gates.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { defPath, executionsOf, smoke } from './harness/checks/fixtures.mjs';
import { discoveredProject, entryOf, nominateStage, operatorRequest, recordExit, resultOf } from './harness/checks/selection.mjs';

const resultRows = (home, candidate) => withStore(home, (db) => db.prepare('SELECT * FROM "check_results" WHERE "candidate" = ? ORDER BY "execution_seq"').all(candidate));

describe('M207 reuse bounded; history beside the deciding result', () => {
  test('(c) two failures then a pass at the same bindings: the gate read shows the earlier executions, their states and triggers, and a link to their history; the pass relabels nothing; (b) a protected application then invalidates every result of the old version and creates no reuse entry', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await discoveredProject(fx, ['sm']);
    const c = await nominateStage(fx, p, ['sm']);
    const ctx = { project: p, stage: p.stage.id };

    // The nomination's registration fails; an operator's request fails; another passes.
    const [nominationRun] = executionsOf(fx.home, c.id).filter((x) => x.key === 'sm');
    await recordExit(fx.engine, nominationRun.id, 1, { output: 'first failure\n' });
    const { sm: second } = await operatorRequest(fx.engine, p.id, c.id, ['sm']);
    await recordExit(fx.engine, second, 1, { output: 'second failure\n' });
    const failures = resultRows(fx.home, c.id).map((row) => ({ ...row }));
    const { sm: third } = await operatorRequest(fx.engine, p.id, c.id, ['sm']);
    const pass = await recordExit(fx.engine, third, 0);

    const evaluation = await stageGate(fx, ctx, c);
    const checkId = Object.keys(evaluation.check_states).find((id) => entryOf(evaluation, id).key === 'sm');
    assert.ok(checkId, 'the fixture is live: sm is a required check of the stage scope');
    const entry = entryOf(evaluation, checkId);
    assert.deepEqual([entry.state, entry.deciding?.execution, entry.deciding?.result], ['passed', third, pass.id], 'the latest registration, passing, decides');

    // N03: beside it, the earlier executions at the same bindings.
    const history = entry.history;
    assert.ok(history && typeof history === 'object', `the gate read carries the history beside the deciding execution (SEAM.md §191) (entry: ${JSON.stringify(entry)})`);
    assert.equal(history.count, 2, 'the count of earlier executions at the same bindings');
    assert.deepEqual(
      history.executions.map((h) => [h.execution, h.state, h.trigger?.source]),
      [
        [nominationRun.id, 'failed', 'nomination'],
        [second, 'failed', 'operator_request'],
      ],
      'their identities, in sequence, each with its state and its trigger, so that a rerun on request is told from the nomination\'s run',
    );
    const linked = await fx.engine.get(history.link);
    assert.equal(linked.status, 200, `the link reads their ordered history (link: ${history.link}; body: ${linked.text})`);
    const listed = linked.body.executions.map((x) => x.id);
    assert.deepEqual(listed.filter((id) => [nominationRun.id, second, third].includes(id)), [nominationRun.id, second, third], 'the linked history lists the executions in sequence, the failures before the pass');

    // The pass relabels nothing.
    for (const before of failures) assert.deepEqual(checkResult(fx.home, before.id), before, `the earlier failure ${before.id} is as it was recorded`);
    assert.deepEqual(resultOf(fx.home, nominationRun.id).map((r) => r.exit_status), [1]);
    assert.deepEqual(resultOf(fx.home, second).map((r) => r.exit_status), [1]);

    // (b) A protected application: the engine's results of the old version are invalidated, and nothing crosses versions.
    const proposal = await capturedProposal(fx, p, { changeKind: null, steps: [step.write(defPath('extra'), smoke('extra'))] });
    await humanApplies(fx, p, proposal, 'tightening');
    for (const row of resultRows(fx.home, c.id)) {
      assert.ok(row.invalidated_at, `the result ${row.id} recorded under the superseded version is invalidated (Q1; SEAM.md §72)`);
    }
    const after = await stageGate(fx, ctx, c);
    const smAfter = Object.entries(after.check_states).find(([id]) => entryOf(after, id).key === 'sm');
    assert.ok(smAfter, 'sm is still required under the new version');
    assert.notEqual(smAfter[1], 'passed', `no result of the old version passes under the new one (state: ${smAfter[1]})`);
    assert.ok(![pass.id, ...failures.map((f) => f.id)].includes(entryOf(after, smAfter[0]).deciding?.result), 'and none decides there');
    const reuse = withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "evidence_reuse" WHERE "project" = ?').get(p.id).n);
    assert.equal(reuse, 0, 'the engine creates no reuse entry (D3 §3.5)');
  });
});
