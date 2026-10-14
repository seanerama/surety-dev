// M440 (a) to (d), the event-driven tick (M5 slice 37; kernel lane, the
// controlled clock). M5 plan §3.7 M440; D6-X07; D6 K1, §7.2; D1 §1.5, §8.1;
// N02; the driver's rulings Q12 and Q13 of 2026-10-13; SEAM.md §441
//   (a) a run's end, a result's recording, an operation's finalization, a
//       decision's answer and work becoming eligible each request a tick
//       (`scheduler.tick_requested` † with `payload.cause` `run_ended`,
//       `result_recorded`, `operation_finalized`, `decision_answered`,
//       `work_eligible`; the route's own request is `api`), and a tick
//       follows within `tick_budget` with no request from the test;
//   (b) several requests made while a tick runs (held at the barrier
//       `scheduler.tick_running` †, after the prerequisite steps and before
//       select) make exactly one following tick and never a second tick at
//       once: `engine.tick.payload.requests` † counts what it coalesced; and
//       (the K1 straddle of M26 and M33, D6 C.2) a journal finalizer held
//       while requests keep coming still finalizes its operation once;
//   (c) with no request, the tick follows `tick_interval` on the engine's
//       clock (Q12): `tick_interval` 600, a clock advance of 300 s makes no
//       tick, a further 305 s makes one within two seconds;
//   (d) every tick runs D1 §8.1's steps 1 to 4 in their order before it
//       selects: `engine.tick.payload.steps` † names the steps it ran.
// Ticks the tests request are used only to set a case up; after the act a
// case observes, no test requests a tick. Durations are monotonic.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { addGitProject, addItem, permittedEdit, roleThatHolds } from './harness/gitruns.mjs';
import { armBarrier, changePolicy, journalBarrier, operationsOf, revisionsOf } from './harness/journal.mjs';
import { eventsAbout } from './harness/invariants.mjs';
import { addProject, addWork, advanceClock, answerDecision, decisionsAbout, driveTo, requestTick, resumeWork, runsOf, scriptedEngine, tick, tickOnce, waitForRun, waitForWork, workItem } from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { armFault, waitFor, releaseBarrier, within } from './harness/engine.mjs';
import { heldGitWrites } from './harness/held-writes.mjs';
import { commitOnRef } from './harness/repos.mjs';
import { executionsOf } from './harness/checks/fixtures.mjs';
import { discoveredProject, nominateStage, recordExit } from './harness/checks/selection.mjs';
import { barrierWaiting } from './harness/session-lane.mjs';
import { TICK_BUDGET_S, maxSeq, nowMs, requestedAfter, requestsAfter, show, sleep, tickAfter, ticksAfter } from './harness/exec37/pace.mjs';

const TICK_RUNNING = 'scheduler.tick_running';
const PREREQUISITES = ['recover', 'journal', 'integrity', 'budgets'];

// The request and the tick that follows it, with no request from the test.
async function requestedThenTicked(fx, seq0, startedMs, cause, subject) {
  const request = await requestedAfter(fx.home, seq0, cause, { subject });
  const { event, elapsedMs } = await tickAfter(fx.home, request.seq, { startedMs, what: `the tick ${cause} requested` });
  assert.ok(elapsedMs <= TICK_BUDGET_S * 1000 + 1000, `the tick follows within tick_budget (${TICK_BUDGET_S} s) of the ${cause}: seen after ${Math.round(elapsedMs)} ms`);
  return { request, tick: event };
}

