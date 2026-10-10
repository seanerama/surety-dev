// M328, three facts; reads are stored (slice 27). M4 plan §3.5 M328;
// D4-N01, D4-N06; N02; D4 §6.1, A.8; D1-28; SEAM.md §§91, 247, 255, 290 to
// 294, 298.
//
// Kernel lane, on the scripted deployment adapter.
//   (a) the environment read after a failed attempt, during a deploy,
//       after a verified deploy, after an observation, after a new
//       configuration version and after an out-of-band change: last
//       verified, attempted and observed kept apart; what the running
//       service was launched with beside the current configuration; the
//       current generation; supervision; the out-of-band observation; the
//       operation in flight;
//   (b) an `unknown` observation and an `expired` one, each shown as such
//       and never as `healthy`, on the environment read and the project read;
//   (c) GET environment and GET logs repeated: no adapter call (counted, by
//       either caller) and nothing written, `observed_at` unchanged; then,
//       on the same home outside harness mode, nothing written and the same
//       stored observation answered. Outside harness mode no seam counts
//       calls, so the count is the harness-mode one (SEAM.md §298 reading 8);
//   (d) a log not yet collected reads `missing`, then `pending` once asked;
//       collected, it is a stored `deployment_logs` record (the control).
//
// SAFETY: no unit, no systemctl, no host process from the test. The engine
// started outside harness mode in (c) builds the real adapter: at its start
// it reads the user manager, read-only, for the units its store recorded
// (scripted names under this test's home's prefix, which do not exist); no
// observation falls due and nothing is deployed while it runs.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { recordRow } from './harness/records.mjs';
import { scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { adapterState, attemptsOf, completeRound, configContent, configure, deploy, deployable, deployToRound, environmentRead, operationsOf, scriptCall } from './harness/deploy/kernel.mjs';
import { changeTarget, recordExit, roundsOf, rowWhen } from './harness/deploy/rounds.mjs';
import { collectLogs, logsRead, observe, observedOf, scriptObservation, storeFootprint } from './harness/deploy/observe.mjs';

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k] ?? null]));

async function running(t, policy = {}) {
  const fx = await scriptedEngine(t);
  const ctx = await deployable(fx, { policy });
  const { operation, execution } = await deployToRound(ctx);
  await recordExit(fx.engine, execution.id, 1);
  await rowWhen(ctx, roundsOf(fx.home, operation.id)[0].id);
  await tick(fx.engine, ctx.project, { rounds: 2 });
  return { ...ctx, op: operation };
}

const projectObserved = async (ctx) => {
  const res = await ctx.fx.engine.get(`/v1/projects/${ctx.project}`);
  assert.equal(res.status, 200, res.text);
  return res.body.project.environments.find((e) => e.id === ctx.env.id)?.observed;
};

