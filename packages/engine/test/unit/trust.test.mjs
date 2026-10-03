// Developer tests for the trust table (D2 §§4.1, 4.2, 7.1, 7.2, K10, A.3,
// A.4; rows M101 to M103, M109): what the store refuses, the two decisions
// and what answering them does, and the dispatch rule. Against a scratch
// store with the engine's migrations.

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
const { answerQueued, reviewDecisions } = await import(join(dist, 'store', 'transitions', 'queue.js'));
const trust = await import(join(dist, 'store', 'transitions', 'trust.js'));
const { proposeEntry, proposeAttempt } = await import(join(dist, 'store', 'transitions', 'qualification.js'));
const { hostIdentity, ISOLATION_MECHANISM, BOUNDARY_MECHANISM } = await import(join(dist, 'trust', 'host.js'));

const HUMAN = { actor_kind: 'human', actor_id: null, request_id: null };
const AT = '2026-10-03T00:00:00.000Z';

function settings(extra = {}) {
  setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, ...extra });
}

function store(t) {
  settings();
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
  run(`INSERT INTO engine_incarnations (id, created_at, pid, started_at, host_boot_id) VALUES ('inc_1', ?, 1, ?, 'boot')`, AT, AT);
  for (const id of ['rec_E1', 'rec_E2', 'rec_B1']) {
    run(
      `INSERT INTO records (id, created_at, project, kind, path, sha256, bytes, redaction_version, published, post_scan) VALUES (?, ?, 'prj_1', 'qualification_evidence', ?, ?, 1, 'r1', 1, 'clean')`,
      id,
      AT,
      id,
      'a'.repeat(64),
    );
  }
  return db;
}

const hostRow = (db, incarnation = 'inc_1', mechanism = 'mech-1') =>
  transact(db, ENGINE_ACTOR, (tx) =>
    trust.recordHostQualification(tx, { incarnation, host_id: hostIdentity(), kernel: 'k', tool_versions: {}, mechanism_fingerprint: mechanism, checks: [], probes: [], evidence: 'rec_E1' }),
  );

const attemptInput = (hq) => ({
  backend: 'claude',
  version: '2.1.288',
  binary_path: '/opt/claude',
  binary_sha256: '1'.repeat(64),
  help_sha256: '2'.repeat(64),
  template: 't',
  template_version: '1',
  model: 'm',
  auth_mode: 'api_key',
  host_qualification: hq,
  profile_fingerprint: 'prof-1',
  fixture_project: 'prj_1',
  candidate_egress: ['api.example.com'],
  canary_deadlines: { positive: 600, cancellation: 600, containment: 600 },
  spend: { cap: null, estimate: 1, label: 'estimate', overshoot: 'deadline' },
});

function entryInput(hq, attempt, over = {}) {
  return {
    backend: 'claude',
    version: '2.1.288',
    binary_path: '/opt/claude',
    binary_sha256: '1'.repeat(64),
    help_sha256: '2'.repeat(64),
    mode: 'one_shot_headless',
    template: 't',
    template_version: '1',
    model: 'm',
    auth_mode: 'api_key',
    capabilities: { tools: ['Read'], denied: ['Agent'], features_disabled: [], delegation_verified: true },
    host_id: hostIdentity(),
    host_qualification: hq,
    isolation: ISOLATION_MECHANISM,
    boundary: BOUNDARY_MECHANISM,
    profile_fingerprint: 'prof-1',
    egress_hosts: ['api.example.com'],
    usage_granularity: 'model_call',
    usage_semantics: 'cumulative',
    cost_reporting: 'reported',
    enforceable_boundaries: [{ boundary: 'invocation', mechanism: 'dispatch_check', evidence: 'rec_B1', overshoot: 'deadline' }],
    result_channel: 'file',
    session_qualified: false,
    provider_files: { locations: [], persistence_flags: [], excluded: [] },
    term_to_exit_ms: null,
    qualification_attempt: attempt,
    evidence: ['rec_E1', 'rec_E2'],
    ...over,
  };
}

function proposed(db, over = {}, label = { test_fixture: true }) {
  const hq = trust.currentHostQualification(db)?.id ?? hostRow(db).id;
  return transact(db, ENGINE_ACTOR, (tx) => {
    const { attempt } = proposeAttempt(tx, attemptInput(hq), label);
    return proposeEntry(tx, entryInput(hq, attempt.id, over), label);
  });
}

const decision = (db, id) => db.prepare('SELECT * FROM decisions WHERE id = ?').get(id);
const entry = (db, id) => db.prepare('SELECT * FROM trust_entries WHERE id = ?').get(id);
const answer = (db, id, option, preview) =>
  transact(db, HUMAN, (tx) => answerQueued(tx, { project: null, decision: id, option, preview_hash: preview ?? decision(db, id).preview_hash, note: null, facts: {} }));

