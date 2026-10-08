// M232, one scope rule (M3 slice 20, validation scope; kernel lane). M3 plan
// §3.6 M232; D3 §4.2 ("one rule, every consumer"), §7.1 L3; B04; Astra's
// T12 and §8.3; D1 §3.4, A.3; D3-S10; SEAM.md §§221 to 227.
//
// Check registration, the gate's scope, the required sign-offs, the
// acceptance content hash and the staleness of a preview bound to that hash
// derive from one rule, so they change together. A T2 candidate is complete,
// signed off by the Reviewer, every check passed; a Low finding the Reviewer
// proposes to accept has a `finding_disposition` decision open, its preview
// binding the candidate's acceptance content hash. Then one input changes,
// nothing else:
// - a requirement's sensitivity: the floor check of its new area is
//   registered by the operator route (refused before), enters the scope,
//   the hash changes, the earlier sign-off no longer counts, the preview is
//   stale and the next generation binds the new hash;
// - a module's tier: the same, through the checks floored at T3, and the
//   required sign-offs become T3's;
// - a module's presence at the revision (the deployment scope): the same,
//   through the module's area and its floor;
// - a requirement's criteria, nonsensitive, the required set unchanged: the
//   scope changes (the new criterion is uncovered), the hash does not, the
//   sign-off still counts, the preview is not stale and its answer is
//   accepted (AD §8.3: such a case keeps its hash).
// And what a module is (the review of build/m3-s20; the driver's ruling
// under D3 §4.2 and AD §8.3): the content hash also covers the scope's
// modules, each by id, paths and effective tier, and the required
// sign-offs, so a module sign-off never outlives a change to what the
// module is, even when the required set and the categories stay as they
// were:
// - a T3 module's paths redefined to other files the revision holds, its
//   area and override the same, present as before;
// - a module's override raised from T2 to T3 where the T3 kinds have no
//   tier floor, so only the required sign-offs change.
// Each time the Reviewer had signed off every sign-off the changed scope
// asks; the hash changes, the open preview is stale, the earlier sign-offs
// no longer count, and a fresh sign-off satisfies the gate.
//
// The spec revision and the module changes are later plan fixture calls
// (SEAM.md §§219, 222); the checks are discovered; results are the
// check-result fixture's; the sign-off and the disposition are a Reviewer's.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { alphaTarget, evaluate, raiseFindings, reasonCodes, review } from './harness/gates.mjs';
import { answer, assertStaleAnswer, consume, decision, nextGeneration, openDecision } from './harness/decisions.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { scriptedEngine, tickUntil } from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';
import { requestChecks } from './harness/checks/fixtures.mjs';
import { reviseSpec } from './harness/checks/classifier.mjs';
import { buildStages, candidatesOfProject, checkIds, def, incomplete, inventoryDefs, moduleIds, passKeys, scopeProject, scopeRead, signoffListed } from './harness/checks/scope.mjs';

// A later plan fixture call that names existing modules: each takes the fields given (SEAM.md §222).
async function redefineModules(fx, project, modules) {
  const res = await fx.engine.post('/v1/harness/fixtures/plan', { project, modules, stages: [{ number: 1, goal: 'a later plan', implements: [] }] });
  assert.equal(res.status, 201, `a later plan fixture call redefines the modules (body: ${res.text})`);
  fx.scripted.script(res.body.stages[0].work_item, [script.crash(), script.crash(), script.crash(), script.crash(), script.crash()]);
}

