// M130 (f) and (g), the exit classes a resource limit gives (M2 slice 13
// part 3; EXHAUSTION LANE ONLY). M2 plan §3.6 M130; D2 §1.6, §3.4, §3.7, A.2,
// A.3; E58 item 7; E69; SEAM.md §§126, 145, 155. The other cases of the row
// are `M130-exit-classes.test.mjs` (slice 13).
//
// NEVER RUN ON THE DEVELOPMENT WORKSTATION: listed under the manifest's
// `exhaust` key and run only by `--lane exhaust` where
// SURETY_EXHAUSTION_HOST names the host (mini-hp01, E69 item 2).
//
// (f) A role that allocates past memory.max (64 MiB, E69 item 1 raising the
// plan's 32 MiB) is OOM-killed by the kernel: exit class resource_limit,
// oom_kill in resource_events, failed / infra_error naming the class.
// (g) A Stop is confirmed, then the role allocates to OOM as the TERM
// reaches it: the engine had begun cancellation first, so the class is
// engine_signaled and the run keeps stopped / human_stop, with oom_kill
// recorded beside it.
//
// SAFETY (E64 item 2, E69; SEAM.md §155): the allocation is the guarded,
// self-bounded `allocate_to_limit` (at most 128 MiB, 1 MiB at a time),
// refused by the role program outside a sandbox or above Sean's caps, and
// released only after the host has read the role contained and its
// domain's limits the case's (limitedRole).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { addProject, assertRunEnded, stopRun, waitForRunState } from './harness/runs.mjs';
import { receiptOf, sandboxEngine, terminalObservation } from './harness/sandbox/lane.mjs';
import { CAPS, addLimitedWork, limitedRole } from './harness/sandbox/limits.mjs';
import { acting, hostNamespaces, step } from './harness/scripted.mjs';

const terminalOf = (fx, runId) => terminalObservation(fx.home, receiptOf(fx.home, runId).id);

describe('M130 (f), (g): the exit classes a resource limit gives', () => {
  test('(f) OOM at memory.max 64 MiB: resource_limit, oom_kill in resource_events, failed / infra_error naming the class', async (t) => {
    const fx = await sandboxEngine(t);
    const project = (await addProject(fx)).id;
    const item = await addLimitedWork(fx, project);
    const armed = await limitedRole(fx, project, item, CAPS, { acts: (act) => [act.allocateToLimit(CAPS)], result: false });
    const ended = await armed.release();
    const log = fx.scripted.eventsOfInvocation(armed.launch.invocation, 'probe').filter((e) => e.action === 'allocate_to_limit');
    assert.ok(log.some((e) => e.step === 'control'), 'the fixture is live: the role allocated');
    assert.ok(!log.some((e) => e.step === 'done'), 'the role never reached its own ceiling: the kernel ended it');
    assertRunEnded(fx.home, armed.run.id, { outcome: 'failed', reason_class: 'infra_error', launched: true, recovery: false });
    const terminal = terminalOf(fx, armed.run.id);
    assert.equal(terminal.exit_class, 'resource_limit', `exit class (${JSON.stringify(terminal)})`);
    assert.deepEqual([terminal.exit_evidence.signal_by_engine, terminal.exit_evidence.signal], [false, 9], 'a SIGKILL the engine did not send');
    assert.ok(terminal.exit_evidence.resource_events.oom_kill >= 1, `oom_kill recorded (${JSON.stringify(terminal.exit_evidence.resource_events)})`);
    assert.match(ended.reason_text ?? '', /resource_limit/, `the run's reason names the class (${ended.reason_text})`);
  });

  test('(g) a Stop confirmed, then the role allocates to OOM before the TERM ends it: engine_signaled keeps stopped / human_stop; oom_kill recorded', async (t) => {
    const fx = await sandboxEngine(t, { config: { terminate_grace: 10, kill_grace: 2 } });
    const project = (await addProject(fx)).id;
    const item = await addLimitedWork(fx, project);
    // On TERM the role allocates (guarded, self-bounded) instead of leaving.
    const onTerm = { steps: [acting(hostNamespaces()).allocateToLimit(CAPS)], then: 'exit' };
    const armed = await limitedRole(fx, project, item, CAPS, { after: [step.hold('gate')], result: false, on_term: onTerm });
    fx.scripted.release(item, 'armed');
    await fx.scripted.waitForHolding({ work_item: item }, 'gate');
    await stopRun(fx.engine, project, armed.run.id);
    await waitFor(() => fx.scripted.eventsOfInvocation(armed.launch.invocation, 'probe').some((e) => e.action === 'allocate_to_limit'), { timeoutMs: 30_000, what: 'the role to begin allocating on TERM' });
    await waitForRunState(fx.home, armed.run.id, 'ended', { timeoutMs: 60_000 });
    assertRunEnded(fx.home, armed.run.id, { outcome: 'stopped', reason_class: 'human_stop', launched: true, recovery: false });
    const terminal = terminalOf(fx, armed.run.id);
    assert.equal(terminal.exit_class, 'engine_signaled', `the cancellation began first: engine_signaled whatever the counter shows (${JSON.stringify(terminal)})`);
    assert.ok(terminal.exit_evidence.resource_events.oom_kill >= 1, `oom_kill recorded beside it (${JSON.stringify(terminal.exit_evidence.resource_events)})`);
  });
});
