// The machine files the Architect writes and the engine parses (D6 §3.3,
// Appendix B.3 to B.6): closed schemas, an unknown field refused by name,
// every value in the form the engine takes (D3 §1.4's rule applied to the
// plan). Pure: each parser takes text and gives the value or the refusal
// naming the file and the field. Nothing a session writes is run (BS5 §4.1
// rule 14): a plan is parsed and registered, never executed.

import { CHECK_KINDS as KINDS, SENSITIVE_AREAS } from '../checks/schema.js';

export interface SchemaFinding {
  file: string;
  field: string | null;
  why: string;
  // A reason code of its own (D7 §4.1; SEAM.md §481), where the refusal is
  // not an unknown field or a malformed file.
  code?: string;
}

// `also`: further refusals of the same file found beside the first (a module
// map's shapes, axes and consumers, D7 §4.1: each named).
export type Parsed<T> = { ok: true; value: T } | { ok: false; finding: SchemaFinding; also?: SchemaFinding[] };

const refuse = <T>(file: string, field: string | null, why: string, code?: string): Parsed<T> => ({ ok: false, finding: { file, field, why, ...(code ? { code } : {}) } });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const KEY = /^R[1-9][0-9]*$/;
const CRITERION = /^R[1-9][0-9]*\.[1-9][0-9]*$/;
const ADR_KEY = /^ADR-[0-9]{3,}$/;
// B.5 `kinds: [CheckKind]`: every kind of F §5.7 (D3 A.2), the floor's included.
const CHECK_KINDS = new Set(KINDS);
export const INTERFACE_KINDS = ['http', 'cli', 'module', 'file', 'event'];

// Each closed schema's fields as the parsers below take them, exported so
// that the Architect's package states exactly these (src/packages/reads.ts;
// E135; M442). `required` ⊆ `fields`.
export const B3 = {
  file: { fields: ['version', 'modules', 'mapping_from_spec'], required: ['version', 'modules', 'mapping_from_spec'] },
  // D7 §4.1, G1 (M6): `surface`; for a `ui` module its `targets`, the
  // `platform_permissions` of android, ios and macos, and the Architect's
  // declared `asset_paths` (B.17).
  module: {
    fields: ['name', 'paths', 'sensitive_areas', 'tier_override', 'interfaces', 'requirements', 'surface', 'targets', 'platform_permissions', 'asset_paths'],
    required: ['name', 'paths', 'sensitive_areas', 'interfaces'],
  },
  // G1: `consumed_by` (modules of this project only, D8 H9) and the shapes
  // and errors of B.8.
  interface: { fields: ['name', 'kind', 'path', 'description', 'consumed_by', 'request', 'response', 'errors'], required: ['name', 'kind', 'description'] },
  mapping: { fields: ['spec_module', 'to'], required: ['spec_module', 'to'] },
  target: { fields: ['target', 'ui_technology', 'form_factors'], required: ['target', 'ui_technology'] },
  permission: { fields: ['target', 'permission', 'why'], required: ['target', 'permission', 'why'] },
  asset_path: { fields: ['slot', 'variant', 'target', 'path'], required: ['slot', 'variant', 'target', 'path'] },
  error: { fields: ['code', 'when'], required: ['code', 'when'] },
} as const;

// D7 A.2: the module surfaces, the UI technologies, the form factors, and
// the targets that take platform permissions (§4.1).
export const MODULE_SURFACES = ['ui', 'api', 'cli', 'library', 'none'] as const;
export const UI_TECHNOLOGIES = ['html_css', 'three_js', 'streamlit', 'react_native', 'flutter', 'swiftui', 'compose', 'other'] as const;
export const FORM_FACTORS = ['phone', 'tablet'] as const;
const MOBILE_TARGETS = ['android', 'ios'];
const PERMISSION_TARGETS = ['android', 'ios', 'macos'];
const TARGET_NAMES = ['web', 'android', 'ios', 'macos', 'windows', 'linux'];

// ---- B.8 the shape language ------------------------------------------------------------

// `{type, properties?, required?, enum?, minimum?, maximum?, minLength?,
// maxLength?, items?, collection?, unit?}`; no references, no union beyond
// one type with `null` (D7 Appendix B.8).
export const B8 = { fields: ['type', 'properties', 'required', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'items', 'collection', 'unit'] } as const;
export const SHAPE_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'] as const;

