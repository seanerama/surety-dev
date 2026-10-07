// M209, the gate's own ref reads (M3 slice 16; kernel lane, real git). M3
// plan §3.2 M209; D3-X01; D3 §5 X1; Q4 (decided (a)), N02; Astra's T16; D1
// §§7.2, 7.6; SEAM.md §§32, 66, 72, 99, 193.
//
// (a) The integration branch and the candidate's nomination ref, each moved
// and each deleted by someone else, then a gate evaluated at once with no
// tick between: the evaluation itself observes it, recording section 32's
// observation before its own transaction, and carries OUT_OF_BAND_CHANGE;
// nothing is issued or completed, at the stage gate and at the Alpha
// authorization alike. Each gate kind is the first to look at each ref.
// (b) Git does not answer (a transient failure), then answers again: the
// evaluation is refused naming the ref it could not read, and nothing is
// recorded as a change, observed or decided; the recovered reads find none.
// (c) The engine's own journaled write racing the evaluation's reads: its
// facts read while a protected application's ref update is confirmed and
// its finalizer has not run, its transaction after that finalizer. It is
// reconciled against the registry and never reported as out of band.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer, decisionsOfKind, openDecision, reachBarrier } from './harness/decisions.mjs';
import { releaseBarrier } from './harness/engine.mjs';
import { maxEventSeq } from './harness/fixtures.mjs';
import { PROTECTED_FILES, alphaTarget, askingForTicks, authorizationsOf, capturedProposal, check, installChecks, nominated, passAll, proposalsOf, reasonCodes, reasonSubjects, stageGate } from './harness/gates.mjs';
import { armBarrier, eventsOfType, outOfBand } from './harness/journal.mjs';
import { commitOnRef, gitQuiet, holdGit, refOid } from './harness/repos.mjs';
import { scriptedEngine, tick, workItem } from './harness/runs.mjs';

// A T1 candidate whose one required check has passed, with an Alpha
// authorization proposed for it. Nothing has been evaluated yet, so nothing
// has been issued or completed.
async function ready(t, config = {}) {
  const fx = await scriptedEngine(t, { config });
  const ctx = await nominated(fx);
  const project = ctx.project.id;
  const k = (await installChecks(fx.engine, project, [check('login', { requirements: ['R1'] })])).id;
  await passAll(fx.engine, project, ctx.candidate.id, [k.login]);
  const alpha = await alphaTarget(fx, ctx);
  return { fx, ctx, project, k, alpha, repo: ctx.project.repo.path };
}

const gateOf = (env, kind) => (kind === 'stage' ? () => stageGate(env.fx, env.ctx) : () => env.alpha.evaluate());

// Nothing a satisfied evaluation does has happened.
function assertNothingIssued(env, what) {
  assert.deepEqual(authorizationsOf(env.fx.home, env.ctx.candidate.id).map((row) => row.status), ['proposed'], `${what}: no authorization is issued`);
  assert.equal(workItem(env.fx.home, env.ctx.items[0]).status, 'verifying', `${what}: the stage's work is not completed`);
}

const CASES = [
  { ref: 'integration', change: 'moved', first: 'alpha_authorize' },
  { ref: 'integration', change: 'deleted', first: 'stage' },
  { ref: 'nomination', change: 'moved', first: 'stage' },
  { ref: 'nomination', change: 'deleted', first: 'alpha_authorize' },
];

