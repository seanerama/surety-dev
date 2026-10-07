// M212, inputs are immutable at their pathnames (M3 slice 17, the protected
// inputs; sandbox lane). M3 plan §3.3 M212; D3-P07; D3 §2.2, §7.1 L6 (B01);
// AD §9; E89 item 2; E95 (Sean's decision for slice 17: verified
// structurally); SEAM.md §§195, 198, 202.
//
// One check with one input, `.surety/checks/expect/app.js`. Of its
// ancestors, `.surety` also holds source (`.surety/README.md`, outside the
// roots), and `.surety/checks/expect` exists in no source at all, only as
// the input's mount target. While the check runs, held at its release
// file, the test reads the check process's mount table from the host
// (/proc/<pid>/mountinfo, the pid from the domain's cgroup.procs, as M201
// (b) finds it) and requires that the input's pathname, and every directory
// from it up to /surety/workspace, lies on a read-only mount below
// /surety/workspace that is not the workspace's writable overlay or its
// upper layer: no rename, removal, exchange or replacement at any of those
// paths is possible (E95). The input's bytes are the blob's.
//
// The control, (e) with (a)'s write: released, the program writes to the
// input (refused, EROFS or EACCES) and to an ordinary source file (it
// succeeds in the domain). The source write does not persist: the input
// still reads the protected bytes, nothing under checktrees/ holds the
// written bytes, the project's checkout is clean, and an operator's re-run
// of the check on the same candidate reads the source file's blob bytes.
//
// Not written, by Sean's decision (E95): the cases in which the check
// program renames, removes, exchanges, relinks or replaces paths (the
// plan's (b) to (d) and Astra's T02 attempts). COVERAGE.md records them, to
// be revisited at slice 18's runner self-test.
//
// SAFETY (E64; BS3 §4 rule 1): the program's `write` mode is guarded. It
// acts only once it has established that it is in a check domain (its pid,
// network and mount namespaces are not the host's, pid 1 is no system init,
// at most 16 processes visible), and the test releases it only after
// reading its containment from the host (assertContained). It opens two
// existing workspace-relative files, creates nothing, and writes one line.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { sha256Hex } from './harness/engine.mjs';
import { PERMITTED_EDIT } from './harness/gitruns.mjs';
import { gitQuiet } from './harness/repos.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { assertContained } from './harness/sandbox/view.mjs';
import {
  GOVERNED_FILE,
  assertImmutableAt,
  blobSha,
  buildStage,
  checkProject,
  checktreeFiles,
  defPath,
  executionsOf,
  filesHolding,
  guardArgs,
  heldExecution,
  holdArgs,
  installCheckProgram,
  mountsOfPid,
  outputText,
  programLine,
  programReport,
  qualifyRunnerByFixture,
  release,
  requestChecks,
  resultRow,
  sandboxGoverned,
  smoke,
  waitRecorded,
} from './harness/checks/fixtures.mjs';

const INPUT = '.surety/checks/expect/app.js';
const INPUT_BYTES = 'the protected expectation\n';
const BESIDE = '.surety/README.md';
const SOURCE = PERMITTED_EDIT.path;
// What the program's write leaves in a file it could write (SEAM.md §198).
const written = (bytes) => {
  const b = Buffer.from(bytes);
  Buffer.from('SURETY-CHECK-WROTE\n').copy(b, 0);
  return b;
};

