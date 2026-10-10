// M317, verification outcomes, and what never verifies (slice 25). M4 plan
// §3.3 M317; D4-V04, D4-V05; D4 §§5.3, 5.4, 6.2; E114, E115; SEAM.md §§91,
// 190, 247, 248, 255, 265, 268.
//
// Kernel lane. Each condition of D4 §5.3 item 6 beside the control in which
// all are met: `verified` only when every one holds; `failed` only on a
// difference (a read that differs, the instance changed) or a failed
// required check; `unknown` otherwise, `missing` naming each absent
// execution, read or resource (D4 A.2 VerificationMissing: identity_read,
// check_execution, check_result, supervision, qualification, deadline).
// Absent evidence is never read as failure or as success. And (b): nothing
// but a verified round of the engine's own reads and engine-run checks
// verifies: not workspace checks, not an adapter's `issued`, not a confirmed
// effect, not a `healthy` observation, not a passing `post_deploy_identity`
// check while the engine's own read differs.
//
// The surviving service of an engine restart (supervision `unknown`): its
// round is `unknown` naming `supervision`, and whatever post-deploy
// execution the kernel lane's scripted boundary holds for it, recording it
// passing verifies nothing (the slice-23 review's S1 form). That the check
// is refused `redaction_unavailable` is the runner's decision at admission,
// which no kernel-lane engine makes (SEAM.md §211): the refusal itself is
// read where a real runner admits checks (M324 (a), slice 26) †.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { capturedProposal, humanApplies } from './harness/gates.mjs';
import { advanceClock, scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { def } from './harness/checks/scope.mjs';
import { defPath } from './harness/checks/fixtures.mjs';
import {
  DEPLOY_DEFS,
  armBarrier,
  deploy,
  deployable,
  deployToRound,
  lapseByFixture,
  operationsOf,
  postDeployExecutions,
  scriptCall,
  tickToBarrier,
} from './harness/deploy/kernel.mjs';
import {
  changeTarget,
  completion,
  environmentRecord,
  executionsOfRound,
  progressOf,
  reasonCodesOf,
  recordExit,
  roundExecutions,
  roundsOf,
  rowOf,
  rowWhen,
  stepExecution,
} from './harness/deploy/rounds.mjs';

const IDENT = def('post_deploy_identity', { gates: ['alpha_complete'], requires: ['environment', 'artifact_digest'] });

async function atRound1(t, opts = {}) {
  const fx = await scriptedEngine(t);
  const ctx = await deployable(fx, opts);
  const { operation, execution } = await deployToRound(ctx, opts.round ?? {});
  const [round1] = roundsOf(fx.home, operation.id);
  return { ...ctx, operation, round1, x1: execution };
}

const missingKinds = (row) => (row.missing ?? []).map((m) => m.kind);

// Change generation 1's unit on the scripted target.
const changeUnit = (ctx, fields) =>
  changeTarget(ctx.fx.engine, ctx.env.id, (target) => ({ ...target, units: target.units.map((u) => (u.generation === 1 ? { ...u, ...fields } : u)) }));

describe('M317 (a) each condition of the verification row', () => {
  const cases = [
    ['all met (the control)', async (ctx) => recordExit(ctx.fx.engine, ctx.x1.id, 0), 'verified', null],
    ['the second read differs (a byte of the tree)', async (ctx) => {
      await changeUnit(ctx, { tree: `sha256:${'d'.repeat(64)}` });
      await recordExit(ctx.fx.engine, ctx.x1.id, 0);
    }, 'failed', null],
    ['the application instance changed between the reads', async (ctx) => {
      await changeUnit(ctx, { instance: { pid: 198765, start_time: 777 } });
      await recordExit(ctx.fx.engine, ctx.x1.id, 0);
    }, 'failed', null],
    ['a required check failed', async (ctx) => recordExit(ctx.fx.engine, ctx.x1.id, 1), 'failed', null],
    ['the second read unread (unavailable)', async (ctx) => {
      await scriptCall(ctx.fx.engine, ctx.env.id, 'verify', [{ failure: 'unavailable' }]);
      await recordExit(ctx.fx.engine, ctx.x1.id, 0);
    }, 'unknown', 'identity_read'],
    ['the adapter qualification lapsed between the round\'s start and its finalization', async (ctx) => {
      await lapseByFixture(ctx.fx.engine, ctx.qualification);
      await recordExit(ctx.fx.engine, ctx.x1.id, 0);
    }, 'unknown', 'qualification'],
    ['the orchestration deadline reached with the check not run', async (ctx) => {
      await advanceClock(ctx.fx.engine, 1801);
    }, 'unknown', 'deadline'],
  ];
  for (const [what, act, outcome, missing] of cases) {
    test(`${what}: ${outcome}${missing ? `, missing naming ${missing}` : ''}`, async (t) => {
      const ctx = await atRound1(t);
      await act(ctx);
      const row = await rowWhen(ctx, ctx.round1.id, { max: 20 });
      assert.equal(row.outcome, outcome, `${what}: the row is ${outcome} (D4 §5.3 item 6) (row ${JSON.stringify({ outcome: row.outcome, missing: row.missing, reads: row.identity_reads })})`);
      if (missing) assert.ok(missingKinds(row).includes(missing), `${what}: missing names ${missing} (${JSON.stringify(row.missing)})`);
      const record = environmentRecord(ctx.fx.home, ctx.env.id);
      if (outcome === 'verified') assert.equal(record.last_verified?.round, ctx.round1.id, 'the control writes last_verified');
      else {
        assert.equal(record.last_verified ?? null, null, `${what}: last_verified is not written`);
        assert.equal(record.attempted?.outcome, outcome === 'failed' ? 'verification_failed' : 'verification_unknown', `${what}: attempted names the outcome (${JSON.stringify(record.attempted)})`);
        await tick(ctx.fx.engine, ctx.project, { rounds: 2 });
        const evaluation = await completion(ctx.fx.engine, ctx.project, ctx.candidate.id, ctx.operation.id);
        assert.ok(reasonCodesOf(evaluation).includes(outcome === 'failed' ? 'DEPLOY_VERIFICATION_FAILED' : 'DEPLOY_VERIFICATION_UNKNOWN'), `${what}: completion names the outcome (${JSON.stringify(evaluation.reasons)})`);
        assert.equal(progressOf(ctx.fx.home, ctx.candidate.id), 'developing');
      }
    });
  }

  test('a required check interrupted until check_infra_retries_max is spent: unknown, missing naming the check; never failed, never verified', async (t) => {
    const ctx = await atRound1(t);
    const seen = new Set();
    for (let i = 0; i < 6; i++) {
      const queued = executionsOfRound(ctx.fx.home, ctx.candidate.id, ctx.round1.id).filter((x) => x.status === 'queued' && !seen.has(x.id));
      if (queued.length === 0) {
        await tick(ctx.fx.engine, ctx.project, { rounds: 2 });
        if (rowOf(ctx.fx.home, ctx.round1.id)) break;
        continue;
      }
      for (const x of queued) {
        seen.add(x.id);
        await stepExecution(ctx.fx.engine, x.id, 'materializing');
        await stepExecution(ctx.fx.engine, x.id, 'interrupted');
      }
      await tick(ctx.fx.engine, ctx.project, { rounds: 2 });
    }
    assert.ok(seen.size >= 1 && seen.size <= 3, `the check ran at most 1 + check_infra_retries_max times (${seen.size})`);
    const row = await rowWhen(ctx, ctx.round1.id, { max: 20 });
    assert.equal(row.outcome, 'unknown', `an execution never established is absent evidence: unknown (${row.outcome})`);
    assert.ok(missingKinds(row).some((k) => ['check_execution', 'check_result'].includes(k)), `missing names the check's execution or result (${JSON.stringify(row.missing)})`);
  });

  test('the service survived an engine restart (supervision unknown): unknown, missing naming supervision, whatever its reads and its scripted check say', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }]);
    await armBarrier(fx.engine, 'deploy.receipt_recorded', 'kill');
    await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    const dying = fx.engine;
    await tickToBarrier(fx, ctx.project, 'deploy.receipt_recorded').catch(() => undefined);
    await dying.exited;
    await fx.start();
    const [op] = operationsOf(fx.home, ctx.project, 'deploy');
    const row = await tickUntil(
      fx.engine,
      ctx.project,
      async () => {
        const round = roundsOf(fx.home, op.id).at(-1);
        const v = round ? rowOf(fx.home, round.id) : undefined;
        if (v) return v;
        for (const x of postDeployExecutions(fx.home, ctx.candidate.id)) if (x.status === 'queued') await recordExit(fx.engine, x.id, 0);
        return undefined;
      },
      { max: 24, what: 'the round on the surviving service' },
    );
    assert.equal(row.outcome, 'unknown');
    assert.ok(missingKinds(row).includes('supervision'), `missing names supervision (${JSON.stringify(row.missing)})`);
    for (const x of postDeployExecutions(fx.home, ctx.candidate.id)) {
      if (x.not_run_reason !== null && x.not_run_reason !== undefined) assert.equal(x.not_run_reason, 'redaction_unavailable', `a post-deploy execution against the survivor is not run for redaction_unavailable, if the engine records it (D4 §5.1, §7.3) (${x.not_run_reason})`);
    }
  });

  test('no post_deploy_behavior check among the passes (the behaviour check removed between the reads, a loosening): the round with only a post_deploy_identity check passing is unknown, never verified', async (t) => {
    const ctx = await atRound1(t, { defs: { ...DEPLOY_DEFS, ident: IDENT } });
    const proposal = await capturedProposal(ctx.fx, { id: ctx.project }, { changeKind: null, steps: [step.delete(defPath('behaves'))] });
    await humanApplies(ctx.fx, { id: ctx.project }, proposal, 'loosening');
    const round2 = await tickUntil(ctx.fx.engine, ctx.project, () => roundsOf(ctx.fx.home, ctx.operation.id).find((r) => r.round === 2), { max: 8, what: 'the round that follows the changed required set (SEAM.md §267)' });
    const xs = await roundExecutions(ctx, round2.id);
    assert.deepEqual(xs.map((x) => x.key), ['ident'], `round 2 requires only the identity check (${xs.map((x) => x.key)})`);
    await recordExit(ctx.fx.engine, xs[0].id, 0);
    const row = await rowWhen(ctx, round2.id);
    assert.equal(row.outcome, 'unknown', `both reads match and every required check passed, but none is post_deploy_behavior: unknown, never verified (D4 §5.3 item 6) (${row.outcome})`);
    assert.equal(environmentRecord(ctx.fx.home, ctx.env.id).last_verified ?? null, null);
    assert.equal(progressOf(ctx.fx.home, ctx.candidate.id), 'developing');
  });
});

