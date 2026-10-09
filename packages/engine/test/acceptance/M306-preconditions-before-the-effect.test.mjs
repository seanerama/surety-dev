// M306, preconditions before the effect (slice 23). M4 plan §3.1 M306;
// D4-O02; D4 §§4.1, 4.7; E113, E115; SEAM.md §§247, 250.
//
// Each case: a deploy request issued and intended, its service's admission
// held by the scripted adapter (SEAM §247) so that the operation waits
// before its effect; one fact changed; admission granted. The operation ends
// `failed` with `outcome_detail` `{"code": "EFFECT_PRECONDITION_CHANGED",
// "fact": <fact>, "manifest": <record>}`, recorded in its precondition
// manifest, with no adapter effect call (counted at the scripted adapter),
// the target untouched, the authorization still consumed and the lease
// released at once. The control changes nothing: the operation's own
// consumption of its authorization refuses nothing, and the effect happens.
//
// Deferred (COVERAGE.md; each a question for Sean): a lost sign-off (it
// needs a T2 candidate's Reviewer sign-off and a change of its acceptance
// content: with the scope rows of slice 25); an open out-of-band
// observation of the environment (the observation job of slice 27, M331
// (b)); the lease lost (preempting teardown, slice 27); a unit of unknown
// ownership (recovery and a restored store, slice 26, M324 (e)). The target
// here holds no prior service, so "the prior service untouched" is read as
// the target unchanged; a prior is slice 26's (M323).

import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { makeTempDir, removeDir } from './harness/engine.mjs';
import { capturedProposal, evaluate, humanApplies, raiseFindings, successor } from './harness/gates.mjs';
import { operatorRequest } from './harness/checks/selection.mjs';
import { recordFile, recordRow } from './harness/records.mjs';
import { advanceClock, scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import {
  adapterState,
  artifactsOf,
  attemptsOf,
  authorizationRow,
  configContent,
  deploy,
  deployable,
  effectCalls,
  environmentLeases,
  fixtureAuthorization,
  lapseByFixture,
  operationsOf,
  putConfig,
  scriptCall,
  setAdmission,
} from './harness/deploy/kernel.mjs';

// A deploy intended and waiting for admission. `start` makes the engine (with its args).
async function waiting(t, { deployableOpts = {}, args } = {}) {
  const fx = await scriptedEngine(t, { start: args === undefined });
  if (args !== undefined) await fx.start({ args });
  const ctx = await deployable(fx, deployableOpts);
  await setAdmission(fx.engine, ctx.env.id, 'held');
  await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }]);
  const request = await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
  const op = await tickUntil(fx.engine, ctx.project, () => operationsOf(fx.home, ctx.project, 'deploy')[0], { max: 8, what: 'the deploy to be intended' });
  await tick(fx.engine, ctx.project, { rounds: 2 });
  assert.equal(operationsOf(fx.home, ctx.project, 'deploy')[0].status, 'intended', 'the fixture is live: the operation waits for admission before its effect');
  const target = (await adapterState(fx.engine, ctx.env.id)).target;
  return { ...ctx, fx, request, op, target, args };
}

// Ticks until the operation has ended or has an attempt (its effect begun).
const ended = (ctx) =>
  tickUntil(
    ctx.fx.engine,
    ctx.project,
    () => {
      const op = operationsOf(ctx.fx.home, ctx.project, 'deploy')[0];
      if (!op) return undefined;
      if (!['intended', 'in_progress'].includes(op.status)) return op;
      return attemptsOf(ctx.fx.home, op.id).length > 0 ? op : undefined;
    },
    { max: 12, what: 'the operation to end or attempt its effect' },
  );

// What every refused case reads.
async function assertRefusedBeforeEffect(ctx, fact, { authorization = 'consumed' } = {}) {
  const op = await ended(ctx);
  assert.equal(op.status, 'failed', `the operation fails before its effect (status ${op.status}, detail ${JSON.stringify(op.outcome_detail)})`);
  assert.deepEqual([op.outcome_detail?.code, op.outcome_detail?.fact], ['EFFECT_PRECONDITION_CHANGED', fact], `outcome_detail names the fact (${JSON.stringify(op.outcome_detail)})`);
  const manifest = recordRow(ctx.fx.home, op.outcome_detail.manifest);
  assert.equal(manifest?.kind, 'deploy_precondition_manifest', 'the precondition manifest is a record');
  const facts = JSON.parse(readFileSync(recordFile(ctx.fx.home, manifest)).toString('utf8')).facts ?? [];
  assert.ok(facts.some((f) => f.fact === fact && f.held === false), `the manifest records ${fact} as not held (${JSON.stringify(facts)})`);
  const state = await adapterState(ctx.fx.engine, ctx.env.id);
  assert.deepEqual([effectCalls(state, 'deploy').length, effectCalls(state, 'teardown').length], [0, 0], 'no adapter effect call');
  assert.deepEqual(state.target, ctx.target, 'the target is as it was');
  assert.equal(authorizationRow(ctx.fx.home, ctx.request.authorization.id).status, authorization, `the authorization is ${authorization}`);
  assert.ok(environmentLeases(ctx.fx.home, ctx.env.id).every((l) => l.released_at !== null), 'the environment lease is released');
  return op;
}

const grant = (ctx) => setAdmission(ctx.fx.engine, ctx.env.id, 'granted');

