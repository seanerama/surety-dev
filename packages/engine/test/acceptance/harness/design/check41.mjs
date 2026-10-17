// M6 slice 41, the Designer session and the design check (M538, M532, M506,
// M521, M524, M533; SEAM.md §§490 to 497). Built on slice 40's harness
// (reference.mjs, drive.mjs) and pinned beside it:
//
// - two more variants of the reference project "Pantry": **Pantry
//   everywhere** (`SIX_*`: the six targets of D7 A.2, an api module and three
//   `ui` modules: web `html_css`; mobile `react_native` on android (phone)
//   and ios (phone, tablet), the notifications permission on both; desktop
//   `flutter` on macos, windows and linux; one phase of four stages) and
//   **Pantry SC** (web under `streamlit`, android under `compose`, for
//   M521 (a));
// - a design drawn from any inventory (`designModel`), as a real Designer
//   reads its package: one screen per inventory target (S1 to Sn in D7
//   A.2's target order), every state obligation of its target, the
//   conventions SEAM.md §484 requires, a mockup of the kind its capability
//   admits; held as JS objects so a case can change one thing and save
//   (`filesOf`, `designTurnOf`);
// - the fault session (`checkSession`): one Designer session whose turns
//   each write the whole design with one change, each saved, the save's
//   `design_check` read (SEAM.md §483);
// - binary files with valid headers (PNG, WebP, ICO, SVG; BS6 §4.1 rule 22),
//   generated here, never decoded;
// - the batch of a six-target design, approved through the owner's routes.
//
// Nothing here is run by the engine or the test but the scripted roles;
// nothing the Designer writes is run by anyone (BS6 §4.1 rule 21).

import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';

import { consume } from '../decisions.mjs';
import { journeyContext, planChecks, pump } from '../journey/drive.mjs';
import { step } from '../scripted.mjs';
import { postSaveRaw } from '../session-lane.mjs';
import { sayAndSettle, scriptTurns, transcriptEntries, turnResult } from '../sessions.mjs';
import { withStore } from '../store.mjs';
import { INTERFACES, MODULES_JSON, REQUIREMENTS, ROADMAP_JSON, SPEC, SPEC_MODULES, STAGES, T2_KINDS, TOKENS, specText } from './reference.mjs';
import { answerWith, batchOf, designRevisions, designScripts, inventoryOf, manifestOf, openDesigner, scriptBuilders, specChangeScriptFor, toPublished } from './drive.mjs';

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const clone = (v) => structuredClone(v);
export const DESIGN_DIR = '.surety/design/';

// `design: before_build` with a phase size that admits every variant.
export const BEFORE_BUILD = Object.freeze({ design: 'before_build', autonomy: 'phase', phase_size: { min: 1, max: 5 } });
// The decisions `pump` answers on the kernel lane (as M505's).
export const KERNEL_KINDS = Object.freeze(['check_correction_unclassifiable', 'check_correction_tightening', 'check_correction_loosening', 'plan_approval']);

// ---- the targets, in D7 A.2's order ----------------------------------------------------------

export const TARGETS = Object.freeze(['web', 'android', 'ios', 'macos', 'windows', 'linux']);
export const DESKTOP = Object.freeze(['macos', 'windows', 'linux']);
export const MOBILE = Object.freeze(['android', 'ios']);
export const TECHNOLOGIES = Object.freeze(['html_css', 'three_js', 'streamlit', 'react_native', 'flutter', 'swiftui', 'compose', 'other']);
// D7 §4.1's admissibility table.
export const ADMISSIBLE = Object.freeze({
  html_css: ['web'],
  three_js: ['web'],
  streamlit: ['web'],
  react_native: ['android', 'ios'],
  flutter: [...TARGETS],
  swiftui: ['ios', 'macos'],
  compose: ['android'],
  other: [...TARGETS],
});

// ---- a module map with other targets (B.3 as G1 extends it) -------------------------------------

