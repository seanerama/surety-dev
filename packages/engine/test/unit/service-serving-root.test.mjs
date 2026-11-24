// Developer tests for a service-mode configuration's serving directory (M7
// plan §3d M625; DECISIONS item 40): `serving {root, entry}` validated as a
// static root and entry are, its defaults filled, refused in static mode;
// part of the configuration identity; its entry checked against the sealed
// artifact before anything is authorized; frozen with the deployment and
// handed to the serving check (servingOf) from the frozen inputs, a later
// configuration version changing nothing for an existing deployment; and
// the environment read stating the current configuration's and the running
// generation's root and entry. No serving declared: today's behaviour.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertRefused } from '../acceptance/harness/fixtures.mjs';
import { sharedFixture } from '../acceptance/harness/gates.mjs';
import { scriptedEngine } from '../acceptance/harness/runs.mjs';
import { withStore } from '../acceptance/harness/store.mjs';
import { configContent, deployToRound, deployable, putConfig, requestDeployment } from '../acceptance/harness/deploy/kernel.mjs';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { validateConfig, configIdentity } = await import(join(dist, 'deploy', 'config.js'));
const { servingSpec } = await import(join(dist, 'deploy', 'static-site.js'));
const { servingOf } = await import(join(dist, 'store', 'transitions', 'checks.js'));

const base = (over = {}) => ({ adapter: 'local_service', adapter_version: '1', targets: ['app'], runtime: { path: '/usr/bin/python3', sha256: 'f'.repeat(64) }, start: ['/usr/bin/python3', 'server.py'], port: 8080, identity_method: 'tree_digest', ...over });
const refusedField = (body) => {
  try {
    validateConfig(body);
  } catch (err) {
    assert.equal(err.code, 'config_invalid');
    assert.equal(err.status, 422);
    return err.subject.field;
  }
  return null;
};

// ---- the configuration ----------------------------------------------------------------------

test('a service configuration accepts serving {root, entry}, its defaults filled in the content; absent or `service` mode alike', () => {
  assert.deepEqual(validateConfig(base({ serving: { root: 'public' } })).serving, { root: 'public', entry: 'index.html' });
  assert.deepEqual(validateConfig(base({ mode: 'service', serving: { root: 'public', entry: 'home.html' } })).serving, { root: 'public', entry: 'home.html' });
  assert.deepEqual(validateConfig(base({ serving: {} })).serving, { root: '.', entry: 'index.html' });
  assert.deepEqual(validateConfig(base({ serving: { root: 'a/b', entry: 'c/d.html' } })).serving, { root: 'a/b', entry: 'c/d.html' });
  const plain = base();
  assert.deepEqual(validateConfig({ ...plain }), plain, 'no serving: the content unchanged');
  assert.equal('serving' in validateConfig({ ...plain }), false);
});

test('serving is validated as static.root and static.entry are', () => {
  for (const root of ['../x', '/srv', 'a/../b', 'a//b', './public', 'a\\b', '', 5]) assert.equal(refusedField(base({ serving: { root } })), 'serving.root', JSON.stringify(root));
  for (const entry of ['/etc/passwd', 'a/../b.html', '.', '', 'x\0y', 7]) assert.equal(refusedField(base({ serving: { root: 'public', entry } })), 'serving.entry', JSON.stringify(entry));
  assert.equal(refusedField(base({ serving: { root: 'public', entry: 'index.html', build: 'x' } })), 'serving');
  assert.equal(refusedField(base({ serving: 'public' })), 'serving');
  assert.equal(refusedField(base({ serving: ['public'] })), 'serving');
  assert.equal(refusedField(base({ serving: { root: 'x'.repeat(257) } })), 'serving.root');
});

test('serving is refused in static mode, naming serving; static stays refused in service mode', () => {
  assert.equal(refusedField(base({ mode: 'static', start: undefined, serving: { root: 'public' } })), 'serving');
  assert.equal(refusedField(base({ static: { root: 'public' } })), 'static');
  assert.equal(refusedField(base({ mode: 'service', static: { root: 'public' } })), 'static');
});

test('servingSpec: the declared root and entry of a service configuration, null without one or in static mode', () => {
  assert.deepEqual(servingSpec(validateConfig(base({ serving: { root: 'public' } }))), { root: 'public', entry: 'index.html' });
  assert.equal(servingSpec(validateConfig(base())), null);
  assert.equal(servingSpec({ mode: 'static', static: { root: 'x', entry: 'y' }, serving: { root: 'z' } }), null);
  assert.equal(servingSpec(null), null);
});

test('the configuration identity changes with serving', () => {
  const id = (c) => configIdentity(validateConfig(c), []);
  const none = id(base());
  const pub = id(base({ serving: { root: 'public' } }));
  assert.notEqual(none, pub);
  assert.notEqual(pub, id(base({ serving: { root: 'public', entry: 'home.html' } })));
  assert.notEqual(pub, id(base({ serving: { root: 'www' } })));
  assert.equal(pub, id(base({ serving: { root: 'public', entry: 'index.html' } })), 'the defaults filled: the same content, the same identity');
});

// ---- through the engine's API on the kernel lane --------------------------------------------

const PUBLIC = Object.freeze({
  'public/index.html': '<!doctype html><link rel="stylesheet" href="app.css"><p>Lap Lab</p>\n',
  'public/app.css': 'p { color: teal; }\n',
});

