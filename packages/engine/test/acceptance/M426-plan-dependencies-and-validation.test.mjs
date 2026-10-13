// M426, plan dependencies and validation per scope, at the first Architect
// close (slice 35; kernel lane). M5 plan §3.5 M426 (a), (c) to (f); D6-P03,
// D6-P04; D6 §5.2, §5.3 items 3 and 4; B04; the driver's rulings of
// 2026-10-13; SEAM.md §§406, 407, 409.
//
// (a) a stage cycle; a stage touching a module outside the roadmap's phase;
//     a requirement assigned to the phase that no stage implements; a phase
//     whose prerequisite phase is incomplete: each refused with its code;
// (c) a criterion, an area, a tier kind missing from the applicable stage's
//     validation while present in another stage's: refused naming that stage
//     (`stage <n>:<subject>`); a module's `tier_override` T3 requires the
//     T3 kinds of the stage touching it and of no other;
// (d) the planned obligations recorded per stage and for the phase (criteria,
//     effective tier, kinds, areas), no `CheckDefinition` and no result from
//     them; the check counted by D3 §4.3's primitive (the lexical case);
// (e) a scoped-mode `descriptive_unverified` requirement assigned to the
//     phase: excluded from the obligations and from the unplanned clause;
// (f) a plan outside `phase_size`: `uncertain` naming `phase_size`, never
//     refused.
// (b), (f) on the replan path and (a)'s regression variant are in
// `M426-replans-against-the-roadmap.test.mjs`; (g)'s shortfall on the phase
// gate is M428 (e).

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { REPO_ROOT } from './harness/engine.mjs';
import { consume, decision } from './harness/decisions.mjs';
import { activePlan, checkRows, ownerPolicy, recordOf, resultsOf, waitPublished } from './harness/journey/drive.mjs';
import { codesOf, firstClose, phaseOf, specReady, stagesWith, subjectsOf } from './harness/journey/plan35.mjs';
import { MODULES_JSON, MODULES_JSON_SERVICE_SECRETS, ROADMAP_JSON, SPEC_SERVICE_SECRETS, STAGES, T2_KINDS } from './harness/journey/reference.mjs';
import { recordFile } from './harness/records.mjs';
import { adoptProject, chooseMode, confirmAndApprove, retrofitArchitectSession, retrofitEngine, retrofitSpecSession } from './harness/retrofit/drive.mjs';
import { REQUIREMENTS as RETROFIT_REQUIREMENTS, conformanceStage, modulesJsonWith, retrofitSpecText, roadmapJson } from './harness/retrofit/products.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';
import { tokenize } from './harness/source-lint.mjs';
import { withStore } from './harness/store.mjs';

const T3_KINDS = [...T2_KINDS, 'property', 'failure_recovery'];
const ROADMAP = '.surety/roadmap/roadmap.json';
const MODULES = '.surety/architecture/modules.json';
const refusedWith = (attempt, code, what) => {
  assert.equal(attempt.res.status, 422, `${what}: the close is refused (→ ${attempt.res.status} ${attempt.res.text})`);
  assert.ok(codesOf(attempt.check).includes(code), `${what}: ${code} (${JSON.stringify(attempt.check?.reasons)})`);
};

// The planned obligations of the active plan: the record's `planned_obligations`,
// [{scope: {kind, number}, tier, criteria, kinds, sensitive_areas}] (SEAM.md §409 †).
function plannedObligations(home, project) {
  const plan = activePlan(home, project);
  assert.ok(plan?.planned_obligations, 'the published plan names its planned obligations');
  const row = recordOf(home, plan.planned_obligations);
  assert.ok(row, 'the planned obligations are a record');
  const value = JSON.parse(readFileSync(recordFile(home, row), 'utf8'));
  return Array.isArray(value) ? value : (value.planned_obligations ?? value.obligations);
}
const scopeOf = (list, kind, number) => list.find((o) => o.scope?.kind === kind && (number === undefined || o.scope?.number === number));

