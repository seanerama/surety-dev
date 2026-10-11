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
// content: slice 28, COVERAGE "M4 slice 25"). The target here
// holds no prior service, so "the prior service untouched" is read as the
// target unchanged; a prior is slice 26's (M323).
//
// Added by slice 26 (deferred here by slice 23, E125 item 8, E127 item 9):
// a unit of unknown ownership, a unit carrying the environment's prefix
// that no attempt intent names, present on the target between the intent
// and the effect (D4 §§4.1, 9.2; SEAM.md §§250, 278). The fact is
// `unknown_ownership`; the precondition's read lists the unit; nothing
// adopts or stops it. Its restored-store form is M324 (e).
//
// Added by slice 27 (deferred here by slice 23, E125 item 8, E127 item 9;
// SEAM.md §§291, 293, 296, 298): an open out-of-band observation of the
// environment (generation 1 restarted by hand, found by the observation
// job while a second deploy waits for admission): fact `out_of_band`; and
// the lease lost before the effect, to a preempting teardown while the
// deploy waits for admission: `failed`, fact `environment_lease`, the
// teardown's `linked_prior`, `deploy.preempted` (the driver's ruling: a
// deploy preempted before any attempt fails; one with an attempt is
// `superseded`, M327).
//
// Added by slice 28 (deferred by slice 23, E125 item 8; carried by E127 item
// 9, E128 item 6, E129 item 9; SEAM.md §318): a required sign-off lost
// between the authorization and the effect. A T2 candidate, signed off by
// its Reviewer at candidate scope, is authorized; while its deploy waits for
// admission the spec revision makes R1 sensitive, so the acceptance content
// hash changes and the earlier sign-off no longer counts (SEAM §§84, 225; the
// stage gate shows `SIGNOFF_MISSING`). The issuing gate's eligibility,
// revalidated before the effect (J4; E113), no longer holds: fact
// `gate_eligibility`, no effect call.

import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { makeTempDir, removeDir } from './harness/engine.mjs';
import { capturedProposal, evaluate, humanApplies, raiseFindings, reasonCodes, review, successor } from './harness/gates.mjs';
import { reviseSpec } from './harness/checks/classifier.mjs';
import { inventoryDefs } from './harness/checks/scope.mjs';
import { operatorRequest } from './harness/checks/selection.mjs';
import { recordFile, recordRow } from './harness/records.mjs';
import { recordExit, roundsOf, rowWhen } from './harness/deploy/rounds.mjs';
import { assertPreemption, observe, openOob, preempt } from './harness/deploy/observe.mjs';
import { advanceClock, scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import {
  adapterState,
  artifactsOf,
  setTarget,
  unitName,
  attemptsOf,
  authorizationRow,
  configContent,
  deploy,
  deployable,
  deployToRound,
  operationRow,
  POST_DEPLOY,
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

describe('M306 a unit of unknown ownership (slice 26; deferred by slice 23)', () => {
  test('a unit carrying the environment\'s prefix that no intent names appears before the effect: refused naming unknown_ownership, the unit listed in the precondition\'s read, never adopted or stopped', async (t) => {
    const ctx = await waiting(t);
    const stray = {
      name: unitName(ctx.fx.home, ctx.env.id, 5),
      state: 'active',
      invocation_id: '5'.repeat(32),
      cgroup: `/user.slice/app.slice/${unitName(ctx.fx.home, ctx.env.id, 5)}`,
      pending_job: false,
      generation: 5,
      instance: { pid: 905005, start_time: 5005 },
      init: { pid: 805005, start_time: 5005 },
      tree: `sha256:${'5'.repeat(64)}`,
    };
    await setTarget(ctx.fx.engine, ctx.env.id, { ...ctx.target, units: [...ctx.target.units, stray] });
    ctx.target = (await adapterState(ctx.fx.engine, ctx.env.id)).target;
    await grant(ctx);
    const op = await assertRefusedBeforeEffect(ctx, 'unknown_ownership');
    const facts = JSON.parse(readFileSync(recordFile(ctx.fx.home, recordRow(ctx.fx.home, op.outcome_detail.manifest))).toString('utf8')).facts ?? [];
    const read = facts.find((f) => f.fact === 'unknown_ownership')?.read;
    assert.ok(JSON.stringify(read ?? null).includes(stray.name), `the precondition's read lists the unit (${JSON.stringify(read)})`);
    assert.deepEqual((await adapterState(ctx.fx.engine, ctx.env.id)).target.units.find((u) => u.name === stray.name), stray, 'the unit is untouched: never adopted, never stopped');
    assert.deepEqual(attemptsOf(ctx.fx.home, op.id), [], 'no attempt, so no intent or capability names it');
  });
});

describe('M306 an open out-of-band observation, and the lease lost (slice 27; deferred by slice 23)', () => {
  test('generation 1 restarted by hand while a second deploy waits for admission: the observation job opens an out-of-band row, and the deploy is refused naming out_of_band, with no effect call', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    const { operation: op1, execution } = await deployToRound(ctx);
    await recordExit(fx.engine, execution.id, 1);
    await rowWhen(ctx, roundsOf(fx.home, op1.id)[0].id);
    await tick(fx.engine, ctx.project, { rounds: 2 });
    const deploysBefore = effectCalls(await adapterState(fx.engine, ctx.env.id), 'deploy').length;

    await setAdmission(fx.engine, ctx.env.id, 'held');
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }]);
    const request = await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    const op2 = await tickUntil(fx.engine, ctx.project, () => operationsOf(fx.home, ctx.project, 'deploy').find((o) => o.id !== op1.id), { max: 8, what: 'the second deploy to be intended' });
    const target = (await adapterState(fx.engine, ctx.env.id)).target;
    await setTarget(fx.engine, ctx.env.id, { ...target, units: target.units.map((u) => (u.generation === 1 ? { ...u, invocation_id: 'e'.repeat(32) } : u)) });
    await observe(ctx);
    assert.equal(openOob(fx.home, ctx.env.id).length, 1, 'the fixture is live: an out-of-band row is open');
    const changed = (await adapterState(fx.engine, ctx.env.id)).target;

    await setAdmission(fx.engine, ctx.env.id, 'granted');
    const op = await tickUntil(fx.engine, ctx.project, () => {
      const o = operationRow(fx.home, op2.id);
      return ['intended', 'in_progress'].includes(o.status) && attemptsOf(fx.home, o.id).length === 0 ? undefined : o;
    }, { max: 12, what: 'the second deploy to end or attempt its effect' });
    assert.equal(op.status, 'failed', `the deploy fails before its effect (${op.status} ${JSON.stringify(op.outcome_detail)})`);
    assert.deepEqual([op.outcome_detail?.code, op.outcome_detail?.fact], ['EFFECT_PRECONDITION_CHANGED', 'out_of_band'], `naming the open out-of-band observation (${JSON.stringify(op.outcome_detail)})`);
    const facts = JSON.parse(readFileSync(recordFile(fx.home, recordRow(fx.home, op.outcome_detail.manifest))).toString('utf8')).facts ?? [];
    assert.ok(facts.some((f) => f.fact === 'out_of_band' && f.held === false), `the manifest records out_of_band not held (${JSON.stringify(facts)})`);
    const state = await adapterState(fx.engine, ctx.env.id);
    assert.equal(effectCalls(state, 'deploy').length, deploysBefore, 'no adapter effect call');
    assert.deepEqual(state.target, changed, 'the target is as it was');
    assert.equal(authorizationRow(fx.home, request.authorization.id).status, 'consumed');
  });

  test('the lease lost to a preempting teardown while the deploy waits for admission: failed naming environment_lease, the teardown\'s linked_prior, deploy.preempted, and no effect call ever', async (t) => {
    const ctx = await waiting(t);
    const { fx } = ctx;
    const leaseBefore = environmentLeases(fx.home, ctx.env.id).find((l) => l.released_at === null);
    const teardownId = await preempt(fx.engine, ctx.project, ctx.env.name);
    assertPreemption(ctx, { deploy: ctx.op, teardownId, leaseBefore });
    const op = operationRow(fx.home, ctx.op.id);
    assert.equal(op.status, 'failed', `a deploy preempted before any attempt fails (the driver's ruling) (${op.status})`);
    assert.deepEqual([op.outcome_detail?.code, op.outcome_detail?.fact], ['EFFECT_PRECONDITION_CHANGED', 'environment_lease'], `naming the lease (${JSON.stringify(op.outcome_detail)})`);
    await grant(ctx);
    await tick(fx.engine, ctx.project, { rounds: 4 });
    assert.equal(effectCalls(await adapterState(fx.engine, ctx.env.id), 'deploy').length, 0, 'no deploy effect call, before or after admission');
    assert.deepEqual(attemptsOf(fx.home, ctx.op.id), [], 'no attempt');
    assert.equal(authorizationRow(fx.home, ctx.request.authorization.id).status, 'consumed', 'the authorization stays consumed');
  });
});

