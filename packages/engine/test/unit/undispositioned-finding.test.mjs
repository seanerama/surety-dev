// Developer test for the driver's ruling on the real M443 run's second
// silent stall: a finding a Reviewer raised (or left) with no disposition
// held the stage gates, and nothing asked anyone. The owner is now asked
// (finding_disposition, scope disposition_owed): in the Reviewer's report
// transaction, and by the tick's sweep for one that exists already. A
// Verifier's finding is not asked while a review may still come. The
// Reviewer's package states the dispositions and this route. Against a
// scratch store, foreign keys off, the rows the minimum each read needs.

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
const { askUndispositioned } = await import(join(dist, 'store', 'transitions', 'findings.js'));
const { answerQueued } = await import(join(dist, 'store', 'transitions', 'queue.js'));
const { resultSchema } = await import(join(dist, 'invoke', 'sandbox', 'context.js'));
const { DISPOSITIONS } = await import(join(dist, 'runs', 'report.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });
const AT = '2026-10-15T00:00:00.000Z';
const LATER = '2026-10-15T00:10:00.000Z';

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  run(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T2', '/repo', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
  );
  run(`INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots, authorized_revision) VALUES ('pv_1', ?, 'prj_1', 1, 'f', 'initial', 'h', 'human', ?, 1, ?, '[]', 'r')`, AT, AT, AT);
  run(`INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress) VALUES ('cand_1', ?, 'prj_1', 1, ?, 'l', ?, 'engine_cadence', 'developing')`, AT, 'a'.repeat(40), AT);
  let seq = 0;
  const runOf = (id, role, state, finished) =>
    run(
      `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined, outcome, finished_at)
       VALUES (?, ?, 'prj_1', ?, 'wi_' || ?, ?, 'one_shot', ?, 'scripted', '1', 'm', ?, ?, 0, ?, ?)`,
      id,
      AT,
      ++seq,
      id,
      role,
      state,
      'a'.repeat(40),
      AT,
      state === 'ended' ? 'completed' : null,
      finished,
    );
  const finding = (id, role, sourceRun, category = 'requirement_conflict', at = AT) =>
    run(
      `INSERT INTO findings (id, created_at, project, seq, scope, subject_id, candidate, source_run, source_role, category, message, "check", proposed_severity, effective_severity, severity_history, sensitive_area, status, reevaluations, criterion)
       VALUES (?, ?, 'prj_1', ?, 'candidate', 'cand_1', 'cand_1', ?, ?, ?, 'validate() coerces numeric strings; R8.4 requires 400', NULL, 'medium', 'medium', '[]', NULL, 'open', '[]', 'R8.4')`,
      id,
      at,
      ++seq,
      sourceRun,
      role,
      category,
    );
  const reviewItem = (runId, source) =>
    run(
      `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
       VALUES (?, ?, 'prj_1', ?, 'review', '{"candidate":"cand_1"}', 'complete', ?, 'cand_1', ?, 0, 0, 0, 0)`,
      `wi_${runId}`,
      AT,
      ++seq,
      source,
      seq,
    );
  return { db, run, runOf, finding, reviewItem };
}

const owed = (db, id) => db.prepare(`SELECT * FROM decisions WHERE kind = 'finding_disposition' AND subject_id = ? AND scope = 'disposition_owed'`).all(id);

test("a Reviewer's undispositioned finding is put to the owner in its report's transaction: change_spec (a requirement_conflict) or accept (Medium: accept releases the gates; no fix, since it names no check); change_spec requests the change and accepts the finding", (t) => {
  const s = store(t);
  s.runOf('run_r', 'reviewer', 'validating', null);
  s.finding('fnd_1', 'reviewer', 'run_r');
  assert.equal(transact(s.db, ENGINE_ACTOR, (tx) => askUndispositioned(tx, { project: 'prj_1', reviewing: true })), 1);
  const [d] = owed(s.db, 'fnd_1');
  assert.equal(d?.status, 'open', 'one open question');
  assert.deepEqual(JSON.parse(d.options).map((o) => o.key), ['change_spec', 'accept']);
  assert.equal(transact(s.db, ENGINE_ACTOR, (tx) => askUndispositioned(tx, { project: 'prj_1' })), 0, 'asked once: the sweep raises no second question');
  transact(s.db, ENGINE_ACTOR, (tx) => answerQueued(tx, { project: 'prj_1', decision: d.id, option: 'change_spec', preview_hash: d.preview_hash, note: null }));
  const f = s.db.prepare(`SELECT status, disposition, disposition_authority FROM findings WHERE id = 'fnd_1'`).get();
  assert.deepEqual([f.status, f.disposition, f.disposition_authority], ['dispositioned', 'accept', 'human']);
  assert.equal(s.db.prepare(`SELECT COUNT(*) AS n FROM work_items WHERE kind = 'spec_change'`).get().n, 1, 'the specification change asked for (no approved spec here: its spec_change item is recorded)');
});

test("the sweep: a Verifier's finding is not asked while the engine's review may come (another review run counts for nothing); once that review has reported after it and left it with none, it is; naming no check, it is offered no fix", (t) => {
  const s = store(t);
  s.runOf('run_v', 'verifier', 'ended', AT);
  s.finding('fnd_2', 'verifier', 'run_v', 'defect');
  assert.equal(transact(s.db, ENGINE_ACTOR, (tx) => askUndispositioned(tx, { project: 'prj_1' })), 0, 'no review reported since: not yet');
  s.runOf('run_x', 'reviewer', 'ended', LATER);
  s.reviewItem('run_x', 'test');
  assert.equal(transact(s.db, ENGINE_ACTOR, (tx) => askUndispositioned(tx, { project: 'prj_1' })), 0, 'a review that is not the engine-queued one: not yet');
  s.runOf('run_r2', 'reviewer', 'ended', LATER);
  s.reviewItem('run_r2', 'verification');
  assert.equal(transact(s.db, ENGINE_ACTOR, (tx) => askUndispositioned(tx, { project: 'prj_1' })), 1);
  const [d] = owed(s.db, 'fnd_2');
  assert.deepEqual(JSON.parse(d.options).map((o) => o.key), ['accept'], 'no change_spec for a defect, no fix without a check that can verify it (owed-blocking.test.mjs has fix)');
  transact(s.db, ENGINE_ACTOR, (tx) => answerQueued(tx, { project: 'prj_1', decision: d.id, option: 'accept', preview_hash: d.preview_hash, note: null }));
  assert.equal(s.db.prepare(`SELECT disposition FROM findings WHERE id = 'fnd_2'`).get().disposition, 'accept');
});

test("the Reviewer's result schema states the dispositions from the parser's own list and the owner's route for a finding left with none", () => {
  const schema = resultSchema('reviewer');
  const d = schema.properties.dispositions;
  assert.deepEqual(d.items.properties.disposition.enum, [...DISPOSITIONS]);
  assert.match(d.description, /put to the human owner/);
  assert.match(d.description, /requirement_conflict or contract_conflict/);
});
