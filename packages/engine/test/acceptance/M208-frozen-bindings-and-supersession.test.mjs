// M208, frozen bindings and supersession (M3 slice 16; kernel lane). M3
// plan §3.2 M208; D3-R12; D3 §2.5 ("Supersession"), §7.4 Q9 (decided (a),
// E91 item 2); Astra's T15; SEAM.md §§177, 180, 189 to 192.
//
// (b) A queued execution whose protected version, and separately whose
// candidate, is superseded before launch is cancelled with no row
// (`check.cancelled`). (c) One running then is not cancelled: it is recorded
// under its frozen bindings and decides nothing that is current. (a) The
// recorded row binds the candidate, its revision, the version registered
// under and the class (the runner id and qualification are the sandbox
// lane's: row M201). (d) Only the candidate superseded, with old-source
// bindings and an assessed reuse: its evaluation is refused, naming its
// successor, issuing nothing, completing nothing and resolving no finding.
//
// Kernel lane: the engine admits no execution (SEAM.md §177); the test
// moves each through the scripted check boundary (§190).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  alphaTarget,
  authorizationsOf,
  capturedProposal,
  check,
  effectiveVersion,
  finding,
  humanApplies,
  installChecks,
  nominated,
  passAll,
  raiseFindings,
  reasonCodes,
  reasonSubjects,
  review,
  reuseEvidence,
  stageGate,
  successor,
} from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { scriptedEngine, tick, tickUntil, workItem } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { defPath, executionRow, executionsOf, smoke } from './harness/checks/fixtures.mjs';
import { candidateRow, discoveredProject, drive, entryOf, nextCandidate, nominateStage, resultOf, TO_RUNNING } from './harness/checks/selection.mjs';

const KEYS = ['a', 'b'];

// Execution `b` was queued when its binding was superseded: it is cancelled
// with no row and check.cancelled names it, by the end of the next ticks.
async function assertCancelledWithNoRow(fx, project, execution, what) {
  const row = await tickUntil(fx.engine, project, () => (executionRow(fx.home, execution)?.status === 'cancelled' ? executionRow(fx.home, execution) : undefined), { max: 4, what: `${what}: the queued execution to be cancelled` });
  assert.equal(row.result, null, `${what}: a cancelled execution has no result`);
  assert.deepEqual(resultOf(fx.home, execution), [], `${what}: and no check_results row names it`);
  assert.equal(eventsOfType(fx.home, 'check.cancelled').filter((e) => e.subject?.check_execution === execution).length, 1, `${what}: one check.cancelled names it`);
}

// Execution `a` was running: it is not cancelled for the supersession, and
// once moved on it is recorded under its frozen bindings.
async function assertRecordedFrozen(fx, project, x, candidate, version, what) {
  await tick(fx.engine, project, { rounds: 2 });
  assert.equal(executionRow(fx.home, x.id).status, 'running', `${what}: a running execution is not cancelled when its binding is superseded`);
  await drive(fx.engine, x.id, ['collecting', 'recorded'], { exit_status: 0 });
  const [row] = resultOf(fx.home, x.id);
  assert.ok(row, `${what}: its result is recorded`);
  assert.deepEqual(
    { candidate: row.candidate, source_revision: row.source_revision, protected_version: row.protected_version, runner_class: row.runner_class, execution_seq: row.execution_seq },
    { candidate: candidate.id, source_revision: candidate.revision, protected_version: version, runner_class: 'direct', execution_seq: x.execution_seq },
    `${what}: (a) the row binds the candidate, its revision, the version it was registered under, the class and its registration's sequence`,
  );
  return row;
}

