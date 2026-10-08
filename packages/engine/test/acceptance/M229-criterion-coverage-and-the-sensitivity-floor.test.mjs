// M229, criterion coverage and the sensitivity floor (M3 slice 20, validation
// scope; kernel lane). M3 plan §3.6 M229; D3 §§4.2 to 4.4, §7.1 L3; B04;
// Astra's T11 and §8.3; D3-S01, D3-S02, D3-S09; SEAM.md §§221 to 227.
//
// (a) A scope is complete only when every criterion of every obligation
// requirement is named by a required acceptance-origin check: a criterion
// no check names is a subject of ACCEPTANCE_SCOPE_INCOMPLETE; a requirement
// registered with no criterion is uncertain, and is one too; a developer
// check naming a criterion is refused at discovery and covers nothing.
// (b) Every sensitivity category of a scope, from a requirement it touches or
// from one of its modules, needs a `sensitivity_floor` check naming it and
// listing the gate kind (`area:<name>`); a floor check applies at T1, T2
// and T3 alike. (c) A sensitive requirement two stages implement brings its
// floor into the first stage's scope once that stage alone is integrated
// (partial delivery), with no module declaring the area. (d) The M1
// fixture's former scope, which satisfied a gate before L3 (a requirement
// registered with no criterion, a check mapped to a requirement and naming
// none), is refused now (AD §8.3).
//
// The checks are discovered from each project's definitions; the nomination
// registers them and admits none (SEAM.md §177), and each result is the
// check-result fixture's (SEAM.md §189). Case (d) uses the checks fixture of
// SEAM.md §67 in its M1 form.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { alphaTarget, effectiveVersion, evaluate, installChecks, nominated, passAll, reasonCodes, scopeOf } from './harness/gates.mjs';
import { permittedEdit, roleThat } from './harness/gitruns.mjs';
import { scriptedEngine, tickUntil } from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';
import { codesAt, errorsAt, versionRead } from './harness/checks/fixtures.mjs';
import { nextCandidate } from './harness/checks/selection.mjs';
import { areaSubjects, buildStages, candidatesOfProject, checkIds, def, defPath, incomplete, inventoryDefs, passKeys, scopeProject, scopeRead } from './harness/checks/scope.mjs';

const stageGateOf = (fx, p, candidate, stage) => evaluate(fx.engine, p.id, candidate.id, 'stage', { stage: stage.id });

