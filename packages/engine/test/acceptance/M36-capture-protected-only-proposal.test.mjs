// M36, capturing a protected-only proposal (slice 5). Plan §3.4 M36; D1
// §§4.1, 7.3 step 2, D1-21; F §4.1 (what a Verifier and a Reviewer may not
// do); E2 ("rejected whole"); Review B04; SEAM.md §68.
//
// Only a Verifier's diff that consists of protected changes and nothing else
// becomes a proposal. Capture is not a commit: nothing reaches the
// integration branch, no revision is recorded, the effective protected
// version stays the authorized one, and the run goes on through finalization
// to ended, completed. A Verifier's diff that also touches source, and any
// other role's diff that touches the protected set, is rejected whole.
//
// With it, the role prohibitions slice 3 left for this slice: a Verifier may
// change nothing but the protected set, and a Reviewer may change nothing.
// The first case is also the first dispatch of `check_correction` work,
// which completes through proposal capture and in no other way here.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { GOVERNED_FILE, effectiveVersion, proposalsOf, roleRun } from './harness/gates.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { assertWorkHistory, runPath } from './harness/invariants.mjs';
import { acceptanceState, assertNothingAccepted, changePolicy, eventsOfType, operationsOf, revisionsOf } from './harness/journal.mjs';
import { assertRecordHolds } from './harness/records.mjs';
import { changedPaths, refOid, snapshotTree } from './harness/repos.mjs';
import { assertRunEnded, getRow, scriptedEngine, workItem } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const CHECK = '.surety/checks/login.check.json';
// M3 slice 15 (objection 022; SEAM.md §187): no required key without a definition.
const FILES = { [GOVERNED_FILE]: '{"protected_paths": [".surety/checks/"]}\n', [CHECK]: '{"expect": 200}\n', 'src/app.js': 'export const app = 1;\n' };
const tighter = step.write(CHECK, '{"expect": 200, "body": "ok"}\n');
const RATIONALE = 'The check did not look at the response body.';
const proposing = { proposal: { rationale: RATIONALE, requested_change_kind: 'tightening' } };
const CAPTURED_OR_CLASSIFIED = ['captured', 'classified', 'awaiting_human'];

async function protectedProject(t) {
  const fx = await scriptedEngine(t);
  const project = await addGitProject(fx, { files: FILES });
  // No repair: a rejected run parks its work at once, so nothing else is launched for it.
  await changePolicy(fx.engine, project.id, { repair_attempts_max: 0 });
  project.base = refOid(project.repo.path, project.repo.ref);
  return { fx, project, authorized: effectiveVersion(fx.home, project.id), before: acceptanceState(fx, project.id) };
}

// The run was rejected whole: nothing of it was accepted, no proposal exists, and the effective version is preserved.
function assertRejectedWhole({ fx, project, authorized, before }, done, path) {
  assertNothingAccepted(fx, done.run.id, before, { reason: 'diff_violation', pathInReason: path });
  assert.equal(proposalsOf(fx.home, project.id).length, 0, 'no proposal was captured');
  assert.equal(eventsOfType(fx.home, 'protected.proposed').length, 0);
  assert.equal(effectiveVersion(fx.home, project.id).id, authorized.id, 'the effective protected version is preserved');
  assert.equal(workItem(fx.home, done.item).status, 'parked', 'and the work is not complete: with no repair allowed it is parked');
}

describe('M36 a protected-only diff of a Verifier is captured as a proposal', () => {
  test('the Verifier changes only the protected set: a proposal is captured, no commit follows, and the run ends completed', async (t) => {
    const ctx = await protectedProject(t);
    const { fx, project, authorized, before } = ctx;
    const { item, run } = await roleRun(fx, project.id, 'check_correction', { steps: [tighter], result: proposing });

    assertRunEnded(fx.home, run.id, { outcome: 'completed', reason_class: 'none', workspace: 'retained', launched: true });
    assert.equal(run.role, 'verifier', 'check_correction work is the Verifier\'s');
    const path = withStore(fx.home, (db) => runPath(db, run.id));
    assert.deepEqual(path.slice(-4), ['validating', 'proposal_captured', 'finalizing', 'ended'], `the run goes through proposal capture and on through finalization (path: ${path.join(' → ')})`);

    const proposals = proposalsOf(fx.home, project.id);
    assert.equal(proposals.length, 1, 'one proposal');
    const [proposal] = proposals;
    const workspace = getRow(fx.home, 'workspaces', run.workspace);
    assert.deepEqual(
      { proposed_by: proposal.proposed_by, run: proposal.run, base: proposal.base_revision, tree: proposal.tree_id, requested: proposal.requested_change_kind },
      { proposed_by: 'verifier_run', run: run.id, base: project.base, tree: snapshotTree(workspace.path, project.base), requested: 'tightening' },
      'the proposal names the run, its base and the tree of what the Verifier left',
    );
    // M3 slice 19 (D3 §1.6; SEAM.md §215): the engine classifies a captured
    // proposal at a later tick, which the run's own ticks may reach.
    assert.ok(CAPTURED_OR_CLASSIFIED.includes(proposal.status), `the proposal is captured, or classified since, and nothing more (it is ${proposal.status})`);
    assert.deepEqual(changedPaths(project.repo.path, project.base, proposal.tree_id), { [CHECK]: 'M' }, 'what it proposes is the protected change, exactly');
    await assertRecordHolds(fx.engine, project.id, proposal.rationale, { kind: 'proposal_rationale', content: RATIONALE });
    assert.deepEqual(eventsOfType(fx.home, 'protected.proposed').length, 1);

    // Capture is not a commit, and it authorizes nothing.
    assert.deepEqual(acceptanceState(fx, project.id), before, 'no ref moved, the registry expects what it expected, no revision was recorded');
    assert.deepEqual(revisionsOf(fx.home, { run: run.id }), [], 'no revision names the run');
    for (const journalKind of ['commit_tree', 'ref_update']) assert.deepEqual(operationsOf(fx.home, { run: run.id, journalKind }), [], `the run has no ${journalKind} operation`);
    assert.equal(effectiveVersion(fx.home, project.id).id, authorized.id, 'the effective protected version is still the authorized one');
    assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, item)), ['eligible', 'claimed', 'executing', 'complete'], 'the check_correction work is complete, through capture');
  });

  test('the Verifier changes the protected set and a source file: rejected whole', async (t) => {
    const ctx = await protectedProject(t);
    const done = await roleRun(ctx.fx, ctx.project.id, 'check_correction', { steps: [tighter, step.write('src/app.js', 'export const app = 2;\n')], result: proposing });
    assertRejectedWhole(ctx, done, 'src/app.js');
  });

  test('another role changes only the protected set (a Reviewer): rejected whole', async (t) => {
    const ctx = await protectedProject(t);
    const done = await roleRun(ctx.fx, ctx.project.id, 'review', { steps: [tighter] });
    assertRejectedWhole(ctx, done, CHECK);
  });
});

describe('M36 what a Verifier and a Reviewer may not change', () => {
  test('a Verifier that changes only a source file, and a Reviewer that writes a file of its own, are rejected whole', async (t) => {
    const ctx = await protectedProject(t);
    const verifier = await roleRun(ctx.fx, ctx.project.id, 'verification', { steps: [step.write('src/app.js', 'export const app = 3;\n')] });
    assertRejectedWhole(ctx, verifier, 'src/app.js');
    const reviewer = await roleRun(ctx.fx, ctx.project.id, 'review', { steps: [step.write('notes/review.md', '# notes\n')] });
    assertRejectedWhole(ctx, reviewer, 'notes/review.md');
  });
});
