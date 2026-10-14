// Developer test for one replan run per project at a time (slice 37; the
// driver's ruling, extending ruling 1 on the protected-path writers): two
// replans of one project write the same phase plan's files, so under D6 K2
// the second waits, eligible, while the first runs, and is dispatchable once
// it has ended. Another project's replan is not held. A specification
// change's replan is also held while that request's check correction is
// unfinished and until the checks its new protected version re-queued have
// results (the driver's ruling (a) on M434). Against a scratch store.

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
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { dispatchBlocker } = await import(join(dist, 'store', 'transitions', 'runs.js'));
const { holdReasonOf } = await import(join(dist, 'scheduler', 'holds.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });

const AT = '2026-10-14T00:00:00.000Z';

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, join(root, 'migrations'));
  for (const p of ['prj_1', 'prj_2']) {
    db.prepare(
      `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
       VALUES (?, ?, ?, 'T2', '/repo', 'main', 'spec_ready', 'registered', '{}')`,
    ).run(p, AT, p);
  }
  let seq = 0;
  const item = (id, project) => {
    db.prepare(
      `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
       VALUES (?, ?, ?, ?, 'replan', '{}', 'eligible', 'test', ?, 1, 0, 0, 0, 0)`,
    ).run(id, AT, project, ++seq, id);
    return () => db.prepare('SELECT * FROM work_items WHERE id = ?').get(id);
  };
  const runOf = (id, workItem, project, state) =>
    db.prepare(
      `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined)
       VALUES (?, ?, ?, ?, ?, 'architect', 'one_shot', ?, 'scripted', '1', 'm', ?, ?, 0)`,
    ).run(id, AT, project, ++seq, workItem, state, 'a'.repeat(40), AT);
  return { db, item, runOf };
}

test("a project's second replan waits while its first runs; dispatchable once it has ended; another project's is not held", (t) => {
  const { db, item, runOf } = store(t);
  const first = item('wi_r1', 'prj_1');
  const second = item('wi_r2', 'prj_1');
  const elsewhere = item('wi_r3', 'prj_2');
  assert.equal(dispatchBlocker(db, second(), { check: false }), null, 'with no replan under way, either may be dispatched');

  db.prepare(`UPDATE work_items SET status = 'executing' WHERE id = 'wi_r1'`).run();
  runOf('run_r1', 'wi_r1', 'prj_1', 'executing');
  const blocked = dispatchBlocker(db, second(), { check: false });
  assert.equal(blocked, 'depends on a replan running');
  assert.equal(holdReasonOf(blocked), 'depends_on', 'shown as a dependency hold');
  assert.equal(dispatchBlocker(db, elsewhere(), { check: false }), null, "another project's replan is not held");

  db.prepare(`UPDATE runs SET state = 'ended', outcome = 'completed' WHERE id = 'run_r1'`).run();
  db.prepare(`UPDATE work_items SET status = 'complete' WHERE id = 'wi_r1'`).run();
  assert.equal(first().status, 'complete');
  assert.equal(dispatchBlocker(db, second(), { check: false }), null, 'once the first has ended, the second is dispatched');
});

test("a specification change's replan is held while its request's check correction is unfinished, then while the checks it re-queued have no result", (t) => {
  const { db } = store(t);
  db.pragma('foreign_keys = OFF');
  const R = 'scr_1';
  const row = (id, kind, subject, status) =>
    db.prepare(
      `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
       VALUES (?, ?, 'prj_1', (SELECT COALESCE(MAX(seq), 0) + 1 FROM work_items), ?, ?, ?, 'test', ?, 1, 0, 0, 0, 0)`,
    ).run(id, AT, kind, JSON.stringify(subject), status, id);
  row('wi_rp', 'replan', { phase_plan: 'plan_1', request: R }, 'eligible');
  row('wi_cc', 'check_correction', { request: R }, 'executing');
  const replan = () => db.prepare(`SELECT * FROM work_items WHERE id = 'wi_rp'`).get();

  const held = dispatchBlocker(db, replan(), { check: false });
  assert.equal(held, `depends on the check correction of specification change request ${R}`);
  assert.equal(holdReasonOf(held), 'depends_on');

  // Parked for the owner, the correction is not under way: the replan goes on.
  db.prepare(`UPDATE work_items SET status = 'parked' WHERE id = 'wi_cc'`).run();
  assert.equal(dispatchBlocker(db, replan(), { check: false }), null, 'a parked correction holds nothing');

  // The correction applied: its proposal's new version re-queued a phase check.
  db.prepare(`UPDATE work_items SET status = 'complete' WHERE id = 'wi_cc'`).run();
  db.prepare(
    `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined)
     VALUES ('run_cc', ?, 'prj_1', 99, 'wi_cc', 'verifier', 'one_shot', 'ended', 'scripted', '1', 'm', ?, ?, 0)`,
  ).run(AT, 'a'.repeat(40), AT);
  db.prepare(
    `INSERT INTO protected_proposals (id, created_at, project, seq, proposed_by, run, base_revision, tree_id, diff_hash, requested_change_kind, status)
     VALUES ('prop_cc', ?, 'prj_1', 1, 'verifier_run', 'run_cc', ?, ?, 'd', 'unclassifiable', 'applied')`,
  ).run(AT, 'a'.repeat(40), 't'.repeat(40));
  db.prepare(
    `INSERT INTO check_executions (id, created_at, project, "check", key, candidate, source_revision, protected_version, runner_class, execution_seq, "trigger", trigger_key, status, registered_at)
     VALUES ('cx_1', ?, 'prj_1', 'chk_1', 'smoke', 'cand_1', ?, 'pv_2', 'direct', 1, ?, 'k', 'queued', ?)`,
  ).run(AT, 'a'.repeat(40), JSON.stringify({ source: 'protected_application', id: 'prop_cc', generation: 1 }), AT);
  assert.equal(dispatchBlocker(db, replan(), { check: false }), `depends on the checks the correction of specification change request ${R} re-queued`);

  db.prepare(`UPDATE check_executions SET status = 'recorded' WHERE id = 'cx_1'`).run();
  assert.equal(dispatchBlocker(db, replan(), { check: false }), null, 'the correction complete and its checks recorded: the replan is dispatched');
});

