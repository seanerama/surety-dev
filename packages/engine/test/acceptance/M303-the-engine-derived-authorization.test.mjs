// M303, the engine-derived authorization and its obligations (slice 23). M4
// plan §3.1 M303; D4-I04, D4-V07; D4 §4.1; J3, J4; Appendix C.2; SEAM.md
// §§75, 246, 248, 249, 253.
//
// `POST /v1/projects/:p/deployments {candidate, environment}` derives the
// binding itself (the sealed artifact, the current configuration identity
// and its targets), evaluates `alpha_authorize`, which J4 makes need the
// completion's obligations, and issues and creates the `deploy` work item,
// or answers 409 `authorization_not_issued` with the evaluation's reasons.
// Repeated requests while the deployment is pending coalesce. Case (d) pins
// M1's setup (a harness environment, a caller's binding, no obligations) as
// refused by the same gate rule that the shared fixture's labelled facts
// satisfy.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertNoEffect, assertRefused, maxEventSeq, storeState } from './harness/fixtures.mjs';
import { addEnvironment, alphaTarget, authorizationsOf, check, installChecks, nominated, passAll, reasonCodes, reasonSubjects } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { scriptedEngine, tickUntil } from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { def } from './harness/checks/repair.mjs';
import {
  DEPLOY_DEFS,
  artifactsOf,
  deploy,
  deployable,
  deployWork,
  operationsOf,
  requestDeployment,
  scriptCall,
  setAdmission,
} from './harness/deploy/kernel.mjs';

const json = (t) => (typeof t === 'string' ? JSON.parse(t) : t);
const reasonsOf = (res) => (res.body?.subject?.reasons ?? []).map((r) => r.code);
const subjectsOf = (res, code) => (res.body?.subject?.reasons ?? []).filter((r) => r.code === code).flatMap((r) => r.subjects ?? []);

