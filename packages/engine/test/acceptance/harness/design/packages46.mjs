// What the Designer's and the Verifier's packages say the engine reads
// (M6 slice 46, row M537; D7 §3.4, §8.4; E151; E135; BS6 §12; SEAM.md
// §§537 to 539).
//
// Each element is a `json surety-reads <id>` block of the package's
// prompt.md, listed in its manifest's `reads` (SEAM.md §453's form, M442's
// reading: harness/real/packages.mjs `packageReads`). This module names the
// elements each package must carry, checks each element's JSON against what
// D7 fixes and the engine's checks read (the shapes SEAM.md §538 pins), and
// judges a design product (or a correction's checks) against what the whole
// package states (SEAM.md §539): the rehearsal's judgement of the
// package-driven Designer fake (harness/standin/package-fakes.cjs).
//
// The closed lists below are D7's (A.2, A.4, §5.3, §5.4, §6.2, §7.2, B.8 to
// B.16) as the engine's own constants hold them (src/design/check.ts,
// inventory.ts, approval.ts, assets.ts), copied here as M442 copied D6's: a
// package that states a different list fails.
//
// Pure: no engine, no process, no file.

import { packageReads } from '../real/packages.mjs';

// ---- the elements each package carries (SEAM.md §538) -------------------------------------

export const DESIGNER_ELEMENTS = Object.freeze([
  'designer.inventory',
  'designer.schemas',
  'designer.check_reasons',
  'designer.conventions',
  'designer.criterion_catalogue',
  'designer.mockup_kinds',
  'designer.selection_floor',
  'designer.external_urls',
  'designer.layouts',
]);
export const DESIGNER_REVIEW_ELEMENTS = Object.freeze([...DESIGNER_ELEMENTS, 'designer.review']);
export const DESIGNER_RETROFIT_ELEMENTS = Object.freeze([...DESIGNER_ELEMENTS, 'designer.retrofit']);
export const VERIFIER_DESIGN_ELEMENTS = Object.freeze(['verifier.design_catalogue']);
export const M6_ELEMENTS = Object.freeze([...DESIGNER_ELEMENTS, 'designer.review', 'designer.retrofit', ...VERIFIER_DESIGN_ELEMENTS]);

// ---- D7's closed lists, as the engine holds them ----------------------------------------------

export const TARGETS = Object.freeze(['web', 'android', 'ios', 'macos', 'windows', 'linux']);
export const MOCKUP_KINDS = Object.freeze(['static_html', 'scene_html', 'simulated_html', 'image', 'source_stub']);
export const NAV_KINDS = Object.freeze(['push', 'replace', 'modal', 'sheet', 'tab', 'back', 'deep_link', 'menu', 'shortcut', 'window']);
export const NATIVE_CONVENTIONS = Object.freeze(['browser_back', 'keyboard_path', 'system_back', 'safe_area', 'permission_prompt', 'touch_interaction', 'platform_navigation', 'window_resize', 'menu_entries', 'keyboard_shortcuts']);
export const ASSET_KINDS = Object.freeze(['logo', 'app_icon', 'favicon', 'banner', 'splash', 'illustration', 'image']);
export const ASSET_VARIANTS = Object.freeze(['full', 'compact', 'monochrome', 'on_light', 'on_dark', 'adaptive_foreground', 'adaptive_background', 'default']);
export const ASSET_STATUSES = Object.freeze(['placeholder', 'proposed', 'approved']);
export const REVIEW_VERDICTS = Object.freeze(['matches', 'deltas', 'not_observed']);
const CSS_TECH = Object.freeze(['html_css', 'three_js']);
// D7 §7.2: the catalogue. `all` may be stated as the word or as the full list.
export const CATALOGUE = Object.freeze({
  tokens_only: { targets: ['web'], technologies: CSS_TECH },
  layout_at_width: { targets: ['web'], technologies: CSS_TECH },
  label_with_unit: { targets: ['web'], technologies: CSS_TECH },
  focus_visible: { targets: ['web'], technologies: CSS_TECH },
  reduced_motion: { targets: ['web'], technologies: CSS_TECH },
  token_parity: { targets: 'all', technologies: 'all' },
  contrast_aa: { targets: 'all', technologies: 'all' },
  state_marker_present: { targets: 'all', technologies: 'all' },
  asset_parity: { targets: 'all', technologies: 'all' },
  human: { targets: 'all', technologies: 'all' },
});
// D7 §5.3 as the design check requires it (src/design/inventory.ts
// requiredConventions): `route|transient` is either field; `permissions`
// only where the target has a platform permission; `back` not on a root.
export const REQUIRED_CONVENTIONS = Object.freeze({
  web: ['route|transient', 'browser_back', 'keyboard_path'],
  android: ['back', 'gestures'],
  ios: ['container', 'edge_swipe_back', 'safe_area_edges'],
  macos: ['window_min', 'menu_entries', 'shortcuts'],
  windows: ['window_min', 'menu_entries', 'shortcuts'],
  linux: ['window_min', 'menu_entries', 'shortcuts'],
});
export const IF_PERMISSIONS = Object.freeze(['android', 'ios']);
// B.12: the convention fields applicable to each target (src/design/check.ts CONVENTION_TARGETS).
export const CONVENTION_FIELDS = Object.freeze({
  web: ['route', 'transient', 'browser_back', 'keyboard_path', 'hover', 'context_menu'],
  android: ['back', 'permissions', 'gestures'],
  ios: ['container', 'edge_swipe_back', 'safe_area_edges', 'permissions', 'gestures'],
  macos: ['window_min', 'menu_entries', 'shortcuts', 'hover', 'context_menu', 'permissions'],
  windows: ['window_min', 'menu_entries', 'shortcuts', 'hover', 'context_menu'],
  linux: ['window_min', 'menu_entries', 'shortcuts', 'hover', 'context_menu'],
});
// D7 §5.3's "not checkable" column (src/design/approval.ts NOT_CHECKABLE_CONVENTIONS).
export const NOT_CHECKABLE = Object.freeze({
  web: ['browser_back', 'keyboard_path'],
  android: ['system_back', 'permission_prompt', 'touch_interaction'],
  ios: ['platform_navigation', 'safe_area', 'permission_prompt'],
  macos: ['window_resize', 'menu_entries', 'keyboard_shortcuts'],
  windows: ['window_resize', 'menu_entries', 'keyboard_shortcuts'],
  linux: ['window_resize', 'menu_entries', 'keyboard_shortcuts'],
});
// D7 A.4: the design check's reasons and the assets' (what a Designer's save can draw).
export const DESIGN_CHECK_REASONS = Object.freeze([
  'DESIGN_SCHEMA_INVALID', 'DESIGN_INVENTORY_STALE', 'DESIGN_INVENTORY_MODIFIED', 'DESIGN_UNKNOWN_REQUIREMENT', 'DESIGN_UNKNOWN_INTERFACE', 'DESIGN_UNKNOWN_TARGET',
  'DESIGN_MOCKUP_MISSING', 'DESIGN_MOCKUP_ORPHAN', 'DESIGN_REQUIREMENT_UNCOVERED', 'DESIGN_STATE_UNCOVERED', 'DESIGN_LAYOUT_UNCOVERED', 'DESIGN_INPUT_UNLABELLED',
  'DESIGN_NAV_UNKNOWN_SCREEN', 'DESIGN_SCREEN_UNREACHABLE', 'DESIGN_CONVENTION_UNDECLARED', 'DESIGN_CONVENTION_UNKNOWN', 'DESIGN_SHORTCUT_DUPLICATE', 'DESIGN_TARGET_DIVERGENCE_UNSTATED',
  'DESIGN_TOKEN_UNDEFINED', 'DESIGN_CONTRAST_BELOW_AA', 'DESIGN_AXIS_MISMATCH', 'DESIGN_MOCKUP_KIND_MISMATCH', 'DESIGN_SIMULATION_UNDECLARED', 'DESIGN_EXTERNAL_URL_UNPINNED',
  'DESIGN_CRITERION_UNCHECKABLE', 'DESIGN_CRITERION_NOT_APPLICABLE', 'DESIGN_FIXTURE_INVALID', 'DESIGN_INTERFACE_DISPUTED', 'DESIGN_INTERFACE_SHAPE_UNKNOWN',
]);
export const ASSET_REASONS = Object.freeze([
  'DESIGN_ASSET_SLOT_MISSING', 'DESIGN_ASSET_PLATFORM_UNKNOWN', 'DESIGN_ASSET_PLACEMENT_MISSING', 'DESIGN_ASSET_ALT_MISSING', 'DESIGN_ASSET_FILE_MISSING', 'DESIGN_ASSET_FORMAT_MISMATCH',
  'DESIGN_ASSET_SIZE_MISMATCH', 'DESIGN_ASSET_TRANSPARENCY_MISMATCH', 'DESIGN_ASSET_SVG_ACTIVE', 'DESIGN_ASSET_STATUS_FORGED', 'DESIGN_ASSET_VERSION_INVALID', 'DESIGN_SELECTION_BELOW_FLOOR',
]);
export const AA_RATIO = 4.5;
// D7 §6.2 (src/design/assets.ts DEFAULT_SLOTS): the default slots of a target, by kind and variant.
export function defaultSlotsOf(target) {
  const out = [{ kind: 'logo', variants: ['full', 'compact', 'monochrome', 'on_light', 'on_dark'] }];
  if (target === 'web') out.push({ kind: 'favicon', variants: ['default'] });
  else out.push({ kind: 'app_icon', variants: target === 'android' ? ['default', 'adaptive_foreground', 'adaptive_background'] : ['default'] });
  if (target === 'ios') out.push({ kind: 'splash', variants: ['default'] });
  return out;
}
export const floorKindOf = (target) => (target === 'web' ? 'favicon' : 'app_icon');