export interface Shape {
  type: string | [string, string];
  properties?: Record<string, Shape>;
  required?: string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  items?: Shape;
  collection?: boolean;
  unit?: string;
}
export const B4 = {
  file: { fields: ['version', 'architecture_version', 'phases', 'moved_requirements'], required: ['version', 'architecture_version', 'phases'] },
  phase: { fields: ['number', 'goal', 'modules', 'requirement_ids', 'depends_on'], required: ['number', 'goal', 'modules', 'requirement_ids', 'depends_on'] },
  moved: { fields: ['key', 'from', 'to'], required: ['key', 'from', 'to'] },
} as const;
export const B5 = {
  file: { fields: ['phase', 'prepared_against', 'stages', 'conformance', 'roadmap_revision', 'notes'], required: ['phase', 'prepared_against', 'stages', 'conformance'] },
  prepared_against: { fields: ['spec_version', 'architecture_version', 'roadmap_version', 'revision'], required: ['spec_version', 'architecture_version', 'roadmap_version', 'revision'] },
  stage: {
    // G6 (D7 §8.1): `screens`, keys of the approved design, optional.
    fields: ['number', 'goal', 'tasks', 'modules', 'implements', 'adrs', 'depends_on', 'validation', 'integration_obligations', 'conformance', 'screens'],
    required: ['number', 'goal', 'tasks', 'modules', 'implements', 'adrs', 'depends_on', 'validation', 'integration_obligations'],
  },
  validation: { fields: ['criteria', 'kinds', 'sensitive_areas'], required: ['criteria', 'kinds', 'sensitive_areas'] },
  conformance_values: ['within_baseline', 'uncertain'],
} as const;

function parseJsonObject(file: string, text: string): Parsed<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return refuse(file, null, 'is not JSON');
  }
  if (!isObj(value)) return refuse(file, null, 'is not a JSON object');
  return { ok: true, value };
}

// The fields an object may hold, and no other.
function closed(file: string, at: string, o: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): SchemaFinding | null {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) return { file, field: at === '' ? k : `${at}.${k}`, why: `"${k}" is not a field of ${at === '' ? 'the file' : at}` };
  for (const k of required) if (!(k in o)) return { file, field: at === '' ? k : `${at}.${k}`, why: `"${k}" is missing` };
  return null;
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;

// A shape in B.8's language, or the refusal naming where it is wrong.
export function parseShape(file: string, at: string, v: unknown): Parsed<Shape> {
  if (!isObj(v)) return refuse(file, at, 'must be a shape object');
  const c = closed(file, at, v, B8.fields, ['type']);
  if (c) return { ok: false, finding: c };
  const t = v.type;
  const isType = (x: unknown) => typeof x === 'string' && (SHAPE_TYPES as readonly string[]).includes(x);
  if (Array.isArray(t)) {
    if (!(t.length === 2 && t.every(isType) && t.includes('null') && t[0] !== t[1])) return refuse(file, `${at}.type`, `a union is one type and "null" only, not ${JSON.stringify(t)}`, 'shape_union_invalid');
  } else if (!isType(t)) return refuse(file, `${at}.type`, `must be one of ${SHAPE_TYPES.join(', ')}`);
  const out: Shape = { type: t as Shape['type'] };
  if (v.properties !== undefined) {
    if (!isObj(v.properties)) return refuse(file, `${at}.properties`, 'must be an object of shapes');
    out.properties = {};
    for (const [k, sub] of Object.entries(v.properties)) {
      const p = parseShape(file, `${at}.properties.${k}`, sub);
      if (!p.ok) return p;
      out.properties[k] = p.value;
    }
  }
  if (v.required !== undefined) {
    if (!strings(v.required)) return refuse(file, `${at}.required`, 'must be an array of property names');
    out.required = v.required;
  }
  if (v.enum !== undefined) {
    if (!Array.isArray(v.enum) || v.enum.length === 0) return refuse(file, `${at}.enum`, 'must be a non-empty array');
    out.enum = v.enum;
  }
  for (const k of ['minimum', 'maximum'] as const) {
    if (v[k] === undefined) continue;
    if (typeof v[k] !== 'number' || !Number.isFinite(v[k])) return refuse(file, `${at}.${k}`, 'must be a number');
    out[k] = v[k] as number;
  }
  for (const k of ['minLength', 'maxLength'] as const) {
    if (v[k] === undefined) continue;
    if (typeof v[k] !== 'number' || !Number.isInteger(v[k]) || (v[k] as number) < 0) return refuse(file, `${at}.${k}`, 'must be a non-negative integer');
    out[k] = v[k] as number;
  }
  if (v.items !== undefined) {
    const p = parseShape(file, `${at}.items`, v.items);
    if (!p.ok) return p;
    out.items = p.value;
  }
  if (v.collection !== undefined) {
    if (typeof v.collection !== 'boolean') return refuse(file, `${at}.collection`, 'must be a boolean');
    out.collection = v.collection;
  }
  if (v.unit !== undefined) {
    if (typeof v.unit !== 'string' || v.unit === '') return refuse(file, `${at}.unit`, 'must be a non-empty string');
    out.unit = v.unit;
  }
  return { ok: true, value: out };
}

