// M24 (slice 3). Plan §3.3 M24 ("tracked refs versus developer refs"); D1
// §§7.2, 7.6, 11.5; D1-11, D1-18; SEAM.md §§27, 32, 33.
//
// The engine tracks the refs it registered: the integration branch and the
// refs it creates itself under refs/surety/. Each has an expected commit.
// Integrity, at every tick before anything of the project is dispatched and
// at startup, reads them. A registered ref that has another commit than its
// expected one, or is gone, is an out-of-band change: it is recorded, a
// decision is raised, the project is blocked, and nothing is absorbed or
// undone until a person answers. `discard` puts the ref back through the
// journal and keeps the stray commit under refs/surety/oob/; `adopt` makes
// the commit found the expected one. The engine's own journaled ref
// operations are never observed. Every other ref is the developer's and has
// no effect at all.
//
// Not in this file: that an observation blocks the gates it affects (slice
// 5); the decision's dependency manifest (row M46, slice 5); a nomination
// ref moved or deleted (with row M27, the second slice-3 session).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertRefused } from './harness/fixtures.mjs';
import { PERMITTED_EDIT, addGitProject, addItem, permittedEdit, roleThat, runToEnd } from './harness/gitruns.mjs';
import { assertCommitted, assertOrdinaryCourse, changePolicy, eventsOfType, operationsOf, outOfBand, registryOf, revisionsOf } from './harness/journal.mjs';
import { commitOnRef, gitQuiet, refOid, refsContaining, refsOf } from './harness/repos.mjs';
import { waitFor } from './harness/engine.mjs';
import { answerDecision, getRow, runsOf, scriptedEngine, tick, workItem } from './harness/runs.mjs';

const MAIN = 'refs/heads/main';
const ticks = async (fx, project, n = 2) => {
  for (let i = 0; i < n; i++) await tick(fx.engine, project);
};

// A project whose integration branch someone else has moved to a stray
// commit, with one eligible item, observed by a tick.
async function movedIntegrationBranch(t) {
  const fx = await scriptedEngine(t);
  const project = await addGitProject(fx);
  const item = await addItem(fx, project.id, 'fix');
  fx.scripted.script(item, [roleThat([permittedEdit()])]);
  const stray = commitOnRef(project.repo.path, MAIN, { 'stray.txt': 'pushed by someone else\n' }, { message: 'a commit the engine did not make' });
  await ticks(fx, project.id);
  return { fx, project, item, stray };
}

// The one unreconciled observation the fixture above produces, in full.
function assertMovedRefObserved(fx, project, stray) {
  const observed = outOfBand(fx.home, project.id);
  assert.equal(observed.length, 1, `one observation, however many ticks ran (found ${observed.length})`);
  const [o] = observed;
  assert.deepEqual(
    { subject_kind: o.subject_kind, ref: o.ref_name, expected: o.expected, found: o.found, disposition: o.disposition },
    { subject_kind: 'ref', ref: MAIN, expected: project.base, found: stray, disposition: null },
    'the observation names the ref, what was expected and what was found',
  );
  assert.deepEqual(
    { kind: o.decision.kind, subject_type: o.decision.subject_type, subject_id: o.decision.subject_id, status: o.decision.status, options: o.decision.options },
    { kind: 'out_of_band_change', subject_type: 'out_of_band_change', subject_id: o.id, status: 'open', options: ['adopt', 'discard'] },
    'its decision is open and offers what is legal for a ref: discard and adopt',
  );
  assert.equal(eventsOfType(fx.home, 'repo.out_of_band').length, 1, 'repo.out_of_band was emitted once');
  // Nothing absorbed, nothing undone.
  assert.equal(registryOf(fx.home, project.id)[MAIN].expected_oid, project.base, 'the registry still expects what it expected');
  assert.equal(refOid(project.repo.path, MAIN), stray, 'and the ref is still where it was put');
  return o;
}

