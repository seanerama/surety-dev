// Developer test for the driver's ruling on loop run 1: a deferred authoring
// parked after 4 runs, each refused whole because its finding named the
// check r10-1-inputs that the same result's proposal added. Now, in a
// Verifier's result that carries a protected proposal, a finding may name a
// check that proposal adds: collection defers the key (invoke/choke.ts),
// acceptance judges it against the proposal's tree (runs/report.ts
// proposedCheckRefusal), and the reference is bound when the proposal is
// decided (store/transitions/protected.ts settleProposalFindings): applied
// with the check, it stands; rejected, or applied without it, the finding
// stands with check null, recorded. A key neither existing nor proposed is
// still refused.

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
const { settleProposalFindings } = await import(join(dist, 'store', 'transitions', 'protected.js'));
const { applicationConflicts } = await import(join(dist, 'store', 'transitions', 'classification.js'));
const { unknownCheck } = await import(join(dist, 'invoke', 'choke.js'));
const { proposesChecks, proposedCheckRefusal } = await import(join(dist, 'runs', 'report.js'));
const { resultSchema } = await import(join(dist, 'invoke', 'sandbox', 'context.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });
const AT = '2026-10-16T00:00:00.000Z';

const result = (check, proposal = { rationale: 'adds r10-1-inputs', requested_change_kind: 'tightening' }) => ({
  summary: 's',
  checkpoint: false,
  nominate: false,
  report: { findings: [{ category: 'defect', severity: 'medium', message: 'k max 0.1, R10.1 needs 0.5', check, criterion: 'R10.1' }], ...(proposal ? { proposal } : {}) },
});

test('collection: a Verifier result carrying a proposal defers a key outside the version; without a proposal, or from a Reviewer, it is refused as before', () => {
  const keys = ['login', 'r12-physics-independent'];
  const r = result('r10-1-inputs');
  assert.equal(proposesChecks('verifier', r), true);
  assert.equal(unknownCheck(r, keys, ['R10.1'], proposesChecks('verifier', r)), null, 'deferred to acceptance');
  assert.equal(proposesChecks('reviewer', r), false);
  assert.match(unknownCheck(r, keys, ['R10.1'], proposesChecks('reviewer', r)), /which is not a check of the project/);
  const bare = result('r10-1-inputs', null);
  assert.equal(proposesChecks('verifier', bare), false);
  assert.match(unknownCheck(bare, keys, ['R10.1'], proposesChecks('verifier', bare)), /which is not a check of the project/);
  // The criterion is still judged at collection.
  assert.match(unknownCheck(result('r10-1-inputs'), keys, ['R1.1'], true), /not a criterion of the project's requirement index/);
});

test("acceptance: a key the proposal's tree defines is taken; one neither existing nor proposed is refused; no changes, or an unread proposal, refuse", () => {
  const existing = ['login'];
  assert.equal(proposedCheckRefusal({ named: ['r10-1-inputs', 'login'], existing, proposed: ['login', 'r10-1-inputs'], changes: 2 }), null);
  assert.match(proposedCheckRefusal({ named: ['r10-9-other'], existing, proposed: ['login', 'r10-1-inputs'], changes: 2 }), /"r10-9-other", which is neither a check of the project nor one this result's proposal adds/);
  assert.match(proposedCheckRefusal({ named: ['r10-1-inputs'], existing, proposed: [], changes: 0 }), /changes no check that could add it/);
  assert.match(proposedCheckRefusal({ named: ['r10-1-inputs'], existing, proposed: null, changes: 1 }), /could not be read/);
  assert.equal(proposedCheckRefusal({ named: ['login'], existing, proposed: null, changes: 1 }), null, 'an existing key needs no proposal read');
});

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  run(`INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management) VALUES ('prj_1', ?, 'p', 'T1', '/repo', 'main', 'spec_ready', 'registered', '{}')`, AT);
  const version = (id, seq, effective) =>
    run(
      `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots, authorized_revision) VALUES (?, ?, 'prj_1', ?, 'f', 'initial', 'h', 'human', ?, ?, ?, '[]', 'r')`,
      id,
      AT,
      seq,
      AT,
      effective ? 1 : 0,
      effective ? AT : null,
    );
  const check = (id, version, key) =>
    run(
      `INSERT INTO checks (id, created_at, project, key, protected_version, kind, required, gate_kinds, definition_path, definition_hash, runner_class) VALUES (?, ?, 'prj_1', ?, ?, 'smoke', 1, '["stage"]', 'd', 'h', 'direct')`,
      id,
      AT,
      key,
      version,
    );
  version('pv_1', 1, true);
  version('pv_2', 2, false);
  check('chk_a', 'pv_1', 'login');
  check('chk_b', 'pv_2', 'login');
  check('chk_c', 'pv_2', 'r10-1-inputs');
  const proposal = (id, runId, status, resulting = null) =>
    run(
      `INSERT INTO protected_proposals (id, created_at, project, seq, proposed_by, run, base_revision, tree_id, diff_hash, requested_change_kind, status, resulting_version) VALUES (?, ?, 'prj_1', 1, 'verifier_run', ?, 'b', 't', 'd', 'tightening', ?, ?)`,
      id,
      AT,
      runId,
      status,
      resulting,
    );
  let seq = 0;
  const finding = (id, runId, check) =>
    run(
      `INSERT INTO findings (id, created_at, project, seq, scope, subject_id, candidate, source_run, source_role, category, message, "check", proposed_severity, effective_severity, severity_history, sensitive_area, status, reevaluations, criterion) VALUES (?, ?, 'prj_1', ?, 'project', 'prj_1', NULL, ?, 'verifier', 'defect', 'm', ?, 'medium', 'medium', '[]', NULL, 'open', '[]', 'R10.1')`,
      id,
      AT,
      ++seq,
      runId,
      check,
    );
  return { db, run, proposal, finding };
}

const checkOf = (db, id) => db.prepare('SELECT "check", status FROM findings WHERE id = ?').get(id);
const unbound = (db) => db.prepare(`SELECT payload FROM events WHERE type = 'finding.check_unbound' ORDER BY seq`).all().map((e) => JSON.parse(e.payload));

test('applied: a check the applied version has stays bound; one it lacks leaves the finding standing with check null, recorded', (t) => {
  const s = store(t);
  s.proposal('pp_1', 'run_v', 'applied', 'pv_2');
  s.finding('fnd_in', 'run_v', 'r10-1-inputs');
  s.finding('fnd_out', 'run_v', 'r10-9-dropped');
  s.finding('fnd_other', 'run_other', 'r10-9-dropped');
  transact(s.db, ENGINE_ACTOR, (tx) => settleProposalFindings(tx, 'pp_1'));
  assert.deepEqual(checkOf(s.db, 'fnd_in'), { check: 'r10-1-inputs', status: 'open' }, 'bound to the applied version');
  assert.deepEqual(checkOf(s.db, 'fnd_out'), { check: null, status: 'open' }, 'stands with no check: never dropped');
  assert.equal(checkOf(s.db, 'fnd_other').check, 'r10-9-dropped', "another run's finding is not this proposal's");
  const [e] = unbound(s.db);
  assert.deepEqual([e.check, e.proposal, e.cause, e.version], ['r10-9-dropped', 'pp_1', 'not_in_applied_version', 'pv_2']);
});

test('rejected (an application conflict): a check only the proposal had leaves the finding with check null; one of the effective version stays', (t) => {
  const s = store(t);
  s.proposal('pp_1', 'run_v', 'approved');
  s.finding('fnd_new', 'run_v', 'r10-1-inputs');
  s.finding('fnd_old', 'run_v', 'login');
  assert.equal(transact(s.db, ENGINE_ACTOR, (tx) => applicationConflicts(tx, { proposal: 'pp_1', intent: null, head: 'h', reason: 'conflict' })), true);
  assert.deepEqual(checkOf(s.db, 'fnd_new'), { check: null, status: 'open' });
  assert.equal(checkOf(s.db, 'fnd_old').check, 'login');
  assert.deepEqual(unbound(s.db).map((e) => [e.check, e.cause]), [['r10-1-inputs', 'proposal_rejected']]);
});

test("the package: a check-writing Verifier's schema states the rule and takes any key; any other Verifier's keeps the enum", () => {
  const keys = ['login'];
  const writing = resultSchema('verifier', keys, ['R10.1'], { proposes: true }).properties.findings.items.properties.check;
  assert.equal(writing.enum, undefined);
  assert.match(writing.description, /a finding may name the check the same result proposes/);
  assert.match(writing.description, /stands with no check \(it is never dropped\)/);
  assert.deepEqual(resultSchema('verifier', keys, ['R10.1']).properties.findings.items.properties.check.enum, keys);
});