describe('M208 frozen bindings and supersession', () => {
  test('(b), (c), (a) the protected version superseded: the queued execution is cancelled with no row; the running one is recorded under its frozen bindings and decides nothing at the new version', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await discoveredProject(fx, KEYS);
    const c = await nominateStage(fx, p, KEYS);
    const v1 = effectiveVersion(fx.home, p.id).id;
    const [a, b] = KEYS.map((key) => executionsOf(fx.home, c.id).find((x) => x.key === key));
    await drive(fx.engine, a.id, TO_RUNNING);

    const proposal = await capturedProposal(fx, p, { changeKind: null, steps: [step.write(defPath('extra'), smoke('extra'))] });
    const v2 = await humanApplies(fx, p, proposal, 'tightening');
    assert.notEqual(v2.id, v1, 'the fixture is live: a new version is in effect');

    await assertCancelledWithNoRow(fx, p.id, b.id, 'the version superseded before launch');
    const row = await assertRecordedFrozen(fx, p.id, a, c, v1, 'the version superseded while running');

    const evaluation = await stageGate(fx, { project: p, stage: p.stage.id }, c);
    const id = Object.keys(evaluation.check_states).find((cid) => entryOf(evaluation, cid).key === 'a');
    assert.ok(id, 'a is required under the new version');
    assert.notEqual(evaluation.check_states[id], 'passed', 'the result recorded under the superseded version passes nothing under the new one');
    assert.notEqual(entryOf(evaluation, id).deciding?.result, row.id, 'and does not decide there');
  });

  test('(b), (c) the candidate superseded: the queued execution is cancelled with no row; the running one is recorded under its frozen bindings; the candidate names its successor', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await discoveredProject(fx, KEYS);
    const c1 = await nominateStage(fx, p, KEYS);
    const v1 = effectiveVersion(fx.home, p.id).id;
    const [a, b] = KEYS.map((key) => executionsOf(fx.home, c1.id).find((x) => x.key === key));
    await drive(fx.engine, a.id, TO_RUNNING);

    const c2 = await nextCandidate(fx, p.id);
    assert.equal(candidateRow(fx.home, c1.id).superseded_by, c2.id, "the successor's nomination supersedes the candidate whose lineage it is on (SEAM.md §192)");
    assert.equal(eventsOfType(fx.home, 'candidate.superseded').filter((e) => e.subject?.candidate === c1.id).length, 1, 'one candidate.superseded names it');
    assert.equal(candidateRow(fx.home, c2.id).superseded_by, null, 'the successor is not superseded');

    await assertCancelledWithNoRow(fx, p.id, b.id, 'the candidate superseded before launch');
    await assertRecordedFrozen(fx, p.id, a, c1, v1, 'the candidate superseded while running');
  });

  test("(d) only the candidate superseded, with old-source bindings and an assessed reuse: its evaluation is refused, naming its successor; it issues nothing, completes nothing and resolves no finding", async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await nominated(fx);
    const project = ctx.project.id;
    const c0 = ctx.candidate;
    const c1 = await successor(fx, ctx);
    // Declared after both nominations, so nothing registers them (SEAM.md §189).
    const k = (await installChecks(fx.engine, project, [check('own', { requirements: ['R1'] }), check('reused', { kind: 'smoke' })])).id;
    const [earlier] = await passAll(fx.engine, project, c0.id, [k.reused]);
    await reuseEvidence(fx.engine, { project, candidate: c1.id, check: k.reused, check_result: earlier.id, assessed: true });

    // A finding on candidate 1 naming `own` and the criterion it covers (F2 (c); SEAM.md §233), so only the supersession stands between it and resolution; dispositioned fix; then `own` passes on candidate 1 after the disposition.
    const [found] = await raiseFindings(fx, project, c1.id, [{ category: 'defect', severity: 'medium', message: 'the session survives a logout', check: 'own', criterion: 'R1.1' }]);
    await review(fx, project, c1.id, { dispositions: [{ finding: found.id, disposition: 'fix' }] });
    await passAll(fx.engine, project, c1.id, [k.own]);
    const alpha = await alphaTarget(fx, ctx, c1);

    // Candidate 2 supersedes candidate 1 before anyone evaluates it.
    const c2 = await successor(fx, ctx);
    assert.equal(candidateRow(fx.home, c1.id).superseded_by, c2.id, 'the fixture is live: candidate 1 is superseded by candidate 2 (SEAM.md §192)');

    const stage = await stageGate(fx, ctx, c1);
    const authorize = await alpha.evaluate();
    for (const [gate, evaluation] of [['stage', stage], ['alpha_authorize', authorize]]) {
      assert.equal(evaluation.outcome, 'not_satisfied', `${gate}: an evaluation of a superseded candidate is not satisfied (Q9)`);
      assert.ok(reasonCodes(evaluation).includes('CANDIDATE_SUPERSEDED'), `${gate}: it is refused as superseded (reasons: ${reasonCodes(evaluation).join(', ')})`);
      assert.deepEqual(reasonSubjects(evaluation, 'CANDIDATE_SUPERSEDED'), [c2.id], `${gate}: naming its successor`);
      assert.deepEqual([evaluation.check_states[k.own], evaluation.check_states[k.reused]], ['passed', 'passed'], `${gate}: its evidence, own and reused, is as good as before: the refusal is the supersession, and no check state is new (Q9 (a))`);
    }
    assert.deepEqual(authorizationsOf(fx.home, c1.id).map((row) => row.status), ['proposed'], 'no authorization is issued');
    assert.equal(eventsOfType(fx.home, 'authorization.issued').length, 0);
    assert.equal(workItem(fx.home, ctx.items[0]).status, 'verifying', "the stage's work is not completed by it");
    assert.deepEqual([finding(fx.home, found.id).status, finding(fx.home, found.id).resolution_verification], ['dispositioned', null], "its post-disposition pass resolves no finding (D3 §2.5)");
  });
});
