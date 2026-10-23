// `surety serve --shell <dir>` (UI1 build spec §4.1, prerequisite P1): the
// static shell the engine serves at `/` and `/assets/<name>` under its CSP
// (api/shell.ts), named by an ordinary start parameter accepted with or
// without --harness. `--harness-shell` stays for the acceptance lane and is
// still accepted only with --harness; one of the two names the directory.
//
// What is proved here without starting a non-harness engine on this host
// (no scope under the user's service manager, no host checks): the parser
// refuses a missing directory and a doubled flag before anything starts;
// `--shell` passes the parser without --harness (the start is then refused
// at the home-path check, which runs before the scope step and writes
// nothing); and under --harness the directory `--shell` names is served
// exactly as `--harness-shell` serves it, CSP included.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(root, 'dist', 'cli.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run the CLI to its exit; returns {code, stdout, stderr}.
function runCli(args, home) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { SURETY_HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' }, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

const shortHome = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'p1s-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
};

test('--shell refuses a directory that does not exist, and a doubled flag, before anything starts', async (t) => {
  const home = shortHome(t);
  const missing = await runCli(['serve', '--shell', join(home, 'no-such-dir')], home);
  assert.equal(missing.code, 2, missing.stderr);
  assert.match(missing.stderr, /--shell .* does not exist/);
  writeFileSync(join(home, 'file'), 'x');
  const notDir = await runCli(['serve', '--shell', join(home, 'file')], home);
  assert.equal(notDir.code, 2);
  assert.match(notDir.stderr, /is not a directory/);
  const twice = await runCli(['serve', '--shell', home, '--shell', home], home);
  assert.equal(twice.code, 2);
  assert.match(twice.stderr, /--shell is given twice/);
  const both = await runCli(['serve', '--harness', '--shell', home, '--harness-shell', home], home);
  assert.equal(both.code, 2);
  assert.match(both.stderr, /name the shell directory twice/);
  assert.equal(existsSync(join(home, 'api.token')), false, 'nothing was started');
});

test('--harness-shell is still accepted only with --harness', async (t) => {
  const home = shortHome(t);
  const r = await runCli(['serve', '--harness-shell', home], home);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--harness-shell is accepted only with --harness/);
});

test('--shell passes the parser without --harness: the start reaches the home-path check (refused there, before the scope step, writing nothing)', async (t) => {
  // A home past the 56-byte bound: the engine refuses it at
  // checkHomeSocketPaths, which runs before the lock, the scope and the
  // host checks. Reaching that refusal proves --shell was accepted.
  const home = mkdtempSync(join(tmpdir(), 'p1-shell-flag-home-long-enough-to-be-refused-by-the-engine-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.ok(Buffer.byteLength(home) > 56, `home is ${Buffer.byteLength(home)} bytes`);
  const r = await runCli(['serve', '--shell', home], home);
  assert.equal(r.code, 6, r.stderr);
  const line = r.stderr.trim().split('\n').at(-1);
  const refusal = JSON.parse(line);
  assert.equal(refusal.code, 'socket_path_too_long');
  assert.equal(existsSync(join(home, 'api.token')), false, 'nothing was written');
  // Control: the same start without --shell is refused the same way, and the
  // harness-only flag is refused earlier, by the parser.
  const control = await runCli(['serve'], home);
  assert.equal(control.code, 6);
  const harnessOnly = await runCli(['serve', '--harness-shell', home], home);
  assert.equal(harnessOnly.code, 2);
});

test('under --harness, the directory --shell names is served at / and /assets/<name> with the CSP, as --harness-shell serves it', async (t) => {
  const home = shortHome(t);
  const shell = join(home, 'shell');
  mkdirSync(join(shell, 'assets'), { recursive: true });
  writeFileSync(join(shell, 'index.html'), '<!doctype html><title>p1</title>');
  writeFileSync(join(shell, 'assets', 'a.js'), 'export const a = 1;\n');
  const port = await new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ api_port: port }));
  const child = spawn(process.execPath, [cli, 'serve', '--harness', '--shell', shell], { env: { SURETY_HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' }, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));
  let exited = null;
  child.on('exit', (code, signal) => (exited = { code, signal }));
  t.after(async () => {
    if (exited === null) {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
    }
  });
  const get = (path, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers: { host: `127.0.0.1:${port}`, connection: 'close', ...headers }, setHost: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });
  const started = Date.now();
  let health = null;
  while (health === null) {
    if (exited !== null) assert.fail(`the engine exited while starting: ${JSON.stringify(exited)}\n${stderr}`);
    if (existsSync(join(home, 'api.token'))) {
      health = await get('/v1/health').catch(() => null);
    }
    if (health === null) {
      assert.ok(Date.now() - started < 30_000, `no listener in 30 s\n${stderr}`);
      await sleep(50);
    }
  }
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.equal(page.body, readFileSync(join(shell, 'index.html'), 'utf8'), 'the document is the file, byte for byte');
  assert.match(String(page.headers['content-security-policy'] ?? ''), /default-src 'none'/, 'the document carries the CSP');
  assert.match(String(page.headers['content-security-policy'] ?? ''), /frame-ancestors 'none'/);
  const asset = await get('/assets/a.js');
  assert.equal(asset.status, 200);
  assert.equal(asset.body, 'export const a = 1;\n');
  assert.match(String(asset.headers['content-type'] ?? ''), /javascript/);
  const nested = await get('/assets/x/a.js');
  assert.notEqual(nested.status, 200, 'only the flat assets directory is a shell route');
  const token = readFileSync(join(home, 'api.token'), 'utf8').trim();
  const engine = await get('/v1/engine', { 'x-surety-token': token });
  assert.equal(engine.status, 200);
  assert.notEqual(JSON.parse(engine.body).bootstrap_exception, true, 'no bootstrap exception is claimed by serving a shell');
});
