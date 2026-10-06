// Developer tests for Q13 (Sean's fourth attempt; D2 §1.6; SEAM.md §143):
// once a run's backend has exited on its own, its exit decides the run's
// end. A Stop or an Abandon confirmed after that is consumed and changes
// nothing, and no later cause the engine decides (a deadline, a budget)
// replaces the exit's end; the exit's own end (its class, its result, the
// acceptance of what it left) is taken. Against a scratch store with the
// engine's migrations and an engine runtime with no services. No process is
// started.

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
const { controlRun } = await import(join(dist, 'store', 'transitions', 'control.js'));
const { answerQueued } = await import(join(dist, 'store', 'transitions', 'queue.js'));
const { Runtime, newHandle } = await import(join(dist, 'runtime.js'));
const { answerFacts } = await import(join(dist, 'decisions', 'facts.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });

const AT = '2026-10-05T22:00:00.000Z';
const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function store(t) {
  const db = new Database(join(scratch(t), 'store.db'));
  t.after(() => db.close());
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  run(`INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management) VALUES ('prj_1', ?, 'p', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`, AT);
  run(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
     VALUES ('wi_1', ?, 'prj_1', 1, 'verification', '{}', 'executing', 'test', 'a', 1, 0, 0, 0, 0)`,
    AT,
  );
  run(
    `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined)
     VALUES ('run_1', ?, 'prj_1', 1, 'wi_1', 'verifier', 'one_shot', 'executing', 'scripted', '1', 'm', ?, ?, 0)`,
    AT,
    'a'.repeat(40),
    '2026-10-05T23:00:00.000Z',
  );
  return db;
}

const stop = (db, extra) => transact(db, ENGINE_ACTOR, (tx) => controlRun(tx, { project: 'prj_1', run: 'run_1', kind: 'stop', previewHash: undefined, ...extra }));
function confirmStop(db, extra = {}) {
  const first = stop(db, {});
  assert.equal(first.status, 409);
  return stop(db, { previewHash: first.body.subject.preview_hash, ...extra });
}
const runOf = (db) => db.prepare('SELECT state, outcome, reason_class FROM runs WHERE id = ?').get('run_1');
const events = (db, type) => db.prepare('SELECT * FROM events WHERE type = ?').all(type);

test('a Stop confirmed before the exit begins the run end: stopped / human_stop', (t) => {
  const db = store(t);
  const r = confirmStop(db);
  assert.equal(r.status, 200);
  assert.deepEqual(runOf(db), { state: 'finalizing', outcome: 'stopped', reason_class: 'human_stop' });
  assert.deepEqual(r.effects, [{ kind: 'end_run', run: 'run_1' }]);
});

test('a Stop confirmed after the backend exited on its own is consumed and changes nothing: the run goes on to its exit\'s end', (t) => {
  const db = store(t);
  const r = confirmStop(db, { exited: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.run.ended_by, 'backend_exit');
  assert.deepEqual(runOf(db), { state: 'executing', outcome: null, reason_class: null }, 'not finalizing, no outcome of the Stop');
  assert.equal(r.effects, undefined, 'no run end begun');
  assert.deepEqual(events(db, 'run.finalizing'), []);
  assert.equal(db.prepare(`SELECT status FROM decisions WHERE kind = 'stop_confirm'`).get().status, 'consumed', 'the confirmation is consumed');
});

test('the same through the decision\'s answer, and for an Abandon', (t) => {
  const db = store(t);
  stop(db, {});
  const d = db.prepare(`SELECT * FROM decisions WHERE kind = 'stop_confirm'`).get();
  const r = transact(db, ENGINE_ACTOR, (tx) => answerQueued(tx, { project: 'prj_1', decision: d.id, option: 'confirm', preview_hash: d.preview_hash, note: null, facts: { exited: true } }));
  assert.equal(r.status, 200);
  assert.deepEqual(runOf(db), { state: 'executing', outcome: null, reason_class: null });

  const db2 = store(t);
  const a1 = transact(db2, ENGINE_ACTOR, (tx) => controlRun(tx, { project: 'prj_1', run: 'run_1', kind: 'abandon', previewHash: undefined }));
  const a2 = transact(db2, ENGINE_ACTOR, (tx) => controlRun(tx, { project: 'prj_1', run: 'run_1', kind: 'abandon', previewHash: a1.body.subject.preview_hash, exited: true }));
  assert.equal(a2.status, 200);
  assert.deepEqual(runOf(db2), { state: 'executing', outcome: null, reason_class: null });
});

// The runtime: what the engine itself decides after the exit.
function runtimeWith(t) {
  const ended = [];
  const rt = new Runtime({ call: async () => null }, { values: {} }, 'inc_unit', scratch(t));
  rt.services = { endRun: async (run, end) => void ended.push({ run, ...end }) };
  const handle = newHandle({ run: 'run_1', project: 'prj_1', work_item: 'wi_1', work_kind: 'verification', role: 'verifier', domain: 'dom_1', invocation: 'inv_1', generation: 1, deadline_at: '2026-10-05T23:00:00.000Z', attempt: null, entry: null });
  rt.handles.set('run_1', handle);
  return { rt, handle, ended };
}

test("after the backend's own exit, a deadline's or a budget's end is not taken; the exit's own end is", async (t) => {
  const { rt, handle, ended } = runtimeWith(t);
  handle.exitedFirst = true;
  assert.equal(rt.exitedFirst('run_1'), true);
  rt.requestEnd(handle, { outcome: 'timed_out', reason: 'deadline' });
  rt.requestEnd(handle, { outcome: 'stopped', reason: 'budget', reasonText: 'budget_day_unknown_tokens' });
  assert.equal(handle.ending, false, 'neither ends the run');
  rt.requestEnd(handle, { outcome: 'failed', reason: 'infra_error', reasonText: 'exit class error_exit: the backend failed without a result' }, { afterExit: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(handle.ending, true);
  assert.deepEqual(ended.map((e) => [e.outcome, e.reason]), [['failed', 'infra_error']], "E84's error_exit outcome stands");
});

test('before the exit every cause ends the run as before', async (t) => {
  const { rt, handle, ended } = runtimeWith(t);
  assert.equal(rt.exitedFirst('run_1'), false);
  rt.requestEnd(handle, { outcome: 'stopped', reason: 'budget', reasonText: 'budget_run_billable_tokens' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ended.map((e) => e.outcome), ['stopped']);
});

test('the decision answer is told whether the run\'s backend exited first', async () => {
  const rt = { read: async () => ({ kind: 'stop_confirm', oob: null, run: 'run_1' }), exitedFirst: (r) => r === 'run_1' };
  assert.deepEqual(await answerFacts(rt, 'prj_1', 'dec_1'), { exited: true });
  const rt2 = { read: async () => ({ kind: 'abandon_confirm', oob: null, run: 'run_2' }), exitedFirst: () => false };
  assert.deepEqual(await answerFacts(rt2, 'prj_1', 'dec_2'), {});
});
