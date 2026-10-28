// Developer tests for Rapid prototype slice E2 (the owner's rulings R4 and
// R8 of 2026-10-28): the dispatch check against the iteration's allowance
// (committed tokens plus the run's reservation, one account shared with the
// read; two claims never both passing; the estimated-cost threshold with an
// unknown cost never 0; the repair limits; the runtime), the two-step Stop and
// Discard of an iteration on the existing stop machinery, and the read's
// `remaining`, `outcome` and `controls`. A scratch store with the engine's
// migrations and a scratch git repository; the scripted backend of the
// harness; no engine, process, unit or host resource is started (a teardown
// is only requested, never run).

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
const { readProject } = await import(join(dist, 'store', 'projections.js'));
const { dispatchCandidates } = await import(join(dist, 'store', 'reads.js'));
const { markHolds } = await import(join(dist, 'scheduler', 'holds.js'));
const { readIteration } = await import(join(dist, 'prototype', 'iterations.js'));
const P = await import(join(dist, 'store', 'transitions', 'prototype.js'));
const { controlIteration, answerDecision } = await import(join(dist, 'store', 'transitions', 'control.js'));
const { openSession } = await import(join(dist, 'sessions', 'session.js'));

setEngineSettings({ lease_ttl: 600, git_deadline: 30, decision_targets: {} });
const HUMAN = { actor_kind: 'human', actor_id: null, request_id: 'req-1' };
const AT = '2026-10-28T00:00:00.000Z';
// The prototype preset's per-run limit (slice E3, the driver's setting).
const RUN_LIMIT = 300_000;

function scratch(t) {
  assert.equal(configureHarness(true, []), null);
  t.after(() => configureHarness(false, []));
  const dir = mkdtempSync(join(tmpdir(), 'surety-rpb-'));
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
  const create = async (limits = {}) => {
    const prepared = await prepareNewProject(rt, { name: 'Proto', idea: 'A small app.', dev_repo_path: join(dir, `app${++n}`), mode: 'rapid_prototype' });
    const made = transact(db, HUMAN, (tx) => bootstrapProject(tx, prepared));
    db.prepare(`UPDATE projects SET registration_state = 'registered', paused = 0 WHERE id = ?`).run(made.project.id);
    setLimits(db, made.project.iteration, limits);
    // From slice E3 the iteration's creation asks the owner to authorize its
    // brief preparation; here it is taken as answered (the limits are under
    // test, not the preparation), so that no owner question is open.
    db.prepare(`UPDATE decisions SET status = 'consumed', consumed_at = ? WHERE project = ? AND kind = 'prototype_preparation_approval'`).run(AT, made.project.id);
    return made.project;
  };
  return { db, create };
}

