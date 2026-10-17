// The design check (D7 §5.6; A.4; SEAM.md §483): `checkDesign(tree,
// inventory)`, a pure function run at every save and again at close, over
// clauses 1 to 8: the closed schemas and the inventory's digest; references;
// coverage per target; navigation and conventions; tokens and WCAG AA on
// declared pairs; axes and mockup kinds; criteria scoped by target and
// technology (§7.2); assets and the selection's floor. It reads JSON, SVG as
// text and raster files by their headers, and computes; it executes nothing
// the Designer wrote and judges no mockup's look. Each reason names its
// subjects, the target among them.

import { createHash } from 'node:crypto';

import { isSlug } from './paths.js';
import { fixtureProblem } from './shape.js';
import { AA_RATIO, contrastRatio } from './contrast.js';
import { ASSET_FORMATS, ASSET_KINDS, ASSET_PROVENANCES, ASSET_STATUSES, ASSET_VARIANTS, type AssetManifest, headerReasons, sha256hex } from './assets.js';
import type { Inventory } from './inventory.js';

export interface DesignReason {
  code: string;
  subjects: Record<string, unknown>;
}

export interface DesignTree {
  // path relative to .surety/design/ → bytes.
  files: Map<string, Buffer>;
}

export interface CheckContext {
  inventory: Inventory | null;
  externalHosts: string[];
  // The slots and digests the last approved revision approved (§6.4), to
  // judge a forged `approved` status.
  approved: { slot: string; slot_version: number; digests: Record<string, string> }[];
  // The manifest the version rules compare a save with (SEAM.md §505): the
  // current approved revision's, else the one the engine last committed.
  base?: AssetManifest | null;
  // The engine's placeholders as the inventory records them (B2): a variant
  // holding one is the engine's, never approved by anyone.
  placeholders?: AssetManifest | null;
  // The project's design policy: under `at_alpha` a convention the code
  // does not show and an interface with no shape are shown, not refused
  // (D7 §12; SEAM.md §528).
  policy?: string;
  // The evidence each review file may cite (B.14): a recorded review's own,
  // by its file's blob; and the saving session's review's (its owner
  // evidence and the engine's observations for its run).
  reviews?: { held: Record<string, string[]>; run: string[] };
}

export interface CheckOutcome {
  outcome: 'passed' | 'refused';
  reasons: DesignReason[];
  // What the check shows without refusing (SEAM.md §528).
  notices: DesignReason[];
  design: Record<string, unknown> | null;
}

// The reasons `at_alpha` shows instead of refusing (D7 §12: "blocking
// approval under before_build and shown under at_alpha").
export const NOTICE_CODES = ['DESIGN_CONVENTION_UNKNOWN', 'DESIGN_INTERFACE_SHAPE_UNKNOWN'];

// B.14's closed fields and values (D7 A.2).
export const REVIEW_FIELDS = {
  file: ['design_version', 'subject', 'screens', 'revised_design', 'first_design'],
  subject: ['kind', 'candidate', 'target', 'build_ref'],
  screen: ['target', 'key', 'verdict', 'observed_on', 'not_observed_reason', 'evidence', 'deltas'],
  delta: ['state', 'owner_words', 'kind'],
} as const;
export const REVIEW_VERDICTS = ['matches', 'deltas', 'not_observed'];
export const OBSERVED_ON = ['browser', 'simulator', 'emulator', 'device', 'simulation'];
export const NOT_OBSERVED = ['no_native_runtime', 'not_reached', 'owner_skipped'];
export const DELTA_KINDS = ['design', 'implementation', 'both'];
export const SUBJECT_KINDS = ['candidate', 'owner_build'];

// A file's git blob id (the id git gives the same bytes).
export function gitBlobId(bytes: Buffer): string {
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
}

// D7 §7.2: the closed criterion catalogue with the targets and technologies
// each kind applies to.
export const CSS_TECH = ['html_css', 'three_js'];
export const CRITERION_CATALOGUE: Record<string, { targets: string[] | 'all'; technologies: string[] | 'all'; reads: boolean }> = {
  tokens_only: { targets: ['web'], technologies: CSS_TECH, reads: true },
  layout_at_width: { targets: ['web'], technologies: CSS_TECH, reads: true },
  label_with_unit: { targets: ['web'], technologies: CSS_TECH, reads: true },
  focus_visible: { targets: ['web'], technologies: CSS_TECH, reads: true },
  reduced_motion: { targets: ['web'], technologies: CSS_TECH, reads: true },
  token_parity: { targets: 'all', technologies: 'all', reads: true },
  contrast_aa: { targets: 'all', technologies: 'all', reads: true },
  state_marker_present: { targets: 'all', technologies: 'all', reads: true },
  asset_parity: { targets: 'all', technologies: 'all', reads: true },
  human: { targets: 'all', technologies: 'all', reads: false },
};
// The kinds that read the implemented tokens: the CSS binding, or the
// neutral tokens.json from named paths (§7.2).
export const NEUTRAL_TOKEN_KINDS = ['token_parity', 'contrast_aa'];
// D7 A.2 NativeConvention: never a criterion in M6 (not_checkable_yet).
export const NATIVE_CONVENTIONS = ['browser_back', 'keyboard_path', 'system_back', 'safe_area', 'permission_prompt', 'touch_interaction', 'platform_navigation', 'window_resize', 'menu_entries', 'keyboard_shortcuts'];

// A screen's route: a request path the engine may ask the service for
// (the slice-45 review's S1): "/" then printable ASCII, no space or control.
export const ROUTE_PATTERN = /^\/[!-~]*$/;

export const MOCKUP_KINDS =['static_html', 'scene_html', 'simulated_html', 'image', 'source_stub'] as const;
export const NAV_KINDS = ['push', 'replace', 'modal', 'sheet', 'tab', 'back', 'deep_link', 'menu', 'shortcut', 'window'];
export const DESIGN_FILES = ['design.json', 'tokens.json', 'flows.json', 'screens.json', 'navigation.json', 'criteria.json', 'assets/manifest.json'] as const;

