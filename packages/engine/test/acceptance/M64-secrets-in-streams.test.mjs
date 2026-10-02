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
//
// The second case is the slice-6 review's (E42 item 1): a transcript that a
// detector registered later marked as a hit is refused by the record read
// (slice 4), and the run's tail still served every byte of it. A quarantined
// record is served by no route: the tail is refused as the record read is.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertRefused } from './harness/fixtures.mjs';
import { until } from './harness/mono.mjs';
import { holdSecret, readRecord, registerDetector, waitForPostScan } from './harness/records.mjs';
import { addProject, addWork, run as runRow, runsOf, scriptedEngine, tick, tickUntil, waitForRun, workItem } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { eventsPath, streamOf, tailPath } from './harness/sse.mjs';

const SECRET = `sk-test-${'Z9y8'.repeat(9)}`;
const SPLIT = 17;
// What the later detector matches. It is not a secret the engine holds, so
// the transcript is stored and served with it until the detector exists.
const MARKER = 'MARKER-482913';

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

  test("a transcript a later detector matched is not served by the run's output tail: the tail is refused as the record read is, and delivers none of the transcript's bytes", async (t) => {
    const fx = await scriptedEngine(t);
    const engine = fx.engine;
    const project = (await addProject(fx)).id;
    const item = await addWork(engine, project, 'verification');
    fx.scripted.script(item, [script.complete([step.stdout(`ticket ${MARKER} filed\n`)])]);
    await tickUntil(engine, project, () => workItem(fx.home, item).status === 'complete', { what: 'the item to complete' });
    const [run] = runsOf(fx.home, item);
    assert.ok(run.transcript, 'the run has its transcript');
    await waitForPostScan(fx.home, run.transcript, 'clean');

    // Before the detector exists, the tail of the ended run serves its output, the marker included.
    const served = await streamOf(engine, tailPath(project, run.id, 0), { keepRaw: true });
    t.after(() => served.close());
    assert.equal(served.status, 200, `the tail of the ended run opens (refusal: ${JSON.stringify(served.refusal)})`);
    await served.waitEnd({ timeoutMs: 20_000, what: 'the tail of the ended run to end' });
    assert.ok(tailBytes(served).bytes.includes(MARKER), 'the fixture: the tail serves the output the detector will match');

    await registerDetector(engine, 'fixture-marker', 'MARKER-[0-9]{6}');
    await waitForPostScan(fx.home, run.transcript, 'hit');
    assertRefused(await readRecord(engine, project, run.transcript), 409, 'record_quarantined', 'reading the transcript a detector matched');

    // The same request now.
    const tail = await streamOf(engine, tailPath(project, run.id, 0), { keepRaw: true });
    t.after(() => tail.close());
    // An engine that still serves it is let finish, so that the failure can say what it delivered.
    if (tail.status === 200) await tail.waitEnd({ timeoutMs: 20_000, what: 'the tail to end' }).catch(() => {});
    const delivered = tailBytes(tail).bytes;
    const answer = { status: tail.status, body: tail.refusal ?? null, text: tail.status === 200 ? `a stream that delivered ${delivered.length} bytes: ${JSON.stringify(delivered.toString('utf8').slice(0, 200))}` : JSON.stringify(tail.refusal) };
    assertRefused(answer, 409, 'record_quarantined', "the tail of a run whose transcript a detector matched");
    assert.equal(delivered.length, 0, 'the tail delivered no output');
    assert.equal(answer.text.includes(MARKER), false, 'and nothing of the transcript is in the refusal');
  });
});
