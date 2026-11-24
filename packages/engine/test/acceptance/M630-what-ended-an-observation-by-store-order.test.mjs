// M630, what ended an observation, decided by store order (M7 plan §3h, row
// M630; DECISIONS item 51 finding 2, first priority; D4 §6.2; SEAM.md §425).
// Sean, 2026-11-24: "Use a shared, durable ordering source for each
// comparison, such as the event sequence for both facts. … 2 · Environment
// health. Prove that a healthy observation followed by a backward clock step
// and a finalized teardown immediately reads as ended by that teardown.
// Cover replacement too: a later observation of the new generation must
// remain current."
//
// Kernel lane, the scripted deployment adapter (as M329 and M611's kernel
// file). Each observation is made by advancing the engine's clock past the
// cadence and asking for ticks (SEAM.md §291); the clock is then stepped back
// with `POST /v1/harness/clock/advance {"seconds": -N}` (SEAM.md §425), so the
// finalization that follows the observation in the store carries an earlier
// wall stamp than the observation.
//   (a) a healthy observation of generation 1, the clock stepped back, a
//       teardown run to finalization: the environment read (and the list)
//       right after serve the observation as ended by that teardown, never
//       as current and fresh, although `finalized_at` < `observed_at`;
//   (b) replacement: the same observation and step, a replacing deployment
//       (generation 2) finalized: the old observation reads ended by that
//       deployment; a later observation of generation 2 is current, with no
//       `ended_by`, its freshness as recorded;
//   (c) equal wall stamps: the clock seam moves whole seconds and cannot put
//       two writes in one millisecond, so the equality is ARRANGED BY A
//       LABELLED STORE WRITE of the teardown operation's `finalized_at` (a
//       wall stamp only; no event, seq or rowid is touched) to the
//       observation's `observed_at`, the store order left as made;
//   (d) rows that predate the ordering fact: see the case at the end.
//
// SAFETY: no unit, no systemctl, no host process; the only engine stopped
// is the test's own (`t.after`).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { advanceClock, scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { adapterState, deploy, deployable, deployToRound, environmentRead, operationsOf, postDeployExecutions, scriptCall, teardown } from './harness/deploy/kernel.mjs';
import { recordExit, roundsOf, rowWhen } from './harness/deploy/rounds.mjs';
import { STEP_MARGIN, historyOf, observe, observedOf } from './harness/deploy/observe.mjs';

// The step back: far beyond the wall time a teardown or a deployment takes
// to finalize on this lane (a few seconds) and the host's own steps (≈3 s).
const STEP = 20;

// Generation 1 deployed, its round decided `failed` (the check exits 1: the
// candidate stays developing, so a replacement of it is an ordinary new
// request, as M329's `running`).
async function running(t) {
  const fx = await scriptedEngine(t);
  const ctx = await deployable(fx);
  const { operation, execution } = await deployToRound(ctx);
  const [round] = roundsOf(fx.home, operation.id);
  await recordExit(fx.engine, execution.id, 1);
  await rowWhen(ctx, round.id);
  await tick(fx.engine, ctx.project, { rounds: 2 });
  const g1 = (await adapterState(fx.engine, ctx.env.id)).target.units.find((u) => u.generation === 1);
  assert.ok(g1 && g1.state === 'active', 'the fixture is live: generation 1 runs on the target');
  return { ...ctx, op: operation };
}

async function stepBack(ctx, seconds) {
  await advanceClock(ctx.fx.engine, -seconds);
  ctx.fx.clockAdvanced = (ctx.fx.clockAdvanced ?? 0) - seconds;
}

async function envListed(ctx) {
  const res = await ctx.fx.engine.get(`/v1/projects/${ctx.project}/environments`);
  assert.equal(res.status, 200, `the environments list (→ ${res.status} ${res.text})`);
  return res.body.environments.find((e) => e.name === ctx.env.name);
}

// A healthy observation of the environment, read back as current and fresh with nothing ending it (the control).
async function healthyCurrent(ctx, what) {
  const row = await observe(ctx);
  assert.equal(row.condition, 'healthy', `${what}: the observation reads healthy (${JSON.stringify(row)})`);
  const read = (await environmentRead(ctx.fx.engine, ctx.project, ctx.env.name)).observed;
  assert.deepEqual([read.observed_at, read.condition, read.freshness, read.ended_by], [row.observed_at, 'healthy', 'fresh', undefined], `${what}: before anything ends it, it is current and fresh (${JSON.stringify(read)})`);
  return row;
}

