// Developer tests for M5 slice 36's pure and store-level parts (D6 §4.4,
// §4.5, §4.7; reading 6; the driver's rulings on the slice-36 design note):
// the roadmap's `moved_requirements` with `from` null; the store's trigger
// that keeps a requirement's phase the roadmap's; the Verifier's
// `spec_applicability` as a result field, its form and its role.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', '..', 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { parseRoadmap } = await import(join(dist, 'plan', 'schemas.js'));
const { fieldAllowed, parseReport } = await import(join(dist, 'runs', 'report.js'));

const roadmap = (moved) =>
  JSON.stringify({ version: 2, architecture_version: 1, phases: [{ number: 1, goal: 'g', modules: ['lib'], requirement_ids: ['R1'], depends_on: [] }], ...(moved ? { moved_requirements: moved } : {}) });

test('moved_requirements accepts from null for a requirement with no phase, and refuses a from that is no phase', () => {
  const ok = parseRoadmap(roadmap([{ key: 'R5', from: null, to: 1 }]));
  assert.equal(ok.ok, true, JSON.stringify(ok.finding ?? null));
  assert.deepEqual(ok.value.moved_requirements, [{ key: 'R5', from: null, to: 1 }]);
  assert.equal(parseRoadmap(roadmap([{ key: 'R5', from: 2, to: 1 }])).ok, true);
  for (const from of [0, 'one', undefined]) {
    const bad = parseRoadmap(roadmap([{ key: 'R5', ...(from === undefined ? {} : { from }), to: 1 }]));
    assert.equal(bad.ok, false, `from ${String(from)} is refused`);
  }
});

function store() {
  const db = new Database(':memory:');
  migrate(db, join(here, '..', '..', 'migrations'));
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO "requirements" ("id", "created_at", "project", "key", "text_ref", "assigned_phase", "status") VALUES ('req_1', 't', 'p', 'R1', 'spec#R1', 1, 'approved'), ('req_5', 't', 'p', 'R5', 'spec#R5', NULL, 'pending')`).run();
  return db;
}
const roadmapRow = (db, version, phases) =>
  db
    .prepare(`INSERT INTO "roadmap_revisions" ("id", "created_at", "project", "version", "git_path", "git_blob", "phases", "approved_by", "approved_at") VALUES (?, 't', 'p', ?, 'r', 'b', ?, 'human', 't')`)
    .run(`road_${version}`, version, JSON.stringify(phases));
const setPhase = (db, key, phase) => db.prepare('UPDATE "requirements" SET "assigned_phase" = ? WHERE "project" = \'p\' AND "key" = ?').run(phase, key);
const phaseOf = (db, key) => db.prepare('SELECT "assigned_phase" FROM "requirements" WHERE "key" = ?').get(key).assigned_phase;

test('before any roadmap a phase may be written; once one exists only the phase the latest revision gives', () => {
  const db = store();
  setPhase(db, 'R1', 2);
  assert.equal(phaseOf(db, 'R1'), 2, 'no roadmap yet: the index hint may be written');
  setPhase(db, 'R1', 1);
  roadmapRow(db, 1, [{ number: 1, requirement_ids: ['R1'] }, { number: 2, requirement_ids: [] }]);
  assert.throws(() => setPhase(db, 'R5', 2), /follows the current roadmap/, 'R5 is in no phase of the roadmap');
  assert.equal(phaseOf(db, 'R5'), null);
  assert.throws(() => setPhase(db, 'R1', 2), /follows the current roadmap/, 'R1 is in phase 1');
  assert.throws(() => setPhase(db, 'R1', null), /follows the current roadmap/, 'R1 cannot leave the phase the roadmap gives it');
  setPhase(db, 'R1', 1);
  db.prepare('UPDATE "requirements" SET "status" = \'verified\' WHERE "key" = \'R1\'').run();
  roadmapRow(db, 2, [{ number: 1, requirement_ids: ['R1'] }, { number: 3, requirement_ids: ['R5'] }]);
  setPhase(db, 'R5', 3);
  assert.equal(phaseOf(db, 'R5'), 3, 'the revision that places R5 lets the engine write its phase');
});

test('spec_applicability: a Verifier\'s field of entries {check, criteria, rationale}, closed', () => {
  const entry = { check: 'integration', criteria: ['R2.2'], rationale: 'the status alone is asserted' };
  assert.equal(fieldAllowed({ status: 'completed', summary: 's', spec_applicability: [entry] }, 'verifier'), true);
  assert.equal(fieldAllowed({ status: 'completed', summary: 's', spec_applicability: [entry] }, 'builder'), false, 'no other role sends it');
  assert.deepEqual(parseReport({ spec_applicability: [entry] }).spec_applicability, [entry]);
  for (const bad of [{ ...entry, criteria: [] }, { ...entry, rationale: ' ' }, { ...entry, extra: 1 }, { criteria: ['R2.2'], rationale: 'r' }]) {
    assert.equal(parseReport({ spec_applicability: [bad] }), null, `refused: ${JSON.stringify(bad)}`);
  }
});
