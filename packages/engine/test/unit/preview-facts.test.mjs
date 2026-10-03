// Developer tests for the preview facts of the four decision kinds that do
// not change code (Review B12, B18; build spec §6 correction 22; brief B1): a
// blocker binds the evidence its blocked item rests on and the continuation a
// retry resumes; a finding's disposition and severity questions bind its
// scope and evidence besides its status; an exclusion binds the finding's
// status, scope and evidence, and the assessed candidate's ancestry. A
// change to any of them, with the question still standing, makes the
// earlier preview stale: the answer is refused and the next tick raises the
// next generation. Against a scratch store with the engine's migrations.

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

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });

const AT = '2026-10-02T00:00:00.000Z';
const R1 = 'a'.repeat(40);
const R2 = 'b'.repeat(40);

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, join(root, 'migrations'));
  // Fixture rows only: the references they make are not the point here.
  db.pragma('foreign_keys = OFF');
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  run(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
  );
  const record = (id, kind) =>
    run(`INSERT INTO records (id, created_at, project, kind, path, sha256, bytes, redaction_version, published, post_scan) VALUES (?, ?, 'prj_1', ?, ?, 'h', 1, 'r1', 1, 'clean')`, id, AT, kind, id);
  record('rec_result', 'result');
  record('rec_transcript', 'transcript');
  record('rec_report', 'result');
  record('rec_evidence', 'assessment_evidence');
  // Work parked at its repair limit after one failed run.
  run(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, blocker, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count,
       preflight_refusals, dispatch_hold)
     VALUES ('wi_1', ?, 'prj_1', 1, 'review', '{}', 'parked', ?, 'test', 'a', 1, 0, 0, 0, 0)`,
    AT,
    JSON.stringify({ reason: 'repair_attempts_max', raised_at: AT, decision: null }),
  );
  const runRow = (id, seq, item, result, transcript) =>
    run(
      `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, outcome, reason_class, backend, backend_version, model_requested, base_revision, deadline_at,
         quarantined, result, transcript)
       VALUES (?, ?, 'prj_1', ?, ?, 'reviewer', 'one_shot', 'ended', 'failed', 'infra_error', 'scripted', '1', 'm', ?, ?, 0, ?, ?)`,
      id,
      AT,
      seq,
      item,
      R1,
      AT,
      result,
      transcript,
    );
  runRow('run_1', 1, 'wi_1', 'rec_result', 'rec_transcript');
  runRow('run_rev', 2, 'wi_x', 'rec_report', null);
  // Two candidates, the second on a lineage started from the first.
  run(`INSERT INTO lineages (id, created_at, project, branch, started_from_candidate, open) VALUES ('lin_1', ?, 'prj_1', 'main', NULL, 0)`, AT);
  run(`INSERT INTO lineages (id, created_at, project, branch, started_from_candidate, open) VALUES ('lin_2', ?, 'prj_1', 'main', 'cand_1', 0)`, AT);
  run(`INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress) VALUES ('cand_1', ?, 'prj_1', 1, ?, 'lin_1', ?, 'engine_cadence', 'developing')`, AT, R1, AT);
  run(`INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress) VALUES ('cand_2', ?, 'prj_1', 2, ?, 'lin_2', ?, 'engine_cadence', 'developing')`, AT, R2, AT);
  // A Critical finding raised by the Reviewer against candidate 1, with a
  // lowering and a deferral proposed beyond its authority.
  run(
    `INSERT INTO findings (id, created_at, project, seq, scope, subject_id, candidate, source_run, source_role, category, message, proposed_severity, effective_severity, status,
       proposed_disposition, proposed_severity_change)
     VALUES ('fnd_1', ?, 'prj_1', 1, 'lineage', 'cand_1', 'cand_1', 'run_rev', 'reviewer', 'defect', 'broken', 'critical', 'critical', 'open', ?, ?)`,
    AT,
    JSON.stringify({ disposition: 'accept', run: 'run_rev' }),
    JSON.stringify({ to: 'low', run: 'run_rev' }),
  );
  // An assessed exclusion of the finding from candidate 2.
  run(
    `INSERT INTO applicability_assessments (id, created_at, project, finding, candidate, proposed_by_run, assessed_by_run, evidence, reason, status)
     VALUES ('appl_1', ?, 'prj_1', 'fnd_1', 'cand_2', 'run_v', 'run_rev', 'rec_evidence', 'not reachable', 'assessed')`,
    AT,
  );
  return db;
}

const raise = (db, kind, subjectType, subjectId) => transact(db, ENGINE_ACTOR, (tx) => raiseQuestion(tx, { project: 'prj_1', kind, subjectType, subjectId }));
const answer = (db, d, option) => transact(db, ENGINE_ACTOR, (tx) => answerQueued(tx, { project: 'prj_1', decision: d.id, option, preview_hash: d.preview_hash, note: null }));
const review = (db) => transact(db, ENGINE_ACTOR, (tx) => reviewDecisions(tx, { project: 'prj_1', channel: 'none' }));
const decisionsOf = (db, kind, subject) => db.prepare(`SELECT * FROM decisions WHERE kind = ? AND subject_id = ? ORDER BY seq`).all(kind, subject);

// The question stands; one of its facts changes: the earlier preview is
// refused, and the tick raises the next generation, whose manifest differs
// in the named key.
function assertStale(db, d, option, key) {
  assert.throws(() => answer(db, d, option), (err) => err.status === 409 && err.code === 'decision_stale', 'the answer that carries the earlier preview is refused');
  review(db);
  const rows = decisionsOf(db, d.kind, d.subject_id);
  assert.deepEqual(rows.map((r) => [r.semantic_generation, r.status]), [[1, 'invalidated'], [2, 'open']]);
  assert.notDeepEqual(JSON.parse(rows[1].dependency_manifest)[key], JSON.parse(d.dependency_manifest)[key], `the manifests differ in "${key}"`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 0);
}

test('a blocker binds the evidence its parked item rests on: a record of the run that parked it quarantined since is a changed preview', (t) => {
  const db = store(t);
  const d = raise(db, 'blocker', 'work_item', 'wi_1');
  assert.deepEqual(JSON.parse(d.dependency_manifest).evidence, {
    run: 'run_1',
    result: { record: 'rec_result', quarantined: false, missing: false },
    transcript: { record: 'rec_transcript', quarantined: false, missing: false },
  });
  db.prepare(`UPDATE records SET post_scan = 'hit' WHERE id = 'rec_transcript'`).run();
  assertStale(db, d, 'retry', 'evidence');
  assert.equal(db.prepare(`SELECT status FROM work_items WHERE id = 'wi_1'`).get().status, 'parked', 'nothing was resumed');
});

test('a blocker binds the continuation a retry resumes: a changed stored checkpoint is a changed preview', (t) => {
  const db = store(t);
  const d = raise(db, 'blocker', 'work_item', 'wi_1');
  assert.deepEqual(JSON.parse(d.dependency_manifest).continuation, { status: 'eligible', from: null });
  db.prepare(`UPDATE work_items SET continue_from = ? WHERE id = 'wi_1'`).run(R2);
  assertStale(db, d, 'retry', 'continuation');
  assert.deepEqual(JSON.parse(decisionsOf(db, 'blocker', 'wi_1')[1].dependency_manifest).continuation, { status: 'eligible', from: R2 });
});

test('a finding’s disposition binds its scope: a lineage finding made project-wide, still applicable, is a changed preview', (t) => {
  const db = store(t);
  const d = raise(db, 'finding_disposition', 'finding', 'fnd_1');
  db.prepare(`UPDATE findings SET scope = 'project' WHERE id = 'fnd_1'`).run();
  assertStale(db, d, 'approve', 'scope');
  const [before, after] = decisionsOf(db, d.kind, d.subject_id).map((r) => JSON.parse(r.dependency_manifest));
  assert.deepEqual([before.applicable, after.applicable], [true, true], 'whether it applies has not changed');
});

test('a severity lowering binds the finding’s evidence: the report it was raised in, gone missing, is a changed preview', (t) => {
  const db = store(t);
  const d = raise(db, 'severity_lower', 'finding', 'fnd_1');
  db.prepare(`UPDATE records SET missing_at = ? WHERE id = 'rec_report'`).run(AT);
  assertStale(db, d, 'approve', 'evidence');
  assert.equal(db.prepare(`SELECT effective_severity FROM findings WHERE id = 'fnd_1'`).get().effective_severity, 'critical', 'nothing was lowered');
});

test('a severity lowering binds the finding’s status as before, and its scope', (t) => {
  const db = store(t);
  const d = raise(db, 'severity_lower', 'finding', 'fnd_1');
  db.prepare(`UPDATE findings SET scope = 'candidate' WHERE id = 'fnd_1'`).run();
  assertStale(db, d, 'approve', 'scope');
});

test('an exclusion binds the candidate’s ancestry: a lineage started from another candidate is a changed preview', (t) => {
  const db = store(t);
  const d = raise(db, 'finding_applicability_exclusion', 'applicability_assessment', 'appl_1');
  assert.deepEqual(JSON.parse(d.dependency_manifest).ancestry, { finding_candidate: 'cand_1', predecessors: ['cand_1'] });
  db.prepare(`INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress) VALUES ('cand_0', ?, 'prj_1', 3, ?, 'lin_1', ?, 'engine_cadence', 'developing')`).run(
    AT,
    R1,
    AT,
  );
  db.prepare(`UPDATE lineages SET started_from_candidate = 'cand_0' WHERE id = 'lin_1'`).run();
  assertStale(db, d, 'approve', 'ancestry');
  assert.equal(db.prepare(`SELECT status FROM applicability_assessments WHERE id = 'appl_1'`).get().status, 'assessed', 'nothing was approved');
});

test('an exclusion binds the finding’s status, scope and evidence', (t) => {
  for (const [change, key] of [
    [`UPDATE findings SET status = 'dispositioned', disposition = 'fix' WHERE id = 'fnd_1'`, 'finding_status'],
    [`UPDATE findings SET scope = 'project' WHERE id = 'fnd_1'`, 'scope'],
    [`UPDATE records SET post_scan = 'hit' WHERE id = 'rec_report'`, 'finding_evidence'],
  ]) {
    const db = store(t);
    const d = raise(db, 'finding_applicability_exclusion', 'applicability_assessment', 'appl_1');
    db.prepare(change).run();
    assertStale(db, d, 'approve', key);
  }
});

test('nothing changed: the preview is answered as before', (t) => {
  const db = store(t);
  const d = raise(db, 'finding_applicability_exclusion', 'applicability_assessment', 'appl_1');
  review(db);
  assert.equal(decisionsOf(db, d.kind, d.subject_id).length, 1, 'a tick raises nothing new');
  answer(db, d, 'approve');
  assert.equal(db.prepare(`SELECT status FROM applicability_assessments WHERE id = 'appl_1'`).get().status, 'approved');
});
