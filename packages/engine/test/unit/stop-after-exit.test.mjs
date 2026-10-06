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
const { Launcher } = await import(join(dist, 'invoke', 'choke.js'));
const { finishRun } = await import(join(dist, 'store', 'transitions', 'runs.js'));
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

test("a Stop confirmed after the backend's own clean exit applies to the work: the run goes on to its exit's end; the confirmation records it", (t) => {
  const db = store(t);
  const r = confirmStop(db, { exited: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.run.ended_by, undefined, 'the answer does not say the run ended');
  assert.equal(r.body.applied.to, 'work');
  assert.match(r.body.applied.reason, /outcome follows that exit/);
  assert.match(r.body.applied.work, /held/);
  assert.deepEqual(runOf(db), { state: 'executing', outcome: null, reason_class: null }, 'not finalizing, no outcome of the Stop');
  assert.deepEqual(r.effects, [{ kind: 'control_after_exit', run: 'run_1', control: 'stop' }], 'the engine is told, no run end begun');
  assert.deepEqual(events(db, 'run.finalizing'), []);
  const d = db.prepare(`SELECT status, answer FROM decisions WHERE kind = 'stop_confirm'`).get();
  assert.equal(d.status, 'consumed');
  assert.deepEqual([JSON.parse(d.answer).applied_to, JSON.parse(d.answer).after_backend_exit], ['work', true], 'recorded durably on the consumed confirmation');
});

test('the same through the decision\'s answer, and for an Abandon', (t) => {
  const db = store(t);
  stop(db, {});
  const d = db.prepare(`SELECT * FROM decisions WHERE kind = 'stop_confirm'`).get();
  const r = transact(db, ENGINE_ACTOR, (tx) => answerQueued(tx, { project: 'prj_1', decision: d.id, option: 'confirm', preview_hash: d.preview_hash, note: null, facts: { exited: true } }));
  assert.equal(r.status, 200);
  assert.deepEqual(runOf(db), { state: 'executing', outcome: null, reason_class: null });
  assert.equal(JSON.parse(db.prepare('SELECT answer FROM decisions WHERE id = ?').get(d.id).answer).applied_to, 'work');

  const db2 = store(t);
  const a1 = transact(db2, ENGINE_ACTOR, (tx) => controlRun(tx, { project: 'prj_1', run: 'run_1', kind: 'abandon', previewHash: undefined }));
  const a2 = transact(db2, ENGINE_ACTOR, (tx) => controlRun(tx, { project: 'prj_1', run: 'run_1', kind: 'abandon', previewHash: a1.body.subject.preview_hash, exited: true }));
  assert.equal(a2.status, 200);
  assert.deepEqual(a2.effects, [{ kind: 'control_after_exit', run: 'run_1', control: 'abandon' }]);
  assert.deepEqual(runOf(db2), { state: 'executing', outcome: null, reason_class: null });
});

// The run's end, the store's side: the outcome is the exit's, the work held.
function endRun(db, outcome, reason) {
  db.prepare(`UPDATE runs SET state = 'finalizing', outcome = ?, reason_class = ? WHERE id = 'run_1'`).run(outcome, reason);
  transact(db, ENGINE_ACTOR, (tx) => finishRun(tx, { run: 'run_1', invocations: {}, recovery: null }));
  return { run: runOf(db), work: db.prepare('SELECT status, dispatch_hold FROM work_items').get() };
}

test('a run completed by its exit after a Stop confirmed meanwhile: completed, and its work held, not complete', (t) => {
  const db = store(t);
  confirmStop(db, { exited: true });
  const r = endRun(db, 'completed', 'none');
  assert.deepEqual(r.run, { state: 'ended', outcome: 'completed', reason_class: 'none' });
  assert.deepEqual(r.work, { status: 'held', dispatch_hold: 0 }, 'held, so nothing is dispatched next');
});

test('the same after an Abandon: the work under its dispatch hold', (t) => {
  const db = store(t);
  const a1 = transact(db, ENGINE_ACTOR, (tx) => controlRun(tx, { project: 'prj_1', run: 'run_1', kind: 'abandon', previewHash: undefined }));
  transact(db, ENGINE_ACTOR, (tx) => controlRun(tx, { project: 'prj_1', run: 'run_1', kind: 'abandon', previewHash: a1.body.subject.preview_hash, exited: true }));
  const r = endRun(db, 'completed', 'none');
  assert.equal(r.run.outcome, 'completed');
  assert.equal(r.work.dispatch_hold, 1);
  assert.notEqual(r.work.status, 'complete');
});

test('without a Stop after the exit, a completed verification completes its work as before', (t) => {
  const db = store(t);
  assert.deepEqual(endRun(db, 'completed', 'none').work, { status: 'complete', dispatch_hold: 0 });
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

test("while the exit's end is undecided, a deadline's or a budget's end is not taken (logged once each); the exit's own end is", async (t) => {
  const { rt, handle, ended } = runtimeWith(t);
  handle.exitedFirst = true;
  assert.equal(rt.exitedFirst('run_1'), true);
  for (let i = 0; i < 5; i++) rt.requestEnd(handle, { outcome: 'timed_out', reason: 'deadline' });
  rt.requestEnd(handle, { outcome: 'stopped', reason: 'budget', reasonText: 'budget_day_unknown_tokens' });
  assert.equal(handle.ending, false, 'neither ends the run');
  assert.deepEqual([...handle.endsNotTaken].sort(), ['stopped/budget', 'timed_out/deadline'], 'each logged once (M2)');
  rt.requestEnd(handle, { outcome: 'completed', reason: 'none' }, { afterExit: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(handle.ending, true);
  assert.deepEqual(ended.map((e) => [e.outcome, e.reason]), [['completed', 'none']]);
});

test('once the exit\'s end is decided (exitedFirst cleared), a deadline ends the run as before (S1)', async (t) => {
  const { rt, handle, ended } = runtimeWith(t);
  handle.exitedFirst = false;
  rt.requestEnd(handle, { outcome: 'timed_out', reason: 'deadline' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ended.map((e) => e.outcome), ['timed_out']);
});

test("the store's effect tells the engine of a Stop after the exit", (t) => {
  const { rt, handle } = runtimeWith(t);
  rt.afterCommit([{ kind: 'control_after_exit', run: 'run_1', control: 'stop' }]);
  assert.equal(handle.controlAfterExit, 'stop');
});

// The engine's callbacks with a stand-in runtime (the Reviewer's R3, R4).
function launcherWith(handle, real, over) {
  return new Launcher({ requestEnd: (h, e, o) => real.requestEnd(h, e, o), setting: () => 0, read: async () => null, role: async () => true, ...over });
}

test('a terminal usage line passing a limit stops the run: it is acted on before the exit is taken (S3)', async (t) => {
  const { rt, handle, ended } = runtimeWith(t);
  // As at the terminal line: the output is not yet drained, so exitedFirst is not set.
  const launcher = launcherWith(handle, rt, { read: async () => 'budget_run_billable_tokens' });
  await launcher.callback(handle, JSON.stringify({ type: 'usage', semantics: 'delta', raw: { input_tokens: 50000, output_tokens: 10 } }));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ended.map((e) => [e.outcome, e.reason, e.reasonText]), [['stopped', 'budget', 'budget_run_billable_tokens']]);
});

test('a usage observation that can never be recorded stops the run budget_unreadable, after the exit too (M1)', { timeout: 30_000 }, async (t) => {
  const { rt, handle, ended } = runtimeWith(t);
  handle.exitedFirst = true;
  const launcher = launcherWith(handle, rt, { role: async () => { throw Object.assign(new Error('injected'), { code: 'store_error' }); } });
  await launcher.callback(handle, JSON.stringify({ type: 'usage', semantics: 'delta', raw: { input_tokens: 5, output_tokens: 1 } }));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ended.map((e) => [e.outcome, e.reasonText]), [['stopped', 'budget_unreadable']]);
});

test('the decision answer is told whether the run\'s backend exited first', async () => {
  const rt = { read: async () => ({ kind: 'stop_confirm', oob: null, run: 'run_1' }), exitedFirst: (r) => r === 'run_1' };
  assert.deepEqual(await answerFacts(rt, 'prj_1', 'dec_1'), { exited: true });
  const rt2 = { read: async () => ({ kind: 'abandon_confirm', oob: null, run: 'run_2' }), exitedFirst: () => false };
  assert.deepEqual(await answerFacts(rt2, 'prj_1', 'dec_2'), {});
});

test('a re-grant reports it decided the run only when the run is in fact ending (M3)', async (t) => {
  for (const exitedFirst of [true, false]) {
    const { rt, handle } = runtimeWith(t);
    handle.exitedFirst = exitedFirst;
    handle.sandbox = { exitReport: null };
    handle.claim.cgroup_path = '/sys/fs/cgroup/unit-none';
    const launcher = launcherWith(handle, rt, {
      handles: rt.handles,
      incarnation: 'inc_unit',
      services: null,
      read: async (name) => (name === 'run.regrant_facts' ? { eligible: true, reason: null, generation: 1, domain: 'dom_1', invocation: 'inv_1', deadline_at: '2000-01-01T00:00:00.000Z' } : null),
    });
    const decided = await launcher.regrant('run_1');
    assert.equal(decided, !exitedFirst, `exitedFirst ${exitedFirst}: decided ${decided}, ending ${handle.ending}`);
    assert.equal(handle.ending, !exitedFirst);
  }
});
