// Developer tests for DECISIONS item 45 (the owner's words of 2026-11-24:
// "Apply the same rule to both the approval and the brief's role list. Have
// approval and dispatch use the same model-selection logic. Test with a
// project role model that differs from the backend default, then change the
// role model while approval is pending. An approval for model A must not
// authorize a run requesting model B. Preserve historical approvals and
// receipts as recorded."; objection 232's rule; M7 plan §3g M629).
//
// One function (store/transitions/requested-model.ts requestedModelOf) for
// dispatch's model_requested, the prototype_preparation_approval's manifest
// and question, the brief's role list and the request-checks consequence.
//
// A scratch store with the engine's migrations under the harness (the
// scripted backend every role's default), as rapid-prototype-brief.test.mjs:
// the dispatch transaction (claimDispatch) is called as the main thread
// calls it, and the policy commit's finalizer as the journal calls it. No
// engine process, backend process or host resource is started.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { setEngineSettings, roleModel } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { configureHarness } = await import(join(dist, 'testing', 'seam.js'));
const { configureGit } = await import(join(dist, 'git', 'exec.js'));
const { prepareNewProject } = await import(join(dist, 'setup', 'projects.js'));
const { bootstrapProject } = await import(join(dist, 'store', 'transitions', 'project.js'));
const R = await import(join(dist, 'store', 'transitions', 'runs.js'));
const { answerQueued } = await import(join(dist, 'store', 'transitions', 'queue.js'));
const { registerRef, integrationRef } = await import(join(dist, 'store', 'transitions', 'repo.js'));
const { runFinalizer } = await import(join(dist, 'store', 'transitions', 'finalize.js'));
const { requestedModelOf } = await import(join(dist, 'store', 'transitions', 'requested-model.js'));
const B = await import(join(dist, 'prototype', 'brief.js'));

setEngineSettings({ lease_ttl: 600, git_deadline: 30, decision_targets: {}, incarnation: 'inc_1' });
const HUMAN = { actor_kind: 'human', actor_id: null, request_id: 'req-1' };
const AT = '2026-11-24T00:00:00.000Z';

