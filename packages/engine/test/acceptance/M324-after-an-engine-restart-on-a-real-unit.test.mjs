// M324, after an engine restart, on real units (slice 26; sandbox lane).
// M4 plan §3.4 M324 (a), (b), (d), (e), (f), and M319 (c)'s dispatch-blocking
// form (deferred here by slice 25); D4-T07, D4-T08, D4-T09; D4 §§4.3, 4.7,
// 5.3, 7.3, 9.2; J2; E110, E116, E126; SEAM.md §§256 to 259, 268, 271 to 278.
//
// On the real `local_service` adapter:
//   (a), (f) the engine killed while a role domain (another project's run), a
//       check domain (a held post-deploy check) and a service domain are all
//       populated: after the restart the role and check domains are closed
//       (D2 §3.3, D3; M112 to M118 and M216 unchanged) and only the service
//       survives (J2). It runs, read through the manager and /proc (its
//       rounds' identity reads name its original instance); its supervision
//       is `unknown` (the environment read); the interrupted round ends
//       `unknown` naming `supervision`; a new round's check against it is
//       not run, `redaction_unavailable`, reaching nothing through the link;
//       no verification passes. A redeploy makes supervision `attached` and
//       the refusal ends (its round's check runs).
//   (b) the control channel dropped without a restart (the fault
//       `control_channel_dropped`): the same.
//   (d) recovery's accounting: after a restart with a surviving service, its
//       reservation (one check's capacity kept free, E126) is counted before
//       any admission, so of two role dispatches of another project that
//       would otherwise both fit, one is held `resource_envelope`; the
//       teardown of the survivor frees it (M319 (c)'s dispatch-blocking).
//   (e) a store restored from a backup whose service domain names another
//       cgroup than the unit's: deployment to the environment is refused
//       before its effect (`unknown_ownership`), the unit listed and never
//       adopted or stopped, and the affected admission held.
// Pinned elsewhere: (c), a launch request of the earlier incarnation refused
// before recovery visits its row, is M321's placement case
// (M321-kills-with-a-real-service); (e) with no intent at all is the kernel
// file M324-a-restored-store-on-the-scripted-target. Deferred: the refusal
// of a survivor's logs and relay (their routes are slice 27's and 28's;
// M334 (d) pins them after a restart).
//
// SAFETY (BS4 §4.1; E64; SEAM.md §§257, 274, 278). The engine is killed only
// by `killOwnEngine` (SIGKILL through the ChildProcess handle the harness
// spawned, after reading from /proc that it is this home's engine), or
// stopped in order before a store command. Every unit is the engine's,
// under this test's home's prefix; the test acts on no unit (the engine's
// teardown removes each). The second project's roles are scripted role
// programs held in their own domains. Every environment and run is ended
// in `finally`; the file ends with `operatorGuard`; every engine start
// carries the real-adapter switch.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { CONTRACT } from './harness/fixtures.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { addGitProject, addItem } from './harness/gitruns.mjs';
import { readFileSync } from 'node:fs';
import { recordFile, recordRow } from './harness/records.mjs';
import { runsOf, stopRun, tick, waitForRunState } from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';
import { domainOf, roleHolding } from './harness/sandbox/lane.mjs';
import { attemptsOf, deploy, environmentRead, operationsOf } from './harness/deploy/kernel.mjs';
import {
  armDeployFault,
  domainRowOf,
  endCase, endEnvironment,
  heldCheck,
  hostDeployable,
  hostEnvironment,
  newestOperation,
  operatorGuard,
  postDeployOf,
  procInstance,
  releaseCheck,
  serviceDomainOf,
  serviceLinkLogs,
  serviceOf,
  settleRound,
  teardownOnHost,
  ticksUntil,
  unitShow,
} from './harness/deploy/host.mjs';
import { roundsOf, verificationsOf, verifyAgain, workEntry } from './harness/deploy/rounds.mjs';
import { backupNow, killOwnEngine, restoreInPlace, storeWrite, unitsNamedIn, startAgain } from './harness/deploy/recover.mjs';
import { withStore } from './harness/store.mjs';

const ENGINE = Object.freeze({ max_concurrent_domains: 2, domain_memory_max: CONTRACT.engine.domain_memory_max.min });
const POLICY = Object.freeze({ deploy_auto_retries_max: 0, service_memory_max: 67108864 });
const EXIT_1 = Object.freeze({ get: ['/hello'], exit: 1 });

const resultOf = (home, execution) => withStore(home, (db) => db.prepare('SELECT * FROM "check_results" WHERE "execution" = ? ORDER BY rowid DESC').get(execution));
const gone = (instance) => instance && (procInstance(instance.pid) === null || procInstance(instance.pid).start_time !== instance.start_time);

