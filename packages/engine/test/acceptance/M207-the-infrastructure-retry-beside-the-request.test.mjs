// M207 (c), the infrastructure retry beside the operator request (M3 slice
// 18; kernel lane). M3 plan §3.2 M207 (c); D3 §2.6 ("History beside the
// deciding result"), §2.7; N03; T05; SEAM.md §§190, 191, 204. The rest of
// the row is `M207-reuse-bounded-history-beside-the-result.test.mjs`
// (slice 16), which deferred this case to the slice that builds the
// `recovery` registration (COVERAGE.md, "M3 slice 16").
//
// The nomination's execution is interrupted; the engine registers it again
// as `recovery` in that transition; the retry fails (exit 1) and is not
// retried, since a genuine failure is never an infrastructure error; an
// operator's request fails too; a second request passes. Beside the
// deciding pass the gate read lists the three earlier executions with
// their triggers, so the bounded infrastructure retry is told from the
// operator's request; nothing is relabelled.
//
// Kernel lane: the engine admits no execution (SEAM.md §177); the test
// moves each through the scripted check boundary (§190), whose transition
// to `interrupted` is the engine's own, recovery registration included.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { checkResult, stageGate } from './harness/gates.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { executionsOf } from './harness/checks/fixtures.mjs';
import { TO_RUNNING, discoveredProject, drive, entryOf, nominateStage, operatorRequest, recordExit, resultOf, stepExecution } from './harness/checks/selection.mjs';

describe('M207 (c) the infrastructure retry beside the operator request', () => {
  test('an interrupted execution is registered again as recovery; its failure is not retried; the gate read tells the retry from the requests and relabels nothing', async (t) => {
    const fx = await scriptedEngine(t, { config: { check_infra_retries_max: 2 } });
    const p = await discoveredProject(fx, ['sm']);
    const c = await nominateStage(fx, p, ['sm']);
    const ctx = { project: p, stage: p.stage.id };

    // The nomination's execution is interrupted: the engine registers its retry in that transition.
    const [nominated] = executionsOf(fx.home, c.id).filter((x) => x.key === 'sm');
    await drive(fx.engine, nominated.id, TO_RUNNING);
    await stepExecution(fx.engine, nominated.id, 'interrupted');
    const afterInterrupt = executionsOf(fx.home, c.id).filter((x) => x.key === 'sm');
    const retry = afterInterrupt.find((x) => x.retry_of === nominated.id);
    assert.ok(retry, `the interrupted execution is registered again (D3 §2.7) (executions: ${JSON.stringify(afterInterrupt.map((x) => [x.id, x.status, x.trigger, x.retry_of]))})`);
    assert.deepEqual([retry.trigger?.source, retry.status, retry.infra_retries], ['recovery', 'queued', 1], 'as trigger recovery, queued, the first infrastructure retry of its original trigger (SEAM.md §204)');
    assert.deepEqual([retry.trigger?.id, retry.trigger?.generation], [nominated.trigger.id, nominated.trigger.generation + 1], "the next generation of the nomination's trigger (T05)");
    assert.deepEqual(resultOf(fx.home, nominated.id), [], 'the interrupted execution has no result row');

    // The retry fails: a genuine failure, never retried as an infrastructure error.
    const retryFailure = await recordExit(fx.engine, retry.id, 1, { output: 'the retry failed\n' });
    assert.deepEqual(
      executionsOf(fx.home, c.id).filter((x) => x.key === 'sm').map((x) => x.id),
      [nominated.id, retry.id],
      'no registration follows a failed result',
    );

    // An operator's request fails; a second passes.
    const { sm: request } = await operatorRequest(fx.engine, p.id, c.id, ['sm']);
    const requestFailure = await recordExit(fx.engine, request, 1, { output: 'the request failed\n' });
    const before = [checkResult(fx.home, retryFailure.id), checkResult(fx.home, requestFailure.id)];
    const { sm: second } = await operatorRequest(fx.engine, p.id, c.id, ['sm']);
    const pass = await recordExit(fx.engine, second, 0);

    const evaluation = await stageGate(fx, ctx, c);
    const checkId = Object.keys(evaluation.check_states).find((id) => entryOf(evaluation, id).key === 'sm');
    const entry = entryOf(evaluation, checkId);
    assert.deepEqual([entry.state, entry.deciding?.execution, entry.deciding?.result], ['passed', second, pass.id], 'the latest registration, passing, decides');
    assert.equal(entry.history?.count, 3, `three earlier executions at the same bindings (history: ${JSON.stringify(entry.history)})`);
    assert.deepEqual(
      entry.history.executions.map((h) => [h.execution, h.trigger?.source, h.state]),
      [
        [nominated.id, 'nomination', null],
        [retry.id, 'recovery', 'failed'],
        [request, 'operator_request', 'failed'],
      ],
      "in sequence, each with its trigger and state: the interrupted nomination (no result), the infrastructure retry and the operator's request are distinguishable",
    );
    assert.deepEqual([checkResult(fx.home, retryFailure.id), checkResult(fx.home, requestFailure.id)], before, 'the pass relabels neither earlier failure');
  });
});