function scratch(t) {
  assert.equal(configureHarness(true, []), null);
  t.after(() => configureHarness(false, []));
  const dir = mkdtempSync(join(tmpdir(), 'surety-rqm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  mkdirSync(join(home, 'scratch'), { recursive: true });
  configureGit({ home, incarnation: 'test', deadlineSeconds: 30, outputCap: 1048576 });
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  migrate(db, join(root, 'migrations'));
  db.prepare(`INSERT INTO engine_incarnations (id, created_at, pid, started_at, host_boot_id) VALUES ('inc_1', ?, 1, ?, 'boot')`).run(AT, AT);
  const rt = { home, scratch: join(home, 'scratch'), setting: () => 30 };
  let n = 0;
  // A rapid prototype whose policy names `policy` (the spec_writer's model
  // set apart from the backend's own, scripted, model).
  const create = async (policy = {}) => {
    const prepared = await prepareNewProject(rt, { name: 'Tasks', idea: 'A small task list app.', dev_repo_path: join(dir, `app${++n}`), mode: 'rapid_prototype' });
    const made = transact(db, HUMAN, (tx) => bootstrapProject(tx, prepared));
    db.prepare(`UPDATE projects SET registration_state = 'registered', paused = 0 WHERE id = ?`).run(made.project.id);
    transact(db, ENGINE_ACTOR, (tx) => registerRef(tx, { project: made.project.id, ref: integrationRef('main'), kind: 'integration', expected: 'sha_boot' }));
    if (Object.keys(policy).length > 0) {
      // Set before the first question is asked of it: the effective policy
      // rewritten, and the iteration's open question raised again against it.
      db.prepare(`UPDATE policy_revisions SET effective = json_patch(effective, ?) WHERE project = ?`).run(JSON.stringify(policy), made.project.id);
      for (const d of decisionsOf(db, made.project.id, 'prototype_preparation_approval')) db.prepare(`UPDATE decisions SET status = 'invalidated', invalidated_reason = 'test setup' WHERE id = ?`).run(d.id);
      transact(db, ENGINE_ACTOR, (tx) => B.raisePreparation(tx, { project: made.project.id, iteration: made.project.iteration }));
    }
    return made.project;
  };
  return { db, create };
}

const decisionsOf = (db, project, kind) => db.prepare('SELECT * FROM decisions WHERE project = ? AND kind = ? ORDER BY seq').all(project, kind);
const openPreparation = (db, project) => decisionsOf(db, project, 'prototype_preparation_approval').filter((d) => d.status === 'open');
const itemsOf = (db, project, kind) => db.prepare('SELECT * FROM work_items WHERE project = ? AND kind = ? ORDER BY seq').all(project, kind);
const runsOf = (db, project) => db.prepare('SELECT * FROM runs WHERE project = ? ORDER BY seq').all(project);
const answer = (db, project, d, option = 'approve', hash = d.preview_hash) => transact(db, HUMAN, (tx) => answerQueued(tx, { project, decision: d.id, option, preview_hash: hash, note: null }));
const claim = (db, project, workItem) => transact(db, ENGINE_ACTOR, (tx) => R.claimDispatch(tx, { project, workItem, incarnation: 'inc_1', scripted: 'scripted-1' }));
const manifestOf = (d) => JSON.parse(d.dependency_manifest);
const refusalCode = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return null;
};

// A policy revision committed through its finalizer, as the journal runs it
// (store/transitions/finalize.ts, purpose `policy`).
let ops = 0;
function commitPolicy(db, project, change) {
  const cur = db.prepare('SELECT r.* FROM projects p JOIN policy_revisions r ON r.id = p.policy_revision WHERE p.id = ?').get(project);
  const effective = { ...JSON.parse(cur.effective), ...change };
  const n = ++ops;
  transact(db, HUMAN, (tx) =>
    runFinalizer(tx, {
      id: `op_pol_${n}`,
      project,
      kind: 'ref_update',
      payload: {},
      inputs: { purpose: 'policy', ref: integrationRef('main'), ref_kind: 'integration', new_oid: `sha_pol_${n}`, revision: cur.revision + 1, blob: `blob_pol_${n}`, change, effective },
    }),
  );
}

// ---- the one function ----------------------------------------------------------------------

test("requestedModelOf: the role's policy model where set, the backend's model where not; a qualification attempt's own; refused with the role's model and why", async (t) => {
  const { db, create } = scratch(t);
  const p = await create({ model_spec_writer: 'sonnet-rqm-a' });
  assert.deepEqual(requestedModelOf(db, p.id, 'spec_writer'), { role: 'spec_writer', provider: 'scripted', model: 'sonnet-rqm-a', resolution: 'scripted', refusal: null, backend_model: 'scripted' });
  // A role whose policy names its schema default.
  assert.equal(requestedModelOf(db, p.id, 'builder').model, roleModel(db, p.id, 'builder'));
  // Not set: the backend's own model. Every dispatched role's key has a
  // schema default (an empty value reads as it), so a role with no
  // `model_<role>` key stands for it here.
  db.prepare(`UPDATE policy_revisions SET effective = json_set(effective, '$.model_architect', '') WHERE project = ?`).run(p.id);
  assert.equal(roleModel(db, p.id, 'architect'), 'opus', 'an empty key reads as its default');
  assert.equal(roleModel(db, p.id, 'rqm_keyless'), null);
  assert.deepEqual(requestedModelOf(db, p.id, 'rqm_keyless'), { role: 'rqm_keyless', provider: 'scripted', model: 'scripted', resolution: 'scripted', refusal: null, backend_model: 'scripted' });
  // A qualification attempt's backend keeps its model, whatever the role's.
  assert.deepEqual(requestedModelOf(db, p.id, 'spec_writer', { kind: 'attempt', backend: 'claude', version: '2.0.0', model: 'claude-rqm-attempt' }), {
    role: 'spec_writer',
    provider: 'claude',
    model: 'claude-rqm-attempt',
    resolution: 'attempt',
    refusal: null,
    backend_model: 'claude-rqm-attempt',
  });
  // Refused now (a real backend with no active entry): the model the role
  // requests is still what a run would record, the refusal beside it.
  db.prepare(`UPDATE policy_revisions SET effective = json_set(effective, '$.backend_spec_writer', 'claude') WHERE project = ?`).run(p.id);
  const refused = requestedModelOf(db, p.id, 'spec_writer');
  assert.deepEqual([refused.provider, refused.model, refused.resolution], ['claude', 'sonnet-rqm-a', 'refused']);
  assert.match(refused.refusal, /claude has no trust entry/);
});

// ---- the approval and its manifest ----------------------------------------------------------

test("the preparation approval names the requested model (the role's) and the backend apart; the question names both; nothing runs before it", async (t) => {
  const { db, create } = scratch(t);
  const p = await create({ model_spec_writer: 'sonnet-rqm-a' });
  const [d] = openPreparation(db, p.id);
  const m = manifestOf(d);
  for (const k of B.PREPARATION_KEYS) assert.ok(k in m, `the manifest binds ${k}`);
  assert.deepEqual([m.role, m.provider, m.model, m.resolution, m.paid], ['spec_writer', 'scripted', 'sonnet-rqm-a', 'scripted', false]);
  assert.match(d.question, /the Spec Writer \(role spec_writer\) on scripted model sonnet-rqm-a/);
  assert.match(d.question, /The model it requests, which the run records as its requested model, is sonnet-rqm-a; the backend is scripted\./);
  assert.match(d.question, /Approving authorizes exactly one preparation run; it approves neither the brief nor the build/);
  const approve = JSON.parse(d.options).find((o) => o.key === 'approve');
  assert.match(approve.consequence_text, /dispatched to the scripted provider, requesting model sonnet-rqm-a; no paid work follows/);
  assert.deepEqual(runsOf(db, p.id), []);
});

test('the role model changed while the approval is open: asked again naming the new model; the old preview refused; the new one approved dispatches one run requesting it', async (t) => {
  const { db, create } = scratch(t);
  const p = await create({ model_spec_writer: 'sonnet-rqm-a' });
  const [d1] = openPreparation(db, p.id);
  commitPolicy(db, p.id, { model_spec_writer: 'sonnet-rqm-b' });
  const after1 = db.prepare('SELECT * FROM decisions WHERE id = ?').get(d1.id);
  assert.equal(after1.status, 'invalidated', 'the open question raised in its next generation, the old one invalidated');
  assert.equal(manifestOf(after1).model, 'sonnet-rqm-a', 'its manifest kept as recorded');
  const [d2] = openPreparation(db, p.id);
  assert.notEqual(d2.preview_hash, d1.preview_hash, 'the preview changed with the role model');
  assert.equal(d2.semantic_generation, d1.semantic_generation + 1);
  assert.deepEqual([manifestOf(d2).model, manifestOf(d2).provider], ['sonnet-rqm-b', 'scripted'], 'the re-read names the new model');
  assert.match(d2.question, /on scripted model sonnet-rqm-b/);
  // The old answer: refused (the decision it names was invalidated); the
  // old hash on the new generation: stale. Nothing done either way.
  assert.equal(refusalCode(() => answer(db, p.id, d1)), 'decision_invalidated');
  assert.equal(refusalCode(() => answer(db, p.id, d2, 'approve', d1.preview_hash)), 'decision_stale');
  assert.deepEqual(itemsOf(db, p.id, 'brief_preparation'), []);
  answer(db, p.id, d2);
  const [item] = itemsOf(db, p.id, 'brief_preparation');
  const c = claim(db, p.id, item.id);
  assert.ok(c, 'dispatched');
  const runs = runsOf(db, p.id);
  assert.deepEqual(runs.map((r) => [r.role, r.model_requested]), [['spec_writer', 'sonnet-rqm-b']], 'exactly one run, requesting the approved model');
  assert.equal(db.prepare('SELECT model_requested FROM invocation_receipts WHERE run = ?').get(runs[0].id).model_requested, 'sonnet-rqm-b');
});

test('approved for model A, the role at B before dispatch: no run; the work cancelled; a new approval naming B says why; the consumed one keeps A; approved, the run requests B', async (t) => {
  const { db, create } = scratch(t);
  const p = await create({ model_spec_writer: 'sonnet-rqm-a' });
  const [d1] = openPreparation(db, p.id);
  answer(db, p.id, d1);
  const [item] = itemsOf(db, p.id, 'brief_preparation');
  commitPolicy(db, p.id, { model_spec_writer: 'sonnet-rqm-b' });
  assert.deepEqual(openPreparation(db, p.id), [], 'nothing asked at the commit: the approval is consumed');
  assert.equal(claim(db, p.id, item.id), null, 'not dispatched under the approval for A');
  assert.deepEqual(runsOf(db, p.id), [], 'no run requesting B');
  assert.equal(db.prepare('SELECT status FROM work_items WHERE id = ?').get(item.id).status, 'cancelled');
  const cancelled = db.prepare(`SELECT payload FROM events WHERE type = 'work.cancelled' ORDER BY seq DESC LIMIT 1`).get();
  assert.match(cancelled.payload, /requested_model_changed/);
  const old = db.prepare('SELECT * FROM decisions WHERE id = ?').get(d1.id);
  assert.deepEqual([old.status, manifestOf(old).model, old.preview_hash, old.dependency_manifest], ['consumed', 'sonnet-rqm-a', d1.preview_hash, d1.dependency_manifest], 'the consumed approval as recorded');
  const [d2] = openPreparation(db, p.id);
  assert.ok(d2, 'a new approval');
  assert.deepEqual([manifestOf(d2).model, manifestOf(d2).provider], ['sonnet-rqm-b', 'scripted']);
  assert.match(d2.question, new RegExp(`You are asked again: your approval \\(decision ${d1.id}\\) authorized a run requesting model sonnet-rqm-a, but the spec_writer role now requests model sonnet-rqm-b, so no run was dispatched under it\\.`));
  const it = db.prepare('SELECT * FROM prototype_iterations WHERE id = ?').get(p.iteration);
  assert.deepEqual([it.status, it.next_step], ['preparing', 'approve preparation or discard']);
  assert.match(it.outcome_reason, /now requests model sonnet-rqm-b, but the approval \(decision .+\) authorized a run requesting model sonnet-rqm-a/);
  // Answered, one run requesting B.
  answer(db, p.id, d2);
  const items = itemsOf(db, p.id, 'brief_preparation');
  assert.equal(items.length, 2);
  assert.ok(claim(db, p.id, items[1].id));
  assert.deepEqual(runsOf(db, p.id).map((r) => r.model_requested), ['sonnet-rqm-b']);
});

test("history kept: the run under A and its receipt still read A after the role's model changes; the brief's role list names each role's requested model with its backend", async (t) => {
  const { db, create } = scratch(t);
  const p = await create({ model_spec_writer: 'sonnet-rqm-a', model_verifier: 'sonnet-rqm-v' });
  const [d1] = openPreparation(db, p.id);
  answer(db, p.id, d1);
  const [item] = itemsOf(db, p.id, 'brief_preparation');
  const c = claim(db, p.id, item.id);
  // The brief's role list, read while the run is under way (briefFacts).
  const facts = transact(db, ENGINE_ACTOR, (tx) => B.briefFacts(tx.db, { project: p.id, run: c.run, environments: ['alpha'] }));
  const byRole = Object.fromEntries(facts.models.flatMap((m) => m.roles.map((r) => [r, [m.provider, m.model]])));
  for (const role of ['spec_writer', 'architect', 'verifier', 'builder']) {
    const rm = requestedModelOf(db, p.id, role);
    assert.deepEqual(byRole[role], [rm.provider, rm.model], `${role}: by the one function`);
  }
  assert.deepEqual([byRole.spec_writer, byRole.verifier], [['scripted', 'sonnet-rqm-a'], ['scripted', 'sonnet-rqm-v']]);
  commitPolicy(db, p.id, { model_spec_writer: 'sonnet-rqm-b' });
  assert.equal(db.prepare('SELECT model_requested FROM runs WHERE id = ?').get(c.run).model_requested, 'sonnet-rqm-a');
  assert.equal(db.prepare('SELECT model_requested FROM invocation_receipts WHERE run = ?').get(c.run).model_requested, 'sonnet-rqm-a');
  assert.equal(manifestOf(db.prepare('SELECT * FROM decisions WHERE id = ?').get(d1.id)).model, 'sonnet-rqm-a');
  assert.deepEqual(openPreparation(db, p.id), [], 'nothing asked again: the preparation is under way');
});
