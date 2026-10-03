// M49, the `policy_widening` manifest (slice 5). Plan §3.5 M49; build spec
// §6 corrections 3 and 22; RN R2 and §3 B12; Review B12, B19; D1 §§10.1,
// 10.5, 11.4, D1-04, D1-15, D1-34, D1-35; E30 item 1; SEAM.md §§27, 76, 78.
//
// A policy change that widens what the engine may do unasked (a higher
// budget, a longer chain of roles) is not committed on request: it raises a
// decision, and the approval binds the base it was previewed against and
// the complete policy that would result. A base that changed in between,
// with the proposed change textually the same, makes the approval stale:
// no update is lost, and a new generation is raised against the new base.
// An approval of an ordinary policy change never carries an edit of the
// governed file.
//
// The first case also raises the chain limit, which slice 3 could not do
// (row M12): with a limit of two, the second role of a chain runs unasked
// and the third waits for a person.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { answerAndHoldEffect, approvalsOf, assertEffectInvalidated, assertQuestionClosed, assertStaleAnswer, confirmRequired, consume, decision, decisionsOfKind, decisionsOn, intentsOf, reject } from './harness/decisions.mjs';
import { GOVERNED_FILE, PROTECTED_FILES, effectiveVersion, proposalsOf } from './harness/gates.mjs';
import { addGitProject, addItem, permittedEdit, roleThat, runToEnd, waitForCandidates, writePlan } from './harness/gitruns.mjs';
import { changePolicy, getPolicy, policyRevisions, workItemsOf } from './harness/journal.mjs';
import { changedPaths, fileAt, refOid } from './harness/repos.mjs';
import { runsOf, scriptedEngine, tick, tickUntil } from './harness/runs.mjs';

const policyPath = (project) => `/v1/projects/${project.id}/policy`;
const head = (project) => refOid(project.repo.path, project.repo.ref);
// The effective policy once revision `n` is the recorded one.
const atRevision = (fx, project, n) =>
  waitFor(
    async () => {
      const policy = await getPolicy(fx.engine, project.id);
      return policy.revision === n ? policy : undefined;
    },
    { what: `policy revision ${n} to be effective` },
  );