// Pantry's map with each named `ui` module's `targets` replaced; `extra`
// modules appended; interfaces consumed by every `ui` module of the map.
export function modulesWith(targets = {}, { extra = [], permissions } = {}) {
  const m = clone(MODULES_JSON);
  for (const mod of m.modules) {
    if (targets[mod.name]) mod.targets = targets[mod.name];
    if (mod.name === 'mobile' && permissions !== undefined) {
      if (permissions === null) delete mod.platform_permissions;
      else mod.platform_permissions = permissions;
    }
  }
  m.modules.push(...clone(extra));
  const ui = m.modules.filter((x) => x.surface === 'ui').map((x) => x.name);
  for (const i of m.modules.find((x) => x.name === 'api').interfaces) if ((i.consumed_by ?? []).length > 0) i.consumed_by = ui;
  for (const e of extra) if (!m.mapping_from_spec.some((x) => x.spec_module === e.name)) m.mapping_from_spec.push({ spec_module: e.name, to: [e.name] });
  return m;
}

// ---- Pantry everywhere: the six targets ------------------------------------------------------

export const SIX_TARGETS_LINE = `**Targets:** ${TARGETS.join(', ')}`;
export const SIX_REQUIREMENTS = Object.freeze([
  REQUIREMENTS[0],
  REQUIREMENTS[1],
  { ...REQUIREMENTS[2], title: 'The pantry on a phone or tablet', surface: 'ui (android, ios)', statement: 'A user sees the pantry\'s items and adds one in the mobile app, on Android or iOS.' },
  {
    key: 'R4',
    title: 'The pantry on the desktop',
    phase: 1,
    surface: 'ui (macos, windows, linux)',
    statement: 'A user sees the pantry\'s items and adds one in the desktop app, on macOS, Windows or Linux.',
    criteria: [{ id: 'R4.1', text: 'Given the desktop module, when desktop/lib/main.dart is read, then it declares a main function.' }],
  },
]);
export const SIX_SPEC_MODULES = Object.freeze([...SPEC_MODULES, { name: 'desktop', paths: ['desktop/'] }]);
export const SIX_SPEC = specText({ requirements: SIX_REQUIREMENTS, targets: SIX_TARGETS_LINE, modules: SIX_SPEC_MODULES });
const NOTIFY = (target) => ({ target, permission: 'notifications', why: 'to remind the household when an item runs low' });
export const SIX_MODULES_JSON = modulesWith(
  {
    mobile: [
      { target: 'android', ui_technology: 'react_native', form_factors: ['phone'] },
      { target: 'ios', ui_technology: 'react_native', form_factors: ['phone', 'tablet'] },
    ],
  },
  {
    permissions: [NOTIFY('android'), NOTIFY('ios')],
    extra: [{ name: 'desktop', surface: 'ui', paths: ['desktop/'], sensitive_areas: [], targets: DESKTOP.map((target) => ({ target, ui_technology: 'flutter' })), interfaces: [] }],
  },
);
export const SIX_ROADMAP = Object.freeze({ ...ROADMAP_JSON, phases: [{ ...ROADMAP_JSON.phases[0], goal: 'the pantry everywhere', modules: ['api', 'web', 'mobile', 'desktop'], requirement_ids: ['R1', 'R2', 'R3', 'R4'] }] });
export const SIX_STAGES = Object.freeze([
  ...STAGES.slice(0, 2),
  { ...STAGES[2], goal: 'the mobile app', tasks: ['write mobile/App.js from the approved design'] },
  { number: 4, goal: 'the desktop app', tasks: ['write desktop/lib/main.dart from the approved design'], modules: ['desktop'], implements: ['R4'], adrs: [STAGES[0].adrs[0]], depends_on: [1], validation: { criteria: ['R4.1'], kinds: T2_KINDS, sensitive_areas: [] }, integration_obligations: [] },
]);
export const SIX_FILES = Object.freeze({ modules: SIX_MODULES_JSON, roadmap: SIX_ROADMAP, stages: SIX_STAGES });
export const toSixPublished = (fx, { policy = BEFORE_BUILD, name = 'pantry-six' } = {}) => toPublished(fx, { policy, name, spec: SIX_SPEC, files: SIX_FILES });

// ---- Pantry SC: web under streamlit, android under compose (M521 (a)) ----------------------------

export const SC_MODULES_JSON = modulesWith({ web: [{ target: 'web', ui_technology: 'streamlit' }], mobile: [{ target: 'android', ui_technology: 'compose', form_factors: ['phone'] }] });
export const toScPublished = (fx, { policy = BEFORE_BUILD, name = 'pantry-sc' } = {}) => toPublished(fx, { policy, name, spec: SPEC, files: { modules: SC_MODULES_JSON } });