describe('M24 a developer branch has no effect', () => {
  test('a branch and a tag the engine does not track are created, moved and deleted: no observation, no decision, and the project goes on', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const repo = project.repo.path;
    commitOnRef(repo, 'refs/heads/feature/x', { 'feature.txt': 'one\n' }, { parent: project.base });
    await ticks(fx, project.id);
    commitOnRef(repo, 'refs/heads/feature/x', { 'feature.txt': 'two\n' });
    gitQuiet(repo, ['update-ref', 'refs/tags/v0', project.base]);
    gitQuiet(repo, ['update-ref', 'refs/heads/dev/work2', project.base]);
    await ticks(fx, project.id);
    gitQuiet(repo, ['update-ref', '-d', 'refs/heads/feature/x']);
    await ticks(fx, project.id);
    assert.deepEqual(outOfBand(fx.home, project.id), [], 'no observation for refs outside the registry');
    assert.equal(eventsOfType(fx.home, 'repo.out_of_band').length, 0);
    assert.deepEqual(Object.keys(registryOf(fx.home, project.id)), [MAIN], 'and none of them was registered');

    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThat([permittedEdit()])]);
    const run = await runToEnd(fx, project.id, item);
    assertCommitted(fx, run.id, { kind: 'engine_commit', parent: project.base, integrated: true, changes: { [PERMITTED_EDIT.path]: 'A' } });
    assert.equal(refOid(repo, 'refs/tags/v0'), project.base, "the developer's refs are where the developer left them");
    assert.equal(refOid(repo, 'refs/heads/dev/work2'), project.base);
  });
});

