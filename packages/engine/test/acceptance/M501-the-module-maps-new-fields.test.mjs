// M501, B.3's new fields (slice 40; kernel lane). M6 plan §3.2 M501; D7
// §4.1; G1, G15; B.3, B.8, B.17; D8 H9 (D7 §17 item 3); SEAM.md §§480, 481.
//
// (a) a module map with `surface`, `targets` (technology, form factors),
//     `platform_permissions`, `asset_paths`, and interfaces with
//     `consumed_by`, `request`, `response` and `errors` in B.8's language:
//     parsed and recorded on the architecture revision;
// (b) every M5 module map (Tally's): parse unchanged (M404's cases stand);
// (c) an unknown field at the module, target, interface and shape levels; a
//     shape with a reference or a union beyond `null`; `form_factors` on a
//     non-mobile target; `platform_permissions` on `web`, `windows` or
//     `linux`; a `consumed_by` naming a module the map does not hold, or a
//     module of another project: each refused naming the field, module,
//     interface or target; nothing registered;
// (d) the Builder's result with and without `asset_bindings`: both
//     accepted; an unknown field in a binding refused naming it.
//
// The refusals are the Architect's save findings and the close's 422
// `plan_refused`, as M404's (SEAM.md §481 names the codes).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertRefused } from './harness/fixtures.mjs';
import { addGitProject, addItem, roleThat, runToEnd } from './harness/gitruns.mjs';
import { architectSession, architectureRevisions, createWithIdea, nothingPublished, specSession, NOTHING } from './harness/journey/drive.mjs';
import { MODULES_JSON as TALLY_MODULES } from './harness/journey/reference.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { closeSession } from './harness/sessions.mjs';
import { INTERFACES, MODULES_JSON, SPEC } from './harness/design/reference.mjs';
import { createPantry, pantryArchitect, pantrySpec } from './harness/design/drive.mjs';

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const clone = (v) => structuredClone(v);
// The map with `edit` applied to a copy.
const mapWith = (edit) => {
  const m = clone(MODULES_JSON);
  edit(m);
  return m;
};
const mod = (m, name) => m.modules.find((x) => x.name === name);
const iface = (m, name) => mod(m, 'api').interfaces.find((i) => i.name === name);

// A project with Pantry's spec approved under `design: off` (the fields
// parse under any policy, D7 §4.1), the policy keys M5 knew only.
async function pantryAtSpec(fx) {
  const p = await createPantry(fx, { policy: { phase_size: { min: 1, max: 5 }, repair_attempts_max: 0 } });
  await pantrySpec(fx, p.id, { text: SPEC });
  return p;
}

// The defects of (c), each with a code and what it must name.
const DEFECTS = [
  { name: 'an unknown field on a module', map: mapWith((m) => (mod(m, 'web').colour = 'blue')), code: 'unknown_field', names: ['colour', 'web'] },
  { name: 'an unknown field on a target', map: mapWith((m) => (mod(m, 'web').targets[0].colour = 'blue')), code: 'unknown_field', names: ['colour', 'web'] },
  { name: 'an unknown field on an interface', map: mapWith((m) => (iface(m, 'add-item').colour = 'blue')), code: 'unknown_field', names: ['colour', 'add-item'] },
  { name: 'an unknown field in a shape', map: mapWith((m) => (iface(m, 'add-item').request.properties.name.colour = 'blue')), code: 'unknown_field', names: ['colour', 'add-item'] },
  { name: 'a shape with a reference', map: mapWith((m) => (iface(m, 'add-item').response = { $ref: '#/item' })), code: 'unknown_field', names: ['$ref', 'add-item'] },
  { name: 'a shape with a union beyond null', map: mapWith((m) => (iface(m, 'add-item').request.properties.quantity = { type: ['integer', 'string'] })), code: 'shape_union_invalid', names: ['quantity', 'add-item'] },
  { name: 'form_factors on a web target', map: mapWith((m) => (mod(m, 'web').targets[0].form_factors = ['phone'])), code: 'module_target_field_invalid', names: ['form_factors', 'web'] },
  { name: 'platform_permissions on web', map: mapWith((m) => (mod(m, 'web').platform_permissions = [{ target: 'web', permission: 'camera', why: 'scan a label' }])), code: 'module_target_field_invalid', names: ['platform_permissions', 'web'] },
  {
    name: 'platform_permissions on windows',
    map: mapWith((m) => m.modules.push({ name: 'desk', surface: 'ui', paths: ['desk/'], sensitive_areas: [], targets: [{ target: 'windows', ui_technology: 'flutter' }], platform_permissions: [{ target: 'windows', permission: 'camera', why: 'scan a label' }], interfaces: [] })),
    code: 'module_target_field_invalid',
    names: ['platform_permissions', 'windows'],
  },
  {
    name: 'platform_permissions on linux',
    map: mapWith((m) => m.modules.push({ name: 'desk', surface: 'ui', paths: ['desk/'], sensitive_areas: [], targets: [{ target: 'linux', ui_technology: 'flutter' }], platform_permissions: [{ target: 'linux', permission: 'camera', why: 'scan a label' }], interfaces: [] })),
    code: 'module_target_field_invalid',
    names: ['platform_permissions', 'linux'],
  },
  { name: 'consumed_by naming a module the map does not hold', map: mapWith((m) => (iface(m, 'list-items').consumed_by = ['web', 'ghost'])), code: 'interface_consumer_unknown', names: ['ghost', 'list-items'] },
  { name: 'consumed_by naming a module of another project', map: mapWith((m) => (iface(m, 'list-items').consumed_by = ['web', 'tally/service'])), code: 'interface_consumer_unknown', names: ['tally/service', 'list-items'] },
];