// ---- the design drawn from an inventory (D7 §5; Appendix B) --------------------------------------

export const WINDOW = Object.freeze({ min: [800, 600], default: [1280, 800] });
export const sizeOf = ([w, h]) => `${w}x${h}`;
export const DESKTOP_LAYOUTS = Object.freeze([sizeOf(WINDOW.min), sizeOf(WINDOW.default)]);

// The NativeConvention entries each target's screen leaves `not_checkable_yet`
// (D7 §5.3's right-hand column, §7.2; A.2), as the Verifier of slice 41 maps
// them (SEAM.md §494): web's browser back and keyboard path; android's system
// back, touch and permission prompt; ios's navigation container and
// edge-swipe back, safe area and permission prompt; a desktop target's
// window resizing, menus and shortcuts. `permission_prompt` only where the
// target has a platform permission.
export const NOT_CHECKABLE = Object.freeze({
  web: ['browser_back', 'keyboard_path'],
  android: ['system_back', 'permission_prompt', 'touch_interaction'],
  ios: ['platform_navigation', 'safe_area', 'permission_prompt'],
  macos: ['window_resize', 'menu_entries', 'keyboard_shortcuts'],
  windows: ['window_resize', 'menu_entries', 'keyboard_shortcuts'],
  linux: ['window_resize', 'menu_entries', 'keyboard_shortcuts'],
});

const targetsOf = (inventory) => [...(inventory.targets ?? [])].sort((a, b) => TARGETS.indexOf(a.target) - TARGETS.indexOf(b.target));
const permissionsOf = (inventory, target) => [...new Set((inventory.obligations ?? []).filter((o) => o.target === target && o.permission).map((o) => o.permission))];
export const notCheckableOf = (inventory, target) => NOT_CHECKABLE[target].filter((c) => c !== 'permission_prompt' || permissionsOf(inventory, target).length > 0);

// The conventions a screen of `target` declares (B.12; §5.3; SEAM.md §484).
export function conventionsFor(target, permissions = []) {
  const perms = permissions.length > 0 ? { permissions: permissions.map((permission) => ({ permission, prompt_when: 'the first time an item is added', rationale: 'to remind the household when an item runs low' })) } : {};
  if (target === 'web') return { route: '/', browser_back: 'leaves Pantry for the previous page; forward returns to the list', keyboard_path: 'Tab reaches Item name, Quantity and Add in that order; Enter adds' };
  if (target === 'android') return { ...perms, gestures: ['tap', 'scroll'] };
  if (target === 'ios') return { container: 'stack', edge_swipe_back: true, safe_area_edges: ['top', 'bottom'], ...perms };
  return { window_min: [...WINDOW.min], menu_entries: [{ action: 'add', menu: 'File', item: 'Add item' }], shortcuts: [{ action: 'add', keys: 'Ctrl+N' }] };
}

// The fixture of an obligation from the inventory's list (B.9 `fixtures`),
// relative to .surety/design/; a permission state reads list-items' `ok`.
function fixtureFor(inventory, o) {
  const iface = o.interface ?? 'list-items';
  const state = o.interface ? o.state : 'ok';
  const f = (inventory.fixtures ?? []).find((x) => x.interface === iface && x.state === state);
  if (!f) throw new Error(`the inventory lists no fixture for ${iface} ${state} (${JSON.stringify(inventory.fixtures)})`);
  return f.path.startsWith(DESIGN_DIR) ? f.path.slice(DESIGN_DIR.length) : f.path;
}