describe('a service serving a directory, through the engine on the kernel lane', () => {
  const shared = sharedFixture();
  let fx;
  before(async () => {
    fx = await scriptedEngine(shared.context);
  });
  after(() => shared.cleanup());

  const envRead = async (project, name) => (await fx.engine.get(`/v1/projects/${project}/environments/${name}`)).body.environment;

  test('the environment read states the serving root and entry; without one, null; the identity differs', async () => {
    const ctx = await deployable(fx, { files: PUBLIC, config: { serving: { root: 'public' } }, name: 'alpha' });
    const stored = withStore(fx.home, (db) => db.prepare('SELECT "content" FROM "environment_configs" WHERE "id" = ?').get(ctx.config.id));
    assert.deepEqual(JSON.parse(stored.content).serving, { root: 'public', entry: 'index.html' }, 'the defaults filled in the version\'s content');
    const read = await envRead(ctx.project, 'alpha');
    assert.equal(read.mode, 'service');
    assert.deepEqual(read.serving, { root: 'public', entry: 'index.html' });
    assert.equal('static' in read, false);
    const plain = await putConfig(fx.engine, ctx.project, 'beta', configContent());
    assert.equal(plain.status, 201, plain.text);
    assert.equal((await envRead(ctx.project, 'beta')).serving, null);
    assert.notEqual(plain.body.config.config_identity, ctx.config.config_identity);
    const staticRefused = await putConfig(fx.engine, ctx.project, 'gamma', configContent({ mode: 'static', start: undefined, serving: { root: 'public' } }));
    assertRefused(staticRefused, 422, 'config_invalid', 'serving in static mode');
    assert.equal(staticRefused.body.subject.field, 'serving');
  });

  test('a serving entry that is not a file of the artifact under the root is refused 422 naming serving.entry; nothing authorized', async () => {
    const ctx = await deployable(fx, { files: PUBLIC, config: { serving: { root: 'public', entry: 'missing.html' } }, name: 'alpha' });
    const res = await requestDeployment(fx.engine, ctx.project, ctx.candidate.id, 'alpha');
    assertRefused(res, 422, 'config_invalid', 'the request');
    assert.equal(res.body.subject.field, 'serving.entry');
    assert.equal(withStore(fx.home, (db) => db.prepare(`SELECT COUNT(*) AS n FROM "deployment_authorizations" WHERE "candidate" = ?`).get(ctx.candidate.id).n), 0);
    // The root is where the entry is looked for: index.html at the
    // repository's root is not public/index.html.
    const other = await deployable(fx, { files: { 'index.html': 'x\n' }, config: { serving: { root: 'public' } }, name: 'alpha' });
    const r2 = await requestDeployment(fx.engine, other.project, other.candidate.id, 'alpha');
    assertRefused(r2, 422, 'config_invalid', 'the request');
    assert.equal(r2.body.subject.field, 'serving.entry');
  });

  test('the deployment freezes the serving spec; servingOf hands the check that root and entry; a later version changes nothing for it', async () => {
    const ctx = await deployable(fx, { files: PUBLIC, config: { serving: { root: 'public' } }, name: 'alpha' });
    const { operation } = await deployToRound(ctx);
    assert.deepEqual(operation.finalizer_inputs.serving, { root: 'public', entry: 'index.html' });
    assert.equal(operation.finalizer_inputs.static, undefined);
    const x = { deployment: JSON.stringify({ operation: operation.id }), artifact_digest: operation.finalizer_inputs.artifact_digest };
    const s1 = withStore(fx.home, (db) => servingOf(db, ctx.project, x));
    assert.equal(s1.root, 'public');
    assert.equal(s1.entry, 'index.html');
    assert.equal(s1.deployed_digest, operation.finalizer_inputs.artifact_digest);
    const running = await envRead(ctx.project, 'alpha');
    assert.ok(running.running, JSON.stringify(running));
    assert.deepEqual(running.running.serving, { root: 'public', entry: 'index.html' });
    // A later version naming another directory.
    const later = await putConfig(fx.engine, ctx.project, 'alpha', configContent({ serving: { root: 'www', entry: 'home.html' } }));
    assert.equal(later.status, 201, later.text);
    const s2 = withStore(fx.home, (db) => servingOf(db, ctx.project, x));
    assert.deepEqual([s2.root, s2.entry], ['public', 'index.html'], 'the deployment compares against what it froze');
    const read = await envRead(ctx.project, 'alpha');
    assert.deepEqual(read.serving, { root: 'www', entry: 'home.html' }, 'the current configuration');
    assert.deepEqual(read.running.serving, { root: 'public', entry: 'index.html' }, 'the running generation');
  });

  test('no serving declared: nothing frozen, the check handed "." and index.html as today', async () => {
    const ctx = await deployable(fx, { files: PUBLIC, name: 'alpha' });
    const { operation } = await deployToRound(ctx);
    assert.equal('serving' in operation.finalizer_inputs, false);
    const s = withStore(fx.home, (db) => servingOf(db, ctx.project, { deployment: JSON.stringify({ operation: operation.id }), artifact_digest: operation.finalizer_inputs.artifact_digest }));
    assert.deepEqual([s.root, s.entry], ['.', 'index.html']);
    const read = await envRead(ctx.project, 'alpha');
    assert.equal(read.serving, null);
    assert.equal(read.running.serving, null);
  });
});
