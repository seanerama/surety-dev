// The test side of the seam (build spec §8, SEAM.md): start the built `surety`
// binary against a fresh $SURETY_HOME, talk to it over real loopback HTTP, and
// stop or kill it with real signals.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

// The harness self-check can point the tests at its witness engine
// (selfcheck/witness-engine.mjs) to show that they are satisfiable and that
// they catch defects. Such a run is never an acceptance run: with the variable
// set, every test file gains one test that fails, so no runner can report a
// pass that the real engine did not earn.
const WITNESS = process.env.SURETY_WITNESS_ENGINE;
export const WITNESS_MARKER = 'NOT AN ACCEPTANCE RUN: the harness is driving the self-check witness engine';
if (WITNESS) {
  const { test } = await import('node:test');
  test(WITNESS_MARKER, () => {
    throw new Error('SURETY_WITNESS_ENGINE is set. Unset it to test the engine.');
  });
}
export const CLI = WITNESS ?? join(REPO_ROOT, 'packages', 'engine', 'dist', 'cli.js');
export const ENGINE_MIGRATIONS = join(REPO_ROOT, 'packages', 'engine', 'migrations');

export const EXIT = { usage: 2, locked: 3, config: 4, token: 5 };

const DEFAULT_WAIT_MS = 30_000;

export function makeTempDir(label) {
  return mkdtempSync(join(tmpdir(), `surety-acc-${label}-`));
}

