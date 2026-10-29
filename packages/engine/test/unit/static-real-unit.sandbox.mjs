// A developer test for the sandbox lane, run by hand (not by `npm run
// test:unit`, whose glob is `*.test.mjs`): it needs a host whose sandbox
// qualifies (a real systemd user manager, cgroup delegation, user and
// network namespaces; mini-hp01) and creates real transient units. Run:
//
//   TMPDIR=<a non-tmpfs directory, short> node --test test/unit/static-real-unit.sandbox.mjs
//
// A static configuration deployed on a real unit by the real local_service
// adapter (SHAPES.md §§2, 3): the unit runs the engine's server in its plain
// mode with the sealed artifact at /surety/app; through the operator relay
// `/` answers the entry's bytes and an asset its bytes, GET and HEAD only
// (POST 405), a traversal 404, and the entry carries no frame or banner;
// the round's checks run in real check domains, among them the engine's
// serving check, whose output lists each path with served and expected
// digests and which passes; then the teardown, and no unit of the home's
// prefix is left.
//
// SAFETY (BS4 §4.1; E64): the only unit is the one the engine creates under
// this test's own home's prefix; the test signals nothing and stops nothing
// itself; the operator's guard reports any leftover by exact name.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from '../acceptance/harness/gates.mjs';
import { defPath, definitionText } from '../acceptance/harness/checks/fixtures.mjs';
import { candidateRow, deploy, unitPrefix } from '../acceptance/harness/deploy/kernel.mjs';
import { heldCheck, hostDeployable, hostEnvironment, newestOperation, operatorGuard, releaseCheck, serviceOf, teardownOnHost, ticksUntil, unitsOfHome, verificationOf } from '../acceptance/harness/deploy/host.mjs';
import { withStore } from '../acceptance/harness/store.mjs';
import { SITE } from './static-fixtures.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
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

describe('a static site on a real unit: served from the sealed artifact, its serving check passed in a real check domain, torn down', () => {
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
    const relay = await ctx.fx.engine.post(`/v1/projects/${ctx.project}/environments/alpha/relay`, {});
    J.relay = relay;
    const port = env.content.port;
    J.served = {
      root: await get(port, '/'),
      asset: await get(port, '/js/app.js'),
      head: await get(port, '/style.css', 'HEAD'),
      post: await get(port, '/', 'POST'),
      traversal: await get(port, '/%2e%2e/%2e%2e/etc/passwd'),
      missing: await get(port, '/nothing.html'),
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
    J.teardown = await teardownOnHost(ctx, env);
    J.after = unitsOfHome(ctx.fx.home).filter((u) => u.unit.startsWith(unitPrefix(ctx.fx.home, env.id)));
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('the unit runs the engine\'s server in its plain mode: / is the entry\'s bytes, an asset its bytes, HEAD, POST 405, traversal 404, no frame or banner', () => {
    assert.ok([200, 201].includes(J.relay.status), J.relay.text);
    assert.equal(J.svc.app.argv[2], '--static');
    assert.equal(J.served.root.status, 200);
    assert.ok(J.served.root.bytes.equals(Buffer.from(SITE['index.html'])));
    assert.ok(!J.served.root.bytes.toString().includes('surety-simulation-banner') && !J.served.root.bytes.toString().includes('<iframe'));
    assert.ok(J.served.asset.bytes.equals(Buffer.from(SITE['js/app.js'])));
    assert.equal(J.served.head.status, 200);
    assert.equal(J.served.post.status, 405);
    assert.equal(J.served.traversal.status, 404);
    assert.equal(J.served.missing.status, 404);
  });

  test('the serving check ran the engine\'s program in a real check domain and passed; its output lists each path with served and expected digests', () => {
    assert.equal(J.serving?.exit_status, 0, JSON.stringify(J.serving));
    assert.match(JSON.parse(J.serving.toolchain).path, /checks\/programs\/static-serving\.mjs$/);
    const text = J.servingOutput ? readFileSync(join(J.fx.home, 'records', J.servingOutput.path), 'utf8') : '';
    assert.ok(text.startsWith('serving check: the entry page and its referenced assets are served from the deployed artifact; not application behaviour, not visual acceptance\n'), text);
    for (const p of ['index.html', 'style.css', 'js/app.js', 'js/lap.js', 'img/logo.svg']) assert.ok(text.includes(`${p}\t${sha(Buffer.from(SITE[p]))}\t${sha(Buffer.from(SITE[p]))}\t200\tmatch`), `${p} in ${text}`);
    assert.equal(J.verification.row.outcome, 'verified');
    assert.equal(J.completed, true);
  });

  test('torn down: no unit of the environment\'s prefix is left', () => {
    assert.ok(J.teardown);
    assert.deepEqual(J.after, []);
  });
});
