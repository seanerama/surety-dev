// M407, Alpha under policy enters at the request; the whole requirement set
// (slice 31b; kernel lane). M5 plan §3.1 M407; D6-D01, D6-D02; D6 §6.8;
// K9; reading 9; B14, B08; D4 §4.1; SEAM.md §354. The driver's ruling: (i)
// covers the active planned set; cancelled, replaced and conformance stages
// go with M430 and M413.
//
// On the scripted deployment adapter (§247), the reference project built to
// phase 1's completion under `autonomy: phase` (M406's fixture):
//   (a) `alpha_deploy` manual: no request created by the engine; the owner's
//       command works as M342;
//   (b) `on_phase_complete`: nothing requested while the environment is not
//       configured, nor while the adapter is not qualified; then one
//       `deployment_requests` row `requested_by` policy with its key, created
//       through `requestDeployment`: the seal, the derived authorization and
//       its evaluation precede the deploy work, and no authorization existed
//       before the request;
//   (c) the request's gate with an incomplete scope (no post-deploy check):
//       `alpha_authorize` refuses as D4-V07, nothing deployed, the outcome
//       retained;
//   (d) a mid-project Alpha after phase 1 of two: the delivered requirements
//       verified, the rest pending, neither failed nor passed;
//   (e) after the last phase: `alpha_authorize` scopes every delivered
//       requirement across both phases;
//   (f) repeated ticks, a restart and a completed prior request: no second
//       request for the key;
//   (g) a superseding candidate after completion: a new key revalidated under
//       D4; a failed attempt not retried, its outcome retained;
//   (h) the harness seeding an authorization before the policy acts: not
//       consumed; the production path derives its own;
//   (i) the delivered set is the active plan's.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { fixtureAuthorization, qualifyByFixture, requestDeployment, scriptCall } from './harness/deploy/kernel.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { evaluationsOf, scopeOf, sharedFixture } from './harness/gates.mjs';
import {
  alphaDeployed,
  alphaReady,
  architectSession,
  authorizationsOfProject,
  candidatesOfProject,
  changeRequest,
  createWithIdea,
  deploymentRequests,
  eventsAbout,
  journeyContext,
  journeyScripts,
  ownerPolicy,
  nextPhasePublished,
  phaseCompleted,
  planOfPhase,
  pump,
  readSpec,
  requirementsOf,
  specSession,
  stagesOfPlan,
  visionSession,
  workOf,
} from './harness/journey/drive.mjs';
import { REQUIREMENTS, ROADMAP_JSON, ROADMAP_MD, specText } from './harness/journey/reference.mjs';
import { scriptedEngine, tick, waitForIdle } from './harness/runs.mjs';
import { setEngineConfig, runningClassifier } from './harness/checks/classifier.mjs';

// The reference project with phase 1 complete under `autonomy: phase`.
// `onePhase`: the specification and roadmap of R1 and R2 alone, so phase 1
// is the last phase (M406 (b)'s products).
// `alphaFirst`: `alpha` configured and the adapter qualified before phase 1
// completes, the realistic order (objection 065): the first tick after the
// completion makes the policy's request, before phase 2 can supersede the
// candidate or change the acceptance content.
async function phaseOneComplete(t, { alpha_deploy = 'manual', omit, onePhase = false, alphaFirst = false } = {}) {
  const fx = await scriptedEngine(t);
  const version = await runningClassifier(fx.engine);
  setEngineConfig(fx, { classifier_authority: { mode: 'authoritative', version } });
  await fx.engine.kill();
  await fx.start();
  journeyScripts(fx, omit === undefined ? {} : { omit });
  // `phase_size` (slice 35; SEAM.md §406): Tally's two-stage phases, so the replan keeps computed routing.
  const p = await createWithIdea(fx, { tier: 'T2', policy: { autonomy: 'phase', alpha_deploy, deploy_auto_retries_max: 0, phase_size: { min: 2, max: 5 } } });
  await visionSession(fx, p.id);
  await specSession(fx, p.id, onePhase ? { second: specText({ requirements: REQUIREMENTS.slice(0, 2) }) } : {});
  const over = onePhase ? { '.surety/roadmap/roadmap.json': { ...ROADMAP_JSON, phases: [ROADMAP_JSON.phases[0]] }, '.surety/roadmap/roadmap.md': ROADMAP_MD } : {};
  const arch = await architectSession(fx, p.id, p.repo, { over });
  const ctx = journeyContext(fx, p);
  const env = alphaFirst ? (await alphaReady(fx, ctx)).env : null;
  const done = await phaseCompleted(fx, ctx, 1);
  return { fx, p, ctx, plan: arch.published, done, env };
}