describe('M24 a registered ref changed by someone else', () => {
  test('the integration branch moved: observed once, not absorbed, the project blocked, also across a restart', async (t) => {
    const { fx, project, item, stray } = await movedIntegrationBranch(t);
    const o = assertMovedRefObserved(fx, project, stray);
    assert.equal(runsOf(fx.home, item).length, 0, 'nothing of the project was dispatched, not even in the tick that made the observation');
    assert.equal(workItem(fx.home, item).status, 'eligible');
    assertRefused(await fx.engine.post(`/v1/projects/${project.id}/policy`, { repair_attempts_max: 1 }), 409, 'out_of_band_change', 'a command that needs the repository');

    await ticks(fx, project.id, 3);
    await fx.engine.kill();
    await fx.start();
    await ticks(fx, project.id);
    const again = assertMovedRefObserved(fx, project, stray);
    assert.deepEqual([again.id, again.decision.id], [o.id, o.decision.id], 'a restart does not ask the question a second time');
    assert.equal(runsOf(fx.home, item).length, 0, 'and still nothing is dispatched');
  });

  test('discard puts the branch back through the journal, keeps the stray commit under refs/surety/oob/, and the project goes on from the expected commit', async (t) => {
    const { fx, project, item, stray } = await movedIntegrationBranch(t);
    const o = assertMovedRefObserved(fx, project, stray);
    await answerDecision(fx.engine, project.id, o.decision.id, 'discard');
    await waitFor(() => outOfBand(fx.home, project.id)[0].disposition === 'discard', { what: 'the discard to be recorded' });
    const after = outOfBand(fx.home, project.id)[0];
    assert.equal(after.decision.status, 'consumed');
    assert.equal(refOid(project.repo.path, MAIN), project.base, 'the branch is back on its expected commit');
    const reset = operationsOf(fx.home, { project: project.id, journalKind: 'ref_update' }).filter((op) => op.events[0].payload.ref === MAIN);
    assert.equal(reset.length, 1, 'one journaled ref update of the branch');
    assertOrdinaryCourse(reset[0], 'the reset');
    assert.deepEqual({ old_oid: reset[0].events[0].payload.old_oid, new_oid: reset[0].events[0].payload.new_oid }, { old_oid: stray, new_oid: project.base }, 'a compare-and-swap from the commit found to the commit expected');

    // The stray commit is kept, under a registered oob ref.
    const registry = registryOf(fx.home, project.id);
    const kept = Object.entries(registry).filter(([, row]) => row.kind === 'oob');
    assert.equal(kept.length, 1, 'one oob ref is registered');
    const [oobRef, row] = kept[0];
    assert.match(oobRef, /^refs\/surety\/oob\/\d+$/);
    assert.equal(row.expected_oid, stray);
    assert.equal(refOid(project.repo.path, oobRef), stray, 'and it holds the stray commit');
    assert.equal(eventsOfType(fx.home, 'repo.reconciled').length, 1);

    // The engine's own reset and its own oob ref are not observed in turn; the project is dispatched again.
    const run = await runToEnd(fx, project.id, item);
    assert.equal(run.base_revision, project.base, 'the next run starts from the expected commit');
    assertCommitted(fx, run.id, { kind: 'engine_commit', parent: project.base, integrated: true, changes: { [PERMITTED_EDIT.path]: 'A' } });
    await ticks(fx, project.id);
    await fx.engine.kill();
    await fx.start();
    await ticks(fx, project.id);
    assert.equal(outOfBand(fx.home, project.id).length, 1, 'no further observation: the reset, the oob ref and the integration were the engine\'s own');
    assert.equal(eventsOfType(fx.home, 'repo.out_of_band').length, 1);
    assert.equal(refOid(project.repo.path, oobRef), stray);
  });

  test('adopt makes the commit found the expected one, records it as an out-of-band revision, and the project goes on from it', async (t) => {
    const { fx, project, item, stray } = await movedIntegrationBranch(t);
    const o = assertMovedRefObserved(fx, project, stray);
    await answerDecision(fx.engine, project.id, o.decision.id, 'adopt');
    await waitFor(() => outOfBand(fx.home, project.id)[0].disposition === 'adopt', { what: 'the adoption to be recorded' });
    assert.equal(outOfBand(fx.home, project.id)[0].decision.status, 'consumed');
    assert.equal(refOid(project.repo.path, MAIN), stray, 'the branch stays where it was found');
    assert.equal(registryOf(fx.home, project.id)[MAIN].expected_oid, stray, 'and that is now what the registry expects');
    const adopted = revisionsOf(fx.home, { project: project.id }).filter((r) => r.sha === stray);
    assert.deepEqual(adopted.map((r) => [r.kind, r.created_by_run]), [['out_of_band', null]], 'the stray commit is recorded as an out-of-band revision that no run made');
    assert.equal(eventsOfType(fx.home, 'repo.reconciled').length, 1);

    const run = await runToEnd(fx, project.id, item);
    assert.equal(run.base_revision, stray, 'the next run starts from the adopted commit');
    assertCommitted(fx, run.id, { kind: 'engine_commit', parent: stray, integrated: true, changes: { [PERMITTED_EDIT.path]: 'A' } });
    await ticks(fx, project.id);
    assert.equal(outOfBand(fx.home, project.id).length, 1, 'no further observation');
  });

  test('the integration branch deleted: observed with nothing found, the project blocked, and discard restores it', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThat([permittedEdit()])]);
    gitQuiet(project.repo.path, ['update-ref', '-d', MAIN]);
    await ticks(fx, project.id);
    const [o, ...more] = outOfBand(fx.home, project.id);
    assert.deepEqual(more, [], 'one observation');
    assert.deepEqual({ subject_kind: o.subject_kind, ref: o.ref_name, expected: o.expected, found: o.found }, { subject_kind: 'ref', ref: MAIN, expected: project.base, found: null }, 'a ref that is gone is found as null, not as its expected commit');
    assert.ok(o.decision.options.includes('discard') && !o.decision.options.includes('stash'), `a deleted ref offers discard and never stash (it offers ${o.decision.options.join(', ')})`);
    assert.equal(runsOf(fx.home, item).length, 0, 'nothing is dispatched');
    assert.equal(registryOf(fx.home, project.id)[MAIN].expected_oid, project.base);

    await answerDecision(fx.engine, project.id, o.decision.id, 'discard');
    await waitFor(() => refOid(project.repo.path, MAIN) === project.base, { what: 'the branch to be restored' });
    const run = await runToEnd(fx, project.id, item);
    assertCommitted(fx, run.id, { kind: 'engine_commit', parent: project.base, integrated: true, changes: { [PERMITTED_EDIT.path]: 'A' } });
    assert.equal(outOfBand(fx.home, project.id).length, 1);
  });

  test("a ref the engine created for a checkpoint, moved and then deleted by someone else, is observed each time and never absorbed", async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThat([permittedEdit()], { checkpoint: true })]);
    const run = await runToEnd(fx, project.id, item);
    const checkpoint = assertCommitted(fx, run.id, { kind: 'checkpoint', parent: project.base, integrated: false, branchAt: project.base });
    // The checkpoint is reachable only through a ref the engine made and registered.
    const registry = registryOf(fx.home, project.id);
    const engineRefs = refsContaining(project.repo.path, checkpoint.sha).filter((ref) => ref in registry);
    assert.ok(engineRefs.length >= 1 && engineRefs.every((ref) => ref.startsWith('refs/surety/')), `the checkpoint is kept by engine refs (${engineRefs.join(', ')})`);
    const [kept] = engineRefs;
    assert.equal(registry[kept].expected_oid, checkpoint.sha);
    await fx.engine.post(`/v1/projects/${project.id}/pause`, {});

    gitQuiet(project.repo.path, ['update-ref', kept, project.base]);
    await ticks(fx, project.id);
    const moved = outOfBand(fx.home, project.id).filter((o) => o.ref_name === kept);
    assert.equal(moved.length, 1, 'the moved engine ref is observed');
    assert.deepEqual([moved[0].subject_kind, moved[0].expected, moved[0].found], ['ref', checkpoint.sha, project.base]);
    assert.ok(moved[0].decision.options.includes('discard') && !moved[0].decision.options.includes('stash'));
    assert.equal(registryOf(fx.home, project.id)[kept].expected_oid, checkpoint.sha, 'its expected commit is not replaced by the one found');
    assert.equal(refOid(project.repo.path, kept), project.base, 'and it is not put back without an answer');

    // discard restores it; then it is deleted, and that is observed anew.
    await answerDecision(fx.engine, project.id, moved[0].decision.id, 'discard');
    await waitFor(() => refOid(project.repo.path, kept) === checkpoint.sha, { what: 'the engine ref to be restored' });
    await ticks(fx, project.id);
    assert.equal(outOfBand(fx.home, project.id).filter((o) => o.ref_name === kept && o.disposition === null).length, 0, 'the restored ref is as expected');
    gitQuiet(project.repo.path, ['update-ref', '-d', kept]);
    await ticks(fx, project.id);
    const gone = outOfBand(fx.home, project.id).filter((o) => o.ref_name === kept && o.disposition === null);
    assert.equal(gone.length, 1, 'the deletion is a new observation');
    assert.deepEqual([gone[0].expected, gone[0].found], [checkpoint.sha, null]);
    assert.equal(registryOf(fx.home, project.id)[kept].expected_oid, checkpoint.sha);
  });
});

