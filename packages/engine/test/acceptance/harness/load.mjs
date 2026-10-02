// The load fixture and the latency judgement of row M71, shared with row M72
// (SEAM.md §93; E36 item 2).
//
// The qualified limits are numbers in ../contract/load-limits.json, not
// words in a test title: 5 projects, 20 connected clients, a store of one
// gibibyte, and the engine's default `api_latency_bound` of 250 ms. A test
// that samples a latency first shows that its fixture is at those limits.
// Passing on a smaller store qualifies nothing larger (Plan M71).
//
// Every duration here is measured on the monotonic clock (mono.mjs).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { httpRequest } from './engine.mjs';
import { isoNow, newId } from './ids.mjs';
import { now, sleep, until } from './mono.mjs';
import { storePath } from './store.mjs';

export const LIMITS = JSON.parse(readFileSync(new URL('../contract/load-limits.json', import.meta.url), 'utf8'));

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- the store at its declared size ------------------------------------------------

// How large the store's files are now: the database and its write-ahead log.
export function storeBytes(home) {
  const size = (file) => {
    try {
      return statSync(file).size;
    } catch {
      return 0;
    }
  };
  return size(storePath(home)) + size(`${storePath(home)}-wal`);
}

// Grow a stopped engine's store to at least `bytes` by appending filler
// events: rows of the `events` table like any other (SEAM.md §9), of type
// `engine.tick`, each with a payload of `rowBytes` bytes of filler and the
// fixture label. One transaction, one pass, no index but the table's own.
// The engine must not be running: the journal mode is switched off WAL for
// the bulk write (so the bytes are written once, not once to the log and
// once to the database) and switched back before the store is closed.
// Returns {rows, firstSeq, lastSeq, bytes, ms}.
export function fillStore(home, { bytes, rowBytes = 65_536 }) {
  const started = now();
  const db = new Database(storePath(home), { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    const mode = db.pragma('journal_mode', { simple: true });
    db.pragma('journal_mode = DELETE');
    db.pragma('synchronous = OFF');
    const pageSize = db.pragma('page_size', { simple: true });
    const firstSeq = db.prepare('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "events"').get().n;
    const insert = db.prepare(
      `INSERT INTO "events" ("id", "created_at", "seq", "at", "type", "subject", "actor_kind", "payload", "tx") VALUES (?, ?, ?, ?, 'engine.tick', '{}', 'engine', ?, ?)`,
    );
    const payload = JSON.stringify({ test_fixture: true, fill: 'x'.repeat(rowBytes) });
    const at = isoNow();
    const tx = newId('tx_');
    let seq = firstSeq;
    db.transaction(() => {
      while (db.pragma('page_count', { simple: true }) * pageSize < bytes) {
        for (let i = 0; i < 64; i++) insert.run(newId('ev_'), at, seq++, at, payload, tx);
      }
    })();
    db.pragma(`journal_mode = ${mode}`);
    return { rows: seq - firstSeq, firstSeq, lastSeq: seq - 1, bytes: db.pragma('page_count', { simple: true }) * pageSize, ms: Math.round(now() - started) };
  } finally {
    db.close();
  }
}

// ---- the engine's memory -------------------------------------------------------------

// A process's resident memory from /proc/<pid>/status, in bytes: `peak` is
// the high-water mark since the process started (VmHWM), `current` what it
// holds now (VmRSS).
export function residentMemory(pid) {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const kb = (key) => {
    const match = new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(status);
    if (!match) throw new Error(`/proc/${pid}/status has no ${key}`);
    return Number(match[1]) * 1024;
  };
  return { peak: kb('VmHWM'), current: kb('VmRSS') };
}

export const MIB = 1024 * 1024;
export const mib = (bytes) => `${(bytes / MIB).toFixed(1)} MiB`;

// ---- latency: a sample, its control, and the judgement -----------------------------------
//
// A latency measured from a test process includes whatever the host and the
// test process did meanwhile. On a loaded machine that can be more than the
// bound, and the fault is not the engine's. Widening the bound until such
// samples pass would prove nothing; so the bound is never widened. Instead
// every sample is paired with a control: at the same instant, from the same
// event loop, a request to a trivial server inside the test process itself.
// If the control took longer than CONTROL_BUDGET_MS, the host or the test
// process was not responsive at that moment, and the sample says nothing
// about the engine: it is void, and is neither a pass nor a failure. A
// judgement needs a stated number of valid samples; if the host is so loaded
// that they cannot be had, the case fails as not judged. Every valid sample
// must be within the bound, measured with whatever the control cost included
// in it: the allowance is never subtracted.
export const CONTROL_BUDGET_MS = 50;

export class Control {
  static async start(t) {
    const control = new Control();
    control.server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' });
      res.end('ok');
    });
    await new Promise((resolve, reject) => {
      control.server.once('error', reject);
      control.server.listen(0, '127.0.0.1', resolve);
    });
    control.port = control.server.address().port;
    t.after(() => new Promise((resolve) => {
      control.server.closeAllConnections?.();
      control.server.close(resolve);
    }));
    return control;
  }

  // One request to the control server: how long it took, in ms.
  async probe() {
    const started = now();
    await httpRequest({ port: this.port, path: '/', headers: { host: `127.0.0.1:${this.port}`, connection: 'close' } });
    return now() - started;
  }
}

