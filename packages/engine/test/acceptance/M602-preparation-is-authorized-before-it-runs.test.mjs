// M602, preparation is authorized before it runs (the owner's draft M7 plan
// §3, row M602; request §3 last paragraph; rulings R5, S1 of 2026-10-28;
// SEAM.md §575). Kernel lane, the scripted provider (unpaid).
//
//   (a) the prototype_preparation_approval raised at creation: the role, the
//       model, the effective per-run allowance (S5), the estimated cost
//       labelled an estimate (the scripted provider: "unpaid"), the
//       own-subtotal note, "exactly one run"; no run before the answer.
//   (b) approve: exactly one brief_preparation work item, dispatched,
//       attributed to the iteration, counted under totals.preparation.
//   (c) reject: status preparing, the next step naming approval or discard,
//       nothing run.
//   (d) …/prepare after a failed preparation: a new approval; 409 while one
//       is open.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { tick } from './harness/runs.mjs';
import {
  PROTO,
  currentIt,
  decisionRead,
  decisionsOfProject,
  eventsFor,
  idle,
  iterationRead,
  iterationRow,
  newApp,
  ok,
  openDecisionsRead,
  answer,
  protoEngine,
  pump,
  receiptsOfRun,
  runsOfIteration,
  runsOfProjectRows,
  usage,
  workOfProject,
} from './harness/prototype.mjs';

