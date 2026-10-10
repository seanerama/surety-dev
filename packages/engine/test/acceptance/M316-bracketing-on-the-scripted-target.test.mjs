// M316 (d), (e), bracketing on the scripted target (slice 25). M4 plan
// §3.3 M316; D4-V03; J7; D4 §5.3; E114; SEAM.md §§247, 265, 267.
//
// Kernel lane. The two identity reads of one round bracket its checks: what
// changes between them is caught, and a round whose bindings changed
// between them is never verified. (d) another generation on the target
// between the reads: the scripted target's unit of generation 1 replaced by
// one of generation 2 (the real-unit form is in
// M316-bracketing-on-a-real-unit). (e) two reads that would both match, but
// under different protected versions or required sets: the round is
// superseded (D4 §5.3 item 7) and no row of it is verified.
//
// Deferred (COVERAGE.md "M4 slice 25"): (f), an out-of-band observation
// between the reads, to slice 27: nothing records an environment-subject
// out-of-band observation before slice 27's observation job and J6.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { capturedProposal, humanApplies } from './harness/gates.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { definitionText, defPath } from './harness/checks/fixtures.mjs';
import { POST_DEPLOY, deployable, deployToRound, unitName } from './harness/deploy/kernel.mjs';
import { changeTarget, environmentRecord, progressOf, recordExit, roundRow, roundsOf, rowOf, rowWhen } from './harness/deploy/rounds.mjs';

async function atRound1(t) {
  const fx = await scriptedEngine(t);
  const ctx = await deployable(fx);
  const { operation, execution } = await deployToRound(ctx);
  const [round1] = roundsOf(fx.home, operation.id);
  return { ...ctx, operation, round1, x1: execution };
}

describe('M316 (d) another generation between the reads', () => {
  test('generation 1\'s unit replaced on the target by one of generation 2 after the first read: the second read does not match, and the round is failed, never verified', async (t) => {
    const ctx = await atRound1(t);
    const first = ctx.round1;
    await changeTarget(ctx.fx.engine, ctx.env.id, (target) => {
      const g1 = target.units.find((u) => u.generation === 1);
      assert.ok(g1, `the fixture is live: generation 1 runs on the target (${JSON.stringify(target.units)})`);
      const g2 = { ...g1, name: unitName(ctx.fx.home, ctx.env.id, 2), generation: 2, invocation_id: `${g1.invocation_id}-g2`, cgroup: `${g1.cgroup}-g2`, instance: { pid: 199001, start_time: 4242 }, init: { pid: 199000, start_time: 4241 } };
      return { ...target, units: [...target.units.filter((u) => u !== g1), g2] };
    });
    await recordExit(ctx.fx.engine, ctx.x1.id, 0);
    const row = await rowWhen(ctx, first.id);
    const second = (row.identity_reads ?? []).find((r) => r.bracket === 'second');
    assert.notEqual(second?.match, 'match', `the second read does not match (${JSON.stringify(second)})`);
    assert.equal(row.outcome, 'failed', `another generation between the reads is a difference: failed (D4 §5.3) (${row.outcome})`);
    assert.equal(environmentRecord(ctx.fx.home, ctx.env.id).last_verified ?? null, null, 'nothing is recorded as verified');
    assert.equal(progressOf(ctx.fx.home, ctx.candidate.id), 'developing');
  });
});

describe('M316 (e) two reads under different protected versions or required sets never verify', () => {
  for (const [what, file, content] of [
    ['a protected version changed between the reads', '.surety/checks/notes.json', '{"note": "changed between the reads"}\n'],
    ['the required set changed between the reads', defPath('behaves2'), definitionText('behaves2', POST_DEPLOY)],
  ]) {
    test(`${what}: the target unchanged, so both reads would match; the round is superseded and no row of it is verified`, async (t) => {
      const ctx = await atRound1(t);
      const proposal = await capturedProposal(ctx.fx, { id: ctx.project }, { changeKind: null, steps: [step.write(file, content)] });
      await humanApplies(ctx.fx, { id: ctx.project }, proposal, 'tightening');
      if (['queued'].includes(ctx.x1.status)) await recordExit(ctx.fx.engine, ctx.x1.id, 0).catch(() => undefined);
      await tick(ctx.fx.engine, ctx.project, { rounds: 4 });
      assert.equal(roundRow(ctx.fx.home, ctx.round1.id).status, 'superseded', 'round 1 is superseded (D4 §5.3 item 7)');
      const row = rowOf(ctx.fx.home, ctx.round1.id);
      assert.notEqual(row?.outcome === 'verified' && row?.invalidated_reason === null, true, `no row of round 1 is a verified row that decides (${JSON.stringify(row)})`);
      assert.notEqual(environmentRecord(ctx.fx.home, ctx.env.id).last_verified?.round, ctx.round1.id, 'last_verified never names round 1');
      assert.equal(progressOf(ctx.fx.home, ctx.candidate.id), 'developing');
    });
  }
});
