// Developer tests for a fix finding whose verifying check is required in an
// earlier phase's scopes and not in the scope a later gate evaluates (real
// loop run 6, project proj_01M52HKQJF0WEBP2KFZFPZPCS1): the Verifier raised a
// security finding naming `security-server` (no criterion) in phase 1; the
// owner answered fix; the fix integrated and security-server passed on the
// newest candidates; but phase 2's stage scopes do not require it, so every
// phase-2 stage gate stayed FINDING_UNSATISFIED on that finding, and the
// fix work sat `verifying`, with nothing running and nothing asked.
//
// The rule as built (D3 §2.11 condition 2 as Sean ruled on S2, the gate of
// each scope sees the finding resolved; E152 item 3): the named check is
// required in one of the candidate's scopes (its stage and deployment scopes
// together, or a phase scope of it), of origin acceptance, covering the
// finding's criterion (or, naming none, covering none), passed on the
// evaluated candidate by an execution after the disposition with intact
// evidence: then any gate that reads the finding resolves it.

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
const { recordCheckResult } = await import(join(dist, 'store', 'transitions', 'baseline.js'));
const { recordDisposition } = await import(join(dist, 'store', 'transitions', 'queue.js'));
const { evaluateGate } = await import(join(dist, 'store', 'transitions', 'gates.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });

const AT = '2026-10-16T00:00:00.000Z';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

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

// A T1 project: phase 1 (plan_1, completed) with stage_1 implementing R1,
// verified on candidate 1; phase 2 (plan_2, published) with stage_2
// implementing R2, integrated in candidate 2. Stage checks acc1 (R1.1) and
// acc2 (R2.1), and the smoke check smk every stage scope requires. The check `x` the finding names is given by the caller.
function store(t, x) {
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
  run(`INSERT INTO requirements (id, created_at, project, key, text_ref, status, criteria, sensitive_areas, assigned_phase) VALUES ('req_2', ?, 'prj_1', 'R2', 'r2', 'approved', '["R2.1"]', '[]', 2)`, AT);
  run(`INSERT INTO lineages (id, created_at, project, branch, started_from_candidate, open) VALUES ('lin_1', ?, 'prj_1', 'main', NULL, 0)`, AT);
  run(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, generation, active, status) VALUES ('plan_1', ?, 'prj_1', 1, ?, 'p1.json', 1, 1, 'completed')`, AT, A);
  run(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, generation, active, status) VALUES ('plan_2', ?, 'prj_1', 2, ?, 'p2.json', 1, 1, 'published')`, AT, A);
  item(db, 'wi_1', 'stage_build', { stage: 'stage_1' }, 'complete', { source: 'plan', id: 'stage_1' });
  item(db, 'wi_2', 'stage_build', { stage: 'stage_2' }, 'verifying', { source: 'plan', id: 'stage_2' });
  run(
    `INSERT INTO stages (id, created_at, project, phase_plan, number, goal, modules, requirement_ids, implements, status, work_item, integrated_revision)
     VALUES ('stage_1', ?, 'prj_1', 'plan_1', 1, 'g', '[]', '["req_1"]', '["req_1"]', 'verified', 'wi_1', ?)`,
    AT,
    A,
  );
  run(
    `INSERT INTO stages (id, created_at, project, phase_plan, number, goal, modules, requirement_ids, implements, status, work_item, integrated_revision)
     VALUES ('stage_2', ?, 'prj_1', 'plan_2', 1, 'g', '[]', '["req_2"]', '["req_2"]', 'integrated', 'wi_2', ?)`,
    AT,
    B,
  );
  check(db, 'chk_acc1', 'acc1', { kind: 'acceptance', criteria: '["R1.1"]', reqs: '["req_1"]', gates: '["stage","alpha_authorize"]' });
  check(db, 'chk_acc2', 'acc2', { kind: 'acceptance', criteria: '["R2.1"]', reqs: '["req_2"]', gates: '["stage","alpha_authorize"]' });
  check(db, 'chk_smk', 'smk', { kind: 'smoke', criteria: '[]', reqs: '[]', gates: '["stage","alpha_authorize"]' });
  if (x) check(db, 'chk_x', x.key, x);
  for (const [id, ref, kind, oid, immutable] of [
    ['ref_main', 'refs/heads/main', 'integration', B, 0],
    ['ref_c1', 'refs/surety/cand/1', 'nomination', A, 1],
    ['ref_c2', 'refs/surety/cand/2', 'nomination', B, 1],
  ]) {
    run('INSERT INTO ref_registry (id, created_at, project, ref, kind, expected_oid, immutable) VALUES (?, ?, ?, ?, ?, ?, ?)', id, AT, 'prj_1', ref, kind, oid, immutable);
  }
  candidate(db, 'cand_1', 1, A, ['wi_1'], 'lin_1');
  return db;
}

function candidate(db, id, seq, revision, held, lineage) {
  db.prepare(
    `INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, nominated_protected_version, progress, held_work)
     VALUES (?, ?, 'prj_1', ?, ?, ?, ?, 'engine_cadence', 'pv_1', 'developing', ?)`,
  ).run(id, AT, seq, revision, lineage, AT, JSON.stringify(held));
  if (revision !== A) db.prepare(`INSERT INTO revision_ancestry (id, created_at, project, ancestor, descendant, is_ancestor) VALUES (?, ?, 'prj_1', ?, ?, 1)`).run(`anc_${id}`, AT, A, revision);
}

function check(db, id, key, { kind, criteria, reqs, gates }) {
  db.prepare(
    `INSERT INTO checks (id, created_at, project, key, protected_version, kind, required, gate_kinds, definition_path, definition_hash, runner_class, criteria, requirement_ids, origin)
     VALUES (?, ?, 'prj_1', ?, 'pv_1', ?, 1, ?, ?, 'h', 'direct', ?, ?, 'acceptance')`,
  ).run(id, AT, key, kind, gates, `.surety/checks/defs/${key}.json`, criteria, reqs);
}

let seq = 100;
function item(db, id, kind, subject, status, trigger = { source: 'test', id }) {
  db.prepare(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, depends_on, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold, chain)
     VALUES (?, ?, 'prj_1', ?, ?, ?, ?, '[]', ?, ?, 1, 0, 0, 0, 0, 0)`,
  ).run(id, AT, ++seq, kind, JSON.stringify(subject), status, trigger.source, trigger.id);
}

// The phase-1 Verifier's finding on candidate 1, dispositioned fix by the owner.
function finding(db, { check: key, criterion = null, category = 'security' }) {
  db.prepare(
    `INSERT INTO findings (id, created_at, project, seq, scope, subject_id, candidate, category, message, "check", criterion, proposed_severity, effective_severity, status)
     VALUES ('fnd_1', ?, 'prj_1', 1, 'candidate', 'cand_1', 'cand_1', ?, 'm', ?, ?, 'medium', 'medium', 'open')`,
  ).run(AT, category, key, criterion);
  const row = db.prepare(`SELECT * FROM findings WHERE id = 'fnd_1'`).get();
  transact(db, ENGINE_ACTOR, (tx) => recordDisposition(tx, row, { disposition: 'fix', authority: 'human', by: 'human', linked_issue: null, defer_target: null }));
  const fix = db.prepare(`SELECT * FROM work_items WHERE kind = 'fix' AND json_extract(subject, '$.finding') = 'fnd_1'`).get();
  assert.ok(fix, 'the fix disposition made fix work');
  return fix;
}

// The fix integrated after phase 1 completed: candidate 2 holds phase 2's
// stage and the fix; the fix waits for its verification.
function fixCandidate(db, fix) {
  db.prepare(`INSERT INTO lineages (id, created_at, project, branch, started_from_candidate, open) VALUES ('lin_2', ?, 'prj_1', 'main', 'cand_1', 0)`).run(AT);
  candidate(db, 'cand_2', 2, B, ['wi_2', fix.id], 'lin_2');
  db.prepare(`UPDATE candidates SET superseded_by = 'cand_2' WHERE id = 'cand_1'`).run();
  db.prepare(`UPDATE work_items SET status = 'verifying' WHERE id = ?`).run(fix.id);
}

const post = (db, chk, cand, exit) => transact(db, ENGINE_ACTOR, (tx) => recordCheckResult(tx, { project: 'prj_1', check: chk, candidate: cand, exit_status: exit }, {})).check_result;
const stageGate = (db) =>
  transact(db, ENGINE_ACTOR, (tx) =>
    evaluateGate(tx, {
      project: 'prj_1',
      candidate: 'cand_2',
      kind: 'stage',
      stage: 'stage_2',
      headFingerprint: 'fp',
      head: B,
      refs: [
        { ref: 'refs/heads/main', read: 'value', oid: B },
        { ref: 'refs/surety/cand/2', read: 'value', oid: B },
      ],
    }),
  ).evaluation;
const statusOf = (db, table, id) => db.prepare(`SELECT status FROM ${table} WHERE id = ?`).get(id).status;
const findingReasons = (ev) => ev.reasons.filter((r) => r.code.startsWith('FINDING_'));

// The loop-6 shape and the stage-scope shape of the same gap.
const NO_CRITERION = [
  ['a phase-only and deployment check (the loop-6 security-server)', { key: 'security-server', kind: 'security_lint', criteria: '[]', reqs: '[]', gates: '["phase","alpha_authorize"]' }],
  ["a check phase 1's stage scope required (covering no criterion, for R1)", { key: 'x-smoke', kind: 'smoke', criteria: '[]', reqs: '["req_1"]', gates: '["stage"]' }],
];

for (const [label, x] of NO_CRITERION) {
  test(`a fix finding naming ${label}, no criterion: phase 2's stage gate, whose scope lacks it, resolves the finding once it passes after the disposition, and the fix completes`, (t) => {
    const db = store(t, x);
    post(db, 'chk_acc1', 'cand_1', 0);
    post(db, 'chk_x', 'cand_1', 1);
    const fix = finding(db, { check: x.key });
    assert.deepEqual(
      db.prepare(`SELECT id FROM work_items WHERE kind = 'check_correction'`).all(),
      [],
      'the check can verify the finding: no check_correction is routed',
    );
    fixCandidate(db, fix);
    post(db, 'chk_acc1', 'cand_2', 0);
    post(db, 'chk_acc2', 'cand_2', 0);
  post(db, 'chk_smk', 'cand_2', 0);
    post(db, 'chk_smk', 'cand_2', 0);

    // Before the check passes on the fix's candidate: unresolved, the gate held.
    const before = stageGate(db);
    assert.ok(!('chk_x' in before.check_states), `${x.key} is not in phase 2's stage scope (${JSON.stringify(before.check_states)})`);
    assert.deepEqual(findingReasons(before), [{ code: 'FINDING_UNSATISFIED', subjects: ['fnd_1'] }]);
    assert.deepEqual(before.missing_verifications, [], 'no missing verification: the check verifies it in another scope');
    assert.equal(statusOf(db, 'findings', 'fnd_1'), 'dispositioned');
    assert.equal(statusOf(db, 'work_items', fix.id), 'verifying');

    // The check passes on the fix's candidate after the disposition.
    const result = post(db, 'chk_x', 'cand_2', 0);
    const after = stageGate(db);
    assert.deepEqual(findingReasons(after), [], `no finding holds the gate (${JSON.stringify(after.reasons)})`);
    assert.equal(after.outcome, 'satisfied', JSON.stringify(after.reasons));
    const row = db.prepare(`SELECT * FROM findings WHERE id = 'fnd_1'`).get();
    assert.equal(row.status, 'resolved');
    assert.deepEqual(JSON.parse(row.resolution_verification), { evaluation: after.id, check_result: result.id ?? result });
    assert.equal(statusOf(db, 'work_items', fix.id), 'complete', 'the fix completes with its finding');
  });
}

