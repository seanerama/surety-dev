// M639, the runtime clock excludes recorded engine-blocked and paused
// intervals (slice 50; kernel lane). The owner's M7 plan §3j, row M639;
// Sean's ruling D5 of 2026-11-26 (DECISIONS item 57): "Accept for recorded
// engine-blocked and explicitly paused intervals. Show total wall time,
// excluded time and reason, and time charged to the limit. Time spent
// waiting for an ordinary owner approval still counts unless the project is
// explicitly paused."; R4; item 53. The controlled clock (SEAM.md §425);
// the prototype's runtime limit is the preset's `prototype_runtime_seconds`
// 2700 (45 min) unless a case says otherwise.
//
// (a) a work item parks after its repairs (iteration 1's first replan fails
//     twice: one automatic repair, then parked, the iteration `failed`), 3 h
//     pass, the owner retries (its blocker answered `retry`): not
//     `limit_reached`; `time.clock` names the interval `parked_on_blocker`;
// (b) the project explicitly paused 2 h after its brief is approved, then
//     resumed: not `limit_reached`; the interval `paused`;
// (c) an ordinary owner question (the first plan's `plan_approval`, three
//     stages) waits 3 h unanswered, unpaused: charged, no exclusion, and
//     `limit_reached` once it passes the limit;
// (d) a stall with no owner act (M642's `completion_held_by`
//     phase_gate_not_satisfied, owner_act null: a phase-only check failing)
//     for 1 h: not `limit_reached`; the interval `engine_stall`;
// (e) running past the limit with no exclusion (M607 (e)'s fixture: limit
//     300 s, a Builder holding): `limit_reached` as M607 (e), the clock
//     charging the whole wall time; and an iteration recorded before the
//     migration (labelled store write) serves `basis:
//     'not_recorded_before_0053'` with `excluded_seconds` null, never 0;
// (f) intervals overlapping (paused 1 h while parked 3 h): the union
//     excluded once, never twice;
// and, as objection 237 asked (answered upheld): a restart and 3 h on the
//     controlled clock between the park and the next tick: the interval is
//     the park's own, from the park; not `limit_reached`.
//
// Readings this file makes (the report says them):
// - "not limit_reached" is read after the event that ends the excluded
//   interval (retry, resume, or the controlled clock past the stall) and
//   further ticks: the iteration's status is not `limit_reached` and its
//   next dispatch is not refused by `runtime`.
// - Durations: an interval's `seconds` is at least the controlled clock's
//   advance across it and at most that plus 600 s of real time; `charged_seconds`
//   is `wall_seconds - excluded_seconds` within 2 s.
// - `cause` is read as naming (by id, anywhere in it) the parked work item
//   or its blocker decision for `parked_on_blocker`; for the others it is
//   read as present (not undefined).
// - `basis` on a recorded iteration is read as any string other than
//   'not_recorded_before_0053'.
// - The pre-migration iteration is ARRANGED BY A LABELLED STORE WRITE: its
//   `prototype_iterations.clock_basis` NULL and its `created_at` a day before
//   migration 0053's `applied_at` (schema_migrations), as a row written
//   before the migration is (the file fails naming either if absent).
//
// SAFETY (BS6 §4.1; E64): the kernel lane; the scripted role program and
// the scripted deployment adapter in the test's own home; nothing signalled
// but the test's own engine (the harness's verified stop).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readPlan } from './harness/journey/drive.mjs';
import { advanceClock, advanceClockInSteps, pauseProject, resumeProject, tick } from './harness/runs.mjs';
import { restart } from './harness/gap57.mjs';
import {
  CHECK_FILES,
  PROTO,
  THREE_STAGES,
  alphaReady,
  answer,
  answerOpen,
  authoringScript,
  builderScript,
  firstPlanScript,
  holdingBuilder,
  idle,
  iterationRead,
  kindNext,
  openDecisionsRead,
  protoEngine,
  pump,
  statusIs,
  toBrief,
  usage,
  workOfProject,
} from './harness/prototype.mjs';
import { advanceTicking, columnsOf, pumpWith, show } from './harness/item57v2.mjs';
import { withStore } from './harness/store.mjs';

const LIMIT = 2700;
const fail = () => ({ steps: [usage(300, 0, 100), { exit: 3 }] });

