// M329, the observation job and its conditions (slice 27); and M325 (b),
// deferred here by slice 26. M4 plan §3.5 M329, §3.4 M325; D4-N02, D4-N05,
// D4-O07; D4 §§4.5, 6.2, 6.3; J6; AR N01; BS4 §11.1 CD2; SEAM.md §§247,
// 290 to 293, 298.
//
// Kernel lane, on the scripted deployment adapter. Generation 1 is deployed
// and its round's check exits 1 (the candidate stays developing, so a
// replacement of the same candidate is an ordinary new request). Each
// observation is made by advancing the engine's clock past the cadence and
// asking for a tick (SEAM.md §291).
//   (a) the job at its cadence: nothing before it is due, one observation
//       per due job, history appended, each with its read interval,
//       expected revision and generation;
//   (b) D4 §6.2's precedence, each beside a successful-read control:
//       unread → unknown; nothing active → down; drift open → degraded;
//       down with the drift beside it; acknowledged drift → degraded;
//       every expected instance running → healthy (the controls). "Some
//       running" (rule 5) cannot arise with M4's one target and is not
//       written (SEAM.md §298 reading 2);
//   (c) a unit whose application has exited while it stays active, never
//       healthy; a read past its deadline and a manager not answering,
//       each `unknown` with `environment.observation_missed`, never the
//       previous value, no out-of-band fact; the freshness bound missed;
//   (d) a manual restart, acknowledgment, a read, re-verification, then an
//       authorized replacement: the restarted instance never adopted, the
//       drift resolved only at the replacement; an observation delayed
//       across a replacement (its read held, SEAM.md §247's `hold`) never
//       installed as drift;
//   (e) CD2: after an engine restart the surviving service's reads match;
//       `degraded`, detail `supervision_unknown`, never `healthy`.
// M325 (b): an observation during an operation compares with its attempt's
// prior and next: a state between them is observed, never out of band; the
// same state after the operation has ended is (the control).
//
// SAFETY: no unit, no systemctl, no host process; the only engine stopped
// is the test's own, in order (`fx.engine.stop()`).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { advanceClock, requestTick, scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { assertConstraint } from './harness/store-cases.mjs';
import { withStore } from './harness/store.mjs';
import { adapterState, attemptsOf, deploy, deployable, deployToRound, environmentRead, operationsOf, postDeployExecutions, scriptCall, unitName } from './harness/deploy/kernel.mjs';
import { changeTarget, executionsOfRound, recordExit, roundsOf, rowOf, rowWhen, verifyAgain } from './harness/deploy/rounds.mjs';
import { answerOn } from './harness/deploy/recover.mjs';
import {
  callsBy,
  historyOf,
  isOpen,
  missedEvents,
  observe,
  observationJob,
  observedEvents,
  observedOf,
  oobDecision,
  oobEvents,
  oobRows,
  openOob,
  releaseHeld,
  scriptObservation,
} from './harness/deploy/observe.mjs';

// Generation 1 deployed, its round decided `failed` (the check exits 1).
async function running(t, { policy = {}, config = {} } = {}) {
  const fx = await scriptedEngine(t, { config });
  const ctx = await deployable(fx, { policy });
  const { operation, execution } = await deployToRound(ctx);
  const [round] = roundsOf(fx.home, operation.id);
  await recordExit(fx.engine, execution.id, 1);
  await rowWhen(ctx, round.id);
  await tick(fx.engine, ctx.project, { rounds: 2 });
  const g1 = (await adapterState(fx.engine, ctx.env.id)).target.units.find((u) => u.generation === 1);
  assert.ok(g1 && g1.state === 'active', 'the fixture is live: generation 1 runs on the target');
  return { ...ctx, op: operation, g1 };
}

const g1Changed = (ctx, change) => changeTarget(ctx.fx.engine, ctx.env.id, (target) => ({ ...target, units: target.units.map((u) => (u.generation === 1 ? change(u) : u)) }));

// The engine's clock moved without an observation being waited for; the
// total is kept for a restart's --harness-clock-offset (SEAM.md §274).
async function advance(ctx, seconds) {
  await advanceClock(ctx.fx.engine, seconds);
  ctx.fx.clockAdvanced = (ctx.fx.clockAdvanced ?? 0) + seconds;
}