// The candidate of the shared shape (T2 by default), complete, signed off
// with `signoffs`, every check of the tier's inventory and of `defs` passed,
// a Low finding's acceptance awaiting the human. `gate()` evaluates the
// stage gate, or with `alpha` the Alpha gate.
async function signedOff(t, { tier = 'T2', defs = {}, files, index = [{ key: 'R1', criteria: ['R1.1'] }], modules = [{ name: 'core', paths: ['src/'] }], signoffs = [{ scope: 'candidate' }], alpha = false } = {}) {
  const fx = await scriptedEngine(t);
  const all = { ...inventoryDefs(tier, ['R1.1']), ...defs };
  const p = await scopeProject(fx, { tier, defs: all, files, index, modules, stages: [{ number: 1, goal: 'R1, in core', implements: ['R1'], modules: ['core'] }] });
  await buildStages(fx, p);
  const [c] = await tickUntil(fx.engine, p.id, () => {
    const found = candidatesOfProject(fx.home, p.id);
    return found.length > 0 ? found : undefined;
  }, { max: 6, what: 'the T2 candidate' });
  await passKeys(fx, p.id, c.id, Object.keys(all));
  const [found] = await raiseFindings(fx, p.id, c.id, [{ category: 'defect', severity: 'low', message: 'a label is misspelt' }], { kind: 'verification' });
  await review(fx, p.id, c.id, { signoffs, dispositions: [{ finding: found.id, disposition: 'accept' }] });
  const target = alpha ? await alphaTarget(fx, { project: p, candidate: c }) : null;
  const gate = () => (alpha ? target.evaluate() : evaluate(fx.engine, p.id, c.id, 'stage', { stage: p.stages[0].id }));
  const before = await gate();
  const scope = scopeRead(fx.home, before);
  assert.deepEqual(incomplete(before), [], `the fixture is live: the scope is complete (reasons: ${JSON.stringify(before.reasons)})`);
  assert.ok(!reasonCodes(before).includes('SIGNOFF_MISSING'), "the fixture is live: the Reviewer's sign-off counts");
  const previewed = await openDecision(fx, p.id, 'finding_disposition', found.id);
  assert.equal(previewed.manifest.acceptance_content_hash, scope.acceptance_content_hash, 'the fixture is live: the preview binds the acceptance content the gate computes');
  return { fx, p, c, found, gate, before, scope, previewed };
}

// The consumers agree after a change that brings `probe` into the scope.
async function assertAllChanged(S, probe, what) {
  const { fx, p, c, gate, scope, previewed } = S;
  const after = await gate();
  const now = scopeRead(fx.home, after);
  const id = checkIds(fx.home, p.id)[probe];
  assert.ok(!scope.required.includes(id) && now.required.includes(id), `${what}: the gate's scope now requires ${probe}`);
  const asked = await requestChecks(fx.engine, p.id, c.id, { keys: [probe] });
  assert.equal(asked.status, 202, `${what}: check registration agrees: the operator route registers ${probe} as a required check (body: ${asked.text})`);
  assert.notEqual(now.acceptance_content_hash, scope.acceptance_content_hash, `${what}: the acceptance content hash changed`);
  assert.ok(reasonCodes(after).includes('SIGNOFF_MISSING'), `${what}: the earlier sign-off cannot authorize the changed content (reasons: ${JSON.stringify(after.reasons)})`);
  await assertStaleAnswer(fx, p.id, previewed, 'approve');
  const next = await nextGeneration(fx, p.id, previewed, { changed: 'acceptance_content_hash' });
  assert.equal(next.manifest.acceptance_content_hash, now.acceptance_content_hash, `${what}: the next preview binds the content as it now is`);
  return { after, now };
}

// Before the change the probe is not required: the operator route refuses it.
async function assertNotRegistrable(S, probe) {
  const res = await requestChecks(S.fx.engine, S.p.id, S.c.id, { keys: [probe] });
  assertRefused(res, 400, 'invalid_value', `before the change ${probe} is not a required check of the candidate`);
}

