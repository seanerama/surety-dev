// M230, the kind inventory (M3 slice 20, validation scope; kernel lane). M3
// plan §3.6 M230; D3 §4.3; F §5.7; B04; Astra's T11 and §8.3; D3-S07;
// SEAM.md §§221 to 227.
//
// For the scope's tier the required set must hold at least one required
// acceptance-origin check of each kind F §5.7 names: T1 acceptance and
// smoke; T2 also integration and security_lint; T3 also property and
// failure_recovery. A T3 stage scope whose one criterion is covered, whose
// every check passed and whose sign-offs (the Reviewer's at candidate scope
// and the security review) are recorded is satisfied (the control); missing
// any one kind it is incomplete, `kind:<kind>` and nothing else. (b) A
// project's `required_checks`, a definition's `gate_kinds` or its
// `tier_floor` cannot waive a kind. (c) A developer check of the missing
// kind does not count. (d) The former M1 and M2 fixture scopes, an
// acceptance check alone at T1 and at T2, are refused now (AD §8.3).
//
// The checks are discovered (a to c) or declared by the checks fixture
// without the harness's inventory (d); results are the check-result
// fixture's (SEAM.md §189); sign-offs are a Reviewer's run's.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { check, evaluate, installChecks, nominated, passAll, reasonCodes, review, scopeOf } from './harness/gates.mjs';
import { scriptedEngine, tickUntil } from './harness/runs.mjs';
import { buildStages, candidatesOfProject, checkIds, def, incomplete, inventoryDefs, kindSubjects, passKeys, scopeProject } from './harness/checks/scope.mjs';

const KIND_OF = { acc: 'acceptance', smoke: 'smoke', integ: 'integration', lint: 'security_lint', prop: 'property', fr: 'failure_recovery' };
const SIGNOFFS = { T1: [], T2: [{ scope: 'candidate' }], T3: [{ scope: 'candidate' }, { scope: 'security' }] };

// A project at `tier` whose stage implements R1 (one criterion, R1.1) and
// whose protected set holds `defs`; its candidate with every check passed and
// the tier's sign-offs recorded; the stage gate evaluated.
async function judged(fx, { tier = 'T3', defs, governed }) {
  const p = await scopeProject(fx, { tier, defs, governed, index: [{ key: 'R1', criteria: ['R1.1'] }], stages: [{ number: 1, goal: 'R1', implements: ['R1'] }] });
  await buildStages(fx, p, { nominate: [tier === 'T1'] });
  const [c] = await tickUntil(fx.engine, p.id, () => {
    const found = candidatesOfProject(fx.home, p.id);
    return found.length > 0 ? found : undefined;
  }, { max: 6, what: `the ${tier} candidate` });
  await passKeys(fx, p.id, c.id, Object.keys(defs));
  if (SIGNOFFS[tier].length > 0) await review(fx, p.id, c.id, { signoffs: SIGNOFFS[tier] });
  const evaluation = await evaluate(fx.engine, p.id, c.id, 'stage', { stage: p.stages[0].id });
  return { p, c, evaluation };
}

const without = (defs, key) => Object.fromEntries(Object.entries(defs).filter(([k]) => k !== key));

function assertOnlyKindMissing(evaluation, kind, what) {
  assert.deepEqual(reasonCodes(evaluation), ['ACCEPTANCE_SCOPE_INCOMPLETE'], `${what}: incomplete, and nothing else blocks (reasons: ${JSON.stringify(evaluation.reasons)})`);
  assert.deepEqual(kindSubjects(evaluation), [`kind:${kind}`], `${what}: the reason names kind:${kind} and no other kind (subjects: ${JSON.stringify(incomplete(evaluation))})`);
}

describe('M230 (a) a T3 scope missing each required kind in turn is incomplete', () => {
  test('the control, every kind present, is satisfied; without any one of the six kinds the scope is incomplete, kind:<kind>', async (t) => {
    const fx = await scriptedEngine(t);
    const full = inventoryDefs('T3', ['R1.1']);
    const control = await judged(fx, { defs: full });
    assert.equal(control.evaluation.outcome, 'satisfied', `the control: complete criteria, every kind, every sign-off: satisfied (reasons: ${JSON.stringify(control.evaluation.reasons)})`);
    for (const [key, kind] of Object.entries(KIND_OF)) {
      const { evaluation } = await judged(fx, { defs: without(full, key) });
      assertOnlyKindMissing(evaluation, kind, `without ${kind}`);
      assert.equal(scopeOf(fx.home, evaluation).validated, 0, `without ${kind}: the scope is not validated`);
    }
  });
});

