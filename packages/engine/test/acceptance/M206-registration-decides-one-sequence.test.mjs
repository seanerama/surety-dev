// M206, registration decides; one sequence (M3 slice 16; kernel lane). M3
// plan §3.2 M206; D3-R11, D3-R22, D3-R23; D3 §2.5, §2.11, §7.1 L7 (B03);
// Astra's T04 and T06; SEAM.md §§177, 180, 183, 189 to 192.
//
// (b), (c) An old matching pass and an assessed reuse pass decide; a newer
// registration then stales the satisfied evaluation in its own
// transaction, and while it is queued, materializing, running, quarantined,
// interrupted and cancelled without a result the check is `missing`, the
// gate read naming the execution and its condition: never the earlier pass.
// (a), (d) Two registrations of the same bindings, the later recorded first:
// the later-registered decides throughout; a fixture result between them
// takes the one sequence and decides over the older queued registration.
// (e) A registration made before a `fix` disposition and recorded after it
// does not resolve the finding; one registered after the disposition does.
//
// Kernel lane: the engine admits no execution (SEAM.md §177); the test
// moves each through the scripted check boundary (§190). No synthetic
// result is inserted anywhere: every result here is a fixture result
// (SEAM.md §67) or one the engine recorded for a registration.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { check, finding, installChecks, nominated, passAll, postResult, raiseFindings, reasonSubjects, review, reuseEvidence, stageGate, successor } from './harness/gates.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { drive, entryOf, evaluationRow, operatorRequest, recordExit, resultOf, stepExecution, TO_RUNNING } from './harness/checks/selection.mjs';
import { executionRow } from './harness/checks/fixtures.mjs';

// The conditions of D3 §2.5 a registration with no usable result can be in,
// reached in turn along D3 A.5 (queued → materializing → running →
// quarantined → interrupted).
const PATH_OF_CONDITIONS = ['queued', 'materializing', 'running', 'quarantined', 'interrupted'];

// The latest registration names no earlier result, and the check is missing.
function assertPending(evaluation, checkId, execution, status, earlier, what) {
  assert.equal(evaluation.check_states[checkId], 'missing', `${what}: the newer registration is ${status} with no result, so the check is missing (L7), never the earlier pass`);
  const entry = entryOf(evaluation, checkId);
  assert.deepEqual(entry.pending, { execution, status }, `${what}: the gate read names the execution and its condition (SEAM.md §191)`);
  assert.ok(entry.deciding === null || !earlier.includes(entry.deciding.result), `${what}: no earlier result decides (deciding: ${JSON.stringify(entry.deciding)})`);
  assert.ok(reasonSubjects(evaluation, 'CHECK_NOT_PASSED').includes(checkId), `${what}: the check is a subject of CHECK_NOT_PASSED`);
  assert.equal(evaluation.outcome, 'not_satisfied', `${what}: the gate is not satisfied`);
}

