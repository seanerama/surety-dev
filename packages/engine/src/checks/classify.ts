// The diff classifier (D3 §§1.6, 3.1 to 3.3, A.2, A.3; B02; N01; T03; Q3,
// Q5; SEAM.md §§215 to 217). `classify(P0, P1, S)` compares P0, the
// discovery of the effective version's tree, with P1, the discovery of the
// proposal's tree, against S, the criteria of the registered requirement
// index. Each difference, per check key and per governed field, is one
// element with its ClassificationReason; then the class is D3 §3.1's rule
// over the elements. It reads what discovery read of the two trees (with
// engine git, on the main thread: checks/classify-inputs.ts) and runs
// nothing.
//
// Conservative by construction (D3 §3.2, B02): a root addition or any other
// change of the root layout is `unclassifiable`; any semantic difference no
// explicit rule places is `unhandled_change`, and a strict element never
// hides an unclassifiable one. Two catch-alls hold the last point: a check
// whose definition or fingerprint differs with no element of its own to say
// how, and governed values that differ with no governed element, are each
// `unhandled_change`.
//
// Pure: no git, no store. Both threads import it.

import { canonicalJson, criterionErrors, GOVERNED_FILE, type DiscoveryError, type ManifestEntry } from './schema.js';
import type { DiscoveredCheck, Discovery } from './discovery.js';
import { seamClassifierVersion } from '../testing/seam.js';

// The version of this classifier (D3 §3.3). A change to the rules below is
// a new version; a version is qualified when the kernel-lane classifier rows
// pass on it. `--harness-classifier-version` (harness mode only, SEAM.md
// §217) makes this start report another.
export const CLASSIFIER_VERSION = 1;

export const runningClassifierVersion = (): number => seamClassifierVersion() ?? CLASSIFIER_VERSION;

// ---- D3 A.2 ------------------------------------------------------------------------------

export const STRICT_REASONS = ['check_added', 'criteria_added', 'gate_kinds_added', 'tier_floor_lowered', 'required_key_added_with_check'] as const;
export const LOOSENING_REASONS = ['check_removed', 'required_key_removed', 'criteria_removed', 'areas_removed', 'gate_kinds_removed', 'tier_floor_raised', 'root_removed'] as const;
export const UNCLASSIFIABLE_REASONS = [
  'root_layout_changed',
  'governed_field_changed',
  'execution_field_changed',
  'input_changed',
  'required_key_added_alone',
  'discovery_error',
  'unhandled_change',
  'no_strict_change',
] as const;
export const NEUTRAL_REASONS = ['neutral_file_changed'] as const;
export const AFFECTED_REASONS = ['added', 'removed', 'definition_changed', 'input_changed', 'required_changed', 'applicability_changed'] as const;

export type ClassificationReason =
  | (typeof STRICT_REASONS)[number]
  | (typeof LOOSENING_REASONS)[number]
  | (typeof UNCLASSIFIABLE_REASONS)[number]
  | (typeof NEUTRAL_REASONS)[number];
export type AffectedReason = (typeof AFFECTED_REASONS)[number];
export type ClassifiedKind = 'tightening' | 'loosening' | 'unclassifiable';

export interface Element {
  reason: ClassificationReason;
  // The check's key, for every element about one check.
  check?: string;
  // A repository path: the file of `neutral_file_changed`, the root of a
  // root element, the governed member or the error's path otherwise.
  path?: string;
}

export interface AffectedCheck {
  check: string;
  reasons: AffectedReason[];
}

export interface Classified {
  change_kind: ClassifiedKind;
  elements: Element[];
  affected_checks: AffectedCheck[];
}

// What discovery read of one tree, and the entries of that tree under the
// roots of both trees (the governed file included), sorted by path.
export interface ClassifySide {
  discovery: Discovery;
  entries: ManifestEntry[];
}

const STRICT = new Set<string>(STRICT_REASONS);
const LOOSENING = new Set<string>(LOOSENING_REASONS);
const UNCLASSIFIABLE = new Set<string>(UNCLASSIFIABLE_REASONS);

