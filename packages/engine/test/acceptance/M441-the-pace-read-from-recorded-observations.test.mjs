// M441 (b), (d), (f), (g), the pace read from recorded observations alone
// (M5 slice 37; kernel lane, the controlled clock). M5 plan §3.7 M441;
// D6-M01, D6-M02; D6 §7.6, A.3; N01; D1 §12.2; the driver's ruling Q3 of
// 2026-10-13 (hold intervals as `work.hold_began` / `work.hold_ended` † and
// `work_items.held_intervals` †; D1's status event `work.held` unchanged);
// SEAM.md §355 and §442
//   (b) a run with no `launched` observation (refused before launch): its
//       launch and invocation elapsed time `unknown`, never zero; a stage
//       with no evaluation: its intervals `unknown`; a run interrupted by an
//       engine restart between `launched` and its terminal observation: its
//       invocation elapsed time `unknown` (or bounded by the observations
//       that exist), never computed from the present clock: the same after
//       600 s more on the clock;
//   (d) the human wait of a stage (D6-M02): the union of the open intervals
//       of the decisions whose `blocked_while_open` holds the stage's items
//       (its `stage_build` item and every item whose `subject.stage` is the
//       stage), within the stage's lifetime (its registration to `verified`):
//       a measured zero with nothing routed; one decision's open time; two
//       overlapping decisions counted once, `decision_hours` † their sum in
//       hours; a decision partly after `verified` counting its inside part;
//       an open decision making it `unknown`;
//   (f) across an engine restart with a settings change (engine
//       `tick_interval`, project `role_memory_max`) and a domain removed
//       between the two reads: the historical run reported with the host
//       observation recorded for its incarnation (`runs[].host_observation`
//       †, `hosts[]` † every observation of the project), its figures
//       unchanged; the removed domain's peak `unknown`, never a value;
//   (g) idle time is the elapsed time of hold intervals by reason, not a
//       count of ticks: a one-shot held `session_busy` while a session is
//       open, and an item held `depends_on`, each across 900 s and 600 s of
//       clock and many ticks.
// Expectations come from the clock's advances with a tolerance of five
// seconds (the host's clock steps back about a second every 31 s), plus the
// real time the test measured on the monotonic clock where it adds to an
// interval; never from the order of wall-clock timestamps.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { stageGate } from './harness/gates.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { changePolicy, eventsOfType } from './harness/journal.mjs';
import { readPace } from './harness/journey/drive.mjs';
import { sessionProject } from './harness/session-lane.mjs';
import { closeSession, openSession } from './harness/sessions.mjs';
import {
  addProject,
  addWork,
  advanceClock,
  answerDecision,
  decisionsAbout,
  driveTo,
  getRow,
  installPlan,
  resumeWork,
  runsOf,
  scriptedEngine,
  tick,
  tickUntil,
  waitForRun,
  waitForWork,
} from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';
import { waitFor } from './harness/engine.mjs';
import { setEngineConfig } from './harness/checks/classifier.mjs';
import { executionsOf } from './harness/checks/fixtures.mjs';
import { nominateStage, recordExit } from './harness/checks/selection.mjs';
import { PARK_ON_REFUSAL, realBackendProject } from './harness/trust.mjs';
import { VERIFIABLE_KEYS, holdEvents, holdIntervals, isUnknown, near, nowMs, show, sleep, verifiableProject } from './harness/exec37/pace.mjs';

const GIB = 1024 * 1024 * 1024;
const TOL = 5;
const hours = (s) => s / 3600;

const openBlocker = (fx, item) => waitFor(() => decisionsAbout(fx.home, item, 'blocker').find((d) => d.status === 'open'), { what: `the blocker of ${item}` });

// A fix item of `stage` (subject.stage) whose run fails, parked at once
// (repair_attempts_max 0): its blocker holds it. Returns {item, blocker}.
async function parkedFix(fx, project, stage) {
  const item = await addWork(fx.engine, project, 'fix', { subject: { stage } });
  fx.scripted.script(item, [script.crash(3)]);
  await tickUntil(fx.engine, project, () => getRow(fx.home, 'work_items', item)?.status === 'parked' || undefined, { max: 6, what: `the fix ${item} to be parked` });
  return { item, blocker: await openBlocker(fx, item) };
}