// The module's surface, targets, platform permissions and declared asset
// paths (D7 §4.1, G1), written onto `entry`; or the refusal.
function parseModuleAxes(file: string, at: string, m: Record<string, unknown>, entry: ModuleMapEntry): SchemaFinding | null {
  const fail = (field: string, why: string, code?: string): SchemaFinding => ({ file, field, why, ...(code ? { code } : {}) });
  if (m.surface !== undefined) {
    if (typeof m.surface !== 'string' || !(MODULE_SURFACES as readonly string[]).includes(m.surface)) return fail(`${at}.surface`, `must be one of ${MODULE_SURFACES.join(', ')}`);
    entry.surface = m.surface;
  }
  if (m.targets !== undefined) {
    if (!Array.isArray(m.targets)) return fail(`${at}.targets`, 'must be an array of {target, ui_technology, form_factors?}');
    const targets: ModuleTarget[] = [];
    for (const [k, t] of m.targets.entries()) {
      const tat = isObj(t) && typeof t.target === 'string' ? `${at}.targets[${k}] (${t.target})` : `${at}.targets[${k}]`;
      if (!isObj(t)) return fail(tat, 'must be an object');
      const ct = closed(file, tat, t, B3.target.fields, B3.target.required);
      if (ct) return ct;
      if (typeof t.target !== 'string' || !TARGET_NAMES.includes(t.target)) return fail(`${tat}.target`, `must be one of ${TARGET_NAMES.join(', ')}`);
      if (typeof t.ui_technology !== 'string' || !(UI_TECHNOLOGIES as readonly string[]).includes(t.ui_technology)) return fail(`${tat}.ui_technology`, `must be one of ${UI_TECHNOLOGIES.join(', ')}`);
      const target: ModuleTarget = { target: t.target, ui_technology: t.ui_technology };
      if (t.form_factors !== undefined) {
        if (!MOBILE_TARGETS.includes(t.target)) return fail(`${tat}.form_factors`, `form_factors are for android and ios only, not the target ${t.target}`, 'module_target_field_invalid');
        if (!strings(t.form_factors) || t.form_factors.length === 0 || !t.form_factors.every((f) => (FORM_FACTORS as readonly string[]).includes(f))) return fail(`${tat}.form_factors`, `must be a non-empty array of ${FORM_FACTORS.join(', ')}`);
        target.form_factors = t.form_factors;
      }
      targets.push(target);
    }
    entry.targets = targets;
  }
  if (m.platform_permissions !== undefined) {
    if (!Array.isArray(m.platform_permissions)) return fail(`${at}.platform_permissions`, 'must be an array of {target, permission, why}');
    const out: { target: string; permission: string; why: string }[] = [];
    for (const [k, p] of m.platform_permissions.entries()) {
      const pat = `${at}.platform_permissions[${k}]`;
      if (!isObj(p)) return fail(pat, 'must be an object');
      const cp = closed(file, pat, p, B3.permission.fields, B3.permission.required);
      if (cp) return cp;
      if (typeof p.target !== 'string' || typeof p.permission !== 'string' || p.permission === '' || typeof p.why !== 'string') return fail(pat, 'must be {target, permission, why}, each a string');
      if (!PERMISSION_TARGETS.includes(p.target)) return fail(`${pat}.target`, `platform_permissions names the target ${p.target}: only ${PERMISSION_TARGETS.join(', ')} take platform permissions`, 'module_target_field_invalid');
      out.push({ target: p.target, permission: p.permission, why: p.why });
    }
    entry.platform_permissions = out;
  }
  if (m.asset_paths !== undefined) {
    if (!Array.isArray(m.asset_paths)) return fail(`${at}.asset_paths`, 'must be an array of {slot, variant, target, path}');
    const out: { slot: string; variant: string; target: string; path: string }[] = [];
    for (const [k, a] of m.asset_paths.entries()) {
      const aat = `${at}.asset_paths[${k}]`;
      if (!isObj(a)) return fail(aat, 'must be an object');
      const ca = closed(file, aat, a, B3.asset_path.fields, B3.asset_path.required);
      if (ca) return ca;
      if (![a.slot, a.variant, a.target, a.path].every((x) => typeof x === 'string' && x !== '')) return fail(aat, 'must be {slot, variant, target, path}, each a non-empty string');
      out.push({ slot: a.slot as string, variant: a.variant as string, target: a.target as string, path: a.path as string });
    }
    entry.asset_paths = out;
  }
  return null;
}

