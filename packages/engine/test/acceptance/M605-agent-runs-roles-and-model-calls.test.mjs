// M605, agent runs, roles and model calls (the owner's draft M7 plan §3,
// row M605; request §7; rulings R7, R9 of 2026-10-28; SEAM.md §575).
// Kernel lane.
//
//   (a) three Builder runs of one iteration: three agent runs, one role
//       (`builder` in roles_used once; agent_runs counts runs, not roles).
//   (b) a session run of two turns: invocations 2 for that run.
//   (c) a run of a second iteration: counted in its own iteration only;
//       app_totals counts both iterations' runs once.
//   (d) a restart between runs: the totals identical before and after.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { tick } from './harness/runs.mjs';
import {
  PROTO,
  answerOpen,
  assertAccounted,
  briefToAlpha,
  builderScript,
  currentIt,
  iterationRead,
  kindNext,
  ok,
  protoEngine,
  pump,
  receiptsOfRun,
  result,
  runsOfIteration,
  statusIs,
  toBrief,
  usage,
} from './harness/prototype.mjs';

describe('M605 agent runs, roles and model calls', () => {
  const shared = sharedFixture();
  const S = {};
  before(async () => {
    S.fx = await protoEngine(shared.context);
  });
  after(() => shared.cleanup());

  test('(a) three Builder runs of one iteration: three agent runs of one role', async () => {
    const { fx } = S;
    const { id, it } = await toBrief(fx, { name: 'Tasks runs' });
    // Stage 1's first Builder run exits with no result and is repaired: three Builder runs in all.
    kindNext(fx, 'stage_build', [{ steps: [usage(800, 0, 200), { exit: 3 }] }, builderScript(1), builderScript(2)], builderScript(1));
    await briefToAlpha(fx, id, it.id);
    S.p = id;
    S.one = it.id;
    const read = await iterationRead(fx, id, it.id);
    const builders = read.usage.runs.filter((r) => r.role === 'builder');
    assert.equal(builders.length, 3, `three Builder runs (${JSON.stringify(read.usage.runs.map((r) => [r.role, r.work_kind, r.outcome]))})`);
    assert.equal(new Set(builders.map((r) => r.id)).size, 3, 'three distinct runs');
    assert.equal(builders.filter((r) => r.outcome === 'completed').length, 2, 'two accepted, one not');
    assert.equal(read.usage.totals.roles_used.filter((r) => r === 'builder').length, 1, 'the Builder is one role in roles_used');
    assert.deepEqual(read.usage.totals.roles_used, [...new Set(read.usage.runs.map((r) => r.role))], 'roles_used: each role once');
    assert.equal(read.usage.totals.agent_runs, read.usage.runs.length, 'agent_runs counts runs, not roles');
    assert.equal(read.usage.totals.agent_runs, runsOfIteration(fx.home, it.id).length, 'every run attributed to the iteration in the store');
    for (const r of builders) assert.equal(r.invocations.length, 1, 'each one-shot Builder run is one invocation');
    assertAccounted(read, 'three Builder runs');
  });

  test('(d) a restart between runs: the totals identical before and after', async () => {
    const { fx } = S;
    const before1 = await iterationRead(fx, S.p, S.one);
    await fx.engine.stop();
    await fx.start();
    const after1 = await iterationRead(fx, S.p, S.one);
    for (const k of ['usage', 'owner_approvals', 'plan', 'outcome', 'app_totals']) assert.deepEqual(after1[k], before1[k], `the iteration's ${k} after the restart is what it was before`);
    assert.deepEqual(after1.remaining.committed, before1.remaining.committed, 'and what it committed');
    assertAccounted(after1, 'after the restart');
  });

  test('(c) a run of a second iteration: counted in its own iteration only; app_totals counts both once', async () => {
    const { fx } = S;
    const p = S.p;
    const before1 = await iterationRead(fx, p, S.one);
    const made = await ok(fx.engine.post(`/v1/projects/${p}/iterations/${S.one}/iterate`, { change: 'Show the number of open tasks.' }), 201, 'POST …/iterate');
    const two = made.iteration.id;
    S.two = two;
    await answerOpen(fx, p, PROTO.preparation.decision);
    await pump(fx, p, statusIs(fx, p, two, 'awaiting_brief_approval'), { what: "iteration 2's brief" });
    const read2 = await iterationRead(fx, p, two);
    const after1 = await iterationRead(fx, p, S.one);
    assert.deepEqual(read2.usage.runs.map((r) => r.work_kind), [PROTO.preparation.work_kind], "iteration 2's own run: its preparation");
    assert.deepEqual(runsOfIteration(fx.home, two).map((r) => r.id), read2.usage.runs.map((r) => r.id), 'attributed to iteration 2 in the store');
    assert.deepEqual(after1.usage, before1.usage, "iteration 1's usage unchanged: the new run is not counted there");
    const ones = new Set(after1.usage.runs.map((r) => r.id));
    assert.ok(read2.usage.runs.every((r) => !ones.has(r.id)), 'no run of iteration 1 in iteration 2');
    assert.equal(read2.app_totals.iterations, 2);
    assert.equal(read2.app_totals.agent_runs, after1.usage.totals.agent_runs + read2.usage.totals.agent_runs, "the app's runs: both iterations', each once");
    assert.equal(read2.app_totals.invocations, after1.usage.totals.invocations + read2.usage.totals.invocations);
    for (const k of ['billable_in', 'cached_in', 'out']) assert.equal(read2.app_totals.tokens[k], after1.usage.totals.tokens[k] + read2.usage.totals.tokens[k], `app_totals.tokens.${k}: the sum, once`);
    assert.deepEqual(after1.app_totals, read2.app_totals, "the app's totals are the same read from either iteration");
    assert.match(read2.app_totals.cumulative_rule, /each counted once/);
  });

  test('(b) a session run of two turns: invocations 2 for that run', async () => {
    const { fx } = S;
    const p = S.p;
    const opened = await ok(fx.engine.post(`/v1/projects/${p}/sessions`, { role: 'spec_writer' }), 201, 'POST …/sessions opens a Spec Writer session');
    const run = opened.run.id;
    const turn = (reply) => ({ steps: [usage(400, 100, 80), result({ summary: reply, reply, artifact_changed: false })] });
    fx.scripted.script(`run-${run}`, [turn('First answer.'), turn('Second answer.')]);
    for (const text of ['What does the prototype leave out?', 'And what is mocked?']) {
      const posted = await ok(fx.engine.post(`/v1/projects/${p}/sessions/${run}/turns`, { text }), 202, 'POST …/turns');
      await waitFor(async () => {
        await tick(fx.engine, p);
        const r = await ok(fx.engine.get(`/v1/projects/${p}/sessions/${run}`), 200, 'GET …/sessions/:r');
        const t = (r.turns ?? []).find((x) => x.turn === posted.turn);
        return t && ['settled', 'failed', 'unknown'].includes(t.state) ? t : undefined;
      }, { what: `turn ${posted.turn} to settle` });
    }
    const read = await iterationRead(fx, p, S.two);
    const session = read.usage.runs.find((r) => r.id === run);
    assert.ok(session, 'the session run is attributed to the open iteration');
    assert.equal(session.kind, 'session');
    assert.equal(session.invocations.length, 2, 'one run, two invocations');
    assert.equal(new Set(session.invocations.map((i) => i.id)).size, 2, 'each invocation distinguishable');
    assert.equal(new Set(session.invocations.map((i) => i.turn)).size, 2, 'each its own turn');
    assert.equal(receiptsOfRun(fx.home, run).length, 2, 'two invocation receipts of the run in the store');
    assert.ok(session.invocations.every((i) => i.usage.state === 'complete' && i.usage.billable_in === 400 && i.usage.cached_in === 100 && i.usage.out === 80), JSON.stringify(session.invocations.map((i) => i.usage)));
    assert.equal(read.usage.totals.agent_runs, read.usage.runs.length, 'the session is one agent run');
    assert.equal(read.usage.totals.invocations, read.usage.runs.reduce((n, r) => n + r.invocations.length, 0), 'its two invocations counted');
    assertAccounted(read, 'a session of two turns');
    await ok(fx.engine.post(`/v1/projects/${p}/sessions/${run}/close`, { refuse: true }), 200, 'the session closed');
    assert.equal((await currentIt(fx, p)).id, S.two);
  });
});
