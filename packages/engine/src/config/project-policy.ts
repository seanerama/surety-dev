// Ungoverned project policy keys (D1 §11.4, A.9 project scope; RN R2; D2
// A.7). A submission is validated whole against the closed schema before
// anything else happens.

import { isModelName } from '../invoke/adapters/model.js';
import { isAbsolute, normalize } from 'node:path';

import { Refusal } from '../refusal.js';
import { BUDGET_BOUNDARIES, type OptionSpec, PROJECT_OPTIONS, PROJECT_POLICY, numberInSpec } from './schema.js';

// A value of an ungoverned key: a number, or one of the typed options.
export type PolicyValue = number | string | boolean | string[] | number[] | Record<string, unknown>;
export type Policy = Record<string, PolicyValue>;

export function projectPolicyDefaults(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, spec] of Object.entries(PROJECT_POLICY)) out[key] = spec.default;
  return out;
}

// The defaults of every ungoverned key, numbers and options.
export function projectEffectiveDefaults(): Policy {
  const out: Policy = { ...projectPolicyDefaults() };
  for (const [key, spec] of Object.entries(PROJECT_OPTIONS)) out[key] = structuredClone(spec.default) as PolicyValue;
  return out;
}

const invalidValue = (key: string, what: string) =>
  new Refusal(400, 'invalid_value', `"${key}" must be ${what}.`, `Correct "${key}" and submit again; nothing was changed.`, { field: key });

// A DNS host name, lower case, no port, no wildcard and no address literal:
// the proxy matches a CONNECT authority against it exactly (D2 §2.4).
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_NAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`);
const isHostName = (v: unknown): v is string => typeof v === 'string' && HOST_NAME.test(v) && !/^[0-9.]+$/.test(v);

// The value of an option, validated; throws a refusal naming the key.
function validateOption(key: string, spec: OptionSpec, value: unknown): PolicyValue {
  switch (spec.type) {
    case 'enum':
      if (typeof value !== 'string' || !spec.values!.includes(value)) throw invalidValue(key, `one of ${spec.values!.join(', ')}`);
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') throw invalidValue(key, 'true or false');
      if (key === 'budget_hard_maximum' && value) {
        // D2 §4.2, K6; E58 item 6: no M2 mechanism enforces a hard spending
        // maximum, so a policy that declares one is refused rather than
        // recorded as if it were enforced.
        throw new Refusal(
          400,
          'hard_cap_unenforceable',
          'The engine cannot enforce a hard spending maximum: within an invocation, overshoot is bounded only by the deadline, and a backend holds its own key.',
          "Set a spending limit on the backend's dedicated API key at the provider; the engine records it as configured, never as enforced. Nothing was changed.",
          { field: key },
        );
      }
      return value;
    case 'host_names': {
      if (!Array.isArray(value) || !value.every(isHostName)) throw invalidValue(key, 'an array of lower-case host names, without ports or addresses');
      if (new Set(value).size !== value.length) throw invalidValue(key, 'an array of distinct host names');
      return [...value];
    }
    case 'model':
      // A model name as the backend's command line takes it: never empty,
      // never an option, no whitespace or control character.
      if (!isModelName(value)) throw invalidValue(key, 'a model name');
      return value;
    case 'size_range': {
      const r = spec.range!;
      const ok = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= r.min && (n as number) <= r.max;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidValue(key, `an object {min, max}, each an integer from ${r.min} to ${r.max}`);
      const o = value as Record<string, unknown>;
      if (Object.keys(o).some((k) => k !== 'min' && k !== 'max') || !ok(o.min) || !ok(o.max)) throw invalidValue(key, `an object {min, max}, each an integer from ${r.min} to ${r.max}`);
      if (o.min > o.max) throw invalidValue(key, 'an object whose min is not above its max');
      return { min: o.min, max: o.max };
    }
    case 'int_list': {
      const r = spec.range!;
      const c = spec.count!;
      const ok = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= r.min && (n as number) <= r.max;
      if (!Array.isArray(value) || value.length < c.min || value.length > c.max || !value.every(ok) || new Set(value).size !== value.length) {
        throw invalidValue(key, `an array of ${c.min} to ${c.max} distinct integers, each from ${r.min} to ${r.max}`);
      }
      return [...value] as unknown as string[];
    }
    case 'subset': {
      const values = spec.values!;
      if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string' && values.includes(v)) || new Set(value).size !== value.length) {
        throw invalidValue(key, `a non-empty subset of ${values.join(', ')}`);
      }
      return [...value];
    }
    case 'absolute_paths': {
      const ok = (p: unknown): p is string => typeof p === 'string' && p.length > 0 && !p.includes('\0') && isAbsolute(p) && normalize(p) === p;
      if (!Array.isArray(value) || !value.every(ok)) throw invalidValue(key, 'an array of absolute, normalized paths');
      if (new Set(value).size !== value.length) throw invalidValue(key, 'an array of distinct paths');
      return [...value];
    }
  }
}

// The keys bounded above by the engine's `domain_memory_max` (D6 K2, A.7;
// D7 A.7: `preview_memory_max`, from 64 MiB to the effective
// `domain_memory_max`; E158 item 4).
export const CEILED_KEYS = ['role_memory_max', 'check_memory_max', 'preview_memory_max'] as const;

// `ceiling`: the engine's `domain_memory_max` in force, which an explicit
// per-profile maximum may not exceed (the driver's ruling Q1, slice 37).
export function validatePolicySubmission(body: unknown, ceiling?: number): Policy {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Refusal(400, 'invalid_value', 'The policy submission must be a JSON object.', 'Send an object of the keys to change.', {
      field: null,
    });
  }
  const entries = Object.entries(body as Record<string, unknown>);
  for (const [key] of entries) {
    if (!Object.hasOwn(PROJECT_POLICY, key) && !Object.hasOwn(PROJECT_OPTIONS, key)) {
      throw new Refusal(
        400,
        'unknown_field',
        `"${key}" is not a writable project policy key.`,
        'Remove the key or correct its spelling; the project policy schema is closed.',
        { field: key },
      );
    }
  }
  const out: Policy = {};
  for (const [key, value] of entries) {
    const option = PROJECT_OPTIONS[key];
    if (option) {
      out[key] = validateOption(key, option, value);
      continue;
    }
    const spec = PROJECT_POLICY[key]!;
    if (!numberInSpec(value, spec)) {
      throw new Refusal(
        400,
        'invalid_value',
        `"${key}" must be ${spec.integer ? 'an integer' : 'a number'} from ${spec.min} to ${spec.max}.`,
        `Correct "${key}" and submit again; nothing was changed.`,
        { field: key },
      );
    }
    if (ceiling !== undefined && (CEILED_KEYS as readonly string[]).includes(key) && (value as number) > ceiling) {
      throw new Refusal(
        400,
        'invalid_value',
        `"${key}" must be from ${spec.min} to the engine's domain_memory_max (${ceiling}).`,
        `Correct "${key}" and submit again; nothing was changed.`,
        { field: key, max: ceiling },
      );
    }
    out[key] = value as number;
  }
  return out;
}