export function removeDir(dir) {
  if (process.env.SURETY_KEEP_TMP === '1') return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    // A test that made part of its fixture unreadable and failed before it
    // restored access: give the owner its access back and remove again.
    if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
    spawnSync('chmod', ['-R', 'u+rwx', dir]);
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export function writeEngineConfig(home, config) {
  writeFileSync(join(home, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

// The child gets a constructed environment, never the test runner's.
export function engineEnv(home) {
  return { SURETY_HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', TZ: 'UTC' };
}

// The promise's value, or null if it has not settled after `ms`. The timer is
// cancelled as soon as the promise settles, so a wait that was decided early
// does not keep the test process alive until the timer would have fired.
export async function within(promise, ms) {
  const timer = new AbortController();
  try {
    return await Promise.race([promise, sleep(ms, null, { signal: timer.signal }).catch(() => null)]);
  } finally {
    timer.abort();
  }
}

// How long a wait has lasted is read from the monotonic clock, never from
// the wall clock (SEAM.md §24, "The harness's own waits"). The host's wall
// clock steps: back by about a second at every time-sync correction, and
// forward by minutes when the virtual machine resumes after its host slept.
// A deadline computed from Date.now() is over at once after a forward step,
// with the engine healthy, and is late after a step back. performance.now()
// does neither.
const monotonicMs = () => performance.now();

export async function waitFor(probe, { timeoutMs = DEFAULT_WAIT_MS, intervalMs = 50, what = 'condition' } = {}) {
  const started = monotonicMs();
  let lastError;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false && value !== null) return value;
    } catch (err) {
      lastError = err;
    }
    if (monotonicMs() - started > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${lastError ? `: ${lastError.message}` : ''}`);
    }
    await sleep(intervalMs);
  }
}

// One HTTP/1.1 request on its own connection. `headers` is sent exactly as
// given: no Host is added, so tests control the Host header.
export function httpRequest({ port, method = 'GET', path, headers = {}, body, timeoutMs = 15_000 }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const sent = { ...headers };
    if (payload !== undefined) {
      sent['content-type'] ??= 'application/json';
      sent['content-length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: sent, setHost: false, agent: false, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, body: json });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`request ${method} ${path} timed out`)));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// A request written byte for byte on a raw socket, for what http.request
// cannot produce: an absolute-form target, a repeated header line, a request
// head sent without its body. `text` is written as given and nothing is added.
// If `continueWith` is given it is written once, and only after the server
// has sent a complete `100 Continue`, which is what a client that sent
// `Expect: 100-continue` does. Resolves when the server closes the connection
// with the final response {status, headers, text, body} and `interim`, the
// status codes of every 1xx response that came before it, in order.
export function rawRequest({ port, text, continueWith, timeoutMs = 15_000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const chunks = [];
    const received = () => Buffer.concat(chunks).toString('utf8');
    let continued = continueWith === undefined;
    socket.setTimeout(timeoutMs, () =>
      socket.destroy(new Error(`raw request timed out after ${timeoutMs} ms; received so far: ${JSON.stringify(received().slice(0, 400))}`)),
    );
    socket.on('connect', () => socket.write(text));
    socket.on('data', (c) => {
      chunks.push(c);
      if (!continued && /^HTTP\/1\.[01] 100[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n/.test(received())) {
        continued = true;
        socket.write(continueWith);
      }
    });
    socket.on('error', reject);
    socket.on('close', () => {
      try {
        resolve(parseRawResponse(received()));
      } catch (err) {
        reject(err);
      }
    });
  });
}

// Everything a server wrote on one connection for one request: zero or more
// interim (1xx) responses, which have a head and no body, then the final one.
export function parseRawResponse(raw) {
  const interim = [];
  let rest = raw;
  for (;;) {
    const split = rest.indexOf('\r\n\r\n');
    if (split < 0) {
      throw new Error(
        `no complete final HTTP response head in ${JSON.stringify(rest.slice(0, 200))}` +
          (interim.length > 0 ? ` after interim ${interim.join(', ')}` : ''),
      );
    }
    const [statusLine, ...headerLines] = rest.slice(0, split).split('\r\n');
    const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);
    if (!match) throw new Error(`bad status line ${JSON.stringify(statusLine)}`);
    const status = Number(match[1]);
    rest = rest.slice(split + 4);
    if (status >= 100 && status <= 199) {
      interim.push(status);
      continue;
    }
    const headers = {};
    for (const line of headerLines) {
      const at = line.indexOf(':');
      headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
    let bodyText = rest;
    if (/chunked/i.test(headers['transfer-encoding'] ?? '')) bodyText = dechunk(bodyText);
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = undefined;
    }
    return { status, headers, text: bodyText, body, interim };
  }
}

function dechunk(text) {
  let out = '';
  let rest = text;
  for (;;) {
    const eol = rest.indexOf('\r\n');
    if (eol < 0) break;
    const size = parseInt(rest.slice(0, eol), 16);
    if (!Number.isFinite(size) || size === 0) break;
    out += rest.slice(eol + 2, eol + 2 + size);
    rest = rest.slice(eol + 2 + size + 2);
  }
  return out;
}

// The last stderr line that is a JSON object with a string `code`: the
// engine's startup refusal (SEAM.md "Process").
export function parseRefusal(stderr) {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value.code === 'string') return value;
    } catch {
      // not JSON; keep looking
    }
  }
  return null;
}

// A refusal body per D1 §11.5: {code, reason, what_to_do, subject}.
export function isRefusalBody(body) {
  return (
    body !== null &&
    typeof body === 'object' &&
    typeof body.code === 'string' &&
    typeof body.reason === 'string' &&
    body.reason.length > 0 &&
    typeof body.what_to_do === 'string' &&
    body.what_to_do.length > 0 &&
    'subject' in body
  );
}

// `cli` is overridable only so the harness self-check can drive a stand-in.
// `env` adds variables to the constructed environment and `cwd` replaces the
// working directory: only row M23 uses them, to start an engine in a hostile
// ambient environment (SEAM.md §31).
export function spawnEngine({ home, harness = true, args = [], cli = CLI, env = {}, cwd = home }) {
  const argv = [cli, 'serve', ...(harness ? ['--harness'] : []), ...args];
  const child = spawn(process.execPath, argv, { env: { ...engineEnv(home), ...env }, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (c) => (out.stdout += c));
  child.stderr.on('data', (c) => (out.stderr += c));
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  // Its output streams have ended too: everything it wrote has been captured.
  const closed = new Promise((resolve) => child.once('close', resolve));
  let status = null;
  exited.then((s) => (status = s));
  return { child, out, exited, closed, exitStatus: () => status };
}

export class Engine {
  constructor({ home, port, authority, proc }) {
    this.home = home;
    this.port = port;
    this.authority = authority ?? `127.0.0.1:${port}`;
    this.proc = proc;
  }

  get pid() {
    return this.proc.child.pid;
  }

  get exited() {
    return this.proc.exited;
  }

  isRunning() {
    return this.proc.exitStatus() === null;
  }

  output() {
    return { ...this.proc.out };
  }

  tokenPath() {
    return join(this.home, 'api.token');
  }

  token() {
    return readFileSync(this.tokenPath(), 'utf8').trim();
  }

  // token: undefined → the real token; null → no token header; string → that.
  request(method, path, { body, token, host, headers = {} } = {}) {
    const sent = { host: host ?? this.authority, connection: 'close', ...headers };
    const value = token === undefined ? this.token() : token;
    if (value !== null) sent['x-surety-token'] = value;
    return httpRequest({ port: this.port, method, path, headers: sent, body });
  }

  get(path, opts) {
    return this.request('GET', path, opts);
  }

  post(path, body, opts = {}) {
    return this.request('POST', path, { ...opts, body: body ?? {} });
  }

  async engineInfo() {
    const res = await this.get('/v1/engine');
    if (res.status !== 200) throw new Error(`GET /v1/engine → ${res.status} ${res.text}`);
    return res.body;
  }

  failureMessage(what) {
    const s = this.proc.exitStatus();
    return `${what}; engine ${s ? `exited code=${s.code} signal=${s.signal}` : 'still running'}\n--- stderr ---\n${this.proc.out.stderr.slice(-4000)}`;
  }

  async waitUntil(state, { timeoutMs = DEFAULT_WAIT_MS } = {}) {
    const probe = async () => {
      if (!this.isRunning()) throw Object.assign(new Error('engine exited'), { fatal: true });
      if (!existsSync(this.tokenPath())) return undefined;
      if (state === 'listening' || state === 'full') {
        const res = await this.get('/v1/health');
        if (res.status !== 200) return undefined;
        return state === 'listening' || res.body?.mode === 'full';
      }
      if (state === 'failed') {
        const res = await this.get('/v1/engine');
        return res.status === 200 && res.body?.startup?.failed ? true : undefined;
      }
      if (state.startsWith('barrier:')) {
        const name = state.slice('barrier:'.length);
        const res = await this.get('/v1/harness/barriers');
        return res.status === 200 && res.body?.barriers?.some((b) => b.name === name && b.state === 'waiting');
      }
      throw new Error(`unknown wait state ${state}`);
    };
    const started = monotonicMs();
    for (;;) {
      try {
        if (await probe()) return;
      } catch (err) {
        if (err.fatal) throw new Error(this.failureMessage(`engine exited while waiting for ${state}`));
      }
      if (monotonicMs() - started > timeoutMs) throw new Error(this.failureMessage(`timed out after ${timeoutMs} ms waiting for ${state}`));
      await sleep(50);
    }
  }

  // SIGTERM, then SIGKILL after a grace period. Resolves with the exit status.
  async stop({ graceMs = 15_000 } = {}) {
    if (!this.isRunning()) return this.proc.exitStatus();
    this.proc.child.kill('SIGTERM');
    const done = await within(this.exited, graceMs);
    if (done) return done;
    this.proc.child.kill('SIGKILL');
    return this.exited;
  }

  async kill() {
    if (!this.isRunning()) return this.proc.exitStatus();
    this.proc.child.kill('SIGKILL');
    return this.exited;
  }
}

// Start an engine and wait for `until`: 'full' (default), 'listening',
// 'failed', 'barrier:<name>', or 'none'.
//
// If the wait throws, the engine is killed before the error is passed on. A
// caller learns of the engine only from the value returned here, so an engine
// whose start-up wait failed is in nobody's cleanup list: left running, it
// outlived its test and kept the test file's process alive until the runner's
// limit. The error still says what the engine was doing when the wait gave
// up: its message is made before the kill.
export async function startEngine({ home, port, harness = true, args = [], authority, until = 'full', timeoutMs, cli, env, cwd } = {}) {
  const proc = spawnEngine({ home, harness, args, cli, env, cwd });
  const engine = new Engine({ home, port, authority, proc });
  if (until !== 'none') {
    try {
      await engine.waitUntil(until, { timeoutMs });
    } catch (err) {
      await engine.kill();
      throw err;
    }
  }
  return engine;
}

// Run `surety serve` expecting it to refuse to start. Resolves with its exit
// status, output and parsed refusal.
export async function startRefused({ home, harness = true, args = [], timeoutMs = 20_000, cli }) {
  const proc = spawnEngine({ home, harness, args, cli });
  const status = await within(proc.exited, timeoutMs);
  // What it wrote before it exited is read to the end before it is parsed.
  if (status !== null) await within(proc.closed, 2000);
  if (status === null) {
    proc.child.kill('SIGKILL');
    await proc.exited;
    throw new Error(`surety serve did not exit within ${timeoutMs} ms; it was expected to refuse.\n--- stderr ---\n${proc.out.stderr.slice(-4000)}`);
  }
  return { ...status, ...proc.out, refusal: parseRefusal(proc.out.stderr) };
}

// Everything a test usually needs: a home, a port, a config, a running engine,
// cleanup registered on the test context.
export async function engineFixture(t, { harness = true, config = {}, args = [], until = 'full', authority } = {}) {
  const home = makeTempDir('home');
  const port = await freePort();
  writeEngineConfig(home, { api_port: port, ...config });
  const engines = [];
  t.after(async () => {
    for (const e of engines) await e.kill();
    removeDir(home);
  });
  const engine = await startEngine({ home, port, harness, args, until, authority });
  engines.push(engine);
  const restart = async (opts = {}) => {
    const next = await startEngine({ home, port, harness, args, authority, ...opts });
    engines.push(next);
    return next;
  };
  return { home, port, engine, restart, track: (e) => engines.push(e) };
}

export async function installProject(engine, { repoPath, name = 'fixture-project', tier = 'T2', branch = 'main' }) {
  const res = await engine.post('/v1/harness/fixtures/project', {
    name,
    tier,
    dev_repo_path: repoPath,
    integration_branch: branch,
  });
  if (res.status !== 201 || typeof res.body?.project?.id !== 'string') {
    throw new Error(`fixture project install → ${res.status} ${res.text}`);
  }
  return res.body.project.id;
}

export async function armFault(engine, fault) {
  const res = await engine.post('/v1/harness/faults', fault);
  if (res.status < 200 || res.status > 299) throw new Error(`arm fault ${JSON.stringify(fault)} → ${res.status} ${res.text}`);
}

// Disarm every fault that is still armed (SEAM.md §61). A fault armed with
// `times` fails that many transactions or reads; a test that armed more than
// its case used up takes the rest away before it goes on.
export async function clearFaults(engine) {
  const res = await engine.request('DELETE', '/v1/harness/faults');
  if (res.status < 200 || res.status > 299) throw new Error(`clear faults → ${res.status} ${res.text}`);
}

export async function releaseBarrier(engine, name) {
  const res = await engine.post(`/v1/harness/barriers/${encodeURIComponent(name)}/release`, {});
  if (res.status < 200 || res.status > 299) throw new Error(`release barrier ${name} → ${res.status} ${res.text}`);
}

export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

// Every file under a directory with its content hash, for "nothing changed" checks.
export function snapshotDir(dir) {
  const out = {};
  const walk = (d, prefix) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = statSync(p);
      if (st.isDirectory()) walk(p, rel);
      else out[rel] = sha256Hex(readFileSync(p));
    }
  };
  walk(dir, '');
  return out;
}