// ---- B.3 modules.json ------------------------------------------------------------------

export interface ModuleInterface {
  name: string;
  kind: string;
  path?: string;
  description: string;
  // D7 §4.1, G1.
  consumed_by?: string[];
  request?: Shape;
  response?: Shape;
  errors?: { code: string; when: string }[];
}

export interface ModuleTarget {
  target: string;
  ui_technology: string;
  form_factors?: string[];
}

export interface ModuleMapEntry {
  name: string;
  paths: string[];
  sensitive_areas: string[];
  tier_override?: 'T1' | 'T2' | 'T3';
  interfaces: ModuleInterface[];
  // The requirements the module holds (Sean, 2026-10-13): what scoped
  // mode's "a stage touching a descriptive requirement's module" reads.
  requirements?: string[];
  // D7 §4.1, G1 (M6).
  surface?: string;
  targets?: ModuleTarget[];
  platform_permissions?: { target: string; permission: string; why: string }[];
  asset_paths?: { slot: string; variant: string; target: string; path: string }[];
}

export interface ModuleMap {
  version: 1;
  modules: ModuleMapEntry[];
  mapping_from_spec: { spec_module: string; to: string[] }[];
}

export const MODULES_FILE = '.surety/architecture/modules.json';

export function parseModuleMap(text: string, file = MODULES_FILE): Parsed<ModuleMap> {
  const p = parseJsonObject(file, text);
  if (!p.ok) return p;
  const o = p.value;
  const c = closed(file, '', o, B3.file.fields, B3.file.required);
  if (c) return { ok: false, finding: c };
  if (o.version !== 1) return refuse(file, 'version', 'must be 1');
  if (!Array.isArray(o.modules)) return refuse(file, 'modules', 'must be an array');
  const modules: ModuleMapEntry[] = [];
  const names = new Set<string>();
  const deferred: SchemaFinding[] = [];
  for (const [i, m] of o.modules.entries()) {
    // A module is named by its name where it has one (E6: the floor from day
    // one; SEAM.md §381: a dropped classification names the module).
    const at = isObj(m) && typeof m.name === 'string' && m.name !== '' ? `modules[${i}] (${m.name})` : `modules[${i}]`;
    if (!isObj(m)) return refuse(file, at, 'must be an object');
    const cm = closed(file, at, m, B3.module.fields, B3.module.required);
    if (cm) return { ok: false, finding: cm };
    if (typeof m.name !== 'string' || m.name === '') return refuse(file, `${at}.name`, 'must be a non-empty string');
    if (names.has(m.name)) return refuse(file, `${at}.name`, `the module ${m.name} is listed twice`);
    names.add(m.name);
    if (!strings(m.paths)) return refuse(file, `${at}.paths`, 'must be an array of paths');
    if (!strings(m.sensitive_areas)) return refuse(file, `${at}.sensitive_areas`, 'must be an array of sensitive areas');
    for (const a of m.sensitive_areas) if (!SENSITIVE_AREAS.includes(a)) return refuse(file, `${at}.sensitive_areas`, `"${a}" is not a sensitive area of the closed list`);
    if (m.tier_override !== undefined && m.tier_override !== 'T1' && m.tier_override !== 'T2' && m.tier_override !== 'T3') return refuse(file, `${at}.tier_override`, 'must be T1, T2 or T3');
    if (m.requirements !== undefined) {
      if (!strings(m.requirements)) return refuse(file, `${at}.requirements`, 'must be an array of requirement keys');
      for (const k of m.requirements) if (!KEY.test(k)) return refuse(file, `${at}.requirements`, `"${k}" is not a requirement key R<n>`);
    }
    if (!Array.isArray(m.interfaces)) return refuse(file, `${at}.interfaces`, 'must be an array');
    const interfaces: ModuleInterface[] = [];
    for (const [j, f] of m.interfaces.entries()) {
      // Named by its name where it has one (D7 §4.1: a refusal names the interface).
      const fat = isObj(f) && typeof f.name === 'string' && f.name !== '' ? `${at}.interfaces[${j}] (${f.name})` : `${at}.interfaces[${j}]`;
      if (!isObj(f)) return refuse(file, fat, 'must be an object');
      const cf = closed(file, fat, f, B3.interface.fields, B3.interface.required);
      if (cf) return { ok: false, finding: cf };
      if (typeof f.name !== 'string' || f.name === '') return refuse(file, `${fat}.name`, 'must be a non-empty string');
      if (typeof f.kind !== 'string' || !INTERFACE_KINDS.includes(f.kind)) return refuse(file, `${fat}.kind`, `must be one of ${INTERFACE_KINDS.join(', ')}`);
      if (f.path !== undefined && typeof f.path !== 'string') return refuse(file, `${fat}.path`, 'must be a string');
      if (typeof f.description !== 'string') return refuse(file, `${fat}.description`, 'must be a string');
      const iface: ModuleInterface = { name: f.name, kind: f.kind, ...(f.path !== undefined ? { path: f.path } : {}), description: f.description };
      if (f.consumed_by !== undefined) {
        if (!strings(f.consumed_by)) return refuse(file, `${fat}.consumed_by`, 'must be an array of module names');
        iface.consumed_by = f.consumed_by;
      }
      for (const k of ['request', 'response'] as const) {
        if (f[k] === undefined) continue;
        const shape = parseShape(file, `${fat}.${k}`, f[k]);
        // Every interface's shapes are read, so each refusal names its own
        // interface (one shape object may stand in two interfaces).
        if (!shape.ok) deferred.push(shape.finding);
        else iface[k] = shape.value;
      }
      if (f.errors !== undefined) {
        if (!Array.isArray(f.errors)) return refuse(file, `${fat}.errors`, 'must be an array of {code, when}');
        const errors: { code: string; when: string }[] = [];
        for (const [k, e] of f.errors.entries()) {
          const eat = `${fat}.errors[${k}]`;
          if (!isObj(e)) return refuse(file, eat, 'must be an object');
          const ce = closed(file, eat, e, B3.error.fields, B3.error.required);
          if (ce) return { ok: false, finding: ce };
          if (typeof e.code !== 'string' || e.code === '' || typeof e.when !== 'string') return refuse(file, eat, 'must be {code, when}, both strings');
          errors.push({ code: e.code, when: e.when });
        }
        iface.errors = errors;
      }
      interfaces.push(iface);
    }
    const entry: ModuleMapEntry = {
      name: m.name,
      paths: m.paths,
      sensitive_areas: m.sensitive_areas,
      ...(m.tier_override !== undefined ? { tier_override: m.tier_override as 'T1' } : {}),
      interfaces,
      ...(m.requirements !== undefined ? { requirements: m.requirements as string[] } : {}),
    };
    const axes = parseModuleAxes(file, at, m, entry);
    if (axes) deferred.push(axes);
    modules.push(entry);
  }
  // `consumed_by` names modules of this map only (D7 §4.1; D8 H9): another
  // project's module is an Integration, never a consumer.
  for (const [i, m] of modules.entries()) {
    for (const [j, f] of m.interfaces.entries()) {
      for (const c of f.consumed_by ?? []) {
        if (!names.has(c)) deferred.push({ file, field: `modules[${i}] (${m.name}).interfaces[${j}] (${f.name}).consumed_by`, why: `names "${c}", which is not a module of this map (a consumer is a module of this project only)`, code: 'interface_consumer_unknown' });
      }
    }
  }
  if (deferred.length > 0) return { ok: false, finding: deferred[0]!, also: deferred.slice(1) };
  if (!Array.isArray(o.mapping_from_spec)) return refuse(file, 'mapping_from_spec', 'must be an array');
  const mapping: ModuleMap['mapping_from_spec'] = [];
  for (const [i, e] of o.mapping_from_spec.entries()) {
    const at = `mapping_from_spec[${i}]`;
    if (!isObj(e)) return refuse(file, at, 'must be an object');
    const ce = closed(file, at, e, B3.mapping.fields, B3.mapping.required);
    if (ce) return { ok: false, finding: ce };
    if (typeof e.spec_module !== 'string' || e.spec_module === '') return refuse(file, `${at}.spec_module`, 'must be a non-empty string');
    if (!strings(e.to)) return refuse(file, `${at}.to`, 'must be an array of module names');
    for (const name of e.to) if (!names.has(name)) return refuse(file, `${at}.to`, `names the module "${name}", which the map does not define`);
    mapping.push({ spec_module: e.spec_module, to: e.to });
  }
  return { ok: true, value: { version: 1, modules, mapping_from_spec: mapping } };
}

