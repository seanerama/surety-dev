// A client for the engine's two server-sent-event streams (rows M64, M71,
// M72; SEAM.md §92): GET /v1/events and GET /v1/projects/:p/runs/:r/tail.
//
// The token goes in the X-Surety-Token header, never in the URL. A client can
// stop reading without closing (`pause`): its socket then fills, the engine
// can deliver nothing more to it, and the engine's side of the story begins.
// What a client has is what it parsed: whole messages only. A message cut off
// by the end of the connection is dropped, so the last `id` a client holds is
// always one it can reconnect from.

import { readFileSync } from 'node:fs';
import http from 'node:http';

import { now, sleep, until } from './mono.mjs';

// `data` longer than this is not kept, only its length: the load fixtures'
// filler events are 64 KiB each and there are thousands of them.
const KEEP_DATA_BELOW = 8192;
const SEPARATOR = Buffer.from('\n\n');

export class StreamClient {
  constructor() {
    this.status = null;
    this.headers = {};
    this.messages = []; // {id, event, data | null, dataBytes}, in the order received
    this.ids = []; // the numeric `id` of every message that has one
    this.bytes = 0; // body bytes received
    this.ended = false; // the connection is over, however it ended
    this.error = null;
    this.endedAt = null; // monotonic
    this.localPort = null;
    this.remotePort = null;
    this.raw = []; // body chunks, kept only when asked for
    this.keepRaw = false;
    this.pending = Buffer.alloc(0);
    this.req = null;
    this.res = null;
  }

  get lastId() {
    return this.ids.length === 0 ? null : this.ids.at(-1);
  }

  take(chunk) {
    this.bytes += chunk.length;
    if (this.keepRaw) this.raw.push(chunk);
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    for (;;) {
      const at = this.pending.indexOf(SEPARATOR);
      if (at < 0) break;
      this.parseBlock(this.pending.subarray(0, at));
      this.pending = this.pending.subarray(at + 2);
    }
  }

  parseBlock(block) {
    const message = { id: null, event: 'message', data: null, dataBytes: 0 };
    let offset = 0;
    let fields = 0;
    while (offset < block.length) {
      let end = block.indexOf(0x0a, offset);
      if (end < 0) end = block.length;
      const line = block.subarray(offset, end);
      offset = end + 1;
      if (line.length === 0 || line[0] === 0x3a) continue; // blank, or a comment
      const colon = line.indexOf(0x3a);
      const name = (colon < 0 ? line : line.subarray(0, colon)).toString('utf8');
      let value = colon < 0 ? Buffer.alloc(0) : line.subarray(colon + 1);
      if (value.length > 0 && value[0] === 0x20) value = value.subarray(1);
      fields++;
      if (name === 'id') message.id = value.toString('utf8');
      else if (name === 'event') message.event = value.toString('utf8');
      else if (name === 'data') {
        message.dataBytes += value.length;
        if (value.length <= KEEP_DATA_BELOW) message.data = (message.data === null ? '' : `${message.data}\n`) + value.toString('utf8');
      }
    }
    if (fields === 0) return; // a block of comments only: a keep-alive
    this.messages.push(message);
    if (message.id !== null && /^\d+$/.test(message.id)) this.ids.push(Number(message.id));
  }

  // The messages of one event name, with `data` parsed as JSON where it was kept.
  of(event) {
    return this.messages.filter((m) => m.event === event).map((m) => ({ ...m, json: m.data === null ? null : safeJson(m.data) }));
  }

  // Everything received, as text: for "this never appeared" checks.
  text() {
    return Buffer.concat(this.raw).toString('latin1');
  }

  // Stop reading. The socket stays open and nothing is taken from it.
  pause() {
    this.res?.pause();
  }

  resume() {
    this.res?.resume();
  }

  // Close from this side, at once.
  close() {
    this.req?.destroy();
    this.res?.destroy();
  }

  // Close by resetting the connection: the engine's next write to it fails.
  reset() {
    const socket = this.res?.socket ?? this.req?.socket;
    if (socket?.resetAndDestroy) socket.resetAndDestroy();
    else this.close();
  }

  waitEnd({ timeoutMs = 30_000, what = 'the stream to end' } = {}) {
    return until(() => this.ended, { timeoutMs, intervalMs: 20, what });
  }

  waitForId(id, { timeoutMs = 30_000 } = {}) {
    return until(() => this.lastId !== null && this.lastId >= id, { timeoutMs, intervalMs: 20, what: `event ${id} to arrive on the stream (last received: ${this.lastId})` });
  }

  waitForMessage(predicate, { timeoutMs = 30_000, what = 'a message' } = {}) {
    return until(() => this.messages.find(predicate), { timeoutMs, intervalMs: 20, what });
  }
}

const safeJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// Open a stream. Resolves with the client once the response head has
// arrived, whatever its status: a refusal is a client whose `status` is not
// 200 and whose body, if any, is in `refusal`. `paused`: stop reading as soon
// as the head is in.
export function openStream({ port, authority, token, path, headers = {}, paused = false, keepRaw = false }) {
  const client = new StreamClient();
  client.keepRaw = keepRaw;
  return new Promise((resolve, reject) => {
    const sent = { host: authority, accept: 'text/event-stream', ...headers };
    if (token !== null && token !== undefined) sent['x-surety-token'] = token;
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers: sent, setHost: false, agent: false });
    client.req = req;
    const over = (err) => {
      if (client.ended) return;
      client.ended = true;
      client.endedAt = now();
      if (err) client.error = err;
    };
    req.on('error', (err) => {
      over(err);
      if (client.status === null) reject(err);
    });
    req.on('response', (res) => {
      client.res = res;
      client.status = res.statusCode;
      client.headers = res.headers;
      client.localPort = res.socket.localPort;
      client.remotePort = res.socket.remotePort;
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          client.refusal = safeJson(Buffer.concat(chunks).toString('utf8')) ?? null;
          over(null);
          resolve(client);
        });
        res.on('error', (err) => {
          over(err);
          resolve(client);
        });
        return;
      }
      res.on('data', (chunk) => client.take(chunk));
      res.on('end', () => over(null));
      res.on('error', (err) => over(err));
      res.on('close', () => over(null));
      if (paused) res.pause();
      resolve(client);
    });
    req.end();
  });
}

// The stream of an engine (harness/engine.mjs `Engine`), with its token.
export const streamOf = (engine, path, opts = {}) => openStream({ port: engine.port, authority: engine.authority, token: opts.token === undefined ? engine.token() : opts.token, path, ...opts });

export const eventsPath = ({ since = 0, limit } = {}) => `/v1/events?since=${since}${limit === undefined ? '' : `&limit=${limit}`}`;
export const tailPath = (project, run, offset = 0) => `/v1/projects/${project}/runs/${run}/tail?offset=${offset}`;

// Read the event log in replay pages (SEAM.md §92): ask for `limit` events
// after the cursor, read the page to its end, go on from the last id, until
// a page comes back empty. Returns {ids, pages, bytes}.
export async function replayInPages(engine, { since = 0, limit, maxPages = 100_000, timeoutMs = 120_000 } = {}) {
  const ids = [];
  let cursor = since;
  let pages = 0;
  let bytes = 0;
  const started = now();
  for (;;) {
    if (pages >= maxPages) throw new Error(`the replay did not end after ${maxPages} pages`);
    if (now() - started > timeoutMs) throw new Error(`the replay did not end within ${timeoutMs} ms (${pages} pages, cursor ${cursor})`);
    const page = await streamOf(engine, eventsPath({ since: cursor, limit }));
    if (page.status !== 200) throw new Error(`replay page since=${cursor} → ${page.status} ${JSON.stringify(page.refusal)}`);
    await page.waitEnd({ timeoutMs: Math.max(1000, timeoutMs - (now() - started)), what: `the replay page after ${cursor} to end (a request with a limit never waits for new events)` });
    pages++;
    bytes += page.bytes;
    if (page.ids.length === 0) return { ids, pages, bytes };
    ids.push(...page.ids);
    cursor = page.lastId;
  }
}

// The same reading, keeping what was read: every message of every page from
// the cursor until a page comes back empty, in the order received, each with
// its `data` parsed as JSON in `json` (null where the data was too long to
// keep, undefined where it is not JSON). For a log small enough to hold: the
// journey's (row M01).
export async function replayMessages(engine, { since = 0, limit = 500, maxPages = 1000 } = {}) {
  const messages = [];
  let cursor = since;
  for (let pages = 0; pages < maxPages; pages++) {
    const page = await streamOf(engine, eventsPath({ since: cursor, limit }));
    if (page.status !== 200) throw new Error(`replay page since=${cursor} → ${page.status} ${JSON.stringify(page.refusal)}`);
    await page.waitEnd({ what: `the replay page after ${cursor} to end (a request with a limit never waits for new events)` });
    if (page.ids.length === 0) return messages;
    for (const message of page.messages) messages.push({ ...message, json: message.data === null ? null : safeJson(message.data) });
    cursor = page.lastId;
  }
  throw new Error(`the replay did not end after ${maxPages} pages`);
}

// The state of the engine's end of a client's connection, as /proc/net/tcp
// shows it: 'established', 'closing' (the engine has closed its end; any
// state but established), or 'gone' (it reset the connection, or the
// connection is over). This is how a client that has stopped reading learns
// that the engine let go of it. Its own end tells it nothing: a paused socket
// reads nothing, and while unread data is still on its way the kernel keeps
// the client's end established whatever the engine did.
export function engineEndState(client) {
  const hex = (port) => port.toString(16).toUpperCase().padStart(4, '0');
  const lines = readFileSync('/proc/net/tcp', 'utf8').split('\n').slice(1);
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    // local address: the engine's port; remote address: the client's.
    if (fields[1].endsWith(`:${hex(client.remotePort)}`) && fields[2].endsWith(`:${hex(client.localPort)}`)) return fields[3] === '01' ? 'established' : 'closing';
  }
  return 'gone';
}

export { sleep };
