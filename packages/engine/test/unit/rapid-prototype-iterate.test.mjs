// Developer tests for Rapid prototype slice E4, Iterate (migration 0046; the
// owner's rulings R7 and R8 of 2026-10-28), against a scratch store with the
// engine's migrations: Iterate refused while the iteration has not ended,
// while a run of the project is under way and from an iteration that is not
// the current one; the predecessor's unfinished work cancelled and the
// questions about it invalidated; the new iteration's preparation question
// and its package's facts naming the iteration it continues, the change and
// the latest approved brief of its predecessors. The HTTP path end to end is
// rapid-prototype-demo.test.mjs's.

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
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { configureHarness } = await import(join(dist, 'testing', 'seam.js'));
const { configureGit } = await import(join(dist, 'git', 'exec.js'));
const { prepareNewProject } = await import(join(dist, 'setup', 'projects.js'));
const { bootstrapProject } = await import(join(dist, 'store', 'transitions', 'project.js'));
const R = await import(join(dist, 'store', 'transitions', 'runs.js'));
const { observeTrigger } = await import(join(dist, 'store', 'transitions', 'work.js'));
const { iterate, changeOf } = await import(join(dist, 'prototype', 'iterate.js'));
const { briefPreparationFacts, briefPreparationText } = await import(join(dist, 'prototype', 'brief.js'));
const { readIteration } = await import(join(dist, 'prototype', 'iterations.js'));

setEngineSettings({ lease_ttl: 600, git_deadline: 30, decision_targets: {}, incarnation: 'inc_1' });
const HUMAN = { actor_kind: 'human', actor_id: null, request_id: 'req-1' };
const AT = '2026-10-28T00:00:00.000Z';
const BRIEF = { app: 'Tasks', limitations: ['tasks are lost on restart'], objectives: ['R1: add', 'R2: list', 'R3: finish'] };

function scratch(t) {
  assert.equal(configureHarness(true, []), null);
  t.after(() => configureHarness(false, []));
  const dir = mkdtempSync(join(tmpdir(), 'surety-rpi-'));
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
  const prepared = prepareNewProject(rt, { name: 'Proto', idea: 'A small app.', dev_repo_path: join(dir, 'app'), mode: 'rapid_prototype' });
  return { db, prepared };
}

async function project(t) {
  const { db, prepared } = scratch(t);
  const ready = await prepared;
  const made = transact(db, HUMAN, (tx) => bootstrapProject(tx, ready));
  db.prepare(`UPDATE projects SET registration_state = 'registered', paused = 0 WHERE id = ?`).run(made.project.id);
  return { db, p: made.project };
}

const iterationRow = (db, id) => db.prepare('SELECT * FROM prototype_iterations WHERE id = ?').get(id);
const run = (db, fn) => transact(db, HUMAN, fn);
const refusal = (fn) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
};

test('Iterate is refused until the current iteration has ended, while a run is under way, and from an iteration that is not the current one', async (t) => {
  const { db, p } = await project(t);
  const r1 = refusal(() => run(db, (tx) => iterate(tx, { project: p.id, iteration: p.iteration, change: null })));
  assert.deepEqual([r1?.status, r1?.code], [409, 'illegal_transition'], 'a preparing iteration has not ended');
  assert.match(r1.reason, /is preparing: an iteration is iterated once it has ended/);
  // Ended by a limit, but a run of the project is still under way.
  const wi = transact(db, ENGINE_ACTOR, (tx) => observeTrigger(tx, { project: p.id, kind: 'fix', trigger_source: 'test', trigger_id: 'a', trigger_generation: 1 }, {})).work_item.id;
  const c = transact(db, ENGINE_ACTOR, (tx) => R.claimDispatch(tx, { project: p.id, workItem: wi, incarnation: 'inc_1', scripted: 'scripted-1' }));
  assert.ok(c);
  db.prepare(`UPDATE prototype_iterations SET status = 'limit_reached' WHERE id = ?`).run(p.iteration);
  const r2 = refusal(() => run(db, (tx) => iterate(tx, { project: p.id, iteration: p.iteration, change: null })));
  assert.equal(r2?.status, 409);
  assert.deepEqual(r2.subject.runs, [c.run], 'the run under way is named');
  // The run ended: Iterate goes on.
  db.prepare(`UPDATE runs SET state = 'ended', outcome = 'failed' WHERE id = ?`).run(c.run);
  const made = run(db, (tx) => iterate(tx, { project: p.id, iteration: p.iteration, change: 'Bigger buttons.' }));
  assert.equal(made.status, 201);
  const r3 = refusal(() => run(db, (tx) => iterate(tx, { project: p.id, iteration: p.iteration, change: null })));
  assert.equal(r3?.status, 409, 'iteration 1 is no longer the current one');
  assert.match(r3.reason, /not the project's current iteration/);
  const r4 = refusal(() => run(db, (tx) => iterate(tx, { project: p.id, iteration: 'it_none', change: null })));
  assert.equal(r4?.status, 404);
  // The change text: absent or null is none; empty or too long is refused.
  assert.equal(changeOf(undefined), null);
  assert.equal(changeOf('x'), 'x');
  for (const bad of ['', '   ', 7, 'y'.repeat(4001)]) assert.equal(refusal(() => changeOf(bad))?.status, 400, JSON.stringify(bad).slice(0, 20));
});

test("Iterate cancels the predecessor's unfinished work and invalidates the questions about it; the predecessor's row is kept", async (t) => {
  const { db, p } = await project(t);
  const wi = transact(db, ENGINE_ACTOR, (tx) => observeTrigger(tx, { project: p.id, kind: 'fix', trigger_source: 'test', trigger_id: 'b', trigger_generation: 1 }, {})).work_item.id;
  db.prepare(`UPDATE prototype_iterations SET status = 'failed', ended_at = ?, outcome_reason = 'parked' WHERE id = ?`).run(AT, p.iteration);
  const before = iterationRow(db, p.iteration);
  const prep = db.prepare(`SELECT id FROM decisions WHERE kind = 'prototype_preparation_approval' AND status = 'open'`).get();
  assert.ok(prep, "iteration 1's preparation question is open");
  const made = run(db, (tx) => iterate(tx, { project: p.id, iteration: p.iteration, change: null }));
  assert.deepEqual(made.body.cancelled_work, [wi]);
  assert.equal(db.prepare('SELECT status FROM work_items WHERE id = ?').get(wi).status, 'cancelled');
  assert.deepEqual(made.body.invalidated_decisions, [prep.id], "the predecessor's open question is invalidated");
  assert.equal(db.prepare('SELECT status FROM decisions WHERE id = ?').get(prep.id).status, 'invalidated');
  assert.deepEqual(iterationRow(db, p.iteration), before, 'the predecessor row is unchanged');
  const two = iterationRow(db, made.body.iteration.id);
  assert.deepEqual([two.seq, two.status, two.predecessor, two.change_text, two.next_step], [2, 'preparing', p.iteration, null, 'approve preparation or discard']);
  assert.deepEqual(JSON.parse(two.limits_json), JSON.parse(before.limits_json), 'the limits snapshotted from the same policy');
  const ev = db.prepare(`SELECT payload FROM events WHERE type = 'prototype.iteration_iterated'`).all().map((e) => JSON.parse(e.payload));
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].predecessor, ev[0].predecessor_status, ev[0].cancelled_work], [p.iteration, 'failed', [wi]]);
  // Each iteration's totals are its own; the app's sum both once.
  const read = readIteration(db, { project: p.id, iteration: two.id });
  assert.deepEqual([read.usage.totals.agent_runs, read.app_totals.iterations, read.app_totals.agent_runs], [0, 2, 0]);
});