// ---- B.4 roadmap.json ------------------------------------------------------------------

export interface RoadmapPhase {
  number: number;
  goal: string;
  modules: string[];
  requirement_ids: string[];
  depends_on: number[];
}

export interface Roadmap {
  version: number;
  architecture_version: number;
  phases: RoadmapPhase[];
  // `from` null: a requirement with no phase yet (D6 §4.5; reading 6; Q10).
  moved_requirements?: { key: string; from: number | null; to: number }[];
}

export const ROADMAP_FILE = '.surety/roadmap/roadmap.json';

export function parseRoadmap(text: string, file = ROADMAP_FILE): Parsed<Roadmap> {
  const p = parseJsonObject(file, text);
  if (!p.ok) return p;
  const o = p.value;
  const c = closed(file, '', o, B4.file.fields, B4.file.required);
  if (c) return { ok: false, finding: c };
  if (!posInt(o.version)) return refuse(file, 'version', 'must be a positive integer');
  if (!posInt(o.architecture_version)) return refuse(file, 'architecture_version', 'must be a positive integer');
  if (!Array.isArray(o.phases) || o.phases.length === 0) return refuse(file, 'phases', 'must be a non-empty array');
  const phases: RoadmapPhase[] = [];
  const numbers = new Set<number>();
  for (const [i, ph] of o.phases.entries()) {
    const at = `phases[${i}]`;
    if (!isObj(ph)) return refuse(file, at, 'must be an object');
    const cp = closed(file, at, ph, B4.phase.fields, B4.phase.required);
    if (cp) return { ok: false, finding: cp };
    if (!posInt(ph.number)) return refuse(file, `${at}.number`, 'must be a positive integer');
    if (numbers.has(ph.number)) return refuse(file, `${at}.number`, `phase ${ph.number} is listed twice`);
    numbers.add(ph.number);
    if (typeof ph.goal !== 'string' || ph.goal.trim() === '') return refuse(file, `${at}.goal`, 'must be a non-empty string');
    if (!strings(ph.modules)) return refuse(file, `${at}.modules`, 'must be an array of module names');
    if (!strings(ph.requirement_ids)) return refuse(file, `${at}.requirement_ids`, 'must be an array of requirement keys');
    for (const k of ph.requirement_ids) if (!KEY.test(k)) return refuse(file, `${at}.requirement_ids`, `"${k}" is not a requirement key R<n>`);
    if (!Array.isArray(ph.depends_on) || !ph.depends_on.every(posInt)) return refuse(file, `${at}.depends_on`, 'must be an array of phase numbers');
    phases.push({ number: ph.number, goal: ph.goal, modules: ph.modules, requirement_ids: ph.requirement_ids, depends_on: ph.depends_on as number[] });
  }
  let moved: Roadmap['moved_requirements'];
  if (o.moved_requirements !== undefined) {
    if (!Array.isArray(o.moved_requirements)) return refuse(file, 'moved_requirements', 'must be an array');
    moved = [];
    for (const [i, m] of o.moved_requirements.entries()) {
      const at = `moved_requirements[${i}]`;
      if (!isObj(m)) return refuse(file, at, 'must be an object');
      const cm = closed(file, at, m, B4.moved.fields, B4.moved.required);
      if (cm) return { ok: false, finding: cm };
      if (typeof m.key !== 'string' || !KEY.test(m.key)) return refuse(file, `${at}.key`, 'must be a requirement key');
      if ((m.from !== null && !posInt(m.from)) || !posInt(m.to)) return refuse(file, `${at}.from`, 'from must be a phase number or null, and to a phase number');
      moved.push({ key: m.key, from: m.from, to: m.to });
    }
  }
  return { ok: true, value: { version: o.version, architecture_version: o.architecture_version, phases, ...(moved ? { moved_requirements: moved } : {}) } };
}