describe('M440 (a) each transition of K1 requests a tick, and the tick follows within tick_budget', () => {
  test('(a) a run\'s end: scheduler.tick_requested with cause run_ended naming the run, then a tick, with no request from the test', async (t) => {
    const fx = await scriptedEngine(t);
    const p = (await addProject(fx)).id;
    const item = await addWork(fx.engine, p, 'verification');
    fx.scripted.script(item, [script.holdThenComplete('gate')]);
    await tick(fx.engine, p);
    await fx.scripted.waitForHolding({ work_item: item });
    const run = await waitForRun(fx.home, item);
    const seq0 = maxSeq(fx.home);
    const started = nowMs();
    fx.scripted.release(item);
    await waitForRun(fx.home, item, { state: 'ended' });
    await requestedThenTicked(fx, seq0, started, 'run_ended', { run: run.id });
  });

  test('(a) an operation\'s finalization: the integration of a fix requests a tick with cause operation_finalized naming the operation', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThatHolds([permittedEdit()])]);
    await tick(fx.engine, project.id);
    await fx.scripted.waitForHolding({ work_item: item });
    const seq0 = maxSeq(fx.home);
    const started = nowMs();
    fx.scripted.release(item);
    await waitForWork(fx.home, item, ['integrated', 'complete']);
    const finalized = await waitFor(() => operationsOf(fx.home, { project: project.id }).filter((op) => op.finalized), { what: 'the integration\'s operations to be finalized' });
    const request = await requestedAfter(fx.home, seq0, 'operation_finalized');
    assert.ok(
      finalized.some((op) => op.id === request.subject?.operation),
      `the request names a finalized operation of the project (${show(request.subject)}; finalized ${show(finalized.map((op) => op.id))})`,
    );
    const { elapsedMs } = await tickAfter(fx.home, request.seq, { startedMs: started, what: 'the tick the finalization requested' });
    assert.ok(elapsedMs <= TICK_BUDGET_S * 1000 + 1000, `within tick_budget: ${Math.round(elapsedMs)} ms`);
  });

  test('(a) a result\'s recording: a check result recorded through the scripted boundary requests a tick with cause result_recorded', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await discoveredProject(fx, ['sm']);
    const c = await nominateStage(fx, p, ['sm']);
    const [x] = executionsOf(fx.home, c.id).filter((e) => e.key === 'sm');
    assert.ok(x, 'the fixture is live: the nomination registered sm');
    const seq0 = maxSeq(fx.home);
    const started = nowMs();
    const result = await recordExit(fx.engine, x.id, 0);
    const request = await requestedAfter(fx.home, seq0, 'result_recorded');
    assert.ok(request.subject?.check_result === result.id || request.subject?.check_execution === x.id, `the request names the result or its execution (${show(request.subject)})`);
    const { elapsedMs } = await tickAfter(fx.home, request.seq, { startedMs: started, what: 'the tick the result requested' });
    assert.ok(elapsedMs <= TICK_BUDGET_S * 1000 + 1000, `within tick_budget: ${Math.round(elapsedMs)} ms`);
  });

  test('(a) a decision\'s answer: a parked item\'s blocker answered requests a tick with cause decision_answered naming the decision', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    await changePolicy(fx.engine, project.id, { repair_attempts_max: 0 });
    const item = await addWork(fx.engine, project.id, 'verification');
    fx.scripted.script(item, [script.crash(3)]);
    await tick(fx.engine, project.id);
    await waitForWork(fx.home, item, 'parked');
    const blocker = await waitFor(() => decisionsAbout(fx.home, item, 'blocker').find((d) => d.status === 'open'), { what: 'the blocker of the parked item' });
    const seq0 = maxSeq(fx.home);
    const started = nowMs();
    await answerDecision(fx.engine, project.id, blocker.id, 'cancel');
    await requestedThenTicked(fx, seq0, started, 'decision_answered', { decision: blocker.id });
  });

  test('(a) work becoming eligible: a held item resumed requests a tick with cause work_eligible, and is dispatched by it', async (t) => {
    const fx = await scriptedEngine(t);
    const p = (await addProject(fx)).id;
    fx.scripted.defaultScript(script.complete());
    const item = await addWork(fx.engine, p, 'verification');
    await driveTo(fx.engine, item, ['claimed', 'held']);
    await tick(fx.engine, p);
    const seq0 = maxSeq(fx.home);
    const started = nowMs();
    await resumeWork(fx.engine, p, item);
    await requestedThenTicked(fx, seq0, started, 'work_eligible', { work_item: item });
    await waitForRun(fx.home, item, { timeoutMs: 10_000 });
    assert.equal(runsOf(fx.home, item).length, 1, 'the resumed item was dispatched by the requested tick, with no request from the test');
  });
});

