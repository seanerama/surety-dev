// The closed schemas of the protected acceptance path at runtime (D3 §§1.1 to
// 1.3, A.4; N04): the six governed fields of `.surety/checks/protected-policy.json`
// with every default and unit, and a check definition, schema version 1.
// Pure functions of text: nothing here reads git or the host, and no default
// is taken from the host environment. A value that breaks a rule is a
// discovery error with its path and code (A.2 `DiscoveryError`), never
// clamped or dropped; the path is the file's, followed for a member by `#`
// and an RFC 6901 pointer (SEAM.md §178).

import { createHash } from 'node:crypto';

import { checkLimits } from './limits.js';

export const GOVERNED_FILE = '.surety/checks/protected-policy.json';
export const DEFINITION_MAX_BYTES = 64 * 1024;
export const DEFINITIONS_MAX = 512;

export const DISCOVERY_ERRORS = [
  'governed_invalid',
  'not_regular_file',
  'not_json',
  'duplicate_entry',
  'too_large',
  'too_many',
  'unknown_field',
  'invalid_value',
  'key_mismatch',
  'program_not_allowed',
  'input_outside_roots',
  'input_not_regular',
  'covers_not_allowed',
  'criterion_unknown',
  'area_unknown',
  'required_key_without_definition',
] as const;
export type DiscoveryErrorCode = (typeof DISCOVERY_ERRORS)[number];
export interface DiscoveryError {
  path: string;
  code: DiscoveryErrorCode;
}

export const CHECK_KINDS = ['acceptance', 'smoke', 'integration', 'security_lint', 'property', 'failure_recovery', 'sensitivity_floor', 'post_deploy_identity', 'post_deploy_behavior'];
export const GATE_KINDS = ['stage', 'phase', 'alpha_authorize', 'alpha_complete', 'beta_authorize', 'beta_complete', 'live_authorize', 'live_complete'];
export const SENSITIVE_AREAS = [
  'authentication',
  'authorization',
  'payments_financial_data',
  'personal_data',
  'secrets_credentials',
  'data_migrations_destructive',
  'irreversible_external_actions',
];
// Kinds an acceptance-origin check covers criteria with (D3 §1.3).
export const COVERING_KINDS = ['acceptance', 'integration', 'property', 'failure_recovery'];
const POST_DEPLOY = ['post_deploy_identity', 'post_deploy_behavior'];
export const SYSTEM_DIRS = ['/usr', '/bin', '/lib', '/lib64'];
// The variables the engine sets in a check's environment (D3 §2.3); a
// definition or the governed env may name none of them, nor any SURETY_ one.
export const ENGINE_VARIABLES = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ', 'CI', 'HTTPS_PROXY'];

export const KEY_FORM = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const COMMAND_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const VARIABLE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const CRITERION = /^R[1-9][0-9]*\.[1-9][0-9]*$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HOST = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(:[0-9]{1,5})?$/;

export interface Governed {
  protected_paths: string[];
  check_discovery: { definitions: string };
  check_commands: Record<string, { path: string; sha256?: string }>;
  runner_config: { direct: { read_paths: string[]; path: string[]; env: Record<string, string>; egress_allow: string[]; timeout_max_s: number } };
  result_collection: { output_max_bytes: number };
  required_checks: string[] | null;
}

export const defaultGoverned = (): Governed => ({
  protected_paths: ['.surety/checks/'],
  check_discovery: { definitions: '.surety/checks/defs/' },
  check_commands: {},
  runner_config: { direct: { read_paths: [], path: ['/usr/bin', '/bin'], env: {}, egress_allow: [], timeout_max_s: 600 } },
  result_collection: { output_max_bytes: 65536 },
  required_checks: null,
});

export interface Definition {
  schema: 1;
  key: string;
  kind: string;
  origin: 'acceptance' | 'developer';
  command: string[];
  cwd: string;
  env: Record<string, string>;
  timeout_s: number;
  covers?: { criteria?: string[]; sensitive_areas?: string[] };
  gate_kinds: string[];
  tier_floor?: string;
  phase?: number;
  runner_class: 'direct' | 'container' | 'remote';
  requires: string[];
  inputs?: string[];
  egress: string[];
}

