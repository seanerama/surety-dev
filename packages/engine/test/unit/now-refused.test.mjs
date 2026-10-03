// Developer tests for the causes of NOW `refused` and for `unknown` (D1
// §12.3; brief B3): a repository the engine cannot read, an out-of-band
// change nobody has settled and a journal operation whose effect is not
// established each make the project `refused`, ahead of the decision that
// asks about it, and the status names the cause; once settled, NOW is what
// it would otherwise be. A status whose inputs cannot be read is `unknown`,
// never a state the engine did not establish. Against a scratch store.

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
const { recordObservation, closeRepositoryObservation } = await import(join(dist, 'store', 'transitions', 'repo.js'));
const { intendOperation, startAttempt, recordAmbiguous } = await import(join(dist, 'store', 'transitions', 'journal.js'));
const { readProject, listProjects } = await import(join(dist, 'store', 'projections.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });

const AT = '2026-10-02T00:00:00.000Z';
const H = 'a'.repeat(40);
const BASELINE = { head: H, index_hash: 'i'.repeat(64), tracked_tree_hash: 't'.repeat(40) };

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.pragma('foreign_keys = ON');
  migrate(db, join(root, 'migrations'));
  for (const id of ['prj_1', 'prj_2']) {
    db.prepare(
      `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
       VALUES (?, ?, 'p', 'T1', '/repo', 'main', 'spec_ready', 'registered', '{}')`,
    ).run(id, AT);
  }
  db.prepare(`INSERT INTO managed_checkouts (id, created_at, project, kind, path, baseline, owner_run) VALUES ('mco_1', ?, 'prj_1', 'integration_worktree', '/repo', ?, NULL)`).run(AT, JSON.stringify(BASELINE));
  return db;
}

const now = (db, project = 'prj_1') => readProject(db, { project, maxConcurrentRuns: 2 }).project.now;

test('an unreadable repository is refused ahead of the decision about it, and names the cause; readable again, it is not', (t) => {
  const db = store(t);
  transact(db, ENGINE_ACTOR, (tx) => recordObservation(tx, 'prj_1', { subject: 'repository', expected: 'readable', found: null }));
  const shown = now(db);
  assert.deepEqual([shown.state, shown.cause], ['refused', 'repository_unreadable']);
  assert.match(shown.reason, /repository cannot be read/);
  assert.equal(now(db, 'prj_2').state, 'idle', 'another project is not refused');
  transact(db, ENGINE_ACTOR, (tx) => closeRepositoryObservation(tx, 'prj_1'));
  assert.deepEqual([now(db).state, now(db).cause], ['idle', null]);
});

test('an unsettled out-of-band change of the integration branch is refused, naming it; settled, the project is what it would otherwise be', (t) => {
  const db = store(t);
  db.prepare(`INSERT INTO ref_registry (id, created_at, project, ref, kind, expected_oid, immutable) VALUES ('ref_main', ?, 'prj_1', 'refs/heads/main', 'integration', ?, 0)`).run(AT, H);
  const o = transact(db, ENGINE_ACTOR, (tx) => recordObservation(tx, 'prj_1', { subject: 'ref', ref: 'ref_main', expected: H, found: 'b'.repeat(40) }));
  const shown = now(db);
  assert.deepEqual([shown.state, shown.cause, shown.primary_action], ['refused', 'out_of_band_change', 'answer_decision']);
  assert.match(shown.reason, /integration branch refs\/heads\/main/);
  db.prepare(`UPDATE out_of_band_changes SET disposition = 'discard' WHERE id = ?`).run(o.id);
  db.prepare(`UPDATE decisions SET status = 'consumed' WHERE id = ?`).run(o.decision);
  assert.equal(now(db).state, 'idle');
});

test('a checkout changed outside the engine leaves it able to act: its question is waiting on a person', (t) => {
  const db = store(t);
  transact(db, ENGINE_ACTOR, (tx) => recordObservation(tx, 'prj_1', { subject: 'checkout', checkout: 'mco_1', expected: JSON.stringify(BASELINE), found: JSON.stringify({ ...BASELINE, tracked_tree_hash: 'e'.repeat(40) }) }));
  assert.deepEqual([now(db).state, now(db).cause], ['waiting_on_you', null]);
});

test('a journal operation whose effect is not established is refused', (t) => {
  const db = store(t);
  const op = transact(db, ENGINE_ACTOR, (tx) =>
    intendOperation(tx, {
      project: 'prj_1',
      kind: 'ref_update',
      payload: { repo: '/repo', ref: 'refs/heads/main', old_oid: H, new_oid: 'b'.repeat(40) },
      target: { repo: '/repo', ref: 'refs/heads/main' },
      subject: { test: 1 },
      finalizer: { purpose: 'oob_keep', ref: 'refs/heads/main', ref_kind: 'integration', new_oid: 'b'.repeat(40) },
      deadlineSeconds: 60,
    }),
  ).operation;
  transact(db, ENGINE_ACTOR, (tx) => startAttempt(tx, { operation: op, incarnation: 'inc_1' }));
  transact(db, ENGINE_ACTOR, (tx) => recordAmbiguous(tx, { operation: op }));
  assert.deepEqual([now(db).state, now(db).cause], ['refused', 'journal_blocked']);
});

test('a status whose inputs cannot be read is unknown, naming why, and the other projects are still shown', (t) => {
  const db = store(t);
  db.prepare('DROP TABLE out_of_band_changes').run();
  const all = listProjects(db, { maxConcurrentRuns: 2 }).projects;
  assert.deepEqual(all.map((p) => [p.id, p.now.state, p.now.cause]), [['prj_1', 'unknown', 'store_error'], ['prj_2', 'unknown', 'store_error']]);
  assert.match(all[0].now.reason, /cannot be computed/);
});