const policyRequests = (home, project) => deploymentRequests(home, project).filter((r) => r.requested_by === 'policy');
const deployWork = (home, project) => workOf(home, project, 'deploy');

describe('M407 (b) readiness and (h) a seeded authorization (on_phase_complete, the one-phase variant: nothing supersedes the completed candidate)', () => {
  test('(b) nothing requested while the environment is not configured, nor while the adapter is not qualified; both ready: one request by policy through requestDeployment, its authorization derived and evaluated before the deploy work; (h) a seeded authorization is neither named nor consumed', async (t) => {
    const { fx, ctx, done } = await phaseOneComplete(t, { alpha_deploy: 'on_phase_complete', onePhase: true });
    await tick(fx.engine, ctx.project, { rounds: 3 });
    assert.deepEqual(policyRequests(fx.home, ctx.project), [], 'no request without an environment');
    assert.equal(authorizationsOfProject(fx.home, ctx.project).length, 0, 'no authorization');
    const { env } = await alphaReady(fx, ctx, { qualify: false });
    await tick(fx.engine, ctx.project, { rounds: 3 });
    assert.deepEqual(policyRequests(fx.home, ctx.project), [], 'no request while the adapter is not qualified');
    assert.deepEqual(deployWork(fx.home, ctx.project), [], 'no deploy work');
    // (h) the harness seeds an authorization before the policy acts.
    const bound = done.completion_binding;
    const seeded = await fixtureAuthorization(fx.engine, { project: ctx.project, candidate: bound.candidate, environment: env.id, artifact_digest: `sha256:${'b'.repeat(64)}`, config_identity: env.config.config_identity, target_set: ['app'] });
    assert.match(seeded?.id ?? '', /^[a-z]+_/, `the fixture names its row (${JSON.stringify(seeded)})`);
    assert.equal(authorizationsOfProject(fx.home, ctx.project).filter((a) => a.id !== seeded.id).length, 0, 'the fixture\'s is the only authorization before the request');
    assert.deepEqual(deploymentRequests(fx.home, ctx.project), [], 'and no request exists');

    await qualifyByFixture(fx.engine, { adapter_version: env.content.adapter_version });
    const row = await pump(fx, ctx, () => policyRequests(fx.home, ctx.project)[0], { what: 'the policy\'s request', max: 12 });
    assert.deepEqual([row.requested_by, row.request_key?.project, row.request_key?.candidate, row.request_key?.environment_configuration !== undefined], ['policy', ctx.project, bound.candidate, true], `the key names the project, the candidate and the configuration (${JSON.stringify(row.request_key)})`);
    assert.deepEqual(row.request_key?.completion_binding, bound, 'and the phase-completion binding');
    assert.equal(eventsAbout(fx.home, 'deploy.requested_by_policy', ctx.project).length, 1, 'deploy.requested_by_policy once');
    const authorization = authorizationsOfProject(fx.home, ctx.project).find((a) => a.id === row.authorization);
    assert.ok(authorization, `the request names the authorization it derived (${JSON.stringify(row)})`);
    assert.notEqual(authorization.id, seeded.id, 'not the seeded one');
    assert.ok(['issued', 'consumed'].includes(authorization.status), `derived and evaluated (${authorization.status})`);
    assert.match(authorization.evaluation ?? '', /^gate_/, 'with its alpha_authorize evaluation');
    const work = deployWork(fx.home, ctx.project);
    assert.equal(work.length, 1, 'one deploy work item');
    assert.equal(work[0].subject?.authorization, authorization.id, 'created for the derived authorization, after the seal and the evaluation');
    assert.equal(work[0].subject?.candidate, bound.candidate);
    assert.notEqual(authorizationsOfProject(fx.home, ctx.project).find((a) => a.id === seeded.id)?.status, 'consumed', 'the seeded authorization is not consumed');
  });
});

