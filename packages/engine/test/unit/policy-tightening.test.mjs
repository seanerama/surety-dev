// Developer tests for D2 (DECISIONS item 57; the owner's ruling of
// 2026-11-26: "The brief can authorize tighter checks tied to its criteria
// using the approved commands and execution permissions. A proposal that
// changes what can execute, weakens existing coverage, or cannot be
// classified comes to me. Keep the check diff available and retain
// candidate verification."): the engine's classification of a rapid
// prototype's own tightening approved under the approved brief's authority
// (store/transitions/classification.ts policyTightening), and every case
// the policy does not cover routed to the owner as before, its evidence
// naming why. Against a real repository (engine git) and a scratch store.

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
const { classificationInputs } = await import(join(dist, 'checks', 'classify-inputs.js'));
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { recordClassification, revalidateApplication } = await import(join(dist, 'store', 'transitions', 'classification.js'));
const { effectsDue } = await import(join(dist, 'store', 'transitions', 'intents.js'));
const { readVersion } = await import(join(dist, 'store', 'transitions', 'checks.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1', classifier_authority: { mode: 'recommend' } });
const AT = '2026-11-26T00:00:00.000Z';
const GOV = JSON.stringify({ protected_paths: ['.surety/checks/'], check_commands: { probe: { path: '/usr/bin/true' } } });
const GOV2 = JSON.stringify({ protected_paths: ['.surety/checks/'], check_commands: { probe: { path: '/usr/bin/true' }, other: { path: '/usr/bin/false' } } });
const def = (key, criteria) =>
  `${JSON.stringify({ schema: 1, key, kind: 'acceptance', command: ['probe', key], timeout_s: 60, covers: { criteria }, gate_kinds: ['stage'], inputs: [`.surety/checks/run/${key}.txt`] }, null, 2)}\n`;
const check = (key, criteria) => ({ [`.surety/checks/defs/${key}.json`]: def(key, criteria), [`.surety/checks/run/${key}.txt`]: `the input of ${key}\n` });

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
  return { repo, treeOf, commit };
}

// A rapid prototype at T1 whose iteration's brief (spec revision sr_1) is
// approved and building; requirements R1 to R3; one effective version at B0
// with check a (R1.1); a Verifier run of the iteration.
async function setup(t, { mode = 'rapid_prototype', approved = true, runIteration = 'it_1', status = 'building' } = {}) {
  const r = repoIn(t);
  const baseFiles = { '.surety/checks/protected-policy.json': GOV, ...check('a', ['R1.1']), 'src/app.js': 'v1\n' };
  const B0 = r.commit(r.treeOf(baseFiles));
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  run(`INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management, mode) VALUES ('prj_1', ?, 'p', 'T1', ?, 'main', 'spec_ready', 'registered', '{}', ?)`, AT, r.repo, mode);
  for (const n of [1, 2, 3]) run(`INSERT INTO requirements (id, created_at, project, key, text_ref, status, criteria) VALUES (?, ?, 'prj_1', ?, 'spec', 'approved', ?)`, `req_${n}`, AT, `R${n}`, JSON.stringify([`R${n}.1`]));
  run(`INSERT INTO spec_revisions (id, created_at, project, version, git_path, git_blob, semantic_digest, approved_by, approved_at) VALUES ('sr_1', ?, 'prj_1', 1, 'spec.md', 'b', 'd', 'human', ?)`, AT, AT);
  run(
    `INSERT INTO prototype_iterations (id, created_at, project, seq, mode, status, limits_json, brief_spec_revision, brief_decision, approved_at) VALUES ('it_1', ?, 'prj_1', 1, 'rapid_prototype', ?, '{}', 'sr_1', 'dec_brief', ?)`,
    AT,
    status,
    approved ? AT : null,
  );
  run(
    `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, effective_from, roots, authorized_revision) VALUES ('pv_1', ?, 'prj_1', 1, 'f', 'initial', 'h', 'human', ?, 1, ?, '[".surety/checks/"]', ?)`,
    AT,
    AT,
    AT,
    B0,
  );
  run(`INSERT INTO ref_registry (id, created_at, project, ref, kind, expected_oid, immutable) VALUES ('ref_main', ?, 'prj_1', 'refs/heads/main', 'integration', ?, 0)`, AT, B0);
  run(
    `INSERT INTO runs (id, created_at, project, seq, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined, iteration, work_item) VALUES ('run_v', ?, 'prj_1', 1, 'verifier', 'one_shot', 'ended', 'scripted', '1', 'm', ?, ?, 0, ?, 'wi_auth')`,
    AT,
    B0,
    AT,
    runIteration,
  );
  const propose = (id, files) => {
    const tree = r.treeOf({ ...baseFiles, ...files });
    run(
      `INSERT INTO protected_proposals (id, created_at, project, seq, proposed_by, run, base_revision, tree_id, diff_hash, requested_change_kind, status) VALUES (?, ?, 'prj_1', (SELECT COALESCE(MAX(seq), 0) + 1 FROM protected_proposals), 'verifier_run', 'run_v', ?, ?, 'dh', 'tightening', 'captured')`,
      id,
      AT,
      B0,
      tree,
    );
    return tree;
  };
  const classifyIt = async (id, tree) => {
    const inputs = await classificationInputs(r.repo, B0, tree);
    return transact(db, ENGINE_ACTOR, (tx) => recordClassification(tx, { proposal: id, effective: 'pv_1', inputs, tree }));
  };
  return { db, run, propose, classifyIt, B0, r };
}

