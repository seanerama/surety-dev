// Developer tests for the answer `adopt` to a checkout observation (D1
// §§7.6, 7.8; brief B2), the store's side: the answer records one intent; its
// beginning journals the engine's commit of the checkout's tracked content on
// the expected head, as an out-of-band revision, with the branch update to
// follow; the finalizer of that update makes the commit the registry's
// expectation, records what the checkout then holds as its baseline (HEAD
// the new commit, index and files as they were), reconciles the observation
// and completes the intent. A checkout whose HEAD is not the expected head
// is not adopted onto it. Against a scratch store; no git is run.

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
const { answerQueued } = await import(join(dist, 'store', 'transitions', 'queue.js'));
const { recordObservation } = await import(join(dist, 'store', 'transitions', 'repo.js'));
const { beginAdopt } = await import(join(dist, 'store', 'transitions', 'intents.js'));
const { startAttempt, recordApplied, recordConfirmed, finalizeOperation } = await import(join(dist, 'store', 'transitions', 'journal.js'));
const { integrityFacts } = await import(join(dist, 'store', 'transitions', 'integrity.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });

const AT = '2026-10-02T00:00:00.000Z';
const H = 'a'.repeat(40); // the expected head, checked out in the developer's checkout
const S = 'c'.repeat(40); // the engine's commit of the checkout's edits
const BASELINE = { head: H, index_hash: 'i'.repeat(64), tracked_tree_hash: 't'.repeat(40) };
const EDITED = { head: H, index_hash: 'i'.repeat(64), tracked_tree_hash: 'e'.repeat(40) };

function store(t, found = EDITED) {
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
     VALUES ('prj_1', ?, 'p', 'T1', '/repo', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
  );
  run(`INSERT INTO ref_registry (id, created_at, project, ref, kind, expected_oid, immutable) VALUES ('ref_main', ?, 'prj_1', 'refs/heads/main', 'integration', ?, 0)`, AT, H);
  run(`INSERT INTO managed_checkouts (id, created_at, project, kind, path, baseline, owner_run) VALUES ('mco_1', ?, 'prj_1', 'integration_worktree', '/repo', ?, NULL)`, AT, JSON.stringify(BASELINE));
  const o = transact(db, ENGINE_ACTOR, (tx) => recordObservation(tx, 'prj_1', { subject: 'checkout', checkout: 'mco_1', expected: JSON.stringify(BASELINE), found: JSON.stringify(found) }));
  const d = db.prepare('SELECT * FROM decisions WHERE id = ?').get(o.decision);
  return { db, o, d };
}

const adopt = (db, d, found) => transact(db, ENGINE_ACTOR, (tx) => answerQueued(tx, { project: 'prj_1', decision: d.id, option: 'adopt', preview_hash: d.preview_hash, note: null, facts: { found } }));

// An operation's ordinary course, as the journal drives it when git does what it is asked.
function drive(db, operation) {
  transact(db, ENGINE_ACTOR, (tx) => startAttempt(tx, { operation, incarnation: 'inc_1' }));
  transact(db, ENGINE_ACTOR, (tx) => recordApplied(tx, { operation }));
  transact(db, ENGINE_ACTOR, (tx) => recordConfirmed(tx, { operation, incarnation: 'inc_1' }));
  return transact(db, ENGINE_ACTOR, (tx) => finalizeOperation(tx, { operation }));
}

test('adopt: the edits become one engine-made out-of-band commit on the integration branch, the observation is reconciled and the checkout’s baseline is what it holds', (t) => {
  const { db, o, d } = store(t);
  assert.deepEqual(JSON.parse(d.options).map((x) => x.key), ['stash', 'adopt']);
  adopt(db, d, JSON.stringify(EDITED));
  const intent = db.prepare('SELECT * FROM effect_intents').get();
  assert.deepEqual([intent.kind, intent.status, db.prepare('SELECT status FROM decisions WHERE id = ?').get(d.id).status], ['oob_adopt', 'pending', 'consumed']);

  const made = transact(db, ENGINE_ACTOR, (tx) =>
    beginAdopt(tx, { intent: intent.id, facts: { found: JSON.stringify(EDITED) }, repo: '/repo', tree: EDITED.tracked_tree_hash, parent: H, sha: S, content: 'commit', index_hash: EDITED.index_hash, deadlineSeconds: 60 }),
  );
  assert.equal(db.prepare('SELECT status FROM effect_intents WHERE id = ?').get(intent.id).status, 'executing');
  // While the branch update is in flight, what the checkout will hold is the engine's own write.
  const receipts = drive(db, made.operation);
  const follow = receipts.follow;
  assert.equal(typeof follow, 'string', 'the branch update follows the commit');
  const inFlight = integrityFacts({ db }, { project: 'prj_1' }).checkouts.find((c) => c.id === 'mco_1');
  assert.deepEqual(inFlight.pending, { head: S, index_hash: EDITED.index_hash, tracked_tree_hash: EDITED.tracked_tree_hash });
  const payload = JSON.parse(db.prepare(`SELECT payload FROM git_journal_events WHERE operation = ? AND event_kind = 'intended'`).get(follow).payload);
  assert.deepEqual([payload.ref, payload.old_oid, payload.new_oid], ['refs/heads/main', H, S], 'a compare-and-swap from the expected head');

  drive(db, follow);
  assert.equal(db.prepare(`SELECT expected_oid FROM ref_registry WHERE ref = 'refs/heads/main'`).get().expected_oid, S, 'the next base is the adopted commit');
  assert.deepEqual(JSON.parse(db.prepare(`SELECT baseline FROM managed_checkouts WHERE id = 'mco_1'`).get().baseline), { head: S, index_hash: EDITED.index_hash, tracked_tree_hash: EDITED.tracked_tree_hash });
  assert.equal(db.prepare('SELECT disposition FROM out_of_band_changes WHERE id = ?').get(o.id).disposition, 'adopt');
  assert.equal(db.prepare('SELECT status FROM effect_intents WHERE id = ?').get(intent.id).status, 'done');
  assert.deepEqual(
    db.prepare('SELECT kind, parent_sha FROM revisions WHERE sha = ?').all(S),
    [{ kind: 'out_of_band', parent_sha: H }],
    'one revision of the commit, out of band, on the expected head',
  );
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'repo.reconciled'`).get().n, 1);
  assert.equal(integrityFacts({ db }, { project: 'prj_1' }).checkouts.find((c) => c.id === 'mco_1').pending, null);
});

test('adopt is refused for a checkout whose HEAD is not the expected head: nothing is consumed or intended', (t) => {
  const moved = { ...EDITED, head: 'd'.repeat(40) };
  const { db, d } = store(t, moved);
  assert.throws(() => adopt(db, d, JSON.stringify(moved)), (err) => err.status === 409 && err.code === 'out_of_band_change');
  assert.equal(db.prepare('SELECT status FROM decisions WHERE id = ?').get(d.id).status, 'open');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM effect_intents').get().n, 0);
});

test('the checkout edited again after the preview: adopt is refused as stale and nothing is intended', (t) => {
  const { db, d } = store(t);
  const again = { ...EDITED, tracked_tree_hash: 'f'.repeat(40) };
  assert.throws(() => adopt(db, d, JSON.stringify(again)), (err) => err.status === 409 && err.code === 'decision_stale');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM effect_intents').get().n, 0);
});

test('the checkout edited again before the effect: the intent is invalidated, the observation closed for integrity to observe afresh, and nothing is begun', (t) => {
  const { db, o, d } = store(t);
  adopt(db, d, JSON.stringify(EDITED));
  const intent = db.prepare('SELECT * FROM effect_intents').get();
  const again = { ...EDITED, tracked_tree_hash: 'f'.repeat(40) };
  const made = transact(db, ENGINE_ACTOR, (tx) =>
    beginAdopt(tx, { intent: intent.id, facts: { found: JSON.stringify(again) }, repo: '/repo', tree: again.tracked_tree_hash, parent: H, sha: S, content: 'commit', index_hash: again.index_hash, deadlineSeconds: 60 }),
  );
  assert.equal(made, null);
  const row = db.prepare('SELECT * FROM effect_intents WHERE id = ?').get(intent.id);
  assert.deepEqual([row.status, row.invalidated_reason], ['invalidated', 'EFFECT_PRECONDITION_CHANGED']);
  const obs = db.prepare('SELECT disposition, closed_at FROM out_of_band_changes WHERE id = ?').get(o.id);
  assert.equal(obs.disposition, null);
  assert.notEqual(obs.closed_at, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operations').get().n, 0);
  assert.equal(db.prepare(`SELECT expected_oid FROM ref_registry WHERE ref = 'refs/heads/main'`).get().expected_oid, H);
});
