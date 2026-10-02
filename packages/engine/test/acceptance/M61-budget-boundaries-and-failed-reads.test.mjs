// M61, budget boundaries and failed reads (slice 4). Plan §3.6 M61; D1 §§4.1,
// 6.6, 13.3, D1-13; E16b; Review B11; SEAM.md §§55, 61.
//
// A run that passes a token limit is stopped at the boundary the scripted
// adapter can enforce, a usage observation, and only through the run-end
// protocol: what it observed is kept, its work is parked behind a blocker,
// and resolving the blocker runs that work again and nothing that had
// completed. An unknown cost is bounded by tokens and is never shown as
// zero. When the store cannot be read for a budget check or a lease check,
// or a journal intent cannot be written, nothing is launched and no effect
// is made: there is no answer to fall back on.
//
// The time and repair limits of this row are pinned where they were built:
// M15-deadlines.test.mjs and M11-repair-limits.test.mjs (slice 2). Deferred
// (COVERAGE.md): faults in gate and decision transactions, and "resolving a
// budget refusal makes no check pass", to slice 5.
//
// The last case is the obligation the second slice-2 review left (E27; E30
// item 9): a role's result whose recording keeps failing must not be a
// silently missing result.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { armFault, clearFaults, releaseBarrier } from './harness/engine.mjs';
import { addGitProject, runToEnd } from './harness/gitruns.mjs';
import { assertOperations, changePolicy } from './harness/journal.mjs';
import { awayFromMidnight, getLedger, invocationOf, ledgerRows, originalRowOf } from './harness/ledger.mjs';
import { assertRecordsSound, recordFile, recordRow } from './harness/records.mjs';
import { worktreeList } from './harness/repos.mjs';
import {
  addProject,
  addWork,
  answerDecision,
  assertRunEnded,
  countOf,
  decisionsAbout,
  requestTick,
  run as runRow,
  runsOf,
  scriptedEngine,
  tick,
  tickOnce,
  tickUntil,
  unownedWorktrees,
  waitForIdle,
  waitForRun,
  waitForRunState,
  workItem,
} from './harness/runs.mjs';
import { RESULT_LINE, script, step } from './harness/scripted.mjs';

// A fault that outlasts any retry: the transaction or read keeps failing
// until the test takes the fault away.
const KEEPS_FAILING = 1000;

// The work is parked behind one open blocker that names the limit.
function assertParkedFor(home, item, limit) {
  const work = workItem(home, item);
  assert.equal(work.status, 'parked');
  assert.equal(JSON.parse(work.blocker).reason, limit, 'the blocker names the limit that was reached');
  const open = decisionsAbout(home, item, 'blocker').filter((d) => d.status === 'open');
  assert.equal(open.length, 1, 'one open blocker decision on the work');
  assert.deepEqual(JSON.parse(open[0].options).map((o) => o.key).sort(), ['cancel', 'retry']);
  return open[0];
}