async function tornDown(ctx) {
  const { fx, env, project } = ctx;
  await scriptCall(fx.engine, env.id, 'teardown', [{ result: 'issued', apply: true }]);
  const asked = await teardown(fx.engine, project, env.name);
  assert.ok(asked.status >= 200 && asked.status < 300, `the owner's teardown (→ ${asked.status} ${asked.text})`);
  return tickUntil(fx.engine, project, () => operationsOf(fx.home, project, 'teardown').find((o) => o.finalized_at !== null), { max: 16, what: 'the teardown to be finalized' });
}

// The store order of the two facts: the observation's `environment.observed`
// and the operation's `operation.finalized`, by event seq.
function storeOrder(home, env, observedAt, operation) {
  const obs = eventsOfType(home, 'environment.observed').filter((e) => e.subject?.environment === env && (e.payload?.observed_at === undefined || e.payload.observed_at === observedAt));
  const fin = eventsOfType(home, 'operation.finalized').filter((e) => e.subject?.operation === operation);
  assert.ok(obs.length >= 1, `the observation's environment.observed is in the journal (${JSON.stringify(obs.map((e) => e.payload))})`);
  assert.equal(fin.length, 1, `the operation's operation.finalized, once (${fin.length})`);
  return { observed: obs.at(-1).seq, finalized: fin[0].seq };
}

// The observation read as ended by `op` (kind `kind`), on the environment read and on the list.
async function assertEndedBy(ctx, stored, op, kind, what) {
  const env = await environmentRead(ctx.fx.engine, ctx.project, ctx.env.name);
  const o = env.observed;
  assert.equal(o.observed_at, stored.observed_at, `${what}: the read serves the stored observation (${JSON.stringify(o)})`);
  assert.deepEqual(
    [o.ended_by?.kind, o.ended_by?.operation],
    [kind, op.id],
    `${what}: the observation reads ended by the ${kind} (operation ${op.id}) although its finalized_at ${op.finalized_at} is not after observed_at ${stored.observed_at} (served ${JSON.stringify(o)})`,
  );
  assert.deepEqual([o.condition, o.freshness, o.stored_condition], ['unknown', 'expired', stored.condition], `${what}: never the pre-${kind} ${stored.condition} observation as current and fresh (${JSON.stringify(o)})`);
  assert.equal(o.ended_by?.finalized_at, op.finalized_at, `${what}: ended_by names the finalization as recorded`);
  const listed = await envListed(ctx);
  assert.equal(listed.state, 'unknown', `${what}: the environments list: unknown (${JSON.stringify(listed)})`);
  assert.deepEqual([listed.observed?.condition, listed.observed?.freshness, listed.observed?.ended_by?.kind, listed.observed?.ended_by?.operation], ['unknown', 'expired', kind, op.id], `${what}: the list serves the same end (${JSON.stringify(listed.observed)})`);
  return o;
}

