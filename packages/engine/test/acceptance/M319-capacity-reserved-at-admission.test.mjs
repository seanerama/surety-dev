// M319 (a), verification capacity reserved at admission, on the scripted
// target (slice 25). M4 plan §3.3 M319; D4-O14; D4 §4.7; E115 item 3; E126;
// SEAM.md §§247, 250, 265, 271.
//
// Kernel lane. Admitting a service domain reserves, beside its own memory,
// one check's capacity; an envelope that cannot hold both makes the attempt
// wait for admission within the orchestration deadline, shown on the deploy
// work item as D2's `resource_envelope` hold (D4 A.2), and then refuses it
// before the prior service is stopped. In the kernel lane admission is the
// scripted adapter's answer (SEAM.md §247); the envelope's own arithmetic
// (a service that fits alone but not with a check) is the sandbox file's,
// M319-the-reserved-check-capacity.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { recordFile, recordRow } from './harness/records.mjs';
import { advanceClock, scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { adapterState, deploy, deployable, deployToRound, effectCalls, environmentLeases, operationsOf, scriptCall, setAdmission } from './harness/deploy/kernel.mjs';
import { recordExit, roundsOf, rowWhen, workEntry } from './harness/deploy/rounds.mjs';

describe('M319 (a) an envelope that holds the service but not the service and one check', () => {
  test('the replacement waits for admission (resource_envelope on its work item) within the deadline, then fails before its effect: generation 1 still running, no effect call', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    const { operation: op1, execution } = await deployToRound(ctx);
    await recordExit(fx.engine, execution.id, 1);
    await rowWhen(ctx, roundsOf(fx.home, op1.id)[0].id);
    await tick(fx.engine, ctx.project, { rounds: 2 });
    const before = (await adapterState(fx.engine, ctx.env.id)).target;
    assert.ok(before.units.some((u) => u.generation === 1 && u.state === 'active'), 'the fixture is live: the prior service, generation 1, runs');
    const deployCalls = effectCalls(await adapterState(fx.engine, ctx.env.id), 'deploy').length;

    await setAdmission(fx.engine, ctx.env.id, 'held');
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }]);
    const request = await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    const op2 = await tickUntil(fx.engine, ctx.project, () => operationsOf(fx.home, ctx.project, 'deploy').find((o) => o.id !== op1.id), { max: 8, what: 'the replacement to be intended' });
    await tick(fx.engine, ctx.project, { rounds: 2 });
    const waiting = await workEntry(fx.engine, ctx.project, request.work_item.id);
    assert.equal(waiting?.dispatch_hold?.code, 'resource_envelope', `while admission waits, the deploy work item shows resource_envelope (D4 §4.7, A.2) (SEAM.md §271) (${JSON.stringify(waiting)})`);
    assert.equal(operationsOf(fx.home, ctx.project, 'deploy').find((o) => o.id === op2.id).status, 'intended', 'it waits before its effect');

    await advanceClock(fx.engine, 1801);
    const failed = await tickUntil(fx.engine, ctx.project, () => {
      const o = operationsOf(fx.home, ctx.project, 'deploy').find((x) => x.id === op2.id);
      return o.status === 'failed' ? o : undefined;
    }, { max: 12, what: 'the replacement to be refused at its deadline' });
    assert.deepEqual([failed.outcome_detail?.code, failed.outcome_detail?.fact], ['EFFECT_PRECONDITION_CHANGED', 'orchestration_deadline'], `refused before its effect, naming the deadline (${JSON.stringify(failed.outcome_detail)})`);
    const facts = JSON.parse(readFileSync(recordFile(fx.home, recordRow(fx.home, failed.outcome_detail.manifest))).toString('utf8')).facts ?? [];
    assert.ok(facts.some((f) => f.fact === 'orchestration_deadline' && f.held === false), 'the precondition manifest records it');
    const after = await adapterState(fx.engine, ctx.env.id);
    assert.equal(effectCalls(after, 'deploy').length, deployCalls, 'no effect call was made for the replacement');
    assert.equal(effectCalls(after, 'teardown').length, 0, 'nothing was stopped');
    assert.deepEqual(after.target, before, 'the prior service is untouched: generation 1 still running');
    assert.ok(environmentLeases(fx.home, ctx.env.id).every((l) => l.released_at !== null), 'the lease is released');
  });
});
