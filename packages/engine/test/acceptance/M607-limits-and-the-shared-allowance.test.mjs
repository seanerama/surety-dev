// M607, limits and the shared allowance (the owner's draft M7 plan §3, row
// M607; request §5; rulings R4, S5 of 2026-10-28; SEAM.md §575). Kernel
// lane.
//
//   (a) a run's effective allowance = min(the per-run limit, what the
//       iteration has left after its settled usage, its unknown allowances
//       and the other runs' reservations), served with limited_by; a run
//       with no positive allowance refused, the iteration limit_reached.
//   (b) two dispatches racing on one tick: the sum of the reservations never
//       exceeds the allowance; with the preset's per-run limit one is held
//       depends_on; with a lower one both run, the second capped.
//   (c) the estimated-dollar threshold: labelled a threshold on estimated
//       cost, never a billing cap; unknown cost never 0.
//   (d) repairs per stage and per iteration: the lower of the prototype
//       value and the item cap (repair_attempts_max).
//   (e) the runtime deadline with a run under way: no new dispatch; the
//       running run ends by its own deadline through the existing
//       termination; the iteration limit_reached with the reason.
//   (f) a raise after limit_reached: it reopens; the iteration's limits
//       updated.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { advanceClockInSteps, tick } from './harness/runs.mjs';
import {
  CHECK_KINDS,
  INDEPENDENT_STAGES,
  PROTO,
  SERVER,
  alphaReady,
  answerOpen,
  assertAccounted,
  builderOwn,
  builderScript,
  confirmed,
  eventsFor,
  firstPlanScript,
  holdingBuilder,
  idle,
  iterationRead,
  kindNext,
  limitsCommitted,
  ownerPolicy,
  protoEngine,
  pump,
  result,
  runsOfIteration,
  statusIs,
  toBrief,
  usage,
  workOfProject,
  write,
} from './harness/prototype.mjs';

const LEASE_TTL = 600;
const holdThen = (hold, path, content) => ({ steps: [usage(1000, 0, 200), { hold, heartbeat_ms: 250 }, write(path, content), result()], on_term: 'exit' });
const fail = () => ({ steps: [usage(300, 0, 100), { exit: 3 }] });
const underWay = (read) => read.usage.runs.filter((x) => x.work_kind === 'stage_build' && x.finished_at === null);

// Pump until `n` stage builds are under way, each having reported its usage.
const racing = (fx, p, it, n) =>
  pump(fx, p, async () => {
    const r = await iterationRead(fx, p, it);
    const u = underWay(r);
    return u.length >= n && u.every((x) => x.invocations[0]?.usage.billable_in === 1000) ? r : undefined;
  }, { answer: CHECK_KINDS, wait: false, what: `${n} stage build(s) under way` });