// ---- JSON with repeated members found ------------------------------------------------

export type Scanned = { ok: true; value: unknown } | { ok: false; code: 'not_json' | 'duplicate_entry'; pointer: string };

const escapePointer = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');

// JSON.parse, except that an object with a repeated member name is reported
// (its pointer) instead of keeping the last value silently (D3 §1.4).
export function scanJson(text: string): Scanned {
  let i = 0;
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++;
  };
  class Bad extends Error {
    constructor(
      readonly code: 'not_json' | 'duplicate_entry',
      readonly pointer: string,
    ) {
      super(code);
    }
  }
  const str = (): string => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) throw new Bad('not_json', '');
    i++;
    try {
      return JSON.parse(text.slice(start, i)) as string;
    } catch {
      throw new Bad('not_json', '');
    }
  };
  const value = (pointer: string): unknown => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const out: Record<string, unknown> = {};
      const seen = new Set<string>();
      ws();
      if (text[i] === '}') {
        i++;
        return out;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') throw new Bad('not_json', pointer);
        const key = str();
        const at = `${pointer}/${escapePointer(key)}`;
        if (seen.has(key)) throw new Bad('duplicate_entry', at);
        seen.add(key);
        ws();
        if (text[i] !== ':') throw new Bad('not_json', pointer);
        i++;
        const v = value(at);
        Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true });
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return out;
        }
        throw new Bad('not_json', pointer);
      }
    }
    if (c === '[') {
      i++;
      const out: unknown[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return out;
      }
      for (;;) {
        out.push(value(`${pointer}/${out.length}`));
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return out;
        }
        throw new Bad('not_json', pointer);
      }
    }
    if (c === '"') return str();
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!m) throw new Bad('not_json', pointer);
    i += m[0].length;
    return JSON.parse(m[0]);
  };
  try {
    const v = value('');
    ws();
    if (i !== text.length) return { ok: false, code: 'not_json', pointer: '' };
    return { ok: true, value: v };
  } catch (err) {
    if (err instanceof Bad) return { ok: false, code: err.code, pointer: err.pointer };
    return { ok: false, code: 'not_json', pointer: '' };
  }
}

// ---- small checks ------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isAbsolute = (p: unknown): p is string => typeof p === 'string' && p.startsWith('/') && !p.includes('\0') && !p.split('/').includes('..');
const isRelative = (p: unknown): p is string => typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.includes('\0') && !p.split('/').some((s) => s === '..' || s === '.git');
const under = (path: string, dirs: readonly string[]): boolean => dirs.some((d) => path === d || path.startsWith(d.endsWith('/') ? d : `${d}/`));
export const isEngineVariable = (name: string): boolean => name.startsWith('SURETY_') || ENGINE_VARIABLES.includes(name);

class Errors {
  readonly list: DiscoveryError[] = [];
  constructor(private readonly file: string) {}
  at(pointer: string, code: DiscoveryErrorCode): void {
    this.list.push({ path: pointer === '' ? this.file : `${this.file}#${pointer}`, code });
  }
  // An error about another entry of the tree, by its own path.
  of(path: string, code: DiscoveryErrorCode): void {
    this.list.push({ path, code });
  }
}

// ---- the governed file (D3 §1.1, A.4) --------------------------------------------------

export interface GovernedResult {
  governed: Governed;
  errors: DiscoveryError[];
}

