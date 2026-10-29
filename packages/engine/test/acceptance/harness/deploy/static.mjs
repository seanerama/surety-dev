// Fixtures and reads for the static-preview rows M613 to M616 (the M7 plan
// §3b; D4 §13, the owner's amendments of 2026-10-29; SEAM.md §§572, 573).
// Kernel lane unless a helper says otherwise: the scripted deployment
// adapter and check boundary stand in where M301's do. Nothing here creates
// a unit or signals a process but this test's own children (the engine's
// static server and serving program, each ended through its own handle).

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 as zcrc32, inflateRawSync } from 'node:zlib';

import { REPO_ROOT } from '../engine.mjs';
import { def } from '../checks/scope.mjs';
import { DEPLOY_DEFS } from './kernel.mjs';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// A static site with no server program (Lap-Lab's shape, D4 §13 "its
// completed candidate (a static site with no server program)"): an entry,
// a stylesheet, a module script importing one local module, an image.
export const SITE = Object.freeze({
  'index.html': '<!doctype html><html><head><link rel="stylesheet" href="style.css"><script type="module" src="./js/app.js"></script></head><body><img src="img/logo.svg" alt="logo"><p>Lap Lab</p></body></html>\n',
  'style.css': 'body { font-family: sans-serif; }\n',
  'js/app.js': "import { lap } from './lap.js';\ndocument.body.dataset.lap = lap;\n",
  'js/lap.js': 'export const lap = 1;\n',
  'img/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>\n',
});
// The local assets the entry references, and the one import one level deep.
export const SITE_ASSETS = Object.freeze(['style.css', 'js/app.js', 'img/logo.svg', 'js/lap.js']);

// A Node service's files: a package.json start script (D4 §13.4: a Node service).
export const NODE_FILES = Object.freeze({ 'package.json': '{"name":"svc","scripts":{"start":"node server.js"}}\n' });

// The configuration's static mode (D4 §13.1): `mode: static`, no start command.
export const STATIC = Object.freeze({ mode: 'static', start: undefined });

// The serving check as a project may declare it (D4 §13.2: the engine's
// program, environment-bound, alpha_complete).
export const SERVE = def('post_deploy_serving', { gates: ['alpha_complete'], requires: ['environment', 'artifact_digest'], command: ['surety-static-serving'], inputs: [] });
export const WITH_SERVE = Object.freeze({ acc: DEPLOY_DEFS.acc, smoke: DEPLOY_DEFS.smoke, serve: SERVE });
export const WITHOUT_POST_DEPLOY = Object.freeze({ acc: DEPLOY_DEFS.acc, smoke: DEPLOY_DEFS.smoke });

// The statement every record of serving verification carries (D4 §13.2, verbatim).
export const SERVING_STATEMENT = 'serving verified; not functional or visual acceptance';
// The serving check's description (the engine's, D4 §13.2 "says what it is").
export const SERVING_DESCRIPTION = 'serving check: the entry page and its referenced assets are served from the deployed artifact; not application behaviour, not visual acceptance';

// The engine's own files: its static server (D4 §13.1) and its serving
// program (§13.2), as the built engine holds them.
const DIST = join(REPO_ROOT, 'packages', 'engine', 'dist');
export const STATIC_SERVER = join(DIST, 'design', 'preview', 'server.mjs');
export const SERVING_PROGRAM = join(DIST, 'checks', 'programs', 'static-serving.mjs');

// ---- plain HTTP, as bytes ----------------------------------------------------------------

export const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// One request to 127.0.0.1:port; {status, headers, bytes} or {status: null, error}.
export const hostGet = (port, path, method = 'GET', headers = {}) =>
  new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, agent: false, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', (e) => resolve({ status: null, error: e.code }));
    req.end();
  });

// A GET of the engine's API carrying (or not) the API token, its body as bytes.
export const engineBytes = (fx, path, { token = true } = {}) =>
  hostGet(fx.engine.port, path, 'GET', { host: fx.engine.authority, connection: 'close', ...(token ? { 'x-surety-token': fx.engine.token() } : {}) });

