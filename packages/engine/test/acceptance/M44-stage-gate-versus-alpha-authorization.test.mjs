// M44, the stage gate versus an Alpha authorization (slice 5). Plan §3.4 M44;
// RN R1 and §4; build spec §3 and §6 correction 4; D1 §§9.1, 9.3, 9.6, 19.3,
// the M1 part of D1-25; Review B03; E30 item 16; SEAM.md §§70, 75.
//
// M4 slice 23 changes what this row's fixtures supply, and nothing it
// asserts (D4 Appendix C.2; J3, J4; SEAM.md §253; COVERAGE.md): the
// authorization is proposed through the harness fixture, the shared
// fixture configures its environment and supplies J4's obligations, and
// `alpha_complete` leaves the unbuilt kinds. The former setup is pinned as
// refused in M303 (d).
//
// M1 computes two gate kinds. A satisfied `stage` gate completes its
// stage's work and issues nothing. An `alpha_authorize` evaluation is made
// for an authorization that was recorded first, as `proposed`, with its
// exact binding; a satisfied evaluation issues that one authorization,
// once. Another binding is another proposal. Nothing is deployed and no
// candidate leaves `developing` in M1.
//
// The first case replaces slice 3's interim rule (E30 item 16): a stage's
// work is complete when its `stage` gate is satisfied, and its candidate's
// verification completing is not enough. The last case is the gate half of
// row M08: every other gate kind is refused before any effect. A store
// failure in the evaluation's transaction (row M61) is in the Alpha group's
// first case.
//
// The second case of the first group is the slice-5 review's finding (E41
// item 5): a stage gate that an out-of-band change blocked is evaluated
// again by the ticks once the change is reconciled. The engine the review
// ran never looked again, so the stage's work stayed `verifying` although
// the same gate, asked for by its route, was satisfied.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { armFault, waitFor } from './harness/engine.mjs';
import { consume, openDecision } from './harness/decisions.mjs';
import { assertNoEffect, assertRefused, maxEventSeq, storeState } from './harness/fixtures.mjs';
import { alphaTarget, authorizationsOf, check, configuredEnvironment, effectiveVersion, evaluationsOf, installChecks, installGatedPlan, nominated, passAll, postResult, proposeAuthorization, reasonCodes, review, stageGate } from './harness/gates.mjs';
import { permittedEdit, roleThat, waitForCandidates } from './harness/gitruns.mjs';
import { assertWorkHistory } from './harness/invariants.mjs';
import { candidatesOf, eventsOfType, outOfBand, workItemsOf } from './harness/journal.mjs';
import { commitOnRef, refOid } from './harness/repos.mjs';
import { answerDecision, countOf, getRow, scriptedEngine, tick, tickUntil, workItem } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { WORK } from './harness/transitions.mjs';

const LOGIN = check('login', { requirements: ['R1'] });
// M4 slice 23 (D4 §5.5; SEAM.md §§249, 253): `alpha_complete` is computed now, for an operation; the other kinds stay refused.
const UNBUILT_KINDS = ['phase', 'beta_authorize', 'beta_complete', 'live_authorize', 'live_complete'];

// A nominated candidate with one required check declared and, unless
// `pass` is false, passed.
async function candidate(t, { pass = true, ...opts } = {}) {
  const fx = await scriptedEngine(t);
  fx.scripted.defaultScript(script.complete());
  const ctx = await nominated(fx, opts);
  const project = ctx.project.id;
  const k = (await installChecks(fx.engine, project, [LOGIN])).id;
  if (pass) await passAll(fx.engine, project, ctx.candidate.id, [k.login]);
  return { fx, ctx, project, c: ctx.candidate, k };
}

const notDeployed = (fx, project, c) => {
  assert.equal(getRow(fx.home, 'candidates', c.id).progress, 'developing', 'the candidate is still developing');
  assert.equal(eventsOfType(fx.home, 'candidate.advanced').length, 0, 'no candidate advanced');
  assert.equal(countOf(fx.home, 'operations', `"project" = ? AND "kind" IN ('deploy', 'publish', 'rollback', 'teardown')`, project), 0, 'no deployment or publication operation exists');
};

