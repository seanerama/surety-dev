// M305, one operation per authorization; completion advances (slice 23). M4
// plan §3.1 M305; D4-O01, D4-V06; D4 §§4.1, 4.3, 5.5; E114; SEAM.md §§246,
// 249, 250, 251.
//
// One authorization makes at most one deploy operation, however often its
// work is claimed or its request repeated, and a consumed authorization
// starts nothing else. `alpha_complete`, evaluated for the operation, is the
// only way to `alpha_deployed`: satisfied, it advances the candidate and
// completes the work item in its own transaction; it re-reads the evidence
// the verification row rests on, so a deciding result's output removed after
// the row refuses it. M4 writes no `releases` row.
//
// Deferred (COVERAGE.md, a question for Sean): (d)'s second half, a result
// invalidated after the row. Every way the engine invalidates a result (a
// protected application's finalizer, `adopt` of an observation of the
// integration branch) needs ticks, and the row and the completion it allows
// are made in the same tick; a barrier between them holds every tick. It
// belongs with the generation and round guards of slice 25 (M317, M318).

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { describe, test } from 'node:test';

import { assertNoEffect, maxEventSeq, storeState } from './harness/fixtures.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { recordExit } from './harness/checks/selection.mjs';
import { recordFile, recordRow } from './harness/records.mjs';
import { seedWorkItem } from './harness/seed.mjs';
import { scriptedEngine, tick, tickUntil, workItem } from './harness/runs.mjs';
import { openStore, storePath, withStore } from './harness/store.mjs';
import {
  adapterState,
  armBarrier,
  candidateRow,
  deploy,
  deployable,
  deployToRound,
  deployWork,
  effectCalls,
  evaluateAlphaComplete,
  operationsOf,
  releaseBarrier,
  requestDeployment,
  scriptCall,
  tickToBarrier,
} from './harness/deploy/kernel.mjs';

const hasTable = (home, name) => withStore(home, (db) => db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined);
const alphaCompleteRows = (home, candidate) => withStore(home, (db) => db.prepare(`SELECT * FROM "gate_evaluations" WHERE "candidate" = ? AND "gate_kind" = 'alpha_complete' ORDER BY rowid`).all(candidate));

describe('M305 (a), (b) one operation per authorization', () => {
  test('two simultaneous requests and a claim interrupted by a kill after the intent make one operation and one consumption', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }]);
    const both = await Promise.all([1, 2].map(() => requestDeployment(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name)));
    for (const res of both) assert.ok([200, 201].includes(res.status), `answered (→ ${res.status} ${res.text})`);
    assert.equal(new Set(both.map((r) => r.body.authorization.id)).size, 1, 'one authorization');
    assert.equal(deployWork(fx.home, ctx.project).length, 1, 'one work item');

    // The engine dies right after the intent's transaction; the next incarnation claims the work again.
    await armBarrier(fx.engine, 'deploy.intended', 'kill');
    const dying = fx.engine;
    await tickToBarrier(fx, ctx.project, 'deploy.intended').catch(() => undefined);
    await dying.exited;
    await fx.start();
    await tickUntil(fx.engine, ctx.project, () => operationsOf(fx.home, ctx.project, 'deploy')[0]?.finalized_at ?? undefined, { max: 16, what: 'the operation to be finalized' });
    await tick(fx.engine, ctx.project, { rounds: 2 });
    assert.equal(operationsOf(fx.home, ctx.project, 'deploy').length, 1, 'one deploy operation');
    assert.equal(eventsOfType(fx.home, 'authorization.consumed').length, 1, 'one consumption');
    assert.equal(effectCalls(await adapterState(fx.engine, ctx.env.id), 'deploy').length, 1, 'one deploy call');
  });

  test('a consumed authorization offered to another intent starts nothing', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'refused' }]);
    const first = await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    await tickUntil(fx.engine, ctx.project, () => operationsOf(fx.home, ctx.project, 'deploy').find((o) => o.status === 'failed'), { max: 12, what: 'the operation to end' });

    // A second deploy work item naming the consumed authorization, written into the stopped engine's store.
    await fx.engine.stop();
    const db = openStore(storePath(fx.home));
    let seeded;
    try {
      seeded = seedWorkItem(db, ctx.project, { kind: 'deploy', status: 'eligible' }).id;
      db.prepare(`UPDATE "work_items" SET "trigger_source" = 'deployment_request', "trigger_id" = ?, "trigger_generation" = 2, "subject" = ? WHERE "id" = ?`).run(
        first.authorization.id,
        JSON.stringify({ candidate: ctx.candidate.id, environment: ctx.env.id, authorization: first.authorization.id }),
        seeded,
      );
    } finally {
      db.close();
    }
    await fx.start();
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }]);
    await tick(fx.engine, ctx.project, { rounds: 6 });
    assert.equal(operationsOf(fx.home, ctx.project, 'deploy').length, 1, 'no second operation');
    assert.equal(eventsOfType(fx.home, 'authorization.consumed').length, 1, 'no second consumption');
    assert.equal(effectCalls(await adapterState(fx.engine, ctx.env.id), 'deploy').length, 0, 'no deploy call in this incarnation');
    assert.notEqual(workItem(fx.home, seeded).status, 'complete', 'the seeded item is not reported done');
  });
});

