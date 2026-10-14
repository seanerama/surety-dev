// M436 (e), the floor under `autonomy: phase` (slice 37; kernel lane). M5
// plan §3.7 M436 (e); D6-X03 ("no floor item is skipped, each of F §9.1's
// items and E10's asserted, not three examples"); D6 §6.5; F §9.1; E10;
// D4 §4.1; SEAM.md §429 The project-lane part of (e) is
// `M436-the-phase-profile-on-the-project-lane`.
//
// On the reference project at `developing` under `phase`, the scripted
// backend, the scripted check boundary and the scripted deployment adapter,
// each item of the floor asserted where the autonomous path would pass it:
//   1. the specification's approval and its changes are the owner's: each
//      `spec_approval` and `spec_change` consumed was answered by a human, and
//      a role's result answering an open decision is refused `invalid_result`,
//      the decision still open;
//   2. protected changes only through the update process: a Builder's write
//      under the protected root is refused whole (`diff_violation`), no
//      proposal, the effective protected version unchanged;
//   3. deployment verification: the deploy applied and its post-deploy check
//      not yet recorded, the candidate is not `alpha_deployed`; recorded, it
//      is;
//   4. reconcile before retry: a refused deploy attempt under the policy is
//      not retried by the scheduler (one adapter deploy call, one request);
//   5. no publication or go-live capability: publish, export and release
//      routes refused before any effect;
//   6. no conversion of a failed check into a pass: a required check failing
//      every time keeps stage 1 from `verified` and the phase from completing;
//      the stage gate is not satisfied;
//   7. every invocation metered: each launched run has its ledger row.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { adapterState, effectCalls, scriptCall } from './harness/deploy/kernel.mjs';
import { decisionsOfKind } from './harness/decisions.mjs';
import { effectiveVersion, proposalsOf } from './harness/gates.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { ROUTED_KINDS, alphaReady, queuedExecutions, resultsOf, candidatesOfProject, deploymentRequests, evaluationsOfKind, openDecisions, phasePlansOf, runsOfProject } from './harness/journey/drive.mjs';
import { journey35 } from './harness/journey/plan35.mjs';
import { journeyProject } from './harness/journey/review31b.mjs';
import { addWork, runsOf, waitForRun } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { ledgerByRun, pumpSome, stageRows, stageWork, workRow } from './harness/exec37/autonomy.mjs';

const json = (t) => (t === null || t === undefined ? t : typeof t === 'string' ? JSON.parse(t) : t);
const NOT_PLAN = ROUTED_KINDS.filter((k) => k !== 'plan_approval');