// A control: the observation reads healthy.
async function healthy(ctx, what) {
  const row = await observe(ctx);
  assert.equal(row.condition, 'healthy', `${what}: the control reads healthy (${JSON.stringify(row)})`);
  return row;
}

describe('M329 (a) the job at its cadence', () => {
  test('one job for the environment at observation_cadence; nothing before it is due; one observation per due job, appended to history, each with its read interval, expected revision and generation, made by one status read', async (t) => {
    const ctx = await running(t);
    const { fx, env } = ctx;
    const job = observationJob(fx.home, env.id);
    assert.ok(job, 'the environment has an observation_jobs row (D4 §6.2)');
    assert.equal(job.cadence_s, 30, `its cadence is observation_cadence, 30 s by default (${job.cadence_s})`);
    await observe(ctx);
    const n = historyOf(fx.home, env.id).length;
    const statusBefore = callsBy(await adapterState(fx.engine, env.id), 'status', 'observation').length;
    await advance(ctx, 5);
    await tick(fx.engine, ctx.project, { rounds: 2 });
    assert.equal(historyOf(fx.home, env.id).length, n, 'five seconds after an observation nothing is due: no observation');
    const row = await observe(ctx, env, { seconds: 26 });
    await tick(fx.engine, ctx.project, { rounds: 2 });
    assert.equal(historyOf(fx.home, env.id).length, n + 1, 'at the cadence, exactly one observation (history appended)');
    assert.equal(callsBy(await adapterState(fx.engine, env.id), 'status', 'observation').length, statusBefore + 1, 'made by one status read of the observation job');
    assert.ok(row.read_interval && row.read_interval.from && row.read_interval.to && Date.parse(row.read_interval.from) <= Date.parse(row.read_interval.to), `it carries its read interval (${JSON.stringify(row.read_interval)})`);
    assert.ok(Number.isInteger(row.expected_revision), `it carries the expected-state revision it compared against (${row.expected_revision})`);
    assert.equal(row.deployment_generation, 1, 'and the generation it compared against');
    assert.equal(row.condition, 'healthy', 'generation 1 running as recorded reads healthy');
    const stored = observedOf(fx.home, env.id);
    assert.deepEqual([stored.condition, stored.observed_at], [row.condition, row.observed_at], 'the record\'s current observation is the latest');
    assert.ok(observedEvents(fx.home, env.id).some((e) => e.payload?.test_fixture !== true), 'environment.observed is emitted by the job, not a fixture');
    // observation_history is append-only at the database level (D1 §6.2; M04's narrowed case).
    withStore(fx.home, (db) => {
      assertConstraint(() => db.prepare('UPDATE "observation_history" SET "condition" = ? WHERE "id" = ?').run('down', row.id), 'UPDATE on observation_history');
      assertConstraint(() => db.prepare('DELETE FROM "observation_history" WHERE "id" = ?').run(row.id), 'DELETE on observation_history');
    }, { readonly: false });
  });
});