// B.8 to B.16: each closed object's fields at a path of its JSON Schema
// (`a.b[]` the items of the array property b of a), and the enums read.
export const SCHEMA_EXPECTED = Object.freeze([
  { id: 'B.8', name: 'shape', fields: { '': ['type', 'properties', 'required', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'items', 'collection', 'unit'] } },
  {
    id: 'B.9',
    file: '.surety/design/inventory/inventory.json',
    fields: {
      '': ['inventory_digest', 'spec_version', 'architecture_version', 'targets', 'cross_platform', 'ui_requirements', 'interfaces', 'obligations', 'fixtures'],
      'targets[]': ['module', 'target', 'ui_technology', 'form_factors', 'preview_capability', 'layouts', 'required_conventions', 'permissions', 'required_slots', 'adrs', 'runtime'],
    },
  },
  {
    id: 'B.10',
    file: '.surety/design/design.json',
    fields: {
      '': ['version', 'origin', 'inventory_digest', 'selection', 'targets', 'cross_platform', 'tokens_file', 'flows_file', 'screens_file', 'navigation_file', 'criteria_file', 'assets_file', 'mockups'],
      selection: ['themes', 'slots', 'layouts'],
      'targets[]': ['module', 'target', 'ui_technology', 'form_factors', 'preview_capability', 'layouts', 'window'],
      'mockups[]': ['path', 'kind', 'screens', 'simulates', 'external_urls'],
    },
    required: { '': ['version', 'origin', 'inventory_digest', 'selection', 'targets', 'tokens_file', 'flows_file', 'screens_file', 'navigation_file', 'criteria_file', 'assets_file', 'mockups'] },
    enums: { 'mockups[].kind': MOCKUP_KINDS },
  },
  { id: 'B.11', file: '.surety/design/tokens.json', fields: { '': ['unit', 'themes', 'type', 'space', 'radius', 'duration', 'pairs'], 'pairs[]': ['text', 'background'] } },
  { id: 'B.12', file: '.surety/design/flows.json', fields: { '': ['flows'], 'flows[]': ['key', 'title', 'requirements', 'steps'], 'flows[].steps[]': ['key', 'title', 'requirement', 'interfaces'] } },
  {
    id: 'B.12',
    file: '.surety/design/screens.json',
    fields: {
      '': ['screens'],
      'screens[]': ['key', 'target', 'title', 'flow_steps', 'requirements', 'interfaces', 'states', 'layouts', 'inputs', 'conventions', 'notes'],
      'screens[].states[]': ['obligation', 'mockup', 'fixture'],
      'screens[].inputs[]': ['interface', 'property', 'label', 'unit'],
      'screens[].conventions': ['route', 'transient', 'browser_back', 'keyboard_path', 'back', 'container', 'edge_swipe_back', 'safe_area_edges', 'permissions', 'gestures', 'window_min', 'menu_entries', 'shortcuts', 'hover', 'context_menu'],
    },
    enums: { 'screens[].target': TARGETS },
  },
  { id: 'B.12', name: 'turn_result', fieldsAtLeast: { '': ['reply', 'artifact_changed', 'questions_for_owner', 'done', 'findings'] }, fieldsAtMost: { '': ['status', 'summary', 'reply', 'artifact_changed', 'questions_for_owner', 'done', 'findings'] } },
  {
    id: 'B.13',
    file: '.surety/design/criteria.json',
    fields: { '': ['criteria', 'human_tests'], 'criteria[]': ['requirement', 'text', 'kind', 'targets', 'paths', 'width', 'slot', 'variant'], 'human_tests[]': ['target', 'text', 'screens', 'not_checkable_yet'] },
    enums: { 'criteria[].kind': Object.keys(CATALOGUE) },
  },
  {
    id: 'B.14',
    file: '.surety/design/reviews/review-<n>.json',
    fields: {
      '': ['design_version', 'subject', 'screens', 'revised_design', 'first_design'],
      subject: ['kind', 'candidate', 'target', 'build_ref'],
      'screens[]': ['target', 'key', 'verdict', 'observed_on', 'not_observed_reason', 'evidence', 'deltas'],
      'screens[].deltas[]': ['state', 'owner_words', 'kind'],
    },
    enums: { 'screens[].verdict': REVIEW_VERDICTS },
  },
  { id: 'B.15', file: '.surety/design/navigation.json', fields: { '': ['targets'], 'targets[]': ['target', 'entries', 'edges'], 'targets[].edges[]': ['from', 'to', 'trigger', 'kind'] }, enums: { 'targets[].edges[].kind': NAV_KINDS } },
  {
    id: 'B.16',
    file: '.surety/design/assets/manifest.json',
    fields: {
      '': ['version', 'slots', 'packaging'],
      'slots[]': ['key', 'kind', 'purpose', 'platforms', 'placement', 'screens', 'variants', 'alt_text', 'decorative', 'slot_version', 'status', 'provenance', 'status_since', 'history'],
      'slots[].variants[]': ['name', 'format', 'size', 'transparency', 'file', 'digest'],
      'packaging[]': ['target', 'slot', 'requirement', 'guidance', 'status'],
    },
    enums: { 'slots[].kind': ASSET_KINDS, 'slots[].variants[].name': ASSET_VARIANTS, 'slots[].status': ASSET_STATUSES },
  },
]);

