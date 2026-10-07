// M201, the check tree is built from the revision and the version's objects
// alone (M3 slice 15 review, finding S2; sandbox lane). M3 plan §3.1 M201;
// D3 §§1.5, 2.4; SEAM.md §§182, 188.
//
// Every materialized file, a source file and a protected input alike, is
// byte-identical to its blob at the candidate's revision (source) or at the
// effective protected version (input). The check tree holds blob bytes
// whatever the project's own work tree, its `.git/info/attributes` or a
// committed `.gitattributes` asks for: no eol, text, ident or
// working-tree-encoding conversion is applied.
//
// The review's finding (E64; the Reviewer's repro): the build materialized
// with the project's main work tree in context, so the owner's checked-out
// and info/attributes, and a committed `.gitattributes`, converted the
// bytes. The contract is that the tree is the blobs.
//
// The check program reports the SHA-256 of each file it reads; the test
// compares it with the SHA-256 of the blob's own bytes, read with engine
// git. (M201's path-one case reads the tree host-side the same way.)
//
// SAFETY: the check program (harness/checks/program.mjs) is benign: it reads
// its workspace and the files it digests, writes its output and exits 0.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { sha256Hex } from './harness/engine.mjs';
import { installGatedPlan, stageGate } from './harness/gates.mjs';
import { roleThat, runToEnd, waitForCandidates } from './harness/gitruns.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { GOVERNED_FILE, checkProject, defPath, installCheckProgram, outputText, programReport, qualifyRunnerByFixture, resultRow, sandboxGoverned, smoke, waitRecorded } from './harness/checks/fixtures.mjs';

// Bytes that a text/eol/ident conversion would change: an LF line and a $Id$
// placeholder git's ident filter rewrites.
const EXPECT = '.surety/checks/expect.txt';
const EXPECT_BYTES = 'alpha\nbeta\n$Id$\n';
const APP = 'src/app.txt';
const APP_BYTES = 'one\ntwo\n$Id$\n';
const COMMITTED_ATTRS = '.gitattributes';
const CONVERT = '* text eol=crlf ident working-tree-encoding=UTF-16\n';

// The exact bytes of a blob at a revision, read with git (never through the
// work tree): `git cat-file blob <rev>:<path>`.
function blobBytes(repo, rev, path) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, 'cat-file', 'blob', `${rev}:${path}`], { maxBuffer: 1 << 24 });
}

describe('M201 the check tree is the revision and the version, byte for byte', () => {
  test('an uncommitted work-tree .gitattributes, .git/info/attributes, and a committed .gitattributes all asking for conversion: the materialized source and protected input are their blob bytes', async (t) => {
    const fx = await sandboxEngine(t);
    const prog = installCheckProgram(fx.root);
    // Hostile attributes in the project's own repository: a committed one (in
    // the first commit), and uncommitted work-tree ones the owner left.
    const plant = (repo) => {
      writeFileSync(join(repo.path, COMMITTED_ATTRS), CONVERT); // overrides the committed value in the detached work tree
      mkdirSync(join(repo.path, '.git', 'info'), { recursive: true });
      writeFileSync(join(repo.path, '.git', 'info', 'attributes'), CONVERT);
    };
    const files = {
      [GOVERNED_FILE]: sandboxGoverned(prog),
      [EXPECT]: EXPECT_BYTES,
      [APP]: APP_BYTES,
      [COMMITTED_ATTRS]: CONVERT,
      [defPath('fidelity')]: smoke('fidelity', {
        command: ['probe', '--report', '--digest', EXPECT, '--digest', APP, 'exit', '0'],
        inputs: [EXPECT],
        gates: ['stage'],
        timeout: 300,
      }),
    };
    const project = await checkProject(fx, { files, tier: 'T1', plant });
    await qualifyRunnerByFixture(fx.engine);
    const plan = await installGatedPlan(fx.engine, project.id, { requirements: [], stages: [{ number: 1, goal: 'the first stage', implements: [] }] });
    fx.scripted.script(plan.stages[0].work_item, [roleThat([], { nominate: true })]);
    const build = await runToEnd(fx, project.id, plan.stages[0].work_item);
    assert.deepEqual([build.outcome, build.reason_class], ['completed', 'none'], `the Builder's run was accepted (${build.reason_text})`);
    const [candidate] = await waitForCandidates(fx, project.id);

    const recorded = await waitRecorded(fx, project.id, candidate.id, ['fidelity']);
    const result = resultRow(fx.home, recorded.fidelity.result);
    assert.deepEqual([result.execution_established, result.exit_status], [1, 0], `the check ran and exited 0 (${JSON.stringify(result)})`);
    const report = programReport(outputText(fx.home, result));

    const expectBlob = sha256Hex(blobBytes(project.repo.path, candidate.revision, EXPECT));
    const appBlob = sha256Hex(blobBytes(project.repo.path, candidate.revision, APP));
    assert.equal(report.digests[EXPECT], expectBlob, 'the protected input in the check tree is its blob bytes, with no eol/ident/encoding conversion');
    assert.equal(report.digests[APP], appBlob, 'the source file in the check tree is its blob bytes, with no conversion');
    assert.equal(report.git_present, false, 'and the tree has no .git');

    // The gate reads the engine's execution, so the fixture is live end to end.
    assert.equal((await stageGate(fx, { project, candidate, stage: plan.stages[0].id })).check_states[recorded.fidelity.check], 'passed', 'the check passed on these bytes');
  });
});
