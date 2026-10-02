// M56, dedupe, consumption and combined plans (slice 5). Plan §3.5 M56; D1
// §§10.2 to 10.5, D1-03, D1-15, D1-27; RN §3 B12; E9 (P9: never the same
// question twice); SEAM.md §§76, 81.
//
// A question has one identity: asked again with its content in another
// order, or after a restart, it is the same decision with the same preview.
// Questions about different subjects are different decisions. A decision
// is consumed at most once: one approval, one effect intent, one effect,
// and no role is launched by the consumption; a repeated answer, such as a
// client sends when it lost the response, is told the decision is consumed.
// A batch of answers whose plans are compatible is consumed whole; a batch
// whose plans conflict consumes none. The terminal codes differ: consumed,
// invalidated.
//
// With it, row M61's store failure in a decision's transaction: nothing is
// consumed, and the answer can be given again.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { armFault, waitFor } from './harness/engine.mjs';
import { CODES, INTENT_BARRIER, answer, approvalsOf, confirmRequired, consume, decision, decisionsOfKind, intentsOf, openDecision, untilKilled } from './harness/decisions.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { armBarrier, changePolicy, getPolicy, policyRevisions } from './harness/journal.mjs';
import { addWork, scriptedEngine, tickUntil, workItem } from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';

const policyPath = (project) => `/v1/projects/${project.id}/policy`;

async function projectFor(t) {
  const fx = await scriptedEngine(t);
  return { fx, project: await addGitProject(fx) };
}

// Two items parked at their repair limit, each with its own blocker.
async function twoBlockers(t) {
  const { fx, project } = await projectFor(t);
  await changePolicy(fx.engine, project.id, { repair_attempts_max: 0 });
  const items = [await addWork(fx.engine, project.id, 'review'), await addWork(fx.engine, project.id, 'review')];
  for (const item of items) fx.scripted.script(item, [script.crash()]);
  await tickUntil(fx.engine, project.id, () => items.every((item) => workItem(fx.home, item).status === 'parked'), { what: 'both items to be parked' });
  const blockers = [await openDecision(fx, project.id, 'blocker', items[0]), await openDecision(fx, project.id, 'blocker', items[1])];
  return { fx, project, items, blockers };
}

const counts = (fx, project, row) => ({ status: decision(fx.home, row.id).status, approvals: approvalsOf(fx.home, row.id).length, intents: intentsOf(fx.home, row.id).length, revisions: policyRevisions(fx.home, project.id).length });

describe('M56 a question has one identity', () => {
  test('the same question with its content in another order is the same decision with the same preview, before and after a restart', async (t) => {
    const { fx, project } = await projectFor(t);
    const first = await confirmRequired(fx, policyPath(project), { max_chained_roles: 3, budget_run_billable_tokens: 2_000_000 });
    const reordered = { budget_run_billable_tokens: 2_000_000, max_chained_roles: 3 };
    const second = await confirmRequired(fx, policyPath(project), reordered);
    assert.deepEqual([second.id, second.preview_hash], [first.id, first.preview_hash], 'order does not make another question');
    await fx.engine.kill();
    await fx.start();
    const third = await confirmRequired(fx, policyPath(project), reordered);
    assert.deepEqual([third.id, third.preview_hash], [first.id, first.preview_hash], 'nor does a restart');
    assert.equal(decisionsOfKind(fx.home, project.id, 'policy_widening').length, 1);
  });

  test('questions about different subjects are different decisions: answering one leaves the other open, with its preview', async (t) => {
    const { fx, project, items, blockers } = await twoBlockers(t);
    assert.notEqual(blockers[0].id, blockers[1].id);
    await consume(fx, project.id, blockers[0], 'cancel');
    assert.deepEqual([decision(fx.home, blockers[1].id).status, decision(fx.home, blockers[1].id).preview_hash, workItem(fx.home, items[1]).status], ['open', blockers[1].preview_hash, 'parked']);
  });
});

