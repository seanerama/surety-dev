// E153 item 1 (Sean, 2026-10-16; D6 §4.5 amended; SEAM §471): a
// specification change approved after every phase of the roadmap is complete.
// Kernel lane: the scripted backend, the scripted check boundary (§190), the
// scripted deployment adapter (§247). Nothing here starts a process but the
// test's own engine and its scripted roles.
//
// The project is the reference journey's one-phase form (R1 and R2, the
// roadmap's phase 1 alone; `journeyProject` with `onePhase`), carried by its
// own path to phase 1's completion, so the build is complete. The change
// rewords R1.1 so that `sum` must accept numeric strings, which the built
// `src/sum.mjs` (`a + b`) does not meet: the Verifier's correction rewrites
// the two checks that cover R1.1 (accept-r1 and integration-lib), and the
// harness records those checks failing on every candidate that existed before
// the change (the kernel lane scripts exits; the built code is what makes the
// failure honest). The delivery phase the Architect's replan proposes moves
// R1 into a new phase 2 (a roadmap revision, D6 §4.7, §5.3 item 3) with one
// stage that makes `sum` coerce, and phase 2's authoring adds a phase-only
// check for R1.1, as the reference project's phase 2 does.

import assert from 'node:assert/strict';

import { definitionText } from '../checks/fixtures.mjs';
import { roleThat } from '../gitruns.mjs';
import { script, step } from '../scripted.mjs';
import { withStore } from '../store.mjs';
import { ADR_KEY, REQUIREMENTS, ROADMAP_JSON, T2_KINDS, specText } from './reference.mjs';
import { candidatesOfProject, phasePlansOf, planOfPhase, stagesOfPlan, workOf } from './drive.mjs';

export const SPEC_PATH = '.surety/spec/spec.md';
const ONE_PHASE = REQUIREMENTS.slice(0, 2);
const v2 = (requirements, change) => specText({ version: 2, requirements, changeLog: [{ version: 2, date: '2026-10-16', change, by: 'Sean' }] });
const withR1 = (text) => ONE_PHASE.map((r) => (r.key === 'R1' ? { ...r, criteria: [{ id: 'R1.1', text }] } : r));

// (a): R1.1 now asks for numeric strings, which `a + b` does not meet.
export const R1_STRINGS = 'Given the numeric strings "2" and "3", when `sum("2", "3")` of `src/sum.mjs` is called, then it returns the number 5.';
export const SPEC_V2_STRINGS = v2(withR1(R1_STRINGS), 'R1.1: sum accepts numeric strings');
// (e), discharged by the correction: R1.1 names the type, which the built code meets.
export const R1_TYPED = 'Given the numbers 2 and 3, when `sum(2, 3)` of `src/sum.mjs` is called, then it returns the number 5, not a string.';
export const SPEC_V2_TYPED = v2(withR1(R1_TYPED), 'R1.1 names the type');
// (e), text only: R2's criteria reordered, every text unchanged (no impact, D6-C03).
export const SPEC_V2_REORDERED = v2(
  ONE_PHASE.map((r) => (r.key === 'R2' ? { ...r, criteria: [...r.criteria].reverse() } : r)),
  'R2\'s criteria reordered',
);

export const CORRECTED_KEYS = Object.freeze(['accept-r1', 'integration-lib']);
const SUM_TEST = '.surety/checks/tests/sum.test.mjs';
const INTEGRATION_LIB_TEST = '.surety/checks/tests/integration-lib.test.mjs';
// The correction for R1_STRINGS: both checks of R1.1 read the strings.
export const SUM_STRINGS_TEST = `import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sum } from '../../../src/sum.mjs';

test('R1.1: sum("2", "3") returns the number 5', () => {
  assert.equal(sum('2', '3'), 5);
  assert.equal(sum(2, 3), 5);
});
`;
export const INTEGRATION_LIB_STRINGS_TEST = `import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

test('integration, R1.1: src/sum.mjs loads in a fresh process and sum("2", "3") is the number 5 there', () => {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', "import { sum } from './src/sum.mjs'; console.log(JSON.stringify({ five: sum('2', '3'), again: sum(2, 3) }));"], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.deepEqual(JSON.parse(out), { five: 5, again: 5 });
});
`;
// The correction for R1_TYPED: the same checks, reading the type.
export const SUM_TYPED_TEST = `import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sum } from '../../../src/sum.mjs';

test('R1.1: sum(2, 3) returns the number 5', () => {
  assert.strictEqual(sum(2, 3), 5);
});
`;
export const INTEGRATION_LIB_TYPED_TEST = `import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

test('integration, R1.1: src/sum.mjs loads in a fresh process and sum(2, 3) is the number 5 there', () => {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', "import { sum } from './src/sum.mjs'; console.log(JSON.stringify({ five: sum(2, 3), type: typeof sum(2, 3) }));"], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.deepEqual(JSON.parse(out), { five: 5, type: 'number' });
});
`;

