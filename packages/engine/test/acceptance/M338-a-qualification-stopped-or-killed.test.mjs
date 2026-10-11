// M338 (b) and (c), the slice-29 review's S2 and S3: a qualification run cut
// short by the engine's own end is `interrupted`, never the adapter's
// failure; and after a crash the remedy works (slice 29; sandbox lane). M4
// plan §3.7 M338; D4 §2.6 ("a case … unexercised [is] `not_exercised`"),
// §4.6 (exact teardown, positive ownership); the coordinator's rulings
// (2026-10-11: an interrupted run's leftovers are refused by exact name and
// never cleaned automatically); SEAM.md §§322, 323, 329, 330.
//
// Each case on a home of its own, in harness mode on the real adapter. The
// run is let reach a point inside it, read from the store only: a service of
// its qualification environment has started (an attempt with its
// application instance recorded, so a qualification operation is open and a
// unit of the prefix is live), and the run is still `running`. Then:
//   S2 the test's own engine child is sent SIGTERM (an orderly stop) and
//      exits by itself. After the restart the run is `interrupted`, never
//      `unqualified`; no case is `failed`, and every case not `passed` is
//      `not_exercised` (a case not completed before the stop is never the
//      adapter's failure); no row was written `current` by it, and the row
//      current before it is still current (Sean's decision on D4-A06, 2026-10-11:
//      an interrupted run lapses no row).
//   S3 the test's own engine child is killed (SIGKILL). After the restart the
//      run is `interrupted`; the next `qualify-adapter` is 409
//      `qualification_left_units` naming each unit of the prefix still
//      loaded; `surety env teardown <env> --project <p>` (no --preempt) is
//      accepted and its teardown is `applied`; nothing of the run's prefix is
//      left on the host; and a following `qualify-adapter` qualifies.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §§257, 274, 329, 330). The only process
// signalled is this test's own engine child, by the ChildProcess handle the
// harness spawned, after reading /proc/<pid>/cmdline (`serve`) and
// /proc/<pid>/environ (this test's SURETY_HOME): SIGTERM by
// `terminateOwnEngine`, SIGKILL by `killOwnEngine`; any failed or disagreeing
// read refuses. Units are acted on only by the engine (the qualification's
// own, and the operator's exact teardown through the engine), under this
// home's prefix; the test only reads them. Each case ends, in `finally`, with
// the engine's exact teardown of whatever its run left; the file ends with
// `operatorGuard`, which reports anything left by exact name.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { operatorGuard, realAdapterStarts, ticksUntil } from './harness/deploy/host.mjs';
import { killOwnEngine } from './harness/deploy/recover.mjs';
import {
  currentRows,
  eventsSince,
  exactTeardown,
  leftOnHost,
  maxSeq,
  qualificationEnvironment,
  qualificationRuns,
  qualifyAdapter,
  qualifyRoute,
  terminateOwnEngine,
  untilQualificationServiceStarted,
} from './harness/deploy/qualify.mjs';

// A run begun through the route, not awaited (its connection ends with the engine).
const begin = (fx) => qualifyRoute(fx.engine).catch((err) => ({ status: null, error: err.message }));

// In `finally`: the engine's exact teardown of the run's environment if
// anything of it is still loaded; never a stop by the test.
async function remedy(fx, env) {
  if (!env || !fx.engine?.isRunning()) return;
  const left = leftOnHost(fx.home, env);
  if ((left.units ?? []).length === 0) return;
  try {
    await exactTeardown(fx, env, ticksUntil);
  } catch (err) {
    console.log(`# note: the exact teardown of ${env.name} after the case did not apply: ${err.message}`);
  }
}