describe('M440 (b) requests coalesce and never re-enter a running tick', () => {
  test('(b) five requests through the route and one by a transition while a tick is held: no tick ends while it is held, exactly one follows, and it counts the requests it coalesced', async (t) => {
    const fx = await scriptedEngine(t);
    const p = (await addProject(fx)).id;
    // The item made eligible below holds once dispatched, so its run ends nothing during the case.
    fx.scripted.defaultScript(script.hold('gate'));
    await tickOnce(fx.engine, p);
    await armBarrier(fx.engine, TICK_RUNNING, 'pause');
    const seq0 = maxSeq(fx.home);
    await requestTick(fx.engine, p);
    await waitFor(() => barrierWaiting(fx, TICK_RUNNING), { what: `a tick to wait at ${TICK_RUNNING} †` });
    // While the tick is held: the API answers; five requests, and work becoming eligible.
    for (let i = 0; i < 5; i++) await requestTick(fx.engine, p);
    const item = await addWork(fx.engine, p, 'verification');
    await sleep(1500);
    assert.deepEqual(ticksAfter(fx.home, seq0), [], 'no tick ended while one is held: the requests did not run a second tick beside it');
    await releaseBarrier(fx.engine, TICK_RUNNING);
    await waitFor(() => ticksAfter(fx.home, seq0).length >= 2, { timeoutMs: 10_000, what: 'the held tick and the one following it' }).catch(() => {});
    await sleep(3000);
    const ticks = ticksAfter(fx.home, seq0);
    assert.equal(ticks.length, 2, `the held tick and exactly one following tick (${show(ticks.map((e) => ({ seq: e.seq, payload: e.payload })))})`);
    const coalesced = ticks[1].payload?.requests;
    assert.ok(Number.isInteger(coalesced) && coalesced >= 6, `the following tick's payload.requests † counts the six requests it coalesced (read ${show(coalesced)})`);
    assert.ok(requestsAfter(fx.home, seq0).filter((e) => e.payload?.cause === 'api').length >= 6, 'each request through the route is recorded with cause api');
    assert.equal(runsOf(fx.home, item).length, 1, 'the following tick dispatched the eligible item once');
    fx.scripted.release('all');
  });

  test('(b) the K1 straddle of M26 and M33: a journal finalizer held while ten requests and the run\'s own requests arrive finalizes its operation once', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [{ steps: [permittedEdit(), { result: { status: 'completed', summary: 'scripted role finished' } }] }]);
    const barrier = journalBarrier('ref_update', 'probe_confirmed');
    await armBarrier(fx.engine, barrier, 'pause');
    await requestTick(fx.engine, project.id);
    await waitFor(() => barrierWaiting(fx, barrier), { what: `the integration to wait before its finalizer (${barrier})` });
    for (let i = 0; i < 10; i++) await requestTick(fx.engine, project.id);
    await sleep(1000);
    await releaseBarrier(fx.engine, barrier);
    await waitForWork(fx.home, item, ['integrated', 'verifying', 'complete']);
    for (let i = 0; i < 3; i++) await requestTick(fx.engine, project.id);
    await sleep(1500);
    const [run] = runsOf(fx.home, item);
    for (const op of operationsOf(fx.home, { project: project.id })) {
      const finals = op.events.filter((e) => e.kind === 'finalized');
      assert.ok(finals.length <= 1, `operation ${op.id} (${op.journal_kind}) finalized at most once (${show(op.events.map((e) => e.kind))})`);
      assert.ok(op.finalized, `operation ${op.id} finalized`);
    }
    assert.equal(revisionsOf(fx.home, { run: run.id }).length, 1, 'one revision for the run');
    withStore(fx.home, (db) => assert.equal(eventsAbout(db, 'work_item', item, 'work.integrated').length, 1, `integrated once (status ${workItem(fx.home, item).status})`));
  });
});