describe('M229 (a) every criterion of an obligation requirement needs a required acceptance-origin check', () => {
  test('a criterion no check names, and a requirement registered with no criterion, leave the stage scope incomplete, naming them; the stage whose criteria are all named is satisfied', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await scopeProject(fx, {
      defs: { acc1: def('acceptance', { criteria: ['R1.1', 'R1.2'] }), acc2: def('acceptance', { criteria: ['R2.1'] }), smoke: def('smoke') },
      index: [
        { key: 'R1', criteria: ['R1.1', 'R1.2'] },
        { key: 'R2', criteria: ['R2.1', 'R2.2'] },
        { key: 'R3', criteria: [] },
      ],
      stages: [
        { number: 1, goal: 'R1', implements: ['R1'] },
        { number: 2, goal: 'R2', implements: ['R2'] },
        { number: 3, goal: 'R3', implements: ['R3'] },
      ],
    });
    const requirement = Object.fromEntries(p.plan.requirements.map((r) => [r.key, r.id]));
    await buildStages(fx, p);
    // One candidate holding every stage: a fix whose Builder asks for the nomination (T1).
    const c = await nextCandidate(fx, p.id);
    await passKeys(fx, p.id, c.id, ['acc1', 'acc2', 'smoke']);
    const [s1, s2, s3] = p.stages;

    const complete = await stageGateOf(fx, p, c, s1);
    assert.equal(complete.outcome, 'satisfied', `the control: stage 1, whose two criteria acc1 names, is satisfied (reasons: ${JSON.stringify(complete.reasons)})`);
    assert.equal(scopeOf(fx.home, complete).validated, 1);

    const uncovered = await stageGateOf(fx, p, c, s2);
    assert.deepEqual(reasonCodes(uncovered), ['ACCEPTANCE_SCOPE_INCOMPLETE'], `stage 2, every check passed, is incomplete and nothing else (reasons: ${JSON.stringify(uncovered.reasons)})`);
    assert.ok(incomplete(uncovered).includes('R2.2'), `the reason names the criterion no required acceptance-origin check names, R2.2 (subjects: ${JSON.stringify(incomplete(uncovered))})`);
    assert.ok(!incomplete(uncovered).includes('R2.1'), 'and not R2.1, which acc2 names');
    assert.equal(scopeOf(fx.home, uncovered).validated, 0, 'the scope is not validated');

    const uncertain = await stageGateOf(fx, p, c, s3);
    assert.equal(uncertain.outcome, 'not_satisfied');
    assert.ok(incomplete(uncertain).includes(requirement.R3), `a requirement registered with no criterion is uncertain: the reason names R3 (subjects: ${JSON.stringify(incomplete(uncertain))})`);
    assert.equal(scopeOf(fx.home, uncertain).validated, 0);
  });

  test('a developer check naming a criterion is refused at discovery and covers nothing: the criterion is uncovered, and the definition is named', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await scopeProject(fx, {
      defs: { acc: def('acceptance', { criteria: ['R1.1'] }), smoke: def('smoke'), dev: def('acceptance', { origin: 'developer', criteria: ['R1.2'] }) },
      index: [{ key: 'R1', criteria: ['R1.1', 'R1.2'] }],
      stages: [{ number: 1, goal: 'R1', implements: ['R1'] }],
    });
    const version = await versionRead(fx.engine, p.id, effectiveVersion(fx.home, p.id).id);
    assert.ok(errorsAt(version, defPath('dev')).length > 0, `the developer definition naming a criterion is a discovery error (errors: ${JSON.stringify(version.discovery_errors)})`);
    assert.deepEqual([...new Set(codesAt(version, defPath('dev')))], ['covers_not_allowed'], 'covers_not_allowed: a developer check covers nothing (D3 §1.3; SEAM.md §221)');
    await buildStages(fx, p, { nominate: [true] });
    const [c] = candidatesOfProject(fx.home, p.id);
    await passKeys(fx, p.id, c.id, ['acc', 'smoke']);
    const evaluation = await stageGateOf(fx, p, c, p.stages[0]);
    assert.equal(evaluation.outcome, 'not_satisfied');
    const subjects = incomplete(evaluation);
    assert.ok(subjects.includes('R1.2'), `R1.2, which only the developer check names, is uncovered (subjects: ${JSON.stringify(subjects)})`);
    assert.ok(!subjects.includes('R1.1'), 'R1.1 is covered by acc');
    assert.ok(subjects.some((s) => typeof s === 'string' && s.startsWith(defPath('dev'))), `the refused definition is named (subjects: ${JSON.stringify(subjects)})`);
  });
});

