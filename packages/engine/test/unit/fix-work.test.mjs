// Developer tests for the fix work the engine creates when a "fix"
// disposition is recorded (E43; E38 items 6 and 7), against a scratch store
// with the engine's migrations.

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
const { recordDisposition } = await import(join(dist, 'store', 'transitions', 'queue.js'));

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.pragma('foreign_keys = ON');
  migrate(db, join(root, 'migrations'));
  db.prepare(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', '2026-10-02T00:00:00.000Z', 'p', 'T2', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
  ).run();
  const finding = (id, seq) =>
    db.prepare(
      `INSERT INTO findings (id, created_at, project, seq, scope, subject_id, category, message, "check", proposed_severity, effective_severity, status)
       VALUES (?, '2026-10-02T00:00:00.000Z', 'prj_1', ?, 'project', 'prj_1', 'defect', 'm', 'login', 'medium', 'medium', 'open')`,
    ).run(id, seq);
  finding('fnd_A', 1);
  finding('fnd_B', 2);
  return db;
}

const row = (db, id) => db.prepare('SELECT * FROM findings WHERE id = ?').get(id);
const fixes = (db, finding) =>
  db.prepare(`SELECT * FROM work_items WHERE kind = 'fix' AND json_extract(subject, '$.finding') = ? ORDER BY seq`).all(finding);
const dispose = (db, id, disposition, authority, by = 'human') =>
  transact(db, ENGINE_ACTOR, (tx) => recordDisposition(tx, row(db, id), { disposition, authority, by, linked_issue: null, defer_target: null }));

test('a fix the human approved registers one chained fix item naming the finding, in the transaction of the disposition', (t) => {
  const db = store(t);
  dispose(db, 'fnd_A', 'fix', 'human');
  const [item, ...more] = fixes(db, 'fnd_A');
  assert.deepEqual(more, []);
  assert.deepEqual(JSON.parse(item.subject), { finding: 'fnd_A' });
  assert.deepEqual([item.status, item.trigger_source, item.trigger_id, item.trigger_generation, item.chain], ['eligible', 'finding', 'fnd_A', 1, 1]);
  // The finding names no criterion, so from M3 slice 21 the same transaction
  // also routes check_correction work (D3 §2.11; repair-and-findings.test.mjs).
  const events = db.prepare(`SELECT type, tx, json_extract(subject, '$.work_item') AS w FROM events ORDER BY seq`).all();
  assert.deepEqual(events.map((e) => e.type), ['finding.dispositioned', 'work.created', 'work.created']);
  assert.equal(events[1].w, item.id, "the fix's work.created comes first");
  assert.ok(events.every((e) => e.tx === events[0].tx), 'one transaction');
  assert.equal(JSON.parse(db.prepare(`SELECT payload FROM events WHERE type = 'work.created' AND json_extract(subject, '$.work_item') = ?`).get(item.id).payload).test_fixture, undefined);
});

test('a disposition that fails leaves no fix item', (t) => {
  const db = store(t);
  assert.throws(() =>
    transact(db, ENGINE_ACTOR, (tx) => {
      recordDisposition(tx, row(db, 'fnd_A'), { disposition: 'fix', authority: 'human', by: 'human', linked_issue: null, defer_target: null });
      throw new Error('the transaction fails after the disposition');
    }),
  );
  assert.deepEqual(fixes(db, 'fnd_A'), []);
  assert.equal(row(db, 'fnd_A').status, 'open');
});

test('no second item while one is open; a reopened finding whose fix completed gets the next generation', (t) => {
  const db = store(t);
  dispose(db, 'fnd_A', 'fix', 'human');
  dispose(db, 'fnd_A', 'fix', 'human');
  assert.equal(fixes(db, 'fnd_A').length, 1);
  db.prepare(`UPDATE work_items SET status = 'complete' WHERE kind = 'fix'`).run();
  dispose(db, 'fnd_A', 'fix', 'human');
  assert.deepEqual(fixes(db, 'fnd_A').map((w) => [w.trigger_generation, w.status]), [[1, 'complete'], [2, 'eligible']]);
});

test("a Reviewer's fix creates the work too, carrying its run's chain; other dispositions create none", (t) => {
  const db = store(t);
  dispose(db, 'fnd_B', 'accept', 'human');
  dispose(db, 'fnd_A', 'fix', 'reviewer', 'run_R');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM work_items WHERE kind = 'fix'`).get().n, 1);
  assert.deepEqual(fixes(db, 'fnd_A').map((w) => [w.trigger_source, w.chain]), [['finding', 1]], 'a run the store does not have counts as chain 1');
});
