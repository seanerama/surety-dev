// M613 (d), static mode of `local_service` on a real unit (slice 50;
// sandbox lane). M7 plan §3b M613 (d); D4 §13.1, §9.2; SEAM.md §§256 to
// 259 (M307's lane), 572, 573. Cases (a) to (c) are the kernel file
// M613-static-mode-of-local-service.
//
// A static site (SITE: an entry, a stylesheet, a module script importing a
// local module, an image) deployed by the real `local_service` adapter with
// a static configuration (`mode: static`, no start command) under the
// adapter qualification stand-in (SEAM.md §248), as M307 deploys its
// service: the unit runs the engine's static server in its plain mode with
// the sealed artifact at /surety/app. Through the operator's relay, while
// the round's checks run: `/` answers the entry's bytes, an asset its
// bytes, HEAD is answered, POST is 405, a `..` path 404, and the HTML
// carries no frame and no banner sentence. The round's checks run in real
// check domains, the engine's serving check among them. Then the teardown:
// no unit of the environment's prefix is left, nothing claims a current
// deployment (`running` null; M7 plan's `alpha.current`, see SEAM.md §573),
// and the history is kept.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §257). The only unit is the one the engine
// creates under this test's own home's prefix; the test acts on no unit and
// signals nothing. The held behaviour check is released with a benign plan
// (GET / only). The file ends with the operator's guard (row M313), which
// reports any leftover by exact name.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { defPath, definitionText } from './harness/checks/fixtures.mjs';
import { candidateRow, deploy, environmentRecord, operationsOf, roundsOf, unitPrefix, verificationsOf } from './harness/deploy/kernel.mjs';
import { heldCheck, hostDeployable, hostEnvironment, newestOperation, operatorGuard, releaseCheck, serviceOf, teardownOnHost, ticksUntil, unitsOfHome, verificationOf } from './harness/deploy/host.mjs';
import { withStore } from './harness/store.mjs';
import { SERVING_DESCRIPTION, SITE, SITE_ASSETS, STATIC_SERVER, hostGet, sha256 } from './harness/deploy/static.mjs';

const { SIMULATION_SENTENCE } = await import(STATIC_SERVER);

