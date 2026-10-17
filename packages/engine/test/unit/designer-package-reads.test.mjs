// Developer tests for what the Designer's package and the Verifier's design
// additions state of what the engine reads (row M537; D7 §3.4, §8.4; E151;
// src/packages/design-reads.ts): every reason the design check, the assets'
// header reads, the snapshot and the approval can give is stated with its
// meaning; every schema object is closed and carries the check's own field
// list; the conventions are the inventory's and the check's; a Designer's
// session package carries the elements, lists them in its manifest and its
// result schema carries `findings`, which no other role's does; the
// Verifier's catalogue states the criteria and the programs.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const D = await import(join(dist, 'packages', 'design-reads.js'));
const { statedElements } = await import(join(dist, 'packages', 'reads.js'));
const { PACKAGE_ELEMENTS, elementListing } = await import(join(dist, 'packages', 'elements.js'));
const { FIELDS, CONVENTION_TARGETS, CRITERION_CATALOGUE } = await import(join(dist, 'design', 'check.js'));
const { requiredConventions } = await import(join(dist, 'design', 'inventory.js'));
const { writeSessionPackage } = await import(join(dist, 'sessions', 'package.js'));

const read = (dir, f) => readFileSync(join(dir, f), 'utf8');
const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const BLOCK = /^```json surety-reads ([A-Za-z0-9_.]+)\n([\s\S]*?)^```$/gm;
const blocks = (text) => Object.fromEntries([...text.matchAll(BLOCK)].map((m) => [m[1], JSON.parse(m[2])]));

const INVENTORY = {
  inventory_digest: 'sha256:aa',
  spec_version: 1,
  architecture_version: 1,
  targets: [
    { module: 'web', target: 'web', ui_technology: 'html_css', form_factors: [], preview_capability: 'native', layouts: [400, 1100], required_conventions: requiredConventions('web', false), permissions: [], required_slots: [{ kind: 'logo', variants: ['full'] }, { kind: 'favicon', variants: ['default'] }], adrs: [], runtime: null },
    { module: 'mobile', target: 'android', ui_technology: 'react_native', form_factors: ['phone'], preview_capability: 'simulated', layouts: ['phone-portrait'], required_conventions: requiredConventions('android', true), permissions: ['camera'], required_slots: [{ kind: 'logo', variants: ['full'] }, { kind: 'app_icon', variants: ['default'] }], adrs: [], runtime: null },
  ],
  cross_platform: true,
  ui_requirements: [{ key: 'R2', phase: 1, modules: ['web', 'mobile'], targets: ['web', 'android'] }],
  interfaces: [],
  obligations: [],
  fixtures: [],
};
const FACTS = { inventory: INVENTORY, inventory_digest: 'sha256:aa', widths: [400, 1100], orientations: ['portrait'], allowlist: ['cdn.jsdelivr.net'] };

// Every object schema with properties, by path, that is not closed.
function openObjects(s, at = '', out = []) {
  if (!s || typeof s !== 'object') return out;
  if (s.properties && s.additionalProperties !== false) out.push(at || '(root)');
  for (const [k, v] of Object.entries(s.properties ?? {})) openObjects(v, at ? `${at}.${k}` : k, out);
  if (s.items) openObjects(s.items, `${at}[]`, out);
  return out;
}

test('every reason the design check, the asset reads, the snapshot and the approval give is stated, with its meaning; the contrast reason carries its ratio', () => {
  const sources = ['design/check.js', 'design/assets.js'].map((f) => readFileSync(join(dist, f), 'utf8'));
  const given = new Set(sources.flatMap((s) => [...s.matchAll(/'(DESIGN_[A-Z_]+)'/g)].map((m) => m[1])));
  given.add('DESIGN_INVENTORY_MODIFIED');
  given.add('DESIGN_INTERFACE_DISPUTED');
  const stated = D.designReasons();
  const codes = stated.map((r) => r.code);
  assert.deepEqual([...given].filter((c) => !codes.includes(c)).sort(), [], 'no reason left unstated');
  assert.equal(new Set(codes).size, codes.length, 'each once');
  for (const r of stated) assert.ok(r.meaning.length > 20 && r.clause, `${r.code} says what it means`);
  assert.equal(stated.find((r) => r.code === 'DESIGN_CONTRAST_BELOW_AA').ratio, 4.5);
});

test('the schemas: B.8 to B.16 and the turn result, every object closed, each with the check\'s own fields', () => {
  const e = D.designerElements(FACTS)['designer.schemas'];
  const list = e.data.schemas;
  for (const s of list) assert.deepEqual(openObjects(s.schema), [], `${s.id} ${s.file ?? s.name} closed`);
  const byFile = (f) => list.find((s) => s.file === `.surety/design/${f}`).schema;
  assert.deepEqual(Object.keys(byFile('design.json').properties).sort(), [...FIELDS.design].sort());
  assert.deepEqual(Object.keys(byFile('screens.json').properties.screens.items.properties.conventions.properties).sort(), [...FIELDS.conventions].sort());
  assert.deepEqual(byFile('criteria.json').properties.criteria.items.properties.kind.enum.sort(), Object.keys(CRITERION_CATALOGUE).sort());
  assert.ok(!('status' in byFile('reviews/review-<n>.json').properties.screens.items.properties), 'a review verdict carries no status');
  const turn = list.find((s) => s.name === 'turn_result').schema;
  assert.ok(turn.properties.findings && turn.additionalProperties === false, 'the turn result lists findings and is closed');
});

