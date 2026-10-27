// Developer tests for the project settings D2 A.7 adds (rows M103, M108) and
// the validation of the widened mount plan before a launch (D2 §2.3): what a
// submission may hold, which changes widen, and what a sandbox_read_paths
// entry may never reach. The plan is judged against scratch directories.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { validatePolicySubmission, wideningKeys, effectiveOf } = await import(join(dist, 'config', 'project-policy.js'));
const { validateReadPaths } = await import(join(dist, 'invoke', 'sandbox', 'plan.js'));
const { validateEngineConfig } = await import(join(dist, 'config', 'engine-config.js'));

test('ui_bootstrap is a closed boolean engine key, false by default', () => {
  assert.equal(validateEngineConfig({}).values.ui_bootstrap, false);
  assert.equal(validateEngineConfig({ ui_bootstrap: true }).values.ui_bootstrap, true);
  assert.throws(() => validateEngineConfig({ ui_bootstrap: 'yes' }), (err) => err.code === 'invalid_value');
  assert.throws(() => validateEngineConfig({ scripted_boundary: true }), (err) => err.code === 'unknown_field');
});

test('the typed project settings: a hard maximum is refused; host names and paths are checked; a backend is named per role', () => {
  assert.throws(() => validatePolicySubmission({ budget_hard_maximum: true }), (err) => err.code === 'hard_cap_unenforceable' && err.status === 400);
  assert.deepEqual(validatePolicySubmission({ budget_hard_maximum: false }), { budget_hard_maximum: false });
  assert.throws(() => validatePolicySubmission({ budget_run_boundary: 'per_call' }), (err) => err.code === 'invalid_value');
  assert.throws(() => validatePolicySubmission({ egress_allow_extra: ['Example.COM'] }), (err) => err.code === 'invalid_value');
  assert.throws(() => validatePolicySubmission({ egress_allow_extra: ['10.0.0.1'] }), (err) => err.code === 'invalid_value');
  assert.throws(() => validatePolicySubmission({ egress_allow_extra: ['example.com:443'] }), (err) => err.code === 'invalid_value');
  assert.throws(() => validatePolicySubmission({ sandbox_read_paths: ['relative/path'] }), (err) => err.code === 'invalid_value');
  assert.throws(() => validatePolicySubmission({ sandbox_read_paths: ['/a/../b'] }), (err) => err.code === 'invalid_value');
  assert.deepEqual(validatePolicySubmission({ backend_verifier: 'claude', backend_mode: 'session_headless' }), { backend_verifier: 'claude', backend_mode: 'session_headless' });
  assert.throws(() => validatePolicySubmission({ backend_mechanic: 'claude' }), (err) => err.code === 'unknown_field');
  assert.throws(() => validatePolicySubmission({ backend_builder: 'gpt' }), (err) => err.code === 'invalid_value');
  assert.throws(() => validatePolicySubmission({ backend_mode: 'interactive' }), (err) => err.code === 'invalid_value');
  // A recorded value the schema refuses is never effective.
  assert.equal(effectiveOf({ budget_hard_maximum: true }).budget_hard_maximum, false);
});

test('a widening: a host or path added; a coarser budget boundary; never a removal or a finer boundary', () => {
  const effective = effectiveOf({ egress_allow_extra: ['a.example.com'], sandbox_read_paths: ['/opt/tool'] });
  assert.deepEqual(wideningKeys(effective, { egress_allow_extra: ['a.example.com', 'b.example.com'] }), ['egress_allow_extra']);
  assert.deepEqual(wideningKeys(effective, { egress_allow_extra: [] }), []);
  assert.deepEqual(wideningKeys(effective, { sandbox_read_paths: ['/opt/tool', '/opt/other'] }), ['sandbox_read_paths']);
  assert.deepEqual(wideningKeys(effective, { sandbox_read_paths: [] }), []);
  assert.deepEqual(wideningKeys(effective, { budget_run_boundary: 'model_turn' }), []);
  assert.deepEqual(wideningKeys(effectiveOf({ budget_run_boundary: 'model_turn' }), { budget_run_boundary: 'invocation' }), ['budget_run_boundary']);
});