describe('M407 Alpha under policy enters at the request (on_phase_complete, the shared journey, alpha ready before phase 1 completes)', () => {
  const shared = sharedFixture();
  let J;
  before(async () => {
    J = await phaseOneComplete(shared.context, { alpha_deploy: 'on_phase_complete', alphaFirst: true });
  });
  after(shared.cleanup);

  test('(b) ready before the completion: the first ticks after it make one request by policy for the completed candidate, issued before phase 2 supersedes it or changes the acceptance content', async () => {
    const { fx, ctx } = J;
    const row = await pump(fx, ctx, () => policyRequests(fx.home, ctx.project)[0], { what: 'the policy\'s request', max: 6 });
    J.request = row;
    const bound = J.done.completion_binding;
    assert.deepEqual([row.requested_by, row.request_key?.candidate], ['policy', bound.candidate], `the request names the completed candidate (${JSON.stringify(row.request_key)})`);
    assert.deepEqual(row.request_key?.completion_binding, bound, 'and its phase-completion binding');
    const authorization = authorizationsOfProject(fx.home, ctx.project).find((a) => a.id === row.authorization);
    assert.ok(authorization && ['issued', 'consumed'].includes(authorization.status), `issued, not refused (${JSON.stringify(authorization)}; outcome ${row.outcome})`);
    const evaluation = evaluationsOf(fx.home, bound.candidate, 'alpha_authorize').find((e) => e.id === authorization.evaluation);
    assert.equal(evaluation?.outcome, 'satisfied', `alpha_authorize satisfied: nothing superseded the candidate or changed its acceptance content first (${evaluation?.reasons})`);
    const work = deployWork(fx.home, ctx.project);
    assert.deepEqual(work.map((w) => w.subject?.authorization), [authorization.id], 'one deploy work item, for the derived authorization');
  });

  test('(d) a mid-project Alpha after phase 1 of two: the delivered requirements verified, the rest pending, neither failed nor passed; alpha_deployed', async () => {
    const { fx, ctx } = J;
    const candidate = await alphaDeployed(fx, ctx);
    assert.equal(candidate.id, J.done.completion_binding.candidate);
    const spec = await readSpec(fx, ctx.project);
    const byKey = Object.fromEntries((spec.requirements ?? []).map((r) => [r.key, r]));
    assert.deepEqual([byKey.R1?.status, byKey.R2?.status], ['verified', 'verified'], `R1 and R2 delivered and verified (${JSON.stringify(byKey)})`);
    assert.deepEqual([byKey.R3?.status, byKey.R4?.status], ['pending', 'pending'], 'R3 and R4 shown pending, neither failed nor passed');
  });

  test('(f) repeated ticks, a restart and a completed prior request: no second request for the key', async () => {
    const { fx, ctx } = J;
    await tick(fx.engine, ctx.project, { rounds: 3 });
    // The restart at an idle point (SEAM.md §371): under `phase` the next
    // phase's runs go on, and a run a restart interrupts ends `recovered` with
    // its work held for the owner's Resume (D1 §15.3), which is not this case.
    await waitForIdle(fx.home, ctx.project);
    await fx.engine.kill();
    await fx.start();
    // Each start records a new host qualification, so the adapter's is
    // recorded again (SEAM.md §274): the environment stays ready, and still
    // no second request for the key.
    await qualifyByFixture(fx.engine, { adapter_version: J.env.content.adapter_version });
    await tick(fx.engine, ctx.project, { rounds: 3 });
    assert.equal(policyRequests(fx.home, ctx.project).length, 1, 'one request');
    assert.equal(deployWork(fx.home, ctx.project).length, 1, 'one deploy work item');
  });

  test('(e) after the last phase: alpha_authorize scopes every delivered requirement across both phases; (g) the new key revalidated, a failed attempt retained and not retried; (i) the delivered set is the active plan\'s', async () => {
    const { fx, ctx } = J;
    await nextPhasePublished(fx, ctx, 2);
    // The scripted adapter refuses the next deploy (D4 A.2 AdapterEffectResult `refused`).
    await scriptCall(fx.engine, J.env.id, 'deploy', [{ result: 'refused', apply: false }]);
    await phaseCompleted(fx, ctx, 2, { max: 200 });
    const second = await pump(fx, ctx, () => policyRequests(fx.home, ctx.project)[1], { what: 'the second phase\'s request', max: 12 });
    assert.notDeepEqual(second.request_key, J.request.request_key, 'a new key');
    assert.equal(second.request_key.completion_binding.generation, planOfPhase(fx.home, ctx.project, 2).find((p) => p.completed_at).generation);
    const authorization = authorizationsOfProject(fx.home, ctx.project).find((a) => a.id === second.authorization);
    const evaluation = evaluationsOf(fx.home, second.request_key.candidate, 'alpha_authorize').find((e) => e.id === authorization.evaluation);
    assert.ok(evaluation, 'the new request\'s alpha_authorize evaluation');
    const scope = scopeOf(fx.home, evaluation);
    // The scope lists requirement ids (§70); read back as keys.
    const reqs = requirementsOf(fx.home, ctx.project);
    const keyOf = (id) => reqs.find((r) => r.id === id || r.key === id)?.key ?? id;
    assert.deepEqual((scope.delivered ?? []).map(keyOf).sort(), ['R1', 'R2', 'R3', 'R4'], `the scope delivers every requirement of both phases (${JSON.stringify(scope.delivered)})`);
    assert.deepEqual(scope.partial ?? [], [], 'none partial');
    // (i) the active plan's stages deliver the set.
    const active = planOfPhase(fx.home, ctx.project, 2).find((p) => p.active === 1 || p.active === true);
    assert.deepEqual(stagesOfPlan(fx.home, active.id).flatMap((s) => s.implements).map(keyOf).sort(), ['R3', 'R4'], 'phase 2\'s active plan delivers R3 and R4 (`implements` holds requirement ids, §70; objection 066)');
    // (g) the failed attempt: retained, not retried.
    const failed = await pump(fx, ctx, () => deploymentRequests(fx.home, ctx.project).find((r) => r.id === second.id && r.outcome && r.outcome !== 'pending') ?? undefined, { what: 'the second request\'s outcome', max: 40 });
    assert.ok(['failed', 'not_verified', 'unknown'].includes(failed.outcome), `the outcome retained (${failed.outcome})`);
    await tick(fx.engine, ctx.project, { rounds: 4 });
    assert.equal(deployWork(fx.home, ctx.project).length, 2, 'no retry: two deploy work items in all');
    assert.equal(policyRequests(fx.home, ctx.project).length, 2, 'no third request');
  });
});

