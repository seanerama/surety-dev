// M613, static mode of `local_service` (slice 49; kernel lane, cases (a) to
// (c); case (d), the real unit, is the sandbox file
// M613-static-mode-on-a-real-unit). M7 plan §3b M613; D4 §13.1 (the
// owner's amendment of 2026-10-29), §9.2; SEAM.md §§577, 578.
//
// (a) `GET /v1/adapters/local_service` before and after the adapter's
//     qualification: the runtime path and SHA-256 the engine itself runs,
//     the modes `service` and `static`, the static server's digest, the
//     qualification `none` then `current`; any other adapter 404;
// (b) `PUT …/config` with `mode: static` and no `start`: accepted with the
//     defaults root `.` and entry `index.html`, the environment read saying
//     `mode: static` and `static {entry, server_digest}`; with `start`:
//     refused; `mode` absent: today's rules;
// (c) a static configuration's deployment request: the ordinary path,
//     `alpha_authorize` evaluated, the artifact sealed with its tree digest,
//     the server's digest recorded on the deployment, and `not_issued` when
//     the gate says so.
//
// The engine's static server is read from the built engine
// (dist/design/preview/server.mjs, D4 §13.1 "the file-serving core of D7
// §5.7's preview server"); its digest is this test's SHA-256 of that file.

import assert from 'node:assert/strict';
import { readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';

import { assertRefused } from './harness/fixtures.mjs';
import { evaluationsOf, sharedFixture } from './harness/gates.mjs';
import { scriptedEngine, tickUntil } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { artifactsOf, configContent, configsOf, deploy, deployable, deployWork, operationsOf, putConfig, qualifyByFixture, requestDeployment, scriptCall } from './harness/deploy/kernel.mjs';
import { SITE, STATIC, STATIC_SERVER, WITH_SERVE, WITHOUT_POST_DEPLOY, readJson, sha256 } from './harness/deploy/static.mjs';

const SERVER_SHA = sha256(readFileSync(STATIC_SERVER));
const environmentRead = async (fx, project, name) => {
  const res = await fx.engine.get(`/v1/projects/${project}/environments/${name}`);
  assert.equal(res.status, 200, `the environment read of ${name} (→ ${res.status} ${res.text})`);
  return res.body.environment;
};

describe('M613 (a) the adapter capability read, before and after the qualification', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    J.fx = fx;
    J.before = await fx.engine.get('/v1/adapters/local_service');
    J.qualification = await qualifyByFixture(fx.engine);
    J.after = await fx.engine.get('/v1/adapters/local_service');
    J.other = await fx.engine.get('/v1/adapters/kubernetes');
    J.scripted = await fx.engine.get('/v1/adapters/scripted');
  });
  after(() => shared.cleanup());

  test('(a) the runtime the engine itself runs, by path and SHA-256; the modes service and static; the static server\'s digest', () => {
    assert.equal(J.before.status, 200, J.before.text);
    const a = J.before.body;
    assert.equal(a.adapter, 'local_service');
    const exe = `/proc/${J.fx.engine.pid}/exe`;
    assert.equal(realpathSync(a.runtime.path), readlinkSync(exe), `the runtime path is the binary the engine's own process runs (${a.runtime.path})`);
    assert.equal(a.runtime.sha256, sha256(readFileSync(exe)), "the runtime's SHA-256 is the engine's own binary's");
    assert.deepEqual(a.modes, ['service', 'static']);
    assert.equal(a.static?.server?.path, STATIC_SERVER, "the static server is the engine's own file");
    assert.equal(a.static.server.sha256, SERVER_SHA, "the static server's digest is its file's SHA-256");
    assert.equal(a.static.entry_default, 'index.html');
  });

  test('(a) the qualification `none` before, `current` after, naming the qualification', () => {
    assert.deepEqual(J.before.body.qualification, { status: 'none', id: null, at: null });
    assert.equal(J.after.status, 200, J.after.text);
    assert.equal(J.after.body.qualification.status, 'current');
    assert.equal(J.after.body.qualification.id, J.qualification);
    assert.match(J.after.body.qualification.at ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual({ ...J.after.body, qualification: null }, { ...J.before.body, qualification: null }, 'nothing else of the read changed with the qualification');
  });

  test('(a) another adapter is 404', () => {
    assertRefused(J.other, 404, 'not_found', 'GET /v1/adapters/kubernetes');
    assertRefused(J.scripted, 404, 'not_found', 'GET /v1/adapters/scripted');
  });
});

