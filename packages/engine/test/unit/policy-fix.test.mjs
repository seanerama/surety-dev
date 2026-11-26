// Developer tests for D3 (DECISIONS item 57; the owner's ruling of
// 2026-11-26: "Use the brief's existing repair, token, and spend
// allowances for verifiable defects within scope. Preserve the finding, the
// repair, and the verification result. Ask me if the allowance is
// exhausted, the repair exceeds scope, or success cannot be verified.
// Lowering, accepting, or deferring a finding remains an owner decision."):
// store/transitions/policy-fix.ts policyFix, as the owed question's sweep
// (findings.ts askUndispositioned) applies it. Against a scratch store,
// foreign keys off, the rows the minimum each read needs.

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
const { askUndispositioned } = await import(join(dist, 'store', 'transitions', 'findings.js'));
const { iterationAccount } = await import(join(dist, 'store', 'transitions', 'prototype.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });
const AT = '2026-11-26T00:00:00.000Z';
const REV = 'a'.repeat(40);

// A rapid prototype at T1: iteration it_1 building on its approved brief
// (spec revision sr_1), its repair allowance `repairs`; requirement R1
// (R1.1); one effective version with a required acceptance check `x`
// covering R1.1; candidate cand_1 nominated on sr_1; a Verifier run of the
// iteration raised finding fnd_1 (a defect on R1.1 naming x) on cand_1.
function store(t, { mode = 'rapid_prototype', repairs = 3, category = 'defect', criterion = 'R1.1', runIteration = 'it_1', exit = 1, result = true, severity = 'low' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  run(`INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management, mode) VALUES ('prj_1', ?, 'p', 'T1', '/repo', 'main', 'spec_ready', 'registered', '{}', ?)`, AT, mode);
  run(`INSERT INTO requirements (id, created_at, project, key, text_ref, status, criteria) VALUES ('req_1', ?, 'prj_1', 'R1', 'spec', 'approved', '["R1.1"]')`, AT);
  run(`INSERT INTO spec_revisions (id, created_at, project, version, git_path, git_blob, semantic_digest, approved_by, approved_at) VALUES ('sr_1', ?, 'prj_1', 1, 'spec.md', 'b', 'd', 'human', ?)`, AT, AT);
  run(
    `INSERT INTO prototype_iterations (id, created_at, project, seq, mode, status, limits_json, brief_spec_revision, brief_decision, approved_at) VALUES ('it_1', ?, 'prj_1', 1, 'rapid_prototype', 'building', ?, 'sr_1', 'dec_brief', ?)`,
    AT,
    JSON.stringify({ prototype_repairs_per_iteration: repairs }),
    AT,
  );
  run(`INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots, authorized_revision) VALUES ('pv_1', ?, 'prj_1', 1, 'f', 'initial', 'h', 'human', ?, 1, ?, '[]', 'r')`, AT, AT, AT);
  run(
    `INSERT INTO checks (id, created_at, project, key, protected_version, kind, required, gate_kinds, definition_path, definition_hash, runner_class, criteria)
     VALUES ('chk_x', ?, 'prj_1', 'x', 'pv_1', 'acceptance', 1, '["stage","alpha_authorize"]', '.surety/checks/defs/x.json', 'h', 'direct', '["R1.1"]')`,
    AT,
  );
  run(`INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress, spec_revision) VALUES ('cand_1', ?, 'prj_1', 1, ?, 'l', ?, 'engine_cadence', 'developing', 'sr_1')`, AT, REV, AT);
  if (result) {
    run(
      `INSERT INTO check_results (id, created_at, project, "check", candidate, source_revision, protected_version, runner_class, runner_id, execution_seq, execution_established, signaled, deadline_hit, exit_status)
       VALUES ('cr_1', ?, 'prj_1', 'chk_x', 'cand_1', ?, 'pv_1', 'direct', 'r', 1, 1, 0, 0, ?)`,
      AT,
      REV,
      exit,
    );
  }
  run(
    `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined, iteration, outcome)
     VALUES ('run_v', ?, 'prj_1', 1, 'wi_v', 'verifier', 'one_shot', 'ended', 'scripted', '1', 'm', ?, ?, 0, ?, 'completed')`,
    AT,
    REV,
    AT,
    runIteration,
  );
  run(
    `INSERT INTO findings (id, created_at, project, seq, scope, subject_id, candidate, source_run, source_role, category, message, "check", proposed_severity, effective_severity, severity_history, sensitive_area, status, reevaluations, criterion)
     VALUES ('fnd_1', ?, 'prj_1', 1, 'candidate', 'cand_1', 'cand_1', 'run_v', 'verifier', ?, 'the unit is printed after the diagrams', 'x', ?, ?, '[]', NULL, 'open', '[]', ?)`,
    AT,
    category,
    severity,
    severity,
    criterion,
  );
  return { db, run };
}

const sweep = (db) => transact(db, ENGINE_ACTOR, (tx) => askUndispositioned(tx, { project: 'prj_1' }));
const owed = (db) => db.prepare(`SELECT * FROM decisions WHERE kind = 'finding_disposition' AND subject_id = 'fnd_1' AND status = 'open'`).all();
const finding = (db) => db.prepare(`SELECT * FROM findings WHERE id = 'fnd_1'`).get();
const work = (db, kind) => db.prepare(`SELECT * FROM work_items WHERE kind = ? ORDER BY rowid`).all(kind);

test('(a) the check failed on the candidate: fix registered by policy at once, one repair unit spent, no question; never accept, defer or a severity change', (t) => {
  for (const severity of ['low', 'high']) {
    const s = store(t, { severity });
    assert.equal(sweep(s.db), 0, 'no question');
    const f = finding(s.db);
    assert.deepEqual([f.status, f.disposition, f.disposition_authority, f.disposition_by], ['dispositioned', 'fix', 'policy', 'policy:rapid_prototype'], severity);
    assert.equal(f.severity_history, '[]', 'no policy entry in the severity history');
    assert.equal(work(s.db, 'fix').length, 1, 'fix work registered');
    const acts = s.db.prepare(`SELECT * FROM delegated_actions WHERE kind = 'fix_registered'`).all();
    assert.equal(acts.length, 1);
    assert.deepEqual([acts[0].subject_id, acts[0].authorized_by, acts[0].performed_by, acts[0].iteration], ['fnd_1', 'dec_brief', 'policy:rapid_prototype', 'it_1']);
    assert.equal(JSON.parse(acts[0].basis).reproduced_by, 'cr_1', 'the failing result that reproduced it');
    assert.equal(iterationAccount(s.db, 'prj_1', 'it_1').repairs_used, 1, 'one unit of prototype_repairs_per_iteration');
    assert.equal(sweep(s.db), 0, 'again: nothing more');
    assert.equal(work(s.db, 'fix').length, 1);
  }
});

test('(b) the check passed on the candidate: no fix; the check correction routed to the Verifier; nobody asked while it is under way', (t) => {
  const s = store(t, { exit: 0 });
  assert.equal(sweep(s.db), 0);
  assert.equal(finding(s.db).status, 'open');
  const corrections = work(s.db, 'check_correction');
  assert.equal(corrections.length, 1);
  assert.deepEqual(JSON.parse(corrections[0].subject), { finding: 'fnd_1' });
  assert.equal(owed(s.db).length, 0);
  assert.equal(work(s.db, 'fix').length, 0);
  // (c) the correction ended and the check still passes: the owner's question, saying the repair could not be verified.
  s.run(`UPDATE work_items SET status = 'complete' WHERE id = ?`, corrections[0].id);
  assert.equal(sweep(s.db), 1);
  const [d] = owed(s.db);
  assert.match(JSON.parse(d.evidence).policy_fix_refused, /repair_unverifiable: every check covering R1.1 still passes on the candidate after the correction/);
  assert.equal(finding(s.db).disposition, null);
});

test('(d, e) refused: the allowance exhausted, a criterion outside the brief, another iteration\'s finding: the owner\'s question naming why; nothing registered', (t) => {
  const cases = [
    { opts: { repairs: 0 }, why: /repair_allowance_exhausted: prototype_repairs_per_iteration 0/ },
    { opts: { criterion: 'R9.1' }, why: /outside_brief/ },
    { opts: { runIteration: 'it_0' }, why: /not_this_iterations_verification/ },
    { opts: { result: false }, why: /repair_unverifiable: no result/ },
  ];
  for (const c of cases) {
    const s = store(t, c.opts);
    assert.equal(sweep(s.db), 1, String(c.why));
    const [d] = owed(s.db);
    assert.match(JSON.parse(d.evidence).policy_fix_refused, c.why);
    assert.equal(finding(s.db).disposition, null);
    assert.equal(work(s.db, 'fix').length, 0);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM delegated_actions').get().n, 0);
  }
  // The candidate is not the iteration's own (superseded).
  const s = store(t);
  s.run(`UPDATE candidates SET superseded_by = 'cand_2' WHERE id = 'cand_1'`);
  assert.equal(sweep(s.db), 1);
  assert.match(JSON.parse(owed(s.db)[0].evidence).policy_fix_refused, /subject_not_current_candidate/);
});

test('(f) a planned project, or a finding that is not a defect: asked as today, no policy evidence', (t) => {
  for (const opts of [{ mode: 'planned' }, { category: 'hygiene' }]) {
    const s = store(t, opts);
    assert.equal(sweep(s.db), 1);
    assert.deepEqual(JSON.parse(owed(s.db)[0].evidence), []);
  }
});

test('objection 236 option 1: X passed, the correction added Y covering the criterion beside it, Y failed on the candidate: F is bound to Y, X kept in its history, and fixed by policy', (t) => {
  const s = store(t, { exit: 0 });
  assert.equal(sweep(s.db), 0);
  const [corr] = work(s.db, 'check_correction');
  // The correction applied: a second required acceptance check y covering R1.1, failing on cand_1.
  s.run(`UPDATE work_items SET status = 'complete' WHERE id = ?`, corr.id);
  s.run(
    `INSERT INTO checks (id, created_at, project, key, protected_version, kind, required, gate_kinds, definition_path, definition_hash, runner_class, criteria)
     VALUES ('chk_y', ?, 'prj_1', 'y', 'pv_1', 'acceptance', 1, '["stage","alpha_authorize"]', '.surety/checks/defs/y.json', 'h', 'direct', '["R1.1"]')`,
    AT,
  );
  s.run(
    `INSERT INTO check_results (id, created_at, project, "check", candidate, source_revision, protected_version, runner_class, runner_id, execution_seq, execution_established, signaled, deadline_hit, exit_status)
     VALUES ('cr_y', ?, 'prj_1', 'chk_y', 'cand_1', ?, 'pv_1', 'direct', 'r', 2, 1, 0, 0, 1)`,
    AT,
    REV,
  );
  assert.equal(sweep(s.db), 0, 'no question');
  const f = finding(s.db);
  assert.deepEqual([f.check, f.disposition, f.disposition_authority], ['y', 'fix', 'policy']);
  const ev = JSON.parse(s.db.prepare(`SELECT payload FROM events WHERE type = 'finding.check_unbound'`).get().payload);
  assert.deepEqual([ev.check, ev.rebound_to, ev.cause, ev.check_result], ['x', 'y', 'reproduced_by_covering_check', 'cr_y']);
  const act = s.db.prepare(`SELECT * FROM delegated_actions WHERE kind = 'fix_registered'`).get();
  const basis = JSON.parse(act.basis);
  assert.deepEqual([basis.reproducing_check, basis.reproduced_by, basis.check_history.map((h) => h.check)], ['y', 'cr_y', ['x']]);
  assert.equal(JSON.parse(act.scope).check, 'y');
  assert.equal(work(s.db, 'fix').length, 1);
});

test('objection 236 option 1: the named check fails: it reproduces the finding, which keeps its check', (t) => {
  const s = store(t);
  s.run(
    `INSERT INTO checks (id, created_at, project, key, protected_version, kind, required, gate_kinds, definition_path, definition_hash, runner_class, criteria)
     VALUES ('chk_a', ?, 'prj_1', 'a', 'pv_1', 'acceptance', 1, '["stage","alpha_authorize"]', '.surety/checks/defs/a.json', 'h', 'direct', '["R1.1"]')`,
    AT,
  );
  s.run(
    `INSERT INTO check_results (id, created_at, project, "check", candidate, source_revision, protected_version, runner_class, runner_id, execution_seq, execution_established, signaled, deadline_hit, exit_status)
     VALUES ('cr_a', ?, 'prj_1', 'chk_a', 'cand_1', ?, 'pv_1', 'direct', 'r', 2, 1, 0, 0, 1)`,
    AT,
    REV,
  );
  assert.equal(sweep(s.db), 0);
  assert.equal(finding(s.db).check, 'x', 'the named check first, though a covering check sorting before it failed too');
  assert.equal(s.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'finding.check_unbound'`).get().n, 0);
});