describe('M440 (c) with no request, the tick follows tick_interval on the engine\'s clock', () => {
  test('(c) tick_interval 600: 300 s on the clock makes no tick; 305 s more makes one within two seconds', async (t) => {
    const fx = await scriptedEngine(t, { config: { tick_interval: 600 } });
    const p = (await addProject(fx)).id;
    await tickOnce(fx.engine, p);
    const seq0 = maxSeq(fx.home);
    await advanceClock(fx.engine, 300);
    await sleep(4000);
    assert.deepEqual(ticksAfter(fx.home, seq0).map((e) => e.seq), [], 'half an interval on the clock: no tick');
    const seq1 = maxSeq(fx.home);
    await advanceClock(fx.engine, 305);
    const started = nowMs();
    const seen = await waitFor(() => ticksAfter(fx.home, seq1)[0], { timeoutMs: 3000, what: 'the interval tick' }).catch(() => undefined);
    assert.ok(seen, `the interval was reached on the engine's clock (Q12): a tick within two seconds of the advance (none seen after ${Math.round(nowMs() - started)} ms)`);
    assert.ok(!requestsAfter(fx.home, seq1).some((e) => e.payload?.cause === 'api'), 'the test requested nothing');
  });
});

describe('M440 (d) D1 §8.1 steps 1 to 4 are never skipped', () => {
  test('(d) every tick, requested by the route or by a run\'s end, names recover, journal, integrity and budgets in that order before select (engine.tick.payload.steps †)', async (t) => {
    const fx = await scriptedEngine(t);
    const p = (await addProject(fx)).id;
    fx.scripted.defaultScript(script.complete());
    const seq0 = maxSeq(fx.home);
    const item = await addWork(fx.engine, p, 'verification');
    await tick(fx.engine, p);
    await waitForWork(fx.home, item, 'complete');
    await requestedAfter(fx.home, seq0, 'run_ended').catch(() => null);
    await sleep(1500);
    const ticks = ticksAfter(fx.home, seq0);
    assert.ok(ticks.length >= 2, 'the fixture is live: at least two ticks');
    for (const e of ticks) {
      const steps = e.payload?.steps;
      assert.ok(Array.isArray(steps), `engine.tick ${e.seq} carries payload.steps † (payload ${show(e.payload)})`);
      const at = PREREQUISITES.map((s) => steps.indexOf(s));
      assert.ok(at.every((i) => i >= 0), `tick ${e.seq} ran each of ${PREREQUISITES.join(', ')} (${show(steps)})`);
      assert.ok(at.every((i, k) => k === 0 || i > at[k - 1]), `in D1 §8.1's order (${show(steps)})`);
      assert.ok(steps.indexOf('select') > at[3], `before select (${show(steps)})`);
    }
    const requested = requestsAfter(fx.home, seq0).filter((e) => e.payload?.cause === 'run_ended');
    assert.ok(requested.length >= 1 && ticks.some((e) => e.seq > requested[0].seq), 'a tick requested by the run\'s end is among them');
  });
});

