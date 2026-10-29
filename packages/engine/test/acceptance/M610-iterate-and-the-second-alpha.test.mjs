// M610, Iterate and the second Alpha (the owner's draft M7 plan §3, row
// M610; request §9; rulings R7, R8, S4 of 2026-10-28; validation gap 3;
// SEAM.md §575). Kernel lane, the scripted deployment adapter.
//
//   (a) …/iterate with change text on an ended iteration: seq + 1 with its
//       predecessor, the limits snapshotted, the predecessor untouched. On a
//       running one: 409, and 409 while a one-shot run or a deployment
//       operation of the project is in flight.
//   (b) iteration 2's preparation question: "iteration 2 … continuing from
//       iteration 1", with the change and the brief it starts from.
//   (d) the predecessor's candidate deployed again meanwhile:
//       prototype.alpha_not_attributed, iteration 2 unchanged.
//   (c) iteration 2 reaches its own Alpha: its own single phase (at most two
//       stages) published policy_authorized, its own candidate and
//       deployment, alpha_ready; the predecessor's alpha_at unchanged and
//       counted nowhere in iteration 2's totals.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { armBarrier, operationsOf, releaseBarrier, teardown, tickToBarrier } from './harness/deploy/kernel.mjs';
import { sharedFixture } from './harness/gates.mjs';
import {
  CHECK_KINDS,
  INDEPENDENT_STAGES,
  PROTO,
  answerOpen,
  briefToAlpha,
  builderScript,
  candidatesOfProject,
  decisionRead,
  eventsFor,
  firstPlanScript,
  idle,
  iterationRead,
  iterationsRead,
  kindNext,
  observedCurrent,
  ok,
  openDecisionsRead,
  policyRead,
  protoEngine,
  pump,
  runsOfIteration,
  scriptDeploy,
  scriptTeardown,
  secondIterationScripts,
  statusIs,
  toBrief,
  usage,
  write,
  result,
  SERVER,
  alphaReady,
} from './harness/prototype.mjs';

const CHANGE = 'Show the number of open tasks at the top.';
const iteratePath = (p, it) => `/v1/projects/${p}/iterations/${it}/iterate`;

