// Developer tests for the closed configuration (src/config). The acceptance
// suite pins the contract through the process; these check the validator's
// edges directly.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { validateEngineConfig } = await import(join(dist, 'config', 'engine-config.js'));
const { validatePolicySubmission, projectPolicyDefaults } = await import(join(dist, 'config', 'project-policy.js'));

const refusedWith = (fn, code, field) =>
  assert.throws(fn, (err) => err.code === code && err.subject?.field === field, `${code} on ${field}`);

test('an empty configuration takes every default, sourced as default', () => {
  const c = validateEngineConfig({});
  assert.equal(c.values.api_port, 7227);
  assert.equal(c.values.api_authority, '127.0.0.1:7227');
  assert.equal(c.values.decision_targets.stop_confirm, null);
  assert.ok(Object.values(c.sources).every((s) => s === 'default'));
});

test('the authority follows the configured port', () => {
  assert.equal(validateEngineConfig({ api_port: 9000 }).values.api_authority, '127.0.0.1:9000');
  assert.equal(validateEngineConfig({ api_port: 9000, api_authority: 'localhost:9000' }).values.api_authority, 'localhost:9000');
  refusedWith(() => validateEngineConfig({ api_authority: 'localhost:9000' }), 'invalid_value', 'api_authority');
});

test('unknown keys are reported before invalid values', () => {
  refusedWith(() => validateEngineConfig({ lease_ttl: 1, nope: 1 }), 'unknown_field', 'nope');
});

test('booleans, strings and null are never coerced', () => {
  for (const v of [true, '90', null, Number.NaN, Number.POSITIVE_INFINITY]) {
    refusedWith(() => validateEngineConfig({ lease_ttl: v }), 'invalid_value', 'lease_ttl');
  }
});

test('decision targets merge over the defaults and refuse the untargeted kinds', () => {
  const c = validateEngineConfig({ decision_targets: { go_live: 600 } });
  assert.equal(c.values.decision_targets.go_live, 600);
  assert.equal(c.values.decision_targets.blocker, 14400);
  assert.equal(c.sources.decision_targets, 'file');
  const empty = validateEngineConfig({ decision_targets: {} });
  assert.equal(empty.sources.decision_targets, 'default', 'a map that overrides nothing is the default');
  assert.equal(empty.values.decision_targets.blocker, 14400);
  refusedWith(() => validateEngineConfig({ decision_targets: null }), 'invalid_value', 'decision_targets');
  refusedWith(() => validateEngineConfig({ decision_targets: { abandon_confirm: 600 } }), 'invalid_value', 'decision_targets.abandon_confirm');
});

test('project policy: defaults, the non-integer budget, and whole-submission refusal', () => {
  // D6 K2 (M5 slice 37): no project run count; the per-profile maxima, each
  // under the engine's ceiling at the policy route.
  assert.equal(projectPolicyDefaults().max_concurrent_runs, undefined);
  assert.equal(projectPolicyDefaults().role_memory_max, 4 * 1024 ** 3);
  assert.equal(projectPolicyDefaults().check_memory_max, 2 * 1024 ** 3);
  refusedWith(() => validatePolicySubmission({ max_concurrent_runs: 1 }), 'unknown_field', 'max_concurrent_runs');
  refusedWith(() => validatePolicySubmission({ role_memory_max: 9 * 1024 ** 3 }, 8 * 1024 ** 3), 'invalid_value', 'role_memory_max');
  assert.deepEqual(validatePolicySubmission({ check_memory_max: 8 * 1024 ** 3 }, 8 * 1024 ** 3), { check_memory_max: 8 * 1024 ** 3 });
  refusedWith(() => validateEngineConfig({ max_concurrent_runs: 2 }), 'unknown_field', 'max_concurrent_runs');
  assert.equal(validateEngineConfig({}).values.max_concurrent_domains, 4);
  assert.deepEqual(validatePolicySubmission({ budget_day_verified_usd: 12.5 }), { budget_day_verified_usd: 12.5 });
  refusedWith(() => validatePolicySubmission({ repair_attempts_max: 2, bogus: 1 }), 'unknown_field', 'bogus');
  refusedWith(() => validatePolicySubmission({ deadline_builder: 300.5 }), 'invalid_value', 'deadline_builder');
  refusedWith(() => validatePolicySubmission([]), 'invalid_value', null);
});
