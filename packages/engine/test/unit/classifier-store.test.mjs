// Developer tests for the classifier's store side (D3 §3.2, §3.3; Q5; K8;
// SEAM.md §§69, 218): a Reviewer's approval under `authoritative` of a
// tightening that changes the required set with no validation-scope
// approval is a recommendation (the review's S2); revalidation with nothing
// read again neither holds nor invalidates (M1); an application whose
// rebased protected set differs from the proposal's withdraws the approval
// (M3). Against a scratch store.

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
const { reviewerApprove, revalidateApplication, applicationDiverged } = await import(join(dist, 'store', 'transitions', 'classification.js'));

const AT = '2026-10-08T00:00:00.000Z';
const H = 'a'.repeat(40);
const AUTHORITATIVE = { mode: 'authoritative', version: 1 };

function store(t, { changesRequiredSet = 0, authority = AUTHORITATIVE } = {}) {
  setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, classifier_authority: authority });
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
    `INSERT INTO protected_proposals (id, created_at, project, seq, proposed_by, base_revision, tree_id, diff_hash, requested_change_kind, classified_change_kind, status, changes_required_set)
     VALUES ('prop_1', ?, 'prj_1', 1, 'human', ?, ?, ?, 'tightening', 'tightening', 'classified', ?)`,
    AT,
    H,
    'd'.repeat(40),
    '9'.repeat(64),
    changesRequiredSet,
  );
  return db;
}

const proposal = (db) => db.prepare(`SELECT status, approver, approver_authority, approval_binding, recommendations FROM protected_proposals WHERE id = 'prop_1'`).get();
const approve = (db, run) => transact(db, ENGINE_ACTOR, (tx) => reviewerApprove(tx, { proposal: 'prop_1', run }));

test('authoritative: a tightening that leaves the required set applies by the Reviewer, its binding kept', (t) => {
  const db = store(t);
  assert.equal(approve(db, 'run_r1'), true);
  const p = proposal(db);
  assert.deepEqual([p.status, p.approver, p.approver_authority], ['approved', 'run_r1', 'reviewer']);
  assert.ok(JSON.parse(p.approval_binding).scope_approval === null);
});

test('authoritative, the required set changed and no validation-scope approval: a recommendation, provenance claimed, nothing approved (S2)', (t) => {
  const db = store(t, { changesRequiredSet: 1 });
  assert.equal(approve(db, 'run_r1'), true);
  const p = proposal(db);
  assert.deepEqual([p.status, p.approver, p.approval_binding], ['classified', null, null]);
  const recs = JSON.parse(p.recommendations);
  assert.equal(recs.length, 1);
  assert.deepEqual([recs[0].run, recs[0].provenance], ['run_r1', 'claimed']);
});

test('authoritative, the required set changed with the validation-scope approval recorded: the Reviewer applies', (t) => {
  const db = store(t, { changesRequiredSet: 1 });
  db.prepare(`INSERT INTO scope_approvals (id, created_at, project, kind, proposal) VALUES ('sa_1', ?, 'prj_1', 'validation_scope', 'prop_1')`).run(AT);
  assert.equal(approve(db, 'run_r1'), true);
  const p = proposal(db);
  assert.deepEqual([p.status, p.approver_authority], ['approved', 'reviewer']);
  assert.equal(JSON.parse(p.approval_binding).scope_approval, 'sa_1');
});

test('recommend: a recommendation, provenance claimed', (t) => {
  const db = store(t, { authority: { mode: 'recommend' } });
  approve(db, 'run_r1');
  assert.equal(proposal(db).status, 'classified');
  assert.equal(JSON.parse(proposal(db).recommendations)[0].provenance, 'claimed');
});

// The human's approval, consumed: the intent recorded, pending.
function humanApproved(db) {
  const d = transact(db, ENGINE_ACTOR, (tx) => raiseQuestion(tx, { project: 'prj_1', kind: 'check_correction_tightening', subjectType: 'protected_proposal', subjectId: 'prop_1' }));
  transact(db, ENGINE_ACTOR, (tx) => answerQueued(tx, { project: 'prj_1', decision: d.id, option: 'approve', preview_hash: d.preview_hash, note: null }));
  return { decision: d, intent: db.prepare('SELECT id FROM effect_intents').get().id };
}

test('revalidation with nothing read again neither holds nor invalidates (M1)', (t) => {
  const db = store(t);
  const { intent } = humanApproved(db);
  for (const inputs of [null, undefined]) {
    const ok = transact(db, ENGINE_ACTOR, (tx) => revalidateApplication(tx, { proposal: 'prop_1', intent, head: H, inputs, inputsVersion: 'pv_1' }));
    assert.equal(ok, false, 'not begun');
  }
  assert.equal(db.prepare('SELECT status FROM effect_intents WHERE id = ?').get(intent).status, 'pending', 'and nothing invalidated');
  assert.equal(proposal(db).status, 'approved');

  approve(db, 'run_r1'); // not classified: no effect
  db.prepare(`UPDATE protected_proposals SET status = 'classified', approver = NULL, approver_authority = NULL WHERE id = 'prop_1'`).run();
  approve(db, 'run_r2');
  const ok = transact(db, ENGINE_ACTOR, (tx) => revalidateApplication(tx, { proposal: 'prop_1', intent: null, inputs: null }));
  assert.equal(ok, false);
  assert.deepEqual([proposal(db).status, proposal(db).approver], ['approved', 'run_r2'], "a Reviewer's approval is not withdrawn on nothing read");
});

test("a rebased protected set that differs from the proposal's withdraws the approval: the human's intent invalidated, the next generation open (M3)", (t) => {
  const db = store(t);
  const { decision, intent } = humanApproved(db);
  assert.equal(transact(db, ENGINE_ACTOR, (tx) => applicationDiverged(tx, { proposal: 'prop_1', intent })), true);
  assert.deepEqual(db.prepare('SELECT status, invalidated_reason FROM effect_intents WHERE id = ?').get(intent), { status: 'invalidated', invalidated_reason: 'EFFECT_PRECONDITION_CHANGED' });
  assert.deepEqual([proposal(db).status, proposal(db).approver], ['classified', null]);
  const next = db.prepare(`SELECT * FROM decisions WHERE kind = 'check_correction_tightening' AND status = 'open'`).get();
  assert.equal(next.semantic_generation, decision.semantic_generation + 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM protected_versions WHERE proposal = 'prop_1'`).get().n, 0, 'nothing applied');
});

test("a Reviewer's application whose rebased set differs: the approval withdrawn and the human's question open (M3)", (t) => {
  const db = store(t);
  approve(db, 'run_r1');
  assert.equal(transact(db, ENGINE_ACTOR, (tx) => applicationDiverged(tx, { proposal: 'prop_1', intent: null })), true);
  assert.deepEqual([proposal(db).status, proposal(db).approver, proposal(db).approval_binding], ['classified', null, null]);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE kind = 'check_correction_tightening' AND status = 'open'`).get().n, 1);
});