describe('M436 (e) the floor under phase', () => {
  test('(e) 1, 2, 3, 5 and 7 on the one-phase journey to alpha_deployed under the policy', async (t) => {
    const { fx, p, ctx } = await journeyProject(t, { onePhase: true, policy: { alpha_deploy: 'on_phase_complete', deploy_auto_retries_max: 0, repair_attempts_max: 0 } });
    await alphaReady(fx, ctx);
    // 1. A role's result answering the open toolchain correction is no answer.
    const toolchain = await pumpSome(fx, ctx, () => openDecisions(fx.home, p.id).find((d) => d.kind === 'check_correction_unclassifiable'), { what: 'the toolchain correction open', max: 60, answerKinds: [] });
    fx.scripted.kindScript('fix', [
      roleThat([], { decisions: [{ decision: toolchain.id, option: 'approve' }] }),
      roleThat([step.write('.surety/checks/defs/accept-r1.json', '{"key": "accept-r1", "kind": "acceptance"}\n'), step.write('src/floor.mjs', 'export const floor = 1;\n')]),
    ]);
    const attempt = await addWork(fx.engine, p.id, 'fix');
    const answered = await pumpSome(fx, ctx, () => runsOf(fx.home, attempt).find((r) => r.state === 'ended'), { what: 'the role\'s run to end', max: 20, answerKinds: [] });
    assert.deepEqual([answered.outcome, answered.reason_class], ['failed', 'invalid_result'], `1. a role's result cannot answer a decision (${JSON.stringify([answered.outcome, answered.reason_class, answered.reason_text])})`);
    assert.equal(openDecisions(fx.home, p.id).find((d) => d.id === toolchain.id)?.status, 'open', '1. the decision is still open');
    // The owner answers it: readiness.
    await pumpSome(fx, ctx, () => phasePlansOf(fx.home, p.id).find((x) => x.phase_number === 1 && x.authoring_ready_at), { what: 'readiness', max: 40, answerKinds: NOT_PLAN });
    // 2. A Builder's write under the protected root, after readiness.
    const effective = effectiveVersion(fx.home, p.id);
    const proposals = proposalsOf(fx.home, p.id).length;
    const protectedWrite = await addWork(fx.engine, p.id, 'fix');
    const rejected = await pumpSome(fx, ctx, () => runsOf(fx.home, protectedWrite).find((r) => r.state === 'ended'), { what: 'the protected write\'s run to end', max: 30, answerKinds: NOT_PLAN });
    assert.equal(rejected.outcome, 'failed', `2. the Builder's protected write is not accepted (${JSON.stringify([rejected.outcome, rejected.reason_class, rejected.reason_text])})`);
    assert.match(String(rejected.reason_text ?? rejected.reason_class ?? ''), /diff_violation|protected/, '2. refused as a protected-path violation');
    assert.equal(proposalsOf(fx.home, p.id).length, proposals, '2. no proposal captured from a Builder');
    assert.equal(effectiveVersion(fx.home, p.id).id, effective.id, '2. the effective protected version unchanged');
    // 3. The deploy applied; its post-deploy check withheld.
    const postDeploy = await pumpSome(fx, ctx, () => candidatesOfProject(fx.home, p.id).length && withPostDeploy(fx, p.id), {
      what: 'a post-deploy check queued after the policy\'s deploy',
      max: 200,
      answerKinds: NOT_PLAN,
      record: (x) => x.deployment === null,
    });
    assert.ok(postDeploy, 'the fixture is live: a post-deploy execution queued');
    assert.ok(!candidatesOfProject(fx.home, p.id).some((c) => c.progress === 'alpha_deployed'), '3. no candidate alpha_deployed before its deployment verification');
    const alphaDeployed = await pumpSome(fx, ctx, () => candidatesOfProject(fx.home, p.id).find((c) => c.progress === 'alpha_deployed'), { what: 'alpha_deployed after the verification', max: 40, answerKinds: NOT_PLAN });
    assert.ok(alphaDeployed, '3. alpha_deployed once verified');
    const complete = evaluationsOfKind(fx.home, p.id, 'alpha_complete').filter((e) => e.candidate === alphaDeployed.id);
    assert.ok(complete.some((e) => e.outcome === 'satisfied'), '3. through a satisfied alpha_complete');
    // 1. Every approval of the specification by a human.
    for (const kind of ['spec_approval', 'spec_change']) {
      for (const d of decisionsOfKind(fx.home, p.id, kind).filter((x) => x.status === 'consumed')) assert.equal(json(d.answer)?.actor, 'human', `1. ${kind} ${d.id} answered by a human`);
    }
    assert.ok(decisionsOfKind(fx.home, p.id, 'spec_approval').some((d) => d.status === 'consumed'), '1. the specification was approved');
    // 5. No publication or go-live capability.
    for (const path of ['publish', 'export', 'releases']) {
      const res = await fx.engine.post(`/v1/projects/${p.id}/${path}`, {});
      assert.ok(res.status >= 400 && ['unsupported', 'not_found'].includes(res.body?.code), `5. POST …/${path} refused (→ ${res.status} ${res.text})`);
    }
    // 7. Every launched run metered.
    const ledger = ledgerByRun(fx.home, p.id);
    const unmetered = runsOfProject(fx.home, p.id).filter((r) => r.started_at && r.kind !== 'session' && !ledger.has(r.id));
    assert.deepEqual(unmetered.map((r) => [r.id, workRow(fx.home, r.work_item)?.kind]), [], '7. every launched one-shot has its ledger row');
  });

  test('(e) 4: a refused deploy attempt under the policy is not retried by the scheduler', async (t) => {
    const { fx, p, ctx } = await journeyProject(t, { onePhase: true, policy: { alpha_deploy: 'on_phase_complete', deploy_auto_retries_max: 0 } });
    const { env } = await alphaReady(fx, ctx, { answers: [{ result: 'refused', apply: false }] });
    const policyRows = () => deploymentRequests(fx.home, p.id).filter((r) => r.requested_by === 'policy');
    await pumpSome(fx, ctx, () => (policyRows()[0] && policyRows()[0].outcome !== 'pending' ? policyRows()[0] : undefined), { what: 'the policy\'s request decided', max: 200, answerKinds: NOT_PLAN });
    for (let i = 0; i < 4; i++) await pumpSome(fx, ctx, () => false, { max: 1, answerKinds: NOT_PLAN }).catch(() => null);
    const calls = effectCalls(await adapterState(fx.engine, env.id));
    assert.equal(calls.length, 1, `4. one deploy call: the refused attempt is not retried (${JSON.stringify(calls)})`);
    assert.equal(policyRows().length, 1, '4. one request');
    assert.notEqual(policyRows()[0].outcome, 'deployed', `4. its outcome retained (${policyRows()[0].outcome})`);
    await scriptCall(fx.engine, env.id, 'deploy', [{ result: 'issued', apply: true }]);
  });

  test('(e) 6: a required check failing every time is never a pass: stage 1 not verified, its gate not satisfied, the phase not complete', async (t) => {
    const { fx, p, ctx } = await journey35(t, { policy: { repair_attempts_max: 0 } });
    const [s1] = stageRows(fx.home, p.id);
    const failing = (x) => (x.key === 'accept-r1' ? 1 : 0);
    await pumpSome(fx, ctx, () => (workRow(fx.home, stageWork(fx.home, p.id, s1.id).id)?.status === 'parked' ? true : undefined), { what: 'stage 1\'s work parked on the failing check', max: 200, answerKinds: NOT_PLAN, exits: failing });
    for (let i = 0; i < 3; i++) await pumpSome(fx, ctx, () => false, { max: 1, answerKinds: NOT_PLAN, exits: failing }).catch(() => null);
    assert.notEqual(stageRows(fx.home, p.id)[0].status, 'verified', '6. stage 1 is not verified');
    assert.ok(!phasePlansOf(fx.home, p.id).some((x) => x.phase_number === 1 && x.completed_at), '6. the phase does not complete');
    const stageGates = evaluationsOfKind(fx.home, p.id, 'stage');
    assert.ok(resultsOf(fx.home, p.id).some((r) => r.exit_status === 1), '6. the fixture is live: the failing result is recorded');
    assert.ok(!stageGates.some((e) => e.outcome === 'satisfied' && JSON.stringify(e).includes(s1.id)), `6. no satisfied stage gate for stage 1 (${JSON.stringify(stageGates.map((e) => [e.outcome, e.reasons]).slice(-2))})`);
    await waitForRun(fx.home, stageWork(fx.home, p.id, s1.id).id, { state: 'ended' });
  });
});

// A post-deploy execution queued (its `deployment` set), whose exit the case withholds.
function withPostDeploy(fx, project) {
  return queuedExecutions(fx.home, project).find((x) => x.deployment !== null);
}