test('an entry is written proposed; the store refuses active without the consumed trust_activation, session mode active, and another isolation', (t) => {
  const db = store(t);
  const { entry: e, decision: d } = proposed(db);
  assert.equal(e.status, 'proposed');
  assert.ok(d, 'trust_activation is raised');
  assert.throws(() => db.prepare(`UPDATE trust_entries SET status = 'active' WHERE id = ?`).run(e.id), /CHECK constraint|activated_by|trust_activation/);
  assert.throws(() => db.prepare(`UPDATE trust_entries SET status = 'active', activated_by = ? WHERE id = ?`).run(d, e.id), /consumed trust_activation/);
  assert.throws(() => db.prepare(`UPDATE trust_entries SET isolation = 'none' WHERE id = ?`).run(e.id), /CHECK constraint|does not change/);
  assert.throws(() => db.prepare(`UPDATE trust_entries SET template = 'other' WHERE id = ?`).run(e.id), /does not change/);
  assert.throws(() => db.prepare('DELETE FROM trust_entries WHERE id = ?').run(e.id), /never deleted/);
  assert.throws(() => proposed(db, { isolation: 'scripted_boundary' }), (err) => err.code === 'invalid_value');
  // A session-mode entry can be written and is never asked about or made
  // active (D2 §1.8), even with a consumed decision naming it.
  const { entry: s, decision: sd } = proposed(db, { mode: 'session_headless' });
  assert.equal(sd, null);
  db.prepare(
    `INSERT INTO decisions (id, created_at, project, seq, kind, subject_type, subject_id, semantic_generation, scope, question, options, dependency_manifest,
       transition_schema_version, preview_hash, evidence, blocked_while_open, raised_at, status)
     VALUES ('dec_X', ?, NULL, 999, 'trust_activation', 'trust_entry', ?, 1, 'subject', 'q', '[]', '{}', 1, 'h', '[]', '{}', ?, 'consumed')`,
  ).run(AT, s.id, AT);
  assert.throws(() => db.prepare(`UPDATE trust_entries SET status = 'active', activated_by = 'dec_X' WHERE id = ?`).run(s.id), /CHECK constraint/);
});

test('trust_activation: approval activates with activated_by and trust.activated, launching nothing; reject leaves proposed; a second answer is consumed', (t) => {
  const db = store(t);
  const { entry: e, decision: d } = proposed(db);
  const runsBefore = db.prepare('SELECT COUNT(*) AS n FROM runs').get().n;
  const result = answer(db, d, 'approve');
  assert.equal(result.status, 200);
  assert.deepEqual(result.effects ?? [], [], 'no effect: nothing is launched');
  const after = entry(db, e.id);
  assert.equal(after.status, 'active');
  assert.equal(after.activated_by, d);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'trust.activated'`).get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, runsBefore);
  assert.throws(() => answer(db, d, 'approve'), (err) => err.code === 'decision_consumed');

  const { entry: r, decision: rd } = proposed(db);
  answer(db, rd, 'reject');
  assert.equal(entry(db, r.id).status, 'proposed');
  transact(db, ENGINE_ACTOR, (tx) => reviewDecisions(tx, { project: null, channel: 'none' }));
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE kind = 'trust_activation' AND subject_id = ? AND status = 'open'`).get(r.id).n, 0, 'not raised again');
});

test('trust_activation is stale when the host qualification lapsed or an evidence record changed between preview and answer', (t) => {
  const db = store(t);
  const { entry: e, decision: d } = proposed(db);
  const preview = decision(db, d).preview_hash;
  // A restart lapses the host qualification.
  transact(db, ENGINE_ACTOR, (tx) => trust.lapseEarlierQualifications(tx, 'inc_2'));
  assert.throws(() => answer(db, d, 'approve', preview), (err) => err.code === 'decision_stale');
  assert.equal(entry(db, e.id).status, 'proposed');

  const second = store(t);
  const { entry: e2, decision: d2 } = proposed(second);
  const p2 = decision(second, d2).preview_hash;
  assert.equal(decision(second, d2).project, null, 'an engine-scoped decision');
  // The audit at a start found an evidence record's bytes not as recorded.
  second.prepare(`UPDATE records SET missing_at = ? WHERE id = 'rec_E1'`).run(AT);
  assert.throws(() => answer(second, d2, 'approve', p2), (err) => err.code === 'decision_stale');
  assert.equal(entry(second, e2.id).status, 'proposed');
});

test('an entry whose usage is not reported is never asked about; a finer boundary needs admission control and evidence', (t) => {
  const db = store(t);
  const { entry: e, decision: d } = proposed(db, { usage_granularity: 'none', enforceable_boundaries: [] });
  assert.equal(d, null);
  assert.equal(e.status, 'proposed');
  assert.throws(() => proposed(db, { enforceable_boundaries: [{ boundary: 'model_turn', mechanism: 'dispatch_check', evidence: 'rec_B1', overshoot: 'x' }] }), (err) => err.code === 'invalid_value');
  assert.throws(() => proposed(db, { enforceable_boundaries: [{ boundary: 'model_turn', mechanism: 'admission_control', evidence: null, overshoot: 'x' }] }), (err) => err.code === 'invalid_value' && err.subject.field === 'enforceable_boundaries');
  const ok = proposed(db, { enforceable_boundaries: [{ boundary: 'model_turn', mechanism: 'admission_control', evidence: 'rec_B1', overshoot: 'none after exhaustion' }] });
  assert.equal(ok.entry.status, 'proposed');
});