const mockupHtml = (key, target, simulated) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${key} Pantry (${target}${simulated ? ', simulated' : ''})</title><link rel="stylesheet" href="../../tokens.css"></head>
<body>
<main>
<h1>Pantry</h1>
<p data-state="empty">Nothing in the pantry yet.</p>
<form><label>Item name <input name="name" maxlength="40"></label><label>Quantity (pcs) <input name="quantity" type="number" min="0" max="99"></label><button>Add</button></form>
</main>
</body>
</html>
`;

// The default selection (B.10; §5.8): both themes, every default slot and
// variant of the inventory, every layout of each target (a desktop target's
// the window sizes the design declares).
export function defaultSelection(inventory) {
  const slots = new Map();
  for (const t of inventory.targets ?? []) for (const s of t.required_slots ?? []) slots.set(s.kind, [...new Set([...(slots.get(s.kind) ?? []), ...s.variants])]);
  return {
    themes: ['light', 'dark'],
    slots: [...slots].map(([kind, variants]) => ({ kind, variants })),
    layouts: targetsOf(inventory).map((t) => ({ target: t.target, layouts: layoutsOf(t) })),
  };
}
const layoutsOf = (t) => (DESKTOP.includes(t.target) ? [...DESKTOP_LAYOUTS] : [...(t.layouts ?? [])]);

// The design as objects: {design, tokens, flows, screens, navigation,
// criteria, mockups: {path: text|Buffer}, extra: {path: text|Buffer}}, every
// path relative to .surety/design/. The asset manifest is the engine's (no
// proposal): the design names it and does not write it.
export function designModel(inventory, { themes = ['light', 'dark'] } = {}) {
  const targets = targetsOf(inventory);
  assert.ok(targets.length > 0, `the inventory has targets (${JSON.stringify(inventory)})`);
  const uiInterfaces = (inventory.interfaces ?? []).map((i) => i.name);
  const keyOf = Object.fromEntries(targets.map((t, i) => [t.target, `S${i + 1}`]));
  const mockupOf = (t) => `mockups/${t.target}/${keyOf[t.target].toLowerCase()}.html`;
  const screens = targets.map((t) => ({
    key: keyOf[t.target],
    target: t.target,
    title: 'Pantry',
    flow_steps: ['F1.1', 'F1.2'],
    requirements: (inventory.ui_requirements ?? []).filter((r) => (r.targets ?? []).includes(t.target)).map((r) => r.key),
    interfaces: [...uiInterfaces],
    states: (inventory.obligations ?? []).filter((o) => o.target === t.target).map((o) => ({ obligation: o, mockup: mockupOf(t), fixture: fixtureFor(inventory, o) })),
    layouts: layoutsOf(t),
    inputs: [
      { interface: 'add-item', property: 'name', label: 'Item name' },
      { interface: 'add-item', property: 'quantity', label: 'Quantity (pcs)', unit: 'pcs' },
    ],
    conventions: conventionsFor(t.target, permissionsOf(inventory, t.target)),
  }));
  const mockupEntries = targets.map((t) => {
    const simulated = t.preview_capability === 'simulated';
    const entry = { path: mockupOf(t), kind: simulated ? 'simulated_html' : 'static_html', screens: [keyOf[t.target]], external_urls: [] };
    if (simulated) entry.simulates = { target: t.target, ...(MOBILE.includes(t.target) ? { form_factor: (t.form_factors ?? ['phone'])[0] } : {}), layout: layoutsOf(t)[0] };
    return entry;
  });
  const selection = defaultSelection(inventory);
  selection.themes = [...themes];
  const design = {
    version: 1,
    origin: 'intended',
    inventory_digest: inventory.inventory_digest,
    selection,
    targets: targets.map((t) => ({
      module: t.module,
      target: t.target,
      ui_technology: t.ui_technology,
      form_factors: t.form_factors ?? [],
      preview_capability: t.preview_capability,
      layouts: layoutsOf(t),
      ...(DESKTOP.includes(t.target) ? { window: { min: [...WINDOW.min], default: [...WINDOW.default] } } : {}),
    })),
    ...(inventory.cross_platform ? { cross_platform: { targets: targets.map((t) => t.target), differences: [] } } : {}),
    tokens_file: 'tokens.json',
    flows_file: 'flows.json',
    screens_file: 'screens.json',
    navigation_file: 'navigation.json',
    criteria_file: 'criteria.json',
    assets_file: 'assets/manifest.json',
    mockups: mockupEntries,
  };
  const tokens = clone(TOKENS);
  tokens.themes = Object.fromEntries(themes.map((th) => [th, TOKENS.themes[th]]));
  return {
    design,
    tokens,
    flows: {
      flows: [
        {
          key: 'F1',
          title: 'Keep the pantry',
          requirements: [...new Set(screens.flatMap((s) => s.requirements))],
          steps: [
            { key: 'F1.1', title: 'See the pantry', interfaces: ['list-items'] },
            { key: 'F1.2', title: 'Add an item', interfaces: ['add-item'] },
          ],
        },
      ],
    },
    screens: { screens },
    navigation: { targets: targets.map((t) => ({ target: t.target, entries: [keyOf[t.target]], edges: [] })) },
    criteria: {
      criteria: [],
      human_tests: targets.map((t) => ({
        target: t.target,
        text: `The ${t.target} UI matches approved design version 1: screen ${keyOf[t.target]}; ${notCheckableOf(inventory, t.target).join(', ')} are judged by a person${t.preview_capability === 'simulated' ? ', on an emulator, simulator or device and not on the simulated preview' : ''}.`,
        screens: [keyOf[t.target]],
        not_checkable_yet: notCheckableOf(inventory, t.target).map((convention) => ({ screen: keyOf[t.target], convention })),
      })),
    },
    mockups: Object.fromEntries(targets.map((t) => [mockupOf(t), mockupHtml(keyOf[t.target], t.target, t.preview_capability === 'simulated')])),
    extra: {},
    keyOf,
  };
}

// The model's files as {path under .surety/design/: text | Buffer}.
export function filesOf(model) {
  const files = {
    'design.json': json(model.design),
    'tokens.json': json(model.tokens),
    'flows.json': json(model.flows),
    'screens.json': json(model.screens),
    'navigation.json': json(model.navigation),
    'criteria.json': json(model.criteria),
    'design.md': '# Pantry: design\n\nOne flow, one screen per target.\n',
    ...model.mockups,
    ...model.extra,
  };
  return Object.fromEntries(Object.entries(files).map(([p, t]) => [`${DESIGN_DIR}${p}`, t]));
}

// A Designer turn writing the whole design: the mockups directory (where
// every case's extra files go) removed first, so no earlier turn's file is
// left; then every file of the model.
export function designTurnOf(model, { reply = 'The design is written.' } = {}) {
  const writes = Object.entries(filesOf(model)).map(([path, content]) => (Buffer.isBuffer(content) ? step.writeBytes(path, content) : step.write(path, content)));
  return { steps: [step.delete(`${DESIGN_DIR}mockups`), ...writes, step.result(turnResult({ reply, artifact_changed: true }))] };
}

// A copy of `model` changed by `edit(m)`.
export function variantOf(model, edit) {
  const m = clone(model);
  for (const [k, v] of Object.entries(model.mockups)) if (Buffer.isBuffer(v)) m.mockups[k] = Buffer.from(v);
  for (const [k, v] of Object.entries(model.extra)) if (Buffer.isBuffer(v)) m.extra[k] = Buffer.from(v);
  edit(m);
  return m;
}
export const screenOf = (m, key) => {
  const s = m.screens.screens.find((x) => x.key === key);
  assert.ok(s, `the design has screen ${key}`);
  return s;
};
export const screenOfTarget = (m, target) => {
  const s = m.screens.screens.find((x) => x.target === target);
  assert.ok(s, `the design has a ${target} screen`);
  return s;
};
export const targetEntry = (m, target) => m.design.targets.find((t) => t.target === target);
export const mockupEntry = (m, target) => m.design.mockups.find((x) => x.screens.includes(screenOfTarget(m, target).key));

// ---- the fault session ----------------------------------------------------------------------------

// One Designer session: for each element of `cases` ({name, model, before?}),
// `before` (a policy change, say) then a turn writing `model` and a save
// (SEAM.md §483). A last turn says nothing, so the last save's refusal is a
// turn's engine entry too. Returns {run, saves: [{name, res}]}; the session
// is left open.
// `run`: an open session to go on with (its earlier launches kept in the script).
export async function checkSession(fx, project, cases, { run: given } = {}) {
  const run = given ?? (await openDesigner(fx, project));
  const done = given ? fx.scripted.launches({ run: run.id }).length : 0;
  const talk = { steps: [step.result(turnResult({ reply: 'Read the engine\'s notes.' }))] };
  scriptTurns(fx, run.id, [...Array.from({ length: done }, () => talk), ...cases.map((c) => designTurnOf(c.model, { reply: `Written: ${c.name}.` })), talk]);
  const saves = [];
  for (const c of cases) {
    if (c.before) await c.before();
    await sayAndSettle(fx, project, run.id, `Draw it: ${c.name}.`);
    saves.push({ name: c.name, res: await postSaveRaw(fx, project, run.id), turn: done + saves.length + 1 });
  }
  await sayAndSettle(fx, project, run.id, 'What did the engine say?');
  return { run, saves };
}

// The design_check of a save's answer (SEAM.md §483).
export const checkOf = (res) => res?.body?.design_check ?? null;
export const reasonsOf = (res) => checkOf(res)?.reasons ?? [];
export const codesIn = (res) => reasonsOf(res).map((r) => r.code);
const show = (res) => `${res?.status} ${JSON.stringify(checkOf(res) ?? res?.body ?? res?.text)?.slice(0, 1500)}`;

// The save was answered 200 and its check refused naming `code` in a reason
// whose text holds every one of `names` (its subjects: the target and what
// it is about, SEAM.md §493).
export function assertReason(res, code, names, what) {
  assert.equal(res?.status, 200, `${what}: the save answers 200 with its check (SEAM.md §483) (→ ${show(res)})`);
  assert.equal(checkOf(res)?.outcome, 'refused', `${what}: the design check refused (→ ${show(res)})`);
  const hit = reasonsOf(res).find((r) => r.code === code && names.every((n) => JSON.stringify(r.subjects ?? r).includes(n)));
  assert.ok(hit, `${what}: ${code} naming ${names.join(', ')} (reasons: ${JSON.stringify(reasonsOf(res))})`);
  return hit;
}
export function assertPassed(res, what) {
  assert.equal(res?.status, 200, `${what}: the save answers 200 (→ ${show(res)})`);
  assert.equal(checkOf(res)?.outcome, 'passed', `${what}: the design check passed (→ ${show(res)})`);
  assert.deepEqual(reasonsOf(res), [], `${what}: no reason`);
}
export function assertNoReason(res, code, what) {
  assert.equal(res?.status, 200, `${what}: the save answers 200 (→ ${show(res)})`);
  assert.ok(checkOf(res), `${what}: the save carries its design_check (→ ${show(res)})`);
  assert.ok(!codesIn(res).includes(code), `${what}: no ${code} (reasons: ${JSON.stringify(reasonsOf(res))})`);
}

// The engine's transcript entries of turn `turn` of `run`, as one text.
export const engineEntryText = (home, run, turn) =>
  transcriptEntries(home, run)
    .filter((e) => e.speaker === 'engine' && e.turn === turn)
    .map((e) => e.text ?? '')
    .join('\n');

// The design_checks row (A.3) of an id.
export const designCheckRow = (home, id) => withStore(home, (db) => db.prepare('SELECT * FROM "design_checks" WHERE "id" = ?').get(id));

// ---- the plan check's reasons (D6 §5.3 clause 5, G2) ---------------------------------------------

export const latestPlanCheck = (home, project) => planChecks(home, project).at(-1) ?? null;
export const planSubjects = (check, code) => (check?.reasons ?? []).filter((r) => r.code === code).flatMap((r) => r.subjects ?? []);

// ---- binary files with valid headers (rule 22; nothing decoded) ----------------------------------

const pngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0);
  return Buffer.concat([len, typed, crc]);
};
// A flat PNG (truecolour, or with alpha), `pad` bytes of text chunk after it.
export function flatPng(w, h, { alpha = false, pad = 0 } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  const row = Buffer.alloc(1 + w * (alpha ? 4 : 3), 0x80);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw))];
  if (pad > 0) parts.push(pngChunk('tEXt', Buffer.concat([Buffer.from('Comment\0', 'latin1'), Buffer.alloc(pad, 0x61)])));
  parts.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
// A WebP whose VP8X header declares w x h; `pad` bytes of XMP after it.
export function webpOf(w, h, { pad = 0 } = {}) {
  const riffChunk = (fourcc, data) => {
    const hdr = Buffer.alloc(8);
    hdr.write(fourcc, 0, 'ascii');
    hdr.writeUInt32LE(data.length, 4);
    return Buffer.concat([hdr, data, Buffer.alloc(data.length % 2)]);
  };
  const vp8x = Buffer.alloc(10);
  vp8x.writeUIntLE(w - 1, 4, 3);
  vp8x.writeUIntLE(h - 1, 7, 3);
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), riffChunk('VP8X', vp8x), ...(pad > 0 ? [riffChunk('XMP ', Buffer.alloc(pad, 0x20))] : [])]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}
// An ICO holding one PNG image.
export function icoOf(png, w, h) {
  const header = Buffer.from([0, 0, 1, 0, 1, 0]);
  const entry = Buffer.alloc(16);
  entry[0] = w >= 256 ? 0 : w;
  entry[1] = h >= 256 ? 0 : h;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}
// A passive SVG (no script, event attribute or external reference), `pad` bytes of comment.
export const svgOf = (w, h, { pad = 0 } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#0b5cad"/>${pad > 0 ? `<!-- ${'x'.repeat(pad)} -->` : ''}</svg>\n`;