const stageOf = (pace, id) => pace.stages.find((s) => s.id === id);
const stageStatus = (fx, id) => getRow(fx.home, 'stages', id)?.status;

// The stage verified through the engine: the queued check recorded passed,
// the Verifier's run (scripted to complete) and the stage gate, ticking until
// the stage is `verified`.
async function verifyStage(fx, p, c) {
  for (const x of executionsOf(fx.home, c.id).filter((e) => e.status === 'queued')) await recordExit(fx.engine, x.id, 0);
  await tickUntil(
    fx.engine,
    p.id,
    async () => {
      await stageGate(fx, { project: p, stage: p.stage.id }, c).catch(() => null);
      return stageStatus(fx, p.stage.id) === 'verified' || undefined;
    },
    { max: 8, what: 'the stage to be verified' },
  );
}

describe('M441 (b) a figure whose observation was not recorded is unknown, never zero', () => {
  test('(b) a run refused before launch: no launched observation, so launched_at and invocation_elapsed are unknown', async (t) => {
    const { fx, project } = await realBackendProject(t, { policy: PARK_ON_REFUSAL });
    const item = await addWork(fx.engine, project, 'verification');
    await tick(fx.engine, project);
    const run = await waitForRun(fx.home, item, { state: 'ended' });
    assert.equal(run.outcome, 'refused', 'the fixture is live: refused before launch');
    const f = (await readPace(fx, project)).runs.find((r) => r.id === run.id);
    assert.ok(f, 'the refused run is in the read');
    assert.ok(isUnknown(f.launched_at), `launched_at † unknown (${show(f.launched_at)})`);
    assert.ok(isUnknown(f.invocation_elapsed), `invocation_elapsed † unknown, never zero (${show(f.invocation_elapsed)})`);
  });

  test('(b) a stage with no evaluation: its eligibility, evaluation and verification intervals are unknown', async (t) => {
    const fx = await scriptedEngine(t);
    const p = (await addProject(fx)).id;
    const plan = await installPlan(fx.engine, p, [{ number: 1, goal: 'a stage never built' }]);
    const f = stageOf(await readPace(fx, p), plan.stages[0].id);
    assert.ok(f, 'the stage is in the read');
    for (const key of ['eligible_to_integrated', 'integrated_to_first_evaluation', 'to_verified']) assert.ok(isUnknown(f[key]), `${key} † unknown, never zero (${show(f[key])})`);
  });

  test('(b) a run interrupted by a restart between launched and its terminal observation: invocation_elapsed unknown or bounded, never computed from the present clock', async (t) => {
    const fx = await scriptedEngine(t);
    const p = (await addProject(fx)).id;
    const item = await addWork(fx.engine, p, 'verification');
    fx.scripted.script(item, [script.hold('gate')]);
    await tick(fx.engine, p);
    await fx.scripted.waitForHolding({ work_item: item });
    const run = await waitForRun(fx.home, item, { state: 'executing' });
    await fx.engine.kill();
    await fx.start();
    await waitForRun(fx.home, item, { state: 'ended' });
    const first = (await readPace(fx, p)).runs.find((r) => r.id === run.id);
    assert.ok(first && typeof first.invocation_elapsed !== 'number', `the interval is not a measured value (${show(first?.invocation_elapsed)})`);
    assert.ok(isUnknown(first.invocation_elapsed), `invocation_elapsed † unknown, or unknown with the bound the observations give (${show(first.invocation_elapsed)})`);
    await advanceClock(fx.engine, 600);
    await sleep(1000);
    const later = (await readPace(fx, p)).runs.find((r) => r.id === run.id);
    assert.deepEqual(later.invocation_elapsed, first.invocation_elapsed, 'the same 600 s later on the clock: never computed from the present');
  });
});