describe('M61 budget boundaries', () => {
  test('a run that passes its token limit is stopped at a usage observation, through cleanup, with what it observed kept; retrying runs that work again and nothing that had completed', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    await changePolicy(fx.engine, project.id, { budget_run_billable_tokens: 10_000 });
    const within = await addWork(fx.engine, project.id, 'verification');
    const over = await addWork(fx.engine, project.id, 'verification');
    fx.scripted.script(within, [script.complete([step.usage({ input_tokens: 4000, output_tokens: 1000 })])]);
    fx.scripted.script(over, [script.hold('gate', { before: [step.usage({ input_tokens: 9000, output_tokens: 6000 })] }), script.complete([step.usage({ input_tokens: 100, output_tokens: 50 })])]);
    await tickUntil(fx.engine, project.id, () => workItem(fx.home, within).status === 'complete', { what: 'the run within its limit to complete' });

    const stopped = await runToEnd(fx, project.id, over);
    assertRunEnded(fx.home, stopped.id, { outcome: 'stopped', reason_class: 'budget', workspace: 'retained', launched: true });
    assert.equal((await fx.engine.get(`/v1/projects/${project.id}/runs/${stopped.id}`)).body?.run?.code, 'budget_exhausted');
    const [launch] = fx.scripted.launches({ run: stopped.id });
    assert.equal(fx.scripted.isLive(launch), false, 'the role is gone: the run ended only after its termination was observed');
    const charged = originalRowOf(fx.home, stopped.id);
    assert.deepEqual({ billable_in: charged.billable_in, out: charged.out, usage_complete: charged.usage_complete }, { billable_in: 9000, out: 6000, usage_complete: 0 }, 'the usage observed before the stop is kept, and the rest is unknown');
    assert.equal(countOf(fx.home, 'usage_observations', '"invocation" = ?', invocationOf(fx.home, stopped.id)), 1);
    const blocker = assertParkedFor(fx.home, over, 'budget_run_billable_tokens');
    assert.deepEqual((await getLedger(fx.engine, project.id)).budget, { exhausted: [] }, 'a run limit is not a day limit: the project is not over budget');

    await answerDecision(fx.engine, project.id, blocker.id, 'retry');
    await tickUntil(fx.engine, project.id, () => workItem(fx.home, over).status === 'complete', { what: 'the retried work to complete' });
    assert.equal(runsOf(fx.home, over).length, 2, 'the stopped work ran once more');
    assert.equal(runsOf(fx.home, within).length, 1, 'the work that had completed was not run again');
    assert.equal(fx.scripted.launches({ work_item: within }).length, 1);
    assert.equal(ledgerRows(fx.home, project.id).length, 3, 'three invocations, each charged once');
    assert.deepEqual(originalRowOf(fx.home, stopped.id), charged, 'the stopped run\'s charge is as it was');
  });

  test('an unknown cost is bounded by tokens: the run is stopped when the day\'s unknown-cost tokens pass the limit, and its cost stays unknown, not zero', async (t) => {
    await awayFromMidnight();
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    await changePolicy(fx.engine, project.id, { budget_day_unknown_tokens: 1000 });
    const item = await addWork(fx.engine, project.id, 'verification');
    fx.scripted.script(item, [script.hold('gate', { before: [step.usage({ input_tokens: 2000, output_tokens: 500 })] })]);

    const stopped = await runToEnd(fx, project.id, item);
    assertRunEnded(fx.home, stopped.id, { outcome: 'stopped', reason_class: 'budget', workspace: 'retained', launched: true });
    assertParkedFor(fx.home, item, 'budget_day_unknown_tokens');
    const row = originalRowOf(fx.home, stopped.id);
    assert.deepEqual({ billable_in: row.billable_in, out: row.out, cost_status: row.cost_status, cost_usd: row.cost_usd }, { billable_in: 2000, out: 500, cost_status: 'unknown', cost_usd: null });
    const ledger = await getLedger(fx.engine, project.id);
    assert.deepEqual(
      { unknown_cost_invocations: ledger.totals.unknown_cost_invocations, unknown_cost_tokens: ledger.totals.unknown_cost_tokens, reported_usd: ledger.totals.reported_usd, estimated_usd: ledger.totals.estimated_usd },
      { unknown_cost_invocations: 1, unknown_cost_tokens: 2500, reported_usd: null, estimated_usd: null },
      'the unknown cost is counted by its tokens and shown as unknown',
    );
    assert.deepEqual(ledger.budget, { exhausted: ['budget_day_unknown_tokens'] });
  });
});