// The governed file's text (null when the tree has none) as discovery reads
// it. Each absent field and member takes A.4's default; a refused value
// takes the default too, never the engine's bound.
export function parseGoverned(text: string | null): GovernedResult {
  const g = defaultGoverned();
  const e = new Errors(GOVERNED_FILE);
  if (text === null) return { governed: g, errors: [] };
  const scanned = scanJson(text);
  if (!scanned.ok) {
    e.at(scanned.code === 'duplicate_entry' ? scanned.pointer : '', scanned.code);
    return { governed: g, errors: e.list };
  }
  if (!isObject(scanned.value)) {
    e.at('', 'governed_invalid');
    return { governed: g, errors: e.list };
  }
  const v = scanned.value;
  const limits = checkLimits();
  for (const key of Object.keys(v)) {
    if (!['protected_paths', 'check_discovery', 'check_commands', 'runner_config', 'result_collection', 'required_checks'].includes(key)) e.at(`/${escapePointer(key)}`, 'unknown_field');
  }
  // protected_paths
  if (v.protected_paths !== undefined) {
    const p = v.protected_paths;
    if (!Array.isArray(p) || p.length === 0) e.at('/protected_paths', 'invalid_value');
    else {
      const ok: string[] = [];
      p.forEach((x, n) => {
        if (!isRelative(x)) e.at(`/protected_paths/${n}`, 'invalid_value');
        else if (ok.includes(x)) e.at(`/protected_paths/${n}`, 'duplicate_entry');
        else ok.push(x);
      });
      if (ok.length > 0) g.protected_paths = ok;
    }
  }
  const roots = g.protected_paths;
  // check_discovery
  if (v.check_discovery !== undefined) {
    const d = v.check_discovery;
    if (!isObject(d)) e.at('/check_discovery', 'invalid_value');
    else {
      for (const k of Object.keys(d)) if (k !== 'definitions') e.at(`/check_discovery/${escapePointer(k)}`, 'unknown_field');
      if (d.definitions !== undefined) {
        const def = d.definitions;
        if (!isRelative(def) || !def.endsWith('/') || !under(def, roots)) e.at('/check_discovery/definitions', 'invalid_value');
        else g.check_discovery = { definitions: def };
      }
    }
  }
  // runner_config, before check_commands (whose paths it bounds)
  if (v.runner_config !== undefined) {
    const r = v.runner_config;
    if (!isObject(r)) e.at('/runner_config', 'invalid_value');
    else {
      // container and remote are known classes and refused while unqualified (D3 §1.1).
      for (const k of Object.keys(r)) if (k !== 'direct') e.at(`/runner_config/${escapePointer(k)}`, 'unknown_field');
      if (r.direct !== undefined) {
        const d = r.direct;
        if (!isObject(d)) e.at('/runner_config/direct', 'invalid_value');
        else {
          const out = g.runner_config.direct;
          for (const k of Object.keys(d)) if (!['read_paths', 'path', 'env', 'egress_allow', 'timeout_max_s'].includes(k)) e.at(`/runner_config/direct/${escapePointer(k)}`, 'unknown_field');
          const paths = (member: 'read_paths' | 'path') => {
            const x = d[member];
            if (x === undefined) return;
            if (!Array.isArray(x)) return e.at(`/runner_config/direct/${member}`, 'invalid_value');
            const ok: string[] = [];
            x.forEach((p, n) => {
              if (!isAbsolute(p)) e.at(`/runner_config/direct/${member}/${n}`, 'invalid_value');
              else if (ok.includes(p)) e.at(`/runner_config/direct/${member}/${n}`, 'duplicate_entry');
              else ok.push(p);
            });
            out[member] = ok;
          };
          paths('read_paths');
          paths('path');
          if (d.env !== undefined) {
            if (!isObject(d.env)) e.at('/runner_config/direct/env', 'invalid_value');
            else {
              const env: Record<string, string> = {};
              for (const [name, value] of Object.entries(d.env)) {
                if (!VARIABLE.test(name) || isEngineVariable(name) || typeof value !== 'string') e.at(`/runner_config/direct/env/${escapePointer(name)}`, 'invalid_value');
                else env[name] = value;
              }
              out.env = env;
            }
          }
          if (d.egress_allow !== undefined) {
            const x = d.egress_allow;
            if (!Array.isArray(x)) e.at('/runner_config/direct/egress_allow', 'invalid_value');
            else {
              const ok: string[] = [];
              x.forEach((h, n) => {
                if (typeof h !== 'string' || !HOST.test(h)) e.at(`/runner_config/direct/egress_allow/${n}`, 'invalid_value');
                else if (ok.includes(h)) e.at(`/runner_config/direct/egress_allow/${n}`, 'duplicate_entry');
                else ok.push(h);
              });
              out.egress_allow = ok;
            }
          }
          if (d.timeout_max_s !== undefined) {
            const t = d.timeout_max_s;
            if (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > limits.check_timeout_max) e.at('/runner_config/direct/timeout_max_s', 'invalid_value');
            else out.timeout_max_s = t;
          }
        }
      }
    }
  }
  // check_commands
  if (v.check_commands !== undefined) {
    const c = v.check_commands;
    if (!isObject(c)) e.at('/check_commands', 'invalid_value');
    else {
      const names = Object.keys(c);
      if (names.length > 64) e.at('/check_commands', 'too_many');
      const allowed = [...SYSTEM_DIRS, ...g.runner_config.direct.read_paths];
      for (const name of names.slice(0, 64)) {
        const at = `/check_commands/${escapePointer(name)}`;
        const entry = c[name];
        if (!COMMAND_NAME.test(name) || !isObject(entry)) {
          e.at(at, 'invalid_value');
          continue;
        }
        let ok = true;
        for (const k of Object.keys(entry)) {
          if (k !== 'path' && k !== 'sha256') {
            e.at(`${at}/${escapePointer(k)}`, 'unknown_field');
            ok = false;
          }
        }
        if (!isAbsolute(entry.path) || !under(entry.path, allowed)) {
          e.at(`${at}/path`, 'invalid_value');
          ok = false;
        }
        if (entry.sha256 !== undefined && (typeof entry.sha256 !== 'string' || !HEX64.test(entry.sha256))) {
          e.at(`${at}/sha256`, 'invalid_value');
          ok = false;
        }
        if (ok) g.check_commands[name] = entry.sha256 === undefined ? { path: entry.path as string } : { path: entry.path as string, sha256: entry.sha256 as string };
      }
    }
  }
  // result_collection
  if (v.result_collection !== undefined) {
    const r = v.result_collection;
    if (!isObject(r)) e.at('/result_collection', 'invalid_value');
    else {
      for (const k of Object.keys(r)) if (k !== 'output_max_bytes') e.at(`/result_collection/${escapePointer(k)}`, 'unknown_field');
      const n = r.output_max_bytes;
      if (n !== undefined) {
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1024 || n > limits.check_output_max_bytes) e.at('/result_collection/output_max_bytes', 'invalid_value');
        else g.result_collection = { output_max_bytes: n };
      }
    }
  }
  // required_checks: absent means every check (null); keys are checked
  // against the definitions by discovery.
  if (v.required_checks !== undefined) {
    const r = v.required_checks;
    if (!Array.isArray(r)) e.at('/required_checks', 'invalid_value');
    else {
      const ok: string[] = [];
      r.forEach((k, n) => {
        if (typeof k !== 'string' || !KEY_FORM.test(k)) e.at(`/required_checks/${n}`, 'invalid_value');
        else if (ok.includes(k)) e.at(`/required_checks/${n}`, 'duplicate_entry');
        else ok.push(k);
      });
      g.required_checks = ok;
    }
  }
  return { governed: g, errors: e.list };
}