describe('M44 the stage gate', () => {
  test("a stage's work is complete only when its stage gate is satisfied, not when its candidate's verification completes; and a satisfied stage gate issues no deployment authority", async (t) => {
    const { fx, ctx, project, c, k } = await candidate(t, { pass: false });
    const stageWork = ctx.items[0];
    // The stage's Builder: its first run, and a second for the repair the failure below takes, which writes the same edit and asks for the nomination.
    fx.scripted.script(stageWork, [roleThat([permittedEdit()], { nominate: true }), roleThat([permittedEdit()], { nominate: true })]);
    // A candidate's verification, let through the chain boundary by a person, completes.
    const verify = async (candidateId) => {
      const verification = workItemsOf(fx.home, project).find((work) => work.kind === 'verification' && work.subject?.candidate === candidateId);
      assert.ok(verification, 'the fixture is live: the nomination created verification work');
      await consume(fx, project, await openDecision(fx, project, 'blocker', verification.id), 'continue');
      await tickUntil(fx.engine, project, () => workItem(fx.home, verification.id).status === 'complete', { what: "the candidate's verification to complete" });
    };
    await verify(c.id);

    // The engine evaluates the stage gate by itself, and it is not satisfied: no execution of the check is recorded.
    const own = await tickUntil(fx.engine, project, () => evaluationsOf(fx.home, c.id, 'stage').at(-1), { max: 4, what: 'the engine to evaluate the stage gate' });
    assert.equal(own.outcome, 'not_satisfied');
    assert.equal(workItem(fx.home, stageWork).status, 'verifying', "the verification is complete and the stage's work is not");

    // A failed execution completes nothing. Under Q2 (D3 §2.10; E90 item 2; objection 030) it sends the stage's work back to its Builder, in the
    // transaction that records it: where this case had the work stay verifying on the failed candidate, the Q2 behaviour is pinned instead.
    await postResult(fx.engine, project, { candidate: c.id, check: k.login, exit_status: 1 });
    assert.deepEqual([workItem(fx.home, stageWork).status, workItem(fx.home, stageWork).repair_attempts], ['eligible', 1], 'a failed execution completes nothing: the stage is sent back to its Builder (Q2)');

    // The repair's candidate: the stage's work is verifying again, and that candidate's verification completes. The work is still not complete.
    const c2 = (await waitForCandidates(fx, project, 2))[1];
    await tickUntil(fx.engine, project, () => workItem(fx.home, stageWork).status === 'verifying', { what: "the stage's work to be verifying on the repair's candidate" });
    await verify(c2.id);
    const own2 = await tickUntil(fx.engine, project, () => evaluationsOf(fx.home, c2.id, 'stage').at(-1), { max: 4, what: "the engine to evaluate the repair's candidate's stage gate" });
    assert.equal(own2.outcome, 'not_satisfied');
    assert.equal(workItem(fx.home, stageWork).status, 'verifying', "its verification is complete and the stage's work is not");

    // A later passing execution: the stale evaluation is recomputed at a tick, and the work completes with it.
    await passAll(fx.engine, project, c2.id, [k.login]);
    await tickUntil(fx.engine, project, () => workItem(fx.home, stageWork).status === 'complete', { max: 4, what: "the stage's work to complete" });
    assert.equal(evaluationsOf(fx.home, c2.id, 'stage').at(-1).outcome, 'satisfied', 'the evaluation that completed it is satisfied');
    const once = WORK.kinds.stage_build.path.slice(0, -1);
    assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, stageWork)), [...once, ...once, 'complete'], 'the path, with the one repair Q2 took, ends complete');

    for (const held of [c, c2]) assert.deepEqual(authorizationsOf(fx.home, held.id), [], 'stage success issues no authorization');
    assert.equal(eventsOfType(fx.home, 'authorization.issued').length, 0);
    notDeployed(fx, project, c);
    notDeployed(fx, project, c2);
  });

  test("a stage gate that an out-of-band change blocked is evaluated again once the change is discarded: the next ticks complete the stage's work, whose check has passed, and nobody asks for the gate", async (t) => {
    const { fx, ctx, project, c, k } = await candidate(t, { pass: false });
    const stageWork = ctx.items[0];
    const repo = ctx.project.repo;
    const verification = workItemsOf(fx.home, project).find((work) => work.kind === 'verification' && work.subject?.candidate === c.id);
    await consume(fx, project, await openDecision(fx, project, 'blocker', verification.id), 'continue');
    await tickUntil(fx.engine, project, () => workItem(fx.home, verification.id).status === 'complete', { what: "the candidate's verification to complete" });
    await tickUntil(fx.engine, project, () => evaluationsOf(fx.home, c.id, 'stage').at(-1), { max: 4, what: 'the engine to evaluate the stage gate' });
    const head = refOid(repo.path, repo.ref);

    // A developer commits to the integration branch behind the engine's back, and the engine observes it. Then the check passes.
    commitOnRef(repo.path, repo.ref, { 'notes.txt': 'a note\n' }, { message: 'developer: a commit the engine did not make' });
    const [observed] = await tickUntil(fx.engine, project, () => (outOfBand(fx.home, project).length > 0 ? outOfBand(fx.home, project) : undefined), { max: 4, what: 'the commit to be observed out of band' });
    await passAll(fx.engine, project, c.id, [k.login]);
    await tick(fx.engine, project);
    assert.deepEqual(reasonCodes(await stageGate(fx, ctx)), ['OUT_OF_BAND_CHANGE'], 'the fixture is live: the check has passed, and the unreconciled observation is all that blocks the gate');
    assert.equal(workItem(fx.home, stageWork).status, 'verifying');

    // The person discards the commit: the branch is put back, and the observation is reconciled.
    await answerDecision(fx.engine, project, observed.decision.id, 'discard');
    await waitFor(() => outOfBand(fx.home, project)[0].disposition === 'discard', { what: 'the discard to be recorded' });
    assert.equal(refOid(repo.path, repo.ref), head, 'the fixture is live: the integration branch is back where the engine left it');

    // Nobody asks for the gate again. The ticks that follow evaluate it, and the stage's work completes.
    for (let i = 0; i < 4 && workItem(fx.home, stageWork).status !== 'complete'; i++) await tick(fx.engine, project);
    assert.equal(workItem(fx.home, stageWork).status, 'complete', "four ticks after the block cleared, the stage's work is still not complete: the blocked stage gate was not evaluated again");
    assert.equal(evaluationsOf(fx.home, c.id, 'stage').at(-1).outcome, 'satisfied', 'the evaluation that completed it is satisfied');
  });
});

