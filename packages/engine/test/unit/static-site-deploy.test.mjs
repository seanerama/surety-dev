// Developer tests for static-site support on the local_service adapter
// (the owner's instruction of 2026-10-29; SHAPES.md §§1, 2): the adapter's
// capability read; a configuration's `mode: 'static'` validated, its
// defaults filled; and a static configuration deployed through the ordinary
// request on the kernel lane (the scripted deployment adapter and the
// labelled qualification fixture standing in where M301's do): the
// authorization is the ordinary one, the intent freezes the engine's server
// as its start command and records the server's SHA-256, and the
// environment read says the mode, the entry and that digest. The server's
// plain mode is run here as this test's child: the entry's and an asset's
// bytes, GET and HEAD only, nothing outside the root, no frame or banner.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertRefused } from '../acceptance/harness/fixtures.mjs';
import { sharedFixture } from '../acceptance/harness/gates.mjs';
import { scriptedEngine, tickUntil } from '../acceptance/harness/runs.mjs';
import { withStore } from '../acceptance/harness/store.mjs';
import { DEPLOY_DEFS, RUNTIME, configContent, deploy, deployable, operationsOf, putConfig, qualifyByFixture, requestDeployment, scriptCall } from '../acceptance/harness/deploy/kernel.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const server = join(dist, 'design', 'preview', 'server.mjs');
const { validateConfig } = await import(join(dist, 'deploy', 'config.js'));
const { staticArgs, SIMULATION_SENTENCE } = await import(server);
const { outputKindOfTree, staticStart } = await import(join(dist, 'deploy', 'static-site.js'));

const sha = (b) => createHash('sha256').update(b).digest('hex');
const SERVER_SHA = sha(readFileSync(server));

export const SITE = Object.freeze({
  'index.html': '<!doctype html><html><head><link rel="stylesheet" href="style.css"><script type="module" src="./js/app.js"></script></head><body><img src="img/logo.svg" alt="logo"><p>Lap Lab</p></body></html>\n',
  'style.css': 'body { font-family: sans-serif; }\n',
  'js/app.js': "import { lap } from './lap.js';\ndocument.body.dataset.lap = lap;\n",
  'js/lap.js': 'export const lap = 1;\n',
  'img/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>\n',
});
const STATIC = { mode: 'static', start: undefined };

// ---- the configuration (SHAPES.md §2) ---------------------------------------------------

const base = (over = {}) => ({ adapter: 'local_service', adapter_version: '1', targets: ['app'], runtime: { path: '/usr/bin/node', sha256: 'f'.repeat(64) }, port: 8080, identity_method: 'tree_digest', ...over });
const refusedField = (body) => {
  try {
    validateConfig(body);
  } catch (err) {
    assert.equal(err.code, 'config_invalid');
    return err.subject.field;
  }
  return null;
};

test('a static configuration names no start command; its root and entry default to "." and index.html, filled in its content', () => {
  const v = validateConfig(base({ mode: 'static' }));
  assert.equal(v.mode, 'static');
  assert.deepEqual(v.static, { root: '.', entry: 'index.html' });
  assert.equal(v.start, undefined);
  assert.deepEqual(validateConfig(base({ mode: 'static', static: { root: 'site', entry: 'home.html' } })).static, { root: 'site', entry: 'home.html' });
  assert.equal(refusedField(base({ mode: 'static', start: ['/usr/bin/node', 'server.js'] })), 'start', 'a start command refused in static mode');
  assert.equal(refusedField(base({ mode: 'static', static: { root: '../x' } })), 'static.root');
  assert.equal(refusedField(base({ mode: 'static', static: { entry: '/etc/passwd' } })), 'static.entry');
  assert.equal(refusedField(base({ mode: 'static', static: { entry: 'a/../b.html' } })), 'static.entry');
  assert.equal(refusedField(base({ mode: 'static', static: { root: '.', entry: 'index.html', build: 'npm run build' } })), 'static');
  assert.equal(refusedField(base({ mode: 'other', start: ['/usr/bin/node', 's.js'] })), 'mode');
});

test('a service configuration, absent mode or `service`, keeps today\'s rules; `static` is refused beside it', () => {
  const svc = base({ start: ['/usr/bin/node', 'server.js'] });
  assert.deepEqual(validateConfig({ ...svc }), svc, 'absent mode: the content unchanged');
  assert.deepEqual(validateConfig({ ...svc, mode: 'service' }), { ...svc, mode: 'service' });
  assert.equal(refusedField(base()), 'start', 'a service configuration still needs its start command');
  assert.equal(refusedField(base({ mode: 'service' })), 'start');
  assert.equal(refusedField({ ...svc, static: { entry: 'index.html' } }), 'static');
});

