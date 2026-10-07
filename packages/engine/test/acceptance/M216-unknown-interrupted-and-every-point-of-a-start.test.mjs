// M216 (a), (b), (d), unknown, interrupted, and every point of a start (M3
// slice 18; sandbox lane). M3 plan §3.4 M216; D3 §2.5 (the check lease),
// §2.6 ("Unknown", "Interrupted"), §2.7, A.5, §7.1 L1; D2 §§3.2 to 3.5;
// T05, T07; SEAM.md §§125, 126, 128 to 130, 203 to 205. Case (c), a
// recovery's retries and a restart between them, is
// `M216-recovery-registrations-and-their-budget.test.mjs` (kernel lane).
//
// (a) The domain's termination unknown (its cgroup.events made unreadable,
//     SEAM.md §128's instrument), once from `running` after the check's own
//     exit, once from `materializing` (its launcher placed, the engine
//     killed and started again): the execution is `quarantined`, no row,
//     nothing collected, the check `missing` and named on the gate read.
//     Once termination is observed, the first is recorded, exactly one row;
//     the second, which never started, ends `interrupted` with no row, and
//     its recovery registration comes after the observed closure.
// (b) A crash (the engine killed through the test's own handle) after each
//     point of a start: allocation, placement, authorization, a successful
//     exec, the durable `started`, the exit report, collection. Closure
//     first; an execution whose exit report was recorded is recorded; any
//     other ends `interrupted` with no row and is never recorded as not
//     started; the domain names the check execution on every path.
//     "Cancel" at each point is not a separate cell: the only cancellation
//     of an execution that has a domain is the engine's at `timeout_s`,
//     which exists only from `started` (D3 §2.6), and M205 (h) and M217 (d)
//     read it (SEAM.md §205).
// (d) The engine paused (SIGSTOP to the engine the test started) past
//     `lease_ttl` with two checks held: the one whose deadline has not
//     passed is re-granted by D2 §3.5's challenge and passes; the one whose
//     `timeout_s` passed during the pause is ended at its deadline, never
//     re-granted: the pause extends no `timeout_s`.
//
// SAFETY: the check program holds at its release file and exits 0; it
// signals nothing. The tests change one cgroup file's mode inside a test
// engine's scope only (makeUnreadable refuses any other path) and restore
// it. Every signal goes to the engine process the test spawned, through its
// handle (kill) or its pid from that handle (SIGSTOP, SIGCONT).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { releaseBarrier } from './harness/engine.mjs';
import { CONTRACT } from './harness/fixtures.mjs';
import { reachBarrier } from './harness/decisions.mjs';
import { askingForTicks, stageGate } from './harness/gates.mjs';
import { armBarrier, changePolicy, eventsOfType } from './harness/journal.mjs';
import { signalPid } from './harness/proc.mjs';
import { makeUnreadable, restoreReadable } from './harness/sandbox/cgroup.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import {
  GOVERNED_FILE,
  buildStage,
  checkProject,
  defPath,
  domainOfExecution,
  entryByKey,
  executionRow,
  executionsOf,
  gateCheckEntries,
  heldExecution,
  holdArgs,
  installCheckProgram,
  qualifyRunnerByFixture,
  release,
  resultRow,
  resultsOfProject,
  sandboxGoverned,
  smoke,
  terminalExecution,
  waitRecorded,
} from './harness/checks/fixtures.mjs';
import { eventSeqAbout, eventSeqOfDomain, eventsAboutExecution, leaseOfExecution, retriesOf } from './harness/checks/execution.mjs';

const kinds = (x) => (x.init_reports ?? []).map((r) => r.kind);

// A sandbox engine, the program, a project of checks that hold at their
// keys and exit 0, a nominated candidate.
async function heldProject(t, { config = {}, keys = ['held'], timeouts = {}, concurrent } = {}) {
  const fx = await sandboxEngine(t, { config });
  const prog = installCheckProgram(fx.root);
  await qualifyRunnerByFixture(fx.engine);
  const files = { [GOVERNED_FILE]: sandboxGoverned(prog) };
  for (const key of keys) files[defPath(key)] = smoke(key, { command: ['probe', ...holdArgs(prog, key), 'exit', '0'], gates: ['stage'], timeout: timeouts[key] ?? 300 });
  const project = await checkProject(fx, { files });
  if (concurrent !== undefined) await changePolicy(fx.engine, project.id, { max_concurrent_checks: concurrent });
  return { fx, prog, project };
}

