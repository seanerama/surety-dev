// Developer tests for the outcome of a policy submission (the usability
// batch of 2026-10-27, decision 6): the answer says `accepted` (a revision
// intended through the journal, its commit pending) or `unchanged` (nothing
// to commit); a submission with an intent_id is answered once, so a repeat
// with the same body is that answer and never a second revision, and a
// different body is policy_intent_conflict; the policy read carries the
// commit state of what was submitted, so a lost answer is settled by
// reading. Against a scratch store: the journal's own progress is the
// acceptance rows' and the validation's (a real repository).

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
const { transact } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { submitPolicy, policyCommitState } = await import(join(dist, 'store', 'transitions', 'project.js'));
const { projectPolicyView } = await import(join(dist, 'store', 'reads.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_unit' });

const AT = '2026-10-27T10:00:00.000Z';
const HEAD = 'a'.repeat(40);
const OWNER = { actor_kind: 'human', actor_id: null, request_id: 'req_1' };

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-pso-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, join(root, 'migrations'));
  db.prepare(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T2', '/repo', 'main', 'spec_ready', 'registered', '{}')`,
  ).run(AT);
  db.prepare(`INSERT INTO ref_registry (id, created_at, project, ref, kind, expected_oid, immutable) VALUES ('ref_1', ?, 'prj_1', 'refs/heads/main', 'integration', ?, 0)`).run(AT, HEAD);
  return db;
}
const prepared = (revision, n) => ({
  head: HEAD,
  revision,
  commit: { sha: String(n).repeat(40).slice(0, 40), tree: 'c'.repeat(40), content: 'tree x' },
  blob: 'd'.repeat(40),
  effective: { repair_attempts_max: n },
  change: { repair_attempts_max: n },
  deadlineSeconds: 60,
});
const submit = (db, args) => transact(db, OWNER, (tx) => submitPolicy(tx, { project: 'prj_1', body: {}, ordinary: {}, widens: [], governed: null, prepared: null, intent_id: null, fingerprint: 'f0', ...args }));
const count = (db, sql) => db.prepare(sql).get().n;

test('accepted: the revision intended, its commit pending; the read says pending', (t) => {
  const db = store(t);
  const r = submit(db, { prepared: prepared(1, 1), fingerprint: 'f1' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { outcome: 'accepted', revision: 1, committed: false, commit: { state: 'pending' } });
  const v = projectPolicyView(db, 'prj_1');
  assert.deepEqual([v.revision, v.committed_at], [null, null], 'nothing recorded until the journal commits it');
  assert.deepEqual(v.pending.map((p) => [p.revision, p.intent_id, p.state]), [[1, null, 'pending']]);
  assert.deepEqual(v.submissions.map((s) => [s.outcome, s.revision, s.committed, s.commit.state]), [['accepted', 1, false, 'pending']]);
});

test('unchanged: nothing to commit, said so; without an intent nothing is recorded', (t) => {
  const db = store(t);
  const r = submit(db, {});
  assert.deepEqual([r.status, r.body], [200, { outcome: 'unchanged', revision: null, committed: false, commit: null }]);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM policy_submissions'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM operations'), 0);
});