describe('M607 limits and the shared allowance', () => {
  const shared = sharedFixture();
  const S = {};
  before(async () => {
    S.fx = await protoEngine(shared.context, { config: { lease_ttl: LEASE_TTL } });
  });
  after(() => shared.cleanup());

  test('(b) two dispatches racing, the preset\'s per-run limit: one under way given all the iteration had left, the other held depends_on; the reservations never past the allowance', async () => {
    const { fx } = S;
    const { id: p, it } = await toBrief(fx, { name: 'Tasks race' });
    kindNext(fx, 'replan', [firstPlanScript({ stages: INDEPENDENT_STAGES })], firstPlanScript());
    kindNext(fx, 'stage_build', [holdingBuilder('race'), builderOwn('server.mjs', SERVER), builderOwn('src/b.mjs', 'export const b = 2;\n')], builderScript(1));
    await answerOpen(fx, p, 'spec_approval');
    await alphaReady(fx, p);
    await racing(fx, p, it.id, 1);
    await tick(fx.engine, p);
    await tick(fx.engine, p);
    const r = await iterationRead(fx, p, it.id);
    const under = underWay(r);
    assert.equal(under.length, 1, `one stage build under way (${JSON.stringify(r.usage.runs.map((x) => [x.work_kind, x.finished_at]))})`);
    const inv = under[0].invocations[0];
    const settled = r.remaining.committed.settled_tokens;
    assert.deepEqual([inv.limited_by, inv.run_limit_tokens, inv.effective_limit_tokens], ['iteration', 5_000_000, 1_500_000 - settled], 'given what the iteration had left after its settled usage, the per-run limit capped');
    assert.equal(r.remaining.committed.total_tokens, 1_500_000, 'settled + its reservation: exactly the allowance, never past it');
    assert.equal(r.remaining.tokens, 0);
    assert.equal(r.remaining.next_run_reservation_tokens, null, 'a run dispatched now would get nothing');
    assert.equal(r.remaining.next_dispatch?.kind, 'settling', 'the other waits on the run under way');
    const other = workOfProject(fx.home, p).filter((w) => w.kind === 'stage_build' && w.id !== under[0].work_item);
    assert.equal(other.length, 1);
    assert.deepEqual([other[0].status, other[0].held], ['eligible', 'depends_on'], 'not dispatched: held depends_on');
    assertAccounted(r, 'two stages racing');
    S.a = { p, it: it.id, run: under[0].id, other: other[0].id };
  });

  test('(a) a run with no positive allowance is refused: the iteration limit_reached, nothing dispatched', async () => {
    const { fx } = S;
    const { p, it, run } = S.a;
    // The run under way stopped: charged its allowance (the rest of the iteration's), so nothing is left.
    await confirmed(fx, `/v1/projects/${p}/runs/${run}/stop`);
    await idle(fx, p);
    const runsBefore = runsOfIteration(fx.home, it).length;
    await pump(fx, p, statusIs(fx, p, it, 'limit_reached'), { max: 4, what: 'the next dispatch refused' });
    const r = await iterationRead(fx, p, it);
    assert.match(r.outcome.reason, /^tokens: prototype_budget_tokens 1500000: committed 1500000 \(settled \d+, unknown allowances \d+, under way 0 observed \+ 0 reserved\) leaves 0: a run would get no positive allowance \(its per-run limit 5000000, capped at what the iteration has left\)/, r.outcome.reason);
    assert.equal(r.outcome.next_step, PROTO.next_steps.limit);
    assert.equal(r.remaining.tokens, 0);
    assert.equal(runsOfIteration(fx.home, it).length, runsBefore, 'no run dispatched');
    const ev = eventsFor(fx.home, 'prototype.iteration_limit_reached', 'iteration', it).at(-1);
    assert.equal(ev.payload.limit, 'tokens');
    await tick(fx.engine, p);
    assert.equal(runsOfIteration(fx.home, it).length, runsBefore, 'still none');
  });

  test('(f) a raise after limit_reached reopens it; the iteration\'s limits updated', async () => {
    const { fx } = S;
    const { p, it } = S.a;
    const before = runsOfIteration(fx.home, it).length;
    const raised = await ownerPolicy(fx, p, { prototype_budget_tokens: 3_000_000 }, 'the raised allowance');
    assert.ok(raised.widening, 'raising is a widening the owner confirmed');
    assert.deepEqual([raised.prototype?.iteration, raised.prototype?.reopens, raised.prototype?.status, raised.prototype?.raises], [it, true, 'limit_reached', ['prototype_budget_tokens']], `the submission says it reopens (${JSON.stringify(raised.prototype)})`);
    await limitsCommitted(fx, p, it, 'prototype_budget_tokens', 3_000_000);
    const r = await iterationRead(fx, p, it);
    assert.ok(PROTO.open_statuses.includes(r.iteration.status), `open again (${r.iteration.status}; a tick may since have named the work its Stop held)`);
    assert.equal(r.iteration.limits.prototype_budget_tokens, 3_000_000, "the iteration's limits updated");
    const changed = eventsFor(fx.home, 'prototype.iteration_limits_changed', 'iteration', it).at(-1);
    assert.deepEqual([changed.payload.reopened, changed.payload.status, changed.payload.raised], [true, 'building', ['prototype_budget_tokens']]);
    // The next dispatch is checked against the new limit, and admitted.
    await pump(fx, p, () => (runsOfIteration(fx.home, it).length > before ? true : undefined), { answer: CHECK_KINDS, max: 6, what: 'a dispatch under the raised limit' });
  });

  test('(b) two dispatches racing, a per-run limit below what is left: both run, the second capped at what the first left; the sum is the allowance', async () => {
    const { fx } = S;
    const { id: p, it } = await toBrief(fx, { name: 'Tasks race two', policy: { budget_run_billable_tokens: 800_000 } });
    kindNext(fx, 'replan', [firstPlanScript({ stages: INDEPENDENT_STAGES })], firstPlanScript());
    kindNext(fx, 'stage_build', [holdThen('both', 'server.mjs', SERVER), holdThen('both', 'src/b.mjs', 'export const b = 2;\n')], builderScript(1));
    await answerOpen(fx, p, 'spec_approval');
    await alphaReady(fx, p, { port: 18081 });
    const r = await racing(fx, p, it.id, 2);
    const invs = underWay(r).map((x) => x.invocations[0]);
    const settled = r.remaining.committed.settled_tokens;
    const byLimit = Object.fromEntries(invs.map((i) => [i.limited_by, i]));
    assert.deepEqual(Object.keys(byLimit).sort(), ['iteration', 'run'], `one limited by the run, one by the iteration (${JSON.stringify(invs.map((i) => [i.limited_by, i.effective_limit_tokens]))})`);
    assert.equal(byLimit.run.effective_limit_tokens, 800_000, 'the first: its per-run limit');
    assert.equal(byLimit.iteration.effective_limit_tokens, 1_500_000 - settled - 800_000, 'the second: what the iteration had left after the first\'s reservation');
    assert.ok(invs.every((i) => i.run_limit_tokens === 800_000));
    assert.equal(settled + invs.reduce((n, i) => n + i.effective_limit_tokens, 0), 1_500_000, 'settled + the two reservations: the allowance, never more');
    assert.equal(r.remaining.committed.total_tokens, 1_500_000);
    assert.equal(r.remaining.tokens, 0);
    assertAccounted(r, 'both running');
    fx.scripted.release('all', 'both');
    await idle(fx, p);
    const settledAfter = await iterationRead(fx, p, it.id);
    assert.ok(settledAfter.remaining.tokens > 0, 'each settled at what it used: the allowance is free again');
    assertAccounted(settledAfter, 'both settled');
  });

  test('(c) the estimated-dollar threshold: labelled a threshold on estimated cost, never a billing cap; unknown cost never 0', async () => {
    const { fx } = S;
    const { id: p, it } = await toBrief(fx, { name: 'Tasks dollars' });
    const before = await iterationRead(fx, p, it.id);
    assert.equal(before.remaining.usd_label, 'an estimated-cost threshold checked at dispatch, not a billing cap');
    assert.deepEqual([before.remaining.enforced, before.remaining.enforcement], [true, 'dispatch_check']);
    // The preparation reported no cost: unknown, never 0.
    assert.equal(before.usage.runs[0].invocations[0].cost.status, 'unknown');
    assert.equal(before.remaining.usd_estimated, null, 'what is left of the threshold is unknown');
    assert.equal(before.remaining.usd_reason, '1 invocation(s) have unknown cost');
    assert.equal(before.usage.totals.cost.unknown_invocations, 1);
    assert.equal(before.usage.totals.cost.reported_usd, null, 'no reported cost is shown as 0');
    // The first plan reports a cost past the threshold: the next dispatch is refused.
    kindNext(fx, 'replan', [{ ...firstPlanScript(), steps: [{ usage: { semantics: 'cumulative', raw: { input_tokens: 2000, cache_read_tokens: 0, output_tokens: 900, cost_usd: 16 } } }, ...firstPlanScript().steps.slice(1)] }], firstPlanScript());
    await answerOpen(fx, p, 'spec_approval');
    await pump(fx, p, statusIs(fx, p, it.id, 'limit_reached'), { what: 'the threshold to stop dispatch' });
    const r = await iterationRead(fx, p, it.id);
    assert.equal(r.outcome.reason, 'usd_estimated: prototype_budget_usd_estimated 15 reached: settled reported 16 + estimated 0 = 16 USD (a threshold on estimated spend, not a billing cap); 1 invocation(s) not costed are not counted, so the spend is at least this', r.outcome.reason);
    assert.doesNotMatch(JSON.stringify([r.outcome, r.remaining, r.iteration]), /(?<!not a )billing cap/, 'a billing cap is named only to say it is not one');
    assert.equal(r.outcome.next_step, PROTO.next_steps.limit);
    assert.equal(r.remaining.usd_estimated, null, 'unknown cost leaves the remainder unknown, never the limit less 16');
    assert.equal(r.usage.totals.cost.reported_usd, 16);
    assert.deepEqual(runsOfIteration(fx.home, it.id).map((x) => x.work_kind), ['brief_preparation', 'replan'], 'nothing dispatched after the threshold');
    assert.equal(eventsFor(fx.home, 'prototype.iteration_limit_reached', 'iteration', it.id).at(-1).payload.limit, 'usd_estimated');
  });

  test('(d) repairs per stage and per iteration: the lower of the prototype value and the item cap', async () => {
    const { fx } = S;
    // Per stage: prototype_repairs_per_stage 1 below repair_attempts_max 3.
    const st = await toBrief(fx, { name: 'Tasks repairs stage', policy: { prototype_repairs_per_stage: 1 } });
    kindNext(fx, 'stage_build', [fail(), fail(), fail()], builderScript(1));
    await answerOpen(fx, st.id, 'spec_approval');
    await alphaReady(fx, st.id, { port: 18082 });
    let r = await pump(fx, st.id, async () => {
      const x = await iterationRead(fx, st.id, st.it.id);
      return x.iteration.status === 'limit_reached' ? x : undefined;
    }, { answer: CHECK_KINDS, what: 'the repair limit per stage' });
    assert.equal(r.remaining.repairs_per_stage, 1, 'min(prototype_repairs_per_stage 1, repair_attempts_max 3)');
    const item = workOfProject(fx.home, st.id).find((w) => w.kind === 'stage_build');
    assert.equal(r.outcome.reason, `repairs_per_stage: prototype_repairs_per_stage 1 reached: work item ${item.id} has had 1 repair(s), and this dispatch would be repair 2`);
    assert.equal(runsOfIteration(fx.home, st.it.id).filter((x) => x.work_kind === 'stage_build').length, 2, 'the first run and one repair: the third never dispatched');
    // Per iteration, the item cap lower than the prototype's per-stage value.
    const ir = await toBrief(fx, { name: 'Tasks repairs iteration', policy: { prototype_repairs_per_iteration: 1, repair_attempts_max: 1 } });
    kindNext(fx, 'stage_build', [fail(), builderScript(1), fail(), builderScript(2)], builderScript(1));
    await answerOpen(fx, ir.id, 'spec_approval');
    await alphaReady(fx, ir.id, { port: 18083 });
    r = await pump(fx, ir.id, async () => {
      const x = await iterationRead(fx, ir.id, ir.it.id);
      return x.iteration.status === 'limit_reached' ? x : undefined;
    }, { answer: CHECK_KINDS, what: 'the repair limit per iteration' });
    assert.equal(r.remaining.repairs_per_stage, 1, 'min(prototype_repairs_per_stage 2, repair_attempts_max 1): the item cap');
    assert.equal(r.outcome.reason, "repairs_per_iteration: prototype_repairs_per_iteration 1 reached: the iteration's work items have had 1 repair(s), and this dispatch would be repair 2");
    assert.equal(r.remaining.repairs_iteration, 0);
    const stages = runsOfIteration(fx.home, ir.it.id).filter((x) => x.work_kind === 'stage_build');
    assert.deepEqual(stages.map((x) => x.outcome === 'completed'), [false, true, false], 'stage 1 failed and was repaired once; stage 2 failed and its repair was refused');
  });

  test('(e) the runtime deadline with a run under way: no new dispatch, the run ends by its own deadline, the iteration limit_reached with the reason', async () => {
    const { fx } = S;
    const { id: p, it } = await toBrief(fx, { name: 'Tasks runtime', policy: { prototype_runtime_seconds: 300, deadline_builder: 600 } });
    kindNext(fx, 'stage_build', [holdingBuilder('long')], builderScript(1));
    await answerOpen(fx, p, 'spec_approval');
    await alphaReady(fx, p, { port: 18084 });
    const r0 = await racing(fx, p, it.id, 1);
    const run = underWay(r0)[0];
    await advanceClockInSteps(fx.engine, 310, { stepSeconds: Math.floor(LEASE_TTL / 2) });
    await tick(fx.engine, p);
    const r = await iterationRead(fx, p, it.id);
    assert.equal(r.iteration.status, 'limit_reached', 'the runtime passed: limit_reached at the tick');
    assert.match(r.outcome.reason, /^runtime: prototype_runtime_seconds 300 passed \(\d+ s since the brief was approved at .*\); no new run is dispatched, and runs already running continue to their own deadlines$/, r.outcome.reason);
    assert.equal(r.outcome.next_step, PROTO.next_steps.limit);
    const live = runsOfIteration(fx.home, it.id).find((x) => x.id === run.id);
    assert.notEqual(live.state, 'ended', 'the run under way is not ended by the runtime limit');
    const count = runsOfIteration(fx.home, it.id).length;
    await tick(fx.engine, p);
    assert.equal(runsOfIteration(fx.home, it.id).length, count, 'no new dispatch');
    // Its own deadline (deadline_builder 600 s) passes: the existing termination ends it.
    await advanceClockInSteps(fx.engine, 300, { stepSeconds: Math.floor(LEASE_TTL / 2) });
    const ended = await waitFor(async () => {
      await tick(fx.engine, p);
      const x = runsOfIteration(fx.home, it.id).find((y) => y.id === run.id);
      return x.state === 'ended' ? x : undefined;
    }, { timeoutMs: 120_000, what: 'the run to end at its own deadline' });
    assert.deepEqual([ended.outcome, ended.reason_class], ['timed_out', 'deadline'], 'it ends timed_out, by its deadline');
    const after = await iterationRead(fx, p, it.id);
    assert.deepEqual([after.iteration.status, after.outcome.reason], ['limit_reached', r.outcome.reason], 'the iteration stays limit_reached with the runtime reason');
    assert.equal(runsOfIteration(fx.home, it.id).length, count, 'nothing dispatched after');
    const inv = after.usage.runs.find((x) => x.id === run.id).invocations[0];
    assert.ok(inv.unknown_allowance_tokens > 0, 'the timed-out run is charged its allowance, never 0');
    assertAccounted(after, 'after the deadline');
  });
});
