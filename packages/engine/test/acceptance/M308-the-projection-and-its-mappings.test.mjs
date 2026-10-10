// M308, the projection and its mappings (slice 24; kernel lane). M4 plan
// §3.2 M308; D4 §3.1, D4-I01, D4-I06; RV3; N04; SEAM.md §§256, 260.
//
// The artifact is sealed by the deployment request (D4 §4.1 (1)), so every
// case here is read from the sealed copy under $SURETY_HOME/artifacts/, the
// `artifacts` and `artifact_mappings` rows and the request's answer, on the
// scripted deployment adapter. What the projection looks like on a running
// service is the sandbox file `M308-the-projection-on-the-target.test.mjs`.
//   (a) the projection: exactly the tracked files minus `.surety/` and the
//       configured excludes, each its blob's bytes, whatever the repository's
//       attributes and filters ask; a protected root configured outside
//       `.surety/` and not excluded is in it; its digest is the canonical
//       manifest's (SEAM.md §260);
//   (b) a symbolic link and a submodule each refuse the request
//       (`artifact_refused`, the refusal named), nothing authorized and no
//       staging left; a special file, which no git tree can hold, is read as
//       one placed in a sealed copy: the next request reusing it is refused
//       `artifact_corrupt`, never omitted (SEAM.md §260 †);
//   (c) the sealed copy deleted, the projection made again: the same digest
//       (SEAM.md §260 †);
//   (d) two revisions differing only in `.surety/` or excluded paths: one
//       `artifacts` row, two mappings; each authorization and each round
//       names its own candidate's revision;
//   (e) a sealed digest reused: rehashed first (a changed byte refuses the
//       reuse, `artifact_corrupt`), and no staging copy left.
//
// SAFETY: kernel lane; no unit, no systemctl, nothing signalled. The cases
// change files of the test's own engine home only. The file ends with the
// operator's guard (row M313).

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { addItem, roleThat, runToEnd, waitForCandidates } from './harness/gitruns.mjs';
import { changePolicy, eventsOfType } from './harness/journal.mjs';
import { changedPaths, listTree } from './harness/repos.mjs';
import { recordExit } from './harness/checks/selection.mjs';
import { executionsOf } from './harness/checks/fixtures.mjs';
import { scriptedEngine, tickUntil } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import {
  artifactsOf,
  authorizationRow,
  candidateRow,
  configContent,
  configure,
  deploy,
  deployable,
  filesUnder,
  isWritable,
  mappingsOf,
  operationsOf,
  postDeployExecutions,
  requestDeployment,
  roundsOf,
  scriptCall,
} from './harness/deploy/kernel.mjs';
import { manifestDigest, operatorGuard, treeManifest, unrecordedUnderArtifacts } from './harness/deploy/host.mjs';

const json = (t) => (typeof t === 'string' ? JSON.parse(t) : t);
const blob = (repo, oid) => execFileSync('git', ['-C', repo, 'cat-file', 'blob', oid]);
const authorizationsOf = (home, candidate, environment) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "deployment_authorizations" WHERE "candidate" = ? AND "environment" = ? ORDER BY rowid').all(candidate, environment));
const securityFindings = (home, project) =>
  withStore(home, (db) => db.prepare(`SELECT * FROM "findings" WHERE "project" = ? AND "category" = 'security' ORDER BY "seq"`).all(project));
const failedEvents = (home) => eventsOfType(home, 'artifact.failed');

// Make a sealed directory writable for the test's own change, and seal it again after.
function unsealed(dir, fn) {
  chmodSync(dir, 0o755);
  try {
    fn();
  } finally {
    chmodSync(dir, 0o555);
  }
}
function removeTree(dir) {
  const open = (d) => {
    chmodSync(d, 0o755);
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) open(p);
      else chmodSync(p, 0o644);
    }
  };
  open(dir);
  rmSync(dir, { recursive: true, force: true });
}

const ATTRIBUTES = '*.txt eol=crlf\n*.js filter=fixture ident\n';
const PROJECTION_FILES = Object.freeze({
  '.gitattributes': ATTRIBUTES,
  'docs/guide.md': 'an excluded directory\n',
  'notes.txt': 'an excluded file\n',
  'qa/expect.txt': 'a protected root outside .surety/, not excluded\n',
  'lib/crlf.txt': 'line one\nline two\n',
  'lib/ident.js': '// $Id$\nexport const x = 1;\n',
});
const EXCLUDE = Object.freeze(['docs/', 'notes.txt']);
const QA_GOVERNED = Object.freeze({ protected_paths: ['.surety/checks/', 'qa/'] });