const proposal = (db, id) => db.prepare('SELECT status, approver, approver_authority, approval_binding FROM protected_proposals WHERE id = ?').get(id);
const questions = (db, id) => db.prepare(`SELECT kind, status, evidence FROM decisions WHERE subject_id = ? ORDER BY rowid`).all(id).map((d) => ({ ...d, evidence: JSON.parse(d.evidence) }));

test('(a) a tightening of the iteration\'s own authoring covering only the brief\'s criteria is approved by the brief\'s policy under recommend: no question, the act recorded, applied by the effects step', async (t) => {
  const s = await setup(t);
  const tree = s.propose('pp_1', check('b', ['R2.1']));
  const out = await s.classifyIt('pp_1', tree);
  assert.equal(out.change_kind, 'tightening');
  const p = proposal(s.db, 'pp_1');
  assert.deepEqual([p.status, p.approver, p.approver_authority], ['approved', 'policy:rapid_prototype', 'policy']);
  assert.ok(p.approval_binding !== null, 'bound to the correction manifest');
  assert.deepEqual(questions(s.db, 'pp_1'), [], 'no check_correction_tightening decision');
  const acts = s.db.prepare(`SELECT * FROM delegated_actions WHERE subject_id = 'pp_1'`).all();
  assert.equal(acts.length, 1);
  assert.deepEqual([acts[0].kind, acts[0].authorized_by_kind, acts[0].authorized_by, acts[0].performed_by, acts[0].iteration], ['tightening_applied', 'decision', 'dec_brief', 'policy:rapid_prototype', 'it_1']);
  const scope = JSON.parse(acts[0].scope);
  assert.deepEqual(scope.criteria, ['R2.1']);
  assert.deepEqual(scope.checks, ['b']);
  assert.equal(scope.tree, tree);
  const ev = s.db.prepare(`SELECT payload FROM events WHERE type = 'protected.approved'`).get();
  const payload = JSON.parse(ev.payload);
  assert.deepEqual([payload.authority, payload.brief_decision], ['policy', 'dec_brief']);
  assert.deepEqual(effectsDue(s.db, { project: 'prj_1' }).proposals, ['pp_1'], 'applied by the ticks after, as a Reviewer\'s approval is');
  // Its binding holds on the same inputs read again.
  const inputs = await classificationInputs(s.r.repo, s.B0, tree);
  const ok = transact(s.db, ENGINE_ACTOR, (tx) => revalidateApplication(tx, { proposal: 'pp_1', intent: null, head: s.B0, inputs, inputsVersion: 'pv_1', inputsTree: tree }));
  assert.equal(ok, true);
});

