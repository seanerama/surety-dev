// M25 (slice 3). Plan §3.3 M25 ("checkout edits and unreadable
// repository"); D1 §§7.1, 7.2, 7.6, 11.5; build spec §6 correction 6 and the
// reminder "unknown is a value" (an unreadable repository is refused, not
// clean); RN R5; D1-36; SEAM.md §32.
//
// Two integrity subjects besides a ref. A managed checkout, here the
// developer's own checkout of the integration branch, whose tracked files
// were edited without its HEAD moving: the edit is observed, it is
// preserved, and the options offered are the ones that make sense for a
// checkout (stash, adopt), not a ref's. And the repository itself, when it
// cannot be read: that is reported as unreadable, never as clean or empty;
// nothing is offered that would reset anything; nothing is dispatched; and
// when it can be read again, integrity is taken afresh before anything of
// the project is dispatched.
//
// Supported integration branches are normally checked out nowhere (row
// M22). The managed-checkout fixture here has one checked out on purpose:
// that is where a checkout observation comes from. The answers to a
// checkout observation, and the decision's manifest, are row M46 (slice 5).

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { assertRefused } from './harness/fixtures.mjs';
import { PERMITTED_EDIT, addGitProject, addItem, permittedEdit, roleThat, runToEnd } from './harness/gitruns.mjs';
import { assertCommitted, eventsOfType, managedCheckouts, outOfBand, registryOf } from './harness/journal.mjs';
import { checkoutState, commitOnRef, gitQuiet, makeUnreadable, refOid } from './harness/repos.mjs';
import { resolvedPath, runsOf, scriptedEngine, tick, workItem } from './harness/runs.mjs';

const MAIN = 'refs/heads/main';
const ticks = async (fx, project, n = 2) => {
  for (let i = 0; i < n; i++) await tick(fx.engine, project);
};

// A project whose developer has the integration branch checked out, clean.
async function managedCheckout(t) {
  const fx = await scriptedEngine(t);
  const project = await addGitProject(fx, { primary: 'integration', files: { 'src/lib.js': 'export const lib = 1;\n' } });
  const [checkout, ...others] = managedCheckouts(fx.home, project.id).filter((c) => c.kind === 'integration_worktree');
  assert.ok(checkout && others.length === 0, "the developer's checkout of the integration branch is a managed checkout");
  assert.equal(resolvedPath(checkout.path), resolvedPath(project.repo.path));
  assert.equal(checkout.owner_run, null);
  assert.deepEqual(Object.keys(checkout.baseline).sort(), ['head', 'index_hash', 'tracked_tree_hash']);
  assert.equal(checkout.baseline.head, project.base);
  await ticks(fx, project.id);
  assert.deepEqual(outOfBand(fx.home, project.id), [], 'a clean checkout is no observation');
  return { fx, project, checkout };
}

function assertCheckoutObserved(fx, project, checkout, changed) {
  const observed = outOfBand(fx.home, project.id);
  assert.equal(observed.length, 1, `one observation, however many ticks ran (found ${observed.length})`);
  const [o] = observed;
  assert.deepEqual({ subject_kind: o.subject_kind, kind: o.checkout_kind, path: resolvedPath(o.checkout_path), disposition: o.disposition }, { subject_kind: 'checkout', kind: 'integration_worktree', path: resolvedPath(project.repo.path), disposition: null }, 'the observation names the checkout');
  const expected = JSON.parse(o.expected);
  const found = JSON.parse(o.found);
  assert.deepEqual(expected, checkout.baseline, 'what was expected is the baseline');
  assert.equal(found.head, expected.head, 'the HEAD has not moved');
  for (const key of ['index_hash', 'tracked_tree_hash']) {
    if (changed.includes(key)) assert.notEqual(found[key], expected[key], `${key} differs from the baseline`);
    else assert.equal(found[key], expected[key], `${key} is as the baseline has it`);
  }
  assert.deepEqual(
    { kind: o.decision.kind, subject_type: o.decision.subject_type, subject_id: o.decision.subject_id, status: o.decision.status, options: o.decision.options },
    { kind: 'out_of_band_change', subject_type: 'out_of_band_change', subject_id: o.id, status: 'open', options: ['adopt', 'stash'] },
    "the options are a checkout's: stash and adopt, and no discard",
  );
  assert.equal(eventsOfType(fx.home, 'repo.out_of_band').length, 1);
  assert.deepEqual(managedCheckouts(fx.home, project.id).find((c) => c.id === checkout.id).baseline, checkout.baseline, 'the baseline is not replaced by what was found');
  return o;
}

