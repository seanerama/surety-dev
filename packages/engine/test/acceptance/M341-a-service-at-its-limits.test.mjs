// M341, a service at its memory and task limits (slice 29; EXHAUSTION LANE
// ONLY). M4 plan §3.7 M341; D4-T05; D4 §§6.2, 9.2; Q6; E69; BS4 §4.1 rules 3,
// 8, 10, §16 questions 2 and 8 (decided as recommended, E121 item 4);
// SEAM.md §§145, 321, 326.
//
// NEVER RUN ON THE DEVELOPMENT WORKSTATION. This file is listed under the
// manifest's `exhaust` key and nowhere else; `node scripts/run-tests.mjs
// acceptance --lane exhaust` runs it only where SURETY_EXHAUSTION_HOST
// equals the host's name (mini-hp01, E69 item 2), by Sean or by the driver at
// his request. Off that host the file does nothing and fails its one case
// `not_exercised` (a failure, never a skip, as M130 (f)'s placeholders did:
// SEAM §145); no engine is started.
//
// On mini-hp01, in a disposable home, the engine deploys only units its own
// home derives (no deployment target is there beyond them; question 2), the
// limits lowered by policy to E69's caps (`service_memory_max` 64 MiB,
// `service_tasks_max` 64):
//   (a) the service allocates past `service_memory_max`: the OOM kill is the
//       domain cgroup's own (its `memory.events` `oom_kill` rises, no other
//       domain's does), the application's exit is recorded
//       (`deploy.service_exited`, `app_exit` by SIGKILL), and the observation
//       reads `down` (D4 §6.2);
//   (b) the service starts `sleep` children past `service_tasks_max`: held at
//       the limit (`pids.current` within `pids.max`, `pids.events` `max`
//       risen), recorded on the domain (`resource_events.pids_max` at least 1
//       once it ends, SEAM §145's form), and the condition is what §6.2
//       maps from what was read, `healthy` included (question 8 (a));
//   (c) meanwhile the round's check domain of the same engine, held during the
//       act, ends with an established result and no OOM kill of its own, and
//       the host's user manager stays `running`.
//
// SAFETY (E64 item 2, E69, BS4 §4.1 rule 8; SEAM.md §326). Two halves and
// self-bounds: the service's acts refuse unless SURETY_TEST_EXHAUST is 1, its
// namespaces are not the test's, pid 1 is no system init and at most 16
// processes are visible (harness/deploy/exhaust-service.cjs); each stops by
// itself at 128 MiB or 96 children. The test asks for an act (through its
// held check program and the service link) only after reading from the host
// that the unit carries this home's prefix, the application is in that
// unit's cgroup and in none of the host's namespaces
// (`assertServiceContained`), and the unit's `memory.max`, `memory.swap.max`
// and `pids.max` are exactly the caps. Nothing is signalled; units are the
// engine's, ended by its teardown in `finally`; the file ends with
// `operatorGuard`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

const DESIGNATED = typeof process.env.SURETY_EXHAUSTION_HOST === 'string' && process.env.SURETY_EXHAUSTION_HOST !== '' && process.env.SURETY_EXHAUSTION_HOST === hostname();

if (!DESIGNATED) {
  describe('M341 a service at its limits (exhaustion lane)', () => {
    test('not_exercised: M341 runs only on the designated exhaustion host (SURETY_EXHAUSTION_HOST equal to the host name; E69); nothing was started', () => {
      assert.fail(`not_exercised off the designated host: this host is ${hostname()}, SURETY_EXHAUSTION_HOST is ${JSON.stringify(process.env.SURETY_EXHAUSTION_HOST ?? null)} (E69; BS4 §16 question 2)`);
    });
  });
} else {
  await limitsOnTheDesignatedHost();
}