// ---- B.5 phase-<n>.json ----------------------------------------------------------------

export interface PlanStage {
  number: number;
  goal: string;
  tasks: string[];
  modules: string[];
  implements: string[];
  adrs: string[];
  depends_on: number[];
  validation: { criteria: string[]; kinds: string[]; sensitive_areas: string[] };
  integration_obligations: string[];
  conformance?: boolean;
  // D7 §8.1 (G6): the approved design's screens the stage implements, when
  // the plan names them; the plan check verifies them (PLAN_SCREEN_UNKNOWN).
  screens?: string[];
}

export interface PhasePlanFile {
  phase: number;
  prepared_against: { spec_version: number; architecture_version: number; roadmap_version: number; revision: string };
  stages: PlanStage[];
  conformance: 'within_baseline' | 'uncertain';
  roadmap_revision?: Roadmap;
  notes?: string;
}

export const PLAN_FILE = /^\.surety\/phases\/phase-([1-9][0-9]*)\.json$/;
export const planPath = (phase: number | '<n>'): string => `.surety/phases/phase-${phase}.json`;

export function parsePhasePlan(text: string, file: string, phase: number): Parsed<PhasePlanFile> {
  const p = parseJsonObject(file, text);
  if (!p.ok) return p;
  const o = p.value;
  const c = closed(file, '', o, B5.file.fields, B5.file.required);
  if (c) return { ok: false, finding: c };
  if (o.phase !== phase) return refuse(file, 'phase', `does not say it is phase ${phase}`);
  if (!isObj(o.prepared_against)) return refuse(file, 'prepared_against', 'must be an object');
  const cpa = closed(file, 'prepared_against', o.prepared_against, B5.prepared_against.fields, B5.prepared_against.required);
  if (cpa) return { ok: false, finding: cpa };
  const pa = o.prepared_against;
  if (!posInt(pa.spec_version) || !posInt(pa.architecture_version) || !posInt(pa.roadmap_version)) return refuse(file, 'prepared_against', 'the versions must be positive integers');
  if (typeof pa.revision !== 'string' || !/^[0-9a-f]{40}$/.test(pa.revision)) return refuse(file, 'prepared_against.revision', 'must be a commit id');
  if (o.conformance !== 'within_baseline' && o.conformance !== 'uncertain') return refuse(file, 'conformance', 'must be within_baseline or uncertain');
  if (o.notes !== undefined && typeof o.notes !== 'string') return refuse(file, 'notes', 'must be a string');
  if (!Array.isArray(o.stages) || o.stages.length === 0) return refuse(file, 'stages', 'must be a non-empty array');
  const stages: PlanStage[] = [];
  for (const [i, s] of o.stages.entries()) {
    const at = `stages[${i}]`;
    if (!isObj(s)) return refuse(file, at, 'must be an object');
    const cs = closed(file, at, s, B5.stage.fields, B5.stage.required);
    if (cs) return { ok: false, finding: cs };
    if (!posInt(s.number)) return refuse(file, `${at}.number`, 'must be a positive integer');
    if (typeof s.goal !== 'string' || s.goal.trim() === '') return refuse(file, `${at}.goal`, 'must be a non-empty string');
    if (!strings(s.tasks)) return refuse(file, `${at}.tasks`, 'must be an array of strings');
    if (!strings(s.modules)) return refuse(file, `${at}.modules`, 'must be an array of module names');
    if (!strings(s.implements)) return refuse(file, `${at}.implements`, 'must be an array of requirement keys');
    for (const k of s.implements) if (!KEY.test(k)) return refuse(file, `${at}.implements`, `"${k}" is not a requirement key R<n>`);
    if (!strings(s.adrs)) return refuse(file, `${at}.adrs`, 'must be an array of ADR keys');
    for (const k of s.adrs) if (!ADR_KEY.test(k)) return refuse(file, `${at}.adrs`, `"${k}" is not an ADR key ADR-<nnn>`);
    if (!Array.isArray(s.depends_on) || !s.depends_on.every(posInt)) return refuse(file, `${at}.depends_on`, 'must be an array of stage numbers');
    if (!isObj(s.validation)) return refuse(file, `${at}.validation`, 'must be an object');
    const cv = closed(file, `${at}.validation`, s.validation, B5.validation.fields, B5.validation.required);
    if (cv) return { ok: false, finding: cv };
    const v = s.validation;
    if (!strings(v.criteria)) return refuse(file, `${at}.validation.criteria`, 'must be an array of criteria');
    for (const k of v.criteria) if (!CRITERION.test(k)) return refuse(file, `${at}.validation.criteria`, `"${k}" is not a criterion R<n>.<m>`);
    if (!strings(v.kinds)) return refuse(file, `${at}.validation.kinds`, 'must be an array of check kinds');
    for (const k of v.kinds) if (!CHECK_KINDS.has(k)) return refuse(file, `${at}.validation.kinds`, `"${k}" is not a check kind of F §5.7`);
    if (!strings(v.sensitive_areas)) return refuse(file, `${at}.validation.sensitive_areas`, 'must be an array of sensitive areas');
    for (const a of v.sensitive_areas) if (!SENSITIVE_AREAS.includes(a)) return refuse(file, `${at}.validation.sensitive_areas`, `"${a}" is not a sensitive area of the closed list`);
    if (!strings(s.integration_obligations)) return refuse(file, `${at}.integration_obligations`, 'must be an array of strings');
    if (s.conformance !== undefined && typeof s.conformance !== 'boolean') return refuse(file, `${at}.conformance`, 'must be a boolean');
    if (s.conformance === true && s.tasks.length > 0) return refuse(file, `${at}.tasks`, 'a conformance stage has no tasks (K11)');
    if (s.screens !== undefined && (!strings(s.screens) || s.screens.some((k) => k.trim() === ''))) return refuse(file, `${at}.screens`, 'must be an array of screen keys of the approved design');
    stages.push({
      number: s.number,
      goal: s.goal,
      tasks: s.tasks,
      modules: s.modules,
      implements: s.implements,
      adrs: s.adrs,
      depends_on: s.depends_on as number[],
      validation: { criteria: v.criteria, kinds: v.kinds, sensitive_areas: v.sensitive_areas },
      integration_obligations: s.integration_obligations,
      ...(s.conformance !== undefined ? { conformance: s.conformance } : {}),
      ...(s.screens !== undefined ? { screens: [...(s.screens as string[])] } : {}),
    });
  }
  let roadmap: Roadmap | undefined;
  if (o.roadmap_revision !== undefined) {
    const r = parseRoadmap(JSON.stringify(o.roadmap_revision), `${file}#roadmap_revision`);
    if (!r.ok) return r as Parsed<PhasePlanFile>;
    roadmap = r.value;
  }
  return {
    ok: true,
    value: {
      phase,
      prepared_against: { spec_version: pa.spec_version, architecture_version: pa.architecture_version, roadmap_version: pa.roadmap_version, revision: pa.revision },
      stages,
      conformance: o.conformance,
      ...(roadmap ? { roadmap_revision: roadmap } : {}),
      ...(typeof o.notes === 'string' ? { notes: o.notes } : {}),
    },
  };
}

