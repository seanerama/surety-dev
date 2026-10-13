// M403, a settled turn leaves no failure entry (slice 32's review, S1; a
// slice-31 regression; kernel lane). D6 §2.2, §2.3 (the transcript: the
// owner's entry, the role's reply, and the engine's notes); SEAM.md §§343,
// 344, 387. A turn whose role replied, with no `requirement_confirmations` in
// its reply, settles `settled` with the role's entry and no engine entry
// saying the turn failed. A turn whose reply did carry confirmations gets the
// engine's note that nothing was answered, and no failure entry either.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createWithIdea } from './harness/journey/drive.mjs';
import { openSession, readSession, sayAndSettle, scriptTurns, turnThatSays } from './harness/sessions.mjs';
import { scriptedEngine } from './harness/runs.mjs';

const failures = (read, turn) => (read.transcript ?? []).filter((e) => e.turn === turn && e.speaker === 'engine' && /turn failed/i.test(e.text ?? ''));

describe('M403 a settled turn leaves no "The turn failed" entry (S1)', () => {
  test('a reply with no requirement_confirmations: the role\'s entry, and no engine entry saying the turn failed', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx);
    const run = await openSession(fx, p.id, 'vision');
    scriptTurns(fx, run.id, [turnThatSays('Who reads the dashboard first?')]);
    const done = await sayAndSettle(fx, p.id, run.id, 'Tally sums two numbers over HTTP.');
    const read = await readSession(fx, p.id, run.id);
    const turn = done.turn.turn;
    assert.ok((read.transcript ?? []).some((e) => e.turn === turn && e.speaker === 'role' && /dashboard/.test(e.text ?? '')), `the role's reply is in the transcript (${JSON.stringify(read.transcript)})`);
    assert.deepEqual(failures(read, turn), [], `no engine entry says the settled turn failed (${JSON.stringify(read.transcript)})`);
  });

  test('a reply carrying requirement_confirmations: the engine\'s note that nothing was answered, and still no failure entry', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx);
    const run = await openSession(fx, p.id, 'vision');
    scriptTurns(fx, run.id, [turnThatSays('I confirm R1.', { requirement_confirmations: [{ key: 'R1', option: 'confirm' }] })]);
    const done = await sayAndSettle(fx, p.id, run.id, 'Tally sums two numbers over HTTP.');
    const read = await readSession(fx, p.id, run.id);
    assert.deepEqual(failures(read, done.turn.turn), [], `no failure entry (${JSON.stringify(read.transcript)})`);
  });
});
