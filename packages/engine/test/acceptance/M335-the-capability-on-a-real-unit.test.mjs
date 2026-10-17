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
// and no `systemd-run` ran: the units whose names derive from this file's
// home hash (`surety-<h>-*`), read before and after, are unchanged, and the
// forged name, read by exact name before and after, is `not-found` both
// times. The read is confined to this home and the forged name (SEAM.md
// §474; E154 item 5): a host-wide `surety-*` read before and after also
// saw the units other files of the split gate's parallel workers started
// and stopped in that window.
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
// The loaded units whose names derive from this home's hash, in any state
// (SEAM.md §474): never another home's, so a parallel file's units cannot
// change it. The engine names every unit it starts from its home's hash.
const homeUnits = (home) => {
  const units = listUnits();
  assert.ok(units !== null, 'the user units can be listed');
  const prefix = `surety-${homeHash(home)}-`;
  return units.filter((u) => u.unit.startsWith(prefix)).map((u) => `${u.unit} ${u.active}`).sort();
};
// The forged unit, by exact name only.
const loadState = (name) => {
  const shown = unitShow(name, ['LoadState']);
  assert.ok(shown !== null, `host-read: ${name} can be shown`);
  return shown.LoadState;
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
    test(`${what}: refused before any host call, naming ${field}; this home's units and the forged name unchanged`, async () => {
      const env = await hostEnvironment(ctx, `cap${n + 1}`);
      try {
        const before = homeUnits(ctx.fx.home);
        const name = forgedName(env);
        if (name !== null) assert.equal(loadState(name), 'not-found', `host-read: ${name} does not exist before the request`);
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
        assert.deepEqual(homeUnits(ctx.fx.home), before, 'host-read: the units of this home are unchanged (no systemd-run ran)');
        if (name !== null) assert.equal(loadState(name), 'not-found', `host-read: ${name} was never created`);
      } finally {
        await endCase(ctx, env);
      }
    });
  });
});
