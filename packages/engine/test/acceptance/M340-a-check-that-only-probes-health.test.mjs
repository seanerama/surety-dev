// M340 (c), the Switchboard mutant under a check that only probes health: a
// LIMITATION (slice 29; project lane). M4 plan §3.7 M340 (c); E120 item 2;
// AR §7; BS4 §11.2; D4 §5.4, §11 class C (a post-deploy check does not prove
// that it tests the behaviour it covers); SEAM.md §§317, 321, 322, 325.
//
// The reference project in the form whose one required `post_deploy_behavior`
// check probes /health only; its Builder writes the Switchboard mutant. The
// engine verifies it: `verified`. The same running service, asked through the
// operator relay (SEAM §317) for the specified user operation, answers it
// wrongly. Shown and labelled a limitation, as M238 (b) labelled a bare
// `node --test`: a health-only check is never evidence that the service
// behaves. (a) and (b) are M340-the-switchboard-mutant.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §§257, 317). The test acts on no unit and
// signals nothing. Its one connection is a GET from its own process to the
// relay the engine opens on 127.0.0.1 at the environment's configured port,
// closed by the engine (`DELETE …/relay`) and by the teardown. The service
// has no act; the secret is a disposable random value, never printed. The
// environment is ended in `finally`; the file ends with `operatorGuard`.

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { deploy } from './harness/deploy/kernel.mjs';
import { endEnvironment, operatorGuard } from './harness/deploy/host.mjs';
import { outputText } from './harness/checks/fixtures.mjs';
import { SWITCHBOARD, referenceDeployable, referenceEnvironment, reportOf, roundChecks, roundRow } from './harness/project/service.mjs';

const LIMITATION = 'LIMITATION (D4 §5.4, §11 class C): a post-deploy check that only probes health verifies the Switchboard mutant; it is never evidence that the service behaves';

// One GET to 127.0.0.1:<port> from the test's own process: {status, body} or {error}.
const askLocal = (port, path) =>
  new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent: false, timeout: 15_000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ error: err.code ?? err.message }));
  });

describe('M340 (c) the Switchboard mutant under a check that only probes health', () => {
  const shared = sharedFixture();
  let guard;
  let ctx;
  const C = {};
  before(async () => {
    guard = operatorGuard();
    ctx = await referenceDeployable(shared.context, guard, { service: SWITCHBOARD, behaviour: 'health' });
    const env = await referenceEnvironment(ctx, 'alpha');
    C.env = env;
    const relay = `/v1/projects/${ctx.project}/environments/${env.name}/relay`;
    try {
      C.request = await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
      C.round = await roundRow(ctx, env);
      C.checks = roundChecks(ctx, C.round.round);
      C.opened = await ctx.fx.engine.post(relay, {});
      if (C.opened.status >= 200 && C.opened.status < 300) {
        C.health = await askLocal(env.content.port, '/health');
        C.sum = await askLocal(env.content.port, '/sum?a=2&b=3');
        C.closed = await ctx.fx.engine.request('DELETE', relay);
      }
    } finally {
      await endEnvironment(ctx, env);
    }
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test(`(c) ${LIMITATION}: verified on its health probe, while the running service answers the specified user operation wrongly`, () => {
    const health = C.checks.find((c) => c.key === 'health');
    assert.ok(health?.result, 'the health-only check has a result in the round');
    assert.deepEqual([health.result.execution_established, health.result.exit_status], [1, 0], 'it ran and passed');
    assert.equal(reportOf(outputText(ctx.fx.home, health.result), 'REF-HEALTH')?.[0]?.status, 200, 'the mutant\'s health answered');
    assert.equal(C.round.row.outcome, 'verified', `the engine verified the mutant on that check (${JSON.stringify({ outcome: C.round.row.outcome, missing: C.round.row.missing })})`);
    assert.ok(C.opened.status >= 200 && C.opened.status < 300, `the fixture is live: the operator relay opens to the running service (${C.opened.text})`);
    assert.equal(C.health?.status, 200, `through the relay, its health answers (${JSON.stringify(C.health)})`);
    let sum = null;
    try {
      sum = JSON.parse(C.sum?.body ?? 'null');
    } catch {
      sum = null;
    }
    assert.deepEqual([C.sum?.status, sum], [200, { sum: '23' }], `and the specified user operation fails on the same service: {"sum": "23"}, not 5 (${JSON.stringify(C.sum)})`);
    assert.ok(C.closed?.status >= 200 && C.closed.status < 300, 'the relay closed');
  });
});
