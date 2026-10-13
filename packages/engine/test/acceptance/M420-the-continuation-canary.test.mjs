// M420, the continuation canary (slice 33; SANDBOX lane: real domains, the
// `scripted` backend's stand-in running the scripted role program, no model).
// M5 plan §3.3 M420 (a) to (c); D6-S09; D6 §2.6; D2 §7.2, §4.1; SEAM.md §§149,
// 392. Its kernel neighbour is `M420-session-backends-and-models`; its real
// part is `M420-the-continuation-canary-on-the-real-backend` (manifest
// `real`, run by the driver only) and M443's attempt.
//   (a) an attempt in `session_headless` mode runs the continuation canary:
//       one session of two turns, the second answering from the first's
//       transcript and artifact (the token turn 1 wrote, found in turn 2's
//       package); the entry it writes is `session_qualified` true only from a
//       passing canary;
//   (b) quiescence: the first turn's domain terminated before the second is
//       dispatched;
//   (c) a failing canary (the second turn answers without the token): the
//       attempt fails on it and no entry is `session_qualified`.
//
// SAFETY (E64 item 2; SEAM.md §§141, 149): the containment canary's guarded
// actions released only after the host read that its role is contained.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { approveAttempt, armedCanary, attemptFixture, canaryOf, canaryRuns, obeyingCanaries, qualify, scriptedBody, waitAttempt } from './harness/sandbox/qualify.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { trustEntries } from './harness/trust.mjs';
import { domainsOfRun, invocationsOf } from './harness/session-lane.mjs';

const times = (one) => Array.from({ length: 8 }, () => one);

async function sessionAttempt(t, mode) {
  const { fx, standIn, fixtureProject } = await attemptFixture(t);
  obeyingCanaries(fx);
  fx.scripted.canaryScript('continuation', times({ steps: [step.canary(mode)] }));
  const attempt = await qualify(fx, scriptedBody(standIn, fixtureProject, { mode: 'session_headless' }));
  await approveAttempt(fx, fixtureProject, attempt.id);
  await armedCanary(fx, 'containment');
  const done = await waitAttempt(fx.home, attempt.id, ['succeeded', 'failed', 'invalidated']);
  return { fx, attempt, done };
}

describe('M420 the continuation canary on the scripted backend', () => {
  test('(a) a session_headless attempt runs the continuation canary, two turns of one session, the second answering from the first; session_qualified true only from its pass; (b) the first domain terminated before the second dispatch', async (t) => {
    const { fx, attempt, done } = await sessionAttempt(t, 'obey');
    assert.equal(done.status, 'succeeded', `the attempt succeeds (${JSON.stringify(done.canaries)})`);
    const canary = canaryOf(done, 'continuation');
    assert.ok(canary, `the continuation canary ran (${JSON.stringify(done.canaries?.map((c) => c.kind))})`);
    const kindOf = (id) => withStore(fx.home, (db) => db.prepare('SELECT * FROM "runs" WHERE "id" = ?').get(id));
    const runId = canary.run ?? canaryRuns(fx.home, attempt.id).map((r) => r.run).find((id) => kindOf(id)?.kind === 'session');
    assert.ok(runId, `the canary's run (${JSON.stringify(canary)})`);
    const runRow = kindOf(runId);
    assert.equal(runRow.kind, 'session', 'a session run');
    const receipts = invocationsOf(fx.home, runRow.id);
    assert.equal(receipts.length, 2, 'two turns, two invocations');
    const answered = fx.scripted.log().filter((e) => e.event === 'canary' && e.kind === 'continuation' && e.outcome === 'answered');
    assert.ok(answered.length === 1 && answered[0].found.length > 0, `turn 2 found turn 1's token in its package (${JSON.stringify(answered)})`);
    const entry = trustEntries(fx.home).find((e) => e.qualification_attempt === attempt.id || e.attempt === attempt.id);
    assert.ok(entry, 'the attempt wrote an entry');
    assert.equal(Boolean(entry.session_qualified), true, 'session_qualified from the passing canary');
    // (b)
    const domains = domainsOfRun(fx.home, runRow.id);
    assert.equal(domains.length, 2, 'a domain a turn');
    const second = fx.scripted.launches({ run: runRow.id })[1];
    const firstEnded = withStore(fx.home, (db) => db.prepare(`SELECT MIN("at") AS at FROM "invocation_status_observations" WHERE "invocation" = ? AND "status" IN ('ended', 'unknown')`).get(receipts[0].id).at);
    assert.ok(firstEnded && second && Date.parse(firstEnded) <= Date.parse(second.at), `the first turn ended (${firstEnded}) before the second launched (${second?.at})`);
  });

  test('(c) a failing continuation canary: the attempt fails on it, and no entry is session_qualified', async (t) => {
    const { fx, done } = await sessionAttempt(t, 'forget');
    assert.equal(done.status, 'failed', `the attempt fails (${JSON.stringify(done.canaries)})`);
    assert.ok(canaryOf(done, 'continuation'), 'on the continuation canary');
    assert.ok(trustEntries(fx.home).every((e) => !e.session_qualified), 'no entry session_qualified');
  });
});