describe('M441 (d) the human wait of a stage (D6-M02)', () => {
  test('(d) a measured zero: a stage verified with nothing routed shows human_wait 0 and decision_hours 0, not unknown', async (t) => {
    const fx = await scriptedEngine(t);
    fx.scripted.defaultScript(script.complete());
    const p = await verifiableProject(fx);
    const c = await nominateStage(fx, p, VERIFIABLE_KEYS);
    await verifyStage(fx, p, c);
    const f = stageOf(await readPace(fx, p.id), p.stage.id);
    assert.equal(f.status, 'verified', 'the fixture is live: the stage is verified');
    assert.equal(f.human_wait, 0, `a measured zero (${show(f.human_wait)})`);
    assert.equal(f.decision_hours, 0, `decision_hours † zero (${show(f.decision_hours)})`);
  });

  test('(d) one decision: its open time; then two overlapping decisions on two items of the stage counted once, decision_hours their sum', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    await changePolicy(fx.engine, project.id, { repair_attempts_max: 0 });
    const plan = await installPlan(fx.engine, project.id, [{ number: 1, goal: 'a stage whose Builder fails' }]);
    const stage = plan.stages[0];
    fx.scripted.script(stage.work_item, [script.crash(3), script.hold('gate')]);
    await tick(fx.engine, project.id);
    await waitForWork(fx.home, stage.work_item, 'parked');
    const a = await openBlocker(fx, stage.work_item);
    // T0: A raised. T0+1800: B raised on a fix of the stage. T0+3600: A answered. T0+5400: B answered.
    await advanceClock(fx.engine, 1800);
    const { blocker: b } = await parkedFix(fx, project.id, stage.id);
    await advanceClock(fx.engine, 1800);
    await answerDecision(fx.engine, project.id, a.id, 'retry');
    const one = stageOf(await readPace(fx, project.id), stage.id);
    await advanceClock(fx.engine, 1800);
    await answerDecision(fx.engine, project.id, b.id, 'cancel');
    const two = stageOf(await readPace(fx, project.id), stage.id);
    // With A answered and B open, the figure has a missing endpoint.
    assert.ok(isUnknown(one.human_wait), `with one decision still open the wait is unknown (${show(one.human_wait)})`);
    assert.ok(near(two.human_wait, 5400, TOL), `the union of [T0, T0+3600] and [T0+1800, T0+5400] is 5400 s, the overlap counted once (read ${show(two.human_wait)})`);
    assert.ok(near(two.decision_hours, hours(7200), hours(2 * TOL)), `decision_hours † the sum, 2 h (read ${show(two.decision_hours)})`);
  });

  test('(d) one decision alone: its open time is the stage\'s wait', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    await changePolicy(fx.engine, project.id, { repair_attempts_max: 0 });
    const plan = await installPlan(fx.engine, project.id, [{ number: 1, goal: 'a stage whose Builder fails once' }]);
    const stage = plan.stages[0];
    fx.scripted.script(stage.work_item, [script.crash(3), script.hold('gate')]);
    await tick(fx.engine, project.id);
    await waitForWork(fx.home, stage.work_item, 'parked');
    const a = await openBlocker(fx, stage.work_item);
    await advanceClock(fx.engine, 1800);
    await answerDecision(fx.engine, project.id, a.id, 'retry');
    const f = stageOf(await readPace(fx, project.id), stage.id);
    assert.ok(near(f.human_wait, 1800, TOL), `the decision's open time, 1800 s (read ${show(f.human_wait)})`);
    assert.ok(near(f.decision_hours, hours(1800), hours(TOL)), `decision_hours † 0.5 h (read ${show(f.decision_hours)})`);
  });

  test('(d) a decision partly after the stage is verified counts its inside part; an open one makes the figure unknown', async (t) => {
    const fx = await scriptedEngine(t);
    fx.scripted.defaultScript(script.complete());
    const p = await verifiableProject(fx, { policy: { repair_attempts_max: 0 } });
    const c = await nominateStage(fx, p, VERIFIABLE_KEYS);
    // T0: a fix of the stage parked. T0+1800: the stage verified. T0+3600: the fix's blocker answered.
    const { blocker } = await parkedFix(fx, p.id, p.stage.id);
    const open = stageOf(await readPace(fx, p.id), p.stage.id);
    assert.ok(isUnknown(open.human_wait), `a blocking decision still open: unknown (${show(open.human_wait)})`);
    assert.ok(isUnknown(open.decision_hours), `and decision_hours † unknown (${show(open.decision_hours)})`);
    await advanceClock(fx.engine, 1800);
    await verifyStage(fx, p, c);
    await advanceClock(fx.engine, 1800);
    await answerDecision(fx.engine, p.id, blocker.id, 'cancel');
    const f = stageOf(await readPace(fx, p.id), p.stage.id);
    assert.equal(f.status, 'verified', 'the fixture is live: verified before the answer');
    assert.ok(near(f.human_wait, 1800, TOL), `the inside part, 1800 s (read ${show(f.human_wait)})`);
    assert.ok(near(f.decision_hours, hours(3600), hours(TOL)), `decision_hours † the whole open time, 1 h (read ${show(f.decision_hours)})`);
  });
});

