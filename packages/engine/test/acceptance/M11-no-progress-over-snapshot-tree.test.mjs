// M11, the progress key over a snapshot tree, and a repair that completes
// work which integrates (slice 3). Plan §3.2 M11 ("repair and conflict
// stopping"); D1 §§4.3, 7.3, 13.3; D1-31; SEAM.md §§15, 28.
//
// Slice 2 counted repairs. A repair that leaves exactly what the attempt
// before it left is no progress, whatever ran in between: the progress key
// is taken over the snapshot tree of an attempt that failed validation (and,
// from slice 5, over its findings), and a tree is the same tree whichever
// run, workspace and moment it came from. An unchanged key counts towards
// `no_progress_max` and parks the work there; a changed key counts nothing,
// and such work runs until the repair limit. The findings part of the key
// and a typed conflict are slice 5's.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CONTRACT } from './harness/fixtures.mjs';
import { assertWorkHistory } from './harness/invariants.mjs';
import { PERMITTED_EDIT, addGitProject, addItem, permittedEdit, roleThat } from './harness/gitruns.mjs';
import { assertCommitted } from './harness/journal.mjs';
import { refOid } from './harness/repos.mjs';
import { decisionsAbout, getRow, runsOf, scriptedEngine, tickUntil, workItem } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const NO_PROGRESS_MAX = CONTRACT.project.no_progress_max.default;
const REPAIR_MAX = CONTRACT.project.repair_attempts_max.default;
assert.ok(NO_PROGRESS_MAX < REPAIR_MAX, 'with the defaults, work that makes no progress parks before the repair limit');

// A role that leaves a tree validation rejects: a path a Builder may not change.
const rejectedWith = (content) => roleThat([permittedEdit(), step.write('.surety/policy.json', content)]);
const parkedFor = (fx, item) => {
  const row = workItem(fx.home, item);
  return row.status === 'parked' ? JSON.parse(row.blocker).reason : undefined;
};
const snapshotTrees = (fx, item) => runsOf(fx.home, item).map((r) => getRow(fx.home, 'workspaces', r.workspace).snapshot_tree);

describe('M11 the progress key is taken over the snapshot tree', () => {
  test('work whose every attempt leaves the same rejected tree is launched once plus no_progress_max times, then parks for no progress', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'fix');
    // Every launch does exactly the same thing, in a workspace of its own.
    fx.scripted.defaultScript(rejectedWith('{"repair_attempts_max": 10}\n'));
    await tickUntil(fx.engine, project.id, () => parkedFor(fx, item), { max: 10, what: 'the work to park' });

    const runs = runsOf(fx.home, item);
    assert.equal(runs.length, 1 + NO_PROGRESS_MAX, `launched once plus no_progress_max (${NO_PROGRESS_MAX}) times, not up to the repair limit`);
    for (const r of runs) assert.deepEqual([r.outcome, r.reason_class], ['failed', 'diff_violation']);
    const trees = snapshotTrees(fx, item);
    assert.ok(trees[0] && new Set(trees).size === 1, `every attempt left the same tree, in a different workspace (${trees.join(', ')})`);
    assert.equal(new Set(runs.map((r) => r.workspace)).size, runs.length);
    const work = workItem(fx.home, item);
    assert.equal(parkedFor(fx, item), 'no_progress_max', 'the work is parked with its cause');
    assert.deepEqual([work.no_progress_count, work.repair_attempts], [NO_PROGRESS_MAX, NO_PROGRESS_MAX], 'two unchanged attempts counted, each re-dispatch counted once as a repair');
    assert.ok(typeof work.progress_key === 'string' && work.progress_key.length > 0, 'the progress key is recorded');
    assert.equal(decisionsAbout(fx.home, item, 'blocker').filter((d) => d.status === 'open').length, 1);
    assert.equal(refOid(project.repo.path, project.repo.ref), project.base, 'nothing was integrated');
    assert.equal(fx.scripted.launches({ work_item: item }).length, runs.length);
    withStore(fx.home, (db) => assertWorkHistory(db, item));
  });

  test('work whose every attempt leaves a different rejected tree counts no lack of progress, and parks at the repair limit', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, Array.from({ length: REPAIR_MAX + 2 }, (_, i) => rejectedWith(`{"attempt": ${i + 1}}\n`)));
    await tickUntil(fx.engine, project.id, () => parkedFor(fx, item), { max: 12, what: 'the work to park' });

    const runs = runsOf(fx.home, item);
    assert.equal(runs.length, 1 + REPAIR_MAX, `launched once plus repair_attempts_max (${REPAIR_MAX}) times`);
    assert.equal(new Set(snapshotTrees(fx, item)).size, runs.length, 'every attempt left another tree');
    const work = workItem(fx.home, item);
    assert.equal(parkedFor(fx, item), 'repair_attempts_max', 'the work is parked at the repair limit, not for lack of progress');
    assert.deepEqual([work.no_progress_count, work.repair_attempts], [0, REPAIR_MAX]);
  });

  test('a small repair that succeeds completes work that integrates: the rejected attempt leaves nothing behind, the repair is committed and integrated', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [rejectedWith('{"repair_attempts_max": 10}\n'), roleThat([permittedEdit()])]);
    await tickUntil(fx.engine, project.id, () => runsOf(fx.home, item).length === 2 && runsOf(fx.home, item)[1].state === 'ended', { max: 6, what: 'the repair to run and end' });

    const [first, second] = runsOf(fx.home, item);
    assert.deepEqual([first.outcome, first.reason_class], ['failed', 'diff_violation']);
    assertCommitted(fx, second.id, { kind: 'engine_commit', parent: project.base, integrated: true, changes: { [PERMITTED_EDIT.path]: 'A' } });
    const work = workItem(fx.home, item);
    assert.deepEqual([work.repair_attempts, work.no_progress_count], [1, 0], 'one repair, and it made progress');
    assert.equal(decisionsAbout(fx.home, item, 'blocker').length, 0);
  });
});
