// M15, the git-call deadline and repository integrity as the overrunning
// prerequisite step (slice 3). Plan §3.2 M15 ("hold an actual git child
// open; expire a run, git call, prerequisite tick step and total tick budget
// in separate cases"); D1 §§7.1, 8.1, 8.5; E7 §3.9.5; D1-20; SEAM.md §§18,
// 32, 34.
//
// Slice 2 expired a run, the first two prerequisite steps and the tick
// budget. Two cases needed git:
//
//   - a git command the engine spawned is held open past `git_deadline`. The
//     engine kills it. The command could have written, so its operation is
//     marked ambiguous, and nothing that depends on it goes on because a
//     timer ran out. Other projects and the API are not disturbed;
//   - the tick's integrity step overruns `tick_step_budget` for one project.
//     That project is not dispatched in that tick, also when the step
//     completes later; the other project is.
//
// How an ambiguous operation is reconciled afterwards, and what its run ends
// as, is the second slice-3 session's (rows M31, M34).

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { armFault, releaseBarrier, waitFor } from './harness/engine.mjs';
import { addGitProject, addItem, permittedEdit, roleThat } from './harness/gitruns.mjs';
import { eventsOfType, operationsOf } from './harness/journal.mjs';
import { holdGit } from './harness/repos.mjs';
import { requestTick, run as runRow, runsOf, scriptedEngine, tick, waitForRun, waitForWork, workItem } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';

// The git processes that name this path on their command line.
function gitProcessesNaming(path) {
  const found = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const argv = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0');
      if (/(^|\/)git$/.test(argv[0]) && argv.some((arg) => arg.includes(path))) found.push({ pid: Number(name), argv: argv.join(' ') });
    } catch {
      // gone, or not ours to read
    }
  }
  return found;
}

describe('M15 a git call past its deadline', () => {
  const GIT_DEADLINE = 2;

  test('a worktree add held open is killed at git_deadline, its operation is marked ambiguous, no role is launched on it, and another project and the API go on', async (t) => {
    const fx = await scriptedEngine(t, { config: { git_deadline: GIT_DEADLINE }, barriers: ['dispatch.receipt_committed=pause'] });
    const held = await addGitProject(fx, { name: 'held' });
    const other = await addGitProject(fx, { name: 'other' });
    fx.scripted.defaultScript(roleThat([permittedEdit()]));
    const item = await addItem(fx, held.id, 'fix');

    // The dispatch is stopped after its claim and before its workspace is created.
    await requestTick(fx.engine, held.id);
    await fx.engine.waitUntil('barrier:dispatch.receipt_committed');
    const run = await waitForRun(fx.home, item, { state: 'claimed' });
    // From here every git command on this repository waits: its configuration is a pipe nobody writes to.
    const letGo = holdGit(held.repo.path);
    fx.beforeCleanup.push(letGo);
    const heldAt = performance.now();
    await releaseBarrier(fx.engine, 'dispatch.receipt_committed');

    // The call is made, and held.
    const [operation] = await waitFor(() => {
      const ops = operationsOf(fx.home, { run: run.id, journalKind: 'worktree_add' });
      return ops.length === 1 ? ops : undefined;
    }, { what: 'the worktree_add operation to be journaled' });
    assert.equal(operation.events[0].kind, 'intended');
    await waitFor(() => gitProcessesNaming(fx.home).length >= 1, { timeoutMs: 5000, what: 'the engine to spawn its git command' });
    assert.equal((await fx.engine.get('/v1/health')).status, 200, 'the API answers while a git call is held');

    // Past the deadline the child is gone and the operation is ambiguous.
    await waitFor(() => gitProcessesNaming(fx.home).length === 0, { timeoutMs: (GIT_DEADLINE + 6) * 1000, what: 'the engine to kill the held git command' });
    const waited = (performance.now() - heldAt) / 1000;
    assert.ok(waited >= GIT_DEADLINE - 1, `the command was given its deadline (${GIT_DEADLINE} s) before it was killed (it was gone after ${waited.toFixed(1)} s)`);
    const marked = await waitFor(() => {
      const [op] = operationsOf(fx.home, { run: run.id, journalKind: 'worktree_add' });
      return op.events.some((e) => e.kind === 'ambiguous') ? op : undefined;
    }, { timeoutMs: 8000, what: 'the operation to be marked ambiguous' });
    assert.notEqual(marked.status, 'succeeded', 'a command killed at its deadline did not succeed');
    assert.ok(!marked.events.some((e) => e.kind === 'applied' || e.kind === 'confirmed'), 'and nothing recorded it as applied');
    assert.ok(eventsOfType(fx.home, 'git.journal_ambiguous').length >= 1 && eventsOfType(fx.home, 'operation.ambiguous').length >= 1, 'the ambiguity is on the record as events');
    assert.equal(fx.scripted.launches({ run: run.id }).length, 0, 'no role was launched on a workspace nobody saw created');
    assert.notEqual(runRow(fx.home, run.id).state, 'executing');
    assert.notEqual(runRow(fx.home, run.id).outcome, 'completed');

    // Meanwhile the other project, whose repository answers, is dispatched and integrates.
    const otherItem = await addItem(fx, other.id, 'fix');
    await tick(fx.engine, other.id);
    await waitFor(() => runsOf(fx.home, otherItem).length === 1 && runsOf(fx.home, otherItem)[0].state === 'ended', { timeoutMs: 30_000, what: 'the other project to run its work' });
    assert.equal(runsOf(fx.home, otherItem)[0].outcome, 'completed', 'a held git call in one repository does not hold another project');
    assert.equal((await fx.engine.get('/v1/health')).status, 200);
  });
});

