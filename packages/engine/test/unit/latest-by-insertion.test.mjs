// Developer tests for D1's monotonic rule (BS5 §4.1 rule 17; the driver's
// ruling on the wall-clock defect, 2026-10-13): what selects "the latest",
// "the previous" or "the newest" row orders by insertion, never by
// `created_at`, which is wall time and steps back on this host. Two rows
// are inserted with their `created_at` inverted; the later insert wins.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', '..', 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { latestSemantics, previousRepresentation } = await import(join(dist, 'spec', 'approval.js'));
const { activePlan } = await import(join(dist, 'plan', 'replace.js'));

function store() {
  const db = new Database(':memory:');
  migrate(db, join(here, '..', '..', 'migrations'));
  db.pragma('foreign_keys = OFF');
  return db;
}
const LATER = '2026-10-13T10:00:01.000Z';
const EARLIER = '2026-10-13T10:00:00.000Z';
const rep = (statement) => JSON.stringify({ requirements: [{ key: 'R1', statement, criteria: [] }] });

test("a session's last save is the last row its save wrote, though the clock stepped back between the two", () => {
  const db = store();
  db.prepare(`INSERT INTO "runs" ("id", "created_at", "project", "seq", "role", "kind", "state", "backend", "backend_version", "model_requested", "base_revision", "deadline_at", "quarantined") VALUES ('run_1', ?, 'p', 1, 'spec_writer', 'session', 'executing', 'scripted', '1', 'm', 'abc', ?, 0)`).run(EARLIER, LATER);
  const save = db.prepare(`INSERT INTO "spec_semantics" ("id", "created_at", "project", "run", "git_blob", "semantic_digest", "representation", "findings", "readable") VALUES (?, ?, 'p', 'run_1', ?, ?, ?, '[]', 1)`);
  // The defective save first, at the later wall time; the clean one after it, the clock stepped back.
  save.run('sem_A', LATER, 'blob_defective', 'd1', rep('defective'));
  save.run('sem_0', EARLIER, 'blob_clean', 'd2', rep('clean'));
  assert.equal(latestSemantics(db, 'run_1').git_blob, 'blob_clean', 'the later insert is the last save');
  assert.equal(JSON.parse(JSON.stringify(previousRepresentation(db, 'p'))).requirements[0].statement, 'clean', "and the project's previous representation");
});

test('the open phase plan is the last one published, whatever its created_at', () => {
  const db = store();
  const plan = db.prepare(`INSERT INTO "phase_plans" ("id", "created_at", "project", "phase_number", "prepared_against_revision", "git_path", "status", "active", "generation") VALUES (?, ?, 'p', ?, 'abc', 'x', 'published', 1, 1)`);
  plan.run('plan_B', LATER, 1);
  plan.run('plan_A', EARLIER, 2);
  assert.equal(activePlan(db, 'p').id, 'plan_A');
});