describe('M317 (b) what never verifies', () => {
  test('workspace checks passed, the adapter\'s issued, a confirmed effect and a healthy observation, with the round\'s own check not yet run: no verified row, completion pending, the candidate developing', async (t) => {
    const ctx = await atRound1(t);
    const [op] = operationsOf(ctx.fx.home, ctx.project, 'deploy');
    assert.equal(op.status, 'succeeded', 'the fixture is live: the effect is confirmed');
    const observed = await ctx.fx.engine.post('/v1/harness/fixtures/observation', { project: ctx.project, environment: ctx.env.id, condition: 'healthy', observed_at: new Date().toISOString(), source: 'test' });
    assert.equal(observed.status, 201, `a healthy observation is recorded (SEAM.md §91) (body: ${observed.text})`);
    await tick(ctx.fx.engine, ctx.project, { rounds: 4 });
    assert.equal(rowOf(ctx.fx.home, ctx.round1.id), undefined, 'no verification row');
    assert.equal(environmentRecord(ctx.fx.home, ctx.env.id).last_verified ?? null, null, 'no last_verified');
    const evaluation = await completion(ctx.fx.engine, ctx.project, ctx.candidate.id, ctx.operation.id);
    assert.ok(reasonCodesOf(evaluation).includes('DEPLOY_VERIFICATION_PENDING'), `completion waits for the round (${JSON.stringify(evaluation.reasons)})`);
    assert.equal(progressOf(ctx.fx.home, ctx.candidate.id), 'developing');
  });

  test('a passing post_deploy_identity check (and a passing behaviour check) while the engine\'s own second read differs: failed, never verified', async (t) => {
    const ctx = await atRound1(t, { defs: { ...DEPLOY_DEFS, ident: IDENT } });
    const xs = await roundExecutions(ctx, ctx.round1.id, { n: 2 });
    await changeUnit(ctx, { tree: `sha256:${'e'.repeat(64)}` });
    for (const x of xs) await recordExit(ctx.fx.engine, x.id, 0);
    const row = await rowWhen(ctx, ctx.round1.id);
    assert.equal(row.outcome, 'failed', `the engine's read decides, not the application's account of itself (D4 §5.4) (${row.outcome})`);
  });
});
