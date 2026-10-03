// M46, the `out_of_band_change` manifest (slice 5). Plan §3.5 M46; build
// spec §6 corrections 6 and 22; RN §3 B12; Review B05, B12; D1 §§7.6, 10.5,
// D1-04, D1-11, D1-15, D1-36; SEAM.md §§32, 76, 79.
//
// The stored observation says what was found when the engine looked. A
// developer can edit the checkout, or move the ref, again after the preview
// was shown, and the stored row does not change by that. So before an
// answer takes effect the engine compares the actual ref or checkout with
// what the preview showed, afresh: a difference refuses the answer, nothing
// is reset, stashed or adopted, and the newer edit is preserved. A valid
// answer reconciles exactly the state that was reviewed, through the
// journal.
//
// Both subjects, per the Plan: a managed checkout (the positive answer, a
// change after the preview, and a change after the answer and before the
// effect) and a registered ref (a change after the preview). The two
// answers for a ref with no change in between are slice 3's (rows M24, M28).

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { releaseBarrier, waitFor, within } from './harness/engine.mjs';
import { INTENT_BARRIER, answer, answerAndHoldEffect, assertEffectInvalidated, assertPreview, assertStaleAnswer, consume, decision, decisionsOfKind, intentsOf, reachBarrier } from './harness/decisions.mjs';
import { addGitProject, addItem, roleThatHolds, runToHold } from './harness/gitruns.mjs';
import { armBarrier, assertOperations, eventsOfType, managedCheckouts, operationsOf, outOfBand, registryOf, revisionsOf } from './harness/journal.mjs';
import { changedPaths, checkoutState, commitOnRef, fileAt, gitQuiet, parentsOf, refOid, trackedTree, treeOf } from './harness/repos.mjs';
import { scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';

const ORIGINAL = 'export const lib = 1;\n';
const edit = (n) => `export const lib = ${n}; // the developer's edit number ${n}\n`;
const oobRefs = (fx, project) => Object.entries(registryOf(fx.home, project.id)).filter(([, row]) => row.kind === 'oob').map(([name]) => name);

// A developer's checkout of the integration branch with a tracked file
// edited, observed, and the decision about it previewed.
async function dirtyCheckout(t) {
  const fx = await scriptedEngine(t);
  const project = await addGitProject(fx, { primary: 'integration', files: { 'src/lib.js': ORIGINAL } });
  const file = join(project.repo.path, 'src/lib.js');
  writeFileSync(file, edit(1));
  await tick(fx.engine, project.id);
  const [observed] = outOfBand(fx.home, project.id);
  assert.deepEqual([observed?.subject_kind, observed?.decision.options], ['checkout', ['adopt', 'stash']], 'the fixture is live: a checkout observation offering stash and adopt');
  return { fx, project, file, observed, previewed: assertPreview(decision(fx.home, observed.decision.id)) };
}

// The slice-2 review's fixture (S1, S2; SEAM.md §111): a developer's checkout
// of the integration branch with a new file staged, and a tracked file whose
// staged version was then superseded in the work tree, observed, and the
// decision about it previewed. `reviewed` is the tree the checkout's tracked
// content is, computed test-side (`trackedTree`): what `git commit -a` would
// commit, so it holds the staged file and the work-tree version of the edit.
const ADDED = 'export const added = 1;\n';
async function stagedCheckout(t) {
  const fx = await scriptedEngine(t);
  const project = await addGitProject(fx, { primary: 'integration', files: { 'src/lib.js': ORIGINAL } });
  const repo = project.repo.path;
  const added = join(repo, 'src/new.js');
  const file = join(repo, 'src/lib.js');
  writeFileSync(added, ADDED);
  gitQuiet(repo, ['add', 'src/new.js']);
  writeFileSync(file, edit(1));
  gitQuiet(repo, ['add', 'src/lib.js']);
  writeFileSync(file, edit(2));
  const reviewed = trackedTree(repo);
  assert.deepEqual(
    [checkoutState(repo).staged, fileAt(repo, reviewed, 'src/new.js'), fileAt(repo, reviewed, 'src/lib.js')],
    ['M\tsrc/lib.js\nA\tsrc/new.js', ADDED, edit(2)],
    'the fixture is live: a new file and an edit are staged, the edit superseded on disk, and the reviewed tree holds the staged file and the work-tree edit',
  );
  await tick(fx.engine, project.id);
  const [observed] = outOfBand(fx.home, project.id);
  assert.deepEqual([observed?.subject_kind, observed?.decision.options], ['checkout', ['adopt', 'stash']], 'the fixture is live: a checkout observation offering stash and adopt');
  return { fx, project, repo, added, file, reviewed, observed, previewed: assertPreview(decision(fx.home, observed.decision.id)) };
}

// The decision the engine raised after it found the subject changed again:
// the old one is closed and exactly one other is open.
const raisedAgain = (fx, project, previewed) =>
  tickUntil(
    fx.engine,
    project.id,
    () => {
      const open = decisionsOfKind(fx.home, project.id, 'out_of_band_change').filter((row) => row.status === 'open' && row.id !== previewed.id);
      return decision(fx.home, previewed.id).status !== 'open' && open.length === 1 ? assertPreview(open[0]) : undefined;
    },
    { max: 4, what: 'the observation to be raised again with what is there now' },
  );

describe('M46 a checkout observation', () => {
  test('a valid stash reconciles exactly the reviewed state, through the journal: the edit is kept under a registered ref and the checkout is back at its baseline', async (t) => {
    const { fx, project, file, observed, previewed } = await dirtyCheckout(t);
    await consume(fx, project.id, previewed, 'stash');
    await waitFor(() => outOfBand(fx.home, project.id)[0].disposition === 'stash' && intentsOf(fx.home, previewed.id)[0]?.status === 'done', { what: 'the stash to be recorded and its effect done' });

    const kept = oobRefs(fx, project);
    assert.equal(kept.length, 1, 'one registered oob ref');
    assert.equal(fileAt(project.repo.path, kept[0], 'src/lib.js'), edit(1), 'it holds the edit that was reviewed');
    assert.equal(readFileSync(file, 'utf8'), ORIGINAL, 'the checkout is back at its baseline');
    assert.deepEqual([checkoutState(project.repo.path).head, checkoutState(project.repo.path).staged], [project.base, '']);
    assert.deepEqual(intentsOf(fx.home, previewed.id).map((intent) => intent.status), ['done'], 'the effect was intended at consumption and is done');
    assert.equal(eventsOfType(fx.home, 'repo.reconciled').length, 1);
    assertOperations(fx.home, { project: project.id });
    await tick(fx.engine, project.id);
    assert.deepEqual(outOfBand(fx.home, project.id).map((row) => row.id), [observed.id], "the engine's own restore is not observed in turn");
  });

  test('the file is edited again after the preview: the answer is refused by a fresh comparison, nothing is stashed or reset, and the new edit is preserved', async (t) => {
    const { fx, project, file, previewed } = await dirtyCheckout(t);
    writeFileSync(file, edit(2));
    await assertStaleAnswer(fx, project.id, previewed, 'stash');
    assert.deepEqual([readFileSync(file, 'utf8'), oobRefs(fx, project)], [edit(2), []], 'the newer edit is where the developer left it, and nothing was stashed');

    const next = await raisedAgain(fx, project, previewed);
    assert.notEqual(next.preview_hash, previewed.preview_hash);
    assert.notDeepEqual(next.manifest.found, previewed.manifest.found, 'the new preview shows what is there now');
    await consume(fx, project.id, next, 'stash');
    await waitFor(() => oobRefs(fx, project).length === 1, { what: 'the stash' });
    assert.equal(fileAt(project.repo.path, oobRefs(fx, project)[0], 'src/lib.js'), edit(2), 'a valid answer stashes exactly what its preview showed');
  });

  test('the file is edited again after the answer and before the effect: the effect is invalidated, never run, and the edit is preserved', async (t) => {
    const { fx, project, file, previewed } = await dirtyCheckout(t);
    const held = await answerAndHoldEffect(fx, project.id, previewed, 'stash');
    writeFileSync(file, edit(3));
    await assertEffectInvalidated(fx, previewed, held);
    assert.deepEqual([readFileSync(file, 'utf8'), oobRefs(fx, project)], [edit(3), []], 'nothing was stashed or reset: the edit made in between is still there');
    assert.equal(outOfBand(fx.home, project.id).filter((row) => row.disposition !== null).length, 0, 'no observation was recorded as reconciled');
    await raisedAgain(fx, project, previewed);
  });

  // The slice-2 review, S2 (SEAM.md §111): a staged new file is stashed, not lost.
  test('stash of a checkout with a staged new file and a staged edit superseded on disk: the oob ref holds the staged file and the work-tree edit, and the checkout is back at its baseline with nothing lost that the ref does not hold', async (t) => {
    const { fx, project, repo, added, file, reviewed, observed, previewed } = await stagedCheckout(t);
    await consume(fx, project.id, previewed, 'stash');
    await waitFor(() => outOfBand(fx.home, project.id)[0].disposition === 'stash' && intentsOf(fx.home, previewed.id)[0]?.status === 'done', { what: 'the stash to be recorded and its effect done' });

    const kept = oobRefs(fx, project);
    assert.equal(kept.length, 1, 'one registered oob ref');
    assert.equal(treeOf(repo, kept[0]), reviewed, `it holds the tree the checkout's tracked content was: the index plus the work-tree content of the paths the index lists (against the baseline the ref changes ${JSON.stringify(changedPaths(repo, project.base, kept[0]))})`);
    assert.deepEqual(changedPaths(repo, project.base, kept[0]), { 'src/lib.js': 'M', 'src/new.js': 'A' }, 'against the baseline: the staged addition and the edit, nothing else');
    assert.deepEqual([fileAt(repo, kept[0], 'src/new.js'), fileAt(repo, kept[0], 'src/lib.js')], [ADDED, edit(2)], 'the staged file is in the stash, and the edit as the work tree had it, which supersedes the staged version');

    // The checkout is at its baseline: HEAD, index and files as the baseline
    // says; the staged file is in the stash and not on disk as a stray.
    assert.deepEqual([checkoutState(repo).head, gitQuiet(repo, ['status', '--porcelain', '--untracked-files=all']), readFileSync(file, 'utf8')], [project.base, '', ORIGINAL], 'the checkout is back at its baseline, clean');
    assert.ok(!existsSync(added) || readFileSync(added, 'utf8') === ADDED, 'what is on disk of the new file, if anything, is what the ref holds');
    assert.deepEqual(outOfBand(fx.home, project.id).map((row) => [row.id, row.disposition]), [[observed.id, 'stash']]);
    assertOperations(fx.home, { project: project.id });
    await tick(fx.engine, project.id);
    assert.equal(outOfBand(fx.home, project.id).length, 1, "the engine's own restore is not observed in turn");
  });
});

// M2 slice 2, B2 (SEAM.md §106): the other answer a checkout observation
// offers. `adopt` takes the developer's edits as the new starting point: the
// engine commits the reviewed tracked content as one out-of-band revision on
// the integration branch, through the journal, and the project goes on from
// it. Nothing of the edits is lost or duplicated, and the developer's files
// are left as they were.
describe('M46 adopt of a checkout', () => {
  test('adopt takes the edits as the new starting point: one engine-made out-of-band revision on the integration branch holds exactly the reviewed content, the observation is reconciled, the files are untouched and not observed again, and the next run is based on it', async (t) => {
    const { fx, project, file, observed, previewed } = await dirtyCheckout(t);
    const repo = project.repo.path;
    const reviewed = trackedTree(repo);
    const [checkout] = managedCheckouts(fx.home, project.id).filter((c) => c.kind === 'integration_worktree');
    assert.deepEqual([checkout.baseline.head, JSON.parse(observed.found).tracked_tree_hash], [project.base, reviewed], 'the fixture is live: the observation found the tree the checkout holds, on the baseline');

    await consume(fx, project.id, previewed, 'adopt');
    await waitFor(() => outOfBand(fx.home, project.id)[0].disposition === 'adopt' && intentsOf(fx.home, previewed.id)[0]?.status === 'done', { what: 'the adoption to be recorded and its effect done' });

    // One commit on the branch, on top of where it was, holding exactly what was reviewed.
    const adopted = refOid(repo, project.repo.ref);
    assert.notEqual(adopted, project.base, 'the integration branch moved');
    assert.deepEqual(parentsOf(repo, adopted), [project.base], 'by one commit, on top of where it was');
    assert.equal(treeOf(repo, adopted), reviewed, 'whose tree is exactly the tracked content that was reviewed');
    assert.deepEqual(changedPaths(repo, project.base, adopted), { 'src/lib.js': 'M' }, 'it changes the edited file and nothing else');
    assert.equal(fileAt(repo, adopted, 'src/lib.js'), edit(1), 'and holds the edit');
    assert.equal(registryOf(fx.home, project.id)[project.repo.ref].expected_oid, adopted, 'the registry expects the branch there');
    const outOfBandRevisions = revisionsOf(fx.home, { project: project.id }).filter((row) => row.kind === 'out_of_band');
    assert.deepEqual(outOfBandRevisions.map((row) => [row.sha, row.created_by_run]), [[adopted, null]], 'one out-of-band revision records the commit, made by no run');

    // Through the journal: the branch update is a compare-and-swap from the
    // commit the branch was at, and every operation of the project is sound.
    const moves = operationsOf(fx.home, { project: project.id, journalKind: 'ref_update' }).filter((op) => op.events[0].payload.ref === project.repo.ref);
    assert.deepEqual(moves.map((op) => [op.events[0].payload.old_oid, op.events[0].payload.new_oid, op.status, op.finalized]), [[project.base, adopted, 'succeeded', true]], 'the branch update was journaled as a compare-and-swap and finalized');
    assertOperations(fx.home, { project: project.id });
    assert.deepEqual(intentsOf(fx.home, previewed.id).map((intent) => intent.status), ['done'], 'the effect was intended at consumption and is done');
    assert.equal(eventsOfType(fx.home, 'repo.reconciled').length, 1, 'the observation is reconciled once');

    // The developer's files are as they were left; the checkout, still on the
    // branch, now stands at the adopted commit and is not observed again.
    assert.equal(readFileSync(file, 'utf8'), edit(1), "the developer's edit is where it was: nothing was reset or stashed");
    assert.deepEqual([checkoutState(repo).head, checkoutState(repo).branch], [adopted, project.repo.ref], 'the checkout is on the integration branch at the adopted commit');
    await tick(fx.engine, project.id);
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, project.id);
    assert.deepEqual(outOfBand(fx.home, project.id).map((row) => [row.id, row.disposition]), [[observed.id, 'adopt']], "the engine's own adoption is not observed in turn, across ticks and a restart");
    assert.equal(readFileSync(file, 'utf8'), edit(1));

    // The project dispatches again, and the next run starts from the adopted commit, edits included.
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThatHolds([step.write('src/next.js', 'export const next = 1;\n')])]);
    const { run, workspace } = await runToHold(fx, project.id, item);
    assert.equal(run.base_revision, adopted, "the next run's base is the adopted commit");
    assert.equal(readFileSync(join(workspace.path, 'src/lib.js'), 'utf8'), edit(1), 'its workspace holds the adopted edit');
    fx.scripted.release(item);
  });

  test('the file is edited again after the answer and before the effect: the adoption is invalidated, never made, and the edit is preserved', async (t) => {
    const { fx, project, file, previewed } = await dirtyCheckout(t);
    const repo = project.repo.path;
    // The answer is accepted and its effect intended; the engine is held
    // before the fresh comparison that precedes the effect (SEAM.md §76).
    await armBarrier(fx.engine, INTENT_BARRIER, 'pause');
    const pending = answer(fx.engine, project.id, previewed, 'adopt').catch((err) => err);
    // The response may be held until the barrier is released; one that comes
    // back at once is a refusal, or an engine that runs the effect at a tick.
    const early = await within(pending, 1500);
    if (early !== null) assert.equal(early.status, 200, `adopt of a checkout is accepted (body: ${early.text})`);
    await reachBarrier(fx, project.id, INTENT_BARRIER);
    assert.deepEqual([decision(fx.home, previewed.id).status, intentsOf(fx.home, previewed.id).map((intent) => intent.status)], ['consumed', ['pending']], 'the decision is consumed with one effect intent that has not begun');

    writeFileSync(file, edit(3));
    await assertEffectInvalidated(fx, previewed, {
      release: async () => {
        await releaseBarrier(fx.engine, INTENT_BARRIER);
        return pending;
      },
    });
    assert.deepEqual(
      [refOid(repo, project.repo.ref), registryOf(fx.home, project.id)[project.repo.ref].expected_oid, revisionsOf(fx.home, { project: project.id }).filter((row) => row.kind === 'out_of_band').length, readFileSync(file, 'utf8')],
      [project.base, project.base, 0, edit(3)],
      'nothing was adopted: the branch and the registry are where they were, no revision was recorded, and the edit made in between is still there',
    );
    assert.equal(outOfBand(fx.home, project.id).filter((row) => row.disposition !== null).length, 0, 'no observation was recorded as reconciled');
    assert.equal(eventsOfType(fx.home, 'repo.reconciled').length, 0);
    const next = await raisedAgain(fx, project, previewed);
    assert.notDeepEqual(next.manifest.found, previewed.manifest.found, 'the new preview shows what is there now');
  });

  // The slice-2 review, S1 (SEAM.md §111): a staged new file is adopted, not lost.
  test('adopt of a checkout with a staged new file and a staged edit superseded on disk: the adopted revision holds the index plus the work-tree content of the paths the index lists, git status is clean afterwards, the file is on disk and in the next run\'s base', async (t) => {
    const { fx, project, repo, added, file, reviewed, observed, previewed } = await stagedCheckout(t);
    await consume(fx, project.id, previewed, 'adopt');
    await waitFor(() => outOfBand(fx.home, project.id)[0].disposition === 'adopt' && intentsOf(fx.home, previewed.id)[0]?.status === 'done', { what: 'the adoption to be recorded and its effect done' });

    const adopted = refOid(repo, project.repo.ref);
    assert.deepEqual(parentsOf(repo, adopted), [project.base], 'the integration branch gained one commit, on top of where it was');
    assert.equal(treeOf(repo, adopted), reviewed, 'whose tree is the index plus the work-tree content of the paths the index lists: what git commit -a would have committed');
    assert.deepEqual(changedPaths(repo, project.base, adopted), { 'src/lib.js': 'M', 'src/new.js': 'A' }, 'it adds the staged file and changes the edited one, nothing else');
    assert.deepEqual([fileAt(repo, adopted, 'src/new.js'), fileAt(repo, adopted, 'src/lib.js')], [ADDED, edit(2)], 'the staged file is adopted, and the edit as the work tree had it, which supersedes the staged version');
    assert.equal(registryOf(fx.home, project.id)[project.repo.ref].expected_oid, adopted);

    // Afterwards: the files are on disk as the developer had them, and git
    // status is clean (E53 item 3: the index is reset to the adopted commit).
    assert.deepEqual([readFileSync(added, 'utf8'), readFileSync(file, 'utf8')], [ADDED, edit(2)], 'the new file and the edit are on disk as the developer left them');
    assert.deepEqual([checkoutState(repo).head, checkoutState(repo).branch, gitQuiet(repo, ['status', '--porcelain', '--untracked-files=all'])], [adopted, project.repo.ref, ''], 'the checkout is on the branch at the adopted commit, with nothing staged, modified or untracked');
    assertOperations(fx.home, { project: project.id });
    await tick(fx.engine, project.id);
    assert.deepEqual(outOfBand(fx.home, project.id).map((row) => [row.id, row.disposition]), [[observed.id, 'adopt']], 'not observed again');

    // The next run starts from the adopted commit, the staged file in its base.
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThatHolds([step.write('src/next.js', 'export const next = 1;\n')])]);
    const { run, workspace } = await runToHold(fx, project.id, item);
    assert.equal(run.base_revision, adopted, "the next run's base is the adopted commit");
    assert.deepEqual([readFileSync(join(workspace.path, 'src/new.js'), 'utf8'), readFileSync(join(workspace.path, 'src/lib.js'), 'utf8')], [ADDED, edit(2)], 'its workspace holds the adopted file and edit');
    fx.scripted.release(item);
  });
});

