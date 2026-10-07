// M211, the candidate's copy is ignored (M3 slice 17, the protected inputs;
// sandbox lane). M3 plan §3.3 M211 and M213 (f); D3-P06, D3-P08; D3 §§1.5,
// 2.2, 2.4; B01; SEAM.md §§195, 196, 199, 202.
//
// The effective version holds a sentinel input. A developer commit, adopted
// out of band by a person, changes the candidate's own copy of it, plants
// another protected file and narrows the roots its governed file names (a
// root layout that differs from the effective version's). A stage built on
// it is nominated. The check reads the effective sentinel, never the
// candidate's; the candidate's own protected fingerprint is recorded on the
// execution; the result binds the effective version. M213 (f), read here on
// the same execution: the domain presents exactly the check's manifest, as
// for any other candidate (M213 (a)).
//
// Reachability: a Builder cannot write a protected path, so the candidate's
// differing copy lands as a developer commit that a person adopts (as M35
// and M201's symlink case do). Its protected set is then unauthorized, which
// the gate reports apart from this row.
//
// SAFETY: the check program (harness/checks/program.mjs) only reads its
// workspace, writes its output and exits 0.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { sha256Hex, waitFor } from './harness/engine.mjs';
import { effectiveVersion, protectedFingerprint } from './harness/gates.mjs';
import { outOfBand } from './harness/journal.mjs';
import { commitOnRef } from './harness/repos.mjs';
import { answerDecision, tick } from './harness/runs.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import {
  GOVERNED_FILE,
  blobSha,
  buildStage,
  checkProject,
  defPath,
  executionRow,
  installCheckProgram,
  outputText,
  programReport,
  qualifyRunnerByFixture,
  reportedFiles,
  resultRow,
  sandboxGoverned,
  smoke,
  waitRecorded,
} from './harness/checks/fixtures.mjs';

const ROOT = '.surety/checks/';
const SENTINEL = '.surety/checks/sentinel.txt';
const EFFECTIVE = 'THE EFFECTIVE SENTINEL\n';
const CANDIDATES = "THE CANDIDATE'S OWN SENTINEL\n";
const PLANTED = '.surety/checks/planted/extra.txt';

describe("M211 the candidate's copy of the protected paths is ignored", () => {
  test("a candidate whose protected files and roots differ from the effective version's: the check reads the effective sentinel; the candidate's fingerprint is on the execution; the result binds the effective version; M213 (f): exactly the manifest is presented", async (t) => {
    const fx = await sandboxEngine(t);
    const prog = installCheckProgram(fx.root);
    const files = {
      [GOVERNED_FILE]: sandboxGoverned(prog),
      [SENTINEL]: EFFECTIVE,
      [defPath('reads')]: smoke('reads', { command: ['probe', '--report', '--digest', SENTINEL, 'exit', '0'], inputs: [SENTINEL], gates: ['stage'], timeout: 300 }),
    };
    const project = await checkProject(fx, { files });
    const version = effectiveVersion(fx.home, project.id);
    await qualifyRunnerByFixture(fx.engine);

    // A developer changes the protected copy and the roots; a person adopts it.
    const narrowed = JSON.parse(sandboxGoverned(prog));
    narrowed.protected_paths = [`${ROOT}defs/`];
    commitOnRef(project.repo.path, project.repo.ref, {
      [SENTINEL]: CANDIDATES,
      [PLANTED]: 'planted by a developer\n',
      [GOVERNED_FILE]: `${JSON.stringify(narrowed, null, 2)}\n`,
    }, { message: "developer: the protected copy changed, nobody's approval" });
    await tick(fx.engine, project.id);
    const observed = await waitFor(() => outOfBand(fx.home, project.id)[0], { what: 'the out-of-band commit to be observed' });
    await answerDecision(fx.engine, project.id, observed.decision.id, 'adopt');
    await waitFor(() => outOfBand(fx.home, project.id)[0].disposition === 'adopt', { what: 'the adoption to be recorded' });

    const { candidate } = await buildStage(fx, project);
    assert.equal(blobSha(project.repo.path, candidate.revision, SENTINEL), sha256Hex(CANDIDATES), "the fixture is live: the candidate's own copy of the sentinel differs from the effective one");
    assert.equal(blobSha(project.repo.path, candidate.revision, PLANTED), sha256Hex('planted by a developer\n'), 'and it holds a protected file the effective version does not');

    const { reads } = await waitRecorded(fx, project.id, candidate.id, ['reads']);
    const result = resultRow(fx.home, reads.result);
    assert.deepEqual([result.execution_established, result.exit_status], [1, 0], `the check ran (${JSON.stringify(result)})`);
    const report = programReport(outputText(fx.home, result));

    assert.equal(report.digests[SENTINEL], sha256Hex(EFFECTIVE), "the check read the effective version's sentinel, not the candidate's copy");
    assert.equal(report.digests[SENTINEL], blobSha(project.repo.path, project.base, SENTINEL), "host-read: those are the bytes of the effective version's blob");

    const x = executionRow(fx.home, reads.id);
    const own = protectedFingerprint(project.repo.path, candidate.revision, [ROOT]);
    assert.notEqual(own, version.fingerprint, "the fixture is live: the candidate's protected set is not the effective version's");
    assert.equal(x.candidate_protected_fingerprint, own, "the candidate's own protected fingerprint (under the effective roots, over the L6 manifest) is recorded on the execution (D3 §1.5; SEAM.md §196)");
    assert.deepEqual([x.protected_version, result.protected_version], [version.id, version.id], 'the execution and its result bind the effective version');

    // M213 (f): the protected content the domain presents is the check's manifest, exactly.
    const seen = reportedFiles(report);
    const protectedSeen = [...seen].filter((p) => p.startsWith(ROOT) || p === GOVERNED_FILE).sort();
    assert.deepEqual(protectedSeen, [SENTINEL], `M213 (f): under a candidate whose root layout differs, only the manifest's input is visible among the protected paths, the governed file and the planted file absent (seen: ${protectedSeen.join(', ')})`);
    assert.ok(seen.has('src/app.js') && seen.has('README.md'), "the candidate's source is presented beside it");
  });
});
