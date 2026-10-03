// Developer tests for evidence reuse across a protected application (D1
// §§7.9, 9.2; build spec §6 corrections 17 and 18; row M41; M2 slice 1, entry
// A5): a result recorded for an earlier candidate under the protected version
// an application superseded is never passed for a later candidate through a
// reuse entry; under the version in force it still counts. Against a scratch
// store with the engine's migrations; the application's finalizer is the
// engine's own.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { finalizeApplication, effectiveVersion } = await import(join(dist, 'store', 'transitions', 'protected.js'));
const { checkState } = await import(join(dist, 'store', 'transitions', 'gates.js'));
const { getCandidate } = await import(join(dist, 'store', 'transitions', 'evidence.js'));

const AT = '2026-10-02T00:00:00.000Z';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.pragma('foreign_keys = ON');
  migrate(db, join(root, 'migrations'));
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  run(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
  );
  run(
    `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots)
     VALUES ('pv_1', ?, 'prj_1', 1, ?, 'initial', 'human', 'human', ?, 1, ?, '[".surety/checks/"]')`,
    AT,
    '1'.repeat(64),
    AT,
    AT,
  );
  run(`INSERT INTO lineages (id, created_at, project, branch, started_from_candidate, open) VALUES ('lin_1', ?, 'prj_1', 'main', NULL, 0)`, AT);
  for (const [id, seq, rev] of [
    ['cand_1', 1, A],
    ['cand_2', 2, B],
  ]) {
    run(
      `INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, nominated_protected_version, progress)
       VALUES (?, ?, 'prj_1', ?, ?, 'lin_1', ?, 'builder_request', 'pv_1', 'developing')`,
      id,
      AT,
      seq,
      rev,
      AT,
    );
  }
  const check = (id, version) =>
    run(
      `INSERT INTO checks (id, created_at, project, key, protected_version, kind, required, gate_kinds, definition_path, definition_hash, runner_class)
       VALUES (?, ?, 'prj_1', 'login', ?, 'acceptance', 1, '["stage","alpha_authorize"]', '.surety/checks/login', 'h', 'direct')`,
      id,
      AT,
      version,
    );
  check('chk_1', 'pv_1');
  // A passing execution of the check for the earlier candidate, under pv_1,
  // and an assessed reuse entry that offers it to the later one.
  run(
    `INSERT INTO check_results (id, created_at, project, "check", candidate, source_revision, protected_version, runner_class, runner_id, execution_seq,
       execution_established, signaled, deadline_hit, exit_status)
     VALUES ('cr_1', ?, 'prj_1', 'chk_1', 'cand_1', ?, 'pv_1', 'direct', 'r', 1, 1, 0, 0, 0)`,
    AT,
    A,
  );
  run(`INSERT INTO evidence_reuse (id, created_at, project, candidate, "check", check_result, record, assessed) VALUES ('reuse_1', ?, 'prj_1', 'cand_2', 'chk_1', 'cr_1', NULL, 1)`, AT);
  return { db, run, check };
}

const stateFor = (db, candidate, checkId) => {
  const c = db.prepare('SELECT * FROM checks WHERE id = ?').get(checkId);
  return checkState(db, 'prj_1', c, { candidate: getCandidate(db, candidate), effective: effectiveVersion(db, 'prj_1'), environment: null, artifact: null }).state;
};

// The application of a proposal lands: its version is intended, then its
// finalizer (the engine's) makes it the effective one.
function applyVersion(db, run) {
  run(
    `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots)
     VALUES ('pv_2', ?, 'prj_1', 2, ?, 'tightening', 'human', 'human', ?, 0, NULL, '[".surety/checks/"]')`,
    AT,
    '2'.repeat(64),
    AT,
  );
  run(
    `INSERT INTO operations (id, created_at, project, seq, kind, target, subject, idempotency_key, semantic_generation, status, deadline_at)
     VALUES ('op_1', ?, 'prj_1', 1, 'git_ref_update', '{}', '{}', 'k1', 1, 'succeeded', ?)`,
    AT,
    AT,
  );
  run(
    `INSERT INTO protected_proposals (id, created_at, project, seq, proposed_by, base_revision, tree_id, diff_hash, requested_change_kind, classified_change_kind, status)
     VALUES ('prop_1', ?, 'prj_1', 1, 'human', ?, ?, ?, 'tightening', 'tightening', 'approved')`,
    AT,
    A,
    'd'.repeat(40),
    'e'.repeat(64),
  );
  transact(db, ENGINE_ACTOR, (tx) =>
    finalizeApplication(tx, { id: 'op_1', project: 'prj_1' }, { purpose: 'protected', ref: 'refs/heads/main', ref_kind: 'integration', new_oid: B, proposal: 'prop_1', version: 'pv_2', intent: null }),
  );
}

test('before any application, the assessed reuse entry lets the earlier result count for the later candidate', (t) => {
  const { db } = store(t);
  assert.equal(stateFor(db, 'cand_2', 'chk_1'), 'passed');
});

test('after a protected application, the reused result of the earlier candidate is not passed for the later one', (t) => {
  const { db, run, check } = store(t);
  applyVersion(db, run);
  check('chk_2', 'pv_2');
  assert.notEqual(db.prepare(`SELECT invalidated_at FROM check_results WHERE id = 'cr_1'`).get().invalidated_at, null, 'the application invalidated it');
  assert.equal(stateFor(db, 'cand_2', 'chk_2'), 'stale');
  assert.equal(stateFor(db, 'cand_1', 'chk_2'), 'stale', 'nor for the candidate it was recorded for');
});

test('a result recorded under the superseded version after the application is not passed through reuse either', (t) => {
  const { db, run, check } = store(t);
  applyVersion(db, run);
  check('chk_2', 'pv_2');
  run(
    `INSERT INTO check_results (id, created_at, project, "check", candidate, source_revision, protected_version, runner_class, runner_id, execution_seq,
       execution_established, signaled, deadline_hit, exit_status)
     VALUES ('cr_2', ?, 'prj_1', 'chk_1', 'cand_1', ?, 'pv_1', 'direct', 'r', 2, 1, 0, 0, 0)`,
    AT,
    A,
  );
  run(`INSERT INTO evidence_reuse (id, created_at, project, candidate, "check", check_result, record, assessed) VALUES ('reuse_2', ?, 'prj_1', 'cand_2', 'chk_2', 'cr_2', NULL, 1)`, AT);
  assert.equal(stateFor(db, 'cand_2', 'chk_2'), 'stale');
});
