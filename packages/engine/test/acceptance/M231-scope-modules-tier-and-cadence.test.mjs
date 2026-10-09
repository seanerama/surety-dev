// M231, scope modules, tier and cadence (M3 slice 20, validation scope;
// kernel lane). M3 plan §3.6 M231; D3 §4.1, §7.1 L3, §7.4 Q10; Q7 (a);
// E90 item 2; E91 item 2; B04; Astra's T11; D3-S03, D3-S04, D3-S08;
// SEAM.md §§221 to 227.
//
// (a) A scope's tier is the highest of the project's tier and its modules'
// `tier_override`s: an override raises the tier for the checks the scope
// requires (tier floors), the kind inventory and the sign-offs; an override
// below the project's tier lowers nothing. (b) A stage scope's modules are
// its stage's; a deployment scope's are every module with a file at the
// candidate's revision, recorded on the candidate; a module deleted at a
// later revision drops out; a presence fact that could not be read makes
// the scope incomplete. (c) The scope tier sets the cadence: in a T1
// project, the integration of a stage whose module is T2 nominates by
// engine cadence with no Builder's request, and so does the integration of
// a fix naming a finding whose revision holds a T2 module; under E104 a fix
// naming a finding is nominated at T1 with no T2 module too (the control).
//
// The checks are discovered; results are the check-result fixture's
// (SEAM.md §189); sign-offs are a Reviewer's run's; findings a Verifier's.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { alphaTarget, evaluate, raiseFindings, reasonCodes, review } from './harness/gates.mjs';
import { addItem, roleThat } from './harness/gitruns.mjs';
import { armFault, clearFaults } from './harness/engine.mjs';
import { addWork, runsOf, scriptedEngine, tickUntil } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { nextCandidate } from './harness/checks/selection.mjs';
import { buildStages, candidatesOfProject, checkIds, def, incomplete, inventoryDefs, kindSubjects, moduleIds, passKeys, scopeProject, scopeRead, signoffListed } from './harness/checks/scope.mjs';

const stageGateOf = (fx, p, candidate, stage) => evaluate(fx.engine, p.id, candidate.id, 'stage', { stage: stage.id });
const candidateRow = (home, id) => withStore(home, (db) => db.prepare('SELECT * FROM "candidates" WHERE "id" = ?').get(id));
const presenceOf = (home, id) => {
  const text = candidateRow(home, id).module_presence;
  return text === null || text === undefined ? null : JSON.parse(text);
};

// A later candidate of a T1 project: a fixture fix whose Builder runs `steps` and asks for the nomination.
async function laterCandidate(fx, p, steps) {
  const before = candidatesOfProject(fx.home, p.id).length;
  const fix = await addItem(fx, p.id, 'fix');
  fx.scripted.script(fix, [roleThat(steps, { nominate: true })]);
  await tickUntil(fx.engine, p.id, () => runsOf(fx.home, fix)[0]?.state === 'ended', { what: 'the fix to be built' });
  return tickUntil(fx.engine, p.id, () => candidatesOfProject(fx.home, p.id)[before], { max: 6, what: 'the later candidate' });
}

