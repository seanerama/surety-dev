// M22 (slice 3). Plan §3.3 M22 ("integration branch checked out elsewhere");
// build spec §6 correction 6 (RN R5; E20; Review B05); D1 §7.5; D1-19,
// D1-36; SEAM.md §§27, 30, 33.
//
// `git update-ref` moves a branch and leaves a work tree that has that
// branch checked out behind: its index and files are still the old commit's,
// and the checkout looks dirty. D1 draft 3 had no protocol for updating such
// a checkout. In force instead: the integration branch is engine-owned. If
// it is checked out in any worktree the engine does not own, an integration
// is refused before the ref moves, with an instruction to switch that
// worktree to another branch or detach it. The check is made again
// immediately before the compare-and-swap. Whatever the checkout holds, a
// developer's uncommitted edits included, is left exactly as it was. A
// developer's worktree that is detached, or on another branch, is the
// supported topology: integration goes through, touches none of them, and
// reports nothing out of band. No checkout-updating protocol exists.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { assertRefused } from './harness/fixtures.mjs';
import { assertWorkHistory } from './harness/invariants.mjs';
import { PERMITTED_EDIT, addGitProject, addItem, permittedEdit, roleThat, roleThatHolds, runToEnd, runToHold } from './harness/gitruns.mjs';
import { armBarrier, assertCommitted, createProject, eventsOfType, journalBarrier, operationsOf, outOfBand, registryOf } from './harness/journal.mjs';
import { addLinkedWorktree, checkoutState, gitQuiet, makeProjectRepo, refOid, repoFingerprint } from './harness/repos.mjs';
import { installProject, releaseBarrier } from './harness/engine.mjs';
import { answerDecision, countOf, decisionsAbout, resolvedPath, run as runRow, scriptedEngine, tick, waitForRun, waitForWork, workItem } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';

// The integration of this run was refused because `worktree` has the branch
// checked out: nothing moved, and the way out is said.
async function assertRefusedForCheckout(fx, project, item, runId, worktree) {
  const run = runRow(fx.home, runId);
  assert.deepEqual([run.state, run.outcome, run.reason_class], ['ended', 'failed', 'integration_conflict'], `the run ends failed with an integration conflict (${run.reason_text})`);
  assert.ok(run.reason_text.includes(resolvedPath(worktree)) || run.reason_text.includes(worktree), `the run's reason names the worktree that has the branch checked out (it says: ${run.reason_text})`);
  const shown = await fx.engine.get(`/v1/projects/${project.id}/runs/${runId}`);
  assert.equal(shown.body?.run?.code, 'integration_conflict', 'the run is reported with the public code');

  assert.equal(refOid(project.repo.path, project.repo.ref), project.base, 'the integration branch has not moved');
  assert.equal(registryOf(fx.home, project.id)[project.repo.ref].expected_oid, project.base, 'and the registry expects it where it was');
  assert.deepEqual(operationsOf(fx.home, { run: runId, journalKind: 'ref_update' }).filter((op) => op.status === 'succeeded'), [], 'no ref update of the run succeeded');

  const parked = await waitForWork(fx.home, item, 'parked');
  const blocker = JSON.parse(parked.blocker);
  assert.equal(blocker.reason, 'integration_branch_checked_out', 'the work is parked with its cause');
  const [decision] = decisionsAbout(fx.home, item, 'blocker').filter((d) => d.status === 'open');
  assert.ok(decision, 'an open blocker names the work item');
  assert.ok(decision.question.includes(resolvedPath(worktree)) || decision.question.includes(worktree), `the blocker names the worktree (it asks: ${decision.question})`);
  assert.match(decision.question, /switch|detach/i, 'and says how to free the branch');
  withStore(fx.home, (db) => assertWorkHistory(db, item));
  return decision;
}