test('the same check failing on the fix candidate after the disposition resolves nothing at the later stage gate', (t) => {
  const db = store(t, NO_CRITERION[0][1]);
  post(db, 'chk_acc1', 'cand_1', 0);
  post(db, 'chk_x', 'cand_1', 1);
  const fix = finding(db, { check: 'security-server' });
  fixCandidate(db, fix);
  post(db, 'chk_acc1', 'cand_2', 0);
  post(db, 'chk_acc2', 'cand_2', 0);
  post(db, 'chk_smk', 'cand_2', 0);
  post(db, 'chk_x', 'cand_2', 1);
  const ev = stageGate(db);
  assert.deepEqual(findingReasons(ev), [{ code: 'FINDING_UNSATISFIED', subjects: ['fnd_1'] }]);
  assert.equal(statusOf(db, 'findings', 'fnd_1'), 'dispositioned');
  assert.notEqual(statusOf(db, 'work_items', fix.id), 'complete');
});

test('a criterion-bearing fix finding whose check covers a phase-1 criterion is resolved at phase 2 stage gate by that check passing on the candidate after the disposition', (t) => {
  const db = store(t, null);
  post(db, 'chk_acc1', 'cand_1', 1);
  const fix = finding(db, { check: 'acc1', criterion: 'R1.1', category: 'defect' });
  fixCandidate(db, fix);
  post(db, 'chk_acc2', 'cand_2', 0);
  post(db, 'chk_smk', 'cand_2', 0);
  const before = stageGate(db);
  assert.deepEqual(findingReasons(before), [{ code: 'FINDING_UNSATISFIED', subjects: ['fnd_1'] }]);
  const result = post(db, 'chk_acc1', 'cand_2', 0);
  const after = stageGate(db);
  assert.deepEqual(findingReasons(after), [], JSON.stringify(after.reasons));
  const row = db.prepare(`SELECT * FROM findings WHERE id = 'fnd_1'`).get();
  assert.equal(row.status, 'resolved');
  assert.equal(JSON.parse(row.resolution_verification).check_result, result.id ?? result);
  assert.equal(statusOf(db, 'work_items', fix.id), 'complete');
});
