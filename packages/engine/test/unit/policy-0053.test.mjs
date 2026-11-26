// Developer tests for the project policy keys of the preparation allowance
// (DECISIONS item 57, the owner's ruling D8 of 2026-11-26; config/schema.ts,
// config/project-policy.ts): their validation, their defaults, and when a
// change of them widens what the engine may do unasked.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { validatePolicySubmission, wideningKeys, projectEffectiveDefaults } = await import(join(root, 'dist', 'config', 'project-policy.js'));

test('the allowance is off by default; its model has no default; its limits default to the per-run limit and the iteration estimate', () => {
  const d = projectEffectiveDefaults();
  assert.equal(d.prototype_preparation_allowance, 'off');
  assert.equal('prototype_preparation_model' in d, false, 'a key with no default is absent, never filled in');
  assert.equal(d.prototype_preparation_run_tokens, 1_500_000);
  assert.equal(d.prototype_preparation_usd_estimated, 15);
});

test('the model is <provider>/<model>, the provider one the engine offers', () => {
  assert.deepEqual(validatePolicySubmission({ prototype_preparation_model: 'claude/opus' }), { prototype_preparation_model: 'claude/opus' });
  for (const bad of ['opus', '/opus', 'claude/', 'acme/opus', 'claude/ opus', 7]) {
    assert.throws(() => validatePolicySubmission({ prototype_preparation_model: bad }), (e) => e.code === 'invalid_value', String(bad));
  }
  assert.throws(() => validatePolicySubmission({ prototype_preparation_allowance: 'always' }), (e) => e.code === 'invalid_value');
});

test('granting widens, revoking does not; a model change widens only while the allowance is granted; raising a limit widens', () => {
  const off = { ...projectEffectiveDefaults() };
  const on = { ...off, prototype_preparation_allowance: 'per_iteration', prototype_preparation_model: 'claude/opus' };
  assert.deepEqual(wideningKeys(off, { prototype_preparation_allowance: 'per_iteration', prototype_preparation_model: 'claude/opus' }), ['prototype_preparation_allowance', 'prototype_preparation_model']);
  assert.deepEqual(wideningKeys(on, { prototype_preparation_allowance: 'off' }), []);
  assert.deepEqual(wideningKeys(on, { prototype_preparation_model: 'claude/sonnet' }), ['prototype_preparation_model']);
  assert.deepEqual(wideningKeys(on, { prototype_preparation_model: 'claude/opus' }), [], 'the same model is no change');
  assert.deepEqual(wideningKeys(off, { prototype_preparation_model: 'claude/sonnet' }), [], 'while the allowance is off, naming a model authorizes nothing');
  assert.deepEqual(wideningKeys(on, { prototype_preparation_model: 'claude/sonnet', prototype_preparation_allowance: 'off' }), [], 'revoked by the same change');
  assert.deepEqual(wideningKeys(on, { prototype_preparation_run_tokens: 2_000_000, prototype_preparation_usd_estimated: 10 }), ['prototype_preparation_run_tokens']);
});
