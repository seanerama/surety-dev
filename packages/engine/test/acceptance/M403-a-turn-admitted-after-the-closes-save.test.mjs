// M403, the close and a turn admitted after the close's own save (slice 31,
// the 31a review's S1; kernel lane). D6 §2.4 ("one idle generation, one
// winner": save, close and the admission of the next turn each run one
// compare-and-swap on the session's idle generation), B01; SEAM.md §§344,
// 365.
//
// A Vision session's turn writes the idea record; the owner closes. The
// close saves, and is held at the barrier `session.close_saved` † (after its
// save, before the transaction that enters `closing` and raises the
// decision). While it is held the owner's next turn is admitted, writes a
// different idea record, and settles. Released, the close either refuses
// (409 `session_generation_stale`, or `session_not_idle`), raising nothing,
// or saves that turn's change first and raises `idea_accept` on it. It never
// raises a decision on the products from before that turn.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

import { releaseBarrier } from './harness/engine.mjs';
import { decisionsOfKind } from './harness/decisions.mjs';
import { armBarrier } from './harness/journal.mjs';
import { createWithIdea } from './harness/journey/drive.mjs';
import { IDEA_RECORD } from './harness/journey/reference.mjs';
import { fileAt, refOid } from './harness/repos.mjs';
import { runRow, say, sayAndSettle, openSession, scriptTurns, turnThatWrites } from './harness/sessions.mjs';
import { scriptedEngine } from './harness/runs.mjs';

const BARRIER = 'session.close_saved';
const gitBlob = (text) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
const LATER_RECORD = IDEA_RECORD.replace('The count the dashboard shows matches the requests made; /sum answers in under 50 ms.', 'The dashboard shows the count first; the count matches the requests made; /sum answers in under 50 ms.');

describe('M403 a turn admitted after the close\'s own save', () => {
  test('(S1) the close never raises its decision on products from before a turn admitted after its save: it refuses on the idle generation, or saves that turn first', async (t) => {
    const fx = await scriptedEngine(t);
    assert.notEqual(LATER_RECORD, IDEA_RECORD, 'the fixture is live: the later record differs');
    const p = await createWithIdea(fx);
    const run = await openSession(fx, p.id, 'vision');
    scriptTurns(fx, run.id, [
      turnThatWrites({ '.surety/idea.md': IDEA_RECORD }, { reply: 'I wrote the idea record.' }),
      turnThatWrites({ '.surety/idea.md': LATER_RECORD }, { reply: 'The count comes first now.' }),
    ]);
    await sayAndSettle(fx, p.id, run.id, 'Write the idea record.');

    // The close, held after its own save.
    await armBarrier(fx.engine, BARRIER, 'pause');
    const closing = fx.engine.post(`/v1/projects/${p.id}/sessions/${run.id}/close`, {});
    await fx.engine.waitUntil(`barrier:${BARRIER}`);
    const savedHead = refOid(p.repo.path, p.repo.ref);
    assert.equal(fileAt(p.repo.path, savedHead, '.surety/idea.md'), IDEA_RECORD, 'the fixture is live: the close\'s save committed the first record');

    // The owner's next turn, admitted and settled while the close is held.
    const late = await say(fx, p.id, run.id, 'Put the count first.');
    assert.equal(late.turn.state, 'settled', `the turn admitted after the close's save settled (${JSON.stringify(late.turn)})`);

    await releaseBarrier(fx.engine, BARRIER);
    const res = await closing;
    const raised = decisionsOfKind(fx.home, p.id, 'idea_accept');
    assert.deepEqual(raised.filter((d) => d.manifest?.blob === gitBlob(IDEA_RECORD)), [], `no idea_accept is bound to the record from before the later turn (${JSON.stringify(raised.map((d) => d.manifest))})`);
    if (res.status === 200) {
      const revision = res.body?.saved?.revision;
      assert.match(revision ?? '', /^[0-9a-f]{40}$/, `the close saved the later turn's change before raising (body: ${res.text})`);
      assert.equal(fileAt(p.repo.path, revision, '.surety/idea.md'), LATER_RECORD, 'its save holds the later record');
      assert.equal(raised.length, 1, 'one idea_accept');
      assert.equal(raised[0].manifest?.blob, gitBlob(LATER_RECORD), 'bound to the later record\'s blob');
    } else {
      assert.equal(res.status, 409, `otherwise the close is refused (→ ${res.status} ${res.text})`);
      assert.ok(['session_generation_stale', 'session_not_idle'].includes(res.body?.code), `on the idle generation (code ${res.body?.code})`);
      assert.deepEqual(raised, [], 'and raises nothing');
      const row = runRow(fx.home, run.id);
      assert.notEqual(row.state, 'ended', 'the session stays open for the owner to close again');
    }
  });
});
