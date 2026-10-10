// M316, bracketing on a real unit (slice 25; sandbox lane). M4 plan §3.3
// M316 (a), (b), (c); D4-V03; J7; D4 §5.3; CD4; SEAM.md §§256 to 259, 268.
// The scripted forms of (d), (e) are M316-bracketing-on-the-scripted-target;
// (f), an out-of-band observation, is deferred to slice 27 (COVERAGE.md).
//
// The two identity reads of one round bracket its post-deploy check, so what
// changes between them is caught. Each case deploys to an environment of its
// own with the target check held between the reads:
//   (a) nothing changes within the round: verified;
//   (b) the unit is restarted by the test, by its exact name, after its
//       containment read (restartOwnUnit), while the check is held between
//       the reads: the restart is a new invocation, so the second read
//       differs (its invocation_id, and the original application gone),
//       never verified (failed);
//   (c) a byte of the sealed copy is changed between the reads: the second
//       read's tree differs, failed.
// (c) uses an artifact of its own (an exclude), so no other case reads the
// changed copy; it is M311 (e)'s observation under bracketing.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §§257, 258). Every unit is the engine's,
// under this test's home's prefix. The unit is restarted only by its exact
// name, after assertServiceContained has read its containment from the host
// (restartOwnUnit). Nothing is signalled. Whatever happens, each environment
// is ended through endEnvironment. The file ends with the operator's guard;
// its first engine start carries the real-adapter switch.

import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { artifactsOf } from './harness/deploy/kernel.mjs';
import {
  RELEASE,
  RELEASE_AGAIN,
  deployHeld,
  endEnvironment,
  hostDeployable,
  hostEnvironment,
  operatorGuard,
  releaseCheck,
  restartOwnUnit,
  verificationOf,
} from './harness/deploy/host.mjs';

const readOf = (row, bracket) => row.identity_reads.find((r) => r.bracket === bracket);

describe('M316 bracketing on a real unit', () => {
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

  // A case that deploys `name` held between the reads and runs body(h);
  // whatever happens the environment is ended and the release files cleared.
  async function heldCase(name, over, body) {
    const env = await hostEnvironment(ctx, name, over);
    let ok = false;
    try {
      const h = await deployHeld(ctx, env);
      await body(h, env);
      ok = true;
    } finally {
      for (const f of [RELEASE, RELEASE_AGAIN]) if (!existsSync(join(ctx.prog.releaseDir, f))) writeFileSync(join(ctx.prog.releaseDir, f), JSON.stringify({ get: [], exit: ok ? 0 : 1 }));
      try {
        await endEnvironment(ctx, env);
      } finally {
        for (const f of [RELEASE, RELEASE_AGAIN]) rmSync(join(ctx.prog.releaseDir, f), { force: true });
      }
    }
  }

  test('(a) nothing changes within the round: verified', async () => {
    await heldCase('ok', {}, async (h) => {
      releaseCheck(ctx, h.svc, { get: ['/hello'], exit: 0 });
      const { row } = await verificationOf(ctx, h.op);
      assert.equal(readOf(row, 'first')?.match, 'match', 'the first read matches');
      assert.equal(readOf(row, 'second')?.match, 'match', 'the second read matches');
      assert.equal(row.outcome, 'verified', `both reads bracket the passing check: verified (${row.outcome})`);
    });
  });

  test('(b) the unit restarted (exact name) between the reads: the second read differs (a new invocation, the original application gone), never verified', async (t) => {
    await heldCase('restart', {}, async (h) => {
      const before = h.svc.app;
      restartOwnUnit(ctx, h.svc);
      releaseCheck(ctx, h.svc, { get: ['/hello'], exit: 0 });
      const { row } = await verificationOf(ctx, h.op);
      const second = readOf(row, 'second');
      assert.equal(second?.match, 'differs', `the restart is a new invocation: the second read differs (${JSON.stringify(second)})`);
      assert.ok(['invocation_id', 'instance', 'start_time', 'unit'].includes(second.detail?.field), `the read names the change (${JSON.stringify(second.detail)})`);
      assert.equal(row.outcome, 'failed', 'never verified: failed');
      assert.notEqual(before.start_time, undefined);
    });
  });

  test('(c) a byte of the sealed copy changed between the reads: the second read\'s tree differs, failed', async () => {
    await heldCase('byte', { artifact: { exclude: ['README.md'] } }, async (h) => {
      const artifact = artifactsOf(ctx.fx.home, ctx.project).find((a) => a.digest === h.op.subject?.artifact_digest);
      assert.ok(artifact, 'the deploy names its sealed artifact');
      const path = join(artifact.path, 'server.js');
      chmodSync(path, 0o644);
      appendFileSync(path, '// changed between the reads\n');
      chmodSync(path, 0o444);
      releaseCheck(ctx, h.svc, { get: ['/hello'], exit: 0 });
      const { row } = await verificationOf(ctx, h.op);
      const second = readOf(row, 'second');
      assert.equal(second?.match, 'differs', `the second read's tree differs (${JSON.stringify(second)})`);
      assert.equal(second.detail?.field, 'tree', `the read names the tree (${JSON.stringify(second.detail)})`);
      assert.equal(row.outcome, 'failed');
    });
  });
});
