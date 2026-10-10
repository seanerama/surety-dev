// M321 (b), (e), (g): kills of the engine with the real `service` profile
// (slice 26; sandbox lane). M4 plan §3.4 M321; D4-O03; D4 §§2.4, 4.3, 9.2;
// E110, E111; BS4 §11.1 CD3; SEAM.md §§125, 256 to 259, 273 to 278.
//
// On the real `local_service` adapter, the engine killed at three points of
// a service's launch, then started again on the same home:
//   - at placement: the launcher placed in the unit's cgroup and waiting
//     before it asks for its grant (`launcher.before_authorization`, a
//     launcher barrier whose wait survives the engine, SEAM.md §125). The
//     next incarnation closes the attempt's launch before it accepts any
//     launch request; the earlier incarnation's launcher, released, is
//     refused before recovery has read its attempt, and runs nothing; no
//     read is `absent` while its unit is loaded, and none is `applied`
//     (M321 (e); M324 (c); M322 (a)'s simplest form);
//   - at the grant (`deploy.launch_granted`, after the grant's transaction,
//     before the reply): the launcher has no reply and runs nothing; the
//     read is never `applied` or `absent` (a launch was granted, D4 §2.4);
//   - between the grant and the init's `started` (`init.app_started`), CD3:
//     the application runs and no instance is recorded, so reconcile answers
//     `unknown` and a blocker offers the preempting teardown, which removes
//     exactly the attempt's unit; a new request makes a new authorization;
//     nothing found by enumeration is recorded as the instance (M321 (g)).
// In none does a verification pass. The fourth kill point of (b), during
// verification, is M324 (a)'s case in M324-after-an-engine-restart-on-a-real-unit
// (the service survives with supervision `unknown`, its round `unknown`
// naming `supervision`). deploy_auto_retries_max is 0, so no retry makes a
// second unit.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §§257, 274). What is killed is this test's
// own engine child and nothing else: at the grant and at `started` the
// engine kills itself at the armed barrier (its `kill`); at placement the
// test calls `killOwnEngine`, which sends SIGKILL through the ChildProcess
// handle the harness spawned after reading from /proc that the pid is the
// engine of this test's own home. No unit is stopped, restarted or reset
// by the test; every unit is the engine's own, under this test's home's
// prefix, and the engine's own teardown removes it. Every environment is
// ended in `finally`; the file ends with `operatorGuard`; every engine start
// carries the real-adapter switch (`hostDeployable`, `realAdapterStarts`).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { requestTick } from './harness/runs.mjs';
import { CGROUP_ROOT, procsOf } from './harness/sandbox/cgroup.mjs';
import { attemptIntent, attemptsOf, candidateRow, deploy, operationsOf, requestDeployment, roundsOf, verificationsOf } from './harness/deploy/kernel.mjs';
import { endCase, endEnvironment, hostDeployable, hostEnvironment, hostUntil, newestOperation, operatorGuard, settleRound, ticksUntil, unitShow } from './harness/deploy/host.mjs';
import { answerOn, barriersOf, killAt, killOwnEngine, openOn, optionKeys, readsOf, releaseBarrier, armBarrier, waitingAt, startAgain } from './harness/deploy/recover.mjs';
import { withStore } from './harness/store.mjs';

const POLICY = Object.freeze({ deploy_auto_retries_max: 0, service_memory_max: 67108864 });

// The processes in a unit's cgroup running the configured start command
// (the application), read from the host; [] when the unit is not loaded.
function applicationsIn(unit) {
  const show = unitShow(unit, ['LoadState', 'ControlGroup']);
  if (show?.LoadState !== 'loaded' || !show.ControlGroup) return [];
  let pids = [];
  try {
    pids = procsOf(`${CGROUP_ROOT}${show.ControlGroup}`);
  } catch {
    return [];
  }
  return pids.filter((pid) => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes('server.js');
    } catch {
      return false;
    }
  });
}

const launchGrants = (home, attempt) => eventsOfType(home, 'deploy.launch_authorized').filter((e) => e.subject?.attempt === attempt);
const noVerificationPassed = (ctx, op) => {
  for (const r of roundsOf(ctx.fx.home, op.id)) for (const v of verificationsOf(ctx.fx.home, r.id)) assert.notEqual(v.outcome, 'verified', 'no verification passes');
  assert.equal(candidateRow(ctx.fx.home, ctx.candidate.id).progress, 'developing', 'the candidate stays developing');
};