describe('M328 (a) the three facts apart, and what the read shows beside them', () => {
  test('a failed attempt, a deploy in flight, a verified deploy, an observation, a new configuration version and an out-of-band change: each fact moves only by its own writer', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx, { policy: { identity_observation_every: 1 } });
    const { project, env } = ctx;

    await scriptCall(fx.engine, env.id, 'deploy', [{ result: 'refused' }]);
    await deploy(fx.engine, project, ctx.candidate.id, env.name);
    const op1 = await tickUntil(fx.engine, project, () => operationsOf(fx.home, project, 'deploy').find((o) => o.status === 'failed'), { what: 'the refused attempt to fail' });
    const failed = await environmentRead(fx.engine, project, env.name);
    assert.deepEqual(pick(failed.attempted, ['operation', 'outcome']), { operation: op1.id, outcome: 'failed' }, `attempted carries the failed attempt (${JSON.stringify(failed.attempted)})`);
    assert.equal(failed.last_verified ?? null, null, 'nothing was verified');

    // deployToRound names the project's first deploy operation; the one in flight is the newest (operation 1 failed).
    const { execution } = await deployToRound(ctx);
    const op2 = operationsOf(fx.home, project, 'deploy').at(-1);
    assert.notEqual(op2.id, op1.id, 'the fixture is live: a second deploy operation');
    const g2 = attemptsOf(fx.home, op2.id)[0].deployment_generation;
    const during = await environmentRead(fx.engine, project, env.name);
    assert.equal(during.operation_in_flight?.id, op2.id, `the operation in flight is shown (${JSON.stringify(during.operation_in_flight)})`);
    await completeRound(ctx, execution);
    await tick(fx.engine, project, { rounds: 2 });
    const verified = await environmentRead(fx.engine, project, env.name);
    assert.equal(verified.last_verified?.generation, g2, `last_verified names operation 2's generation (${JSON.stringify(verified.last_verified)})`);
    assert.deepEqual([verified.attempted?.operation, verified.attempted?.generation], [op2.id, g2], 'attempted is operation 2\'s');
    assert.equal(verified.current_generation, g2, 'the current generation');
    assert.equal(verified.supervision, 'attached', 'the running service\'s supervision');
    assert.equal(verified.running?.config, verified.config?.id, 'the running service was launched with the current configuration version');
    assert.equal(verified.operation_in_flight ?? null, null, 'no operation in flight');
    assert.deepEqual(verified.out_of_band ?? null, [], 'no out-of-band observation');

    const row = await observe(ctx);
    const observed = await environmentRead(fx.engine, project, env.name);
    assert.deepEqual([observed.observed?.condition, observed.observed?.observed_at], [row.condition, row.observed_at], 'observed is the observation\'s');
    assert.deepEqual([observed.last_verified, observed.attempted], [verified.last_verified, verified.attempted], 'an observation changes neither last_verified nor attempted');

    const v2 = await configure(fx.engine, project, env.name, configContent({ env: { CHANGED: '1' } }));
    const rotated = await environmentRead(fx.engine, project, env.name);
    assert.equal(rotated.config?.id, v2.config.id, 'the current configuration version');
    assert.equal(rotated.running?.config, verified.config.id, 'beside it, the version the running service was launched with');

    await changeTarget(fx.engine, env.id, (target) => ({ ...target, units: target.units.map((u) => ({ ...u, tree: `sha256:${'d'.repeat(64)}` })) }));
    await observe(ctx);
    const drift = await environmentRead(fx.engine, project, env.name);
    assert.equal((drift.out_of_band ?? []).filter((o) => o.status === 'open').length, 1, `the open out-of-band observation is shown (${JSON.stringify(drift.out_of_band)})`);
    assert.deepEqual(drift.last_verified, verified.last_verified, 'last_verified is kept as history, never erased');
  });
});

describe('M328 (b) unknown and expired observations', () => {
  test('an unknown observation is shown unknown, never healthy', async (t) => {
    const ctx = await running(t);
    assert.equal((await observe(ctx)).condition, 'healthy', 'the control');
    await scriptObservation(ctx.fx.engine, ctx.env.id, 'status', [{ failure: 'unavailable' }]);
    await observe(ctx);
    assert.equal((await environmentRead(ctx.fx.engine, ctx.project, ctx.env.name)).observed?.condition, 'unknown', 'the environment read shows unknown');
    assert.equal((await projectObserved(ctx))?.condition, 'unknown', 'so does the project read');
  });

  test('an observation past observation_freshness_bound is shown expired, never healthy, and the stored row is unchanged', async (t) => {
    const ctx = await running(t, { observation_cadence: 3600, observation_freshness_bound: 30 });
    const row = await observe(ctx, ctx.env, { seconds: 3601 });
    assert.equal(row.condition, 'healthy', 'the control: fresh and healthy');
    const stored = JSON.stringify(observedOf(ctx.fx.home, ctx.env.id));
    await ctx.fx.engine.post('/v1/harness/clock/advance', { seconds: 31 });
    const read = (await environmentRead(ctx.fx.engine, ctx.project, ctx.env.name)).observed;
    assert.equal(read?.freshness, 'expired', `past the bound the read shows expired (${JSON.stringify(read)})`);
    assert.notEqual(read?.condition, 'healthy', 'an expired observation is never shown as healthy (D1-28)');
    assert.notEqual((await projectObserved(ctx))?.condition, 'healthy', 'nor on the project read');
    assert.equal(JSON.stringify(observedOf(ctx.fx.home, ctx.env.id)), stored, 'reading rewrites nothing');
  });
});

