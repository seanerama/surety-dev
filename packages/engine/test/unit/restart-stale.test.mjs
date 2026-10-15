// Developer tests for the driver's ruling on the restart stall (D1 §9.5,
// 2026-10-15): at engine start every gate evaluation that is not satisfied
// and not already stale is marked stale, in one transaction, and the count
// rides on engine.started. A satisfied evaluation is untouched. A stage gate
// whose last evaluation was not satisfied before the restart is then due
// again (found by the real M443 run: stage 2 sat in 'verifying' behind a
// not_satisfied evaluation the new engine never recomputed).

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', '..', 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { schedulerStarted } = await import(join(dist, 'store', 'transitions', 'engine.js'));
const { dueStageGates } = await import(join(dist, 'store', 'transitions', 'gates.js'));

const T = '2026-10-15T10:00:00.000Z';

function store() {
  const db = new Database(':memory:');
  migrate(db, join(here, '..', '..', 'migrations'));
  db.pragma('foreign_keys = OFF');
  return db;
}

function candidate(db, id, seq, held) {
  db.prepare(`INSERT INTO "candidates" ("id", "created_at", "project", "seq", "revision", "lineage", "nominated_at", "nominated_by", "progress", "held_work") VALUES (?, ?, 'p', ?, 'abc', 'lin_none', ?, 'engine_cadence', 'developing', ?)`).run(id, T, seq, T, JSON.stringify(held));
}
function workItem(db, id, seq, kind, status, subject, trigger) {
  db.prepare(`INSERT INTO "work_items" ("id", "created_at", "project", "seq", "kind", "subject", "status", "trigger_source", "trigger_id", "trigger_generation", "repair_attempts", "no_progress_count", "preflight_refusals", "dispatch_hold") VALUES (?, ?, 'p', ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, 0)`).run(id, T, seq, kind, JSON.stringify(subject), status, trigger[0], trigger[1]);
}
function evaluation(db, id, cand, stage, outcome) {
  db.prepare(`INSERT INTO "gate_evaluations" ("id", "created_at", "project", "scope", "candidate", "gate_kind", "computed_at", "inputs_hash", "inputs_snapshot", "check_states", "outcome", "reasons", "satisfiers", "stale", "stage") VALUES (?, ?, 'p', 'candidate', ?, 'stage', ?, 'h', '{}', '[]', ?, '[]', '[]', 0, ?)`).run(id, T, cand, T, outcome, stage);
}
const staleOf = (db, id) => db.prepare('SELECT "stale" FROM "gate_evaluations" WHERE "id" = ?').get(id).stale;

test('engine start stales a not-satisfied evaluation, leaves a satisfied one, and the stage gate is due again', () => {
  const db = store();
  // Two candidates, each verified, each holding one stage's work in 'verifying'.
  candidate(db, 'cand_A', 1, ['wi_stage2']);
  candidate(db, 'cand_B', 2, ['wi_stage3']);
  workItem(db, 'wi_ver_A', 1, 'verification', 'complete', { candidate: 'cand_A' }, ['nomination', 'cand_A']);
  workItem(db, 'wi_ver_B', 2, 'verification', 'complete', { candidate: 'cand_B' }, ['nomination', 'cand_B']);
  workItem(db, 'wi_stage2', 3, 'stage_build', 'verifying', { stage: 'stage_2' }, ['plan', 'plan_1:stage_2']);
  workItem(db, 'wi_stage3', 4, 'stage_build', 'verifying', { stage: 'stage_3' }, ['plan', 'plan_1:stage_3']);
  evaluation(db, 'ge_unsat', 'cand_A', 'stage_2', 'not_satisfied');
  evaluation(db, 'ge_sat', 'cand_B', 'stage_3', 'satisfied');

  assert.deepEqual(dueStageGates(db, { project: 'p' }), [], 'before the restart neither gate is due: the stall');

  const r = transact(db, ENGINE_ACTOR, (tx) => schedulerStarted(tx, 'inc_2'));
  assert.equal(r.stale_gate_evaluations, 1);
  assert.equal(staleOf(db, 'ge_unsat'), 1, 'the not-satisfied evaluation is stale');
  assert.equal(staleOf(db, 'ge_sat'), 0, 'the satisfied one is untouched');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "gate_evaluations"').get().n, 2, 'staleness is not invalidation: nothing is removed');

  const ev = db.prepare(`SELECT "payload" FROM "events" WHERE "type" = 'engine.started' ORDER BY rowid DESC LIMIT 1`).get();
  assert.equal(JSON.parse(ev.payload).stale_gate_evaluations, 1, 'the count rides on engine.started');

  assert.deepEqual(dueStageGates(db, { project: 'p' }), [{ candidate: 'cand_A', stage: 'stage_2' }]);

  // A second start finds nothing more to stale.
  assert.equal(transact(db, ENGINE_ACTOR, (tx) => schedulerStarted(tx, 'inc_3')).stale_gate_evaluations, 0);
});