// D3 §3.1: `unclassifiable` if any element is, or if there is no strict and
// no loosening element; otherwise `loosening` if any element is; otherwise
// `tightening`. (`initial` is project creation's alone.)
export function kindOf(elements: readonly Element[]): ClassifiedKind {
  if (elements.some((e) => UNCLASSIFIABLE.has(e.reason))) return 'unclassifiable';
  const strict = elements.some((e) => STRICT.has(e.reason));
  const loose = elements.some((e) => LOOSENING.has(e.reason));
  if (!strict && !loose) return 'unclassifiable';
  return loose ? 'loosening' : 'tightening';
}

// ---- comparison helpers ------------------------------------------------------------------

const minus = (a: readonly string[], b: readonly string[]): string[] => a.filter((x) => !b.includes(x));
// Lists whose order carries no meaning compare as sets.
const sameSet = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => {
  if (a === undefined || b === undefined) return a === b;
  return canonicalJson([...new Set(a)].sort()) === canonicalJson([...new Set(b)].sort());
};
const same = (a: unknown, b: unknown): boolean => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const TIER_RANK: Record<string, number> = { T1: 1, T2: 2, T3: 3 };

// The fields of a definition that say how a check executes (D3 §3.1,
// "unclassifiable"): any change is `execution_field_changed`.
const EXECUTION_FIELDS = ['kind', 'origin', 'command', 'cwd', 'env', 'timeout_s', 'runner_class', 'requires', 'inputs', 'egress'] as const;
const SET_FIELDS = new Set(['requires', 'inputs', 'egress']);
const GOVERNED_FIELDS = ['check_discovery', 'check_commands', 'runner_config', 'result_collection'] as const;

const isDefinitionFile = (path: string, dirs: readonly string[]): boolean =>
  dirs.some((dir) => path.startsWith(dir) && path.endsWith('.json') && !path.slice(dir.length).includes('/'));

// ---- classify ----------------------------------------------------------------------------

