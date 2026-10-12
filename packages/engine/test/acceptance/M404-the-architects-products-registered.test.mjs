// M404, the Architect's products registered; packages read approved bindings
// (slice 31a; kernel lane). M5 plan §3.1 M404; D6-A01; D6 §3.3, §3.5, §5.1,
// Appendix B.3 to B.6; B02; SEAM.md §§343, 346, 347.
//
// (a) a correct close approved and published: `architecture_revisions` 1,
//     `modules` replaced by the map with its mapping from TPL §6, ADR texts as
//     `baseline_texts` kind `adr`, `roadmap_revisions` 1 with `assigned_phase`
//     derived, `phase_plans` 1 with its stages and work;
// (b) `modules.json` dropping a TPL §6 sensitive area from every module: the
//     save's acceptance as architecture refused naming the area; moving one
//     between modules: accepted;
// (c) an unknown field in a machine file; a roadmap listing a requirement
//     twice or omitting one; a phase depending on itself: each refused naming
//     the field, key or phase; nothing registered;
// (d) ADR front matter without `key`, or with a status outside the three:
//     refused naming the ADR;
// (e) after two approved revisions, a Builder's and a replan's package while
//     a newer checkpoint of an ADR and the spec sits in the checkout: the
//     packages carry the approved revision's ADR and requirement text by
//     their bindings, never the checkpoint's.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { consume, decision } from './harness/decisions.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import {
  NOTHING,
  activePlan,
  architectSession,
  architectureRevisions,
  baselineTexts,
  createWithIdea,
  modulesOf,
  nothingPublished,
  phasePlansOf,
  requirementsOf,
  roadmapRevisions,
  specSession,
  stagesOfPlan,
  visionSession,
  workOf,
} from './harness/journey/drive.mjs';
import { ADR_001, ADR_001_REVISED, ADR_KEY, BAD_ARCHITECTURE, MODULES_JSON, MODULES_JSON_SERVICE_SECRETS, REQUIREMENTS, SPEC_SERVICE_SECRETS, adrText, specText } from './harness/journey/reference.mjs';
import { addWork, runsOf, scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { closeSession, openSession, packageOf, saveSession, sayAndSettle, scriptTurns, turnThatWrites } from './harness/sessions.mjs';

const ADR_PATH = `.surety/adrs/${ADR_KEY}.md`;
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

async function approvedSpec(fx, { spec } = {}) {
  const p = await createWithIdea(fx, { policy: { repair_attempts_max: 0 } });
  await visionSession(fx, p.id);
  await specSession(fx, p.id, spec === undefined ? {} : { second: spec });
  return p;
}

// An Architect save with `over` replacing a product: the save's findings and
// the close's refusal, nothing registered. Returns {saved, closeRes}.
async function refusedProducts(fx, p, over) {
  const arch = await architectSession(fx, p.id, p.repo, { over, answer: 'none' });
  assert.notEqual(arch.closeRes.status, 200, `the close is refused (${arch.closeRes.status} ${arch.closeRes.text})`);
  assertRefused(arch.closeRes, 422, 'plan_refused', 'a close whose products do not parse');
  assert.deepEqual(nothingPublished(fx.home, p.id), NOTHING, 'nothing registered');
  await closeSession(fx, p.id, arch.run.id, { refuse: true });
  return arch;
}

const names = (findings, code, text) => (findings ?? []).some((f) => f.code === code && JSON.stringify(f).includes(text));

describe('M404 the Architect\'s products registered; packages read approved bindings', () => {
  test('(a) a correct close approved and published: architecture_revisions 1, modules replaced by the map with its mapping, ADR texts refreshed, roadmap_revisions 1 with assigned_phase derived, phase_plans 1 with stages and work', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await approvedSpec(fx);
    const specModules = modulesOf(fx.home, p.id);
    assert.deepEqual(specModules.map((m) => m.name).sort(), ['lib', 'service'], 'the fixture is live: TPL §6\'s modules registered at the spec approval');
    const arch = await architectSession(fx, p.id, p.repo);
    const [revision] = architectureRevisions(fx.home, p.id);
    assert.deepEqual([architectureRevisions(fx.home, p.id).length, revision.version], [1, 1], 'architecture_revisions 1');
    const modules = modulesOf(fx.home, p.id);
    assert.deepEqual(modules.map((m) => [m.name, m.paths]), MODULES_JSON.modules.map((m) => [m.name, m.paths]), 'modules replaced by the map');
    assert.deepEqual(JSON.parse(revision.mapping_from_spec ?? 'null'), MODULES_JSON.mapping_from_spec, 'with its mapping from TPL §6');
    const adrs = baselineTexts(fx.home, p.id, 'adr');
    assert.deepEqual(adrs.map((a) => [a.key, a.text]), [[ADR_KEY, ADR_001]], 'the ADR text as baseline_texts kind adr');
    const [roadmap] = roadmapRevisions(fx.home, p.id);
    assert.deepEqual([roadmapRevisions(fx.home, p.id).length, roadmap.version, roadmap.architecture_revision], [1, 1, revision.id], 'roadmap_revisions 1, on the architecture revision');
    const phases = Object.fromEntries(requirementsOf(fx.home, p.id).map((r) => [r.key, r.assigned_phase]));
    assert.deepEqual(phases, { R1: 1, R2: 1, R3: 2, R4: 2 }, 'assigned_phase derived from the roadmap');
    const plan = arch.published;
    assert.deepEqual([phasePlansOf(fx.home, p.id).length, plan.phase_number, plan.roadmap_revision, plan.prepared_against_architecture], [1, 1, roadmap.id, revision.id]);
    assert.deepEqual(stagesOfPlan(fx.home, plan.id).map((s) => [s.number, s.status]), [[1, 'planned'], [2, 'planned']], 'its two stages');
    assert.equal(workOf(fx.home, p.id, 'stage_build').length, 2, 'and their work');
  });

  test('(b) a module map dropping a TPL §6 sensitive area from every module is refused as architecture naming the area; a map moving it between modules is accepted', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await approvedSpec(fx, { spec: SPEC_SERVICE_SECRETS });
    assert.deepEqual(modulesOf(fx.home, p.id).find((m) => m.name === 'service')?.sensitive_areas, ['secrets_credentials'], 'the fixture is live: TPL §6 gives service an area');
    const dropped = await refusedProducts(fx, p, BAD_ARCHITECTURE.area_dropped.files);
    assert.ok(names(dropped.saved.findings, 'architecture_area_dropped', 'secrets_credentials'), `the save names the dropped area (${JSON.stringify(dropped.saved.findings)})`);
    const moved = await architectSession(fx, p.id, p.repo, { over: BAD_ARCHITECTURE.area_moved.files });
    assert.ok(moved.published, 'the move is accepted and published');
    assert.deepEqual(modulesOf(fx.home, p.id).find((m) => m.name === 'lib')?.sensitive_areas, ['secrets_credentials'], 'the area now sits on lib');
    assert.equal(modulesOf(fx.home, p.id).some((m) => m.name === 'service' && m.sensitive_areas.includes('secrets_credentials')), false);
    void MODULES_JSON_SERVICE_SECRETS;
  });

  for (const [name, code] of [
    ['unknown_field', 'unknown_field'],
    ['requirement_twice', 'roadmap_requirement_duplicate'],
    ['requirement_omitted', 'roadmap_requirement_missing'],
    ['phase_self', 'roadmap_phase_cycle'],
  ]) {
    test(`(c) ${name.replace('_', ' ')} in a machine file: refused naming ${BAD_ARCHITECTURE[name].names}; nothing registered`, async (t) => {
      const fx = await scriptedEngine(t);
      const p = await approvedSpec(fx);
      const arch = await refusedProducts(fx, p, BAD_ARCHITECTURE[name].files);
      assert.ok(names(arch.saved.findings, code, BAD_ARCHITECTURE[name].names), `the save's findings carry ${code} naming ${BAD_ARCHITECTURE[name].names} (${JSON.stringify(arch.saved.findings)})`);
      assert.ok(JSON.stringify(arch.closeRes.body).includes(BAD_ARCHITECTURE[name].names), 'the close names it too');
    });
  }

  for (const [name, code] of [
    ['adr_no_key', 'adr_key_missing'],
    ['adr_status', 'adr_status_invalid'],
  ]) {
    test(`(d) ADR front matter ${name === 'adr_no_key' ? 'without key' : 'with a status outside the three'}: refused naming ${ADR_KEY}`, async (t) => {
      const fx = await scriptedEngine(t);
      const p = await approvedSpec(fx);
      const arch = await refusedProducts(fx, p, BAD_ARCHITECTURE[name].files);
      assert.ok(names(arch.saved.findings, code, ADR_KEY), `${code} naming the ADR (${JSON.stringify(arch.saved.findings)})`);
      assert.deepEqual(baselineTexts(fx.home, p.id, 'adr'), [], 'no ADR text registered');
    });
  }

  test('(e) after two approved revisions, a Builder\'s and a replan\'s package carry the approved ADR and requirement text, never a newer checkpoint\'s', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await approvedSpec(fx);
    const first = await architectSession(fx, p.id, p.repo);
    // The phase's check authoring, dispatched under `phase`, is given a script that ends it at once.
    const authoring = workOf(fx.home, p.id, 'check_authoring');
    for (const w of authoring) fx.scripted.script(w.id, [script.complete(), script.complete(), script.complete()]);
    fx.scripted.defaultScript(script.complete());
    // Revision 2: a later Architect session revises the ADR; its close raises architecture_approval again.
    const run = await openSession(fx, p.id, 'architect');
    scriptTurns(fx, run.id, [turnThatWrites({ [ADR_PATH]: ADR_001_REVISED }, { reply: 'ADR revised.', done: true })]);
    await sayAndSettle(fx, p.id, run.id, 'Make every answer JSON.');
    await saveSession(fx, p.id, run.id);
    const closed = await closeSession(fx, p.id, run.id);
    const again = (closed.decisions ?? []).find((d) => d.kind === 'architecture_approval');
    assert.ok(again, `a later Architect session raises architecture_approval again (${JSON.stringify(closed)})`);
    await consume(fx, p.id, decision(fx.home, again.id), 'approve');
    await tickUntil(fx.engine, p.id, () => (architectureRevisions(fx.home, p.id).length === 2 ? true : undefined), { what: 'architecture revision 2' });
    assert.deepEqual(baselineTexts(fx.home, p.id, 'adr').map((a) => a.text), [ADR_001_REVISED], 'the ADR text refreshed at the approval');
    assert.equal(activePlan(fx.home, p.id).id, first.published.id, 'the plan is unchanged');
    // Newer checkpoints, unapproved: a third ADR text and a changed R1 statement.
    const CHECKPOINT_ADR = adrText({ decision: 'CHECKPOINT ONLY: the service uses Express.' });
    const CHECKPOINT_R1 = 'CHECKPOINT ONLY: the library multiplies two numbers.';
    const a3 = await openSession(fx, p.id, 'architect');
    scriptTurns(fx, a3.id, [turnThatWrites({ [ADR_PATH]: CHECKPOINT_ADR }, { reply: 'A draft.' })]);
    await sayAndSettle(fx, p.id, a3.id, 'Draft a change.');
    await saveSession(fx, p.id, a3.id);
    await closeSession(fx, p.id, a3.id, { refuse: true });
    const s2 = await openSession(fx, p.id, 'spec_writer');
    scriptTurns(fx, s2.id, [turnThatWrites({ '.surety/spec/spec.md': specText({ requirements: REQUIREMENTS.map((r) => (r.key === 'R1' ? { ...r, statement: CHECKPOINT_R1 } : r)) }) }, { reply: 'A draft.' })]);
    await sayAndSettle(fx, p.id, s2.id, 'Draft a change to R1.');
    await saveSession(fx, p.id, s2.id);
    await closeSession(fx, p.id, s2.id, { refuse: true });
    // A Builder's package (fix work, a fixture's) and a replan's package (a fixture's work), each dumped.
    const dumps = {};
    for (const kind of ['fix', 'replan']) {
      const item = await addWork(fx.engine, p.id, kind);
      fx.scripted.script(item, [{ steps: [step.probe('context_dump'), step.result({ status: 'completed', summary: `${kind} dumped` })] }]);
      const run_ = await tickUntil(fx.engine, p.id, () => runsOf(fx.home, item).find((r) => r.state === 'ended'), { max: 20, what: `the ${kind} run to end` });
      dumps[kind] = packageOf(fx, run_.id);
      assert.ok(dumps[kind], `the ${kind} role dumped its package`);
    }
    const approvedR1 = REQUIREMENTS[0].statement;
    for (const [kind, pkg] of Object.entries(dumps)) {
      const texts = Object.values(pkg).filter((x) => typeof x === 'string');
      assert.ok(texts.some((x) => x.includes('every answer is JSON with content type application/json')), `${kind}'s package carries the approved ADR text (revision 2) (files: ${Object.keys(pkg).join(', ')})`);
      assert.ok(!texts.some((x) => x.includes('CHECKPOINT ONLY: the service uses Express')), `${kind}'s package does not carry the ADR checkpoint`);
      assert.ok(texts.some((x) => x.includes(approvedR1)), `${kind}'s package carries the approved requirement text`);
      assert.ok(!texts.some((x) => x.includes(CHECKPOINT_R1)), `${kind}'s package does not carry the spec checkpoint`);
    }
    await tick(fx.engine, p.id);
  });
});