describe('M231 (a) a module override raises the scope tier, and never lowers it', () => {
  test('in a T1 project, the stage whose module is T3 requires the tier-floored checks, the T3 kinds and the T3 sign-offs; the stage whose module has no override requires none of them', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await scopeProject(fx, {
      defs: {
        acc1: def('acceptance', { criteria: ['R1.1'] }),
        acc2: def('acceptance', { criteria: ['R2.1'] }),
        smoke: def('smoke'),
        integ1: def('integration', { criteria: ['R1.1'], tier_floor: 'T2' }),
        integ2: def('integration', { criteria: ['R2.1'], tier_floor: 'T2' }),
        lint: def('security_lint', { tier_floor: 'T2' }),
      },
      index: [
        { key: 'R1', criteria: ['R1.1'] },
        { key: 'R2', criteria: ['R2.1'] },
      ],
      modules: [
        { name: 'billing', paths: ['billing/'], tier_override: 'T3' },
        { name: 'web', paths: ['web/'] },
      ],
      stages: [
        { number: 1, goal: 'R1, in billing', implements: ['R1'], modules: ['billing'] },
        { number: 2, goal: 'R2, in web', implements: ['R2'], modules: ['web'] },
      ],
    });
    await buildStages(fx, p, { steps: [[step.write('billing/pay.js', 'export const pay = () => 0;\n')], [step.write('web/index.js', 'export const page = 1;\n')]] });
    const c = await nextCandidate(fx, p.id);
    await passKeys(fx, p.id, c.id, ['acc1', 'acc2', 'smoke', 'integ1', 'integ2', 'lint']);
    const ids = checkIds(fx.home, p.id);
    const [s1, s2] = p.stages;

    const raised = await stageGateOf(fx, p, c, s1);
    const scope = scopeRead(fx.home, raised);
    assert.ok(scope.required.includes(ids.integ1) && scope.required.includes(ids.lint), 'checks: the T2-floored integ1 and lint are required in the T3 scope of a T1 project');
    assert.deepEqual(kindSubjects(raised), ['kind:failure_recovery', 'kind:property'], `kinds: the T3 inventory is required, and its two T3 kinds are missing (subjects: ${JSON.stringify(incomplete(raised))})`);
    assert.ok(reasonCodes(raised).includes('SIGNOFF_MISSING'), `sign-offs: a T3 scope needs sign-offs, which a T1 scope does not (reasons: ${JSON.stringify(raised.reasons)})`);
    assert.ok(signoffListed(scope, 'candidate') && signoffListed(scope, 'module', 'billing') && signoffListed(scope, 'security'), `the required sign-offs are T3's: candidate, the module billing, security (${JSON.stringify(scope.signoffs)})`);
    await review(fx, p.id, c.id, { signoffs: [{ scope: 'candidate' }] });
    assert.ok(reasonCodes(await stageGateOf(fx, p, c, s1)).includes('SIGNOFF_MISSING'), "the candidate's sign-off alone (T2's) is not enough");
    await review(fx, p.id, c.id, { signoffs: [{ scope: 'module', module: 'billing' }, { scope: 'security' }] });
    assert.ok(!reasonCodes(await stageGateOf(fx, p, c, s1)).includes('SIGNOFF_MISSING'), 'with the module and security sign-offs recorded, no sign-off is missing');

    const plain = await stageGateOf(fx, p, c, s2);
    const plainScope = scopeRead(fx.home, plain);
    assert.ok(!plainScope.required.includes(ids.integ2) && !plainScope.required.includes(ids.lint), 'the control: in the T1 scope of the stage whose module has no override, the T2-floored checks are not required');
    assert.deepEqual(kindSubjects(plain), [], 'and only the T1 kinds are asked');
    assert.equal(plain.outcome, 'satisfied', `and it is satisfied, needing no sign-off (reasons: ${JSON.stringify(plain.reasons)})`);
  });

  test('in a T2 project, a stage module overridden T1 lowers nothing: the T2-floored checks and the T2 sign-off are still required', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await scopeProject(fx, {
      tier: 'T2',
      defs: { ...inventoryDefs('T1', ['R1.1']), integ: def('integration', { criteria: ['R1.1'], tier_floor: 'T2' }), lint: def('security_lint', { tier_floor: 'T2' }) },
      index: [{ key: 'R1', criteria: ['R1.1'] }],
      modules: [{ name: 'docs', paths: ['docs/'], tier_override: 'T1' }],
      stages: [{ number: 1, goal: 'R1, in docs', implements: ['R1'], modules: ['docs'] }],
    });
    await buildStages(fx, p, { steps: [[step.write('docs/guide.md', '# guide\n')]] });
    const [c] = await tickUntil(fx.engine, p.id, () => {
      const found = candidatesOfProject(fx.home, p.id);
      return found.length > 0 ? found : undefined;
    }, { max: 6, what: 'the T2 candidate' });
    await passKeys(fx, p.id, c.id, ['acc', 'smoke', 'integ', 'lint']);
    const evaluation = await stageGateOf(fx, p, c, p.stages[0]);
    const scope = scopeRead(fx.home, evaluation);
    const ids = checkIds(fx.home, p.id);
    assert.ok(scope.required.includes(ids.integ) && scope.required.includes(ids.lint), 'the T2-floored checks are required');
    assert.deepEqual(reasonCodes(evaluation), ['SIGNOFF_MISSING'], `the scope is complete at T2 and the T2 sign-off is required (reasons: ${JSON.stringify(evaluation.reasons)})`);
  });
});