describe('M56 a decision is consumed at most once', () => {
  test('a failed consuming transaction consumes nothing; the answer consumes once, with one approval, one effect and no role launched; the same answer again is refused as consumed', async (t) => {
    const { fx, project } = await projectFor(t);
    const previewed = await confirmRequired(fx, policyPath(project), { max_chained_roles: 2 });

    await armFault(fx.engine, { point: 'before_event', event_type: 'decision.consumed' });
    assertRefused(await answer(fx.engine, project.id, previewed, 'approve'), 500, 'store_error', 'an answer whose transaction fails');
    assert.deepEqual(counts(fx, project, previewed), { status: 'open', approvals: 0, intents: 0, revisions: 0 }, 'nothing of it is left');

    await consume(fx, project.id, previewed, 'approve');
    const repeated = await answer(fx.engine, project.id, previewed, 'approve');
    assertRefused(repeated, 409, CODES.consumed, 'the same answer sent again');
    assert.equal(repeated.body.subject.decision, previewed.id, 'the refusal names the decision, so a client that lost the first response knows it took effect');
    await waitFor(async () => (await getPolicy(fx.engine, project.id)).revision === 1, { what: 'the approved change to be effective' });
    assert.deepEqual(counts(fx, project, previewed), { status: 'consumed', approvals: 1, intents: 1, revisions: 1 }, 'one approval, one effect intent, one effect');
    assert.equal(fx.scripted.launches().length, 0, 'consuming a decision launches no role');
  });

  test('the engine is killed after the consumption and before the effect: the answer is consumed durably, the effect is made once after the restart, and the answer sent again is refused as consumed', async (t) => {
    const { fx, project } = await projectFor(t);
    const previewed = await confirmRequired(fx, policyPath(project), { max_chained_roles: 2 });
    await armBarrier(fx.engine, INTENT_BARRIER, 'kill');
    answer(fx.engine, project.id, previewed, 'approve').catch(() => null);
    await untilKilled(fx, project.id);
    assert.deepEqual(counts(fx, project, previewed), { status: 'consumed', approvals: 1, intents: 1, revisions: 0 }, 'the consumption and its intent are durable; the effect has not been made');

    await fx.start();
    assertRefused(await answer(fx.engine, project.id, previewed, 'approve'), 409, CODES.consumed, 'the answer sent again after the restart');
    await tickUntil(fx.engine, project.id, () => policyRevisions(fx.home, project.id).length === 1 && intentsOf(fx.home, previewed.id)[0].status === 'done', { max: 4, what: 'the consumed effect to be made' });
    assert.deepEqual(counts(fx, project, previewed), { status: 'consumed', approvals: 1, intents: 1, revisions: 1 }, 'made once');
    assert.equal((await getPolicy(fx.engine, project.id)).effective.max_chained_roles, 2);
  });
});

describe('M56 a batch of answers', () => {
  const batch = (fx, project, rows, option) => fx.engine.post(`/v1/projects/${project.id}/decisions/answer-batch`, { answers: rows.map((row) => ({ decision: row.id, option, preview_hash: row.preview_hash })) });

  test('compatible plans are consumed together', async (t) => {
    const { fx, project, items, blockers } = await twoBlockers(t);
    const res = await batch(fx, project, blockers, 'cancel');
    assert.equal(res.status, 200, `a batch of two independent answers (body: ${res.text})`);
    assert.deepEqual(blockers.map((row) => decision(fx.home, row.id).status), ['consumed', 'consumed']);
    assert.deepEqual(items.map((item) => workItem(fx.home, item).status), ['cancelled', 'cancelled']);
  });

  test('conflicting plans consume none; and of two questions the one that was answered is consumed and the one it overtook is invalidated, each with its own code', async (t) => {
    const { fx, project } = await projectFor(t);
    // Two widenings of the same key, previewed against the same base.
    const two = await confirmRequired(fx, policyPath(project), { max_chained_roles: 2 });
    const three = await confirmRequired(fx, policyPath(project), { max_chained_roles: 3 });
    assert.notEqual(two.id, three.id, 'the fixture is live: two different questions');

    assertRefused(await batch(fx, project, [two, three], 'approve'), 409, CODES.batch_conflict, 'a batch whose plans conflict');
    for (const row of [two, three]) assert.deepEqual(counts(fx, project, row), { status: 'open', approvals: 0, intents: 0, revisions: 0 }, 'neither was consumed');

    await consume(fx, project.id, two, 'approve');
    await tickUntil(fx.engine, project.id, () => decision(fx.home, three.id).status === 'invalidated', { max: 4, what: 'the overtaken question to be invalidated' });
    assertRefused(await answer(fx.engine, project.id, two, 'approve'), 409, CODES.consumed, 'answering the consumed decision');
    assertRefused(await answer(fx.engine, project.id, three, 'approve'), 409, CODES.invalidated, 'answering the invalidated decision');
    await waitFor(async () => (await getPolicy(fx.engine, project.id)).effective.max_chained_roles === 2, { what: 'the approved widening to be effective' });
  });
});
