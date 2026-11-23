// M610, Iterate and the second Alpha (the owner's draft M7 plan §3, row
// M610; request §9; rulings R7, R8, S4 of 2026-10-28; validation gap 3;
// SEAM.md §575). Kernel lane, the scripted deployment adapter.
//
//   (a) …/iterate with change text on an ended iteration: seq + 1 with its
//       predecessor, the limits snapshotted, the predecessor untouched (its
//       historical outcome, status and reason; its next_step, current
//       guidance, no longer open_alpha once its Alpha was torn down:
//       objection 224, the owner's ruling of 2026-10-29). On a
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
//   (e) iteration 1 ended limit_reached with its phase plan still published
//       and active and a stage integrated (objection 230; the owner accepted
//       the plan-closure design on 2026-11-23): …/iterate closes that plan
//       (the response and prototype.iteration_iterated name it in
//       closed_plans; the plan replaced and inactive with
//       replacement.closed_by 'iterated'; its integrated stage keeps its
//       status with cancelled_at set, its unbuilt one cancelled), and
//       iteration 2's approved brief leads to its own first plan published
//       policy_authorized and on to its own Alpha; iteration 1's receipt,
//       runs, ledger rows and outcome unchanged.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { armBarrier, operationsOf, releaseBarrier, teardown, tickToBarrier } from './harness/deploy/kernel.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { withStore } from './harness/store.mjs';
import {
  CHECK_FILES,
  CHECK_FILE_R4,
  CHECK_KINDS,
  REQ4,
  REQS,
  authoringScript,
  builderOwn,
  deploymentRequestsOf,
  json,
  modelBrief,
  prepScript,
  specText,
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

// (e)'s products. Iteration 1 builds stage 1 and fails stage 2 past its one
// allowed repair (limit_reached with the plan open). Iteration 2's brief
// adds the open count to the same single phase (phase 1 is not complete, so
// its first plan is phase 1 again): spec version 2, roadmap version 2, one
// stage implementing every requirement of the brief.
const failing = () => ({ steps: [usage(300, 0, 100), { exit: 3 }] });
const REQS_E = Object.freeze([...REQS, { ...REQ4, phase: 1 }]);
const KEYS_E = REQS_E.map((r) => r.key);
const ROADMAP_E = { version: 2, architecture_version: 1, phases: [{ number: 1, goal: 'the task list and its open count, end to end', modules: ['app'], requirement_ids: KEYS_E, depends_on: [] }] };
const STAGES_E = [{ number: 1, goal: 'the task list and its open count', tasks: ['the task list and its open count'], modules: ['app'], implements: KEYS_E, adrs: [], depends_on: [], validation: { criteria: KEYS_E.map((k) => `${k}.1`), kinds: ['acceptance', 'smoke'], sensitive_areas: [] }, integration_obligations: [] }];
const continuingPlanScript = () => ({
  steps: [
    usage(1800, 0, 700),
    write('.surety/roadmap/roadmap.json', json(ROADMAP_E)),
    write('.surety/roadmap/roadmap.md', '# Roadmap\n\n1. The task list and its open count, end to end (R1, R2, R3, R4).\n'),
    { write: { path: '.surety/phases/phase-1.json', content: json({ phase: 1, prepared_against: { spec_version: 2, architecture_version: 1, roadmap_version: 2, revision: '__HEAD__' }, stages: STAGES_E, conformance: 'within_baseline' }), substitute_head: true } },
    write('.surety/phases/phase-1.md', '# Phase 1\n\n- Stage 1: the task list and its open count\n'),
    result({ summary: "iteration 2's first plan: phase 1 again", plan: 'phase-1', conformance: 'within_baseline' }),
  ],
});
const ledgerOfIteration = (home, it) => withStore(home, (db) => db.prepare('SELECT l.* FROM "ledger_rows" l JOIN "runs" r ON r."id" = l."run" WHERE r."iteration" = ? ORDER BY l.rowid').all(it));
const plansOf = (home, p) => withStore(home, (db) => db.prepare('SELECT * FROM "phase_plans" WHERE "project" = ? ORDER BY rowid').all(p));
const stagesOf = (home, plan) => withStore(home, (db) => db.prepare('SELECT * FROM "stages" WHERE "phase_plan" = ? ORDER BY "number"').all(plan));
// The receipt as its owner keeps it: what is served now (the envelope), the
// app's sum across iterations and the current controls set apart.
const receiptKept = async (fx, p, it) => {
  const res = await fx.engine.get(`/v1/projects/${p}/iterations/${it}/receipt.json`);
  assert.equal(res.status, 200, `GET …/receipt.json (→ ${res.status} ${res.text.slice(0, 400)})`);
  const r = JSON.parse(res.text);
  for (const k of ['generated_at', 'served_at', 'snapshot_seq', 'app_totals', 'controls']) delete r[k];
  return r;
};

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
    for (const k of ['usage', 'owner_approvals', 'plan', 'brief', 'limitations']) assert.deepEqual(after1[k], S.oneRead[k], `the predecessor's ${k} untouched`);
    // Objection 224 (the owner's ruling of 2026-10-29; the plan's M611 (e)):
    // the outcome's status and reason are history and untouched; next_step
    // is current guidance, and after the finalized teardown it no longer
    // offers to open an Alpha that is not deployed (SEAM.md §579).
    assert.equal(S.oneRead.outcome.next_step, 'open_alpha', 'before the teardown: open the Alpha');
    assert.deepEqual([after1.outcome.status, after1.outcome.reason], [S.oneRead.outcome.status, S.oneRead.outcome.reason], "the predecessor's historical outcome untouched");
    assert.deepEqual(Object.keys(after1.outcome).sort(), Object.keys(S.oneRead.outcome).sort(), 'the outcome keeps its members');
    assert.equal(after1.alpha.current_state, 'torn_down', `its Alpha is not currently available: torn down (${after1.alpha.current_reason})`);
    assert.equal(after1.alpha.current, null, 'no current Alpha claimed');
    assert.notEqual(after1.outcome.next_step, 'open_alpha', 'next_step no longer offers to open the Alpha');
    assert.equal(after1.outcome.next_step, PROTO.next_steps.alpha_gone, "next_step: the engine's guidance that the Alpha is no longer deployed");
    assert.equal(after1.iteration.next_step, after1.outcome.next_step, 'the iteration read serves the same guidance');
    assert.equal(list.find((i) => i.seq === 1).next_step, after1.outcome.next_step, 'and the list');
    // The recorded outcome beside current guidance (the plan's M611 (e); the
    // owner's ruling of 2026-10-29: "next_step means current guidance.
    // Historical outcomes remain preserved separately."; SEAM.md §582).
    const rec = after1.outcome.recorded;
    assert.deepEqual([rec?.status, rec?.reason, rec?.next_step], ['alpha_ready', 'alpha_complete', 'open_alpha'], `outcome.recorded keeps the stored outcome as written (${JSON.stringify(rec)})`);
    assert.match(rec.recorded_at ?? '', /^\d{4}-\d{2}-\d{2}T/, 'when it was written');
    assert.deepEqual(rec, S.oneRead.outcome.recorded, 'unchanged by the teardown and the iterate');
    assert.equal(S.oneRead.outcome.recorded.next_step, S.oneRead.outcome.next_step, 'before the teardown, guidance and record agreed');
    assert.ok(typeof after1.outcome.note === 'string' && /current guidance/.test(after1.outcome.note) && /recorded/.test(after1.outcome.note), `outcome.note says which is which (${after1.outcome.note})`);
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

  test("(e) iteration 1 ended limit_reached with its phase plan open and a stage integrated: …/iterate closes that plan, and iteration 2's approved brief leads to its own first plan published policy_authorized and its own Alpha; iteration 1's receipt, runs, ledger rows and outcome unchanged", async () => {
    const { fx } = S;
    // Iteration 1: stage 1 built and integrated; stage 2 fails, and so does
    // its one allowed repair; the next repair is refused: limit_reached.
    const { id: q, it } = await toBrief(fx, { name: 'Tasks open plan', policy: { prototype_repairs_per_stage: 1 } });
    const one = it.id;
    kindNext(fx, 'stage_build', [builderScript(1), failing(), failing()], builderScript(1));
    await answerOpen(fx, q, 'spec_approval');
    await alphaReady(fx, q, { port: 18086 });
    await pump(fx, q, statusIs(fx, q, one, 'limit_reached'), { answer: CHECK_KINDS, max: 100, what: 'iteration 1 limit_reached on the repairs of stage 2' });
    await idle(fx, q);

    // The state of objection 230: the plan published and active, stage 1 integrated, stage 2 not.
    const open = plansOf(fx.home, q).filter((x) => x.status === 'published' && x.active === 1);
    assert.equal(open.length, 1, `one open plan (${JSON.stringify(plansOf(fx.home, q).map((x) => [x.id, x.status, x.active]))})`);
    const plan1 = open[0];
    assert.deepEqual([plan1.phase_number, plan1.routing, plan1.completed_at], [1, PROTO.routing, null], "iteration 1's phase-1 plan, published under the policy, not completed");
    const [s1, s2] = stagesOf(fx.home, plan1.id);
    assert.deepEqual([s1.status, s1.cancelled_at], ['integrated', null], `stage 1 integrated (${JSON.stringify(s1)})`);
    assert.ok(['planned', 'building'].includes(s2.status) && s2.cancelled_at === null, `stage 2 not built (${s2.status})`);
    const read1 = await iterationRead(fx, q, one);
    assert.equal(read1.iteration.status, 'limit_reached');
    assert.match(read1.outcome.reason, /^repairs_per_stage: /, read1.outcome.reason);
    assert.equal(read1.iteration.alpha_at, null, 'no Alpha in iteration 1');
    assert.deepEqual(deploymentRequestsOf(fx.home, q), [], 'nothing of iteration 1 deployed');
    const runs1 = runsOfIteration(fx.home, one);
    const ledger1 = ledgerOfIteration(fx.home, one);
    assert.ok(runs1.length > 0 && ledger1.length > 0, 'iteration 1 has runs and ledger rows to keep');
    const receipt1 = await receiptKept(fx, q, one);

    // Iterate: the predecessor's open plan closed, and said so.
    const made = await ok(fx.engine.post(iteratePath(q, one), { change: CHANGE }), 201, 'POST …/iterate on a limit_reached iteration with its plan open');
    const two = made.iteration.id;
    assert.deepEqual([made.iteration.seq, made.iteration.status, made.iteration.predecessor], [2, 'preparing', one]);
    const closed = [{ phase_plan: plan1.id, phase: 1, generation: plan1.generation, cancelled: [s2.id], superseded: [s1.id] }];
    assert.deepEqual(made.closed_plans, closed, `the response names the closed plan (${JSON.stringify(made.closed_plans)})`);
    const iterated = eventsFor(fx.home, 'prototype.iteration_iterated', 'iteration', two);
    assert.equal(iterated.length, 1);
    assert.deepEqual(iterated[0].payload.closed_plans, closed, 'and so does prototype.iteration_iterated');
    const closedRow = plansOf(fx.home, q).find((x) => x.id === plan1.id);
    assert.deepEqual([closedRow.status, closedRow.active, closedRow.replaced_by, closedRow.completed_at], ['replaced', 0, null, null], 'the plan replaced and inactive, by no later generation, not completed');
    assert.deepEqual(JSON.parse(closedRow.replacement), { closed_by: 'iterated', iteration: one, successor: two, cancelled: [s2.id], superseded: [s1.id] }, 'its replacement record');
    const [s1After, s2After] = stagesOf(fx.home, plan1.id);
    assert.deepEqual([s1After.status, s1After.integrated_revision], ['integrated', s1.integrated_revision], 'the integrated stage keeps its status and its integration as history');
    assert.match(s1After.cancelled_at ?? '', /^\d{4}-\d{2}-\d{2}T/, 'with cancelled_at set');
    assert.equal(s2After.status, 'cancelled', 'the unbuilt stage cancelled');
    assert.match(s2After.cancelled_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(plansOf(fx.home, q).filter((x) => x.status === 'published' && x.active === 1).length, 0, 'no plan of the project open');

    // Iteration 2: its brief, approved; its own first plan; its own Alpha.
    kindNext(fx, 'brief_preparation', [prepScript({ spec: specText({ version: 2, reqs: REQS_E, changeLog: [{ version: 2, change: 'Show the number of open tasks at the top' }] }), brief: modelBrief({ objectives: REQS_E.map((r) => `${r.key}: ${r.statement}`), included: ['adding, listing and finishing tasks', 'the number of open tasks'] }) })], prepScript());
    kindNext(fx, 'replan', [continuingPlanScript()], firstPlanScript());
    kindNext(fx, 'check_authoring', [authoringScript({ files: { ...CHECK_FILES, ...CHECK_FILE_R4 } })], authoringScript());
    kindNext(fx, 'stage_build', [builderOwn('src/count.mjs', 'export const open = (ts) => ts.filter((t) => !t.done).length;\n')], builderScript(1));
    const since = eventsFor(fx.home, 'prototype.plan_policy_authorized', 'project', q).length;
    await answerOpen(fx, q, PROTO.preparation.decision);
    await pump(fx, q, statusIs(fx, q, two, 'awaiting_brief_approval'), { what: "iteration 2's brief" });
    assert.equal((await iterationRead(fx, q, two)).iteration.brief.version, 2, 'a new specification revision');
    await answerOpen(fx, q, 'spec_approval');
    await pump(fx, q, async () => {
      const refused = eventsFor(fx.home, 'plan.generation_refused', 'project', q);
      if (refused.length > 0) throw new Error(`iteration 2's first plan was refused (objection 230): ${JSON.stringify(refused.map((e) => e.payload))}`);
      const routed = eventsFor(fx.home, 'prototype.plan_routed_to_owner', 'iteration', two);
      if (routed.length > 0) throw new Error(`iteration 2's plan was routed to the owner: ${JSON.stringify(routed[0].payload)}`);
      return (await iterationRead(fx, q, two)).iteration.status === 'alpha_ready' ? true : undefined;
    }, { answer: CHECK_KINDS, max: 100, what: "iteration 2's own Alpha after its predecessor's open plan" });
    const read2 = await iterationRead(fx, q, two);
    assert.deepEqual([read2.plan.routing, read2.plan.approved_by, read2.plan.bundle_status], [PROTO.routing, PROTO.publisher, 'published'], 'its own first plan published policy_authorized');
    const authorized = eventsFor(fx.home, 'prototype.plan_policy_authorized', 'iteration', two);
    assert.equal(authorized.length, 1);
    assert.deepEqual([authorized[0].payload.plan_phase, authorized[0].payload.expected_phase, authorized[0].payload.phases], [1, 1, 1], 'its own single phase: phase 1, not completed by its predecessor');
    assert.ok(authorized[0].payload.stages >= 1 && authorized[0].payload.stages <= PROTO.bounds.max_stages, 'at most two stages');
    assert.equal(eventsFor(fx.home, 'prototype.plan_policy_authorized', 'project', q).length, since + 1);
    const plan2 = plansOf(fx.home, q).find((x) => x.id !== plan1.id && x.bundle === read2.plan.bundle);
    assert.ok(plan2, `iteration 2's plan row (${JSON.stringify(plansOf(fx.home, q).map((x) => [x.id, x.phase_number, x.status, x.bundle]))})`);
    assert.deepEqual([plan2.phase_number, plan2.routing], [1, PROTO.routing]);
    assert.ok(stagesOf(fx.home, plan2.id).every((x) => x.id !== s1.id && x.id !== s2.id), "none of the predecessor's stages kept in it");
    assert.equal(plansOf(fx.home, q).find((x) => x.id === plan1.id).status, 'replaced', "the predecessor's plan stays closed");
    assert.match(read2.alpha.candidate ?? '', /^cand_/, 'its own candidate');
    assert.ok(read2.alpha.deployment_request, 'its own deployment request');
    assert.equal(candidatesOfProject(fx.home, q).find((c) => c.id === read2.alpha.candidate).progress, 'alpha_deployed');
    assert.equal(read2.iteration.status, 'alpha_ready');

    // Iteration 1 as its owner reads it: unchanged.
    const after1 = await iterationRead(fx, q, one);
    assert.deepEqual([after1.iteration.status, after1.outcome.status, after1.outcome.reason, after1.iteration.alpha_at], [read1.iteration.status, read1.outcome.status, read1.outcome.reason, null], "iteration 1's outcome unchanged");
    assert.deepEqual(after1.outcome.recorded, read1.outcome.recorded, 'its recorded outcome unchanged');
    assert.deepEqual(after1.usage, read1.usage, 'its usage unchanged');
    assert.deepEqual(runsOfIteration(fx.home, one), runs1, 'its runs unchanged');
    assert.deepEqual(ledgerOfIteration(fx.home, one), ledger1, 'its ledger rows unchanged');
    assert.deepEqual(await receiptKept(fx, q, one), receipt1, 'its receipt unchanged');
    const ids1 = new Set(runs1.map((r) => r.id));
    assert.ok(read2.usage.runs.length > 0 && read2.usage.runs.every((r) => !ids1.has(r.id)), "no run of iteration 1 in iteration 2's totals");
  });
});