describe('M22 an integration is refused while the branch is checked out in a worktree the engine does not own', () => {
  test("checked out in the repository's own work tree: the ref does not move, the checkout is left as it was, the work is parked with the way out, and once the branch is freed a retry integrates", async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx, { primary: 'integration' });
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThat([permittedEdit()]), roleThat([permittedEdit()])]);
    const checkout = checkoutState(project.repo.path);
    assert.equal(checkout.branch, project.repo.ref, 'the fixture is live: the developer has the integration branch checked out');

    const run = await runToEnd(fx, project.id, item);
    const decision = await assertRefusedForCheckout(fx, project, item, run.id, project.repo.path);
    assert.deepEqual(checkoutState(project.repo.path), checkout, "the developer's checkout is exactly as it was: HEAD, branch, index and files");

    // The developer frees the branch; the blocker's retry lets the work run again, and it integrates.
    gitQuiet(project.repo.path, ['checkout', '-q', '--detach']);
    await answerDecision(fx.engine, project.id, decision.id, 'retry');
    const second = await runToEnd(fx, project.id, item, { index: 1 });
    assertCommitted(fx, second.id, { kind: 'engine_commit', parent: project.base, integrated: true, changes: { [PERMITTED_EDIT.path]: 'A' } });
    assert.equal(gitQuiet(project.repo.path, ['rev-parse', 'HEAD']), project.base, "the developer's detached checkout stays on the commit it was on");
  });

  test('checked out in a linked worktree with uncommitted edits: refused the same way, and every edit, staged or not, is still there', async (t) => {
    const fx = await scriptedEngine(t);
    // The developer's dirty checkout is there before the project is installed: it is what the engine first sees.
    const repo = makeProjectRepo(join(fx.root, 'repo-linked'));
    const linked = addLinkedWorktree(repo.path, join(fx.root, 'developer-on-main'), { branch: 'main' });
    writeFileSync(join(linked, 'README.md'), '# fixture, being edited by the developer\n');
    writeFileSync(join(linked, 'staged.txt'), 'staged by the developer\n');
    gitQuiet(linked, ['add', 'staged.txt']);
    writeFileSync(join(linked, 'untracked.txt'), 'not yet added\n');
    const checkout = checkoutState(linked);
    assert.deepEqual([checkout.branch, checkout.staged], [repo.ref, 'A\tstaged.txt'], 'the fixture is live: a dirty checkout of the integration branch');
    const project = { id: await installProject(fx.engine, { repoPath: repo.path }), repo, base: repo.head };

    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThat([permittedEdit()])]);
    const run = await runToEnd(fx, project.id, item);
    await assertRefusedForCheckout(fx, project, item, run.id, linked);
    assert.deepEqual(checkoutState(linked), checkout, "the developer's edits, staged and unstaged, and untracked files are untouched");
  });

  test('checked out between the commit and the compare-and-swap: the second check, just before the ref would move, refuses it', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThatHolds([permittedEdit()])]);
    const { run } = await runToHold(fx, project.id, item);
    // Stop the integration between its journaled intent and its effect.
    const barrier = journalBarrier('ref_update', 'intent_committed');
    await armBarrier(fx.engine, barrier, 'pause');
    fx.scripted.release(item);
    await fx.engine.waitUntil(`barrier:${barrier}`);
    const [intended] = operationsOf(fx.home, { run: run.id, journalKind: 'ref_update' });
    assert.deepEqual(intended.events.map((e) => e.kind), ['intended'], 'the ref update is journaled and not yet applied');
    assert.equal(intended.events[0].payload.old_oid, project.base);
    assert.equal(refOid(project.repo.path, project.repo.ref), project.base);

    // Now the developer checks the branch out.
    const linked = addLinkedWorktree(project.repo.path, join(fx.root, 'developer-late'), { branch: 'main' });
    const checkout = checkoutState(linked);
    await releaseBarrier(fx.engine, barrier);
    await waitForRun(fx.home, item, { state: 'ended' });
    await assertRefusedForCheckout(fx, project, item, run.id, linked);
    const [after] = operationsOf(fx.home, { run: run.id, journalKind: 'ref_update' });
    assert.deepEqual([after.events.map((e) => e.kind), after.status], [['intended', 'failed'], 'failed'], 'the journaled ref update was refused before its effect, and is recorded as failed');
    assert.deepEqual(checkoutState(linked), checkout, 'the checkout made in between is untouched');
  });

  test('a project is not created through the API on a repository whose integration branch is checked out; once it is freed, it is', async (t) => {
    const fx = await scriptedEngine(t);
    const repo = makeProjectRepo(join(fx.root, 'repo-checked-out'), { primary: 'integration' });
    const before = { repo: repoFingerprint(repo.path), checkout: checkoutState(repo.path) };
    const res = await fx.engine.post('/v1/projects', { name: 'checked-out', tier: 'T2', dev_repo_path: repo.path, integration_branch: 'main' });
    assertRefused(res, 409, 'integration_conflict', 'bootstrap onto a checked-out integration branch');
    assert.equal(resolvedPath(res.body.subject?.worktree ?? ''), resolvedPath(repo.path), 'the refusal names the worktree');
    assert.match(res.body.what_to_do, /switch|detach/i, 'and says how to free the branch');
    assert.equal(countOf(fx.home, 'projects'), 0, 'no project was created');
    assert.deepEqual({ repo: repoFingerprint(repo.path), checkout: checkoutState(repo.path) }, before, 'the repository and the checkout are as they were');

    gitQuiet(repo.path, ['checkout', '-q', '--detach']);
    const { id } = await createProject(fx.engine, { repoPath: repo.path, name: 'checked-out' });
    assert.notEqual(refOid(repo.path, repo.ref), repo.head, 'with the branch free, the bootstrap commit is integrated');
    assert.equal(registryOf(fx.home, id)[repo.ref].expected_oid, refOid(repo.path, repo.ref));
  });
});

