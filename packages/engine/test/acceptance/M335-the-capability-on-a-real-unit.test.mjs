// M335, the capability's scope, on the real adapter (slice 28; sandbox
// lane). M4 plan §3.6 M335; D4-A05; D4 §§2.2, 8.2, 9.3, 9.5; BS4 §4.1 rule
// 5; SEAM.md §§256, 257, 310, 315.
//
// The kernel file (`M335-the-capability-on-the-scripted-target.test.mjs`)
// refuses every forged member; here three of them reach the real
// `local_service` adapter's entry: another environment, a unit of the
// environment outside the attempt's frozen intent, and a unit name not
// derived from the home's hash. Each is refused before any host call:
// `deploy.capability_refused` names the member, the attempt is `failed`,
// and the host's unit list is unchanged (every `surety-*` unit, read before
// and after, and the forged name `not-found`), so no `systemd-run` ran.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §257). The forged names are read only, by
// exact name; nothing creates, stops or signals a unit or a process. Every
// environment is ended in `finally`; the file ends with `operatorGuard`.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { attemptsOf, configure, forgeCapability, homeHash, operationsOf, unitName } from './harness/deploy/kernel.mjs';
import { endCase, hostConfig, hostDeployable, hostEnvironment, listUnits, operatorGuard, ticksUntil, unitShow } from './harness/deploy/host.mjs';

const POLICY = Object.freeze({ deploy_auto_retries_max: 0, service_memory_max: 67108864 });
const suretyUnits = () => {
  const units = listUnits();
  assert.ok(units !== null, 'the user units can be listed');
  return units.filter((u) => u.unit.startsWith('surety-')).map((u) => `${u.unit} ${u.active}`).sort();
};

describe('M335 a forged capability is refused before any host call, on the real adapter', () => {
  const shared = sharedFixture();
  let guard;
  let ctx;
  let other;
  before(async () => {
    guard = operatorGuard();
    ctx = await hostDeployable(shared.context, guard, { policy: POLICY });
    other = (await configure(ctx.fx.engine, ctx.project, 'other', await hostConfig())).environment;
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  const cases = [
    ['environment', 'another environment', () => other.id, () => null],
    ['create_units', 'a unit of the environment outside the attempt\'s frozen intent', (env) => [unitName(ctx.fx.home, env.id, 99)], (env) => unitName(ctx.fx.home, env.id, 99)],
    ['create_units', 'a unit name not derived from the home\'s hash', (env) => [`surety-${homeHash(ctx.fx.home) === '000000000000' ? '111111111111' : '000000000000'}-${env.id}-g1.service`], (env) => `surety-${homeHash(ctx.fx.home) === '000000000000' ? '111111111111' : '000000000000'}-${env.id}-g1.service`],
  ];
  cases.forEach(([field, what, value, forgedName], n) => {
    test(`${what}: refused before any host call, naming ${field}; the host's units unchanged`, async () => {
      const env = await hostEnvironment(ctx, `cap${n + 1}`);
      try {
        const before = suretyUnits();
        await forgeCapability(ctx.fx.engine, env.id, field, value(env));
        const res = await ctx.fx.engine.post(`/v1/projects/${ctx.project}/deployments`, { candidate: ctx.candidate.id, environment: env.name });
        assert.ok([200, 201].includes(res.status), `the request is issued (${res.text})`);
        assert.ok(!res.text.includes('deploy_capability_refused'), 'no route answers deploy_capability_refused');
        const attempt = await ticksUntil(ctx.fx, ctx.project, () => {
          const op = operationsOf(ctx.fx.home, ctx.project, 'deploy').filter((o) => o.target?.environment === env.id).at(-1);
          const a = op ? attemptsOf(ctx.fx.home, op.id)[0] : undefined;
          return a && a.status !== 'started' ? a : undefined;
        }, { what: `the attempt with the forged ${field} to end` });
        assert.equal(attempt.status, 'failed', `the attempt is failed (${attempt.status})`);
        const events = eventsOfType(ctx.fx.home, 'deploy.capability_refused').filter((e) => e.subject?.attempt === attempt.id);
        assert.equal(events.length, 1, `deploy.capability_refused, once (${JSON.stringify(events)})`);
        assert.equal(events[0].payload?.field, field, `naming ${field} (${JSON.stringify(events[0].payload)})`);
        assert.deepEqual(suretyUnits(), before, 'host-read: the unit list is unchanged (no systemd-run ran)');
        const name = forgedName(env);
        if (name !== null) assert.equal(unitShow(name, ['LoadState'])?.LoadState, 'not-found', `host-read: ${name} was never created`);
      } finally {
        await endCase(ctx, env);
      }
    });
  });
});