describe('M49 the policy_widening manifest', () => {
  test('raising the chain limit is committed only on approval, bound to the base and to the complete resulting policy; with a limit of two the second role of a chain runs unasked and the third waits', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const previewed = await confirmRequired(fx, policyPath(project), { max_chained_roles: 2 });
    assert.deepEqual(
      { kind: previewed.kind, base: previewed.manifest.base_revision, proposed: previewed.manifest.proposed_policy.max_chained_roles, widens: previewed.manifest.widens },
      { kind: 'policy_widening', base: null, proposed: 2, widens: ['max_chained_roles'] },
      'the preview binds the base (no revision yet), the complete proposed policy and what it widens',
    );
    assert.deepEqual([(await getPolicy(fx.engine, project.id)).effective.max_chained_roles, head(project)], [1, project.base], 'nothing is changed or committed before the approval');

    await consume(fx, project.id, previewed, 'approve');
    const policy = await atRevision(fx, project, 1);
    assert.equal(policy.effective.max_chained_roles, 2);
    const [revision] = policyRevisions(fx.home, project.id);
    assert.deepEqual([revision.widens_authority, revision.decision, revision.committed], [1, previewed.id, 1], 'the revision records that it widens authority and which decision confirmed it');
    assert.equal(JSON.parse(fileAt(project.repo.path, head(project), '.surety/policy.json')).max_chained_roles, 2, 'and it is committed');
    await waitFor(() => intentsOf(fx.home, previewed.id)[0]?.status === 'done', { what: 'the effect of the approval to be done' });
    assert.deepEqual([approvalsOf(fx.home, previewed.id).length, intentsOf(fx.home, previewed.id).length], [1, 1], 'one approval and one effect');

    // A chain of three roles: an Architect's plan, its stage's Builder, the candidate's Verifier.
    const replan = await addItem(fx, project.id, 'replan');
    fx.scripted.script(replan, [roleThat([writePlan(2, [{ number: 1, goal: 'the only stage' }])])]);
    fx.scripted.defaultScript(roleThat([permittedEdit()]));
    await runToEnd(fx, project.id, replan);
    const stage = await tickUntil(
      fx.engine,
      project.id,
      () => {
        const work = workItemsOf(fx.home, project.id).find((found) => found.kind === 'stage_build');
        return work && runsOf(fx.home, work.id)[0]?.state === 'ended' ? work : undefined;
      },
      { what: 'the stage the plan registered to be built' },
    );
    assert.equal(decisionsOn(fx.home, 'blocker', stage.id).length, 0, 'the second role of the chain was dispatched with no human step');
    await waitForCandidates(fx, project.id);
    await tick(fx.engine, project.id);
    const verification = workItemsOf(fx.home, project.id).find((found) => found.kind === 'verification');
    assert.deepEqual([runsOf(fx.home, verification.id).length, decisionsOn(fx.home, 'blocker', verification.id).map((row) => row.status)], [0, ['open']], 'the third role stops at the limit: the next step is a decision');
  });

  test('the base changes while the proposed change stays the same: the approval is stale, no update is lost, and the same submission is a new generation against the new base', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const previewed = await confirmRequired(fx, policyPath(project), { max_chained_roles: 3 });
    await changePolicy(fx.engine, project.id, { repair_attempts_max: 2 });

    await assertStaleAnswer(fx, project.id, previewed, 'approve');
    const unchanged = await getPolicy(fx.engine, project.id);
    assert.deepEqual([unchanged.revision, unchanged.effective.repair_attempts_max, unchanged.effective.max_chained_roles], [1, 2, 1], 'the ordinary change stands and nothing was widened');

    const next = await confirmRequired(fx, policyPath(project), { max_chained_roles: 3 });
    assert.deepEqual([next.id !== previewed.id, next.semantic_generation, decision(fx.home, previewed.id).status], [true, previewed.semantic_generation + 1, 'invalidated']);
    assert.notEqual(next.preview_hash, previewed.preview_hash);
    assert.notDeepEqual(next.manifest.base_revision, previewed.manifest.base_revision, 'the new preview is bound to the new base');
    await consume(fx, project.id, next, 'approve');
    const both = await atRevision(fx, project, 2);
    assert.deepEqual([both.effective.repair_attempts_max, both.effective.max_chained_roles], [2, 3], 'approved against the new base, the widening keeps the change made in between');
  });

  test('the base changes after the approval and before its effect: the effect is invalidated, the budget is not raised, and the approval is not carried over', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const previewed = await confirmRequired(fx, policyPath(project), { budget_run_billable_tokens: 3_000_000 });
    assert.deepEqual(previewed.manifest.widens, ['budget_run_billable_tokens'], 'raising a budget is a widening');
    const held = await answerAndHoldEffect(fx, project.id, previewed, 'approve');
    await changePolicy(fx.engine, project.id, { repair_attempts_max: 2 });
    await assertEffectInvalidated(fx, previewed, held);

    const policy = await getPolicy(fx.engine, project.id);
    assert.deepEqual([policy.revision, policy.effective.budget_run_billable_tokens, policy.effective.repair_attempts_max], [1, 1_500_000, 2], 'only the ordinary change is in effect');
    assert.deepEqual(policyRevisions(fx.home, project.id).map((row) => row.widens_authority), [0]);
    const next = await tickUntil(fx.engine, project.id, () => decisionsOfKind(fx.home, project.id, 'policy_widening').find((row) => row.status === 'open'), { max: 4, what: 'the next generation of the widening' });
    assert.deepEqual([next.id !== previewed.id, approvalsOf(fx.home, next.id).length], [true, 0], 'the question is asked again, with no approval carried over');
  });

  test('a widening that comes with a governed field: approving the widening commits the ordinary policy only; the governed edit is a proposal and stays one', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx, { files: PROTECTED_FILES });
    const authorized = effectiveVersion(fx.home, project.id);
    const previewed = await confirmRequired(fx, policyPath(project), { max_chained_roles: 2, required_checks: [] });
    const [proposal] = proposalsOf(fx.home, project.id);
    assert.deepEqual([previewed.response.body.subject.proposal, proposal?.proposed_by, proposal?.status], [proposal?.id, 'human', 'captured'], 'the governed part became a protected proposal, named in the response');

    await consume(fx, project.id, previewed, 'approve');
    await atRevision(fx, project, 1);
    assert.deepEqual(changedPaths(project.repo.path, project.base, head(project)), { '.surety/policy.json': 'A' }, 'the approval committed the ordinary policy file and nothing else');
    assert.ok(!('required_checks' in JSON.parse(fileAt(project.repo.path, head(project), '.surety/policy.json'))), 'which holds no governed key');
    assert.equal(fileAt(project.repo.path, head(project), GOVERNED_FILE), PROTECTED_FILES[GOVERNED_FILE], 'the governed file is as it was');
    assert.deepEqual([effectiveVersion(fx.home, project.id).id, proposalsOf(fx.home, project.id)[0].status], [authorized.id, 'captured'], 'the effective protected version is unchanged and the proposal is still only captured');
  });

  // M2 slice 1, A4 (SEAM.md §102).
  test('reject: the policy is as it was, nothing is committed, the decision is closed with the answer recorded, and the question is not raised again', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const before = await getPolicy(fx.engine, project.id);
    const previewed = await confirmRequired(fx, policyPath(project), { max_chained_roles: 2 });
    assert.deepEqual(previewed.options.map((option) => option.key).sort(), ['approve', 'reject'], 'the fixture is live: the widening offers reject');

    await reject(fx, project.id, previewed);
    const after = await getPolicy(fx.engine, project.id);
    assert.deepEqual([after.revision, after.effective], [before.revision, before.effective], 'the effective policy is as it was: no revision, the chain limit at its default');
    assert.equal(after.effective.max_chained_roles, 1);
    assert.deepEqual(policyRevisions(fx.home, project.id), [], 'no policy revision was recorded');
    assert.equal(head(project), project.base, 'nothing was committed to the integration branch');
    await assertQuestionClosed(fx, project.id, previewed);
    assert.deepEqual([(await getPolicy(fx.engine, project.id)).effective.max_chained_roles, head(project)], [1, project.base], 'and the ticks widened and committed nothing');
  });
});