describe('M329 (b) the precedence of D4 §6.2, each beside a successful read', () => {
  test('a required state unread: unknown; read again: healthy', async (t) => {
    const ctx = await running(t);
    await healthy(ctx, 'before');
    await g1Changed(ctx, (u) => ({ ...u, state: 'unread' }));
    assert.equal((await observe(ctx)).condition, 'unknown', 'an unread required state is unknown (rule 1)');
    await g1Changed(ctx, (u) => ({ ...u, state: 'active' }));
    await healthy(ctx, 'after');
  });

  test('nothing of the environment active: down; once generation 1 runs: healthy', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    assert.equal((await observe(ctx)).condition, 'down', 'an environment with no application active and no unexpected unit is down (rule 2)');
    const { operation, execution } = await deployToRound(ctx);
    await recordExit(fx.engine, execution.id, 1);
    await rowWhen(ctx, roundsOf(fx.home, operation.id)[0].id);
    await tick(fx.engine, ctx.project, { rounds: 2 });
    await healthy(ctx, 'deployed');
  });

  test('drift open (an identity read that differs): degraded; acknowledged: still degraded, the marker unresolved', async (t) => {
    const ctx = await running(t, { policy: { identity_observation_every: 1 } });
    await healthy(ctx, 'before');
    await g1Changed(ctx, (u) => ({ ...u, tree: `sha256:${'d'.repeat(64)}` }));
    const drift = await observe(ctx);
    assert.equal(drift.condition, 'degraded', `drift open is degraded (rule 3) (${drift.condition})`);
    const [row] = openOob(ctx.fx.home, ctx.env.id);
    assert.ok(row, 'an out-of-band row is open');
    await answerOn(ctx, oobDecision(ctx.fx.home, row), 'acknowledge');
    const after = oobRows(ctx.fx.home, ctx.env.id).find((r) => r.id === row.id);
    assert.equal(after.disposition, 'acknowledge');
    assert.equal(after.acknowledged?.unresolved_until_replacement, true, `the acknowledgment is a persistent marker (D4 A.3) (${JSON.stringify(after.acknowledged)})`);
    assert.equal(after.closed_at, null, 'unresolved until a replacement');
    assert.equal((await observe(ctx)).condition, 'degraded', 'acknowledged drift stays degraded (N01)');
    const read = await environmentRead(ctx.fx.engine, ctx.project, ctx.env.name);
    assert.deepEqual((read.out_of_band ?? []).map((o) => [o.id, o.status]), [[row.id, 'acknowledged']], `the read shows the acknowledged drift (${JSON.stringify(read.out_of_band)})`);
  });

  test('stopped by hand: down, with the drift shown beside it', async (t) => {
    const ctx = await running(t);
    await healthy(ctx, 'before');
    await g1Changed(ctx, (u) => ({ ...u, state: 'inactive', instance: null }));
    assert.equal((await observe(ctx)).condition, 'down', 'nothing active: down (rule 2)');
    const read = await environmentRead(ctx.fx.engine, ctx.project, ctx.env.name);
    assert.equal(read.observed?.condition, 'down');
    assert.ok((read.out_of_band ?? []).some((o) => o.status === 'open'), `the out-of-band fact is visible beside down (D4 §6.2) (${JSON.stringify(read.out_of_band)})`);
  });
});

describe('M329 (c) never healthy on what the reads cannot establish', () => {
  test('the unit active with its application exited: never healthy; the application back: healthy', async (t) => {
    const ctx = await running(t);
    await healthy(ctx, 'before');
    const instance = ctx.g1.instance;
    await g1Changed(ctx, (u) => ({ ...u, instance: null }));
    assert.notEqual((await observe(ctx)).condition, 'healthy', 'a live init or launcher with its original application exited is not healthy (D4 §6.2)');
    await g1Changed(ctx, (u) => ({ ...u, instance }));
    await healthy(ctx, 'after');
  });

  test('a read past its deadline and a manager not answering: each unknown with environment.observation_missed, never the previous value, and no out-of-band fact; read again: healthy', async (t) => {
    const ctx = await running(t, { config: { adapter_read_deadline: 1 } });
    const { fx, env } = ctx;
    for (const [what, answer] of [
      ['a read past its deadline', { hang: true }],
      ['a manager not answering', { failure: 'unavailable' }],
    ]) {
      await healthy(ctx, `before ${what}`);
      const missed = missedEvents(fx.home, env.id).length;
      await scriptObservation(fx.engine, env.id, 'status', [answer]);
      const row = await observe(ctx);
      assert.equal(row.condition, 'unknown', `${what}: unknown, never the previous healthy (${row.condition})`);
      assert.equal(observedOf(fx.home, env.id).condition, 'unknown', `${what}: the record's observation is unknown`);
      assert.ok(missedEvents(fx.home, env.id).length > missed, `${what}: environment.observation_missed`);
      assert.deepEqual(oobRows(fx.home, env.id), [], `${what}: a read failure never creates an out-of-band fact`);
    }
    await healthy(ctx, 'after');
  });

  test('the freshness bound missed: unknown with environment.observation_missed although the job is not due', async (t) => {
    const ctx = await running(t, { policy: { observation_cadence: 3600, observation_freshness_bound: 30 } });
    const { fx, env } = ctx;
    assert.equal((await observe(ctx, env, { seconds: 3601 })).condition, 'healthy', 'the control: a successful observation');
    const missed = missedEvents(fx.home, env.id).length;
    const row = await observe(ctx, env, { seconds: 31 });
    assert.equal(row.condition, 'unknown', `the bound missed: unknown (D1 §8.1 step 5) (${row.condition})`);
    assert.ok(missedEvents(fx.home, env.id).length > missed, 'environment.observation_missed');
    assert.deepEqual(oobRows(fx.home, env.id), [], 'no out-of-band fact');
  });
});

