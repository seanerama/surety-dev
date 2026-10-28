// M608, Stop and a deliberate resume (the owner's draft M7 plan §3, row
// M608; request §5; ruling R4 and the validation gap 4 of 2026-10-28;
// SEAM.md §575). Kernel lane.
//
//   (a) …/stop without and with the preview hash, a run under way: 409
//       confirm_required with the runs listed and their fates; confirmed,
//       each run stopped (human_stop) keeping its charge and its unknown
//       allowance, the project paused, the iteration stopped.
//   (b) with nothing running: paused and stopped.
//   (c) a limit raised while stopped: the iteration stays stopped (the
//       submission and the event say why); nothing dispatched.
//   (d) …/resume, the deliberate action: the project resumed, the work the
//       Stop held resumed, the iteration back to building or awaiting_owner
//       by the next tick; controls.resume served.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { tick } from './harness/runs.mjs';
import {
  CHECK_KINDS,
  PROTO,
  alphaReady,
  answerOpen,
  builderScript,
  confirmed,
  decisionRead,
  eventsFor,
  holdingBuilder,
  idle,
  iterationRead,
  kindNext,
  ledgerOfInvocation,
  limitsCommitted,
  ok,
  ownerPolicy,
  projectRead,
  protoEngine,
  pump,
  runsOfIteration,
  statusIs,
  toBrief,
  workOfProject,
} from './harness/prototype.mjs';

