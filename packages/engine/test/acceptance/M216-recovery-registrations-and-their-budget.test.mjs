// M216 (c), a recovery's retries and a restart between them (M3 slice 18;
// kernel lane). M3 plan §3.4 M216 (c); D3 §2.5 ("Triggers"), §2.7, A.3
// (`retry_of`, `infra_retries`); T05; SEAM.md §§190, 204. The sandbox-lane
// cases of the row, (a), (b) and (d), are
// `M216-unknown-interrupted-and-every-point-of-a-start.test.mjs`.
//
// With `check_infra_retries_max` 2: the nomination's execution is
// interrupted and registered again (generation 2, the first retry); the
// engine is killed and started again on the same home; the retry is
// interrupted and registered again (generation 3, the second); that one is
// interrupted and nothing more is registered: the restart reset nothing of
// the original trigger's budget. The check is then `missing`, naming the
// last interrupted execution. Exactly one registration per trigger
// generation and key throughout; each retry registered in the transaction
// that ended the execution it retries.
//
// Kernel lane: the engine admits no execution (SEAM.md §177); the test
// moves each through the scripted check boundary (§190). After a restart a
// scripted execution is changed only by the route (§190).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { stageGate } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { assertOncePerTrigger, executionsOf } from './harness/checks/fixtures.mjs';
import { TO_RUNNING, discoveredProject, drive, entryOf, nominateStage, resultOf, stepExecution } from './harness/checks/selection.mjs';
import { retriesOf } from './harness/checks/execution.mjs';

const ofKey = (fx, c) => executionsOf(fx.home, c.id).filter((x) => x.key === 'sm');

// The check.registered event of `execution` shares its transaction with the
// check.interrupted event of `ended` (SEAM.md §180: events.tx).
function assertRegisteredWith(fx, execution, ended, what) {
  const registered = eventsOfType(fx.home, 'check.registered').find((e) => e.subject?.check_execution === execution);
  const interrupted = eventsOfType(fx.home, 'check.interrupted').find((e) => e.subject?.check_execution === ended);
  assert.ok(registered && interrupted, `${what}: check.registered of the retry and check.interrupted of ${ended} were both emitted`);
  assert.equal(registered.tx, interrupted.tx, `${what}: the retry is registered in the transaction that ends the interrupted execution (D3 §2.5, "recovery registers in the transition that ends the interrupted execution")`);
}

describe('M216 (c) recovery registrations and their budget', () => {
  test('each interruption is registered again as the next generation of its original trigger, at most check_infra_retries_max times; a restart between them resets nothing', async (t) => {
    const fx = await scriptedEngine(t, { config: { check_infra_retries_max: 2 } });
    const p = await discoveredProject(fx, ['sm']);
    const c = await nominateStage(fx, p, ['sm']);
    const [original] = ofKey(fx, c);
    assert.equal(original.trigger?.source, 'nomination');

    // First interruption: the first retry.
    await drive(fx.engine, original.id, TO_RUNNING);
    await stepExecution(fx.engine, original.id, 'interrupted');
    const [first] = retriesOf(ofKey(fx, c), original);
    assert.ok(first, 'the interrupted execution is registered again');
    assert.deepEqual(
      [first.trigger?.source, first.trigger?.id, first.trigger?.generation, first.infra_retries, first.status],
      ['recovery', original.trigger.id, original.trigger.generation + 1, 1, 'queued'],
      'recovery, the original trigger\'s id, the next generation, the first retry (SEAM.md §204)',
    );
    assertRegisteredWith(fx, first.id, original.id, 'the first retry');

    // The engine is killed and started again on the same home.
    await fx.engine.kill();
    await fx.start();
    assert.deepEqual(ofKey(fx, c).map((x) => [x.id, x.status]), [[original.id, 'interrupted'], [first.id, 'queued']], 'the restart changes no scripted execution and registers nothing (SEAM.md §190)');

    // Second interruption, after the restart: the second retry.
    await stepExecution(fx.engine, first.id, 'materializing');
    await stepExecution(fx.engine, first.id, 'interrupted');
    const [, second] = retriesOf(ofKey(fx, c), original);
    assert.ok(second, 'the interrupted retry is registered again: the budget survived the restart unspent');
    assert.deepEqual(
      [second.trigger?.source, second.trigger?.id, second.trigger?.generation, second.infra_retries, second.retry_of],
      ['recovery', original.trigger.id, original.trigger.generation + 2, 2, first.id],
      'the next generation again, the second retry of the original trigger, retrying the first',
    );
    assertRegisteredWith(fx, second.id, first.id, 'the second retry');

    // Third interruption: the budget of 2 is spent; nothing more.
    await drive(fx.engine, second.id, TO_RUNNING);
    await stepExecution(fx.engine, second.id, 'interrupted');
    const rows = ofKey(fx, c);
    assert.deepEqual(rows.map((x) => x.id), [original.id, first.id, second.id], `no third retry: check_infra_retries_max is 2 per original trigger, a restart resetting nothing (executions: ${JSON.stringify(rows.map((x) => [x.trigger, x.infra_retries]))})`);
    assertOncePerTrigger(rows, 'the recovery chain');
    for (const x of rows) assert.deepEqual(resultOf(fx.home, x.id), [], `${x.id}: interrupted, no result row`);

    const evaluation = await stageGate(fx, { project: p, stage: p.stage.id }, c);
    const checkId = Object.keys(evaluation.check_states).find((id) => entryOf(evaluation, id).key === 'sm');
    const entry = entryOf(evaluation, checkId);
    assert.deepEqual([entry.state, entry.pending?.execution, entry.pending?.status], ['missing', second.id, 'interrupted'], 'the check is missing, naming the last interrupted execution; no earlier execution decides');
  });
});