describe('M46 a ref observation', () => {
  test('the branch is moved again after the preview: adopt is refused, nothing is adopted or reset, and the next preview shows the commit that is there now', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const first = commitOnRef(project.repo.path, project.repo.ref, { 'stray.txt': 'one\n' }, { message: 'developer: a first commit' });
    await tick(fx.engine, project.id);
    const [observed] = outOfBand(fx.home, project.id);
    assert.deepEqual([observed?.subject_kind, observed?.found], ['ref', first], 'the fixture is live: the first commit was observed');
    const previewed = assertPreview(decision(fx.home, observed.decision.id));

    const second = commitOnRef(project.repo.path, project.repo.ref, { 'stray.txt': 'two\n' }, { message: 'developer: a second commit' });
    await assertStaleAnswer(fx, project.id, previewed, 'adopt');
    assert.deepEqual(
      [refOid(project.repo.path, project.repo.ref), registryOf(fx.home, project.id)[project.repo.ref].expected_oid, revisionsOf(fx.home, { project: project.id }).filter((row) => row.kind === 'out_of_band').length],
      [second, project.base, 0],
      'the branch is where the developer put it, the registry expects what it expected, and nothing was adopted',
    );

    const next = await raisedAgain(fx, project, previewed);
    assert.equal(next.manifest.found, second, 'the next preview is about the commit that is there now');
    await consume(fx, project.id, next, 'adopt');
    await waitFor(() => registryOf(fx.home, project.id)[project.repo.ref].expected_oid === second, { what: 'the adoption of the reviewed commit' });
  });
});
