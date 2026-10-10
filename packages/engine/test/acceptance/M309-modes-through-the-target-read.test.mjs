// M309 (b) through the target read (slice 24; sandbox lane). M4 plan §3.2
// M309 (b); D4 §§3.1, 3.4; D4-I07; E117; SEAM.md §§256 to 260. The sealing,
// umask, bound and staging cases are the kernel file
// `M309-sealing-modes-and-bounded-preparation.test.mjs`.
//   (b) an executable and a non-executable file keep their classes `100755`
//       and `100644` through sealing and the target read: the running tree,
//       walked from the host, hashes to the sealed digest and `/surety/app` is
//       a read-only mount; then a file added to the sealed copy between the
//       round's two identity reads makes the second read `differs`, never an
//       entry omitted, and the verification is not `verified`.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §257): the only unit is the engine's,
// under this test's home's prefix; the test acts on no unit and signals
// nothing; it changes a file of its own engine home's sealed copy. The
// fixture service and the check program are used in their benign routes
// only. The file ends with the operator's guard (row M313). Its first
// engine start carries the real-adapter switch.

import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { mountAt, mountsOfPid } from './harness/checks/fixtures.mjs';
import { artifactsOf, deploy } from './harness/deploy/kernel.mjs';
import {
  appRoot,
  heldCheck,
  hostDeployable,
  hostEnvironment,
  manifestDigest,
  newestOperation,
  operatorGuard,
  releaseCheck,
  serviceOf,
  teardownOnHost,
  ticksUntil,
  treeManifest,
  verificationOf,
} from './harness/deploy/host.mjs';

describe('M309 (b) the canonical modes through sealing and the target read', () => {
  const shared = sharedFixture();
  let guard;
  let R;
  before(async () => {
    guard = operatorGuard();
    const ctx = await hostDeployable(shared.context, guard, { entries: { 'bin/run.sh': { content: '#!/bin/sh\necho run\n', mode: '100755' } } });
    const env = await hostEnvironment(ctx, 'alpha');
    await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
    await ticksUntil(ctx.fx, ctx.project, () => heldCheck(ctx, env), { what: "the round's check to hold" });
    const op = newestOperation(ctx, env);
    const svc = serviceOf(ctx, env, op);
    const [artifact] = artifactsOf(ctx.fx.home, ctx.project);
    R = { ctx, env, op, svc, artifact, tree: treeManifest(appRoot(svc.app.pid)), mount: mountAt(mountsOfPid(svc.app.pid), '/surety/app') };
    // Between the two reads: one file added to the sealed copy, from the host.
    chmodSync(artifact.path, 0o755);
    writeFileSync(join(artifact.path, 'added-between-reads.txt'), 'added by the test\n', { mode: 0o444 });
    chmodSync(artifact.path, 0o555);
    releaseCheck(ctx, svc, { get: ['/hello'], exit: 0 });
    R.verification = await verificationOf(ctx, op);
    R.teardown = await teardownOnHost(ctx, env);
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('(b) 100755 and 100644 on the target as in the manifest; the running tree hashes to the sealed digest; /surety/app is a read-only mount', () => {
    const { tree, op, mount } = R;
    assert.deepEqual(tree.odd, []);
    assert.equal(tree.entries.find((e) => e[0] === 'bin/run.sh')?.[2], '100755', 'bin/run.sh is of the executable class on the target');
    assert.equal(tree.entries.find((e) => e[0] === 'server.js')?.[2], '100644', 'server.js is of the plain class on the target');
    assert.equal(manifestDigest(tree.entries), op.subject?.artifact_digest, 'the target read reconstructs the sealed digest');
    assert.ok(mount && mount.point === '/surety/app', `/surety/app is a mount of its own (${JSON.stringify(mount?.point)})`);
    assert.ok(mount.options.includes('ro'), `and read-only (${mount.options.join(',')})`);
  });

  test('(b) a file added to the sealed copy between the reads: the second read differs, never an entry omitted; not verified', () => {
    const { row } = R.verification;
    const second = row.identity_reads.find((r) => r.bracket === 'second');
    assert.equal(row.identity_reads.find((r) => r.bracket === 'first')?.match, 'match', 'the first read matched');
    assert.equal(second?.match, 'differs', `the second read differs (${JSON.stringify(second)})`);
    assert.notEqual(row.outcome, 'verified', `not verified (${row.outcome})`);
    assert.equal(R.teardown.status, 'succeeded', 'torn down');
  });
});