// B.10 to B.16's closed fields.
export const FIELDS = {
  design: ['version', 'origin', 'inventory_digest', 'selection', 'targets', 'cross_platform', 'tokens_file', 'flows_file', 'screens_file', 'navigation_file', 'criteria_file', 'assets_file', 'mockups'],
  selection: ['themes', 'slots', 'layouts'],
  target: ['module', 'target', 'ui_technology', 'form_factors', 'preview_capability', 'layouts', 'window'],
  mockup: ['path', 'kind', 'screens', 'simulates', 'external_urls'],
  tokens: ['unit', 'themes', 'type', 'space', 'radius', 'duration', 'pairs'],
  flows: ['flows'],
  flow: ['key', 'title', 'requirements', 'steps'],
  step: ['key', 'title', 'requirement', 'interfaces'],
  screens: ['screens'],
  screen: ['key', 'target', 'title', 'flow_steps', 'requirements', 'interfaces', 'states', 'layouts', 'inputs', 'conventions', 'notes'],
  state: ['obligation', 'mockup', 'fixture'],
  input: ['interface', 'property', 'label', 'unit'],
  conventions: ['route', 'transient', 'browser_back', 'keyboard_path', 'back', 'container', 'edge_swipe_back', 'safe_area_edges', 'permissions', 'gestures', 'window_min', 'menu_entries', 'shortcuts', 'hover', 'context_menu'],
  navigation: ['targets'],
  navTarget: ['target', 'entries', 'edges'],
  edge: ['from', 'to', 'trigger', 'kind'],
  criteria: ['criteria', 'human_tests'],
  criterion: ['requirement', 'text', 'kind', 'targets', 'paths', 'width', 'slot', 'variant'],
  humanTest: ['target', 'text', 'screens', 'not_checkable_yet'],
  manifest: ['version', 'slots', 'packaging'],
  slot: ['key', 'kind', 'purpose', 'platforms', 'placement', 'screens', 'variants', 'alt_text', 'decorative', 'slot_version', 'status', 'provenance', 'status_since', 'history'],
  variant: ['name', 'format', 'size', 'transparency', 'file', 'digest'],
  packaging: ['target', 'slot', 'requirement', 'guidance', 'status'],
  guidance: ['source', 'read_on'],
} as const;

// D7 §6.6, A.2 PackagingStatus in M6.
export const PACKAGING_STATUSES = ['recorded', 'not_checkable_yet'];
// A slot's files, as the version rules compare them (SEAM.md §505).
const filesOf = (s: { variants?: unknown }): string =>
  JSON.stringify(
    (Array.isArray(s.variants) ? (s.variants as Record<string, unknown>[]) : [])
      .filter(isObj)
      .map((v) => [String(v.name), v.file ?? null, v.digest ?? null])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
// The manifest less its version, canonically: a difference from the base's is a change.
const manifestBody = (m: { slots?: unknown; packaging?: unknown }): string => canonicalJson({ slots: m.slots ?? null, packaging: m.packaging ?? [] });
const canonicalJson = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
};