test('the brief no longer covers it before the application (the iteration ended): the policy approval is withdrawn and the owner asked, the evidence saying so', async (t) => {
  const s = await setup(t);
  const tree = s.propose('pp_1', check('b', ['R2.1']));
  await s.classifyIt('pp_1', tree);
  s.run(`UPDATE prototype_iterations SET status = 'discarded' WHERE id = 'it_1'`);
  const inputs = await classificationInputs(s.r.repo, s.B0, tree);
  const ok = transact(s.db, ENGINE_ACTOR, (tx) => revalidateApplication(tx, { proposal: 'pp_1', intent: null, head: s.B0, inputs, inputsVersion: 'pv_1', inputsTree: tree }));
  assert.equal(ok, false);
  assert.deepEqual([proposal(s.db, 'pp_1').status, proposal(s.db, 'pp_1').approver], ['classified', null]);
  const q = questions(s.db, 'pp_1');
  assert.equal(q.length, 1);
  assert.equal(q[0].kind, 'check_correction_tightening');
  assert.match(q[0].evidence.policy_not_covered, /policy_approval_withdrawn/);
});

test('(c-f) not covered: an unclassifiable change of what can execute, a predecessor\'s authoring, no approved brief, a changed specification: the owner\'s question as today, its evidence naming why', async (t) => {
  const cases = [
    { name: 'check_commands changed', opts: {}, files: { '.surety/checks/protected-policy.json': GOV2, ...check('b', ['R2.1']) }, kind: 'check_correction_unclassifiable', why: /classified_unclassifiable/ },
    { name: "another iteration's run", opts: { runIteration: 'it_0' }, files: check('b', ['R2.1']), kind: 'check_correction_tightening', why: /not_this_iterations_authoring/ },
    { name: 'no approved brief', opts: { approved: false }, files: check('b', ['R2.1']), kind: 'check_correction_tightening', why: /no_approved_brief/ },
  ];
  for (const c of cases) {
    const s = await setup(t, c.opts);
    const tree = s.propose('pp_1', c.files);
    await s.classifyIt('pp_1', tree);
    const p = proposal(s.db, 'pp_1');
    assert.notEqual(p.status, 'approved', c.name);
    const q = questions(s.db, 'pp_1');
    assert.equal(q.length, 1, c.name);
    assert.equal(q[0].kind, c.kind, c.name);
    assert.match(q[0].evidence.policy_not_covered, c.why, c.name);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM delegated_actions').get().n, 0, c.name);
  }
  // A specification approved after the brief: not what the brief approved.
  const s = await setup(t);
  s.run(`INSERT INTO spec_revisions (id, created_at, project, version, git_path, git_blob, semantic_digest, approved_by, approved_at) VALUES ('sr_2', ?, 'prj_1', 2, 'spec.md', 'b2', 'd2', 'human', ?)`, AT, AT);
  const tree = s.propose('pp_1', check('b', ['R2.1']));
  await s.classifyIt('pp_1', tree);
  assert.match(questions(s.db, 'pp_1')[0].evidence.policy_not_covered, /spec_changed_since_brief/);
});

test('a planned project: the owner\'s question exactly as before, no policy evidence', async (t) => {
  const s = await setup(t, { mode: 'planned' });
  const tree = s.propose('pp_1', check('b', ['R2.1']));
  await s.classifyIt('pp_1', tree);
  const q = questions(s.db, 'pp_1');
  assert.equal(q.length, 1);
  assert.deepEqual(q[0].evidence, []);
  assert.equal(proposal(s.db, 'pp_1').status, 'classified');
});

test('the protected-version read serves the proposal that made a version, with its diff and the delegated act', async (t) => {
  const s = await setup(t);
  const tree = s.propose('pp_1', check('b', ['R2.1']));
  await s.classifyIt('pp_1', tree);
  s.run(
    `INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, proposal, approved_by, approver_authority, approved_at, authorized, effective_from, roots, authorized_revision) VALUES ('pv_2', ?, 'prj_1', 2, 'f2', 'tightening', 'pp_1', 'policy:rapid_prototype', 'policy', ?, 0, NULL, '[".surety/checks/"]', 'x')`,
    AT,
    AT,
  );
  const v = readVersion(s.db, { project: 'prj_1', version: 'pv_2' }).version;
  assert.deepEqual([v.approved_by, v.approver_authority], ['policy:rapid_prototype', 'policy']);
  assert.equal(v.proposal.id, 'pp_1');
  assert.deepEqual(v.proposal.diff, { base_revision: s.B0, tree, classified_tree: tree, diff_hash: 'dh' });
  assert.equal(v.proposal.delegated_action.authorized_by.id, 'dec_brief');
  assert.equal(readVersion(s.db, { project: 'prj_1', version: 'pv_1' }).version.proposal, null);
});
