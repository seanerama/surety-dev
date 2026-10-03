// Developer tests for the three reads M2 adds (D1 §11.3; brief B4): a
// project's operations, one decision by its id, and the environments, each a
// projection the store worker runs, against a scratch store with the engine's
// migrations. None may write, and none shows another project's rows.

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
const { intendOperation, startAttempt, recordAmbiguous, blockOperation } = await import(join(dist, 'store', 'transitions', 'journal.js'));
const { observeTrigger, chainBoundary } = await import(join(dist, 'store', 'transitions', 'work.js'));
const { readOperations, readDecision, readEnvironments } = await import(join(dist, 'store', 'projections.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));

setEngineSettings({ lease_ttl: 60, git_deadline: 30, decision_targets: {} });

const AT = '2026-10-02T00:00:00.000Z';
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

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

const footprint = (db) => {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
  return tables.map(({ name }) => [name, db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n]);
};

const intend = (db, project, ref) =>
  transact(db, ENGINE_ACTOR, (tx) =>
    intendOperation(tx, {
      project,
      kind: 'ref_update',
      payload: { repo: '/nowhere', ref, old_oid: OLD, new_oid: NEW },
      target: { repo: '/nowhere', ref },
      subject: { test: ref },
      finalizer: { purpose: 'oob_keep', ref, ref_kind: 'oob', new_oid: NEW },
      deadlineSeconds: 30,
    }),
  ).operation;

test('the operations read lists every operation of the project, pending and blocked ones included, with its intent and attempts, and writes nothing', (t) => {
  const db = store(t);
  const pending = intend(db, 'prj_1', 'refs/surety/oob/1');
  const blocked = intend(db, 'prj_1', 'refs/surety/oob/2');
  intend(db, 'prj_2', 'refs/surety/oob/3');
  transact(db, ENGINE_ACTOR, (tx) => startAttempt(tx, { operation: blocked, incarnation: 'inc_x' }));
  transact(db, ENGINE_ACTOR, (tx) => recordAmbiguous(tx, { operation: blocked }));
  transact(db, ENGINE_ACTOR, (tx) => blockOperation(tx, { operation: blocked, outcome: 'unknown', read: 'read the ref', question: 'q', workItems: [] }));

  const before = footprint(db);
  const read = readOperations(db, { project: 'prj_1' });
  assert.deepEqual(footprint(db), before, 'the read wrote nothing');
  assert.equal(read.snapshot_seq, db.prepare('SELECT MAX(seq) AS n FROM events').get().n);
  assert.deepEqual(read.operations.map((o) => o.id), [pending, blocked], 'only this project’s operations, in seq order');

  const [p, b] = read.operations;
  assert.deepEqual([p.kind, p.journal_kind, p.state, p.status, p.purpose, p.attempts, p.blocker], ['git_ref_update', 'ref_update', 'intended', 'intended', 'oob_keep', [], null]);
  assert.deepEqual([p.intent.ref, p.intent.old_oid, p.intent.new_oid], ['refs/surety/oob/1', OLD, NEW], 'the intent as the journal froze it');
  assert.deepEqual([b.state, b.status, b.attempts.length, b.attempts[0].status], ['ambiguous', 'ambiguous', 1, 'ambiguous']);
  assert.equal(b.attempts[0].reconciliation_reads.at(-1).result, 'unknown');
  assert.equal(b.blocker, db.prepare(`SELECT id FROM decisions WHERE kind = 'blocker' AND subject_id = ? AND status = 'open'`).get(blocked).id, 'the open blocker decision');
});

test('one decision by its id: the list’s shape with its status, preview and answer; another project’s is not found', (t) => {
  const db = store(t);
  const item = transact(db, ENGINE_ACTOR, (tx) => observeTrigger(tx, { project: 'prj_1', kind: 'stage_build', trigger_source: 'test', trigger_id: 'a', trigger_generation: 1, chain: 2 }, {})).work_item.id;
  transact(db, ENGINE_ACTOR, (tx) => chainBoundary(tx, { workItem: item }));
  const row = db.prepare(`SELECT * FROM decisions WHERE kind = 'blocker' AND subject_id = ?`).get(item);

  const before = footprint(db);
  const read = readDecision(db, { project: 'prj_1', decision: row.id });
  assert.deepEqual(footprint(db), before, 'the read wrote nothing');
  const d = read.decision;
  assert.deepEqual(
    [d.id, d.kind, d.subject_type, d.subject_id, d.status, d.semantic_generation, d.preview_hash, d.question, d.answer],
    [row.id, 'blocker', 'work_item', item, 'open', 1, row.preview_hash, row.question, null],
  );
  assert.deepEqual(d.options, JSON.parse(row.options), 'the options as stored, with their effect plans and plan hashes');
  assert.deepEqual(d.dependency_manifest, JSON.parse(row.dependency_manifest), 'what the preview is bound to');
  assert.throws(() => readDecision(db, { project: 'prj_2', decision: row.id }), (err) => err.status === 404 && err.code === 'not_found');
  assert.throws(() => readDecision(db, { project: 'prj_1', decision: 'dec_none' }), (err) => err.status === 404 && err.code === 'not_found');
});

test('the environments read shows each environment of the project with its current observation, and an environment never observed as unknown', (t) => {
  const db = store(t);
  db.prepare(`INSERT INTO environments (id, created_at, project, name, adapter, adapter_config_ref, verify_spec) VALUES ('env_1', ?, 'prj_1', 'alpha', 'test', 'none', '{}')`).run(AT);
  db.prepare(`INSERT INTO environments (id, created_at, project, name, adapter, adapter_config_ref, verify_spec) VALUES ('env_2', ?, 'prj_2', 'other', 'test', 'none', '{}')`).run(AT);
  const before = footprint(db);
  const read = readEnvironments(db, { project: 'prj_1' });
  assert.deepEqual(footprint(db), before, 'the read wrote nothing');
  assert.deepEqual(read.environments.map((e) => [e.id, e.name, e.observed.condition, e.observed.observed_at]), [['env_1', 'alpha', 'unknown', null]]);
  assert.throws(() => readEnvironments(db, { project: 'prj_none' }), (err) => err.status === 404);
});