describe('M608 Stop and a deliberate resume', () => {
  const shared = sharedFixture();
  const S = {};
  before(async () => {
    S.fx = await protoEngine(shared.context);
  });
  after(() => shared.cleanup());

  test('(a) …/stop with a run under way: 409 confirm_required listing the runs and their fates; confirmed, the run stopped keeping its charge and allowance, the project paused, the iteration stopped', async () => {
    const { fx } = S;
    const { id: p, it } = await toBrief(fx, { name: 'Tasks stop' });
    kindNext(fx, 'stage_build', [holdingBuilder('stop'), builderScript(1), builderScript(2)], builderScript(1));
    await answerOpen(fx, p, 'spec_approval');
    await alphaReady(fx, p);
    const under = await pump(fx, p, async () => {
      const r = await iterationRead(fx, p, it.id);
      const run = r.usage.runs.find((x) => x.work_kind === 'stage_build' && x.finished_at === null);
      return run && run.invocations[0]?.usage.billable_in === 1000 ? run : undefined;
    }, { answer: CHECK_KINDS, wait: false, what: 'a stage build under way' });
    S.a = { p, it: it.id, run: under.id, item: under.work_item };
    const path = `/v1/projects/${p}/iterations/${it.id}/stop`;
    const ask = await fx.engine.post(path, {});
    assert.equal(ask.status, 409, `without the preview hash: confirm_required (→ ${ask.status} ${ask.text})`);
    assert.equal(ask.body.code, 'confirm_required');
    const d = await decisionRead(fx, p, ask.body.subject.decision);
    const m = d.dependency_manifest;
    assert.deepEqual([m.iteration, m.action, m.project_paused, m.outcome?.status, m.outcome?.next_step], [it.id, 'stop', true, 'stopped', PROTO.next_steps.stop], 'the preview binds the action and its outcome');
    assert.deepEqual(m.runs.map((r) => [r.run, r.stoppable]), [[under.id, true]], 'the run under way listed');
    assert.match(m.runs[0].fate, /^stopped by its stop protocol \(human_stop\); what it observed is kept, its usage is charged with its unknown allowance/, 'with its fate');
    assert.equal(runsOfIteration(fx.home, it.id).find((r) => r.id === under.id).state === 'ended', false, 'nothing is stopped before the confirmation');
    assert.equal((await projectRead(fx, p)).paused, false);
    const done = await ok(fx.engine.post(path, { preview_hash: ask.body.subject.preview_hash }), 200, 'confirmed with the preview hash');
    assert.ok(done, 'the stop answered');
    await idle(fx, p);
    const run = runsOfIteration(fx.home, it.id).find((r) => r.id === under.id);
    assert.deepEqual([run.state, run.reason_class], ['ended', 'human_stop'], `the run stopped by the owner (${run.outcome}, ${run.reason_class})`);
    const read = await iterationRead(fx, p, it.id);
    const inv = read.usage.runs.find((r) => r.id === under.id).invocations[0];
    assert.deepEqual([inv.usage.billable_in, inv.usage.out], [1000, 200], 'its charge kept: what it observed');
    assert.equal(inv.unknown_allowance_tokens, inv.effective_limit_tokens - 1200, 'plus its unknown allowance');
    assert.equal(ledgerOfInvocation(fx.home, inv.id).filter((r) => r.corrects === null).length, 1, 'charged once');
    assert.deepEqual([read.iteration.status, read.outcome.next_step], ['stopped', PROTO.next_steps.stop]);
    assert.equal((await projectRead(fx, p)).paused, true, 'the project paused');
    assert.equal(eventsFor(fx.home, 'prototype.iteration_stopped', 'iteration', it.id).length, 1);
    assert.ok(read.controls.resume, 'controls.resume is served');
    // The stopped run's allowance was all the iteration had left: a resume now would meet the limit, and is refused.
    assert.equal(read.controls.resume.available, false);
    assert.match(read.controls.resume.reason, /raise the limit, then resume$/, read.controls.resume.reason);
    const early = await fx.engine.post(`/v1/projects/${p}/iterations/${it.id}/resume`, {});
    assert.equal(early.status, 409, `resume refused while a limit would refuse the next dispatch (→ ${early.status} ${early.text})`);
    assert.equal((await iterationRead(fx, p, it.id)).iteration.status, 'stopped');
  });

  test('(b) …/stop with nothing running: paused and stopped', async () => {
    const { fx } = S;
    const { id: p, it } = await toBrief(fx, { name: 'Tasks idle stop' });
    const path = `/v1/projects/${p}/iterations/${it.id}/stop`;
    const ask = await fx.engine.post(path, {});
    assert.equal(ask.status, 409);
    assert.deepEqual((await decisionRead(fx, p, ask.body.subject.decision)).dependency_manifest.runs, [], 'no run to stop');
    await ok(fx.engine.post(path, { preview_hash: ask.body.subject.preview_hash }), 200, 'Stop confirmed');
    const read = await iterationRead(fx, p, it.id);
    assert.deepEqual([read.iteration.status, read.outcome.next_step, (await projectRead(fx, p)).paused], ['stopped', PROTO.next_steps.stop, true]);
    const runs = runsOfIteration(fx.home, it.id).length;
    await tick(fx.engine, p);
    assert.equal(runsOfIteration(fx.home, it.id).length, runs, 'nothing dispatched');
  });

  test('(c) a limit raised while stopped: the iteration stays stopped, the submission and the event say why; nothing dispatched', async () => {
    const { fx } = S;
    const { p, it } = S.a;
    const runs = runsOfIteration(fx.home, it).length;
    const raised = await ownerPolicy(fx, p, { prototype_budget_tokens: 3_000_000 }, 'the raised allowance');
    assert.equal(raised.prototype?.reopens, false, `the submission says it does not reopen (${JSON.stringify(raised.prototype)})`);
    assert.equal(raised.prototype?.reason, `iteration 1 was stopped by the owner: raising a limit does not undo a Stop; resume it deliberately (POST /v1/projects/${p}/iterations/${it}/resume)`);
    await limitsCommitted(fx, p, it, 'prototype_budget_tokens', 3_000_000);
    await tick(fx.engine, p);
    await tick(fx.engine, p);
    const read = await iterationRead(fx, p, it);
    assert.deepEqual([read.iteration.status, (await projectRead(fx, p)).paused], ['stopped', true], 'stays stopped, and paused');
    const changed = eventsFor(fx.home, 'prototype.iteration_limits_changed', 'iteration', it).at(-1);
    assert.deepEqual([changed.payload.reopened, changed.payload.status], [false, 'stopped']);
    assert.match(changed.payload.not_reopened_because, /raising a limit does not undo a Stop/);
    assert.equal(runsOfIteration(fx.home, it).length, runs, 'nothing dispatched');
    assert.equal(workOfProject(fx.home, p).find((w) => w.id === S.a.item).status, 'held', 'the work the Stop held stays held');
  });

  test('(d) …/resume is the deliberate action: the project resumed, the held work resumed, the iteration building or awaiting_owner by the next tick; controls.resume served', async () => {
    const { fx } = S;
    const { p, it } = S.a;
    const before = await iterationRead(fx, p, it);
    assert.equal(before.controls.resume.available, true, before.controls.resume.reason);
    assert.equal((await fx.engine.post(`/v1/projects/${p}/iterations/${it}/resume`, { note: 'x' })).status, 400, 'the route takes no field');
    const resumed = await ok(fx.engine.post(`/v1/projects/${p}/iterations/${it}/resume`, {}), 200, 'POST …/resume');
    assert.deepEqual([resumed.iteration.status, resumed.project_unpaused], ['building', true]);
    assert.deepEqual(resumed.resumed_work, [S.a.item], 'the work the Stop held is resumed with it');
    assert.equal((await projectRead(fx, p)).paused, false, 'the project resumed');
    const ev = eventsFor(fx.home, 'prototype.iteration_resumed', 'iteration', it);
    assert.equal(ev.length, 1);
    assert.deepEqual([ev[0].payload.from, ev[0].payload.to, ev[0].payload.project_unpaused], ['stopped', 'building', true]);
    await tick(fx.engine, p);
    const read = await iterationRead(fx, p, it);
    assert.ok(['building', 'awaiting_owner'].includes(read.iteration.status), `building or awaiting_owner after the next tick (${read.iteration.status})`);
    assert.equal(read.controls.resume.available, false, 'resumed once: not offered again');
    assert.equal((await fx.engine.post(`/v1/projects/${p}/iterations/${it}/resume`, {})).status, 409, 'a second resume is refused');
    await pump(fx, p, statusIs(fx, p, it, 'alpha_ready'), { answer: CHECK_KINDS, max: 100, what: 'the resumed iteration to reach alpha_ready' });
    assert.ok(runsOfIteration(fx.home, it).filter((r) => r.work_item === S.a.item).length >= 2, 'the held work was dispatched again after the resume');
  });
});