test('an intent is answered once: the repeat is the answer (no second revision); another body is policy_intent_conflict', (t) => {
  const db = store(t);
  const first = submit(db, { prepared: prepared(1, 1), intent_id: 'pi_1', fingerprint: 'f1' });
  assert.deepEqual(first.body, { outcome: 'accepted', revision: 1, committed: false, commit: { state: 'pending' } });
  const ops = count(db, 'SELECT COUNT(*) AS n FROM operations');
  // The repeat arrives as the route prepares it: nothing prepared.
  const again = submit(db, { intent_id: 'pi_1', fingerprint: 'f1', repeat: true });
  assert.deepEqual([again.status, again.body], [first.status, first.body]);
  // Even one prepared again (a race the project lock prevents) intends nothing.
  const raced = submit(db, { prepared: prepared(1, 2), intent_id: 'pi_1', fingerprint: 'f1' });
  assert.deepEqual(raced.body, first.body);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM operations'), ops, 'no second commit intended');
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM policy_submissions WHERE intent_id = 'pi_1'"), 1);
  assert.throws(() => submit(db, { prepared: prepared(1, 3), intent_id: 'pi_1', fingerprint: 'f2' }), (e) => e.status === 409 && e.code === 'policy_intent_conflict');
  // An unchanged submission with an intent is answered once too.
  const none = submit(db, { intent_id: 'pi_2', fingerprint: 'f9' });
  assert.deepEqual(submit(db, { intent_id: 'pi_2', fingerprint: 'f9', repeat: true }).body, none.body);
  assert.deepEqual(projectPolicyView(db, 'prj_1').submissions.map((s) => [s.intent_id, s.outcome]), [['pi_2', 'unchanged'], ['pi_1', 'accepted']]);
});

test("a widening's refusal is answered once: the repeat is the same 409, never a commit after the approval", (t) => {
  const db = store(t);
  const r = submit(db, { ordinary: { repair_attempts_max: 9 }, widens: ['repair_attempts_max'], intent_id: 'pi_w', fingerprint: 'fw' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'confirm_required');
  const again = submit(db, { intent_id: 'pi_w', fingerprint: 'fw', repeat: true });
  assert.deepEqual([again.status, again.body], [409, r.body]);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM decisions WHERE kind = 'policy_widening'"), 1, 'one decision');
});

test('the commit state follows the journal: committed once the ref update is finalized, failed if the journal fails it', (t) => {
  const db = store(t);
  submit(db, { prepared: prepared(1, 1), intent_id: 'pi_1', fingerprint: 'f1' });
  const row = db.prepare("SELECT operation FROM policy_submissions WHERE intent_id = 'pi_1'").get();
  assert.ok(row.operation, 'the commit operation is kept');
  assert.deepEqual(policyCommitState(db, 'prj_1', row.operation), { state: 'pending', committed_at: null });
  // The journal's ref update of that commit, as its finalizer leaves it.
  const sha = '1'.repeat(40);
  const insertRef = (id, status, finalized) =>
    db
      .prepare(
        `INSERT INTO operations (id, created_at, project, seq, kind, target, subject, idempotency_key, semantic_generation, status, deadline_at, finalized_at, finalizer_inputs)
         VALUES (?, ?, 'prj_1', ?, 'git_ref_update', '{}', '{}', ?, 1, ?, ?, ?, ?)`,
      )
      .run(id, AT, 100 + id.length, `k_${id}`, status, AT, finalized, JSON.stringify({ purpose: 'policy', new_oid: sha, revision: 1 }));
  db.pragma('foreign_keys = OFF');
  insertRef('op_ref', 'in_progress', null);
  assert.equal(policyCommitState(db, 'prj_1', row.operation).state, 'pending');
  db.prepare("UPDATE operations SET status = 'succeeded', finalized_at = ? WHERE id = 'op_ref'").run('2026-10-27T10:00:05.000Z');
  assert.deepEqual(policyCommitState(db, 'prj_1', row.operation), { state: 'committed', committed_at: '2026-10-27T10:00:05.000Z' });
  const again = submit(db, { intent_id: 'pi_1', fingerprint: 'f1', repeat: true });
  assert.deepEqual(again.body, { outcome: 'accepted', revision: 1, committed: true, commit: { state: 'committed', committed_at: '2026-10-27T10:00:05.000Z' } }, 'the repeat: the same outcome and revision, its commit as it is now');
  assert.deepEqual(projectPolicyView(db, 'prj_1').pending, []);
  db.prepare("UPDATE operations SET status = 'failed' WHERE id = 'op_ref'").run();
  assert.equal(policyCommitState(db, 'prj_1', row.operation).state, 'failed');
});
