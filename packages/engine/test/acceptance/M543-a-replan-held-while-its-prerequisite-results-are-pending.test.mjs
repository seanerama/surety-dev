// M543 (a), (b), (c), (e), (f), a replan whose prerequisite results are
// still to come is held, not refused (M6 slice 39; kernel lane). M6 plan
// §3.1 M543; BS6 §11.3 (E154 item 6 (2)); M444F-1 (M5 report §15); D6 §5.3
// item 3, §5.6, §5.8; E148 item 3; E156 Q1; SEAM.md §474 (the pins: the hold
// reason `prerequisite_results`, the interval's `pending`).
//
// The fixture (harness/journey/held543.mjs, M426 (a)'s journey): phase 1
// complete, phase 2 published, stage 3 integrated and nominated, stage 4
// parked, the owner's `replan` (D6 §5.7). Phase 1's required `accept-r1` on
// stage 3's candidate, the newest, is kept back by the test: its execution
// is queued (or running) and its result is still to come, so the dependency
// clause reads phase 1 `unknown` there. On main the replan's plan check
// refuses the plan `PLAN_DEPENDENCY_INCOMPLETE` and spends its repair at once
// (M444F-1).
//   (a) the replan held with a recorded hold interval, reason
//       `prerequisite_results`, whose `pending` names `accept-r1` and its
//       execution; not refused, no repair spent, no blocker raised;
//   (f) the project read during the hold shows the held replan with the
//       result it waits on;
//   (e) a restart during the hold: the hold continues, no duplicate replan;
//   (b) the result recorded passed: checked again and published as routed
//       (published, or a `plan_approval` raised); recorded failed: refused
//       `PLAN_DEPENDENCY_INCOMPLETE` with D6 §5.6's one repair, then the
//       blocker offering `retry` and `cancel`;
//   (c) `repair_attempts` unchanged by the hold.
// Whether the engine holds the replan before its dispatch or after its run
// is the Builder's; the cases read the item, its runs and the plan checks.
//
// SAFETY (BS6 §4.1; E64): kernel lane; nothing acts on a process but the
// test's own engine (the verified kill) and its scripted roles.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { TO_RUNNING, drive, recordExit, stepExecution } from './harness/checks/selection.mjs';
import { executionRow } from './harness/checks/fixtures.mjs';
import { workOf } from './harness/journey/drive.mjs';
import {
  DEPENDENCY,
  HOLD_REASON,
  KEPT_KEY,
  dependencyRefusals,
  describeOutcome,
  failedRuns,
  intervalsOf,
  itemRow,
  names,
  openBlockers,
  openInterval,
  outcomeOf,
  pumpKeeping,
  runsOfItem,
  toReplacement,
} from './harness/journey/held543.mjs';
import { tick } from './harness/runs.mjs';

// The replan's outcome with the kept execution untouched.
const untilOutcome = (j, item, what) => pumpKeeping(j.fx, j.p.id, () => outcomeOf(j.fx, j.p, item, j.phase2), { keep: (x) => x.id === j.kept.id, max: 30, what });

// (a)'s observations of a held replan.
function assertHeld(j, item, out) {
  const { fx, p, kept } = j;
  assert.ok(out.held, `the replan is held while ${KEPT_KEY}'s result on the newest candidate is still to come, not refused (${describeOutcome(out)})`);
  assert.equal(out.held.reason, HOLD_REASON, `a recorded hold interval, reason ${HOLD_REASON} (${JSON.stringify(out.held)})`);
  assert.ok(names(out.held, kept.id), `the interval's pending names ${KEPT_KEY} and its execution ${kept.id} (${JSON.stringify(out.held)})`);
  assert.deepEqual(failedRuns(fx.home, p.id, item.id).map((r) => [r.outcome, r.reason_class, r.reason_text]), [], 'no run of the replan refused');
  assert.deepEqual(dependencyRefusals(fx.home, p.id).map((c) => c.reasons), [], `no plan check refused ${DEPENDENCY}`);
  assert.deepEqual(openBlockers(fx.home, item.id).map((d) => d.question), [], 'no blocker raised');
  assert.equal(itemRow(fx.home, item.id).repair_attempts, 0, 'no repair spent');
}