describe('M232 one scope rule: every consumer changes together', () => {
  test("only a requirement's sensitivity: registration, scope, sign-offs, content hash and the preview change together", async (t) => {
    const S = await signedOff(t, { defs: { fpd: def('sensitivity_floor', { areas: ['personal_data'] }) } });
    await assertNotRegistrable(S, 'fpd');
    await reviseSpec(S.fx, S.p.id, [{ key: 'R1', criteria: ['R1.1'], areas: ['personal_data'] }]);
    const { now } = await assertAllChanged(S, 'fpd', 'sensitivity');
    assert.ok(now.categories.includes('personal_data'), 'the scope has the category');
  });

  test("only a module's tier: registration, scope, the required sign-offs, content hash and the preview change together", async (t) => {
    const S = await signedOff(t, { defs: { prop: def('property', { criteria: ['R1.1'], tier_floor: 'T3' }), fr: def('failure_recovery', { criteria: ['R1.1'], tier_floor: 'T3' }) } });
    await assertNotRegistrable(S, 'prop');
    assert.ok(!signoffListed(S.scope, 'security'), 'the fixture is live: a T2 scope asks no security review');
    await redefineModules(S.fx, S.p.id, [{ name: 'core', paths: ['src/'], tier_override: 'T3' }]);
    const { now } = await assertAllChanged(S, 'prop', 'module tier');
    assert.ok(now.required.includes(checkIds(S.fx.home, S.p.id).fr), 'every check floored at T3 is required');
    assert.ok(signoffListed(now, 'module', 'core') && signoffListed(now, 'security'), `the required sign-offs are T3's (${JSON.stringify(now.signoffs)})`);
  });

  test("only a module's presence at the revision: registration, the deployment scope, sign-offs, content hash and the preview change together", async (t) => {
    const S = await signedOff(t, {
      alpha: true,
      defs: { fpay: def('sensitivity_floor', { areas: ['payments_financial_data'] }) },
      modules: [{ name: 'core', paths: ['src/'] }, { name: 'billing', paths: ['billing/'], sensitive_areas: ['payments_financial_data'] }],
    });
    assert.ok(!S.scope.categories.includes('payments_financial_data'), 'the fixture is live: billing has no file at the revision');
    await assertNotRegistrable(S, 'fpay');
    // billing's paths now take in a file the revision holds.
    await redefineModules(S.fx, S.p.id, [{ name: 'billing', paths: ['src/'], sensitive_areas: ['payments_financial_data'] }]);
    const { now } = await assertAllChanged(S, 'fpay', 'module presence');
    assert.ok(now.categories.includes('payments_financial_data'), 'the deployment scope has the present module\'s category');
    const stage = scopeRead(S.fx.home, await evaluate(S.fx.engine, S.p.id, S.c.id, 'stage', { stage: S.p.stages[0].id }));
    assert.equal(stage.acceptance_content_hash, now.acceptance_content_hash, "one content for the candidate: its stage scope's hash is its deployment scope's (D1 A.3: the hash excludes the gate kind; SEAM.md §225)");
  });

  test('only a requirement\'s criteria, nonsensitive, the required set the same: the scope changes and the hash does not; the sign-off still counts and the preview is not stale', async (t) => {
    const S = await signedOff(t);
    await reviseSpec(S.fx, S.p.id, [{ key: 'R1', criteria: ['R1.1', 'R1.2'] }]);
    const after = await S.gate();
    const now = scopeRead(S.fx.home, after);
    assert.ok(incomplete(after).includes('R1.2'), `the scope changed: the new criterion is uncovered (reasons: ${JSON.stringify(after.reasons)})`);
    assert.deepEqual([...now.required].sort(), [...S.scope.required].sort(), 'the required set is the same');
    assert.deepEqual(now.categories, S.scope.categories, 'and nothing sensitive');
    assert.equal(now.acceptance_content_hash, S.scope.acceptance_content_hash, 'so the acceptance content hash is kept (AD §8.3)');
    assert.ok(!reasonCodes(after).includes('SIGNOFF_MISSING'), 'the sign-off on that content still counts');
    const res = await answer(S.fx.engine, S.p.id, S.previewed, 'approve');
    assert.equal(res.status, 200, `the preview bound to the kept hash is not stale: its answer is accepted (→ ${res.status} ${res.text})`);
    assert.equal(decision(S.fx.home, S.previewed.id).status, 'consumed');
  });
});