describe('M610 Iterate and the second Alpha', () => {
  const shared = sharedFixture();
  const S = {};
  before(async () => {
    const fx = await protoEngine(shared.context);
    S.fx = fx;
    const { id: p, it } = await toBrief(fx, { name: 'Tasks iterate' });
    S.p = p;
    S.one = it.id;
    S.env = await briefToAlpha(fx, p, it.id);
    await observedCurrent(fx, p, it.id);
    S.oneRead = await iterationRead(fx, p, it.id);
  });
  after(() => shared.cleanup());

  test('(a) on a running iteration, and while a deployment operation or a one-shot run of the project is in flight: 409; on an ended one: iteration seq + 1 with its predecessor, the limits snapshotted, the predecessor untouched', async () => {
    const { fx, p, one, env } = S;
    // A teardown of the environment in flight (held before its host call): 409.
    await scriptTeardown(fx, env);
    await armBarrier(fx.engine, 'adapter.before_host_call', 'pause');
    const asked = await teardown(fx.engine, p, 'alpha');
    assert.ok(asked.status >= 200 && asked.status < 300, `the owner's teardown (→ ${asked.status} ${asked.text})`);
    await tickToBarrier(fx, p, 'adapter.before_host_call');
    const op = operationsOf(fx.home, p, 'teardown').at(-1);
    const inFlight = await fx.engine.post(iteratePath(p, one), { change: CHANGE });
    await releaseBarrier(fx.engine, 'adapter.before_host_call');
    assert.equal(inFlight.status, 409, `iterate while the teardown is in flight (→ ${inFlight.status} ${inFlight.text})`);
    assert.equal(inFlight.body.subject?.operation, op.id, 'the refusal names the operation');
    assert.equal((await iterationsRead(fx, p)).iterations.length, 1, 'no iteration created');
    await pump(fx, p, () => operationsOf(fx.home, p, 'teardown').find((o) => o.id === op.id && o.finalized_at !== null), { max: 12, what: 'the teardown to finalize' });

    // Ended (alpha_ready): iterated.
    const limits = (await policyRead(fx, p)).effective;
    const made = await ok(fx.engine.post(iteratePath(p, one), { change: CHANGE }), 201, 'POST …/iterate');
    S.two = made.iteration.id;
    assert.deepEqual([made.iteration.seq, made.iteration.status, made.iteration.predecessor, made.iteration.change], [2, 'preparing', one, CHANGE]);
    for (const k of ['prototype_budget_tokens', 'prototype_budget_usd_estimated', 'prototype_runtime_seconds', 'prototype_repairs_per_stage', 'prototype_repairs_per_iteration', 'budget_run_billable_tokens']) assert.equal(made.iteration.limits[k], limits[k], `${k} snapshotted from the policy in force`);
    assert.deepEqual([made.predecessor.id, made.predecessor.seq, made.predecessor.status], [one, 1, 'alpha_ready']);
    assert.equal(eventsFor(fx.home, 'prototype.iteration_iterated', 'iteration', S.two).length, 1);
    const list = (await iterationsRead(fx, p)).iterations;
    assert.deepEqual(list.map((i) => [i.seq, i.status, i.predecessor, i.change]), [[1, 'alpha_ready', null, null], [2, 'preparing', one, CHANGE]]);
    const after1 = await iterationRead(fx, p, one);
    for (const k of ['usage', 'owner_approvals', 'plan', 'brief', 'limitations', 'outcome']) assert.deepEqual(after1[k], S.oneRead[k], `the predecessor's ${k} untouched`);
    assert.deepEqual([after1.iteration.status, after1.iteration.alpha_at, after1.alpha.candidate, after1.alpha.deployment_request], [S.oneRead.iteration.status, S.oneRead.iteration.alpha_at, S.oneRead.alpha.candidate, S.oneRead.alpha.deployment_request]);

    // Running: iteration 2 has not ended; iteration 1 is no longer the current one.
    const running = await fx.engine.post(iteratePath(p, S.two), { change: 'again' });
    assert.equal(running.status, 409, `iterate on a running iteration (→ ${running.status} ${running.text})`);
    assert.equal((await fx.engine.post(iteratePath(p, one), { change: CHANGE })).status, 409, 'nor on one no longer current');
    assert.equal((await fx.engine.post(iteratePath(p, one), { change: '' })).status, 400, 'an empty change is refused');
  });

  test('(a) an ended iteration with a one-shot run of the project still under way: 409 naming the run', async () => {
    const { fx } = S;
    // Two independent stages both dispatched (a per-run limit below what is
    // left); one fails with no repair allowed, so the iteration fails, while
    // the other still runs.
    const { id: q, it } = await toBrief(fx, { name: 'Tasks busy', policy: { repair_attempts_max: 0, budget_run_billable_tokens: 600_000 } });
    kindNext(fx, 'replan', [firstPlanScript({ stages: INDEPENDENT_STAGES })], firstPlanScript());
    kindNext(fx, 'stage_build', [{ steps: [usage(1000, 0, 200), { hold: 'busy', heartbeat_ms: 250 }, write('server.mjs', SERVER), result()], on_term: 'exit' }, { steps: [usage(300, 0, 100), { exit: 3 }] }], builderScript(1));
    await answerOpen(fx, q, 'spec_approval');
    await alphaReady(fx, q, { port: 18085 });
    const failed = await pump(fx, q, async () => {
      const r = await iterationRead(fx, q, it.id);
      const holding = r.usage.runs.find((x) => x.work_kind === 'stage_build' && x.finished_at === null);
      return r.iteration.status === 'failed' && holding ? { r, holding } : undefined;
    }, { answer: CHECK_KINDS, wait: false, what: 'the iteration failed with a run still under way' });
    const res = await fx.engine.post(iteratePath(q, it.id), { change: CHANGE });
    assert.equal(res.status, 409, `iterate while a one-shot run is under way (→ ${res.status} ${res.text})`);
    assert.deepEqual(res.body.subject?.runs, [failed.holding.id], 'the refusal names the run');
    assert.equal((await iterationsRead(fx, q)).iterations.length, 1, 'no iteration created');
    fx.scripted.release('all', 'busy');
    await idle(fx, q);
    await ok(fx.engine.post(iteratePath(q, it.id), { change: CHANGE }), 201, 'once it has ended, iterated');
  });

  test('(b) iteration 2\'s preparation question: continuing from iteration 1, with the change and the brief it starts from', async () => {
    const { fx, p, one, two } = S;
    const q = (await openDecisionsRead(fx, p)).find((d) => d.kind === PROTO.preparation.decision);
    assert.ok(q && q.subject_id === two, "iteration 2's preparation is asked for");
    assert.match(q.question, /This is iteration 2 of the app, continuing from iteration 1/);
    assert.ok(q.question.includes(`the change you asked for is "${CHANGE}"`), 'with the change');
    assert.match(q.question, /the preparation starts from the brief approved in iteration 1/, 'and the brief it starts from');
    const m = (await decisionRead(fx, p, q.id)).dependency_manifest;
    assert.deepEqual([m.continues?.iteration, m.continues?.seq, m.continues?.previous_brief_iteration_seq, m.continues?.previous_brief_spec_revision, m.change], [one, 1, 1, S.oneRead.iteration.brief.spec_revision, CHANGE], 'its manifest binds what it continues and the change');
  });

  test('(d) the predecessor\'s candidate deployed again meanwhile: prototype.alpha_not_attributed, iteration 2 unchanged', async () => {
    const { fx, p, two, env } = S;
    const before2 = await iterationRead(fx, p, two);
    await scriptDeploy(fx, env);
    const req = await fx.engine.post(`/v1/projects/${p}/deployments`, { candidate: S.oneRead.alpha.candidate, environment: 'alpha' });
    assert.ok([200, 201, 202].includes(req.status), `the predecessor's candidate requested again (→ ${req.status} ${req.text})`);
    const refused = await pump(fx, p, () => eventsFor(fx.home, 'prototype.alpha_not_attributed', 'iteration', two)[0], { what: 'the stale deployment to complete' });
    assert.equal(refused.payload.candidate, S.oneRead.alpha.candidate);
    assert.match(refused.payload.reason, /iteration 1's Alpha, not iteration 2's/);
    const read2 = await iterationRead(fx, p, two);
    assert.deepEqual([read2.iteration.status, read2.alpha.candidate, read2.alpha.deployment_request, read2.alpha.current, read2.iteration.alpha_at], [before2.iteration.status, null, null, null, null], 'iteration 2 unchanged: not Alpha-ready on its predecessor\'s deployment');
    assert.deepEqual(read2.usage, before2.usage, "nothing of it counted in iteration 2's totals");
    const read1 = await iterationRead(fx, p, S.one);
    assert.deepEqual([read1.iteration.status, read1.iteration.alpha_at, read1.alpha.deployment_request], [S.oneRead.iteration.status, S.oneRead.iteration.alpha_at, S.oneRead.alpha.deployment_request], "iteration 1's history unchanged");
  });

  test('(c) iteration 2 reaches its own Alpha: its own single phase published policy_authorized, its own candidate and deployment, alpha_ready; the predecessor counted nowhere in it', async () => {
    const { fx, p, one, two, env } = S;
    secondIterationScripts(fx);
    await scriptDeploy(fx, env);
    const since = eventsFor(fx.home, 'prototype.plan_policy_authorized', 'project', p).length;
    await answerOpen(fx, p, PROTO.preparation.decision);
    await pump(fx, p, statusIs(fx, p, two, 'awaiting_brief_approval'), { what: "iteration 2's brief" });
    const briefRead = await iterationRead(fx, p, two);
    assert.deepEqual([briefRead.iteration.brief.version, briefRead.brief.objectives.length], [2, 4], 'a new specification revision, its four objectives');
    await answerOpen(fx, p, 'spec_approval');
    await pump(fx, p, async () => {
      const routed = eventsFor(fx.home, 'prototype.plan_routed_to_owner', 'iteration', two);
      if (routed.length > 0) throw new Error(`iteration 2's plan was routed to the owner: ${JSON.stringify(routed[0].payload)}`);
      return (await iterationRead(fx, p, two)).iteration.status === 'alpha_ready' ? true : undefined;
    }, { answer: CHECK_KINDS, max: 100, what: "iteration 2's own Alpha" });
    const read2 = await iterationRead(fx, p, two);
    assert.deepEqual([read2.plan.routing, read2.plan.approved_by, read2.plan.bundle_status], [PROTO.routing, PROTO.publisher, 'published']);
    const authorized = eventsFor(fx.home, 'prototype.plan_policy_authorized', 'iteration', two);
    assert.equal(authorized.length, 1);
    assert.deepEqual([authorized[0].payload.plan_phase, authorized[0].payload.expected_phase, authorized[0].payload.phases], [2, 2, 2], 'its own single phase: phase 2, the roadmap\'s last');
    assert.ok(authorized[0].payload.stages >= 1 && authorized[0].payload.stages <= PROTO.bounds.max_stages, 'at most two stages');
    assert.equal(eventsFor(fx.home, 'prototype.plan_policy_authorized', 'project', p).length, since + 1);
    assert.notEqual(read2.plan.bundle, S.oneRead.plan.bundle);
    assert.match(read2.alpha.candidate ?? '', /^cand_/);
    assert.notEqual(read2.alpha.candidate, S.oneRead.alpha.candidate, 'its own candidate');
    assert.ok(read2.alpha.deployment_request && read2.alpha.deployment_request !== S.oneRead.alpha.deployment_request, 'its own deployment request');
    assert.equal(candidatesOfProject(fx.home, p).find((c) => c.id === read2.alpha.candidate).progress, 'alpha_deployed');
    assert.equal(read2.iteration.status, 'alpha_ready');
    const after1 = await iterationRead(fx, p, one);
    assert.equal(after1.iteration.alpha_at, S.oneRead.iteration.alpha_at, "the predecessor's alpha_at unchanged");
    const ids1 = new Set(runsOfIteration(fx.home, one).map((r) => r.id));
    assert.ok(read2.usage.runs.length > 0 && read2.usage.runs.every((r) => !ids1.has(r.id)), "no run of iteration 1 in iteration 2's totals");
    assert.deepEqual(after1.usage, S.oneRead.usage, "iteration 1's usage unchanged");
    assert.equal(read2.app_totals.agent_runs, after1.usage.totals.agent_runs + read2.usage.totals.agent_runs, "the app's totals: both, once");
    assert.deepEqual(Object.keys(read2.owner_approvals.by_kind).sort(), [...PROTO.owner_kinds].sort(), "iteration 2's own three answers");
  });
});
