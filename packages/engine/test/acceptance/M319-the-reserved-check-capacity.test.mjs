// M319, verification capacity reserved, on real domains (slice 25; sandbox
// lane). M4 plan §3.3 M319 (b), (c); D4-O14; D4 §4.7; E115 item 3; E126;
// SEAM.md §§256 to 259, 271. Case (a), the pre-effect refusal, is the
// scripted file M319-capacity-reserved-at-admission.
//
// A running service takes no slot of max_concurrent_domains; it holds its
// memory and, while it runs, one check domain's capacity is kept free and
// shared by post-deploy checks, which run serially (E126). So:
//   (b) with the envelope otherwise full of role runs, a new verification
//       round's post-deploy check of the running service is still admitted,
//       into the reserved capacity, and runs; deployment's mandatory
//       verification is never made impossible by other work;
//   (c) after an engine restart that leaves the service running, the
//       service domain's reservation (memory and check capacity) is restored
//       before any new work is dispatched: a role dispatch of another
//       project is held (resource_envelope) accounting for it. (The surviving
//       service's own supervision is unknown and nothing verifies on it,
//       E110; the recovery accounting is also M324's, slice 26.)
//
// SAFETY (BS4 §4.1; E64; SEAM.md §257). The only service unit is the
// engine's, under this test's home's prefix. No instrument acts on a unit;
// the second project's role is the scripted role program, held in its own
// domain. The file ends with the operator's guard; its first engine start
// carries the real-adapter switch.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { CONTRACT } from './harness/fixtures.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { addGitProject, addItem } from './harness/gitruns.mjs';
import { stopRun, waitForRunState } from './harness/runs.mjs';
import { roleAlive, roleHolding } from './harness/sandbox/lane.mjs';
import { deploy } from './harness/deploy/kernel.mjs';
import {
  endEnvironment,
  heldCheck,
  hostDeployable,
  hostEnvironment,
  newestOperation,
  operatorGuard,
  releaseCheck,
  serviceDomainOf,
  serviceOf,
  settleRound,
  ticksUntil,
  verificationOf,
} from './harness/deploy/host.mjs';
import { verifyAgain } from './harness/deploy/rounds.mjs';

// domain_memory_max and service_memory_max at their minimums, so two
// admitted domains plus the service fit in what the host has (as M220 does).
// service_memory_max is a project key (SEAM §252), set through the policy.
const ADMIT = Object.freeze({
  max_concurrent_domains: 2,
  domain_memory_max: CONTRACT.engine.domain_memory_max.min,
});
const POLICY = Object.freeze({ service_memory_max: 67108864 });

describe('M319 the reserved check capacity, on real domains', () => {
  const shared = sharedFixture();
  let guard;
  let ctx;
  before(async () => {
    guard = operatorGuard();
    ctx = await hostDeployable(shared.context, guard, { engineConfig: ADMIT, policy: POLICY });
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  // Deploy to a new environment and settle it to a verified, alpha_deployed
  // service running. Returns {env, op, svc}.
  async function deployed(name) {
    const env = await hostEnvironment(ctx, name);
    await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
    const op = await ticksUntil(ctx.fx, ctx.project, () => newestOperation(ctx, env), { what: `the deploy of ${name}` });
    const { row } = await settleRound(ctx, env, op);
    assert.equal(row.outcome, 'verified', `the service is verified and running (${row.outcome})`);
    return { env, op, svc: serviceOf(ctx, env, op) };
  }

  test('(b) with a role run of another project filling the envelope, the running service\'s new verification round\'s check is still admitted and runs', async () => {
    const d = await deployed('reserve');
    const other = await addGitProject(ctx.fx, { tier: 'T1' });
    const role = await roleHolding(ctx.fx, other.id, await addItem(ctx.fx, other.id, 'fix'));
    try {
      // The envelope now holds the service (its own memory, no slot), one
      // role domain, and the one check capacity kept free. A new round's
      // post-deploy check must be admitted into that reserved capacity.
      const round = await verifyAgain(ctx.fx.engine, ctx.project, d.op.id);
      const held = await ticksUntil(ctx.fx, ctx.project, () => heldCheck(ctx, d.env), { what: 'the new round\'s post-deploy check to be admitted beside the role run' });
      assert.ok(held, 'the service\'s verification check ran in its own check domain while the role held a domain (D4 §4.7; E126)');
      assert.ok(roleAlive(role.domain, role.launch), 'the role run was still holding its domain when the check was admitted (read in its domain by its pid inside the namespace; objection 041)');
      releaseCheck(ctx, d.svc, { get: ['/hello'], exit: 0 });
      const { row } = await verificationOf(ctx, d.op);
      assert.equal(row.round, round.id, 'the new round decided');
      assert.equal(row.outcome, 'verified', 'the check passed: mandatory verification was not made impossible by other work');
    } finally {
      await stopRun(ctx.fx.engine, other.id, role.run.id);
      await waitForRunState(ctx.fx.home, role.run.id, 'ended', { timeoutMs: 60_000 }).catch(() => undefined);
      await endEnvironment(ctx, d.env);
    }
  });

  test('(c) after an engine restart that leaves the service running, its reservation (memory and check capacity) is restored and the service domain stays accounted (not terminated), so it is counted before any admission', async () => {
    const d = await deployed('survive');
    const domainBefore = serviceDomainOf(ctx.fx.home, d.svc.attempt.id);
    assert.ok(domainBefore?.reservation?.memory && domainBefore?.reservation?.check_capacity, `the service domain records its reservation {memory, check_capacity} (${JSON.stringify(domainBefore?.reservation)})`);
    assert.notEqual(domainBefore.state, 'terminated', 'the service domain is live before the restart');
    await ctx.fx.engine.kill();
    await ctx.fx.start();
    await ctx.fx.engine.get('/v1/engine');
    const domainAfter = serviceDomainOf(ctx.fx.home, d.svc.attempt.id);
    assert.deepEqual(domainAfter?.reservation, domainBefore.reservation, 'the surviving service\'s reservation is restored across the restart, counted before any dispatch (D4 §9.2; E126)');
    assert.notEqual(domainAfter.state, 'terminated', 'the service domain is not closed by recovery: only its closure, once observed, frees its reservation (the dispatch it then blocks is M324\'s, slice 26)');
    await endEnvironment(ctx, d.env);
  });
});