describe('M613 (b), (c) the static configuration and its deployment request', () => {
  const shared = sharedFixture();
  let fx;
  before(async () => {
    fx = await scriptedEngine(shared.context);
  });
  after(() => shared.cleanup());

  test('(b) mode static and no start: accepted with root "." and entry index.html; the environment read says mode static and static {entry, server_digest}', async () => {
    const ctx = await deployable(fx, { files: SITE, config: STATIC, defs: WITH_SERVE });
    const [version] = configsOf(fx.home, ctx.env.id);
    assert.equal(version.content.mode, 'static');
    assert.deepEqual(version.content.static, { root: '.', entry: 'index.html' }, 'the defaults are filled in the version\'s content');
    assert.equal('start' in version.content, false, 'no start command');
    const read = await environmentRead(fx, ctx.project, 'alpha');
    assert.equal(read.mode, 'static');
    assert.deepEqual(read.static, { entry: 'index.html', server_digest: null }, 'no server digest before any deployment');
  });

  test('(b) mode static with a start command: refused 422 config_invalid naming start, nothing written', async () => {
    const ctx = await deployable(fx, { files: SITE, config: STATIC, defs: WITH_SERVE });
    const res = await putConfig(fx.engine, ctx.project, 'beta', configContent({ mode: 'static' }));
    assertRefused(res, 422, 'config_invalid', 'a start command in static mode');
    assert.equal(res.body.subject.field, 'start');
    assert.equal((await fx.engine.get(`/v1/projects/${ctx.project}/environments/beta`)).status, 404, 'no environment beta was made');
  });

  test('(b) mode absent: today\'s rules — a service configuration is accepted and reads mode service with no static part; one with no start command is refused', async () => {
    const ctx = await deployable(fx, { files: SITE, config: STATIC, defs: WITH_SERVE });
    const svc = await putConfig(fx.engine, ctx.project, 'beta', configContent());
    assert.equal(svc.status, 201, svc.text);
    const [version] = configsOf(fx.home, svc.body.environment.id);
    assert.equal('mode' in version.content, false, 'the content is as written: no mode added');
    const read = await environmentRead(fx, ctx.project, 'beta');
    assert.equal(read.mode, 'service');
    assert.equal('static' in read, false);
    const { start: _start, ...noStart } = configContent();
    const refused = await putConfig(fx.engine, ctx.project, 'gamma', noStart);
    assertRefused(refused, 422, 'config_invalid', 'a service configuration without its start command');
    assert.equal(refused.body.subject.field, 'start');
  });

  test('(c) the ordinary request path: alpha_authorize evaluated and issued, a deploy work item, the artifact sealed by its tree digest, the server digest recorded on the deployment', async () => {
    const ctx = await deployable(fx, { files: SITE, config: STATIC, defs: WITH_SERVE });
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }]);
    const request = await deploy(fx.engine, ctx.project, ctx.candidate.id, 'alpha');
    const authorize = evaluationsOf(fx.home, ctx.candidate.id, 'alpha_authorize');
    assert.equal(authorize.length, 1, 'one alpha_authorize evaluation');
    assert.equal(authorize[0].outcome, 'satisfied', authorize[0].reasons);
    assert.equal(request.authorization.status, 'issued');
    assert.equal(deployWork(fx.home, ctx.project).length, 1, 'one deploy work item, as for any request');
    const op = await tickUntil(fx.engine, ctx.project, () => operationsOf(fx.home, ctx.project, 'deploy')[0], { max: 12, what: 'the deploy operation' });
    assert.equal(op.finalizer_inputs.authorization, request.authorization.id, 'the ordinary authorization, consumed by the ordinary intent');
    const [artifact] = artifactsOf(fx.home, ctx.project);
    assert.equal(artifact?.status, 'sealed', 'the artifact is sealed');
    assert.equal(artifact.digest, `sha256:${sha256(artifact.manifest)}`, 'its identity is the digest of its tree manifest');
    assert.equal(configsOf(fx.home, ctx.env.id)[0].content.identity_method, 'tree_digest');
    const paths = readJson(artifact.manifest).map((e) => e[0]);
    for (const p of Object.keys(SITE)) assert.ok(paths.includes(p), `the sealed tree holds ${p}`);
    assert.deepEqual(op.finalizer_inputs.static, { root: '.', entry: 'index.html', server: STATIC_SERVER, server_digest: `sha256:${SERVER_SHA}` });
    const intended = withStore(fx.home, (db) => db.prepare(`SELECT "payload" FROM "deploy_journal_events" WHERE "operation" = ? AND "event_kind" = 'intended'`).get(op.id));
    assert.equal(readJson(intended.payload).server_digest, `sha256:${SERVER_SHA}`, 'the deployment record carries server_digest');
    const read = await environmentRead(fx, ctx.project, 'alpha');
    assert.deepEqual(read.static, { entry: 'index.html', server_digest: `sha256:${SERVER_SHA}` });
  });

  test('(c) the gate says no: alpha_authorize not satisfied, the request answered not_issued, nothing issued and no deployment begun', async () => {
    const ctx = await deployable(fx, { files: SITE, config: STATIC, defs: WITHOUT_POST_DEPLOY });
    const res = await requestDeployment(fx.engine, ctx.project, ctx.candidate.id, 'alpha');
    assertRefused(res, 409, 'authorization_not_issued', 'the request');
    assert.ok(res.body.subject.reasons.some((r) => r.code === 'ACCEPTANCE_SCOPE_INCOMPLETE'), JSON.stringify(res.body.subject.reasons));
    const authorize = evaluationsOf(fx.home, ctx.candidate.id, 'alpha_authorize');
    assert.equal(authorize.at(-1)?.outcome, 'not_satisfied', 'alpha_authorize was evaluated and said no');
    assert.equal(withStore(fx.home, (db) => db.prepare(`SELECT COUNT(*) AS n FROM "deployment_authorizations" WHERE "candidate" = ? AND "status" = 'issued'`).get(ctx.candidate.id).n), 0);
    assert.deepEqual(operationsOf(fx.home, ctx.project, 'deploy'), []);
    assert.deepEqual(deployWork(fx.home, ctx.project), [], 'no deploy work item');
  });
});
