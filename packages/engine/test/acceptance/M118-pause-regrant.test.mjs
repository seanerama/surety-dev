// M118, a healthy run survives a pause; nothing else is re-granted (M2
// slice 11, sandbox lane). M2 plan §3.3 M118; D2 §3.5, K5 (D2-B09,
// D2-B10); E36 item 6; E27 items 3, 5, 7; AR N01; SEAM.md §§16, 122, 126,
// 130.
//
// The engine is really stopped (SIGSTOP) for longer than lease_ttl with the
// scripted role alive and heartbeating inside the sandbox, then continued
// and ticked. A fresh challenge answered re-grants the lease on the same
// generation, leaving the deadline and the budget alone, and the run
// completes; a dropped response, with the heartbeats the role buffered
// during the pause, re-grants nothing and the run is recovered through the
// boundary; a role that finished during the pause completes by its clean
// exit; a deadline or a budget exhausted during the pause ends the run
// without a re-grant; a new incarnation never re-grants; a Stop confirmed
// before the pause completes; a backend that failed during the pause fails.
//
// Each pause is real time: lease_ttl's minimum plus a margin. Every case
// here is expected to fail on the engine these tests were written against,
// which has no init to challenge (COVERAGE.md, "M2 slice 11").

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { armFault, waitFor } from './harness/engine.mjs';
import { CONTRACT } from './harness/fixtures.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { changePolicy } from './harness/journal.mjs';
import { originalRowOf } from './harness/ledger.mjs';
import { addProject, addWork, advanceClockInSteps, assertRunEnded, CLOCK_SLACK_MS, leasesOf, run as runRow, stopRun, tick, waitForRun, waitForRunState, waitForWork } from './harness/runs.mjs';
import { cgroupExists, waitCgroupGone } from './harness/sandbox/cgroup.mjs';
import { eventsOf, receiptOf, roleAlive, roleHolding, sandboxEngine, terminalObservation } from './harness/sandbox/lane.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const LEASE_TTL = CONTRACT.engine.lease_ttl.min;
const PAUSE_MS = (LEASE_TTL + 3) * 1000;
const CONFIG = { lease_ttl: LEASE_TTL, terminate_grace: 3, kill_grace: 2 };

const runLease = (home, runId) => leasesOf(home, runId).find((l) => l.resource_kind === 'run');
const regrants = (home, runId) => eventsOf(home, 'run', runId, 'run.lease_regranted');
const usageRows = (home, invocation) => withStore(home, (db) => db.prepare('SELECT * FROM "usage_observations" WHERE "invocation" = ? ORDER BY "seq"').all(invocation));

// SIGSTOP the engine past lease_ttl, then SIGCONT. Returns the wall-clock
// time of the SIGCONT. The role inside the sandbox goes on meanwhile.
async function pause(fx) {
  const stoppedAt = Date.now();
  process.kill(fx.engine.pid, 'SIGSTOP');
  await sleep(PAUSE_MS);
  process.kill(fx.engine.pid, 'SIGCONT');
  return { stoppedAt, contAt: Date.now() };
}