test("the continuing iteration's preparation: the question names iteration N+1 continuing from N with the change; its package carries the latest approved brief of its predecessors and the change", async (t) => {
  const { db, p } = await project(t);
  // Iteration 1 approved a brief, then was discarded; iteration 2 approved none and was discarded too.
  db.prepare(`UPDATE prototype_iterations SET status = 'discarded', approved_at = ?, brief_json = ?, ended_at = ? WHERE id = ?`).run(AT, JSON.stringify(BRIEF), AT, p.iteration);
  const two = run(db, (tx) => iterate(tx, { project: p.id, iteration: p.iteration, change: 'Show the count.' })).body.iteration.id;
  const q2 = db.prepare(`SELECT question, dependency_manifest FROM decisions WHERE kind = 'prototype_preparation_approval' AND subject_id = ? AND status = 'open'`).get(two);
  assert.match(q2.question, /^Authorize one brief preparation run for prototype iteration 2\? This is iteration 2 of the app, continuing from iteration 1: the change you asked for is "Show the count\."; the preparation starts from the brief approved in iteration 1/);
  assert.deepEqual(JSON.parse(q2.dependency_manifest).continues, { iteration: p.iteration, seq: 1, previous_brief_iteration_seq: 1, previous_brief_spec_revision: null });
  db.prepare(`UPDATE prototype_iterations SET status = 'discarded', ended_at = ? WHERE id = ?`).run(AT, two);
  const three = run(db, (tx) => iterate(tx, { project: p.id, iteration: two, change: 'And a dark theme.' })).body.iteration.id;
  const d3 = db.prepare(`SELECT id FROM decisions WHERE kind = 'prototype_preparation_approval' AND subject_id = ? AND status = 'open'`).get(three);
  const facts = briefPreparationFacts(db, { id: 'wi_x', project: p.id, subject: JSON.stringify({ decision: d3.id }) });
  assert.deepEqual([facts.iteration_seq, facts.continues.predecessor_seq, facts.continues.change, facts.continues.previous_brief_iteration_seq], [3, 2, 'And a dark theme.', 1], 'the chain is followed back to the latest approved brief');
  assert.deepEqual(facts.continues.previous_brief, BRIEF);
  const text = briefPreparationText(facts).join('\n');
  assert.match(text, /## Continuing from the previous iteration/);
  assert.match(text, /The owner's change request: "And a dark theme\."/);
  assert.match(text, /The previous approved brief \(iteration 1\) is in \/surety\/context\/prototype-brief\.json under continues\.previous_brief/);
  // A first iteration's facts continue nothing.
  const d1 = db.prepare(`SELECT id FROM decisions WHERE kind = 'prototype_preparation_approval' AND subject_id = ?`).get(p.iteration);
  assert.equal(briefPreparationFacts(db, { id: 'wi_y', project: p.id, subject: JSON.stringify({ decision: d1.id }) }).continues, null);
});
