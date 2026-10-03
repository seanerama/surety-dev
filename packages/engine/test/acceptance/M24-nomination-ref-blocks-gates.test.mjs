// M24, "block affected gates" for a candidate's nomination marker (M2 slice
// 1, entry A1). Plan §3.3 M24 ("Unexpected registered changes block
// affected gates"); D1 §§7.2, 7.6, 9.3(3) (`OUT_OF_BAND_CHANGE`); D1-11,
// D1-18; E18; SEAM.md §§32, 42, 72, and §99 for this case.
//
// Slice 3 pinned that a nomination ref moved or deleted by someone else is
// observed, never absorbed, and put back by `discard`
// (M24-nomination-ref-moved-or-deleted). Slice 5 pinned that an unreconciled
// observation of the integration branch blocks every gate of the project
// (M40, first case). What neither pinned, and what a real agent's commits
// make matter: while the observation of a candidate's own marker is
// unresolved, that candidate's gates are blocked, at the stage gate and at
// the Alpha authorization alike, however good its evidence is; so no
// authorization is issued for a candidate whose marker has been tampered
// with and not yet put right. Once the marker is put back, the same
// evidence satisfies both.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { alphaTarget, authorizationsOf, check, installChecks, nominated, passAll, reasonCodes, stageGate } from './harness/gates.mjs';
import { eventsOfType, outOfBand, registryOf } from './harness/journal.mjs';
import { commitOnRef, refOid } from './harness/repos.mjs';
import { answerDecision, scriptedEngine, tick } from './harness/runs.mjs';

const ticks = async (fx, project, n = 3) => {
  for (let i = 0; i < n; i++) await tick(fx.engine, project);
};

describe('M24 an unresolved observation of a nomination ref blocks the candidate\'s gates', () => {
  test('with the marker moved by someone else, the stage gate and the Alpha authorization gate carry OUT_OF_BAND_CHANGE and no authorization is issued, although the check has passed; after discard both are satisfied on the same evidence', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await nominated(fx);
    const project = ctx.project.id;
    const repo = ctx.project.repo.path;
    const candidate = ctx.candidate;
    const ref = `refs/surety/cand/${candidate.seq}`;
    const k = (await installChecks(fx.engine, project, [check('login', { requirements: ['R1'] })])).id;
    await passAll(fx.engine, project, candidate.id, [k.login]);
    const satisfied = await stageGate(fx, ctx);
    assert.equal(satisfied.outcome, 'satisfied', `the fixture is live: the stage gate is satisfied by the pass (reasons: ${reasonCodes(satisfied).join(', ')})`);
    const alpha = await alphaTarget(fx, ctx);
    assert.deepEqual(authorizationsOf(fx.home, candidate.id).map((row) => row.status), ['proposed'], 'the fixture is live: an authorization is proposed and not issued');

    // Someone moves the candidate's marker to a commit the engine did not nominate.
    const stray = commitOnRef(repo, ref, { 'stray.txt': 'someone moved the candidate ref\n' }, { message: 'a commit the engine did not nominate' });
    await ticks(fx, project);
    const observed = outOfBand(fx.home, project).filter((o) => o.disposition === null);
    assert.equal(observed.length, 1, `the fixture is live: one unreconciled observation (found ${observed.length})`);
    assert.deepEqual({ kind: observed[0].subject_kind, ref: observed[0].ref_name, found: observed[0].found }, { kind: 'ref', ref, found: stray }, 'it is the observation of the nomination ref (row M24, slice 3)');
    assert.equal(registryOf(fx.home, project)[ref].expected_oid, candidate.revision, 'nothing was absorbed');

    // While it is unresolved, the candidate's gates are blocked, whatever the evidence says.
    const blocked = await stageGate(fx, ctx);
    assert.ok(reasonCodes(blocked).includes('OUT_OF_BAND_CHANGE'), `the stage gate carries OUT_OF_BAND_CHANGE while the marker's observation is unresolved (reasons: ${reasonCodes(blocked).join(', ') || 'none'})`);
    assert.equal(blocked.outcome, 'not_satisfied');
    assert.equal(blocked.check_states[k.login], 'passed', 'the evidence is as good as before: the block is the observation');
    const alphaBlocked = await alpha.evaluate();
    assert.ok(reasonCodes(alphaBlocked).includes('OUT_OF_BAND_CHANGE'), `the Alpha authorization gate carries it too (reasons: ${reasonCodes(alphaBlocked).join(', ') || 'none'})`);
    assert.equal(alphaBlocked.outcome, 'not_satisfied');
    assert.deepEqual(authorizationsOf(fx.home, candidate.id).map((row) => row.status), ['proposed'], 'no authorization is issued for a candidate whose marker is not where the engine put it');
    assert.deepEqual(eventsOfType(fx.home, 'authorization.issued'), [], 'and none was issued on the way');

    // A person puts the marker back; the same evidence satisfies both gates.
    await answerDecision(fx.engine, project, observed[0].decision.id, 'discard');
    await waitFor(() => outOfBand(fx.home, project).find((o) => o.id === observed[0].id).disposition === 'discard', { what: 'the discard to be recorded' });
    assert.equal(refOid(repo, ref), candidate.revision, 'the marker is back on the nominated revision');
    await ticks(fx, project, 2);
    assert.deepEqual(outOfBand(fx.home, project).filter((o) => o.disposition === null), [], 'nothing is unresolved');
    const again = await stageGate(fx, ctx);
    assert.deepEqual([again.outcome, again.check_states[k.login]], ['satisfied', 'passed'], `once the marker is put right the stage gate is satisfied on the same pass (reasons: ${reasonCodes(again).join(', ') || 'none'})`);
    const alphaAgain = await alpha.evaluate();
    assert.equal(alphaAgain.outcome, 'satisfied', `and so is the Alpha authorization gate (reasons: ${reasonCodes(alphaAgain).join(', ') || 'none'})`);
    assert.deepEqual(authorizationsOf(fx.home, candidate.id).map((row) => row.status), ['issued'], 'which issues the proposed authorization now, and not before');
  });
});
