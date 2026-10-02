// M64, the two streams (slice 6). Plan §3.6 M64 ("known secrets reach neither
// disk nor API/SSE/audit"); D1 §§11.3, 14.2, 17(5); E16c; SEAM.md §§57, 92.
//
// Slice 4 pinned redaction for what reaches the disk and the record read.
// The event stream and a run's output tail did not exist then (COVERAGE.md,
// "Obligations recorded by the slice-4 session"). This is that case: a role
// prints a secret the engine holds, split between two writes, and reports it
// in a usage line as well. A client that follows the run's output while it is
// produced, and a client that follows the event stream, are never sent the
// secret; the text around it arrives, live, and is what the transcript holds.
// The value is synthetic: no real secret is used.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { until } from './harness/mono.mjs';
import { holdSecret, readRecord } from './harness/records.mjs';
import { addProject, addWork, run as runRow, scriptedEngine, tick, waitForRun } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { eventsPath, streamOf, tailPath } from './harness/sse.mjs';

const SECRET = `sk-test-${'Z9y8'.repeat(9)}`;
const SPLIT = 17;

// The bytes a tail has delivered so far, and whether its offsets are the
// byte offsets they claim to be.
function tailBytes(tail) {
  const chunks = [];
  let offset = 0;
  let contiguous = true;
  for (const message of tail.of('output')) {
    const bytes = Buffer.from(message.json?.b64 ?? '', 'base64');
    if (message.json?.offset !== offset || Number(message.id) !== offset + bytes.length) contiguous = false;
    offset += bytes.length;
    chunks.push(bytes);
  }
  return { bytes: Buffer.concat(chunks), contiguous };
}

describe('M64 known secrets in the output tail and the event stream', () => {
  test('a secret a role prints in two writes, and reports in a usage line, reaches neither a client following the run\'s output nor a client following the events; the text around it arrives while the role still runs', async (t) => {
    const fx = await scriptedEngine(t);
    const engine = fx.engine;
    const project = (await addProject(fx)).id;
    await holdSecret(engine, 'secrets/m64-streams', SECRET);
    const item = await addWork(engine, project, 'verification');
    fx.scripted.script(item, [
      {
        steps: [
          step.stdout(`before ${SECRET.slice(0, SPLIT)}`),
          step.sleep(300),
          step.stdout(`${SECRET.slice(SPLIT)} after\n`),
          step.usage({ input_tokens: 3, output_tokens: 1, model: `model-${SECRET}` }),
          step.hold('gate', { heartbeat_ms: 0 }),
          step.result(),
        ],
      },
    ]);

    const events = await streamOf(engine, eventsPath({ since: 0 }), { keepRaw: true });
    t.after(() => events.close());
    assert.equal(events.status, 200, `the event stream opens (refusal: ${JSON.stringify(events.refusal)})`);
    await tick(engine, project);
    const run = await waitForRun(fx.home, item, { state: 'executing' });
    const tail = await streamOf(engine, tailPath(project, run.id, 0), { keepRaw: true });
    t.after(() => tail.close());
    assert.equal(tail.status, 200, `the output tail opens (refusal: ${JSON.stringify(tail.refusal)})`);
    assert.match(tail.headers['content-type'] ?? '', /^text\/event-stream\b/);

    // Live: the text after the secret arrives while the role is still waiting at its hold.
    await fx.scripted.waitForHolding({ run: run.id });
    await until(() => tailBytes(tail).bytes.includes(' after'), { timeoutMs: 20_000, what: 'the output after the secret to arrive on the tail while the role runs' });
    assert.equal(runRow(fx.home, run.id).state, 'executing', 'the role had not finished when its output had arrived');

    fx.scripted.release(item);
    await waitForRun(fx.home, item, { state: 'ended' });
    await tail.waitEnd({ timeoutMs: 20_000, what: "the tail to end once the run's output has ended" });
    await events.waitForMessage((message) => message.event === 'run.ended', { timeoutMs: 20_000, what: 'the run.ended event on the stream' });

    const delivered = tailBytes(tail);
    assert.equal(delivered.contiguous, true, 'each tail message says where its bytes begin, and its id is where they end');
    assert.equal(delivered.bytes.includes(SECRET), false, 'the secret is not in the output the tail delivered');
    assert.equal(tail.text().includes(SECRET), false, 'nor anywhere else in what the tail client received');
    assert.ok(delivered.bytes.includes('before ') && delivered.bytes.includes(' after'), 'the text around the secret was delivered');
    assert.equal(tail.of('end').length, 1, 'the tail says that the output has ended');

    // What the tail delivered is the captured output: the transcript, byte for byte.
    const transcript = runRow(fx.home, run.id).transcript;
    assert.ok(transcript, 'the run has its transcript');
    const record = await readRecord(engine, project, transcript);
    assert.equal(record.status, 200, `GET the transcript (body: ${record.text.slice(0, 200)})`);
    assert.equal(delivered.bytes.toString('utf8'), record.text, 'the tail delivered exactly what the transcript holds');

    assert.equal(events.text().includes(SECRET), false, 'the secret is in no event a client received, the usage it was reported in included');
  });
});