describe('M305 (c), (e) completion advances, and nothing else does', () => {
  test('alpha_complete for the operation: pending while its round is open; satisfied once the round is verified, advancing the candidate and completing the work item in its own transaction; no other route; no releases row', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    const { operation, execution, request } = await deployToRound(ctx);

    const pending = await evaluateAlphaComplete(fx.engine, ctx.project, ctx.candidate.id, operation.id);
    assert.equal(pending.status, 200, `the gate route answers for the operation (body: ${pending.text})`);
    assert.equal(pending.body.evaluation?.outcome, 'not_satisfied');
    assert.ok(pending.body.evaluation.reasons.some((r) => r.code === 'DEPLOY_VERIFICATION_PENDING'), `the round is open: DEPLOY_VERIFICATION_PENDING (reasons: ${JSON.stringify(pending.body.evaluation.reasons)})`);
    assert.equal(candidateRow(fx.home, ctx.candidate.id).progress, 'developing');

    const before = storeState(fx.home);
    const seq = maxEventSeq(fx.home);
    const other = await fx.engine.post(`/v1/projects/${ctx.project}/candidates/${ctx.candidate.id}/advance`, { progress: 'alpha_deployed' });
    assert.ok([404, 501].includes(other.status), `no route advances a candidate (→ ${other.status})`);
    assertNoEffect(fx.home, before, seq, 'an advance asked for by a route');

    await recordExit(fx.engine, execution.id, 0);
    await tickUntil(fx.engine, ctx.project, () => (candidateRow(fx.home, ctx.candidate.id).progress === 'alpha_deployed' ? true : undefined), { max: 12, what: 'the advance' });
    const advanced = eventsOfType(fx.home, 'candidate.advanced');
    assert.equal(advanced.length, 1, 'one advance');
    const sameTx = withStore(fx.home, (db) => db.prepare('SELECT "type", "subject", "payload" FROM "events" WHERE "tx" = ?').all(advanced[0].tx));
    assert.ok(sameTx.some((e) => e.type === 'gate.evaluated'), 'the advance is in an evaluation\'s transaction');
    assert.ok(sameTx.some((e) => e.type.startsWith('work.') && JSON.parse(e.subject).work_item === request.work_item.id && JSON.parse(e.payload ?? '{}').to === 'complete'), 'with the work item\'s completion');
    assert.equal(workItem(fx.home, request.work_item.id).status, 'complete');
    assert.equal(alphaCompleteRows(fx.home, ctx.candidate.id).filter((e) => e.outcome === 'satisfied').length, 1);
    if (hasTable(fx.home, 'releases')) assert.equal(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "releases"').get().n), 0, 'no releases row');
  });
});

describe('M305 (d) completion re-reads the evidence the verification row rests on', () => {
  test("the deciding post-deploy result's output record removed after the verification row: completion is refused (EVIDENCE_MISSING) and the candidate stays developing", async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    const { execution } = await deployToRound(ctx);
    await armBarrier(fx.engine, 'verify.row_recorded', 'pause');
    await recordExit(fx.engine, execution.id, 0);
    await tickToBarrier(fx, ctx.project, 'verify.row_recorded');
    const result = withStore(fx.home, (db) => db.prepare('SELECT * FROM "check_results" WHERE "execution" = ?').get(execution.id));
    assert.ok(result?.output, 'the result names its output record');
    rmSync(recordFile(fx.home, recordRow(fx.home, result.output)), { force: true });
    await releaseBarrier(fx.engine, 'verify.row_recorded');
    await tick(fx.engine, ctx.project, { rounds: 4 });
    assert.equal(candidateRow(fx.home, ctx.candidate.id).progress, 'developing', 'the candidate stays developing');
    assert.equal(eventsOfType(fx.home, 'candidate.advanced').length, 0);
    const last = alphaCompleteRows(fx.home, ctx.candidate.id).at(-1);
    assert.equal(last?.outcome, 'not_satisfied', 'the completion evaluation is not satisfied');
    assert.ok(JSON.parse(last.reasons).some((r) => r.code === 'EVIDENCE_MISSING' && r.subjects.includes(result.output)), `EVIDENCE_MISSING names the record (reasons: ${last.reasons})`);
  });
});
