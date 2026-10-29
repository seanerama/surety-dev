// M547, the production shell parameter (UI1 plan §3, slice 47; UI1 build
// spec §4.1, P1; api/shell.ts; cli.ts; D2 §3.1 for the scope). `surety serve
// --shell <dir>` names the static shell without --harness.
//   (a) `--shell` with no value, a path that does not exist, a non-directory,
//       or given twice, and `--shell` together with `--harness-shell`, are
//       refused by usage (exit 2) before anything starts: the home is left as
//       it was and no `surety-*` unit appears under the user's service manager;
//   (b) `--harness-shell` stays accepted only with `--harness`;
//   (c) started WITHOUT --harness on a disposable home with `--shell <dir>`,
//       the engine reaches `mode: full` through every startup step in its own
//       `surety-<h16(home)>-<incarnation>.scope` (listed `active running` by
//       `systemctl --user` while the engine is up), serves `/` and each
//       `/assets/<name>` byte for byte, without a token, the document under
//       SHELL_CSP (the string read from `src/api/shell.ts`, so the row pins
//       the engine's string, not a copy of it) and every shell response under
//       the defensive headers (D1 §11.1); serves no nested or unknown path as
//       a shell route (`/assets/x/a.js`, `/nope.html`, `/index.html`,
//       `/assets/missing.js` all answer 401 `token_required`, even where the
//       file exists on disk); reports `bootstrap_exception: false` and its
//       revision as the repository's HEAD; and on SIGTERM exits leaving no
//       `surety-*` unit under the user's service manager;
//   (d) under --harness, `--shell` serves the directory exactly as
//       `--harness-shell` does: the same status, bytes and headers for `/`,
//       each `/assets/<name>`, and the non-routes.
//
// This is the only acceptance test that starts an engine without --harness.
// The engine makes its own scope (named from its own disposable home) and
// removes it when it stops; the test only reads the manager
// (`systemctl --user list-units`), never stops, starts or reloads anything
// (M4 build spec §4.1 rules 1 and 2). A host where `systemctl --user` cannot
// be run fails the row; it does not skip it. Homes are made directly under
// the temporary directory (TMPDIR, as every other acceptance home; at most
// 56 bytes, E134) and removed, their engines killed through the child handle
// by pid, by the harness's fail-closed teardown. Not under a fixed /tmp: on a
// host whose /tmp is tmpfs the engine refuses the home (`unsafe_filesystem`),
// and the gate names a disk-backed TMPDIR for that reason.
//
// Reading of the row: SHELL_CSP is a document policy (api/shell.ts: "The
// shell document's content security policy"); the engine sends it on `/`, the
// document, and the defensive headers on every response. That is what is
// asserted here: the CSP on the document, the defensive headers on all.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { CLI, REPO_ROOT, engineEnv, freePort, startEngine, waitFor, within, writeEngineConfig } from './harness/engine.mjs';
import { scopeUnit, scopeUnitPrefix } from './harness/sandbox/cgroup.mjs';
import { forgetHome, registerHome, teardownHome } from './harness/teardown.mjs';

const STARTUP_STEPS = ['scope', 'lock', 'listen', 'store', 'recovery', 'integrity', 'host_qualification', 'full', 'scheduler'];
const DEFENSIVE_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'x-frame-options': 'DENY' };