describe('M543 a replan whose prerequisite results are still to come is held, not refused', () => {
  test('(a) held on prerequisite_results naming the queued result; (f) the project read shows it; (e) a restart keeps the hold, no duplicate replan; (b) the result passed: published as routed; (c) no repair spent', async (t) => {
    const j = await toReplacement(t);
    const { fx, p, kept } = j;
    assert.equal(executionRow(fx.home, kept.id)?.status, 'queued', `the fixture is live: ${KEPT_KEY} on the newest candidate is queued`);
    const item = await j.replan();
    // (a)
    const out = await untilOutcome(j, item, 'the replan held, refused, parked or published');
    assertHeld(j, item, out);
    const runsAtHold = runsOfItem(fx.home, p.id, item.id).length;
    await tick(fx.engine, p.id, { rounds: 3 });
    assert.equal(openInterval(fx.home, item.id)?.reason, HOLD_REASON, 'the hold stands over further ticks');
    assert.equal(runsOfItem(fx.home, p.id, item.id).length, runsAtHold, 'and nothing more of the replan is dispatched while it holds');
    // (f) the project read during the hold.
    const read = await fx.engine.get(`/v1/projects/${p.id}`);
    assert.equal(read.status, 200, `GET /v1/projects/:p (→ ${read.status})`);
    assert.ok(read.text.includes(item.id), `the project read shows the held replan ${item.id} (${read.text.slice(0, 1200)})`);
    assert.ok(read.text.includes(KEPT_KEY) && read.text.includes(kept.id), `with the result it waits on: ${KEPT_KEY}, execution ${kept.id} (${read.text.slice(0, 1200)})`);
    // (e) a restart during the hold.
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, p.id, { rounds: 3 });
    assert.equal(executionRow(fx.home, kept.id)?.status, 'queued', 'the fixture is live: the result is still to come after the restart');
    const afterRestart = openInterval(fx.home, item.id);
    assert.equal(afterRestart?.reason, HOLD_REASON, `the hold continues after the restart (${JSON.stringify(intervalsOf(fx.home, item.id))})`);
    assert.ok(names(afterRestart, kept.id), 'still naming the pending result');
    assert.deepEqual(workOf(fx.home, p.id, 'replan').filter((w) => !['complete', 'cancelled'].includes(w.status)).map((w) => w.id), [item.id], 'no duplicate replan: the held item is the only replan not ended');
    assert.equal(runsOfItem(fx.home, p.id, item.id).length, runsAtHold, 'no run dispatched by the restart');
    assert.equal(itemRow(fx.home, item.id).repair_attempts, 0, 'no repair spent across the restart');
    // (b) the result recorded passed: checked again, published as routed.
    await recordExit(fx.engine, kept.id, 0);
    const next = await pumpKeeping(
      fx,
      p.id,
      () => {
        const o = outcomeOf(fx, p, item, j.phase2);
        return o && !o.held ? o : undefined;
      },
      { max: 30, what: 'the replan after its result passed' },
    );
    assert.ok(next.published || next.approval, `checked again and published as routed (${describeOutcome(next)})`);
    assert.deepEqual(failedRuns(fx.home, p.id, item.id).map((r) => r.reason_text), [], 'no run of the replan refused');
    assert.deepEqual(dependencyRefusals(fx.home, p.id).map((c) => c.reasons), [], `no plan check refused ${DEPENDENCY}`);
    // (c)
    assert.equal(itemRow(fx.home, item.id).repair_attempts, 0, '(c) repair_attempts unchanged by the hold');
    const closed = intervalsOf(fx.home, item.id).filter((h) => h.reason === HOLD_REASON);
    assert.ok(closed.length > 0 && closed.every((h) => typeof h.to === 'string'), `the hold interval closed (${JSON.stringify(closed)})`);
  });

  test('(a) held on prerequisite_results naming the running result; (b) the result failed: refused PLAN_DEPENDENCY_INCOMPLETE with the one repair, then the blocker; (c) only that repair counted', async (t) => {
    const j = await toReplacement(t);
    const { fx, p, kept } = j;
    await drive(fx.engine, kept.id, TO_RUNNING);
    assert.equal(executionRow(fx.home, kept.id)?.status, 'running', `the fixture is live: ${KEPT_KEY} on the newest candidate is running`);
    const item = await j.replan();
    const out = await untilOutcome(j, item, 'the replan held, refused, parked or published');
    assertHeld(j, item, out);
    // (b) the result recorded failed.
    await stepExecution(fx.engine, kept.id, 'collecting');
    await stepExecution(fx.engine, kept.id, 'recorded', { exit_status: 1 });
    const blocker = await pumpKeeping(fx, p.id, () => openBlockers(fx.home, item.id)[0], { max: 30, what: 'the refused replan repaired once and parked' });
    const failed = failedRuns(fx.home, p.id, item.id);
    assert.equal(failed.length, 2, `refused, then D6 §5.6's one repair, refused again (${JSON.stringify(failed.map((r) => [r.outcome, r.reason_class, r.reason_text]))})`);
    for (const r of failed) {
      assert.deepEqual([r.outcome, r.reason_class], ['failed', 'invalid_result'], 'the plan check refused the plan');
      assert.match(r.reason_text ?? '', new RegExp(DEPENDENCY), `${DEPENDENCY} (${r.reason_text})`);
      assert.match(r.reason_text ?? '', new RegExp(KEPT_KEY), `naming the failed ${KEPT_KEY} (${r.reason_text})`);
    }
    const options = blocker.options.map((o) => o.key);
    for (const o of ['retry', 'cancel']) assert.ok(options.includes(o), `the blocker offers ${o} (${JSON.stringify(options)})`);
    // (c)
    assert.equal(itemRow(fx.home, item.id).repair_attempts, 1, '(c) one repair counted: the refusal\'s, none for the hold');
  });
});