describe('M229 (b) every sensitivity category needs a floor check listing the gate kind', () => {
  test('an area from a requirement, then from a scope module, with no floor check listing the stage gate: incomplete, area:<name>; at the Alpha gate, whose floors list it, both areas are covered and the gate is satisfied', async (t) => {
    const fx = await scriptedEngine(t);
    const alphaOnly = ['alpha_authorize'];
    const p = await scopeProject(fx, {
      defs: {
        acc: def('acceptance', { criteria: ['R1.1', 'R2.1'] }),
        smoke: def('smoke'),
        fpd: def('sensitivity_floor', { areas: ['personal_data'], gates: alphaOnly }),
        fpay: def('sensitivity_floor', { areas: ['payments_financial_data'], gates: alphaOnly }),
      },
      files: { 'billing/pay.js': 'export const pay = () => 0;\n' },
      index: [
        { key: 'R1', criteria: ['R1.1'], areas: ['personal_data'] },
        { key: 'R2', criteria: ['R2.1'] },
      ],
      modules: [{ name: 'billing', paths: ['billing/'], sensitive_areas: ['payments_financial_data'] }],
      stages: [
        { number: 1, goal: 'R1', implements: ['R1'] },
        { number: 2, goal: 'R2, in billing', implements: ['R2'], modules: ['billing'] },
      ],
    });
    await buildStages(fx, p);
    const c = await nextCandidate(fx, p.id);
    await passKeys(fx, p.id, c.id, ['acc', 'smoke', 'fpd', 'fpay']);
    const [s1, s2] = p.stages;

    const fromRequirement = await stageGateOf(fx, p, c, s1);
    assert.deepEqual(reasonCodes(fromRequirement), ['ACCEPTANCE_SCOPE_INCOMPLETE'], `stage 1: every check passed, and incomplete (reasons: ${JSON.stringify(fromRequirement.reasons)})`);
    assert.deepEqual(areaSubjects(fromRequirement), ['area:personal_data'], 'the area of the requirement stage 1 implements has no floor check listing the stage gate; billing is not a module of stage 1');
    assert.ok(scopeRead(fx.home, fromRequirement).categories.includes('personal_data'), 'the scope records the category');

    const fromModule = await stageGateOf(fx, p, c, s2);
    assert.deepEqual(reasonCodes(fromModule), ['ACCEPTANCE_SCOPE_INCOMPLETE'], `stage 2: incomplete (reasons: ${JSON.stringify(fromModule.reasons)})`);
    assert.deepEqual(areaSubjects(fromModule), ['area:payments_financial_data'], "the area of stage 2's module, with no requirement declaring it, has no floor listing the stage gate");
    assert.ok(scopeRead(fx.home, fromModule).categories.includes('payments_financial_data'));

    const alpha = await (await alphaTarget(fx, { project: p, candidate: c })).evaluate();
    const ids = checkIds(fx.home, p.id);
    const scope = scopeRead(fx.home, alpha);
    assert.ok(scope.required.includes(ids.fpd) && scope.required.includes(ids.fpay), 'at alpha_authorize both floors are required');
    assert.deepEqual([...scope.categories].sort(), ['payments_financial_data', 'personal_data'], "the deployment scope's categories: the delivered requirement's and the present module's");
    assert.equal(alpha.outcome, 'satisfied', `with each area's floor listing the gate kind and passed, the Alpha gate is satisfied (reasons: ${JSON.stringify(alpha.reasons)})`);
  });

  test('the floor applies at every tier: at T1, T2 and T3 the floor check naming the scope area is in the required set, and no area is uncovered', async (t) => {
    const fx = await scriptedEngine(t);
    for (const tier of ['T1', 'T2', 'T3']) {
      const p = await scopeProject(fx, {
        tier,
        defs: { ...inventoryDefs(tier, ['R1.1']), floor: def('sensitivity_floor', { areas: ['authentication'] }) },
        index: [{ key: 'R1', criteria: ['R1.1'], areas: ['authentication'] }],
        stages: [{ number: 1, goal: 'R1', implements: ['R1'] }],
      });
      await buildStages(fx, p, { nominate: [tier === 'T1'] });
      const [c] = await tickUntil(fx.engine, p.id, () => {
        const found = candidatesOfProject(fx.home, p.id);
        return found.length > 0 ? found : undefined;
      }, { max: 6, what: `the ${tier} candidate` });
      const evaluation = await stageGateOf(fx, p, c, p.stages[0]);
      const scope = scopeRead(fx.home, evaluation);
      assert.ok(scope.categories.includes('authentication'), `${tier}: the category is the scope's (categories: ${JSON.stringify(scope.categories)})`);
      assert.ok(scope.required.includes(checkIds(fx.home, p.id).floor), `${tier}: the floor check is required`);
      assert.deepEqual(areaSubjects(evaluation), [], `${tier}: no area is uncovered`);
    }
  });
});

