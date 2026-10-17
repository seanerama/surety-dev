// M502, targets and the surface mark (slice 40; kernel lane). M6 plan §3.2
// M502; D7 §4.1, §4.2; G3; Q7; B.2; SEAM.md §481.
//
// (a) a header `**Targets:** web, android` with `**Cross-platform:** yes`:
//     targets and cross-platform in `spec_semantics`; a target outside the
//     six; a duplicate: each the engine's entry naming it (a save finding
//     and the next turn's engine entry), approval blocked while it stands;
// (b) `**Surface:** ui` and `**Surface:** ui (android, ios)` under a
//     requirement: recorded with its targets; a mark naming a target the
//     header lacks: the defect named;
// (c) an M5 specification with neither line: parses as before, its
//     `semantic_digest` unchanged (the digest main computed, held here);
// (d) a save changing only the targets: the digest changes;
// (e) at publication, under `design: before_build`: a marked requirement no
//     UI stage implements is a UI requirement of the inventory with its
//     targets; an unmarked one a UI stage implements is one; an unmarked
//     one only a non-UI stage implements is not.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createWithIdea } from './harness/journey/drive.mjs';
import { SPEC as TALLY_SPEC } from './harness/journey/reference.mjs';
import { blockersOf, findingNaming, semanticsOf, specSaves } from './harness/journey/spec34.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { transcriptEntries } from './harness/sessions.mjs';
import { REQUIREMENTS, STAGES, ROADMAP_JSON, specText } from './harness/design/reference.mjs';
import { createPantry, inventoryOf, toPublished } from './harness/design/drive.mjs';

// The semantic digest of Tally's specification (M401's `SPEC`) as the M5
// engine computes it: read on main at e55bce2 by this file's first run
// (SEAM.md §481). An M5 specification's digest does not move (G3; M502 (c)).
const M5_TALLY_DIGEST = '56b7143cf5d0addd5a18f467f716dd1dbd66c1ab174912ec4874e44ab5a80e5f';

const header = (targets, cross = '**Cross-platform:** yes') => specText({ targets, crossPlatform: cross });
const withSurface = (key, surface) => specText({ requirements: REQUIREMENTS.map((r) => (r.key === key ? { ...r, surface } : r)) });

async function saveOne(fx, text, { close = true } = {}) {
  const p = await createPantry(fx, { policy: { phase_size: { min: 1, max: 5 } } });
  const s = await specSaves(fx, p.id, [text], { close });
  const [row] = semanticsOf(fx.home, s.run.id);
  return { p, s, row, findings: s.saves[0]?.findings ?? [] };
}

