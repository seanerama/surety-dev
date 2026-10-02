// Ungoverned project policy keys (D1 §11.4, A.9 project scope; RN R2). A
// submission is validated whole against the closed schema before anything
// else happens.

import { Refusal } from '../refusal.js';
import { PROJECT_POLICY, numberInSpec } from './schema.js';

export function projectPolicyDefaults(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, spec] of Object.entries(PROJECT_POLICY)) out[key] = spec.default;
  return out;
}

export function validatePolicySubmission(body: unknown): Record<string, number> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Refusal(400, 'invalid_value', 'The policy submission must be a JSON object.', 'Send an object of the keys to change.', {
      field: null,
    });
  }
  const entries = Object.entries(body as Record<string, unknown>);
  for (const [key] of entries) {
    if (!Object.hasOwn(PROJECT_POLICY, key)) {
      throw new Refusal(
        400,
        'unknown_field',
        `"${key}" is not a writable project policy key.`,
        'Remove the key or correct its spelling; the project policy schema is closed.',
        { field: key },
      );
    }
  }
  for (const [key, value] of entries) {
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
  }
  return Object.fromEntries(entries) as Record<string, number>;
}

// Keys whose larger value widens what the engine may do unasked: limits,
// deadlines, budgets and caps. Raising one takes the policy_widening route
// (row M49, slice 5), which this engine revision does not have.
const WIDENING_KEYS = new Set([
  'max_concurrent_runs',
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
export function wideningKeys(effective: Record<string, number>, change: Record<string, number>): string[] {
  return Object.entries(change)
    .filter(([key, value]) => WIDENING_KEYS.has(key) && value > (effective[key] ?? Number.NEGATIVE_INFINITY))
    .map(([key]) => key);
}
