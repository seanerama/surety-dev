// M438 (h): a role domain allocating past its `role_memory_max` (M5 slice
// 37; EXHAUSTION LANE ONLY). M5 plan §3.7 M438 (h); D6-X06 ("a domain
// exceeding it ends resource_limit, its run infra_error, nothing else
// affected"); D6 §6.4 ("the cost, plainly"); E141 item 4; E69; E64; BS5 §4.1
// rules 8 to 10, 16; SEAM.md §§155, 427 The other cases of the row are
// `M438-the-envelope-as-built` (kernel) and
// `M438-the-profile-maxima-on-the-real-boundary` (sandbox).
//
// NEVER RUN ON THE DEVELOPMENT WORKSTATION: listed under the manifest's
// `exhaust` key and run only by `--lane exhaust` where
// SURETY_EXHAUSTION_HOST names the host (mini-hp01, E69 item 2), by Sean or
// by the driver at his request; off the designated host it is
// `not_exercised` (a failure, never a skip).
//
// The engine starts with `--harness-profile-maxima role=67108864` † (harness
// mode, this file only): every role domain's maximum is 64 MiB, E69's cap,
// below `role_memory_max`'s 512 MiB floor, recorded on the domain at
// admission as any profile maximum is. The instrument's work item gets
// Sean's other caps (64 tasks, 1 MiB and 64 inodes of volatile storage)
// through section 155's `domain_limits`, with **no `memory_max`** (a subset
// †): its memory bound is the profile's, not the override's. A second
// project's role domain holds beside it the whole time.
//   - the instrument's domain: `execution_domains.memory_max` 64 MiB, and
//     its cgroup's memory.max read from the host 64 MiB, before release;
//   - after release: the run `failed` / `infra_error`, its exit class
//     `resource_limit`, the OOM kill recorded from its own cgroup's
//     memory.events (`resource_events.oom_kill`);
//   - nothing else affected: the other role was alive throughout and
//     completes `completed`, its own domain records no OOM kill; the engine
//     answers.
//
// SAFETY (E64's two halves, E69). The allocation is the guarded,
// self-bounded `allocate_to_limit` (1 MiB at a time, stopping itself at
// 128 MiB), which the role program refuses outside a sandbox (its pid, net
// and mnt namespaces not the host's, pid 1 no system init, at most 16
// processes visible) or above Sean's caps. The test releases it only after
// it has read from the host that the role is contained in its domain's
// cgroup (a member, under this home's prefix) and that the domain's
// pids.max, memory.max, memory.swap.max and volatile filesystem are exactly
// the caps (limitedRole); any other reading fails the case before release.
// The test signals nothing; the held second role ends by its release file.
// On mini-hp01: TMPDIR on disk, XDG_RUNTIME_DIR=/run/user/1000, Node
// 22.22.0 (rule 16).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const DESIGNATED = typeof process.env.SURETY_EXHAUSTION_HOST === 'string' && process.env.SURETY_EXHAUSTION_HOST !== '' && process.env.SURETY_EXHAUSTION_HOST === hostname();

if (!DESIGNATED) {
  describe('M438 (h) a role domain past its maximum (exhaustion lane)', () => {
    test('not_exercised: M438 (h) runs only on the designated exhaustion host (SURETY_EXHAUSTION_HOST equal to the host name; E69); nothing was started', () => {
      assert.fail(`not_exercised off the designated host: this host is ${hostname()}, SURETY_EXHAUSTION_HOST is ${JSON.stringify(process.env.SURETY_EXHAUSTION_HOST ?? null)} (E69; BS5 §16 question 2)`);
    });
  });
} else {
  await pastTheMaximumOnTheDesignatedHost();
}