test('the conventions, layouts, floor and allowlist are the inventory\'s and the project\'s', () => {
  const b = D.designerElements(FACTS);
  const conv = b['designer.conventions'].data.targets;
  for (const c of conv) {
    assert.deepEqual(c.required, requiredConventions(c.target, false));
    assert.deepEqual(c.fields, CONVENTION_TARGETS[c.target]);
  }
  assert.equal(conv.find((c) => c.target === 'android').if_permissions, 'permissions');
  assert.equal(conv.find((c) => c.target === 'macos').if_permissions, undefined);
  assert.deepEqual(b['designer.layouts'].data.targets, [{ module: 'web', target: 'web', layouts: [400, 1100] }, { module: 'mobile', target: 'android', layouts: ['phone-portrait'] }]);
  assert.deepEqual(b['designer.external_urls'].data.allowlist, ['cdn.jsdelivr.net']);
  assert.deepEqual(b['designer.selection_floor'].data.floor.per_target, [{ target: 'web', kind: 'favicon', variants: 1 }, { target: 'android', kind: 'app_icon', variants: 1 }]);
  assert.deepEqual(b['designer.mockup_kinds'].data.capabilities, [{ module: 'web', target: 'web', preview_capability: 'native' }, { module: 'mobile', target: 'android', preview_capability: 'simulated' }]);
  assert.deepEqual(D.designerElements({ ...FACTS, inventory: null })['designer.inventory'], undefined, 'no inventory: not stated, never an empty one');
});

test('the registry: the three Designer packages and the Verifier packages\' catalogue', () => {
  assert.deepEqual([...PACKAGE_ELEMENTS.designer_review].filter((x) => !PACKAGE_ELEMENTS.designer.includes(x)), ['designer.review']);
  assert.deepEqual([...PACKAGE_ELEMENTS.designer_retrofit].filter((x) => !PACKAGE_ELEMENTS.designer.includes(x)), ['designer.retrofit']);
  const carried = Object.fromEntries(elementListing().map((e) => [e.id, e.packages]));
  assert.deepEqual(carried['verifier.design_catalogue'].sort(), ['verifier_authoring', 'verifier_authoring_retrofit', 'verifier_correction']);
});

test('a Designer\'s session package states its elements and lists them; its result schema carries findings, no other role\'s does', (t) => {
  const elements = statedElements('designer', D.designerElements(FACTS));
  const dir = scratch(t);
  const facts = { run: 'run_d', project: 'prj_1', role: 'designer', turn: 1, paths: ['.surety/design/'], transcript: [], findings: [], approved: [], retrofit: null };
  writeSessionPackage(dir, { run: 'run_d' }, facts, new Map(), null, null, { files: [], prompt: [], reads: { pkg: 'designer', elements } });
  const m = JSON.parse(read(dir, 'manifest.json'));
  assert.equal(m.package, 'designer');
  assert.deepEqual(m.reads, [...PACKAGE_ELEMENTS.designer]);
  assert.deepEqual(Object.keys(blocks(read(dir, 'prompt.md'))).sort(), [...PACKAGE_ELEMENTS.designer].sort());
  assert.match(read(dir, 'prompt.md'), /You are the Designer role/);
  assert.ok(JSON.parse(read(dir, 'result-schema.json')).properties.findings, 'findings in the Designer\'s result schema');
  const other = scratch(t);
  writeSessionPackage(other, { run: 'run_s' }, { ...facts, role: 'spec_writer', paths: ['.surety/spec/'] });
  assert.equal(JSON.parse(read(other, 'result-schema.json')).properties.findings, undefined, 'none in the Spec Writer\'s');
});

test('the Verifier\'s design catalogue: the criteria with their paths, the programs, how a check reads a slot', () => {
  const none = D.verifierDesignElements({ criteria: [], programs: null })['verifier.design_catalogue'].data;
  assert.deepEqual(none.criteria, []);
  assert.equal(none.command.programs, null, 'unknown programs are null, never none');
  const c = { id: 'R2.3', kind: 'asset_parity', targets: ['web'], technologies: ['html_css'], paths: ['web/logo.svg'], slot: 'logo', variant: 'full' };
  const d = D.verifierDesignElements({ criteria: [c], programs: ['node'] })['verifier.design_catalogue'].data;
  assert.deepEqual(d.criteria, [c]);
  assert.deepEqual(d.command.programs, ['node']);
  assert.equal(d.asset_inputs.variable, 'SURETY_ASSET_<SLOT>_<VARIANT>');
  assert.deepEqual(d.kinds.map((k) => k.kind).sort(), Object.keys(CRITERION_CATALOGUE).sort());
  assert.equal(D.verifierDesignElements(null)['verifier.design_catalogue'], undefined);
});
