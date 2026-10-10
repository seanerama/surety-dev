// M314, the service link (slice 25; sandbox lane). M4 plan §3.3 M314;
// D4-V02; J8; X1; D4 §§5.1, 5.2; SEAM.md §§256 to 258, 268.
//
// One engine and one project whose `behaves` check is the link-probing
// program (host.mjs `behaves: 'link'`), which the engine runs in a `check`
// domain reaching the service only through the engine-brokered link. Each
// case deploys to an environment of its own, releases the held link check
// with a plan after reading the check's containment from the host, reads its
// report and the service_link_log records, and ends the environment.
//   (a) the deploy-bound check's tree holds the protected inputs only, no
//       candidate source (an empty source projection);
//   (b) the check reaches the frozen generation through SURETY_TARGET_APP;
//       other loopback ports and a host address are not reachable from the
//       check's namespace (shown by the report and a host read; such
//       attempts never reach the engine, so they are not in the link log);
//   (c), (e) every connection the link relays is written to a
//       service_link_log record of the execution, bound to the execution,
//       round, operation, attempt, generation and application instance;
//   (d) the check's reply grants no reverse connection: a listener the check
//       opens accepts nothing, and the service reaches neither the engine
//       nor the check;
//   (f) the service_link_* limits, lowered by the engine configuration:
//       a tunnel past tunnel_max_seconds is closed, a connection past
//       tunnels_max is refused, each logged with its limit;
//   (g) the same `behaves` check from a non-deployment trigger (the operator
//       route) is environment_unbound (D3 §5 X3), and D2's proxy and M215's
//       egress restrictions are unchanged.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §§257, 258, 268). Every unit is the
// engine's, under this test's home's prefix. The link check is an instrument
// that tries addresses other than its target, holds tunnels and listens for
// a connection back; it runs those steps only when it reads its own
// containment from inside, and the test writes its plan only after reading
// the check's containment from the host (`releaseLink`). It signals nothing
// and starts no process. The file ends with the operator's guard; its first
// engine start carries the real-adapter switch.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { executionsOf, requestChecks, resultRow } from './harness/checks/fixtures.mjs';
import { attemptsOf, deploy, roundsOf } from './harness/deploy/kernel.mjs';
import {
  RELEASE,
  endEnvironment,
  heldCheck,
  hostDeployable,
  hostEnvironment,
  linkReport,
  newestOperation,
  operatorGuard,
  releaseLink,
  serviceLinkLogs,
  ticksUntil,
  verificationOf,
} from './harness/deploy/host.mjs';
import { freePort } from './harness/engine.mjs';

const LINK = { program: 'link-check.mjs' };