describe('M441 (f) across a restart with a settings change and a domain removed', () => {
  test('(f) the historical run keeps the host observation of its incarnation and its figures; the present settings appear only in the new observation; the removed domain\'s peak is unknown', async (t) => {
    const fx = await scriptedEngine(t, { config: { tick_interval: 600 } });
    const project = await addGitProject(fx);
    fx.scripted.defaultScript(script.complete());
    const done = await addWork(fx.engine, project.id, 'verification');
    await tick(fx.engine, project.id);
    await waitForWork(fx.home, done, 'complete');
    const held = await addWork(fx.engine, project.id, 'review');
    fx.scripted.script(held, [script.hold('gate')]);
    await tick(fx.engine, project.id);
    await fx.scripted.waitForHolding({ work_item: held });
    const doneRun = runsOf(fx.home, done)[0];
    const heldRun = runsOf(fx.home, held)[0];
    const r1 = await readPace(fx, project.id);
    // The settings change: the project's role_memory_max now, the engine's tick_interval at the restart.
    const policy = await fx.engine.post(`/v1/projects/${project.id}/policy`, { role_memory_max: 3 * GIB });
    await fx.engine.kill();
    setEngineConfig(fx, { tick_interval: 300 });
    await fx.start();
    await waitForRun(fx.home, held, { state: 'ended' });
    await tick(fx.engine, project.id);
    const r2 = await readPace(fx, project.id);

    const before = r1.runs.find((r) => r.id === doneRun.id);
    const afterR = r2.runs.find((r) => r.id === doneRun.id);
    assert.ok(typeof before?.host_observation === 'string', `runs[].host_observation † names an observation (${show(before?.host_observation)})`);
    assert.deepEqual(afterR, before, 'the historical run is reported the same after the restart: its figures and its host observation');
    const hosts = r2.hosts;
    assert.ok(Array.isArray(hosts) && hosts.length >= 2, `hosts † lists every observation of the project (${show(hosts)})`);
    const h1 = hosts.find((h) => h.id === before.host_observation);
    assert.ok(h1, 'the run\'s observation is listed');
    assert.equal(h1.tick_interval, 600, 'with the values recorded for it, not the present tick_interval');
    assert.equal(h1.role_memory_max, 4 * GIB, 'and the role_memory_max recorded then');
    const h2 = hosts.at(-1);
    assert.equal(h2.trigger, 'engine_start', `the new observation was recorded at the engine's start (${show(h2)})`);
    assert.equal(h2.tick_interval, 300, 'the present tick_interval belongs to the new observation');
    assert.equal(policy.status, 200, `the fixture is live: role_memory_max † is a project setting (→ ${policy.status} ${policy.text})`);
    assert.equal(h2.role_memory_max, 3 * GIB, 'and the present role_memory_max');
    assert.equal(r2.host.tick_interval, 300, 'the host block is the latest observation');
    // The domain of the held run, removed by the restart's recovery: its peak was never read.
    const domain = r2.domains.find((d) => d.run === heldRun.id) ?? r2.domains.at(-1);
    assert.ok(domain && isUnknown(domain.memory_peak), `the removed domain's memory_peak is unknown, never a value (${show(domain)})`);
    const heldBefore = r1.domains.find((d) => d.id === domain.id);
    assert.ok(!heldBefore || isUnknown(heldBefore.memory_peak), 'nor was it a value before');
  });
});