// ---- reading a JSON Schema ------------------------------------------------------------------

// The subschema at `path` ('' the root; `a.b[]` a's property b's items).
export function schemaAt(schema, path) {
  let s = schema;
  if (path === '') return s ?? null;
  for (const seg of path.split('.')) {
    const arr = seg.endsWith('[]');
    const name = arr ? seg.slice(0, -2) : seg;
    s = s?.properties?.[name] ?? null;
    if (arr) s = s?.items ?? null;
    if (!s) return null;
  }
  return s;
}
const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && b.every((x) => a.includes(x));
const sorted = (a) => [...(a ?? [])].sort();
// Every object schema with `properties` closed (additionalProperties false), recursively.
function openObjects(schema, at = '', out = []) {
  if (!schema || typeof schema !== 'object') return out;
  if (schema.properties && schema.additionalProperties !== false) out.push(at || '(root)');
  for (const [k, v] of Object.entries(schema.properties ?? {})) openObjects(v, at ? `${at}.${k}` : k, out);
  if (schema.items) openObjects(schema.items, `${at}[]`, out);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') openObjects(schema.additionalProperties, `${at}{}`, out);
  for (const k of ['anyOf', 'oneOf']) for (const [i, v] of (schema[k] ?? []).entries()) openObjects(v, `${at}<${k}${i}>`, out);
  return out;
}
const enumAt = (schema, path) => {
  const i = path.lastIndexOf('.');
  const owner = schemaAt(schema, i < 0 ? '' : path.slice(0, i));
  const leaf = owner?.properties?.[i < 0 ? path : path.slice(i + 1)];
  return leaf?.enum ?? leaf?.items?.enum ?? null;
};

// ---- the problems of each element's JSON (SEAM.md §538) ---------------------------------------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' && v.trim().length > 0;
const appliesAll = (v) => v === 'all';

