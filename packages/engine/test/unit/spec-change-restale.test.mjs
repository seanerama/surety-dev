// Developer tests for E171 item 5 H4 (a), Sean's ruling of 2026-10-19
// (SEAM.md §552): a spec change's replan whose proposal went stale, its
// phase's plan still open, is registered again against the active
// generation, once; a second staleness against the same active generation
// registers the next generation parked with a blocker for the owner.
// Against a scratch store with the engine's migrations.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', '..', 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { settleReplacements, pendingReplacement, RESTALE_PARK_REASON } = await import(join(dist, 'plan', 'replace.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });

const AT = '2026-10-19T00:00:00.000Z';

function store() {
  const db = new Database(':memory:');
  migrate(db, join(here, '..', '..', 'migrations'));
  db.pragma('foreign_keys = OFF');
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  run(`INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management) VALUES ('p', ?, 'p', 'T1', '/repo', 'main', 'spec_ready', 'registered', '{}')`, AT);
  // Generation 1 replaced by generation 2, the active one.
  run(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, status, active, generation, replaced_by) VALUES ('pp_1', ?, 'p', 1, 'r', 'g', 'replaced', 0, 1, 'pp_2')`, AT);
  run(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, status, active, generation) VALUES ('pp_2', ?, 'p', 1, 'r', 'g', 'published', 1, 2)`, AT);
  return { db, run };
}

let seq = 0;
// A spec change's replan, complete, whose one proposal went stale.
function staleReplan(run, { id, generation, evidence, status = 'complete' }) {
  seq += 1;
  run(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold, trigger_evidence)
     VALUES (?, ?, 'p', ?, 'replan', '{"request":"scr_1"}', ?, 'spec_change', 'scr_1', ?, 0, 0, 0, 0, ?)`,
    id, AT, seq, status, generation, JSON.stringify(evidence),
  );
  run(`INSERT INTO runs (id, created_at, project, seq, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined, work_item) VALUES (?, ?, 'p', ?, 'architect', 'one_shot', 'ended', 'b', 'v', 'm', 'r', ?, 0, ?)`, `run_${id}`, AT, seq, AT, id);
  run(`INSERT INTO plan_bundles (id, created_at, project, head, blobs, artifacts, versions, status, stale_reason, run) VALUES (?, ?, 'p', 'h', '{}', '{}', '{}', 'stale', 'another proposal was published', ?)`, `pb_${id}`, AT, `run_${id}`);
}

const settle = (db) => transact(db, ENGINE_ACTOR, (tx) => settleReplacements(tx, 'p'));
const replans = (db) => db.prepare(`SELECT * FROM work_items WHERE kind = 'replan' AND trigger_source = 'spec_change' ORDER BY trigger_generation`).all();

test('a stale spec change replan is registered again against the active generation, once, and then parks', () => {
  const { db, run } = store();
  const original = { phase_plan: 'pp_1', generation: 1, evidence: { request: 'scr_1', impact: null }, stale: ['stage 1', 'criterion:R1.1'] };
  staleReplan(run, { id: 'wi_1', generation: 1, evidence: original });
  settle(db);
  const [, again] = replans(db);
  assert.ok(again, 'registered again');
  assert.equal(again.status, 'eligible');
  assert.equal(again.trigger_generation, 2);
  const ev = JSON.parse(again.trigger_evidence);
  assert.deepEqual([ev.phase_plan, ev.generation, ev.evidence, ev.stale, ev.from_work_item], ['pp_2', 2, original.evidence, original.stale, 'wi_1'], 'the active target, the original evidence and stale list');
  assert.deepEqual(ev.restaled, { why: 'another proposal was published', from_work_item: 'wi_1', bundle: 'pb_wi_1' }, 'the cause in a field of its own');
  assert.equal(pendingReplacement(db, 'p', { id: 'pp_2', generation: 2 })?.work_item, again.id, 'it holds completion');
  settle(db);
  assert.equal(replans(db).length, 2, 'once: nothing more while it is pending');

  // It proposes and goes stale again against the same active generation.
  db.prepare(`DELETE FROM work_items WHERE id = ?`).run(again.id);
  staleReplan(run, { id: 'wi_2', generation: 2, evidence: ev });
  settle(db);
  const parked = replans(db)[2];
  assert.ok(parked, 'the next generation registered');
  assert.equal(parked.status, 'parked', 'the cap: parked, not dispatched');
  assert.equal(JSON.parse(parked.blocker).reason, RESTALE_PARK_REASON);
  const pev = JSON.parse(parked.trigger_evidence);
  assert.deepEqual([pev.evidence, pev.stale, pev.from_work_item, pev.restaled.from_work_item], [original.evidence, original.stale, 'wi_2', 'wi_2'], 'its evidence carried, the original stale list kept');
  const q = db.prepare(`SELECT options FROM decisions WHERE kind = 'blocker' AND subject_id = ? AND status = 'open'`).get(parked.id);
  assert.ok(q, 'a blocker for the owner');
  assert.deepEqual(JSON.parse(q.options).map((o) => o.key), ['retry', 'cancel'], 'retry or cancel');
  assert.equal(pendingReplacement(db, 'p', { id: 'pp_2', generation: 2 })?.work_item, parked.id, 'parked, it holds completion until the owner answers');
  settle(db);
  assert.equal(replans(db).length, 3, 'parked: nothing more');
  db.prepare(`UPDATE work_items SET status = 'cancelled' WHERE id = ?`).run(parked.id);
  assert.equal(pendingReplacement(db, 'p', { id: 'pp_2', generation: 2 }), null, 'cancelled: holds nothing');
  settle(db);
  assert.equal(replans(db).length, 3, 'cancelled: not registered again');
});

test('no re-registration when the latest was cancelled, names no plan, or its phase is no longer the open one', () => {
  for (const [label, setup] of [
    ['cancelled', (run) => staleReplan(run, { id: 'wi_c', generation: 1, status: 'cancelled', evidence: { phase_plan: 'pp_1', generation: 1, evidence: { request: 'scr_1' }, stale: [] } })],
    ['another phase open', (run) => {
      run(`UPDATE phase_plans SET phase_number = 2 WHERE id = 'pp_2'`);
      staleReplan(run, { id: 'wi_o', generation: 1, evidence: { phase_plan: 'pp_1', generation: 1, evidence: { request: 'scr_1' }, stale: [] } });
    }],
    ['no plan named', (run) => staleReplan(run, { id: 'wi_n', generation: 1, evidence: { evidence: { request: 'scr_1' }, stale: [] } })],
  ]) {
    const { db, run } = store();
    setup(run);
    settle(db);
    assert.equal(replans(db).length, 1, label);
  }
});