describe('M502 targets and the surface mark', () => {
  test('(a) **Targets:** web, android with **Cross-platform:** yes: targets and cross-platform in spec_semantics', async (t) => {
    const fx = await scriptedEngine(t);
    const { row, findings } = await saveOne(fx, header('**Targets:** web, android'), { close: false });
    assert.equal(row?.readable, 1, `the representation is readable (${JSON.stringify(row?.findings)})`);
    assert.deepEqual([row.representation.targets, row.representation.cross_platform], [['web', 'android'], true], `targets and cross-platform (SEAM.md §481) (${JSON.stringify(row.representation).slice(0, 300)})`);
    assert.deepEqual(findings.filter((f) => /target|surface/i.test(JSON.stringify(f))), [], 'no finding about them');
  });

  for (const [name, line, code, names] of [
    ['a target outside the six', '**Targets:** web, tvos', 'spec_target_unknown', 'tvos'],
    ['a duplicate target', '**Targets:** web, android, web', 'spec_target_duplicate', 'web'],
  ]) {
    test(`(a) ${name}: the engine's entry names it; approval blocked while it stands`, async (t) => {
      const fx = await scriptedEngine(t);
      const { s, findings } = await saveOne(fx, header(line));
      assert.ok(findingNaming(findings, code, names), `the save's finding ${code} names ${names} (${JSON.stringify(findings)})`);
      assert.ok(transcriptEntries(fx.home, s.run.id).some((e) => e.speaker === 'engine' && (e.text ?? '').includes(code)), 'the engine\'s transcript entry names it');
      assert.ok(s.approval, 'the close raised spec_approval');
      assert.ok(blockersOf(s.approval).some((b) => b.includes('spec_semantics_invalid')), `approve blocked (${JSON.stringify(blockersOf(s.approval))})`);
    });
  }

  test('(b) **Surface:** ui and **Surface:** ui (android, ios) under a requirement: recorded with its targets', async (t) => {
    const fx = await scriptedEngine(t);
    const text = specText({
      targets: '**Targets:** web, android, ios',
      requirements: REQUIREMENTS.map((r) => (r.key === 'R2' ? { ...r, surface: 'ui' } : r.key === 'R3' ? { ...r, surface: 'ui (android, ios)' } : r)),
    });
    const { row, findings } = await saveOne(fx, text, { close: false });
    const req = (key) => (row.representation.requirements ?? []).find((r) => r.key === key);
    assert.deepEqual([req('R2')?.surface, req('R2')?.surface_targets ?? null], ['ui', null], `R2 marked ui with no target list (${JSON.stringify(req('R2'))})`);
    assert.deepEqual([req('R3')?.surface, req('R3')?.surface_targets], ['ui', ['android', 'ios']], 'R3 marked ui for android and ios');
    assert.equal(req('R1')?.surface ?? null, null, 'R1 unmarked');
    assert.deepEqual(findings.filter((f) => /surface/i.test(JSON.stringify(f))), [], 'no finding');
  });

  test('(b) a mark naming a target the header lacks: the defect named; approval blocked', async (t) => {
    const fx = await scriptedEngine(t);
    const { s, findings } = await saveOne(fx, withSurface('R3', 'ui (ios)'));
    assert.ok(findingNaming(findings, 'spec_surface_target_unknown', 'ios'), `spec_surface_target_unknown naming ios (${JSON.stringify(findings)})`);
    assert.ok(blockersOf(s.approval).some((b) => b.includes('spec_semantics_invalid')), 'approve blocked');
  });

  test('(c) an M5 specification with neither line parses as before: its semantic_digest unchanged', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx);
    const s = await specSaves(fx, p.id, [TALLY_SPEC], { close: false });
    const [row] = semanticsOf(fx.home, s.run.id);
    assert.equal(row.readable, 1);
    assert.equal(row.semantic_digest, M5_TALLY_DIGEST, 'the digest M5 computed for the same text');
    assert.equal('targets' in row.representation || 'cross_platform' in row.representation, false, 'no key added to an M5 representation');
  });

  test('(d) a save changing only the targets changes the digest', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createPantry(fx, { policy: { phase_size: { min: 1, max: 5 } } });
    const s = await specSaves(fx, p.id, [header('**Targets:** web, android'), header('**Targets:** web, android, ios')], { close: false });
    const [a, b] = semanticsOf(fx.home, s.run.id);
    assert.ok(a?.semantic_digest && b?.semantic_digest, 'both saves have a digest');
    assert.notEqual(a.semantic_digest, b.semantic_digest, 'the digest changes with the targets');
  });

  test('(e) at publication: a marked requirement no UI stage implements, an unmarked one a UI stage implements, an unmarked one only a non-UI stage implements', async (t) => {
    const fx = await scriptedEngine(t);
    // R2 unmarked (stage 2, web, implements it); R4 marked `ui` with no list, implemented by the API stage; R1 unmarked, API only.
    const R4 = { key: 'R4', title: 'Items sorted by name', phase: 1, surface: 'ui', statement: 'Items are listed sorted by name.', criteria: [{ id: 'R4.1', text: 'Given two items b and a, when GET /api/items is requested, then a is listed first.' }] };
    const requirements = [REQUIREMENTS[0], { ...REQUIREMENTS[1], surface: undefined }, REQUIREMENTS[2], R4];
    const stages = STAGES.map((s) => (s.number === 1 ? { ...s, implements: ['R1', 'R4'], validation: { ...s.validation, criteria: [...s.validation.criteria, 'R4.1'] } } : s));
    const roadmap = { ...ROADMAP_JSON, phases: [{ ...ROADMAP_JSON.phases[0], requirement_ids: ['R1', 'R2', 'R3', 'R4'] }] };
    const { p } = await toPublished(fx, { policy: { design: 'before_build', phase_size: { min: 1, max: 5 } }, spec: specText({ requirements }), files: { stages, roadmap } });
    const inventory = inventoryOf(p);
    const ui = Object.fromEntries((inventory.ui_requirements ?? []).map((r) => [r.key, r]));
    assert.deepEqual(Object.keys(ui).sort(), ['R2', 'R3', 'R4'], `the inventory's UI requirements (${JSON.stringify(inventory.ui_requirements)})`);
    assert.deepEqual([...ui.R4.targets].sort(), ['android', 'web'], 'the marked one with every target of the header');
    assert.deepEqual(ui.R2.targets, ['web'], 'the unmarked one a UI stage implements, with its stage\'s targets');
    assert.deepEqual(ui.R3.targets, ['android'], 'the marked one with its list');
    assert.equal(ui.R1, undefined, 'the unmarked one only the API stage implements is not one');
  });
});
