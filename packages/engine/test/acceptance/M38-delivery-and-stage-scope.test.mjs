// M38, delivery and stage scope (slice 5). Plan §3.4 M38; RN R7 and §3 B01;
// build spec §6 correction 8; D1 §9.1, D1-09; Review B01; SEAM.md §70.
//
// Delivery is computed per candidate, when its scope is built, from the
// stages that implement a requirement: none listed is not started (the
// predicate "every stage listing it" is not true of an empty set); some
// integrated at an ancestor of the candidate is partial; all is delivered.
// A stage's scope binds that stage's obligations. The Alpha scope is the
// delivered requirements plus the release floor, and never counts work that
// is not finished. Whatever is uncovered or empty leaves the scope
// incomplete, and an incomplete scope satisfies nothing.
//
// One history, read case by case: a T1 project whose plan has two stages.
// Stage 1 implements A, B and D; stage 2 implements B and C; nothing
// implements Z. Candidate 1 is nominated after stage 1, candidate 2 after
// stage 2. The cases are separately reported readings of the scopes built
// along the way.
//
// M3 slice 20 (L3; SEAM.md §226): the requirement index registers keys of
// the form R<n> (D3 §4.5), so A, B, C, D and Z are the keys R1 to R5, each
// with its one criterion R<n>.1, which its check covers. A delivered
// requirement with no required check is incomplete by its uncovered
// criterion, which the reason names.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { alphaTarget, check, criterionOf, evaluate, installChecks, nominated, reasonCodes, reasonSubjects, scopeOf, sharedFixture, stageGate } from './harness/gates.mjs';
import { roleThatHolds } from './harness/gitruns.mjs';
import { candidatesOf, stagesOf } from './harness/journal.mjs';
import { isAncestor } from './harness/repos.mjs';
import { scriptedEngine, tickUntil } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';

// The requirements A, B, C, D and Z, as index keys (M3 slice 20).
const [A, B, C, D, Z] = ['R1', 'R2', 'R3', 'R4', 'R5'];

async function history(t) {
  const fx = await scriptedEngine(t);
  const ctx = await nominated(fx, {
    requirements: [A, B, C, D, Z],
    stages: [
      { number: 1, goal: 'the first stage', implements: [A, B, D] },
      { number: 2, goal: 'the second stage', implements: [B, C] },
    ],
    // Stage 2's Builder waits until the scopes of candidate 1 have been read.
    roles: [undefined, roleThatHolds([step.write('src/stage-2.js', 'export const stage = 2;\n')], [], { nominate: true })],
  });
  const project = ctx.project.id;
  const [stage1, stage2] = ctx.plan.stages.map((stage) => stage.id);
  const c1 = ctx.candidate;
  const evaluations = {};

  evaluations.noChecks = await stageGate(fx, ctx);
  const first = await installChecks(fx.engine, project, [
    check('kA', { requirements: [A] }),
    check('kB', { requirements: [B] }),
    check('kC', { requirements: [C] }),
    check('smoke', { kind: 'smoke', gates: ['alpha_authorize'] }),
  ]);
  evaluations.uncovered = await stageGate(fx, ctx);
  const second = await installChecks(fx.engine, project, [check('kD', { requirements: [D] })]);
  evaluations.c1stage = await stageGate(fx, ctx);
  const alpha1 = await alphaTarget(fx, ctx, c1);
  evaluations.c1alpha = await alpha1.evaluate();

  fx.scripted.release(ctx.items[1]);
  const c2 = await tickUntil(fx.engine, project, () => candidatesOf(fx.home, project)[1], { what: 'the second candidate' });
  evaluations.c1after = await stageGate(fx, ctx);
  evaluations.c2stage2 = await evaluate(fx.engine, project, c2.id, 'stage', { stage: stage2 });
  evaluations.c2alpha = await (await alphaTarget(fx, ctx, c2, { environment: alpha1.environment })).evaluate();

  return {
    fx,
    ctx,
    c1,
    c2,
    stage1,
    stage2,
    R: { A: ctx.requirement[A], B: ctx.requirement[B], C: ctx.requirement[C], D: ctx.requirement[D], Z: ctx.requirement[Z] },
    k: { ...first.id, ...second.id },
    evaluations,
    scope: Object.fromEntries(Object.entries(evaluations).map(([name, evaluation]) => [name, scopeOf(fx.home, evaluation)])),
  };
}

