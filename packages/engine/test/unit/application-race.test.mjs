// Developer tests for a protected application whose branch update was
// overtaken (D1 §§7.5, 10.5; SEAM.md §104; E51): a ref update intended and
// never attempted, whose ref the engine has itself registered elsewhere since,
// fails without effect, and what it was for is withdrawn: the intent is
// invalidated with EFFECT_PRECONDITION_CHANGED, the intended version is gone,
// the proposal awaits approval again and the next generation is open. A ref
// at the update's old commit, or anywhere the engine did not put it, is not
// refused here (it stays the probe's to judge). Against a scratch store.

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
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { raiseQuestion, answerQueued } = await import(join(dist, 'store', 'transitions', 'queue.js'));
const { intendOperation, refuseMovedBase } = await import(join(dist, 'store', 'transitions', 'journal.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });

const AT = '2026-10-02T00:00:00.000Z';
const H = 'a'.repeat(40); // the head the application was prepared on
const R = 'b'.repeat(40); // where an integration moved the branch since
const P = 'c'.repeat(40); // the application's commit
const X = 'e'.repeat(40); // a commit nobody registered

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
    'f'.repeat(64),
    AT,
    AT,
  );
  run(`INSERT INTO ref_registry (id, created_at, project, ref, kind, expected_oid, immutable) VALUES ('ref_main', ?, 'prj_1', 'refs/heads/main', 'integration', ?, 0)`, AT, H);
  run(
    `INSERT INTO protected_proposals (id, created_at, project, seq, proposed_by, base_revision, tree_id, diff_hash, requested_change_kind, classified_change_kind, status)
     VALUES ('prop_1', ?, 'prj_1', 1, 'human', ?, ?, ?, 'tightening', 'tightening', 'classified')`,
    AT,
    H,
    'd'.repeat(40),
    '9'.repeat(64),
  );
  // The human approves, against H: the consumption records the intent.
  const d = transact(db, ENGINE_ACTOR, (tx) => raiseQuestion(tx, { project: 'prj_1', kind: 'check_correction_tightening', subjectType: 'protected_proposal', subjectId: 'prop_1' }));
  transact(db, ENGINE_ACTOR, (tx) => answerQueued(tx, { project: 'prj_1', decision: d.id, option: 'approve', preview_hash: d.preview_hash, note: null }));
  const intent = db.prepare('SELECT id FROM effect_intents').get().id;
  // The application begun: its version intended, its commit made, its branch
  // update intended from H by the commit's finalizer.
  run(
    `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, proposal, approved_by, approver_authority, approved_at, authorized, effective_from, roots)
     VALUES ('pv_2', ?, 'prj_1', 2, ?, 'tightening', 'prop_1', 'human', 'human', ?, 0, NULL, '[".surety/checks/"]')`,
    AT,
    '2'.repeat(64),
    AT,
  );
  run(`UPDATE effect_intents SET status = 'executing' WHERE id = ?`, intent);
  const op = transact(db, ENGINE_ACTOR, (tx) =>
    intendOperation(tx, {
      project: 'prj_1',
      kind: 'ref_update',
      payload: { repo: '/nowhere', ref: 'refs/heads/main', old_oid: H, new_oid: P },
      target: { repo: '/nowhere', ref: 'refs/heads/main' },
      subject: { proposal: 'prop_1', new_oid: P },
      finalizer: { purpose: 'protected', ref: 'refs/heads/main', ref_kind: 'integration', new_oid: P, proposal: 'prop_1', version: 'pv_2', intent },
      deadlineSeconds: 60,
    }),
  ).operation;
  return { db, decision: d, intent, op };
}

const refuse = (db, op, found) => transact(db, ENGINE_ACTOR, (tx) => refuseMovedBase(tx, { operation: op, found, incarnation: 'inc_1' }));
const opState = (db, op) => ({
  status: db.prepare('SELECT status FROM operations WHERE id = ?').get(op).status,
  journal: db.prepare('SELECT state FROM git_journal_state WHERE operation = ?').get(op).state,
});

test('the branch registered elsewhere since the update was intended: it fails without effect, and the application is withdrawn', (t) => {
  const { db, decision, intent, op } = store(t);
  db.prepare(`UPDATE ref_registry SET expected_oid = ? WHERE id = 'ref_main'`).run(R);
  assert.equal(refuse(db, op, R), true);
  assert.deepEqual(opState(db, op), { status: 'failed', journal: 'failed' });
  assert.deepEqual(db.prepare('SELECT status, invalidated_reason FROM effect_intents WHERE id = ?').get(intent), { status: 'invalidated', invalidated_reason: 'EFFECT_PRECONDITION_CHANGED' });
  assert.deepEqual(db.prepare(`SELECT status, approver, resulting_version FROM protected_proposals WHERE id = 'prop_1'`).get(), { status: 'classified', approver: null, resulting_version: null });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM protected_versions WHERE proposal = 'prop_1'`).get().n, 0);
  assert.equal(db.prepare(`SELECT id FROM protected_versions WHERE authorized = 1 AND effective_from IS NOT NULL AND superseded_by IS NULL`).get().id, 'pv_1');
  const next = db.prepare(`SELECT * FROM decisions WHERE kind = 'check_correction_tightening' AND status = 'open'`).get();
  assert.equal(next.semantic_generation, decision.semantic_generation + 1);
  assert.equal(JSON.parse(next.dependency_manifest).integration_revision, R);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM approvals WHERE decision = ?').get(next.id).n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE kind = 'blocker' AND status = 'open'`).get().n, 0);
});

test('a ref at the old commit, or at a commit the engine never registered, is not refused here', (t) => {
  const { db, intent, op } = store(t);
  assert.equal(refuse(db, op, H), false, 'at the old commit: the swap can still hold');
  assert.equal(refuse(db, op, X), false, 'somewhere nobody registered: the probe judges it');
  assert.equal(refuse(db, op, null), false, 'gone');
  assert.deepEqual(opState(db, op), { status: 'intended', journal: 'intended' });
  assert.equal(db.prepare('SELECT status FROM effect_intents WHERE id = ?').get(intent).status, 'executing');
});

test('an update that was attempted is not refused here, wherever the ref is', (t) => {
  const { db, op } = store(t);
  db.prepare(`UPDATE ref_registry SET expected_oid = ? WHERE id = 'ref_main'`).run(R);
  db.prepare(
    `INSERT INTO operation_attempts (id, created_at, project, operation, attempt_number, status, started_at, timeline, reconciliation_reads, incarnation)
     VALUES ('att_1', ?, 'prj_1', ?, 1, 'started', ?, '[]', '[]', 'inc_0')`,
  ).run(AT, op, AT);
  assert.equal(refuse(db, op, R), false);
  assert.equal(opState(db, op).journal, 'intended');
});
