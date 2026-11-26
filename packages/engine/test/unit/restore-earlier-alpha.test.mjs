// Developer tests for WO1 Q1 (DECISIONS item 57, the owner's ruling of
// 2026-11-26; store/transitions/restore.ts): what qualified an iteration's
// Alpha is read from the store (deployment request → authorization →
// evaluation → acceptance scope), and the restore is refused, naming why,
// when the iteration had no Alpha or the environment's configuration is no
// longer the one that Alpha was authorized under. A scratch store, foreign
// keys off, the rows the reads need; the whole journey is M645's.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { migrate } = await import(join(root, 'dist', 'store', 'migrate.js'));
const R = await import(join(root, 'dist', 'store', 'transitions', 'restore.js'));

const AT = '2026-11-26T00:00:00.000Z';

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-restore-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management, mode) VALUES ('prj_1', ?, 'p', 'T1', '/r', 'main', 'spec_ready', 'registered', 'none', 'rapid_prototype')`).run(AT);
  db.prepare(`INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress) VALUES ('cand_1', ?, 'prj_1', 1, 'sha1', 'lin', ?, 'engine_cadence', 'alpha_deployed')`).run(AT, AT);
  db.prepare(`INSERT INTO environments (id, created_at, project, name, adapter, adapter_config_ref, verify_spec, prefix, current_config) VALUES ('env_1', ?, 'prj_1', 'alpha', 'local_service', 'ref', '{}', 'pfx', 'envc_2')`).run(AT);
  for (const [id, v, identity, status] of [['envc_1', 1, 'idA', 'superseded'], ['envc_2', 2, 'idB', 'current']]) {
    db.prepare(`INSERT INTO environment_configs (id, created_at, project, environment, version, content, config_identity, secret_digests, status, written_by, written_at) VALUES (?, ?, 'prj_1', 'env_1', ?, '{}', ?, '{}', ?, 'human', ?)`).run(id, AT, v, identity, status, AT);
  }
  db.prepare(
    `INSERT INTO acceptance_scopes (id, created_at, project, candidate, gate_kind, spec_revision, effective_protected_version, source_revision, delivered_requirement_ids, partial_requirement_ids, sensitivity_categories, required_check_ids, runner_classes, required_signoffs, validated, scope_hash, acceptance_content_hash)
     VALUES ('scope_1', ?, 'prj_1', 'cand_1', 'alpha_authorize', 'spec_1', 'pv_1', 'sha1', '["req_1"]', '[]', '[]', '["chk_1"]', '{}', '[]', 1, 'h', 'c')`,
  ).run(AT);
  db.prepare(`INSERT INTO gate_evaluations (id, created_at, project, scope, candidate, gate_kind, computed_at, inputs_hash, inputs_snapshot, check_states, outcome, reasons, satisfiers, stale) VALUES ('gate_1', ?, 'prj_1', 'scope_1', 'cand_1', 'alpha_authorize', ?, 'h', '{}', '{}', 'satisfied', '[]', '[]', 0)`).run(AT, AT);
  db.prepare(`INSERT INTO deployment_authorizations (id, created_at, project, candidate, environment, artifact_digest, source_delivery_mapping, config_identity, target_set, protected_version, evaluation, status, generation, binding_hash) VALUES ('dauth_1', ?, 'prj_1', 'cand_1', 'env_1', 'sha256:a', '{}', 'idA', '[]', 'pv_1', 'gate_1', 'consumed', 1, 'b')`).run(AT);
  db.prepare(`INSERT INTO deployment_requests (id, created_at, project, request_key, requested_by, candidate, environment, authorization, outcome) VALUES ('dreq_1', ?, 'prj_1', 'k', 'policy', 'cand_1', 'env_1', 'dauth_1', 'deployed')`).run(AT);
  db.prepare(`INSERT INTO prototype_iterations (id, created_at, project, seq, mode, status, limits_json, candidate, deployment_request, alpha_at, approved_at) VALUES ('it_1', ?, 'prj_1', 1, 'rapid_prototype', 'alpha_ready', '{}', 'cand_1', 'dreq_1', ?, ?)`).run(AT, AT, AT);
  db.prepare(`INSERT INTO prototype_iterations (id, created_at, project, seq, mode, status, limits_json, predecessor) VALUES ('it_2', ?, 'prj_1', 2, 'rapid_prototype', 'preparing', '{}', 'it_1')`).run(AT);
  return db;
}

test('restoreSource: what qualified the Alpha, read through its request, authorization, evaluation and scope', (t) => {
  const db = store(t);
  const s = R.restoreSource(db, 'prj_1', 'it_1');
  assert.deepEqual([s.iteration.seq, s.candidate.id, s.request.id, s.authorization.id, s.authorization.config_identity, s.evaluation, s.scope.id, s.scope.spec_revision, s.scope.effective_protected_version], [1, 'cand_1', 'dreq_1', 'dauth_1', 'idA', 'gate_1', 'scope_1', 'spec_1', 'pv_1']);
  assert.throws(() => R.restoreSource(db, 'prj_1', 'it_2'), (e) => e.code === 'illegal_transition' && /never reached its Alpha/.test(e.reason));
  assert.throws(() => R.restoreSource(db, 'prj_1', 'it_9'), (e) => e.code === 'not_found');
});

test('restoreFacts: the environment\'s configuration changed since that Alpha was authorized: refused, naming the configuration', (t) => {
  const db = store(t);
  assert.throws(
    () => R.restoreFacts(db, { project: 'prj_1', iteration: 'it_1' }),
    (e) => e.code === 'config_changed' && e.subject.config === 'envc_2' && e.subject.qualified_config_identity === 'idA' && e.subject.qualified_by === 'gate_1',
  );
  assert.throws(() => R.restoreFacts(db, { project: 'prj_1', iteration: 'it_1', environment: 7 }), (e) => e.code === 'invalid_value');
});

test('restoredOf and restoreOfAuthorization: only a deployed restore is served, as recorded', (t) => {
  const db = store(t);
  assert.equal(R.restoredOf(db, 'env_1'), null, 'the latest deployed request is no restore');
  assert.equal(R.restoreOfAuthorization(db, 'dauth_1'), null);
  db.prepare(`INSERT INTO deployment_requests (id, created_at, project, request_key, requested_by, candidate, environment, authorization, outcome, restore) VALUES ('dreq_2', ?, 'prj_1', 'k2', 'human', 'cand_1', 'env_1', 'dauth_2', 'deployed', ?)`).run(AT, JSON.stringify({ iteration: 1, iteration_id: 'it_1', candidate: 'cand_1', spec_revision: 'spec_1', protected_version: 'pv_1', qualified_by: 'gate_1' }));
  const r = R.restoredOf(db, 'env_1');
  assert.deepEqual([r.iteration, r.candidate, r.spec_revision, r.protected_version, r.qualified_by, r.request, r.restored_at], [1, 'cand_1', 'spec_1', 'pv_1', 'gate_1', 'dreq_2', null], 'restored_at unknown until its operation is finalized, never invented');
  assert.equal(R.restoreOfAuthorization(db, 'dauth_2'), 'it_1');
});