describe('M15 repository integrity as the prerequisite step that overruns', () => {
  const tickEvents = (home) => withStore(home, (db) => db.prepare(`SELECT "seq" FROM "events" WHERE "type" = 'engine.tick' ORDER BY "seq"`).all().map((e) => e.seq));
  const createdSeq = (home, runId) => withStore(home, (db) => db.prepare(`SELECT "seq" FROM "events" WHERE "type" = 'run.created' AND json_extract("subject", '$.run') = ?`).get(runId).seq);

  test('an integrity step that overruns its budget suppresses that project for the tick, late completion included, while the other project is dispatched', async (t) => {
    const fx = await scriptedEngine(t, { config: { tick_step_budget: 1, tick_budget: 20 } });
    fx.scripted.defaultScript({ steps: [{ result: { status: 'completed', summary: 'done' } }] });
    const a = (await addGitProject(fx)).id;
    const b = (await addGitProject(fx)).id;
    await tick(fx.engine, a);
    const itemA = await addItem(fx, a, 'verification');
    const itemB = await addItem(fx, b, 'verification');

    const delay = 4000;
    await armFault(fx.engine, { point: 'tick_step', step: 'integrity', project: a, delay_ms: delay });
    const requested = Date.now();
    const before = tickEvents(fx.home).at(-1) ?? 0;
    await requestTick(fx.engine, a);
    const tickSeq = await waitFor(() => tickEvents(fx.home).find((seq) => seq > before), { what: 'the requested tick to finish' });
    assert.equal((await fx.engine.get('/v1/health')).status, 200, 'the API answers while a step is overrunning');

    // In that tick: B was dispatched, A was not.
    const runB = await waitForRun(fx.home, itemB);
    assert.ok(createdSeq(fx.home, runB.id) < tickSeq, 'the other project was dispatched in the same tick');
    assert.equal(runsOf(fx.home, itemA).length, 0, 'the project whose integrity step overran was not dispatched in that tick');

    // The slow step completes late. Nothing is dispatched on the strength of it.
    await sleep(Math.max(0, requested + delay + 1500 - Date.now()));
    assert.equal(runsOf(fx.home, itemA).length, 0, 'a late completion does not dispatch');
    assert.equal(workItem(fx.home, itemA).status, 'eligible');
    await waitForWork(fx.home, itemB, 'complete');

    // The next tick, with its integrity step in time, dispatches it.
    await tick(fx.engine, a);
    await waitForWork(fx.home, itemA, 'complete');
    assert.equal(fx.scripted.launches({ work_item: itemA }).length, 1);
  });
});