// The clock as served, its shape checked; returns it.
function clockOf(read, what) {
  const c = read.time?.clock;
  assert.ok(c && typeof c === 'object', `${what}: the iteration read serves time.clock (time: ${show(read.time)})`);
  for (const k of ['wall_seconds', 'excluded', 'excluded_seconds', 'charged_seconds', 'limit_seconds', 'basis']) assert.ok(k in c, `${what}: time.clock.${k} served (${show(c)})`);
  assert.ok(Array.isArray(c.excluded), `${what}: excluded is a list (${show(c.excluded)})`);
  for (const e of c.excluded) {
    for (const k of ['reason', 'from', 'to', 'seconds', 'cause']) assert.ok(k in e, `${what}: each excluded interval carries ${k} (${show(e)})`);
    assert.ok(['parked_on_blocker', 'paused', 'engine_stall', 'provider_refusal'].includes(e.reason), `${what}: a known reason (${e.reason})`);
  }
  return c;
}
function assertRecorded(c, what, { limit = LIMIT } = {}) {
  assert.equal(c.limit_seconds, limit, `${what}: limit_seconds is the iteration's prototype_runtime_seconds`);
  assert.ok(typeof c.basis === 'string' && c.basis !== 'not_recorded_before_0053', `${what}: recorded basis (${show(c.basis)})`);
  assert.equal(typeof c.wall_seconds, 'number', `${what}: wall_seconds a number`);
  assert.equal(typeof c.excluded_seconds, 'number', `${what}: excluded_seconds a number`);
  assert.ok(Math.abs(c.charged_seconds - (c.wall_seconds - c.excluded_seconds)) <= 2, `${what}: charged = wall − excluded (${c.charged_seconds} vs ${c.wall_seconds} − ${c.excluded_seconds})`);
}
const within = (s, advanced) => typeof s === 'number' && s >= advanced - 2 && s <= advanced + 600;
function assertInterval(c, reason, advanced, what, causeNames = []) {
  const hits = c.excluded.filter((e) => e.reason === reason);
  assert.equal(hits.length, 1, `${what}: one ${reason} interval (${show(c.excluded)})`);
  const e = hits[0];
  assert.ok(within(e.seconds, advanced), `${what}: the ${reason} interval lasts the ${advanced} s advanced (${e.seconds})`);
  assert.ok(typeof e.from === 'string' && typeof e.to === 'string' && Date.parse(e.to) > Date.parse(e.from), `${what}: from and to recorded (${show(e)})`);
  assert.ok(Math.abs((Date.parse(e.to) - Date.parse(e.from)) / 1000 - e.seconds) <= 2, `${what}: seconds = to − from (${show(e)})`);
  assert.notEqual(e.cause, undefined, `${what}: its cause served`);
  if (causeNames.length > 0) assert.ok(causeNames.some((id) => show(e.cause).includes(id)), `${what}: its cause names ${causeNames.join(' or ')} (${show(e.cause)})`);
  return e;
}
async function assertNotLimited(fx, p, it, what) {
  await tick(fx.engine, p, { rounds: 2 });
  const r = await iterationRead(fx, p, it);
  assert.notEqual(r.iteration.status, 'limit_reached', `${what}: not limit_reached (${r.iteration.status}: ${r.outcome?.reason ?? ''})`);
  assert.notEqual(r.remaining.next_dispatch?.limit, 'runtime', `${what}: the next dispatch not refused by runtime (${show(r.remaining.next_dispatch)})`);
  return r;
}

// Iteration 1's first replan fails twice: parked, the iteration failed.
async function parked(t, name) {
  const fx = await protoEngine(t, { config: { lease_ttl: 600 } });
  const { id: p, it } = await toBrief(fx, { name });
  kindNext(fx, 'replan', [fail(), fail()], firstPlanScript());
  await answerOpen(fx, p, 'spec_approval');
  await pump(fx, p, statusIs(fx, p, it.id, 'failed'), { what: 'the replan parked after its repair, the iteration failed', max: 20 });
  const R = workOfProject(fx.home, p).find((w) => w.kind === 'replan' && w.status === 'parked');
  assert.ok(R, 'the fixture is live: the replan is parked');
  const blocker = (await openDecisionsRead(fx, p)).find((d) => d.kind === 'blocker' && d.subject_id === R.id);
  assert.ok(blocker, `the fixture is live: its blocker question is open (${show((await openDecisionsRead(fx, p)).map((d) => [d.kind, d.subject_id]))})`);
  const r = await iterationRead(fx, p, it.id);
  assert.ok(r.time.approval_to_alpha_seconds === null && r.iteration.status === 'failed', 'the fixture is live: failed, no Alpha');
  return { fx, p, it: it.id, R: R.id, blocker };
}
const retry = async (fx, p, blocker) => {
  const res = await answer(fx, p, blocker, 'retry');
  assert.equal(res.status, 200, `the owner retries the parked replan (→ ${res.status} ${res.text})`);
};

