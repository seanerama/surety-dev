// M18 (slice 2). Plan §3.2 M18; D1 §§2.7, 4.5, 15.1, 16; build spec §6
// corrections 1, 12 and 13; Review B08, B17; D1-08, D1-26, D1-32; SEAM.md
// §§14, 16, 18. The engine is killed at each boundary of a dispatch and of a
// run end: run created, domain allocated, receipt committed, just before the
// spawn, role spawned but ownership not yet completed, a normal result
// received and not yet acted on, finalizing and not yet ended. Each case
// reopens the store after the kill, restarts the engine and asserts what
// recovery made of every row the dead engine left: every invocation and
// domain accounted for, no execution authority left, the role process gone,
// an outcome already recorded kept and finalized once, no replacement
// launched before that, and then the work continued by an explicit Resume.
// A recorded pid that now belongs to an unrelated process is never
// signalled. A boundary whose emptiness is unknown leaves the run
// quarantined.
// Snapshot recovery of the role's files ("normal result before snapshot")
// belongs to slice 3; here the workspace is asserted retained with them.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { assertRecoveredStore, assertWorkHistory, eventsAbout } from './harness/invariants.mjs';
import { isAlive, procStartTime } from './harness/proc.mjs';
import {
  addProject,
  addWork,
  assertRunEnded,
  assertRunQuarantined,
  requestTick,
  resumeWork,
  runsOf,
  runsOfProject,
  scriptedEngine,
  tick,
  waitForRun,
  waitForWork,
  workItem,
} from './harness/runs.mjs';
import { BOUNDARY, processIsLive, script, step } from './harness/scripted.mjs';
import { openStore, storePath, withStore } from './harness/store.mjs';

// Each boundary: the script of the first launch (if the dispatch gets that
// far), and what recovery must record. `launched` is whether a role process
// was in fact spawned before the kill: true, false, or null where the store
// alone cannot tell (the kill came between `dispatch_started` and the spawn).
const BOUNDARIES = [
  { barrier: 'dispatch.run_created', launched: false, outcome: 'recovered', work: 'held' },
  { barrier: 'dispatch.domain_allocated', launched: false, outcome: 'recovered', work: 'held' },
  { barrier: 'dispatch.receipt_committed', launched: false, outcome: 'recovered', work: 'held' },
  { barrier: 'launch.before_spawn', launched: null, outcome: 'recovered', work: 'held' },
  { barrier: 'launch.before_ownership', first: script.hold('gate', { before: [step.write('notes.txt', 'half done')] }), launched: true, outcome: 'recovered', work: 'held' },
  { barrier: 'run.result_received', first: script.complete([step.write('notes.txt', 'done'), step.usage({ input_tokens: 9 })]), launched: true, outcome: 'recovered', work: 'held' },
  { barrier: 'run_end.before_ended', first: script.complete([step.usage({ input_tokens: 9 })]), launched: true, outcome: 'completed', work: 'complete' },
];

// Start an engine that kills itself at `barrier`, give it one verification
// item, ask for a tick, and wait for the engine to die there.
async function killedAt(t, barrier, first, { config = {}, holdsAfterKill = false } = {}) {
  const fx = await scriptedEngine(t, { barriers: [`${barrier}=kill`], config });
  const project = (await addProject(fx)).id;
  const item = await addWork(fx.engine, project, 'verification');
  // The first real launch follows `first` (or completes); any later one completes.
  fx.scripted.script(item, [first ?? script.complete(), script.complete()]);
  fx.scripted.defaultScript(script.complete());
  const dead = fx.engine;
  const incarnation = (await dead.engineInfo()).incarnation;
  await requestTick(dead, project).catch(() => {});
  const status = await dead.exited;
  assert.deepEqual(status, { code: null, signal: 'SIGKILL' }, `the engine killed itself at ${barrier}`);
  // A role spawned just before the kill may still be starting; its own log says when it is there.
  if (holdsAfterKill) await fx.scripted.waitForHolding({ work_item: item });
  const runs = runsOfProject(fx.home, project);
  assert.equal(runs.length, 1, `one run exists after a kill at ${barrier}`);
  assert.notEqual(runs[0].state, 'ended', 'and it has not ended');
  return { fx, project, item, run: runs[0], incarnation };
}

const rowsOf = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));