// The slice-37 review (SEAM.md §449): D1 §8.1's order read from what each
// step records, not from the engine's own list. Three projects, each owing
// one prerequisite step, their conditions made while the scheduler is held
// at `scheduler.tick_running` (§441), so that one tick meets all three:
//   - recover (step 1): a run whose end failed once (the `before_event` fault
//     on `run.ended`) is ended by the recovery's retry: its `run.ended`;
//   - journal (step 2): a commit write held past `git_deadline`, killed and
//     ambiguous, is probed: its operation's `git.journal_*` and `operation.*`
//     events;
//   - integrity (step 3): an integration branch moved by hand is observed:
//     its `repo.out_of_band`.
// In that tick their events come in that order, before its `engine.tick`.
// Step 4, the budgets, records no event of its own: its place is not read here.
describe('M440 (d) D1 §8.1\'s order, read from what the steps record', () => {
  test('(d) in one tick: the recovery\'s run end, then the journal\'s probe, then the integrity observation, each from its own project, before the tick ends', async (t) => {
    const writes = heldGitWrites(t);
    const fx = await scriptedEngine(t, { env: writes.env, config: { git_deadline: 2 } });
    fx.scripted.defaultScript(script.complete());
    // A: a role holding, whose end will fail once.
    const a = (await addProject(fx)).id;
    const held = await addWork(fx.engine, a, 'verification');
    fx.scripted.script(held, [script.holdThenComplete('gate')]);
    await tick(fx.engine, a);
    await fx.scripted.waitForHolding({ work_item: held });
    // B: a fix whose commit write is held.
    const b = await addGitProject(fx);
    const fix = await addItem(fx, b.id, 'fix');
    fx.scripted.script(fix, [roleThatHolds([permittedEdit()])]);
    writes.holdCommit();
    await tick(fx.engine, b.id);
    await fx.scripted.waitForHolding({ work_item: fix });
    // C: a project whose branch will move by hand.
    const c = await addGitProject(fx);

    // The scheduler held; the three conditions made.
    await armBarrier(fx.engine, 'scheduler.tick_running', 'pause');
    await requestTick(fx.engine, a);
    await waitFor(() => barrierWaiting(fx, 'scheduler.tick_running'), { what: 'a tick held at scheduler.tick_running' });
    fx.scripted.release(fix, 'gate');
    const ambiguous = await waitFor(() => operationsOf(fx.home, { project: b.id }).find((op) => op.status === 'ambiguous'), { timeoutMs: 30_000, what: 'B\'s commit write killed at its deadline and ambiguous' });
    await armFault(fx.engine, { point: 'before_event', event_type: 'run.ended' });
    fx.scripted.release(held, 'gate');
    const [aRun] = runsOf(fx.home, held);
    await waitFor(() => withStore(fx.home, (db) => db.prepare(`SELECT 1 FROM "runs" WHERE "id" = ? AND "state" = 'finalizing'`).get(aRun.id)) ?? undefined, { what: 'A\'s run end decided and its ending failed once' });
    commitOnRef(c.repo.path, c.repo.ref, { 'stray.txt': 'moved by hand\n' });
    const heldTicks = ticksAfter(fx.home, 0).length;
    const from = maxSeq(fx.home);
    await releaseBarrier(fx.engine, 'scheduler.tick_running');

    // The first tick to begin after the release: the one whose steps meet all three.
    const after = await waitFor(() => (ticksAfter(fx.home, from).length >= 2 ? ticksAfter(fx.home, from) : undefined), { timeoutMs: 30_000, what: 'the held tick and the next to end' });
    const [heldEnd, next] = after;
    const ev = (type, pred) => withStore(fx.home, (db) => db.prepare('SELECT "seq", "subject", "payload" FROM "events" WHERE "type" = ? AND "seq" > ? ORDER BY "seq"').all(type, heldEnd.seq)).map((e) => ({ ...e, subject: JSON.parse(e.subject ?? '{}') })).find(pred);
    const recovered = ev('run.ended', (e) => e.subject.run === aRun.id);
    const probed = withStore(fx.home, (db) => db.prepare(`SELECT "seq", "type" FROM "events" WHERE ("type" LIKE 'git.journal_%' OR "type" LIKE 'operation.%') AND json_extract("subject", '$.operation') = ? AND "seq" > ? ORDER BY "seq"`).all(ambiguous.id, heldEnd.seq))[0];
    const observed = ev('repo.out_of_band', (e) => e.subject.project === c.id);
    const found = { recovered: recovered?.seq ?? null, probed: probed?.seq ?? null, observed: observed?.seq ?? null, tick_end: next.seq, held_tick_end: heldEnd.seq, ticks_before: heldTicks };
    assert.ok(recovered && probed && observed, `the fixture is live: each step left its record after the held tick (${JSON.stringify(found)})`);
    assert.ok(found.recovered < next.seq && found.probed < next.seq && found.observed < next.seq, `all three in the one tick after the hold, before its engine.tick (${JSON.stringify(found)})`);
    assert.ok(found.recovered < found.probed && found.probed < found.observed, `in D1 §8.1's order: recover, journal, integrity (${JSON.stringify(found)})`);
  });
});