test('host qualifications: one active; a later start lapses it; a lapsed row is never reactivated; none active under the bootstrap exception', (t) => {
  const db = store(t);
  const first = hostRow(db);
  assert.equal(first.status, 'active');
  const second = hostRow(db);
  assert.equal(db.prepare('SELECT status FROM host_qualifications WHERE id = ?').get(first.id).status, 'lapsed');
  assert.equal(second.status, 'active');
  assert.throws(() => db.prepare(`UPDATE host_qualifications SET status = 'active' WHERE id = ?`).run(first.id), /never reactivated|UNIQUE/);
  settings({ ui_bootstrap: true });
  t.after(() => settings());
  const third = hostRow(db);
  assert.equal(third.status, 'lapsed');
  assert.equal(third.bootstrap_exception, 1);
  assert.equal(trust.currentHostQualification(db).id, second.id, 'the exception lapses nothing and activates nothing');
});

test('the dispatch rule: scripted only in harness; a named backend needs an active one-shot entry, an enforceable boundary and a current compatible host', (t) => {
  const db = store(t);
  const setPolicy = (effective) => {
    db.prepare(
      `INSERT INTO policy_revisions (id, created_at, project, revision, git_path, git_blob, changed_by, changed_at, diff_summary, widens_authority, committed, effective)
       VALUES (?, ?, 'prj_1', ?, '.surety/policy.json', 'b', 'test', ?, '', 0, 1, ?)`,
    ).run(`pr_${effective.n}`, AT, effective.n, AT, JSON.stringify(effective.p));
    db.prepare('UPDATE projects SET policy_revision = ? WHERE id = ?').run(`pr_${effective.n}`, 'prj_1');
  };
  const resolve = (scripted = 'scripted-1') => trust.resolveBackend(db, { project: 'prj_1', role: 'builder', scripted });
  assert.equal(resolve().kind, 'scripted');
  assert.equal(resolve(null).code, 'backend_refused');

  setPolicy({ n: 1, p: { backend_builder: 'claude' } });
  assert.equal(resolve().code, 'backend_refused', 'no entry');
  const { entry: e, decision: d } = proposed(db);
  assert.equal(resolve().code, 'backend_refused', 'a proposed entry');
  assert.equal(trust.hostReport(db).eligible, true, 'the host qualification row makes the host eligible outside harness mode');
  // K10: an authorized attempt is no authority for project work.
  db.prepare(`UPDATE qualification_attempts SET status = 'authorized'`).run();
  assert.equal(resolve().code, 'backend_refused', 'an authorized attempt');
  answer(db, d, 'approve');
  assert.equal(resolve().kind, 'entry');

  setPolicy({ n: 2, p: { backend_builder: 'claude', backend_mode: 'session_headless' } });
  assert.equal(resolve().code, 'backend_refused', 'session mode, no fallback');

  setPolicy({ n: 3, p: { backend_builder: 'claude', budget_run_boundary: 'model_turn' } });
  const refused = resolve();
  assert.equal(refused.code, 'budget_boundary_unenforceable');
  assert.equal(refused.subject.overshoot.bounded_by, 'deadline');
  assert.deepEqual(refused.subject.enforceable_boundaries.map((b) => b.boundary), ['invocation']);

  setPolicy({ n: 4, p: { backend_builder: 'claude' } });
  transact(db, ENGINE_ACTOR, (tx) => trust.lapseEarlierQualifications(tx, 'inc_2'));
  assert.equal(resolve().code, 'isolation_unqualified', 'no current host qualification');
  db.prepare(`INSERT INTO engine_incarnations (id, created_at, pid, started_at, host_boot_id) VALUES ('inc_2', ?, 1, ?, 'boot')`).run(AT, AT);
  hostRow(db, 'inc_2', 'mech-1');
  assert.equal(resolve().kind, 'entry', 'a qualified restart restores dispatch');

  transact(db, ENGINE_ACTOR, (tx) => trust.revokeEntry(tx, trust.getEntry(db, e.id), 'binary changed'));
  assert.equal(resolve().code, 'backend_refused', 'a revoked entry');
});

test('the engine read lists only backends with active entries, and scripted only in harness mode', (t) => {
  const db = store(t);
  assert.deepEqual(trust.trustView(db, { scripted: false }).backends, []);
  assert.deepEqual(trust.trustView(db, { scripted: true }).backends, ['scripted']);
  const { decision: d } = proposed(db);
  assert.deepEqual(trust.trustView(db, { scripted: false }).backends, []);
  answer(db, d, 'approve');
  const view = trust.trustView(db, { scripted: false });
  assert.deepEqual(view.backends, ['claude']);
  assert.deepEqual(view.trust_entries[0].enforceable_boundaries, [{ boundary: 'invocation', mechanism: 'dispatch_check', evidence: 'rec_B1', overshoot: 'deadline' }]);
  assert.deepEqual([view.host_qualification.source, view.host_qualification.eligible], ['qualification', true]);
  assert.ok(view.host_qualification.checks.every((c) => c.result === 'not_exercised'), 'no check is reported passed');
});