describe("M209 the gate's own ref reads", () => {
  for (const { ref, change, first } of CASES) {
    const second = first === 'stage' ? 'alpha_authorize' : 'stage';
    test(`(a) the ${ref} ref ${change} by someone else, then the ${first} gate at once, with no tick: the evaluation observes it before its transaction and carries OUT_OF_BAND_CHANGE; the ${second} gate too; nothing is issued`, async (t) => {
      const env = await ready(t);
      const { fx, ctx, project, k, repo } = env;
      const name = ref === 'integration' ? ctx.project.repo.ref : `refs/surety/cand/${ctx.candidate.seq}`;
      const expected = refOid(repo, name);
      assert.ok(expected, `the fixture is live: ${name} is registered and present`);

      let found = null;
      if (change === 'moved') found = commitOnRef(repo, name, { 'stray.txt': `someone moved ${name}\n` }, { message: 'a commit the engine did not make' });
      else gitQuiet(repo, ['update-ref', '-d', name]);
      assert.deepEqual(outOfBand(fx.home, project), [], 'the fixture is live: nothing is observed before the evaluation (no tick has run)');

      const mark = maxEventSeq(fx.home);
      const evaluation = await gateOf(env, first)();
      assert.ok(reasonCodes(evaluation).includes('OUT_OF_BAND_CHANGE'), `the ${first} evaluation reads the ref itself and carries OUT_OF_BAND_CHANGE (reasons: ${reasonCodes(evaluation).join(', ') || 'none'})`);
      assert.equal(evaluation.outcome, 'not_satisfied');
      assert.equal(evaluation.check_states[k.login], 'passed', 'the evidence is as good as before: the block is the observation');

      const observed = outOfBand(fx.home, project).filter((o) => o.disposition === null);
      assert.equal(observed.length, 1, `one observation is recorded (found ${observed.length})`);
      assert.deepEqual(
        { kind: observed[0].subject_kind, ref: observed[0].ref_name, expected: observed[0].expected, found: observed[0].found, decision: observed[0].decision?.kind },
        { kind: 'ref', ref: name, expected, found, decision: 'out_of_band_change' },
        "it is section 32's observation of the ref, with its decision",
      );
      const oob = eventsOfType(fx.home, 'repo.out_of_band', mark);
      const evaluated = eventsOfType(fx.home, 'gate.evaluated', mark);
      assert.ok(oob.length >= 1 && evaluated.length >= 1, 'both events were written');
      assert.ok(oob[0].seq < evaluated.at(-1).seq, "the observation is recorded before the evaluation's transaction");
      assertNothingIssued(env, `after the ${first} evaluation`);

      const other = await gateOf(env, second)();
      assert.ok(reasonCodes(other).includes('OUT_OF_BAND_CHANGE'), `the ${second} gate carries it too (reasons: ${reasonCodes(other).join(', ') || 'none'})`);
      assert.equal(outOfBand(fx.home, project).length, 1, 'and it is not recorded again');
      assertNothingIssued(env, `after the ${second} evaluation`);
    });
  }

  test("(b) git does not answer, then answers: the evaluations are refused naming the ref they could not read, nothing is recorded as a change and no adopt or discard is asked; the recovered reads find none", async (t) => {
    const env = await ready(t, { git_deadline: 2 });
    const { fx, ctx, project, repo } = env;
    const refs = [ctx.project.repo.ref, `refs/surety/cand/${ctx.candidate.seq}`];

    const letGo = holdGit(repo);
    fx.beforeCleanup.push(letGo);
    const held = [await stageGate(fx, ctx), await env.alpha.evaluate()];
    letGo();

    for (const [gate, evaluation] of [['stage', held[0]], ['alpha_authorize', held[1]]]) {
      assert.equal(evaluation.outcome, 'not_satisfied', `${gate}: an unread ref is not a pass`);
      assert.ok(reasonCodes(evaluation).includes('REF_UNREAD'), `${gate}: the evaluation is refused naming the unread fact (SEAM.md §193) (reasons: ${reasonCodes(evaluation).join(', ')})`);
      assert.ok(reasonSubjects(evaluation, 'REF_UNREAD').some((s) => refs.includes(s)), `${gate}: the reason names a registered ref it could not read (subjects: ${reasonSubjects(evaluation, 'REF_UNREAD').join(', ')})`);
      assert.ok(!reasonCodes(evaluation).includes('OUT_OF_BAND_CHANGE'), `${gate}: a failed read is not an observed change (N02)`);
    }
    assert.deepEqual(outOfBand(fx.home, project), [], 'no out-of-band row: no changed-ref value was made up');
    assert.deepEqual(eventsOfType(fx.home, 'repo.out_of_band'), [], 'no repo.out_of_band');
    assert.deepEqual(decisionsOfKind(fx.home, project, 'out_of_band_change'), [], 'no adopt or discard is asked');
    assertNothingIssued(env, 'while git did not answer');

    // Git answers again: the reread, the ticks and a new evaluation find nothing changed.
    await tick(fx.engine, project, { rounds: 2 });
    const recovered = await stageGate(fx, ctx);
    assert.ok(!reasonCodes(recovered).includes('REF_UNREAD') && !reasonCodes(recovered).includes('OUT_OF_BAND_CHANGE'), `the recovered read finds the refs where they were (reasons: ${reasonCodes(recovered).join(', ') || 'none'})`);
    assert.equal(recovered.outcome, 'satisfied', 'and the same evidence satisfies the gate');
    assert.deepEqual(outOfBand(fx.home, project), [], 'still nothing observed');
  });

  test("(c) an evaluation whose refs are read while a protected application's ref update is confirmed and not finalized, and whose transaction follows the finalizer: reconciled against the registry, never reported as out of band", async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await nominated(fx, { files: PROTECTED_FILES });
    const project = ctx.project.id;
    const k = (await installChecks(fx.engine, project, [check('login', { requirements: ['R1'] })])).id;
    await passAll(fx.engine, project, ctx.candidate.id, [k.login]);
    const headBefore = refOid(ctx.project.repo.path, ctx.project.repo.ref);
    const proposal = await capturedProposal(fx, ctx.project, { changeKind: 'tightening' });
    const decision = await openDecision(fx, project, 'check_correction_tightening', proposal.id);

    // The engine's own write: the application's ref update confirmed, its finalizer held.
    await armBarrier(fx.engine, 'protected_application.before_finalizer', 'pause');
    const answered = answer(fx.engine, project, decision, 'approve').catch((err) => err);
    await reachBarrier(fx, project, 'protected_application.before_finalizer');
    assert.notEqual(refOid(ctx.project.repo.path, ctx.project.repo.ref), headBefore, 'the fixture is live: the engine has moved the integration branch and not yet finalized the move');

    // The evaluation reads its facts now and is held before its transaction.
    await armBarrier(fx.engine, 'gate.facts_read', 'pause');
    const evaluating = stageGate(fx, ctx);
    await reachBarrier(fx, project, 'gate.facts_read');

    // The finalizer runs; then the evaluation's transaction.
    await releaseBarrier(fx.engine, 'protected_application.before_finalizer');
    await askingForTicks(fx, project, () => proposalsOf(fx.home, project).find((row) => row.id === proposal.id)?.status === 'applied', 'the application to be finalized');
    await releaseBarrier(fx.engine, 'gate.facts_read');
    const evaluation = await evaluating;
    await answered;

    assert.ok(!reasonCodes(evaluation).includes('OUT_OF_BAND_CHANGE'), `the engine's own write is not out of band (reasons: ${reasonCodes(evaluation).join(', ') || 'none'})`);
    assert.deepEqual(outOfBand(fx.home, project), [], 'no observation is recorded');
    await tick(fx.engine, project, { rounds: 2 });
    assert.deepEqual(outOfBand(fx.home, project), [], 'nor by the ticks that follow');
    assert.ok(!reasonCodes(await stageGate(fx, ctx)).includes('OUT_OF_BAND_CHANGE'), 'nor by a later evaluation');
    assert.deepEqual(eventsOfType(fx.home, 'repo.out_of_band'), [], 'no repo.out_of_band was ever written');
  });
});