describe('M329 (d) a manual restart, then its resolution only at a replacement', () => {
  test('restart by hand, acknowledge, read, re-verify, replace: the restarted instance never adopted, the drift resolved only at the replacement', async (t) => {
    const ctx = await running(t, { policy: { identity_observation_every: 1 } });
    const { fx, env, project } = ctx;
    const recorded = attemptsOf(fx.home, ctx.op.id)[0].app_instance;
    await healthy(ctx, 'before');
    await g1Changed(ctx, (u) => ({ ...u, invocation_id: 'e'.repeat(32), instance: { pid: 999001, start_time: 4242 } }));
    const drift = await observe(ctx);
    assert.notEqual(drift.condition, 'healthy', 'the restarted unit is not healthy');
    const [row] = openOob(fx.home, env.id);
    assert.ok(row && JSON.stringify(row.found).includes('e'.repeat(32)), `an out-of-band row names the new invocation (${JSON.stringify(row)})`);
    await answerOn(ctx, oobDecision(fx.home, row), 'acknowledge');
    assert.notEqual((await observe(ctx)).condition, 'healthy', 'read again after the acknowledgment: not healthy');
    const round = await verifyAgain(fx.engine, project, ctx.op.id);
    const v = await tickUntil(fx.engine, project, async () => {
      for (const x of executionsOfRound(fx.home, ctx.candidate.id, round.id)) if (x.status === 'queued') await recordExit(fx.engine, x.id, 0);
      return rowOf(fx.home, round.id);
    }, { max: 16, what: 'the re-verification\'s row' });
    assert.notEqual(v.outcome, 'verified', `re-verification never adopts the restarted instance (D4 §6.3) (${v.outcome})`);
    assert.deepEqual(attemptsOf(fx.home, ctx.op.id)[0].app_instance, recorded, 'the attempt\'s application instance is never rebound');
    assert.equal(oobRows(fx.home, env.id).find((r) => r.id === row.id).closed_at, null, 'still unresolved after a read and a re-verification');

    await tick(fx.engine, project, { rounds: 2 });
    await scriptCall(fx.engine, env.id, 'deploy', [{ result: 'issued', apply: true }]);
    await deploy(fx.engine, project, ctx.candidate.id, env.name);
    const op2 = await tickUntil(fx.engine, project, () => operationsOf(fx.home, project, 'deploy').find((o) => o.id !== ctx.op.id && attemptsOf(fx.home, o.id)[0]?.status === 'succeeded'), { max: 16, what: 'the replacement to be applied' });
    const x2 = await tickUntil(fx.engine, project, () => postDeployExecutions(fx.home, ctx.candidate.id).find((x) => x.deployment?.operation === op2.id), { max: 12, what: 'the replacement\'s round' });
    await recordExit(fx.engine, x2.id, 1);
    await tick(fx.engine, project, { rounds: 3 });
    assert.ok(oobRows(fx.home, env.id).find((r) => r.id === row.id).closed_at, 'the drift is resolved at the replacement');
    assert.equal((await observe(ctx)).condition, 'healthy', 'the replacement observed: healthy');
    assert.deepEqual((await environmentRead(fx.engine, project, env.name)).out_of_band ?? [], [], 'no drift left on the read');
  });

  test('an observation whose read was made before a replacement and returns after it: never installed as drift', async (t) => {
    const ctx = await running(t);
    const { fx, env, project } = ctx;
    await healthy(ctx, 'before');
    await scriptObservation(fx.engine, env.id, 'status', [{ hold: true }]);
    const n = historyOf(fx.home, env.id).length;
    await advance(ctx, 31);
    await requestTick(fx.engine, project);
    await tickUntil(fx.engine, project, async () => callsBy(await adapterState(fx.engine, env.id), 'status', 'observation').at(-1)?.answer?.hold === true, { max: 6, what: 'the observation\'s held status read' });

    // The replacement, while the observation's read is held (SEAM.md §291: its reads hold no tick).
    await scriptCall(fx.engine, env.id, 'deploy', [{ result: 'issued', apply: true }]);
    await deploy(fx.engine, project, ctx.candidate.id, env.name);
    const x2 = await tickUntil(fx.engine, project, () => postDeployExecutions(fx.home, ctx.candidate.id).find((x) => x.deployment?.operation !== ctx.op.id), { max: 16, what: 'the replacement\'s round' });
    await recordExit(fx.engine, x2.id, 1);
    await tick(fx.engine, project, { rounds: 2 });
    const target = (await adapterState(fx.engine, env.id)).target;
    assert.deepEqual(target.units.map((u) => u.name), [unitName(fx.home, env.id, 2)], 'the fixture is live: generation 2 replaced generation 1');

    await releaseHeld(fx.engine, env.id);
    await tick(fx.engine, project, { rounds: 3 });
    assert.ok(historyOf(fx.home, env.id).length >= n, 'the delayed observation is retried or kept as history');
    assert.deepEqual(oobRows(fx.home, env.id), [], 'the delayed comparison (generation 1 running, generation 2 absent) is never installed as drift');
    assert.deepEqual(oobEvents(fx.home, env.id), [], 'no environment.out_of_band');
    assert.equal((await observe(ctx)).condition, 'healthy', 'the next observation: generation 2 healthy');
  });
});

