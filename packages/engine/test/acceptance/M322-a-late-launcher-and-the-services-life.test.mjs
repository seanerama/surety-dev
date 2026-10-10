// M322, a late launcher, and the service's life (slice 26; sandbox lane).
// M4 plan §3.4 M322 (a) to (d), and M325 (e)'s domain of unknown
// termination; D4-O04, D4-T06, D4-O13; D4 §§2.4, 4.7, 9.2, A.4; E110, E111;
// SEAM.md §§125, 256 to 259, 262, 273 to 278.
//
// On the real `local_service` adapter:
//   (a) a launcher held before it asks for its grant while the adapter's
//       effect call passes `adapter_effect_deadline` (the caller cancelled
//       the create), then the engine killed and started again (its launch
//       closed): while the unit is loaded no read is `absent` and nothing is
//       retried, the lease held (the effect not quiescent); released, the
//       launcher is refused and runs nothing; after the unit ends and a new
//       read, `absent`;
//   (b) the application's natural exit with a descendant holding its port and
//       its output closed (the fixture's `detach`), a refused setup and a
//       failed `exec` (the faults `service_setup_refused`,
//       `service_exec_failed`): each domain `terminated` with closure
//       observed (from `launched`, or from `allocated`), the exit recorded
//       (`deploy.service_exited`, `app_exit`) no later than the closure, the
//       descendant ended in it, never restarted;
//   (c) a termination not observed (the fault `service_closure_unread` at a
//       teardown): `quarantined`, keeping its reservation and conferring no
//       launch, then `terminated` once closure is observed (M325 (e)'s
//       "unknown domain keeps its quarantine and reservation and confers
//       nothing");
//   (d) the unit restarted by the test (exact name, after the containment
//       read): the grant spent, the launcher refused, nothing of the
//       application runs; and the manager never restarts it by itself
//       (`Restart=no`, no restart counted after the natural exit of (b)).
// deploy_auto_retries_max is 0, so no retry makes a second unit;
// `adapter_effect_deadline` is 10 s, its minimum, for (a).
//
// SAFETY (BS4 §4.1; E64; SEAM.md §§257, 258, 274). Every unit is the
// engine's, under this test's home's prefix. The fixture service's `detach`
// is released only after `assertServiceContained` has read its containment
// from the host and runs only when the service reads itself contained. The
// test restarts a unit only by its exact name, after the same read
// (`restartOwnUnit`). The engine is killed only by `killOwnEngine` (SIGKILL
// through the ChildProcess handle the harness spawned, after reading from
// /proc that it is this home's engine). Nothing else is signalled. Every
// environment is ended in `finally`; the file ends with `operatorGuard`.
// This is the slice's last file (BS4 §4.1 rule 9).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { requestTick } from './harness/runs.mjs';
import { CGROUP_ROOT, procsOf } from './harness/sandbox/cgroup.mjs';
import { attemptIntent, attemptsOf, deploy, environmentLeases, operationsOf, teardown } from './harness/deploy/kernel.mjs';
import {
  armDeployFault,
  assertServiceContained,
  deployHeld,
  endEnvironment,
  hostDeployable,
  hostEnvironment,
  hostUntil,
  newestOperation,
  operatorGuard,
  procInstance,
  releaseCheck,
  restartOwnUnit,
  serviceDomainOf,
  serviceOf,
  settleRound,
  ticksUntil,
  unitShow,
  verificationOf,
} from './harness/deploy/host.mjs';
import { answerOn, armBarrier, barriersOf, killOwnEngine, leaseHeld, openOn, readsOf, releaseBarrier, waitingAt } from './harness/deploy/recover.mjs';

const POLICY = Object.freeze({ deploy_auto_retries_max: 0, service_memory_max: 67108864 });
const ENGINE = Object.freeze({ adapter_effect_deadline: 10 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (iso) => Date.parse(iso);

// Host pids in a unit's cgroup whose command line includes `marker`; [] when the unit is not loaded.
function membersWith(unit, marker) {
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
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').some((a) => a.includes(marker));
    } catch {
      return false;
    }
  });
}

const grantsOf = (home, attempt) => eventsOfType(home, 'deploy.launch_authorized').filter((e) => e.subject?.attempt === attempt);
const gone = (instance) => {
  const now = procInstance(instance.pid);
  return now === null || now.start_time !== instance.start_time;
};

