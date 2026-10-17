// The interface inventory (D7 §4.2 to §4.4; Appendix B.9; G1, G3; SEAM.md
// §484): a pure function of the approved bundle (the specification's
// representation, the module map, the published plans' stages, the ADRs, the
// environment's runtime) and the project's design policy. It derives
// obligations, never screens (§4.3): per target a consuming `ui` module
// serves, `loading`, `error:<code>`, `empty`, `invalid_input`, `ok` and
// `permission_denied:<permission>`; the targets with their technology,
// preview capability, layouts, required conventions and default asset
// slots; the UI requirements; and deterministic fixtures generated from the
// shapes with a seed taken from the inventory's digest (§4.4).
//
// `invalid_input` is one obligation per interface and target whose request
// holds a property with a bound or an enum (objection 125, decided by the
// driver under Sean's delegation: B.9's obligation has no property field).
// The inventory names no project: two projects with the same bundle derive
// byte-identical files (the placeholders, which do name the project, are
// assets/, not the inventory).

import { canonical, sha256 } from '../store/transitions/common.js';
import type { ModuleMap, Shape } from '../plan/schemas.js';
import { DEFAULT_SLOTS, type SlotSpec } from './assets.js';

export const DESIGN_ROOT = '.surety/design/';
export const INVENTORY_DIR = '.surety/design/inventory/';
export const INVENTORY_FILE = '.surety/design/inventory/inventory.json';
export const FIXTURE_DIR = 'inventory/fixtures/';

export type PreviewCapability = 'native' | 'simulated' | 'none';

export interface InventoryTarget {
  module: string;
  target: string;
  ui_technology: string;
  form_factors: string[];
  preview_capability: PreviewCapability;
  layouts: (number | string)[];
  required_conventions: string[];
  permissions: string[];
  required_slots: { kind: string; variants: string[] }[];
  adrs: string[];
  runtime: string | null;
}

export interface InventoryInterface {
  name: string;
  module: string;
  kind: string;
  path?: string;
  request?: Shape;
  response?: Shape;
  errors: { code: string; when: string }[];
  shape_known: boolean;
}

export interface Obligation {
  target: string;
  interface?: string;
  permission?: string;
  state: string;
}

export interface Inventory {
  inventory_digest: string;
  spec_version: number | null;
  architecture_version: number | null;
  targets: InventoryTarget[];
  cross_platform: boolean;
  ui_requirements: { key: string; phase: number | null; modules: string[]; targets: string[] }[];
  interfaces: InventoryInterface[];
  obligations: Obligation[];
  fixtures: { interface: string; state: string; path: string }[];
}

// What the derivation reads (design/store.ts inventoryFacts).
export interface InventoryInputs {
  spec_version: number | null;
  architecture_version: number | null;
  // The header's targets (G3), null when the specification states none.
  spec_targets: string[] | null;
  cross_platform: boolean;
  requirements: { key: string; phase: number | null; human_test: boolean; surface: 'ui' | null; surface_targets: string[] | null }[];
  modules: ModuleMap;
  // The published plans' stages: their modules' names and the requirement
  // keys they implement.
  stages: { modules: string[]; implements: string[]; conformance?: boolean }[];
  adrs: { key: string; text: string }[];
  runtime: string | null;
  policy: { design_preview: string; design_widths: number[]; design_orientations: string[] };
  // Requirement keys that are never UI requirements: the design's own
  // human-test requirements (D7 §7.4).
  exclude: string[];
}

// D7 §5.2: what the engine can show for a module's target.
export function previewCapability(target: string, technology: string, designPreview: string): PreviewCapability {
  if (designPreview === 'off') return 'none';
  if (target === 'web' && (technology === 'html_css' || technology === 'three_js')) return 'native';
  return 'simulated';
}

// D7 §5.3 as B.12's field names (SEAM.md §484): what each screen of a target
// declares. `permissions` for android and ios only when the target has one.
export function requiredConventions(target: string, hasPermission: boolean): string[] {
  if (target === 'web') return ['route|transient', 'browser_back', 'keyboard_path'];
  if (target === 'android') return ['back', ...(hasPermission ? ['permissions'] : []), 'gestures'];
  if (target === 'ios') return ['container', 'edge_swipe_back', 'safe_area_edges', ...(hasPermission ? ['permissions'] : [])];
  return ['window_min', 'menu_entries', 'shortcuts'];
}

