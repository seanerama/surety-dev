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
// NEW BEHAVIOUR (the Builder's `build/policy-unchanged` 4d78f618; objection
// 216). (b)'s identical values are EXPECTED TO FAIL on engine main 7ef35529,
// which commits a key sent at its current value as a new revision
// (`accepted`).
//
//   (a) A change to commit is answered {outcome: "accepted", revision,
//       committed: false, commit: {state: "pending"}}; the project's policy
//       read then shows that revision's commit state, `committed` once the
//       journal has committed it, so a client whose answer was lost settles
//       it by reading, without sending it again.
//   (b) A submission with nothing to commit is answered {outcome:
//       "unchanged", revision: null, committed: false, commit: null}, and
//       makes no revision and no `policy.changed`. By the owner's ruling of
//       2026-10-27 (objection 216; SEAM.md §571), "submitting values
//       identical to the current effective values should return unchanged,
//       without creating another revision. Preserve validation and
//       intent-id behavior": a key at the value (a) committed, keys at their
//       defaults, and `{}` are each `unchanged`; validation still runs
//       first (an identical key beside a refused one is refused); with an
//       `intent_id`, the repeat of an unchanged submission is the same
//       answer and a different body under it is 409
//       `policy_intent_conflict`; a body mixing an identical key with a
//       changed one is `accepted` with the next revision.
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
import { eventsOfType, getPolicy } from './harness/journal.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';

const post = (fx, project, body) => fx.engine.post(`/v1/projects/${project}/policy`, body);
const UNCHANGED = Object.freeze({ outcome: 'unchanged', revision: null, committed: false, commit: null });
const policyChanged = (home, project) => eventsOfType(home, 'policy.changed').filter((e) => JSON.stringify(e.subject ?? null).includes(project)).length;
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
  test('(a) accepted with its revision and commit pending, then read committed; (b) identical values, defaults and {} unchanged (no revision; validation and intent_id kept), a mixed body accepted; (c) refusals unchanged', async (t) => {
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

    // (b) Nothing to commit (the owner's ruling of 2026-10-27; objection
    // 216): values identical to the current effective ones, keys at their
    // defaults, and `{}` are each `unchanged`, with no revision and no
    // policy.changed.
    const revisions = revisionsOf(fx.home, project);
    const changed = policyChanged(fx.home, project);
    assert.ok(changed >= 1, `the fixture is live: (a)'s revision raised policy.changed (${changed})`);
    const { effective } = await getPolicy(fx.engine, project);
    assert.deepEqual([effective.repair_attempts_max, effective.autonomy], [3, 'phase'], `the fixture is live: both keys read at their defaults, never set (${JSON.stringify(effective)})`);
    const nothing = async (body, what) => {
      const r = await post(fx, project, body);
      assert.equal(r.status, 200, `${what}: nothing to commit is not a refusal (body: ${r.text})`);
      assert.deepEqual(r.body, UNCHANGED, `${what}: unchanged`);
      return r;
    };
    await nothing({ budget_run_billable_tokens: 1_000_000 }, 'the value (a) committed, sent again');
    await nothing({ repair_attempts_max: 3, autonomy: 'phase' }, 'keys at their defaults');
    await nothing({}, 'no ordinary key');

    // Validation first: an identical key beside a refused one is refused.
    const mixedBad = await post(fx, project, { budget_run_billable_tokens: 1_000_000, not_a_policy_key: true });
    assert.deepEqual([mixedBad.status, mixedBad.body?.code], [400, 'unknown_field'], `an identical key does not excuse a refused one (body: ${mixedBad.text})`);
    assert.ok(!('outcome' in mixedBad.body), 'the refusal carries no outcome');

    // The intent_id behaviour, preserved for an unchanged submission.
    const intended = { intent_id: 'm561-u1', budget_run_billable_tokens: 1_000_000 };
    await nothing(intended, 'identical, with an intent_id');
    await nothing(intended, 'the same intent and body, repeated');
    const conflict = await post(fx, project, { intent_id: 'm561-u1', budget_run_billable_tokens: 800_000 });
    assert.deepEqual([conflict.status, conflict.body?.code], [409, 'policy_intent_conflict'], `a different body under the unchanged submission's intent (body: ${conflict.text})`);
    assert.ok(isRefusalBody(conflict.body), 'the refusal shape');

    await new Promise((r) => setTimeout(r, 1_000));
    const after = await getPolicy(fx.engine, project);
    assert.deepEqual(
      [after.revision, revisionsOf(fx.home, project), policyChanged(fx.home, project), after.effective?.budget_run_billable_tokens],
      [before + 1, revisions, changed, 1_000_000],
      'no revision, no policy.changed, the value as (a) left it',
    );

    // A body mixing an identical key with a changed one is accepted with the next revision.
    const day = effective.budget_day_verified_usd === 10 ? 9 : 10;
    const mixed = await post(fx, project, { budget_run_billable_tokens: 1_000_000, budget_day_verified_usd: day });
    assert.equal(mixed.status, 200, `a mixed body is taken (body: ${mixed.text})`);
    assert.deepEqual(mixed.body, { outcome: 'accepted', revision: before + 2, committed: false, commit: { state: 'pending' } }, 'a mixed body: accepted, the next revision');
    const doneMixed = await settled(fx, project, before + 2);
    assert.deepEqual([doneMixed.policy.effective?.budget_run_billable_tokens, doneMixed.policy.effective?.budget_day_verified_usd], [1_000_000, day], 'both keys in effect');
    assert.deepEqual([revisionsOf(fx.home, project), policyChanged(fx.home, project)], [revisions + 1, changed + 1], 'one revision more, one policy.changed more');

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
    assert.equal((await getPolicy(fx.engine, project)).revision, before + 2, 'the refusals changed nothing');
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