// Which convention fields apply to each target (B.12: a field not
// applicable to the screen's target is refused).
export const CONVENTION_TARGETS: Record<string, string[]> = {
  web: ['route', 'transient', 'browser_back', 'keyboard_path', 'hover', 'context_menu'],
  android: ['back', 'permissions', 'gestures'],
  ios: ['container', 'edge_swipe_back', 'safe_area_edges', 'permissions', 'gestures'],
  macos: ['window_min', 'menu_entries', 'shortcuts', 'hover', 'context_menu', 'permissions'],
  windows: ['window_min', 'menu_entries', 'shortcuts', 'hover', 'context_menu'],
  linux: ['window_min', 'menu_entries', 'shortcuts', 'hover', 'context_menu'],
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

export function checkDesign(tree: DesignTree, ctx: CheckContext): CheckOutcome {
  const reasons: DesignReason[] = [];
  const add = (code: string, subjects: Record<string, unknown>) => reasons.push({ code, subjects });
  const schema = (file: string, field: string | null, why: string) => add('DESIGN_SCHEMA_INVALID', { file, field, why });
  const closed = (file: string, at: string, o: Record<string, unknown>, fields: readonly string[]): boolean => {
    let ok = true;
    for (const k of Object.keys(o)) {
      if (!fields.includes(k)) {
        schema(file, at === '' ? k : `${at}.${k}`, `"${k}" is not a field of ${at === '' ? 'the file' : at}`);
        ok = false;
      }
    }
    return ok;
  };
  // (The tree's bounds, §5.5, refuse the save before any commit or check:
  // sessions/driver.ts, 413 design_tree_too_large.)
  const json = (path: string): Record<string, unknown> | null => {
    const b = tree.files.get(path);
    if (!b) {
      schema(path, null, 'the file is missing');
      return null;
    }
    try {
      const v = JSON.parse(b.toString('utf8')) as unknown;
      if (!isObj(v)) {
        schema(path, null, 'is not a JSON object');
        return null;
      }
      return v;
    } catch {
      schema(path, null, 'is not JSON');
      return null;
    }
  };
  const inv = ctx.inventory;
  // ---- clause 1: the closed schemas; the inventory's digest --------------------------------
  const design = json('design.json');
  const tokens = json('tokens.json');
  const flows = json('flows.json');
  const screensFile = json('screens.json');
  const nav = json('navigation.json');
  const criteriaFile = json('criteria.json');
  const manifest = json('assets/manifest.json') as AssetManifest | null;
  if (design) {
    closed('design.json', '', design, FIELDS.design);
    if (!inv) add('DESIGN_INVENTORY_STALE', { inventory_digest: design.inventory_digest ?? null, current: null, why: 'the project has no recorded inventory' });
    else if (design.inventory_digest !== inv.inventory_digest) add('DESIGN_INVENTORY_STALE', { inventory_digest: design.inventory_digest ?? null, current: inv.inventory_digest });
    if (design.origin !== 'intended' && design.origin !== 'observed') schema('design.json', 'origin', 'must be intended or observed');
    if (isObj(design.selection)) closed('design.json', 'selection', design.selection, FIELDS.selection);
    else schema('design.json', 'selection', 'must be an object');
  }
  const screens = (isObj(screensFile) && Array.isArray(screensFile.screens) ? screensFile.screens : []).filter(isObj) as Record<string, unknown>[];
  if (screensFile) closed('screens.json', '', screensFile, FIELDS.screens);
  for (const [i, s] of screens.entries()) {
    const at = `screens[${i}] (${String(s.key)})`;
    closed('screens.json', at, s, FIELDS.screen);
    for (const [j, st] of (Array.isArray(s.states) ? s.states : []).entries()) if (isObj(st)) closed('screens.json', `${at}.states[${j}]`, st, FIELDS.state);
    for (const [j, inp] of (Array.isArray(s.inputs) ? s.inputs : []).entries()) if (isObj(inp)) closed('screens.json', `${at}.inputs[${j}]`, inp, FIELDS.input);
    if (isObj(s.conventions)) {
      closed('screens.json', `${at}.conventions`, s.conventions, FIELDS.conventions);
      // A route is a request path the engine may ask for (the slice-45 review's S1).
      if (s.conventions.route !== undefined && (typeof s.conventions.route !== 'string' || !ROUTE_PATTERN.test(s.conventions.route))) {
        schema('screens.json', `${at}.conventions.route`, 'must be a request path: "/" then printable characters, no space, CR, LF or control');
      }
      const allowed = CONVENTION_TARGETS[String(s.target)] ?? [];
      for (const k of Object.keys(s.conventions)) if ((FIELDS.conventions as readonly string[]).includes(k) && !allowed.includes(k)) schema('screens.json', `${at}.conventions.${k}`, `"${k}" is not a convention of the target ${String(s.target)}`);
    } else schema('screens.json', `${at}.conventions`, 'must be an object');
  }
  if (tokens) closed('tokens.json', '', tokens, FIELDS.tokens);
  if (flows) {
    closed('flows.json', '', flows, FIELDS.flows);
    for (const [i, f] of (Array.isArray(flows.flows) ? flows.flows : []).entries()) {
      if (!isObj(f)) continue;
      closed('flows.json', `flows[${i}]`, f, FIELDS.flow);
      for (const [j, st] of (Array.isArray(f.steps) ? f.steps : []).entries()) if (isObj(st)) closed('flows.json', `flows[${i}].steps[${j}]`, st, FIELDS.step);
    }
  }
  if (nav) {
    closed('navigation.json', '', nav, FIELDS.navigation);
    for (const [i, t] of (Array.isArray(nav.targets) ? nav.targets : []).entries()) {
      if (!isObj(t)) continue;
      closed('navigation.json', `targets[${i}]`, t, FIELDS.navTarget);
      for (const [j, e] of (Array.isArray(t.edges) ? t.edges : []).entries()) if (isObj(e)) closed('navigation.json', `targets[${i}].edges[${j}]`, e, FIELDS.edge);
    }
  }
  const criteria = (isObj(criteriaFile) && Array.isArray(criteriaFile.criteria) ? criteriaFile.criteria : []).filter(isObj) as Record<string, unknown>[];
  const humanTests = (isObj(criteriaFile) && Array.isArray(criteriaFile.human_tests) ? criteriaFile.human_tests : []).filter(isObj) as Record<string, unknown>[];
  if (criteriaFile) {
    closed('criteria.json', '', criteriaFile, FIELDS.criteria);
    criteria.forEach((c, i) => closed('criteria.json', `criteria[${i}]`, c, FIELDS.criterion));
    humanTests.forEach((h, i) => closed('criteria.json', `human_tests[${i}]`, h, FIELDS.humanTest));
  }
  if (manifest) {
    closed('assets/manifest.json', '', manifest as unknown as Record<string, unknown>, FIELDS.manifest);
    for (const [i, s] of (Array.isArray(manifest.slots) ? manifest.slots : []).entries()) {
      if (!isObj(s)) continue;
      closed('assets/manifest.json', `slots[${i}] (${String(s.key)})`, s, FIELDS.slot);
      for (const [j, v] of (Array.isArray(s.variants) ? s.variants : []).entries()) if (isObj(v)) closed('assets/manifest.json', `slots[${i}].variants[${j}]`, v, FIELDS.variant);
    }
  }
  // ---- clause 2: references ----------------------------------------------------------------
  const invTargets = new Set((inv?.targets ?? []).map((t) => t.target));
  const invInterfaces = new Set((inv?.interfaces ?? []).map((i) => i.name));
  const uiReqFor = (target: string) => new Set((inv?.ui_requirements ?? []).filter((r) => r.targets.includes(target)).map((r) => r.key));
  const mockups = (isObj(design) && Array.isArray(design.mockups) ? design.mockups : []).filter(isObj) as Record<string, unknown>[];
  mockups.forEach((m, i) => closed('design.json', `mockups[${i}]`, m, FIELDS.mockup));
  const screenKeys = new Set(screens.map((s) => String(s.key)));
  const named = new Set<string>();
  for (const s of screens) {
    const target = String(s.target);
    const key = String(s.key);
    if (!invTargets.has(target)) add('DESIGN_UNKNOWN_TARGET', { screen: key, target });
    const reqs = uiReqFor(target);
    for (const r of strs(s.requirements) ? s.requirements : []) if (!reqs.has(r)) add('DESIGN_UNKNOWN_REQUIREMENT', { screen: key, target, requirement: r });
    for (const f of strs(s.interfaces) ? s.interfaces : []) if (!invInterfaces.has(f)) add('DESIGN_UNKNOWN_INTERFACE', { screen: key, target, interface: f });
    for (const st of (Array.isArray(s.states) ? s.states : []).filter(isObj)) {
      if (typeof st.mockup === 'string') {
        named.add(st.mockup);
        if (!tree.files.has(st.mockup)) add('DESIGN_MOCKUP_MISSING', { screen: key, target, mockup: st.mockup });
      }
      if (typeof st.fixture === 'string' && !tree.files.has(st.fixture)) add('DESIGN_MOCKUP_MISSING', { screen: key, target, fixture: st.fixture });
    }
  }
  for (const m of mockups) {
    const path = String(m.path);
    if (!tree.files.has(path)) add('DESIGN_MOCKUP_MISSING', { mockup: path });
    if (!strs(m.screens) || m.screens.length === 0 || !m.screens.some((k) => screenKeys.has(k))) add('DESIGN_MOCKUP_ORPHAN', { mockup: path });
    for (const k of strs(m.screens) ? m.screens : []) if (!screenKeys.has(k)) add('DESIGN_MOCKUP_MISSING', { mockup: path, screen: k });
  }
  for (const path of tree.files.keys()) {
    if (!path.startsWith('mockups/') || path.startsWith('mockups/data/')) continue;
    if (!mockups.some((m) => m.path === path) && !named.has(path)) add('DESIGN_MOCKUP_ORPHAN', { mockup: path });
  }
  // The role's own fixtures (§4.4; SEAM.md §493): data, never mockups; each
  // named as the inventory's fixtures are and valid against what that
  // fixture is valid against.
  for (const [path, bytes] of tree.files) {
    if (!path.startsWith('mockups/data/')) continue;
    const problem = fixtureProblem(path.slice('mockups/data/'.length), bytes, inv);
    if (problem !== null) add('DESIGN_FIXTURE_INVALID', { file: path, why: problem });
  }
  // The review files (B.14): closed, their values A.2's, never a verdict's
  // `status` (every verdict in them is a proposal, D7 §10.3), and no
  // evidence id the review does not hold.
  for (const [path, bytes] of [...tree.files].filter(([p]) => p.startsWith('reviews/') && p.endsWith('.json')).sort((a, b) => a[0].localeCompare(b[0]))) {
    const file = path;
    let v: unknown;
    try {
      v = JSON.parse(bytes.toString('utf8'));
    } catch {
      schema(file, null, 'is not JSON');
      continue;
    }
    if (!isObj(v)) {
      schema(file, null, 'is not a JSON object');
      continue;
    }
    closed(file, '', v, REVIEW_FIELDS.file);
    for (const k of ['revised_design', 'first_design']) if (typeof v[k] !== 'boolean') schema(file, k, 'must be true or false');
    if (v.design_version !== undefined && v.design_version !== null && !(typeof v.design_version === 'number' && Number.isInteger(v.design_version) && v.design_version >= 1)) schema(file, 'design_version', 'must be the design version reviewed');
    if (!isObj(v.subject)) schema(file, 'subject', 'must be an object');
    else {
      closed(file, 'subject', v.subject, REVIEW_FIELDS.subject);
      if (!SUBJECT_KINDS.includes(String(v.subject.kind))) schema(file, 'subject.kind', `must be one of ${SUBJECT_KINDS.join(', ')}`);
    }
    const allowed = ctx.reviews ? (ctx.reviews.held[gitBlobId(bytes)] ?? ctx.reviews.run) : null;
    if (!Array.isArray(v.screens)) schema(file, 'screens', 'must be a list');
    for (const [i, x] of (Array.isArray(v.screens) ? v.screens : []).entries()) {
      const at = `screens[${i}]`;
      if (!isObj(x)) {
        schema(file, at, 'must be an object');
        continue;
      }
      closed(file, at, x, REVIEW_FIELDS.screen);
      if (typeof x.target !== 'string' || typeof x.key !== 'string') schema(file, at, 'names its target and screen key');
      if (!REVIEW_VERDICTS.includes(String(x.verdict))) schema(file, `${at}.verdict`, `must be one of ${REVIEW_VERDICTS.join(', ')}`);
      if (x.observed_on !== undefined && !OBSERVED_ON.includes(String(x.observed_on))) schema(file, `${at}.observed_on`, `must be one of ${OBSERVED_ON.join(', ')}`);
      if (x.not_observed_reason !== undefined && !NOT_OBSERVED.includes(String(x.not_observed_reason))) schema(file, `${at}.not_observed_reason`, `must be one of ${NOT_OBSERVED.join(', ')}`);
      if (!strs(x.evidence)) schema(file, `${at}.evidence`, 'must be a list of evidence ids');
      else if (allowed !== null) for (const e of x.evidence) if (!allowed.includes(e)) schema(file, `${at}.evidence`, `${e} is not evidence this review holds`);
      if (!Array.isArray(x.deltas)) schema(file, `${at}.deltas`, 'must be a list');
      for (const [j, d] of (Array.isArray(x.deltas) ? x.deltas : []).entries()) {
        if (!isObj(d)) {
          schema(file, `${at}.deltas[${j}]`, 'must be an object');
          continue;
        }
        closed(file, `${at}.deltas[${j}]`, d, REVIEW_FIELDS.delta);
        if (typeof d.owner_words !== 'string' || d.owner_words === '') schema(file, `${at}.deltas[${j}].owner_words`, "must be the owner's words");
        if (!DELTA_KINDS.includes(String(d.kind))) schema(file, `${at}.deltas[${j}].kind`, `must be one of ${DELTA_KINDS.join(', ')}`);
      }
    }
  }
  // An interface the retrofit map could not shape (D7 §12): reported on
  // every screen that uses it; nothing is derived from it.
  const unshaped = new Set((inv?.interfaces ?? []).filter((i) => i.shape_known === false).map((i) => i.name));
  for (const s of screens) for (const f of strs(s.interfaces) ? s.interfaces : []) if (unshaped.has(f)) add('DESIGN_INTERFACE_SHAPE_UNKNOWN', { target: String(s.target), screen: String(s.key), interface: f });
  // ---- clause 3: coverage, per target ----------------------------------------------------------
  const selection = isObj(design?.selection) ? (design!.selection as Record<string, unknown>) : {};
  const selectedLayouts = (target: string): unknown[] => {
    const l = (Array.isArray(selection.layouts) ? selection.layouts : []).filter(isObj).find((x) => x.target === target);
    return Array.isArray(l?.layouts) ? l!.layouts : (inv?.targets.find((t) => t.target === target)?.layouts ?? []);
  };
  for (const r of inv?.ui_requirements ?? []) {
    for (const target of r.targets) {
      if (!invTargets.has(target)) continue;
      if (!screens.some((s) => s.target === target && strs(s.requirements) && s.requirements.includes(r.key))) add('DESIGN_REQUIREMENT_UNCOVERED', { requirement: r.key, target });
    }
  }
  for (const o of inv?.obligations ?? []) {
    const covered = screens.some(
      (s) =>
        s.target === o.target &&
        (o.interface === undefined || (strs(s.interfaces) && s.interfaces.includes(o.interface))) &&
        (Array.isArray(s.states) ? s.states : []).filter(isObj).some((st) => isObj(st.obligation) && st.obligation.state === o.state && (st.obligation.interface ?? null) === (o.interface ?? null) && (st.obligation.permission ?? null) === (o.permission ?? null)),
    );
    if (!covered) add('DESIGN_STATE_UNCOVERED', { target: o.target, ...(o.interface ? { interface: o.interface } : {}), ...(o.permission ? { permission: o.permission } : {}), state: o.state });
  }
  for (const s of screens) {
    const target = String(s.target);
    const layouts = Array.isArray(s.layouts) ? s.layouts.map(String) : [];
    for (const l of selectedLayouts(target)) if (!layouts.includes(String(l))) add('DESIGN_LAYOUT_UNCOVERED', { screen: String(s.key), target, layout: l });
    for (const name of strs(s.interfaces) ? s.interfaces : []) {
      const iface = inv?.interfaces.find((i) => i.name === name);
      for (const [prop, shape] of Object.entries(iface?.request?.properties ?? {})) {
        if (shape.unit === undefined) continue;
        const input = (Array.isArray(s.inputs) ? s.inputs : []).filter(isObj).find((x) => x.interface === name && x.property === prop);
        if (!input || typeof input.label !== 'string' || !input.label.includes(shape.unit)) add('DESIGN_INPUT_UNLABELLED', { screen: String(s.key), target, interface: name, property: prop, unit: shape.unit });
      }
    }
  }
  // ---- clause 4: navigation and conventions -----------------------------------------------------
  const navTargets = (isObj(nav) && Array.isArray(nav.targets) ? nav.targets : []).filter(isObj) as Record<string, unknown>[];
  for (const t of navTargets) {
    const target = String(t.target);
    const mine = new Set(screens.filter((s) => s.target === target).map((s) => String(s.key)));
    const entries = strs(t.entries) ? t.entries : [];
    const edges = (Array.isArray(t.edges) ? t.edges : []).filter(isObj);
    for (const e of [...entries.map((x) => ({ from: x, to: x })), ...edges]) for (const k of [e.from, e.to]) if (!mine.has(String(k))) add('DESIGN_NAV_UNKNOWN_SCREEN', { target, screen: String(k) });
    for (const e of edges) if (!NAV_KINDS.includes(String(e.kind))) schema('navigation.json', `edges.kind`, `"${String(e.kind)}" is not a NavKind`);
    const reached = new Set(entries);
    for (let changed = true; changed; ) {
      changed = false;
      for (const e of edges) if (reached.has(String(e.from)) && !reached.has(String(e.to))) {
        reached.add(String(e.to));
        changed = true;
      }
    }
    for (const k of mine) if (!reached.has(k)) add('DESIGN_SCREEN_UNREACHABLE', { target, screen: k });
  }
  for (const target of invTargets) {
    if (!navTargets.some((t) => t.target === target) && screens.some((s) => s.target === target)) for (const s of screens.filter((x) => x.target === target)) add('DESIGN_SCREEN_UNREACHABLE', { target, screen: String(s.key) });
  }
  for (const s of screens) {
    const target = String(s.target);
    const key = String(s.key);
    const conv = isObj(s.conventions) ? s.conventions : {};
    const t = inv?.targets.find((x) => x.target === target);
    const entry = navTargets.find((n) => n.target === target);
    const root = strs(entry?.entries) && entry!.entries.includes(key);
    for (const c of t?.required_conventions ?? []) {
      if (c === 'route|transient') {
        if (conv.route === undefined && conv.transient === undefined) add('DESIGN_CONVENTION_UNDECLARED', { target, screen: key, convention: 'route' });
        continue;
      }
      if (c === 'back' && root) continue;
      if (c === 'permissions') {
        const declared = (Array.isArray(conv.permissions) ? conv.permissions : []).filter(isObj).map((p) => p.permission);
        for (const p of t?.permissions ?? []) if (!declared.includes(p)) add('DESIGN_CONVENTION_UNDECLARED', { target, screen: key, convention: 'permissions', permission: p });
        continue;
      }
      if (conv[c] === undefined) add('DESIGN_CONVENTION_UNDECLARED', { target, screen: key, convention: c });
      if (conv[c] === 'unknown') add('DESIGN_CONVENTION_UNKNOWN', { target, screen: key, convention: c });
    }
    const keys = (Array.isArray(conv.shortcuts) ? conv.shortcuts : []).filter(isObj).map((x) => String(x.keys));
    for (const k of new Set(keys.filter((x, i) => keys.indexOf(x) !== i))) add('DESIGN_SHORTCUT_DUPLICATE', { target, screen: key, keys: k });
  }
  const cross = isObj(design?.cross_platform) ? (design!.cross_platform as Record<string, unknown>) : null;
  if (cross && inv?.cross_platform) {
    const group = strs(cross.targets) ? cross.targets : [...invTargets];
    const differences = (Array.isArray(cross.differences) ? cross.differences : []).filter(isObj);
    for (const f of (isObj(flows) && Array.isArray(flows.flows) ? flows.flows : []).filter(isObj)) {
      for (const st of (Array.isArray(f.steps) ? f.steps : []).filter(isObj)) {
        for (const target of group) {
          const has = screens.some((s) => s.target === target && strs(s.flow_steps) && s.flow_steps.includes(String(st.key)));
          const stated = differences.some((d) => d.target === target && (d.flow_step === st.key || d.flow_step === undefined));
          if (!has && !stated) add('DESIGN_TARGET_DIVERGENCE_UNSTATED', { target, flow_step: String(st.key) });
        }
      }
    }
  }
  // ---- clause 5: tokens and contrast --------------------------------------------------------------
  const themes = isObj(tokens?.themes) ? (tokens!.themes as Record<string, Record<string, string>>) : {};
  const selectedThemes = strs(selection.themes) ? selection.themes : Object.keys(themes);
  for (const p of (Array.isArray(tokens?.pairs) ? tokens!.pairs : []).filter(isObj)) {
    for (const theme of selectedThemes) {
      const vals = themes[theme] ?? {};
      const fg = vals[String(p.text)];
      const bg = vals[String(p.background)];
      if (fg === undefined) add('DESIGN_TOKEN_UNDEFINED', { theme, token: String(p.text) });
      if (bg === undefined) add('DESIGN_TOKEN_UNDEFINED', { theme, token: String(p.background) });
      if (fg === undefined || bg === undefined) continue;
      const ratio = contrastRatio(fg, bg);
      if (ratio === null || ratio < AA_RATIO) add('DESIGN_CONTRAST_BELOW_AA', { theme, text: String(p.text), background: String(p.background), ratio: ratio === null ? null : Math.round(ratio * 100) / 100 });
    }
  }
  // ---- clause 6: axes and mockups --------------------------------------------------------------------
  for (const t of (Array.isArray(design?.targets) ? design!.targets : []).filter(isObj)) {
    closed('design.json', `targets (${String(t.target)})`, t, FIELDS.target);
    const it = inv?.targets.find((x) => x.target === t.target && x.module === t.module);
    if (!it) add('DESIGN_UNKNOWN_TARGET', { target: String(t.target), module: String(t.module) });
    else if (it.ui_technology !== t.ui_technology || it.preview_capability !== t.preview_capability) {
      add('DESIGN_AXIS_MISMATCH', { target: String(t.target), module: String(t.module), ui_technology: t.ui_technology, preview_capability: t.preview_capability, inventory: { ui_technology: it.ui_technology, preview_capability: it.preview_capability } });
    }
  }
  for (const m of mockups) {
    const path = String(m.path);
    const kind = String(m.kind);
    if (!(MOCKUP_KINDS as readonly string[]).includes(kind)) {
      schema('design.json', 'mockups.kind', `"${kind}" is not a mockup kind`);
      continue;
    }
    for (const key of strs(m.screens) ? m.screens : []) {
      const s = screens.find((x) => x.key === key);
      if (!s) continue;
      const target = String(s.target);
      const it = inv?.targets.find((x) => x.target === target);
      const cap = it?.preview_capability ?? 'none';
      const admitted =
        kind === 'image' || kind === 'source_stub' ? true : kind === 'static_html' ? target === 'web' && cap === 'native' : kind === 'scene_html' ? target === 'web' && it?.ui_technology === 'three_js' : cap === 'simulated';
      if (!admitted) add('DESIGN_MOCKUP_KIND_MISMATCH', { mockup: path, kind, screen: key, target, preview_capability: cap });
      if (target !== 'web' && kind !== 'simulated_html' && kind !== 'image' && kind !== 'source_stub') add('DESIGN_SIMULATION_UNDECLARED', { mockup: path, screen: key, target });
    }
    if (kind === 'simulated_html' && !(isObj(m.simulates) && typeof m.simulates.target === 'string')) add('DESIGN_SIMULATION_UNDECLARED', { mockup: path });
    for (const u of strs(m.external_urls) ? m.external_urls : []) {
      let host = '';
      try {
        host = new URL(u).hostname;
      } catch {
        host = '';
      }
      if (!ctx.externalHosts.includes(host) || !/@\d+\.\d+\.\d+/.test(u)) add('DESIGN_EXTERNAL_URL_UNPINNED', { mockup: path, url: u });
    }
  }
  // ---- clause 7: criteria (§7.2) -----------------------------------------------------------------------
  const techOf = (target: string): string => inv?.targets.find((x) => x.target === target)?.ui_technology ?? 'other';
  for (const [i, c] of criteria.entries()) {
    const kind = String(c.kind);
    const spec = CRITERION_CATALOGUE[kind];
    const onScreens = screens.filter((s) => c.requirement !== 'new' && strs(s.requirements) && s.requirements.includes(String(c.requirement)));
    const targetsOf = strs(c.targets) ? c.targets : [];
    const scoped = onScreens.filter((x) => targetsOf.length === 0 || targetsOf.includes(String(x.target)));
    if (!spec) {
      // A native convention is recorded not_checkable_yet, never a
      // criterion in M6 (§7.2; SEAM.md §494); any other kind is outside
      // the catalogue.
      if (NATIVE_CONVENTIONS.includes(kind)) {
        const targets = [...new Set([...targetsOf, ...scoped.map((s) => String(s.target))])];
        add('DESIGN_CRITERION_NOT_APPLICABLE', { criterion: i, kind, targets, technologies: targets.map(techOf), hint: 'not_checkable_yet' });
      } else add('DESIGN_CRITERION_UNCHECKABLE', { criterion: i, kind, why: 'not a kind of the criterion catalogue (D7 §7.2)' });
      continue;
    }
    const hasPaths = strs(c.paths) && c.paths.length > 0;
    let pathsNamed = false;
    for (const s of scoped) {
      const target = String(s.target);
      const tech = techOf(target);
      if ((spec.targets !== 'all' && !spec.targets.includes(target)) || (spec.technologies !== 'all' && !spec.technologies.includes(tech))) {
        add('DESIGN_CRITERION_NOT_APPLICABLE', { criterion: i, kind, target, technology: tech });
        continue;
      }
      // token_parity and contrast_aa outside the CSS binding read the
      // neutral tokens.json where the code reads it: only with paths naming
      // that (§7.2; SEAM.md §494).
      if (NEUTRAL_TOKEN_KINDS.includes(kind) && !CSS_TECH.includes(tech) && !hasPaths) {
        add('DESIGN_CRITERION_NOT_APPLICABLE', { criterion: i, kind, target, technology: tech, missing: 'paths', why: `outside html_css and three_js, ${kind} applies only with paths naming where the code reads the neutral tokens.json` });
        pathsNamed = true;
      }
    }
    if (spec.reads && !hasPaths && !pathsNamed) add('DESIGN_CRITERION_UNCHECKABLE', { criterion: i, kind, missing: 'paths', why: 'a criterion that reads files names the implemented paths' });
  }
  // ---- clause 8: assets and the selection --------------------------------------------------------------
  const base = ctx.base ?? null;
  const baseSlots = new Map((base?.slots ?? []).map((s) => [s.key, s]));
  if (manifest && Array.isArray(manifest.packaging)) {
    // D7 §6.6: recorded or not_checkable_yet in M6; nothing is checked against guidance.
    for (const [i, p] of manifest.packaging.entries()) {
      if (!isObj(p)) {
        schema('assets/manifest.json', `packaging[${i}]`, 'must be an object');
        continue;
      }
      closed('assets/manifest.json', `packaging[${i}]`, p, FIELDS.packaging);
      if (!PACKAGING_STATUSES.includes(String(p.status))) schema('assets/manifest.json', `packaging[${i}].status`, `"${String(p.status)}" is not a packaging status (recorded, not_checkable_yet)`);
      if (typeof p.target !== 'string' || typeof p.requirement !== 'string') schema('assets/manifest.json', `packaging[${i}]`, 'names its target and requirement');
      if (!isObj(p.guidance) || typeof p.guidance.source !== 'string' || typeof p.guidance.read_on !== 'string') schema('assets/manifest.json', `packaging[${i}].guidance`, 'names its source and the date it was read ({source, read_on})');
      else closed('assets/manifest.json', `packaging[${i}].guidance`, p.guidance, FIELDS.guidance);
    }
  } else if (manifest && manifest.packaging !== undefined) schema('assets/manifest.json', 'packaging', 'must be a list');
  if (manifest && Array.isArray(manifest.slots)) {
    const slots = manifest.slots.filter(isObj);
    for (const s of slots) {
      const key = String(s.key);
      // A slot key names directories the engine makes (the Builder's
      // package, a check's domain): a slug, nothing else (the slice-40 review's B1).
      if (!isSlug(s.key)) {
        add('DESIGN_ASSET_SLOT_KEY_INVALID', { slot: key, why: 'a slot key is a slug: a lower-case letter, then up to 63 lower-case letters, digits, _ or -' });
        continue;
      }
      if (!(ASSET_KINDS as readonly string[]).includes(String(s.kind))) schema('assets/manifest.json', `slots (${key}).kind`, `"${String(s.kind)}" is not an asset kind`);
      if (!(ASSET_STATUSES as readonly string[]).includes(String(s.status))) schema('assets/manifest.json', `slots (${key}).status`, 'not an asset status');
      if (!(ASSET_PROVENANCES as readonly string[]).includes(String(s.provenance))) schema('assets/manifest.json', `slots (${key}).provenance`, 'not an asset provenance');
      for (const p of strs(s.platforms) ? s.platforms : []) if (!invTargets.has(p)) add('DESIGN_ASSET_PLATFORM_UNKNOWN', { slot: key, target: p });
      if (['logo', 'banner', 'illustration'].includes(String(s.kind)) && (typeof s.alt_text !== 'string' || s.alt_text === '')) add('DESIGN_ASSET_ALT_MISSING', { slot: key });
      if (s.kind === 'banner' && typeof s.placement !== 'string') add('DESIGN_ASSET_PLACEMENT_MISSING', { slot: key });
      if (s.status === 'approved') {
        // Approved means the owner approved these files (§6.4): every file of
        // the slot's own (the engine's placeholder variants aside, which no
        // approval approves: a target added later extends an approved slot
        // with them, S2) is effective from an approval at the same digest.
        const was = ctx.approved.find((a) => a.slot === key);
        const placeholder = (variant: string) => ctx.placeholders?.slots.find((p) => p.key === key)?.variants.find((x) => x.name === variant)?.digest;
        const own = (s.variants ?? []).filter((v) => typeof v.digest === 'string' && v.digest !== placeholder(String(v.name)));
        if (!was || own.length === 0 || own.some((v) => was.digests[String(v.name)] !== v.digest)) add('DESIGN_ASSET_STATUS_FORGED', { slot: key });
      }
      if (s.kind === 'illustration' && typeof s.placement !== 'string' && !(strs(s.screens) && s.screens.length > 0)) add('DESIGN_ASSET_PLACEMENT_MISSING', { slot: key });
      // The status `placeholder` is the engine's alone (SEAM.md §505).
      if (s.status === 'placeholder' && s.provenance !== 'engine_placeholder') add('DESIGN_ASSET_STATUS_FORGED', { slot: key, why: 'only an engine placeholder has the status placeholder' });
      // The versions against the base (SEAM.md §505): a slot whose files
      // differ from the base's carries a higher slot_version; a new slot starts at 1.
      const was = baseSlots.get(key);
      if (typeof s.slot_version !== 'number' || !Number.isInteger(s.slot_version) || s.slot_version < 1) add('DESIGN_ASSET_VERSION_INVALID', { slot: key, why: 'slot_version is a positive integer' });
      else if (was && filesOf(s) !== filesOf(was) && !(s.slot_version > was.slot_version)) add('DESIGN_ASSET_VERSION_INVALID', { slot: key, slot_version: s.slot_version, base_slot_version: was.slot_version, why: 'the slot\'s files changed and its slot_version did not increase' });
      const selectedVariants = new Set((Array.isArray(selection.slots) ? selection.slots : []).filter(isObj).filter((x) => x.kind === s.kind).flatMap((x) => (strs(x.variants) ? x.variants : [])));
      for (const v of (Array.isArray(s.variants) ? s.variants : []).filter(isObj)) {
        if (!(ASSET_VARIANTS as readonly string[]).includes(String(v.name))) schema('assets/manifest.json', `slots (${key}).variants.name`, `"${String(v.name)}" is not an asset variant`);
        if (!(ASSET_FORMATS as readonly string[]).includes(String(v.format))) schema('assets/manifest.json', `slots (${key}).variants.format`, `"${String(v.format)}" is not an asset format`);
        if (typeof v.file !== 'string') {
          if (selectedVariants.has(String(v.name))) add('DESIGN_ASSET_FILE_MISSING', { slot: key, variant: String(v.name), why: 'the selected variant names no file' });
          continue;
        }
        const file = tree.files.get(v.file);
        if (!file) {
          add('DESIGN_ASSET_FILE_MISSING', { slot: key, variant: String(v.name), file: v.file });
          continue;
        }
        for (const r of headerReasons(file, v, { slot: key, variant: String(v.name), file: v.file })) add(r.code, r.subjects);
        if (typeof v.digest === 'string' && v.digest !== sha256hex(file)) add('DESIGN_ASSET_VERSION_INVALID', { slot: key, variant: String(v.name), why: 'the digest is not the file\'s' });
      }
    }
    // The manifest's version against the base's (SEAM.md §505).
    if (base && manifestBody(manifest) !== manifestBody(base) && !(typeof manifest.version === 'number' && manifest.version > base.version)) {
      add('DESIGN_ASSET_VERSION_INVALID', { version: manifest.version ?? null, base_version: base.version, why: 'the manifest changed and its version did not increase' });
    }
    // The selection: each selected slot and variant in the manifest (§6.2), and the floor (§5.8).
    for (const sel of (Array.isArray(selection.slots) ? selection.slots : []).filter(isObj)) {
      const slot = slots.find((s) => s.kind === sel.kind);
      for (const v of strs(sel.variants) ? sel.variants : []) if (!slot || !(slot.variants ?? []).some((x) => x.name === v)) add('DESIGN_ASSET_SLOT_MISSING', { kind: String(sel.kind), variant: v });
    }
  }
  if (design && inv) {
    const themesSel = strs(selection.themes) ? selection.themes : [];
    const dropped: string[] = [];
    if (themesSel.length === 0) dropped.push('every theme');
    const slotSel = (Array.isArray(selection.slots) ? selection.slots : []).filter(isObj);
    const logo = slotSel.find((s) => s.kind === 'logo');
    if (!logo || !strs(logo.variants) || logo.variants.length === 0) dropped.push('the logo');
    for (const t of inv.targets) {
      const kind = t.target === 'web' ? 'favicon' : 'app_icon';
      const s = slotSel.find((x) => x.kind === kind);
      if (!s || !strs(s.variants) || s.variants.length === 0) dropped.push(`the ${kind} of ${t.target}`);
      if (selectedLayouts(t.target).length === 0 && t.layouts.length > 0) dropped.push(`every layout of ${t.target}`);
    }
    for (const d of new Set(dropped)) add('DESIGN_SELECTION_BELOW_FLOOR', { dropped: d });
  }
  // Under `at_alpha`, for an observed design only (D7 §12; the slice-45
  // review's S5): shown, not refusing.
  const shown = ctx.policy === 'at_alpha' && isObj(design) && design.origin === 'observed' ? reasons.filter((r) => NOTICE_CODES.includes(r.code)) : [];
  const refusing = reasons.filter((r) => !shown.includes(r));
  return { outcome: refusing.length === 0 ? 'passed' : 'refused', reasons: refusing, notices: shown, design };
}

// What a selection narrows below the inventory's defaults (§5.8), as the
// approval lists it ("narrowed: dark theme; logo variants monochrome, on_dark").
export function narrowings(design: Record<string, unknown> | null, inv: Inventory | null): string[] {
  if (!design || !inv) return [];
  const sel = isObj(design.selection) ? design.selection : {};
  const out: string[] = [];
  const themes = strs(sel.themes) ? sel.themes : [];
  for (const t of ['light', 'dark']) if (!themes.includes(t)) out.push(`theme ${t}`);
  const defaults = new Map<string, Set<string>>();
  for (const t of inv.targets) for (const s of t.required_slots) defaults.set(s.kind, new Set([...(defaults.get(s.kind) ?? []), ...s.variants]));
  const slots = (Array.isArray(sel.slots) ? sel.slots : []).filter(isObj);
  for (const [kind, variants] of defaults) {
    const chosen = slots.find((s) => s.kind === kind);
    const kept = new Set(strs(chosen?.variants) ? chosen!.variants : []);
    const lost = [...variants].filter((v) => !kept.has(v));
    if (lost.length > 0) out.push(`${kind} variants ${lost.join(', ')}`);
  }
  const layouts = (Array.isArray(sel.layouts) ? sel.layouts : []).filter(isObj);
  for (const t of inv.targets) {
    const chosen = layouts.find((l) => l.target === t.target);
    if (!chosen || !Array.isArray(chosen.layouts)) continue;
    const lost = t.layouts.filter((l) => !(chosen.layouts as unknown[]).map(String).includes(String(l)));
    if (lost.length > 0) out.push(`${t.target} layouts ${lost.join(', ')}`);
  }
  return out;
}