describe('M324 after an engine restart, on real units', () => {
  const shared = sharedFixture();
  let guard;
  let ctx;
  const others = [];
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

  // A service of `name` deployed and its first round settled failed (the candidate stays developing).
  async function deployed(name) {
    const env = await hostEnvironment(ctx, name);
    await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
    const op = await ticksUntil(ctx.fx, ctx.project, () => newestOperation(ctx, env), { what: `the deploy of ${name}` });
    await settleRound(ctx, env, op, { plan: EXIT_1 });
    return { env, op, svc: serviceOf(ctx, env, op) };
  }

  // A round of `op` registered and ended; its row and its executions.
  async function roundOn(env, op) {
    const round = await verifyAgain(ctx.fx.engine, ctx.project, op.id);
    const row = await ticksUntil(ctx.fx, ctx.project, () => verificationsOf(ctx.fx.home, round.id)[0], { what: `the row of round ${round.round}` });
    return { round, row, executions: postDeployOf(ctx, env).filter((x) => x.deployment?.round === round.id) };
  }

  // The refusal of a survivor's checks: not run, redaction_unavailable, nothing through the link; the round unknown naming supervision.
  function assertRefusedRound({ row, executions }, svc) {
    assert.equal(row.outcome, 'unknown', `no verification passes on a service of unknown supervision (${row.outcome})`);
    assert.ok((row.missing ?? []).some((m) => m.kind === 'supervision'), `missing names supervision (${JSON.stringify(row.missing)})`);
    assert.ok(executions.length > 0, 'the round registers its required check, which is then refused, not run (SEAM.md §278); a round with no execution would make the refusal unread');
    for (const x of executions) {
      const result = resultOf(ctx.fx.home, x.id);
      assert.ok(result, `the check ${x.id} has a result`);
      assert.deepEqual([result.execution_established, result.not_run_reason], [0, 'redaction_unavailable'], `the check is refused, not run: redaction_unavailable (D4 §§5.1, 7.3; E116) (${JSON.stringify(result)})`);
      assert.ok(!serviceLinkLogs(ctx.fx.home, ctx.project).some((l) => l.entries.some((e) => e.execution === x.id)), 'and reaches nothing through the link');
    }
    const first = (row.identity_reads ?? []).find((r) => r.bracket === 'first');
    if (first && first.instance !== 'unread') assert.equal(first.instance?.pid, svc.app.pid, 'the survivor is read through the manager and /proc as its original instance');
  }

  async function newOtherProject() {
    const other = await addGitProject(ctx.fx, { tier: 'T1' });
    others.push(other);
    return other;
  }

  test('(a), (f) a restart with a role, a check and a service domain populated: only the service survives, its supervision unknown; its rounds unknown, its checks refused redaction_unavailable; a redeploy attaches it and the refusal ends', async () => {
    const d = await deployed('survive');
    const other = await newOtherProject();
    const role = await roleHolding(ctx.fx, other.id, await addItem(ctx.fx, other.id, 'fix'));
    let stopped = false;
    try {
      const interrupted = await verifyAgain(ctx.fx.engine, ctx.project, d.op.id);
      const held = await ticksUntil(ctx.fx, ctx.project, () => heldCheck(ctx, d.env), { what: 'the new round\'s check to hold in its domain' });
      const checkMember = procInstance(held.member.pid);
      const roleMember = procInstance(role.member.pid);
      assert.ok(checkMember && roleMember, 'the fixture is live: a role, a check and a service domain are populated');

      // SIGKILL to this test's own engine child (killOwnEngine reads its /proc first).
      await killOwnEngine(ctx.fx);
      await startAgain(ctx);
      await tick(ctx.fx.engine, ctx.project, { rounds: 2 });

      // (f) J2: role and check domains closed as before; only the service domain survives.
      const roleDomain = await ticksUntil(ctx.fx, other.id, () => {
        const dom = domainOf(ctx.fx.home, role.run.id);
        return dom && dom.status === 'terminated' ? dom : undefined;
      }, { what: 'the role domain to be closed by recovery' });
      assert.equal(roleDomain.status, 'terminated');
      assert.ok(gone(roleMember), 'the role\'s process is gone');
      stopped = true;
      const checkDomain = await ticksUntil(ctx.fx, ctx.project, () => {
        const dom = domainRowOf(ctx.fx.home, held.domain.id);
        return dom && dom.status === 'terminated' ? dom : undefined;
      }, { what: 'the check domain to be closed by recovery' });
      assert.equal(checkDomain.status, 'terminated');
      assert.ok(gone(checkMember), 'the check\'s process is gone');
      assert.equal(unitShow(d.svc.unit, ['ActiveState'])?.ActiveState, 'active', 'host-read: the service\'s unit runs');
      assert.ok(!gone(d.svc.app), 'host-read: its original application runs');
      assert.notEqual(serviceDomainOf(ctx.fx.home, d.svc.attempt.id).state, 'terminated', 'the service domain is not closed by recovery (J2)');

      // (a) supervision unknown; the interrupted round unknown; a new round refused.
      const read = await environmentRead(ctx.fx.engine, ctx.project, d.env.name);
      assert.equal(read.supervision, 'unknown', `supervision unknown after the restart (E110) (${JSON.stringify(read)})`);
      assert.ok((read.conditions ?? []).includes('supervision_unknown'));
      const row2 = await ticksUntil(ctx.fx, ctx.project, () => verificationsOf(ctx.fx.home, interrupted.id)[0], { what: 'the interrupted round\'s row' });
      assert.equal(row2.outcome, 'unknown', 'the round open at the kill ends unknown');
      assert.ok((row2.missing ?? []).some((m) => m.kind === 'supervision'));
      assertRefusedRound(await roundOn(d.env, d.op), d.svc);

      // A redeploy: supervision attached, and its round's check runs.
      await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, d.env.name);
      const op2 = await ticksUntil(ctx.fx, ctx.project, () => (newestOperation(ctx, d.env)?.id !== d.op.id ? newestOperation(ctx, d.env) : undefined), { what: 'the redeploy' });
      const held2 = await ticksUntil(ctx.fx, ctx.project, () => {
        const h = heldCheck(ctx, d.env);
        return h && h.execution.deployment?.operation === op2.id ? h : undefined;
      }, { what: 'the redeploy\'s check to run' });
      assert.equal((await environmentRead(ctx.fx.engine, ctx.project, d.env.name)).supervision, 'attached', 'after the redeploy supervision is attached');
      releaseCheck(ctx, serviceOf(ctx, d.env, op2), EXIT_1);
      const row = await ticksUntil(ctx.fx, ctx.project, () => verificationsOf(ctx.fx.home, roundsOf(ctx.fx.home, op2.id).at(-1)?.id ?? '')[0], { what: 'the redeploy\'s row' });
      assert.equal(resultOf(ctx.fx.home, held2.execution.id)?.execution_established, 1, 'the check ran: the refusal has ended');
      assert.notEqual(row.outcome, 'unknown');
    } finally {
      if (!stopped) await stopRun(ctx.fx.engine, other.id, role.run.id).catch(() => undefined);
      await waitForRunState(ctx.fx.home, role.run.id, 'ended', { timeoutMs: 60_000 }).catch(() => undefined);
      await endCase(ctx, d.env);
    }
  });

  test('(b) the control channel dropped without a restart: supervision unknown; the next round\'s check refused redaction_unavailable; nothing verified', async () => {
    const d = await deployed('dropped');
    try {
      await armDeployFault(ctx, d.env, 'control_channel_dropped');
      await ticksUntil(ctx.fx, ctx.project, async () => ((await environmentRead(ctx.fx.engine, ctx.project, d.env.name)).supervision === 'unknown' ? true : undefined), { what: 'supervision to read unknown' });
      assertRefusedRound(await roundOn(d.env, d.op), d.svc);
    } finally {
      await endCase(ctx, d.env);
    }
  });

  test('(d) recovery accounts for a surviving service before any admission: of two role dispatches that would otherwise fit, one is held resource_envelope until the survivor is torn down (M319 (c))', async () => {
    const d = await deployed('account');
    // Two other projects, one role run each: a project runs one role at a time, so two runs of one project would not show the envelope.
    const other = await newOtherProject();
    const third = await newOtherProject();
    const runs = [];
    try {
      // SIGKILL to this test's own engine child (killOwnEngine reads its /proc first).
      await killOwnEngine(ctx.fx);
      await startAgain(ctx);
      assert.ok(serviceDomainOf(ctx.fx.home, d.svc.attempt.id)?.reservation?.check_capacity, 'the survivor\'s reservation is recorded');
      const first = await roleHolding(ctx.fx, other.id, await addItem(ctx.fx, other.id, 'fix'), { name: 'one' });
      runs.push(first.run);
      const second = await addItem(ctx.fx, third.id, 'fix');
      ctx.fx.scripted.script(second, [script.hold('two')]);
      await tick(ctx.fx.engine, third.id, { rounds: 2 });
      assert.deepEqual(runsOf(ctx.fx.home, second), [], 'the second role run is not dispatched');
      const entry = await workEntry(ctx.fx.engine, third.id, second);
      assert.equal(entry?.dispatch_hold?.code, 'resource_envelope', `held for the envelope, the survivor's check capacity counted (D4 §9.2; E126) (${JSON.stringify(entry)})`);
      // The survivor torn down by the engine (an ordinary teardown: the lease is free), its closure observed.
      const down = await teardownOnHost(ctx, d.env);
      assert.equal(attemptsOf(ctx.fx.home, down.id).at(-1)?.status, 'succeeded', `the survivor's teardown is applied (${JSON.stringify(attemptsOf(ctx.fx.home, down.id).map((a) => [a.status, a.reconciliation_reads?.map((r) => r.result)]))})`);
      assert.equal(serviceDomainOf(ctx.fx.home, d.svc.attempt.id)?.state, 'terminated', 'its domain is terminated, its reservation freed');
      // Ticks of the other project until it dispatches (the harness engine ticks only when asked).
      const run2 = await ticksUntil(ctx.fx, third.id, () => runsOf(ctx.fx.home, second).find((r) => r.state === 'executing'), { timeoutMs: 180_000, what: 'the second role run to be dispatched once the survivor is torn down' });
      runs.push(run2);
      assert.ok(run2, 'once the survivor\'s closure is observed, the second dispatch is admitted (the control)');
    } finally {
      for (const r of runs) await stopRun(ctx.fx.engine, r.project, r.id).catch(() => undefined);
      for (const r of runs) await waitForRunState(ctx.fx.home, r.id, 'ended', { timeoutMs: 60_000 }).catch(() => undefined);
      await endCase(ctx, d.env);
    }
  });

  test('(e) a store restored from a backup whose service domain names another cgroup: deployment refused before its effect naming unknown_ownership, the unit listed, never adopted or stopped; the affected admission held', async () => {
    const d = await deployed('restored');
    const other = others[0] ?? (await newOtherProject());
    const invocation = unitShow(d.svc.unit, ['InvocationID']).InvocationID;
    let item = null;
    try {
      await ctx.fx.engine.stop();
      const from = backupNow(ctx.fx);
      restoreInPlace(ctx.fx, from, Object.fromEntries([[ctx.project, ctx.p.repo.path], ...others.map((o) => [o.id, o.repo.path])]));
      storeWrite(ctx.fx, (db) => db.prepare(`UPDATE "execution_domains" SET "cgroup_path" = "cgroup_path" || '-elsewhere' WHERE "attempt" = ?`).run(d.svc.attempt.id));
      await startAgain(ctx);

      const known = new Set(operationsOf(ctx.fx.home, ctx.project, 'deploy').map((o) => o.id));
      await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, d.env.name);
      const op = await ticksUntil(ctx.fx, ctx.project, () => {
        const o = operationsOf(ctx.fx.home, ctx.project, 'deploy').find((x) => !known.has(x.id));
        return o && o.status === 'failed' ? o : undefined;
      }, { what: 'the request after the restore to be refused' });
      assert.deepEqual([op.outcome_detail?.code, op.outcome_detail?.fact], ['EFFECT_PRECONDITION_CHANGED', 'unknown_ownership'], `deployment blocked (D4 §9.2) (${JSON.stringify(op.outcome_detail)})`);
      const facts = JSON.parse(readFileSync(recordFile(ctx.fx.home, recordRow(ctx.fx.home, op.outcome_detail.manifest))).toString('utf8')).facts ?? [];
      assert.ok(unitsNamedIn(facts.find((f) => f.fact === 'unknown_ownership')?.read).includes(d.svc.unit), 'the unit is listed in what the precondition read');
      assert.deepEqual(attemptsOf(ctx.fx.home, op.id), [], 'never adopted: no attempt names it');
      assert.equal(unitShow(d.svc.unit, ['InvocationID'])?.InvocationID, invocation, 'host-read: never stopped or restarted');
      assert.ok(!gone(d.svc.app), 'host-read: its application still runs');

      item = await addItem(ctx.fx, other.id, 'fix');
      ctx.fx.scripted.script(item, [script.hold('three')]);
      await tick(ctx.fx.engine, other.id, { rounds: 2 });
      assert.deepEqual(runsOf(ctx.fx.home, item), [], 'the affected admission is held: no role run dispatched while the reservation cannot be accounted');
    } finally {
      // The store's record put back as the host reports it, so the engine's own teardown can remove what it owns.
      if (ctx.fx.engine.isRunning()) await ctx.fx.engine.stop();
      storeWrite(ctx.fx, (db) => db.prepare(`UPDATE "execution_domains" SET "cgroup_path" = replace("cgroup_path", '-elsewhere', '') WHERE "attempt" = ?`).run(d.svc.attempt.id));
      await startAgain(ctx);
      await endCase(ctx, d.env);
      if (item) for (const r of runsOf(ctx.fx.home, item)) await stopRun(ctx.fx.engine, other.id, r.id).catch(() => undefined);
    }
  });
});
