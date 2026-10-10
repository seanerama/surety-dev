// M305 (d), the second half: a result invalidated after the verification
// row (slice 25; deferred here by slice 23, COVERAGE.md "M4 slice 23").
// M4 plan §3.1 M305 (d); D4-V06; D4 §§4.3, 5.5; E114 item 3; SEAM.md
// §§190, 249, 251, 265, 270.
//
// `alpha_complete` does not trust a stored `verified` label (D4 §5.5; AR
// B05): it re-reads the deciding results the row rests on as they are now.
// The engine evaluates completion at the tick after the row (SEAM.md §270),
// and the barrier `deploy.before_completion` fires in that tick before the
// evaluation's transaction. The engine is killed there (the barrier's
// `kill`), so the row is durable and completion has not been evaluated; the
// deciding post-deploy result is then marked invalidated in the stopped
// engine's store (D1 correction 17's durable `check_results.invalidated_at`,
// the only column an invalidation writes, SEAM.md §72) †; the engine is
// started again. Every engine path that invalidates a result (a protected
// application's finalizer; `adopt` of an observation) needs ticks of the
// same project, which a barrier paused in that tick would hold, so the
// invalidation is the test's write between incarnations (slice 23's
// reasoning; SEAM.md §270). The control makes the same kill and restart
// without the write: completion is then recomputed at the next tick and
// advances (D4 §4.3, "after the verification row, before completion").

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { eventsOfType } from './harness/journal.mjs';
import { scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { openStore, storePath, withStore } from './harness/store.mjs';
import { armBarrier, candidateRow, deployable, deployToRound, tickToBarrier, verificationsOf, roundsOf } from './harness/deploy/kernel.mjs';
import { alphaCompleteRows, recordExit } from './harness/deploy/rounds.mjs';

// A verified row recorded and the engine killed before completion is evaluated. Returns {ctx, operation, result, row}.
async function killedBeforeCompletion(t) {
  const fx = await scriptedEngine(t);
  const ctx = await deployable(fx);
  const { operation, execution } = await deployToRound(ctx);
  await armBarrier(fx.engine, 'deploy.before_completion', 'kill');
  await recordExit(fx.engine, execution.id, 0);
  const dying = fx.engine;
  await tickToBarrier(fx, ctx.project, 'deploy.before_completion').catch(() => undefined);
  await dying.exited;
  const [round] = roundsOf(fx.home, operation.id);
  const [row] = round ? verificationsOf(fx.home, round.id) : [];
  assert.equal(row?.outcome, 'verified', `the fixture is live: the round's row is verified before completion is evaluated (row ${JSON.stringify(row)})`);
  assert.equal(candidateRow(fx.home, ctx.candidate.id).progress, 'developing', 'the fixture is live: completion was not evaluated before the kill (SEAM.md §270)');
  const result = withStore(fx.home, (db) => db.prepare('SELECT * FROM "check_results" WHERE "execution" = ?').get(execution.id));
  assert.ok(result, 'the deciding post-deploy result exists');
  return { fx, ctx, operation, result, row };
}

describe('M305 (d) completion re-reads the deciding results: one invalidated after the row refuses it', () => {
  test('control: the same kill between the row and completion, and a restart: completion is recomputed at the next tick and advances the candidate', async (t) => {
    const { fx, ctx } = await killedBeforeCompletion(t);
    await fx.start();
    await tickUntil(fx.engine, ctx.project, () => (candidateRow(fx.home, ctx.candidate.id).progress === 'alpha_deployed' ? true : undefined), { max: 12, what: 'completion recomputed after the restart' });
    assert.equal(eventsOfType(fx.home, 'candidate.advanced').length, 1, 'one advance');
  });

  test('the deciding result invalidated after the verification row and before completion: completion is not satisfied, a reason names the result or the row, and the candidate stays developing', async (t) => {
    const { fx, ctx, result, row } = await killedBeforeCompletion(t);
    const db = openStore(storePath(fx.home));
    try {
      const changed = db.prepare('UPDATE "check_results" SET "invalidated_at" = ? WHERE "id" = ? AND "invalidated_at" IS NULL').run(new Date().toISOString(), result.id).changes;
      assert.equal(changed, 1, 'the deciding result is marked invalidated in the stopped store (correction 17)');
    } finally {
      db.close();
    }
    await fx.start();
    await tick(fx.engine, ctx.project, { rounds: 6 });
    assert.equal(candidateRow(fx.home, ctx.candidate.id).progress, 'developing', 'the candidate stays developing: completion did not trust the stored verified label (D4 §5.5)');
    assert.equal(eventsOfType(fx.home, 'candidate.advanced').length, 0, 'no advance');
    const last = alphaCompleteRows(fx.home, ctx.candidate.id).at(-1);
    assert.equal(last?.outcome, 'not_satisfied', `completion was evaluated and not satisfied (${JSON.stringify(last)})`);
    const named = (last.reasons ?? []).some((r) => (r.subjects ?? []).includes(result.id) || (r.subjects ?? []).includes(row.id));
    assert.ok(named, `a reason names the invalidated result ${result.id} or the row ${row.id} (reasons: ${JSON.stringify(last.reasons)}) (SEAM.md §270) †`);
  });
});
