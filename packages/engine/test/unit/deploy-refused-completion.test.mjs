// Developer test for a deploy whose completion was refused (D4 §4.7; the
// driver's ruling 2 on M401, slice 37). The deploy work item waits on a blocker
// that names its decision, never on one with none. The decision offers
// re-verification only when it can succeed: a finalized deploy whose latest
// attempt succeeded on the environment's current generation, for a candidate
// not superseded (D4 §5.5 refuses alpha_complete for a superseded one). It
// also offers the preempting teardown and abandonment of the completion;
// abandoning cancels the work, naming why. Against a scratch store; foreign
// keys off, the rows the minimum the transitions read.

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
const { afterCompletion } = await import(join(dist, 'store', 'transitions', 'deploy.js'));
const { answerQueued } = await import(join(dist, 'store', 'transitions', 'queue.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });

const AT = '2026-10-14T00:00:00.000Z';

function store(t, { superseded = false } = {}) {
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
     VALUES ('prj_1', ?, 'p', 'T1', '/repo', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
  );
  run(`INSERT INTO environments (id, created_at, project, name, adapter, adapter_config_ref, verify_spec, prefix, current_generation, deployment_generation) VALUES ('env_1', ?, 'prj_1', 'alpha', 'local_service', 'x', '{}', 'p', 1, 1)`, AT);
  run(`INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress, superseded_by) VALUES ('cand_1', ?, 'prj_1', 1, ?, 'l', ?, 'engine_cadence', 'developing', ?)`, AT, 'a'.repeat(40), AT, superseded ? 'cand_2' : null);
  run(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
     VALUES ('wi_d', ?, 'prj_1', 1, 'deploy', '{"candidate":"cand_1","environment":"env_1"}', 'executing', 'test', 'wi_d', 1, 0, 0, 0, 0)`,
    AT,
  );
  const frozen = { purpose: 'deploy', work_item: 'wi_d', authorization: 'dauth_1', candidate: 'cand_1', mapping: null, artifact_digest: 'sha256:x', artifact_path: null, manifest: null, config_version: null, config_number: null, config_identity: null, secret_digests: [], target_set: [], environment: 'env_1', environment_name: 'alpha', prefix: 'p', lease: { id: 'lease_1', generation: 1 } };
  run(
    `INSERT INTO operations (id, created_at, project, seq, kind, target, subject, idempotency_key, semantic_generation, status, deadline_at, finalizer_inputs, orchestration_stage)
     VALUES ('op_1', ?, 'prj_1', 1, 'deploy', '{"environment":"env_1"}', '{"candidate":"cand_1"}', 'k', 1, 'succeeded', ?, ?, 'completion')`,
    AT,
    AT,
    JSON.stringify(frozen),
  );
  run(`INSERT INTO operation_attempts (id, created_at, project, operation, attempt_number, status, started_at, deployment_generation, reconciliation_reads) VALUES ('att_1', ?, 'prj_1', 'op_1', 1, 'succeeded', ?, 1, '[]')`, AT, AT);
  run(`INSERT INTO deploy_journal_state (id, created_at, project, operation, journal_kind, state, last_event_seq) VALUES ('djs_1', ?, 'prj_1', 'op_1', 'deploy_apply', 'finalized', 3)`, AT);
  return db;
}

const refuse = (db) => transact(db, ENGINE_ACTOR, (tx) => afterCompletion(tx, { operation: 'op_1', candidate: 'cand_1', satisfied: false, evaluation: 'gate_1', reasons: ['CHECK_NOT_PASSED'] }));
const item = (db) => db.prepare(`SELECT * FROM work_items WHERE id = 'wi_d'`).get();
const openBlocker = (db) => db.prepare(`SELECT * FROM decisions WHERE kind = 'blocker' AND subject_id = 'wi_d' AND status = 'open'`).get();

test('a refused completion waits on a decision that names it: verify again, tear down, or abandon; abandoning cancels the work with its reason', (t) => {
  const db = store(t);
  refuse(db);
  const w = item(db);
  assert.equal(w.status, 'awaiting_decision');
  const d = openBlocker(db);
  assert.ok(d, 'a blocker decision is raised');
  assert.equal(JSON.parse(w.blocker).decision, d.id, 'the work item\'s blocker names its decision, never null');
  assert.deepEqual(JSON.parse(d.options).map((o) => o.key), ['reverify', 'teardown', 'abandon']);
  transact(db, ENGINE_ACTOR, (tx) => answerQueued(tx, { project: 'prj_1', decision: d.id, option: 'abandon', preview_hash: d.preview_hash, note: null }));
  assert.equal(item(db).status, 'cancelled', 'abandoned, the work ends terminal');
  const ev = db.prepare(`SELECT payload FROM events WHERE type = 'work.cancelled' AND json_extract(subject, '$.work_item') = 'wi_d'`).get();
  assert.equal(JSON.parse(ev.payload).cause, 'abandon_completion');
});

test('re-verification is not offered for a superseded candidate: its completion would be refused again', (t) => {
  const db = store(t, { superseded: true });
  refuse(db);
  const d = openBlocker(db);
  assert.ok(d, 'a blocker decision is raised');
  assert.deepEqual(JSON.parse(d.options).map((o) => o.key), ['teardown', 'abandon']);
});
