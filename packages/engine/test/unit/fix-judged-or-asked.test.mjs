// Developer tests for objection 209 under Sean's rulings of 2026-10-23
// (errata E180; SEAM.md §562): a plain `fix` the engine left `verifying` for
// ever (findings F26 and F33 of the M535 Waterlog recovery attempt).
//
// - D-1: a role's finding stored with a lineage or candidate scope and no
//   candidate applies as a project finding (gates.ts findingApplies); a
//   Builder's objection does not.
// - D-4: a fix's current candidate is the latest candidate not superseded
//   holding it, itself or by ancestry (repair.ts currentCandidate).
// - D-2: the stage gate a plain verifying fix is judged at is due on that
//   candidate once its verification is complete, for each stage whose scope
//   requires the finding's named check (gates.ts dueStageGates).
// - D-3: a fix no such gate can judge, with nothing of it in flight, is
//   `unjudged` (gates.ts fixJudgement), naming the missing prerequisite.

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
const { recordDisposition } = await import(join(dist, 'store', 'transitions', 'queue.js'));
const { dueStageGates, findingApplies, fixJudgement } = await import(join(dist, 'store', 'transitions', 'gates.js'));
const { currentCandidate } = await import(join(dist, 'store', 'transitions', 'repair.js'));
const { getCandidate } = await import(join(dist, 'store', 'transitions', 'evidence.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });

const AT = '2026-10-23T00:00:00.000Z';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

function scratchDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  return db;
}

function item(db, id, kind, subject, status, trigger = { source: 'test', id }) {
  db.prepare(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, depends_on, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold, chain)
     VALUES (?, ?, 'prj_1', (SELECT COALESCE(MAX(seq), 0) + 1 FROM work_items WHERE project = 'prj_1'), ?, ?, ?, '[]', ?, ?, 1, 0, 0, 0, 0, 0)`,
  ).run(id, AT, kind, JSON.stringify(subject), status, trigger.source, trigger.id);
}

function check(db, id, key, gates) {
  db.prepare(
    `INSERT INTO checks (id, created_at, project, key, protected_version, kind, required, gate_kinds, definition_path, definition_hash, runner_class, criteria, requirement_ids, origin)
     VALUES (?, ?, 'prj_1', ?, 'pv_1', 'acceptance', 1, ?, ?, 'h', 'direct', '["R1.1"]', '["req_1"]', 'acceptance')`,
  ).run(id, AT, key, gates, `.surety/checks/defs/${key}.json`);
}

function candidate(db, id, n, revision, held, lineage, from) {
  db.prepare(`INSERT INTO lineages (id, created_at, project, branch, started_from_candidate, open) VALUES (?, ?, 'prj_1', 'main', ?, 0)`).run(lineage, AT, from);
  db.prepare(
    `INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, nominated_protected_version, progress, held_work)
     VALUES (?, ?, 'prj_1', ?, ?, ?, ?, 'engine_cadence', 'pv_1', 'developing', ?)`,
  ).run(id, AT, n, revision, lineage, AT, JSON.stringify(held));
  if (revision !== A) db.prepare(`INSERT INTO revision_ancestry (id, created_at, project, ancestor, descendant, is_ancestor) VALUES (?, ?, 'prj_1', ?, ?, 1)`).run(`anc_${id}`, AT, A, revision);
}

// A T1 project, its one stage verified on candidate 1 (stage work
// complete). `acc` covers R1.1 at the stage and Alpha gates; `lg` covers
// R1.1 at alpha_authorize only. The Verifier's finding on candidate 1 names
// `key`, dispositioned fix by the owner: fix work `fix`. Its candidate 2 is
// superseded by candidate 3, which started from it (holding the fix by
// ancestry); candidate 3's verification is `verification`.
function store(t, { key = 'acc', verification = 'complete' } = {}) {
  const db = scratchDb(t);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  run(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
  );
  run(
    `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots, fingerprint_scheme)
     VALUES ('pv_1', ?, 'prj_1', 1, 'fp', 'initial', 'human', 'human', ?, 1, ?, '[".surety/checks/"]', 'manifest')`,
    AT,
    AT,
    AT,
  );
  run(`INSERT INTO requirements (id, created_at, project, key, text_ref, status, criteria, sensitive_areas, assigned_phase) VALUES ('req_1', ?, 'prj_1', 'R1', 'r1', 'approved', '["R1.1"]', '[]', 1)`, AT);
  run(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, generation, active, status) VALUES ('plan_1', ?, 'prj_1', 1, ?, 'p1.json', 1, 1, 'published')`, AT, A);
  item(db, 'wi_stage', 'stage_build', { stage: 'stage_1' }, 'complete', { source: 'plan', id: 'stage_1' });
  run(
    `INSERT INTO stages (id, created_at, project, phase_plan, number, goal, modules, requirement_ids, implements, status, work_item, integrated_revision)
     VALUES ('stage_1', ?, 'prj_1', 'plan_1', 1, 'g', '[]', '["req_1"]', '["req_1"]', 'verified', 'wi_stage', ?)`,
    AT,
    A,
  );
  check(db, 'chk_acc', 'acc', '["stage","alpha_authorize"]');
  check(db, 'chk_lg', 'lg', '["alpha_authorize"]');
  candidate(db, 'cand_1', 1, A, ['wi_stage'], 'lin_1', null);
  run(
    `INSERT INTO findings (id, created_at, project, seq, scope, subject_id, candidate, source_role, category, message, "check", criterion, proposed_severity, effective_severity, status)
     VALUES ('fnd_1', ?, 'prj_1', 1, 'candidate', 'cand_1', 'cand_1', 'verifier', 'defect', 'm', ?, 'R1.1', 'medium', 'medium', 'open')`,
    AT,
    key,
  );
  const row = db.prepare(`SELECT * FROM findings WHERE id = 'fnd_1'`).get();
  transact(db, ENGINE_ACTOR, (tx) => recordDisposition(tx, row, { disposition: 'fix', authority: 'human', by: 'human', linked_issue: null, defer_target: null }));
  const fix = db.prepare(`SELECT * FROM work_items WHERE kind = 'fix' AND json_extract(subject, '$.finding') = 'fnd_1'`).get();
  assert.ok(fix, 'the fix disposition made fix work');
  run(`UPDATE work_items SET status = 'verifying' WHERE id = ?`, fix.id);
  candidate(db, 'cand_2', 2, B, [fix.id], 'lin_2', 'cand_1');
  candidate(db, 'cand_3', 3, C, [], 'lin_3', 'cand_2');
  run(`UPDATE candidates SET superseded_by = 'cand_3' WHERE id = 'cand_2'`);
  item(db, 'wi_v2', 'verification', { candidate: 'cand_2' }, 'cancelled', { source: 'nomination', id: 'cand_2' });
  item(db, 'wi_v3', 'verification', { candidate: 'cand_3' }, verification, { source: 'nomination', id: 'cand_3' });
  return { db, fix: db.prepare('SELECT * FROM work_items WHERE id = ?').get(fix.id) };
}