describe('M630 what ended an observation, decided by store order', () => {
  test('(a) a healthy observation, the clock stepped back, a finalized teardown: the read right after serves the observation as ended by that teardown, never current and fresh', async (t) => {
    const ctx = await running(t);
    const { fx, env } = ctx;
    const seen = await healthyCurrent(ctx, '(a)');
    const historyBefore = historyOf(fx.home, env.id);
    await stepBack(ctx, STEP);
    const op = await tornDown(ctx);
    // The fixture is live: by wall stamps the teardown was finalized before the observation was made; by store order after.
    assert.ok(op.finalized_at < seen.observed_at, `the clock step inverts the stamps: finalized_at ${op.finalized_at} < observed_at ${seen.observed_at}`);
    const order = storeOrder(fx.home, env.id, seen.observed_at, op.id);
    assert.ok(order.observed < order.finalized, `by store order the observation (seq ${order.observed}) precedes the finalization (seq ${order.finalized})`);
    assert.equal(historyOf(fx.home, env.id).length, historyBefore.length, 'no observation was made between: the stored one is the healthy one');
    assert.equal(observedOf(fx.home, env.id)?.observed_at, seen.observed_at);
    await assertEndedBy(ctx, seen, op, 'teardown', '(a) right after the finalization');
    assert.equal(op.kind, 'teardown');
    assert.equal(observedOf(fx.home, env.id)?.condition, 'healthy', 'the stored observation is kept as it was');
    assert.deepEqual(historyOf(fx.home, env.id), historyBefore, 'the observation history untouched');
  });

  test('(b) replacement: the old observation reads ended by the replacing deployment; a later observation of the new generation is current, with no ended_by', async (t) => {
    const ctx = await running(t);
    const { fx, env, project } = ctx;
    const seen = await healthyCurrent(ctx, '(b)');
    assert.equal(seen.deployment_generation, 1, 'the observation is of generation 1');
    await stepBack(ctx, STEP);
    await scriptCall(fx.engine, env.id, 'deploy', [{ result: 'issued', apply: true }]);
    await deploy(fx.engine, project, ctx.candidate.id, env.name);
    const op2 = await tickUntil(fx.engine, project, () => operationsOf(fx.home, project, 'deploy').find((o) => o.id !== ctx.op.id && o.finalized_at !== null), { max: 16, what: 'the replacing deployment to be finalized' });
    assert.ok(op2.finalized_at < seen.observed_at, `the clock step inverts the stamps: finalized_at ${op2.finalized_at} < observed_at ${seen.observed_at}`);
    const order = storeOrder(fx.home, env.id, seen.observed_at, op2.id);
    assert.ok(order.observed < order.finalized, `by store order the observation (seq ${order.observed}) precedes the replacing finalization (seq ${order.finalized})`);
    await assertEndedBy(ctx, seen, op2, 'deployment', '(b) after the replacing deployment');
    // The replacement's round, then a later observation of generation 2 (the job falls due past the step).
    const x2 = await tickUntil(fx.engine, project, () => postDeployExecutions(fx.home, ctx.candidate.id).find((x) => x.deployment?.operation === op2.id), { max: 12, what: "the replacement's round" });
    await recordExit(fx.engine, x2.id, 1);
    await tick(fx.engine, project, { rounds: 2 });
    const later = await observe(ctx, env, { seconds: STEP + 31 + STEP_MARGIN });
    assert.equal(later.deployment_generation, 2, `the later observation is of generation 2 (${JSON.stringify(later)})`);
    const after = (await environmentRead(fx.engine, project, env.name)).observed;
    assert.equal(after.observed_at, later.observed_at, 'the read serves the later observation');
    assert.equal(after.ended_by, undefined, `the observation of the new generation is current: nothing ended it (${JSON.stringify(after)})`);
    assert.equal(after.condition, later.condition, 'its condition as recorded');
    assert.equal(after.freshness, 'fresh', 'its freshness as recorded: fresh');
    assert.equal(after.stored_condition, undefined);
    const listed = await envListed(ctx);
    assert.equal(listed.observed?.ended_by, undefined, `the list: no ended_by (${JSON.stringify(listed.observed)})`);
    assert.equal(listed.observed?.observed_at, later.observed_at);
  });

  test('(c) equal wall stamps (arranged by a labelled store write of the teardown\'s finalized_at): the same answer as (a), decided by store order', async (t) => {
    const ctx = await running(t);
    const { fx, env } = ctx;
    const seen = await healthyCurrent(ctx, '(c)');
    const op = await tornDown(ctx);
    const order = storeOrder(fx.home, env.id, seen.observed_at, op.id);
    assert.ok(order.observed < order.finalized, `by store order the observation (seq ${order.observed}) precedes the finalization (seq ${order.finalized})`);
    // FIXTURE TAMPERING (labelled): the two wall stamps made equal. Only `operations.finalized_at` is written; no event, seq or rowid.
    withStore(fx.home, (db) => db.prepare('UPDATE "operations" SET "finalized_at" = ? WHERE "id" = ?').run(seen.observed_at, op.id), { readonly: false });
    const equal = operationsOf(fx.home, ctx.project, 'teardown').find((o) => o.id === op.id);
    assert.equal(equal.finalized_at, seen.observed_at, 'the fixture is live: finalized_at equals observed_at to the millisecond');
    assert.deepEqual(storeOrder(fx.home, env.id, seen.observed_at, op.id), order, 'the store order of the two facts untouched');
    await assertEndedBy(ctx, seen, equal, 'teardown', '(c) equal stamps');
  });
});