describe('M328 (c) GET environment and GET logs are stored reads', () => {
  test('repeated, in harness mode: no adapter call and nothing written; on the same home outside harness mode: nothing written and the same stored observation', async (t) => {
    const ctx = await running(t, { observation_cadence: 3600 });
    const { fx, project, env } = ctx;
    await observe(ctx, env, { seconds: 3601 });
    const asked = await collectLogs(fx.engine, project, env.name);
    assert.equal(asked.status, 202, `the collection is asked (SEAM.md §294) (body: ${asked.text})`);
    await tickUntil(fx.engine, project, async () => (await logsRead(fx.engine, project, env.name)).body?.state === 'collected', { what: 'the log to be collected' });

    const footprint = storeFootprint(fx.home, env.id);
    const calls = (await adapterState(fx.engine, env.id)).calls.length;
    const answers = [];
    for (let i = 0; i < 3; i++) {
      const e = await fx.engine.get(`/v1/projects/${project}/environments/${env.name}`);
      const l = await logsRead(fx.engine, project, env.name);
      assert.deepEqual([e.status, l.status], [200, 200], `the reads answer (${e.text} ${l.text})`);
      answers.push({ observed: e.body.environment.observed, logs: l.body.logs });
    }
    assert.equal((await adapterState(fx.engine, env.id)).calls.length, calls, 'no adapter call, by an operation or the observation job (D4 §6.1)');
    assert.deepEqual(storeFootprint(fx.home, env.id), footprint, 'nothing written: no event, record, observation or job changed');
    assert.ok(answers.every((a) => a.observed.observed_at === answers[0].observed.observed_at), 'no read refreshes the observation\'s age');
    assert.ok(answers[0].logs.length >= 1 && answers[0].logs.every((l) => l.record && l.at), `the logs read returns stored records with their source timestamps (${JSON.stringify(answers[0].logs)})`);

    await fx.engine.stop();
    await fx.start({ harness: false });
    const outside = storeFootprint(fx.home, env.id);
    for (let i = 0; i < 3; i++) {
      const e = await fx.engine.get(`/v1/projects/${project}/environments/${env.name}`);
      const l = await logsRead(fx.engine, project, env.name);
      assert.deepEqual([e.status, l.status], [200, 200], `outside harness mode the reads answer (${e.text} ${l.text})`);
      assert.equal(e.body.environment.observed?.observed_at, answers[0].observed.observed_at, 'outside harness mode the same stored observation');
    }
    assert.deepEqual(storeFootprint(fx.home, env.id), outside, 'outside harness mode the reads write nothing');
  });
});

describe('M328 (d) a log not yet collected', () => {
  test('missing before any collection, pending once asked, then a stored deployment_logs record', async (t) => {
    const ctx = await running(t);
    const { fx, project, env } = ctx;
    const none = await logsRead(fx.engine, project, env.name);
    assert.equal(none.status, 200, none.text);
    assert.deepEqual([none.body.state, none.body.logs], ['missing', []], `an uncollected log reads missing, never fetched by the read (${none.text})`);
    assert.equal((await collectLogs(fx.engine, project, env.name)).status, 202);
    const asked = await logsRead(fx.engine, project, env.name);
    assert.ok(['pending', 'collected'].includes(asked.body.state), `once asked: pending until recorded (${asked.text})`);
    const done = await tickUntil(fx.engine, project, async () => {
      const r = await logsRead(fx.engine, project, env.name);
      return r.body?.state === 'collected' ? r.body : undefined;
    }, { what: 'the log to be collected' });
    assert.equal(recordRow(fx.home, done.logs[0]?.record)?.kind, 'deployment_logs', `the collection made a deployment_logs record (${JSON.stringify(done.logs)})`);
  });
});
