// M113, TERM then kill; closure on every path; a terminated domain is never
// repopulated (M2 slice 11, sandbox lane). M2 plan §3.3 M113; D2 §3.2,
// §3.6, K1, K4 (D2-B04, D2-B12, D2-B13); D1 §4.5; BS §6 corrections 1, 2;
// AR B01; SEAM.md §§122, 125, 126. Rows M13 to M15 repeated once through
// the real boundary: Stop, Abandon and a deadline end a run only after the
// cgroup reads populated 0 with the launch closed.
//
// Closure comes first on every path; TERM reaches the role through the
// init and a role that ignores it is killed with its descendant by
// cgroup.kill after terminate_grace; `terminated` is recorded only after the
// engine has read populated 0, and the directory is removed after the
// record and never recreated; an unreadable cgroup.events is unknown, never
// termination; a Stop before placement, a Stop after placement and a
// deadline before authorization each close the launch with no role ever
// launched; a paused launcher released after its run ended starts nothing
// and changes no ref; an Abandon discards the workspace only after
// termination with closure.
//
// Every case here is expected to fail on the engine these tests were
// written against, which has no launcher and no cgroup boundary
// (COVERAGE.md, "M2 slice 11").

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { CONTRACT } from './harness/fixtures.mjs';
import { releaseBarrier } from './harness/engine.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { armBarrier, registryOf } from './harness/journal.mjs';
import { abandonRun, addProject, addWork, advanceClockInSteps, assertRunEnded, assertRunQuarantined, getRow, requestTick, runsOf, stopRun, tick, waitForQuarantine, waitForRun, waitForRunState, waitForWork, CLOCK_SLACK_MS } from './harness/runs.mjs';
import { cgroupExists, makeUnreadable, populated, procsOf, readEvents, restoreReadable, waitCgroupGone } from './harness/sandbox/cgroup.mjs';
import { assertEngineInScope, domainOf, domainRow, eventsOf, receiptOf, roleAlive, roleHolding, sandboxEngine, terminalObservation, waitForEvent } from './harness/sandbox/lane.mjs';
import { hostProcess, memberByInnerPid } from './harness/sandbox/procs.mjs';
import { script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const VERIFIER_DEADLINE = CONTRACT.project.deadline_verifier.default;
const LEASE_TTL = CONTRACT.engine.lease_ttl.max;
const CLOCK = { stepSeconds: Math.floor(LEASE_TTL / 2), pauseMs: 1200 };

// A role that ignores TERM and leaves a descendant that ignores TERM.
const ignoring = (name = 'gate') => ({ name, on_term: 'ignore', before: [step.descendant({ holds_stdout: false, on_term: 'ignore' })] });

const seqOf = (events, i = 0) => events[i]?.seq ?? null;

// What every ending must show of the domain once the run has ended.
function assertClosedThenTerminated(fx, run, domain, what) {
  const row = domainRow(fx.home, domain.id);
  assert.deepEqual([row.status, row.launch_state, row.observation], ['terminated', 'closed', 'terminated'], `${what}: the domain is terminated with its launch closed`);
  assert.ok(row.launch_closed_at && row.observed_at, `${what}: launch_closed_at and observed_at are set`);
  assert.ok(Date.parse(row.launch_closed_at) <= Date.parse(row.observed_at) + CLOCK_SLACK_MS, `${what}: closure precedes the observation`);
  const closed = seqOf(eventsOf(fx.home, 'domain', domain.id, 'domain.launch_closed'));
  const terminated = seqOf(eventsOf(fx.home, 'domain', domain.id, 'domain.terminated'));
  const ended = seqOf(eventsOf(fx.home, 'run', run.id, 'run.ended'));
  assert.ok(closed !== null && terminated !== null && ended !== null, `${what}: domain.launch_closed (${closed}), domain.terminated (${terminated}) and run.ended (${ended}) were written`);
  assert.ok(closed < terminated && terminated < ended, `${what}: domain.launch_closed (${closed}) before domain.terminated (${terminated}) before run.ended (${ended})`);
  assert.equal(eventsOf(fx.home, 'domain', domain.id, 'domain.launch_closed').length, 1, `${what}: closed once`);
  assert.equal(cgroupExists(domain.cgroup_path), false, `${what}: the directory is removed`);
  return row;
}

describe('M113 TERM then kill, closure on every path', () => {
  test('(a) Stop while executing, the role and its descendant ignoring TERM: domain.launch_closed first, terminated recorded only after populated 0 is read (the test reads it at boundary.before_terminated), signal 9 by the engine, at least terminate_grace after closure, the directory removed after the record, run.ended after domain.terminated', async (t) => {
    const grace = { terminate_grace: 5, kill_grace: 2 };
    const fx = await sandboxEngine(t, { config: grace });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const { run, domain, launch } = await roleHolding(fx, project, item, ignoring());
    const descendant = await fx.scripted.waitForDescendant({ invocation: launch.invocation });
    const descendantHost = memberByInnerPid(domain.cgroup_path, descendant.pid);
    assert.ok(descendantHost, 'the fixture is live: the descendant is a member of the domain');
    await armBarrier(fx.engine, 'boundary.before_terminated', 'pause');

    const stoppedAt = performance.now();
    await stopRun(fx.engine, project, run.id);
    await waitForEvent(fx.home, 'domain', domain.id, 'domain.launch_closed');
    assert.equal(roleAlive(domain, launch), true, 'closure comes first: the role, which ignores TERM, is still alive right after domain.launch_closed');
    assert.equal(domainRow(fx.home, domain.id).launch_state, 'closed');

    await fx.engine.waitUntil('barrier:boundary.before_terminated', { timeoutMs: 40_000 });
    assert.ok(performance.now() - stoppedAt >= (grace.terminate_grace - 1) * 1000, 'the kill came no earlier than terminate_grace');
    assert.deepEqual(readEvents(domain.cgroup_path), { populated: 0, frozen: 0 }, 'the test reads populated 0 at the barrier');
    assert.deepEqual(procsOf(domain.cgroup_path), [], 'nothing is left in the domain: the role and its descendant are gone');
    assert.equal(hostProcess(descendantHost.pid), null, 'the descendant that ignored TERM was killed with the domain');
    assert.deepEqual(eventsOf(fx.home, 'domain', domain.id, 'domain.terminated'), [], 'terminated is not yet recorded');
    assert.equal(domainRow(fx.home, domain.id).status, 'launched', 'the domain row is unchanged at the barrier');
    assert.equal(cgroupExists(domain.cgroup_path), true, 'the directory is still there before the record');

    await releaseBarrier(fx.engine, 'boundary.before_terminated');
    await waitForRunState(fx.home, run.id, 'ended');
    const row = assertClosedThenTerminated(fx, run, domain, '(a)');
    assert.ok(Date.parse(row.observed_at) - Date.parse(row.launch_closed_at) >= grace.terminate_grace * 1000 - CLOCK_SLACK_MS, `observed_at is at least terminate_grace (${grace.terminate_grace} s) after closure (${row.launch_closed_at} → ${row.observed_at})`);
    assertRunEnded(fx.home, run.id, { outcome: 'stopped', reason_class: 'human_stop', workspace: 'retained', launched: true, recovery: false });
    const terminal = terminalObservation(fx.home, receiptOf(fx.home, run.id).id);
    assert.equal(terminal.exit_class, 'engine_signaled', `exit class (${JSON.stringify(terminal)})`);
    assert.deepEqual([terminal.exit_evidence.signal, terminal.exit_evidence.signal_by_engine, terminal.exit_evidence.status], [9, true, null], `exit_evidence shows signal 9 by the engine and no reported status (${JSON.stringify(terminal.exit_evidence)})`);
    await waitForWork(fx.home, item, 'held');
  });

  test('(b) a role that exits on TERM: terminated before terminate_grace elapses, signal 15 by the engine', async (t) => {
    const grace = { terminate_grace: 8, kill_grace: 2 };
    const fx = await sandboxEngine(t, { config: grace });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const { run, domain, launch } = await roleHolding(fx, project, item, { on_term: 'exit' });
    const stoppedAt = performance.now();
    await stopRun(fx.engine, project, run.id);
    await waitForEvent(fx.home, 'domain', domain.id, 'domain.terminated', { timeoutMs: grace.terminate_grace * 1000 });
    const took = performance.now() - stoppedAt;
    assert.ok(took < (grace.terminate_grace - 1) * 1000, `a role that exits on TERM empties the domain before terminate_grace (${grace.terminate_grace} s): terminated after ${Math.round(took)} ms`);
    assert.ok(fx.scripted.eventsOfInvocation(launch.invocation, 'signal').some((e) => e.signal === 'SIGTERM' && e.pid === launch.pid), 'the role logged the TERM the init relayed');
    await waitForRunState(fx.home, run.id, 'ended');
    assertClosedThenTerminated(fx, run, domain, '(b)');
    assertRunEnded(fx.home, run.id, { outcome: 'stopped', reason_class: 'human_stop', launched: true, recovery: false });
    const terminal = terminalObservation(fx.home, receiptOf(fx.home, run.id).id);
    assert.equal(terminal.exit_class, 'engine_signaled');
    assert.deepEqual([terminal.exit_evidence.signal, terminal.exit_evidence.signal_by_engine, terminal.exit_evidence.status], [15, true, 143], `signal 15 by the engine, the role's exit status as the init reported it (${JSON.stringify(terminal.exit_evidence)})`);
  });

  test('(c) cgroup.events made unreadable before the kill phase: unknown and quarantine, never terminated on the kill\'s return; readable again, the next tick clears it', async (t) => {
    const grace = { terminate_grace: 3, kill_grace: 2 };
    const fx = await sandboxEngine(t, { config: grace });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const { run, domain, launch } = await roleHolding(fx, project, item, ignoring());
    await stopRun(fx.engine, project, run.id);
    await waitForEvent(fx.home, 'domain', domain.id, 'domain.launch_closed');
    makeUnreadable(domain.cgroup_path, 'cgroup.events');
    t.after(() => {
      try {
        restoreReadable(domain.cgroup_path, 'cgroup.events');
      } catch {
        // gone
      }
    });

    await waitForQuarantine(fx.home, run.id, { timeoutMs: 30_000 });
    const facts = assertRunQuarantined(fx.home, run.id, { outcome: 'stopped' });
    assert.equal(facts.domains[0].observation, 'unknown', 'the observation is unknown');
    assert.equal(facts.domains[0].launch_state, 'closed');
    await sleep((grace.terminate_grace + grace.kill_grace + 2) * 1000);
    assert.equal(roleAlive(domain, launch), false, 'the kill still went out: the role is gone');
    assert.deepEqual(eventsOf(fx.home, 'domain', domain.id, 'domain.terminated'), [], "the kill's return is never termination: nothing recorded it");
    assert.equal(cgroupExists(domain.cgroup_path), true, 'the directory is not removed while termination is unknown');
    for (let i = 0; i < 2; i++) await tick(fx.engine, project);
    assertRunQuarantined(fx.home, run.id, { outcome: 'stopped' });

    restoreReadable(domain.cgroup_path, 'cgroup.events');
    assert.equal(populated(domain.cgroup_path), 0, 'the fixture is live: the domain is in fact empty');
    await tick(fx.engine, project);
    await waitForRunState(fx.home, run.id, 'ended');
    assertClosedThenTerminated(fx, run, domain, '(c)');
    assertRunEnded(fx.home, run.id, { outcome: 'stopped', reason_class: 'human_stop', launched: true, recovery: false });
  });

  test('(d) Stop before placement, Stop after placement before authorization, a deadline before authorization: each writes domain.launch_closed, no role is ever launched, the run ends stopped, stopped, timed_out', async (t) => {
    const fx = await sandboxEngine(t, { config: { lease_ttl: LEASE_TTL, terminate_grace: 3, kill_grace: 2 } });
    const scope = await assertEngineInScope(fx);
    const project = (await addProject(fx)).id;
    fx.scripted.defaultScript(script.holdThenComplete('gate'));

    const paths = [
      { name: 'Stop before placement', barrier: 'launcher.before_placement', end: async (run) => stopRun(fx.engine, project, run.id), outcome: ['stopped', 'human_stop'], work: 'held' },
      { name: 'Stop after placement before authorization', barrier: 'launcher.before_authorization', end: async (run) => stopRun(fx.engine, project, run.id), outcome: ['stopped', 'human_stop'], work: 'held' },
      { name: 'a deadline before authorization', barrier: 'launcher.before_authorization', end: async () => advanceClockInSteps(fx.engine, VERIFIER_DEADLINE + 5, CLOCK), outcome: ['timed_out', 'deadline'], work: 'parked' },
    ];
    for (const path of paths) {
      const item = await addWork(fx.engine, project, 'verification');
      await armBarrier(fx.engine, path.barrier, 'pause');
      await requestTick(fx.engine, project);
      await fx.engine.waitUntil(`barrier:${path.barrier}`);
      const run = await waitForRun(fx.home, item);
      const domain = domainOf(fx.home, run.id);
      const placed = path.barrier === 'launcher.before_authorization';
      assert.equal(populated(domain.cgroup_path), placed ? 1 : 0, `${path.name}: the domain is ${placed ? '' : 'not '}populated at the barrier`);
      const launcher = placed ? procsOf(domain.cgroup_path)[0] : procsOf(scope.supervisor).find((p) => p !== fx.engine.pid && /node$/.test(hostProcess(p)?.cmdline[0] ?? ''));
      assert.ok(launcher, `${path.name}: the launcher is found (${placed ? 'in the domain' : 'in the supervisor leaf'})`);

      await path.end(run);
      await waitForRunState(fx.home, run.id, 'ended', { timeoutMs: 60_000 });
      assertClosedThenTerminated(fx, run, domain, path.name);
      assertRunEnded(fx.home, run.id, { outcome: path.outcome[0], reason_class: path.outcome[1], launched: false, recovery: false });
      assert.equal(hostProcess(launcher), null, `${path.name}: the launcher is gone (${placed ? 'it died with the domain or exited on refusal' : 'killed through its handle and its exit awaited'})`);
      assert.deepEqual(eventsOf(fx.home, 'domain', domain.id, 'domain.launch_authorized'), [], `${path.name}: never authorized`);
      if (!placed) assert.deepEqual(eventsOf(fx.home, 'domain', domain.id, 'domain.placed'), [], `${path.name}: never placed`);
      assert.deepEqual(fx.scripted.launches({ run: run.id }), [], `${path.name}: no role was ever launched`);
      const statuses = withStore(fx.home, (db) => db.prepare('SELECT "status" FROM "invocation_status_observations" WHERE "invocation" = ? ORDER BY "seq"').all(receiptOf(fx.home, run.id).id)).map((s) => s.status);
      assert.deepEqual(statuses, ['dispatch_started', 'refused'], `${path.name}: the receipt is refused, never launched`);
      await waitForWork(fx.home, item, path.work);
      // The release of a barrier whose waiter is gone is a no-op.
      const res = await fx.engine.post(`/v1/harness/barriers/${path.barrier}/release`, {});
      assert.ok([200, 404, 409].includes(res.status), `${path.name}: releasing afterwards is a no-op (${res.status})`);
    }
  });

  test('(e) a launcher paused before authorization, released after its run ended on a deadline: no role process ever appears, the registry\'s refs and the workspace\'s current_base are unchanged', async (t) => {
    const fx = await sandboxEngine(t, { config: { lease_ttl: LEASE_TTL, terminate_grace: 3, kill_grace: 2 }, barriers: ['launcher.before_authorization=pause'] });
    const project = (await addGitProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(item, [script.complete([step.write('src/late.txt', 'late')])]);
    await requestTick(fx.engine, project);
    await fx.engine.waitUntil('barrier:launcher.before_authorization');
    const run = await waitForRun(fx.home, item);
    const domain = domainOf(fx.home, run.id);
    const refsBefore = registryOf(fx.home, project);
    const baseBefore = getRow(fx.home, 'workspaces', run.workspace).current_base;

    await advanceClockInSteps(fx.engine, VERIFIER_DEADLINE + 5, CLOCK);
    await waitForRunState(fx.home, run.id, 'ended', { timeoutMs: 60_000 });
    assertRunEnded(fx.home, run.id, { outcome: 'timed_out', reason_class: 'deadline', launched: false, recovery: false });
    assertClosedThenTerminated(fx, run, domain, '(e)');
    const res = await fx.engine.post('/v1/harness/barriers/launcher.before_authorization/release', {});
    assert.ok([200, 404, 409].includes(res.status), `releasing the launcher after the run ended is a no-op (${res.status})`);
    await sleep(2000);
    for (let i = 0; i < 2; i++) await tick(fx.engine, project);
    assert.deepEqual(fx.scripted.launches({ run: run.id }), [], 'no role process ever appeared');
    assert.deepEqual(eventsOf(fx.home, 'domain', domain.id, 'domain.launch_authorized'), [], 'no grant');
    assert.deepEqual(registryOf(fx.home, project), refsBefore, "the registry's refs are unchanged");
    assert.equal(getRow(fx.home, 'workspaces', run.workspace).current_base, baseBefore, "the workspace's current_base is unchanged");
    assert.equal(cgroupExists(domain.cgroup_path), false, 'the domain stays gone');
    await waitForWork(fx.home, item, 'parked');
  });

  test('(f) after terminated: the directory stays absent across ticks and a restart, no later domain.placed names the domain, nothing recreates it', async (t) => {
    const fx = await sandboxEngine(t);
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const { run, domain } = await roleHolding(fx, project, item, { after: [step.result()] });
    fx.scripted.release(item);
    await waitForRunState(fx.home, run.id, 'ended');
    await waitCgroupGone(domain.cgroup_path);
    const placedBefore = eventsOf(fx.home, 'domain', domain.id, 'domain.placed').length;
    assert.equal(placedBefore, 1);
    for (let i = 0; i < 3; i++) await tick(fx.engine, project);
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, project);
    assert.equal(cgroupExists(domain.cgroup_path), false, 'the directory stays absent');
    assert.equal(eventsOf(fx.home, 'domain', domain.id, 'domain.placed').length, placedBefore, 'no later domain.placed for a terminated domain');
    assert.equal(domainRow(fx.home, domain.id).status, 'terminated');
    assert.equal(runsOf(fx.home, item).length, 1);
  });

  test('(g) Abandon while executing: termination with closure precedes the workspace discard; M14\'s facts otherwise', async (t) => {
    const fx = await sandboxEngine(t);
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const { run, domain } = await roleHolding(fx, project, item, ignoring());
    await abandonRun(fx.engine, project, run.id);
    await waitForRunState(fx.home, run.id, 'ended', { timeoutMs: 40_000 });
    assertClosedThenTerminated(fx, run, domain, '(g)');
    assertRunEnded(fx.home, run.id, { outcome: 'abandoned', reason_class: 'human_abandon', workspace: 'discarded', launched: true, recovery: false });
    const terminated = seqOf(eventsOf(fx.home, 'domain', domain.id, 'domain.terminated'));
    const removal = withStore(fx.home, (db) =>
      db.prepare(`SELECT "seq", "subject" FROM "events" WHERE "type" = 'operation.intended' AND json_extract("subject", '$.run') = ? AND json_extract("subject", '$.action') = 'worktree_remove' ORDER BY "seq"`).all(run.id),
    );
    assert.equal(removal.length, 1, 'one worktree_remove operation was intended for the run');
    assert.ok(terminated < removal[0].seq, `domain.terminated (${terminated}) precedes the discard's intent (${removal[0].seq})`);
    const work = await waitForWork(fx.home, item, 'eligible');
    assert.equal(work.dispatch_hold, 1, 'the work waits under a dispatch hold');
  });
});
