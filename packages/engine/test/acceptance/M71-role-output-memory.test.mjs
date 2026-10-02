// M71, the memory a role's output costs the engine (slice 6). Recorded for
// this row by the slice-2 review (E25: "the engine buffers a role's output
// without a cap") and again by the slice-4 session, which pinned what is
// retained (at most 8 MiB of a transcript, SEAM.md §56) and left what is
// buffered to the load row (COVERAGE.md). D1 §§6.1, 14.1; SEAM.md §93.
//
// The bound is not a number measured on some engine. A role writes 512 MiB
// to its standard output, in lines of one mebibyte. An engine that keeps a
// role's output in memory must hold those bytes, so its resident memory
// rises by at least what was written; one that passes the output through
// rises by its buffers. The case asks for less than half of what was
// written, measured as the rise of the process's peak resident memory
// (VmHWM), which nothing the engine does afterwards can lower.
//
// The role's result comes after the output, so the run completes only if
// the engine read all of it.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MIB, mib, residentMemory } from './harness/load.mjs';
import { addProject, addWork, assertRunEnded, scriptedEngine, tick, waitForRun } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';

const LINES = 512;
const WRITTEN = LINES * MIB;
const ALLOWED = WRITTEN / 2;

describe("M71 a role's output is not held in memory", () => {
  test(`a role that writes ${LINES} MiB of output and then its result completes, and the engine's peak resident memory rises by less than half of what the role wrote`, async (t) => {
    const fx = await scriptedEngine(t);
    const engine = fx.engine;
    const project = (await addProject(fx)).id;
    const item = await addWork(engine, project, 'verification');
    const output = Array.from({ length: LINES }, () => [step.stdoutFill(MIB - 1), step.stdout('\n')]).flat();
    fx.scripted.script(item, [{ steps: [step.hold('start', { heartbeat_ms: 0 }), ...output, step.result()] }]);
    await tick(engine, project);
    const run = await waitForRun(fx.home, item, { state: 'executing' });
    await fx.scripted.waitForHolding({ run: run.id }, 'start');

    const before = residentMemory(engine.pid);
    fx.scripted.release(item, 'start');
    const ended = await waitForRun(fx.home, item, { state: 'ended', timeoutMs: 300_000 });
    const after = residentMemory(engine.pid);

    assert.deepEqual([ended.outcome, ended.reason_class], ['completed', 'none'], `the engine read all the role wrote, and its result after it (${ended.reason_text ?? ''})`);
    assertRunEnded(fx.home, run.id, { outcome: 'completed' });
    const rise = after.peak - before.peak;
    t.diagnostic(`M71 role output: ${mib(WRITTEN)} written; engine peak resident memory ${mib(before.peak)} before, ${mib(after.peak)} after (rise ${mib(rise)}, allowed below ${mib(ALLOWED)})`);
    assert.ok(rise < ALLOWED, `the engine's peak resident memory rose by ${mib(rise)} while a role wrote ${mib(WRITTEN)}: less than ${mib(ALLOWED)} is allowed, and an engine that buffers the output cannot stay below what was written`);
  });
});