// D7 §4.2, A.7: web the configured widths; android and ios each form factor
// in each orientation; a desktop target none until a design declares its window.
export function targetLayouts(target: string, formFactors: string[], policy: InventoryInputs['policy']): (number | string)[] {
  if (target === 'web') return [...policy.design_widths];
  if (target === 'android' || target === 'ios') return (formFactors.length > 0 ? formFactors : ['phone']).flatMap((f) => policy.design_orientations.map((o) => `${f}-${o}`));
  return [];
}

// D7 §6.2: the default slots of a target, by kind and variant.
export function defaultSlotsOf(target: string): { kind: string; variants: string[] }[] {
  return DEFAULT_SLOTS.filter((s: SlotSpec) => s.platforms(target)).map((s) => ({ kind: s.kind, variants: [...s.variants(target)] }));
}

const isHttpish = (kind: string) => kind === 'http' || kind === 'event';

// Whether a shape holds a `collection` anywhere.
export function holdsCollection(shape: Shape | undefined): boolean {
  if (!shape) return false;
  if (shape.collection === true) return true;
  if (shape.items && holdsCollection(shape.items)) return true;
  return Object.values(shape.properties ?? {}).some(holdsCollection);
}

const bounded = (s: Shape): boolean => s.minimum !== undefined || s.maximum !== undefined || s.minLength !== undefined || s.maxLength !== undefined || (s.enum !== undefined && s.enum.length > 0);

// Whether a request holds a property with a bound or an enum (top level,
// declared order), and the first such property.
export function firstBounded(shape: Shape | undefined): string | null {
  for (const [name, p] of Object.entries(shape?.properties ?? {})) if (bounded(p)) return name;
  return null;
}

