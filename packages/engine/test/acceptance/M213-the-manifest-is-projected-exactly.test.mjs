// M213, the manifest is projected exactly (M3 slice 17, the protected inputs;
// sandbox lane). M3 plan §3.3 M213; D3-P08; D3 §§1.3, 1.5, 2.2, §7.4 Q3; B01;
// Astra's T01, T02; E95; SEAM.md §§195, 199, 202.
//
// Each check reports every entry under its workspace and the digests of
// the files it is told to read. The protected paths it sees are exactly the
// entries of its input manifest (the version read's, D3 §1.3), each with its
// blob's bytes; no other protected content, and the governed file nowhere,
// the source projection included. The candidate's source is beside them.
//   (a) declared inputs: one file;
//   (b) overlapping directory inputs: each member once;
//   (c) a directory input containing the governed file;
//   (d) default inputs (Q3): every file under the roots but the governed file;
//   (e) roots configured so that the governed file lies outside them.
// (f), a candidate whose root layout differs, is read on M211's execution
// (`M211-the-candidates-copy-is-ignored.test.mjs`); (g), a symlinked
// mount-target ancestor in the candidate's source, is
// `M201-source-symlink-refused.test.mjs` (the slice-15 review's S1).
//
// SAFETY: the check program (harness/checks/program.mjs) only reads its
// workspace, writes its output and exits 0.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { effectiveVersion, sharedFixture } from './harness/gates.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import {
  GOVERNED_FILE,
  blobSha,
  buildStage,
  checkByKey,
  checkProject,
  defPath,
  governedText,
  installCheckProgram,
  outputText,
  programReport,
  qualifyRunnerByFixture,
  reportedFiles,
  resultRow,
  sandboxGoverned,
  smoke,
  versionRead,
  waitRecorded,
} from './harness/checks/fixtures.mjs';

const ROOT = '.surety/checks/';
const A = '.surety/checks/expect/a.txt';
const B = '.surety/checks/expect/sub/b.txt';
const UNDECLARED = '.surety/checks/data/undeclared.txt';
const OUTSIDE_ROOT = 'acceptance/';
const CONTRACT = 'acceptance/contract.txt';
const OUTSIDE_DEFS = 'acceptance/defs/';

const isProtected = (path, roots) => path === GOVERNED_FILE || roots.some((r) => path.startsWith(r));
const sorted = (xs) => [...xs].sort();

// One check that reports, digesting `digests`.
const reporter = (key, { inputs, digests }) => smoke(key, { command: ['probe', '--report', ...digests.flatMap((p) => ['--digest', p]), 'exit', '0'], inputs, gates: ['stage'], timeout: 300 });

async function exercise(t) {
  const fx = await sandboxEngine(t);
  const prog = installCheckProgram(fx.root);
  await qualifyRunnerByFixture(fx.engine);

  // The governed file under the root: (a) to (d).
  const inside = await checkProject(fx, {
    files: {
      [GOVERNED_FILE]: sandboxGoverned(prog),
      [A]: 'input a\n',
      [B]: 'input b\n',
      [UNDECLARED]: 'protected, in no declared input\n',
      [defPath('declared')]: reporter('declared', { inputs: [A], digests: [A] }),
      [defPath('overlap')]: reporter('overlap', { inputs: ['.surety/checks/expect/', '.surety/checks/expect/sub/'], digests: [A, B] }),
      [defPath('containing')]: reporter('containing', { inputs: [ROOT], digests: [A, B, UNDECLARED] }),
      [defPath('defaulted')]: reporter('defaulted', { inputs: undefined, digests: [A, B, UNDECLARED] }),
    },
  });
  // The governed file outside every root: (e).
  const outside = await checkProject(fx, {
    files: {
      [GOVERNED_FILE]: governedText({ ...JSON.parse(sandboxGoverned(prog)), protected_paths: [OUTSIDE_ROOT], check_discovery: { definitions: OUTSIDE_DEFS } }),
      [CONTRACT]: 'the accepted contract\n',
      [`${OUTSIDE_DEFS}outside.json`]: reporter('outside', { inputs: undefined, digests: [CONTRACT] }),
    },
  });

  const runs = {};
  for (const [label, project, keys, roots] of [
    ['inside', inside, ['declared', 'overlap', 'containing', 'defaulted'], [ROOT]],
    ['outside', outside, ['outside'], [OUTSIDE_ROOT]],
  ]) {
    const version = await versionRead(fx.engine, project.id, effectiveVersion(fx.home, project.id).id);
    assert.deepEqual(version.discovery_errors, [], `${label}: the fixture is live: no discovery error`);
    const { candidate } = await buildStage(fx, project);
    const recorded = await waitRecorded(fx, project.id, candidate.id, keys);
    for (const key of keys) {
      const result = resultRow(fx.home, recorded[key].result);
      assert.deepEqual([result.execution_established, result.exit_status], [1, 0], `${label}/${key}: the check ran (${JSON.stringify(result)})`);
      runs[key] = { project, candidate, roots, check: checkByKey(version, key), report: programReport(outputText(fx.home, result)) };
    }
  }
  return { fx, runs };
}