// facts: {inventory, digest, targets: [{module, target, ui_technology, preview_capability}],
// widths, orientations, allowlist, review: {build_ref, evidence: [ids]} | null,
// sourcePaths: [..] | null, criteria: [{id, kind, targets, paths, slot?, variant?}] | null}
export function elementProblems(id, v, facts = {}) {
  const p = [];
  const need = (cond, what) => {
    if (!cond) p.push(what);
  };
  if (v === undefined) return [`no block (\`json surety-reads ${id}\`)`];
  switch (id) {
    case 'designer.inventory': {
      need(v.file === '.surety/design/inventory/inventory.json', `file .surety/design/inventory/inventory.json (got ${JSON.stringify(v.file)})`);
      need(isObj(v.inventory), 'inventory: the inventory (B.9)');
      if (facts.digest) need(v.inventory_digest === facts.digest && v.inventory?.inventory_digest === facts.digest, `inventory_digest the project's current one ${facts.digest} (got ${v.inventory_digest} / ${v.inventory?.inventory_digest})`);
      if (facts.inventory) need(JSON.stringify(v.inventory) === JSON.stringify(facts.inventory), 'inventory: the committed inventory.json, as committed');
      break;
    }
    case 'designer.schemas': {
      const list = Array.isArray(v.schemas) ? v.schemas : [];
      for (const ex of SCHEMA_EXPECTED) {
        const s = list.find((x) => x?.id === ex.id && (ex.file ? x.file === ex.file : x.name === ex.name));
        const label = `${ex.id} ${ex.file ?? ex.name}`;
        if (!s || !isObj(s.schema)) {
          p.push(`${label}: its schema`);
          continue;
        }
        const open = openObjects(s.schema);
        if (open.length > 0) p.push(`${label}: every object closed (additionalProperties false) (open at ${open.join(', ')})`);
        for (const [at, fields] of Object.entries(ex.fields ?? {})) {
          const got = Object.keys(schemaAt(s.schema, at)?.properties ?? {});
          if (!sameSet(got, fields)) p.push(`${label} ${at || '(root)'}: the fields ${JSON.stringify(sorted(fields))} (got ${JSON.stringify(sorted(got))})`);
        }
        for (const [at, fields] of Object.entries(ex.fieldsAtLeast ?? {})) {
          const got = Object.keys(schemaAt(s.schema, at)?.properties ?? {});
          const missing = fields.filter((f) => !got.includes(f));
          const extra = got.filter((f) => !(ex.fieldsAtMost?.[at] ?? got).includes(f));
          if (missing.length > 0 || extra.length > 0) p.push(`${label} ${at || '(root)'}: the fields ${JSON.stringify(fields)} (missing ${JSON.stringify(missing)}, unknown ${JSON.stringify(extra)})`);
        }
        for (const [at, req] of Object.entries(ex.required ?? {})) {
          const got = schemaAt(s.schema, at)?.required ?? [];
          const missing = req.filter((f) => !got.includes(f));
          if (missing.length > 0) p.push(`${label} ${at || '(root)'}: required ${JSON.stringify(missing)}`);
        }
        for (const [at, values] of Object.entries(ex.enums ?? {})) {
          const got = enumAt(s.schema, at);
          if (!sameSet(got, values)) p.push(`${label} ${at}: the enum ${JSON.stringify(values)} (got ${JSON.stringify(got)})`);
        }
      }
      break;
    }
    case 'designer.check_reasons': {
      const list = Array.isArray(v.reasons) ? v.reasons : [];
      const codes = list.map((r) => r?.code);
      const missing = [...DESIGN_CHECK_REASONS, ...ASSET_REASONS].filter((c) => !codes.includes(c));
      need(missing.length === 0, `every reason of D7 A.4's design check and assets (missing ${JSON.stringify(missing)})`);
      const mute = list.filter((r) => !text(r?.meaning)).map((r) => r?.code);
      need(mute.length === 0, `each reason with what it means (none for ${JSON.stringify(mute)})`);
      const aa = list.find((r) => r?.code === 'DESIGN_CONTRAST_BELOW_AA');
      need(aa?.ratio === AA_RATIO, `DESIGN_CONTRAST_BELOW_AA with its ratio ${AA_RATIO} (got ${JSON.stringify(aa?.ratio)})`);
      break;
    }
    case 'designer.conventions': {
      need(v.reason === 'DESIGN_CONVENTION_UNDECLARED', 'reason DESIGN_CONVENTION_UNDECLARED');
      const list = Array.isArray(v.targets) ? v.targets : [];
      for (const t of TARGETS) {
        const e = list.find((x) => x?.target === t);
        if (!e) {
          p.push(`target ${t}`);
          continue;
        }
        if (!sameSet(e.required, REQUIRED_CONVENTIONS[t])) p.push(`${t}: required ${JSON.stringify(REQUIRED_CONVENTIONS[t])} (got ${JSON.stringify(e.required)})`);
        if (IF_PERMISSIONS.includes(t) ? e.if_permissions !== 'permissions' : e.if_permissions !== undefined) p.push(`${t}: if_permissions ${IF_PERMISSIONS.includes(t) ? '"permissions"' : 'absent'} (got ${JSON.stringify(e.if_permissions)})`);
        if (!sameSet(e.fields, CONVENTION_FIELDS[t])) p.push(`${t}: fields ${JSON.stringify(CONVENTION_FIELDS[t])} (got ${JSON.stringify(e.fields)})`);
        if (!sameSet(e.not_checkable_yet, NOT_CHECKABLE[t])) p.push(`${t}: not_checkable_yet ${JSON.stringify(NOT_CHECKABLE[t])} (got ${JSON.stringify(e.not_checkable_yet)})`);
      }
      need(isObj(v.cross_platform) && sameSet(v.cross_platform.difference, ['target', 'what', 'why']) && v.cross_platform.reason === 'DESIGN_TARGET_DIVERGENCE_UNSTATED', `cross_platform {difference: [target, what, why], reason: DESIGN_TARGET_DIVERGENCE_UNSTATED} (got ${JSON.stringify(v.cross_platform)})`);
      break;
    }
    case 'designer.criterion_catalogue': {
      const list = Array.isArray(v.kinds) ? v.kinds : [];
      need(sameSet(list.map((k) => k?.kind), Object.keys(CATALOGUE)), `the kinds ${JSON.stringify(Object.keys(CATALOGUE))} (got ${JSON.stringify(list.map((k) => k?.kind))})`);
      for (const [kind, ex] of Object.entries(CATALOGUE)) {
        const e = list.find((k) => k?.kind === kind);
        if (!e) continue;
        for (const axis of ['targets', 'technologies']) {
          const ok = ex[axis] === 'all' ? appliesAll(e[axis]) || (axis === 'targets' && sameSet(e[axis], TARGETS)) || (axis === 'technologies' && Array.isArray(e[axis]) && CSS_TECH.every((t) => e[axis].includes(t))) : sameSet(e[axis], ex[axis]);
          if (!ok) p.push(`${kind}: ${axis} ${JSON.stringify(ex[axis])} (got ${JSON.stringify(e[axis])})`);
        }
        if (!text(e.reads)) p.push(`${kind}: what its check reads`);
      }
      need(sameSet(v.native_conventions, NATIVE_CONVENTIONS), `native_conventions ${JSON.stringify(NATIVE_CONVENTIONS)} (got ${JSON.stringify(v.native_conventions)})`);
      need(v.not_applicable === 'DESIGN_CRITERION_NOT_APPLICABLE' && v.hint === 'not_checkable_yet', 'not_applicable DESIGN_CRITERION_NOT_APPLICABLE with the hint not_checkable_yet');
      need(text(v.paths_rule), 'paths_rule: a criterion that reads files names the implemented paths');
      break;
    }
    case 'designer.mockup_kinds': {
      const by = isObj(v.by_capability) ? v.by_capability : {};
      need(sameSet((v.kinds ?? []).map((k) => k?.kind), MOCKUP_KINDS), `the kinds ${JSON.stringify(MOCKUP_KINDS)}`);
      const native = by.native ?? [];
      const simulated = by.simulated ?? [];
      need(['static_html', 'image', 'source_stub'].every((k) => native.includes(k)) && !native.includes('simulated_html'), `native admits static_html, image, source_stub and not simulated_html (got ${JSON.stringify(native)})`);
      need(['simulated_html', 'image', 'source_stub'].every((k) => simulated.includes(k)) && !simulated.includes('static_html') && !simulated.includes('scene_html'), `simulated admits simulated_html, image, source_stub and neither static_html nor scene_html (got ${JSON.stringify(simulated)})`);
      need(sameSet(by.none, ['image', 'source_stub']), `none admits image and source_stub only (got ${JSON.stringify(by.none)})`);
      const sim = v.simulation;
      need(isObj(sim) && sim.kind === 'simulated_html' && sim.declares === 'simulates' && sim.reason === 'DESIGN_SIMULATION_UNDECLARED' && /simulat/i.test(sim.rule ?? '') && /declare/i.test(sim.rule ?? ''), `simulation {kind: simulated_html, declares: simulates, reason: DESIGN_SIMULATION_UNDECLARED, rule: an HTML mockup of a non-web target is a simulation and must be declared one} (got ${JSON.stringify(sim)})`);
      for (const t of facts.targets ?? []) {
        const c = (v.capabilities ?? []).find((x) => x?.target === t.target && x?.module === t.module);
        if (c?.preview_capability !== t.preview_capability) p.push(`capabilities: ${t.module} ${t.target} ${t.preview_capability} (got ${JSON.stringify(c)})`);
      }
      break;
    }
    case 'designer.selection_floor': {
      const d = v.defaults ?? {};
      need(sameSet(d.themes, ['light', 'dark']), `defaults.themes light, dark (got ${JSON.stringify(d.themes)})`);
      for (const t of facts.targets ?? []) {
        const got = (d.slots ?? []).filter((s) => s?.target === t.target).map((s) => `${s.kind}:${sorted(s.variants).join('|')}`);
        const want = defaultSlotsOf(t.target).map((s) => `${s.kind}:${sorted(s.variants).join('|')}`);
        if (!sameSet(got, want)) p.push(`defaults.slots of ${t.target} ${JSON.stringify(want)} (got ${JSON.stringify(got)})`);
      }
      const f = v.floor ?? {};
      need(f.themes === 1 && f.layouts_per_target === 1 && f.logo_variants === 1, `floor themes 1, layouts_per_target 1, logo_variants 1 (got ${JSON.stringify(f)})`);
      for (const t of facts.targets ?? []) {
        const e = (f.per_target ?? []).find((x) => x?.target === t.target);
        if (e?.kind !== floorKindOf(t.target) || e?.variants !== 1) p.push(`floor.per_target ${t.target}: ${floorKindOf(t.target)} with one variant (got ${JSON.stringify(e)})`);
      }
      need(v.reason === 'DESIGN_SELECTION_BELOW_FLOOR', 'reason DESIGN_SELECTION_BELOW_FLOOR');
      need(text(v.narrowing), 'narrowing: the owner\'s act at design_approval');
      break;
    }
    case 'designer.external_urls': {
      need(v.field === 'external_urls', 'field external_urls');
      if (facts.allowlist) need(sameSet(v.allowlist, facts.allowlist), `allowlist the project's design_external_urls ${JSON.stringify(facts.allowlist)} (got ${JSON.stringify(v.allowlist)})`);
      need(v.version_pattern === '@<major>.<minor>.<patch>', `version_pattern @<major>.<minor>.<patch> (got ${JSON.stringify(v.version_pattern)})`);
      need(v.reason === 'DESIGN_EXTERNAL_URL_UNPINNED' && text(v.rule), 'reason DESIGN_EXTERNAL_URL_UNPINNED and the rule');
      break;
    }
    case 'designer.layouts': {
      if (facts.widths) need(sameSet(v.widths, facts.widths), `widths the project's design_widths ${JSON.stringify(facts.widths)} (got ${JSON.stringify(v.widths)})`);
      if (facts.orientations) need(sameSet(v.orientations, facts.orientations), `orientations ${JSON.stringify(facts.orientations)} (got ${JSON.stringify(v.orientations)})`);
      for (const t of facts.targets ?? []) {
        const e = (v.targets ?? []).find((x) => x?.target === t.target && x?.module === t.module);
        if (JSON.stringify(e?.layouts) !== JSON.stringify(t.layouts)) p.push(`${t.module} ${t.target}: layouts ${JSON.stringify(t.layouts)} (got ${JSON.stringify(e?.layouts)})`);
      }
      need(text(v.rule), 'rule: every screen declares every selected layout of its target');
      break;
    }
    case 'designer.review': {
      need(isObj(v.files) && ['review', 'approved', 'source', 'check_results', 'observations', 'evidence'].every((k) => text(v.files[k])), `files: review, approved, source, check_results, observations, evidence (got ${JSON.stringify(v.files)})`);
      need(isObj(v.provenance) && ['engine_observed', 'owner_supplied', 'owner_reported'].every((k) => text(v.provenance[k])), 'provenance: engine_observed, owner_supplied, owner_reported, each what it means');
      need(text(v.verdicts) && /propos/i.test(v.verdicts), 'verdicts: proposals the owner confirms');
      need(text(v.simulation), 'simulation: a verdict on a simulation is never native evidence');
      if (facts.review) {
        const o = v.owner;
        need(isObj(o) && isObj(o.build_ref) && o.build_ref.value === facts.review.build_ref && o.build_ref.provenance === 'owner_reported', `owner.build_ref {value: ${JSON.stringify(facts.review.build_ref)} verbatim, provenance: owner_reported} (got ${JSON.stringify(o?.build_ref)})`);
        const ev = Array.isArray(o?.evidence) ? o.evidence : [];
        need(sameSet(ev.map((e) => e?.id), facts.review.evidence), `owner.evidence the review's evidence ${JSON.stringify(facts.review.evidence)} (got ${JSON.stringify(ev.map((e) => e?.id))})`);
        const unlabelled = ev.filter((e) => e?.provenance !== 'owner_supplied').map((e) => e?.id);
        need(unlabelled.length === 0, `each owner evidence item labelled owner_supplied (not ${JSON.stringify(unlabelled)})`);
        need(Array.isArray(v.observations) && v.observations.length === 0, 'observations: none (the engine observed nothing of an owner build)');
      }
      break;
    }
    case 'designer.retrofit': {
      need(v.origin === 'observed', 'origin observed');
      need(Array.isArray(v.ui_source), 'ui_source: the UI source paths');
      if (facts.sourcePaths) need(sameSet(v.ui_source, facts.sourcePaths), `ui_source the package's design/source/ files ${JSON.stringify(facts.sourcePaths)} (got ${JSON.stringify(v.ui_source)})`);
      need(sameSet(v.reasons, ['DESIGN_CONVENTION_UNKNOWN', 'DESIGN_INTERFACE_SHAPE_UNKNOWN']), 'reasons DESIGN_CONVENTION_UNKNOWN, DESIGN_INTERFACE_SHAPE_UNKNOWN');
      need(isObj(v.assets) && v.assets.provenance === 'observed' && v.assets.status === 'proposed', 'assets {provenance: observed, status: proposed}');
      need(text(v.criteria), 'criteria: scheduled to the first change phase, never the conformance set');
      break;
    }
    case 'verifier.design_catalogue': {
      const list = Array.isArray(v.kinds) ? v.kinds : [];
      need(sameSet(list.map((k) => k?.kind), Object.keys(CATALOGUE)), `the kinds ${JSON.stringify(Object.keys(CATALOGUE))}`);
      for (const [kind, ex] of Object.entries(CATALOGUE)) {
        const e = list.find((k) => k?.kind === kind);
        if (e && ex.targets !== 'all' && !(sameSet(e.targets, ex.targets) && sameSet(e.technologies, ex.technologies))) p.push(`${kind}: where it applies ${JSON.stringify(ex)} (got ${JSON.stringify({ targets: e.targets, technologies: e.technologies })})`);
        if (e && !text(e.reads)) p.push(`${kind}: what its check reads`);
      }
      const ai = v.asset_inputs;
      need(isObj(ai) && ai.member === 'asset_inputs' && sameSet(Object.keys(ai.item ?? {}), ['slot', 'variant']) && ai.variable === 'SURETY_ASSET_<SLOT>_<VARIANT>', `asset_inputs {member: asset_inputs, item: {slot, variant}, variable: SURETY_ASSET_<SLOT>_<VARIANT>} (got ${JSON.stringify(ai)})`);
      // The programs a design check's command names first (objection 201): the governed
      // file's check_commands, or null where the governed values cannot be read.
      const cmd = v.command;
      need(isObj(cmd) && cmd.member === 'command' && (cmd.programs === null || (Array.isArray(cmd.programs) && cmd.programs.every((x) => typeof x === 'string' && x.length > 0))) && text(cmd.rule), `command {member: command, programs: [names] or null, rule} (got ${JSON.stringify(cmd)})`);
      const got = Array.isArray(v.criteria) ? v.criteria : null;
      need(got !== null, 'criteria: the design criteria with their implemented paths');
      if (facts.criteria && got) {
        const show = (c) => `${c.id}:${c.kind}:${sorted(c.targets).join('|')}:${(c.paths ?? []).join('|')}:${c.slot ?? ''}:${c.variant ?? ''}`;
        const want = facts.criteria.map(show);
        const have = got.map(show);
        if (!sameSet(have, want)) p.push(`criteria ${JSON.stringify(want)} (got ${JSON.stringify(have)})`);
      }
      break;
    }
    default:
      p.push('an element this module does not know');
  }
  return p;
}