describe('M212 inputs are immutable at their pathnames', () => {
  test("while the check runs, the input and every directory up to /surety/workspace lie on a read-only mount of their own (host-read mount table); released, a write to the input is refused and a source write succeeds and does not persist", async (t) => {
    const fx = await sandboxEngine(t);
    const prog = installCheckProgram(fx.root);
    const command = ['probe', '--report', '--digest', INPUT, '--digest', BESIDE, '--digest', SOURCE, ...holdArgs(prog, 'immutable'), ...guardArgs(), 'write', INPUT, SOURCE];
    const files = {
      [GOVERNED_FILE]: sandboxGoverned(prog),
      [INPUT]: INPUT_BYTES,
      [BESIDE]: 'source beside the protected root\n',
      [defPath('immutable')]: smoke('immutable', { command, inputs: [INPUT], gates: ['stage'], timeout: 300 }),
    };
    const project = await checkProject(fx, { files });
    await qualifyRunnerByFixture(fx.engine);
    const { candidate } = await buildStage(fx, project);
    const inputSha = blobSha(project.repo.path, project.base, INPUT);
    const sourceBytes = Buffer.from(PERMITTED_EDIT.content);
    assert.equal(blobSha(project.repo.path, candidate.revision, SOURCE), sha256Hex(sourceBytes), "the fixture is live: the candidate's source holds the permitted edit");

    // Held: containment read from the host, then the mount table.
    const held = await heldExecution(fx, project.id, candidate.id, { immutable: 'immutable' });
    assertContained(held.domain, held.member, 'the check program');
    const mounts = mountsOfPid(held.member.pid);
    assert.ok(mounts.some((m) => m.point === '/surety/workspace'), `the fixture is live: the host read the check's own mount table (points: ${mounts.map((m) => m.point).join(' ')})`);
    const chain = assertImmutableAt(mounts, INPUT, `the input ${INPUT}`);
    assert.equal(chain.length, 4, 'the input and its three ancestors below /surety/workspace were each read');
    release(prog, 'immutable');

    const { immutable } = await waitRecorded(fx, project.id, candidate.id, ['immutable']);
    const result = resultRow(fx.home, immutable.result);
    assert.deepEqual([result.execution_established, result.exit_status], [1, 0], `the check ran to its end (${JSON.stringify(result)})`);
    const text = outputText(fx.home, result);
    const report = programReport(text);
    assert.equal(report.digests[INPUT], inputSha, "the input's pathname reads the protected bytes, the blob's");
    assert.equal(report.digests[BESIDE], blobSha(project.repo.path, candidate.revision, BESIDE), 'the source file in an ancestor of the input is presented with its bytes');

    // (a) and (e): the writes.
    const write = programLine(text, 'SURETY-CHECK-WRITE');
    const outcome = Object.fromEntries(write.results.map((r) => [r.path, r.outcome]));
    assert.ok(['EROFS', 'EACCES'].includes(outcome[INPUT]), `a write to the input is refused, EROFS or EACCES (got ${outcome[INPUT]})`);
    assert.equal(write.after[INPUT], inputSha, 'after the attempt the input still reads the protected bytes');
    assert.equal(outcome[SOURCE], 'ok', `(e) the control: a write to an ordinary source file succeeds in the domain (got ${outcome[SOURCE]})`);
    assert.equal(write.after[SOURCE], sha256Hex(written(sourceBytes)), 'and the domain read back what it wrote');

    // It does not persist (E89 item 2).
    assert.deepEqual(filesHolding(checktreeFiles(fx.home), written(sourceBytes)), [], 'host-read: no file under checktrees/ holds the bytes the check wrote');
    assert.equal(gitQuiet(project.repo.path, ['status', '--porcelain', '--untracked-files=all']), '', "host-read: the project's checkout is unchanged");
    rmSync(join(prog.releaseDir, 'immutable'));
    const rerun = await requestChecks(fx.engine, project.id, candidate.id, { keys: ['immutable'] });
    assert.equal(rerun.status, 202, `an operator re-runs the check on the same candidate (body: ${rerun.text})`);
    const again = await heldExecution(fx, project.id, candidate.id, { immutable: 'immutable' });
    assert.notEqual(again.execution.id, immutable.id, 'the re-run is a new execution');
    assertContained(again.domain, again.member, 'the re-run check program');
    release(prog, 'immutable');
    const second = (await waitRecorded(fx, project.id, candidate.id, ['immutable'], { what: 'the re-run to be recorded' })).immutable;
    assert.equal(second.id, again.execution.id);
    const secondReport = programReport(outputText(fx.home, resultRow(fx.home, second.result)));
    assert.equal(secondReport.digests[SOURCE], sha256Hex(sourceBytes), "the re-run reads the source file's blob bytes: the earlier execution's write did not persist");
    assert.equal(executionsOf(fx.home, candidate.id).filter((x) => x.key === 'immutable').length, 2);
  });
});