// ---- B.6 ADR front matter --------------------------------------------------------------

export interface AdrFrontMatter {
  key: string;
  status: 'proposed' | 'accepted' | 'superseded';
  supersedes?: string;
  // D6 §8.1 step 3, §8.2: an ADR reconstructed from adopted code.
  reconstructed?: boolean;
}

export const ADR_FILE = /^\.surety\/adrs\/(ADR-[0-9]{3,})\.md$/;
export const adrPath = (key: string): string => `.surety/adrs/${key}.md`;
export const ADR_STATUSES = ['proposed', 'accepted', 'superseded'];
export const ADR_FIELDS = { fields: ['key', 'status', 'supersedes', 'reconstructed'], required: ['key', 'status'] } as const;
export const ADR_HEADINGS = ['Context', 'Decision', 'Consequences'] as const;

// `---` front matter with `key`, `status` and optional `supersedes`; the
// headings Context, Decision and Consequences in the body.
export function parseAdr(text: string, file: string): Parsed<AdrFrontMatter> {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return refuse(file, null, 'has no front matter');
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return refuse(file, null, 'its front matter is not closed');
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '') continue;
    const m = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!m) return refuse(file, null, `the front matter line "${line.trim()}" is not a field`);
    if (!(ADR_FIELDS.fields as readonly string[]).includes(m[1]!)) return refuse(file, m[1]!, `"${m[1]}" is not a field of an ADR's front matter`);
    fields.set(m[1]!, m[2]!.trim().replace(/^["']|["']$/g, ''));
  }
  const key = fields.get('key');
  if (key === undefined || !ADR_KEY.test(key)) return refuse(file, 'key', key === undefined ? '"key" is missing' : `"${key}" is not an ADR key ADR-<nnn>`);
  const expected = ADR_FILE.exec(file)?.[1];
  if (expected !== undefined && expected !== key) return refuse(file, 'key', `"${key}" is not the key the file name gives (${expected})`);
  const status = fields.get('status');
  if (status === undefined || !ADR_STATUSES.includes(status)) return refuse(file, 'status', status === undefined ? '"status" is missing' : `"${status}" is not proposed, accepted or superseded`);
  const supersedes = fields.get('supersedes');
  if (supersedes !== undefined && !ADR_KEY.test(supersedes)) return refuse(file, 'supersedes', `"${supersedes}" is not an ADR key`);
  const reconstructed = fields.get('reconstructed');
  if (reconstructed !== undefined && reconstructed !== 'true' && reconstructed !== 'false') return refuse(file, 'reconstructed', `"${reconstructed}" is not true or false`);
  const body = lines.slice(end + 1).join('\n');
  for (const heading of ADR_HEADINGS) {
    if (!new RegExp(`^#{1,3}\\s+${heading}\\b`, 'm').test(body)) return refuse(file, null, `has no ${heading} heading`);
  }
  return { ok: true, value: { key, status: status as AdrFrontMatter['status'], ...(supersedes !== undefined ? { supersedes } : {}), ...(reconstructed !== undefined ? { reconstructed: reconstructed === 'true' } : {}) } };
}