async function limitsOnTheDesignatedHost() {
  const { sharedFixture } = await import('./harness/gates.mjs');
  const { eventsOfType } = await import('./harness/journal.mjs');
  const { CGROUP_ROOT } = await import('./harness/sandbox/cgroup.mjs');
  const { withStore } = await import('./harness/store.mjs');
  const { RUNTIME } = await import('./harness/deploy/kernel.mjs');
  const host = await import('./harness/deploy/host.mjs');
  const { observeOnHost } = await import('./harness/deploy/observe.mjs');

  const MIB = 1024 * 1024;
  const CAPS = Object.freeze({ memory: 64 * MIB, tasks: 64 });
  const POLICY = Object.freeze({ deploy_auto_retries_max: 0, service_memory_max: CAPS.memory, service_tasks_max: CAPS.tasks, identity_observation_every: 1 });
  const EXHAUST_SERVICE = readFileSync(new URL('./harness/deploy/exhaust-service.cjs', import.meta.url), 'utf8');

  const cgFile = (cg, file) => readFileSync(join(cg, file), 'utf8').trim();
  const counter = (cg, file, key) => {
    const line = cgFile(cg, file).split('\n').find((l) => l.startsWith(`${key} `));
    return line ? Number(line.split(' ')[1]) : null;
  };
  const domainRow = (home, id) => {
    const row = withStore(home, (db) => db.prepare('SELECT * FROM "execution_domains" WHERE "id" = ?').get(id));
    return row ? { ...row, resource_events: row.resource_events ? JSON.parse(row.resource_events) : null, app_exit: row.app_exit ? JSON.parse(row.app_exit) : null } : null;
  };

  // The test's half: contained, and the unit's limits exactly the caps, read from the host.
  function assertAtCaps(ctx, svc) {
    host.assertServiceContained(ctx, svc, 'before the test asks for an exhausting act');
    const cg = join(CGROUP_ROOT, host.unitShow(svc.unit, ['ControlGroup']).ControlGroup);
    assert.equal(cgFile(cg, 'memory.max'), String(CAPS.memory), "host-read: the unit's memory.max is the cap; anything else is not released");
    assert.equal(cgFile(cg, 'memory.swap.max'), '0', 'host-read: it cannot swap');
    assert.equal(cgFile(cg, 'pids.max'), String(CAPS.tasks), "host-read: the unit's pids.max is the cap");
    return cg;
  }

  describe('M341 a service at its limits (exhaustion lane, on the designated host)', () => {
    const shared = sharedFixture();
    let guard;
    let ctx;
    before(async () => {
      guard = host.operatorGuard();
      ctx = await host.hostDeployable(shared.context, guard, { policy: POLICY, files: { 'exhaust.cjs': EXHAUST_SERVICE } });
    });
    after(async () => {
      try {
        guard.assertClean();
      } finally {
        await shared.cleanup();
      }
    });

    const environment = (name) => host.hostEnvironment(ctx, name, { start: [RUNTIME.path, 'exhaust.cjs'], env: { SURETY_TEST_HOST_NS: host.hostNsValue(), SURETY_TEST_EXHAUST: '1' } });

    test('(a), (c) past service_memory_max: the OOM kill is the domain\'s own, the exit recorded, the observation down; the check domain and the host unaffected', async () => {
      const env = await environment('memory');
      try {
        const { op, held, svc } = await host.deployHeld(ctx, env);
        const cg = assertAtCaps(ctx, svc);
        const before = counter(cg, 'memory.events', 'oom_kill');
        host.releaseCheck(ctx, svc, { get: ['/act/alloc'], exit: 1 });
        await host.hostUntil(() => {
          try {
            return counter(cg, 'memory.events', 'oom_kill') > before;
          } catch {
            return false;
          }
        }, { timeoutMs: 120_000, what: "the unit's own memory.events oom_kill to rise" });
        const { row } = await host.verificationOf(ctx, op);
        assert.ok(row, 'the round ended');
        const exited = await host.ticksUntil(ctx.fx, ctx.project, () => eventsOfType(ctx.fx.home, 'deploy.service_exited').find((e) => e.subject?.attempt === svc.attempt.id), { what: "the application's exit to be recorded" });
        const domain = domainRow(ctx.fx.home, exited.subject.domain);
        assert.ok(['SIGKILL', 9].includes(domain?.app_exit?.status?.signal), `the application's exit recorded, by SIGKILL (${JSON.stringify(domain?.app_exit)})`);
        const observed = await observeOnHost(ctx, env, host.ticksUntil);
        assert.equal(observed.condition, 'down', `the observation reads down after the OOM kill (D4 §6.2) (${JSON.stringify(observed)})`);
        const check = domainRow(ctx.fx.home, held.domain.id);
        const result = withStore(ctx.fx.home, (db) => db.prepare('SELECT * FROM "check_results" WHERE "execution" = ?').get(held.execution.id));
        assert.equal(result?.execution_established, 1, '(c) the check domain held during the act ended with an established result');
        assert.ok(!(check?.resource_events?.oom_kill > 0), `(c) and no OOM kill of its own (${JSON.stringify(check?.resource_events)})`);
        assert.equal(host.managerState(), 'running', '(c) the host\'s user manager is running');
      } finally {
        await host.endEnvironment(ctx, env);
      }
    });

    test('(b), (c) past service_tasks_max: held at the limit, recorded on the domain; the condition as §6.2 maps what was read, healthy included', async () => {
      const env = await environment('tasks');
      try {
        const { op, held, svc } = await host.deployHeld(ctx, env);
        const cg = assertAtCaps(ctx, svc);
        host.releaseCheck(ctx, svc, { get: ['/act/fork'], exit: 1 });
        await host.hostUntil(() => {
          try {
            return counter(cg, 'pids.events', 'max') > 0;
          } catch {
            return false;
          }
        }, { timeoutMs: 120_000, what: "the unit's pids.events max to rise" });
        assert.ok(Number(cgFile(cg, 'pids.current')) <= CAPS.tasks, 'host-read: held at the limit');
        const { row } = await host.verificationOf(ctx, op);
        assert.ok(row, 'the round ended');
        const alive = host.procInstance(svc.app.pid)?.start_time === svc.app.start_time;
        const observed = await observeOnHost(ctx, env, host.ticksUntil);
        const expected = alive && observed.facts?.identity?.match === 'match' ? 'healthy' : 'down';
        assert.equal(observed.condition, expected, `the condition is §6.2's mapping of what was read (the application ${alive ? 'running' : 'gone'}; question 8 (a)) (${JSON.stringify(observed)})`);
        const result = withStore(ctx.fx.home, (db) => db.prepare('SELECT * FROM "check_results" WHERE "execution" = ?').get(held.execution.id));
        assert.equal(result?.execution_established, 1, '(c) the check domain held during the act ended with an established result');
        assert.equal(host.managerState(), 'running', '(c) the host\'s user manager is running');
      } finally {
        await host.endEnvironment(ctx, env);
      }
      const domain = withStore(ctx.fx.home, (db) => db.prepare(`SELECT d.* FROM "execution_domains" d JOIN "operation_attempts" a ON a."id" = d."attempt" JOIN "operations" o ON o."id" = a."operation" WHERE o."kind" = 'deploy' ORDER BY d.rowid DESC`).get());
      const events = domain?.resource_events ? JSON.parse(domain.resource_events) : null;
      assert.ok(events?.pids_max >= 1, `recorded on the domain once it ended: resource_events.pids_max at least 1 (SEAM.md §145's form) (${JSON.stringify(events)})`);
    });
  });
}