describe('M61 a store that cannot be read or written fails closed', () => {
  test('budget: while the budget read fails nothing is dispatched, although an earlier check had succeeded', async (t) => {
    const fx = await scriptedEngine(t);
    const project = (await addProject(fx)).id;
    fx.scripted.defaultScript(script.complete([step.usage({ input_tokens: 10 })]));
    const first = await addWork(fx.engine, project, 'verification');
    await tickUntil(fx.engine, project, () => workItem(fx.home, first).status === 'complete', { what: 'a first item to complete within budget' });

    const second = await addWork(fx.engine, project, 'verification');
    await armFault(fx.engine, { point: 'budget_read', project, times: KEEPS_FAILING });
    for (let i = 0; i < 2; i++) await tickOnce(fx.engine, project);
    assert.equal(runsOf(fx.home, second).length, 0, 'no run was created on a budget that could not be read');
    assert.equal(fx.scripted.launches({ work_item: second }).length, 0);
    assert.equal(workItem(fx.home, second).status, 'eligible');
    assert.equal((await fx.engine.get('/v1/health')).status, 200, 'the engine goes on');

    await clearFaults(fx.engine);
    await tickUntil(fx.engine, project, () => workItem(fx.home, second).status === 'complete', { what: 'the item to complete once the budget can be read' });
    assert.equal(fx.scripted.launches({ work_item: second }).length, 1);
  });

  test('lease: while the lease read before the spawn fails no role is launched; the run ends unlaunched and the work is repaired afterwards', async (t) => {
    const fx = await scriptedEngine(t, { barriers: ['launch.before_spawn=pause'] });
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    fx.scripted.defaultScript(script.complete());
    await requestTick(fx.engine, project);
    await fx.engine.waitUntil('barrier:launch.before_spawn');
    const claimed = await waitForRun(fx.home, item, { state: 'claimed' });
    await armFault(fx.engine, { point: 'lease_read', times: KEEPS_FAILING });
    await releaseBarrier(fx.engine, 'launch.before_spawn');

    await waitForRunState(fx.home, claimed.id, 'ended', { timeoutMs: 60_000 });
    assertRunEnded(fx.home, claimed.id, { outcome: 'failed', reason_class: 'infra_error', launched: false });
    assert.equal(fx.scripted.launches().length, 0, 'nothing was launched on a lease that could not be read');

    await clearFaults(fx.engine);
    await tickUntil(fx.engine, project, () => workItem(fx.home, item).status === 'complete', { what: 'the item to complete once the lease can be read' });
    assert.equal(fx.scripted.launches({ work_item: item }).length, 1, 'one launch in all');
  });

  test('journal: while the intent cannot be written no git effect is made and nothing is launched', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addProject(fx);
    const item = await addWork(fx.engine, project.id, 'verification');
    fx.scripted.defaultScript(script.complete());
    await armFault(fx.engine, { point: 'before_event', event_type: 'git.journal_intended', times: KEEPS_FAILING });
    for (let i = 0; i < 2; i++) {
      await tickOnce(fx.engine, project.id);
      await waitForIdle(fx.home, project.id);
    }
    assert.equal(worktreeList(project.repo.path).length, 1, 'no worktree was added without a committed intent');
    assert.deepEqual(unownedWorktrees(fx.home, project.id), []);
    assert.equal(fx.scripted.launches().length, 0, 'and no role was launched');

    await clearFaults(fx.engine);
    await tickUntil(fx.engine, project.id, () => workItem(fx.home, item).status === 'complete', { what: 'the item to complete once the journal can be written' });
    assert.equal(fx.scripted.launches({ work_item: item }).length, 1);
    assertOperations(fx.home, { project: project.id });
  });
});

describe('M61 a result whose recording keeps failing', () => {
  test('the run ends failed with the cause stated, the result the role sent is still in its transcript, and the work is repaired', async (t) => {
    const fx = await scriptedEngine(t);
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    fx.scripted.script(item, [script.holdThenComplete('gate', [step.usage({ input_tokens: 7 })]), script.complete()]);
    await tick(fx.engine, project);
    const first = await waitForRun(fx.home, item, { state: 'executing' });
    await fx.scripted.waitForHolding({ run: first.id });
    await armFault(fx.engine, { point: 'before_event', event_type: 'run.validating', times: KEEPS_FAILING });
    fx.scripted.release(item);

    await waitForRunState(fx.home, first.id, 'ended', { timeoutMs: 90_000 });
    assertRunEnded(fx.home, first.id, { outcome: 'failed', reason_class: 'infra_error', launched: true });
    const ended = runRow(fx.home, first.id);
    assert.ok(typeof ended.reason_text === 'string' && ended.reason_text.length > 0, 'the run says why it failed');
    assertRecordsSound(fx.home, project);
    assert.ok(ended.transcript, 'the run has its transcript');
    assert.ok(readFileSync(recordFile(fx.home, recordRow(fx.home, ended.transcript)), 'utf8').includes(RESULT_LINE), 'the result the role sent is retained in the transcript');

    await clearFaults(fx.engine);
    await tickUntil(fx.engine, project, () => workItem(fx.home, item).status === 'complete', { what: 'the repair run to complete' });
    assert.equal(runsOf(fx.home, item).length, 2, 'one repair');
    assert.equal(workItem(fx.home, item).repair_attempts, 1);
  });
});
