// M308 (a) on the target (slice 24; sandbox lane). M4 plan §3.2 M308 (a);
// D4 §3.1, D4-I01; N04; SEAM.md §§256 to 260. The projection's other cases
// are the kernel file `M308-the-projection-and-its-mappings.test.mjs`.
//
// A revision holding `.surety/`, an excluded directory and file, a
// protected root configured outside `.surety/` and not excluded (`qa/`),
// and attributes and a filter configured in the repository, deployed on a
// real unit. Walked from the host through `/proc/<pid>/root/surety/app`,
// the running service's tree is exactly the tracked files minus `.surety/`
// and the excludes, each its blob's bytes, `qa/` among them.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §257): the only unit is the engine's,
// under this test's home's prefix; the test acts on no unit and signals
// nothing; the fixture service and the check program are used in their
// benign routes only. The file ends with the operator's guard (row M313).
// Its first engine start carries the real-adapter switch.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { listTree } from './harness/repos.mjs';
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

const sha = (b) => createHash('sha256').update(b).digest('hex');
const EXCLUDE = Object.freeze(['docs/', 'notes.txt']);
const FILES = Object.freeze({
  '.gitattributes': '*.txt eol=crlf\n*.js ident\n',
  'docs/guide.md': 'an excluded directory\n',
  'notes.txt': 'an excluded file\n',
  'qa/expect.txt': 'a protected root outside .surety/, not excluded\n',
  'lib/crlf.txt': 'line one\nline two\n',
});

describe('M308 (a) the projection on a running service, read from the host', () => {
  const shared = sharedFixture();
  let guard;
  let R;
  before(async () => {
    guard = operatorGuard();
    const ctx = await hostDeployable(shared.context, guard, { files: FILES, governed: { protected_paths: ['.surety/checks/', 'qa/'] } });
    execFileSync('git', ['-C', ctx.p.repo.path, 'config', 'filter.fixture.smudge', 'tr a-z A-Z']);
    const env = await hostEnvironment(ctx, 'alpha', { artifact: { exclude: [...EXCLUDE] } });
    await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name);
    await ticksUntil(ctx.fx, ctx.project, () => heldCheck(ctx, env), { what: "the round's check to hold" });
    const op = newestOperation(ctx, env);
    const svc = serviceOf(ctx, env, op);
    R = { ctx, env, op, svc, tree: treeManifest(appRoot(svc.app.pid)) };
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

  test('(a) the running tree is exactly the tracked files minus .surety/ and the excludes, each its blob\'s bytes; the unexcluded protected root qa/ is deployed', () => {
    const { ctx, op, tree } = R;
    const listed = listTree(ctx.p.repo.path, ctx.candidate.revision);
    const expected = Object.entries(listed)
      .filter(([path]) => !path.startsWith('.surety/') && !EXCLUDE.some((e) => (e.endsWith('/') ? path.startsWith(e) : path === e)))
      .map(([path, meta]) => [path, meta.split(' ')[2]])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    assert.deepEqual(tree.odd, [], 'no link or special file');
    assert.deepEqual(tree.entries.map((e) => e[0]), expected.map(([p]) => p), 'the running tree holds exactly the projection');
    for (const [path, oid] of expected) {
      const bytes = execFileSync('git', ['-C', ctx.p.repo.path, 'cat-file', 'blob', oid]);
      assert.equal(tree.entries.find((e) => e[0] === path)?.[4], sha(bytes), `${path} is its blob's bytes on the target`);
    }
    assert.ok(tree.entries.some((e) => e[0] === 'qa/expect.txt'), 'qa/expect.txt, of the protected root outside .surety/, is deployed (D4 §3.1, N04)');
    assert.equal(manifestDigest(tree.entries), op.subject?.artifact_digest, 'and the tree hashes to the operation\'s digest');
    assert.equal(artifactsOf(ctx.fx.home, ctx.project)[0].digest, op.subject?.artifact_digest);
    assert.equal(R.verification.row.outcome, 'verified');
    assert.equal(R.teardown.status, 'succeeded', 'torn down');
  });
});