// A captured package's problems: each element of `ids` present (block and
// `reads`) and right; each of `absent` absent. As harness/real/packages.mjs.
export function designPackageProblems(files, ids, { absent = [], facts = {} } = {}) {
  const pkg = packageReads(files);
  const problems = [];
  if (!pkg.prompt) return ['the package has no prompt.md'];
  for (const [id, msg] of Object.entries(pkg.bad)) problems.push(`${id}: its JSON does not parse (${msg})`);
  for (const id of ids) {
    if (!pkg.reads?.includes(id)) problems.push(`${id}: listed in manifest.json's reads`);
    for (const m of elementProblems(id, pkg.blocks[id], facts)) problems.push(`${id}: ${m}`);
  }
  for (const id of absent) if (id in pkg.blocks || pkg.reads?.includes(id)) problems.push(`${id}: not carried by this package`);
  return problems;
}

// ---- the Designer's rehearsal content (what a model writes and no package states) -----------

// Colours, type and spacing; the candidate colours of the muted text, each
// list's first below AA on its background (the fake picks by the ratio the
// package states, SEAM.md §539); the convention values a Designer would
// write; the criteria the owner wants, by target and kind, with the
// implemented paths; a library the mockups load; the Designer's logo
// proposal. JSON only: it is written to the fakes' rehearsal-content.json.
export function designerContent({ name = 'Pantry', criteria = [], logo = true, library = true } = {}) {
  return {
    palette: {
      light: { 'color.text.primary': '#1a1a1a', 'color.surface.base': '#ffffff', 'color.accent': '#0b5cad' },
      dark: { 'color.text.primary': '#f2f2f2', 'color.surface.base': '#121212', 'color.accent': '#8ab4f8' },
    },
    contrast_candidates: {
      light: { 'color.text.muted': ['#9aa5b1', '#52606d'] },
      dark: { 'color.text.muted': ['#3e4c59', '#9aa5b1'] },
    },
    pairs: [
      { text: 'color.text.primary', background: 'color.surface.base' },
      { text: 'color.text.muted', background: 'color.surface.base' },
    ],
    type: { 'type.body': { size: 16 }, 'type.title': { size: 24, weight: 600 } },
    space: { 'space.sm': 8, 'space.md': 16 },
    radius: { 'radius.sm': 4 },
    duration: { 'duration.fast': 150 },
    title: name,
    conventions: {
      route: '/',
      browser_back: `leaves ${name} for the previous page; forward returns`,
      keyboard_path: 'Tab reaches every field and action in reading order; Enter submits',
      back: 'exit',
      gestures: ['tap', 'scroll'],
      container: 'stack',
      edge_swipe_back: true,
      safe_area_edges: ['top', 'bottom'],
      window_min: [800, 600],
      menu_entries: [],
      shortcuts: [],
    },
    permission_prompt_when: 'the first time the feature that needs it is used',
    permission_rationale: 'so that the feature the owner asked for works',
    criteria,
    criterion_text: {
      tokens_only: 'Given the {{module}} module, when {{path0}} is read, then every colour, size, spacing, radius and duration in it is a custom property defined in {{path1}}.',
      asset_parity: 'Given the {{module}} module, when {{path0}} is read, then it equals the effective {{slot}} ({{variant}}) byte for byte.',
      state_marker_present: 'Given the {{module}} module, when {{paths}} is read, then each state of its screens carries its named marker.',
      label_with_unit: 'Given the {{module}} module, when {{paths}} is read, then every input has a label naming its unit where it has one.',
      focus_visible: 'Given the {{module}} module, when {{paths}} is read, then every focusable element keeps a visible focus style.',
    },
    human_test_text: 'The {{target}} UI matches the approved design: screens {{screens}}; judged by a person{{native}}.',
    library: library ? { name: 'modern-normalize', version: '2.0.0', file: 'modern-normalize.css' } : null,
    logo_svg: logo ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40" width="120" height="40"><rect width="120" height="40" rx="6" fill="#0b5cad"/><text x="60" y="26" font-size="18" text-anchor="middle" fill="#ffffff">${name}</text></svg>\n` : null,
  };
}