// The protected paths a check saw are its manifest's, exactly, each with its blob's bytes; the source beside them.
function assertExactly(run, expected, what) {
  const manifest = run.check.input_manifest.map(([path]) => path);
  assert.deepEqual(sorted(manifest), sorted(expected), `${what}: the version read's input manifest is ${expected.join(', ')}`);
  const seen = reportedFiles(run.report);
  const protectedSeen = [...seen].filter((p) => isProtected(p, run.roots));
  assert.deepEqual(sorted(protectedSeen), sorted(expected), `${what}: the protected paths the check sees are exactly its manifest (seen: ${sorted(protectedSeen).join(', ')})`);
  assert.ok(!seen.has(GOVERNED_FILE), `${what}: the governed file is visible nowhere`);
  for (const path of Object.keys(run.report.digests)) {
    if (expected.includes(path)) assert.equal(run.report.digests[path], blobSha(run.project.repo.path, run.project.base, path), `${what}: ${path} reads its blob's bytes`);
    else assert.match(run.report.digests[path], /^error:ENOENT$/, `${what}: ${path}, protected and not in the manifest, is absent (${run.report.digests[path]})`);
  }
  assert.ok(seen.has('README.md') && seen.has('src/app.js'), `${what}: the candidate's source is presented beside them`);
}

describe('M213 the manifest is projected exactly', () => {
  const shared = sharedFixture();
  let X;
  before(async () => {
    X = await exercise(shared.context);
  });
  after(() => shared.cleanup());

  test('(a) declared inputs: that path, and no other protected path, is visible', () => {
    assertExactly(X.runs.declared, [A], '(a)');
  });

  test('(b) overlapping directory inputs: each member once', () => {
    const manifest = X.runs.overlap.check.input_manifest.map(([path]) => path);
    assert.equal(new Set(manifest).size, manifest.length, `(b) no member is in the manifest twice (${manifest.join(', ')})`);
    assertExactly(X.runs.overlap, [A, B], '(b)');
  });

  test('(c) a directory input containing the governed file: the governed file is in no projection', () => {
    const defs = ['containing', 'declared', 'defaulted', 'overlap'].map(defPath);
    assertExactly(X.runs.containing, [A, B, UNDECLARED, ...defs], '(c)');
  });

  test('(d) default inputs: every file under the roots but the governed file', () => {
    const defs = ['containing', 'declared', 'defaulted', 'overlap'].map(defPath);
    assertExactly(X.runs.defaulted, [A, B, UNDECLARED, ...defs], '(d)');
  });

  test('(e) roots that leave the governed file outside them: it is visible nowhere, the source projection included', () => {
    assertExactly(X.runs.outside, [CONTRACT, `${OUTSIDE_DEFS}outside.json`], '(e)');
  });
});