describe('M426 plan dependencies and validation per scope', () => {
  test('(a) a cycle, a module outside the phase, an assigned requirement no stage implements, an incomplete prerequisite phase: each refused with its code', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await specReady(fx);
    const cycle = await firstClose(fx, p, { stages: stagesWith(1, { 1: { depends_on: [2] } }) });
    refusedWith(cycle, 'PLAN_CYCLE', 'stages 1 and 2 depending on each other');
    assert.ok(subjectsOf(cycle.check, 'PLAN_CYCLE').some((s) => /1/.test(s) && /2/.test(s)), `the cycle names both stages (${JSON.stringify(cycle.check.reasons)})`);
    const outside = await firstClose(fx, p, { over: { [ROADMAP]: { ...ROADMAP_JSON, phases: [{ ...phaseOf(1), modules: ['lib'] }, phaseOf(2)] } } });
    refusedWith(outside, 'PLAN_MODULE_OUTSIDE_PHASE', 'stage 2 touching service, which phase 1 does not list');
    assert.ok(subjectsOf(outside.check, 'PLAN_MODULE_OUTSIDE_PHASE').includes('stage 2:service'), `naming stage 2:service (${JSON.stringify(outside.check.reasons)})`);
    const unplanned = await firstClose(fx, p, { stages: [STAGES[1][0]] });
    refusedWith(unplanned, 'PLAN_REQUIREMENT_UNPLANNED', 'R2 assigned to phase 1 and implemented by no stage');
    assert.ok(subjectsOf(unplanned.check, 'PLAN_REQUIREMENT_UNPLANNED').includes('R2'), `naming R2 (${JSON.stringify(unplanned.check.reasons)})`);
    const prerequisite = await firstClose(fx, p, { over: { [ROADMAP]: { ...ROADMAP_JSON, phases: [{ ...phaseOf(1), depends_on: [2] }, { ...phaseOf(2), depends_on: [] }] } } });
    refusedWith(prerequisite, 'PLAN_DEPENDENCY_INCOMPLETE', 'phase 1 depending on phase 2, not complete');
    assert.ok(subjectsOf(prerequisite.check, 'PLAN_DEPENDENCY_INCOMPLETE').includes('phase 2'), `naming phase 2 (${JSON.stringify(prerequisite.check.reasons)})`);
  });

  test('(c) a criterion and a kind missing from the applicable stage while present in another stage\'s: refused naming that stage; the union of the arrays satisfies nothing', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await specReady(fx);
    // R1.1 validated by stage 2 (which does not implement R1), not by stage 1.
    const criterion = await firstClose(fx, p, { stages: stagesWith(1, { 1: { validation: { criteria: [] } }, 2: { validation: { criteria: ['R1.1', 'R2.1', 'R2.2'] } } }) });
    refusedWith(criterion, 'PLAN_CRITERION_UNVALIDATED', 'R1.1 in stage 2\'s validation only');
    assert.ok(subjectsOf(criterion.check, 'PLAN_CRITERION_UNVALIDATED').includes('stage 1:R1.1'), `naming stage 1:R1.1 (the driver's form) (${JSON.stringify(criterion.check.reasons)})`);
    // integration in stage 1's kinds only.
    const kind = await firstClose(fx, p, { stages: stagesWith(1, { 2: { validation: { kinds: T2_KINDS.filter((k) => k !== 'integration') } } }) });
    refusedWith(kind, 'PLAN_KIND_MISSING', 'integration in stage 1\'s kinds only');
    assert.deepEqual(subjectsOf(kind.check, 'PLAN_KIND_MISSING'), ['stage 2:integration'], `naming stage 2:integration and nothing of stage 1 (${JSON.stringify(kind.check.reasons)})`);
  });

  test('(c) an area missing from the stage touching its module while present in another stage\'s: PLAN_AREA_UNVALIDATED naming that stage', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await specReady(fx, { spec: SPEC_SERVICE_SECRETS });
    const floor = [...T2_KINDS, 'sensitivity_floor'];
    const misplaced = await firstClose(fx, p, {
      over: { [MODULES]: MODULES_JSON_SERVICE_SECRETS },
      stages: stagesWith(1, { 1: { validation: { sensitive_areas: ['secrets_credentials'], kinds: floor } }, 2: { validation: { sensitive_areas: [] } } }),
    });
    refusedWith(misplaced, 'PLAN_AREA_UNVALIDATED', 'secrets_credentials validated by stage 1, which does not touch service');
    assert.ok(subjectsOf(misplaced.check, 'PLAN_AREA_UNVALIDATED').includes('stage 2:secrets_credentials'), `naming stage 2:secrets_credentials (${JSON.stringify(misplaced.check.reasons)})`);
    // The control: the area validated where it sits.
    const placed = await firstClose(fx, p, { over: { [MODULES]: MODULES_JSON_SERVICE_SECRETS }, stages: stagesWith(1, { 2: { validation: { sensitive_areas: ['secrets_credentials'], kinds: floor } } }) });
    assert.ok(!codesOf(placed.check).includes('PLAN_AREA_UNVALIDATED'), `validated by stage 2, the area is satisfied (${JSON.stringify(placed.check?.reasons)})`);
  });

  test('(c) a module with tier_override T3: its stage owes the T3 kinds and no other stage does; (d) the planned obligations per stage and phase, no check definition and no result from them', async (t) => {
    const fx = await scriptedEngine(t);
    // The publication makes check_authoring eligible; its run ends at once and proposes nothing.
    fx.scripted.defaultScript(script.complete());
    const p = await specReady(fx);
    const raised = { [MODULES]: { ...MODULES_JSON, modules: MODULES_JSON.modules.map((m) => (m.name === 'service' ? { ...m, tier_override: 'T3' } : m)) } };
    const t2 = await firstClose(fx, p, { over: raised });
    refusedWith(t2, 'PLAN_KIND_MISSING', 'stage 2 at T2\'s kinds while service is T3');
    assert.deepEqual(subjectsOf(t2.check, 'PLAN_KIND_MISSING').sort(), ['stage 2:failure_recovery', 'stage 2:property'], `the raised tier's kinds, for stage 2 only (${JSON.stringify(t2.check.reasons)})`);
    const t3 = await firstClose(fx, p, { over: raised, stages: stagesWith(1, { 2: { validation: { kinds: T3_KINDS } } }) });
    assert.equal(t3.res.status, 200, `with the T3 kinds on stage 2 the close is accepted (→ ${t3.res.status} ${t3.res.text})`);
    for (const d of Object.values(t3.decisions)) await consume(fx, p.id, decision(fx.home, d.id), 'approve');
    await waitPublished(fx, p.id);
    // (d) the obligations as recorded.
    const obligations = plannedObligations(fx.home, p.id);
    const s1 = scopeOf(obligations, 'stage', 1);
    const s2 = scopeOf(obligations, 'stage', 2);
    const phase = scopeOf(obligations, 'phase', 1);
    assert.ok(s1 && s2 && phase, `one obligation per stage and one for the phase (${JSON.stringify(obligations)})`);
    assert.deepEqual([s1.tier, [...s1.kinds].sort(), s1.criteria], ['T2', [...T2_KINDS].sort(), ['R1.1']], `stage 1: T2, its kinds, R1.1 (${JSON.stringify(s1)})`);
    assert.deepEqual([s2.tier, [...s2.kinds].sort(), [...s2.criteria].sort()], ['T3', [...T3_KINDS].sort(), ['R2.1', 'R2.2']], `stage 2: the effective tier T3 and its kinds (${JSON.stringify(s2)})`);
    assert.deepEqual([...phase.criteria].sort(), ['R1.1', 'R2.1', 'R2.2'], `the phase: every criterion of its requirements (${JSON.stringify(phase)})`);
    assert.ok(Array.isArray(s1.sensitive_areas) && Array.isArray(phase.sensitive_areas), 'areas recorded per scope');
    assert.deepEqual(checkRows(fx.home, p.id), [], 'no check definition from the planned obligations (D6 §5.3 item 4)');
    assert.deepEqual(resultsOf(fx.home, p.id), [], 'no result from them');
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "check_executions" x JOIN "candidates" k ON k."id" = x."candidate" WHERE k."project" = ?').get(p.id).n), 0, 'no execution');
  });

  test('(d) checkPlan\'s module uses the shared coverage primitive and defines no kind table of its own (lexical; the driver\'s ruling 6)', () => {
    const src = join(REPO_ROOT, 'packages', 'engine', 'src');
    const candidates = [];
    const walk = (dir, rel) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path, `${rel}${name}/`);
        else if (name.endsWith('.ts')) {
          const tokens = tokenize(readFileSync(path, 'utf8'), `${rel}${name}`);
          if (tokens.some((tk, i) => tk.kind === 'word' && tk.text === 'function' && tokens[i + 1]?.text === 'checkPlan')) candidates.push({ file: `${rel}${name}`, tokens });
        }
      }
    };
    walk(src, '');
    assert.equal(candidates.length, 1, `one module defines checkPlan (${candidates.map((c) => c.file).join(', ')})`);
    const { file, tokens } = candidates[0];
    const words = tokens.filter((tk) => tk.kind === 'word').map((tk) => tk.text);
    const calls = tokens.some((tk, i) => tk.kind === 'word' && tk.text === 'computeScope' && tokens[i + 1]?.kind === 'punct' && tokens[i + 1]?.text === '(');
    assert.ok(calls, `${file} counts the planned obligations with D3 §4.3's primitive, computeScope (D6 §5.3 item 4: one implementation)`);
    assert.ok(!words.includes('KIND_INVENTORY') || !tokens.some((tk, i) => tk.text === 'KIND_INVENTORY' && tokens[i + 1]?.text === '=' && ['const', 'let', 'var'].includes(tokens[i - 1]?.text)), `${file} declares no kind table`);
    const kindLiterals = tokens.filter((tk) => tk.kind === 'string' && ['security_lint', 'failure_recovery', 'property'].includes(tk.text)).map((tk) => `${tk.text}:${tk.line}`);
    assert.deepEqual(kindLiterals, [], `${file} spells out no tier's kinds`);
  });

  test('(e) a scoped-mode descriptive_unverified requirement assigned to the phase: no PLAN_REQUIREMENT_UNPLANNED, and not in the obligations', async (t) => {
    const fx = await retrofitEngine(t, { withoutR1: true });
    fx.scripted.defaultScript(script.complete());
    const p = await adoptProject(fx);
    await ownerPolicy(fx, p.id, { phase_size: { min: 1, max: 5 } });
    await chooseMode(fx, p.id, 'scoped');
    await retrofitSpecSession(fx, p.id, { spec: retrofitSpecText({ requirements: RETROFIT_REQUIREMENTS.map((r) => (r.key === 'R1' ? { ...r, descriptive: true } : r)) }) });
    await confirmAndApprove(fx, p.id, { R2: 'confirm', R3: 'confirm', R4: 'defect' });
    const arch = await retrofitArchitectSession(fx, p.id, p.repo, {
      roadmap: roadmapJson({ phase1: ['R1', 'R2', 'R3'], phase2: ['R4'] }),
      modules: modulesJsonWith({ lib: ['R1'], service: ['R2', 'R3', 'R4'] }),
      stages: [conformanceStage({ implements: ['R2', 'R3'], modules: ['service'] })],
    });
    assert.equal(arch.closeRes.status, 200, `the conformance plan without R1 is accepted: R1 is descriptive (→ ${arch.closeRes.status} ${arch.closeRes.text})`);
    assert.ok(arch.published, 'and published');
    const obligations = plannedObligations(fx.home, p.id);
    assert.ok(!JSON.stringify(obligations).includes('R1.'), `no obligation of R1 (${JSON.stringify(obligations)})`);
  });

  test('(f) a plan of two stages under the default phase_size {3, 5}: uncertain naming phase_size, passed, never refused', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await specReady(fx, { policy: { phase_size: { min: 3, max: 5 } } });
    const attempt = await firstClose(fx, p);
    assert.equal(attempt.res.status, 200, `the close is accepted (→ ${attempt.res.status} ${attempt.res.text})`);
    assert.deepEqual([attempt.check.outcome, attempt.check.reasons], ['passed', []], 'passed with no reason');
    assert.ok((attempt.check.uncertain ?? []).some((u) => String(u).startsWith('phase_size')), `uncertain names phase_size (SEAM.md §409) (${JSON.stringify(attempt.check.uncertain)})`);
  });
});

