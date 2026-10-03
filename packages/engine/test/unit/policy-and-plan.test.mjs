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
