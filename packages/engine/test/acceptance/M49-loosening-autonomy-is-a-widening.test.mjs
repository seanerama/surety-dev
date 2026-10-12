// M49, loosening autonomy is a policy widening (slice 31; kernel lane).
// Sean's decision of 2026-10-12, relayed by the driver (SEAM.md §364): on an
// existing project, a change of `autonomy` toward less human stepping (step
// → stage → phase) or of `alpha_deploy` from `manual` to `on_phase_complete`
// widens what the engine may do unasked, so it is answered 409
// `confirm_required` and applied only on the owner's approval of the
// `policy_widening` decision, as raising `max_chained_roles` is (M49; D1
// §§10.1, 11.4; SEAM.md §§27, 76). Tightening applies directly. A new
// project's default stays `autonomy: phase`, `alpha_deploy: manual` (D6 K3,
// K9; A.7), with no policy revision.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { confirmRequired, consume, reject } from './harness/decisions.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { changePolicy, getPolicy, policyRevisions } from './harness/journal.mjs';
import { refOid } from './harness/repos.mjs';
import { scriptedEngine } from './harness/runs.mjs';

const policyPath = (project) => `/v1/projects/${project.id}/policy`;
const head = (project) => refOid(project.repo.path, project.repo.ref);

// A widening previewed: the decision, its `widens`, and nothing changed or committed.
async function widening(fx, project, change, key) {
  const before = await getPolicy(fx.engine, project.id);
  const headBefore = head(project);
  const previewed = await confirmRequired(fx, policyPath(project), change);
  assert.equal(previewed.kind, 'policy_widening', `${JSON.stringify(change)} raises policy_widening`);
  assert.ok((previewed.manifest?.widens ?? []).includes(key), `its manifest says it widens ${key} (${JSON.stringify(previewed.manifest?.widens)})`);
  assert.equal(previewed.manifest?.proposed_policy?.[key], change[key], 'and binds the proposed value');
  const after = await getPolicy(fx.engine, project.id);
  assert.deepEqual([after.revision, after.effective[key], head(project)], [before.revision, before.effective[key], headBefore], 'nothing is changed or committed before the approval');
  return previewed;
}

const effectiveAfter = async (fx, project, revision) => {
  for (let i = 0; i < 100; i++) {
    const policy = await getPolicy(fx.engine, project.id);
    if (policy.revision === revision) return policy;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`policy revision ${revision} of ${project.id} was not effective`);
};

describe('M49 loosening autonomy or alpha_deploy is a policy widening; tightening applies directly', () => {
  test('a new project: autonomy phase and alpha_deploy manual by default, with no policy revision', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const policy = await getPolicy(fx.engine, project.id);
    assert.deepEqual([policy.effective.autonomy, policy.effective.alpha_deploy, policy.revision], ['phase', 'manual', null]);
    assert.deepEqual(policyRevisions(fx.home, project.id), []);
  });

  test('autonomy: phase → step applies directly; step → stage and stage → phase are confirm_required, applied only on approval; step → phase is a widening too; a rejected loosening changes nothing', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    // Tightening: an ordinary change, 200, committed on request.
    const tightened = await changePolicy(fx.engine, project.id, { autonomy: 'step' });
    assert.equal(tightened.effective.autonomy, 'step', 'phase → step applies directly');
    assert.equal(policyRevisions(fx.home, project.id).at(-1)?.widens_authority, 0, 'as an ordinary revision');

    // step → phase at once: a widening; rejected, nothing changes.
    const leap = await widening(fx, project, { autonomy: 'phase' }, 'autonomy');
    await reject(fx, project.id, leap);
    assert.equal((await getPolicy(fx.engine, project.id)).effective.autonomy, 'step', 'a rejected loosening leaves step');

    // step → stage: a widening, applied on approval.
    const toStage = await widening(fx, project, { autonomy: 'stage' }, 'autonomy');
    await consume(fx, project.id, toStage, 'approve');
    const stage = await effectiveAfter(fx, project, 2);
    assert.equal(stage.effective.autonomy, 'stage');
    assert.deepEqual([policyRevisions(fx.home, project.id).at(-1)?.widens_authority, policyRevisions(fx.home, project.id).at(-1)?.decision], [1, toStage.id], 'the revision records the widening and its decision');

    // stage → phase: a widening again.
    const toPhase = await widening(fx, project, { autonomy: 'phase' }, 'autonomy');
    await consume(fx, project.id, toPhase, 'approve');
    assert.equal((await effectiveAfter(fx, project, 3)).effective.autonomy, 'phase');

    // phase → stage: tightening, direct.
    assert.equal((await changePolicy(fx.engine, project.id, { autonomy: 'stage' })).effective.autonomy, 'stage', 'phase → stage applies directly');
  });

  test('alpha_deploy: manual → on_phase_complete is confirm_required, applied only on approval; on_phase_complete → manual applies directly', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const previewed = await widening(fx, project, { alpha_deploy: 'on_phase_complete' }, 'alpha_deploy');
    await consume(fx, project.id, previewed, 'approve');
    const widened = await effectiveAfter(fx, project, 1);
    assert.equal(widened.effective.alpha_deploy, 'on_phase_complete');
    assert.equal(policyRevisions(fx.home, project.id)[0]?.widens_authority, 1, 'a widening revision');
    const back = await changePolicy(fx.engine, project.id, { alpha_deploy: 'manual' });
    assert.equal(back.effective.alpha_deploy, 'manual', 'on_phase_complete → manual applies directly');
    assert.equal(policyRevisions(fx.home, project.id).at(-1)?.widens_authority, 0, 'as an ordinary revision');
  });
});
