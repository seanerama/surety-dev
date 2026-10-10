// M312, unsupported configurations refused (slice 24; kernel lane). M4 plan
// §3.2 M312; E120 item 2; AR §8.1; D4 §§3.2, 9.2, 10 X2, Appendix B; Q4;
// SEAM.md §§245, 261. The same refusals with the real adapter, read from
// the host, are `M312-unsupported-configurations-on-the-host.test.mjs`.
//   (a) at `PUT …/config`: persistent state declared, a non-empty egress
//       list, zero targets, two targets, an adapter other than
//       `local_service`, a build step: each 422 `config_invalid` naming the
//       field, no version written;
//   (b) at the request: a runtime path absent from the host; a runtime
//       whose hash differs from the pinned one;
//   (c) at the request: a start command whose entry point is not in the
//       sealed artifact; one naming a host path (the project's checkout, the
//       operator's home); one whose program is not the configured runtime.
// (b) and (c) are each 422 `config_invalid` naming the field, before any
// authorization is recorded and before any intent: no authorization row, no
// work item, no operation, no adapter call.
//
// SAFETY: kernel lane; no unit, no systemctl, nothing signalled. The file
// ends with the operator's guard (row M313).

import assert from 'node:assert/strict';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { RUNTIME, adapterState, configContent, configure, deployable, putConfig, requestDeployment } from './harness/deploy/kernel.mjs';
import { operatorGuard } from './harness/deploy/host.mjs';

const environmentNamed = (home, project, name) => withStore(home, (db) => db.prepare('SELECT * FROM "environments" WHERE "project" = ? AND "name" = ?').get(project, name));
const countOf = (home, sql, ...p) => withStore(home, (db) => db.prepare(sql).get(...p).n);

// What the plan's (a) declares, each refused at PUT naming its field.
const AT_PUT = Object.freeze([
  ['persistent state declared', { persistent_state: true }, 'persistent_state'],
  ['a non-empty egress list', { egress: ['example.com'] }, 'egress'],
  ['zero targets', { targets: [] }, 'targets'],
  ['two targets', { targets: ['app', 'web'] }, 'targets'],
  ['an adapter other than local_service', { adapter: 'container' }, 'adapter'],
  ['a build step', { build: { command: ['npm', 'ci'] } }, 'build'],
]);

// What the plan's (b) and (c) declare, each refused at the request naming its field.
function atRequest(ctx) {
  const missing = '/nonexistent/surety-m312/node';
  return [
    ['(b) a runtime path absent from the host', { runtime: { path: missing, sha256: RUNTIME.sha256 }, start: [missing, 'server.js'] }, 'runtime.path'],
    ['(b) a runtime whose hash differs from the pinned one', { runtime: { path: RUNTIME.path, sha256: '0'.repeat(64) } }, 'runtime.sha256'],
    ['(c) a start command whose entry point is not in the sealed artifact', { start: [RUNTIME.path, 'not-in-the-artifact.js'] }, 'start.1'],
    ["(c) a start command naming a file of the project's checkout", { start: [RUNTIME.path, join(ctx.p.repo.path, 'server.js')] }, 'start.1'],
    ["(c) a start command naming a file of the operator's home", { start: [RUNTIME.path, join(userInfo().homedir, 'server.js')] }, 'start.1'],
    ['(c) a start command whose program is not the configured runtime', { start: ['/bin/sh', 'server.js'] }, 'start.0'],
  ];
}

describe('M312 unsupported configurations refused (kernel lane)', () => {
  const shared = sharedFixture();
  let guard;
  let fx;
  let ctx;
  before(async () => {
    guard = operatorGuard();
    fx = guard.track(await scriptedEngine(shared.context));
    ctx = await deployable(fx);
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('(a) at PUT …/config: persistent state, egress, zero or two targets, another adapter and a build step are each config_invalid naming the field; no version written', async () => {
    let n = 0;
    for (const [what, over, field] of AT_PUT) {
      const name = `refused-${++n}`;
      const res = await putConfig(fx.engine, ctx.project, name, configContent(over));
      assert.deepEqual([res.status, res.body?.code, res.body?.subject?.field], [422, 'config_invalid', field], `${what}: refused naming ${field} (${res.text})`);
      assert.equal(environmentNamed(fx.home, ctx.project, name), undefined, `${what}: no environment and no version written`);
    }
    const before = countOf(fx.home, 'SELECT COUNT(*) AS n FROM "environment_configs" WHERE "environment" = ?', ctx.env.id);
    for (const [what, over, field] of AT_PUT) {
      const res = await putConfig(fx.engine, ctx.project, ctx.env.name, configContent(over));
      assert.deepEqual([res.status, res.body?.subject?.field], [422, field], `${what}, as a new version of alpha: refused (${res.text})`);
    }
    assert.equal(countOf(fx.home, 'SELECT COUNT(*) AS n FROM "environment_configs" WHERE "environment" = ?', ctx.env.id), before, 'alpha gained no version');
  });

  test('(b), (c) at the request: an absent runtime, a runtime of another hash, an entry point not in the artifact, a host path, another program: each config_invalid naming the field, before any authorization and any intent; no adapter call', async () => {
    let n = 0;
    for (const [what, over, field] of atRequest(ctx)) {
      const name = `host-${++n}`;
      const env = (await configure(fx.engine, ctx.project, name, configContent(over))).environment;
      const res = await requestDeployment(fx.engine, ctx.project, ctx.candidate.id, name);
      assert.deepEqual([res.status, res.body?.code, res.body?.subject?.field], [422, 'config_invalid', field], `${what}: refused at the request naming ${field} (${res.text})`);
      await tick(fx.engine, ctx.project);
      assert.equal(countOf(fx.home, 'SELECT COUNT(*) AS n FROM "deployment_authorizations" WHERE "environment" = ?', env.id), 0, `${what}: no authorization recorded`);
      assert.equal(countOf(fx.home, `SELECT COUNT(*) AS n FROM "work_items" WHERE "project" = ? AND "kind" = 'deploy'`, ctx.project), 0, `${what}: no deploy work item (none in the project: nothing here was ever issued)`);
      assert.equal(countOf(fx.home, `SELECT COUNT(*) AS n FROM "operations" WHERE "project" = ? AND "kind" IN ('deploy', 'teardown')`, ctx.project), 0, `${what}: no operation, no intent`);
      assert.deepEqual((await adapterState(fx.engine, env.id)).calls, [], `${what}: no adapter call`);
    }
  });
});
