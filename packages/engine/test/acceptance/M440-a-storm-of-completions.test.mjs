// M440 (e), the tick under a storm of completions (M5 slice 37; kernel lane,
// the controlled clock). M5 plan §3.7 M440 (e); D6-X07; D6 K1, N02; D1 §1.5,
// §8.1 steps 1 to 4, §8.3; and the K1 straddle of M12, M15, M18 and M71
// (D6 C.2: "event-storm, expiry and cancellation cases, not only faster
// happy-path ticks"; the driver's ruling Q11, 2026-10-13); SEAM.md §430
//
// The storm: one project's short `verification` items, a new one made
// eligible every quarter of a second for fifteen seconds, each completing at
// once, so completions keep requesting ticks and work is continuously
// eligible. The test requests one tick to begin it and none after: what
// keeps it going is K1's requested tick. Under it, each of the four things
// D1 §8.1 puts before selection is done within the existing latency bound
// (two seconds of real time, SEAM.md §18; three allowed here for the host's
// clock):
//   (e1) every tick runs steps 1 to 4 in their order (`engine.tick.payload.
//        steps` †), each tick yields under a small `tick_budget` (5 s) even
//        while step delays use it up, and another project's eligible work is
//        dispatched during the storm (no starvation);
//   (e2) an overdue lease renewal: a silent role's lease is renewed after
//        each third of `lease_ttl` the clock moves;
//   (e3) an expiry due: a launch stalled before its spawn whose lease the
//        clock jumps past is put through the run-end protocol by a requested
//        tick, with no request from the test;
//   (e4) a cancellation pending: a Stop confirmed ends the run `stopped`;
//   (e5) a recovery step owed: a run whose ending transaction failed once
//        (the `before_event` fault on `run.ended`) is ended by the next tick's
//        recovery, and no run is left unended.
// Durations are monotonic; nothing here allocates or signals anything but
// the engine's own scripted roles.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CONTRACT } from './harness/fixtures.mjs';
import { armFault, releaseBarrier, waitFor } from './harness/engine.mjs';
import { addProject, addWork, advanceClock, requestTick, run as runRow, runsOf, runsOfProject, scriptedEngine, stopRun, waitForRun, workItem } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { changePolicy } from './harness/journal.mjs';
import { maxSeq, nowMs, show, sleep, ticksAfter } from './harness/exec37/pace.mjs';

const LEASE_TTL = CONTRACT.engine.lease_ttl.min;
const TICK_BUDGET = CONTRACT.engine.tick_budget.min;
const BOUND_MS = 3000;
const CONFIG = Object.freeze({ lease_ttl: LEASE_TTL, tick_budget: TICK_BUDGET, tick_step_budget: CONTRACT.engine.tick_step_budget.min, terminate_grace: 1, kill_grace: 1 });
const PREREQUISITES = ['recover', 'journal', 'integrity', 'budgets'];

const runLease = (home, run) => withStore(home, (db) => db.prepare(`SELECT * FROM "leases" WHERE "resource_kind" = 'run' AND "resource_id" = ? ORDER BY rowid DESC LIMIT 1`).get(run));

// The storm on `project`: `seed` items and one tick request, then one new
// item every `everyMs` until `seconds` have passed. Returns a handle whose
// `done` resolves to the items added, each with the monotonic time it was added.
function storm(fx, project, { seconds = 15, everyMs = 250, seed = 4 } = {}) {
  const added = [];
  let stopped = false;
  const done = (async () => {
    for (let i = 0; i < seed; i++) added.push({ id: await addWork(fx.engine, project, 'verification'), at: nowMs() });
    await requestTick(fx.engine, project);
    const until = nowMs() + seconds * 1000;
    while (!stopped && nowMs() < until) {
      await sleep(everyMs);
      added.push({ id: await addWork(fx.engine, project, 'verification'), at: nowMs() });
    }
    return added;
  })();
  return { added, done, stop: () => (stopped = true) };
}

// The storm sustained itself: of the items added more than three seconds
// before its end, at least four in five completed with no request from the
// test after the first.
async function assertSustained(fx, s) {
  const added = await s.done;
  const end = nowMs();
  await sleep(BOUND_MS);
  const due = added.filter((a) => end - a.at > 3000);
  const complete = due.filter((a) => workItem(fx.home, a.id)?.status === 'complete');
  assert.ok(
    due.length >= 10 && complete.length >= 0.8 * due.length,
    `a sustained stream of completions, kept going by requested ticks alone (K1): ${complete.length} of ${due.length} items complete (statuses ${show([...new Set(due.map((a) => workItem(fx.home, a.id)?.status))])})`,
  );
  return added;
}

