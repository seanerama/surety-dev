// M561, request outcomes: what the policy route answers, and how a lost
// answer is settled (UI1 slice 48, kernel lane; the usability batch of
// 2026-10-27, decision 6, the driver's fixed shape; the B2 record's
// coordinator question on `committed: false`; D1 §§10.1, 11.4; SEAM.md
// §§27, 570).
//
// NEW BEHAVIOUR (Builder's branch `build/assistant-usability`). EVERY CASE
// HERE IS EXPECTED TO FAIL on engine main 600b6e88, whose route answers
// {revision, committed: false} for a change and {revision: null, committed:
// false} when nothing is to commit, and refuses `intent_id` as an unknown
// field.
//
//   (a) A change to commit is answered {outcome: "accepted", revision,
//       committed: false, commit: {state: "pending"}}; the project's policy
//       read then shows that revision's commit state, `committed` once the
//       journal has committed it, so a client whose answer was lost settles
//       it by reading, without sending it again.
//   (b) A submission with nothing to commit is answered {outcome:
//       "unchanged", revision: null, committed: false, commit: null}.
//   (c) Refusals stay 4xx with their codes and the refusal shape, and carry
//       no outcome.
//   (d) With an `intent_id`, a repeat with the same body is answered with
//       the same revision (its commit state current) and commits nothing
//       more; a different body under it is 409 `policy_intent_conflict`,
//       and nothing changes.
//
// The names under which the read shows the commit state (`submissions[]`
// with `intent_id`, `revision`, `commit.state`; `pending[]`) are the
// Builder's (the driver's shape names the requirement only; SEAM.md §570).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isRefusalBody, waitFor } from './harness/engine.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { getPolicy } from './harness/journal.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';

const post = (fx, project, body) => fx.engine.post(`/v1/projects/${project}/policy`, body);
const revisionsOf = (home, project) => withStore(home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "policy_revisions" WHERE "project" = ?').get(project).n);

// The read's commit state of `revision` (optionally of one intent).
async function commitShown(fx, project, revision, intent) {
  const p = await getPolicy(fx.engine, project);
  const s = (p.submissions ?? []).find((x) => x.revision === revision && (intent === undefined || x.intent_id === intent));
  return { policy: p, submission: s ?? null };
}

async function settled(fx, project, revision, intent) {
  return waitFor(
    async () => {
      const shown = await commitShown(fx, project, revision, intent);
      return shown.submission?.commit?.state === 'committed' && shown.policy.revision === revision ? shown : undefined;
    },
    { what: `revision ${revision} to read committed` },
  );
}

describe('M561 the policy route\'s outcomes and a lost answer settled by reading (new behaviour: fails on 600b6e88)', () => {
  test('(a) accepted with its revision and commit pending, then read committed; (b) unchanged; (c) refusals unchanged', async (t) => {
    const fx = await scriptedEngine(t);
    const { id: project } = await addGitProject(fx);
    const before = (await getPolicy(fx.engine, project)).revision ?? 0;

    const res = await post(fx, project, { budget_run_billable_tokens: 1_000_000 });
    assert.equal(res.status, 200, `the change is taken (body: ${res.text})`);
    assert.deepEqual(res.body, { outcome: 'accepted', revision: before + 1, committed: false, commit: { state: 'pending' } }, 'accepted: its revision, its commit pending');
    const shown = await commitShown(fx, project, before + 1);
    assert.ok(shown.submission, `the read shows the revision's submission at once (${JSON.stringify(shown.policy.submissions ?? null)})`);
    assert.ok(['pending', 'committed'].includes(shown.submission.commit?.state), `with its commit state (${JSON.stringify(shown.submission)})`);
    const done = await settled(fx, project, before + 1);
    assert.equal(done.policy.effective?.budget_run_billable_tokens, 1_000_000, 'and the value is in effect');

    const revisions = revisionsOf(fx.home, project);
    const same = await post(fx, project, { budget_run_billable_tokens: 1_000_000 });
    assert.equal(same.status, 200, `nothing to commit is not a refusal (body: ${same.text})`);
    assert.deepEqual(same.body, { outcome: 'unchanged', revision: null, committed: false, commit: null }, 'unchanged');
    await new Promise((r) => setTimeout(r, 1_000));
    assert.equal(revisionsOf(fx.home, project), revisions, 'no revision');

    for (const [body, code] of [
      [{ budget_run_billable_tokens: 1 }, 'invalid_value'],
      [{ not_a_policy_key: true }, 'unknown_field'],
    ]) {
      const r = await post(fx, project, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} refused 400 (body: ${r.text})`);
      assert.equal(r.body?.code, code, `with ${code}`);
      assert.ok(isRefusalBody(r.body), 'the refusal shape');
      assert.ok(!('outcome' in r.body), 'a refusal carries no outcome');
    }
    assert.equal((await getPolicy(fx.engine, project)).revision, before + 1, 'the refusals changed nothing');
  });

  test('(d) with an intent_id: a repeat with the same body is the same revision and commits nothing more; a different body is 409 policy_intent_conflict', async (t) => {
    const fx = await scriptedEngine(t);
    const { id: project } = await addGitProject(fx);
    const before = (await getPolicy(fx.engine, project)).revision ?? 0;
    const body = { intent_id: 'm561-p1', budget_run_billable_tokens: 900_000 };

    const first = await post(fx, project, body);
    assert.equal(first.status, 200, `the change is taken (body: ${first.text})`);
    assert.deepEqual([first.body.outcome, first.body.revision], ['accepted', before + 1], `accepted (${first.text})`);
    // The answer is "lost": the client reads instead.
    const read = await settled(fx, project, before + 1, 'm561-p1');
    assert.deepEqual([read.submission.intent_id, read.submission.outcome, read.submission.revision], ['m561-p1', 'accepted', before + 1], 'the read settles the lost answer');
    const revisions = revisionsOf(fx.home, project);

    const again = await post(fx, project, body);
    assert.equal(again.status, 200, `the repeat is answered (body: ${again.text})`);
    assert.deepEqual([again.body.outcome, again.body.revision, again.body.commit?.state], ['accepted', before + 1, 'committed'], `the same revision, its commit state current (${again.text})`);
    await new Promise((r) => setTimeout(r, 1_000));
    assert.deepEqual([(await getPolicy(fx.engine, project)).revision, revisionsOf(fx.home, project)], [before + 1, revisions], 'nothing more is committed');

    const other = await post(fx, project, { intent_id: 'm561-p1', budget_run_billable_tokens: 800_000 });
    assert.deepEqual([other.status, other.body?.code], [409, 'policy_intent_conflict'], `a different body under the same intent (body: ${other.text})`);
    assert.ok(isRefusalBody(other.body), 'the refusal shape');
    await new Promise((r) => setTimeout(r, 1_000));
    assert.deepEqual([(await getPolicy(fx.engine, project)).revision, revisionsOf(fx.home, project)], [before + 1, revisions], 'and nothing changes');
  });
});