// A nominated candidate whose check is held before its materialization,
// then `point` armed: the Builder's own run, which uses the same launcher and
// collection, has passed every barrier by then, so `point` fires for the
// check's start (SEAM.md §205).
async function armedForTheCheck(fx, project, point) {
  await armBarrier(fx.engine, 'checks.before_materialize', 'pause');
  const built = await buildStage(fx, project);
  await reachBarrier(fx, project.id, 'checks.before_materialize');
  await armBarrier(fx.engine, point, 'pause');
  await releaseBarrier(fx.engine, 'checks.before_materialize');
  return built;
}

const executionWith = (fx, project, candidate, key, status, what) =>
  askingForTicks(fx, project, () => {
    const x = executionsOf(fx.home, candidate).filter((e) => e.key === key).at(-1);
    return x && x.status === status ? x : undefined;
  }, what);

// Closure first, then the domain's termination, then the execution's end
// (SEAM.md §126's order, read from the events' sequence).
function assertClosureFirst(fx, x, endType, what) {
  const domain = domainOfExecution(fx.home, x);
  assert.ok(domain, `${what}: the execution names its domain`);
  assert.deepEqual([domain.profile, domain.check_execution, domain.run], ['check', x.id, null], `${what}: the domain belongs to the check execution (L1)`);
  if (domain.launch_binding !== null && domain.launch_binding !== undefined) assert.equal(domain.launch_binding.check_execution, x.id, `${what}: its launch binding names the check execution (L1)`);
  assert.deepEqual([domain.status, domain.launch_state], ['terminated', 'closed'], `${what}: the domain is terminated with closure`);
  const closed = eventSeqOfDomain(fx.home, 'domain.launch_closed', domain.id);
  const terminated = eventSeqOfDomain(fx.home, 'domain.terminated', domain.id);
  const ended = eventSeqAbout(fx.home, endType, x.id);
  assert.ok(closed !== null && terminated !== null && ended !== null, `${what}: domain.launch_closed, domain.terminated and ${endType} were each emitted (${closed}, ${terminated}, ${ended})`);
  assert.ok(closed < terminated && terminated < ended, `${what}: closure (${closed}) before termination (${terminated}) before ${endType} (${ended})`);
  return domain;
}