// ---- the rehearsal's judgement of a design (SEAM.md §539) ------------------------------------

const DESIGN = '.surety/design/';
const parseOr = (t) => {
  try {
    return typeof t === 'string' ? JSON.parse(t) : null;
  } catch {
    return null;
  }
};
function luminance(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(hex ?? ''));
  if (!m) return null;
  const c = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
const technologyApplies = (cat, kind, target, technology) => {
  const e = (cat?.kinds ?? []).find((k) => k.kind === kind);
  if (!e) return false;
  const tOk = e.targets === 'all' || (Array.isArray(e.targets) && e.targets.includes(target));
  const xOk = e.technologies === 'all' || (Array.isArray(e.technologies) && e.technologies.includes(technology));
  return tOk && xOk;
};

// `written` the files the fake wrote ({path: text}); `W` the elements as the
// whole package states them; `content` the rehearsal's. Returns
// [{element, problem}], one per failing element (first problem kept).
export function judgeDesign(written, W, content) {
  const out = new Map();
  const fail = (element, problem) => {
    if (!out.has(element)) out.set(element, problem);
  };
  const file = (rel) => parseOr(written?.[`${DESIGN}${rel}`]);
  const design = file('design.json');
  const screensFile = file('screens.json');
  const tokens = file('tokens.json');
  const criteria = file('criteria.json');
  const screens = Array.isArray(screensFile?.screens) ? screensFile.screens : [];
  const inv = W['designer.inventory']?.inventory ?? null;
  // designer.inventory: the design drawn against the inventory: its digest, every UI requirement on each of its targets.
  if (!design || design.inventory_digest !== inv?.inventory_digest) fail('designer.inventory', `design.json names inventory_digest ${inv?.inventory_digest} (got ${JSON.stringify(design?.inventory_digest)})`);
  for (const r of inv?.ui_requirements ?? []) for (const t of r.targets ?? []) if (!screens.some((s) => s.target === t && (s.requirements ?? []).includes(r.key))) fail('designer.inventory', `${r.key} on a screen of ${t}`);
  // designer.schemas: every file the schemas name for the design written, and parsing; nothing outside the schema's fields.
  const S = W['designer.schemas']?.schemas ?? [];
  for (const s of S.filter((x) => x.file && !x.file.includes('<') && !x.file.includes('/inventory/') && !x.file.endsWith('assets/manifest.json'))) {
    const text = written?.[s.file];
    const v = parseOr(text);
    if (v === null) {
      fail('designer.schemas', `${s.file} written as JSON`);
      continue;
    }
    for (const [k] of Object.entries(v)) if (!(k in (s.schema?.properties ?? {}))) fail('designer.schemas', `${s.file}: ${k} is not a field of ${s.id}`);
  }
  // designer.check_reasons: every declared pair meets the ratio the package states, in each theme.
  const ratio = (W['designer.check_reasons']?.reasons ?? []).find((r) => r.code === 'DESIGN_CONTRAST_BELOW_AA')?.ratio ?? AA_RATIO;
  for (const [theme, colours] of Object.entries(tokens?.themes ?? {})) {
    for (const pr of tokens?.pairs ?? []) {
      const c = contrast(colours[pr.text], colours[pr.background]);
      if (c === null || c < ratio) fail('designer.check_reasons', `${pr.text} on ${pr.background} in ${theme}: ${c === null ? 'undefined' : c.toFixed(3)}:1 below ${ratio}:1`);
    }
  }
  if (!tokens) fail('designer.check_reasons', 'tokens.json with its pairs');
  // designer.conventions: every screen declares every convention its target requires.
  const conv = W['designer.conventions']?.targets ?? [];
  const invTargets = inv?.targets ?? [];
  for (const s of screens) {
    const req = conv.find((x) => x.target === s.target)?.required ?? REQUIRED_CONVENTIONS[s.target] ?? [];
    const c = s.conventions ?? {};
    for (const r of req) {
      if (r === 'back') continue;
      const ok = r === 'route|transient' ? c.route !== undefined || c.transient !== undefined : c[r] !== undefined;
      if (!ok) fail('designer.conventions', `${s.key} (${s.target}) declares ${r}`);
    }
    const perms = invTargets.find((t) => t.target === s.target)?.permissions ?? [];
    for (const perm of IF_PERMISSIONS.includes(s.target) ? perms : []) if (!(c.permissions ?? []).some((x) => x.permission === perm)) fail('designer.conventions', `${s.key} (${s.target}) declares the permission ${perm}`);
  }
  if (screens.length === 0) fail('designer.conventions', 'screens with their conventions');
  // designer.layouts: each screen at its target's layouts, as the package states them.
  for (const s of screens) {
    const want = (W['designer.layouts']?.targets ?? []).find((x) => x.target === s.target)?.layouts;
    if (JSON.stringify(s.layouts ?? null) !== JSON.stringify(want ?? null)) fail('designer.layouts', `${s.key} (${s.target}) at layouts ${JSON.stringify(want)} (got ${JSON.stringify(s.layouts)})`);
  }
  // designer.mockup_kinds: every screen has a mockup of a kind its target's capability admits; a simulation declared.
  const mk = W['designer.mockup_kinds'];
  for (const s of screens) {
    const cap = (mk?.capabilities ?? invTargets).find((x) => x.target === s.target)?.preview_capability;
    const m = (design?.mockups ?? []).find((x) => (x.screens ?? []).includes(s.key));
    if (!m) fail('designer.mockup_kinds', `${s.key} (${s.target}) has a mockup`);
    else if (!(mk?.by_capability?.[cap] ?? []).includes(m.kind)) fail('designer.mockup_kinds', `${s.key}: ${m.kind} admitted on ${cap}`);
    else if (m.kind === 'simulated_html' && !m.simulates) fail('designer.mockup_kinds', `${m.path} declares what it simulates`);
  }
  // designer.selection_floor: a selection at or above the floor.
  const sel = design?.selection;
  if (!sel || !(sel.themes ?? []).length || !(sel.slots ?? []).some((x) => x.kind === 'logo' && (x.variants ?? []).length > 0)) fail('designer.selection_floor', `a selection with a theme and a logo variant (got ${JSON.stringify(sel)})`);
  for (const t of invTargets) {
    const k = floorKindOf(t.target);
    if (!(sel?.slots ?? []).some((x) => x.kind === k && (x.variants ?? []).length > 0)) fail('designer.selection_floor', `the selection keeps the ${k} of ${t.target}`);
    if (!((sel?.layouts ?? []).find((l) => l.target === t.target)?.layouts ?? []).length && (t.layouts ?? []).length > 0) fail('designer.selection_floor', `the selection keeps a layout of ${t.target}`);
  }
  // designer.external_urls: the library the owner asked for, loaded from an allowed host at an exact version.
  if (content?.library) {
    const allow = W['designer.external_urls']?.allowlist ?? [];
    const urls = (design?.mockups ?? []).flatMap((m) => m.external_urls ?? []);
    const good = urls.filter((u) => {
      try {
        const x = new URL(u);
        return x.protocol === 'https:' && allow.includes(x.hostname) && /@\d+\.\d+\.\d+/.test(x.pathname);
      } catch {
        return false;
      }
    });
    if (good.length === 0 || good.length !== urls.length) fail('designer.external_urls', `the mockups load ${content.library.name} from an allowed host at an exact version (got ${JSON.stringify(urls)})`);
  }
  // designer.criterion_catalogue: each criterion the owner wants where the catalogue applies it, and none where it does not.
  const cat = W['designer.criterion_catalogue'];
  const proposed = Array.isArray(criteria?.criteria) ? criteria.criteria : [];
  for (const want of content?.criteria ?? []) {
    const tech = invTargets.find((t) => t.target === want.target)?.ui_technology;
    const applies = technologyApplies(cat, want.kind, want.target, tech);
    const has = proposed.some((c) => c.kind === want.kind && (c.targets ?? []).includes(want.target));
    if (applies && !has) fail('designer.criterion_catalogue', `a ${want.kind} criterion on ${want.target}`);
    if (!applies && has) fail('designer.criterion_catalogue', `no ${want.kind} criterion on ${want.target} (${tech})`);
  }
  if ((content?.criteria ?? []).length > 0 && !criteria) fail('designer.criterion_catalogue', 'criteria.json');
  return [...out].map(([element, problem]) => ({ element, problem }));
}