test("a project's specification change and its protected writers cannot interleave: each is held while the other is under way", (t) => {
  const { db } = store(t);
  db.pragma('foreign_keys = OFF');
  const row = (id, kind, subject, status = 'eligible') =>
    db.prepare(
      `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
       VALUES (?, ?, 'prj_1', (SELECT COALESCE(MAX(seq), 0) + 1 FROM work_items), ?, ?, ?, 'test', ?, 1, 0, 0, 0, 0)`,
    ).run(id, AT, kind, JSON.stringify(subject), status, id);
  const get = (id) => db.prepare('SELECT * FROM work_items WHERE id = ?').get(id);
  db.prepare(`INSERT INTO spec_change_requests (id, created_at, project, seq, request_text, source, status, work_item) VALUES ('scr_1', ?, 'prj_1', 1, 'change', 'owner', 'requested', 'wi_sc')`).run(AT);
  row('wi_sc', 'spec_change', { request: 'scr_1' });
  row('wi_auth', 'check_authoring', { phase_plan: 'plan_2' });

  // A check authoring runs: the change is held, not proposed beside it.
  db.prepare(`UPDATE work_items SET status = 'executing' WHERE id = 'wi_auth'`).run();
  db.prepare(
    `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined)
     VALUES ('run_auth', ?, 'prj_1', 50, 'wi_auth', 'verifier', 'one_shot', 'executing', 'scripted', '1', 'm', ?, ?, 0)`,
  ).run(AT, 'a'.repeat(40), AT);
  assert.equal(dispatchBlocker(db, get('wi_sc'), { check: false }), 'depends on a protected-path writer running');
  // Its run ended, its proposal captured and not decided: still held.
  db.prepare(`UPDATE runs SET state = 'ended', outcome = 'completed' WHERE id = 'run_auth'`).run();
  db.prepare(`UPDATE work_items SET status = 'awaiting_decision', continuation = 'executing' WHERE id = 'wi_auth'`).run();
  db.prepare(`INSERT INTO protected_proposals (id, created_at, project, seq, proposed_by, run, base_revision, tree_id, diff_hash, requested_change_kind, status) VALUES ('prop_1', ?, 'prj_1', 1, 'verifier_run', 'run_auth', 'b', 't', 'd', 'tightening', 'captured')`).run(AT);
  assert.equal(dispatchBlocker(db, get('wi_sc'), { check: false }), 'depends on a protected proposal not yet applied or rejected');
  assert.equal(holdReasonOf(dispatchBlocker(db, get('wi_sc'), { check: false })), 'depends_on');
  // Its question routed to the owner: the owner orders the two answers.
  db.prepare(`UPDATE protected_proposals SET status = 'awaiting_human' WHERE id = 'prop_1'`).run();
  assert.equal(dispatchBlocker(db, get('wi_sc'), { check: false }), null, "a proposal awaiting the owner's answer holds nothing");
  // Approved, its application under way: held again.
  db.prepare(`UPDATE protected_proposals SET status = 'approved' WHERE id = 'prop_1'`).run();
  assert.equal(dispatchBlocker(db, get('wi_sc'), { check: false }), 'depends on a protected proposal not yet applied or rejected');
  // Applied: the change goes on.
  db.prepare(`UPDATE protected_proposals SET status = 'applied' WHERE id = 'prop_1'`).run();
  db.prepare(`UPDATE work_items SET status = 'complete' WHERE id = 'wi_auth'`).run();
  assert.equal(dispatchBlocker(db, get('wi_sc'), { check: false }), null);

  // The other way: while the change is proposed (and until applied), no
  // protected writer of the project is dispatched; its own correction is.
  db.prepare(`UPDATE spec_change_requests SET status = 'proposed' WHERE id = 'scr_1'`).run();
  row('wi_auth2', 'check_authoring', { phase_plan: 'plan_3' });
  row('wi_own', 'check_correction', { request: 'scr_1' });
  assert.equal(dispatchBlocker(db, get('wi_auth2'), { check: false }), 'depends on specification change 1, being proposed or not yet applied');
  assert.equal(dispatchBlocker(db, get('wi_own'), { check: false }), null, "the request's own correction is not held by it");
  db.prepare(`UPDATE spec_change_requests SET status = 'approved' WHERE id = 'scr_1'`).run();
  assert.equal(dispatchBlocker(db, get('wi_auth2'), { check: false }), null, 'applied: the writer goes on');
});