describe('M303 the engine-derived authorization and its obligations', () => {
  test('(a) the production route refuses a caller\'s digest, identity or targets, naming the field, and records nothing; the M1 route that took them is gone', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    const binding = { artifact_digest: `sha256:${'a'.repeat(64)}`, config_identity: ctx.config.config_identity, target_set: ['app'] };
    for (const [field, value] of Object.entries(binding)) {
      const before = storeState(fx.home);
      const seq = maxEventSeq(fx.home);
      const res = await requestDeployment(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name, { [field]: value });
      assertRefused(res, 400, 'unknown_field', `a request carrying ${field}`);
      assert.equal(res.body.subject?.field, field, `the refusal names ${field}`);
      assertNoEffect(fx.home, before, seq, `a request carrying ${field}`);
    }
    const before = storeState(fx.home);
    const seq = maxEventSeq(fx.home);
    const old = await fx.engine.post(`/v1/projects/${ctx.project}/candidates/${ctx.candidate.id}/authorizations`, { environment: ctx.env.id, ...binding });
    assertRefused(old, 404, 'not_found', 'the M1 authorization route');
    assertNoEffect(fx.home, before, seq, 'the M1 authorization route');
    assert.deepEqual(authorizationsOf(fx.home, ctx.candidate.id), [], 'no authorization exists');
  });

  test('(b), (e) the authorization binds the sealed artifact, the current identity and its targets; repeated, concurrent and replayed requests while the deployment is pending return it and create nothing; one issuance; a deliberate request after the operation is terminal makes a new authorization of the next generation', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    const { project, candidate, env } = ctx;
    // Admission held (SEAM.md §247): whatever ticks run, the operation waits before its effect, so the deployment stays pending.
    await setAdmission(fx.engine, env.id, 'held');
    const first = await deploy(fx.engine, project, candidate.id, env.name);
    const [artifact] = artifactsOf(fx.home, project);
    const [row] = authorizationsOf(fx.home, candidate.id);
    assert.deepEqual(
      [row.id, row.status, row.environment, row.artifact_digest, row.config_identity, json(row.target_set)],
      [first.authorization.id, 'issued', env.id, artifact?.digest, ctx.config.config_identity, ['app']],
      'issued, bound to what the engine sealed and the configuration in force',
    );

    const again = [await requestDeployment(fx.engine, project, candidate.id, env.name), ...(await Promise.all([1, 2, 3].map(() => requestDeployment(fx.engine, project, candidate.id, env.name))))];
    // A request whose response was lost is the same request sent again, here after the engine was killed and started.
    await fx.engine.kill();
    await fx.start();
    again.push(await requestDeployment(fx.engine, project, candidate.id, env.name));
    for (const res of again) {
      assert.ok([200, 201].includes(res.status), `a repeated request is answered (→ ${res.status} ${res.text})`);
      assert.deepEqual([res.body?.authorization?.id, res.body?.work_item?.id], [first.authorization.id, first.work_item.id], 'with the same authorization and work item');
    }
    assert.equal(authorizationsOf(fx.home, candidate.id).length, 1, 'one authorization');
    assert.equal(deployWork(fx.home, project).length, 1, 'one deploy work item');
    assert.equal(eventsOfType(fx.home, 'authorization.issued').length, 1, 'issued once (M44\'s single issuance)');
    assert.equal(artifactsOf(fx.home, project).length, 1, 'one artifact');

    // The operation ends (its one attempt refused), and the operator asks again.
    await scriptCall(fx.engine, env.id, 'deploy', [{ result: 'refused' }]);
    await setAdmission(fx.engine, env.id, 'granted');
    await tickUntil(fx.engine, project, () => operationsOf(fx.home, project, 'deploy').find((o) => o.status === 'failed'), { max: 12, what: 'the operation to end failed' });
    const later = await deploy(fx.engine, project, candidate.id, env.name);
    assert.notEqual(later.authorization.id, first.authorization.id, 'a new authorization');
    const rows = authorizationsOf(fx.home, candidate.id);
    assert.deepEqual(rows.map((r) => [r.id, r.status]), [[first.authorization.id, 'consumed'], [later.authorization.id, 'issued']], 'the first stays consumed; the second is issued');
    assert.equal(rows[1].generation, rows[0].generation + 1, 'of the next generation');
    assert.equal(rows[1].binding_hash === rows[0].binding_hash, false, 'binding_hash includes the generation');
    assert.deepEqual(deployWork(fx.home, project).map((w) => [w.trigger_id, w.trigger_generation]), [[first.authorization.id, 1], [later.authorization.id, 1]], 'and a work item for it');
  });

  for (const [name, opts, code, subject] of [
    ['no current adapter qualification', { qualify: false }, 'ADAPTER_UNQUALIFIED', 'environment'],
    ['no identity method in the configuration', { config: { identity_method: undefined } }, 'IDENTITY_METHOD_MISSING', 'environment'],
    [
      'a post_deploy_identity check but no required post_deploy_behavior check in the alpha_complete scope',
      { defs: { acc: DEPLOY_DEFS.acc, smoke: DEPLOY_DEFS.smoke, ident: def('post_deploy_identity', { gates: ['alpha_complete'], requires: ['environment', 'artifact_digest'] }) } },
      'ACCEPTANCE_SCOPE_INCOMPLETE',
      'kind:post_deploy_behavior',
    ],
  ]) {
    test(`(c) ${name}: alpha_authorize is not satisfied (${code}); nothing is issued; the request is answered with the reasons`, async (t) => {
      const fx = await scriptedEngine(t);
      const ctx = await deployable(fx, opts);
      const res = await requestDeployment(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
      assertRefused(res, 409, 'authorization_not_issued', 'the request');
      assert.ok(reasonsOf(res).includes(code), `the refusal carries ${code} (reasons: ${reasonsOf(res).join(', ')})`);
      const expected = subject === 'environment' ? ctx.env.id : subject;
      assert.ok(subjectsOf(res, code).includes(expected), `${code} names ${expected} (subjects: ${JSON.stringify(subjectsOf(res, code))})`);
      assert.ok(authorizationsOf(fx.home, ctx.candidate.id).every((r) => r.status === 'proposed'), 'no authorization is issued');
      assert.deepEqual(deployWork(fx.home, ctx.project), [], 'no deploy work item');
      const evaluations = withStore(fx.home, (db) => db.prepare(`SELECT * FROM "gate_evaluations" WHERE "candidate" = ? AND "gate_kind" = 'alpha_authorize'`).all(ctx.candidate.id));
      assert.ok(evaluations.length >= 1 && evaluations.every((e) => e.outcome === 'not_satisfied'), 'the evaluation is recorded, not satisfied');
    });
  }

  test("(d) M1's insufficient setup (a harness environment, a caller's binding, no obligations) is refused by the gate; the shared fixture's labelled facts satisfy the same rule", async (t) => {
    const fx = await scriptedEngine(t);
    fx.scripted.defaultScript(script.complete());
    const ctx = await nominated(fx);
    const k = (await installChecks(fx.engine, ctx.project.id, [check('login', { requirements: ['R1'] })])).id;
    await passAll(fx.engine, ctx.project.id, ctx.candidate.id, [k.login]);

    const old = await alphaTarget(fx, ctx, ctx.candidate, { obligations: false });
    const refused = await old.evaluate();
    assert.equal(refused.outcome, 'not_satisfied', 'the M1 setup no longer issues an Alpha authorization');
    for (const code of ['ADAPTER_UNQUALIFIED', 'IDENTITY_METHOD_MISSING', 'ACCEPTANCE_SCOPE_INCOMPLETE']) assert.ok(reasonCodes(refused).includes(code), `${code} (reasons: ${reasonCodes(refused).join(', ')})`);
    assert.ok(reasonSubjects(refused, 'ACCEPTANCE_SCOPE_INCOMPLETE').includes('kind:post_deploy_behavior'), 'the missing obligation is named by kind');
    assert.deepEqual(authorizationsOf(fx.home, ctx.candidate.id).map((r) => r.status), ['proposed'], 'nothing issued');
    assert.equal((await addEnvironment(fx.engine, ctx.project.id, { name: 'spare' })).startsWith('env_'), true, 'the harness environment fixture itself stands');

    const labelled = await alphaTarget(fx, ctx);
    const satisfied = await labelled.evaluate();
    assert.equal(satisfied.outcome, 'satisfied', `with the labelled facts the same gate is satisfied (reasons: ${reasonCodes(satisfied).join(', ')})`);
    const qualified = eventsOfType(fx.home, 'adapter.qualified');
    assert.ok(qualified.length >= 1 && qualified.every((e) => e.payload?.test_fixture === true), 'every qualification here is the fixture\'s, labelled test_fixture');
    const rows = withStore(fx.home, (db) => db.prepare('SELECT * FROM "adapter_qualifications"').all());
    assert.ok(rows.length >= 1 && rows.every((r) => r.status === 'current' && json(r.cases).length === 0), 'each fixture row is current with no case run');
  });
});
