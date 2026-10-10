// M324 (e), a store restored from a backup that cannot account for a
// prefixed unit, on the scripted target (slice 26). M4 plan §3.4 M324 (e);
// D4-T08; D4 §§4.1, 4.6, 9.2; E110 item 1; SEAM.md §§59, 247, 250, 273, 278.
//
// Kernel lane. The scripted target outlives the store (its state is under
// the scripted directory, SEAM.md §247), as a real unit outlives a store
// restored from an older backup. A unit carrying the environment's prefix
// that the restored store cannot account for, because no attempt intent
// names it or because the cgroup the store recorded for it is not the one
// the target reports, blocks deployment to the environment (D4 §9.2): a
// request after the restore is refused before its effect, naming
// `unknown_ownership` (SEAM.md §250's fact), the unit listed in what the
// precondition read; it is never adopted (no intent or capability names
// it, no instance is recorded from it) and never stopped. The sandbox file
// M324-after-an-engine-restart-on-a-real-unit reads the affected admission
// and the other cases of the row on real units.
//
// SAFETY: no unit, no systemctl, no host process. The engine is stopped in
// order (SIGTERM through its own handle) before each store command, which
// runs only while no engine holds the home.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { recordFile, recordRow } from './harness/records.mjs';
import { scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { adapterState, attemptsOf, completeRound, deploy, deployToRound, deployable, effectCalls, operationsOf, scriptCall, setTarget, unitName } from './harness/deploy/kernel.mjs';
import { backupNow, restoreInPlace, unitsNamedIn } from './harness/deploy/recover.mjs';

// Every attempt's recorded application instance, by attempt.
const appInstances = (home) => withStore(home, (db) => db.prepare('SELECT "id", "app_instance" FROM "operation_attempts" WHERE "app_instance" IS NOT NULL ORDER BY "id"').all());

// The deploy request made after the restore, and its operation once ended.
async function requestAfterRestore(ctx) {
  const { fx, project, candidate, env } = ctx;
  await scriptCall(fx.engine, env.id, 'deploy', [{ result: 'issued', apply: true }]);
  const callsBefore = (await adapterState(fx.engine, env.id)).calls.length;
  const instancesBefore = appInstances(fx.home);
  const known = new Set(operationsOf(fx.home, project, 'deploy').map((o) => o.id));
  await deploy(fx.engine, project, candidate.id, env.name);
  const op = await tickUntil(fx.engine, project, () => {
    const o = operationsOf(fx.home, project, 'deploy').find((x) => !known.has(x.id));
    return o && o.status !== 'intended' && o.status !== 'in_progress' ? o : undefined;
  }, { max: 16, what: 'the request after the restore to end or attempt its effect' });
  await tick(fx.engine, project, { rounds: 2 });
  return { op, callsBefore, instancesBefore };
}

async function assertBlockedAndUntouched(ctx, { op, callsBefore, instancesBefore }, g1Before) {
  const { fx, env } = ctx;
  assert.deepEqual([op.status, op.outcome_detail?.code, op.outcome_detail?.fact], ['failed', 'EFFECT_PRECONDITION_CHANGED', 'unknown_ownership'], `deployment to the environment is blocked before its effect (D4 §§4.1, 9.2) (${JSON.stringify(op.outcome_detail)})`);
  const manifest = JSON.parse(readFileSync(recordFile(fx.home, recordRow(fx.home, op.outcome_detail.manifest))).toString('utf8'));
  const fact = (manifest.facts ?? []).find((f) => f.fact === 'unknown_ownership');
  assert.equal(fact?.held, false);
  assert.ok(unitsNamedIn(fact.read).includes(g1Before.name), `the unit is listed in what the precondition read (${JSON.stringify(fact.read)})`);
  const state = await adapterState(fx.engine, env.id);
  assert.deepEqual(state.calls.slice(callsBefore).filter((c) => c.call === 'deploy' || c.call === 'teardown'), [], 'no effect call: nothing is stopped or started');
  assert.deepEqual(state.target.units.find((u) => u.name === g1Before.name), g1Before, 'the unit is untouched');
  assert.deepEqual(attemptsOf(fx.home, op.id), [], 'no attempt of the blocked operation, so no intent or capability adopts the unit');
  // Nothing is recorded from it after the restore: the recorded instances are those the restored store
  // held before the request (in the second case, g1's own, recorded at its launch; objection 044).
  assert.deepEqual(appInstances(fx.home), instancesBefore, 'no instance is recorded from it');
}

describe('M324 (e) a restored store that cannot account for a prefixed unit', () => {
  test('no intent: the store restored from a backup taken before generation 1 was deployed; the running unit blocks deployment, is listed, and is never adopted or stopped', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    await fx.engine.stop();
    const before = backupNow(fx);
    await fx.start();
    const { execution } = await deployToRound(ctx);
    await completeRound(ctx, execution);
    const g1 = (await adapterState(fx.engine, ctx.env.id)).target.units.find((u) => u.name === unitName(fx.home, ctx.env.id, 1));
    assert.equal(g1?.state, 'active', 'the fixture is live: generation 1 runs');
    await fx.engine.stop();
    restoreInPlace(fx, before, { [ctx.project]: ctx.p.repo.path });
    await fx.start();
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "attempt_intents"').get().n), 0, 'the fixture is live: the restored store has no attempt intent');
    await assertBlockedAndUntouched({ ...ctx, fx }, await requestAfterRestore({ ...ctx, fx }), g1);
  });

  test('a different cgroup: the store restored with g1\'s intent, the target reporting another cgroup for the unit; it blocks deployment, is listed, and is never adopted or stopped', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    const { execution } = await deployToRound(ctx);
    await completeRound(ctx, execution);
    await fx.engine.stop();
    const after = backupNow(fx);
    restoreInPlace(fx, after, { [ctx.project]: ctx.p.repo.path });
    await fx.start();
    const { target } = await adapterState(fx.engine, ctx.env.id);
    const g1 = { ...target.units.find((u) => u.name === unitName(fx.home, ctx.env.id, 1)), cgroup: '/user.slice/app.slice/elsewhere.scope' };
    await setTarget(fx.engine, ctx.env.id, { ...target, units: target.units.map((u) => (u.name === g1.name ? g1 : u)) });
    await assertBlockedAndUntouched({ ...ctx, fx }, await requestAfterRestore({ ...ctx, fx }), g1);
  });
});
