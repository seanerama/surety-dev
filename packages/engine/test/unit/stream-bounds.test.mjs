// Developer tests for the supervisor's stream bounds and the harness fault
// `stream_slow` (D2 §3.7; SEAM.md §157). Nothing is flooded: a few hundred
// bytes against bounds of tens of bytes.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { RoleOutput } = await import(join(dist, 'invoke', 'choke.js'));
const seam = await import(join(dist, 'testing', 'seam.js'));

test('stream_slow: its form is checked, and outside harness mode it delays nothing', () => {
  assert.deepEqual(seam.parseStreamSlow({ point: 'stream_slow', delay_ms: 5 }), { delayMs: 5, remaining: null });
  assert.deepEqual(seam.parseStreamSlow({ point: 'stream_slow', delay_ms: 5, times: 3 }), { delayMs: 5, remaining: 3 });
  for (const bad of [{}, { delay_ms: 0 }, { delay_ms: 'x' }, { delay_ms: 60_001 }, { delay_ms: 5, times: 0 }]) assert.throws(() => seam.parseStreamSlow(bad), (e) => e.code === 'invalid_value');
  seam.setStreamSlow({ delayMs: 50, remaining: null });
  assert.equal(seam.seamStreamDelay(), 0, 'a no-op outside harness mode (SEAM.md §7)');
  seam.setStreamSlow(null);
});

test('a line over stream_line_max_bytes stops the reading and is reported, nothing past it acted on', async () => {
  const stream = new PassThrough();
  const bounds = [];
  const out = new RoleOutput(stream, () => {}, { lineMax: 32, queueMax: 1024, onBound: (why) => bounds.push(why) });
  stream.write('{"type":"heartbeat"}\n');
  stream.write(`${'x'.repeat(40)}\n`);
  stream.write('{"type":"heartbeat"}\n');
  const lines = [];
  for (let l = await out.next(); l !== null; l = await out.next()) lines.push(l);
  assert.equal(bounds.length, 1);
  assert.match(bounds[0], /stream_line_max_bytes/);
  assert.ok(lines.every((l) => l.length <= 32), `no line over the bound is acted on (${JSON.stringify(lines)})`);
});

test('a slow consumer lets the queue pass stream_queue_max_bytes: the reading stops and is reported', async () => {
  const stream = new PassThrough();
  const bounds = [];
  const out = new RoleOutput(stream, () => {}, { lineMax: 1024, queueMax: 100, onBound: (why) => bounds.push(why) });
  // Twenty 20-byte lines arrive while the consumer has not taken one.
  for (let i = 0; i < 20; i++) stream.write(`${String(i).padStart(19, '0')}\n`);
  await new Promise((r) => setImmediate(r));
  assert.equal(bounds.length, 1, 'the queue bound is reported once');
  assert.match(bounds[0], /stream_queue_max_bytes/);
  assert.equal(await out.next(), null, 'nothing queued is acted on after the bound');
});

// M133 (g) on the exhaustion host: the over-bound line was written to the
// transcript whole before the bound was judged. The transcript now ends at
// the bound itself, in one chunk and across chunks.
test('a line over stream_line_max_bytes reaches the transcript only up to the bound', async () => {
  for (const pieces of [[`ok\n${'x'.repeat(40)}\n`], ['ok\n', 'x'.repeat(20), `${'x'.repeat(20)}\n`]]) {
    const stream = new PassThrough();
    const kept = [];
    const bounds = [];
    const out = new RoleOutput(stream, (b) => kept.push(Buffer.from(b)), { lineMax: 32, queueMax: 1024, onBound: (why) => bounds.push(why) });
    for (const p of pieces) stream.write(p);
    const lines = [];
    for (let l = await out.next(); l !== null; l = await out.next()) lines.push(l);
    const written = pieces.join('').length;
    const transcript = Buffer.concat(kept).toString();
    assert.equal(bounds.length, 1, `the bound is reported once (${JSON.stringify(pieces.map((p) => p.length))})`);
    assert.equal(transcript, `ok\n${'x'.repeat(32)}`, 'the transcript holds the line before and the long line up to the bound');
    assert.ok(transcript.length < written, `fewer bytes than the role wrote (${transcript.length} of ${written})`);
    // Lines queued when the bound is reached are dropped with the reading;
    // none over the bound is ever acted on.
    assert.ok(lines.every((l) => l === 'ok'), `nothing over the bound is acted on (${JSON.stringify(lines)})`);
  }
});