// The correction's design checks (SEAM.md §539): a check definition covering
// each criterion `verifier.design_catalogue` lists, with `asset_inputs` for a
// criterion on a slot. `written` the fake's files.
export function judgeDesignChecks(written, W) {
  const out = [];
  const defs = Object.entries(written ?? {})
    .filter(([p]) => p.endsWith('.json') && p.includes('/checks/'))
    .map(([, t]) => parseOr(t))
    .filter((d) => d && typeof d.key === 'string');
  for (const c of W['verifier.design_catalogue']?.criteria ?? []) {
    const d = defs.find((x) => (x.covers?.criteria ?? []).includes(c.id));
    if (!d) out.push({ element: 'verifier.design_catalogue', problem: `a check covering ${c.id} (${c.kind})` });
    else if (c.slot && !(d.asset_inputs ?? []).some((a) => a.slot === c.slot && a.variant === c.variant)) out.push({ element: 'verifier.design_catalogue', problem: `${d.key} reads ${c.slot}/${c.variant} through asset_inputs` });
    // Its command names first a program the catalogue states (objection 201).
    const programs = W['verifier.design_catalogue']?.command?.programs;
    if (d && Array.isArray(programs) && !programs.includes((d.command ?? [])[0])) out.push({ element: 'verifier.design_catalogue', problem: `${d.key}'s command names first one of the programs ${JSON.stringify(programs)} (got ${JSON.stringify((d.command ?? [])[0] ?? null)})` });
  }
  if ((W['verifier.design_catalogue']?.criteria ?? []).length === 0) out.push({ element: 'verifier.design_catalogue', problem: 'the design criteria the correction is to cover' });
  return out;
}