// The slice-37 review's S2 (the driver's ruling, 2026-10-14; SEAM.md §449): a
// restart with eligible work. No tick, requested or interval, runs before the
// scheduler starts, after the lift to full mode; nothing is dispatched before
// `engine.started`; requests made during the start (the recovery's run end,
// work eligible) coalesce into the first tick.
describe('M440 (S2) a restart with eligible work', () => {
  test('(S2) no tick and no dispatch before engine.started; the start\'s requests coalesce into the first tick after it', async (t) => {
    const killAt = journalBarrier('ref_update', 'probe_confirmed');
    const fx = await scriptedEngine(t);
    fx.scripted.defaultScript(script.complete());
    const project = await addGitProject(fx);
    const p = project.id;
    // A fix whose integration the engine is killed in, after its branch update
    // is confirmed and before it is finalized: the restart's own recovery
    // finalizes it, a transition that requests a tick (K1) during the start.
    const first = await addItem(fx, p, 'fix');
    fx.scripted.script(first, [roleThatHolds([permittedEdit()])]);
    await tick(fx.engine, p);
    await fx.scripted.waitForHolding({ work_item: first });
    // Eligible work never dispatched before the kill: made while a tick is held.
    await armBarrier(fx.engine, 'scheduler.tick_running', 'pause');
    await requestTick(fx.engine, p);
    await waitFor(() => barrierWaiting(fx, 'scheduler.tick_running'), { what: 'a tick held at scheduler.tick_running' });
    const second = await addWork(fx.engine, p, 'review');
    assert.equal(runsOf(fx.home, second).length, 0, 'the fixture is live: the second item is eligible and not dispatched');
    await armBarrier(fx.engine, killAt, 'kill');
    const dead = fx.engine;
    fx.scripted.release(first, 'gate');
    assert.deepEqual(await within(dead.exited, 30_000), { code: null, signal: 'SIGKILL' }, `the engine kills itself at ${killAt}`);
    const from = maxSeq(fx.home);

    // Restarted, with ticks also requested through the route all through the
    // start (from the moment it listens until engine.started is recorded).
    const engine = await fx.start({ until: 'listening' });
    const startedYet = () => withStore(fx.home, (db) => db.prepare(`SELECT 1 FROM "events" WHERE "type" = 'engine.started' AND "seq" > ?`).get(from)) !== undefined;
    while (!startedYet()) {
      await engine.post(`/v1/projects/${p}/tick`, {}).catch(() => null);
      await sleep(20);
    }
    await waitForWork(fx.home, second, 'complete', { timeoutMs: 60_000 });
    const after = (type) => withStore(fx.home, (db) => db.prepare('SELECT "seq", "subject", "payload" FROM "events" WHERE "type" = ? AND "seq" > ? ORDER BY "seq"').all(type, from)).map((e) => ({ ...e, subject: JSON.parse(e.subject ?? '{}'), payload: JSON.parse(e.payload ?? 'null') }));
    const [started] = after('engine.started');
    assert.ok(started, 'the restart recorded engine.started');
    const requestedBefore = after('scheduler.tick_requested').filter((e) => e.seq < started.seq);
    assert.ok(requestedBefore.length >= 1, `the fixture is live: the start's recovery requested a tick before engine.started (${JSON.stringify(after('scheduler.tick_requested').map((e) => [e.seq, e.payload?.cause]))}, started ${started.seq})`);
    const ticksBefore = after('engine.tick').filter((e) => e.seq < started.seq);
    assert.deepEqual(ticksBefore.map((e) => e.seq), [], `no tick before the scheduler starts (engine.started at ${started.seq})`);
    const createdBefore = after('run.created').filter((e) => e.seq < started.seq);
    assert.deepEqual(createdBefore.map((e) => e.subject.run), [], 'nothing dispatched before engine.started');
    const [firstTick] = after('engine.tick').filter((e) => e.seq > started.seq);
    assert.ok(firstTick, 'a tick after the start');
    assert.ok(Number.isInteger(firstTick.payload?.requests) && firstTick.payload.requests >= requestedBefore.length, `the start's requests (${requestedBefore.length}) coalesce into the first tick (its requests ${JSON.stringify(firstTick.payload)})`);
    const [secondRun] = runsOf(fx.home, second);
    const created = after('run.created').find((e) => e.subject.run === secondRun.id);
    assert.ok(created.seq > started.seq, 'the eligible work is dispatched after engine.started');
  });
});