// The open decision on an operation (a blocker or rollout_partial), once raised.
const openDecision = (ctx, op) => ticksUntil(ctx.fx, ctx.project, () => [...openOn(ctx.fx.home, 'blocker', op.id), ...openOn(ctx.fx.home, 'rollout_partial', op.id)][0], { what: `a decision on ${op.id}` });

// The preempting teardown through the decision's `teardown` option, finalized.
async function teardownThrough(ctx, env, row) {
  await answerOn(ctx, row, 'teardown');
  return ticksUntil(ctx.fx, ctx.project, () => operationsOf(ctx.fx.home, ctx.project, 'teardown').filter((o) => o.target?.environment === env.id && o.finalized_at).at(-1), { what: 'the teardown to be finalized' });
}

describe('M321 (b), (e), (g) the engine killed during a real service\'s launch', () => {
  const shared = sharedFixture();
  let guard;
  let ctx;
  before(async () => {
    guard = operatorGuard();
    ctx = await hostDeployable(shared.context, guard, { policy: POLICY });
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('at placement: the next incarnation closes the launch before accepting any request; the earlier incarnation\'s launcher is refused and runs nothing; never absent while its unit is loaded, never applied', async () => {
    const env = await hostEnvironment(ctx, 'placed');
    try {
      await armBarrier(ctx.fx.engine, 'launcher.before_authorization', 'pause');
      await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
      for (let i = 0; i < 6 && !(await barriersOf(ctx.fx.engine)).some((b) => b.name === 'launcher.before_authorization' && b.state === 'waiting'); i++) {
        await requestTick(ctx.fx.engine, ctx.project);
        await new Promise((r) => setTimeout(r, 2000));
      }
      await waitingAt(ctx.fx.engine, 'launcher.before_authorization');
      const op = newestOperation(ctx, env);
      const [attempt] = attemptsOf(ctx.fx.home, op.id);
      const unit = attemptIntent(ctx.fx.home, attempt.id).create_units[0];
      assert.equal(unitShow(unit, ['LoadState'])?.LoadState, 'loaded', 'the fixture is live: the unit exists, its launcher placed and waiting');

      // SIGKILL to this test's own engine child (killOwnEngine reads its /proc first).
      await killOwnEngine(ctx.fx);
      await startAgain(ctx);
      const closed = attemptsOf(ctx.fx.home, op.id)[0];
      assert.equal(closed.launch_state, 'closed', 'the earlier incarnation\'s launch is closed before the new one accepts any launch request (D4 §9.2)');
      await waitingAt(ctx.fx.engine, 'launcher.before_authorization', { timeoutMs: 30_000 });
      await releaseBarrier(ctx.fx.engine, 'launcher.before_authorization');

      // While the unit is loaded: no application in it, and no read absent (D4-O04).
      await hostUntil(() => {
        assert.deepEqual(applicationsIn(unit), [], 'the refused launcher runs nothing of the application');
        const loaded = unitShow(unit, ['LoadState'])?.LoadState === 'loaded';
        if (loaded) assert.ok(!readsOf(attemptsOf(ctx.fx.home, op.id)[0]).includes('absent'), 'no read is absent while the unit is loaded');
        return !loaded;
      }, { timeoutMs: 120_000, what: 'the refused launcher\'s unit to end' });
      assert.deepEqual(launchGrants(ctx.fx.home, attempt.id), [], 'no grant for the attempt in either incarnation');
      assert.equal(attemptsOf(ctx.fx.home, op.id)[0].app_instance ?? null, null, 'no application instance');
      const settled = await ticksUntil(ctx.fx, ctx.project, () => {
        const a = attemptsOf(ctx.fx.home, op.id)[0];
        return readsOf(a).includes('absent') ? a : undefined;
      }, { what: 'a read after the unit ended to establish absence' });
      assert.ok(!readsOf(settled).includes('applied'), 'never applied');
      noVerificationPassed(ctx, op);
    } finally {
      await endCase(ctx, env);
    }
  });

  test('at the grant: the launcher has no reply and runs nothing; the read is never applied or absent (a launch was granted); no verification passes', async () => {
    const env = await hostEnvironment(ctx, 'granted');
    try {
      await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
      await killAt(ctx.fx, ctx.project, 'deploy.launch_granted');
      const op = newestOperation(ctx, env);
      const [attempt] = attemptsOf(ctx.fx.home, op.id);
      assert.ok(attempt.init_instance, 'the fixture is live: the grant is recorded (the init)');
      const unit = attemptIntent(ctx.fx.home, attempt.id).create_units[0];
      await startAgain(ctx);
      await hostUntil(() => {
        assert.deepEqual(applicationsIn(unit), [], 'nothing of the application runs');
        return unitShow(unit, ['LoadState'])?.LoadState !== 'loaded';
      }, { timeoutMs: 120_000, what: 'the launcher with no reply to end' });
      const a = await ticksUntil(ctx.fx, ctx.project, () => {
        const x = attemptsOf(ctx.fx.home, op.id)[0];
        return x.reconciliation_reads.length > 0 ? x : undefined;
      }, { what: 'the read after the restart' });
      assert.ok(!readsOf(a).some((r) => r === 'applied' || r === 'absent'), `a granted launch whose unit is gone is neither applied nor absent (D4 §2.4) (${JSON.stringify(readsOf(a))})`);
      assert.equal(a.app_instance ?? null, null);
      noVerificationPassed(ctx, op);
      await teardownThrough(ctx, env, await openDecision(ctx, op));
    } finally {
      await endCase(ctx, env);
    }
  });

  test('CD3, between the grant and the init\'s started: unknown and a blocker offering teardown; the teardown removes exactly the attempt\'s unit; a new request makes a new authorization; nothing enumerated is recorded as the instance', async () => {
    const env = await hostEnvironment(ctx, 'started');
    try {
      const first = await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
      await killAt(ctx.fx, ctx.project, 'init.app_started');
      const op = newestOperation(ctx, env);
      const [attempt] = attemptsOf(ctx.fx.home, op.id);
      assert.equal(attempt.app_instance ?? null, null, 'the fixture is live: no application instance recorded');
      const unit = attemptIntent(ctx.fx.home, attempt.id).create_units[0];
      await startAgain(ctx);
      assert.equal(applicationsIn(unit).length, 1, 'host-read: the application runs, surviving the engine (D4 §9.2)');
      const a = await ticksUntil(ctx.fx, ctx.project, () => {
        const x = attemptsOf(ctx.fx.home, op.id)[0];
        return x.reconciliation_reads.length > 0 ? x : undefined;
      }, { what: 'the read after the restart' });
      assert.equal(readsOf(a)[0], 'unknown', `no instance recorded: unknown (CD3 (a)) (${JSON.stringify(readsOf(a))})`);
      const blocker = await ticksUntil(ctx.fx, ctx.project, () => openOn(ctx.fx.home, 'blocker', op.id)[0], { what: 'the blocker' });
      assert.ok(optionKeys(blocker).includes('teardown'), `the blocker offers the preempting teardown (${JSON.stringify(optionKeys(blocker))})`);
      noVerificationPassed(ctx, op);
      const down = await teardownThrough(ctx, env, blocker);
      const intent = withStore(ctx.fx.home, (db) => db.prepare('SELECT * FROM "attempt_intents" WHERE "operation" = ?').all(down.id));
      assert.ok(JSON.stringify(intent).includes(unit), 'the teardown\'s intent names the attempt\'s unit');
      assert.equal(unitShow(unit, ['LoadState'])?.LoadState, 'not-found', 'host-read: the unit is gone');
      assert.deepEqual(applicationsIn(unit), [], 'and the application with it');
      assert.equal(attemptsOf(ctx.fx.home, op.id)[0].app_instance ?? null, null, 'nothing enumerated is recorded as the instance (CD3; E110)');
      const next = await requestDeployment(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
      assert.equal(next.status, 201, `a new request makes a new authorization (→ ${next.status} ${next.text})`);
      assert.notEqual(next.body.authorization.id, first.authorization.id);
      const op2 = await ticksUntil(ctx.fx, ctx.project, () => (newestOperation(ctx, env)?.id !== op.id ? newestOperation(ctx, env) : undefined), { what: 'the new deploy' });
      await settleRound(ctx, env, op2, { plan: { get: ['/hello'], exit: 1 } });
    } finally {
      await endCase(ctx, env);
    }
  });
});