// One sample: `request` is a function that sends one request to the engine
// and resolves with its response. Returns {ms, controlMs, valid, response}.
export async function sample(control, request) {
  const started = now();
  const controlled = control.probe();
  const engine = request().then((response) => ({ response, ms: now() - started }));
  const [{ response, ms }, controlMs] = await Promise.all([engine, controlled]);
  return { ms, controlMs, valid: controlMs <= CONTROL_BUDGET_MS, response };
}

const round = (ms) => Math.round(ms * 10) / 10;

// What a set of samples shows: {taken, valid, void, max, median}.
export function summary(samples) {
  const valid = samples.filter((s) => s.valid).map((s) => s.ms).sort((a, b) => a - b);
  return {
    taken: samples.length,
    valid: valid.length,
    void: samples.length - valid.length,
    max: valid.length === 0 ? null : round(valid.at(-1)),
    median: valid.length === 0 ? null : round(valid[Math.floor(valid.length / 2)]),
  };
}

// The judgement: at least `minValid` samples were valid, and every valid one
// is within the bound.
export function assertWithinBound(samples, { boundMs, minValid, what }) {
  const s = summary(samples);
  assert.ok(
    s.valid >= minValid,
    `${what}: not judged. Only ${s.valid} of ${s.taken} samples had a control within ${CONTROL_BUDGET_MS} ms (${minValid} are needed): this host was too loaded to say anything about the engine, and that is not a pass`,
  );
  const over = samples.filter((sampled) => sampled.valid && sampled.ms > boundMs).map((sampled) => `${round(sampled.ms)} ms (control ${round(sampled.controlMs)} ms)`);
  assert.deepEqual(over, [], `${what}: every valid sample is within api_latency_bound = ${boundMs} ms (valid ${s.valid}, median ${s.median} ms, worst ${s.max} ms)`);
  return s;
}

// Take samples of one request, `everyMs` apart, while `during()` is true,
// at least `min` and at most `max` of them.
export async function sampleWhile(control, request, during, { everyMs = 100, min = 0, max = 200 } = {}) {
  const samples = [];
  while (samples.length < max && (samples.length < min || (await during()))) {
    samples.push(await sample(control, request));
    await sleep(everyMs);
  }
  return samples;
}

// ---- connected clients, in a process of their own ----------------------------------------
//
// The clients of the load case run in a child process (stream-clients.mjs),
// so that reading hundreds of megabytes of replay does not occupy the event
// loop that measures the latencies. `spec` is {followers, pagers, slow,
// since, limit}: `followers` read the event stream from `since` and stay;
// `pagers` read the whole log again and again in pages of `limit`; `slow`
// clients ask for the whole log and never read it. Resolves once every
// client has its response head. `stop()` ends the process and returns its
// summary: {connected, clients: [{kind, status, bytes, events, lastId, ended}]}.
export async function startStreamClients(t, engine, spec) {
  const child = spawn(process.execPath, [join(HERE, 'stream-clients.mjs')], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', SURETY_STREAM_TOKEN: engine.token(), SURETY_STREAM_SPEC: JSON.stringify({ port: engine.port, authority: engine.authority, ...spec }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  const lines = () => stdout.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  const ready = await until(
    () => {
      if (child.exitCode !== null) throw Object.assign(new Error(`the stream clients exited (${child.exitCode}): ${stderr.slice(-2000)}`), { fatal: true });
      return lines().find((line) => line.ready);
    },
    { timeoutMs: 60_000, what: `the stream clients to connect (stderr: ${stderr.slice(-500)})` },
  );
  return {
    connected: ready.connected,
    statuses: ready.statuses,
    // What the clients have received so far.
    progress: async () => {
      child.kill('SIGUSR2');
      const before = lines().filter((line) => line.progress).length;
      return until(() => lines().filter((line) => line.progress)[before], { timeoutMs: 10_000, what: 'the stream clients to report their progress' });
    },
    stop: async () => {
      child.kill('SIGTERM');
      await exited;
      const done = lines().find((line) => line.summary);
      if (!done) throw new Error(`the stream clients left no summary (stderr: ${stderr.slice(-2000)})`);
      return done;
    },
  };
}

export { now, sleep, until };