describe('M613 (d) a static configuration on a real unit: served from the sealed artifact by the engine\'s server, verified, torn down', () => {
  const shared = sharedFixture();
  let guard;
  const J = {};
  before(async () => {
    guard = operatorGuard();
    const serve = definitionText('serve', { kind: 'post_deploy_serving', command: ['surety-static-serving'], timeout_s: 120, gate_kinds: ['alpha_complete'], requires: ['environment', 'artifact_digest'], inputs: [] });
    const ctx = await hostDeployable(shared.context, guard, { files: { ...SITE, [defPath('serve')]: serve } });
    const env = await hostEnvironment(ctx, 'alpha', { mode: 'static', start: undefined, env: {} });
    Object.assign(J, { ctx, env, fx: ctx.fx });
    J.request = await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, 'alpha');
    J.held = await ticksUntil(ctx.fx, ctx.project, () => heldCheck(ctx, env, { key: 'behaves' }), { what: 'the behaviour check to hold', timeoutMs: 600_000 });
    J.op = newestOperation(ctx, env);
    J.svc = serviceOf(ctx, env, J.op);
    // Through the operator's relay, while the round's checks run.
    J.relay = await ctx.fx.engine.post(`/v1/projects/${ctx.project}/environments/alpha/relay`, {});
    const port = env.content.port;
    J.served = {
      root: await hostGet(port, '/'),
      assets: Object.fromEntries(await Promise.all(SITE_ASSETS.map(async (p) => [p, await hostGet(port, `/${p}`)]))),
      head: await hostGet(port, '/style.css', 'HEAD'),
      post: await hostGet(port, '/', 'POST'),
      dotdot: await hostGet(port, '/../index.html'),
      encoded: await hostGet(port, '/%2e%2e/%2e%2e/etc/passwd'),
      inner: await hostGet(port, '/js/%2e%2e/%2e%2e/%2e%2e/etc/passwd'),
    };
    await ctx.fx.engine.request('DELETE', `/v1/projects/${ctx.project}/environments/alpha/relay`, { body: {} });
    releaseCheck(ctx, J.svc, { get: ['/'], exit: 0 });
    J.verification = await verificationOf(ctx, J.op);
    J.serving = withStore(ctx.fx.home, (db) =>
      db
        .prepare(`SELECT r.*, x."toolchain" FROM "check_results" r JOIN "checks" c ON c."id" = r."check" JOIN "check_executions" x ON x."id" = r."execution" WHERE c."key" = 'serve' AND r."candidate" = ? ORDER BY r.rowid DESC LIMIT 1`)
        .get(ctx.candidate.id),
    );
    J.servingOutput = J.serving?.output ? withStore(ctx.fx.home, (db) => db.prepare('SELECT "path" FROM "records" WHERE "id" = ?').get(J.serving.output)) : null;
    J.completed = await ticksUntil(ctx.fx, ctx.project, () => (candidateRow(ctx.fx.home, ctx.candidate.id).progress === 'alpha_deployed' ? true : undefined), { what: 'alpha_deployed' });
    J.beforeTeardown = { record: environmentRecord(ctx.fx.home, env.id), read: (await ctx.fx.engine.get(`/v1/projects/${ctx.project}/environments/alpha`)).body.environment };
    J.teardown = await teardownOnHost(ctx, env);
    J.after = unitsOfHome(ctx.fx.home).filter((u) => u.unit.startsWith(unitPrefix(ctx.fx.home, env.id)));
    J.afterRead = (await ctx.fx.engine.get(`/v1/projects/${ctx.project}/environments/alpha`)).body.environment;
    J.afterRecord = environmentRecord(ctx.fx.home, env.id);
    J.afterHistory = {
      deploys: operationsOf(ctx.fx.home, ctx.project, 'deploy').map((o) => o.id),
      verifications: roundsOf(ctx.fx.home, J.op.id).flatMap((r) => verificationsOf(ctx.fx.home, r.id)).map((v) => [v.id, v.outcome]),
      artifacts: withStore(ctx.fx.home, (db) => db.prepare('SELECT "id", "digest", "status" FROM "artifacts" WHERE "project" = ?').all(ctx.project)),
    };
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('(d) the unit runs the engine\'s server in its plain mode over the sealed artifact', () => {
    assert.ok([200, 201].includes(J.relay.status), `the operator's relay opened (→ ${J.relay.status} ${J.relay.text})`);
    assert.equal(J.request.authorization.status, 'issued');
    assert.equal(J.svc.app.argv[1], STATIC_SERVER, `the application is the engine's static server (${JSON.stringify(J.svc.app.argv)})`);
    assert.deepEqual(J.svc.app.argv.slice(2), ['--static', '--root=.', '--entry=index.html']);
  });

  test('(d) / answers the entry\'s bytes; an asset its bytes; HEAD answered; POST 405; .. 404', () => {
    assert.equal(J.served.root.status, 200);
    assert.ok(J.served.root.bytes.equals(Buffer.from(SITE['index.html'])), '/ is the entry\'s bytes, nothing added');
    for (const p of SITE_ASSETS) {
      assert.equal(J.served.assets[p].status, 200, p);
      assert.ok(J.served.assets[p].bytes.equals(Buffer.from(SITE[p])), `${p}: its bytes`);
    }
    assert.equal(J.served.head.status, 200, 'HEAD is answered');
    assert.equal(J.served.head.headers['content-length'], String(Buffer.byteLength(SITE['style.css'])));
    assert.equal(J.served.head.bytes.length, 0, 'with no body');
    assert.equal(J.served.post.status, 405);
    for (const k of ['dotdot', 'encoded', 'inner']) assert.equal(J.served[k].status, 404, `${k}: a path out of the root is 404`);
  });

  test('(d) the HTML carries no frame and no banner sentence', () => {
    const html = J.served.root.bytes.toString('utf8');
    assert.equal(typeof SIMULATION_SENTENCE, 'string');
    assert.ok(SIMULATION_SENTENCE.length > 0);
    assert.equal(html.includes(SIMULATION_SENTENCE), false, 'no banner sentence');
    assert.equal(/<iframe/i.test(html), false, 'no frame');
    assert.equal(html.includes('surety-simulation-banner'), false, 'no banner element');
  });

  test('(d) the round verified: the engine\'s serving check ran in a real check domain and passed, listing each path with served and expected digests', () => {
    assert.equal(J.verification.row.outcome, 'verified');
    assert.equal(J.serving?.exit_status, 0, JSON.stringify(J.serving));
    assert.match(JSON.parse(J.serving.toolchain).path, /checks\/programs\/static-serving\.mjs$/);
    const text = J.servingOutput ? readFileSync(join(J.fx.home, 'records', J.servingOutput.path), 'utf8') : '';
    assert.ok(text.startsWith(`${SERVING_DESCRIPTION}\n`), text);
    for (const p of ['index.html', ...SITE_ASSETS]) assert.ok(text.includes(`${p}\t${sha256(SITE[p])}\t${sha256(SITE[p])}\t200\tmatch`), `${p} in ${text}`);
    assert.equal(J.completed, true);
  });

  test('(d) teardown: the unit gone, nothing claims a current deployment, the history kept', () => {
    assert.ok(J.teardown, 'the teardown was applied');
    assert.deepEqual(J.after, [], 'no unit of the environment\'s prefix is left');
    assert.ok(J.beforeTeardown.read.running, 'before the teardown the environment read named what runs');
    assert.equal(J.afterRead.running, null, 'after it, nothing runs');
    assert.equal(J.afterRecord.attempted?.outcome, 'teardown_applied');
    assert.deepEqual(J.afterRecord.last_verified, J.beforeTeardown.record.last_verified, 'last_verified kept');
    assert.ok(J.afterHistory.deploys.includes(J.op.id), 'the deployment operation kept');
    assert.ok(J.afterHistory.verifications.some(([id, outcome]) => id === J.verification.row.id && outcome === 'verified'), 'the verification kept');
    assert.ok(J.afterHistory.artifacts.length >= 1, 'the artifact record kept');
  });
});
