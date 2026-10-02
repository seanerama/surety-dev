// Developer tests for E37 item 2: a held secret is redacted as the role's
// output encodes it. A JSON line is matched on its decoded values, so every
// JSON escape of the secret is removed and the line stays valid JSON; any
// other line is matched as bytes, raw and escaped; and the post-write scan
// finds every form the redactor removes.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { StreamRedactor, holdSecret, redactText, redactValue, scanBytes } = await import(join(dist, 'records', 'redact.js'));

const SECRET = 'SYNTH"Q\\B/é-😀-7731';
holdSecret('unit', SECRET);

// The secret with every character written as \uXXXX (surrogate pairs included).
const allUnicode = Array.from({ length: SECRET.length }, (_, i) => `\\u${SECRET.charCodeAt(i).toString(16).padStart(4, '0')}`).join('');

// Escaped forms a JSON writer may produce.
const ENCODINGS = {
  canonical: JSON.stringify(SECRET).slice(1, -1),
  'all \\u': allUnicode,
  'solidus escaped': JSON.stringify(SECRET).slice(1, -1).replace('/', '\\/'),
  'one \\u': JSON.stringify(SECRET).slice(1, -1).replace('S', '\\u0053'),
};

function streamed(text, step) {
  const bytes = Buffer.from(text, 'utf8');
  const r = new StreamRedactor();
  const out = [];
  for (let at = 0; at < bytes.length; at += step) out.push(r.push(bytes.subarray(at, at + step)));
  out.push(r.end());
  return Buffer.concat(out).toString('utf8');
}

for (const [name, encoded] of Object.entries(ENCODINGS)) {
  test(`a JSON line holding the secret ${name} is redacted on its decoded value, however it is cut`, () => {
    const line = `{"type":"result","summary":"token: ${encoded} end"}\n`;
    assert.equal(JSON.parse(line).summary, `token: ${SECRET} end`, 'the fixture encodes the secret');
    assert.equal(scanBytes(Buffer.from(line)).hit, true, 'the scan finds the escaped form');
    for (const step of [1, 2, 3, 5, 7, 64, 4096]) {
      const out = streamed(line, step);
      assert.deepEqual(JSON.parse(out), { type: 'result', summary: 'token: [REDACTED] end' }, `cut every ${step}`);
      assert.equal(scanBytes(Buffer.from(out)).hit, false);
    }
  });
}

test('a line that is not JSON is redacted as bytes, raw and escaped', () => {
  const line = `log: raw ${SECRET} and escaped ${ENCODINGS.canonical} and ${allUnicode} (\n`;
  for (const step of [1, 4, 4096]) assert.equal(streamed(line, step), 'log: raw [REDACTED] and escaped [REDACTED] and [REDACTED] (\n');
});

test('JSON inside a JSON string: the secret escaped twice is removed', () => {
  const inner = JSON.stringify({ summary: SECRET });
  const line = `${JSON.stringify({ message: inner })}\n`;
  const out = streamed(line, 3);
  assert.equal(out.includes(ENCODINGS.canonical), false);
  assert.equal(JSON.parse(out).message.includes('[REDACTED]'), true);
  assert.equal(scanBytes(Buffer.from(line)).hit, true);
});

test('text and values served lose the escaped form too', () => {
  assert.equal(redactText(`x ${ENCODINGS.canonical} y`), 'x [REDACTED] y');
  assert.deepEqual(redactValue({ summary: `a ${SECRET} b ${ENCODINGS.canonical}` }), { summary: 'a [REDACTED] b [REDACTED]' });
});

test('output with no secret passes unchanged', () => {
  const line = '{"a": 1.0, "b": "\\u0041\\\\u0042 \\"q\\""}\n';
  assert.equal(streamed(line, 2), line);
  assert.equal(scanBytes(Buffer.from(line)).hit, false);
});