test('the read paths a plan refuses: the engine home and aliases of it, repositories, credential locations, host trees, sockets and FIFOs', async (t) => {
  const base = mkdtempSync(join(process.env.SURETY_UNIT_PLAN_DIR ?? '/var/tmp', 'surety-plan-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  const operator = join(base, 'operator');
  const harmless = join(base, 'tools');
  for (const d of [home, repo, operator, harmless, join(operator, '.ssh')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(harmless, 'tool'), 'x');
  symlinkSync(home, join(base, 'alias-of-home'));
  const ctx = { home, repositories: [repo], workspaces: [], checkouts: [] };
  const savedHome = process.env.HOME;
  process.env.HOME = operator;
  t.after(() => {
    process.env.HOME = savedHome;
  });

  assert.equal(await validateReadPaths([harmless], ctx), null, 'a harmless directory may be bound');
  const reason = async (p) => (await validateReadPaths([p], ctx))?.reason ?? null;
  assert.equal(await reason(home), 'engine_home');
  assert.equal(await reason(join(base, 'alias-of-home')), 'engine_home', 'an alias is judged by what it resolves to');
  assert.ok((await validateReadPaths([base], ctx)).detail.startsWith('it contains'));
  assert.equal(await reason(repo), 'repository');
  assert.equal(await reason(join(operator, '.ssh')), 'credential_location');
  for (const host of ['/run', '/proc', '/dev', '/tmp', '/mnt']) assert.equal(await reason(host), 'forbidden_root', `${host} is refused`);
  if (existsSync('/usr/lib/wsl')) assert.equal(await reason('/usr/lib/wsl'), 'wsl_path');

  const sockets = join(base, 'sockets');
  mkdirSync(sockets);
  const server = net.createServer().listen(join(sockets, 'listening.sock'));
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  assert.equal(await reason(sockets), 'special_file');

  const fifos = join(base, 'fifos');
  mkdirSync(fifos);
  execFileSync('mkfifo', [join(fifos, 'pipe')]);
  assert.equal(await reason(fifos), 'special_file');
});

// The owner's production-defaults ruling of 2026-10-27: outside the test mode
// the scripted backend is neither a default nor a choice of a
// `backend_<role>` key, the keys have no default and are absent from the
// effective defaults; in the test mode `scripted` is offered and is every
// role's default, as before.
test('backend_<role>: no default and only the real providers outside the test mode; scripted the default and a choice in it', async (t) => {
  const { projectEffectiveDefaults, projectOptionSpecs, unconfiguredBackendKeys } = await import(join(dist, 'config', 'project-policy.js'));
  const { configureHarness } = await import(join(dist, 'testing', 'seam.js'));
  const { generateAppendix } = await import(join(dist, 'contract', 'appendix.js'));
  const KEYS = ['backend_builder', 'backend_verifier', 'backend_reviewer', 'backend_architect', 'backend_vision', 'backend_spec_writer', 'backend_designer'];
  t.after(() => configureHarness(false, []));

  // Production.
  const defaults = projectEffectiveDefaults();
  for (const key of KEYS) {
    assert.equal(Object.hasOwn(defaults, key), false, `${key} is absent from the defaults: unconfigured`);
    assert.deepEqual([...projectOptionSpecs()[key].values], ['claude', 'codex'], `${key} offers the real providers only`);
    assert.equal(projectOptionSpecs()[key].default, null, `${key} has no default`);
    assert.throws(() => validatePolicySubmission({ [key]: 'scripted' }), (e) => e.code === 'invalid_value');
    assert.deepEqual(validatePolicySubmission({ [key]: 'claude' }), { [key]: 'claude' });
  }
  assert.equal(defaults.backend_mode, 'one_shot_headless', 'the other options keep their defaults');
  assert.deepEqual(unconfiguredBackendKeys(defaults), KEYS);
  // A recorded `scripted` is not effective; a recorded real provider is.
  const eff = effectiveOf({ backend_builder: 'scripted', backend_verifier: 'codex' });
  assert.equal(Object.hasOwn(eff, 'backend_builder'), false);
  assert.equal(eff.backend_verifier, 'codex');
  assert.deepEqual(unconfiguredBackendKeys(eff), KEYS.filter((k) => k !== 'backend_verifier'));
  // A change of an unconfigured key never counts as a widening.
  assert.deepEqual(wideningKeys(defaults, { backend_builder: 'claude' }), []);
  // The appendix states the key as unconfigured.
  const appendix = generateAppendix({ config: { engine: {}, project: { backend_builder: { default: null, type: 'enum', values: ['claude', 'codex'], widening: 'never' } } } });
  assert.ok(appendix.split('\n').includes('- `backend_builder`: no default, unconfigured until set (one of claude, codex)'));

  // The test mode.
  assert.equal(configureHarness(true, []), null);
  const test = projectEffectiveDefaults();
  for (const key of KEYS) {
    assert.equal(test[key], 'scripted', `${key} defaults to scripted in the test mode`);
    assert.deepEqual([...projectOptionSpecs()[key].values], ['scripted', 'claude', 'codex']);
    assert.deepEqual(validatePolicySubmission({ [key]: 'scripted' }), { [key]: 'scripted' });
  }
  assert.deepEqual(unconfiguredBackendKeys(test), []);
  assert.deepEqual(Object.keys(projectOptionSpecs()), Object.keys((configureHarness(false, []), projectOptionSpecs())), 'the same keys, in the same order, in both modes');
});

// GET /v1/setup's policy part: outside the test mode the backend keys are
// absent from policy_defaults and stated unconfigured, with a message that a
// real provider needs configuring; in the test mode, scripted as before.
test("GET /v1/setup's policy defaults state an unconfigured provider outside the test mode, and scripted in it", async (t) => {
  const { policyDefaults } = await import(join(dist, 'setup', 'policy-defaults.js'));
  const { configureHarness } = await import(join(dist, 'testing', 'seam.js'));
  t.after(() => configureHarness(false, []));
  const ROLES = { builder: 'backend_builder', verifier: 'backend_verifier', reviewer: 'backend_reviewer', architect: 'backend_architect', vision: 'backend_vision', spec_writer: 'backend_spec_writer', designer: 'backend_designer' };

  const prod = policyDefaults();
  assert.equal(prod.policy_defaults_state, 'provider_unconfigured');
  for (const key of Object.values(ROLES)) {
    assert.equal(Object.hasOwn(prod.policy_defaults, key), false, `${key} absent`);
    assert.deepEqual(prod.policy_fields[key], { type: 'enum', values: ['claude', 'codex'], default: null, widening: 'never' });
  }
  assert.equal(prod.backend_defaults.state, 'unconfigured');
  assert.equal(prod.backend_defaults.provider_required, true);
  assert.deepEqual(prod.backend_defaults.choices, ['claude', 'codex']);
  assert.deepEqual(prod.backend_defaults.roles, Object.fromEntries(Object.entries(ROLES).map(([role, key]) => [role, { key, state: 'unconfigured', default: null }])));
  assert.match(prod.backend_defaults.message, /^No provider is configured: backend_builder, .*backend_designer have no default, and the engine substitutes none\. Configure a real provider \(claude or codex\)/);
  assert.equal(prod.policy_defaults.budget_run_boundary, 'invocation', 'the other defaults are served as before');

  assert.equal(configureHarness(true, []), null);
  const test = policyDefaults();
  assert.equal(test.policy_defaults_state, 'complete');
  for (const key of Object.values(ROLES)) assert.equal(test.policy_defaults[key], 'scripted');
  assert.deepEqual(test.policy_fields.backend_builder.values, ['scripted', 'claude', 'codex']);
  assert.deepEqual(test.backend_defaults, {
    state: 'default',
    provider_required: false,
    message: null,
    choices: ['scripted', 'claude', 'codex'],
    roles: Object.fromEntries(Object.entries(ROLES).map(([role, key]) => [role, { key, state: 'default', default: 'scripted' }])),
  });
});