// The engine's own CSP string, read from the source so the row pins it.
function shellCspFromSource() {
  const source = readFileSync(join(REPO_ROOT, 'packages', 'engine', 'src', 'api', 'shell.ts'), 'utf8');
  const m = /^export const SHELL_CSP = (["'])(.*)\1;$/m.exec(source);
  assert.ok(m, 'src/api/shell.ts exports SHELL_CSP as one string literal');
  return m[2];
}

// A disposable home directly under the temporary directory, at most 56 bytes
// (E134), registered for the fail-closed teardown and removed after the test.
function scuiHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'm547-'));
  assert.ok(Buffer.byteLength(home) <= 56, `the home ${home} is ${Buffer.byteLength(home)} bytes`);
  registerHome(home, home);
  t.after(() => {
    teardownHome(home);
    forgetHome(home);
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

// A small shell in the home: a document, three flat assets (one of them
// bytes that are not UTF-8, so "byte for byte" is a comparison of bytes), a
// nested file under assets/ and a file beside index.html, which are no
// routes.
function writeShell(home) {
  const shell = join(home, 'shell');
  mkdirSync(join(shell, 'assets', 'x'), { recursive: true });
  writeFileSync(join(shell, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>M547</title><script type="module" src="/assets/a.js"></script></head><body>shell</body></html>\n');
  writeFileSync(join(shell, 'assets', 'a.js'), 'export const a = 547;\n');
  writeFileSync(join(shell, 'assets', 'style.css'), 'body { margin: 0 }\n');
  writeFileSync(join(shell, 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0xc3, 0x28, 0x80]));
  writeFileSync(join(shell, 'assets', 'x', 'a.js'), 'export const nested = true;\n');
  writeFileSync(join(shell, 'nope.html'), '<!doctype html>not a route\n');
  return shell;
}
const ASSETS = { 'a.js': 'text/javascript; charset=utf-8', 'style.css': 'text/css; charset=utf-8', 'logo.png': 'image/png' };
const NON_ROUTES = ['/assets/x/a.js', '/nope.html', '/index.html', '/assets/missing.js'];

// One GET on its own connection, the body kept as bytes. No token is sent
// unless `token` is given; the Host header is the engine's authority.
function fetchBytes(port, path, { token = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host: `127.0.0.1:${port}`, connection: 'close' };
    if (token !== null) headers['x-surety-token'] = token;
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers, setHost: false, agent: false, timeout: 15_000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        let body;
        try {
          body = JSON.parse(bytes.toString('utf8'));
        } catch {
          body = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, bytes, body });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`GET ${path} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

// Run the CLI as an operator would, to its exit.
function runCli(args, home) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: engineEnv(home), cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

// The `surety-*` units the user's service manager lists, `--all` so a unit
// that is stopping is still seen. Only a read. A manager that cannot be
// asked fails the row: an unknown is not a pass.
function suretyUnits() {
  const done = spawnSync('systemctl', ['--user', 'list-units', '--all', 'surety-*', '--no-legend', '--plain', '--no-pager', '--full'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(done.status, 0, `systemctl --user list-units answers (status ${done.status}, ${done.error?.message ?? (done.stderr?.trim() || 'no stderr')})`);
  return done.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols[0] && cols[0].startsWith('surety-'))
    .map((cols) => ({ unit: cols[0], load: cols[1], active: cols[2], sub: cols[3] }));
}

// The session the engine's scope needs: the same login session this test
// runs in (as the sandbox lane passes it; lane.mjs `sandboxEnv`).
function sessionEnv() {
  const runtime = process.env.XDG_RUNTIME_DIR;
  assert.ok(runtime && existsSync(runtime), `XDG_RUNTIME_DIR names the login session's runtime directory (it is ${JSON.stringify(runtime)}); the scope of (c) needs the user manager of this session`);
  return { XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${join(runtime, 'bus')}` };
}

const repositoryHead = () => {
  const done = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(done.status, 0, `git rev-parse HEAD answers for ${REPO_ROOT} (${done.error?.message ?? done.stderr.trim()})`);
  return done.stdout.trim();
};

// What a shell GET must carry, beyond its status: the file's bytes, its type,
// the defensive headers, and the CSP on the document only.
function assertShellResponse(res, path, file, type, csp) {
  assert.equal(res.status, 200, `GET ${path} → ${res.status} ${res.bytes.toString('utf8').slice(0, 200)}`);
  assert.ok(res.bytes.equals(readFileSync(file)), `GET ${path} is the file's bytes (${res.bytes.length} served, ${readFileSync(file).length} on disk)`);
  assert.equal(res.headers['content-type'], type, `GET ${path} content-type`);
  for (const [name, value] of Object.entries(DEFENSIVE_HEADERS)) assert.equal(res.headers[name], value, `GET ${path} carries ${name}`);
  assert.equal(res.headers['set-cookie'], undefined, `GET ${path} sets no cookie`);
  if (path === '/') assert.equal(res.headers['content-security-policy'], csp, 'the document carries SHELL_CSP, the string api/shell.ts exports');
}

const assertNotShellRoute = async (port, path) => {
  const res = await fetchBytes(port, path);
  assert.equal(res.status, 401, `GET ${path} without a token → ${res.status}: not a shell route`);
  assert.equal(res.body?.code, 'token_required', `GET ${path} is refused for the token (${res.bytes.toString('utf8').slice(0, 200)})`);
  for (const [name, value] of Object.entries(DEFENSIVE_HEADERS)) assert.equal(res.headers[name], value, `the refusal of ${path} carries ${name}`);
};

describe('M547 the production shell parameter', () => {
  test('(a) --shell with no value, a missing path, a non-directory, or given twice, and --shell with --harness-shell, are refused by usage (exit 2) before anything starts', async (t) => {
    const home = scuiHome(t);
    const shell = writeShell(home);
    writeFileSync(join(home, 'file'), 'not a directory\n');
    const before = { home: readdirSync(home).sort(), units: suretyUnits().map((u) => u.unit) };
    const cases = [
      { args: ['serve', '--shell'], stderr: /--shell needs a directory/ },
      { args: ['serve', '--shell', join(home, 'no-such-dir')], stderr: /--shell .*no-such-dir does not exist/ },
      { args: ['serve', '--shell', join(home, 'file')], stderr: /--shell .*file is not a directory/ },
      { args: ['serve', '--shell', shell, '--shell', shell], stderr: /--shell is given twice/ },
      { args: ['serve', '--harness', '--shell', shell, '--harness-shell', shell], stderr: /--harness-shell and --shell name the shell directory twice/ },
      { args: ['serve', '--harness', '--harness-shell', shell, '--shell', shell], stderr: /--shell is given twice|name the shell directory twice/ },
    ];
    for (const c of cases) {
      const r = await runCli(c.args, home);
      assert.equal(r.code, 2, `${c.args.join(' ')} → exit ${r.code} (signal ${r.signal})\n${r.stderr}`);
      assert.match(r.stderr, c.stderr, `${c.args.join(' ')} says why`);
      assert.match(r.stderr, /^surety \S+: /m, 'the refusal is the usage line, naming the command');
      assert.equal(r.stdout, '', 'nothing on stdout');
    }
    assert.deepEqual(readdirSync(home).sort(), before.home, 'the home is as it was: no lock, no token, no store');
    assert.equal(existsSync(join(home, 'api.token')), false);
    assert.deepEqual(suretyUnits().map((u) => u.unit).filter((u) => u.startsWith(scopeUnitPrefix(home))), [], 'no unit of this home was made');
    assert.deepEqual(suretyUnits().map((u) => u.unit).filter((u) => !before.units.includes(u)), [], 'no new surety-* unit under the user manager');
  });

  test('(b) --harness-shell stays accepted only with --harness', async (t) => {
    const home = scuiHome(t);
    const shell = writeShell(home);
    const r = await runCli(['serve', '--harness-shell', shell], home);
    assert.equal(r.code, 2, `exit ${r.code}\n${r.stderr}`);
    assert.match(r.stderr, /--harness-shell is accepted only with --harness/);
    assert.equal(existsSync(join(home, 'api.token')), false, 'nothing was started');
    // The same flag with --harness is accepted: (d) starts that engine and
    // serves the directory from it. Here only the parser's answer is pinned.
  });

  test('(c) without --harness, --shell <dir>: mode full through every step in its own scope, the shell served byte for byte under SHELL_CSP and the defensive headers without a token, no nested or unknown path a shell route, bootstrap_exception false, and SIGTERM leaves no surety-* unit', async (t) => {
    const csp = shellCspFromSource();
    const home = scuiHome(t);
    const shell = writeShell(home);
    const port = await freePort();
    writeEngineConfig(home, { api_port: port });
    const session = sessionEnv();
    const unitsBefore = suretyUnits();
    assert.deepEqual(unitsBefore.filter((u) => u.unit.startsWith(scopeUnitPrefix(home))), [], 'no unit of this home before the start');
    t.diagnostic(`surety-* units before: ${unitsBefore.length === 0 ? 'none' : unitsBefore.map((u) => `${u.unit} ${u.active} ${u.sub}`).join(', ')}`);

    const started = performance.now();
    const engine = await startEngine({ home, port, harness: false, args: ['--shell', shell], env: session, until: 'full', timeoutMs: 60_000 });
    const startupMs = Math.round(performance.now() - started);
    t.after(async () => {
      if (engine.isRunning()) await engine.kill();
    });
    t.diagnostic(`startup to mode full: ${startupMs} ms`);

    // The start: every step, the scope, no exception, the revision.
    const health = await fetchBytes(port, '/v1/health', { token: engine.token() });
    assert.equal(health.status, 200, `GET /v1/health → ${health.status}`);
    const info = await engine.engineInfo();
    assert.equal(info.mode, 'full');
    assert.deepEqual(info.startup.completed, STARTUP_STEPS, 'every startup step completed, in order');
    assert.equal(info.startup.failed, null, 'no step failed');
    assert.equal(info.bootstrap_exception, false, 'no bootstrap exception');
    assert.ok(info.scope && typeof info.scope.unit === 'string', `the engine reports its scope (${JSON.stringify(info.scope)})`);
    assert.match(info.scope.unit, /^surety-[0-9a-f]{16}-[^/\s]+\.scope$/, 'the scope is surety-<h16>-<incarnation>.scope');
    assert.equal(info.scope.unit, scopeUnit(home, info.incarnation), 'the scope is named from this home and this incarnation');
    assert.equal(info.revision?.revision, repositoryHead(), `the revision is the repository's HEAD (${JSON.stringify(info.revision)})`);
    const during = suretyUnits();
    const own = during.filter((u) => u.unit === info.scope.unit);
    assert.equal(own.length, 1, `systemctl --user lists the scope ${info.scope.unit} while the engine is up (listed: ${during.map((u) => u.unit).join(', ') || 'nothing'})`);
    assert.equal(own[0].active, 'active', `the scope is active (${own[0].active} ${own[0].sub})`);
    assert.equal(own[0].sub, 'running', `the scope is running (${own[0].active} ${own[0].sub})`);
    assert.deepEqual(
      during.map((u) => u.unit).filter((u) => u.startsWith(scopeUnitPrefix(home))),
      [info.scope.unit],
      'the engine made exactly one unit of this home',
    );
    t.diagnostic(`surety-* units during: ${during.map((u) => `${u.unit} ${u.active} ${u.sub}`).join(', ')}`);

    // The shell, without a token.
    assertShellResponse(await fetchBytes(port, '/'), '/', join(shell, 'index.html'), 'text/html; charset=utf-8', csp);
    for (const [name, type] of Object.entries(ASSETS)) {
      const path = `/assets/${name}`;
      assertShellResponse(await fetchBytes(port, path), path, join(shell, 'assets', name), type, csp);
    }
    for (const path of NON_ROUTES) await assertNotShellRoute(port, path);
    // The shell served nothing of the engine's own: a token-bearing request
    // still reaches the API, and the shell did not become an API route.
    const engineAgain = await engine.get('/v1/engine');
    assert.equal(engineAgain.status, 200);
    assert.equal(engineAgain.body.bootstrap_exception, false, 'serving the shell claims no bootstrap exception');

    // SIGTERM: the engine exits of itself, and its scope is gone.
    engine.proc.child.kill('SIGTERM');
    const stopped = performance.now();
    const status = await within(engine.exited, 15_000);
    assert.ok(status !== null, engine.failureMessage('the engine did not exit within 15 s of SIGTERM'));
    t.diagnostic(`exit after SIGTERM: ${Math.round(performance.now() - stopped)} ms, code=${status.code} signal=${status.signal}`);
    const after = await waitFor(
      () => {
        const units = suretyUnits();
        return units.some((u) => u.unit.startsWith(scopeUnitPrefix(home))) ? undefined : units;
      },
      { timeoutMs: 20_000, what: `the scope ${info.scope.unit} to leave the user manager's list` },
    );
    assert.deepEqual(after.filter((u) => u.unit.startsWith(scopeUnitPrefix(home))), [], 'no unit of this home remains');
    assert.deepEqual(
      after.map((u) => u.unit).filter((u) => !unitsBefore.some((b) => b.unit === u)),
      [],
      `no surety-* unit this start made remains (before: ${unitsBefore.map((u) => u.unit).join(', ') || 'none'}; after: ${after.map((u) => u.unit).join(', ') || 'none'})`,
    );
    t.diagnostic(`surety-* units after: ${after.length === 0 ? 'none' : after.map((u) => `${u.unit} ${u.active} ${u.sub}`).join(', ')}`);
  });

  test('(d) under --harness, --shell serves the directory exactly as --harness-shell does', async (t) => {
    const csp = shellCspFromSource();
    const home = scuiHome(t);
    const shell = writeShell(home);
    const engines = [];
    for (const flag of ['--shell', '--harness-shell']) {
      const engineHome = join(home, flag === '--shell' ? 's' : 'h');
      mkdirSync(engineHome);
      const port = await freePort();
      writeEngineConfig(engineHome, { api_port: port });
      const engine = await startEngine({ home: engineHome, port, args: [flag, shell], until: 'full' });
      t.after(() => engine.stop());
      engines.push({ flag, engine, port });
    }
    const [viaShell, viaHarnessShell] = engines;
    const paths = ['/', ...Object.keys(ASSETS).map((n) => `/assets/${n}`), ...NON_ROUTES];
    for (const path of paths) {
      const a = await fetchBytes(viaShell.port, path);
      const b = await fetchBytes(viaHarnessShell.port, path);
      assert.equal(a.status, b.status, `GET ${path}: --shell → ${a.status}, --harness-shell → ${b.status}`);
      assert.ok(a.bytes.equals(b.bytes), `GET ${path}: the same bytes from both`);
      for (const name of ['content-type', 'content-security-policy', 'content-length', ...Object.keys(DEFENSIVE_HEADERS)]) {
        assert.equal(a.headers[name], b.headers[name], `GET ${path}: the same ${name} from both`);
      }
    }
    // And both are the directory: the document with SHELL_CSP, each asset's bytes, the non-routes refused for the token.
    for (const { flag, port } of engines) {
      assertShellResponse(await fetchBytes(port, '/'), '/', join(shell, 'index.html'), 'text/html; charset=utf-8', csp);
      for (const [name, type] of Object.entries(ASSETS)) assertShellResponse(await fetchBytes(port, `/assets/${name}`), `/assets/${name}`, join(shell, 'assets', name), type, csp);
      for (const path of NON_ROUTES) await assertNotShellRoute(port, path);
      assert.equal((await fetchBytes(port, '/v1/engine', { token: readFileSync(join(home, flag === '--shell' ? 's' : 'h', 'api.token'), 'utf8').trim() })).body.bootstrap_exception, false, `${flag}: no bootstrap exception`);
    }
  });
});
