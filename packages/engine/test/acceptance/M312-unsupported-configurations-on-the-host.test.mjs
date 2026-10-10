// M312 (b), (c) with the real adapter, read from the host (slice 24; sandbox
// lane). M4 plan §3.2 M312; E120 item 2; AR §8.1; D4 §§3.2, 9.2, Appendix
// B; SEAM.md §§256, 257, 261. The kernel file
// `M312-unsupported-configurations-refused.test.mjs` holds (a) and the same
// refusals on the scripted adapter.
//
// Each configuration (b) and (c) name is refused at the request (422
// `config_invalid` naming the field) with the real `local_service`
// adapter: no authorization, no unit of the environment's prefix on the
// host, and nothing of the project's checkout run or mounted by any process
// the test can read.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §257): when the engine refuses as it must,
// no unit is created at all; the test acts on no unit and signals nothing.
// The file ends with the operator's guard (row M313). Its first engine start
// carries the real-adapter switch.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { tick } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { RUNTIME, requestDeployment, unitPrefix } from './harness/deploy/kernel.mjs';
import { hostDeployable, hostEnvironment, listUnits, operatorGuard } from './harness/deploy/host.mjs';

// Every readable process whose command line, or whose mount table, names `path`.
function processesTouching(path) {
  const found = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const argv = readFileSync(`/proc/${name}/cmdline`, 'utf8');
      if (argv.includes(path)) found.push(`${name} runs ${JSON.stringify(argv.split('\0').slice(0, 4))}`);
    } catch {
      // gone, or not ours
    }
    try {
      const mounts = readFileSync(`/proc/${name}/mountinfo`, 'utf8').split('\n').filter((l) => l.split(' ')[3]?.startsWith(path));
      if (mounts.length > 0) found.push(`${name} mounts ${mounts[0]}`);
    } catch {
      // gone, or not ours
    }
  }
  return found;
}

describe('M312 (b), (c) unsupported configurations refused with the real adapter, read from the host', () => {
  const shared = sharedFixture();
  let guard;
  let ctx;
  before(async () => {
    guard = operatorGuard();
    ctx = await hostDeployable(shared.context, guard);
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('(b), (c) each refused at the request naming its field; no authorization; no unit of its prefix; nothing of the checkout run or mounted', async () => {
    const missing = '/nonexistent/surety-m312/node';
    const cases = [
      ['(b) a runtime path absent from the host', { runtime: { path: missing, sha256: RUNTIME.sha256 }, start: [missing, 'server.js'] }, 'runtime.path'],
      ['(b) a runtime whose hash differs', { runtime: { path: RUNTIME.path, sha256: '0'.repeat(64) } }, 'runtime.sha256'],
      ['(c) an entry point not in the artifact', { start: [RUNTIME.path, 'not-in-the-artifact.js'] }, 'start.1'],
      ["(c) a file of the project's checkout", { start: [RUNTIME.path, join(ctx.p.repo.path, 'server.js')] }, 'start.1'],
      ["(c) a file of the operator's home", { start: [RUNTIME.path, join(userInfo().homedir, 'server.js')] }, 'start.1'],
      ['(c) a program other than the runtime', { start: ['/bin/sh', 'server.js'] }, 'start.0'],
    ];
    let n = 0;
    for (const [what, over, field] of cases) {
      const env = await hostEnvironment(ctx, `host-${++n}`, over);
      const res = await requestDeployment(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
      assert.deepEqual([res.status, res.body?.code, res.body?.subject?.field], [422, 'config_invalid', field], `${what}: refused naming ${field} (${res.text})`);
      await tick(ctx.fx.engine, ctx.project);
      const auths = withStore(ctx.fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "deployment_authorizations" WHERE "environment" = ?').get(env.id).n);
      assert.equal(auths, 0, `${what}: no authorization`);
      const units = (listUnits() ?? []).filter((u) => u.unit.startsWith(unitPrefix(ctx.fx.home, env.id)));
      assert.deepEqual(units, [], `${what}: no unit of ${unitPrefix(ctx.fx.home, env.id)} on the host`);
    }
    assert.deepEqual(processesTouching(ctx.p.repo.path), [], "nothing of the project's checkout is run or mounted by any process the test can read");
  });
});
