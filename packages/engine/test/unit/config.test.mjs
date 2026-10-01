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
  refusedWith(() => validateEngineConfig({ decision_targets: null }), 'invalid_value', 'decision_targets');
  refusedWith(() => validateEngineConfig({ decision_targets: { abandon_confirm: 600 } }), 'invalid_value', 'decision_targets.abandon_confirm');
});

test('project policy: defaults, the non-integer budget, and whole-submission refusal', () => {
  assert.equal(projectPolicyDefaults().max_concurrent_runs, 1);
  assert.deepEqual(validatePolicySubmission({ budget_day_verified_usd: 12.5 }), { budget_day_verified_usd: 12.5 });
  refusedWith(() => validatePolicySubmission({ repair_attempts_max: 2, bogus: 1 }), 'unknown_field', 'bogus');
  refusedWith(() => validatePolicySubmission({ deadline_builder: 300.5 }), 'invalid_value', 'deadline_builder');
  refusedWith(() => validatePolicySubmission([]), 'invalid_value', null);
});