describe('M231 (b) which modules a scope takes', () => {
  test('a stage scope takes its stage\'s modules; a deployment scope every module present at the revision, recorded on the candidate; a module deleted at a later revision drops out; an unreadable presence fact leaves the scope incomplete', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await scopeProject(fx, {
      defs: {
        acc: def('acceptance', { criteria: ['R1.1'] }),
        smoke: def('smoke'),
        fauth: def('sensitivity_floor', { areas: ['authentication'] }),
        fpay: def('sensitivity_floor', { areas: ['payments_financial_data'] }),
      },
      files: { 'auth/login.js': 'export const login = () => true;\n', 'billing/pay.js': 'export const pay = () => 0;\n' },
      index: [{ key: 'R1', criteria: ['R1.1'] }],
      modules: [
        { name: 'auth', paths: ['auth/'], sensitive_areas: ['authentication'] },
        { name: 'billing', paths: ['billing/'], sensitive_areas: ['payments_financial_data'] },
        { name: 'web', paths: ['web/'] },
      ],
      stages: [{ number: 1, goal: 'R1, in auth', implements: ['R1'], modules: ['auth'] }],
    });
    await buildStages(fx, p, { nominate: [true] });
    const [c1] = candidatesOfProject(fx.home, p.id);
    const ids = checkIds(fx.home, p.id);
    const mod = moduleIds(fx.home, p.id);

    const stage = scopeRead(fx.home, await stageGateOf(fx, p, c1, p.stages[0]));
    assert.deepEqual([...stage.categories].sort(), ['authentication'], "the stage scope's modules are its stage's: auth, not billing, though billing is present");
    assert.ok(stage.required.includes(ids.fauth) && !stage.required.includes(ids.fpay), 'its floor is auth\'s and not billing\'s');

    const target = await alphaTarget(fx, { project: p, candidate: c1 });
    const deploy = scopeRead(fx.home, await target.evaluate());
    assert.deepEqual([...deploy.categories].sort(), ['authentication', 'payments_financial_data'], 'the deployment scope takes every module present at the revision (Q7 (a)): auth and billing; web has no file');
    assert.ok(deploy.required.includes(ids.fauth) && deploy.required.includes(ids.fpay), 'both floors are required');
    const present1 = presenceOf(fx.home, c1.id);
    assert.ok(present1 && Array.isArray(present1.modules), `the presence fact is recorded on the candidate (module_presence: ${JSON.stringify(present1)})`);
    assert.deepEqual([...present1.modules].sort(), [mod.auth, mod.billing].sort(), 'it names auth and billing, the modules with a file at the revision');

    const c2 = await laterCandidate(fx, p, [step.delete('billing/pay.js')]);
    const later = scopeRead(fx.home, await (await alphaTarget(fx, { project: p, candidate: c2 }, c2, { environment: target.environment })).evaluate());
    assert.deepEqual([...later.categories].sort(), ['authentication'], 'billing, deleted at the later revision, drops out of the deployment scope');
    assert.ok(!later.required.includes(ids.fpay), 'and so does its floor');
    assert.deepEqual(presenceOf(fx.home, c2.id)?.modules, [mod.auth], 'the later candidate records auth alone as present');

    // The presence read fails (SEAM.md §224's fault) for a candidate nominated while it is armed.
    await armFault(fx.engine, { point: 'module_presence_read', project: p.id, times: 100 });
    const c3 = await laterCandidate(fx, p, [step.write('src/three.js', 'export const three = 3;\n')]);
    const third = await alphaTarget(fx, { project: p, candidate: c3 }, c3, { environment: target.environment });
    const unread = await third.evaluate();
    assert.equal(unread.outcome, 'not_satisfied');
    assert.ok(incomplete(unread).includes('module_presence'), `an unread presence fact is ACCEPTANCE_SCOPE_INCOMPLETE naming it (reasons: ${JSON.stringify(unread.reasons)})`);
    assert.equal(presenceOf(fx.home, c3.id), null, 'no presence is recorded for the candidate: an unread fact is not an empty one');
    await clearFaults(fx.engine);
    const read = await third.evaluate();
    assert.ok(!incomplete(read).includes('module_presence'), `once the fact can be read it is read, and the scope no longer names it (reasons: ${JSON.stringify(read.reasons)})`);
    assert.deepEqual([...(presenceOf(fx.home, c3.id)?.modules ?? [])].sort(), [mod.auth], 'and it is recorded');
  });
});