export function deriveInventory(input: InventoryInputs): Inventory {
  const map = input.modules;
  const uiModules = map.modules.filter((m) => m.surface === 'ui');
  const uiNames = new Set(uiModules.map((m) => m.name));
  const targetsOf = (module: string): string[] => (map.modules.find((m) => m.name === module)?.targets ?? []).map((t) => t.target);
  // Targets, per `ui` module and target (B.9).
  const targets: InventoryTarget[] = [];
  for (const m of uiModules) {
    for (const t of m.targets ?? []) {
      // The approved specification's targets bound the design (G3, Q7): a
      // target the header removed is no longer the inventory's (D7 §9.1).
      if (input.spec_targets !== null && !input.spec_targets.includes(t.target)) continue;
      const permissions = (m.platform_permissions ?? []).filter((p) => p.target === t.target).map((p) => p.permission);
      targets.push({
        module: m.name,
        target: t.target,
        ui_technology: t.ui_technology,
        form_factors: [...(t.form_factors ?? [])],
        preview_capability: previewCapability(t.target, t.ui_technology, input.policy.design_preview),
        layouts: targetLayouts(t.target, t.form_factors ?? [], input.policy),
        required_conventions: requiredConventions(t.target, permissions.length > 0),
        permissions,
        required_slots: defaultSlotsOf(t.target),
        // The ADRs that name the module's technology or the module.
        adrs: input.adrs.filter((a) => a.text.includes(t.ui_technology)).map((a) => a.key).sort(),
        runtime: input.runtime,
      });
    }
  }
  // Interfaces a `ui` module consumes or exposes (§4.2).
  const interfaces: InventoryInterface[] = [];
  const consumersOf = new Map<string, string[]>();
  // Declared unshapeable (D7 §12): nothing is derived from it.
  const unshaped = new Set<string>();
  for (const m of map.modules) {
    for (const f of m.interfaces) {
      const consumers = (f.consumed_by ?? []).filter((c) => uiNames.has(c));
      const exposed = uiNames.has(m.name);
      if (consumers.length === 0 && !exposed) continue;
      consumersOf.set(f.name, [...new Set([...consumers, ...(exposed ? [m.name] : [])])]);
      interfaces.push({
        name: f.name,
        module: m.name,
        kind: f.kind,
        ...(f.path !== undefined ? { path: f.path } : {}),
        ...(f.request ? { request: f.request } : {}),
        ...(f.response ? { response: f.response } : {}),
        errors: [...(f.errors ?? [])],
        shape_known: f.shape !== 'unknown' && f.request !== undefined && f.response !== undefined,
      });
      if (f.shape === 'unknown') unshaped.add(f.name);
    }
  }
  // State obligations, per target the consuming modules serve (§4.2).
  const obligations: Obligation[] = [];
  const seen = new Set<string>();
  const push = (o: Obligation) => {
    const k = `${o.target}|${o.interface ?? ''}|${o.permission ?? ''}|${o.state}`;
    if (seen.has(k)) return;
    seen.add(k);
    obligations.push(o);
  };
  for (const t of targets) {
    for (const f of interfaces) {
      if (unshaped.has(f.name)) continue;
      if (!(consumersOf.get(f.name) ?? []).some((c) => targetsOf(c).includes(t.target) && c === t.module)) continue;
      if (isHttpish(f.kind)) push({ target: t.target, interface: f.name, state: 'loading' });
      for (const e of f.errors) push({ target: t.target, interface: f.name, state: `error:${e.code}` });
      if (holdsCollection(f.response)) push({ target: t.target, interface: f.name, state: 'empty' });
      if (firstBounded(f.request) !== null) push({ target: t.target, interface: f.name, state: 'invalid_input' });
      push({ target: t.target, interface: f.name, state: 'ok' });
    }
    for (const p of t.permissions) push({ target: t.target, permission: p, state: `permission_denied:${p}` });
  }
  // UI requirements (§4.2): implemented by a UI stage, or marked.
  const uiStageTargets = (key: string): { modules: string[]; targets: string[] } => {
    const modules = new Set<string>();
    // A conformance stage builds nothing: its requirements are UI
    // requirements only by the mark (objection 150).
    for (const s of input.stages) if (!s.conformance && s.implements.includes(key)) for (const m of s.modules) if (uiNames.has(m)) modules.add(m);
    const ts = new Set<string>();
    for (const m of modules) for (const t of targetsOf(m)) if (input.spec_targets === null || input.spec_targets.includes(t)) ts.add(t);
    return { modules: [...modules].sort(), targets: [...ts] };
  };
  const ui_requirements: Inventory['ui_requirements'] = [];
  for (const r of input.requirements) {
    if (input.exclude.includes(r.key)) continue;
    const staged = uiStageTargets(r.key);
    if (r.surface === 'ui') {
      ui_requirements.push({ key: r.key, phase: r.phase, modules: staged.modules, targets: r.surface_targets ?? [...(input.spec_targets ?? [])] });
    } else if (staged.modules.length > 0) {
      ui_requirements.push({ key: r.key, phase: r.phase, modules: staged.modules, targets: staged.targets });
    }
  }
  ui_requirements.sort((a, b) => keyOrder(a.key) - keyOrder(b.key));
  const core = {
    targets,
    cross_platform: input.cross_platform,
    ui_requirements,
    interfaces,
    obligations,
  };
  // The digest is of what the design is drawn against, never of version
  // numbers: a specification change that changes no UI requirement, shape or
  // target leaves it as it was (D7 §7.4).
  const digest = sha256(canonical(core));
  const fixtures: Inventory['fixtures'] = [];
  const fseen = new Set<string>();
  for (const o of obligations) {
    if (!o.interface) continue;
    const k = `${o.interface}|${o.state}`;
    if (fseen.has(k)) continue;
    fseen.add(k);
    fixtures.push({ interface: o.interface, state: o.state, path: `${FIXTURE_DIR}${o.interface}.${o.state}.json` });
  }
  return { inventory_digest: digest, spec_version: input.spec_version, architecture_version: input.architecture_version, ...core, fixtures };
}

const keyOrder = (k: string): number => Number(/^R(\d+)/.exec(k)?.[1] ?? 0);

// ---- fixtures (D7 §4.4) ----------------------------------------------------------------------

