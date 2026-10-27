// M560, B2: the qualification budget's admission, and a canary that never
// ran (UI1 slice 48, sandbox lane; errata E183 item 3 (B2, SETUP-01, Sean's
// approval of 2026-10-27); the Builder's B2 record; SEAM.md §§148, 566).
//
//   (a) A qualification approval is accepted only if
//         charged + outstanding reservations + requested <= limit,
//       the fixture project's budget_day_unknown_tokens: `charged` the day's
//       unknown-cost tokens and allowances, `outstanding` what attempts
//       already authorized or running reserve (each its cancellation
//       canary's limit until that canary is dispatched), `requested` this
//       attempt's own (the fixture's budget_run_billable_tokens). The four
//       numbers are served before any answer on GET /v1/engine
//       (`qualification_attempts[].admission`, with `fits`, the reserving
//       attempts and `clears_at`, the next 00:00Z), and each attempt's
//       `reserved_tokens`. At exactly the limit it fits. Over it, the
//       answer is refused 409 `budget_exhausted` with the four numbers and
//       `clears_at`; the decision stays open, the attempt proposed, nothing
//       written but the refused request's own audit event (api.act, 409).
//       Once the reserving attempt has ended its reservation is released
//       and the numbers say so.
//   (b) A canary held at dispatch until its deadline (here: its fixture
//       project paused) is recorded `failure_class: "not_dispatched"` with
//       its `wait_reason` (the blocker's own words), `passed: false`; it ran
//       nothing (no run); the attempt ends `failed`. The approval states the
//       attempt's true canary count.
//
// Reuses M135's and M136's sandbox-lane fixtures (harness/sandbox/qualify.mjs).
// No model is called: the canaries are the scripted role program.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { changePolicy } from './harness/journal.mjs';
import { pauseProject } from './harness/runs.mjs';
import { approveAttempt, attemptFixture, attemptOf, canaryOf, canaryRuns, qualify, scriptedBody, waitAttempt } from './harness/sandbox/qualify.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { answerEngine, openEngineDecision } from './harness/trust.mjs';

const R = 300_000;
const times = (one) => Array.from({ length: 6 }, () => one);
const shownOf = async (fx, id) => (await fx.engine.engineInfo()).qualification_attempts?.find((a) => a.id === id) ?? null;
const nextMidnight = (day) => new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString();
const lastSeq = (home) => withStore(home, (db) => db.prepare('SELECT COALESCE(MAX("seq"), 0) AS n FROM "events"').get().n);

