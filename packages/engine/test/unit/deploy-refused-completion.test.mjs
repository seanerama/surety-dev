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

function store(t, { superseded = false, bound = false } = {}) {
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
  const frozen = { purpose: 'deploy', work_item: 'wi_d', authorization: 'dauth_1', candidate: 'cand_1', mapping: bound ? 'map_1' : null, artifact_digest: 'sha256:x', artifact_path: null, manifest: null, config_version: null, config_number: null, config_identity: bound ? 'cfg_1' : null, secret_digests: [], target_set: [], environment: 'env_1', environment_name: 'alpha', prefix: 'p', lease: { id: 'lease_1', generation: 1 } };
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

// ---- the driver's rulings 1 and 2 on M401's T1 runs (slice 37) ------------------------------------

const { reverifyResolvedCompletions } = await import(join(dist, 'store', 'transitions', 'queue.js'));
const { policyRequestDue } = await import(join(dist, 'store', 'transitions', 'deploy.js'));

function refusedOn(db, subjects) {
  db.prepare(
    `INSERT INTO gate_evaluations (id, created_at, project, scope, candidate, gate_kind, computed_at, inputs_hash, inputs_snapshot, check_states, outcome, reasons, satisfiers, stale)
     VALUES ('gate_1', ?, 'prj_1', 'scope_1', 'cand_1', 'alpha_complete', ?, 'h', '{}', '{}', 'not_satisfied', ?, '[]', 0)`,
  ).run(AT, AT, JSON.stringify([{ code: 'ACCEPTANCE_SCOPE_INCOMPLETE', subjects }]));
  transact(db, ENGINE_ACTOR, (tx) => afterCompletion(tx, { operation: 'op_1', candidate: 'cand_1', satisfied: false, evaluation: 'gate_1', reasons: ['ACCEPTANCE_SCOPE_INCOMPLETE'] }));
}
const owe = (db, id, key, resolved = null) =>
  db.prepare(`INSERT INTO check_obligations (id, created_at, project, "check", key, criteria, generation, reason, resolved_at) VALUES (?, ?, 'prj_1', 'chk', ?, '["R2.1"]', 2, 'spec_changed', ?)`).run(id, AT, key, resolved);

test('2: a completion refused only on spec_changed obligations is verified again once they resolve, its blocker invalidated', (t) => {
  const db = store(t, { bound: true });
  db.prepare(
    `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots, authorized_revision) VALUES ('pv_1', ?, 'prj_1', 1, 'f', 'initial', 'h', 'human', ?, 1, ?, '[]', 'r')`,
  ).run(AT, AT, AT);
  owe(db, 'o1', 'accept-r2');
  refusedOn(db, ['obligation:accept-r2']);
  const d = openBlocker(db);
  assert.ok(d, "the owner's blocker while the obligation is open");
  assert.deepEqual(transact(db, ENGINE_ACTOR, (tx) => reverifyResolvedCompletions(tx, { project: 'prj_1' })), [], 'nothing while it is open');
  db.prepare(`UPDATE check_obligations SET resolved_at = ? WHERE id = 'o1'`).run(AT);
  assert.deepEqual(transact(db, ENGINE_ACTOR, (tx) => reverifyResolvedCompletions(tx, { project: 'prj_1' })), ['op_1'], 'resolved: verified again');
  assert.equal(item(db).status, 'executing', 'the work goes on with the new round');
  assert.equal(db.prepare(`SELECT status FROM decisions WHERE id = ?`).get(d.id).status, 'invalidated', 'its blocker is invalidated');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM verification_rounds WHERE operation = 'op_1'`).get().n, 1, 'one new round');
});

test('2: a completion refused on anything else as well keeps the owner\'s blocker', (t) => {
  const db = store(t);
  owe(db, 'o1', 'accept-r2', AT);
  refusedOn(db, ['obligation:accept-r2', 'R9.1']);
  assert.deepEqual(transact(db, ENGINE_ACTOR, (tx) => reverifyResolvedCompletions(tx, { project: 'prj_1' })), []);
  assert.equal(item(db).status, 'awaiting_decision');
  assert.ok(openBlocker(db), 'the blocker stands');
});

test('1: the alpha_deploy policy requests nothing while a specification change of the project is proposed', (t) => {
  const db = store(t);
  db.prepare(`INSERT INTO policy_revisions (id, created_at, project, revision, git_path, git_blob, changed_by, changed_at, diff_summary, widens_authority, committed, effective) VALUES ('pol_1', ?, 'prj_1', 1, 'p', 'b', 'h', ?, '', 0, 1, ?)`).run(
    AT,
    AT,
    JSON.stringify({ alpha_deploy: 'on_phase_complete' }),
  );
  db.prepare(`UPDATE projects SET policy_revision = 'pol_1'`).run();
  const reads = [];
  const spy = { prepare: (sql) => (reads.push(sql), db.prepare(sql)) };
  policyRequestDue(spy, { project: 'prj_1' });
  assert.ok(reads.some((s) => s.includes('"phase_plans"')), 'with no change proposed, the completed phase is read');
  db.prepare(`INSERT INTO spec_change_requests (id, created_at, project, seq, request_text, source, status) VALUES ('scr_1', ?, 'prj_1', 1, 'c', 'owner', 'proposed')`).run(AT);
  reads.length = 0;
  assert.equal(policyRequestDue(spy, { project: 'prj_1' }), null);
  assert.ok(!reads.some((s) => s.includes('"phase_plans"')), 'held before anything of the phase is read');
});