test('the start command a static deployment freezes: the configured runtime running the engine\'s server in its plain mode', () => {
  assert.deepEqual(staticStart('/usr/bin/node', server, { root: '.', entry: 'index.html' }), ['/usr/bin/node', server, '--static', '--root=.', '--entry=index.html']);
  assert.deepEqual(staticArgs(['--static', '--root=.', '--entry=index.html']), { root: '.', entry: 'index.html' });
  assert.equal(staticArgs([]), null, 'no arguments: the design preview');
  for (const bad of [['--static'], ['--static', '--root=..', '--entry=a.html'], ['--static', '--root=.', '--entry=/a.html'], ['--root=.', '--entry=a.html'], ['--static', '--root=.', '--entry=a.html', '--x']]) {
    assert.equal(staticArgs(bad), 'invalid', JSON.stringify(bad));
  }
});

test('outputKindOfTree: an index.html and no start script is a static site; a start script a node service; else unknown, never guessed', () => {
  const m = (...paths) => paths.map((p) => [p, 'file', '100644', 1, 'a'.repeat(64)]);
  const read = (text) => (p) => (p === 'package.json' && text !== null ? Buffer.from(text) : null);
  assert.equal(outputKindOfTree(m('index.html', 'app.js')), 'static_site');
  assert.equal(outputKindOfTree(m('index.html', 'package.json'), read('{"scripts":{"test":"x"}}')), 'static_site');
  assert.equal(outputKindOfTree(m('server.js', 'package.json'), read('{"scripts":{"start":"node server.js"}}')), 'node_service');
  assert.equal(outputKindOfTree(m('index.html', 'package.json'), read('{"scripts":{"start":"node s.js"}}')), 'node_service');
  assert.equal(outputKindOfTree(m('index.html', 'package.json')), 'unknown', 'a package.json not read: the start script is unknown');
  assert.equal(outputKindOfTree(m('index.html', 'package.json'), read('not json')), 'unknown');
  assert.equal(outputKindOfTree(m('server.js')), 'unknown');
  assert.equal(outputKindOfTree(m('site/index.html')), 'unknown', 'an index.html only at the root');
});

// ---- the server's plain mode, as this test's child --------------------------------------

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const get = (port, path, method = 'GET') =>
  new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', (e) => resolve({ status: null, error: e.code }));
    req.end();
  });

export function writeTree(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

test('the plain mode serves the entry at / and every file\'s bytes as they are: GET and HEAD only, nothing outside the root, no frame, banner or index', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'static-site-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dir = join(tmp, 'app');
  writeTree(dir, SITE);
  writeFileSync(join(tmp, 'secret.txt'), 'outside');
  symlinkSync(join(tmp, 'secret.txt'), join(dir, 'link.txt'));
  const port = await freePort();
  const child = spawn(process.execPath, [server, '--static', '--root=.', '--entry=index.html'], { cwd: dir, env: { PATH: '/usr/bin:/bin', PORT: String(port) }, stdio: 'ignore' });
  // Ended through its own handle.
  t.after(() => child.kill('SIGTERM'));
  let first;
  for (let i = 0; i < 100; i++) {
    first = await get(port, '/');
    if (first.status !== null) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(first.status, 200);
  assert.ok(first.bytes.equals(Buffer.from(SITE['index.html'])), '/ answers the entry\'s bytes, nothing added');
  assert.match(first.headers['content-type'], /^text\/html/);
  const text = first.bytes.toString('utf8');
  assert.ok(!text.includes(SIMULATION_SENTENCE) && !text.includes('surety-simulation-banner') && !text.includes('<iframe') && !text.includes('Design preview'), 'no frame, banner or index');
  for (const p of ['style.css', 'js/app.js', 'js/lap.js', 'img/logo.svg', 'index.html']) {
    const r = await get(port, `/${p}`);
    assert.equal(r.status, 200, p);
    assert.ok(r.bytes.equals(Buffer.from(SITE[p])), `${p}: its bytes`);
  }
  assert.match((await get(port, '/js/app.js')).headers['content-type'], /^text\/javascript/);
  const head = await get(port, '/style.css', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], String(Buffer.byteLength(SITE['style.css'])));
  assert.equal(head.bytes.length, 0);
  for (const m of ['POST', 'PUT', 'DELETE']) assert.equal((await get(port, '/', m)).status, 405, m);
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/js/%2e%2e/%2e%2e/secret.txt', '/link.txt', '/nothing.html', '/__surety/raw/index.html', '/js/']) assert.equal((await get(port, p)).status, 404, p);
  assert.equal((await get(port, '/%zz')).status, 400);
});

// ---- over HTTP on a disposable engine (the kernel lane) ---------------------------------