describe('M38 delivery is computed per candidate, and scope is built from it', () => {
  const shared = sharedFixture();
  let S;
  before(async () => {
    S = await history(shared.context);
  });
  after(() => shared.cleanup());

  const delivery = (scope, id) => (scope.delivered.includes(id) ? 'delivered' : scope.partial.includes(id) ? 'partial' : 'not_started');
  const checks = (...keys) => keys.map((key) => S.k[key]).sort();

  test('a requirement that no stage implements is not started, also when every stage is integrated', () => {
    assert.equal(delivery(S.scope.c1stage, S.R.Z), 'not_started');
    assert.equal(delivery(S.scope.c2alpha, S.R.Z), 'not_started', 'no implementing stage is not "every implementing stage is integrated"');
  });

  test('a requirement none of whose stages is integrated is not started', () => {
    assert.equal(delivery(S.scope.c1stage, S.R.C), 'not_started');
    assert.equal(delivery(S.scope.c1alpha, S.R.C), 'not_started');
  });

  test('a requirement some of whose stages are integrated is partial, which is not delivered', () => {
    assert.equal(delivery(S.scope.c1stage, S.R.B), 'partial');
    assert.equal(delivery(S.scope.c1alpha, S.R.B), 'partial');
  });

  test('a requirement all of whose stages are integrated at an ancestor of the candidate is delivered', () => {
    assert.deepEqual([...S.scope.c1alpha.delivered].sort(), [S.R.A, S.R.D].sort(), 'candidate 1: A and D');
    assert.deepEqual([...S.scope.c2alpha.delivered].sort(), [S.R.A, S.R.B, S.R.C, S.R.D].sort(), 'candidate 2: A, B, C and D');
    assert.deepEqual(S.scope.c2alpha.partial, [], 'and nothing is partial for candidate 2');
  });

  test('a stage integrated at a revision that is not an ancestor of the candidate delivers nothing to it', () => {
    const stage2 = stagesOf(S.fx.home, S.ctx.project.id).find((stage) => stage.id === S.stage2);
    assert.ok(stage2.integrated_revision, 'the fixture is live: stage 2 is integrated');
    assert.equal(isAncestor(S.ctx.project.repo.path, stage2.integrated_revision, S.c1.revision), false, 'at a revision that is not an ancestor of candidate 1');
    assert.deepEqual([...S.scope.c1after.delivered].sort(), [S.R.A, S.R.D].sort(), 'candidate 1 still has A and D delivered and no more');
    assert.deepEqual(S.scope.c1after.partial, [S.R.B], 'and B is still partial for it');
  });

  test('an empty required set, and a delivered requirement with no required check, leave the scope incomplete, and the gate is not satisfied', () => {
    for (const name of ['noChecks', 'uncovered']) {
      assert.ok(reasonCodes(S.evaluations[name]).includes('ACCEPTANCE_SCOPE_INCOMPLETE'), `${name}: reasons ${reasonCodes(S.evaluations[name]).join(', ')}`);
      assert.equal(S.scope[name].validated, 0, `${name}: the scope is not validated`);
    }
    assert.deepEqual(S.scope.noChecks.required, [], 'the fixture is live: with no check declared the required set is empty');
    assert.ok(reasonSubjects(S.evaluations.uncovered, 'ACCEPTANCE_SCOPE_INCOMPLETE').includes(criterionOf(D)), 'the reason names the criterion of the delivered requirement that has no check (D3 §4.3)');
    assert.equal(S.scope.c1stage.validated, 1, 'once every delivered requirement has a required check the scope is validated');
    assert.ok(!reasonCodes(S.evaluations.c1stage).includes('ACCEPTANCE_SCOPE_INCOMPLETE'));
  });

  test("a stage's scope binds that stage's obligations and not another stage's", () => {
    assert.deepEqual([S.scope.c1stage.gate_kind, S.scope.c1stage.stage, S.scope.c1stage.candidate], ['stage', S.stage1, S.c1.id]);
    for (const key of ['kA', 'kD']) assert.ok(S.scope.c1stage.required.includes(S.k[key]), `stage 1 requires ${key}`);
    for (const key of ['kC', 'smoke']) assert.ok(!S.scope.c1stage.required.includes(S.k[key]), `stage 1 does not require ${key}`);
    for (const key of ['kB', 'kC']) assert.ok(S.scope.c2stage2.required.includes(S.k[key]), `stage 2 requires ${key}`);
    for (const key of ['kA', 'kD']) assert.ok(!S.scope.c2stage2.required.includes(S.k[key]), `stage 2 does not require ${key}`);
  });

  test('the Alpha scope is the delivered requirements plus the release floor, and nothing unfinished is in it', () => {
    assert.deepEqual([...S.scope.c1alpha.required].sort(), checks('kA', 'kD', 'smoke'), 'candidate 1: the checks of A and D, and the smoke check; not those of B, which is partial, or of C, which is not started');
    assert.deepEqual(Object.keys(S.evaluations.c1alpha.check_states).sort(), checks('kA', 'kD', 'smoke'), 'a check state is given for the required checks and no other');
    assert.deepEqual([...S.scope.c2alpha.required].sort(), checks('kA', 'kB', 'kC', 'kD', 'smoke'), 'candidate 2: every delivered requirement and the release floor');
    assert.equal(S.evaluations.c1alpha.outcome, 'not_satisfied', 'and an Alpha scope whose checks have not run is not satisfied');
  });
});