test('D-1: a role finding stored with scope candidate and no candidate applies as a project finding; a Builder objection of that shape applies to none', (t) => {
  const { db } = store(t);
  const c3 = getCandidate(db, 'cand_3');
  const legacy = { ...db.prepare(`SELECT * FROM findings WHERE id = 'fnd_1'`).get(), id: 'fnd_x', scope: 'candidate', candidate: null, source_role: 'verifier' };
  assert.equal(findingApplies(db, legacy, c3), true, 'a Verifier finding of the legacy shape is read as a project finding');
  assert.equal(findingApplies(db, { ...legacy, scope: 'lineage' }, c3), true, 'and so is one of lineage scope');
  assert.equal(findingApplies(db, { ...legacy, source_role: 'builder', category: 'requirement_conflict' }, c3), false, "a Builder's objection keeps its own route");
  assert.equal(findingApplies(db, { ...legacy, candidate: 'cand_9' }, c3), false, 'a row with a candidate is unchanged: not on the chain, not applied');
});

test("D-4: a fix's current candidate is the latest candidate not superseded holding it by ancestry, never its superseded own", (t) => {
  const { db, fix } = store(t);
  assert.equal(currentCandidate(db, fix)?.id, 'cand_3');
  db.prepare(`UPDATE candidates SET superseded_by = 'cand_4' WHERE id = 'cand_3'`).run();
  assert.equal(currentCandidate(db, fix), null, 'every holder superseded: none');
});

test('D-2: the stage gate a plain verifying fix is judged at is due on its current candidate once its verification is complete, never on the superseded one', (t) => {
  const { db, fix } = store(t);
  assert.deepEqual(dueStageGates(db, { project: 'prj_1' }), [{ candidate: 'cand_3', stage: 'stage_1' }]);
  assert.deepEqual(fixJudgement(db, fix), { state: 'in_flight', candidate: 'cand_3', why: 'a stage gate of cand_3 is due' });
  // Evaluated and current: no longer due, and judged (not unjudged).
  db.prepare(
    `INSERT INTO gate_evaluations (id, created_at, project, scope, candidate, gate_kind, computed_at, inputs_hash, inputs_snapshot, check_states, outcome, reasons, satisfiers, stale, stage)
     VALUES ('gate_1', ?, 'prj_1', 'scope_1', 'cand_3', 'stage', ?, 'h', '{}', '{}', 'not_satisfied', '[]', '[]', 0, 'stage_1')`,
  ).run(AT, AT);
  assert.deepEqual(dueStageGates(db, { project: 'prj_1' }), []);
  assert.deepEqual(fixJudgement(db, fix), { state: 'judgeable', candidate: 'cand_3', stages: ['stage_1'] });
});

test("D-2, D-3: while its current candidate's verification is pending nothing is due and the fix is in flight, never unjudged", (t) => {
  const { db, fix } = store(t, { verification: 'eligible' });
  assert.deepEqual(dueStageGates(db, { project: 'prj_1' }), []);
  assert.equal(fixJudgement(db, fix)?.state, 'in_flight');
});

test('D-3: a fix whose named check no stage scope requires is unjudged, naming the check, the candidate and the missing prerequisite; no gate is made due', (t) => {
  const { db, fix } = store(t, { key: 'lg' });
  assert.deepEqual(dueStageGates(db, { project: 'prj_1' }), [], 'no stage scope gains lg');
  const j = fixJudgement(db, fix);
  assert.equal(j?.state, 'unjudged');
  assert.deepEqual([j.candidate, j.finding, j.check], ['cand_3', 'fnd_1', 'lg']);
  assert.match(j.missing, /no stage scope of candidate cand_3 requires check lg; it is required only at alpha_authorize/);
});