// A change to what a module is that leaves the required set and the
// categories as they were: the hash changes, the open preview is stale, the
// earlier sign-offs (every one the changed scope asks) do not count; the
// human's answer on the next generation and a fresh sign-off of `signoffs`
// satisfy the gate.
async function assertSignoffsRenewed(S, signoffs, what) {
  const { fx, p, c, gate, scope, previewed } = S;
  const after = await gate();
  const now = scopeRead(fx.home, after);
  assert.deepEqual([...now.required].sort(), [...scope.required].sort(), `${what}: the fixture is live: the required set is the same`);
  assert.deepEqual([...now.categories].sort(), [...scope.categories].sort(), `${what}: the fixture is live: the categories are the same`);
  assert.deepEqual(incomplete(after), [], `${what}: the fixture is live: the scope is complete (reasons: ${JSON.stringify(after.reasons)})`);
  assert.notEqual(now.acceptance_content_hash, scope.acceptance_content_hash, `${what}: the acceptance content hash changed: it covers the scope's modules (id, paths, effective tier) and the required sign-offs (D3 §4.2; AD §8.3)`);
  assert.ok(reasonCodes(after).includes('SIGNOFF_MISSING'), `${what}: the earlier sign-offs, made on what the module was, cannot authorize the changed content (reasons: ${JSON.stringify(after.reasons)})`);
  await assertStaleAnswer(fx, p.id, previewed, 'approve');
  const next = await nextGeneration(fx, p.id, previewed, { changed: 'acceptance_content_hash' });
  assert.equal(next.manifest.acceptance_content_hash, now.acceptance_content_hash, `${what}: the next preview binds the content as it now is`);
  await consume(fx, p.id, next, 'approve');
  await review(fx, p.id, c.id, { signoffs });
  const fresh = await gate();
  assert.equal(fresh.outcome, 'satisfied', `${what}: signed off afresh on the content as it now is, the gate is satisfied (reasons: ${JSON.stringify(fresh.reasons)})`);
  assert.equal(scopeRead(fx.home, fresh).acceptance_content_hash, now.acceptance_content_hash, `${what}: on the same content`);
}

const T3_SIGNOFFS = [{ scope: 'candidate' }, { scope: 'module', module: 'core' }, { scope: 'security' }];

describe('M232 a module sign-off does not survive a change to what the module is (the review of build/m3-s20)', () => {
  test("a T3 module's paths redefined to other files of the revision, its area and override the same and present as before: the hash, the preview and the sign-offs change; a fresh sign-off satisfies the Alpha gate", async (t) => {
    const core = (paths) => ({ name: 'core', paths, sensitive_areas: ['personal_data'], tier_override: 'T3' });
    const S = await signedOff(t, {
      tier: 'T3',
      alpha: true,
      defs: { fpd: def('sensitivity_floor', { areas: ['personal_data'] }) },
      files: { 'lib/util.js': 'export const util = 1;\n' },
      modules: [core(['src/'])],
      signoffs: T3_SIGNOFFS,
    });
    assert.ok(signoffListed(S.scope, 'module', 'core') && signoffListed(S.scope, 'security'), `the fixture is live: the scope asks core's sign-off and the security review (${JSON.stringify(S.scope.signoffs)})`);
    await redefineModules(S.fx, S.p.id, [core(['lib/'])]);
    // Presence is read again for core as it now is: lib/ has a file at the revision.
    await S.gate();
    const presence = JSON.parse(candidatesOfProject(S.fx.home, S.p.id)[0].module_presence ?? 'null');
    assert.deepEqual(presence?.modules, [moduleIds(S.fx.home, S.p.id).core], `the fixture is live: core is present at the revision under its new paths (module_presence: ${JSON.stringify(presence)})`);
    await assertSignoffsRenewed(S, T3_SIGNOFFS, 'core redefined from src/ to lib/');
  });

  test("a module's override raised from T2 to T3, the property and failure_recovery checks having no tier floor: the required set is the same and the required sign-offs change; the hash, the preview and the sign-offs change with them; a fresh sign-off satisfies the stage gate", async (t) => {
    const S = await signedOff(t, {
      defs: { prop: def('property', { criteria: ['R1.1'] }), fr: def('failure_recovery', { criteria: ['R1.1'] }) },
      modules: [{ name: 'core', paths: ['src/'], tier_override: 'T2' }],
      // Signed off beyond what the T2 scope asks: every sign-off the T3 scope will.
      signoffs: T3_SIGNOFFS,
    });
    assert.ok(!signoffListed(S.scope, 'security'), 'the fixture is live: a T2 scope asks no security review');
    await redefineModules(S.fx, S.p.id, [{ name: 'core', paths: ['src/'], tier_override: 'T3' }]);
    const now = scopeRead(S.fx.home, await S.gate());
    assert.ok(signoffListed(now, 'module', 'core') && signoffListed(now, 'security'), `the required sign-offs are T3's (${JSON.stringify(now.signoffs)})`);
    await assertSignoffsRenewed(S, T3_SIGNOFFS, "core's override T2 to T3");
  });
});