describe('M206 registration decides; one sequence', () => {
  test('(b), (c) an old matching pass and an assessed reuse pass, then a newer registration: the satisfied evaluation is stale in the registration\'s transaction, and queued, materializing, running, quarantined, interrupted and cancelled the check is missing, never the earlier pass', async (t) => {
    // No recovery registration after `interrupted` (D3 §2.7; SEAM.md §189).
    const fx = await scriptedEngine(t, { config: { check_infra_retries_max: 0 } });
    const ctx = await nominated(fx);
    const project = ctx.project.id;
    const c1 = ctx.candidate;
    const c2 = await successor(fx, ctx);

    // Declared after both nominations, so no nomination registers them (SEAM.md §189).
    const k = (await installChecks(fx.engine, project, [check('own', { requirements: ['R1'] }), check('reused', { kind: 'smoke' })])).id;
    const [ownPass] = await passAll(fx.engine, project, c2.id, [k.own]);
    const [earlierPass] = await passAll(fx.engine, project, c1.id, [k.reused]);
    await reuseEvidence(fx.engine, { project, candidate: c2.id, check: k.reused, check_result: earlierPass.id, assessed: true });
    const earlier = [ownPass.id, earlierPass.id];

    const satisfied = await stageGate(fx, ctx, c2);
    assert.deepEqual(
      [satisfied.outcome, satisfied.check_states[k.own], satisfied.check_states[k.reused]],
      ['satisfied', 'passed', 'passed'],
      `the fixture is live: the old pass and the assessed reuse pass decide, and the stage gate of candidate 2 is satisfied (reasons: ${satisfied.reasons.map((r) => r.code).join(', ') || 'none'})`,
    );

    // (c) A newer registration of both checks, by the operator route.
    const x = await operatorRequest(fx.engine, project, c2.id);
    assert.deepEqual(Object.keys(x).sort(), ['own', 'reused'], 'both required checks are registered');
    assert.equal(evaluationRow(fx.home, satisfied.id).stale, 1, 'the registration stales the satisfied evaluation in its own transaction: stale as soon as the request is answered, with no tick (L7)');

    // (b) In each condition, both checks are missing, naming the newer execution.
    for (const status of PATH_OF_CONDITIONS) {
      if (status !== 'queued') for (const key of ['own', 'reused']) await stepExecution(fx.engine, x[key], status);
      const evaluation = await stageGate(fx, ctx, c2);
      assertPending(evaluation, k.own, x.own, status, earlier, `own, newer registration ${status}`);
      assertPending(evaluation, k.reused, x.reused, status, earlier, `reused, newer registration ${status}`);
    }

    // Cancelled without a result restores nothing.
    const y = await operatorRequest(fx.engine, project, c2.id);
    for (const key of ['own', 'reused']) await stepExecution(fx.engine, y[key], 'cancelled');
    const cancelled = await stageGate(fx, ctx, c2);
    assertPending(cancelled, k.own, y.own, 'cancelled', earlier, 'own, newer registration cancelled');
    assertPending(cancelled, k.reused, y.reused, 'cancelled', earlier, 'reused, newer registration cancelled');
    for (const id of [x.own, x.reused, y.own, y.reused]) assert.deepEqual(resultOf(fx.home, id), [], `no result was recorded for ${id}: none stands for a condition with no result`);
  });

  test('(a), (d) two registrations of the same bindings, the later recorded first, with a fixture result between them: one sequence; the later registration decides throughout, whatever finishes last', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await nominated(fx);
    const project = ctx.project.id;
    const c = ctx.candidate;
    const k = (await installChecks(fx.engine, project, [check('own', { requirements: ['R1'] })])).id;

    const { own: a } = await operatorRequest(fx.engine, project, c.id, ['own']);
    const fixture = await postResult(fx.engine, project, { candidate: c.id, check: k.own, exit_status: 1 });
    const afterFixture = await stageGate(fx, ctx);
    assert.equal(afterFixture.check_states[k.own], 'failed', 'a fixture result takes the one sequence and decides over an older queued registration (SEAM.md §189)');
    assert.equal(entryOf(afterFixture, k.own).deciding?.result, fixture.id, 'the fixture result is the deciding one');

    const { own: b } = await operatorRequest(fx.engine, project, c.id, ['own']);
    const seqA = executionRow(fx.home, a).execution_seq;
    const seqB = executionRow(fx.home, b).execution_seq;
    assert.ok(seqA < fixture.execution_seq && fixture.execution_seq < seqB, `(d) one sequence, in the order made: registration ${seqA}, fixture result ${fixture.execution_seq}, registration ${seqB}`);

    // The later registration is recorded first, failing.
    await drive(fx.engine, a, TO_RUNNING);
    const rb = await recordExit(fx.engine, b, 1);
    assert.equal(rb.execution_seq, seqB, "a recorded result carries its registration's sequence, not a new one (SEAM.md §191)");
    const first = await stageGate(fx, ctx);
    assert.equal(first.check_states[k.own], 'failed', 'the later registration decides');
    assert.deepEqual(entryOf(first, k.own).deciding, { execution: b, result: rb.id, execution_seq: seqB }, 'the deciding execution is the later registration');

    // Then the earlier registration finishes, passing, after it.
    const ra = await recordExit(fx.engine, a, 0);
    assert.equal(ra.execution_seq, seqA, "the earlier registration's result carries its own sequence");
    const second = await stageGate(fx, ctx);
    assert.equal(second.check_states[k.own], 'failed', 'an earlier registration finishing later changes nothing: registration orders, not completion or timestamps');
    assert.equal(entryOf(second, k.own).deciding?.execution, b, 'the later registration still decides');

    const seqs = [seqA, fixture.execution_seq, seqB];
    assert.equal(new Set(seqs).size, 3, '(d) no collision between registrations and fixture results');
  });

  test('(e) a registration made before a fix disposition and recorded after it does not resolve the finding; one registered after the disposition does', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await nominated(fx);
    const project = ctx.project.id;
    const c = ctx.candidate;
    const k = (await installChecks(fx.engine, project, [check('own', { requirements: ['R1'] })])).id;

    // The highest result is a fixture's; a newer registration is left unfinished.
    await postResult(fx.engine, project, { candidate: c.id, check: k.own, exit_status: 1 });
    const { own: before } = await operatorRequest(fx.engine, project, c.id, ['own']);

    // A Reviewer reports a finding naming the check, and dispositions it fix.
    const [found] = await raiseFindings(fx, project, c.id, [{ category: 'defect', severity: 'medium', message: 'the login form accepts an empty password', check: 'own' }]);
    await review(fx, project, c.id, { dispositions: [{ finding: found.id, disposition: 'fix' }] });
    assert.equal(finding(fx.home, found.id).status, 'dispositioned', 'the fixture is live: the finding is dispositioned fix');

    // The registration made before the disposition completes, passing.
    const late = await recordExit(fx.engine, before, 0);
    const evaluation = await stageGate(fx, ctx);
    assert.equal(evaluation.check_states[k.own], 'passed', 'the fixture is live: the check passes by that execution');
    assert.equal(entryOf(evaluation, k.own).deciding?.result, late.id);
    assert.deepEqual([finding(fx.home, found.id).status, finding(fx.home, found.id).resolution_verification], ['dispositioned', null], 'an execution registered before the disposition does not count as after it, though recorded after it (the watermark comes from the one sequence, T06)');
    assert.ok(reasonSubjects(evaluation, 'FINDING_UNSATISFIED').includes(found.id), 'the finding still stands at the gate');

    // A registration after the disposition resolves it.
    const { own: after } = await operatorRequest(fx.engine, project, c.id, ['own']);
    const proof = await recordExit(fx.engine, after, 0);
    const resolving = await stageGate(fx, ctx);
    const row = finding(fx.home, found.id);
    assert.equal(row.status, 'resolved', 'an execution registered after the disposition, passing, resolves the finding (SEAM.md §74)');
    assert.equal(JSON.parse(row.resolution_verification).check_result, proof.id, 'by that execution');
    assert.equal(JSON.parse(row.resolution_verification).evaluation, resolving.id);
  });
});