describe('M501 B.3\'s new fields', () => {
  test('(a) surface, targets with technology and form factors, platform_permissions, asset_paths and interface shapes parsed and recorded on the architecture revision', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await pantryAtSpec(fx);
    const arch = await pantryArchitect(fx, p.id, p.repo, { answer: 'both' });
    assert.equal(arch.closeRes.status, 200, `the close is accepted (${arch.closeRes.status} ${arch.closeRes.text?.slice(0, 600)}; save findings ${JSON.stringify(arch.saved?.findings)})`);
    const [rev] = architectureRevisions(fx.home, p.id);
    const map = parse(rev?.module_map);
    assert.deepEqual(map?.modules?.map((m) => [m.name, m.surface]), [['api', 'api'], ['web', 'ui'], ['mobile', 'ui']], 'surfaces');
    assert.deepEqual(mod(map, 'mobile').targets, MODULES_JSON.modules[2].targets, 'targets with technology and form factors');
    assert.deepEqual(mod(map, 'mobile').platform_permissions, MODULES_JSON.modules[2].platform_permissions, 'platform_permissions');
    assert.deepEqual(mod(map, 'mobile').asset_paths, MODULES_JSON.modules[2].asset_paths, 'asset_paths');
    for (const want of [INTERFACES.list, INTERFACES.add]) {
      const got = iface(map, want.name);
      assert.deepEqual([got?.consumed_by, got?.request, got?.response, got?.errors], [want.consumed_by, want.request, want.response, want.errors], `${want.name}: consumed_by, request, response and errors in B.8's language`);
    }
  });

  test('(b) an M5 module map parses unchanged (Tally\'s, M404\'s fixture)', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx, { policy: { repair_attempts_max: 0 } });
    await specSession(fx, p.id);
    const arch = await architectSession(fx, p.id, p.repo);
    assert.ok(arch.published, 'approved and published');
    const map = parse(architectureRevisions(fx.home, p.id)[0].module_map);
    assert.deepEqual(map.modules.map((m) => [m.name, m.paths, m.interfaces]), TALLY_MODULES.modules.map((m) => [m.name, m.paths, m.interfaces]), 'recorded as written');
    assert.equal(map.modules.some((m) => 'surface' in m || 'targets' in m), false, 'nothing added to an M5 map');
  });

  for (const d of DEFECTS) {
    test(`(c) ${d.name}: refused (${d.code}) naming ${d.names.join(' and ')}; nothing registered`, async (t) => {
      const fx = await scriptedEngine(t);
      const p = await pantryAtSpec(fx);
      const arch = await pantryArchitect(fx, p.id, p.repo, { files: { modules: d.map }, answer: 'none' });
      const finding = (arch.saved?.findings ?? []).find((f) => f.code === d.code && d.names.every((n) => JSON.stringify(f).includes(n)));
      assert.ok(finding, `the save's findings carry ${d.code} naming ${d.names.join(', ')} (${JSON.stringify(arch.saved?.findings)})`);
      assertRefused(arch.closeRes, 422, 'plan_refused', `a close whose module map has ${d.name}`);
      assert.ok(d.names.every((n) => arch.closeRes.text.includes(n)), `the close names ${d.names.join(', ')} (${arch.closeRes.text.slice(0, 400)})`);
      assert.deepEqual(nothingPublished(fx.home, p.id), NOTHING, 'nothing registered');
      await closeSession(fx, p.id, arch.run.id, { refuse: true });
    });
  }

  test('(d) a Builder\'s result with asset_bindings (empty) and without: both accepted; an unknown field in a binding refused naming it', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await addGitProject(fx);
    const write = (n) => step.write(`src/f${n}.js`, `export const n = ${n};\n`);
    const withBindings = await addItem(fx, p.id, 'fix');
    fx.scripted.script(withBindings, [roleThat([write(1)], { asset_bindings: [] })]);
    const a = await runToEnd(fx, p.id, withBindings);
    assert.deepEqual([a.outcome, a.reason_class], ['completed', null], `with asset_bindings: accepted (${a.reason_text})`);
    const without = await addItem(fx, p.id, 'fix');
    fx.scripted.script(without, [roleThat([write(2)])]);
    const b = await runToEnd(fx, p.id, without);
    assert.deepEqual([b.outcome, b.reason_class], ['completed', null], `without: accepted (${b.reason_text})`);
    const unknown = await addItem(fx, p.id, 'fix');
    fx.scripted.script(unknown, [roleThat([write(3)], { asset_bindings: [{ slot: 'logo', variant: 'full', target: 'web', path: 'src/f3.js', form: 'copy', colour: 'blue' }] })]);
    const c = await runToEnd(fx, p.id, unknown);
    assert.deepEqual([c.outcome, c.reason_class], ['failed', 'invalid_result'], `an unknown field in a binding: refused by B.17's closed schema (${c.reason_text})`);
    assert.match(c.reason_text ?? '', /colour/, 'naming the field');
  });
});
