// M201, a symlink ancestor of an input in the candidate's source refuses the
// mount plan, and nothing outside the domain is written (M3 slice 15 review,
// finding S1; sandbox lane). M3 plan §3.1 M201; D3 §2.2 ("A mount target
// whose ancestor in the source projection is a symlink ... refuses the
// launch, mount_plan_refused"); E64; SEAM.md §§182, 188.
//
// The review's finding: the init created each input's mount target under the
// workspace overlay before pivot_root, following symbolic links, so a
// candidate whose source kept a symlink at an ancestor of an input (for
// example `.surety`, which is above the protected root `.surety/checks/` and
// so stays in the source projection) made the init resolve and truncate a
// file OUTSIDE the domain. The contract is that such a plan is refused, no
// launcher is started, and nothing outside the domain is created or changed.
//
// Reachability (the plan's fixtures): a candidate cannot be built with a
// protected-path symlink by a Builder (the protected route refuses it). The
// test lands the symlink on the integration branch as a developer commit,
// has a person adopt it out of band (as M35 does), and nominates a candidate
// on top of it. Its protected set is then unauthorized (the symlink removed
// the protected files), which the gate reports separately; this case is only
// about the mount plan and the host write.
//
// SAFETY (E64): the symlink points at a directory THE TEST OWNS, under its
// own temp directory; nothing of the user's is named. The case asserts the
// test's sentinel file is byte- and mtime-identical, read host-side. The
// check program is never released into an action; if the plan is refused it
// never runs, and if it runs (the defect) it only reads.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { installGatedPlan } from './harness/gates.mjs';
import { permittedEdit, roleThat, runToEnd, waitForCandidates } from './harness/gitruns.mjs';
import { gitQuiet, refOid } from './harness/repos.mjs';
import { answerDecision, tick } from './harness/runs.mjs';
import { eventsOfType, outOfBand } from './harness/journal.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { askingForTicks } from './harness/gates.mjs';
import { GOVERNED_FILE, checkProject, defPath, executionsOf, installCheckProgram, qualifyRunnerByFixture, resultRow, sandboxGoverned, smoke } from './harness/checks/fixtures.mjs';

const EXPECT = '.surety/checks/expect.txt';

// Land a developer commit on the integration branch whose `.surety` is a
// symlink to `target`, removing the protected files under it. Built with a
// scratch index, as a push or a second clone would move the branch.
function commitSymlinkHead(repo, ref, target) {
  const base = refOid(repo, ref);
  const index = join(repo, '.git', `fixture-index-${process.hrtime.bigint()}`);
  const env = { GIT_INDEX_FILE: index };
  gitQuiet(repo, ['read-tree', base], { env });
  gitQuiet(repo, ['rm', '-r', '--cached', '--quiet', '.surety'], { env });
  const blob = gitQuiet(repo, ['hash-object', '-w', '--stdin'], { input: target });
  gitQuiet(repo, ['update-index', '--add', '--cacheinfo', `120000,${blob},.surety`], { env });
  const tree = gitQuiet(repo, ['write-tree'], { env });
  const commit = gitQuiet(repo, ['commit-tree', tree, '-p', base, '-m', 'developer: replace .surety with a symlink nobody approved']);
  gitQuiet(repo, ['update-ref', ref, commit]);
  return commit;
}

describe('M201 a symlink ancestor of an input in the source refuses the mount plan', () => {
  test('a candidate whose source has `.surety` as a symlink to a test-owned directory: the check is mount_plan_refused, no launcher starts, and the test sentinel outside the domain is unchanged', async (t) => {
    const fx = await sandboxEngine(t);
    const prog = installCheckProgram(fx.root);

    // A directory the test owns, with a sentinel the init's setup would empty.
    const victim = join(fx.root, 'host-victim');
    mkdirSync(victim, { recursive: true });
    const sentinel = join(victim, EXPECT.split('/').at(-1));
    writeFileSync(sentinel, 'PRECIOUS TEST-OWNED DATA\n');
    const before = { bytes: readFileSync(sentinel), mtimeMs: statSync(sentinel).mtimeMs };

    const files = {
      [GOVERNED_FILE]: sandboxGoverned(prog),
      [EXPECT]: 'the protected input\n',
      [defPath('smoke')]: smoke('smoke', { command: ['probe', '--report', 'exit', '0'], inputs: [EXPECT], gates: ['stage'], timeout: 300 }),
    };
    const project = await checkProject(fx, { files, tier: 'T1' });
    await qualifyRunnerByFixture(fx.engine);
    const plan = await installGatedPlan(fx.engine, project.id, { requirements: [], stages: [{ number: 1, goal: 'the first stage', implements: [] }] });

    // A developer replaces `.surety` with a symlink; a person adopts it.
    commitSymlinkHead(project.repo.path, project.repo.ref, victim);
    await tick(fx.engine, project.id);
    const observed = await waitFor(() => outOfBand(fx.home, project.id)[0], { what: 'the out-of-band commit to be observed' });
    await answerDecision(fx.engine, project.id, observed.decision.id, 'adopt');
    await waitFor(() => outOfBand(fx.home, project.id)[0].disposition === 'adopt', { what: 'the adoption to be recorded' });

    // A stage is built on the adopted head and nominated: the candidate's source keeps the `.surety` symlink.
    fx.scripted.script(plan.stages[0].work_item, [roleThat([permittedEdit()], { nominate: true })]);
    const build = await runToEnd(fx, project.id, plan.stages[0].work_item);
    assert.deepEqual([build.outcome, build.reason_class], ['completed', 'none'], `the Builder's run was accepted (${build.reason_text})`);
    const [candidate] = await waitForCandidates(fx, project.id);

    // The smoke check's execution reaches a terminal record.
    const x = await askingForTicks(
      fx,
      project.id,
      () => {
        const found = executionsOf(fx.home, candidate.id).filter((e) => e.key === 'smoke').at(-1);
        return found && (found.status === 'recorded' || found.status === 'cancelled') ? found : undefined;
      },
      "the smoke check's execution to reach a terminal state",
    );

    // Host-side, the sentinel outside the domain is untouched.
    assert.deepEqual(readFileSync(sentinel), before.bytes, 'the test-owned sentinel file outside the domain has its bytes (nothing was written through the symlink)');
    assert.equal(statSync(sentinel).mtimeMs, before.mtimeMs, 'and its mtime: the init created no mount target through the symlink');

    // The plan was refused: a row with execution_established false, mount_plan_refused, and no launcher placed for it.
    assert.equal(x.status, 'recorded', `the refused execution records a row (status ${x.status})`);
    const result = resultRow(fx.home, x.result);
    assert.deepEqual([result?.execution_established, result?.not_run_reason], [0, 'mount_plan_refused'], `mount_plan_refused, not established (${JSON.stringify(result)})`);
    assert.deepEqual(
      eventsOfType(fx.home, 'check.launched').filter((e) => e.subject?.check_execution === x.id),
      [],
      'no launcher was started for the execution',
    );
  });
});