describe('M25 tracked files edited in a managed checkout', () => {
  test('an unstaged edit, with HEAD and index where they were, is observed as a checkout change, preserved, and offered stash or adopt', async (t) => {
    const { fx, project, checkout } = await managedCheckout(t);
    writeFileSync(join(project.repo.path, 'src/lib.js'), 'export const lib = 2; // edited by the developer\n');
    const dirty = checkoutState(project.repo.path);
    assert.deepEqual([dirty.head, dirty.staged], [project.base, ''], 'the fixture is live: a dirty tracked file, HEAD and index unmoved');

    await ticks(fx, project.id);
    const o = assertCheckoutObserved(fx, project, checkout, ['tracked_tree_hash']);
    assert.deepEqual(checkoutState(project.repo.path), dirty, "the developer's edit is preserved: the engine reset nothing");
    assert.equal(readFileSync(join(project.repo.path, 'src/lib.js'), 'utf8'), 'export const lib = 2; // edited by the developer\n');
    assert.equal(refOid(project.repo.path, MAIN), project.base);

    // Across more ticks and a restart it stays one observation, and the edit stays.
    await ticks(fx, project.id, 3);
    await fx.engine.kill();
    await fx.start();
    await ticks(fx, project.id);
    const again = assertCheckoutObserved(fx, project, checkout, ['tracked_tree_hash']);
    assert.deepEqual([again.id, again.decision.id], [o.id, o.decision.id]);
    assert.deepEqual(checkoutState(project.repo.path), dirty);
  });

  test('a staged edit is observed the same way: the index differs from the baseline, the HEAD does not', async (t) => {
    const { fx, project, checkout } = await managedCheckout(t);
    writeFileSync(join(project.repo.path, 'src/lib.js'), 'export const lib = 3; // staged by the developer\n');
    gitQuiet(project.repo.path, ['add', 'src/lib.js']);
    const dirty = checkoutState(project.repo.path);
    assert.deepEqual([dirty.head, dirty.staged], [project.base, 'M\tsrc/lib.js'], 'the fixture is live: a staged change, HEAD unmoved');

    await ticks(fx, project.id);
    assertCheckoutObserved(fx, project, checkout, ['index_hash', 'tracked_tree_hash']);
    assert.deepEqual(checkoutState(project.repo.path), dirty, 'the staged edit is preserved');
  });
});

describe('M25 a repository that cannot be read', () => {
  // A project with one eligible item, whose repository is then made unreadable.
  async function unreadable(t) {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const item = await addItem(fx, project.id, 'fix');
    fx.scripted.script(item, [roleThat([permittedEdit()])]);
    // No tick has run since the item was added: nothing of it is under way.
    const restore = makeUnreadable(project.repo.path);
    let restored = false;
    const readable = () => {
      if (!restored) restore();
      restored = true;
    };
    fx.beforeCleanup.push(readable);
    await ticks(fx, project.id);
    return { fx, project, item, readable };
  }

  function assertUnreadableObserved(fx, project, item) {
    const observed = outOfBand(fx.home, project.id);
    assert.equal(observed.length, 1, `one observation (found ${observed.length})`);
    const [o] = observed;
    assert.deepEqual({ subject_kind: o.subject_kind, found: o.found, disposition: o.disposition }, { subject_kind: 'repository', found: null, disposition: null }, 'the repository is the subject, and what it holds is unknown');
    assert.deepEqual({ kind: o.decision.kind, status: o.decision.status, options: o.decision.options }, { kind: 'out_of_band_change', status: 'open', options: [] }, 'nothing is offered: no reset, no adoption, no stash can mean anything for a repository that cannot be read');
    assert.equal(registryOf(fx.home, project.id)[MAIN].expected_oid, project.base, 'unknown is not clean: the registry expects what it expected');
    assert.equal(eventsOfType(fx.home, 'repo.reconciled').length, 0);
    assert.equal(runsOf(fx.home, item).length, 0, 'nothing of the project is dispatched');
    assert.equal(workItem(fx.home, item).status, 'eligible');
    return o;
  }

  test('it is reported as unreadable, not as clean; nothing is dispatched and no reset is offered; once readable and unchanged, the observation closes and the project goes on', async (t) => {
    const { fx, project, item, readable } = await unreadable(t);
    const o = assertUnreadableObserved(fx, project, item);
    assertRefused(await fx.engine.post(`/v1/projects/${project.id}/policy`, { repair_attempts_max: 1 }), 409, 'repo_unreadable', 'a command that needs the repository');
    await ticks(fx, project.id, 3);
    assertUnreadableObserved(fx, project, item);
    assert.equal((await fx.engine.get('/v1/health')).status, 200);

    readable();
    const run = await runToEnd(fx, project.id, item);
    const closed = outOfBand(fx.home, project.id);
    assert.deepEqual(closed.map((x) => [x.id, x.decision.status]), [[o.id, 'invalidated']], 'the same observation, its decision closed because the condition is gone; no new one');
    assert.equal(eventsOfType(fx.home, 'repo.reconciled').length, 1);
    assertCommitted(fx, run.id, { kind: 'engine_commit', parent: project.base, integrated: true, changes: { [PERMITTED_EDIT.path]: 'A' } });
  });

  test('a ref that was moved while the repository could not be read is found when it can be read again, before anything is dispatched', async (t) => {
    const { fx, project, item, readable } = await unreadable(t);
    assertUnreadableObserved(fx, project, item);
    // Access comes back, and with it a commit the engine never made.
    readable();
    const stray = commitOnRef(project.repo.path, MAIN, { 'stray.txt': 'pushed while the engine could not look\n' });
    await ticks(fx, project.id);
    const observed = outOfBand(fx.home, project.id);
    const ref = observed.filter((o) => o.subject_kind === 'ref');
    assert.equal(ref.length, 1, 'the moved branch is observed in the first integrity step after access is restored');
    assert.deepEqual([ref[0].ref_name, ref[0].expected, ref[0].found, ref[0].decision.status], [MAIN, project.base, stray, 'open']);
    assert.equal(observed.find((o) => o.subject_kind === 'repository').decision.status, 'invalidated', 'the repository itself can be read again');
    assert.equal(runsOf(fx.home, item).length, 0, 'fresh integrity came before dispatch: nothing was started on the moved branch');
    assert.equal(registryOf(fx.home, project.id)[MAIN].expected_oid, project.base);
  });
});