describe('static configurations through the engine\'s API on the kernel lane', () => {
  const shared = sharedFixture();
  let fx;
  before(async () => {
    fx = await scriptedEngine(shared.context);
  });
  after(() => shared.cleanup());

  test('GET /v1/adapters/local_service: qualification none, then current after the labelled fixture; any other adapter is 404', async () => {
    const res = await fx.engine.get('/v1/adapters/local_service');
    assert.equal(res.status, 200, res.text);
    const a = res.body;
    assert.deepEqual(Object.keys(a).sort(), ['adapter', 'adapter_version', 'modes', 'outputs', 'qualification', 'runtime', 'static'].sort());
    assert.equal(a.adapter, 'local_service');
    assert.equal(a.adapter_version, '1');
    assert.deepEqual(a.qualification, { status: 'none', id: null, at: null });
    assert.deepEqual(a.runtime, { path: process.execPath, sha256: RUNTIME.sha256, version: process.version }, "the engine's own node, what a configuration may pin here");
    assert.deepEqual(a.modes, ['service', 'static']);
    assert.equal(a.static.server.path, server);
    assert.equal(a.static.server.sha256, SERVER_SHA);
    assert.equal(a.static.entry_default, 'index.html');
    assert.deepEqual(a.outputs, [{ kind: 'node_service', hosted: true }, { kind: 'static_site', hosted: true, downloadable: true }]);
    const id = await qualifyByFixture(fx.engine);
    const after = (await fx.engine.get('/v1/adapters/local_service')).body;
    assert.equal(after.qualification.status, 'current');
    assert.equal(after.qualification.id, id);
    assert.match(after.qualification.at, /^\d{4}-\d{2}-\d{2}T/);
    assertRefused(await fx.engine.get('/v1/adapters/kubernetes'), 404, 'not_found', 'another adapter');
  });

  test('a static configuration is written and read back: the environment read says mode static, the entry, and no server digest before any deployment', async () => {
    const ctx = await deployable(fx, { files: SITE, config: STATIC, name: 'alpha' });
    const read = (await fx.engine.get(`/v1/projects/${ctx.project}/environments/alpha`)).body.environment;
    assert.equal(read.mode, 'static');
    assert.deepEqual(read.static, { entry: 'index.html', server_digest: null });
    // A service configuration's read: mode service, no static part.
    const svc = await putConfig(fx.engine, ctx.project, 'beta', configContent());
    assert.equal(svc.status, 201, svc.text);
    const r2 = (await fx.engine.get(`/v1/projects/${ctx.project}/environments/beta`)).body.environment;
    assert.equal(r2.mode, 'service');
    assert.equal('static' in r2, false);
    const refused = await putConfig(fx.engine, ctx.project, 'gamma', configContent({ mode: 'static' }));
    assertRefused(refused, 422, 'config_invalid', 'a start command in static mode');
    assert.equal(refused.body.subject.field, 'start');
  });

  test('a static configuration deploys a static candidate through the ordinary request: issued by alpha_authorize, the intent freezing the engine\'s server and its SHA-256', async () => {
    const ctx = await deployable(fx, { files: SITE, config: STATIC, name: 'alpha' });
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }]);
    const request = await deploy(fx.engine, ctx.project, ctx.candidate.id, 'alpha');
    assert.equal(request.authorization.status, 'issued');
    const op = await tickUntil(fx.engine, ctx.project, () => operationsOf(fx.home, ctx.project, 'deploy')[0], { max: 12, what: 'the deploy operation' });
    const frozen = op.finalizer_inputs;
    assert.deepEqual(frozen.static, { root: '.', entry: 'index.html', server, server_digest: `sha256:${SERVER_SHA}` });
    assert.deepEqual(frozen.start, [RUNTIME.path, server, '--static', '--root=.', '--entry=index.html']);
    assert.equal(frozen.authorization, request.authorization.id, 'the ordinary authorization, consumed by the ordinary intent');
    const intended = withStore(fx.home, (db) => db.prepare(`SELECT "payload" FROM "deploy_journal_events" WHERE "operation" = ? AND "event_kind" = 'intended'`).get(op.id));
    assert.equal(JSON.parse(intended.payload).server_digest, `sha256:${SERVER_SHA}`, 'the deployment record carries the server digest');
    const read = (await fx.engine.get(`/v1/projects/${ctx.project}/environments/alpha`)).body.environment;
    assert.deepEqual(read.static, { entry: 'index.html', server_digest: `sha256:${SERVER_SHA}` });
  });

  test('the authorization path is the ordinary one: without the alpha_complete scope\'s behaviour check, alpha_authorize refuses and nothing is issued', async () => {
    const ctx = await deployable(fx, { files: SITE, config: STATIC, name: 'alpha', defs: { acc: DEPLOY_DEFS.acc, smoke: DEPLOY_DEFS.smoke } });
    const res = await requestDeployment(fx.engine, ctx.project, ctx.candidate.id, 'alpha');
    assertRefused(res, 409, 'authorization_not_issued', 'the request');
    const reasons = res.body.subject.reasons.map((r) => r.code);
    assert.ok(reasons.includes('ACCEPTANCE_SCOPE_INCOMPLETE'), reasons.join(', '));
    assert.equal(withStore(fx.home, (db) => db.prepare(`SELECT COUNT(*) AS n FROM "deployment_authorizations" WHERE "candidate" = ? AND "status" = 'issued'`).get(ctx.candidate.id).n), 0);
  });

  test('a static entry that is not a file of the artifact is refused before anything is sealed', async () => {
    const ctx = await deployable(fx, { files: SITE, config: { ...STATIC, static: { root: '.', entry: 'missing.html' } }, name: 'alpha' });
    const res = await requestDeployment(fx.engine, ctx.project, ctx.candidate.id, 'alpha');
    assertRefused(res, 422, 'config_invalid', 'the request');
    assert.equal(res.body.subject.field, 'static.entry');
  });
});
