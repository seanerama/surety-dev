// M416 (f), (d), the next turn's package and the raw stream in a real domain
// (slice 33; SANDBOX lane: real `role` domains, the scripted backend, no
// model; the kernel half is `M416-the-transcript-and-its-speakers`). M5 plan
// §3.3 M416; D6-S03; D6 §2.2, §2.3; D1 §14.2; SEAM.md §§343, 390.
//   (f) the second turn's package, read in the domain at /surety/context,
//       holds the transcript so far and the artifact's current state;
//   (d) a held secret the owner typed, which the role echoes on its stdout:
//       the raw stream record is redacted like the transcript.
//
// SAFETY (BS5 §4.1; E64): the scripted role program in the test's own
// domains; nothing signalled.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { holdSecret, recordFile } from './harness/records.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { step } from './harness/scripted.mjs';
import { openSession, packageOf, sayAndSettle, scriptTurns, transcriptEntries, turnResult, turnThatDumps, turnThatWrites } from './harness/sessions.mjs';
import { withStore } from './harness/store.mjs';
import { sessionProject } from './harness/session-lane.mjs';

const IDEA = '# Tally\n\nThe artifact as the first turn left it: a service that sums numbers.\n';
const recordsOf = (home, project) => withStore(home, (db) => db.prepare('SELECT * FROM "records" WHERE "project" = ?').all(project));

describe('M416 (f), (d) the next turn\'s package and the raw stream, in a real domain', () => {
  test('(f) the second turn\'s package at /surety/context holds the transcript so far and the artifact\'s current state', async (t) => {
    const fx = await sandboxEngine(t);
    const p = await sessionProject(fx);
    const run = await openSession(fx, p.id, 'vision');
    scriptTurns(fx, run.id, [turnThatWrites({ '.surety/idea.md': IDEA }, { reply: 'The first reply.' }), turnThatDumps({}, { reply: 'Read it.' })]);
    await sayAndSettle(fx, p.id, run.id, 'The first message.');
    await sayAndSettle(fx, p.id, run.id, 'The second message.');
    const pkg = Object.values(packageOf(fx, run.id, 1) ?? {}).join('\n');
    assert.ok(pkg.length > 0, 'the fixture is live: the second turn dumped its package');
    for (const text of ['The first message.', 'The first reply.', 'The second message.']) assert.ok(pkg.includes(text), `the package holds "${text}"`);
    assert.ok(pkg.includes('The artifact as the first turn left it'), 'and the artifact\'s current state');
  });

  test('(d) a held secret typed by the owner and echoed by the role: the transcript and the raw stream record redacted', async (t) => {
    const secret = 'sk-tally-held-secret-value-0002';
    const fx = await sandboxEngine(t);
    const p = await sessionProject(fx);
    await holdSecret(fx.engine, 'project/tally/api_key', secret);
    const run = await openSession(fx, p.id, 'vision');
    scriptTurns(fx, run.id, [{ steps: [step.stdout(`{"type":"note","text":"you said ${secret}"}\n`), step.result(turnResult({ reply: 'Noted.' }))] }]);
    await sayAndSettle(fx, p.id, run.id, `The key is ${secret}.`);
    assert.ok(transcriptEntries(fx.home, run.id).every((e) => !(e.text ?? '').includes(secret)), 'the transcript redacted');
    const holding = recordsOf(fx.home, p.id).filter((r) => {
      try {
        return readFileSync(recordFile(fx.home, r), 'latin1').includes(secret);
      } catch {
        return false;
      }
    });
    assert.deepEqual(holding.map((r) => r.kind), [], 'no record, the raw stream included, holds the secret');
  });
});
