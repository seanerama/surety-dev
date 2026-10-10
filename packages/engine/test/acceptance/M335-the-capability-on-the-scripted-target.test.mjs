// M335, the capability's scope, on the scripted target (slice 28; kernel
// lane). M4 plan §3.6 M335; D4-A05; D4 §§2.2, 8.2; R2; SEAM.md §§247, 250,
// 295, 310, 315.
//
// The Release Operator mints an effect's capability from the attempt's
// frozen intent; only a defect or a forged internal call could present
// another. The harness forges one (SEAM §315's fault `capability_forged`:
// the next effect call's capability, as minted, has one member replaced
// before `adapterCall` checks it). For each member the plan names (another
// environment, another digest, another unit, a stale attempt, another
// generation, another incarnation, a stale lease generation; a unit outside
// the attempt's frozen intent; a unit name not derived from the home's hash;
// one failing the character check) the call is refused before any host
// call: no call reaches the scripted adapter (counted), the target is
// unchanged, `deploy.capability_refused` names the member, the attempt is
// `failed` with nothing applied, and no route answers
// `deploy_capability_refused`. A teardown's capability naming a unit outside
// its intent is refused the same way, the unit left running.
// `deploy_auto_retries_max` is 0, so no retry follows a refused attempt.
// The sandbox form (the host's unit list unchanged) is
// `M335-the-capability-on-a-real-unit.test.mjs`.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { scriptedEngine, tickUntil } from './harness/runs.mjs';
import {
  adapterState,
  attemptsOf,
  configContent,
  configure,
  deploy,
  deployable,
  forgeCapability,
  homeHash,
  operationRow,
  operationsOf,
  operationsRead,
  scriptCall,
  teardown,
  unitName,
} from './harness/deploy/kernel.mjs';

const POLICY = Object.freeze({ deploy_auto_retries_max: 0 });

const refusedEvents = (home, attempt) => eventsOfType(home, 'deploy.capability_refused').filter((e) => e.subject?.attempt === attempt);