describe('M44 an Alpha authorization', () => {
  test('a satisfied evaluation issues the one proposed authorization it was made for; repeating it issues nothing more; a failed evaluation transaction issues nothing; nothing is deployed', async (t) => {
    const { fx, ctx, project, c } = await candidate(t);
    const alpha = await alphaTarget(fx, ctx);
    assert.deepEqual([alpha.authorization.status, (await proposeAuthorization(fx.engine, project, c.id, alpha.binding)).id], ['proposed', alpha.authorization.id], 'the authorization is recorded first, as proposed; the same binding is the same row');

    // The evaluation's transaction fails once: nothing is issued and no evaluation is left behind.
    await armFault(fx.engine, { point: 'before_event', event_type: 'gate.evaluated' });
    const failed = await fx.engine.post(`/v1/projects/${project}/candidates/${c.id}/gates/alpha_authorize`, { authorization: alpha.authorization.id });
    assertRefused(failed, 500, 'store_error', 'an evaluation whose transaction fails');
    assert.deepEqual([authorizationsOf(fx.home, c.id).map((row) => row.status), evaluationsOf(fx.home, c.id, 'alpha_authorize').length], [['proposed'], 0]);

    const evaluation = await alpha.evaluate();
    assert.equal(evaluation.outcome, 'satisfied', `reasons: ${reasonCodes(evaluation).join(', ')}`);
    await alpha.evaluate();
    await alpha.evaluate();
    const rows = authorizationsOf(fx.home, c.id);
    assert.equal(rows.length, 1, 'one authorization, however often the gate is evaluated');
    const [issued] = rows;
    assert.deepEqual(
      { id: issued.id, status: issued.status, candidate: issued.candidate, environment: issued.environment, artifact: issued.artifact_digest, config: issued.config_identity, targets: JSON.parse(issued.target_set), version: issued.protected_version, evaluation: issued.evaluation },
      { id: alpha.authorization.id, status: 'issued', candidate: c.id, environment: alpha.environment, artifact: alpha.binding.artifact_digest, config: alpha.binding.config_identity, targets: alpha.binding.target_set, version: effectiveVersion(fx.home, project).id, evaluation: evaluation.id },
      'the proposed row is the one issued, with its binding and the evaluation that issued it',
    );
    assert.equal(eventsOfType(fx.home, 'authorization.issued').length, 1, 'issued once');
    notDeployed(fx, project, c);
  });

  test('a restart between proposal and issuance: the proposal is still there, proposed, and is issued once', async (t) => {
    const { fx, ctx, c } = await candidate(t);
    const alpha = await alphaTarget(fx, ctx);
    await fx.engine.kill();
    await fx.start();
    assert.deepEqual(authorizationsOf(fx.home, c.id).map((row) => [row.id, row.status]), [[alpha.authorization.id, 'proposed']], 'a restart issues nothing');
    assert.equal((await alpha.evaluate()).outcome, 'satisfied');
    assert.deepEqual(authorizationsOf(fx.home, c.id).map((row) => [row.id, row.status]), [[alpha.authorization.id, 'issued']]);
    assert.equal(eventsOfType(fx.home, 'authorization.issued').length, 1);
  });

  test('a changed scope cannot reuse the authorization or the sign-off: another target set is another proposal, and a successor candidate has neither', async (t) => {
    // T2: the Alpha gate needs the Reviewer's sign-off.
    const { fx, ctx, project, c, k } = await candidate(t, { tier: 'T2' });
    await review(fx, project, c.id, { signoffs: [{ scope: 'candidate' }] });
    // M4 slice 23 (J4; SEAM.md §253): the environment is the owner's configuration, of one target (`local_service` takes one, D4 §10 X2);
    // the second binding still names two targets, through the fixture authorization of SEAM.md §246, as the M1 route took them.
    const environment = await configuredEnvironment(fx, ctx, { targets: ['alpha-1'] });
    const one = await alphaTarget(fx, ctx, c, { environment, targets: ['alpha-1'] });
    assert.equal((await one.evaluate()).outcome, 'satisfied', 'the fixture is live: candidate 1 is authorized for one target');

    // Another target set: a second proposal. Issuing it supersedes the first.
    const both = await alphaTarget(fx, ctx, c, { environment, targets: ['alpha-1', 'alpha-2'] });
    assert.notEqual(both.authorization.id, one.authorization.id);
    assert.deepEqual(authorizationsOf(fx.home, c.id).map((row) => row.status), ['issued', 'proposed'], 'the issued authorization does not cover the changed targets');
    assert.equal((await both.evaluate()).outcome, 'satisfied');
    assert.deepEqual(authorizationsOf(fx.home, c.id).map((row) => row.status), ['superseded', 'issued'], 'the later issuance supersedes the earlier one');

    // A successor candidate: a later stage changes the source and is nominated at its integration.
    const later = await installGatedPlan(fx.engine, project, { stages: [{ number: 2, goal: 'a later stage', implements: [] }] });
    fx.scripted.script(later.stages[0].work_item, [roleThat([step.write('src/stage-2.js', 'export const stage = 2;\n')])]);
    const c2 = await tickUntil(fx.engine, project, () => candidatesOf(fx.home, project)[1], { what: 'the second candidate' });
    await passAll(fx.engine, project, c2.id, [k.login]);
    const borrowed = await fx.engine.post(`/v1/projects/${project}/candidates/${c2.id}/gates/alpha_authorize`, { authorization: both.authorization.id });
    assertRefused(borrowed, 404, 'not_found', "evaluating candidate 2's gate for candidate 1's authorization");
    const next = await alphaTarget(fx, ctx, c2, { environment, targets: ['alpha-1', 'alpha-2'] });
    const evaluation = await next.evaluate();
    assert.deepEqual(reasonCodes(evaluation), ['SIGNOFF_MISSING'], "candidate 1's sign-off does not serve candidate 2");
    assert.deepEqual(authorizationsOf(fx.home, c2.id).map((row) => row.status), ['proposed'], 'and candidate 2 has no issued authorization');
    assert.deepEqual(authorizationsOf(fx.home, c.id).map((row) => row.status), ['superseded', 'issued'], "candidate 1's are as they were");
  });
});