// `known`: the criteria of the registered index; null when none is
// registered, so every criterion is unknown (schema.criterionErrors).
export function classify(p0: ClassifySide, p1: ClassifySide, known: ReadonlySet<string> | null): Classified {
  const elements: Element[] = [];
  const g0 = p0.discovery.governed;
  const g1 = p1.discovery.governed;

  // The root layout (B02): a removed root is a loosening; an added root, so
  // also a narrowed or changed one, is unclassifiable. A reordering is no
  // difference.
  const removedRoots = minus(g0.protected_paths, g1.protected_paths);
  const addedRoots = minus(g1.protected_paths, g0.protected_paths);
  for (const root of removedRoots) elements.push({ reason: 'root_removed', path: root });
  for (const root of addedRoots) elements.push({ reason: 'root_layout_changed', path: root });
  const layoutChanged = removedRoots.length + addedRoots.length > 0;

  // The governed fields that are never a tightening by themselves (D3 §3.2).
  let governedChanged = false;
  for (const field of GOVERNED_FIELDS) {
    if (!same(g0[field], g1[field])) {
      elements.push({ reason: 'governed_field_changed', path: `${GOVERNED_FILE}#/${field}` });
      governedChanged = true;
    }
  }

  // Every discovery error of P1, those against the index included (D3 §3.4, L5).
  const errors1: DiscoveryError[] = [...p1.discovery.errors, ...criterionErrors(p1.discovery.checks, known)];
  const seenErrors = new Set<string>();
  for (const e of errors1) {
    const k = `${e.path}\u0000${e.code}`;
    if (seenErrors.has(k)) continue;
    seenErrors.add(k);
    elements.push({ reason: 'discovery_error', path: e.path });
  }
  // Every discovery error of P0's tree that P1 does not reproduce identically
  // (same path, same code). An error P1 reproduces is already a
  // `discovery_error` above. One P1 clears is a difference no rule places: a
  // definition P0 could not parse is in neither check map, so its deletion,
  // or its repair in place, would otherwise vanish, and a dropped check is a
  // loosening nobody approved (D3 §1.4); a governed-file error cleared is the
  // same. Each is `unhandled_change` naming the error's path (the review's
  // S1). The index's `criterion_unknown` errors are not P0's tree errors:
  // they are judged against the index (schema.criterionErrors), and a
  // correction that drops such a criterion is classified by its own elements
  // (D3 §3.4; M228 (b)). Only discovery's own errors count here, the
  // structural ones that leave a definition or a governed field out of P0's
  // maps. `area_unknown` is among them as built: it is judged against the
  // closed list of areas (schema.ts), and the definition is dropped, so its
  // check is in no map and is classified only through this rule.
  const reproduced = new Set(p1.discovery.errors.map((e) => `${e.path}\u0000${e.code}`));
  const seenCleared = new Set<string>();
  for (const e of p0.discovery.errors) {
    const k = `${e.path}\u0000${e.code}`;
    if (reproduced.has(k) || seenCleared.has(k)) continue;
    seenCleared.add(k);
    elements.push({ reason: 'unhandled_change', path: e.path });
  }
  const defFile1 = (key: string) => `${g1.check_discovery.definitions}${key}.json`;
  const invalidInP1 = (key: string) => errors1.some((e) => e.path.split('#')[0] === defFile1(key));

  // Each check, by key.
  const c0 = new Map<string, DiscoveredCheck>(p0.discovery.checks.map((c) => [c.key, c]));
  const c1 = new Map<string, DiscoveredCheck>(p1.discovery.checks.map((c) => [c.key, c]));
  const keys = [...new Set([...c0.keys(), ...c1.keys()])].sort();
  const affected: AffectedCheck[] = [];
  for (const key of keys) {
    const before = c0.get(key);
    const after = c1.get(key);
    if (before === undefined && after !== undefined) {
      elements.push({ reason: 'check_added', check: key });
      if (g1.required_checks !== null && g1.required_checks.includes(key)) elements.push({ reason: 'required_key_added_with_check', check: key });
      affected.push({ check: key, reasons: ['added'] });
      continue;
    }
    if (before !== undefined && after === undefined) {
      // A definition P1 still has but could not parse is not removed: its
      // discovery error is what classifies it.
      if (invalidInP1(key)) affected.push({ check: key, reasons: ['definition_changed'] });
      else {
        elements.push({ reason: 'check_removed', check: key });
        affected.push({ check: key, reasons: ['removed'] });
      }
      continue;
    }
    const a = before!;
    const b = after!;
    const d0 = a.definition;
    const d1 = b.definition;
    const own: Element[] = [];
    const at = (reason: ClassificationReason) => own.push({ reason, check: key });
    // Criteria and areas (D3 §3.1): a gained criterion is strict, a lost one
    // a loosening; a lost area a loosening, a gained one has no rule.
    const crit0 = d0.covers?.criteria ?? [];
    const crit1 = d1.covers?.criteria ?? [];
    if (minus(crit1, crit0).length > 0) at('criteria_added');
    if (minus(crit0, crit1).length > 0) at('criteria_removed');
    const areas0 = d0.covers?.sensitive_areas ?? [];
    const areas1 = d1.covers?.sensitive_areas ?? [];
    if (minus(areas0, areas1).length > 0) at('areas_removed');
    if (minus(areas1, areas0).length > 0) at('unhandled_change');
    if (minus(d1.gate_kinds, d0.gate_kinds).length > 0) at('gate_kinds_added');
    if (minus(d0.gate_kinds, d1.gate_kinds).length > 0) at('gate_kinds_removed');
    if (d0.tier_floor !== d1.tier_floor) {
      if (d1.tier_floor === undefined) at('tier_floor_lowered');
      else if (d0.tier_floor === undefined) at('tier_floor_raised');
      else at((TIER_RANK[d1.tier_floor] ?? 0) < (TIER_RANK[d0.tier_floor] ?? 0) ? 'tier_floor_lowered' : 'tier_floor_raised');
    }
    if (d0.phase !== d1.phase) at('unhandled_change');
    const executionChanged = EXECUTION_FIELDS.some((f) =>
      SET_FIELDS.has(f) ? !sameSet(d0[f] as string[] | undefined, d1[f] as string[] | undefined) : !same(d0[f], d1[f]),
    );
    if (executionChanged) at('execution_field_changed');
    const inputChanged = !same(a.input_manifest, b.input_manifest);
    if (inputChanged) at('input_changed');
    // Required membership of a check both versions have.
    if (a.required && !b.required) at('required_key_removed');
    if (!a.required && b.required) at('required_key_added_alone');
    // The catch-alls (B02, T03): a difference in the definition, or in the
    // check fingerprint, that no rule above placed and no governed element
    // explains.
    const definitionChanged = !same(d0, d1);
    const placed = own.some((e) => e.reason !== 'required_key_removed' && e.reason !== 'required_key_added_alone');
    if (definitionChanged && !placed) at('unhandled_change');
    else if (a.fingerprint !== b.fingerprint && !placed && !governedChanged) at('unhandled_change');
    elements.push(...own);
    // Affected (N01; D3 §1.6): definition, input identity, required
    // membership, applicability; a fingerprint changed otherwise (a governed
    // entry the check uses) counts as its definition.
    const reasons: AffectedReason[] = [];
    if (definitionChanged || (a.fingerprint !== b.fingerprint && !inputChanged)) reasons.push('definition_changed');
    if (inputChanged) reasons.push('input_changed');
    if (a.required !== b.required) reasons.push('required_changed');
    if (!sameSet(d0.gate_kinds, d1.gate_kinds) || d0.tier_floor !== d1.tier_floor || d0.phase !== d1.phase) reasons.push('applicability_changed');
    if (reasons.length > 0) affected.push({ check: key, reasons });
  }

  // Governed values that differ with no governed element: no rule places
  // them (`required_checks` compares by membership, above).
  const placedGoverned = governedChanged || layoutChanged;
  const restOf = (g: typeof g0) => ({ ...g, protected_paths: [...g.protected_paths].sort(), required_checks: null });
  if (!placedGoverned && !same(restOf(g0), restOf(g1))) elements.push({ reason: 'unhandled_change', path: GOVERNED_FILE });

  // Changed files under the roots (D3 §3.1, neutral): a file in no check's
  // input manifest, neither the governed file nor a definition (whose
  // difference the elements above account for). With the root layout
  // changed, such a file is not neutral, and no rule places it.
  const m0 = new Map(p0.entries.map(([path, type, mode, oid]) => [path, `${type} ${mode} ${oid}`]));
  const m1 = new Map(p1.entries.map(([path, type, mode, oid]) => [path, `${type} ${mode} ${oid}`]));
  const inManifest = new Set<string>();
  for (const c of [...p0.discovery.checks, ...p1.discovery.checks]) for (const [path] of c.input_manifest) inManifest.add(path);
  const defDirs = [g0.check_discovery.definitions, g1.check_discovery.definitions];
  const changed = [...new Set([...m0.keys(), ...m1.keys()])].filter((path) => m0.get(path) !== m1.get(path)).sort();
  for (const path of changed) {
    if (path === GOVERNED_FILE || isDefinitionFile(path, defDirs) || inManifest.has(path)) continue;
    elements.push({ reason: layoutChanged ? 'unhandled_change' : 'neutral_file_changed', path });
  }

  if (!elements.some((e) => STRICT.has(e.reason) || LOOSENING.has(e.reason))) elements.push({ reason: 'no_strict_change' });
  return { change_kind: kindOf(elements), elements, affected_checks: affected };
}

// ---- classifier_authority (D3 §3.3, A.7; Q5; SEAM.md §217) ------------------------------------

export interface AuthoritySetting {
  mode: 'recommend' | 'authoritative';
  version?: number;
}

export const DEFAULT_AUTHORITY: AuthoritySetting = Object.freeze({ mode: 'recommend' });

// A Reviewer's approval of a tightening is the authority E13 gives it only
// under `authoritative` naming the running classifier; anything else reads
// as `recommend` (K8).
export const authorityInForce = (setting: AuthoritySetting | undefined, running: number): 'authoritative' | 'recommend' =>
  setting?.mode === 'authoritative' && setting.version === running ? 'authoritative' : 'recommend';
