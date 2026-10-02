// M16 (slice 2). Plan §3.2 M16; D1 §§4.5, 16.1; RN R3; build spec §6
// corrections 1 and 2; Review B08; D1-08; SEAM.md §§14, 16. When the
// execution boundary does not report a domain terminated, nothing may treat
// it as terminated: the run stays finalizing and quarantined, the workspace
// is kept, the lease becomes a quarantine reservation and not execution
// authority, a blocker says so, and nothing else of the project is
// dispatched. All of it survives a restart. An operator's acknowledgement is
// recorded and establishes nothing. Three ways into it: the role's process
// exited but the boundary still reports the domain running (a descendant
// lives on); the boundary cannot read membership; cancellation fails.
// The scripted boundary proves the engine's reaction. It qualifies no real
// containment (Plan §2).
//
// After the slice-2 review (E25), two more cases. A role that exits and
// leaves a real descendant behind is still a role that has exited: the
// run-end protocol begins then, whatever the descendant holds open, and the
// descendant is terminated as a member of the domain. And an `unknown` report
// is acted on when it is made, not after the grace periods.
//
// After the second slice-2 review (E27), four more. An `unknown` report ends
// the wait for a report, not the signalling: the processes the engine found
// still get SIGKILL once terminate_grace has passed (D1 §4.5 step 2), and
// the quarantine clears when the boundary reads again. The end of the role's
// output is not the role's exit: a role that closes its stdout and goes on is
// not signalled, and its run ends by what it earned when it does exit. And a
// last line without a line ending is a line, whether or not a descendant
// holds the stream open (E27 item 1).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { waitFor } from './harness/engine.mjs';
import { assertWorkHistory } from './harness/invariants.mjs';
import {
  addProject,
  addWork,
  answerDecision,
  assertRunEnded,
  assertRunQuarantined,
  getRow,
  leasesOf,
  run as runRow,
  runsOf,
  scriptedEngine,
  stopRun,
  tick,
  waitForQuarantine,
  waitForRun,
  waitForRunState,
  waitForWork,
  workItem,
} from './harness/runs.mjs';
import { BOUNDARY, script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const GRACE = { terminate_grace: 1, kill_grace: 1 };

// What must stay true for as long as the quarantine lasts, however many
// ticks run: not ended, nothing discarded, nothing reused.
async function assertQuarantineHolds(fx, project, { runId, item, waiting, outcome, blocker = 'open' }) {
  for (let i = 0; i < 2; i++) await tick(fx.engine, project);
  const facts = assertRunQuarantined(fx.home, runId, { outcome, blocker });
  assert.equal(runsOf(fx.home, item).length, 1, 'the quarantined work is not dispatched again');
  assert.equal(runsOf(fx.home, waiting).length, 0, 'nothing else of the project is dispatched onto what the run still holds');
  assert.equal(workItem(fx.home, waiting).status, 'eligible');
  assert.ok(!['complete', 'held'].includes(workItem(fx.home, item).status), `the work is neither complete nor released (it is ${workItem(fx.home, item).status})`);
  return facts;
}

// The same quarantine, read again after the engine was killed and restarted.
async function assertSurvivesRestart(fx, project, ids, before) {
  await fx.engine.kill();
  await fx.start();
  const after = await assertQuarantineHolds(fx, project, ids);
  assert.equal(after.run.outcome, before.run.outcome, 'the recorded outcome is unchanged');
  const reservation = (facts) => facts.leases.find((l) => l.resource_kind === 'quarantine' && l.released_at === null).id;
  assert.equal(reservation(after), reservation(before), 'the same quarantine reservation is still held');
  const blockerId = (facts) => facts.decisions.find((d) => d.kind === 'blocker').id;
  assert.equal(blockerId(after), blockerId(before), 'the same blocker is still there; the question is not asked twice');
  assert.equal(after.decisions.filter((d) => d.kind === 'blocker').length, 1, 'one blocker for one quarantine');
  for (const g of after.grants) assert.ok(g.revoked_at, 'no grant is live after the restart');
  return after;
}

describe('M16 unknown termination is never success', () => {
  test('the role process exited, but the boundary still reports the domain running', async (t) => {
    const fx = await scriptedEngine(t, { config: GRACE });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const waiting = await addWork(fx.engine, project, 'review');
    fx.scripted.script(item, [script.complete([step.write('report.txt', 'verified')])]);
    fx.scripted.script(waiting, [script.hold('gate')]);
    // The parent exits normally; the boundary says something of the domain still runs.
    fx.scripted.boundary({ default: BOUNDARY.running });

    await tick(fx.engine, project);
    const first = await waitForRun(fx.home, item);
    await waitForQuarantine(fx.home, first.id);
    const [launch] = fx.scripted.launches({ run: first.id });
    assert.equal(fx.scripted.isLive(launch), false, 'the process the engine spawned has exited');
    const ids = { runId: first.id, item, waiting };
    const before = await assertQuarantineHolds(fx, project, ids);
    assert.ok(existsSync(`${before.workspaces[0].path}/report.txt`), 'the workspace is kept as the role left it');
    const question = before.decisions.find((d) => d.kind === 'blocker');
    assert.ok(question.question.length > 0, 'the blocker says what is wrong');
    assert.ok(JSON.parse(question.options).some((o) => o.key === 'acknowledge'));

    const after = await assertSurvivesRestart(fx, project, ids, before);

    // The operator acknowledges. That is recorded, and it establishes nothing.
    const blocker = after.decisions.find((d) => d.kind === 'blocker');
    await answerDecision(fx.engine, project, blocker.id, 'acknowledge');
    assert.equal(getRow(fx.home, 'decisions', blocker.id).status, 'consumed');
    const acknowledged = await assertQuarantineHolds(fx, project, { ...ids, blocker: 'any' });
    assert.equal(acknowledged.domains[0].status, 'quarantined', 'an acknowledgement does not establish that the domain is empty');
    assert.equal(runRow(fx.home, first.id).state, 'finalizing');
    assert.ok(existsSync(`${before.workspaces[0].path}/report.txt`));
  });

  test('the boundary cannot read membership', async (t) => {
    const fx = await scriptedEngine(t, { config: GRACE });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const waiting = await addWork(fx.engine, project, 'review');
    fx.scripted.script(item, [script.hold('gate')]);
    fx.scripted.script(waiting, [script.hold('gate')]);
    await tick(fx.engine, project);
    await fx.scripted.waitForHolding({ work_item: item });
    const first = await waitForRun(fx.home, item, { state: 'executing' });

    fx.scripted.boundary({ default: BOUNDARY.unknown });
    await stopRun(fx.engine, project, first.id);
    await waitForQuarantine(fx.home, first.id);
    const ids = { runId: first.id, item, waiting, outcome: 'stopped' };
    const before = await assertQuarantineHolds(fx, project, ids);
    assert.equal(leasesOf(fx.home, first.id).filter((l) => l.resource_kind === 'run' && l.released_at === null).length, 0, 'unknown is not execution authority');
    await assertSurvivesRestart(fx, project, ids, before);
  });

  test('cancellation fails: the boundary keeps reporting the domain running after Stop', async (t) => {
    const fx = await scriptedEngine(t, { config: GRACE });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const waiting = await addWork(fx.engine, project, 'review');
    fx.scripted.script(item, [script.hold('gate', { on_term: 'ignore' })]);
    fx.scripted.script(waiting, [script.hold('gate')]);
    await tick(fx.engine, project);
    await fx.scripted.waitForHolding({ work_item: item });
    const first = await waitForRun(fx.home, item, { state: 'executing' });
    const domain = withStore(fx.home, (db) => db.prepare('SELECT * FROM "execution_domains" WHERE "run" = ?').get(first.id));

    fx.scripted.boundary({ domains: { [domain.id]: BOUNDARY.running } });
    await stopRun(fx.engine, project, first.id);
    await waitForQuarantine(fx.home, first.id);
    const ids = { runId: first.id, item, waiting, outcome: 'stopped' };
    const before = await assertQuarantineHolds(fx, project, ids);
    assert.ok(existsSync(before.workspaces[0].path), 'the workspace is not discarded or reused');
    const after = await assertSurvivesRestart(fx, project, ids, before);

    const blocker = after.decisions.find((d) => d.kind === 'blocker');
    await answerDecision(fx.engine, project, blocker.id, 'acknowledge');
    const acknowledged = await assertQuarantineHolds(fx, project, { ...ids, blocker: 'any' });
    assert.equal(acknowledged.run.outcome, 'stopped');
    assert.equal(acknowledged.domains[0].status, 'quarantined', 'an acknowledgement does not establish that the domain is empty');
  });
});

// The run has ended or is quarantined: the run-end protocol has done what it
// can. Fails, saying where the run is, if neither happens in `timeoutMs`.
async function runSettles(fx, runId, { timeoutMs, otherwise }) {
  const settled = (row) => row.state === 'ended' || row.quarantined === 1;
  await waitFor(() => settled(runRow(fx.home, runId)), { timeoutMs, what: 'the run to end or be quarantined' }).catch(() => {});
  const row = runRow(fx.home, runId);
  assert.ok(settled(row), `${otherwise}: ${timeoutMs / 1000} s later run ${runId} is ${row.state} with outcome ${row.outcome} and quarantined ${row.quarantined}`);
  return row;
}

describe('M16 a descendant that outlives the role (review)', () => {
  test('a role that completes and exits, leaving a descendant with its output open, ends completed once the descendant is terminated', async (t) => {
    const fx = await scriptedEngine(t, { config: GRACE });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const waiting = await addWork(fx.engine, project, 'review');
    // The role starts a background process that inherits its stdout and its
    // environment, sends a valid result and exits 0.
    fx.scripted.script(item, [script.complete([step.usage({ input_tokens: 5 }), step.descendant({ holds_stdout: true, on_term: 'exit' })])]);
    fx.scripted.script(waiting, [script.complete()]);

    await tick(fx.engine, project);
    const first = await waitForRun(fx.home, item);
    const descendant = await fx.scripted.waitForDescendant();
    const [launch] = fx.scripted.launches({ run: first.id });
    assert.equal(descendant.parent, launch.pid, 'the descendant was started by the role');
    assert.equal(descendant.domain, launch.domain, 'and carries the marker of its domain');
    assert.deepEqual([descendant.ready, descendant.holds_stdout], [true, true], 'it was up, holding the role\'s stdout, before the role went on');
    await waitFor(() => !fx.scripted.isLive(launch), { what: 'the role process to exit' });
    assert.ok(fx.scripted.eventsOf(launch.pid, 'exit').some((e) => e.code === 0), 'the role exited 0 after sending its result');

    // The role has exited: the run-end protocol begins now. It does not wait
    // for the end of an output stream that a descendant can hold open for ever.
    await runSettles(fx, first.id, {
      timeoutMs: 15_000,
      otherwise: 'the run-end protocol must begin when the role exits, although a descendant still holds its output open',
    });
    await waitForRunState(fx.home, first.id, 'ended');
    assert.equal(fx.scripted.isLive(descendant), false, 'the descendant was terminated as a member of the domain before the run ended');
    const facts = assertRunEnded(fx.home, first.id, { outcome: 'completed', reason_class: 'none', workspace: 'retained', launched: true, recovery: false });
    assert.equal(facts.receipts[0].usage.length, 1, 'the usage the role reported is kept');
    assert.equal((await waitForWork(fx.home, item, 'complete')).status, 'complete', 'the work is complete, not parked behind a deadline');
    withStore(fx.home, (db) => assert.deepEqual(assertWorkHistory(db, item), ['eligible', 'claimed', 'executing', 'complete']));

    // The project is free again.
    await tick(fx.engine, project);
    await waitForWork(fx.home, waiting, 'complete');
  });
});

describe('M16 an unknown report is acted on when it is made (review)', () => {
  test('with the boundary reporting unknown, a stopped run is quarantined at once, not after the grace periods', async (t) => {
    const config = { terminate_grace: 30, kill_grace: 5 };
    const fx = await scriptedEngine(t, { config });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(item, [script.hold('gate')]);
    await tick(fx.engine, project);
    await fx.scripted.waitForHolding({ work_item: item });
    const first = await waitForRun(fx.home, item, { state: 'executing' });

    fx.scripted.boundary({ default: BOUNDARY.unknown });
    await stopRun(fx.engine, project, first.id);
    // Signalling cannot make an unreadable boundary readable, so there is
    // nothing to wait for: well inside terminate_grace the run is quarantined.
    const row = await runSettles(fx, first.id, {
      timeoutMs: 10_000,
      otherwise: `an unknown report means quarantine when it is made (terminate_grace is ${config.terminate_grace} s, kill_grace ${config.kill_grace} s)`,
    });
    assert.equal(row.quarantined, 1, 'unknown is never termination');
    assertRunQuarantined(fx.home, first.id, { outcome: 'stopped' });
    assert.notEqual(workItem(fx.home, item).status, 'held', 'the work is not released');
  });

  // The second review: the case above was met by returning at the first
  // `unknown` report, after SIGTERM and before the SIGKILL that D1 §4.5 step 2
  // requires. The report ends the wait for a report. It does not end the
  // signalling: a process the engine found is still there to be killed.
  test('with the boundary reporting unknown, a stopped role that ignores SIGTERM is still sent SIGKILL after terminate_grace, and the quarantine clears once the boundary reads again', async (t) => {
    const config = { terminate_grace: 6, kill_grace: 2 };
    const fx = await scriptedEngine(t, { config });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const waiting = await addWork(fx.engine, project, 'review');
    fx.scripted.script(item, [script.hold('gate', { on_term: 'ignore' })]);
    fx.scripted.script(waiting, [script.complete()]);
    await tick(fx.engine, project);
    const launch = await fx.scripted.waitForHolding({ work_item: item });
    const first = await waitForRun(fx.home, item, { state: 'executing' });

    fx.scripted.boundary({ default: BOUNDARY.unknown });
    const stoppedAt = performance.now();
    await stopRun(fx.engine, project, first.id);

    // As before: quarantined at the report, inside terminate_grace. The role
    // ignores SIGTERM, and SIGKILL is not due yet, so it is still running.
    const row = await runSettles(fx, first.id, {
      timeoutMs: (config.terminate_grace - 2) * 1000,
      otherwise: `an unknown report means quarantine when it is made (terminate_grace is ${config.terminate_grace} s)`,
    });
    assert.equal(row.quarantined, 1, 'unknown is never termination');
    assert.equal(fx.scripted.isLive(launch), true, `SIGKILL is not due before terminate_grace (${config.terminate_grace} s): the role that ignores SIGTERM is still running when the quarantine is recorded`);
    assertRunQuarantined(fx.home, first.id, { outcome: 'stopped' });

    // D1 §4.5 step 2: TERM, terminate_grace, KILL. No tick is asked for: the
    // signalling is the run-end protocol's own, and a quarantine does not end it.
    const killWithinMs = (config.terminate_grace + config.kill_grace + 6) * 1000;
    await waitFor(() => !fx.scripted.isLive(launch), { timeoutMs: Math.max(1000, stoppedAt + killWithinMs - performance.now()), what: 'the role to be killed' }).catch(() => {});
    const signals = fx.scripted.eventsOf(launch.pid, 'signal').map((e) => e.signal);
    assert.equal(
      fx.scripted.isLive(launch),
      false,
      `a role that ignores SIGTERM must be sent SIGKILL once terminate_grace (${config.terminate_grace} s) has passed, also when the boundary reports unknown: ` +
        `${Math.round((performance.now() - stoppedAt) / 1000)} s after Stop it is still running (signals it logged: ${signals.join(', ') || 'none'}; ` +
        `run ${runRow(fx.home, first.id).state}, quarantined ${runRow(fx.home, first.id).quarantined})`,
    );
    assert.ok(signals.includes('SIGTERM'), 'it was sent SIGTERM first');

    // The role is gone and the boundary still cannot be read: nothing is
    // concluded from the kill. The quarantine holds, however many ticks run.
    await assertQuarantineHolds(fx, project, { runId: first.id, item, waiting, outcome: 'stopped' });

    // The boundary reads again and finds the domain empty: the quarantine
    // clears, and the run ends with the outcome it had.
    fx.scripted.boundary({ default: BOUNDARY.auto });
    await tick(fx.engine, project);
    await waitFor(() => runRow(fx.home, first.id).state === 'ended', { timeoutMs: 10_000, what: 'the quarantine to clear' }).catch(() => {});
    assert.equal(runRow(fx.home, first.id).state, 'ended', 'once the boundary reports the domain terminated, the quarantine clears and the run ends');
    assertRunEnded(fx.home, first.id, { outcome: 'stopped', reason_class: 'human_stop', workspace: 'retained', launched: true, recovery: false });
    assert.equal((await waitForWork(fx.home, item, 'held')).status, 'held', 'the stopped work is held');

    // The project is free again.
    await tick(fx.engine, project);
    await waitForWork(fx.home, waiting, 'complete');
    withStore(fx.home, (db) => assertWorkHistory(db, item));
  });
});

describe("M16 the role's exit begins the run end, not the end of its output (second review)", () => {
  // SEAM.md §13: the run-end protocol begins when the launched process exits.
  // Reading the end of its output is not that: a role may close its stdout
  // and go on working.
  test('a role that sends a valid result, closes its stdout and exits 0 later is not signalled before it exits, and ends completed', async (t) => {
    const fx = await scriptedEngine(t, { config: GRACE });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    // Result, end of output, and then the role is still there until released; it sends no heartbeat.
    fx.scripted.script(item, [{ steps: [step.result(), step.closeStdout(), step.hold('gate', { heartbeat_ms: 0 })] }]);

    await tick(fx.engine, project);
    const launch = await fx.scripted.waitForHolding({ work_item: item });
    const first = await waitForRun(fx.home, item);
    assert.equal(fx.scripted.eventsOf(launch.pid, 'stdout_closed').length, 1, 'the role closed its stdout after sending its result');

    // Three seconds with its output closed. The role has not exited, so
    // nothing has ended: it is not signalled, and the run has no outcome.
    await sleep(3000);
    const during = runRow(fx.home, first.id);
    const signalled = fx.scripted.eventsOf(launch.pid, 'signal').map((e) => e.signal);
    assert.deepEqual(
      signalled,
      [],
      `the run-end protocol begins when the role exits, not when its output ends: three seconds after closing its stdout the role, which had not exited, was signalled ` +
        `(run ${during.state}, outcome ${during.outcome}/${during.reason_class})`,
    );
    assert.equal(fx.scripted.isLive(launch), true, 'the role is still running');
    assert.equal(during.outcome, null, `a run whose role has not exited has no outcome yet (it is ${during.state}, ${during.outcome}/${during.reason_class})`);

    // Now it exits 0, by itself.
    fx.scripted.release(item);
    await waitFor(() => !fx.scripted.isLive(launch), { what: 'the role to exit' });
    assert.deepEqual(fx.scripted.eventsOf(launch.pid, 'exit').map((e) => e.code), [0], 'the role exited 0');
    await waitForRunState(fx.home, first.id, 'ended');
    assertRunEnded(fx.home, first.id, { outcome: 'completed', reason_class: 'none', workspace: 'retained', launched: true, recovery: false });
    assert.deepEqual(fx.scripted.eventsOf(launch.pid, 'signal'), [], 'it was never signalled');
    assert.equal((await waitForWork(fx.home, item, 'complete')).status, 'complete');
    withStore(fx.home, (db) => assertWorkHistory(db, item));
  });

  // E27 item 1: a final line without a line ending is still a line, whether
  // or not another process holds the stream open when the engine stops reading.
  for (const withDescendant of [false, true]) {
    const title = withDescendant
      ? 'a valid result with no line ending, from a role that exits 0 and leaves a descendant holding its stdout, ends completed'
      : 'a valid result with no line ending, from a role that exits 0, ends completed';
    test(title, async (t) => {
      const fx = await scriptedEngine(t, { config: GRACE });
      const project = (await addProject(fx)).id;
      const item = await addWork(fx.engine, project, 'verification');
      const before = [step.usage({ input_tokens: 5 }), ...(withDescendant ? [step.descendant({ holds_stdout: true, on_term: 'exit' })] : [])];
      fx.scripted.script(item, [script.completeUnterminated(before)]);

      await tick(fx.engine, project);
      const first = await waitForRun(fx.home, item);
      const [launch] = await fx.scripted.waitForLaunch({ run: first.id });
      const descendant = withDescendant ? await fx.scripted.waitForDescendant({ parent: launch.pid }) : null;
      if (descendant) assert.deepEqual([descendant.ready, descendant.holds_stdout], [true, true], "the descendant was up, holding the role's stdout, before the role wrote its result");
      await waitFor(() => !fx.scripted.isLive(launch), { what: 'the role process to exit' });
      assert.ok(fx.scripted.eventsOf(launch.pid, 'exit').some((e) => e.code === 0), 'the role exited 0 after writing its result');

      await runSettles(fx, first.id, { timeoutMs: 15_000, otherwise: 'the run-end protocol must begin when the role exits' });
      await waitForRunState(fx.home, first.id, 'ended');
      const ended = runRow(fx.home, first.id);
      assert.deepEqual(
        [ended.outcome, ended.reason_class],
        ['completed', 'none'],
        `a final line without a line ending is still a line: the role wrote a valid result as its last, unterminated line and exited 0${withDescendant ? ', and a descendant held its stdout open' : ''}`,
      );
      const facts = assertRunEnded(fx.home, first.id, { outcome: 'completed', reason_class: 'none', workspace: 'retained', launched: true, recovery: false });
      assert.equal(facts.receipts[0].usage.length, 1, 'the usage the role reported is kept');
      if (descendant) assert.equal(fx.scripted.isLive(descendant), false, 'the descendant was terminated as a member of the domain before the run ended');
      assert.equal((await waitForWork(fx.home, item, 'complete')).status, 'complete');
      assert.equal(runsOf(fx.home, item).length, 1, 'the work was done once');
    });
  }
});
