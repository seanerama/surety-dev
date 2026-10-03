// Developer tests for the gate's out-of-band input (D1 §§7.6, 9.3(3); row
// M24; M2 slice 1, entry A1): an unreconciled observation of a candidate's
// own nomination ref holds that candidate's gates and no other candidate's;
// one of the integration branch holds every gate of the project. Against a
// scratch store with the engine's migrations.

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
const { recordObservation } = await import(join(dist, 'store', 'transitions', 'repo.js'));
const { evaluateGate } = await import(join(dist, 'store', 'transitions', 'gates.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });

const AT = '2026-10-02T00:00:00.000Z';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const FP = 'f'.repeat(64);

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.pragma('foreign_keys = ON');
  migrate(db, join(root, 'migrations'));
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  run(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
  );
  run(
    `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots)
     VALUES ('pv_1', ?, 'prj_1', 1, ?, 'initial', 'human', 'human', ?, 1, ?, '[".surety/checks/"]')`,
    AT,
    FP,
    AT,
    AT,
  );
  run(`INSERT INTO lineages (id, created_at, project, branch, started_from_candidate, open) VALUES ('lin_1', ?, 'prj_1', 'main', NULL, 0)`, AT);
  for (const [id, seq, rev] of [
    ['cand_1', 1, A],
    ['cand_2', 2, B],
  ]) {
    run(
      `INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, nominated_protected_version, progress)
       VALUES (?, ?, 'prj_1', ?, ?, 'lin_1', ?, 'builder_request', 'pv_1', 'developing')`,
      id,
      AT,
      seq,
      rev,
      AT,
    );
  }
  for (const [id, ref, kind, oid, immutable] of [
    ['ref_main', 'refs/heads/main', 'integration', B, 0],
    ['ref_c1', 'refs/surety/cand/1', 'nomination', A, 1],
    ['ref_c2', 'refs/surety/cand/2', 'nomination', B, 1],
  ]) {
    run('INSERT INTO ref_registry (id, created_at, project, ref, kind, expected_oid, immutable) VALUES (?, ?, ?, ?, ?, ?, ?)', id, AT, 'prj_1', ref, kind, oid, immutable);
  }
  run(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path) VALUES ('plan_1', ?, 'prj_1', 1, ?, 'plan.json')`, AT, A);
  run(`INSERT INTO stages (id, created_at, project, phase_plan, number, goal, modules, requirement_ids, implements, status) VALUES ('stage_1', ?, 'prj_1', 'plan_1', 1, 'g', '[]', '[]', '[]', 'planned')`, AT);
  return db;
}

const observe = (db, ref, expected, found) => transact(db, ENGINE_ACTOR, (tx) => recordObservation(tx, 'prj_1', { subject: 'ref', ref, expected, found }));
const gate = (db, candidate) => transact(db, ENGINE_ACTOR, (tx) => evaluateGate(tx, { project: 'prj_1', candidate, kind: 'stage', stage: 'stage_1', headFingerprint: FP, head: B })).evaluation;
const oob = (evaluation) => evaluation.reasons.find((r) => r.code === 'OUT_OF_BAND_CHANGE');

test("a moved nomination ref holds that candidate's gate, and only that candidate's", (t) => {
  const db = store(t);
  assert.equal(oob(gate(db, 'cand_1')), undefined, 'nothing observed: no out-of-band reason');
  const row = observe(db, 'ref_c1', A, C);
  const held = gate(db, 'cand_1');
  assert.equal(held.outcome, 'not_satisfied');
  assert.deepEqual(oob(held), { code: 'OUT_OF_BAND_CHANGE', subjects: [row.id] });
  assert.equal(oob(gate(db, 'cand_2')), undefined, "another candidate's gate is not held by it");
});

test('a deleted nomination ref holds the gate too; a discarded observation holds nothing', (t) => {
  const db = store(t);
  const row = observe(db, 'ref_c1', A, null);
  assert.deepEqual(oob(gate(db, 'cand_1')), { code: 'OUT_OF_BAND_CHANGE', subjects: [row.id] });
  db.prepare(`UPDATE out_of_band_changes SET disposition = 'discard' WHERE id = ?`).run(row.id);
  assert.equal(oob(gate(db, 'cand_1')), undefined);
});

test("an observation of the integration branch holds every candidate's gate; with a marker observation both are named", (t) => {
  const db = store(t);
  const branch = observe(db, 'ref_main', B, C);
  assert.deepEqual(oob(gate(db, 'cand_2')), { code: 'OUT_OF_BAND_CHANGE', subjects: [branch.id] });
  const marker = observe(db, 'ref_c1', A, C);
  assert.deepEqual(oob(gate(db, 'cand_1')), { code: 'OUT_OF_BAND_CHANGE', subjects: [branch.id, marker.id] });
});