describe("M24 the engine's own ref operations are never observed", () => {
  test('after a bootstrap, a policy change, a checkpoint and an integration, through ticks and a restart, nothing is out of band and every registered ref is where the registry expects it', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx, { via: 'api' });
    await changePolicy(fx.engine, project.id, { repair_attempts_max: 1 });
    const afterPolicy = refOid(project.repo.path, MAIN);
    assert.notEqual(afterPolicy, project.base, 'the policy change was committed to the integration branch');
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThat([permittedEdit()], { checkpoint: true }), roleThat([{ write: { path: 'src/more.js', content: 'export {};\n' } }])]);
    const first = await runToEnd(fx, project.id, item);
    const checkpoint = assertCommitted(fx, first.id, { kind: 'checkpoint', parent: afterPolicy, integrated: false, branchAt: afterPolicy });
    const second = await runToEnd(fx, project.id, item, { index: 1 });
    assertCommitted(fx, second.id, { kind: 'engine_commit', parent: checkpoint.sha, branchWas: afterPolicy, integrated: true });

    await ticks(fx, project.id, 3);
    await fx.engine.kill();
    await fx.start();
    await ticks(fx, project.id);
    assert.deepEqual(outOfBand(fx.home, project.id), [], 'none of the engine\'s own commits and ref updates is an out-of-band change');
    assert.equal(eventsOfType(fx.home, 'repo.out_of_band').length, 0);
    const refs = refsOf(project.repo.path);
    for (const [ref, row] of Object.entries(registryOf(fx.home, project.id))) {
      assert.equal(refs[ref], row.expected_oid, `the registered ref ${ref} (${row.kind}) is at its expected commit`);
    }
    assert.equal(getRow(fx.home, 'projects', project.id).registration_state, 'registered');
  });
});