const setLimits = (db, iteration, change) => {
  const row = db.prepare('SELECT limits_json FROM prototype_iterations WHERE id = ?').get(iteration);
  db.prepare('UPDATE prototype_iterations SET limits_json = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.limits_json), ...change }), iteration);
};
const item = (db, project, trigger) => transact(db, ENGINE_ACTOR, (tx) => observeTrigger(tx, { project, kind: 'fix', trigger_source: 'test', trigger_id: trigger, trigger_generation: 1 }, {})).work_item.id;
const claim = (db, project, wi) => transact(db, ENGINE_ACTOR, (tx) => R.claimDispatch(tx, { project, workItem: wi, incarnation: 'inc_1', scripted: 'scripted-1' }));
function dispatch(db, project, trigger) {
  const wi = item(db, project, trigger);
  const c = claim(db, project, wi);
  assert.ok(c, `${trigger} is dispatched`);
  return { wi, run: c.run, inv: db.prepare('SELECT id FROM invocation_receipts WHERE run = ?').get(c.run).id, dom: db.prepare('SELECT id FROM execution_domains WHERE run = ?').get(c.run).id };
}
const launch = (db, r) =>
  transact(db, ENGINE_ACTOR, (tx) => {
    R.dispatchStarted(tx, { run: r.run, invocation: r.inv });
    R.recordLaunch(tx, { run: r.run, invocation: r.inv, domain: r.dom, pid: 999999, pgid: 999999, startTime: null });
  });
const usage = (db, r, raw) => transact(db, ENGINE_ACTOR, (tx) => R.recordUsage(tx, { run: r.run, generation: 1, invocation: r.inv, semantics: 'cumulative', raw }));
function settle(db, r) {
  transact(db, ENGINE_ACTOR, (tx) => R.domainTerminated(tx, { domain: r.dom, observed: true }));
  const inv = Object.fromEntries(db.prepare('SELECT id FROM invocation_receipts WHERE run = ?').all(r.run).map((x) => [x.id, 'ended']));
  transact(db, ENGINE_ACTOR, (tx) => R.finishRun(tx, { run: r.run, invocations: inv, recovery: null }));
}
function runWith(db, project, trigger, raw) {
  const r = dispatch(db, project, trigger);
  launch(db, r);
  if (raw) usage(db, r, raw);
  transact(db, ENGINE_ACTOR, (tx) => R.beginEnd(tx, { run: r.run, outcome: 'completed', reason: 'none' }));
  settle(db, r);
  return r;
}
const iteration = (db, id) => db.prepare('SELECT * FROM prototype_iterations WHERE id = ?').get(id);
const events = (db, type) => db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY seq').all(type).map((e) => JSON.parse(e.payload));
const eligibleAgain = (db, wi, attempts) => db.prepare(`UPDATE work_items SET status = 'eligible', repair_due = 1, repair_attempts = ? WHERE id = ?`).run(attempts, wi);

test('tokens: committed plus the reservation is checked in the claim; two claims cannot both pass; settling holds, final records limit_reached; a raised limit reopens', async (t) => {
  const { db, create } = scratch(t);
  const p = await create({ prototype_budget_tokens: 400_000 });
  const a = item(db, p.id, 'a');
  const b = item(db, p.id, 'b');
  // Both pass the scheduler's read before either is claimed, as at one tick.
  const listed = dispatchCandidates(db).find((c) => c.project === p.id).items.map((i) => i.id);
  assert.deepEqual(listed, [a, b]);
  const first = claim(db, p.id, a);
  assert.ok(first, 'the first claim: 0 committed + 300,000 reserved fits 400,000');
  assert.equal(claim(db, p.id, b), null, 'the second claim, in its own transaction, sees the first one reservation: 600,000 > 400,000');
  assert.equal(iteration(db, p.iteration).status, 'preparing', 'only reservations of runs under way stand in the way: held, not ended');
  const r = { run: first.run, inv: db.prepare('SELECT id FROM invocation_receipts WHERE run = ?').get(first.run).id, dom: db.prepare('SELECT id FROM execution_domains WHERE run = ?').get(first.run).id };
  launch(db, r);
  usage(db, r, { input_tokens: 60_000, output_tokens: 20_000 });
  transact(db, ENGINE_ACTOR, (tx) => markHolds(tx));
  assert.equal(db.prepare('SELECT held FROM work_items WHERE id = ?').get(b).held, 'depends_on', 'the settling hold is recorded as a wait on running work');
  let read = readIteration(db, { project: p.id, iteration: p.iteration });
  assert.deepEqual(read.remaining.committed, { settled_tokens: 0, unknown_allowance_tokens: 0, under_way_observed_tokens: 80_000, under_way_reserved_tokens: RUN_LIMIT - 80_000, total_tokens: RUN_LIMIT });
  assert.equal(read.remaining.tokens, 400_000 - RUN_LIMIT, 'the read and the check count the same account');
  assert.deepEqual([read.remaining.enforced, read.remaining.enforcement, read.remaining.overshoot], [true, 'dispatch_check', 'running runs end at their own limits and deadlines']);
  assert.equal(read.remaining.next_dispatch.kind, 'settling');
  assert.equal(read.remaining.next_run_reservation_tokens, RUN_LIMIT);

  // What it observed can only grow: at 120,000 observed, 120,000 + 300,000
  // passes the limit whatever the run does now.
  usage(db, r, { input_tokens: 100_000, output_tokens: 20_000 });
  assert.equal(readIteration(db, { project: p.id, iteration: p.iteration }).remaining.next_dispatch.kind, 'final');
  transact(db, ENGINE_ACTOR, (tx) => R.beginEnd(tx, { run: r.run, outcome: 'completed', reason: 'none' }));
  settle(db, r);
  // Settled at 120,000: 120,000 + 300,000 > 400,000 whatever runs do now.
  assert.equal(claim(db, p.id, b), null);
  const it = iteration(db, p.iteration);
  assert.equal(it.status, 'limit_reached');
  assert.match(it.outcome_reason, /^tokens: prototype_budget_tokens 400000: committed 120000 \(settled 120000, unknown allowances 0, under way 0 observed \+ 0 reserved\) \+ this run's reservation 300000 = 420000 exceeds it/);
  assert.equal(it.next_step, 'raise the limit or discard');
  assert.ok(it.ended_at);
  const [ev] = events(db, 'prototype.iteration_limit_reached');
  assert.deepEqual([ev.limit, ev.committed, ev.reservation, ev.from], ['tokens', 120_000, RUN_LIMIT, 'preparing']);
  read = readIteration(db, { project: p.id, iteration: p.iteration });
  assert.deepEqual(read.outcome, { status: 'limit_reached', reason: it.outcome_reason, next_step: 'raise the limit or discard' });
  assert.equal(read.remaining.next_dispatch, null, 'an iteration that is not open is asked nothing');
  const now = readProject(db, { project: p.id }).project.now;
  assert.equal(now.state, 'idle');
  assert.match(now.reason, /^Prototype iteration 1 is limit_reached: tokens: prototype_budget_tokens 400000.*next: raise the limit or discard\.$/);
  // A planned project's dispatch is never the iteration's to refuse: no
  // other item of this one is dispatched either.
  assert.equal(claim(db, p.id, item(db, p.id, 'c')), null);

  // The owner raises the limit (a policy revision recorded): the iteration
  // follows the editable keys and is open again.
  const rev = db.prepare('SELECT p.policy_revision AS id, r.effective FROM projects p JOIN policy_revisions r ON r.id = p.policy_revision WHERE p.id = ?').get(p.id);
  db.prepare('UPDATE policy_revisions SET effective = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(rev.effective), prototype_budget_tokens: 1_000_000 }), rev.id);
  transact(db, HUMAN, (tx) => P.limitsChanged(tx, p.id));
  const reopened = iteration(db, p.iteration);
  assert.deepEqual([reopened.status, reopened.outcome_reason, reopened.next_step, reopened.ended_at, JSON.parse(reopened.limits_json).prototype_budget_tokens], ['preparing', null, null, null, 1_000_000]);
  assert.equal(events(db, 'prototype.iteration_limits_changed')[0].reopened, true);
  assert.ok(claim(db, p.id, b), 'checked against the raised limit');
});

test('estimated cost: settled reported and estimated only; an unknown cost is never 0, so the token check decides; reaching the threshold records limit_reached', async (t) => {
  const { db, create } = scratch(t);
  const p = await create({ prototype_budget_tokens: 10_000_000, prototype_budget_usd_estimated: 1 });
  runWith(db, p.id, 'a', { input_tokens: 10, output_tokens: 10, cost_usd: 0.6 });
  runWith(db, p.id, 'b', { input_tokens: 10, output_tokens: 10 });
  let read = readIteration(db, { project: p.id, iteration: p.iteration });
  assert.equal(read.remaining.usd_estimated, null, 'unknown, not 0.4');
  assert.match(read.remaining.usd_reason, /1 invocation\(s\) have unknown cost/);
  assert.equal(read.remaining.usd_label, 'an estimated-cost threshold checked at dispatch, not a billing cap');
  assert.equal(read.remaining.next_dispatch, null, '0.6 known is under 1, and the token check passes: admitted');
  // Were the token check to fail, the cost check could not carry the dispatch.
  setLimits(db, p.iteration, { prototype_budget_tokens: 200_000 });
  const held = P.prototypeBlocker(db, p.id, { reservation: RUN_LIMIT, repair: false, item_repairs: 0, work_item: null });
  assert.match(held, /^prototype limit: tokens: .* exceeds it; the estimated-cost check cannot pass on its own: 1 invocation\(s\) of unknown cost and 0 under way not yet costed are not counted as 0, so the token check decides$/);
  setLimits(db, p.iteration, { prototype_budget_tokens: 10_000_000 });
  runWith(db, p.id, 'c', { input_tokens: 10, output_tokens: 10, cost_usd: 0.5 });
  assert.equal(claim(db, p.id, item(db, p.id, 'd')), null);
  const it = iteration(db, p.iteration);
  assert.equal(it.status, 'limit_reached');
  assert.equal(
    it.outcome_reason,
    'usd_estimated: prototype_budget_usd_estimated 1 reached: settled reported 1.1 + estimated 0 = 1.1 USD (a threshold on estimated spend, not a billing cap); 1 invocation(s) not costed are not counted, so the spend is at least this',
  );
  read = readIteration(db, { project: p.id, iteration: p.iteration });
  assert.equal(read.remaining.usd_estimated, null);
});

test('repairs: the per-stage limit on the work item, applying where lower than repair_attempts_max, and the per-iteration limit on the sum', async (t) => {
  const { db, create } = scratch(t);
  const p = await create({ prototype_budget_tokens: 50_000_000, prototype_repairs_per_stage: 1, prototype_repairs_per_iteration: 4 });
  assert.equal(readIteration(db, { project: p.id, iteration: p.iteration }).remaining.repairs_per_stage, 1, 'the lower of 1 and repair_attempts_max 3');
  const r = runWith(db, p.id, 'a', { input_tokens: 1, output_tokens: 1 });
  eligibleAgain(db, r.wi, 0);
  const repair = claim(db, p.id, r.wi);
  assert.ok(repair, 'repair 1 of at most 1');
  assert.equal(db.prepare('SELECT repair_attempts FROM work_items WHERE id = ?').get(r.wi).repair_attempts, 1);
  const r2 = { run: repair.run, inv: db.prepare('SELECT id FROM invocation_receipts WHERE run = ?').get(repair.run).id, dom: db.prepare('SELECT id FROM execution_domains WHERE run = ?').get(repair.run).id };
  launch(db, r2);
  usage(db, r2, { input_tokens: 1, output_tokens: 1 });
  transact(db, ENGINE_ACTOR, (tx) => R.beginEnd(tx, { run: r2.run, outcome: 'completed', reason: 'none' }));
  settle(db, r2);
  eligibleAgain(db, r.wi, 1);
  assert.equal(claim(db, p.id, r.wi), null);
  let it = iteration(db, p.iteration);
  assert.equal(it.status, 'limit_reached');
  assert.equal(it.outcome_reason, `repairs_per_stage: prototype_repairs_per_stage 1 reached: work item ${r.wi} has had 1 repair(s), and this dispatch would be repair 2`);

  const q = await create({ prototype_budget_tokens: 50_000_000, prototype_repairs_per_stage: 10, prototype_repairs_per_iteration: 2 });
  const x = runWith(db, q.id, 'x', { input_tokens: 1, output_tokens: 1 });
  const y = runWith(db, q.id, 'y', { input_tokens: 1, output_tokens: 1 });
  db.prepare('UPDATE work_items SET repair_attempts = 1 WHERE id IN (?, ?)').run(x.wi, y.wi);
  assert.equal(readIteration(db, { project: q.id, iteration: q.iteration }).remaining.repairs_iteration, 0);
  assert.ok(claim(db, q.id, item(db, q.id, 'fresh')), 'a first dispatch is no repair: admitted');
  eligibleAgain(db, x.wi, 1);
  assert.equal(claim(db, q.id, x.wi), null);
  it = iteration(db, q.iteration);
  assert.equal(it.status, 'limit_reached');
  assert.equal(it.outcome_reason, "repairs_per_iteration: prototype_repairs_per_iteration 2 reached: the iteration's work items have had 2 repair(s), and this dispatch would be repair 3");
});

test('runtime: once approved_at + prototype_runtime_seconds has passed no new run is dispatched; a running run is left alone; the tick records it too', async (t) => {
  const { db, create } = scratch(t);
  const p = await create({ prototype_budget_tokens: 50_000_000, prototype_runtime_seconds: 300 });
  const running = dispatch(db, p.id, 'running');
  launch(db, running);
  const before = db.prepare('SELECT state, deadline_at, outcome FROM runs WHERE id = ?').get(running.run);
  db.prepare('UPDATE prototype_iterations SET approved_at = ? WHERE id = ?').run(new Date(Date.now() - 400_000).toISOString(), p.iteration);
  assert.equal(claim(db, p.id, item(db, p.id, 'next')), null);
  const it = iteration(db, p.iteration);
  assert.equal(it.status, 'limit_reached');
  assert.match(it.outcome_reason, /^runtime: prototype_runtime_seconds 300 passed \(4\d\d s since the brief was approved at .*\); no new run is dispatched, and runs already running continue to their own deadlines$/);
  assert.deepEqual(db.prepare('SELECT state, deadline_at, outcome FROM runs WHERE id = ?').get(running.run), before, 'the running run is not ended, and its deadline is its own');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE kind = 'stop_confirm'`).get().n, 0, 'nothing is stopped by the limit itself');
  // It then ends through the ordinary machinery and is charged as any run.
  usage(db, running, { input_tokens: 3, output_tokens: 4 });
  transact(db, ENGINE_ACTOR, (tx) => R.beginEnd(tx, { run: running.run, outcome: 'completed', reason: 'none' }));
  settle(db, running);
  assert.equal(readIteration(db, { project: p.id, iteration: p.iteration }).usage.totals.tokens.billable_in, 3);

  // With nothing eligible, the tick records the runtime passed.
  const q = await create({ prototype_runtime_seconds: 300 });
  db.prepare('UPDATE prototype_iterations SET approved_at = ? WHERE id = ?').run(new Date(Date.now() - 301_000).toISOString(), q.iteration);
  transact(db, ENGINE_ACTOR, (tx) => markHolds(tx));
  assert.equal(iteration(db, q.iteration).status, 'limit_reached');
  assert.match(iteration(db, q.iteration).outcome_reason, /^runtime: /);
  // A session's opening meets the same check; its refusal writes nothing,
  // and the driver records the limit in a transaction of its own.
  const s = await create({ prototype_runtime_seconds: 300 });
  db.prepare('UPDATE prototype_iterations SET approved_at = ? WHERE id = ?').run(new Date(Date.now() - 301_000).toISOString(), s.iteration);
  assert.throws(
    () => transact(db, HUMAN, (tx) => openSession(tx, { project: s.id, role: 'vision', scripted: 'scripted-1', incarnation: 'inc_1' })),
    (e) => e.status === 409 && e.code === 'prototype_limit_reached' && e.subject.final === true,
  );
  assert.equal(iteration(db, s.iteration).status, 'preparing');
  assert.equal(transact(db, ENGINE_ACTOR, (tx) => P.enforceIterationLimit(tx, s.id, P.askOfSession(tx.db, s.id, 'vision'))), true);
  assert.equal(iteration(db, s.iteration).status, 'limit_reached');
});

test('Stop: the preview lists the running runs; confirmation pauses the project, stops each run through its own Stop, keeps every charge; nothing running still pauses and stops', async (t) => {
  const { db, create } = scratch(t);
  const p = await create({ prototype_budget_tokens: 50_000_000 });
  runWith(db, p.id, 'done', { input_tokens: 5, output_tokens: 5 });
  const a = dispatch(db, p.id, 'a');
  launch(db, a);
  usage(db, a, { input_tokens: 40, output_tokens: 2 });
  const b = dispatch(db, p.id, 'b');
  let read = readIteration(db, { project: p.id, iteration: p.iteration });
  assert.deepEqual(read.controls.stop.available, true);
  assert.match(read.controls.stop.reason, /pauses the project .* stops 2 running run\(s\)/);

  const ask = transact(db, HUMAN, (tx) => controlIteration(tx, { project: p.id, iteration: p.iteration, action: 'stop', previewHash: undefined, facts: {} }));
  assert.equal(ask.status, 409);
  assert.equal(ask.body.code, 'confirm_required');
  const d = db.prepare('SELECT * FROM decisions WHERE id = ?').get(ask.body.subject.decision);
  assert.deepEqual([d.kind, d.subject_type, d.subject_id, d.scope, d.status], ['stop_confirm', 'iteration', p.iteration, 'stop', 'open']);
  const manifest = JSON.parse(d.dependency_manifest);
  assert.deepEqual(manifest.runs.map((r) => [r.run, r.stoppable]), [[a.run, true], [b.run, true]]);
  assert.match(manifest.runs[0].fate, /human_stop.*charged with its unknown allowance/);
  assert.deepEqual([manifest.project_paused, manifest.outcome], [true, { status: 'stopped', next_step: 'resume by raising a limit / iterate / discard' }]);
  assert.match(d.question, /^Stop prototype iteration 1\? The project is paused .* 2 run\(s\) of it have not ended/);
  assert.equal(db.prepare('SELECT paused FROM projects WHERE id = ?').get(p.id).paused, 0, 'nothing happens before the confirmation');
  assert.throws(() => transact(db, HUMAN, (tx) => controlIteration(tx, { project: p.id, iteration: p.iteration, action: 'stop', previewHash: 'nope', facts: {} })), (e) => e.code === 'decision_stale');

  const done = transact(db, HUMAN, (tx) => controlIteration(tx, { project: p.id, iteration: p.iteration, action: 'stop', previewHash: ask.body.subject.preview_hash, facts: {} }));
  assert.equal(done.status, 200);
  assert.deepEqual([done.body.iteration.status, done.body.project.paused, done.body.runs.stopped.map((s) => s.run)], ['stopped', true, [a.run, b.run]]);
  assert.deepEqual(done.effects.filter((e) => e.kind === 'end_run').map((e) => e.run), [a.run, b.run]);
  for (const s of done.body.runs.stopped) {
    const own = db.prepare('SELECT kind, subject_type, subject_id, status FROM decisions WHERE id = ?').get(s.decision);
    assert.deepEqual(own, { kind: 'stop_confirm', subject_type: 'run', subject_id: s.run, status: 'consumed' }, 'each run stopped through its own Stop');
    assert.deepEqual(db.prepare('SELECT outcome, reason_class FROM runs WHERE id = ?').get(s.run), { outcome: 'stopped', reason_class: 'human_stop' });
  }
  const it = iteration(db, p.iteration);
  assert.deepEqual([it.status, it.next_step], ['stopped', 'resume by raising a limit / iterate / discard']);
  assert.match(it.outcome_reason, /^stopped by the owner \(decision .*\): the project paused, 2 run\(s\) stopped, each keeping its charge$/);
  // The runs end through the ordinary protocol and are charged.
  settle(db, a);
  settle(db, b);
  read = readIteration(db, { project: p.id, iteration: p.iteration });
  const charged = read.usage.runs.find((r) => r.id === a.run).invocations[0];
  assert.deepEqual([charged.usage.state, charged.usage.billable_in, charged.unknown_allowance_tokens], ['incomplete', 40, RUN_LIMIT - 42]);
  assert.equal(read.usage.totals.agent_runs, 3, 'no run erased');
  assert.equal(read.remaining.committed.settled_tokens, 10 + 42);
  assert.deepEqual(read.controls.stop, { available: false, reason: 'the iteration is stopped: nothing of it can be stopped' });
  assert.match(readProject(db, { project: p.id }).project.now.reason, /Prototype iteration 1 is stopped/);

  // Nothing running: still paused and stopped, through the decision's own answer route.
  const q = await create();
  const askQ = transact(db, HUMAN, (tx) => controlIteration(tx, { project: q.id, iteration: q.iteration, action: 'stop', previewHash: undefined, facts: {} }));
  assert.deepEqual(JSON.parse(db.prepare('SELECT dependency_manifest FROM decisions WHERE id = ?').get(askQ.body.subject.decision).dependency_manifest).runs, []);
  const answered = transact(db, HUMAN, (tx) => answerDecision(tx, { project: q.id, decision: askQ.body.subject.decision, option: 'confirm', preview_hash: askQ.body.subject.preview_hash, note: null, facts: {} }));
  assert.equal(answered.status, 200);
  assert.deepEqual([iteration(db, q.iteration).status, db.prepare('SELECT paused FROM projects WHERE id = ?').get(q.id).paused], ['stopped', 1]);
  assert.throws(() => transact(db, HUMAN, (tx) => controlIteration(tx, { project: q.id, iteration: q.iteration, action: 'stop', previewHash: undefined, facts: {} })), (e) => e.status === 409);
});

// An Alpha deployed by an iteration: an environment, a deployed request, its
// deploy operation (ended), recorded on the iteration as E1 records it.
function deployed(db, project, it, n, envId = 'env_1') {
  db.pragma('foreign_keys = OFF');
  if (!db.prepare('SELECT 1 FROM environments WHERE id = ?').get(envId)) {
    db.prepare(`INSERT INTO environments (id, created_at, project, name, adapter, adapter_config_ref, verify_spec, current_generation, prefix) VALUES (?, ?, ?, 'alpha', 'local_service', 'x', '{}', 1, 'svc')`).run(envId, AT, project);
  }
  db.prepare(`INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress) VALUES (?, ?, ?, ?, 'rev', 'lin', ?, 'engine_cadence', 'alpha_deployed')`).run(`cand_${n}`, AT, project, n, AT);
  db.prepare(`INSERT INTO deployment_requests (id, created_at, project, request_key, requested_by, candidate, environment, authorization, outcome) VALUES (?, ?, ?, ?, 'policy', ?, ?, ?, 'deployed')`).run(`dreq_${n}`, AT, project, `k${n}`, `cand_${n}`, envId, `auth_${n}`);
  db.prepare(
    `INSERT INTO operations (id, created_at, project, seq, kind, target, subject, idempotency_key, semantic_generation, status, deadline_at, orchestration_stage, authorization)
     VALUES (?, ?, ?, ?, 'deploy', ?, '{}', ?, 1, 'succeeded', ?, 'ended', ?)`,
  ).run(`op_${n}`, AT, project, 100 + n, JSON.stringify({ environment: envId }), `key_${n}`, AT, `auth_${n}`);
  db.pragma('foreign_keys = ON');
  db.prepare(`UPDATE prototype_iterations SET status = 'alpha_ready', candidate = ?, deployment_request = ?, alpha_at = ?, ended_at = ?, outcome_reason = 'alpha_complete', next_step = 'open_alpha' WHERE id = ?`).run(`cand_${n}`, `dreq_${n}`, AT, AT, it);
}

test('Discard: tears down its own deployment, keeps every receipt and ledger row, Alpha history kept and current null once torn down; leaves a newer iteration’s deployment alone', async (t) => {
  const { db, create } = scratch(t);
  const p = await create({ prototype_budget_tokens: 50_000_000 });
  const r = runWith(db, p.id, 'a', { input_tokens: 7, output_tokens: 3 });
  deployed(db, p.id, p.iteration, 1);
  const before = readIteration(db, { project: p.id, iteration: p.iteration });
  assert.deepEqual(before.controls.discard, { available: true, reason: 'stops 0 running run(s) of the iteration and tears down its Alpha in environment alpha; receipts, ledger rows, runs and records are kept', tears_down_alpha: true, kept_because: null });
  assert.deepEqual(before.controls.stop, { available: false, reason: 'the iteration is alpha_ready: nothing of it can be stopped' });
  const ask = transact(db, HUMAN, (tx) => controlIteration(tx, { project: p.id, iteration: p.iteration, action: 'discard', previewHash: undefined, facts: {} }));
  const d = db.prepare('SELECT * FROM decisions WHERE id = ?').get(ask.body.subject.decision);
  assert.deepEqual([d.kind, d.subject_type, d.scope], ['stop_confirm', 'iteration', 'discard']);
  assert.deepEqual(JSON.parse(d.dependency_manifest).alpha, { tears_down_alpha: true, environment: { id: 'env_1', name: 'alpha' }, deployment_request: 'dreq_1', kept_because: null });
  assert.match(d.question, /Its Alpha in environment alpha is torn down/);
  const done = transact(db, HUMAN, (tx) => controlIteration(tx, { project: p.id, iteration: p.iteration, action: 'discard', previewHash: ask.body.subject.preview_hash, facts: {} }));
  assert.deepEqual(done.body.teardown, { environment: 'alpha', operation_requested: true });
  assert.ok(done.effects.some((e) => e.kind === 'relay_closed' && e.environment === 'env_1'));
  assert.ok(db.prepare('SELECT teardown_requested_at FROM environments WHERE id = ?').get('env_1').teardown_requested_at, 'the ordinary teardown is requested');
  assert.equal(db.prepare('SELECT paused FROM projects WHERE id = ?').get(p.id).paused, 0, 'Discard does not pause; the discarded iteration holds dispatch');
  const it = iteration(db, p.iteration);
  assert.deepEqual([it.status, it.next_step, it.alpha_at, it.candidate], ['discarded', 'iterate', AT, 'cand_1']);
  assert.ok(it.ended_at > AT);
  assert.ok(db.prepare('SELECT 1 FROM ledger_rows WHERE run = ?').get(r.run), 'the ledger row is kept');
  // The teardown finalized (deploy.ts finalizeDeploy calls withdrawAlpha).
  transact(db, ENGINE_ACTOR, (tx) => P.withdrawAlpha(tx, { project: p.id, environment: 'env_1', operation: 'op_td' }));
  const after = readIteration(db, { project: p.id, iteration: p.iteration });
  assert.deepEqual([after.alpha.current, after.alpha.deployed_at, after.outcome.status], [null, AT, 'discarded']);
  assert.deepEqual(after.usage.totals.tokens.billable_in, before.usage.totals.tokens.billable_in);
  assert.deepEqual(after.remaining.committed, before.remaining.committed);
  assert.deepEqual([after.controls.discard.available, after.controls.discard.reason], [false, 'the iteration is already discarded']);
  assert.equal(claim(db, p.id, item(db, p.id, 'x')), null, 'nothing of a discarded iteration is dispatched');

  // Two iterations sharing the environment: the newer one's deployment is the current one.
  const q = await create();
  deployed(db, q.id, q.iteration, 2, 'env_2');
  const second = transact(db, ENGINE_ACTOR, (tx) => P.createIteration(tx, { project: q.id, limits: JSON.parse(iteration(db, q.iteration).limits_json), predecessor: q.iteration }));
  deployed(db, q.id, second, 3, 'env_2');
  const older = readIteration(db, { project: q.id, iteration: q.iteration }).controls.discard;
  assert.equal(older.tears_down_alpha, false);
  assert.equal(older.kept_because, 'iteration 2, newer, holds environment alpha: its deployment (request dreq_3) is the one running there, and Discard never touches it');
  assert.equal(readIteration(db, { project: q.id, iteration: second }).controls.discard.tears_down_alpha, true);
  const askOld = transact(db, HUMAN, (tx) => controlIteration(tx, { project: q.id, iteration: q.iteration, action: 'discard', previewHash: undefined, facts: {} }));
  assert.match(db.prepare('SELECT question FROM decisions WHERE id = ?').get(askOld.body.subject.decision).question, /No Alpha is torn down: iteration 2, newer, holds environment alpha/);
  const doneOld = transact(db, HUMAN, (tx) => controlIteration(tx, { project: q.id, iteration: q.iteration, action: 'discard', previewHash: askOld.body.subject.preview_hash, facts: {} }));
  assert.equal(doneOld.body.teardown, null);
  assert.equal(db.prepare('SELECT teardown_requested_at FROM environments WHERE id = ?').get('env_2').teardown_requested_at, null, 'the newer Alpha is left in place');
  assert.deepEqual([iteration(db, q.iteration).status, iteration(db, second).status], ['discarded', 'alpha_ready']);
  assert.equal(db.prepare('SELECT progress FROM candidates WHERE id = ?').get('cand_3').progress, 'alpha_deployed');
});

test('the controls object of an open iteration: what Stop and Discard would do now', async (t) => {
  const { db, create } = scratch(t);
  const p = await create({ prototype_budget_tokens: 50_000_000 });
  const read = readIteration(db, { project: p.id, iteration: p.iteration });
  assert.deepEqual(read.controls, {
    stop: { available: true, reason: 'pauses the project so that nothing else is dispatched, and stops 0 running run(s) of the iteration, each keeping its charge and its unknown allowance; nothing of the usage is erased' },
    discard: { available: true, reason: 'stops 0 running run(s) of the iteration and leaves any Alpha in place; receipts, ledger rows, runs and records are kept', tears_down_alpha: false, kept_because: 'this iteration deployed nothing' },
  });
  assert.equal('enforced_from' in read.remaining, false);
});
