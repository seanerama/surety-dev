// Developer tests for the workspace assistant's configuration block (the
// assistant design §1.2; Sean's approval of 2026-10-27): absent by default
// (the assistant unconfigured), every field required when present and none
// defaulted, every number within its sanity bounds, the turn's limit not
// above the day's, a credential reference of the block's backend; a partial
// or out-of-range block refuses the start, which writes nothing; the scripted
// backend only in the test mode. The owner's recommended values are in the
// contract as a recommendation, never applied.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { validateEngineConfig, inspectEngineConfig } = await import(join(dist, 'config', 'engine-config.js'));
const { exportContract } = await import(join(dist, 'contract', 'document.js'));
const { ASSISTANT_FIELDS } = await import(join(dist, 'config', 'schema.js'));

const BLOCK = {
  backend: 'claude',
  model: 'sonnet',
  credential_ref: 'backend/claude/subscription_token',
  day_limit_billable_tokens: 400_000,
  turn_limit_billable_tokens: 40_000,
  turn_deadline_seconds: 120,
};
const refusedWith = (raw, code, field) =>
  assert.throws(() => validateEngineConfig(raw), (err) => err.code === code && err.subject?.field === field, `${code} on ${field} for ${JSON.stringify(raw)}`);

test('no block: the assistant is unconfigured, sourced as default, with no value supplied', () => {
  const c = validateEngineConfig({});
  assert.equal(c.values.workspace_assistant, null);
  assert.equal(c.sources.workspace_assistant, 'default');
  assert.deepEqual(inspectEngineConfig(c).workspace_assistant, { value: null, source: 'default' });
});

test('a whole block is taken exactly as stated, sourced as file', () => {
  const c = validateEngineConfig({ workspace_assistant: BLOCK });
  assert.deepEqual(c.values.workspace_assistant, BLOCK);
  assert.equal(c.sources.workspace_assistant, 'file');
  // Other numbers chosen by the owner are taken as stated, whatever the
  // recommendation says.
  const other = { ...BLOCK, model: 'claude-opus-5-5', day_limit_billable_tokens: 2_000_000, turn_limit_billable_tokens: 250_000, turn_deadline_seconds: 600 };
  assert.deepEqual(validateEngineConfig({ workspace_assistant: other }).values.workspace_assistant, other);
});

test('a partial block is refused field by field: no field has a default', () => {
  assert.deepEqual([...ASSISTANT_FIELDS].sort(), Object.keys(BLOCK).sort());
  for (const k of ASSISTANT_FIELDS) {
    const partial = { ...BLOCK };
    delete partial[k];
    refusedWith({ workspace_assistant: partial }, 'invalid_value', `workspace_assistant.${k}`);
  }
  refusedWith({ workspace_assistant: {} }, 'invalid_value', 'workspace_assistant.backend');
  for (const v of [null, true, 'claude', [], 40_000]) refusedWith({ workspace_assistant: v }, 'invalid_value', 'workspace_assistant');
  refusedWith({ workspace_assistant: { ...BLOCK, budget: 1 } }, 'unknown_field', 'workspace_assistant.budget');
});

test('out-of-range and ill-formed values are refused, never coerced or clamped', () => {
  for (const [k, bad] of [
    ['day_limit_billable_tokens', 999],
    ['day_limit_billable_tokens', 100_000_001],
    ['day_limit_billable_tokens', 400_000.5],
    ['day_limit_billable_tokens', '400000'],
    ['turn_limit_billable_tokens', 999],
    ['turn_limit_billable_tokens', null],
    ['turn_deadline_seconds', 9],
    ['turn_deadline_seconds', 3601],
    ['backend', 'gpt'],
    ['model', '-p'],
    ['model', ''],
    ['credential_ref', 'backend/claude/other'],
    ['credential_ref', 'backend/codex/api_key'],
  ]) {
    refusedWith({ workspace_assistant: { ...BLOCK, [k]: bad } }, 'invalid_value', `workspace_assistant.${k}`);
  }
  refusedWith({ workspace_assistant: { ...BLOCK, turn_limit_billable_tokens: 400_001 } }, 'invalid_value', 'workspace_assistant.turn_limit_billable_tokens');
  // The scripted backend is a value the validator knows; the test mode alone
  // may use it (refused at start otherwise, below).
  assert.equal(validateEngineConfig({ workspace_assistant: { ...BLOCK, backend: 'scripted' } }).values.workspace_assistant.backend, 'scripted');
});

test("the contract states the block: absent by default, every field required, the owner's recommendation labelled as such and not a default", () => {
  const spec = exportContract().config.engine.workspace_assistant;
  assert.equal(spec.default, null);
  assert.deepEqual(spec.required_when_present, [...ASSISTANT_FIELDS]);
  assert.deepEqual(spec.recommended, BLOCK);
  assert.match(spec.recommended_is, /never applied by the engine/);
  assert.match(spec.limit_is, /not a hard maximum/);
});

// A start refused for its configuration: exit 4, a refusal on stderr, and
// nothing written to the home (no store, no lock, no token).
function start(t, config, args = []) {
  const home = mkdtempSync('/tmp/wab-cfg-');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  const done = spawnSync(process.execPath, [join(dist, 'cli.js'), 'serve', ...args], { env: { PATH: process.env.PATH, SURETY_HOME: home }, encoding: 'utf8', timeout: 30_000 });
  return { done, entries: readdirSync(home).sort() };
}

test('a partial or out-of-range block refuses the start, which writes nothing', (t) => {
  for (const block of [{ backend: 'claude' }, { ...BLOCK, turn_deadline_seconds: 1 }]) {
    const { done, entries } = start(t, { workspace_assistant: block });
    assert.equal(done.status, 4, `exit 4 (status ${done.status}; stderr ${done.stderr.slice(-400)})`);
    assert.match(done.stderr, /workspace_assistant/);
    assert.deepEqual(entries, ['config.json'], 'nothing written beside config.json');
  }
});

test('the scripted backend is refused at start outside the test mode, writing nothing', (t) => {
  const { done, entries } = start(t, { workspace_assistant: { ...BLOCK, backend: 'scripted' } });
  assert.equal(done.status, 4, `exit 4 (status ${done.status}; stderr ${done.stderr.slice(-400)})`);
  assert.match(done.stderr, /scripted only in the engine's test mode/);
  assert.deepEqual(entries, ['config.json']);
});