describe('M329 (e) CD2: a surviving service whose supervision is unknown', () => {
  test('after an engine restart the reads match: degraded, detail supervision_unknown, never healthy', async (t) => {
    const ctx = await running(t);
    const { fx, env, project } = ctx;
    await healthy(ctx, 'supervised');
    await fx.engine.stop();
    await fx.start({ args: ['--harness-clock-offset', String(fx.clockAdvanced)] });
    const row = await observe(ctx);
    assert.equal(row.condition, 'degraded', `supervision unknown never reads healthy: degraded (CD2) (${row.condition})`);
    assert.equal(row.detail?.code, 'supervision_unknown', `the detail names supervision_unknown (SEAM.md §292) (${JSON.stringify(row.detail)})`);
    const read = await environmentRead(fx.engine, project, env.name);
    assert.equal(read.supervision, 'unknown');
    assert.ok(read.conditions.includes('supervision_unknown'));
    assert.notEqual(read.observed?.condition, 'healthy');
  });
});

describe('M325 (b) an observation during the operation (deferred by slice 26)', () => {
  test('while generation 2 replaces generation 1, states between prior and next are observed, never out of band; the same state after the operation has ended is out of band (the control)', async (t) => {
    const ctx = await running(t);
    const { fx, env, project } = ctx;
    await healthy(ctx, 'before');
    await scriptCall(fx.engine, env.id, 'deploy', [{ result: 'issued', apply: true }]);
    await deploy(fx.engine, project, ctx.candidate.id, env.name);
    const x2 = await tickUntil(fx.engine, project, () => postDeployExecutions(fx.home, ctx.candidate.id).find((x) => x.deployment?.operation !== ctx.op.id), { max: 16, what: 'operation 2\'s round' });
    const op2 = operationsOf(fx.home, project, 'deploy').find((o) => o.id === x2.deployment.operation);
    const g2 = (await adapterState(fx.engine, env.id)).target.units.find((u) => u.generation === 2);
    assert.ok(g2, 'the fixture is live: operation 2 applied generation 2');

    // Prior stopped, next absent: between them.
    await changeTarget(fx.engine, env.id, (target) => ({ ...target, units: [] }));
    const between = await observe(ctx);
    assert.equal(between.deployment_generation, 2, 'compared against the attempt\'s generation');
    await changeTarget(fx.engine, env.id, (target) => ({ ...target, units: [g2] }));
    await observe(ctx);
    assert.deepEqual(oobRows(fx.home, env.id), [], 'a state between the attempt\'s prior and next is recorded as observed, never as out of band (D4 §4.5)');
    assert.deepEqual(oobEvents(fx.home, env.id), [], 'no environment.out_of_band');

    // The control: the operation ended, the same state is out of band.
    await recordExit(fx.engine, x2.id, 1);
    await tickUntil(fx.engine, project, () => (operationsOf(fx.home, project, 'deploy').find((o) => o.id === op2.id)?.orchestration_stage === 'ended' ? true : undefined), { max: 12, what: 'operation 2 to end' });
    await changeTarget(fx.engine, env.id, (target) => ({ ...target, units: [] }));
    await observe(ctx);
    assert.ok(oobRows(fx.home, env.id).some(isOpen), 'with no operation in flight, generation 2 gone is an out-of-band change');
  });
});
