// The two preview facts of a protected correction that no M1 case changed
// (M2 slice 1, entry A3; SEAM.md §101): the proposal's content and the
// approved specification. One scenario, taken once for each of the three
// correction kinds (rows M53 to M55). Each change refuses an answer carried
// on the earlier preview, applies nothing, and is a new generation whose
// manifest shows the changed value (D1 §§4.6, 10.5; Review B12: "the same
// tree/diff and policy do not establish that the approved correction still
// applies to the current source and requirements").
//
// The proposal's content changes in the store, with the engine stopped, as
// rows M45 and M51 change a dependency no engine path changes while the
// question stands (SEAM.md §§65, 83). The approved specification changes
// through the plan fixture, the one M1 path by which it changes: the
// baseline gains a requirement (SEAM.md §67).

import assert from 'node:assert/strict';

import { assertStaleAnswer, nextGeneration } from './decisions.mjs';
import { CHECK_FILE, assertNotApplied, correction, installGatedPlan } from './gates.mjs';
import { commitOnRef, treeOf } from './repos.mjs';
import { script } from './scripted.mjs';
import { withStore } from './store.mjs';

// The tree the proposal's content is replaced with: the check file changed
// another way, on the proposal's own base. The commit that carries it is
// made with no ref, so nothing in the repository moves.
export const REPLACED_CONTENT = '{"expect": 200, "body": "ok", "replaced_in_the_store": true}\n';

export async function contentAndSpecChange(t, changeKind, opts) {
  const ctx = await correction(t, changeKind, opts);
  const { fx, project, proposal, decision: first } = ctx;
  assert.deepEqual([first.manifest.proposal_status, first.manifest.tree], [proposal.status, proposal.tree_id], 'the fixture is live: the preview binds the proposal as captured');

  // 1. The proposal's content changes: its tree is replaced in the store.
  const replaced = treeOf(project.repo.path, commitOnRef(project.repo.path, null, { [CHECK_FILE]: REPLACED_CONTENT }, { parent: proposal.base_revision, message: 'fixture: another tree for the proposal' }));
  assert.notEqual(replaced, proposal.tree_id, 'the fixture is live: the replacement is another tree');
  await fx.engine.stop();
  withStore(fx.home, (db) => db.prepare('UPDATE "protected_proposals" SET "tree_id" = ? WHERE "id" = ?').run(replaced, proposal.id), { readonly: false });
  await fx.start();
  await assertStaleAnswer(fx, project.id, first, 'approve');
  assertNotApplied(fx, ctx, ctx.headBefore);
  const second = await nextGeneration(fx, project.id, first, { changed: 'tree' });
  assert.deepEqual(
    { tree: second.manifest.tree, head: second.manifest.integration_revision, status: second.manifest.proposal_status },
    { tree: replaced, head: ctx.headBefore, status: proposal.status },
    'the next generation shows the tree it would now apply; the integration branch and the proposal are as they were',
  );

  // 2. The approved specification changes: the baseline gains a requirement.
  // The stage that comes with it is built by a Builder that exits without a
  // result, so nothing of it is committed and the integration branch stays.
  const plan = await installGatedPlan(fx.engine, project.id, { requirements: ['R1'], stages: [{ number: 1, goal: 'a stage of the changed specification', implements: ['R1'] }] });
  fx.scripted.script(plan.stages[0].work_item, [script.crash()]);
  await assertStaleAnswer(fx, project.id, second, 'approve');
  assertNotApplied(fx, ctx, ctx.headBefore);
  const third = await nextGeneration(fx, project.id, second, { changed: 'spec_revision' });
  assert.deepEqual(
    { tree: third.manifest.tree, head: third.manifest.integration_revision, status: third.manifest.proposal_status },
    { tree: replaced, head: ctx.headBefore, status: proposal.status },
    'the specification is what changed: the tree, the integration branch and the proposal did not change again',
  );
  const row = assertNotApplied(fx, ctx, ctx.headBefore);
  assert.equal(row.status, proposal.status, 'the proposal awaits its approval as before');
  return { ...ctx, generations: [first, second, third], replaced };
}
