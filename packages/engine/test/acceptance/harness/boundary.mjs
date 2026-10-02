// Requests for the HTTP boundary matrix of rows M68 and M69 (SEAM.md §§89,
// 90): what the engine must refuse before a route is reached, and what every
// response must carry.

import assert from 'node:assert/strict';
import net from 'node:net';

import { parseRawResponse } from './engine.mjs';
import { now } from './mono.mjs';

// The engine's own origin: the scheme, and the authority the Host check
// compares against (D1 §11.1: "the exact self origin including scheme and port").
export const selfOrigin = (engine) => `http://${engine.authority}`;

// The head of a request, written as given. `host` and `token` default to the
// engine's own; null leaves the header out. `headers` is an object or an
// array of [name, value] pairs (an array can repeat a name).
export function requestHead(engine, method, target, headers = {}, { host = engine.authority, token = engine.token() } = {}) {
  const lines = [`${method} ${target} HTTP/1.1`];
  if (host !== null) lines.push(`Host: ${host}`);
  if (token !== null) lines.push(`X-Surety-Token: ${token}`);
  for (const [name, value] of Array.isArray(headers) ? headers : Object.entries(headers)) lines.push(`${name}: ${value}`);
  lines.push('Connection: close');
  return `${lines.join('\r\n')}\r\n\r\n`;
}

// Send a request byte for byte and read the answer: {status, headers, text,
// body, interim}, as engine.mjs `rawRequest` gives it. Unlike that one, this
// reads whatever the engine wrote before the connection ended, however it
// ended: an engine that refuses a request it has not read to the end closes
// on unread bytes, and the client's kernel then reports a reset after the
// answer. The answer is still the answer.
export function sendRaw(engine, text, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: engine.port });
    const chunks = [];
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      socket.destroy();
      const received = Buffer.concat(chunks).toString('utf8');
      if (received === '') return reject(err ?? new Error('the engine closed the connection without an answer'));
      try {
        resolve(parseRawResponse(received));
      } catch (parseError) {
        reject(parseError);
      }
    };
    socket.setTimeout(timeoutMs, () => finish(new Error(`no answer within ${timeoutMs} ms; received so far: ${JSON.stringify(Buffer.concat(chunks).toString('utf8').slice(0, 300))}`)));
    socket.on('connect', () => socket.write(text));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', (err) => finish(err));
    socket.on('close', () => finish(null));
  });
}

// The headers every response carries, error responses included (D1 §11.1,
// §17(13); SEAM.md §89).
export function assertDefensiveHeaders(res, what) {
  const h = res.headers;
  assert.equal(h['x-content-type-options'], 'nosniff', `${what}: X-Content-Type-Options`);
  assert.equal(h['referrer-policy'], 'no-referrer', `${what}: Referrer-Policy`);
  assert.match(String(h['cache-control'] ?? ''), /(^|[\s,])no-store($|[\s,])/, `${what}: Cache-Control has no-store`);
  assert.match(String(h['x-frame-options'] ?? ''), /^deny$/i, `${what}: X-Frame-Options denies framing`);
}

// No CORS (D1 §11.1): no response grants anything to another origin.
export function assertNoCors(res, what) {
  const granted = Object.keys(res.headers).filter((name) => name.toLowerCase().startsWith('access-control-'));
  assert.deepEqual(granted, [], `${what}: the response carries no Access-Control header`);
}

// A request whose body is sent in HTTP chunks and never finished: `count`
// chunks of `size` bytes, `paceMs` apart, and then nothing: no last chunk, no
// end. Whatever the engine answers, it answers without having seen the end of
// the body. Resolves with {response, sentBytes, answeredAfterMs, closed}:
// `response` is the parsed answer or null if none came within `waitMs` of the
// last chunk; `answeredAfterMs` is measured from the last chunk written.
export function unfinishedChunkedBody({ port, head, first = '', size, count, paceMs = 2, waitMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const received = [];
    let sentBytes = 0;
    let lastWrite = null;
    let answeredAt = null;
    let settled = false;
    let timer = null;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      let response = null;
      try {
        response = parseRawResponse(Buffer.concat(received).toString('utf8'));
      } catch {
        response = null;
      }
      resolve({ response, sentBytes, answeredAfterMs: answeredAt === null || lastWrite === null ? null : answeredAt - lastWrite, closed });
    };
    const chunk = (data) => `${Buffer.byteLength(data).toString(16)}\r\n${data}\r\n`;
    socket.on('error', (err) => {
      // A reset after the answer was written is the engine closing on a
      // request it will not read further.
      if (received.length > 0) finish(true);
      else if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    socket.on('data', (data) => {
      if (answeredAt === null) answeredAt = now();
      received.push(data);
    });
    socket.on('close', () => finish(true));
    socket.on('connect', async () => {
      socket.write(head);
      if (first !== '') {
        socket.write(chunk(first));
        sentBytes += Buffer.byteLength(first);
      }
      const data = 'a'.repeat(size);
      for (let i = 0; i < count && !settled && !socket.destroyed; i++) {
        socket.write(chunk(data));
        sentBytes += size;
        lastWrite = now();
        await new Promise((r) => setTimeout(r, paceMs));
      }
      lastWrite = lastWrite ?? now();
      timer = setTimeout(() => finish(false), waitMs);
    });
  });
}

// A request that is abandoned half way: the head and part of the body are
// written, then the connection is reset. Resolves once the socket is gone.
export function abandonedUpload({ port, head, partial }) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.on('error', () => resolve());
    socket.on('close', () => resolve());
    socket.on('connect', () => {
      socket.write(head + partial, () => {
        setTimeout(() => {
          if (socket.resetAndDestroy) socket.resetAndDestroy();
          else socket.destroy();
        }, 100);
      });
    });
  });
}