describe('M118 a healthy run survives a pause', () => {
  test('(a) the challenge answered: run.lease_regranted on the same generation with a fresh challenge, expires_at renewed, deadline_at and the budget unchanged, the run completes', async (t) => {
    const fx = await sandboxEngine(t, { config: CONFIG });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const { run, domain, launch } = await roleHolding(fx, project, item, { on_term: 'exit', after: [step.result()] });
    const before = runLease(fx.home, run.id);
    const deadline = runRow(fx.home, run.id).deadline_at;

    const { contAt } = await pause(fx);
    assert.equal(roleAlive(domain, launch), true, 'the fixture is live: the role lived through the pause');
    await tick(fx.engine, project);
    const [event] = await waitFor(() => {
      const found = regrants(fx.home, run.id);
      return found.length > 0 ? found : undefined;
    }, { what: 'run.lease_regranted' });
    assert.equal(event.payload.generation, before.generation, 'the same generation: fencing is unchanged');
    const c = event.payload.challenge;
    assert.ok(c && typeof c.nonce === 'string' && /^[0-9a-f]{16,}$/.test(c.nonce), `a fresh nonce (${JSON.stringify(c)})`);
    assert.ok(Date.parse(c.sent_at) >= contAt - CLOCK_SLACK_MS, `the challenge was sent after the pause (${c.sent_at} vs ${new Date(contAt).toISOString()})`);
    assert.ok(Date.parse(c.answered_at) >= Date.parse(c.sent_at) - CLOCK_SLACK_MS, 'and answered after it was sent');
    assert.equal(c.backend_state, 'running', 'the init reported the backend running');
    const after = runLease(fx.home, run.id);
    assert.equal(after.id, before.id, 'the same lease row');
    assert.equal(after.generation, before.generation);
    assert.ok(Date.parse(after.expires_at) > Date.parse(before.expires_at), `expires_at renewed (${before.expires_at} → ${after.expires_at})`);
    assert.ok(Date.parse(event.payload.expires_at) > Date.parse(before.expires_at) && Date.parse(after.expires_at) >= Date.parse(event.payload.expires_at), `the event carries the renewed expiry, and later renewals only move it on (${event.payload.expires_at}, now ${after.expires_at})`);
    assert.ok(Date.parse(after.renewed_at) >= Date.parse(c.answered_at) - CLOCK_SLACK_MS, 'the renewal is the re-grant\'s, not a buffered heartbeat\'s');
    assert.equal(runRow(fx.home, run.id).deadline_at, deadline, 'deadline_at is unchanged');
    assert.equal(runRow(fx.home, run.id).state, 'executing', 'the run goes on');
    assert.equal(regrants(fx.home, run.id).length, 1, 'one re-grant');

    fx.scripted.release(item);
    await waitForRunState(fx.home, run.id, 'ended');
    assertRunEnded(fx.home, run.id, { outcome: 'completed', reason_class: 'none', launched: true, recovery: false });
    assert.equal(terminalObservation(fx.home, receiptOf(fx.home, run.id).id).exit_class, 'clean');
    await waitForWork(fx.home, item, 'complete');
  });

  test('(b) challenge_response_dropped with heartbeats buffered during the pause: no re-grant, the run recovered, the role terminated through the boundary, work held', async (t) => {
    const fx = await sandboxEngine(t, { config: CONFIG });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const { run, domain, launch } = await roleHolding(fx, project, item, { on_term: 'ignore', heartbeat_ms: 500 });
    const before = runLease(fx.home, run.id);
    await armFault(fx.engine, { point: 'challenge_response_dropped' });

    const { stoppedAt } = await pause(fx);
    assert.equal(roleAlive(domain, launch), true, 'the fixture is live: the role lived, heartbeating, through the pause');
    await tick(fx.engine, project);
    await waitForRunState(fx.home, run.id, 'ended', { timeoutMs: 60_000 });
    assert.deepEqual(regrants(fx.home, run.id), [], 'no re-grant without a fresh response');
    assertRunEnded(fx.home, run.id, { outcome: 'recovered', reason_class: 'recovered', launched: true, recovery: false });
    const after = leasesOf(fx.home, run.id).find((l) => l.id === before.id);
    assert.ok(Date.parse(after.renewed_at) <= stoppedAt + CLOCK_SLACK_MS, `a heartbeat buffered during the pause renewed nothing (last renewal ${after.renewed_at}, stopped at ${new Date(stoppedAt).toISOString()})`);
    assert.equal(roleAlive(domain, launch), false, 'the role was terminated through the boundary');
    await waitCgroupGone(domain.cgroup_path);
    assert.equal(terminalObservation(fx.home, receiptOf(fx.home, run.id).id).exit_evidence.signal_by_engine, true);
    await waitForWork(fx.home, item, 'held');
  });

  test('(c) the role exited 0 with a valid result during the pause: the run ends by its exit, completed on exit class clean, no re-grant', async (t) => {
    const fx = await sandboxEngine(t, { config: CONFIG });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const { run, domain, launch } = await roleHolding(fx, project, item, { on_term: 'exit', after: [step.result()] });
    process.kill(fx.engine.pid, 'SIGSTOP');
    await sleep(2000);
    fx.scripted.release(item);
    await waitFor(() => fx.scripted.eventsOfInvocation(launch.invocation, 'exit').some((e) => e.code === 0), { what: 'the role to exit 0 during the pause' });
    assert.equal(runRow(fx.home, run.id).state, 'executing', 'the fixture is live: the stopped engine recorded nothing of it');
    await sleep(PAUSE_MS - 2000);
    process.kill(fx.engine.pid, 'SIGCONT');
    await tick(fx.engine, project);
    await waitForRunState(fx.home, run.id, 'ended', { timeoutMs: 60_000 });
    assertRunEnded(fx.home, run.id, { outcome: 'completed', reason_class: 'none', launched: true, recovery: false });
    const terminal = terminalObservation(fx.home, receiptOf(fx.home, run.id).id);
    assert.equal(terminal.exit_class, 'clean', `the backend's exit during the pause is clean (${JSON.stringify(terminal)})`);
    assert.deepEqual(regrants(fx.home, run.id), [], 'a backend that has exited is not re-granted');
    await waitCgroupGone(domain.cgroup_path);
    await waitForWork(fx.home, item, 'complete');
  });

  test('(d) the deadline, and separately the budget, exhausted during the pause: timed_out; stopped / budget; no re-grant', async (t) => {
    const fx = await sandboxEngine(t, { config: CONFIG });
    const project = (await addGitProject(fx)).id;
    const deadlineSeconds = CONTRACT.project.deadline_verifier.min;
    await changePolicy(fx.engine, project, { deadline_verifier: deadlineSeconds, budget_run_billable_tokens: CONTRACT.project.budget_run_billable_tokens.min });

    // The deadline: the clock is moved to twenty seconds short of it, and
    // the real pause crosses it.
    const first = await addWork(fx.engine, project, 'verification');
    const a = await roleHolding(fx, project, first, { on_term: 'exit' });
    await advanceClockInSteps(fx.engine, deadlineSeconds - 20, { stepSeconds: LEASE_TTL - 5, pauseMs: 1200 });
    assert.equal(runRow(fx.home, a.run.id).state, 'executing', 'the fixture is live: within its deadline before the pause');
    await pause(fx);
    await tick(fx.engine, project);
    await waitForRunState(fx.home, a.run.id, 'ended', { timeoutMs: 60_000 });
    assertRunEnded(fx.home, a.run.id, { outcome: 'timed_out', reason_class: 'deadline', launched: true, recovery: false });
    assert.deepEqual(regrants(fx.home, a.run.id), [], 'a run past its deadline is not re-granted');
    await waitForWork(fx.home, first, 'parked');

    // The budget: a usage line that passes the run limit, written during
    // the pause and read after it, stops the run before any re-grant.
    const second = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(second, [{ steps: [step.hold('gate'), step.usage({ input_tokens: 20_000, output_tokens: 5 }), step.hold('after')] }]);
    await tick(fx.engine, project);
    await fx.scripted.waitForHolding({ work_item: second });
    const b = await waitForRun(fx.home, second, { state: 'executing' });
    const invocation = receiptOf(fx.home, b.id).id;
    process.kill(fx.engine.pid, 'SIGSTOP');
    await sleep(2000);
    fx.scripted.release(second, 'gate');
    await fx.scripted.waitForHolding({ work_item: second }, 'after');
    assert.deepEqual(usageRows(fx.home, invocation), [], 'the fixture is live: the stopped engine has not read the usage line');
    await sleep(PAUSE_MS - 2000);
    process.kill(fx.engine.pid, 'SIGCONT');
    await waitFor(() => (usageRows(fx.home, invocation).length > 0 ? true : undefined), { what: 'the usage observation to be recorded after the pause' });
    await tick(fx.engine, project);
    await waitForRunState(fx.home, b.id, 'ended', { timeoutMs: 60_000 });
    assertRunEnded(fx.home, b.id, { outcome: 'stopped', reason_class: 'budget', launched: true, recovery: false });
    assert.deepEqual(regrants(fx.home, b.id), [], 'a run that exhausted its budget is not re-granted');
    assert.equal(originalRowOf(fx.home, b.id).billable_in, 20_000, 'the usage that exhausted the budget is kept');
  });

  test('(e) the engine killed instead and restarted: the new incarnation never re-grants; recovery ends the run recovered', async (t) => {
    const fx = await sandboxEngine(t, { config: CONFIG });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const { run, domain, launch } = await roleHolding(fx, project, item, { on_term: 'exit' });
    await fx.engine.kill();
    await sleep(PAUSE_MS);
    assert.equal(roleAlive(domain, launch), true, 'the fixture is live: the role outlived the engine');
    const engine = await fx.start();
    const info = await engine.engineInfo();
    await tick(engine, project);
    await waitForRunState(fx.home, run.id, 'ended');
    assertRunEnded(fx.home, run.id, { outcome: 'recovered', reason_class: 'recovered', launched: true, recovery: info.incarnation });
    assert.deepEqual(regrants(fx.home, run.id), [], 'another incarnation re-grants nothing');
    assert.equal(cgroupExists(domain.cgroup_path), false);
    await waitForWork(fx.home, item, 'held');
  });

  test('(f) a Stop confirmed just before the pause: no re-grant; the Stop completes', async (t) => {
    const fx = await sandboxEngine(t, { config: CONFIG });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const { run } = await roleHolding(fx, project, item, { on_term: 'exit' });
    await stopRun(fx.engine, project, run.id);
    await pause(fx);
    await tick(fx.engine, project);
    await waitForRunState(fx.home, run.id, 'ended', { timeoutMs: 60_000 });
    assertRunEnded(fx.home, run.id, { outcome: 'stopped', reason_class: 'human_stop', launched: true, recovery: false });
    assert.deepEqual(regrants(fx.home, run.id), [], 'a run already ending is not re-granted');
    await waitForWork(fx.home, item, 'held');
  });

  test('(g) the backend exited error_exit during the pause: failed, no re-grant', async (t) => {
    const fx = await sandboxEngine(t, { config: CONFIG });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const { run, launch } = await roleHolding(fx, project, item, { on_term: 'exit', after: [step.exit(3)] });
    process.kill(fx.engine.pid, 'SIGSTOP');
    await sleep(2000);
    fx.scripted.release(item);
    await waitFor(() => fx.scripted.eventsOfInvocation(launch.invocation, 'exit').some((e) => e.code === 3), { what: 'the role to exit 3 during the pause' });
    await sleep(PAUSE_MS - 2000);
    process.kill(fx.engine.pid, 'SIGCONT');
    await tick(fx.engine, project);
    await waitForRunState(fx.home, run.id, 'ended', { timeoutMs: 60_000 });
    assertRunEnded(fx.home, run.id, { outcome: 'failed', reason_class: 'infra_error', launched: true, recovery: false });
    const terminal = terminalObservation(fx.home, receiptOf(fx.home, run.id).id);
    assert.equal(terminal.exit_class, 'error_exit', `the exit class (${JSON.stringify(terminal)})`);
    assert.deepEqual([terminal.exit_evidence.status, terminal.exit_evidence.signal_by_engine], [3, false]);
    assert.deepEqual(regrants(fx.home, run.id), [], 'no re-grant');
  });
});
