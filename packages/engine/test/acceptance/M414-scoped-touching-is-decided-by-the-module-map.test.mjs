// M414 (d), scoped mode's "touching" decided by the module map (slice 32;
// kernel lane). Sean's decision of 2026-10-13: each module entry of
// `modules.json` lists the requirements it holds (`requirements`, B.3 †); in
// scoped mode a stage touching any module that holds a descriptive,
// criteria-less requirement is refused `PLAN_DESCRIPTIVE_MODULE_TOUCHED`,
// whatever it implements; a module map naming an unknown requirement, or
// leaving a descriptive requirement unmapped in scoped mode, is a finding that
// blocks the save, naming it. D6 §8.1 step 2, §8.3; B10; D6-R04, D6-R08;
// SEAM.md §387.
//   (a) the case that tells the module rule from a by-requirement reading: R1
//       (in `lib`) descriptive; the conformance stage touches `lib` and
//       `service` and implements only R2 and R3 (neither descriptive):
//       refused, naming `lib`; the same stage touching `service` alone: the
//       plan is published;
//   (b) a module map that leaves the descriptive R1 unmapped: the save's
//       finding names R1, and the close is refused;
//   (c) a module map naming an unknown requirement (R9): the save's finding
//       names R9, and the close is refused.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { requirementsOf } from './harness/journey/drive.mjs';
import { adoptProject, chooseMode, confirmAndApprove, retrofitArchitectSession, retrofitEngine, retrofitSpecSession } from './harness/retrofit/drive.mjs';
import { REQUIREMENTS, conformanceStage, modulesJsonWith, roadmapJson, retrofitSpecText } from './harness/retrofit/products.mjs';

// The scoped project with R1 descriptive (phase 2), R2 and R3 confirmed, R4 a defect.
async function scoped(t) {
  const fx = await retrofitEngine(t, { withoutR1: true });
  const p = await adoptProject(fx);
  await chooseMode(fx, p.id, 'scoped');
  await retrofitSpecSession(fx, p.id, { spec: retrofitSpecText({ requirements: REQUIREMENTS.map((r) => (r.key === 'R1' ? { ...r, descriptive: true, phase: 2 } : r)) }) });
  await confirmAndApprove(fx, p.id, { R2: 'confirm', R3: 'confirm', R4: 'defect' });
  assert.equal(requirementsOf(fx.home, p.id).find((r) => r.key === 'R1').status, 'descriptive_unverified', 'the fixture is live: R1 descriptive_unverified');
  return { fx, p };
}
const roadmap = roadmapJson({ phase1: ['R2', 'R3'], phase2: ['R1', 'R4'] });
const saveFindings = (arch) => JSON.stringify(arch.saved?.findings ?? []);

describe('M414 (d) scoped mode: touching is decided by the module map (Sean, 2026-10-13)', () => {
  test('(a) a stage touching lib, which holds the descriptive R1, is refused whatever it implements; touching service alone is published', async (t) => {
    const { fx, p } = await scoped(t);
    const touching = conformanceStage({ implements: ['R2', 'R3'], modules: ['lib', 'service'] });
    const refused = await retrofitArchitectSession(fx, p.id, p.repo, { roadmap, stages: [touching], answer: 'none' });
    assert.equal(refused.closeRes.status, 422, `the plan touching lib is refused, though it implements only R2 and R3 (→ ${refused.closeRes.status} ${refused.closeRes.text})`);
    assert.match(JSON.stringify(refused.closeRes.body?.subject ?? {}), /PLAN_DESCRIPTIVE_MODULE_TOUCHED/, 'PLAN_DESCRIPTIVE_MODULE_TOUCHED');
    assert.match(JSON.stringify(refused.closeRes.body?.subject ?? {}), /lib/, 'naming the module');
    await fx.engine.post(`/v1/projects/${p.id}/sessions/${refused.run.id}/close`, { refuse: true });
    const ok = await retrofitArchitectSession(fx, p.id, p.repo, { roadmap, stages: [conformanceStage({ implements: ['R2', 'R3'], modules: ['service'] })] });
    assert.ok(ok.published, `the stage touching service alone is published (${ok.closeRes.text})`);
  });

  test('(b) a module map leaving the descriptive R1 unmapped: the save names R1 and the close is refused', async (t) => {
    const { fx, p } = await scoped(t);
    const arch = await retrofitArchitectSession(fx, p.id, p.repo, { roadmap, stages: [conformanceStage({ implements: ['R2', 'R3'], modules: ['service'] })], modules: modulesJsonWith({ lib: [] }), answer: 'none' });
    assert.match(saveFindings(arch), /R1/, `the save's finding names R1 (${saveFindings(arch)})`);
    assert.equal(arch.closeRes.status, 422, `the close is refused (→ ${arch.closeRes.status} ${arch.closeRes.text})`);
  });

  test('(c) a module map naming an unknown requirement: the save names it and the close is refused', async (t) => {
    const { fx, p } = await scoped(t);
    const arch = await retrofitArchitectSession(fx, p.id, p.repo, { roadmap, stages: [conformanceStage({ implements: ['R2', 'R3'], modules: ['service'] })], modules: modulesJsonWith({ service: ['R2', 'R3', 'R4', 'R9'] }), answer: 'none' });
    assert.match(saveFindings(arch), /R9/, `the save's finding names R9 (${saveFindings(arch)})`);
    assert.equal(arch.closeRes.status, 422, `the close is refused (→ ${arch.closeRes.status} ${arch.closeRes.text})`);
  });
});