// The storm's project on a repository whose primary worktree is detached, so
// its policy can change (objection 090), with `budget_run_billable_tokens` at
// its minimum (a tightening): the day budget's reservation of each run under
// way (D1 §13.3; D6 §6.5, a separate bound) then admits every domain slot to
// the storm's one project (objection 091, the driver's ruling: the kernel
// lane tests the real accounting, so the case sets the budget it needs).
async function stormEngine(t, opts = {}) {
  const fx = await scriptedEngine(t, { config: CONFIG, ...opts });
  fx.scripted.defaultScript(script.complete());
  const s = (await addGitProject(fx)).id;
  await changePolicy(fx.engine, s, { budget_run_billable_tokens: CONTRACT.project.budget_run_billable_tokens.min });
  return { fx, s };
}

describe('M440 (e) the tick under a sustained stream of completions', () => {
  test('(e1) every tick runs steps 1 to 4 in order and yields under tick_budget while step delays use it up; another project\'s work is dispatched during the storm', async (t) => {
    const { fx, s } = await stormEngine(t);
    const others = [];
    for (let i = 0; i < 3; i++) others.push((await addProject(fx)).id);
    const seq0 = maxSeq(fx.home);
    const st = storm(fx, s);
    // Track the gaps between ticks while the storm runs (monotonic).
    let last = nowMs();
    let lastSeq = seq0;
    let maxGap = 0;
    const watch = (async () => {
      while (true) {
        const ticks = ticksAfter(fx.home, lastSeq);
        if (ticks.length > 0) {
          const now = nowMs();
          maxGap = Math.max(maxGap, now - last);
          last = now;
          lastSeq = ticks.at(-1).seq;
        }
        if (st.finished) return;
        await sleep(50);
      }
    })();
    await sleep(3000);
    // Use the budget up: each prerequisite step of each other project delayed past its step budget, once.
    for (const p of others) for (const stepName of ['recover', 'journal', 'integrity']) await armFault(fx.engine, { point: 'tick_step', step: stepName, project: p, delay_ms: 2500 });
    const lateItem = await addWork(fx.engine, others[0], 'verification');
    const lateAt = nowMs();
    await assertSustained(fx, st);
    st.finished = true;
    await watch;
    const ticks = ticksAfter(fx.home, seq0);
    for (const e of ticks) {
      const steps = e.payload?.steps;
      assert.ok(Array.isArray(steps), `engine.tick ${e.seq} carries payload.steps † (${show(e.payload)})`);
      const at = PREREQUISITES.map((x) => steps.indexOf(x));
      assert.ok(at.every((i) => i >= 0) && at.every((i, k) => k === 0 || i > at[k - 1]), `tick ${e.seq} ran steps 1 to 4 in order (${show(steps)})`);
    }
    assert.ok(maxGap <= (TICK_BUDGET + 2) * 1000, `each tick yielded under tick_budget (${TICK_BUDGET} s) while requests kept coming: the longest gap between ticks was ${Math.round(maxGap)} ms`);
    const late = runsOf(fx.home, lateItem)[0];
    assert.ok(late, `another project's item made eligible during the storm was dispatched (no starvation; ${Math.round(nowMs() - lateAt)} ms after it was added)`);
  });

  test('(e2) an overdue lease renewal: a silent role\'s lease is renewed within the bound after each third of lease_ttl the clock moves, while the storm runs', async (t) => {
    const { fx, s } = await stormEngine(t);
    const l = (await addProject(fx)).id;
    const item = await addWork(fx.engine, l, 'verification');
    fx.scripted.script(item, [{ steps: [step.hold('gate', { heartbeat_ms: 0 }), step.result()] }]);
    const st = storm(fx, s);
    await fx.scripted.waitForHolding({ work_item: item }, 'gate', { timeoutMs: 10_000 }).catch(() => {});
    const run = runsOf(fx.home, item)[0];
    assert.ok(run, 'the silent role was dispatched by a requested tick (no request from the test after the storm\'s first)');
    const third = Math.floor(LEASE_TTL / 3);
    for (let i = 1; i <= 4; i++) {
      const before = runLease(fx.home, run.id);
      await advanceClock(fx.engine, third);
      const started = nowMs();
      const renewed = await waitFor(() => {
        const l2 = runLease(fx.home, run.id);
        return l2 && l2.renewed_at !== before.renewed_at && Date.parse(l2.renewed_at) > Date.parse(before.renewed_at) ? l2 : undefined;
      }, { timeoutMs: BOUND_MS, what: 'the renewal' }).catch(() => undefined);
      assert.ok(renewed, `step ${i}: the lease renewal due after ${third} s of clock is made within ${BOUND_MS} ms under the storm (${Math.round(nowMs() - started)} ms; ${show(runLease(fx.home, run.id))})`);
    }
    fx.scripted.release(item);
    await waitForRun(fx.home, item, { state: 'ended' });
    assert.equal(runRow(fx.home, run.id).outcome, 'completed', 'its lease never expired: the run completed');
    await assertSustained(fx, st);
  });

  test('(e3) an expiry due: a stalled launch whose lease the clock jumps past is put through the run-end protocol by a requested tick within the bound', async (t) => {
    const { fx, s } = await stormEngine(t, { barriers: ['launch.before_spawn=pause'] });
    const e = (await addProject(fx)).id;
    const item = await addWork(fx.engine, e, 'verification');
    await requestTick(fx.engine, e);
    await fx.engine.waitUntil('barrier:launch.before_spawn');
    const run = await waitForRun(fx.home, item, { state: 'claimed' });
    const st = storm(fx, s);
    await sleep(3000);
    await advanceClock(fx.engine, LEASE_TTL + 5);
    const started = nowMs();
    const begun = await waitFor(() => ['finalizing', 'ended'].includes(runRow(fx.home, run.id).state) || undefined, { timeoutMs: BOUND_MS, what: 'the run-end protocol' }).catch(() => undefined);
    assert.ok(begun, `the expired lease of run ${run.id} was reconciled within ${BOUND_MS} ms by a requested tick (${Math.round(nowMs() - started)} ms; state ${runRow(fx.home, run.id).state})`);
    await releaseBarrier(fx.engine, 'launch.before_spawn');
    await waitForRun(fx.home, item, { state: 'ended' });
    assert.equal(runRow(fx.home, run.id).outcome, 'recovered', 'nothing had decided its outcome: recovered');
    await assertSustained(fx, st);
  });

  test('(e4) a cancellation pending: a Stop confirmed during the storm ends the run stopped within the bound and terminate_grace', async (t) => {
    const { fx, s } = await stormEngine(t);
    const c = (await addProject(fx)).id;
    const item = await addWork(fx.engine, c, 'verification');
    fx.scripted.script(item, [script.hold('gate', { on_term: 'exit' })]);
    const st = storm(fx, s);
    await fx.scripted.waitForHolding({ work_item: item }, 'gate', { timeoutMs: 10_000 }).catch(() => {});
    const run = runsOf(fx.home, item)[0];
    assert.ok(run, 'the role was dispatched by a requested tick');
    await sleep(2000);
    await stopRun(fx.engine, c, run.id);
    const started = nowMs();
    const ended = await waitFor(() => runRow(fx.home, run.id).state === 'ended' || undefined, { timeoutMs: BOUND_MS + CONFIG.terminate_grace * 1000 + 1000, what: 'the stopped run to end' }).catch(() => undefined);
    assert.ok(ended, `the Stop was acted on under the storm (${Math.round(nowMs() - started)} ms; state ${runRow(fx.home, run.id).state})`);
    assert.equal(runRow(fx.home, run.id).outcome, 'stopped');
    assert.equal(workItem(fx.home, item).status, 'held', 'the stopped work is held');
    await assertSustained(fx, st);
  });

  test('(e5) a recovery step owed: a run whose ending transaction fails once is ended by a later tick\'s recovery within the bound; no run is left unended or ended twice', async (t) => {
    const { fx, s } = await stormEngine(t);
    const st = storm(fx, s);
    await sleep(3000);
    await armFault(fx.engine, { point: 'before_event', event_type: 'run.ended' });
    // The longest any run of the storm is seen `finalizing` (monotonic, sampled).
    const seenAt = new Map();
    let longest = 0;
    let finished = false;
    const watch = (async () => {
      while (!finished) {
        const now = nowMs();
        const rows = runsOfProject(fx.home, s);
        for (const r of rows) {
          if (r.state === 'finalizing') {
            if (!seenAt.has(r.id)) seenAt.set(r.id, now);
            longest = Math.max(longest, now - seenAt.get(r.id));
          } else if (seenAt.has(r.id) && r.state === 'ended') seenAt.delete(r.id);
        }
        await sleep(50);
      }
    })();
    const added = await assertSustained(fx, st);
    finished = true;
    await watch;
    assert.ok(longest <= BOUND_MS, `no run waited for its recovery longer than the bound: the longest seen finalizing was ${Math.round(longest)} ms`);
    const runs = runsOfProject(fx.home, s);
    const unended = runs.filter((r) => r.state !== 'ended');
    assert.deepEqual(unended.map((r) => [r.id, r.state]), [], 'no run of the storm is left unended');
    withStore(fx.home, (db) => {
      for (const r of runs) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM "events" WHERE "type" = 'run.ended' AND json_extract("subject", '$.run') = ?`).get(r.id).n, 1, `run ${r.id} ended once`);
    });
    assert.ok(added.every((a) => runsOf(fx.home, a.id).length <= 1), 'no item was bought twice');
  });
});