describe('M335 every capability outside its attempt\'s scope is refused before any host call', () => {
  const shared = sharedFixture();
  let ctx;
  let other;
  const answers = [];
  const attempts = [];
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    ctx = await deployable(fx, { policy: POLICY });
    other = (await configure(fx.engine, ctx.project, 'beta', configContent())).environment;
  });
  after(async () => {
    try {
      for (const text of answers) assert.ok(!text.includes('"code":"deploy_capability_refused"') && !text.includes('"code": "deploy_capability_refused"'), `no route answers deploy_capability_refused (D4 A.6) (${text.slice(0, 300)})`);
    } finally {
      await shared.cleanup();
    }
  });

  // A deploy requested with the capability's `field` forged to `value`; the
  // attempt's fate read. Returns {op, attempt}.
  async function forged(field, value) {
    const { fx, project, candidate, env } = ctx;
    const known = new Set(operationsOf(fx.home, project, 'deploy').map((o) => o.id));
    const callsBefore = (await adapterState(fx.engine, env.id)).calls.filter((c) => ['deploy', 'teardown'].includes(c.call)).length;
    const targetBefore = (await adapterState(fx.engine, env.id)).target;
    await scriptCall(fx.engine, env.id, 'deploy', [{ result: 'issued', apply: true }]);
    await forgeCapability(fx.engine, env.id, field, typeof value === 'function' ? value() : value);
    const res = await fx.engine.post(`/v1/projects/${project}/deployments`, { candidate: candidate.id, environment: env.name });
    answers.push(res.text);
    assert.ok([200, 201].includes(res.status), `the request is issued (${res.text})`);
    const attempt = await tickUntil(fx.engine, project, () => {
      const op = operationsOf(fx.home, project, 'deploy').find((o) => !known.has(o.id));
      const a = op ? attemptsOf(fx.home, op.id)[0] : undefined;
      return a && a.status !== 'started' ? a : undefined;
    }, { max: 12, what: `the attempt with the forged ${field} to end` });
    const op = operationRow(fx.home, attempt.operation);
    attempts.push(attempt);
    const state = await adapterState(fx.engine, env.id);
    assert.equal(state.calls.filter((c) => ['deploy', 'teardown'].includes(c.call)).length, callsBefore, `${field}: no effect call reached the adapter: refused before any host call`);
    assert.deepEqual(state.target, targetBefore, `${field}: the target is unchanged`);
    assert.equal(attempt.status, 'failed', `${field}: the attempt is failed (${attempt.status})`);
    assert.ok(!['issued', 'uncertain'].includes(attempt.receipt?.result), `${field}: nothing issued (${JSON.stringify(attempt.receipt)})`);
    const events = refusedEvents(fx.home, attempt.id);
    assert.equal(events.length, 1, `${field}: deploy.capability_refused, once (${JSON.stringify(events)})`);
    assert.equal(events[0].payload?.field, field, `${field}: the event names the member that failed (${JSON.stringify(events[0].payload)})`);
    answers.push(JSON.stringify(await operationsRead(fx.engine, project)));
    return { op, attempt };
  }

  const h = () => homeHash(ctx.fx.home);
  const cases = [
    ['environment', 'another environment', () => other.id],
    ['artifact_digest', 'another digest', `sha256:${'b'.repeat(64)}`],
    ['create_units', 'another unit (another environment\'s)', () => [unitName(ctx.fx.home, other.id, 1)]],
    ['attempt', 'a stale attempt (an earlier, ended one)', () => attempts[0].id],
    ['generation', 'another generation', 999],
    ['incarnation', 'another incarnation', 'inc_00000000000000000000000000'],
    ['lease_generation', 'a stale lease generation', 0],
    ['create_units', 'a unit of the environment outside the attempt\'s frozen intent', () => [unitName(ctx.fx.home, ctx.env.id, 99)]],
    ['create_units', 'a unit name not derived from the home\'s hash', () => [`surety-${h() === '000000000000' ? '111111111111' : '000000000000'}-${ctx.env.id}-g1.service`]],
    ['create_units', 'a unit name failing the character check', () => [`surety-${h()}-${ctx.env.id}-g1.service;id`]],
  ];
  for (const [field, what, value] of cases) {
    test(`${what}: refused before any host call, deploy.capability_refused naming ${field}, the attempt failed with nothing applied`, async () => {
      await forged(field, value);
    });
  }

  test('a teardown\'s capability naming a unit outside its intent: refused before any host call, the running unit left as it was', async () => {
    const { fx, project, candidate, env } = ctx;
    // A deploy that applies: a unit of the environment runs.
    const known = new Set(operationsOf(fx.home, project, 'deploy').map((o) => o.id));
    await scriptCall(fx.engine, env.id, 'deploy', [{ result: 'issued', apply: true }]);
    await deploy(fx.engine, project, candidate.id, env.name);
    await tickUntil(fx.engine, project, () => {
      const op = operationsOf(fx.home, project, 'deploy').find((o) => !known.has(o.id));
      return op && attemptsOf(fx.home, op.id)[0]?.status === 'succeeded' ? op : undefined;
    }, { max: 12, what: 'the deploy to apply' });
    const before = await adapterState(fx.engine, env.id);
    assert.ok(before.target.units.some((u) => u.state === 'active'), 'the fixture is live: a unit of the environment is active');

    await scriptCall(fx.engine, env.id, 'teardown', [{ result: 'issued', apply: true }]);
    await forgeCapability(fx.engine, env.id, 'stop_units', [unitName(fx.home, env.id, 99)]);
    const knownT = new Set(operationsOf(fx.home, project, 'teardown').map((o) => o.id));
    const asked = await teardown(fx.engine, project, env.name);
    answers.push(asked.text);
    const attempt = await tickUntil(fx.engine, project, () => {
      const op = operationsOf(fx.home, project, 'teardown').find((o) => !knownT.has(o.id));
      const a = op ? attemptsOf(fx.home, op.id)[0] : undefined;
      return a && a.status !== 'started' ? a : undefined;
    }, { max: 16, what: 'the teardown\'s attempt with the forged stop_units to end' });
    const after = await adapterState(fx.engine, env.id);
    assert.equal(after.calls.filter((c) => c.call === 'teardown').length, before.calls.filter((c) => c.call === 'teardown').length, 'no teardown call reached the adapter');
    assert.deepEqual(after.target.units, before.target.units, 'the running unit is as it was');
    assert.equal(attempt.status, 'failed', `the teardown's attempt is failed (${attempt.status})`);
    const events = refusedEvents(fx.home, attempt.id);
    assert.equal(events.length, 1, `deploy.capability_refused, once (${JSON.stringify(events)})`);
    assert.equal(events[0].payload?.field, 'stop_units', `naming stop_units (${JSON.stringify(events[0].payload)})`);
  });
});