describe('M18 recovery at each allocation, launch and run-end boundary', () => {
  for (const b of BOUNDARIES) {
    test(`killed at ${b.barrier}`, async (t) => {
      const { fx, project, item, run } = await killedAt(t, b.barrier, b.first, { holdsAfterKill: b.barrier === 'launch.before_ownership' });

      // What the dead engine left, read from the reopened store and from the role's own log.
      const before = {
        receipts: rowsOf(fx.home, 'SELECT "id" FROM "invocation_receipts" WHERE "run" = ?', run.id).map((r) => r.id),
        domains: rowsOf(fx.home, 'SELECT "id", "status" FROM "execution_domains" WHERE "run" = ?', run.id),
        launches: fx.scripted.launches({ work_item: item }),
        ledger: rowsOf(fx.home, 'SELECT "id" FROM "ledger_rows" WHERE "run" = ?', run.id).length,
      };
      assert.equal(workItem(fx.home, item).status === 'eligible', false, 'the work was claimed in the transaction that created its run');
      if (b.launched === true) assert.equal(before.launches.length, 1, 'the role was spawned before the kill');
      if (b.launched === false) assert.equal(before.launches.length, 0, 'no role was spawned before the kill');
      if (b.barrier === 'launch.before_ownership') {
        assert.equal(fx.scripted.isLive(before.launches[0]), true, 'the role outlived the engine');
        const own = rowsOf(fx.home, 'SELECT * FROM "process_ownership" WHERE "domain" = ?', before.domains[0].id);
        assert.equal(own[0].pid, null, 'its ownership row was never completed');
      }
      if (b.barrier === 'run_end.before_ended') {
        assert.deepEqual([run.state, run.outcome], ['finalizing', 'completed'], 'the outcome was recorded before the kill');
      } else {
        assert.equal(run.outcome, null, 'no outcome was recorded before the kill');
      }

      // Restart. Recovery runs before full mode.
      const engine = await fx.start();
      const incarnation = (await engine.engineInfo()).incarnation;
      withStore(fx.home, (db) => assertRecoveredStore(db));
      const facts = assertRunEnded(fx.home, run.id, {
        outcome: b.outcome,
        reason_class: b.outcome === 'recovered' ? 'recovered' : 'none',
        workspace: 'retained',
        recovery: incarnation,
        ...(b.launched === null ? {} : { launched: b.launched }),
      });
      // Every invocation and domain the dead engine registered is accounted for, and none was added.
      assert.deepEqual(facts.receipts.map((r) => r.id), before.receipts, 'the same receipts, each finalized');
      assert.deepEqual(facts.domains.map((d) => d.id), before.domains.map((d) => d.id), 'the same domains, each terminated');
      for (const launch of fx.scripted.launches({ work_item: item })) assert.equal(fx.scripted.isLive(launch), false, 'no role process survives recovery');
      assert.equal(fx.scripted.launches({ work_item: item }).length, before.launches.length, 'recovery launched nothing');
      if (b.barrier === 'launch.before_ownership' || b.barrier === 'run.result_received') {
        assert.ok(existsSync(`${facts.workspaces[0].path}/notes.txt`), 'the workspace is retained with what the role wrote');
      }
      assert.equal((await waitForWork(fx.home, item, b.work)).status, b.work);

      // No replacement is launched by the scheduler; finalization is not repeated.
      for (let i = 0; i < 2; i++) await tick(engine, project);
      assert.equal(runsOf(fx.home, item).length, 1, 'no replacement run');
      assert.equal(fx.scripted.launches({ work_item: item }).length, before.launches.length);
      assertRunEnded(fx.home, run.id, { outcome: b.outcome, recovery: incarnation });

      if (b.work === 'held') {
        // Continuation: an explicit Resume, a new run linked to the recovered one, and the work completes.
        await resumeWork(engine, project, item);
        await tick(engine, project);
        await waitForWork(fx.home, item, 'complete');
        const [, second] = runsOf(fx.home, item);
        assert.equal(second.parent_run, run.id);
        assertRunEnded(fx.home, second.id, { outcome: 'completed', launched: true, recovery: false });
        assert.equal(fx.scripted.launches({ work_item: item }).length, before.launches.length + 1, 'exactly one more launch');
      } else {
        // The outcome recorded before the kill stands, and a second restart changes nothing.
        assert.equal(facts.receipts[0].ledger.filter((row) => row.corrects === null).length, 1);
        await engine.kill();
        const again = await fx.start();
        await tick(again, project);
        const after = assertRunEnded(fx.home, run.id, { outcome: 'completed', recovery: incarnation, launched: true });
        assert.equal(after.receipts[0].ledger.length, 1, 'finalized once');
        assert.equal(workItem(fx.home, item).status, 'complete');
        assert.equal(runsOf(fx.home, item).length, 1);
      }
      withStore(fx.home, (db) => {
        assertWorkHistory(db, item);
        assert.equal(eventsAbout(db, 'run', run.id, 'run.ended').length, 1);
      });
    });
  }

  test('a recorded pid that now belongs to an unrelated process is not signalled', async (t) => {
    const fx = await scriptedEngine(t);
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(item, [script.hold('gate'), script.complete()]);
    await tick(fx.engine, project);
    const launch = await fx.scripted.waitForHolding({ work_item: item });
    const run = await waitForRun(fx.home, item, { state: 'executing' });
    await fx.engine.kill();

    // The role dies while the engine is down, and its pid is "reused": the
    // ownership row now names a live process with another start time, in a
    // process group of its own.
    process.kill(launch.pid, 'SIGKILL');
    await waitFor(() => !processIsLive(launch.pid, launch.start_time), { what: 'the role process to be gone' });
    const bystander = spawn('sleep', ['300'], { stdio: 'ignore', detached: true });
    t.after(() => {
      try {
        process.kill(bystander.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    });
    await waitFor(() => existsSync(`/proc/${bystander.pid}/stat`), { what: 'the bystander to start' });
    assert.notEqual(procStartTime(bystander.pid), String(launch.start_time));
    const db = openStore(storePath(fx.home));
    try {
      const changed = db
        .prepare('UPDATE "process_ownership" SET "pid" = ?, "pgid" = ? WHERE "invocation" = (SELECT "id" FROM "invocation_receipts" WHERE "run" = ?)')
        .run(bystander.pid, bystander.pid, run.id);
      assert.equal(changed.changes, 1);
    } finally {
      db.close();
    }

    const engine = await fx.start();
    const incarnation = (await engine.engineInfo()).incarnation;
    assertRunEnded(fx.home, run.id, { outcome: 'recovered', reason_class: 'recovered', recovery: incarnation, launched: true });
    withStore(fx.home, (database) => assertRecoveredStore(database));
    assert.ok(isAlive(bystander.pid) && bystander.exitCode === null && bystander.signalCode === null, 'the unrelated process was not signalled');

    // Continuation.
    await resumeWork(engine, project, item);
    await tick(engine, project);
    await waitForWork(fx.home, item, 'complete');
    assert.ok(isAlive(bystander.pid) && bystander.signalCode === null, 'and still was not');
  });

  test('a boundary whose emptiness is unknown after the restart leaves the run quarantined until termination is observed', async (t) => {
    const { fx, project, item, run } = await killedAt(t, 'launch.before_ownership', script.hold('gate'), {
      config: { terminate_grace: 1, kill_grace: 1 },
      holdsAfterKill: true,
    });
    const [launch] = fx.scripted.launches({ work_item: item });
    assert.equal(fx.scripted.isLive(launch), true, 'the role outlived the engine');

    // After the restart the boundary cannot say whether the domain is empty.
    fx.scripted.boundary({ default: BOUNDARY.unknown });
    const engine = await fx.start();
    assert.equal((await engine.engineInfo()).mode, 'full', 'a quarantine does not keep the engine restricted');
    const quarantined = assertRunQuarantined(fx.home, run.id, { outcome: 'recovered' });
    assert.equal(quarantined.work.status === 'held', false, 'the work is not released while the run is quarantined');
    for (let i = 0; i < 2; i++) await tick(engine, project);
    assert.equal(runsOf(fx.home, item).length, 1, 'no replacement before reconciliation');
    assertRunQuarantined(fx.home, run.id, { outcome: 'recovered' });

    // The role is in fact gone, and the boundary can be read again.
    if (fx.scripted.isLive(launch)) process.kill(launch.pid, 'SIGKILL');
    await waitFor(() => !fx.scripted.isLive(launch), { what: 'the role process to be gone' });
    fx.scripted.boundary({ default: BOUNDARY.auto });
    await tick(engine, project);
    await waitFor(() => runsOf(fx.home, item)[0].state === 'ended', { what: 'the quarantine to clear' });
    assertRunEnded(fx.home, run.id, { outcome: 'recovered', reason_class: 'recovered', launched: true });
    await waitForWork(fx.home, item, 'held');
    await resumeWork(engine, project, item);
    await tick(engine, project);
    await waitForWork(fx.home, item, 'complete');
    assert.equal(fx.scripted.launches().length, 2, 'two launches in all: the one that was quarantined and the resumed one');
  });
});