// A recorded effective policy read back: each key the schema knows, with its
// recorded value where that value is of the key's form, else its default.
export function effectiveOf(recorded: Record<string, unknown> | null): Policy {
  const out = projectEffectiveDefaults();
  if (recorded === null) return out;
  for (const [key, spec] of Object.entries(PROJECT_POLICY)) if (numberInSpec(recorded[key], spec)) out[key] = recorded[key] as number;
  for (const [key, spec] of Object.entries(PROJECT_OPTIONS)) {
    if (!Object.hasOwn(recorded, key)) continue;
    try {
      out[key] = validateOption(key, spec, recorded[key]);
    } catch {
      // A value the schema refuses is never effective.
    }
  }
  return out;
}

// Keys whose larger value widens what the engine may do unasked: limits,
// deadlines, budgets and caps. Raising one takes the policy_widening route
// (row M49, slice 5).
const WIDENING_KEYS = new Set([
  'max_chained_roles',
  'preflight_refusals_max',
  'repair_attempts_max',
  'no_progress_max',
  'deadline_builder',
  'deadline_verifier',
  'deadline_reviewer',
  'deadline_architect',
  'session_idle_timeout',
  'observation_freshness_bound',
  'budget_run_billable_tokens',
  'budget_day_verified_usd',
  'budget_day_unknown_tokens',
  'snapshot_max_files',
  'snapshot_max_bytes',
  'snapshot_max_file_bytes',
]);

// The keys of a change that widen authority against the effective policy.
// An option widens as its spec says (D2 §§2.3, 2.4: adding a host to the
// egress list or a path to the read paths; removing one does not).
export function wideningKeys(effective: Policy, change: Policy): string[] {
  return Object.entries(change)
    .filter(([key, value]) => {
      const option = PROJECT_OPTIONS[key];
      if (option) {
        if (option.widening === 'added') {
          const before = new Set((effective[key] as string[] | undefined) ?? []);
          return (value as string[]).some((v) => !before.has(v));
        }
        // An ordered enumeration loosens toward its later values (D6 K3, K9).
        if (option.widening === 'later') {
          const values = (option.values ?? []) as readonly unknown[];
          return values.indexOf(value) > values.indexOf(effective[key] ?? option.default);
        }
        if (option.widening === 'coarser') {
          const rank = (b: unknown) => (BUDGET_BOUNDARIES as readonly unknown[]).indexOf(b);
          return rank(value) > rank(effective[key] ?? option.default);
        }
        return false;
      }
      return WIDENING_KEYS.has(key) && (value as number) > ((effective[key] as number | undefined) ?? Number.NEGATIVE_INFINITY);
    })
    .map(([key]) => key);
}