describe('M230 (b) required_checks, gate_kinds and tier_floor cannot waive a kind', () => {
  test('security_lint left out of required_checks, or listing only alpha_authorize: incomplete at the stage gate, kind:security_lint; an integration check whose tier_floor is above a T2 scope: incomplete, kind:integration', async (t) => {
    const fx = await scriptedEngine(t);
    const full = inventoryDefs('T3', ['R1.1']);

    const listed = await judged(fx, { defs: full, governed: { required_checks: Object.keys(full).filter((k) => k !== 'lint') } });
    assert.ok(!scopeOf(fx.home, listed.evaluation).required.includes(checkIds(fx.home, listed.p.id).lint), 'the fixture is live: lint is not required');
    assertOnlyKindMissing(listed.evaluation, 'security_lint', 'required_checks omitting lint');

    const gated = await judged(fx, { defs: { ...full, lint: def('security_lint', { gates: ['alpha_authorize'] }) } });
    assertOnlyKindMissing(gated.evaluation, 'security_lint', 'lint listing only alpha_authorize');

    // tier_floor omits a check only below its floor, so the case is a T2 scope (SEAM.md §221).
    const t2 = inventoryDefs('T2', ['R1.1']);
    const floored = await judged(fx, { tier: 'T2', defs: { ...t2, integ: def('integration', { criteria: ['R1.1'], tier_floor: 'T3' }) } });
    assert.ok(!scopeOf(fx.home, floored.evaluation).required.includes(checkIds(fx.home, floored.p.id).integ), 'the fixture is live: integ, floored at T3, is not required at T2');
    assertOnlyKindMissing(floored.evaluation, 'integration', 'integration floored above the T2 scope');
  });
});

describe('M230 (c) a developer check of the missing kind does not count', () => {
  test('property supplied only by a developer-origin check: still incomplete, kind:property, the developer check required beside it', async (t) => {
    const fx = await scriptedEngine(t);
    const defs = { ...without(inventoryDefs('T3', ['R1.1']), 'prop'), devprop: def('property', { origin: 'developer' }) };
    const { p, evaluation } = await judged(fx, { defs });
    assert.ok(scopeOf(fx.home, evaluation).required.includes(checkIds(fx.home, p.id).devprop), 'the fixture is live: the developer check is required (D3 §4.2 (a))');
    assertOnlyKindMissing(evaluation, 'property', 'a developer property check');
  });
});

describe('M230 (d) the former fixture scopes are refused now (AD §8.3)', () => {
  test('an acceptance check alone, its criterion covered and passed: at T1 incomplete, kind:smoke; at T2, with the sign-off, incomplete, kind:smoke, kind:integration, kind:security_lint', async (t) => {
    const fx = await scriptedEngine(t);
    for (const [tier, kinds] of [
      ['T1', ['kind:smoke']],
      ['T2', ['kind:integration', 'kind:security_lint', 'kind:smoke']],
    ]) {
      const ctx = await nominated(fx, { tier });
      const ids = (await installChecks(fx.engine, ctx.project.id, [check('login', { requirements: ['R1'] })], { inventory: false })).id;
      await passAll(fx.engine, ctx.project.id, ctx.candidate.id, Object.values(ids));
      if (SIGNOFFS[tier].length > 0) await review(fx, ctx.project.id, ctx.candidate.id, { signoffs: SIGNOFFS[tier] });
      const evaluation = await evaluate(fx.engine, ctx.project.id, ctx.candidate.id, 'stage', { stage: ctx.stage });
      assert.deepEqual(reasonCodes(evaluation), ['ACCEPTANCE_SCOPE_INCOMPLETE'], `${tier}: incomplete, and nothing else blocks (reasons: ${JSON.stringify(evaluation.reasons)})`);
      assert.deepEqual(kindSubjects(evaluation), kinds, `${tier}: the kinds the tier requires and the scope lacks`);
    }
  });
});