describe('M602 preparation is authorized before it runs', () => {
  const shared = sharedFixture();
  const S = {};
  before(async () => {
    S.fx = await protoEngine(shared.context);
  });
  after(() => shared.cleanup());

  test('(a) the question raised at creation names the role, the model, the effective per-run allowance, the cost as an estimate (scripted: unpaid), the own subtotal and exactly one run; no run before the answer', async () => {
    const { fx } = S;
    const { id } = await newApp(fx, { name: 'Tasks a' });
    S.a = id;
    const it = await currentIt(fx, id);
    const open = await openDecisionsRead(fx, id);
    assert.deepEqual(open.map((d) => [d.kind, d.subject_id]), [[PROTO.preparation.decision, it.id]], 'one question, about the iteration');
    const d = await decisionRead(fx, id, open[0].id);
    const m = d.dependency_manifest;
    assert.deepEqual([m.iteration, m.iteration_seq, m.iteration_status, m.role, m.provider, m.resolution], [it.id, 1, 'preparing', PROTO.preparation.role, 'scripted', 'scripted'], 'the iteration, the role and the provider it binds');
    assert.equal(typeof m.model, 'string');
    assert.ok(m.model.length > 0, 'the model is named');
    // S5: the run's effective allowance, the per-run limit (5,000,000) capped at what the iteration has left (1,500,000).
    assert.equal(m.run_token_limit, 1_500_000, 'the effective per-run allowance');
    assert.deepEqual([m.paid, m.estimated_usd], [false, null], 'the scripted provider is unpaid: no estimate is a number, none is 0');
    assert.match(m.estimate_basis, /^scripted provider: unpaid/, 'the basis says so');
    assert.equal(m.authorizes, PROTO.preparation.authorizes);
    assert.match(d.question, /Spec Writer \(role spec_writer\) on scripted model /, 'the question names the role and the model');
    assert.match(d.question, /Its effective token limit is 1500000 billable tokens: the per-run limit of 5000000, capped at what the iteration has left of its token allowance/, 'the effective allowance, said as such');
    assert.match(d.question, /The scripted provider is unpaid: no paid work follows/, 'the cost: unpaid');
    assert.match(d.question, /counted in the prototype's totals as its own subtotal \(brief preparation\)/, 'the own subtotal');
    assert.match(d.question, /Approving authorizes exactly one preparation run; it approves neither the brief nor the build/, 'exactly one run, nothing more');
    assert.deepEqual(d.options.map((o) => o.key), ['approve', 'reject']);
    await tick(fx.engine, id);
    assert.deepEqual(runsOfProjectRows(fx.home, id), [], 'no run before the answer');
    assert.deepEqual(workOfProject(fx.home, id), [], 'no work item before the answer');
    S.aQuestion = d;
  });

  test('(b) approve: exactly one brief_preparation work item, dispatched, attributed to the iteration, counted under totals.preparation', async () => {
    const { fx } = S;
    const id = S.a;
    const it = await currentIt(fx, id);
    await ok(answer(fx, id, S.aQuestion), 200, 'the owner approves');
    const items = workOfProject(fx.home, id);
    assert.deepEqual(items.map((w) => [w.kind, w.status]), [[PROTO.preparation.work_kind, 'eligible']], 'exactly one brief_preparation work item');
    assert.equal(JSON.parse(items[0].subject).decision, S.aQuestion.id, 'it names the approval it came from');
    assert.equal(eventsFor(fx.home, 'prototype.preparation_authorized', 'iteration', it.id).length, 1);
    await pump(fx, id, async () => ((await iterationRead(fx, id, it.id)).iteration.status === 'awaiting_brief_approval' ? true : undefined), { what: 'the brief' });
    const runs = runsOfIteration(fx.home, it.id);
    assert.deepEqual(runs.map((r) => [r.work_kind, r.role, r.outcome, r.iteration]), [[PROTO.preparation.work_kind, PROTO.preparation.role, 'completed', it.id]], 'one run, the preparation, attributed to the iteration in the store');
    assert.deepEqual(runsOfProjectRows(fx.home, id).map((r) => r.id), runs.map((r) => r.id), 'and no other run of the project');
    assert.deepEqual(workOfProject(fx.home, id).map((w) => w.kind), [PROTO.preparation.work_kind], 'and no other work item');
    const [receipt] = receiptsOfRun(fx.home, runs[0].id);
    assert.deepEqual(
      [receipt.budget_snapshot.prototype_allowance?.iteration, receipt.budget_snapshot.prototype_allowance?.effective_limit_tokens, receipt.budget_snapshot.prototype_allowance?.limited_by],
      [it.id, 1_500_000, 'iteration'],
      'its receipt fixes the effective allowance it was dispatched with',
    );
    const read = await iterationRead(fx, id, it.id);
    assert.deepEqual(read.usage.runs.map((r) => [r.id, r.work_kind]), [[runs[0].id, PROTO.preparation.work_kind]], 'the iteration read serves the one run');
    assert.deepEqual(read.usage.totals.preparation, { runs: 1, tokens: 1200 + 300 + 400, usd: read.usage.totals.preparation.usd }, 'the preparation subtotal: one run, 1,900 tokens');
    assert.notEqual(read.usage.totals.preparation.usd, undefined);
    assert.equal(read.owner_approvals.by_kind[PROTO.preparation.decision], 1, 'the approval counted once');
  });

  test('(c) reject: status preparing, the next step naming approval or discard, nothing run', async () => {
    const { fx } = S;
    const { id } = await newApp(fx, { name: 'Tasks c' });
    const it = await currentIt(fx, id);
    const d = (await openDecisionsRead(fx, id))[0];
    await ok(answer(fx, id, d, 'reject'), 200, 'the owner rejects');
    await tick(fx.engine, id);
    await tick(fx.engine, id);
    const read = await iterationRead(fx, id, it.id);
    assert.equal(read.iteration.status, 'preparing');
    assert.equal(read.outcome.next_step, 'approve preparation or discard', 'the next step names approval or discard');
    assert.equal(eventsFor(fx.home, 'prototype.preparation_declined', 'iteration', it.id).length, 1);
    assert.deepEqual(workOfProject(fx.home, id), [], 'no work item');
    assert.deepEqual(runsOfProjectRows(fx.home, id), [], 'nothing run');
    assert.equal((await decisionRead(fx, id, d.id)).status, 'consumed');
    // The next step works: the preparation asked for again.
    const asked = await ok(fx.engine.post(`/v1/projects/${id}/iterations/${it.id}/prepare`, {}), 201, 'POST …/prepare after a rejection');
    assert.equal(asked.decision.kind, PROTO.preparation.decision);
  });

  test('(d) …/prepare after a failed preparation: a new approval; 409 while one is open', async () => {
    const { fx } = S;
    const { id } = await newApp(fx, { name: 'Tasks d' });
    const it = await currentIt(fx, id);
    // The approved preparation fails (its run exits with no result).
    const d = (await openDecisionsRead(fx, id))[0];
    await ok(answer(fx, id, d), 200, 'the owner approves');
    const [item] = workOfProject(fx.home, id);
    fx.scripted.script(item.id, [{ steps: [usage(400, 0, 100), { exit: 3 }] }]);
    await tick(fx.engine, id);
    await idle(fx, id);
    await tick(fx.engine, id);
    await idle(fx, id);
    const failed = await iterationRead(fx, id, it.id);
    const runs = runsOfIteration(fx.home, it.id);
    assert.equal(runs.length, 1, 'one preparation run, never repaired');
    assert.notEqual(runs[0].outcome, 'completed');
    assert.deepEqual([failed.iteration.status, failed.outcome.next_step], ['preparing', 'prepare again or discard'], 'preparing, its next step to prepare again');
    assert.ok((failed.outcome.reason ?? '').includes(`the brief preparation run ${runs[0].id} ended`), `the reason names the run (${failed.outcome.reason})`);
    assert.equal(workOfProject(fx.home, id)[0].status, 'cancelled', 'its work cancelled');
    assert.equal(eventsFor(fx.home, 'prototype.preparation_failed', 'iteration', it.id).length, 1);
    // A new approval, and 409 while it is open.
    const asked = await ok(fx.engine.post(`/v1/projects/${id}/iterations/${it.id}/prepare`, {}), 201, 'POST …/prepare after the failure');
    assert.equal(asked.decision.kind, PROTO.preparation.decision);
    assert.notEqual(asked.decision.id, d.id, 'a new question');
    assert.equal(iterationRow(fx.home, it.id).next_step, 'approve preparation or discard');
    // While that approval is open, another is refused (409), and no second question is raised.
    const again = await fx.engine.post(`/v1/projects/${id}/iterations/${it.id}/prepare`, {});
    assert.deepEqual((await openDecisionsRead(fx, id)).filter((x) => x.kind === PROTO.preparation.decision).map((x) => x.id), [asked.decision.id], 'one question open');
    assert.equal(runsOfIteration(fx.home, it.id).length, 1, 'nothing more was run');
    assert.equal(again.status, 409, `…/prepare while a preparation approval is open (→ ${again.status} ${again.text})`);
  });
});