describe('M314 the service link', () => {
  const shared = sharedFixture();
  let guard;
  let ctx;
  before(async () => {
    guard = operatorGuard();
    ctx = await hostDeployable(shared.context, guard, { behaves: 'link', engineConfig: { service_link_tunnels_max: 1, service_link_tunnel_max_seconds: 60, service_link_connect_timeout: 1 } });
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  // Deploy to a new environment `name`, held with the link check running.
  async function heldDeploy(name, over = {}) {
    const env = await hostEnvironment(ctx, name, over);
    await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
    const held = await ticksUntil(ctx.fx, ctx.project, () => heldCheck(ctx, env, LINK), { what: `the link check of ${name} to hold` });
    const op = newestOperation(ctx, env);
    return { env, op, held };
  }

  // A case that deploys `name` held and runs body(h); whatever happens, a
  // check still held is let go (no step, exit 1), the environment is ended
  // through endEnvironment (the engine's teardown, then the test's stop by
  // exact name), and the release file is taken away, so a failing case
  // leaves no service holding the shared check capacity.
  async function linkCase(name, body) {
    let h = null;
    const file = join(ctx.prog.releaseDir, RELEASE);
    try {
      h = await heldDeploy(name);
      await body(h);
    } finally {
      if (!existsSync(file)) writeFileSync(file, JSON.stringify({ steps: [], exit: 1 }));
      try {
        if (ctx.envs[name]) await endEnvironment(ctx, ctx.envs[name]);
      } finally {
        rmSync(file, { force: true });
      }
    }
  }

  // Release the held link check with its steps, then read the verification
  // row and the link check's report. Returns {row, report, result}.
  async function runLink(h, steps, exit = 0) {
    releaseLink(ctx, h.held, { steps, exit });
    const { row } = await verificationOf(ctx, h.op);
    const { report, result } = linkReport(ctx, h.held.execution);
    return { row, report, result };
  }

  test('(a) the deploy-bound check\'s tree holds the protected inputs only, no candidate source', async () => {
    await linkCase('tree', async (h) => {
      const { report } = await runLink(h, [{ do: 'tree' }, { do: 'get', path: '/hello' }]);
      const tree = report.steps.find((s) => s.do === 'tree').result;
      const files = (tree.entries ?? []).map((e) => e.path);
      assert.ok(files.some((p) => p.startsWith('.surety/checks/')), `the protected inputs are present (${JSON.stringify(files)})`);
      assert.ok(!files.includes('server.js') && !files.some((p) => p === 'lib/greeting.js'), `no candidate source is in the tree (empty source projection, D4 §5.1) (${JSON.stringify(files)})`);
    });
  });

  test('(b) SURETY_TARGET_APP reaches the frozen generation; other loopback ports and a host address do not, and are not in the link log', async () => {
    await linkCase('reach', async (h) => {
      const otherPort = await freePort();
      const { report } = await runLink(h, [
        { do: 'get', path: '/hello' },
        { do: 'reach', host: '127.0.0.1', port: otherPort },
        { do: 'reach', host: '127.0.0.1', port: 9 },
      ]);
      const got = report.steps.find((s) => s.do === 'get').result;
      assert.equal(got.status, 200, `the target answers through the link (${JSON.stringify(got)})`);
      for (const r of report.steps.filter((s) => s.do === 'reach')) assert.notEqual(r.result.reached, true, `${r.host}:${r.port} is not reachable from the check's namespace (${JSON.stringify(r.result)})`);
      const logs = serviceLinkLogs(ctx.fx.home, ctx.project);
      const addresses = logs.flatMap((l) => l.entries).flatMap((e) => [e.address, e.authority, e.port]).filter((v) => v !== undefined);
      assert.ok(!addresses.includes(otherPort) && !addresses.includes(9), `the other ports never reached the engine, so they are not in the link log (${JSON.stringify(addresses)})`);
    });
  });

  test('(c), (e) every relayed connection is written to a service_link_log record bound to the execution, round, operation, attempt, generation and application instance', async () => {
    await linkCase('log', async (h) => {
      const { row } = await runLink(h, [{ do: 'get', path: '/hello' }, { do: 'get', path: '/version' }]);
      const round = roundsOf(ctx.fx.home, h.op.id).at(-1);
      const attempt = attemptsOf(ctx.fx.home, h.op.id).at(-1);
      const logs = serviceLinkLogs(ctx.fx.home, ctx.project).filter((l) => l.entries.some((e) => e.execution === h.held.execution.id));
      assert.ok(logs.length >= 1, `a service_link_log record for the execution (${logs.length})`);
      const entries = logs.flatMap((l) => l.entries).filter((e) => e.execution === h.held.execution.id);
      assert.ok(entries.length >= 2, `each relayed connection is logged (${entries.length})`);
      for (const e of entries) {
        assert.equal(e.execution, h.held.execution.id, 'the entry names the execution');
        assert.equal(e.round, round.id, 'the round');
        assert.equal(e.operation, h.op.id, 'the operation');
        assert.equal(e.attempt, attempt.id, 'the attempt');
        assert.equal(e.generation, attempt.deployment_generation, 'the generation');
        assert.deepEqual([e.instance?.pid, e.instance?.start_time], [attempt.app_instance.pid, attempt.app_instance.start_time], 'the application instance');
      }
      assert.equal(row.outcome, 'verified', 'the check passed through the link');
    });
  });

  test('(d) the check\'s reply grants no reverse connection: a listener the check opens accepts nothing', async () => {
    await linkCase('reverse', async (h) => {
      const port = await freePort();
      const { report } = await runLink(h, [{ do: 'listen', port }, { do: 'get', path: '/hello' }, { do: 'sleep', ms: 1500 }]);
      const listener = (report.listeners ?? []).find((l) => l.port === port);
      assert.ok(listener, 'the check opened a listener');
      assert.equal(listener.accepted, 0, 'nothing connected back to the check (D4 §5.2: the link carries application data only)');
    });
  });

  test('(f) a connection past service_link_tunnels_max (lowered to 1) is refused and logged with its limit', async () => {
    await linkCase('limit', async (h) => {
      await runLink(h, [{ do: 'open', id: 1, path: '/hello' }, { do: 'many', count: 3, path: '/hello', timeout_ms: 3000 }, { do: 'wait_closed', id: 1, max_s: 5 }]);
      const entries = serviceLinkLogs(ctx.fx.home, ctx.project).flatMap((l) => l.entries).filter((e) => e.execution === h.held.execution.id);
      const refused = entries.filter((e) => e.decision === 'refused' || e.limit?.key === 'service_link_tunnels_max');
      assert.ok(refused.some((e) => e.limit?.key === 'service_link_tunnels_max'), `a refusal names the tunnels_max limit (SEAM.md §268) (${JSON.stringify(entries.map((e) => [e.decision, e.limit]))})`);
    });
  });

  test('(g) the same behaves check from a non-deployment trigger never reaches the link: the operator route refuses it (not a required check of the candidate\'s stage or authorization scope) or records it environment_unbound (D3 §5 X3; M222 (c); M215 unchanged)', async () => {
    const isBehaves = (x) => x.key === 'behaves' && x.trigger?.source !== 'deployment_verification';
    const before = executionsOf(ctx.fx.home, ctx.candidate.id).filter(isBehaves).map((x) => x.id);
    const res = await requestChecks(ctx.fx.engine, ctx.project, ctx.candidate.id, { keys: ['behaves'] });
    assert.ok([202, 400].includes(res.status), `the operator route registers it or refuses it (body: ${res.text})`);
    if (res.status === 400) assert.equal(res.body?.code, 'invalid_value', `a refusal is invalid_value naming the keys (body: ${res.text})`);
    const fresh = await ticksUntil(
      ctx.fx,
      ctx.project,
      () => {
        const xs = executionsOf(ctx.fx.home, ctx.candidate.id).filter((x) => isBehaves(x) && !before.includes(x.id));
        if (res.status === 400) return { xs };
        return xs.length > 0 && xs.every((x) => ['recorded', 'cancelled', 'interrupted'].includes(x.status)) ? { xs } : undefined;
      },
      { what: 'the operator-triggered behaves execution to settle' },
    );
    if (res.status === 400) assert.equal(fresh.xs.length, 0, 'refused: nothing registered');
    for (const x of fresh.xs) {
      const r = x.result ? resultRow(ctx.fx.home, x.result) : null;
      assert.equal(r?.not_run_reason ?? x.not_run_reason ?? null, 'environment_unbound', `a deploy-bound check from a non-deployment trigger is environment_unbound (${JSON.stringify({ status: x.status, result: r })})`);
    }
  });
});