describe('M44 the gate kinds M1 does not compute (row M08)', () => {
  test(`${UNBUILT_KINDS.join(', ')}: each is refused before any effect`, async (t) => {
    const { fx, project, c } = await candidate(t);
    for (const kind of UNBUILT_KINDS) {
      const before = storeState(fx.home);
      const seq = maxEventSeq(fx.home);
      const res = await fx.engine.post(`/v1/projects/${project}/candidates/${c.id}/gates/${kind}`, {});
      assertRefused(res, 501, 'unsupported', `evaluating the ${kind} gate`);
      assertNoEffect(fx.home, before, seq, `evaluating the ${kind} gate`);
    }
  });

  test('alpha_complete is no longer refused as unsupported: it is evaluated for an operation, and a request that names none is refused invalid_value before any effect (M4 slice 23)', async (t) => {
    const { fx, project, c } = await candidate(t);
    const before = storeState(fx.home);
    const seq = maxEventSeq(fx.home);
    const res = await fx.engine.post(`/v1/projects/${project}/candidates/${c.id}/gates/alpha_complete`, {});
    assertRefused(res, 400, 'invalid_value', 'evaluating alpha_complete with no operation');
    assert.equal(res.body.subject?.field, 'operation', 'the refusal names the operation it needs');
    assertNoEffect(fx.home, before, seq, 'evaluating alpha_complete with no operation');
  });
});