describe('M229 (c) partial delivery does not suppress a floor', () => {
  test('a sensitive requirement two stages implement, no module declaring its area: once the first stage alone is integrated, its floor check is in the first stage\'s scope', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await scopeProject(fx, {
      defs: { acc: def('acceptance', { criteria: ['R1.1'] }), smoke: def('smoke'), fauth: def('sensitivity_floor', { areas: ['authentication'] }) },
      index: [{ key: 'R1', criteria: ['R1.1'], areas: ['authentication'] }],
      stages: [
        { number: 1, goal: 'R1, first half', implements: ['R1'] },
        { number: 2, goal: 'R1, second half', implements: ['R1'] },
      ],
    });
    const [s1, s2] = p.stages;
    fx.scripted.script(s1.work_item, [roleThat([permittedEdit()], { nominate: true })]);
    // The second stage's Builder never finishes: R1 stays partial.
    fx.scripted.script(s2.work_item, [script.crash(), script.crash(), script.crash(), script.crash(), script.crash()]);
    const [c] = await tickUntil(fx.engine, p.id, () => {
      const found = candidatesOfProject(fx.home, p.id);
      return found.length > 0 ? found : undefined;
    }, { max: 16, what: "the first stage's candidate" });
    const evaluation = await stageGateOf(fx, p, c, s1);
    const scope = scopeRead(fx.home, evaluation);
    const R1 = p.plan.requirements.find((r) => r.key === 'R1').id;
    assert.deepEqual([scope.delivered, scope.partial], [[], [R1]], 'the fixture is live: R1 is partially delivered at the candidate');
    assert.ok(scope.categories.includes('authentication'), `the partially delivered requirement's area is a category of the first stage's scope (categories: ${JSON.stringify(scope.categories)})`);
    assert.ok(scope.required.includes(checkIds(fx.home, p.id).fauth), 'and its floor check is in that scope');
    assert.deepEqual(areaSubjects(evaluation), [], 'the area is covered by the floor');
  });
});

describe('M229 (d) the M1 fixture\'s former scope is now refused (AD §8.3)', () => {
  test('a requirement registered with no criterion, its check mapped to it: uncertain; a requirement with a criterion, its check mapped to the requirement and naming no criterion: the criterion is uncovered; every check passed both times', async (t) => {
    const fx = await scriptedEngine(t);
    const m1Checks = [
      { key: 'login', kind: 'acceptance', gate_kinds: ['stage', 'alpha_authorize'], requirements: ['R1'] },
      { key: 'smoke', kind: 'smoke', gate_kinds: ['stage', 'alpha_authorize'] },
    ];
    for (const [what, index, subject] of [
      ['no index: R1 has no criterion', false, (ctx) => ctx.requirement.R1],
      ['R1 registered with R1.1, the check naming none', true, () => 'R1.1'],
    ]) {
      const ctx = await nominated(fx, { index });
      const ids = (await installChecks(fx.engine, ctx.project.id, m1Checks, { inventory: false })).id;
      await passAll(fx.engine, ctx.project.id, ctx.candidate.id, Object.values(ids));
      const evaluation = await evaluate(fx.engine, ctx.project.id, ctx.candidate.id, 'stage', { stage: ctx.stage });
      assert.deepEqual(reasonCodes(evaluation), ['ACCEPTANCE_SCOPE_INCOMPLETE'], `${what}: the scope the M1 fixture made is incomplete, and nothing else blocks (reasons: ${JSON.stringify(evaluation.reasons)})`);
      assert.ok(incomplete(evaluation).includes(subject(ctx)), `${what}: the reason names ${subject(ctx)} (subjects: ${JSON.stringify(incomplete(evaluation))})`);
    }
  });
});
