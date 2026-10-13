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

import { approveAttempt, armedCanary, attemptFixture, attemptOf, canaryOf, canaryRuns, obeyingCanaries, postQualify, qualify, scriptedBody, waitAttempt } from './harness/sandbox/qualify.mjs';
import { waitFor } from './harness/engine.mjs';
import { holdSecret, recordFile, recordRow } from './harness/records.mjs';
import { readFileSync } from 'node:fs';
import { installTrustEntry } from './harness/trust.mjs';
import { acting, hostNamespaces, step } from './harness/scripted.mjs';
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

// The slice-33 review's M2, M3 and M6 (D6 §2.6, §2.7; D2 §7.2; SEAM.md §§392, 393).
describe('M420 the continuation canary: the review\'s M2, M3 and M6', () => {
  test('M2: an entry\'s session qualification naming a model other than the entry\'s is refused; a binary whose hash differs from the entry\'s is refused; the entry never session_qualified', async (t) => {
    const { fx, standIn, fixtureProject } = await attemptFixture(t);
    obeyingCanaries(fx);
    fx.scripted.canaryScript('continuation', times({ steps: [step.canary('obey')] }));
    const entry = await installTrustEntry(fx.engine, standIn, { status: 'active', model: 'claude-sonnet-5-5' });
    const other = await postQualify(fx, { entry: entry.id, mode: 'session_headless', model: 'claude-opus-5-5', fixture_project: fixtureProject });
    assert.ok(other.status >= 400 && other.status < 500, `a model other than the entry's refused (→ ${other.status} ${other.text})`);
    standIn.changeBytes('M420 M2: the binary is not the entry\'s');
    const changed = await postQualify(fx, { entry: entry.id, mode: 'session_headless', model: 'claude-sonnet-5-5', fixture_project: fixtureProject });
    if (changed.status === 201) {
      const id = changed.body.qualification_attempt?.id ?? changed.body.attempt?.id;
      await approveAttempt(fx, fixtureProject, id).catch(() => null);
      const done = await waitAttempt(fx.home, id, ['succeeded', 'failed', 'invalidated']).catch(() => attemptOf(fx.home, id));
      assert.notEqual(done?.status, 'succeeded', `a binary whose hash differs is not qualified (${done?.status})`);
    } else {
      assert.ok(changed.status >= 400 && changed.status < 500, `a binary whose hash differs refused (→ ${changed.status} ${changed.text})`);
    }
    assert.equal(Boolean(trustEntries(fx.home).find((e) => e.id === entry.id)?.session_qualified), false, 'the entry never session_qualified');
  });

  test('M3: a continuation canary whose first turn\'s provider inventory is missing does not pass, and its evidence does not claim carried: false', async (t) => {
    const secret = 'sk-continuation-held-secret-0003';
    const { fx, standIn, fixtureProject } = await attemptFixture(t);
    obeyingCanaries(fx);
    await holdSecret(fx.engine, 'project/canary/token', secret);
    // Turn 1 leaves a provider file holding a registered secret: the screen refuses its inventory (SEAM.md §152), so none is recorded.
    const leave = { steps: [acting(hostNamespaces()).volatileShapes({ files: [{ path: '/surety/home/notes/turn1.jsonl', content: `{"key":"${secret}"}\n` }] }), step.canary('obey')] };
    fx.scripted.canaryScript('continuation', [leave, ...times({ steps: [step.canary('obey')] })]);
    const attempt = await qualify(fx, scriptedBody(standIn, fixtureProject, { mode: 'session_headless' }));
    await approveAttempt(fx, fixtureProject, attempt.id);
    await armedCanary(fx, 'containment');
    const done = await waitAttempt(fx.home, attempt.id, ['succeeded', 'failed', 'invalidated']);
    const canary = canaryOf(done, 'continuation');
    assert.ok(canary, `the continuation canary ran (${JSON.stringify(done.canaries?.map((c) => c.kind))})`);
    assert.notEqual(canary.passed, true, 'it does not pass without the first turn\'s inventory');
    const row = canary.evidence ? recordRow(fx.home, canary.evidence) : null;
    const evidence = row ? readFileSync(recordFile(fx.home, row), 'utf8') : '';
    assert.doesNotMatch(evidence.replace(/\s/g, ''), /"carried":false/, `its evidence does not claim carried: false (${evidence.slice(0, 400)})`);
  });

  test('M6: the engine restarts between the canary\'s two turns: the attempt invalidated, the canary\'s session run ended, the fixture project not held session_busy for the next attempt', async (t) => {
    const { fx, standIn, fixtureProject } = await attemptFixture(t);
    obeyingCanaries(fx);
    // Turn 2 holds at its start, so the restart lands before the canary can finish its second turn.
    fx.scripted.canaryScript('continuation', [{ steps: [step.canary('obey')] }, { steps: [step.hold('gate'), step.canary('obey')] }, ...times({ steps: [step.canary('obey')] })]);
    const first = await qualify(fx, scriptedBody(standIn, fixtureProject, { mode: 'session_headless' }));
    await approveAttempt(fx, fixtureProject, first.id);
    await armedCanary(fx, 'containment');
    // The canary's turns are driven by the attempt, not the owner's routes, so the restart is timed by the store:
    // once turn 1 is settled, the engine is stopped (its own verified kill) and started again.
    const turnOne = () =>
      withStore(fx.home, (db) => db.prepare(`SELECT t."settled_at" FROM "turns" t JOIN "runs" r ON r."id" = t."run" WHERE r."project" = ? AND r."kind" = 'session' AND t."number" = 1`).get(fixtureProject));
    await waitFor(() => (turnOne()?.settled_at ? true : undefined), { what: 'the canary\'s first turn to settle', intervalMs: 50, timeoutMs: 180_000 });
    await fx.engine.kill();
    fx.scripted.release('all', 'gate');
    await fx.start();
    const invalidated = await waitAttempt(fx.home, first.id, ['succeeded', 'failed', 'invalidated']).catch(() => attemptOf(fx.home, first.id));
    assert.equal(invalidated?.status, 'invalidated', `the attempt invalidated by the restart (${invalidated?.status})`);
    const open = withStore(fx.home, (db) => db.prepare(`SELECT "id", "state" FROM "runs" WHERE "project" = ? AND "kind" = 'session' AND "state" <> 'ended'`).all(fixtureProject));
    assert.deepEqual(open, [], 'the canary\'s session run ended');
    const second = await qualify(fx, scriptedBody(standIn, fixtureProject, { mode: 'session_headless' }));
    await approveAttempt(fx, fixtureProject, second.id);
    await armedCanary(fx, 'containment');
    const done = await waitAttempt(fx.home, second.id, ['succeeded', 'failed', 'invalidated']);
    assert.ok(canaryOf(done, 'continuation')?.passed, `the next attempt's continuation canary runs on the fixture project, not held session_busy (${JSON.stringify(done.canaries)})`);
  });
});