async function pastTheMaximumOnTheDesignatedHost() {
  const { newId } = await import('./harness/ids.mjs');
  const { addProject, addWork, assertRunEnded, runsOf, tick, waitForRunState } = await import('./harness/runs.mjs');
  const { domainOf, receiptOf, roleAlive, roleProcess, sandboxEngine, scopeUnitPrefix, terminalObservation } = await (async () => {
    const lane = await import('./harness/sandbox/lane.mjs');
    const cg = await import('./harness/sandbox/cgroup.mjs');
    return { ...lane, scopeUnitPrefix: cg.scopeUnitPrefix };
  })();
  const { CAPS, limitedRole } = await import('./harness/sandbox/limits.mjs');
  const { step } = await import('./harness/scripted.mjs');

  const MIB = 1024 * 1024;
  const PROFILE = 64 * MIB;
  assert.equal(PROFILE, CAPS.memory_max, 'the profile maximum is Sean\'s memory cap (E69 item 1)');
  const terminalOf = (fx, runId) => terminalObservation(fx.home, receiptOf(fx.home, runId).id);
  const readMax = (dir) => readFileSync(join(dir, 'memory.max'), 'utf8').trim();

  describe('M438 (h) a role domain past its maximum (exhaustion lane)', () => {
    test('a role allocating past role_memory_max 64 MiB: resource_limit, infra_error, the OOM kill in its own cgroup; the role beside it unaffected', async (t) => {
      const fx = await sandboxEngine(t, { start: false });
      await fx.start({ args: ['--harness-profile-maxima', `role=${PROFILE}`] });
      const prefix = scopeUnitPrefix(fx.home);

      // The other project's role, held beside the instrument throughout.
      const other = (await addProject(fx)).id;
      const otherItem = await addWork(fx.engine, other, 'verification');
      fx.scripted.script(otherItem, [{ steps: [step.hold('gate', { heartbeat_ms: 250 }), step.result()] }]);
      await tick(fx.engine, other);
      const otherLaunch = await fx.scripted.waitForHolding({ work_item: otherItem }, 'gate');
      const otherRun = await waitForRunState(fx.home, otherLaunch.run, 'executing');
      const otherDomain = domainOf(fx.home, otherRun.id);
      assert.ok(otherDomain.cgroup_path.includes(prefix), `the other role's domain is this home's (${otherDomain.cgroup_path})`);
      await roleProcess(fx, otherDomain, otherLaunch);

      // The instrument: Sean's caps but memory through the trigger fixture, memory from the profile.
      const project = (await addProject(fx)).id;
      const res = await fx.engine.post('/v1/harness/fixtures/trigger', {
        project,
        kind: 'verification',
        trigger_source: 'test',
        trigger_id: newId('trg_'),
        trigger_generation: 1,
        domain_limits: { pids_max: CAPS.pids_max, writable_bytes: CAPS.writable_bytes, writable_inodes: CAPS.writable_inodes },
      });
      assert.equal(res.status, 201, `a trigger with domain_limits and no memory_max (a subset †) (→ ${res.status} ${res.text})`);
      const item = res.body.work_item.id;
      // The test's half: contained, and every limit exactly the caps (memory.max from the profile), before release.
      const armed = await limitedRole(fx, project, item, CAPS, { acts: (act) => [act.allocateToLimit(CAPS)], result: false });
      assert.ok(armed.domain.cgroup_path.includes(prefix), `the instrument's domain is this home's (${armed.domain.cgroup_path})`);
      assert.equal(armed.domain.memory_max, PROFILE, `execution_domains.memory_max is the profile's 64 MiB, recorded at admission (${JSON.stringify(armed.domain)})`);
      assert.equal(readMax(armed.domain.cgroup_path), String(PROFILE), 'host-read: memory.max 64 MiB');
      assert.ok(roleAlive(otherDomain, otherLaunch), 'the other role is alive before the release');

      const ended = await armed.release();
      const log = fx.scripted.eventsOfInvocation(armed.launch.invocation, 'probe').filter((e) => e.action === 'allocate_to_limit');
      assert.ok(log.some((e) => e.step === 'control'), 'the fixture is live: the role allocated');
      assert.ok(!log.some((e) => e.step === 'done'), 'the role never reached its own ceiling: the kernel ended it');
      assertRunEnded(fx.home, armed.run.id, { outcome: 'failed', reason_class: 'infra_error', launched: true, recovery: false });
      const terminal = terminalOf(fx, armed.run.id);
      assert.equal(terminal.exit_class, 'resource_limit', `exit class (${JSON.stringify(terminal)})`);
      assert.ok(terminal.exit_evidence.resource_events.oom_kill >= 1, `the OOM kill recorded from its own cgroup's memory.events (${JSON.stringify(terminal.exit_evidence.resource_events)})`);
      assert.match(ended.reason_text ?? '', /resource_limit/, `the run's reason names the class (${ended.reason_text})`);

      // Nothing else affected.
      assert.ok(roleAlive(otherDomain, otherLaunch), 'the other role is still alive after the OOM kill');
      assert.equal((await fx.engine.get('/v1/health')).status, 200, 'the engine answers');
      fx.scripted.release(otherItem, 'gate');
      await waitForRunState(fx.home, otherRun.id, 'ended', { timeoutMs: 60_000 });
      const [otherEnded] = runsOf(fx.home, otherItem);
      assert.deepEqual([otherEnded.outcome, otherEnded.reason_class], ['completed', 'none'], `the other role completes (${otherEnded.reason_text})`);
      const otherTerminal = terminalOf(fx, otherRun.id);
      assert.ok(!((otherTerminal.exit_evidence?.resource_events?.oom_kill ?? 0) > 0), `no OOM kill in the other domain (${JSON.stringify(otherTerminal.exit_evidence?.resource_events)})`);
    });
  });
}
