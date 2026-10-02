// M44, the stage gate versus an Alpha authorization (slice 5). Plan §3.4 M44;
// RN R1 and §4; build spec §3 and §6 correction 4; D1 §§9.1, 9.3, 9.6, 19.3,
// the M1 part of D1-25; Review B03; E30 item 16; SEAM.md §§70, 75.
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
// failure in the evaluation's transaction (row M61) is in the second case.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { armFault } from './harness/engine.mjs';
import { consume, openDecision } from './harness/decisions.mjs';
import { assertNoEffect, assertRefused, maxEventSeq, storeState } from './harness/fixtures.mjs';
import { addEnvironment, alphaTarget, authorizationsOf, check, effectiveVersion, evaluationsOf, installChecks, installGatedPlan, nominated, passAll, postResult, proposeAuthorization, reasonCodes, review } from './harness/gates.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { assertWorkHistory } from './harness/invariants.mjs';
import { candidatesOf, eventsOfType, workItemsOf } from './harness/journal.mjs';
import { countOf, getRow, scriptedEngine, tick, tickUntil, workItem } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { WORK } from './harness/transitions.mjs';

const LOGIN = check('login', { requirements: ['R1'] });
const UNBUILT_KINDS = ['phase', 'alpha_complete', 'beta_authorize', 'beta_complete', 'live_authorize', 'live_complete'];

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
    // The candidate's verification, let through the chain boundary by a person, completes.
    const verification = workItemsOf(fx.home, project).find((work) => work.kind === 'verification' && work.subject?.candidate === c.id);
    assert.ok(verification, 'the fixture is live: the nomination created verification work');
    await consume(fx, project, await openDecision(fx, project, 'blocker', verification.id), 'continue');
    await tickUntil(fx.engine, project, () => workItem(fx.home, verification.id).status === 'complete', { what: "the candidate's verification to complete" });

    // The engine evaluates the stage gate by itself, and it is not satisfied: no execution of the check is recorded.
    const own = await tickUntil(fx.engine, project, () => evaluationsOf(fx.home, c.id, 'stage').at(-1), { max: 4, what: 'the engine to evaluate the stage gate' });
    assert.equal(own.outcome, 'not_satisfied');
    assert.equal(workItem(fx.home, stageWork).status, 'verifying', "the verification is complete and the stage's work is not");

    // A failed execution completes nothing.
    await postResult(fx.engine, project, { candidate: c.id, check: k.login, exit_status: 1 });
    await tick(fx.engine, project);
    assert.equal(workItem(fx.home, stageWork).status, 'verifying');

    // A later passing execution: the stale evaluation is recomputed at a tick, and the work completes with it.
    await passAll(fx.engine, project, c.id, [k.login]);
    await tickUntil(fx.engine, project, () => workItem(fx.home, stageWork).status === 'complete', { max: 4, what: "the stage's work to complete" });
    assert.equal(evaluationsOf(fx.home, c.id, 'stage').at(-1).outcome, 'satisfied', 'the evaluation that completed it is satisfied');
    assert.deepEqual(withStore(fx.home, (db) => assertWorkHistory(db, stageWork)), WORK.kinds.stage_build.path);

    assert.deepEqual(authorizationsOf(fx.home, c.id), [], 'stage success issues no authorization');
    assert.equal(eventsOfType(fx.home, 'authorization.issued').length, 0);
    notDeployed(fx, project, c);
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
    const environment = await addEnvironment(fx.engine, project, { targets: ['alpha-1', 'alpha-2'] });
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
});
