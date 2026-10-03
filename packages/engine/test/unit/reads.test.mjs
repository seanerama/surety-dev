// Developer tests for the work-items read and the gate read (D1 §11.3; E47),
// against a scratch store with the engine's migrations. Each read is the
// projection the store worker runs; neither may write.

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
const { observeTrigger, chainBoundary } = await import(join(dist, 'store', 'transitions', 'work.js'));
const { readWork, readGate } = await import(join(dist, 'store', 'projections.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));

// What the store worker is handed when it opens the store.
setEngineSettings({ lease_ttl: 60, git_deadline: 30, decision_targets: {} });

const AT = '2026-10-02T00:00:00.000Z';

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.pragma('foreign_keys = ON');
  migrate(db, join(root, 'migrations'));
  for (const id of ['prj_1', 'prj_2']) {
    db.prepare(
      `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
       VALUES (?, ?, 'p', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
    ).run(id, AT);
  }
  return db;
}

// What a read must leave as it was: every row count and the event log.
const footprint = (db) => {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
  return tables.map(({ name }) => [name, db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n]);
};

const work = (db, project, trigger, extra = {}) =>
  transact(db, ENGINE_ACTOR, (tx) => observeTrigger(tx, { project, kind: 'stage_build', trigger_source: 'test', trigger_id: trigger, trigger_generation: 1, ...extra }, {})).work_item.id;

test('the work read lists the project’s items with their trigger and chain, and the blocker of one held at its chaining boundary', (t) => {
  const db = store(t);
  const a = work(db, 'prj_1', 'a');
  const b = work(db, 'prj_1', 'b', { chain: 3, subject: { stage: 'stage_x' } });
  work(db, 'prj_2', 'c');
  transact(db, ENGINE_ACTOR, (tx) => chainBoundary(tx, { workItem: b }));
  const decision = db.prepare(`SELECT id FROM decisions WHERE kind = 'blocker' AND subject_id = ?`).get(b).id;

  const before = footprint(db);
  const read = readWork(db, { project: 'prj_1' });
  assert.deepEqual(footprint(db), before, 'the read wrote nothing');

  assert.equal(typeof read.served_at, 'string');
  assert.equal(read.snapshot_seq, db.prepare('SELECT MAX(seq) AS n FROM events').get().n);
  assert.deepEqual(read.work_items.map((w) => w.id), [a, b], 'only this project’s items, oldest first');
  const [first, second] = read.work_items;
  assert.deepEqual(
    [first.kind, first.status, first.subject, first.trigger_source, first.trigger_id, first.trigger_generation, first.chain, first.blocker],
    ['stage_build', 'eligible', {}, 'test', 'a', 1, 0, null],
  );
  assert.deepEqual(second.subject, { stage: 'stage_x' });
  assert.equal(second.chain, 3);
  assert.deepEqual([second.blocker.reason, second.blocker.decision], ['max_chained_roles', decision]);
  assert.deepEqual(second.blocker.options.map((o) => o.key), ['continue', 'cancel'], 'the decision’s options, as stored');
  assert.deepEqual(second.blocker.options, JSON.parse(db.prepare('SELECT options FROM decisions WHERE id = ?').get(decision).options));
});

test('an item no stored blocker names, held by an open decision, shows that decision and its cause', (t) => {
  const db = store(t);
  const a = work(db, 'prj_1', 'a');
  db.prepare(
    `INSERT INTO decisions (id, created_at, project, seq, kind, subject_type, subject_id, semantic_generation, scope, question, options, dependency_manifest,
       transition_schema_version, preview_hash, evidence, blocked_while_open, raised_at, status)
     VALUES ('dec_q', ?, 'prj_1', 1, 'blocker', 'run', 'run_x', 1, '', 'q', ?, ?, 1, 'h', '[]', ?, ?, 'open')`,
  ).run(AT, JSON.stringify([{ key: 'acknowledge' }]), JSON.stringify({ cause: 'termination_unobserved' }), JSON.stringify({ work_items: [a], gate: null, operation: null }), AT);
  const [item] = readWork(db, { project: 'prj_1' }).work_items;
  assert.deepEqual(item.blocker, { reason: 'termination_unobserved', raised_at: AT, decision: 'dec_q', options: [{ key: 'acknowledge' }] });
});

test('the work read of a project that does not exist is 404', (t) => {
  const db = store(t);
  assert.throws(() => readWork(db, { project: 'prj_none' }), (err) => err.status === 404 && err.code === 'not_found');
});

// A recorded evaluation, as the gate function leaves it, written directly.
function evaluation(db, { id, stale = 0, outcome = 'not_satisfied', states, reasons }) {
  db.pragma('foreign_keys = OFF');
  db.prepare(
    `INSERT OR IGNORE INTO acceptance_scopes (id, created_at, project, candidate, gate_kind, stage, effective_protected_version, source_revision, delivered_requirement_ids,
       partial_requirement_ids, sensitivity_categories, required_check_ids, runner_classes, required_signoffs, validated, scope_hash, acceptance_content_hash)
     VALUES ('scope_1', ?, 'prj_1', 'cand_1', 'stage', 'stage_1', 'pv_1', 'rev1', '["REQ-1"]', '[]', '[]', '["chk_a","chk_b"]', '{}', '[]', 1, 'h', 'h')`,
  ).run(AT);
  db.prepare(
    `INSERT INTO gate_evaluations (id, created_at, project, scope, candidate, gate_kind, computed_at, inputs_hash, inputs_snapshot, check_states, outcome, reasons, satisfiers, stale, stage)
     VALUES (?, ?, 'prj_1', 'scope_1', 'cand_1', 'stage', ?, 'h', ?, ?, ?, ?, '[]', ?, 'stage_1')`,
  ).run(id, AT, AT, JSON.stringify({ results: { chk_a: 'res_a', chk_b: null } }), JSON.stringify(states), outcome, JSON.stringify(reasons), stale);
  db.pragma('foreign_keys = ON');
}

function candidate(db) {
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress) VALUES ('cand_1', ?, 'prj_1', 1, 'rev1', 'lin_1', ?, 'engine_cadence', 'developing')`).run(AT, AT);
  db.pragma('foreign_keys = ON');
}

test('the gate read is 404 before any evaluation, then shows the latest recorded one as recorded, and writes nothing', (t) => {
  const db = store(t);
  candidate(db);
  assert.throws(() => readGate(db, { project: 'prj_1', candidate: 'cand_1', kind: 'stage' }), (err) => err.status === 404 && err.code === 'not_found');

  evaluation(db, { id: 'gate_1', outcome: 'satisfied', states: { chk_a: 'passed', chk_b: 'passed' }, reasons: [] });
  evaluation(db, { id: 'gate_2', stale: 1, states: { chk_a: 'passed', chk_b: 'missing' }, reasons: [{ code: 'CHECK_NOT_PASSED', subjects: ['chk_b'] }] });

  const before = footprint(db);
  const read = readGate(db, { project: 'prj_1', candidate: 'cand_1', kind: 'stage' });
  assert.deepEqual(footprint(db), before, 'the read wrote nothing');

  assert.deepEqual(read.evaluation, {
    id: 'gate_2',
    gate_kind: 'stage',
    outcome: 'not_satisfied',
    reasons: [{ code: 'CHECK_NOT_PASSED', subjects: ['chk_b'] }],
    check_states: { chk_a: 'passed', chk_b: 'missing' },
    scope: 'scope_1',
    stale: true,
  }, 'the latest, as recorded');

  assert.throws(() => readGate(db, { project: 'prj_1', candidate: 'cand_1', kind: 'alpha_authorize' }), (err) => err.status === 404);
  assert.throws(() => readGate(db, { project: 'prj_2', candidate: 'cand_1', kind: 'stage' }), (err) => err.status === 404 && err.code === 'not_found', 'another project’s candidate is not found');
});
