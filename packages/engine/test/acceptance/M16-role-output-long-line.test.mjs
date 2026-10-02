// M16, reading a role's output (slice 3; the final slice-2 review, E28).
// Plan §3.2 M16 ("unknown termination is never success" rests on the engine
// reading what a role really sent); D1 §§4.3, 15.1; E27 item 1; SEAM.md §§13
// and 24. The engine reads a role's standard output as lines. The time that
// takes is linear in the length of a line, and a long line costs nothing of
// what follows it: a role that writes one very long line, then reports usage
// and a valid result, and exits 0, ends completed, with its usage recorded,
// within the bound stated here. The slice-2 engine put each chunk it read
// after everything it had read of the line so far and searched the whole
// again, so the time grew with the square of the line's length.
//
// The role program exits only once everything it wrote has been read
// (../harness/scripted/child.mjs), so what is measured is the engine and not
// output the harness dropped.

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { describe, test } from 'node:test';

import { assertRunEnded, addProject, addWork, scriptedEngine, tick, waitForRun, waitForWork } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';

// One line of this many bytes (64 MiB), and how long the run may take from
// the role's launch to its end. A reader that is linear in the line's length
// needs about a second for it on the host these tests were written on; the
// slice-2 engine needed fifteen.
const LINE_BYTES = 64 * 1024 * 1024;
const BOUND_MS = 8000;

describe('M16 a very long line of role output (final review)', () => {
  test('a role that writes one line of 64 MiB and then its usage and a valid result ends completed within eight seconds, and nothing after the line is lost', async (t) => {
    const fx = await scriptedEngine(t);
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const usage = { input_tokens: 41, output_tokens: 3 };
    fx.scripted.script(item, [{ steps: [step.stdoutFill(LINE_BYTES), step.stdout('\n'), step.usage(usage), step.result()] }]);
    await tick(fx.engine, project);
    const [launch] = await fx.scripted.waitForLaunch({ work_item: item });
    const launchedAt = performance.now();
    const run = await waitForRun(fx.home, item, { state: 'ended', timeoutMs: 180_000 });
    const took = performance.now() - launchedAt;

    assert.deepEqual(
      [run.outcome, run.reason_class],
      ['completed', 'none'],
      'the result the role sent after the long line was read: nothing after a long line is lost',
    );
    const facts = assertRunEnded(fx.home, run.id, { outcome: 'completed', reason_class: 'none', workspace: 'retained', launched: true, recovery: false });
    assert.deepEqual(facts.receipts[0].usage.map((u) => JSON.parse(u.raw)), [usage], 'the usage reported after the long line was recorded');
    assert.ok(fx.scripted.eventsOf(launch.pid, 'exit').some((e) => e.code === 0), 'the role exited 0 once all it wrote had been read');
    assert.equal((await waitForWork(fx.home, item, 'complete')).status, 'complete');
    assert.ok(
      took <= BOUND_MS,
      `reading a role's output must be linear in the length of a line: a line of ${LINE_BYTES / (1024 * 1024)} MiB, then a usage line and a result, took ${Math.round(took)} ms from the role's launch to the run's end (bound: ${BOUND_MS} ms)`,
    );
  });
});