// The Spec Writer's one-shot writing `text` (spec_change work).
export const changeScriptOf = (text, changes) => roleThat([step.write(SPEC_PATH, text)], { summary: 'the change', changes });
// The Verifier's correction (check_correction work): both checks of R1.1 rewritten.
export const correctionOf = (sumTest, integrationTest, rationale) =>
  roleThat([step.write(SUM_TEST, sumTest), step.write(INTEGRATION_LIB_TEST, integrationTest)], { proposal: { rationale, requested_change_kind: 'tightening' } });

// ---- the delivery phase (the Architect's replan; D6 §5.6, §5.3, §4.7) ----------------------------

export const SUM_MJS_STRINGS = 'export const sum = (a, b) => Number(a) + Number(b);\n';
export const DELIVERY_STAGE = Object.freeze({
  number: 3,
  goal: 'sum accepts numeric strings',
  tasks: ['make sum(a, b) in src/sum.mjs coerce numeric strings to numbers'],
  modules: ['lib'],
  implements: ['R1'],
  adrs: [ADR_KEY],
  depends_on: [],
  validation: { criteria: ['R1.1'], kinds: T2_KINDS, sensitive_areas: [] },
  integration_obligations: [],
});
const PHASE_1 = ROADMAP_JSON.phases[0];
// `depends_on` empty: a delivery phase depending on phase 1 is refused today
// PLAN_DEPENDENCY_INCOMPLETE, phase 1's candidate now failing the corrected
// checks the delivery phase exists to fix (SEAM §471; a question for Sean).
export const DELIVERY_PHASE = Object.freeze({ number: 2, goal: 'deliver the approved change to R1.1', modules: ['lib'], requirement_ids: ['R1'], depends_on: [] });
// Roadmap version 2: R1 moved from the completed phase 1 into the delivery phase.
export const ROADMAP_V2 = Object.freeze({
  ...ROADMAP_JSON,
  version: 2,
  phases: [{ ...PHASE_1, requirement_ids: ['R2'] }, DELIVERY_PHASE],
  moved_requirements: [{ key: 'R1', from: 1, to: 2 }],
});
const text = (v) => `${JSON.stringify(v, null, 2)}\n`;
const ROADMAP_MD_V2 = '# Roadmap\n\n1. Sum two numbers through the service (R2).\n2. Deliver the approved change: sum accepts numeric strings (R1).\n';

// The Architect's replan proposing the delivery phase: the roadmap revision
// and phase 2's plan, prepared against spec version 2, architecture 1,
// roadmap 1 and the run's head. `stages` and `roadmap` vary it ((d)).
export function deliveryReplan({ stages = [DELIVERY_STAGE], roadmap = ROADMAP_V2, spec_version = 2 } = {}) {
  const plan = { phase: 2, prepared_against: { spec_version, architecture_version: 1, roadmap_version: 2, revision: '__HEAD__' }, stages, conformance: 'within_baseline' };
  return {
    steps: [
      step.write('.surety/roadmap/roadmap.json', text(roadmap)),
      step.write('.surety/roadmap/roadmap.md', ROADMAP_MD_V2),
      { write: { path: '.surety/phases/phase-2.json', content: text(plan), substitute_head: true } },
      step.write('.surety/phases/phase-2.md', `# Phase 2\n\n${stages.map((s) => `- Stage ${s.number}: ${s.goal}`).join('\n')}\n`),
      step.result({ status: 'completed', summary: 'the delivery phase planned', plan: 'phase-2', roadmap_revision: true, conformance: 'within_baseline', adrs_changed: [] }),
    ],
  };
}
// A replan refused by the plan check: the stage implements R1 while the
// roadmap leaves R1 in the completed phase 1 (PLAN_MODULE_OUTSIDE_PHASE) and
// the delivery phase assigns nothing.
export const UNBUILDABLE_ROADMAP = Object.freeze({ ...ROADMAP_JSON, version: 2, phases: [PHASE_1, { ...DELIVERY_PHASE, requirement_ids: [] }] });
export const unbuildableReplan = () => deliveryReplan({ roadmap: UNBUILDABLE_ROADMAP });