// ---- the batch of a design, approved through the owner's routes (D7 §7.1, §7.4) -------------------

// The batched spec change's version 2 for a variant (as slice 40's
// specV2For): each human test a requirement marked **Human test.** and
// **Surface:** ui (<target>), numbered after the requirements, in order.
// `version` above 2: the human tests' texts revised (a later design's batch),
// each change `text_changed`.
export function specV2With({ criteria, base, targets, modules, version = 2 }) {
  const reqs = base.map((r) => ({ ...r, criteria: [...r.criteria] }));
  const changes = [];
  const humanKeys = {};
  let next = reqs.length + 1;
  for (const c of criteria.criteria) {
    const r = reqs.find((x) => x.key === c.requirement);
    r.criteria.push({ id: `${r.key}.${r.criteria.length + 1}`, text: c.text });
    if (!changes.some((x) => x.key === r.key)) changes.push({ key: r.key, kind: 'criteria_added', reason: 'the approved design\'s criteria' });
  }
  for (const h of criteria.human_tests) {
    const key = `R${next++}`;
    humanKeys[h.target] = key;
    reqs.push({ key, title: `The ${h.target} UI matches the approved design`, phase: 1, surface: `ui (${h.target})`, statement: `A person judges the ${h.target} UI against the approved design.`, human_test: h.text, criteria: [] });
    changes.push({ key, kind: version > 2 ? 'text_changed' : 'added', reason: `the ${h.target} human test of the approved design` });
  }
  const log = [{ version: 2, date: '2026-10-16', change: 'The approved design\'s criteria and human tests', by: 'Sean' }];
  if (version > 2) log.push({ version, date: '2026-10-16', change: 'The revised design\'s human tests', by: 'Sean' });
  const text = specText({ version, requirements: reqs, targets, modules, changeLog: log });
  return { text, changes, humanKeys, requirements: reqs };
}