// The projection of a revision as D4 §3.1 defines it: tracked paths minus .surety/ and the excludes.
function projectionOf(repo, revision, exclude) {
  const tree = listTree(repo, revision);
  const out = {};
  for (const [path, meta] of Object.entries(tree)) {
    if (path === '.surety' || path.startsWith('.surety/')) continue;
    if (exclude.some((e) => (e.endsWith('/') ? path.startsWith(e) : path === e || path.startsWith(`${e}/`)))) continue;
    const [mode, type, oid] = meta.split(' ');
    out[path] = { mode, type, oid };
  }
  return out;
}

describe('M308 the projection and its mappings (kernel lane)', () => {
  const shared = sharedFixture();
  let guard;
  let fx;
  before(async () => {
    guard = operatorGuard();
    fx = guard.track(await scriptedEngine(shared.context));
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  let A; // (a)'s project, reused by (c)
  test('(a) the projection is exactly the tracked files minus .surety/ and the excludes, each its blob\'s bytes whatever the attributes and a configured filter ask; the unexcluded protected root qa/ is deployed; the digest is the canonical manifest\'s', async () => {
    const ctx = await deployable(fx, { files: PROJECTION_FILES, governed: QA_GOVERNED, config: { artifact: { exclude: [...EXCLUDE] } } });
    // A filter the repository's own configuration names: engine git never runs it (E93 S2).
    execFileSync('git', ['-C', ctx.p.repo.path, 'config', 'filter.fixture.smudge', 'tr a-z A-Z']);
    execFileSync('git', ['-C', ctx.p.repo.path, 'config', 'filter.fixture.clean', 'cat']);
    const request = await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    const [artifact, ...more] = artifactsOf(fx.home, ctx.project);
    assert.equal(more.length, 0, 'one artifact');
    assert.equal(artifact.status, 'sealed');
    assert.equal(authorizationRow(fx.home, request.authorization.id).artifact_digest, artifact.digest, 'the authorization binds the sealed digest');

    const expected = projectionOf(ctx.p.repo.path, ctx.candidate.revision, EXCLUDE);
    const sealed = filesUnder(artifact.path);
    assert.deepEqual(Object.keys(sealed).sort(), Object.keys(expected).sort(), "the sealed directory holds exactly the revision's tracked files minus .surety/ and the excludes");
    assert.ok('qa/expect.txt' in sealed, 'the protected root configured outside .surety/ and not excluded is deployed (D4 §3.1, N04)');
    for (const gone of ['docs/guide.md', 'notes.txt']) assert.ok(!(gone in sealed), `${gone} is excluded`);
    assert.ok(!Object.keys(sealed).some((p) => p.startsWith('.surety/')), 'nothing of .surety/');
    for (const [path, { oid }] of Object.entries(expected)) {
      assert.ok(sealed[path].equals(blob(ctx.p.repo.path, oid)), `${path} is its blob's bytes (no eol conversion, no ident expansion, no filter)`);
      assert.equal(isWritable(join(artifact.path, path)), false, `${path} has no write bit`);
    }
    assert.ok(!sealed['lib/crlf.txt'].includes(0x0d), 'eol=crlf converted nothing');
    assert.ok(sealed['lib/ident.js'].toString('utf8').includes('$Id$'), 'ident expanded nothing');
    const { entries, odd } = treeManifest(artifact.path);
    assert.deepEqual(odd, []);
    assert.equal(manifestDigest(entries), artifact.digest, "the digest is sha256 of the canonical manifest of the sealed tree (SEAM.md §260)");
    assert.deepEqual([artifact.entries, artifact.bytes], [entries.length, entries.reduce((n, e) => n + e[3], 0)], 'entries and bytes are the manifest\'s');
    const mappings = mappingsOf(fx.home, artifact.id);
    assert.deepEqual(mappings.map((m) => m.dev_revision), [ctx.candidate.revision], "one mapping, naming the candidate's revision");
    assert.match(mappings[0].builder ?? '', /^engine-projection@/);
    A = { ctx, artifact };
  });

  test('(b) a symbolic link refuses the request: artifact_refused naming symlink; nothing authorized; no staging left', async () => {
    const ctx = await deployable(fx, { entries: { 'lib/link.js': { link: 'greeting.js' } } });
    const res = await requestDeployment(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    assert.deepEqual([res.status, res.body?.code, res.body?.subject?.refusal], [422, 'artifact_refused', 'symlink'], `refused, naming the link (${res.text})`);
    assert.deepEqual(authorizationsOf(fx.home, ctx.candidate.id, ctx.env.id), [], 'no authorization recorded');
    assert.ok(failedEvents(fx.home).some((e) => e.payload?.refusal === 'symlink'), 'artifact.failed names the refusal');
    assert.deepEqual(unrecordedUnderArtifacts(fx.home), [], 'nothing under artifacts/ but recorded artifacts: the staging is removed');
  });

  test('(b) a submodule refuses the request: artifact_refused naming submodule; nothing authorized; no staging left', async () => {
    const ctx = await deployable(fx, { entries: { 'vendor/sub': { gitlink: 'a'.repeat(40) } } });
    const res = await requestDeployment(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    assert.deepEqual([res.status, res.body?.code, res.body?.subject?.refusal], [422, 'artifact_refused', 'submodule'], `refused, naming the submodule (${res.text})`);
    assert.deepEqual(authorizationsOf(fx.home, ctx.candidate.id, ctx.env.id), [], 'no authorization recorded');
    assert.ok(failedEvents(fx.home).some((e) => e.payload?.refusal === 'submodule'), 'artifact.failed names the refusal');
    assert.deepEqual(unrecordedUnderArtifacts(fx.home), [], 'no staging left');
  });

  test('(b) a special file (a FIFO) in a sealed copy: the next request reusing it is refused artifact_corrupt, never omitted; the artifact failed; a security finding; nothing authorized (SEAM.md §260 †)', async () => {
    const ctx = await deployable(fx);
    await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    const [artifact] = artifactsOf(fx.home, ctx.project);
    unsealed(artifact.path, () => {
      const made = spawnSync('mkfifo', [join(artifact.path, 'pipe')]);
      assert.equal(made.status, 0, 'the test places a FIFO in its own home\'s sealed copy');
    });
    const beta = await configure(fx.engine, ctx.project, 'beta', configContent());
    const res = await requestDeployment(fx.engine, ctx.project, ctx.candidate.id, 'beta');
    assert.deepEqual([res.status, res.body?.code], [409, 'artifact_corrupt'], `the reuse is refused (${res.text})`);
    assert.deepEqual(authorizationsOf(fx.home, ctx.candidate.id, beta.environment.id), [], 'nothing authorized for beta');
    assert.equal(artifactsOf(fx.home, ctx.project)[0].status, 'failed', 'the artifact is failed');
    assert.ok(securityFindings(fx.home, ctx.project).some((f) => f.effective_severity === 'high' && f.scope === 'project' && f.status === 'open'), 'a security finding, high, of the project');
  });

  test('(c) the sealed copy deleted, the projection made again by the next request: the same digest, the same artifacts row (SEAM.md §260 †)', async () => {
    assert.ok(A, '(a) made its artifact');
    const { ctx, artifact } = A;
    removeTree(artifact.path);
    await configure(fx.engine, ctx.project, 'beta', configContent({ artifact: { exclude: [...EXCLUDE] } }));
    const again = await deploy(fx.engine, ctx.project, ctx.candidate.id, 'beta');
    assert.equal(authorizationRow(fx.home, again.authorization.id).artifact_digest, artifact.digest, 'the same digest');
    const rows = artifactsOf(fx.home, ctx.project);
    assert.deepEqual(rows.map((r) => [r.id, r.digest, r.status]), [[artifact.id, artifact.digest, 'sealed']], 'one artifacts row, the same, sealed');
    assert.equal(manifestDigest(treeManifest(artifact.path).entries), artifact.digest, 'the sealed copy is back, rehashing to the digest');
  });

  test('(d), (e) two revisions differing only in .surety/ and excluded paths: one artifact, two mappings; each authorization and round names its own revision; the reuse rehashes first and leaves no staging', async () => {
    const ctx = await deployable(fx, { config: { artifact: { exclude: ['docs/'] } } });
    const { project } = ctx;
    // Candidate 1 deployed, verified and completed on the scripted target.
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }]);
    const first = await deploy(fx.engine, project, ctx.candidate.id, ctx.env.name);
    const x1 = await tickUntil(fx.engine, project, () => postDeployExecutions(fx.home, ctx.candidate.id)[0], { max: 16, what: "candidate 1's round" });
    await recordExit(fx.engine, x1.id, 0);
    await tickUntil(fx.engine, project, () => (candidateRow(fx.home, ctx.candidate.id).progress === 'alpha_deployed' ? true : undefined), { max: 12, what: 'candidate 1 alpha_deployed' });
    const sealedEvents = eventsOfType(fx.home, 'artifact.sealed').length;

    // Candidate 2: a policy revision (.surety/) and a Builder's write to an excluded path only.
    await changePolicy(fx.engine, project, { repair_attempts_max: 0 });
    const fix = await addItem(fx, project, 'fix');
    fx.scripted.script(fix, [roleThat([step.write('docs/later.md', 'an excluded change\n')], { nominate: true })]);
    await runToEnd(fx, project, fix);
    const c2 = (await waitForCandidates(fx, project, 2)).at(-1);
    assert.notEqual(c2.revision, ctx.candidate.revision, 'a second candidate');
    const changed = Object.keys(changedPaths(ctx.p.repo.path, ctx.candidate.revision, c2.revision));
    assert.ok(changed.length > 0 && changed.every((p) => p.startsWith('.surety/') || p.startsWith('docs/')), `the revisions differ only in .surety/ or docs/ (${changed.join(', ')})`);
    for (const x of executionsOf(fx.home, c2.id).filter((e) => ['acc', 'smoke'].includes(e.key) && e.status !== 'recorded')) await recordExit(fx.engine, x.id, 0);

    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }]);
    const second = await deploy(fx.engine, project, c2.id, ctx.env.name);
    assert.deepEqual(unrecordedUnderArtifacts(fx.home), [], '(e) the reuse leaves no staging copy');
    assert.equal(eventsOfType(fx.home, 'artifact.sealed').length, sealedEvents, '(e) nothing sealed again: the bytes were reused');
    const x2 = await tickUntil(fx.engine, project, () => postDeployExecutions(fx.home, c2.id)[0], { max: 16, what: "candidate 2's round" });

    const [artifact, ...more] = artifactsOf(fx.home, project);
    assert.equal(more.length, 0, 'one artifacts row for both revisions');
    const mappings = mappingsOf(fx.home, artifact.id);
    assert.deepEqual(mappings.map((m) => m.dev_revision).sort(), [ctx.candidate.revision, c2.revision].sort(), 'two mappings, one per revision');
    const mappingOf = (id) => mappings.find((m) => m.id === id);
    for (const [request, candidate, what] of [[first, ctx.candidate, 'candidate 1'], [second, c2, 'candidate 2']]) {
      const auth = authorizationRow(fx.home, request.authorization.id);
      assert.equal(json(auth.source_delivery_mapping).dev_revision, candidate.revision, `${what}'s authorization names its own revision`);
      assert.equal(auth.artifact_digest, artifact.digest);
    }
    const [op1, op2] = operationsOf(fx.home, project, 'deploy');
    assert.equal(mappingOf(roundsOf(fx.home, op1.id)[0].mapping)?.dev_revision, ctx.candidate.revision, "candidate 1's round names its own mapping");
    assert.equal(mappingOf(roundsOf(fx.home, op2.id)[0].mapping)?.dev_revision, c2.revision, "candidate 2's round names its own mapping");
    assert.ok(x2, 'the second round registered its check');

    // (e) A byte changed in the sealed copy, then a deliberate request: the reuse rehashes first and refuses.
    await recordExit(fx.engine, x2.id, 0);
    await tickUntil(fx.engine, project, () => (candidateRow(fx.home, c2.id).progress === 'alpha_deployed' ? true : undefined), { max: 12, what: 'candidate 2 alpha_deployed' });
    const target = join(artifact.path, 'server.js');
    chmodSync(target, 0o644);
    appendFileSync(target, '// changed by the test\n');
    chmodSync(target, 0o444);
    const before = authorizationsOf(fx.home, c2.id, ctx.env.id).length;
    const res = await requestDeployment(fx.engine, project, c2.id, ctx.env.name);
    assert.deepEqual([res.status, res.body?.code], [409, 'artifact_corrupt'], `the reuse of a changed sealed copy is refused (${res.text})`);
    assert.equal(authorizationsOf(fx.home, c2.id, ctx.env.id).length, before, 'nothing authorized');
    assert.equal(artifactsOf(fx.home, project)[0].status, 'failed');
    assert.ok(failedEvents(fx.home).some((e) => e.payload?.reason === 'artifact_corrupt'), 'artifact.failed, reason artifact_corrupt');
    assert.deepEqual(unrecordedUnderArtifacts(fx.home), [], 'no staging left');
  });
});