// Phase 2's check authoring: a phase-only regression check of R1.1 (as the
// reference project's phase 2 adds one), a tightening.
const PHASE_DELIVERY_TEST = '.surety/checks/tests/phase-delivery.test.mjs';
export const DELIVERY_AUTHORING = roleThat(
  [
    step.write(
      '.surety/checks/defs/phase-delivery.json',
      definitionText('phase-delivery', { inputs: ['.surety/checks/wrapper.mjs', PHASE_DELIVERY_TEST], kind: 'acceptance', command: ['node', '.surety/checks/wrapper.mjs', PHASE_DELIVERY_TEST], timeout_s: 120, gate_kinds: ['phase'], covers: { criteria: ['R1.1'] } }),
    ),
    step.write(PHASE_DELIVERY_TEST, SUM_STRINGS_TEST.replace("test('R1.1:", "test('phase, R1.1:")),
  ],
  { proposal: { rationale: 'The delivery phase\'s regression of R1.1 on the phase candidate.', requested_change_kind: 'tightening' } },
);

// The scripts by kind after phase 1's completion: the change's Spec Writer,
// the correction, the delivery replan, phase 2's authoring and Builder.
// `replan` may be any script (an array: one per launch).
export function scriptsAfterPhaseOne(fx, { spec, changes, correction, replan = deliveryReplan() }) {
  fx.scripted.kindScript('spec_change', changeScriptOf(spec, changes));
  fx.scripted.kindScript('check_correction', correction);
  fx.scripted.kindScript('replan', replan);
  fx.scripted.kindScript('check_authoring', DELIVERY_AUTHORING);
  fx.scripted.kindScript('stage_build', roleThat([step.write('src/sum.mjs', SUM_MJS_STRINGS)]));
  fx.scripted.defaultScript(script.complete());
}

// The exits the kernel lane's boundary records (§190): a corrected check of
// R1.1 fails on every candidate that existed before the change when the
// built code does not meet the change (`failsBefore`), and every other
// execution passes.
export const exitsFor = (oldCandidates, { failsBefore }) => (x) => (failsBefore && CORRECTED_KEYS.includes(x.key) && oldCandidates.has(x.candidate) ? 1 : 0);

// ---- readers ---------------------------------------------------------------------------------------

const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const json = (v) => (v === null || v === undefined ? v : typeof v === 'string' ? JSON.parse(v) : v);

// The replan items the change registered: trigger_source spec_change, id the request.
export const changeReplans = (home, project, request) => workOf(home, project, 'replan').filter((w) => w.trigger_source === 'spec_change' && w.trigger_id === request);
export const allReplans = (home, project) => workOf(home, project, 'replan');

// Phase 1 as history: its plan row, its stages, its phase sign-offs and
// evaluations, its completion events. Compared before and after.
export function phaseOneHistory(home, project) {
  const plan = planOfPhase(home, project, 1).find((x) => x.completed_at);
  assert.ok(plan, 'the fixture is live: phase 1 is complete');
  return {
    plan: { id: plan.id, generation: plan.generation, status: plan.status, completed_at: plan.completed_at, completion_binding: plan.completion_binding, published_at: plan.published_at, approved_by: plan.approved_by },
    stages: stagesOfPlan(home, plan.id).map((s) => ({ id: s.id, number: s.number, status: s.status, integrated_revision: s.integrated_revision ?? null, implements: s.implements })),
    // The phase sign-offs on phase 1's bound candidate.
    signoffs: rows(home, `SELECT s."id", s."scope", s."candidate", s."binding" FROM "signoffs" s WHERE s."candidate" = ? AND s."scope" = 'phase' ORDER BY s.rowid`, plan.completion_binding?.candidate ?? '').map((s) => ({ ...s, binding: json(s.binding) })),
    phaseEvaluations: rows(home, `SELECT "id", "candidate", "outcome" FROM "gate_evaluations" WHERE "project" = ? AND "gate_kind" = 'phase' AND "candidate" = ? ORDER BY rowid`, project, plan.completion_binding?.candidate ?? '').map((e) => ({ ...e })),
    completions: rows(home, `SELECT "seq" FROM "events" WHERE "type" = 'baseline.phase_complete' AND json_extract("subject", '$.project') = ? AND json_extract("subject", '$.phase_plan') = ?`, project, plan.id).map((e) => e.seq),
  };
}

// Every build artefact beyond phase 1: plans of other phases, stage_build work for other plans.
export function beyondPhaseOne(home, project) {
  const plans = phasePlansOf(home, project);
  const one = new Set(plans.filter((x) => x.phase_number === 1).map((x) => x.id));
  const stages = rows(home, 'SELECT "id", "phase_plan" FROM "stages" WHERE "project" = ?', project).filter((s) => !one.has(s.phase_plan));
  return {
    plans: plans.filter((x) => x.phase_number !== 1).map((x) => [x.phase_number, x.status]),
    stages: stages.map((s) => s.id),
    roadmaps: rows(home, 'SELECT "version" FROM "roadmap_revisions" WHERE "project" = ? ORDER BY "version"', project).map((r) => r.version),
  };
}

export const latestCandidate = (home, project) => candidatesOfProject(home, project).at(-1) ?? null;