describe('M441 (g) idle time from hold intervals, not tick counts', () => {
  test('(g) a one-shot held session_busy across 900 s of clock and many ticks: one interval, one began and one ended event, about 900 s in project.idle.session_busy; D1\'s work.held untouched', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await sessionProject(fx);
    const session = await openSession(fx, p.id, 'vision');
    const item = await addWork(fx.engine, p.id, 'fix');
    fx.scripted.script(item, [script.complete()]);
    await tick(fx.engine, p.id);
    const started = nowMs();
    await advanceClock(fx.engine, 900);
    for (let i = 0; i < 5; i++) await tick(fx.engine, p.id);
    await closeSession(fx, p.id, session.id);
    const realS = (nowMs() - started) / 1000;
    await tick(fx.engine, p.id);
    await waitForRun(fx.home, item, { state: 'ended' });
    const intervals = holdIntervals(fx.home, item);
    assert.ok(Array.isArray(intervals), `work_items.held_intervals † (${show(intervals)})`);
    const busy = intervals.filter((h) => h.reason === 'session_busy');
    assert.equal(busy.length, 1, `one session_busy interval, not one per tick (${show(intervals)})`);
    assert.ok(typeof busy[0].from === 'string' && typeof busy[0].to === 'string', 'closed at both ends');
    const ev = holdEvents(fx.home, item);
    assert.deepEqual([ev.began.length, ev.ended.length], [1, 1], `one work.hold_began † and one work.hold_ended † (${show(ev)})`);
    assert.equal(ev.began[0].payload?.reason, 'session_busy');
    assert.equal(eventsOfType(fx.home, 'work.held').filter((e) => e.subject?.work_item === item).length, 0, 'D1\'s work.held status event is not used for a hold interval');
    const idle = (await readPace(fx, p.id)).project.idle;
    assert.ok(near(idle?.session_busy, 900 + realS, TOL), `idle.session_busy is the elapsed time, about ${Math.round(900 + realS)} s (read ${show(idle?.session_busy)})`);
  });

  test('(g) an item held depends_on across 600 s of clock and many ticks: one interval, about 600 s in project.idle.depends_on', async (t) => {
    const fx = await scriptedEngine(t);
    const p = (await addProject(fx)).id;
    fx.scripted.defaultScript(script.complete());
    const first = await addWork(fx.engine, p, 'verification');
    await driveTo(fx.engine, first, ['claimed', 'held']);
    const dependant = await addWork(fx.engine, p, 'review', { depends_on: [first] });
    await tick(fx.engine, p);
    const started = nowMs();
    await advanceClock(fx.engine, 600);
    for (let i = 0; i < 5; i++) await tick(fx.engine, p);
    await resumeWork(fx.engine, p, first);
    await tick(fx.engine, p);
    await waitForWork(fx.home, first, 'complete');
    const realS = (nowMs() - started) / 1000;
    await tick(fx.engine, p);
    await waitForWork(fx.home, dependant, 'complete');
    const intervals = holdIntervals(fx.home, dependant);
    assert.ok(Array.isArray(intervals), `work_items.held_intervals † (${show(intervals)})`);
    const dep = intervals.filter((h) => h.reason === 'depends_on');
    assert.equal(dep.length, 1, `one depends_on interval (${show(intervals)})`);
    const idle = (await readPace(fx, p)).project.idle;
    assert.ok(near(idle?.depends_on, 600 + realS, TOL), `idle.depends_on about ${Math.round(600 + realS)} s (read ${show(idle?.depends_on)})`);
  });
});