describe('M216 unknown and interrupted executions, and every point of a start', () => {
  test('(a) from running: the termination unknown after the check exited: quarantined, no row, missing and named; observed, exactly one row', async (t) => {
    const { fx, prog, project } = await heldProject(t);
    const { stage, candidate } = await buildStage(fx, project);
    const held = await heldExecution(fx, project.id, candidate.id, { held: 'held' });
    makeUnreadable(held.domain.cgroup_path);
    fx.beforeCleanup.push(() => {
      try {
        restoreReadable(held.domain.cgroup_path);
      } catch {
        // gone with its domain
      }
    });
    release(prog, 'held');

    const q = await executionWith(fx, project.id, candidate.id, 'held', 'quarantined', 'the execution to be quarantined while its termination is unknown');
    assert.equal(q.id, held.execution.id);
    assert.equal(q.result, null, 'no row is recorded while termination is unknown');
    assert.deepEqual(resultsOfProject(fx.home, project.id), [], 'nothing is collected or recorded');
    assert.equal(eventsAboutExecution(fx.home, 'check.quarantined', q.id).length, 1, 'check.quarantined names the execution');
    const during = entryByKey(gateCheckEntries(await stageGate(fx, { project, stage }, candidate)), 'held');
    assert.deepEqual([during.state, during.pending?.execution, during.pending?.status], ['missing', q.id, 'quarantined'], 'the check is missing and the gate read names the quarantined execution');

    restoreReadable(held.domain.cgroup_path);
    const { held: done } = await waitRecorded(fx, project.id, candidate.id, ['held'], { what: 'the termination to be observed and the execution recorded' });
    assert.equal(done.id, q.id, 'the same execution is recorded');
    const rows = resultsOfProject(fx.home, project.id);
    assert.equal(rows.length, 1, 'exactly one row');
    assert.deepEqual([rows[0].execution, rows[0].execution_established, rows[0].exit_status], [q.id, 1, 0], 'from the reports the init had made: established, exit 0');
    assertClosureFirst(fx, executionRow(fx.home, q.id), 'check.result', 'the recorded execution');
  });

  test('(a) from materializing: the launcher placed, the engine killed, the termination unknown at the restart: quarantined, no row; observed, interrupted with no row, and the retry registered after the closure', async (t) => {
    const { fx, project } = await heldProject(t, { config: { check_infra_retries_max: 1 } });
    const { stage, candidate } = await armedForTheCheck(fx, project, 'launcher.placed');
    await reachBarrier(fx, project.id, 'launcher.placed');
    const [x] = executionsOf(fx.home, candidate.id);
    assert.deepEqual([x.status, typeof x.domain], ['materializing', 'string'], `the fixture is live: a domain is allocated and placed while the execution is materializing (SEAM.md §205) (${x.status})`);
    const domain = domainOfExecution(fx.home, x);
    await fx.engine.kill();
    makeUnreadable(domain.cgroup_path);
    fx.beforeCleanup.push(() => {
      try {
        restoreReadable(domain.cgroup_path);
      } catch {
        // gone with its domain
      }
    });
    await fx.start();

    const q = await executionWith(fx, project.id, candidate.id, 'held', 'quarantined', 'the execution to be quarantined from materializing');
    assert.equal(q.id, x.id);
    assert.equal(q.result, null, 'no row');
    assert.deepEqual(resultsOfProject(fx.home, project.id), [], 'nothing recorded');
    assert.equal(domainOfExecution(fx.home, q).status, 'quarantined', 'the domain stays nonterminal while its closure is unknown');
    const during = entryByKey(gateCheckEntries(await stageGate(fx, { project, stage }, candidate)), 'held');
    assert.deepEqual([during.state, during.pending?.execution, during.pending?.status], ['missing', q.id, 'quarantined'], 'missing, the gate read naming the quarantined execution');

    restoreReadable(domain.cgroup_path);
    const let_go = await fx.engine.post(`/v1/harness/barriers/${encodeURIComponent('launcher.placed')}/release`, {});
    assert.ok([200, 201, 202, 204, 404, 409].includes(let_go.status), `the waiting launcher's barrier is released, or its waiter is gone (SEAM.md §125) (${let_go.status} ${let_go.text})`);
    const ended = await terminalExecution(fx, project.id, candidate.id, 'held', 'the quarantined execution to end once its closure is observed');
    const original = executionRow(fx.home, x.id);
    assert.equal(original.status, 'interrupted', 'it never started, so it ends interrupted');
    assert.equal(original.result, null, 'with no row: a check that may have started is never recorded as not started');
    assert.deepEqual(resultsOfProject(fx.home, project.id).filter((r) => r.execution === x.id), [], 'no row of it');
    const closedDomain = assertClosureFirst(fx, original, 'check.interrupted', 'the interrupted execution');
    const [retry] = retriesOf(executionsOf(fx.home, candidate.id), original);
    assert.ok(retry, `recovery registers it again (D3 §2.7) (ended: ${ended.id})`);
    assert.ok(eventSeqAbout(fx.home, 'check.registered', retry.id) > eventSeqOfDomain(fx.home, 'domain.terminated', closedDomain.id), 'the retry waited for the closure: registered after the domain was terminated');
  });

  // (b) The points of a start. `exited`: the program has exited and the
  // init's exit report reached the engine before the point.
  const CELLS = [
    { point: 'launcher.before_placement', what: 'after allocation', exited: false },
    { point: 'launcher.placed', what: 'after placement', exited: false },
    { point: 'launcher.authorized', what: 'after authorization', exited: false },
    { point: 'checks.before_started', what: 'after a successful exec, before the started report is durable', exited: false },
    { point: 'checks.started', what: 'after the durable started report', exited: false },
    { point: 'checks.exit_recorded', what: 'after the exit report', exited: true },
    { point: 'collect.before_read', what: 'during collection', exited: true },
  ];
  for (const cell of CELLS) {
    test(`(b) a crash ${cell.what} (${cell.point}): ${cell.exited ? 'the exit report was recorded, so the execution is recorded, one row' : 'interrupted, no row, never recorded as not started'}; closure first; the domain names the check execution`, async (t) => {
      const { fx, prog, project } = await heldProject(t, { config: { check_infra_retries_max: 0 } });
      const { candidate } = await armedForTheCheck(fx, project, cell.point);
      if (cell.exited) {
        await heldExecution(fx, project.id, candidate.id, { held: 'held' });
        release(prog, 'held');
      }
      await reachBarrier(fx, project.id, cell.point);
      const [x] = executionsOf(fx.home, candidate.id);
      await fx.engine.kill();
      await fx.start();

      const ended = await terminalExecution(fx, project.id, candidate.id, 'held', `the execution to end after the restart (${cell.point})`);
      assert.equal(ended.id, x.id, 'it is the same execution; nothing was registered again (check_infra_retries_max 0)');
      const rows = resultsOfProject(fx.home, project.id);
      if (cell.exited) {
        assert.equal(ended.status, 'recorded', 'an execution whose exit report the engine had recorded is collected and recorded as usual');
        assert.equal(rows.length, 1, 'exactly one row');
        assert.deepEqual([rows[0].execution, rows[0].execution_established, rows[0].exit_status, rows[0].not_run_reason], [x.id, 1, 0, null], 'established, the exit status the init reported');
        assert.ok(kinds(ended).includes('started') && kinds(ended).includes('exit'), `its started and exit reports were recorded (${JSON.stringify(ended.init_reports)})`);
        assertClosureFirst(fx, ended, 'check.result', cell.point);
      } else {
        assert.equal(ended.status, 'interrupted', `ended interrupted (${ended.status})`);
        assert.deepEqual(rows, [], 'no row: never recorded as not started, failed or passed');
        assert.equal(ended.not_run_reason, null, 'and no not-run reason');
        assertClosureFirst(fx, ended, 'check.interrupted', cell.point);
      }
    });
  }

  test('(d) a pause past lease_ttl: the check whose deadline has not passed is re-granted by the challenge and passes; the one whose timeout_s passed in the pause ends at its deadline, not re-granted', async (t) => {
    const LEASE_TTL = CONTRACT.engine.lease_ttl.min;
    const PAUSE_MS = (LEASE_TTL + 3) * 1000;
    const { fx, prog, project } = await heldProject(t, {
      config: { lease_ttl: LEASE_TTL, terminate_grace: 3, kill_grace: 2 },
      keys: ['long', 'short'],
      timeouts: { long: 300, short: LEASE_TTL - 10 },
      concurrent: 2,
    });
    const { candidate } = await buildStage(fx, project);
    const a = await heldExecution(fx, project.id, candidate.id, { long: 'long', short: 'short' });
    const b = await heldExecution(fx, project.id, candidate.id, a.key === 'long' ? { short: 'short' } : { long: 'long' });
    const long = a.key === 'long' ? a : b;
    const short = a.key === 'short' ? a : b;
    const [leaseBefore] = leaseOfExecution(fx.home, long.execution.id);
    assert.ok(leaseBefore, 'the fixture is live: the running check holds a lease of kind check (L1)');
    assert.equal(executionRow(fx.home, short.execution.id).status, 'running', 'the fixture is live: the short check is still running when the pause begins');

    t.after(() => signalPid(fx.engine.pid, 'SIGCONT'));
    assert.equal(signalPid(fx.engine.pid, 'SIGSTOP'), true, 'the engine is stopped');
    await sleep(PAUSE_MS);
    assert.equal(signalPid(fx.engine.pid, 'SIGCONT'), true, 'the engine is continued');

    const regrant = await askingForTicks(fx, project.id, () => eventsAboutExecution(fx.home, 'check.lease_regranted', long.execution.id)[0], "the long check's lease to be re-granted by the challenge");
    assert.equal(regrant.payload?.generation, leaseBefore.generation, 're-granted on the same generation (D2 §3.5)');
    assert.match(regrant.payload?.challenge?.nonce ?? '', /^[0-9a-f]{16,}$/, 'by a fresh challenge carrying a nonce');
    release(prog, 'long');
    const { long: recorded } = await waitRecorded(fx, project.id, candidate.id, ['long']);
    const r = resultRow(fx.home, recorded.result);
    assert.deepEqual([r.execution_established, r.exit_status, r.deadline_hit, r.signaled], [1, 0, 0, 0], 'the re-granted check runs to its end and passes');

    const shortEnded = await terminalExecution(fx, project.id, candidate.id, 'short', 'the short check to end at its deadline');
    const s = resultRow(fx.home, shortEnded.result);
    assert.deepEqual([s.execution_established, s.exit_status, s.deadline_hit, s.signaled], [1, null, 1, 1], 'the check whose timeout_s passed during the pause ends at its deadline: the pause extended nothing');
    assert.deepEqual(eventsAboutExecution(fx.home, 'check.lease_regranted', short.execution.id), [], 'and its lease was not re-granted');
    assert.ok(eventsOfType(fx.home, 'check.lease_regranted').every((e) => e.subject?.check_execution !== undefined), 'every re-grant names its check execution');
  });
});