describe("M560 the qualification budget's admission; a canary that never ran", () => {
  test('(a) admission by reservation: the four numbers served before the answer; fits at the limit; over it 409 budget_exhausted with the four numbers and clears_at, the decision left open; released once the reserving attempt ends', async (t) => {
    const { fx, standIn, fixtureProject } = await attemptFixture(t);
    await changePolicy(fx.engine, fixtureProject, { budget_run_billable_tokens: R, budget_day_unknown_tokens: 2 * R });
    // Attempt A: its positive canary holds, so its cancellation canary is not yet dispatched.
    fx.scripted.canaryScript('positive', times({ steps: [step.hold('held'), step.canary('obey')] }));
    fx.scripted.canaryScript('cancellation', times({ steps: [step.canary('obey')], on_term: 'exit' }));
    fx.scripted.canaryScript('containment', times({ steps: [step.canary('obey')] }));
    const a = await qualify(fx, scriptedBody(standIn, fixtureProject));
    await approveAttempt(fx, fixtureProject, a.id);
    await fx.scripted.waitForHolding({ canary_kind: 'positive' }, 'held', { timeoutMs: 120_000 });
    assert.equal(attemptOf(fx.home, a.id).status, 'running', 'the fixture is live: A runs, its cancellation canary not yet dispatched');
    assert.equal((await shownOf(fx, a.id))?.reserved_tokens, R, `A reserves its cancellation canary's limit (${JSON.stringify(await shownOf(fx, a.id))})`);

    // Attempt B, proposed: 0 + R + R <= 2R fits, exactly.
    const b = await qualify(fx, scriptedBody(standIn, fixtureProject));
    let adm = (await shownOf(fx, b.id))?.admission;
    assert.ok(adm, 'GET /v1/engine serves B\'s admission before any answer');
    assert.deepEqual(
      { limit_key: adm.limit_key, fixture_project: adm.fixture_project, outstanding: adm.outstanding_reserved_tokens, requested: adm.requested_tokens, limit: adm.limit_tokens, reserving: adm.reserving_attempts, clears_at: adm.clears_at },
      { limit_key: 'budget_day_unknown_tokens', fixture_project: fixtureProject, outstanding: R, requested: R, limit: 2 * R, reserving: [{ id: a.id, tokens: R }], clears_at: nextMidnight(adm.day) },
      `the numbers (${JSON.stringify(adm)})`,
    );
    assert.equal(adm.fits, adm.charged_tokens + R + R <= 2 * R, 'fits is the inequality');
    assert.equal(adm.charged_tokens, 0, 'nothing charged yet: at the limit exactly');
    assert.equal(adm.fits, true, '<= the limit fits');

    // Lowered by one token: over the limit.
    await changePolicy(fx.engine, fixtureProject, { budget_day_unknown_tokens: 2 * R - 1 });
    adm = (await shownOf(fx, b.id)).admission;
    assert.deepEqual([adm.fits, adm.limit_tokens], [false, 2 * R - 1], `over the limit by one (${JSON.stringify(adm)})`);
    const previewed = await openEngineDecision(fx, fixtureProject, 'qualification_approval', b.id);
    const events = lastSeq(fx.home);
    const res = await answerEngine(fx.engine, previewed, 'approve');
    assert.deepEqual([res.status, res.body?.code], [409, 'budget_exhausted'], `refused budget_exhausted (body: ${res.text})`);
    const sub = res.body.subject;
    assert.deepEqual(
      [sub.charged_tokens, sub.outstanding_reserved_tokens, sub.requested_tokens, sub.limit_tokens, sub.clears_at, sub.qualification_attempt],
      [0, R, R, 2 * R - 1, adm.clears_at, b.id],
      `the four numbers and clears_at (${JSON.stringify(sub)})`,
    );
    const d = withStore(fx.home, (db) => db.prepare('SELECT "status" FROM "decisions" WHERE "id" = ?').get(previewed.id));
    assert.equal(d.status, 'open', 'the decision stays open');
    assert.equal(attemptOf(fx.home, b.id).status, 'proposed', 'B stays proposed');
    // Only the request's own audit record (api.act, its status 409) follows.
    const written = withStore(fx.home, (db) => db.prepare('SELECT "type", "payload" FROM "events" WHERE "seq" > ? ORDER BY "seq"').all(events));
    assert.deepEqual(written.map((e) => [e.type, JSON.parse(e.payload).status]), [['api.act', 409]], `nothing was written but the refused request's audit (${JSON.stringify(written)})`);

    // A ends: its reservation is released.
    fx.scripted.release('all', 'held');
    const doneA = await waitAttempt(fx.home, a.id, ['succeeded', 'failed', 'invalidated'], { timeoutMs: 300_000 });
    assert.equal(doneA.status, 'succeeded', `A ended (${JSON.stringify(doneA.canaries)})`);
    assert.equal((await shownOf(fx, a.id))?.reserved_tokens, 0, 'A holds nothing now');
    adm = (await shownOf(fx, b.id)).admission;
    assert.deepEqual([adm.outstanding_reserved_tokens, adm.reserving_attempts], [0, []], `released (${JSON.stringify(adm)})`);
    assert.equal(adm.fits, adm.charged_tokens + R <= 2 * R - 1, 'fits is the inequality, with what A charged');
  });

  test('(b) a canary held at dispatch to its deadline: not_dispatched with its wait_reason, passed false, nothing run; the attempt failed; the approval names three canaries', async (t) => {
    const { fx, standIn, fixtureProject } = await attemptFixture(t);
    fx.scripted.canaryScript('positive', times({ steps: [step.canary('obey')] }));
    const a = await qualify(fx, scriptedBody(standIn, fixtureProject, { canary_deadlines: { positive: 3, cancellation: 3, containment: 3 } }));
    await pauseProject(fx.engine, fixtureProject);
    const previewed = await openEngineDecision(fx, fixtureProject, 'qualification_approval', a.id);
    assert.match(JSON.stringify(previewed), /three canaries \(positive, cancellation, containment\)/, 'the approval names the true canary count');
    const answered = await answerEngine(fx.engine, previewed, 'approve');
    assert.equal(answered.status, 200, `the approval is taken (body: ${answered.text})`);
    const done = await waitAttempt(fx.home, a.id, ['succeeded', 'failed', 'invalidated'], { timeoutMs: 120_000 });
    assert.equal(done.status, 'failed', `the attempt failed (${JSON.stringify(done.canaries)})`);
    const positive = canaryOf(done, 'positive');
    assert.deepEqual([positive?.passed, positive?.failure_class, positive?.run ?? null], [false, 'not_dispatched', null], `the positive canary never ran (${JSON.stringify(positive)})`);
    assert.equal(positive.wait_reason, 'project paused', `its wait_reason is the blocker's words (${JSON.stringify(positive)})`);
    assert.equal(canaryRuns(fx.home, a.id).length, 0, 'no canary run was dispatched');
    await waitFor(() => attemptOf(fx.home, a.id).status === 'failed' || undefined, { what: 'the attempt failed' });
  });
});
