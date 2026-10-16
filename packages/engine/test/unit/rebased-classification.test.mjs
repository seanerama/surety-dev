// Developer test for the driver's ruling on loop run 1 (M444 #19, L1-2),
// option (ii): two check authorings ran on one base, each proposing a
// tightening (a new check). Once the first was applied, the second,
// classified on its own tree against the new effective version, read as
// removing the first's check (a loosening), and its application's identity
// check failed. Now a proposal whose base does not hold the effective
// version is classified on its own changes rebased onto the effective
// revision (checks/classify-inputs.ts classifiedTree), the tree recorded;
// the application compares its rebased protected set with that tree; a
// pending proposal the version moved past is classified again, its
// question raised anew; a rebase conflict refuses the proposal for repair.
// Against a real repository (engine git) and a scratch store.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { configureGit } = await import(join(dist, 'git', 'exec.js'));
const { rebaseTree } = await import(join(dist, 'git', 'rebase.js'));
const { classificationInputs, classifiedTree } = await import(join(dist, 'checks', 'classify-inputs.js'));
const { classify } = await import(join(dist, 'checks', 'classify.js'));
const { discover } = await import(join(dist, 'checks', 'discovery.js'));
const { protectedSetAt } = await import(join(dist, 'protected', 'set.js'));
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { pendingReclassification, reclassifyProposal, classificationConflicts, recordClassification } = await import(join(dist, 'store', 'transitions', 'classification.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });
const AT = '2026-10-16T00:00:00.000Z';
const CRITERIA = new Set(['R1.1', 'R2.1', 'R3.1']);
const GOV = JSON.stringify({ protected_paths: ['.surety/checks/'], check_commands: { probe: { path: '/usr/bin/true' } } });
const def = (key, criterion, timeout = 60) =>
  `${JSON.stringify({ schema: 1, key, kind: 'acceptance', command: ['probe', key], timeout_s: timeout, covers: { criteria: [criterion] }, gate_kinds: ['stage'], inputs: [`.surety/checks/run/${key}.txt`] }, null, 2)}\n`;
const check = (key, criterion, timeout) => ({ [`.surety/checks/defs/${key}.json`]: def(key, criterion, timeout), [`.surety/checks/run/${key}.txt`]: `the input of ${key}\n` });

function repoIn(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  const home = join(dir, 'home');
  mkdirSync(join(home, 'tmp'), { recursive: true });
  configureGit({ deadlineSeconds: 30, outputCap: 1 << 24, home, incarnation: 'inc_unit' });
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'u', GIT_AUTHOR_EMAIL: 'u@x', GIT_COMMITTER_NAME: 'u', GIT_COMMITTER_EMAIL: 'u@x' };
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env });
  const index = join(dir, 'index');
  // A tree of exactly `files`, and a commit of it on `parent`.
  const treeOf = (files) => {
    rmSync(index, { force: true });
    const ienv = { ...env, GIT_INDEX_FILE: index };
    for (const [path, content] of Object.entries(files)) {
      const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, env, encoding: 'utf8', input: content }).trim();
      execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${oid},${path}`], { cwd: repo, env: ienv });
    }
    return execFileSync('git', ['write-tree'], { cwd: repo, env: ienv, encoding: 'utf8' }).trim();
  };
  const commit = (tree, parent) => execFileSync('git', ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'c'], { cwd: repo, env, encoding: 'utf8' }).trim();
  return { repo, scratch: join(home, 'tmp'), treeOf, commit };
}

// The loop's pattern: a base with check a; two authorings on it, one adding b
// (R2.1), one adding c (R3.1); the first applied, then the integration branch
// moved on with a source change.
function loopPattern(t) {
  const r = repoIn(t);
  const baseFiles = { '.surety/checks/protected-policy.json': GOV, ...check('a', 'R1.1'), 'src/app.js': 'v1\n' };
  const B0 = r.commit(r.treeOf(baseFiles));
  const first = { base_revision: B0, tree_id: r.treeOf({ ...baseFiles, ...check('b', 'R2.1') }) };
  const second = { base_revision: B0, tree_id: r.treeOf({ ...baseFiles, ...check('c', 'R3.1') }) };
  return { r, B0, first, second, baseFiles };
}

const reasons = (c) => [...(c.reasons ?? [])].map((x) => (typeof x === 'string' ? x : `${x.code ?? x.reason}${x.subject ? `:${x.subject}` : x.key ? `:${x.key}` : ''}`));

test("the loop's two tightenings on one base: once the first is applied, the second is classified on its changes rebased onto the effective revision, a tightening adding only its own check; on its own tree it would read as removing the first's", async (t) => {
  const { r, B0, first, second } = loopPattern(t);
  // Both classified at B0, where both bases hold the effective version: their own trees.
  for (const p of [first, second]) {
    const ct = await classifiedTree(r.repo, p, B0, r.scratch);
    assert.deepEqual(ct, { tree: p.tree_id }, 'the base is the effective revision: its own tree');
    const c = classify(...Object.values(await classificationInputs(r.repo, B0, ct.tree)), CRITERIA);
    assert.equal(c.change_kind, 'tightening');
  }
  // The first applied: its changes onto B0, the new effective revision A1; then a source commit H.
  const applied1 = await rebaseTree(r.repo, first.base_revision, first.tree_id, B0, r.scratch);
  const A1 = r.commit(applied1.tree, B0);
  const H = r.commit(r.treeOf({ ...Object.fromEntries((await listFiles(r.repo, A1)).map((f) => [f.path, f.content])), 'src/app.js': 'v2\n' }), A1);

  // What the engine read before the ruling: the second's own tree against A1.
  const old = classify(...Object.values(await classificationInputs(r.repo, A1, second.tree_id)), CRITERIA);
  assert.notEqual(old.change_kind, 'tightening', `on its own tree it reads as removing b (${old.change_kind}: ${JSON.stringify(old.reasons)})`);

  // Now: rebased onto the effective revision.
  const ct = await classifiedTree(r.repo, second, A1, r.scratch);
  assert.ok('tree' in ct && ct.tree !== second.tree_id, 'rebased: a tree of its own changes on A1');
  const c = classify(...Object.values(await classificationInputs(r.repo, A1, ct.tree)), CRITERIA);
  assert.equal(c.change_kind, 'tightening', `a tightening (${JSON.stringify(c.reasons)})`);
  const keys = (await discover(r.repo, ct.tree)).checks.map((x) => x.key).sort();
  assert.deepEqual(keys, ['a', 'b', 'c'], "the classified tree holds the first's check and its own");

  // The application: its changes rebased onto the head H; its protected set
  // is the classified tree's (the identity check holds), so it applies, and
  // after it both checks are in effect.
  const applied2 = await rebaseTree(r.repo, second.base_revision, second.tree_id, H, r.scratch);
  assert.equal((await protectedSetAt(r.repo, applied2.tree)).fingerprint, (await protectedSetAt(r.repo, ct.tree)).fingerprint, 'what is committed is what was classified');
  const A2 = r.commit(applied2.tree, H);
  assert.deepEqual((await discover(r.repo, A2)).checks.map((x) => x.key).sort(), ['a', 'b', 'c'], 'both applied: neither removed the other');
  // And at A2, the source change H made stands.
  assert.deepEqual((await listFiles(r.repo, A2)).find((f) => f.path === 'src/app.js').content, 'v2\n');
});

test('a base that holds the effective version (the branch moved on with source only) is classified on its own tree; a path the effective version changed another way is a conflict', async (t) => {
  const { r, B0, baseFiles } = loopPattern(t);
  const S = r.commit(r.treeOf({ ...baseFiles, 'src/app.js': 'v2\n' }), B0);
  const later = { base_revision: S, tree_id: r.treeOf({ ...baseFiles, 'src/app.js': 'v2\n', ...check('d', 'R2.1') }) };
  assert.deepEqual(await classifiedTree(r.repo, later, B0, r.scratch), { tree: later.tree_id }, 'B0 is an ancestor of its base: its own tree');
  // Two corrections of check a's timeout on one base; the first applied.
  const one = { base_revision: B0, tree_id: r.treeOf({ ...baseFiles, ...check('a', 'R1.1', 90) }) };
  const two = { base_revision: B0, tree_id: r.treeOf({ ...baseFiles, ...check('a', 'R1.1', 120) }) };
  const A1 = r.commit((await rebaseTree(r.repo, B0, one.tree_id, B0, r.scratch)).tree, B0);
  assert.deepEqual(await classifiedTree(r.repo, two, A1, r.scratch), { conflict: '.surety/checks/defs/a.json' });
});

// ---- the store: classified again when the version moves; a conflict refused --------------------

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
  // The registered index the classifier judges criteria against.
  for (const n of [1, 2, 3]) run(`INSERT INTO requirements (id, created_at, project, key, text_ref, status, criteria) VALUES (?, ?, 'prj_1', ?, 'spec', 'approved', ?)`, `req_${n}`, AT, `R${n}`, JSON.stringify([`R${n}.1`]));
  const version = (id, seq, revision, effective) =>
    run(
      `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots, authorized_revision, superseded_by) VALUES (?, ?, 'prj_1', ?, 'f', 'initial', 'h', 'human', ?, 1, ?, '[".surety/checks/"]', ?, ?)`,
      id,
      AT,
      seq,
      AT,
      AT,
      revision,
      effective ? null : 'pv_next',
    );
  const proposal = (id, p, status = 'captured') =>
    run(
      `INSERT INTO protected_proposals (id, created_at, project, seq, proposed_by, run, base_revision, tree_id, diff_hash, requested_change_kind, status) VALUES (?, ?, 'prj_1', (SELECT COALESCE(MAX(seq), 0) + 1 FROM protected_proposals), 'verifier_run', NULL, ?, ?, 'd', 'tightening', ?)`,
      id,
      AT,
      p.base_revision,
      p.tree_id,
      status,
    );
  return { db, run, version, proposal };
}

const decisionsOf = (db, id) => db.prepare(`SELECT kind, status FROM decisions WHERE subject_id = ? ORDER BY rowid`).all(id);

test('a pending proposal the effective version moved past is classified again on its rebased tree, the tree recorded, its old question invalidated and a new one raised; read again, nothing more', async (t) => {
  const { r, B0, first, second } = loopPattern(t);
  const s = store(t);
  s.version('pv_1', 1, B0, true);
  s.proposal('pp_2', second);
  const inputs0 = await classificationInputs(r.repo, B0, second.tree_id);
  transact(s.db, ENGINE_ACTOR, (tx) => recordClassification(tx, { proposal: 'pp_2', effective: 'pv_1', inputs: inputs0, tree: second.tree_id }));
  assert.deepEqual(decisionsOf(s.db, 'pp_2'), [{ kind: 'check_correction_tightening', status: 'open' }]);
  assert.deepEqual(pendingReclassification(s.db, { project: 'prj_1' }), [], 'classified at the version in effect: nothing to do');

  // The first applied: pv_2 effective at A1.
  const A1 = r.commit((await rebaseTree(r.repo, B0, first.tree_id, B0, r.scratch)).tree, B0);
  s.run(`UPDATE protected_versions SET superseded_by = 'pv_2' WHERE id = 'pv_1'`);
  s.version('pv_2', 2, A1, true);
  const [due] = pendingReclassification(s.db, { project: 'prj_1' });
  assert.deepEqual([due.proposal, due.effective, due.revision, due.base, due.tree], ['pp_2', 'pv_2', A1, B0, second.tree_id]);

  const ct = await classifiedTree(r.repo, { base_revision: due.base, tree_id: due.tree }, due.revision, r.scratch);
  const inputs = await classificationInputs(r.repo, A1, ct.tree);
  const done = transact(s.db, ENGINE_ACTOR, (tx) => reclassifyProposal(tx, { proposal: 'pp_2', effective: 'pv_2', inputs, tree: ct.tree }));
  assert.equal(done.change_kind, 'tightening', 'still the tightening it is');
  const row = s.db.prepare(`SELECT status, classified_tree, classification FROM protected_proposals WHERE id = 'pp_2'`).get();
  assert.deepEqual([row.status, row.classified_tree, JSON.parse(row.classification).effective_version], ['classified', ct.tree, 'pv_2']);
  assert.deepEqual(decisionsOf(s.db, 'pp_2'), [
    { kind: 'check_correction_tightening', status: 'invalidated' },
    { kind: 'check_correction_tightening', status: 'open' },
  ]);
  assert.deepEqual(pendingReclassification(s.db, { project: 'prj_1' }), [], 'classified at the version in effect');
  assert.equal(transact(s.db, ENGINE_ACTOR, (tx) => reclassifyProposal(tx, { proposal: 'pp_2', effective: 'pv_2', inputs, tree: ct.tree })), null, 'once');
});

test('a rebase conflict refuses the proposal for repair: rejected, its questions withdrawn', async (t) => {
  const { r, B0 } = loopPattern(t);
  const s = store(t);
  s.version('pv_1', 1, B0, true);
  s.proposal('pp_x', { base_revision: B0, tree_id: 't' }, 'classified');
  s.run(
    `INSERT INTO decisions (id, created_at, project, seq, kind, subject_type, subject_id, semantic_generation, scope, question, options, dependency_manifest, transition_schema_version, preview_hash, evidence, blocked_while_open, raised_at, status) VALUES ('dec_x', ?, 'prj_1', 1, 'check_correction_tightening', 'protected_proposal', 'pp_x', 1, 'subject', 'q', '[]', '{}', 1, 'h', '[]', '{}', ?, 'open')`,
    AT,
    AT,
  );
  assert.equal(transact(s.db, ENGINE_ACTOR, (tx) => classificationConflicts(tx, { proposal: 'pp_x', revision: B0, reason: 'its changes do not rebase (.surety/checks/defs/a.json)' })), true);
  assert.equal(s.db.prepare(`SELECT status FROM protected_proposals WHERE id = 'pp_x'`).get().status, 'rejected');
  assert.deepEqual(decisionsOf(s.db, 'pp_x'), [{ kind: 'check_correction_tightening', status: 'invalidated' }]);
  const e = s.db.prepare(`SELECT payload FROM events WHERE type = 'protected.rejected'`).get();
  assert.equal(JSON.parse(e.payload).cause, 'rebase_conflict');
});

async function listFiles(repo, rev) {
  const out = execFileSync('git', ['ls-tree', '-r', '--name-only', rev], { cwd: repo, encoding: 'utf8' }).trim().split('\n');
  return out.map((path) => ({ path, content: execFileSync('git', ['show', `${rev}:${path}`], { cwd: repo, encoding: 'utf8' }) }));
}
