// Developer tests for M4 slice 23, the walking deployment (D4 §§2 to 5;
// SEAM.md §§244 to 254): reconcile's mapping of what was read (D4 §2.4), the
// configuration's validation and keyed identity (§3.2), the artifact's
// projection, digest and rehash (§3.1), the bounded adapter calls (§2.1),
// and the store's immutability of configuration versions. Pure functions
// and a scratch store with the engine's migrations; no engine is started.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { judgeReconcile } = await import(join(dist, 'deploy', 'reconcile.js'));
const { configIdentity, validateConfig, homeHash, digestOf } = await import(join(dist, 'deploy', 'config.js'));
const { excluded, digestOfManifest, rehash } = await import(join(dist, 'deploy', 'artifact.js'));
const { effectCall, readCall } = await import(join(dist, 'deploy', 'adapter.js'));
const { migrate } = await import(join(dist, 'store', 'migrate.js'));

const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-deploy-'));
  t.after(() => {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // gone already
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
};

// ---- reconcile (D4 §2.4; D4-A03; review S2, S3, m2) -----------------------------------------------

const DIGEST = `sha256:${'a'.repeat(64)}`;
const APP = { pid: 100001, start_time: 1002 };
const OLD = { pid: 100000, start_time: 1001 };
const unit = (name, over = {}) => ({ resource: name, kind: 'unit', recorded: true, state: 'active', pendingJob: false, generation: 1, instance: APP, tree: DIGEST, ...over });
const res = (kind, name, over = {}) => ({ resource: `/run/${name}/${kind}`, kind, recorded: true, state: kind === 'cgroup' ? 'populated' : 'present', pendingJob: false, generation: Number(/g(\d+)$/.exec(name)[1]), ...over });
const deploy = (over = {}) => ({
  kind: 'deploy',
  prefix: 'p-',
  digest: DIGEST,
  create_units: ['p-g2.service'],
  prior: [],
  stop_units: [],
  recorded: ['p-g1.service', 'p-g2.service'],
  launch_granted: true,
  app_instance: APP,
  ...over,
});
const teardown = (over = {}) => deploy({ kind: 'teardown', create_units: [], stop_units: ['p-g1.service', 'p-g2.service'], ...over });
const read = (inventory, complete = true) => ({ ok: { outcome: 'unknown', complete, inventory, reads: [], identity: [] } });
const judge = (inventory, x, complete) => judgeReconcile(read(inventory, complete), x).outcome;

test('reconcile: a failed or incomplete read, any resource with a state or job unread or missing, or a pending job is unknown, before anything else', () => {
  assert.equal(judgeReconcile({ failure: 'deadline' }, deploy()).outcome, 'unknown');
  assert.equal(judge([unit('p-g2.service')], deploy(), false), 'unknown');
  assert.equal(judge([unit('p-g2.service'), unit('other.service', { recorded: false })], deploy(), false), 'unknown', 'unknown takes precedence over conflicting');
  assert.equal(judge([unit('p-g2.service', { state: 'unread' })], deploy()), 'unknown');
  assert.equal(judge([unit('p-g2.service', { pendingJob: true })], deploy()), 'unknown', 'no quiescence');
  assert.equal(judge([unit('p-g2.service'), res('cgroup', 'p-g2', { state: 'unread' })], deploy()), 'unknown', 'a cgroup unread (S3)');
  assert.equal(judge([res('cgroup', 'p-g2', { state: 'unread' })], teardown()), 'unknown', 'a teardown with a cgroup unread is never applied (S3)');
  assert.equal(judge([res('socket', 'p-g2', { generation: 'unread' })], teardown()), 'unknown', 'a resource whose generation is unread belongs to no unit the engine can name');
  assert.equal(judge([res('cgroup', 'p-g7')], teardown()), 'conflicting', 'a resource of a generation no intent names');
  const { pendingJob: _p, ...noJob } = unit('p-g2.service');
  const { state: _s, ...noState } = unit('p-g2.service');
  assert.equal(judge([noJob], deploy()), 'unknown', 'a missing pending job is unknown, not none (m2)');
  assert.equal(judge([noState], deploy()), 'unknown', 'a missing state is unknown, not inactive (m2)');
  assert.equal(judgeReconcile({ ok: null }, deploy()).outcome, 'unknown', 'an answer that is not a reconciliation');
});

test('reconcile: applied needs the authorized unit with the recorded instance and the frozen digest, the prior gone, nothing else live', () => {
  assert.equal(judge([unit('p-g2.service'), res('cgroup', 'p-g2')], deploy()), 'applied');
  assert.equal(judge([unit('p-g2.service', { tree: `sha256:${'b'.repeat(64)}` })], deploy()), 'conflicting', 'another tree');
  assert.equal(judge([unit('p-g2.service', { instance: { pid: 7, start_time: 1 } })], deploy()), 'conflicting', 'another instance');
  assert.equal(judge([unit('p-g2.service', { instance: 'unread' })], deploy()), 'unknown', 'the instance unread');
  assert.equal(judge([unit('p-g2.service')], deploy({ app_instance: null })), 'unknown', 'no instance recorded at launch: the binding is unread');
  const prior = [{ unit: 'p-g1.service', instance: OLD }];
  assert.equal(judge([unit('p-g2.service'), unit('p-g1.service', { instance: OLD })], deploy({ prior })), 'conflicting', 'two generations active');
  assert.equal(judge([unit('p-g2.service'), res('cgroup', 'p-g1')], deploy({ prior })), 'partial', 'the prior domain still populated: its termination not established');
  assert.equal(judge([unit('p-g2.service'), unit('stray.service', { recorded: false })], deploy()), 'conflicting', 'a unit no intent names');
  assert.equal(judge([unit('p-g2.service'), unit('stray.service', { recorded: false, state: 'failed' })], deploy()), 'conflicting', 'in any state');
});

test('reconcile: absent only with g and its domain absent, no launch ever granted, the prior exactly as frozen; a granted launch whose unit is gone is partial (S2)', () => {
  const prior = [{ unit: 'p-g1.service', instance: OLD }];
  assert.equal(judge([], deploy({ launch_granted: false })), 'absent');
  assert.equal(judge([unit('p-g1.service', { instance: OLD })], deploy({ launch_granted: false, prior })), 'absent', 'the prior intact');
  assert.equal(judge([], deploy({ launch_granted: true })), 'partial', 'a launch granted and its unit gone (S2)');
  assert.equal(judge([res('cgroup', 'p-g2')], deploy({ launch_granted: false })), 'partial', "g's domain still there (S3)");
  assert.equal(judge([], deploy({ launch_granted: false, prior })), 'partial', 'the prior stopped and g absent');
  assert.equal(judge([unit('p-g1.service', { instance: APP })], deploy({ launch_granted: false, prior })), 'conflicting', 'the prior running another instance than the one frozen (S3)');
  assert.equal(judge([unit('p-g2.service', { state: 'failed' })], deploy()), 'partial', 'g present but failed');
});

test('reconcile: a teardown is applied only with every resource it covers gone; residue is partial; an unowned resource in any state is conflicting (S3)', () => {
  assert.equal(judge([], teardown()), 'applied');
  assert.equal(judge([unit('p-g1.service'), unit('p-g2.service')], teardown()), 'absent');
  assert.equal(judge([unit('p-g2.service')], teardown()), 'partial');
  assert.equal(judge([res('cgroup', 'p-g2'), res('socket', 'p-g2')], teardown()), 'partial', 'no unit left, but a populated cgroup and a socket');
  assert.equal(judge([unit('p-g1.service'), unit('p-g2.service'), unit('p-g3.service', { recorded: false, state: 'failed' })], teardown()), 'conflicting', 'every unit unchanged plus an extra prefixed unit, failed');
  assert.equal(judge([unit('x.service', { recorded: false })], teardown()), 'conflicting');
});

// ---- configuration (D4 §3.2; SEAM.md §245) -----------------------------------------------------

const content = (over = {}) => ({
  adapter: 'local_service',
  adapter_version: '1',
  targets: ['app'],
  runtime: { path: '/usr/bin/node', sha256: 'f'.repeat(64) },
  start: ['/usr/bin/node', 'server.js'],
  port: 8080,
  ...over,
});

test('configuration: the closed content; only deployment references (review S4); a refusal names the field as a dotted path', () => {
  assert.deepEqual(validateConfig(content()), content());
  const refused = (body, field) =>
    assert.throws(
      () => validateConfig(body),
      (e) => e.code === 'config_invalid' && e.subject.field === field,
      `refused naming ${field}`,
    );
  refused(content({ surprise: 1 }), 'surprise');
  refused(content({ adapter: 'docker' }), 'adapter');
  refused(content({ targets: ['app', 'web'] }), 'targets');
  refused(content({ port: 80 }), 'port');
  refused(content({ secrets: { APP_TOKEN: 'vault/x' } }), 'secrets.APP_TOKEN');
  refused(content({ secrets: { APP_TOKEN: 'backend/claude/api_key' } }), 'secrets.APP_TOKEN');
  refused(content({ check_secrets: ['backend/claude/subscription_token'] }), 'check_secrets.0');
  refused(content({ check_secrets: ['deploy/ok', 'vault/x'] }), 'check_secrets.1');
  refused(content({ identity_method: 'banner' }), 'identity_method');
});

test('configuration identity: every field changes it; equal content gives equal identity; a reference is keyed by its digest', () => {
  const d = [{ ref: 'deploy/app_token', digest: 'hmac-sha256:1' }];
  const base = content({ secrets: { APP_TOKEN: 'deploy/app_token' } });
  const id = configIdentity(base, d);
  assert.match(id, /^sha256:[0-9a-f]{64}$/);
  assert.equal(configIdentity({ ...base }, d), id);
  assert.notEqual(configIdentity({ ...base, port: 8081 }, d), id);
  assert.notEqual(configIdentity({ ...base, adapter_version: '2' }, d), id);
  assert.notEqual(configIdentity({ ...base, targets: ['web'] }, d), id);
  assert.notEqual(configIdentity(base, [{ ref: 'deploy/app_token', digest: 'hmac-sha256:2' }]), id, 'another held value');
  const key = Buffer.alloc(32, 7);
  assert.notEqual(digestOf(key, 'v'), digestOf(Buffer.alloc(32, 8), 'v'), 'keyed');
  assert.match(homeHash('/some/home'), /^[0-9a-f]{12}$/);
});

// ---- the artifact (D4 §3.1) ----------------------------------------------------------------------

test('artifact: .surety/ and the excludes are outside the projection; the digest is the manifest\'s; a rehash finds a change, an extra file and a write bit', (t) => {
  assert.equal(excluded('.surety/checks/a.json', []), true);
  assert.equal(excluded('docs/x.md', ['docs/']), true);
  assert.equal(excluded('docs', ['docs']), true);
  assert.equal(excluded('docsy/x.md', ['docs']), false);
  const dir = scratch(t);
  const sealed = join(dir, 'sealed');
  mkdirSync(join(sealed, 'lib'), { recursive: true });
  writeFileSync(join(sealed, 'server.js'), 'ok\n');
  writeFileSync(join(sealed, 'lib', 'run.sh'), '#!/bin/sh\n');
  chmodSync(join(sealed, 'server.js'), 0o444);
  chmodSync(join(sealed, 'lib', 'run.sh'), 0o555);
  const h = (s) => createHash('sha256').update(s).digest('hex');
  const manifest = [
    ['lib/run.sh', 'file', '100755', 10, h('#!/bin/sh\n')],
    ['server.js', 'file', '100644', 3, h('ok\n')],
  ];
  assert.match(digestOfManifest(manifest), /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(digestOfManifest(manifest), digestOfManifest([manifest[0], ['server.js', 'file', '100755', 3, h('ok\n')]]), 'the executable class is in the digest');
  assert.equal(rehash(sealed, manifest), 'ok');
  chmodSync(join(sealed, 'server.js'), 0o644);
  assert.equal(rehash(sealed, manifest), 'corrupt', 'a write bit');
  chmodSync(join(sealed, 'server.js'), 0o444);
  writeFileSync(join(sealed, 'extra.js'), 'x');
  chmodSync(join(sealed, 'extra.js'), 0o444);
  assert.equal(rehash(sealed, manifest), 'corrupt', 'an extra file');
  rmSync(join(sealed, 'extra.js'));
  chmodSync(join(sealed, 'server.js'), 0o644);
  appendFileSync(join(sealed, 'server.js'), 'more');
  chmodSync(join(sealed, 'server.js'), 0o444);
  assert.equal(rehash(sealed, manifest), 'corrupt', 'a changed byte');
  assert.equal(rehash(join(dir, 'missing'), manifest), 'unread');
});

// ---- bounded calls (D4 §2.1) -----------------------------------------------------------------------

const bounds = { effectMs: 100, readMs: 100, outputBytes: 1000 };

test('bounded calls: an effect past its deadline or bound is uncertain; a read past its deadline or bound, or failing, is a failure class', async () => {
  const cap = { kind: 'deploy' };
  const hang = { deploy: (_c, signal) => new Promise((r) => signal.addEventListener('abort', () => r({ result: 'issued', steps: [] }))) };
  assert.deepEqual((await effectCall(hang, cap, null, bounds)).bound, 'deadline');
  assert.equal((await effectCall(hang, cap, null, bounds)).receipt.result, 'uncertain');
  const big = { deploy: async () => ({ result: 'issued', steps: [{ at: '', step: '', detail: 'x'.repeat(2000) }] }) };
  assert.deepEqual([(await effectCall(big, cap, null, bounds)).bound, (await effectCall(big, cap, null, bounds)).receipt.result], ['output_exceeded', 'uncertain']);
  const odd = { deploy: async () => ({ result: 'done' }) };
  assert.equal((await effectCall(odd, cap, null, bounds)).receipt.result, 'uncertain', 'an answer that is no result');
  const fine = { deploy: async () => ({ result: 'refused', steps: [] }) };
  const settled = await effectCall(fine, cap, null, bounds);
  assert.deepEqual([settled.receipt, settled.bound], [{ result: 'refused', steps: [] }, null]);
  // Review m1: the call's own promise, which the operator awaits before any
  // reconcile read, settles even after a deadline.
  const late = await effectCall(hang, cap, null, bounds);
  assert.equal(late.bound, 'deadline');
  await late.settled;
  assert.deepEqual(await readCall(() => new Promise(() => {}), bounds), { failure: 'deadline' });
  assert.deepEqual(await readCall(async () => 'x'.repeat(2000), bounds), { failure: 'output_exceeded' });
  assert.deepEqual(await readCall(async () => Promise.reject(Object.assign(new Error('x'), { failure: 'invalid_response' })), bounds), { failure: 'invalid_response' });
  assert.deepEqual(await readCall(async () => Promise.reject(new Error('x')), bounds), { failure: 'unavailable' });
  assert.deepEqual(await readCall(async () => [1], bounds), { ok: [1] });
});

// ---- the store ----------------------------------------------------------------------------------------

test('store: a configuration version is never edited or deleted; only its status moves, and a superseded one stays so', (t) => {
  const dir = scratch(t);
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  migrate(db, join(root, 'migrations'));
  const at = '2026-10-09T00:00:00.000Z';
  db.prepare(`INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management) VALUES ('prj_1', ?, 'p', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`).run(at);
  db.prepare(`INSERT INTO environments (id, created_at, project, name, adapter, adapter_config_ref, verify_spec) VALUES ('env_1', ?, 'prj_1', 'alpha', 'local_service', 'x', '{}')`).run(at);
  db.prepare(
    `INSERT INTO environment_configs (id, created_at, project, environment, version, content, config_identity, secret_digests, status, written_by, written_at) VALUES ('envc_1', ?, 'prj_1', 'env_1', 1, '{}', 'sha256:x', '[]', 'current', 'human', ?)`,
  ).run(at, at);
  for (const sql of [`UPDATE environment_configs SET content = '{}'`, `UPDATE environment_configs SET secret_digests = '[]'`, `DELETE FROM environment_configs`]) {
    assert.throws(() => db.prepare(sql).run(), /environment_configs/, sql);
  }
  db.prepare(`UPDATE environment_configs SET status = 'superseded'`).run();
  assert.throws(() => db.prepare(`UPDATE environment_configs SET status = 'current'`).run(), /superseded/);
  // Review m6: a prefix is fixed once.
  db.prepare(`UPDATE environments SET prefix = 'surety-000000000000-env_1-'`).run();
  assert.throws(() => db.prepare(`UPDATE environments SET prefix = 'surety-111111111111-env_1-'`).run(), /prefix is fixed/);
});

// ---- supervision (D4 §9.2; E110; review S1) ------------------------------------------------------

test('supervision: attached only while the incarnation that granted the launch runs; unknown after a restart or with no grant', async () => {
  const { supervisionOf } = await import(join(dist, 'store', 'transitions', 'deploy.js'));
  const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
  setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_now' });
  const granted = JSON.stringify({ pid: 1, start_time: 2 });
  assert.equal(supervisionOf({ incarnation: 'inc_now', init_instance: granted }), 'attached');
  assert.equal(supervisionOf({ incarnation: 'inc_before', init_instance: granted }), 'unknown', 'launched by an earlier incarnation');
  assert.equal(supervisionOf({ incarnation: 'inc_now', init_instance: null }), 'unknown', 'no launch granted');
  setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });
  assert.equal(supervisionOf({ incarnation: 'inc_now', init_instance: granted }), 'unknown', 'no running incarnation known');
});