describe('M338 a qualification run cut short (the slice-29 review, S2 and S3)', () => {
  const shared = sharedFixture();
  let guard;
  before(() => {
    guard = operatorGuard();
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('S2 an orderly stop during the run: interrupted, never unqualified; no case failed, every case not passed not_exercised; it writes no row and lapses the row current before it', async () => {
    const fx = realAdapterStarts(await sandboxEngine(shared.context, { start: false }));
    guard.track(fx);
    await fx.start();
    let env = null;
    try {
      // A row current before the run (Sean, D4-A06: an interrupted run lapses no row).
      const earlier = await qualifyAdapter(fx.engine);
      assert.equal(earlier.qualified, true, 'the fixture is live: a row is current before the run that is stopped');
      const seq = maxSeq(fx.home);
      const pending = begin(fx);
      const at = await untilQualificationServiceStarted(fx);
      env = at.environment;
      assert.equal(qualificationRuns(fx.home).find((r) => r.id === at.run.id)?.status, 'running', 'the fixture is live: the run is still running when the stop is sent');
      assert.ok((leftOnHost(fx.home, env).units ?? []).length > 0, 'and a unit of its prefix is live');
      const stopped = await terminateOwnEngine(fx);
      assert.ok(stopped.inTime, 'the engine stopped in order on SIGTERM (within 60 s), nothing more sent');
      assert.equal(stopped.status?.signal ?? null, null, `it exited by itself, not by a signal (${JSON.stringify(stopped.status)})`);
      await pending;

      await fx.start();
      const run = qualificationRuns(fx.home).find((r) => r.id === at.run.id);
      assert.equal(run?.status, 'interrupted', `after the restart the run is interrupted, never unqualified (${run?.status})`);
      const cases = run.cases ?? [];
      assert.equal(cases.length, 9, 'its nine cases are recorded');
      assert.deepEqual(cases.filter((c) => c.result === 'failed' || c.control === 'failed').map((c) => c.case), [], 'no case is failed: the stop is not the adapter\'s failure');
      for (const c of cases.filter((e) => e.result !== 'passed')) assert.equal(c.result, 'not_exercised', `${c.case}: not completed before the stop, not_exercised (${JSON.stringify(c).slice(0, 200)})`);
      assert.deepEqual(currentRows(fx.home).map((r) => r.id), [earlier.adapter_qualification], 'the interrupted run wrote no current row, and the earlier row is still the one current: an interrupted run lapses nothing (Sean, D4-A06)');
      assert.deepEqual(eventsSince(fx.home, 'adapter.qualified', seq), [], 'no adapter.qualified');
      assert.deepEqual(eventsSince(fx.home, 'adapter.qualification_lapsed', seq), [], 'no adapter.qualification_lapsed');
    } finally {
      await remedy(fx, env);
    }
  });

  test('S3 a crash during the run: interrupted; the next qualify-adapter 409 qualification_left_units naming each unit; the exact teardown applied, nothing of the prefix left; then the adapter qualifies', async () => {
    const fx = realAdapterStarts(await sandboxEngine(shared.context, { start: false }));
    guard.track(fx);
    await fx.start();
    let env = null;
    try {
      const pending = begin(fx);
      const at = await untilQualificationServiceStarted(fx);
      env = at.environment;
      assert.equal(qualificationRuns(fx.home).find((r) => r.id === at.run.id)?.status, 'running', 'the fixture is live: the run is still running when the engine is killed');
      await killOwnEngine(fx);
      await pending;

      await fx.start();
      const run = qualificationRuns(fx.home).find((r) => r.id === at.run.id);
      assert.equal(run?.status, 'interrupted', `after the restart the run is interrupted (${run?.status})`);
      const left = leftOnHost(fx.home, env);
      assert.ok((left.units ?? []).length > 0, `the fixture is live: the killed run left a unit of its prefix loaded (${JSON.stringify(left)})`);

      const refused = await qualifyRoute(fx.engine);
      assert.deepEqual([refused.status, refused.body?.code], [409, 'qualification_left_units'], `the next qualify-adapter is refused (→ ${refused.status} ${refused.text?.slice(0, 400)})`);
      const named = JSON.stringify(refused.body?.subject ?? null);
      for (const unit of left.units) assert.ok(named.includes(unit), `the refusal names ${unit} (${named.slice(0, 400)})`);
      assert.equal(qualificationEnvironment(fx.home, run.id)?.id, env.id, 'the environment to tear down is the run\'s own');

      const td = await exactTeardown(fx, env, ticksUntil);
      assert.equal(td.attempt.reconciliation_reads?.at(-1)?.result, 'applied', 'the exact teardown reached applied (D4 §4.6)');
      assert.deepEqual(leftOnHost(fx.home, env), { units: [], cgroups: [], runFiles: [] }, 'nothing of the run\'s prefix is left: no unit, cgroup or runtime file');

      const again = await qualifyRoute(fx.engine);
      assert.equal(again.status, 200, `a following qualify-adapter runs (→ ${again.status} ${again.text?.slice(0, 300)})`);
      assert.equal(again.body?.qualified, true, `and qualifies (${JSON.stringify(again.body?.cases?.filter((c) => c.result !== 'passed'))})`);
    } finally {
      await remedy(fx, env);
    }
  });
});