describe('M22 the supported topology integrates, and no checkout is touched', () => {
  test("with the developer's work tree on another branch, one linked worktree detached and one on a feature branch, the integration goes through and reports nothing out of band", async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx, { primary: 'other' });
    const detached = addLinkedWorktree(project.repo.path, join(fx.root, 'developer-detached'), { at: project.base });
    const feature = addLinkedWorktree(project.repo.path, join(fx.root, 'developer-feature'), { branch: 'feature/x', at: project.base });
    writeFileSync(join(feature, 'wip.txt'), 'work in progress on a feature branch\n');
    const checkouts = { primary: project.repo.path, detached, feature };
    const before = Object.fromEntries(Object.entries(checkouts).map(([name, dir]) => [name, checkoutState(dir)]));
    assert.deepEqual([before.primary.branch, before.detached.branch, before.feature.branch], ['refs/heads/dev/work', null, 'refs/heads/feature/x'], 'the fixture is live: no worktree has the integration branch checked out');

    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThat([permittedEdit()])]);
    const run = await runToEnd(fx, project.id, item);
    const committed = assertCommitted(fx, run.id, { kind: 'engine_commit', parent: project.base, integrated: true, changes: { [PERMITTED_EDIT.path]: 'A' } });
    assert.notEqual(committed.sha, project.base);

    for (const [name, dir] of Object.entries(checkouts)) assert.deepEqual(checkoutState(dir), before[name], `the developer's ${name} checkout is exactly as it was`);
    for (let i = 0; i < 2; i++) await tick(fx.engine, project.id);
    assert.deepEqual(outOfBand(fx.home, project.id), [], 'no checkout is reported dirty, no ref out of band: the move was the engine\'s own');
    assert.equal(eventsOfType(fx.home, 'repo.out_of_band').length, 0);
    assert.notEqual(workItem(fx.home, item).status, 'parked');
  });
});
