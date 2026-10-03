// Developer tests for the preview of a protected-check correction (D1 §§9.7,
// 10.5, A.8; Review B12; rows M53 to M55; M2 slice 1, entries A3 and A4): the
// answer is refused as out of date when the approved spec or the proposal's
// content changed since the preview, and "reject" closes the question and
// leaves the proposal rejected, with nothing approved or intended and no
// question raised again. Against a scratch store with the engine's migrations.

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
const { raiseQuestion, answerQueued, reviewDecisions } = await import(join(dist, 'store', 'transitions', 'queue.js'));
const { ensureRequirements } = await import(join(dist, 'store', 'transitions', 'baseline.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });

const AT = '2026-10-02T00:00:00.000Z';
const A = 'a'.repeat(40);
const KIND = { tightening: 'check_correction_tightening', loosening: 'check_correction_loosening', unclassifiable: 'check_correction_unclassifiable' };

function store(t, classified) {
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
  run(`INSERT INTO ref_registry (id, created_at, project, ref, kind, expected_oid, immutable) VALUES ('ref_main', ?, 'prj_1', 'refs/heads/main', 'integration', ?, 0)`, AT, A);
  run(
    `INSERT INTO protected_proposals (id, created_at, project, seq, proposed_by, base_revision, tree_id, diff_hash, requested_change_kind, classified_change_kind, status)
     VALUES ('prop_1', ?, 'prj_1', 1, 'human', ?, ?, ?, ?, ?, ?)`,
    AT,
    A,
    'd'.repeat(40),
    'e'.repeat(64),
    classified,
    classified,
    classified === 'tightening' ? 'classified' : 'awaiting_human',
  );
  transact(db, ENGINE_ACTOR, (tx) => ensureRequirements(tx, { project: 'prj_1', keys: ['R1'] }));
  const decision = transact(db, ENGINE_ACTOR, (tx) => raiseQuestion(tx, { project: 'prj_1', kind: KIND[classified], subjectType: 'protected_proposal', subjectId: 'prop_1' }));
  return { db, decision };
}

const answer = (db, d, option) => transact(db, ENGINE_ACTOR, (tx) => answerQueued(tx, { project: 'prj_1', decision: d.id, option, preview_hash: d.preview_hash, note: null }));
const proposal = (db) => db.prepare(`SELECT status, approver, approver_authority, resulting_version FROM protected_proposals WHERE id = 'prop_1'`).get();
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const refusalCode = (fn) => {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return 'accepted';
};

for (const classified of ['tightening', 'loosening', 'unclassifiable']) {
  test(`${KIND[classified]}: a requirement added to the approved spec after the preview makes the answer stale`, (t) => {
    const { db, decision } = store(t, classified);
    transact(db, ENGINE_ACTOR, (tx) => ensureRequirements(tx, { project: 'prj_1', keys: ['R2'] }));
    assert.equal(refusalCode(() => answer(db, decision, 'approve')), 'decision_stale');
    assert.equal(proposal(db).status, classified === 'tightening' ? 'classified' : 'awaiting_human');
    assert.equal(count(db, 'approvals'), 0);
    assert.equal(count(db, 'effect_intents'), 0);
  });

  test(`${KIND[classified]}: the proposal's content changed after the preview makes the answer stale`, (t) => {
    const { db, decision } = store(t, classified);
    db.prepare(`UPDATE protected_proposals SET tree_id = ? WHERE id = 'prop_1'`).run('9'.repeat(40));
    assert.equal(refusalCode(() => answer(db, decision, 'approve')), 'decision_stale');
    assert.equal(count(db, 'approvals'), 0);
  });

  test(`${KIND[classified]}: reject closes the question with the answer recorded, leaves the proposal rejected and applies nothing`, (t) => {
    const { db, decision } = store(t, classified);
    answer(db, decision, 'reject');
    const d = db.prepare('SELECT status, answer FROM decisions WHERE id = ?').get(decision.id);
    assert.equal(d.status, 'consumed');
    assert.equal(JSON.parse(d.answer).option, 'reject');
    assert.deepEqual(proposal(db), { status: 'rejected', approver: null, approver_authority: null, resulting_version: null });
    assert.equal(count(db, 'approvals'), 0);
    assert.equal(count(db, 'effect_intents'), 0);
    assert.equal(count(db, 'protected_versions'), 1);
    transact(db, ENGINE_ACTOR, (tx) => reviewDecisions(tx, { project: 'prj_1', channel: 'in_app' }));
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE status = 'open'`).get().n, 0, 'the question is not raised again');
  });
}
