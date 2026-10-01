// Engine configuration: $SURETY_HOME/config.json, read and validated once at
// startup, before the lock is taken (E22 item 1). A refused configuration
// writes nothing.

import { readFileSync } from 'node:fs';

import { Refusal } from '../refusal.js';
import {
  DECISION_KINDS,
  DECISION_KINDS_WITHOUT_TARGET,
  DECISION_TARGET_DEFAULTS,
  DECISION_TARGET_RANGE,
  DEFAULT_API_PORT,
  ENGINE_FIXED,
  ENGINE_KEYS,
  ENGINE_NUMBERS,
  type EngineKey,
  numberInSpec,
} from './schema.js';

export type ConfigSource = 'file' | 'default';

export interface EngineConfig {
  values: {
    [K in EngineKey]: K extends 'api_authority' ? string : K extends 'decision_targets' ? Record<string, number | null> : number;
  };
  sources: Record<EngineKey, ConfigSource>;
}

const unknownField = (field: string) =>
  new Refusal(
    400,
    'unknown_field',
    `"${field}" is not a configuration key.`,
    'Remove the key from config.json or correct its spelling; the configuration is closed.',
    { field },
  );

const invalidValue = (field: string, why: string) =>
  new Refusal(400, 'invalid_value', `"${field}" ${why}.`, `Correct "${field}" in config.json and start the engine again.`, {
    field,
  });

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function validateEngineConfig(raw: unknown): EngineConfig {
  if (!isPlainObject(raw)) throw invalidValue('config.json', 'must hold a JSON object');
  const known = new Set<string>(ENGINE_KEYS);
  for (const key of Object.keys(raw)) if (!known.has(key)) throw unknownField(key);

  const values: Record<string, unknown> = {};
  const sources = {} as Record<EngineKey, ConfigSource>;
  for (const key of ENGINE_KEYS) {
    const given = Object.hasOwn(raw, key);
    const value = raw[key];
    // A decision-target map that overrides nothing is the default (SEAM.md §2).
    const overrides = key !== 'decision_targets' || !isPlainObject(value) || Object.keys(value).length > 0;
    sources[key] = given && overrides ? 'file' : 'default';
    if (key === 'api_authority') {
      const port = values.api_port as number;
      const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!given) values[key] = allowed[0];
      else if (typeof value === 'string' && allowed.includes(value)) values[key] = value;
      else throw invalidValue(key, `must be exactly ${allowed.join(' or ')}`);
    } else if (key === 'decision_targets') {
      values[key] = decisionTargets(given ? value : {});
    } else if (key in ENGINE_FIXED) {
      const fixed = ENGINE_FIXED[key]!;
      if (given && value !== fixed) throw invalidValue(key, `is fixed at ${fixed}`);
      values[key] = fixed;
    } else {
      const spec = ENGINE_NUMBERS[key]!;
      if (!given) values[key] = spec.default;
      else if (numberInSpec(value, spec)) values[key] = value;
      else throw invalidValue(key, `must be ${spec.integer ? 'an integer' : 'a number'} from ${spec.min} to ${spec.max}`);
    }
  }
  return { values: values as EngineConfig['values'], sources };
}

function decisionTargets(raw: unknown): Record<string, number | null> {
  if (!isPlainObject(raw)) throw invalidValue('decision_targets', 'must be an object of decision kind to seconds');
  const kinds = new Set<string>(DECISION_KINDS);
  const effective: Record<string, number | null> = { ...DECISION_TARGET_DEFAULTS };
  for (const [kind, value] of Object.entries(raw)) {
    const field = `decision_targets.${kind}`;
    if (!kinds.has(kind)) throw unknownField(field);
    if (DECISION_KINDS_WITHOUT_TARGET.has(kind)) throw invalidValue(field, 'has no target and cannot be given one');
    const ok =
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= DECISION_TARGET_RANGE.min &&
      value <= DECISION_TARGET_RANGE.max;
    if (!ok) throw invalidValue(field, `must be an integer number of seconds from ${DECISION_TARGET_RANGE.min} to ${DECISION_TARGET_RANGE.max}`);
    effective[kind] = value;
  }
  return effective;
}

export function loadEngineConfig(file: string): EngineConfig {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return validateEngineConfig({});
    throw invalidValue('config.json', `could not be read (${(err as Error).message})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw invalidValue('config.json', `is not valid JSON (${(err as Error).message})`);
  }
  return validateEngineConfig(raw);
}

// GET /v1/engine `config`: one {value, source} entry per key.
export function inspectEngineConfig(config: EngineConfig): Record<string, { value: unknown; source: ConfigSource }> {
  const out: Record<string, { value: unknown; source: ConfigSource }> = {};
  for (const key of ENGINE_KEYS) out[key] = { value: config.values[key], source: config.sources[key] };
  return out;
}

export { DEFAULT_API_PORT };
