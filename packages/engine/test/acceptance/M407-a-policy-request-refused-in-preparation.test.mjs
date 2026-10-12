// M407 (c), the 31b review's S6 (slice 31; kernel lane). D6 §6.8 (the policy
// enters at the request, through `requestDeployment`; a refused request is
// final for its key), D4 §4.1 and M312's refusal at the request (a runtime
// whose hash differs from the pinned one, `config_invalid`); SEAM §§354,
// 371, 374.
//
// The one-phase variant under `on_phase_complete`, `alpha` configured with a
// runtime of another hash and the adapter qualified before phase 1
// completes. The policy's request is refused inside its preparation: one
// `deployment_requests` row, `requested_by` policy, `not_issued`, with its
// `reason` † naming the refusal; later ticks make no second request,
// re-seal nothing and emit `artifact.failed` no more than once.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { configContent, configure, qualifyByFixture } from './harness/deploy/kernel.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { deploymentRequests, phaseCompleted } from './harness/journey/drive.mjs';
import { journeyProject, pumpNoIdle } from './harness/journey/review31b.mjs';

describe('M407 (c) S6: a policy request refused inside its preparation', () => {
  test('one deployment_requests row not_issued with its reason; no re-seal and no repeated artifact.failed', async (t) => {
    const { fx, p, ctx } = await journeyProject(t, { onePhase: true, policy: { alpha_deploy: 'on_phase_complete', deploy_auto_retries_max: 0 } });
    const content = configContent({ start: [process.execPath, 'server.mjs'], runtime: { path: process.execPath, sha256: '0'.repeat(64) } });
    await configure(fx.engine, p.id, 'alpha', content);
    await qualifyByFixture(fx.engine, { adapter_version: content.adapter_version });
    await phaseCompleted(fx, ctx, 1);
    const policy = () => deploymentRequests(fx.home, p.id).filter((r) => r.requested_by === 'policy');
    await pumpNoIdle(fx, ctx, () => policy().length > 0 || eventsOfType(fx.home, 'artifact.failed').length >= 2, { what: 'the policy\'s request, or a repeated preparation', max: 10, answerKinds: [] }).catch(() => null);
    for (let i = 0; i < 4; i++) await pumpNoIdle(fx, ctx, () => false, { max: 1, answerKinds: [] }).catch(() => null);
    const rows = policy();
    const failedSoFar = eventsOfType(fx.home, 'artifact.failed').filter((e) => e.subject?.project === p.id);
    const policyEvents = eventsOfType(fx.home, 'deploy.requested_by_policy').filter((e) => e.subject?.project === p.id);
    // The engine's own diagnostic of the tick's policy step (src's `log`, one
    // JSON line on stderr per failed attempt): read only to show the fixture is
    // live, never as the contract.
    const attempts = fx.engine
      .output()
      .stderr.split('\n')
      .filter((l) => l.includes('"what":"alpha policy"'));
    assert.ok(failedSoFar.length > 0 || policyEvents.length > 0 || rows.length > 0 || attempts.length > 0, `the fixture is live: the policy acted on the completion (artifact.failed ${failedSoFar.length}, deploy.requested_by_policy ${policyEvents.length}, the engine's diagnostics of the policy step ${attempts.length})`);
    assert.equal(rows.length, 1, `one request by policy is recorded (${JSON.stringify(rows)}; artifact.failed ${failedSoFar.length}: ${JSON.stringify(failedSoFar.map((e) => e.payload)).slice(0, 400)}; the policy step failed ${attempts.length} times: ${attempts.slice(0, 1).join('').slice(0, 400)})`);
    assert.equal(rows[0].outcome, 'not_issued', 'not_issued');
    assert.match(String(rows[0].reason ?? ''), /config_invalid|runtime/, `with its reason naming the refusal (${JSON.stringify(rows[0])})`);
    const failed = eventsOfType(fx.home, 'artifact.failed').filter((e) => e.subject?.project === p.id);
    assert.ok(failed.length <= 1, `artifact.failed at most once: later ticks re-seal nothing (${failed.length})`);
  });
});
