// M543 (d), a replan whose prerequisite result is not coming is refused at
// once, never held (M6 slice 39; kernel lane). M6 plan §3.1 M543; BS6
// §11.3 (E154 item 6 (2), (3): "a result that can never arrive is refused
// with an open question naming it", rule 25's form); D6 §5.3 item 3, §5.6,
// §5.8; E156 Q1; SEAM.md §474.
//
// The fixture is M543 (a)'s (harness/journey/held543.mjs): an early
// replacement of phase 2 whose dependency clause reads phase 1's
// `accept-r1` on stage 3's candidate, the newest. Here no result is coming:
//   (d) its only execution cancelled (unknown, nothing queued or running);
//   (d) a regressed phase: its result recorded failed (M426 (a)).
// Each: refused at once as built, `PLAN_DEPENDENCY_INCOMPLETE` naming the
// result, never held on `prerequisite_results`; D6 §5.6's one repair; then
// a blocker whose question names the result and which offers `retry` and
// `cancel`: never a silent stall.
//
// SAFETY (BS6 §4.1; E64): kernel lane; nothing acts on a process but the
// test's own engine and its scripted roles.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { stepExecution } from './harness/checks/selection.mjs';
import { executionRow } from './harness/checks/fixtures.mjs';
import { DEPENDENCY, HOLD_REASON, KEPT_KEY, failedRuns, intervalsOf, itemRow, openBlockers, pumpKeeping, toReplacement } from './harness/journey/held543.mjs';

async function refusedAtOnce(j, item) {
  const { fx, p } = j;
  const blocker = await pumpKeeping(fx, p.id, () => openBlockers(fx.home, item.id)[0], { keep: (x) => x.id === j.kept.id, max: 30, what: 'the replan refused, repaired once and parked' });
  assert.deepEqual(intervalsOf(fx.home, item.id).filter((h) => h.reason === HOLD_REASON), [], `never held on ${HOLD_REASON}: no result is coming`);
  const failed = failedRuns(fx.home, p.id, item.id);
  assert.equal(failed.length, 2, `refused at once, then D6 §5.6's one repair, refused again (${JSON.stringify(failed.map((r) => [r.outcome, r.reason_class, r.reason_text]))})`);
  for (const r of failed) {
    assert.deepEqual([r.outcome, r.reason_class], ['failed', 'invalid_result'], 'the plan check refused the plan');
    assert.match(r.reason_text ?? '', new RegExp(DEPENDENCY), `${DEPENDENCY} (${r.reason_text})`);
    assert.match(r.reason_text ?? '', new RegExp(KEPT_KEY), `naming ${KEPT_KEY} (${r.reason_text})`);
  }
  assert.equal(itemRow(fx.home, item.id).repair_attempts, 1, 'one repair counted');
  const options = blocker.options.map((o) => o.key);
  for (const o of ['retry', 'cancel']) assert.ok(options.includes(o), `the blocker offers ${o} (${JSON.stringify(options)})`);
  assert.ok(String(blocker.question ?? '').includes(KEPT_KEY), `the blocker's question names the result ${KEPT_KEY}: never a silent stall (${blocker.question})`);
}

describe('M543 (d) a replan whose prerequisite result is not coming is refused at once', () => {
  test('(d) the result unknown with no execution queued or running (cancelled): refused PLAN_DEPENDENCY_INCOMPLETE, one repair, a blocker naming it with retry and cancel', async (t) => {
    const j = await toReplacement(t);
    await stepExecution(j.fx.engine, j.kept.id, 'cancelled');
    assert.equal(executionRow(j.fx.home, j.kept.id)?.status, 'cancelled', `the fixture is live: ${KEPT_KEY}'s only execution on the newest candidate is cancelled`);
    const item = await j.replan();
    await refusedAtOnce(j, item);
  });

  test('(d) a regressed phase, its result recorded failed: refused PLAN_DEPENDENCY_INCOMPLETE, one repair, a blocker naming it with retry and cancel', async (t) => {
    const j = await toReplacement(t, { keptExit: 1 });
    assert.equal(executionRow(j.fx.home, j.kept.id)?.status, 'recorded', `the fixture is live: ${KEPT_KEY} recorded (failed) on the newest candidate`);
    const item = await j.replan();
    await refusedAtOnce(j, item);
  });
});