// ---- the engine's serving program, run by this test against the engine's server ----------

// The engine's static server in its plain mode over `dir` (this test's child,
// ended through its own handle at `t.after`). Returns the port.
export async function serveDir(t, dir, { entry = 'index.html' } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [STATIC_SERVER, '--static', '--root=.', `--entry=${entry}`], { cwd: dir, env: { PATH: '/usr/bin:/bin', PORT: String(port) }, stdio: 'ignore' });
  t.after(() => child.kill('SIGTERM'));
  for (let i = 0; i < 200; i++) {
    if ((await hostGet(port, '/')).status !== null) return port;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the engine\'s static server did not answer');
}

// A copy of the sealed artifact's directory, changed by `edit(dir)`; removed at `t.after`.
export function changedCopy(t, artifactDir, edit) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-acc-static-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(artifactDir, join(dir, 'app'), { recursive: true });
  const app = join(dir, 'app');
  edit(app);
  return app;
}
export const overwrite = (dir, path, text) => {
  chmodSync(join(dir, path), 0o644);
  writeFileSync(join(dir, path), text);
};
export const remove = (dir, path) => unlinkSync(join(dir, path));

// The engine's serving program run against the server at `port` with the
// variables the engine gives it (D4 §13.2; the Builder's record): the
// sealed manifest as the store records it, the execution's and the
// deployment's digests. Returns {code, lines, rows: [[path, served, expected, status, result]], summary}.
export function runServingProgram({ port, manifest, executionDigest, deployedDigest, entry = 'index.html' }) {
  const r = spawnSync(process.execPath, [SERVING_PROGRAM], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      SURETY_SERVING_URL: `http://127.0.0.1:${port}`,
      SURETY_STATIC_ROOT: '.',
      SURETY_STATIC_ENTRY: entry,
      SURETY_ARTIFACT_DIGEST: executionDigest,
      SURETY_DEPLOYED_ARTIFACT_DIGEST: deployedDigest,
      SURETY_ARTIFACT_MANIFEST: manifest,
    },
    timeout: 60_000,
  });
  const lines = (r.stdout ?? '').trim().split('\n');
  let summary = null;
  try {
    summary = JSON.parse(lines.at(-1));
  } catch {
    summary = null;
  }
  return { code: r.status, lines, stderr: r.stderr, rows: lines.filter((l) => l.split('\t').length === 5 && l.split('\t')[0] !== 'path').map((l) => l.split('\t')), summary };
}

// ---- a zip read by this test's own reader ------------------------------------------------

// The end record, the central directory, each local header, raw inflate and
// zlib's CRC-32 (never the engine's reader). [{name, bytes}] in directory order.
export function unzip(buf) {
  const end = buf.length - 22;
  assert.equal(buf.readUInt32LE(end), 0x06054b50, 'the package ends with an end-of-central-directory record');
  const n = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50, 'a central directory entry');
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const csize = buf.readUInt32LE(at + 20);
    const usize = buf.readUInt32LE(at + 24);
    const nlen = buf.readUInt16LE(at + 28);
    const skip = buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nlen);
    at += 46 + nlen + skip;
    assert.equal(buf.readUInt32LE(local), 0x04034b50, `${name}: a local header`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    assert.ok(method === 0 || method === 8, `${name}: stored or deflated`);
    const bytes = method === 0 ? Buffer.from(data) : inflateRawSync(data);
    assert.equal(bytes.length, usize, `${name}: its size`);
    assert.equal(zcrc32(bytes), crc, `${name}: its CRC-32`);
    out.push({ name, bytes });
  }
  return out;
}

// ---- reads -------------------------------------------------------------------------------

export const readJson = (text) => (text === null || text === undefined ? text : typeof text === 'string' ? JSON.parse(text) : text);
export const fileBytes = (path) => readFileSync(path);

// Every key anywhere in a JSON value.
export function keysDeep(value, out = new Set()) {
  if (Array.isArray(value)) for (const v of value) keysDeep(v, out);
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
}