describe('M639 the runtime clock excludes recorded engine-blocked and paused intervals', () => {
  test('(a) parked after its repairs, 3 h pass, the owner retries: not limit_reached; time.clock names parked_on_blocker', { timeout: 600_000 }, async (t) => {
    const { fx, p, it, R, blocker } = await parked(t, 'M639 a');
    await advanceTicking(fx, p, 10_800);
    const during = clockOf(await iterationRead(fx, p, it), '(a) while parked');
    assert.ok(during.excluded.some((e) => e.reason === 'parked_on_blocker'), `(a) the open interval is served while parked (${show(during.excluded)})`);
    await retry(fx, p, blocker);
    const r = await assertNotLimited(fx, p, it, '(a) after the retry');
    const c = clockOf(r, '(a)');
    assertRecorded(c, '(a)');
    assertInterval(c, 'parked_on_blocker', 10_800, '(a)', [R, blocker.id]);
    assert.ok(c.wall_seconds > LIMIT && c.charged_seconds < LIMIT, `(a) only the excluded time takes the wall time past the limit (wall ${c.wall_seconds}, charged ${c.charged_seconds})`);
    await pump(fx, p, async () => (workOfProject(fx.home, p).find((w) => w.id === R)?.status === 'complete' ? true : undefined), { what: 'the retried replan completes', max: 10 });
    assert.notEqual((await iterationRead(fx, p, it)).iteration.status, 'limit_reached', '(a) and it builds on');
  });

  test('(b) paused 2 h after the approval, then resumed: not limit_reached; time.clock names paused', { timeout: 600_000 }, async (t) => {
    const fx = await protoEngine(t, { config: { lease_ttl: 600 } });
    const { id: p, it } = await toBrief(fx, { name: 'M639 b' });
    await answerOpen(fx, p, 'spec_approval');
    await pauseProject(fx.engine, p);
    await idle(fx, p);
    await advanceTicking(fx, p, 7200);
    await resumeProject(fx.engine, p);
    const r = await assertNotLimited(fx, p, it.id, '(b) after the resume');
    const c = clockOf(r, '(b)');
    assertRecorded(c, '(b)');
    assertInterval(c, 'paused', 7200, '(b)');
    assert.ok(c.wall_seconds > LIMIT && c.charged_seconds < LIMIT, `(b) only the paused time takes the wall time past the limit (wall ${c.wall_seconds}, charged ${c.charged_seconds})`);
  });

  test('(c) an ordinary owner question (plan_approval) waits 3 h unanswered, unpaused: charged, and limit_reached once past the limit', { timeout: 600_000 }, async (t) => {
    const fx = await protoEngine(t, { config: { lease_ttl: 600 } });
    const { id: p, it } = await toBrief(fx, { name: 'M639 c' });
    kindNext(fx, 'replan', [firstPlanScript({ stages: THREE_STAGES })], firstPlanScript());
    await answerOpen(fx, p, 'spec_approval');
    await pump(fx, p, async () => ((await openDecisionsRead(fx, p)).some((d) => d.kind === 'plan_approval') ? true : undefined), { what: 'the first plan routed to the owner', max: 20 });
    await advanceTicking(fx, p, 10_800);
    const r = await iterationRead(fx, p, it.id);
    assert.equal(r.iteration.status, 'limit_reached', `(c) the wait is charged: limit_reached (${r.iteration.status})`);
    assert.match(r.outcome.reason, /^runtime: prototype_runtime_seconds 2700 passed/, r.outcome.reason);
    const c = clockOf(r, '(c)');
    assertRecorded(c, '(c)');
    assert.deepEqual(c.excluded, [], `(c) no exclusion for an ordinary owner wait (${show(c.excluded)})`);
    assert.equal(c.excluded_seconds, 0, '(c) nothing excluded');
    assert.ok(c.charged_seconds > LIMIT, `(c) charged past the limit (${c.charged_seconds})`);
  });

  test('(d) a stall with no owner act (phase gate not satisfied, owner_act null) for 1 h: not limit_reached; time.clock names engine_stall', { timeout: 600_000 }, async (t) => {
    const fx = await protoEngine(t, { config: { lease_ttl: 600 } });
    const r1 = JSON.parse(CHECK_FILES['.surety/checks/defs/accept-r1.json']);
    const files = { ...CHECK_FILES, '.surety/checks/defs/phase-r1.json': `${JSON.stringify({ ...r1, key: 'phase-r1', gate_kinds: ['phase'] }, null, 2)}\n` };
    kindNext(fx, 'check_authoring', [authoringScript({ files })], authoringScript());
    const { id: p, it } = await toBrief(fx, { name: 'M639 d' });
    await answerOpen(fx, p, 'spec_approval');
    await alphaReady(fx, p, { port: 18639 });
    const held = await pumpWith(
      fx,
      p,
      async () => {
        const h = (await readPlan(fx, p)).plan?.completion_held_by;
        return h?.reason === 'phase_gate_not_satisfied' && (h.owner_act ?? null) === null ? h : undefined;
      },
      { answer: ['check_correction_unclassifiable', 'check_correction_tightening', 'check_correction_loosening'], exitOf: (x) => (x.key === 'phase-r1' ? 1 : 0), max: 80, what: 'the phase held by its gate with no owner act' },
    );
    assert.equal(held.stale, false, 'the fixture is live: a fresh evaluation');
    await tick(fx.engine, p, { rounds: 2 });
    await advanceTicking(fx, p, 3600, 600);
    const r = await assertNotLimited(fx, p, it.id, '(d) after an hour stalled');
    const c = clockOf(r, '(d)');
    assertRecorded(c, '(d)');
    const stall = c.excluded.filter((e) => e.reason === 'engine_stall');
    assert.equal(stall.length, 1, `(d) one engine_stall interval (${show(c.excluded)})`);
    assert.ok(stall[0].seconds >= 3600 - 2 && stall[0].seconds <= 3600 + 600, `(d) it covers the hour (${stall[0].seconds})`);
    assert.notEqual(stall[0].cause, undefined, '(d) its cause served');
    assert.ok(c.wall_seconds > LIMIT && c.charged_seconds < LIMIT, `(d) only the stalled time takes the wall time past the limit (wall ${c.wall_seconds}, charged ${c.charged_seconds})`);
  });

  test("(e) running past the limit with no exclusion: limit_reached as M607 (e), the whole wall time charged; an iteration recorded before the migration serves basis 'not_recorded_before_0053', excluded_seconds null", { timeout: 600_000 }, async (t) => {
    const fx = await protoEngine(t, { config: { lease_ttl: 600 } });
    const { id: p, it } = await toBrief(fx, { name: 'M639 e', policy: { prototype_runtime_seconds: 300, deadline_builder: 600 } });
    kindNext(fx, 'stage_build', [holdingBuilder('long')], builderScript(1));
    await answerOpen(fx, p, 'spec_approval');
    await alphaReady(fx, p, { port: 18640 });
    await pump(fx, p, () => (withStore(fx.home, (db) => db.prepare(`SELECT 1 FROM "runs" r JOIN "work_items" w ON w."id" = r."work_item" WHERE r."project" = ? AND w."kind" = 'stage_build' AND r."state" <> 'ended'`).get(p)) ? true : undefined), { wait: false, max: 60, answer: ['check_correction_unclassifiable', 'check_correction_tightening', 'check_correction_loosening'], what: 'a stage build under way' });
    await advanceClockInSteps(fx.engine, 310, { stepSeconds: 300 });
    await tick(fx.engine, p);
    const r = await iterationRead(fx, p, it.id);
    assert.equal(r.iteration.status, 'limit_reached', '(e) the runtime passed: limit_reached at the tick');
    assert.match(r.outcome.reason, /^runtime: prototype_runtime_seconds 300 passed \(\d+ s since the brief was approved at .*\); no new run is dispatched, and runs already running continue to their own deadlines$/, r.outcome.reason);
    assert.equal(r.outcome.next_step, PROTO.next_steps.limit);
    const c = clockOf(r, '(e)');
    assertRecorded(c, '(e)', { limit: 300 });
    assert.deepEqual([c.excluded, c.excluded_seconds], [[], 0], `(e) nothing excluded (${show(c)})`);
    assert.ok(c.charged_seconds > 300 && Math.abs(c.charged_seconds - c.wall_seconds) <= 2, `(e) the whole wall time charged (${c.charged_seconds} of ${c.wall_seconds})`);
    fx.scripted.release('all', 'long');
    // The pre-migration reading.
    assert.ok(columnsOf(fx.home, 'prototype_iterations').includes('clock_basis'), `the fixture is live: prototype_iterations.clock_basis exists (columns: ${columnsOf(fx.home, 'prototype_iterations').join(', ')})`);
    const applied = withStore(fx.home, (db) => db.prepare('SELECT "applied_at" FROM "schema_migrations" WHERE "seq" = 53').get())?.applied_at;
    assert.ok(applied, 'the fixture is live: migration 0053 recorded as applied');
    // FIXTURE TAMPERING (labelled): the iteration as a row written before migration 0053 was applied: created a day before it, no clock basis recorded.
    const before = new Date(Date.parse(applied) - 86_400_000).toISOString();
    withStore(fx.home, (db) => db.prepare('UPDATE "prototype_iterations" SET "clock_basis" = NULL, "created_at" = ? WHERE "id" = ?').run(before, it.id), { readonly: false });
    const old = clockOf(await iterationRead(fx, p, it.id), '(e) pre-0053');
    assert.equal(old.basis, 'not_recorded_before_0053', `(e) the basis says the intervals were not recorded (${show(old)})`);
    assert.equal(old.excluded_seconds, null, `(e) excluded_seconds unknown, never 0 (${show(old)})`);
  });

  test('(f) paused 1 h while parked 3 h: the union excluded once, never twice', { timeout: 600_000 }, async (t) => {
    const { fx, p, it, R, blocker } = await parked(t, 'M639 f');
    await advanceTicking(fx, p, 3600);
    await pauseProject(fx.engine, p);
    await advanceTicking(fx, p, 3600);
    await resumeProject(fx.engine, p);
    await advanceTicking(fx, p, 3600);
    await retry(fx, p, blocker);
    const r = await assertNotLimited(fx, p, it, '(f) after the retry');
    const c = clockOf(r, '(f)');
    assertRecorded(c, '(f)');
    assertInterval(c, 'parked_on_blocker', 10_800, '(f)', [R, blocker.id]);
    assertInterval(c, 'paused', 3600, '(f)');
    assert.ok(within(c.excluded_seconds, 10_800), `(f) the union (3 h) excluded once, never 4 h (${c.excluded_seconds})`);
    assert.ok(c.charged_seconds < LIMIT, `(f) charged below the limit (${c.charged_seconds})`);
  });

  test('(objection 237) a restart and 3 h between the park and the next tick: the parked interval is the park\'s own; not limit_reached', { timeout: 600_000 }, async (t) => {
    const fx = await protoEngine(t, { config: { lease_ttl: 600 } });
    const { id: p, it } = await toBrief(fx, { name: 'M639 237' });
    kindNext(fx, 'replan', [fail(), fail()], firstPlanScript());
    await answerOpen(fx, p, 'spec_approval');
    // Pumped only until the replan parks: no tick after the park.
    await pump(fx, p, () => (workOfProject(fx.home, p).some((w) => w.kind === 'replan' && w.status === 'parked') ? true : undefined), { what: 'the replan parked after its repair', max: 20 });
    const R = workOfProject(fx.home, p).find((w) => w.kind === 'replan' && w.status === 'parked');
    await restart(fx);
    await advanceClock(fx.engine, 10_800);
    await tick(fx.engine, p, { rounds: 2 });
    const parkedRead = await iterationRead(fx, p, it.id);
    assert.notEqual(parkedRead.iteration.status, 'limit_reached', `the first tick after the park and the 3 h does not end the iteration (${parkedRead.iteration.status}: ${parkedRead.outcome?.reason ?? ''})`);
    const blocker = (await openDecisionsRead(fx, p)).find((d) => d.kind === 'blocker' && d.subject_id === R.id);
    assert.ok(blocker, 'the fixture is live: the blocker question is open');
    await retry(fx, p, blocker);
    const r = await assertNotLimited(fx, p, it.id, '(237) after the retry');
    const c = clockOf(r, '(237)');
    assertRecorded(c, '(237)');
    assertInterval(c, 'parked_on_blocker', 10_800, '(237)', [R.id, blocker.id]);
  });
});