// A deterministic stream of numbers from a seed (sha256 counter mode).
class Seeded {
  private n = 0;
  constructor(private readonly seed: string) {}
  next(): number {
    const h = sha256(`${this.seed}:${this.n++}`);
    return parseInt(h.slice(0, 8), 16) / 0x1_0000_0000;
  }
  int(min: number, max: number): number {
    return Math.floor(min + this.next() * (max - min + 1));
  }
}

const mainType = (s: Shape): string => (Array.isArray(s.type) ? (s.type.find((t) => t !== 'null') ?? 'null') : s.type);

// A value valid against `shape`, named from `name` and the bounds; a
// collection holds `n` items.
function valueOf(shape: Shape | undefined, name: string, rnd: Seeded, n: number): unknown {
  if (!shape) return null;
  if (shape.enum && shape.enum.length > 0) return shape.enum[rnd.int(0, shape.enum.length - 1)];
  switch (mainType(shape)) {
    case 'null':
      return null;
    case 'boolean':
      return rnd.next() < 0.5;
    case 'integer': {
      const min = Math.ceil(shape.minimum ?? 0);
      const max = Math.floor(shape.maximum ?? min + 99);
      return max < min ? min : rnd.int(min, max);
    }
    case 'number': {
      const min = shape.minimum ?? 0;
      const max = shape.maximum ?? min + 100;
      return Math.round((min + rnd.next() * (max - min)) * 100) / 100;
    }
    case 'string': {
      const min = shape.minLength ?? 1;
      const max = shape.maxLength ?? Math.max(min, 24);
      let s = `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'value'}-${rnd.int(1, 999)}`;
      if (s.length > max) s = s.slice(0, Math.max(max, 0));
      while (s.length < min) s += 'x';
      return s;
    }
    case 'array': {
      const count = shape.collection === true ? n : Math.max(shape.minLength ?? 1, 1);
      return Array.from({ length: count }, (_, i) => valueOf(shape.items, `${name}-${i + 1}`, rnd, n));
    }
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, p] of Object.entries(shape.properties ?? {})) out[k] = valueOf(p, k, rnd, n);
      return out;
    }
    default:
      return null;
  }
}

// A value violating the first bound of `p` (D7 §4.4).
function violating(p: Shape, name: string): unknown {
  if (p.minimum !== undefined) return p.minimum - 1;
  if (p.maximum !== undefined) return p.maximum + 1;
  if (p.minLength !== undefined) return p.minLength > 0 ? '' : 'x'.repeat((p.maxLength ?? 0) + 1);
  if (p.maxLength !== undefined) return 'x'.repeat(p.maxLength + 1);
  if (p.enum && p.enum.length > 0) return `not-${String(p.enum[0])}-${name}`;
  return null;
}

// Each fixture's text: path (relative to .surety/design/) → JSON text.
export function fixtureFiles(inv: Inventory): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of inv.fixtures) {
    const iface = inv.interfaces.find((i) => i.name === f.interface);
    const rnd = new Seeded(`${inv.inventory_digest}:${f.interface}:${f.state}`);
    let value: unknown;
    if (f.state === 'ok') value = valueOf(iface?.response, f.interface, rnd, 3);
    else if (f.state === 'empty') value = valueOf(iface?.response, f.interface, rnd, 0);
    else if (f.state === 'loading') value = null;
    else if (f.state.startsWith('error:')) {
      const code = f.state.slice('error:'.length);
      value = { code, message: iface?.errors.find((e) => e.code === code)?.when ?? code };
    } else if (f.state === 'invalid_input') {
      const req = iface?.request;
      const v = valueOf(req, f.interface, rnd, 1);
      const first = firstBounded(req);
      if (first !== null && v !== null && typeof v === 'object' && !Array.isArray(v)) (v as Record<string, unknown>)[first] = violating(req!.properties![first]!, first);
      value = v;
    } else value = null;
    out[f.path] = `${JSON.stringify(value, null, 2)}\n`;
  }
  return out;
}

export const inventoryText = (inv: Inventory): string => `${JSON.stringify(inv, null, 2)}\n`;