describe('M231 (c) the scope tier sets the cadence', () => {
  test('in a T1 project with no Builder asking, the integration of a stage whose module is T2 nominates by engine cadence, the stage whose module has no override does not, and the integration of a fix naming a finding, its revision holding the T2 module, nominates by engine cadence; under E104 the same fix in a project with no T2 module is nominated by the engine too, while its stages still are not', async (t) => {
    const fx = await scriptedEngine(t);
    const shape = (override) => ({
      defs: { acc: def('acceptance', { criteria: ['R1.1', 'R2.1'] }), smoke: def('smoke') },
      index: [
        { key: 'R1', criteria: ['R1.1'] },
        { key: 'R2', criteria: ['R2.1'] },
      ],
      modules: [{ name: 'billing', paths: ['billing/'], ...(override ? { tier_override: 'T2' } : {}) }, { name: 'web', paths: ['web/'] }],
      stages: [
        { number: 1, goal: 'R1, in billing', implements: ['R1'], modules: ['billing'] },
        { number: 2, goal: 'R2, in web', implements: ['R2'], modules: ['web'] },
      ],
    });
    const steps = [[step.write('billing/pay.js', 'export const pay = () => 0;\n')], [step.write('web/index.js', 'export const page = 1;\n')]];

    // The T2 module: the stage nominates by cadence.
    const p = await scopeProject(fx, shape(true));
    await buildStages(fx, p, { steps });
    const stages = withStore(fx.home, (db) => db.prepare('SELECT * FROM "stages" WHERE "project" = ? ORDER BY "number"').all(p.id));
    const stage1 = stages.find((s) => s.number === 1);
    const [c1, extra] = await tickUntil(fx.engine, p.id, () => {
      const found = candidatesOfProject(fx.home, p.id);
      return found.length > 0 ? found : undefined;
    }, { max: 6, what: 'the cadence nomination of the stage whose module is T2' });
    assert.equal(extra, undefined, 'one candidate: the stage whose module has no override, integrated with no request, nominated nothing');
    assert.deepEqual([c1.nominated_by, c1.revision], ['engine_cadence', stage1.integrated_revision], 'the stage whose module is T2 was nominated by engine cadence, at its integration');

    // A finding on it, and fix work naming the finding, whose Builder asks for nothing.
    const fixCandidate = async (q, candidate) => {
      const [found] = await raiseFindings(fx, q.id, candidate.id, [{ category: 'defect', severity: 'medium', message: 'the total omits the fee' }], { kind: 'verification' });
      const fix = await addWork(fx.engine, q.id, 'fix', { subject: { finding: found.id } });
      fx.scripted.script(fix, [roleThat([step.write('src/fee.js', 'export const fee = 1;\n')])]);
      const run = await tickUntil(fx.engine, q.id, () => (runsOf(fx.home, fix)[0]?.state === 'ended' ? runsOf(fx.home, fix)[0] : undefined), { what: 'the fix to be built' });
      assert.deepEqual([run.outcome, run.reason_class], ['completed', 'none'], `the fixture is live: the fix was accepted (${run.reason_text})`);
      return tickUntil(fx.engine, q.id, () => candidatesOfProject(fx.home, q.id).find((x) => x.id !== candidate.id) ?? false, { max: 4, what: 'a nomination of the fix' }).catch(() => undefined);
    };
    const c2 = await fixCandidate(p, c1);
    assert.equal(c2?.nominated_by, 'engine_cadence', `the fix's integration, its revision holding the T2 module billing, nominated by engine cadence (Q10 (a)) (candidate: ${JSON.stringify(c2 ?? null)})`);

    // The control: the same shape with no override. Its stages nominate nothing; a fix-free candidate is made on request. The same fix,
    // its Builder asking for nothing: before E104 it nominated nothing at T1 (the straddle; COVERAGE.md, "M3 slice 22: E104"); now the
    // integration of a fix that names a finding is a nomination point at every tier (E104, Sean 2026-10-08), by engine cadence as at T2.
    const q = await scopeProject(fx, shape(false));
    await buildStages(fx, q, { steps });
    assert.deepEqual(candidatesOfProject(fx.home, q.id), [], 'the control: in a T1 project with no T2 module, no stage integration nominates without a request');
    const d1 = await nextCandidate(fx, q.id);
    const d2 = await fixCandidate(q, d1);
    assert.equal(d2?.nominated_by, 'engine_cadence', `E104: the fix of a finding is nominated at T1 with no request, by engine cadence (candidate: ${JSON.stringify(d2 ?? null)})`);
  });
});