describe('M407 under manual, and an incomplete scope', () => {
  test('(a) alpha_deploy manual after the last phase: no request by the engine; the owner\'s command works as M342', async (t) => {
    const { fx, ctx, done } = await phaseOneComplete(t, { alpha_deploy: 'manual', onePhase: true });
    await alphaReady(fx, ctx);
    await tick(fx.engine, ctx.project, { rounds: 4 });
    assert.deepEqual(policyRequests(fx.home, ctx.project), [], 'no request by policy');
    assert.deepEqual(deployWork(fx.home, ctx.project), [], 'no deploy work');
    const res = await requestDeployment(fx.engine, ctx.project, done.completion_binding.candidate, 'alpha');
    assert.ok([200, 201].includes(res.status), `the owner's command is answered (→ ${res.status} ${res.text})`);
    assert.equal(res.body?.authorization?.status, 'issued');
    const rows = deploymentRequests(fx.home, ctx.project);
    assert.deepEqual(rows.map((r) => r.requested_by), ['human'], 'the request row names the human');
    // Switching the policy afterwards requests nothing for a key already requested.
    await ownerPolicy(fx, ctx.project, { alpha_deploy: 'on_phase_complete' }); // a widening, approved by the owner (SEAM.md §364)
    await tick(fx.engine, ctx.project, { rounds: 3 });
    assert.deepEqual(policyRequests(fx.home, ctx.project), [], 'the completed key admits no policy request');
  });

  test('(c) the request\'s gate with an incomplete scope: alpha_authorize refuses as D4-V07, nothing deployed, the outcome retained, no second request', async (t) => {
    const { fx, ctx } = await phaseOneComplete(t, { alpha_deploy: 'on_phase_complete', omit: { 1: ['.surety/checks/defs/operation.json', '.surety/checks/post-deploy/operation.mjs'] } });
    await alphaReady(fx, ctx);
    const row = await pump(fx, ctx, () => policyRequests(fx.home, ctx.project).find((r) => r.outcome && r.outcome !== 'pending') ?? undefined, { what: 'the request\'s outcome', max: 12 });
    assert.equal(row.outcome, 'not_issued', `the request was refused at alpha_authorize (${JSON.stringify(row)})`);
    const authorization = authorizationsOfProject(fx.home, ctx.project).find((a) => a.id === row.authorization);
    assert.equal(authorization?.status, 'proposed', 'the authorization proposed, never issued');
    const evaluation = evaluationsOf(fx.home, row.request_key.candidate, 'alpha_authorize').find((e) => e.id === authorization.evaluation);
    assert.equal(evaluation?.outcome, 'not_satisfied');
    const codes = JSON.parse(evaluation.reasons).map((r) => r.code);
    assert.ok(codes.includes('ACCEPTANCE_SCOPE_INCOMPLETE'), `D4-V07's reason, J4: no required post_deploy_behavior check in the completion scope (${codes.join(', ')})`);
    assert.deepEqual(deployWork(fx.home, ctx.project), [], 'nothing deployed');
    await tick(fx.engine, ctx.project, { rounds: 3 });
    assert.equal(policyRequests(fx.home, ctx.project).length, 1, 'the outcome retained; no second request for the key');
    assert.equal(candidatesOfProject(fx.home, ctx.project).every((c) => c.progress === 'developing'), true);
  });
});
