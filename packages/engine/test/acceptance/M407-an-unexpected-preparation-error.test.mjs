// M407, an unexpected error in the policy request's preparation (slice 37,
// carried from the 31b review; kernel lane). M5 plan §3.1 M407 (f); D6-D01,
// D6-D02; D6 §6.8 ("the policy is not an unbounded retry"; "a failed attempt
// retains the request's outcome"); K1 (requested ticks make an unbounded
// retry a hot loop); K9; B14; the driver's ruling Q4 of slice 37; SEAM.md
// §§354, 374, 433 The refusal at preparation (a `Refusal`) is S6's,
// `M407-a-policy-request-refused-in-preparation`.
//
// The one-phase variant under `on_phase_complete`, `alpha` configured and the
// adapter qualified before phase 1 completes. The fault `deploy.prepare_error`
// † (`POST /v1/harness/faults` `{"point": "deploy.prepare_error", "project",
// "times"?}`, the house form of a counted fault) makes the engine's
// preparation of the project's deploy request throw an error that is not a
// refusal, `times` times. Expected (the driver's ruling): one
// `deployment_requests` row for the key, its `preparation_attempts` †
// counting the preparations; at most one sealed artifact for the candidate
// (a re-seal reuses it); re-preparation at most `deploy_auto_retries_max`
// more times, then `not_issued` with `reason` `preparation_failed`, and no
// preparation on later requested ticks; with fewer errors than the bound the
// request proceeds and deploys, with one row.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { artifactsOf } from './harness/deploy/kernel.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { ROUTED_KINDS, alphaReady, candidatesOfProject, deploymentRequests, phaseCompleted } from './harness/journey/drive.mjs';
import { journeyProject } from './harness/journey/review31b.mjs';
import { tick } from './harness/runs.mjs';
import { pumpSome } from './harness/exec37/autonomy.mjs';

const NOT_PLAN = ROUTED_KINDS.filter((k) => k !== 'plan_approval');

async function armPrepareError(fx, project, times) {
  const res = await fx.engine.post('/v1/harness/faults', { point: 'deploy.prepare_error', project, times });
  assert.equal(res.status, 200, `the fault deploy.prepare_error † is armed (→ ${res.status} ${res.text})`);
}

async function readyToComplete(t, retries) {
  const { fx, p, ctx } = await journeyProject(t, { onePhase: true, policy: { alpha_deploy: 'on_phase_complete', deploy_auto_retries_max: retries } });
  const { env } = await alphaReady(fx, ctx);
  return { fx, p, ctx, env };
}

const policyRows = (home, project) => deploymentRequests(home, project).filter((r) => r.requested_by === 'policy');
// The project's sealed artifacts (one candidate is requested in the one-phase variant; `artifacts` has no candidate column).
const sealedFor = (home, project) => artifactsOf(home, project).filter((a) => a.status === 'sealed');

describe('M407 an unexpected error in the policy request\'s preparation', () => {
  test('errors beyond the bound: one row, 1 + deploy_auto_retries_max preparations, then not_issued preparation_failed; nothing re-prepared on later ticks; at most one sealed artifact', async (t) => {
    const { fx, p, ctx } = await readyToComplete(t, 1);
    await armPrepareError(fx, p.id, 5);
    const done = await phaseCompleted(fx, ctx, 1);
    const candidate = done.completion_binding.candidate;
    const decided = await pumpSome(fx, ctx, () => policyRows(fx.home, p.id).find((r) => r.outcome !== 'pending'), { what: 'the policy\'s request decided', max: 30, answerKinds: NOT_PLAN });
    assert.deepEqual([decided.outcome, decided.reason], ['not_issued', 'preparation_failed'], `not_issued with reason preparation_failed (${JSON.stringify(decided)})`);
    assert.equal(decided.preparation_attempts, 2, `1 + deploy_auto_retries_max (1) preparations recorded (preparation_attempts †; ${JSON.stringify(decided)})`);
    // Later ticks, requested and not: nothing prepared again.
    for (let i = 0; i < 5; i++) await tick(fx.engine, p.id, { rounds: 1 });
    const rows = policyRows(fx.home, p.id);
    assert.equal(rows.length, 1, 'one request row for the key');
    assert.equal(rows[0].preparation_attempts, 2, 'no preparation on later ticks');
    assert.ok(sealedFor(fx.home, p.id).length <= 1, `at most one sealed artifact for the candidate (${JSON.stringify(artifactsOf(fx.home, p.id).map((a) => [a.digest, a.status]))})`);
    assert.ok(!candidatesOfProject(fx.home, p.id).some((c) => c.progress === 'alpha_deployed'), 'nothing deployed');
    assert.ok(eventsOfType(fx.home, 'deploy.requested_by_policy').filter((e) => e.subject?.project === p.id).length <= 1, 'the policy\'s request event at most once');
  });

  test('fewer errors than the bound: the request re-prepared under the same key proceeds and deploys; one row, one sealed artifact', async (t) => {
    const { fx, p, ctx } = await readyToComplete(t, 1);
    await armPrepareError(fx, p.id, 1);
    const done = await phaseCompleted(fx, ctx, 1);
    const candidate = done.completion_binding.candidate;
    const deployed = await pumpSome(fx, ctx, () => candidatesOfProject(fx.home, p.id).find((c) => c.progress === 'alpha_deployed'), { what: 'alpha_deployed after one failed preparation', max: 60, answerKinds: NOT_PLAN });
    assert.equal(deployed.id, candidate);
    const rows = policyRows(fx.home, p.id);
    assert.equal(rows.length, 1, `one request row for the key (${JSON.stringify(rows)})`);
    assert.equal(rows[0].outcome, 'deployed');
    assert.equal(rows[0].preparation_attempts, 2, 'two preparations recorded on it');
    assert.equal(sealedFor(fx.home, p.id).length, 1, 'one sealed artifact: the re-seal reused it');
  });
});