describe('M306 every precondition is read again before the effect', () => {
  test('control: nothing changed; the operation\'s own consumption of its authorization refuses nothing, and the effect happens once admitted', async (t) => {
    const ctx = await waiting(t);
    await grant(ctx);
    const op = await ended(ctx);
    const [attempt] = await tickUntil(ctx.fx.engine, ctx.project, () => {
      const a = attemptsOf(ctx.fx.home, op.id);
      return a[0] && a[0].status !== 'started' ? a : undefined;
    }, { what: 'the attempt to settle' });
    assert.equal(attempt.status, 'succeeded');
    assert.equal(effectCalls(await adapterState(ctx.fx.engine, ctx.env.id), 'deploy').length, 1, 'one effect call');
  });

  test('the authorization superseded by a later issuance for the candidate and environment', async (t) => {
    const ctx = await waiting(t);
    const later = await fixtureAuthorization(ctx.fx.engine, { project: ctx.project, candidate: ctx.candidate.id, environment: ctx.env.id, artifact_digest: `sha256:${'b'.repeat(64)}`, config_identity: ctx.config.config_identity, target_set: ['app'] });
    assert.equal((await evaluate(ctx.fx.engine, ctx.project, ctx.candidate.id, 'alpha_authorize', { authorization: later.id }, { inventory: false })).outcome, 'satisfied', 'the fixture is live: a later authorization is issued');
    await grant(ctx);
    await assertRefusedBeforeEffect(ctx, 'authorization', { authorization: 'superseded' });
  });

  test('the candidate superseded by a later nomination on its lineage', async (t) => {
    const ctx = await waiting(t);
    await successor(ctx.fx, { project: { id: ctx.project } });
    await grant(ctx);
    await assertRefusedBeforeEffect(ctx, 'candidate_superseded');
  });

  test('a protected tightening applied (the issuing gate\'s eligibility revalidated)', async (t) => {
    const ctx = await waiting(t);
    const proposal = await capturedProposal(ctx.fx, { id: ctx.project }, { changeKind: null, content: '{"expect": 200}\n' });
    await humanApplies(ctx.fx, { id: ctx.project }, proposal, 'tightening');
    await grant(ctx);
    await assertRefusedBeforeEffect(ctx, 'gate_eligibility');
  });

  test('a pending required rerun (a newer registration of a required check)', async (t) => {
    const ctx = await waiting(t);
    await operatorRequest(ctx.fx.engine, ctx.project, ctx.candidate.id, ['acc']);
    await grant(ctx);
    await assertRefusedBeforeEffect(ctx, 'gate_eligibility');
  });

  test('a new blocking finding', async (t) => {
    const ctx = await waiting(t);
    await raiseFindings(ctx.fx, ctx.project, ctx.candidate.id, [{ category: 'security', severity: 'critical', message: 'the service accepts an expired session', check: 'acc', criterion: 'R1.1' }]);
    await grant(ctx);
    await assertRefusedBeforeEffect(ctx, 'gate_eligibility');
  });

  test('required evidence expired: a deciding result\'s output record missing', async (t) => {
    const ctx = await waiting(t);
    const output = withStore(ctx.fx.home, (db) => db.prepare('SELECT "output" FROM "check_results" WHERE "execution" = ?').get(ctx.reg.acc.id))?.output;
    assert.ok(output, 'the acceptance result names its output record');
    rmSync(recordFile(ctx.fx.home, recordRow(ctx.fx.home, output)), { force: true });
    await grant(ctx);
    await assertRefusedBeforeEffect(ctx, 'gate_eligibility');
  });

  test('the configuration changed (a new version)', async (t) => {
    const ctx = await waiting(t);
    const res = await putConfig(ctx.fx.engine, ctx.project, ctx.env.name, configContent({ port: 9090 }));
    assert.ok([200, 201].includes(res.status), `the fixture is live: a new version (→ ${res.status})`);
    await grant(ctx);
    await assertRefusedBeforeEffect(ctx, 'configuration_changed');
  });

  test('a secret value changed (the version secrets_changed at the next start)', async (t) => {
    const dir = makeTempDir('m306-secret');
    t.after(() => removeDir(dir));
    const file = join(dir, 'token');
    writeFileSync(file, 'surety-m306-first-value-0123456789\n');
    chmodSync(file, 0o600);
    const args = ['--secret-file', `deploy/app_token=${file}`];
    const ctx = await waiting(t, { args, deployableOpts: { config: { secrets: { APP_TOKEN: 'deploy/app_token' } } } });
    writeFileSync(file, 'surety-m306-second-value-9876543210\n');
    await ctx.fx.engine.stop();
    await ctx.fx.start({ args });
    await grant(ctx);
    await assertRefusedBeforeEffect(ctx, 'config_secrets_changed');
  });

  test('the sealed artifact changed (it no longer rehashes to its digest)', async (t) => {
    const ctx = await waiting(t);
    const [artifact] = artifactsOf(ctx.fx.home, ctx.project);
    const path = join(artifact.path, 'server.js');
    chmodSync(path, 0o644);
    appendFileSync(path, '// changed\n');
    await grant(ctx);
    await assertRefusedBeforeEffect(ctx, 'artifact_integrity');
  });

  test('the adapter qualification lapsed', async (t) => {
    const ctx = await waiting(t);
    await lapseByFixture(ctx.fx.engine, ctx.qualification);
    await grant(ctx);
    await assertRefusedBeforeEffect(ctx, 'adapter_qualification');
  });

  test('the host qualification lapsed (a host check failed at the next start)', async (t) => {
    const ctx = await waiting(t);
    await ctx.fx.engine.stop();
    await ctx.fx.start({ args: ['--harness-host-check', 'H6=failed'] });
    await grant(ctx);
    await assertRefusedBeforeEffect(ctx, 'host_qualification');
  });

  test('admission not granted by the orchestration deadline: failed with nothing applied, naming the deadline', async (t) => {
    const ctx = await waiting(t);
    await advanceClock(ctx.fx.engine, 1801);
    await assertRefusedBeforeEffect(ctx, 'orchestration_deadline');
  });
});
