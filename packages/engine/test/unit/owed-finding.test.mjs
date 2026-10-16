// Developer test for the driver's ruling on the real M444 run's silent stall:
// a phase-2 Architect replan raised a project-scope contract_conflict with no
// candidate in a T1 project; no review would ever come, and the sweep asked
// only after a review of the finding's candidate. Now a finding is owed to
// the owner (finding_disposition, scope disposition_owed) whenever no review
// will come: (b) it names no candidate, (c) its source is not a Verifier or
// a Reviewer, (d) its candidate's tier queues no engine review (the rule
// queueReview applies; objection 117 upheld, SEAM.md §466), (e) a phase
// verification raised it, (f) its candidate's review has already reported
// and none is still to come (the driver's ruling on real loop run 3). A
// Verifier's or Reviewer's finding on a reviewed tier still waits for a
// review still to report. Against a scratch store, foreign keys off, the
// rows the minimum each read needs.

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
const { tierQueuesReview } = await import(join(dist, 'store', 'transitions', 'gates.js'));

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
const cand = (db) => db.prepare(`SELECT * FROM candidates WHERE id = 'cand_1'`).get();

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
  assert.equal(tierQueuesReview(s.db, cand(s.db), 'pv_1'), true, 'T2 queues the review');
  s.finding('fnd_c1', { role: 'architect' });
  s.finding('fnd_c2', { role: 'spec_writer' });
  s.finding('fnd_c3', { role: null, category: 'security' });
  assert.equal(sweep(s.db), 3);
  for (const id of ['fnd_c1', 'fnd_c2', 'fnd_c3']) assert.equal(owed(s.db, id).length, 1, id);
});

test("(d) a Verifier's candidate finding in a tier that queues no engine review (T1) is owed at once", (t) => {
  const s = store(t, { tier: 'T1' });
  assert.equal(tierQueuesReview(s.db, cand(s.db), 'pv_1'), false, 'T1 queues no review');
  s.finding('fnd_d', { role: 'verifier', category: 'defect' });
  assert.equal(sweep(s.db), 1);
  assert.deepEqual(JSON.parse(owed(s.db, 'fnd_d')[0].options).map((o) => o.key), ['lower_and_accept'], 'High, naming no check: owed-blocking.test.mjs');
});

test("a candidate-scoped Reviewer's or Verifier's finding on a reviewed tier is NOT asked before its review reports", (t) => {
  const s = store(t, { tier: 'T2' });
  s.finding('fnd_r', { role: 'reviewer' });
  s.finding('fnd_v', { role: 'verifier', category: 'defect' });
  assert.equal(sweep(s.db), 0);
  assert.equal(owed(s.db, 'fnd_r').length + owed(s.db, 'fnd_v').length, 0);
});

test('unknown is not "no review": with no effective version the tier is unread, and a T1 Verifier finding waits', (t) => {
  const s = store(t, { tier: 'T1', effective: false });
  s.finding('fnd_u', { role: 'verifier', category: 'defect' });
  assert.equal(sweep(s.db), 0);
});

// A review item is the engine's (queueReview's trigger (verification, <candidate>)).
let itemSeq = 90;
const item = (s, id, kind, status, subject = { candidate: 'cand_1' }) =>
  s.db
    .prepare(
      `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
       VALUES (?, ?, 'prj_1', ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`,
    )
    .run(id, AT, ++itemSeq, kind, JSON.stringify(subject), status, kind === 'review' ? 'verification' : 'test', kind === 'review' ? 'cand_1' : id, itemSeq);

test("(d) narrowed: a T1 candidate a review work item is on, still to report (M42's and M50's shape), is one a review comes to; its Reviewer's finding waits", (t) => {
  const s = store(t, { tier: 'T1' });
  item(s, 'wi_rev', 'review', 'executing');
  s.finding('fnd_n', { role: 'reviewer', category: 'defect' });
  assert.equal(sweep(s.db), 0);
  // (b) is untouched by it: a finding naming no candidate is still owed.
  s.finding('fnd_nb', { role: 'verifier', scope: 'project', candidate: null });
  assert.equal(sweep(s.db), 1);
  assert.equal(owed(s.db, 'fnd_nb').length, 1);
});

test("(f) a Verifier's finding on a T2 candidate whose review has already reported (complete, none still to come) is owed: no later review sees it", (t) => {
  const s = store(t, { tier: 'T2' });
  item(s, 'wi_rev', 'review', 'complete');
  s.finding('fnd_f', { role: 'verifier', category: 'defect' });
  assert.equal(sweep(s.db), 1);
  assert.equal(owed(s.db, 'fnd_f').length, 1);
});

test('(f) not while a review of the candidate is still to report', (t) => {
  const s = store(t, { tier: 'T2' });
  item(s, 'wi_rev', 'review', 'complete');
  item(s, 'wi_rev2', 'review', 'eligible');
  s.finding('fnd_f2', { role: 'verifier', category: 'defect' });
  assert.equal(sweep(s.db), 0);
});

test("(e) a phase Verifier's finding is owed at once, whatever the candidate's review (D6 §5.8; D6-F02)", (t) => {
  const s = store(t, { tier: 'T2' });
  item(s, 'wi_rev', 'review', 'executing');
  // The finding's run is on wi_run_fnd_e (store's runOf): a phase verification.
  item(s, 'wi_run_fnd_e', 'phase_verification', 'executing', { candidate: 'cand_1', phase_plan: 'plan_1' });
  s.finding('fnd_e', { role: 'verifier', category: 'hygiene' });
  assert.equal(sweep(s.db), 1);
  assert.equal(owed(s.db, 'fnd_e').length, 1);
});