describe('M306 a required sign-off lost before the effect (slice 28; deferred by slice 23)', () => {
  test('a T2 candidate\'s Reviewer sign-off no longer counts once the acceptance content changes while its deploy waits for admission: failed naming gate_eligibility, no effect call', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx, { tier: 'T2', defs: { ...inventoryDefs('T2', ['R1.1']), behaves: POST_DEPLOY } });
    await review(fx, ctx.project, ctx.candidate.id, { signoffs: [{ scope: 'candidate' }] });
    const stage = ctx.p.stages[0].id;
    assert.ok(!reasonCodes(await evaluate(fx.engine, ctx.project, ctx.candidate.id, 'stage', { stage }, { inventory: false })).includes('SIGNOFF_MISSING'), 'the fixture is live: the Reviewer\'s sign-off counts');
    await setAdmission(fx.engine, ctx.env.id, 'held');
    await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }]);
    const request = await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    const op = await tickUntil(fx.engine, ctx.project, () => operationsOf(fx.home, ctx.project, 'deploy')[0], { max: 8, what: 'the deploy to be intended' });
    await tick(fx.engine, ctx.project, { rounds: 2 });
    assert.equal(operationsOf(fx.home, ctx.project, 'deploy')[0].status, 'intended', 'the fixture is live: the operation waits for admission before its effect');
    const target = (await adapterState(fx.engine, ctx.env.id)).target;

    // The sign-off lost: R1 made sensitive, so the acceptance content hash moves.
    await reviseSpec(fx, ctx.project, [{ key: 'R1', criteria: ['R1.1'], areas: ['personal_data'] }]);
    assert.ok(reasonCodes(await evaluate(fx.engine, ctx.project, ctx.candidate.id, 'stage', { stage }, { inventory: false })).includes('SIGNOFF_MISSING'), 'the fixture is live: the earlier sign-off no longer counts');

    await setAdmission(fx.engine, ctx.env.id, 'granted');
    await assertRefusedBeforeEffect({ ...ctx, fx, request, op, target }, 'gate_eligibility');
  });
});