// ---- a definition (D3 §1.3, A.4) -----------------------------------------------------

export interface TreeEntry {
  path: string;
  type: string; // as git ls-tree prints it: blob, tree, commit
  mode: string; // 100644, 100755, 120000, 160000, 040000
  oid: string;
}

export type ManifestEntry = [string, string, string, string];

export interface DefinitionResult {
  definition: Definition | null;
  manifest: ManifestEntry[];
  errors: DiscoveryError[];
}

const DEFINITION_FIELDS = ['schema', 'key', 'kind', 'origin', 'command', 'cwd', 'env', 'timeout_s', 'covers', 'gate_kinds', 'tier_floor', 'phase', 'runner_class', 'requires', 'inputs', 'egress'];

export const isProtectedPath = (path: string, roots: readonly string[]): boolean => path === GOVERNED_FILE || roots.some((r) => path === r || path.startsWith(r.endsWith('/') ? r : `${r}/`));

const isRegular = (x: TreeEntry): boolean => x.type === 'blob' && (x.mode === '100644' || x.mode === '100755');

// The regular-file members of the tree a check's inputs name, as its input
// manifest, sorted by path (D3 §1.3, L6). `entries` are every entry of the
// tree; the governed file is never a member.
function expandInputs(inputs: string[] | undefined, roots: readonly string[], entries: readonly TreeEntry[], e: Errors): ManifestEntry[] {
  const members = new Map<string, TreeEntry>();
  const files = entries.filter((x) => x.type !== 'tree');
  if (inputs === undefined) {
    // The default (Q3 (a)): every entry under the roots but the governed
    // file; a link or a submodule there is refused below (B01).
    for (const x of files) if (x.path !== GOVERNED_FILE && isProtectedPath(x.path, roots)) members.set(x.path, x);
  } else {
    inputs.forEach((input, n) => {
      const at = `/inputs/${n}`;
      if (input === GOVERNED_FILE) return e.at(at, 'invalid_value');
      if (!isProtectedPath(input, roots)) return e.at(at, 'input_outside_roots');
      if (input.endsWith('/')) {
        const found = files.filter((x) => x.path.startsWith(input) && x.path !== GOVERNED_FILE);
        if (found.length === 0 && !entries.some((x) => x.type === 'tree' && `${x.path}/` === input)) return e.at(at, 'invalid_value');
        for (const x of found) members.set(x.path, x);
        return;
      }
      const x = files.find((f) => f.path === input);
      if (!x) {
        // A directory named without its slash, or nothing at all.
        return e.at(at, 'invalid_value');
      }
      members.set(x.path, x);
    });
  }
  const out: ManifestEntry[] = [];
  let refused = false;
  for (const x of [...members.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (!isRegular(x)) {
      // A symlink, a submodule or any other entry among the inputs (B01):
      // under default inputs each is named by its own path.
      if (inputs === undefined) e.of(x.path, 'input_not_regular');
      refused = true;
      continue;
    }
    out.push([x.path, x.type, x.mode, x.oid]);
  }
  if (refused && inputs !== undefined) e.at('/inputs', 'input_not_regular');
  return out;
}

// One definition file's text, read as discovery reads it. `stem` is the
// file's name without `.json`. Index-dependent errors (a criterion the
// approved spec does not have) are not decided here: see criterionErrors.
export function parseDefinition(file: string, stem: string, text: string, governed: Governed, entries: readonly TreeEntry[]): DefinitionResult {
  const e = new Errors(file);
  const fail = (): DefinitionResult => ({ definition: null, manifest: [], errors: e.list });
  const scanned = scanJson(text);
  if (!scanned.ok) {
    e.at('', scanned.code);
    return fail();
  }
  if (!isObject(scanned.value)) {
    e.at('', 'invalid_value');
    return fail();
  }
  const v = scanned.value;
  for (const k of Object.keys(v)) if (!DEFINITION_FIELDS.includes(k)) e.at(`/${escapePointer(k)}`, 'unknown_field');
  if (v.schema !== 1) e.at('/schema', 'invalid_value');
  if (typeof v.key !== 'string' || v.key !== stem || !KEY_FORM.test(stem)) e.at('/key', 'key_mismatch');
  const kind = typeof v.kind === 'string' && CHECK_KINDS.includes(v.kind) ? v.kind : null;
  if (kind === null) e.at('/kind', 'invalid_value');
  const origin = v.origin === undefined ? 'acceptance' : v.origin;
  if (origin !== 'acceptance' && origin !== 'developer') e.at('/origin', 'invalid_value');
  // command
  let command: string[] = [];
  if (!Array.isArray(v.command) || v.command.length < 1 || v.command.length > 64 || !v.command.every((a) => typeof a === 'string' && !a.includes('\0'))) e.at('/command', 'invalid_value');
  else {
    command = v.command as string[];
    if (!Object.hasOwn(governed.check_commands, command[0]!)) e.at('/command/0', 'program_not_allowed');
  }
  const cwd = v.cwd === undefined ? '.' : v.cwd;
  if (typeof cwd !== 'string' || (cwd !== '.' && !isRelative(cwd))) e.at('/cwd', 'invalid_value');
  const env: Record<string, string> = {};
  if (v.env !== undefined) {
    if (!isObject(v.env)) e.at('/env', 'invalid_value');
    else
      for (const [name, value] of Object.entries(v.env)) {
        if (!VARIABLE.test(name) || isEngineVariable(name) || typeof value !== 'string') e.at(`/env/${escapePointer(name)}`, 'invalid_value');
        else env[name] = value;
      }
  }
  const t = v.timeout_s;
  if (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > governed.runner_config.direct.timeout_max_s) e.at('/timeout_s', 'invalid_value');
  // covers
  let covers: Definition['covers'] | undefined;
  const criteria: string[] = [];
  const areas: string[] = [];
  if (v.covers !== undefined) {
    const c = v.covers;
    if (!isObject(c)) e.at('/covers', 'invalid_value');
    else if (origin === 'developer') e.at('/covers', 'covers_not_allowed');
    else {
      for (const k of Object.keys(c)) if (k !== 'criteria' && k !== 'sensitive_areas') e.at(`/covers/${escapePointer(k)}`, 'unknown_field');
      if (c.criteria !== undefined) {
        if (kind !== null && !COVERING_KINDS.includes(kind)) e.at('/covers/criteria', 'covers_not_allowed');
        else if (!Array.isArray(c.criteria)) e.at('/covers/criteria', 'invalid_value');
        else
          c.criteria.forEach((x, n) => {
            if (typeof x !== 'string' || !CRITERION.test(x)) e.at(`/covers/criteria/${n}`, 'invalid_value');
            else if (criteria.includes(x)) e.at(`/covers/criteria/${n}`, 'duplicate_entry');
            else criteria.push(x);
          });
      }
      if (c.sensitive_areas !== undefined) {
        if (kind !== 'sensitivity_floor') e.at('/covers/sensitive_areas', 'covers_not_allowed');
        else if (!Array.isArray(c.sensitive_areas)) e.at('/covers/sensitive_areas', 'invalid_value');
        else
          c.sensitive_areas.forEach((x, n) => {
            if (typeof x !== 'string' || !SENSITIVE_AREAS.includes(x)) e.at(`/covers/sensitive_areas/${n}`, 'area_unknown');
            else if (areas.includes(x)) e.at(`/covers/sensitive_areas/${n}`, 'duplicate_entry');
            else areas.push(x);
          });
      }
      covers = { ...(criteria.length > 0 ? { criteria } : {}), ...(areas.length > 0 ? { sensitive_areas: areas } : {}) };
    }
  }
  if (origin === 'acceptance' && kind !== null && COVERING_KINDS.includes(kind) && criteria.length === 0 && !e.list.some((x) => x.path.includes('#/covers'))) e.at('/covers', 'invalid_value');
  if (kind === 'sensitivity_floor' && areas.length === 0 && !e.list.some((x) => x.path.includes('#/covers'))) e.at('/covers', 'invalid_value');
  // gate kinds, tier floor, phase
  const gates: string[] = [];
  if (!Array.isArray(v.gate_kinds) || v.gate_kinds.length === 0) e.at('/gate_kinds', 'invalid_value');
  else
    v.gate_kinds.forEach((x, n) => {
      if (typeof x !== 'string' || !GATE_KINDS.includes(x)) e.at(`/gate_kinds/${n}`, 'invalid_value');
      else if (gates.includes(x)) e.at(`/gate_kinds/${n}`, 'duplicate_entry');
      else gates.push(x);
    });
  if (v.tier_floor !== undefined && (kind === 'sensitivity_floor' || !['T1', 'T2', 'T3'].includes(v.tier_floor as string))) e.at('/tier_floor', 'invalid_value');
  if (v.phase !== undefined && (typeof v.phase !== 'number' || !Number.isInteger(v.phase) || v.phase < 1)) e.at('/phase', 'invalid_value');
  const runner = v.runner_class === undefined ? 'direct' : v.runner_class;
  if (runner !== 'direct' && runner !== 'container' && runner !== 'remote') e.at('/runner_class', 'invalid_value');
  const requires: string[] = [];
  if (v.requires !== undefined) {
    if (!Array.isArray(v.requires)) e.at('/requires', 'invalid_value');
    else
      v.requires.forEach((x, n) => {
        if (x !== 'environment' && x !== 'artifact_digest') e.at(`/requires/${n}`, 'invalid_value');
        else if (requires.includes(x)) e.at(`/requires/${n}`, 'duplicate_entry');
        else requires.push(x);
      });
    if (requires.length > 0 && kind !== null && !POST_DEPLOY.includes(kind)) e.at('/requires', 'invalid_value');
  }
  // inputs
  let inputs: string[] | undefined;
  if (v.inputs !== undefined) {
    if (!Array.isArray(v.inputs)) e.at('/inputs', 'invalid_value');
    else {
      inputs = [];
      v.inputs.forEach((x, n) => {
        if (!isRelative(x)) e.at(`/inputs/${n}`, 'invalid_value');
        else if (inputs!.includes(x)) e.at(`/inputs/${n}`, 'duplicate_entry');
        else inputs!.push(x);
      });
    }
  }
  const manifest = v.inputs !== undefined && inputs === undefined ? [] : expandInputs(inputs, governed.protected_paths, entries, e);
  // egress
  const egress: string[] = [];
  if (v.egress !== undefined) {
    if (!Array.isArray(v.egress)) e.at('/egress', 'invalid_value');
    else
      v.egress.forEach((x, n) => {
        if (typeof x !== 'string' || !governed.runner_config.direct.egress_allow.includes(x)) e.at(`/egress/${n}`, 'invalid_value');
        else if (egress.includes(x)) e.at(`/egress/${n}`, 'duplicate_entry');
        else egress.push(x);
      });
  }
  // A link or a submodule among the inputs (B01) is an error of the version,
  // which then satisfies no gate; the definition is still discovered, so
  // nothing is dropped silently.
  if (e.list.some((x) => x.code !== 'input_not_regular')) return { definition: null, manifest, errors: e.list };
  const definition: Definition = {
    schema: 1,
    key: stem,
    kind: kind!,
    origin: origin as Definition['origin'],
    command,
    cwd: cwd as string,
    env,
    timeout_s: t as number,
    ...(covers !== undefined && Object.keys(covers).length > 0 ? { covers } : {}),
    gate_kinds: gates,
    ...(v.tier_floor !== undefined ? { tier_floor: v.tier_floor as string } : {}),
    ...(v.phase !== undefined ? { phase: v.phase as number } : {}),
    runner_class: runner as Definition['runner_class'],
    requires,
    ...(inputs !== undefined ? { inputs } : {}),
    egress,
  };
  return { definition, manifest, errors: e.list };
}

// ---- fingerprints -------------------------------------------------------------------

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// The check fingerprint (D3 §1.3): SHA-256 over the canonical definition,
// its input manifest and the governed entries it uses.
export function checkFingerprint(definition: Definition, manifest: ManifestEntry[], governed: Governed): string {
  const used = {
    definition,
    input_manifest: manifest,
    command: governed.check_commands[definition.command[0]!] ?? null,
    runner: governed.runner_config.direct,
    result_collection: governed.result_collection,
  };
  return createHash('sha256').update(canonicalJson(used)).digest('hex');
}

// ---- criteria against the registered index (D3 §§1.4, 3.4, 4.5) --------------------

// The `criterion_unknown` errors of the given checks against the criteria of
// the registered requirement index (null: no index is registered, so every
// criterion is unknown).
export function criterionErrors(checks: { path: string; criteria: string[] }[], known: ReadonlySet<string> | null): DiscoveryError[] {
  const out: DiscoveryError[] = [];
  for (const c of checks) {
    c.criteria.forEach((criterion, n) => {
      if (known === null || !known.has(criterion)) out.push({ path: `${c.path}#/covers/criteria/${n}`, code: 'criterion_unknown' });
    });
  }
  return out;
}

export const requirementKeyOf = (criterion: string): string => criterion.slice(0, criterion.indexOf('.'));
