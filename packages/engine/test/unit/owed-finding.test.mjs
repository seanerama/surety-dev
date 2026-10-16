// Developer test for the driver's ruling on the real M444 run's silent stall:
// a phase-2 Architect replan raised a project-scope contract_conflict with no
// candidate in a T1 project; no review would ever come, and the sweep asked
// only after a review of the finding's candidate. Now a finding is owed to
// the owner (finding_disposition, scope disposition_owed) whenever no review
// will come: (b) it names no candidate, (c) its source is not a Verifier or
// a Reviewer. A Verifier's or Reviewer's finding on a candidate still waits
// for its review; (d), a T1 candidate's, waits on objection 117 (M105).
// Against a scratch store, foreign keys off, the rows the minimum each read
// needs.

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

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });
const AT = '2026-10-16T00:00:00.000Z';

function store(t, { tier, effective = true }) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  run(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', ?, '/repo', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
    tier,
  );
  if (effective) {
    run(`INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots, authorized_revision) VALUES ('pv_1', ?, 'prj_1', 1, 'f', 'initial', 'h', 'human', ?, 1, ?, '[]', 'r')`, AT, AT, AT);
  }
  run(`INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress) VALUES ('cand_1', ?, 'prj_1', 1, ?, 'l', ?, 'engine_cadence', 'developing')`, AT, 'a'.repeat(40), AT);
  let seq = 0;
  // A run still under way: no review of anything has reported.
  const runOf = (id, role) =>
    run(
      `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined)
       VALUES (?, ?, 'prj_1', ?, 'wi_' || ?, ?, 'one_shot', 'validating', 'scripted', '1', 'm', ?, ?, 0)`,
      id,
      AT,
      ++seq,
      id,
      role,
      'a'.repeat(40),
      AT,
    );
  const finding = (id, { role, scope = 'candidate', candidate = 'cand_1', category = 'contract_conflict' }) => {
    if (role) runOf(`run_${id}`, role);
    run(
      `INSERT INTO findings (id, created_at, project, seq, scope, subject_id, candidate, source_run, source_role, category, message, "check", proposed_severity, effective_severity, severity_history, sensitive_area, status, reevaluations, criterion)
       VALUES (?, ?, 'prj_1', ?, ?, ?, ?, ?, ?, ?, 'the plan names an interface the spec does not', NULL, 'high', 'high', '[]', NULL, 'open', '[]', NULL)`,
      id,
      AT,
      ++seq,
      scope,
      scope === 'project' ? 'prj_1' : (candidate ?? 'prj_1'),
      candidate,
      role ? `run_${id}` : null,
      role,
      category,
    );
  };
  return { db, finding };
}

const sweep = (db) => transact(db, ENGINE_ACTOR, (tx) => askUndispositioned(tx, { project: 'prj_1' }));
const owed = (db, id) => db.prepare(`SELECT * FROM decisions WHERE kind = 'finding_disposition' AND subject_id = ? AND scope = 'disposition_owed' AND status = 'open'`).all(id);

test('(b) a finding naming no candidate is owed at once, even on a reviewed tier and from a Verifier', (t) => {
  const s = store(t, { tier: 'T2' });
  s.finding('fnd_b', { role: 'verifier', scope: 'project', candidate: null });
  assert.equal(sweep(s.db), 1);
  const [d] = owed(s.db, 'fnd_b');
  assert.deepEqual(JSON.parse(d.options).map((o) => o.key), ['change_spec', 'lower_and_accept'], 'a High conflict naming no check: change_spec, or lower and accept (owed-blocking.test.mjs)');
  assert.equal(sweep(s.db), 0, 'asked once');
});

test("(b)+(c) the real M444 shape: an Architect replan's project-scope contract_conflict with no candidate, in a T1 project", (t) => {
  const s = store(t, { tier: 'T1' });
  s.finding('fnd_arch', { role: 'architect', scope: 'project', candidate: null });
  assert.equal(sweep(s.db), 1);
  assert.equal(owed(s.db, 'fnd_arch').length, 1);
});

test("(c) a finding whose source is not a Verifier or a Reviewer is owed at once, though it names a reviewed tier's candidate; an engine-origin one (no role) too", (t) => {
  const s = store(t, { tier: 'T2' });
  s.finding('fnd_c1', { role: 'architect' });
  s.finding('fnd_c2', { role: 'spec_writer' });
  s.finding('fnd_c3', { role: null, category: 'security' });
  assert.equal(sweep(s.db), 3);
  for (const id of ['fnd_c1', 'fnd_c2', 'fnd_c3']) assert.equal(owed(s.db, id).length, 1, id);
});

test("a candidate-scoped Reviewer's or Verifier's finding on a reviewed tier is NOT asked before its review reports", (t) => {
  const s = store(t, { tier: 'T2' });
  s.finding('fnd_r', { role: 'reviewer' });
  s.finding('fnd_v', { role: 'verifier', category: 'defect' });
  assert.equal(sweep(s.db), 0);
  assert.equal(owed(s.db, 'fnd_r').length + owed(s.db, 'fnd_v').length, 0);
});
