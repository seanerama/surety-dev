// M24, an immutable nomination ref moved or deleted (slice 3, second
// session). Plan §3.3 M24 ("separately move/delete integration or immutable
// nomination refs ... Unexpected registered changes block affected gates;
// engine-owned ref operations reconcile without false positives. Registry
// expectations never silently absorb an external change"); E18 ("Nomination
// tags are kept, as immutable engine-owned refs registered and audited by the
// integrity check"); D1 §§7.2, 7.6, 7.7; D1-11, D1-18; SEAM.md §§32, 42.
//
// The first session pinned what integrity does with the integration branch
// and with a keep ref. A nomination ref, refs/surety/cand/<seq>, is
// registered too, and it is immutable: the commit the registry expects for
// it never changes. So when someone moves or deletes it, the observation
// offers `discard`, which puts the ref back on the nominated revision, and
// never `adopt`: adopting would make another commit the candidate's. The
// candidate itself is a row in the store and is not touched by any of it.
//
// That such an observation blocks the gates of the candidate is slice 5's.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { addStagedProject, permittedEdit, roleThat, runToEnd, waitForCandidates } from './harness/gitruns.mjs';
import { assertOperations, candidatesOf, outOfBand, registryOf } from './harness/journal.mjs';
import { commitOnRef, gitQuiet, refOid } from './harness/repos.mjs';
import { answerDecision, scriptedEngine, tick } from './harness/runs.mjs';

const ticks = async (fx, project, n = 2) => {
  for (let i = 0; i < n; i++) await tick(fx.engine, project);
};

// A T2 project with one candidate: {fx, project, candidate, ref, sha}.
async function nominated(t) {
  const fx = await scriptedEngine(t);
  const { project, items } = await addStagedProject(fx, { tier: 'T2' });
  fx.scripted.script(items[0], [roleThat([permittedEdit()])]);
  await runToEnd(fx, project.id, items[0]);
  const [candidate] = await waitForCandidates(fx, project.id);
  const ref = `refs/surety/cand/${candidate.seq}`;
  assert.deepEqual(registryOf(fx.home, project.id)[ref], { kind: 'nomination', expected_oid: candidate.revision, immutable: 1 }, 'the fixture is live: a registered, immutable nomination ref');
  await ticks(fx, project.id);
  assert.deepEqual(outOfBand(fx.home, project.id), [], "the engine's own nomination is not out of band");
  return { fx, project, candidate, ref, sha: candidate.revision };
}

// The one observation of the nomination ref, with nothing absorbed.
function assertObserved(ctx, found) {
  const { fx, project, candidate, ref, sha } = ctx;
  const observed = outOfBand(fx.home, project.id);
  assert.equal(observed.length, 1, `one observation, however many ticks ran (found ${observed.length})`);
  const [o] = observed;
  assert.deepEqual({ kind: o.subject_kind, ref: o.ref_name, expected: o.expected, found: o.found, disposition: o.disposition }, { kind: 'ref', ref, expected: sha, found, disposition: null }, 'it names the nomination ref, the nominated revision and what was found');
  assert.deepEqual([o.decision.kind, o.decision.status, o.decision.options], ['out_of_band_change', 'open', ['discard']], 'an immutable ref offers discard, and never adopt: its expected commit cannot change');
  assert.equal(registryOf(fx.home, project.id)[ref].expected_oid, sha, 'the registry still expects the nominated revision');
  assert.deepEqual(candidatesOf(fx.home, project.id), [candidate], 'the candidate is as it was nominated');
  return o;
}

describe('M24 an immutable nomination ref changed by someone else', () => {
  test('moved: observed once and not absorbed; discard puts it back on the nominated revision through the journal and keeps the stray commit; the candidate is untouched', async (t) => {
    const ctx = await nominated(t);
    const { fx, project, ref, sha } = ctx;
    const stray = commitOnRef(project.repo.path, ref, { 'stray.txt': 'someone moved the candidate ref\n' }, { message: 'a commit the engine did not nominate' });
    await ticks(fx, project.id, 3);
    const o = assertObserved(ctx, stray);
    assert.equal(refOid(project.repo.path, ref), stray, 'nothing is undone before a person answers');
    await fx.engine.kill();
    await fx.start();
    await ticks(fx, project.id);
    assert.equal(assertObserved(ctx, stray).id, o.id, 'a restart does not ask again');

    await answerDecision(fx.engine, project.id, o.decision.id, 'discard');
    await waitFor(() => outOfBand(fx.home, project.id)[0].disposition === 'discard', { what: 'the discard to be recorded' });
    assert.equal(refOid(project.repo.path, ref), sha, 'the nomination ref is back on the nominated revision');
    const registry = registryOf(fx.home, project.id);
    const kept = Object.entries(registry).filter(([, row]) => row.kind === 'oob');
    assert.deepEqual(kept.map(([name, row]) => [refOid(project.repo.path, name), row.expected_oid]), [[stray, stray]], 'the stray commit is kept under a registered oob ref');
    assert.deepEqual(registry[ref], { kind: 'nomination', expected_oid: sha, immutable: 1 });
    await ticks(fx, project.id);
    assert.equal(outOfBand(fx.home, project.id).filter((x) => x.disposition === null).length, 0, "the engine's own reset is not observed in turn");
    assert.deepEqual(candidatesOf(fx.home, project.id), [ctx.candidate]);
    assertOperations(fx.home, { project: project.id });
  });

  test('deleted: observed with nothing found; discard restores it on the nominated revision', async (t) => {
    const ctx = await nominated(t);
    const { fx, project, ref, sha } = ctx;
    gitQuiet(project.repo.path, ['update-ref', '-d', ref]);
    await ticks(fx, project.id, 3);
    const o = assertObserved(ctx, null);
    assert.equal(refOid(project.repo.path, ref), null, 'nothing is undone before a person answers');
    await answerDecision(fx.engine, project.id, o.decision.id, 'discard');
    await waitFor(() => outOfBand(fx.home, project.id)[0].disposition === 'discard', { what: 'the discard to be recorded' });
    assert.equal(refOid(project.repo.path, ref), sha, 'the nomination ref is there again, on the nominated revision');
    assert.equal(Object.values(registryOf(fx.home, project.id)).filter((row) => row.kind === 'oob').length, 0, 'there was no stray commit to keep');
    await ticks(fx, project.id);
    assert.equal(outOfBand(fx.home, project.id).filter((x) => x.disposition === null).length, 0);
    assert.deepEqual(candidatesOf(fx.home, project.id), [ctx.candidate]);
  });
});