// The roles of a published variant scripted as the journey's (slice 40's
// designScripts), the batch's Spec Writer writing `v2`; the kernel context.
export function scriptVariant(fx, p, v2) {
  designScripts(fx);
  if (v2) fx.scripted.kindScript('spec_change', specChangeScriptFor(v2));
  scriptBuilders(fx, p.id);
  const ctx = journeyContext(fx, p, { lane: 'kernel' });
  ctx.answerKinds = [...KERNEL_KINDS];
  return ctx;
}

// The batch once raised: {design_approval, spec_change, batch_key, members}.
export const untilBatch = (fx, ctx, { max = 40 } = {}) =>
  pump(fx, ctx, () => {
    const b = batchOf(fx.home, ctx.project);
    return b?.spec_change ? b : undefined;
  }, { what: 'the batch to be raised', max });
export const approvedRevision = (home, project) => designRevisions(home, project).find((r) => ['approved', 'approved_without_criteria'].includes(r.status)) ?? null;

// Both members answered `approve` through the owner's route; the effect awaited.
export async function approveBatch(fx, ctx, batch, extra = {}) {
  const a = await answerWith(fx, ctx.project, batch.design_approval, 'approve', extra);
  assert.equal(a.status, 200, `design_approval answered approve (${a.text})`);
  await consume(fx, ctx.project, batch.spec_change, 'approve');
  return pump(fx, ctx, () => approvedRevision(fx.home, ctx.project) ?? undefined, { what: 'the design approved', max: 20 });
}

// The current inventory and manifest at the head (slice 40's reads).
export const inventoryNow = (p) => inventoryOf(p);
export const manifestNow = (p) => manifestOf(p);