// The service domain of an attempt once `done(domain)` holds.
const domainWhen = (ctx, attempt, done, what) =>
  ticksUntil(ctx.fx, ctx.project, () => {
    const d = serviceDomainOf(ctx.fx.home, attempt);
    return d && done(d) ? d : undefined;
  }, { timeoutMs: 180_000, what });

// A domain that ended by a legal ending: terminated, closure observed (the
// unit's cgroup gone from the host), never restarted (one grant at most, no
// application running in the unit).
async function assertLegalEnding(ctx, attempt, unit, what) {
  const domain = await domainWhen(ctx, attempt.id, (d) => d.state === 'terminated', `${what}: the service domain to be terminated`);
  assert.ok(domain.terminated_at, `${what}: its termination is recorded`);
  await hostUntil(() => unitShow(unit, ['LoadState'])?.LoadState !== 'loaded', { timeoutMs: 60_000, what: `${what}: the unit to be gone` });
  assert.ok(grantsOf(ctx.fx.home, attempt.id).length <= 1, `${what}: never launched again`);
  return domain;
}

describe('M322 a late launcher, and the service\'s life, on real units', () => {
  const shared = sharedFixture();
  let guard;
  let ctx;
  before(async () => {
    guard = operatorGuard();
    ctx = await hostDeployable(shared.context, guard, { engineConfig: ENGINE, policy: POLICY });
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('(a) a launcher asking after its attempt\'s launch was closed (the create cancelled at its deadline, then a restart): never absent nor retried while its unit is loaded, the lease held; it runs nothing; absent after the unit ends and a new read', async () => {
    const env = await hostEnvironment(ctx, 'late');
    try {
      await armBarrier(ctx.fx.engine, 'launcher.before_authorization', 'pause');
      await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
      for (let i = 0; i < 6 && !(await barriersOf(ctx.fx.engine)).some((b) => b.name === 'launcher.before_authorization' && b.state === 'waiting'); i++) {
        await requestTick(ctx.fx.engine, ctx.project);
        await sleep(2000);
      }
      await waitingAt(ctx.fx.engine, 'launcher.before_authorization');
      const op = newestOperation(ctx, env);
      const [attempt] = attemptsOf(ctx.fx.home, op.id);
      const unit = attemptIntent(ctx.fx.home, attempt.id).create_units[0];
      // The effect's call passes adapter_effect_deadline with the launcher still held: the create is cancelled.
      const cancelled = await ticksUntil(ctx.fx, ctx.project, () => {
        const a = attemptsOf(ctx.fx.home, op.id)[0];
        return a.status !== 'started' ? a : undefined;
      }, { timeoutMs: 120_000, what: 'the effect to pass its deadline' });
      assert.equal(cancelled.status, 'ambiguous', `the cancelled create is ambiguous (D4 §2.1) (${cancelled.status})`);
      assert.equal(unitShow(unit, ['LoadState'])?.LoadState, 'loaded', 'the fixture is live: the unit is still loaded, its launcher held');
      await ticksUntil(ctx.fx, ctx.project, () => (attemptsOf(ctx.fx.home, op.id)[0].reconciliation_reads.length > 0 ? true : undefined), { what: 'a read after the cancellation' });
      assert.ok(!readsOf(attemptsOf(ctx.fx.home, op.id)[0]).includes('absent'), 'a loaded unit whose launcher can still ask is never absent (D4 §2.4)');
      assert.equal(attemptsOf(ctx.fx.home, op.id).length, 1, 'nothing retried');
      assert.ok(leaseHeld(ctx.fx.home, env.id), 'the effect not quiescent: the lease held (D4 §4.7)');

      // SIGKILL to this test's own engine child (killOwnEngine reads its /proc first); the next incarnation closes the launch.
      await killOwnEngine(ctx.fx);
      await ctx.fx.start();
      assert.equal(attemptsOf(ctx.fx.home, op.id)[0].launch_state, 'closed', 'the launch is closed before any request is accepted');
      await waitingAt(ctx.fx.engine, 'launcher.before_authorization', { timeoutMs: 30_000 });
      await releaseBarrier(ctx.fx.engine, 'launcher.before_authorization');
      await hostUntil(() => {
        assert.deepEqual(membersWith(unit, 'server.js'), [], 'the late launcher runs nothing of the application');
        const loaded = unitShow(unit, ['LoadState'])?.LoadState === 'loaded';
        if (loaded) {
          assert.ok(!readsOf(attemptsOf(ctx.fx.home, op.id)[0]).includes('absent'), 'no read is absent while the unit is loaded (loaded, failed or inactive)');
          assert.equal(attemptsOf(ctx.fx.home, op.id).length, 1, 'and no retry');
        }
        return !loaded;
      }, { timeoutMs: 120_000, what: 'the refused launcher\'s unit to end' });
      assert.deepEqual(grantsOf(ctx.fx.home, attempt.id), [], 'no grant in either incarnation');
      const settled = await ticksUntil(ctx.fx, ctx.project, () => {
        const a = attemptsOf(ctx.fx.home, op.id)[0];
        return readsOf(a).includes('absent') ? a : undefined;
      }, { what: 'bounded cleanup and a new read to establish absence' });
      assert.equal(settled.status, 'reconciled_absent');
      await ticksUntil(ctx.fx, ctx.project, () => (!leaseHeld(ctx.fx.home, env.id) ? true : undefined), { what: 'the lease to be released after quiescence' });
      const [lease] = environmentLeases(ctx.fx.home, env.id);
      const absentAt = settled.reconciliation_reads.find((r) => r.result === 'absent').at;
      assert.ok(ms(lease.released_at) >= ms(absentAt), 'released only after the read that established absence');
    } finally {
      await endEnvironment(ctx, env);
    }
  });

  test('(b) natural exit with a descendant holding the port, its output closed: terminated with closure observed, the exit recorded no later than the closure, the descendant ended, never restarted; (d) the manager never restarts it', async () => {
    const env = await hostEnvironment(ctx, 'exits');
    try {
      const { op, svc } = await deployHeld(ctx, env);
      const before = { ...svc.app };
      assert.equal(unitShow(svc.unit, ['Restart'])?.Restart, 'no', 'host-read: automatic restart is disabled (D4 §9.2)');
      releaseCheck(ctx, svc, { get: ['/act/detach'], exit: 1 });
      const child = await hostUntil(() => membersWith(svc.unit, '--detached-child')[0], { what: 'the descendant to be listening' });
      const childInstance = procInstance(child);
      await hostUntil(() => gone(before), { timeoutMs: 60_000, what: 'the application to exit' });
      await verificationOf(ctx, op);
      const domain = await assertLegalEnding(ctx, svc.attempt, svc.unit, 'the natural exit');
      const exit = typeof domain.app_exit === 'string' ? JSON.parse(domain.app_exit) : domain.app_exit;
      assert.ok(exit?.at, `the exit is recorded on the domain (D4 A.3 app_exit) (${JSON.stringify(domain.app_exit)})`);
      assert.ok(ms(exit.at) <= ms(domain.terminated_at), 'no later than the closure');
      const exited = eventsOfType(ctx.fx.home, 'deploy.service_exited').filter((e) => e.subject?.attempt === svc.attempt.id);
      assert.equal(exited.length, 1, 'deploy.service_exited, once');
      assert.ok(childInstance === null || gone(childInstance), 'the descendant ended in the closure');
      assert.equal(grantsOf(ctx.fx.home, svc.attempt.id).length, 1, 'one grant: never restarted');
    } finally {
      await endEnvironment(ctx, env);
    }
  });

  test('(b) a refused setup: the domain allocated → terminated with closure observed; never launched, nothing of the application ran', async () => {
    const env = await hostEnvironment(ctx, 'nosetup');
    try {
      await armDeployFault(ctx, env, 'service_setup_refused');
      await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
      const op = await ticksUntil(ctx.fx, ctx.project, () => newestOperation(ctx, env), { what: 'the deploy' });
      const attempt = await ticksUntil(ctx.fx, ctx.project, () => attemptsOf(ctx.fx.home, op.id)[0], { what: 'the attempt' });
      const unit = attemptIntent(ctx.fx.home, attempt.id).create_units[0];
      const domain = await assertLegalEnding(ctx, attempt, unit, 'the refused setup');
      assert.equal(domain.launch_authorized_at ?? null, null, 'never authorized: terminated directly from allocated');
      assert.deepEqual(grantsOf(ctx.fx.home, attempt.id), [], 'no grant');
      assert.equal(attemptsOf(ctx.fx.home, op.id)[0].app_instance ?? null, null, 'no application instance');
    } finally {
      await endEnvironment(ctx, env);
    }
  });

  test('(b) a failed exec: launched → terminated with closure observed; no application instance; never restarted', async () => {
    const env = await hostEnvironment(ctx, 'noexec');
    try {
      await armDeployFault(ctx, env, 'service_exec_failed');
      await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
      const op = await ticksUntil(ctx.fx, ctx.project, () => newestOperation(ctx, env), { what: 'the deploy' });
      const attempt = await ticksUntil(ctx.fx, ctx.project, () => attemptsOf(ctx.fx.home, op.id)[0], { what: 'the attempt' });
      const unit = attemptIntent(ctx.fx.home, attempt.id).create_units[0];
      await assertLegalEnding(ctx, attempt, unit, 'the failed exec');
      assert.equal(grantsOf(ctx.fx.home, attempt.id).length, 1, 'launched once (the grant), never again');
      assert.equal(attemptsOf(ctx.fx.home, op.id)[0].app_instance ?? null, null, 'no application instance');
      const row = await ticksUntil(ctx.fx, ctx.project, () => [...openOn(ctx.fx.home, 'rollout_partial', op.id), ...openOn(ctx.fx.home, 'blocker', op.id)][0], { what: 'a decision on the attempt' });
      await answerOn(ctx, row, row.kind === 'rollout_partial' ? 'abandon' : 'teardown');
    } finally {
      await endEnvironment(ctx, env);
    }
  });

  test('(c) a termination not observed at a teardown: quarantined, keeping its reservation and conferring no launch; then terminated once closure is observed', async () => {
    const env = await hostEnvironment(ctx, 'quarantine');
    try {
      await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
      const op = await ticksUntil(ctx.fx, ctx.project, () => newestOperation(ctx, env), { what: 'the deploy' });
      await settleRound(ctx, env, op, { plan: { get: ['/hello'], exit: 1 } });
      const svc = serviceOf(ctx, env, op);
      await armDeployFault(ctx, env, 'service_closure_unread');
      const asked = await teardown(ctx.fx.engine, ctx.project, env.name);
      assert.ok(asked.status >= 200 && asked.status < 300, `the teardown is accepted (→ ${asked.status} ${asked.text})`);
      const quarantined = await domainWhen(ctx, svc.attempt.id, (d) => d.state === 'quarantined' || d.state === 'terminated', 'the domain to be quarantined');
      assert.equal(quarantined.state, 'quarantined', `a termination not observed is quarantined, never terminated (D4 §9.2) (${quarantined.state})`);
      assert.ok(quarantined.reservation?.memory && quarantined.reservation?.check_capacity, `it keeps its reservation (D4 §4.7) (${JSON.stringify(quarantined.reservation)})`);
      assert.equal(quarantined.launch_state, 'closed', 'it confers no launch');
      const down = operationsOf(ctx.fx.home, ctx.project, 'teardown').filter((o) => o.target?.environment === env.id).at(-1);
      assert.ok(!['succeeded'].includes(attemptsOf(ctx.fx.home, down.id)[0]?.status), 'the teardown is not applied while the termination is unobserved');
      const terminated = await domainWhen(ctx, svc.attempt.id, (d) => d.state === 'terminated', 'closure to be observed later');
      assert.ok(terminated.terminated_at, 'quarantined → terminated');
    } finally {
      await endEnvironment(ctx, env);
    }
  });

  test('(d) the unit restarted by the test (exact name): the grant spent, the launcher refused, nothing of the application runs', async () => {
    const env = await hostEnvironment(ctx, 'restart');
    try {
      const { op, svc } = await deployHeld(ctx, env);
      releaseCheck(ctx, svc, { get: ['/hello'], exit: 1 });
      await verificationOf(ctx, op);
      const before = { ...svc.app };
      const invocation = unitShow(svc.unit, ['InvocationID']).InvocationID;
      assertServiceContained(ctx, svc, 'before the restart');
      assert.equal(restartOwnUnit(ctx, svc), 0, 'the test restarts its own unit by exact name');
      await hostUntil(() => (unitShow(svc.unit, ['InvocationID'])?.InvocationID ?? invocation) !== invocation || unitShow(svc.unit, ['LoadState'])?.LoadState !== 'loaded', { what: 'a new invocation of the unit' });
      await sleep(5000);
      assert.deepEqual(membersWith(svc.unit, 'server.js'), [], 'nothing of the application runs in the restarted unit');
      assert.ok(gone(before), 'the original application is gone');
      assert.equal(grantsOf(ctx.fx.home, svc.attempt.id).length, 1, 'no second grant: the launch is single-use');
      const after = attemptsOf(ctx.fx.home, op.id).at(-1).app_instance;
      assert.deepEqual([after.pid, after.start_time], [before.pid, before.start_time], 'the recorded instance is unchanged');
    } finally {
      await endEnvironment(ctx, env);
    }
  });
});
