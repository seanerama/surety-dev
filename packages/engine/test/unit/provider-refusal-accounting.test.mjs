// Developer tests for slice C2k, the owner's two rulings on Codex accounting
// of 2026-10-30:
//
//   A. "Show an estimate based on the configured model and tier, labelled
//      'estimated from requested model; provider did not report model/tier.'
//      Preserve the provider-reported fields as unknown."
//   B. "Track provider refusal separately from token consumption and internal
//      reservations. Implement a documented recovery path so a quota error
//      doesn't require manually widening multiple limits just to retry.
//      Preserve history; don't assume every missing usage report means zero
//      usage."
//
// A scratch store with the engine's migrations and a scratch git repository;
// the scripted backend of the harness (a run's end is recorded as the choke
// point records it, with the provider refusal it found in a Codex stream);
// no engine, process, unit or host resource is started. The Codex stream
// cases feed the adapter the observed MAIN stream of run
// run_01M66EEYSGTJXRTZPP91KZD17S.

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
const { markHolds } = await import(join(dist, 'scheduler', 'holds.js'));
const { readIteration, iterationReceipt } = await import(join(dist, 'prototype', 'iterations.js'));
const P = await import(join(dist, 'store', 'transitions', 'prototype.js'));
const L = await import(join(dist, 'store', 'transitions', 'ledger.js'));
const { runRepresentation } = await import(join(dist, 'store', 'transitions', 'control.js'));
const { CodexStream, codexProviderRefusal } = await import(join(dist, 'invoke', 'adapters', 'codex.js'));

setEngineSettings({ lease_ttl: 600, git_deadline: 30, decision_targets: {} });
const HUMAN = { actor_kind: 'human', actor_id: null, request_id: 'req-1' };
const AT = '2026-10-30T00:00:00.000Z';
const QUOTA = 'Quota exceeded. Check your plan and billing details.';
const REFUSAL = { provider_refusal: { kind: 'usage_limit', message: QUOTA } };
// The refused run's one usage observation, as the Codex adapter writes it
// for a turn.failed without usage (adapters/codex.ts terminalEvent).
const ABSENT = { usage_final: false, usage_scope: 'absent', thread_id: '01a18ce7-7ec8-7080-a73a-d98176094ff3' };

// ---- the observed Codex streams ----------------------------------------------------

const REFUSED_STREAM = [
  { type: 'thread.started', thread_id: '01a18ce7-7ec8-7080-a73a-d98176094ff3' },
  { type: 'turn.started' },
  { type: 'error', message: QUOTA },
  { type: 'turn.failed', error: { message: QUOTA } },
];
const summaryOf = (events) => {
  const s = new CodexStream();
  for (const e of events) s.feed(JSON.stringify(e));
  return s.summary();
};

test('(B) the stream: a quota error before any item, with no usage, is a provider refusal; after an item, with usage, or an authentication failure, it is not', () => {
  assert.deepEqual(codexProviderRefusal(summaryOf(REFUSED_STREAM)), { kind: 'usage_limit', message: QUOTA }, 'the observed MAIN stream of run_01M66EEYSGTJXRTZPP91KZD17S');
  const rate = [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.started' }, { type: 'turn.failed', error: { message: 'exceeded retry limit, last status: 429 Too Many Requests' } }];
  assert.equal(codexProviderRefusal(summaryOf(rate))?.kind, 'usage_limit', 'a 429 alone, with the terminal event');
  const afterItem = [REFUSED_STREAM[0], REFUSED_STREAM[1], { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'working' } }, REFUSED_STREAM[2], REFUSED_STREAM[3]];
  assert.equal(codexProviderRefusal(summaryOf(afterItem)), null, 'an item ran: the turn was not refused before it began');
  const withUsage = [REFUSED_STREAM[0], REFUSED_STREAM[1], REFUSED_STREAM[2], { type: 'turn.failed', error: { message: QUOTA }, usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } }];
  assert.equal(codexProviderRefusal(summaryOf(withUsage)), null, 'usage reported: not a refusal');
  const auth = [REFUSED_STREAM[0], REFUSED_STREAM[1], { type: 'turn.failed', error: { message: '401 Unauthorized: invalid api key' } }];
  assert.equal(codexProviderRefusal(summaryOf(auth)), null, 'an authentication failure is not a quota refusal');
  assert.equal(codexProviderRefusal(null), null);
});

// ---- the scratch store ---------------------------------------------------------------

function scratch(t) {
  assert.equal(configureHarness(true, []), null);
  t.after(() => configureHarness(false, []));
  const dir = mkdtempSync(join(tmpdir(), 'surety-c2k-'));
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
  // A rapid prototype whose brief was approved `approvedAgoMs` ago, building.
  const create = async (limits = {}, approvedAgoMs = 60_000) => {
    const prepared = await prepareNewProject(rt, { name: 'Proto', idea: 'A small app.', dev_repo_path: join(dir, `app${++n}`), mode: 'rapid_prototype' });
    const made = transact(db, HUMAN, (tx) => bootstrapProject(tx, prepared));
    db.prepare(`UPDATE projects SET registration_state = 'registered', paused = 0 WHERE id = ?`).run(made.project.id);
    const row = db.prepare('SELECT limits_json FROM prototype_iterations WHERE id = ?').get(made.project.iteration);
    db.prepare(`UPDATE prototype_iterations SET limits_json = ?, status = 'building', approved_at = ?, next_step = 'none: building' WHERE id = ?`).run(
      JSON.stringify({ ...JSON.parse(row.limits_json), ...limits }),
      new Date(Date.now() - approvedAgoMs).toISOString(),
      made.project.iteration,
    );
    db.prepare(`UPDATE decisions SET status = 'consumed', consumed_at = ? WHERE project = ? AND kind = 'prototype_preparation_approval'`).run(AT, made.project.id);
    db.prepare(`UPDATE policy_revisions SET effective = json_set(effective, '$.budget_day_unknown_tokens', 100000000) WHERE project = ?`).run(made.project.id);
    return made.project;
  };
  return { db, create };
}

const item = (db, project, trigger) => transact(db, ENGINE_ACTOR, (tx) => observeTrigger(tx, { project, kind: 'fix', trigger_source: 'test', trigger_id: trigger, trigger_generation: 1 }, {})).work_item.id;
const claim = (db, project, wi) => transact(db, ENGINE_ACTOR, (tx) => R.claimDispatch(tx, { project, workItem: wi, incarnation: 'inc_1', scripted: 'scripted-1' }));
function dispatch(db, project, trigger) {
  const wi = item(db, project, trigger);
  const c = claim(db, project, wi);
  assert.ok(c, `${trigger} is dispatched`);
  return { wi, run: c.run, inv: db.prepare('SELECT id FROM invocation_receipts WHERE run = ?').get(c.run).id, dom: db.prepare('SELECT id FROM execution_domains WHERE run = ?').get(c.run).id };
}
// The receipt of a real backend's invocation (one under a trust entry: C4's
// unknown allowance applies to it, as to a Codex run on MAIN). The scratch
// store's receipt is made so for the test only.
function makeReal(db, inv) {
  db.pragma('foreign_keys = OFF');
  db.exec('DROP TRIGGER invocation_receipts_no_update');
  db.prepare(`UPDATE invocation_receipts SET trust_entry = 'te_test', provider = 'codex' WHERE id = ?`).run(inv);
  db.exec(`CREATE TRIGGER invocation_receipts_no_update BEFORE UPDATE ON invocation_receipts
BEGIN SELECT RAISE(ABORT, 'invocation_receipts is append-only'); END`);
  db.pragma('foreign_keys = ON');
}
// The run made a Codex run (its backend and requested model), so that its
// ledger row is written by the Codex normalization, as on MAIN.
const makeCodex = (db, run) => db.prepare(`UPDATE runs SET backend = 'codex', model_requested = 'gpt-6.1-terra' WHERE id = ?`).run(run);
// A Codex run that launched, observed `raw`, and ended failed infra_error,
// with `detail` as the choke point records it (invoke/choke.ts
// decideAfterExit).
function failedRun(db, project, trigger, { raw = ABSENT, detail, reasonText } = {}) {
  const r = dispatch(db, project, trigger);
  makeReal(db, r.inv);
  makeCodex(db, r.run);
  transact(db, ENGINE_ACTOR, (tx) => {
    R.dispatchStarted(tx, { run: r.run, invocation: r.inv });
    R.recordLaunch(tx, { run: r.run, invocation: r.inv, domain: r.dom, pid: 999999, pgid: 999999, startTime: null });
  });
  transact(db, ENGINE_ACTOR, (tx) => R.recordUsage(tx, { run: r.run, generation: 1, invocation: r.inv, semantics: 'cumulative', raw }));
  transact(db, ENGINE_ACTOR, (tx) =>
    R.beginEnd(tx, { run: r.run, outcome: 'failed', reason: 'infra_error', reasonText: reasonText ?? 'exit class error_exit: the backend failed without a result', ...(detail ? { detail } : {}) }),
  );
  transact(db, ENGINE_ACTOR, (tx) => R.domainTerminated(tx, { domain: r.dom, observed: true }));
  transact(db, ENGINE_ACTOR, (tx) => R.finishRun(tx, { run: r.run, invocations: { [r.inv]: 'ended' }, recovery: null }));
  return r;
}
const original = (db, inv) => db.prepare('SELECT * FROM ledger_rows WHERE invocation = ? AND corrects IS NULL').get(inv);
const iteration = (db, id) => db.prepare('SELECT * FROM prototype_iterations WHERE id = ?').get(id);
const work = (db, wi) => db.prepare('SELECT status, repair_due, repair_attempts FROM work_items WHERE id = ?').get(wi);
const events = (db, type) => db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY seq').all(type).map((e) => JSON.parse(e.payload));
const tick = (db) => transact(db, ENGINE_ACTOR, (tx) => markHolds(tx));

test('(B1) a provider refusal: its row is provider_refused with no unknown allowance and the refusal kept; the run is infra_error with the documented sub-reason; the work is held, no repair spent', async (t) => {
  const { db, create } = scratch(t);
  const p = await create({ prototype_budget_tokens: 3_000_000 });
  const r = failedRun(db, p.id, 'a', { detail: REFUSAL, reasonText: `provider_refusal: the provider refused the run's turn (usage_limit: "${QUOTA}")` });
  const row = original(db, r.inv);
  assert.deepEqual(
    [row.cost_status, row.cost_usd, row.billable_in, row.out, row.usage_complete, row.unknown_allowance_tokens],
    ['provider_refused', null, null, null, 0, null],
    'neither measured consumption (no counts, never 0) nor an unknown-usage allowance',
  );
  assert.deepEqual(JSON.parse(row.raw_usage).provider_refusal, { kind: 'usage_limit', message: QUOTA }, 'the refusal kept on the row');
  assert.match(row.normalization_version, /\+provider-refusal-1$/);
  assert.deepEqual(events(db, 'ledger.row').at(-1).provider_refusal, { kind: 'usage_limit', message: QUOTA });
  const run = runRepresentation(db, { project: p.id, run: r.run }).run;
  assert.deepEqual([run.outcome, run.reason_class, run.provider_refusal], ['failed', 'infra_error', { kind: 'usage_limit', message: QUOTA }], 'RunReasonClass unchanged; the sub-reason on the run read');
  assert.deepEqual(work(db, r.wi), { status: 'held', repair_due: 0, repair_attempts: 0 }, 'held for the retry, no repair due or spent');
  // The ledger read: the row's refusal beside it; apart from totals, which
  // count no allowance and no unknown cost for it.
  const view = L.ledgerView(db, { project: p.id, day: null });
  const served = view.rows.find((x) => x.invocation === r.inv);
  assert.deepEqual(served.provider_refusal, { kind: 'usage_limit', message: QUOTA });
  assert.deepEqual([view.totals.unknown_allowance_tokens, view.totals.unknown_cost_invocations], [null, 0]);
  assert.deepEqual([view.provider_refusals.invocations, view.provider_refusals.runs], [1, [r.run]]);
  assert.equal(Object.hasOwn(view.totals, 'provider_refused_invocations'), false, 'the totals keep their members (M59/M60)');
});

test('(B1) the old rule is unchanged: a real run that reports nothing and was not refused by the provider is charged its unknown allowance', async (t) => {
  const { db, create } = scratch(t);
  const p = await create({ prototype_budget_tokens: 10_000_000 });
  const r = failedRun(db, p.id, 'a');
  const row = original(db, r.inv);
  assert.equal(row.cost_status, 'unknown');
  assert.equal(typeof row.unknown_allowance_tokens, 'number');
  assert.ok(row.unknown_allowance_tokens > 0, `charged its allowance (${row.unknown_allowance_tokens}), never 0`);
  assert.equal(JSON.parse(row.raw_usage).provider_refusal, undefined);
  assert.notEqual(work(db, r.wi).status, 'held', 'repaired as before, not held');
  // A refusal recorded on a run that did report usage is not a refusal of
  // its usage: the counts stand and the row is not provider_refused.
  const q = failedRun(db, p.id, 'b', { raw: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, usage_final: true, usage_scope: 'turn' }, detail: REFUSAL });
  assert.notEqual(original(db, q.inv).cost_status, 'provider_refused');
});

test('(B1, B2) the iteration: held awaiting_owner with the refusal as its stop condition; the refusal in its own line on the read and the receipt; nothing of it counted against the token limit; nothing more dispatched until the retry', async (t) => {
  const { db, create } = scratch(t);
  // A token allowance the old rule's allowance (the run's whole effective
  // limit) would have spent at once, as on MAIN (it went limit_reached).
  const p = await create({ prototype_budget_tokens: 1_500_000 });
  const r = failedRun(db, p.id, 'a', { detail: REFUSAL });
  let it = iteration(db, p.iteration);
  assert.equal(it.status, 'awaiting_owner', 'held, not limit_reached');
  assert.equal(it.next_step, P.PROVIDER_REFUSAL_NEXT_STEP);
  assert.match(it.outcome_reason, /^provider_refusal: .*Quota exceeded/);
  assert.equal(it.provider_hold_run, r.run);
  assert.ok(it.provider_hold_since);
  tick(db);
  it = iteration(db, p.iteration);
  assert.deepEqual([it.status, it.next_step], ['awaiting_owner', P.PROVIDER_REFUSAL_NEXT_STEP], 'the tick keeps it so');
  assert.equal(events(db, 'prototype.iteration_limit_reached').length, 0, 'no limit was reached');
  const status = events(db, 'prototype.iteration_status_changed').at(-1);
  assert.deepEqual([status.to, status.provider_refusal.run, status.provider_refusal.kind], ['awaiting_owner', r.run, 'usage_limit']);
  // The token account: no allowance, no unknown total, the whole allowance left.
  const account = P.iterationAccount(db, p.id, p.iteration);
  assert.deepEqual([account.committed_tokens, account.unknown_allowance_tokens, account.unknown_billable_invocations, account.provider_refusals.length], [0, 0, 0, 1]);
  assert.equal(P.iterationVerdict(db, it, P.askOfItem(db, { id: '', project: p.id, repair_due: 0, repair_attempts: 0 })), null, 'the limits admit the next dispatch');
  // But nothing is dispatched while held.
  const b = item(db, p.id, 'b');
  assert.equal(claim(db, p.id, b), null, 'another item is not dispatched against the refusal');
  assert.match(R.dispatchBlocker(db, db.prepare('SELECT * FROM work_items WHERE id = ?').get(b), { check: false }), /^waits for the owner's retry: iteration 1 is held by a provider refusal/);
  // The read and the receipt.
  const read = readIteration(db, { project: p.id, iteration: p.iteration });
  const line = read.usage.provider_refusals;
  assert.deepEqual([line.count, line.held, line.runs.map((x) => x.run), line.runs[0].kind, line.runs[0].message], [1, true, [r.run], 'usage_limit', QUOTA]);
  assert.match(line.rule, /not consumption and not an allowance/);
  assert.deepEqual([read.usage.totals.unknown_allowance_tokens, read.usage.totals.cost.unknown_invocations, read.usage.totals.cost.provider_refused_invocations], [null, 0, 1], 'apart from the allowances and the unknown-cost invocations');
  assert.deepEqual([read.remaining.tokens, read.remaining.committed.total_tokens, read.remaining.committed.estimated_allowance_tokens], [1_500_000, 0, 0], 'the whole allowance is left');
  assert.equal(read.remaining.committed.measured_is, 'lower_bound', 'what the refused invocation used is not reported: never read as 0');
  const inv = read.usage.runs.find((x) => x.id === r.run).invocations[0];
  assert.deepEqual([inv.cost.status, inv.unknown_allowance_tokens, inv.cost.provider_refusal], ['provider_refused', null, { kind: 'usage_limit', message: QUOTA }]);
  assert.deepEqual([read.controls.retry.available, read.outcome.next_step], [true, P.PROVIDER_REFUSAL_NEXT_STEP]);
  const receipt = iterationReceipt(db, { project: p.id, iteration: p.iteration });
  assert.deepEqual(receipt.usage.provider_refusals.runs.map((x) => x.run), [r.run], 'the receipt carries the same line');
});

test('(B2) the runtime clock excludes the time held by a provider refusal, and counts the rest', async (t) => {
  const HOUR = 3_600_000;
  // heldSeconds: the ended holds as recorded, the current one from its start
  // (or the approval, if later) to the time asked.
  const approved = '2026-10-30T10:00:00.000Z';
  const at = Date.parse('2026-10-30T13:00:00.000Z');
  assert.equal(P.heldSeconds({ approved_at: approved, provider_hold_since: null, provider_hold_ms: 0 }, at), 0);
  assert.equal(P.heldSeconds({ approved_at: approved, provider_hold_since: '2026-10-30T12:00:00.000Z', provider_hold_ms: 0 }, at), 3600);
  assert.equal(P.heldSeconds({ approved_at: approved, provider_hold_since: '2026-10-30T09:00:00.000Z', provider_hold_ms: 0 }, at), 3 * 3600, 'never before the approval');
  assert.equal(P.heldSeconds({ approved_at: approved, provider_hold_since: '2026-10-30T12:30:00.000Z', provider_hold_ms: 600_000 }, at), 600 + 1800, 'ended holds plus the current one');
  assert.equal(P.heldSeconds({ approved_at: null, provider_hold_since: '2026-10-30T12:00:00.000Z', provider_hold_ms: 0 }, at), 0, 'no runtime before an approval');

  // As on MAIN: approved 3 h ago with a 45-minute runtime, held by a refusal
  // for all but the first 30 minutes.
  const { db, create } = scratch(t);
  const p = await create({ prototype_runtime_seconds: 2700 });
  const r = failedRun(db, p.id, 'a', { detail: REFUSAL });
  db.prepare('UPDATE prototype_iterations SET approved_at = ?, provider_hold_since = ? WHERE id = ?').run(new Date(Date.now() - 3 * HOUR).toISOString(), new Date(Date.now() - 2.5 * HOUR).toISOString(), p.iteration);
  tick(db);
  let it = iteration(db, p.iteration);
  assert.equal(it.status, 'awaiting_owner', 'the runtime passed while held is not counted: no limit_reached at the tick');
  const read = readIteration(db, { project: p.id, iteration: p.iteration });
  assert.ok(read.remaining.runtime_seconds > 2700 - 1810 && read.remaining.runtime_seconds <= 2700 - 1790, `about 30 minutes used of 45 (${read.remaining.runtime_seconds} s left)`);
  assert.ok(Math.abs(read.time.provider_hold_seconds - 2.5 * 3600) < 10, `held 2.5 h (${read.time.provider_hold_seconds})`);
  // Without the hold the same iteration is past its runtime.
  db.prepare('UPDATE prototype_iterations SET provider_hold_since = NULL, provider_hold_run = NULL WHERE id = ?').run(p.iteration);
  const v = P.iterationVerdict(db, iteration(db, p.iteration), { reservation: 0, repair: false, item_repairs: 0, work_item: null });
  assert.equal(v?.limit, 'runtime', 'the clock counts every second not held');
  void r;
  void it;
});

test('(B3) the retry: one owner act ends the hold and re-dispatches the refused work, no limit raised, no repair spent; refused with what to do when the iteration is not held by a refusal', async (t) => {
  const { db, create } = scratch(t);
  const p = await create({ prototype_budget_tokens: 1_500_000, prototype_runtime_seconds: 18_000 }, 3_600_000);
  // Not held yet: refused, with what to do.
  assert.throws(
    () => transact(db, HUMAN, (tx) => P.retryIteration(tx, { project: p.id, iteration: p.iteration })),
    (e) => e.status === 409 && e.code === 'illegal_transition' && /not held by a provider refusal/.test(e.message),
  );
  const r = failedRun(db, p.id, 'a', { detail: REFUSAL });
  const limitsBefore = iteration(db, p.iteration).limits_json;
  db.prepare('UPDATE prototype_iterations SET provider_hold_since = ? WHERE id = ?').run(new Date(Date.now() - 600_000).toISOString(), p.iteration);
  const out = transact(db, HUMAN, (tx) => P.retryIteration(tx, { project: p.id, iteration: p.iteration }));
  assert.equal(out.status, 200);
  assert.deepEqual([out.body.retried_work, out.body.refused_run, out.body.limits_raised, out.body.iteration.status], [[r.wi], r.run, [], 'building']);
  assert.ok(out.body.provider_hold_seconds >= 599 && out.body.provider_hold_seconds < 700, `the hold's time recorded (${out.body.provider_hold_seconds} s)`);
  const it = iteration(db, p.iteration);
  assert.deepEqual([it.status, it.provider_hold_since, it.provider_hold_run, it.limits_json], ['building', null, null, limitsBefore], 'open again, the hold ended, no limit changed');
  assert.deepEqual(work(db, r.wi), { status: 'eligible', repair_due: 0, repair_attempts: 0 }, 're-dispatched as it was, no repair');
  const resumed = events(db, 'prototype.iteration_resumed').at(-1);
  assert.deepEqual([resumed.cause, resumed.refused_run, resumed.retried_work], ['provider_refusal_retry', r.run, [r.wi]]);
  // The next dispatch is admitted against the limits as they were.
  const c = claim(db, p.id, r.wi);
  assert.ok(c, 'the refused work is dispatched again, no limit raised');
  // A second retry: nothing is held.
  assert.throws(
    () => transact(db, HUMAN, (tx) => P.retryIteration(tx, { project: p.id, iteration: p.iteration })),
    (e) => e.status === 409 && /not held by a provider refusal/.test(e.message) && /next step/.test(e.message),
  );
});

test('(B3) a retry never undoes a Stop: a stopped iteration held by a refusal is refused with its resume named; the resume resumes the refused work and ends the hold', async (t) => {
  const { db, create } = scratch(t);
  const p = await create({ prototype_runtime_seconds: 18_000 }, 3_600_000);
  const r = failedRun(db, p.id, 'a', { detail: REFUSAL });
  db.prepare(`UPDATE prototype_iterations SET status = 'stopped', next_step = ? WHERE id = ?`).run(P.STOP_NEXT_STEP, p.iteration);
  db.prepare('UPDATE projects SET paused = 1 WHERE id = ?').run(p.id);
  assert.throws(
    () => transact(db, HUMAN, (tx) => P.retryIteration(tx, { project: p.id, iteration: p.iteration })),
    (e) => e.status === 409 && /is stopped: resume it deliberately/.test(e.message),
  );
  transact(db, HUMAN, (tx) => P.resumeIteration(tx, { project: p.id, iteration: p.iteration }));
  const it = iteration(db, p.iteration);
  assert.deepEqual([it.provider_hold_since, it.provider_hold_run, work(db, r.wi).status], [null, null, 'eligible']);
  assert.ok(it.provider_hold_ms > 0, 'the hold until the resume is recorded, not counted against the runtime');
});

test('(B3) the work resumed otherwise (POST …/work/:w/resume) ends the hold at the tick', async (t) => {
  const { db, create } = scratch(t);
  const p = await create();
  const r = failedRun(db, p.id, 'a', { detail: REFUSAL });
  const { resumeWork } = await import(join(dist, 'store', 'transitions', 'work.js'));
  transact(db, HUMAN, (tx) => resumeWork(tx, { project: p.id, workItem: r.wi }));
  tick(db);
  const it = iteration(db, p.iteration);
  assert.deepEqual([it.provider_hold_since, it.provider_hold_run, it.status], [null, null, 'building']);
});

// ---- ruling A: the estimate from the requested model ---------------------------------

// MAIN's run_01M66QKVZ3NJ847FZXWT1WJHKR (gpt-6.1-terra), as charged.
const TERRA_ROW = {
  provider: 'codex',
  model_requested: 'gpt-6.1-terra',
  model_observed: null,
  raw_usage: JSON.stringify({ input_tokens: 181773, cached_input_tokens: 165031, output_tokens: 3897, reasoning_output_tokens: 193, cache_write_input_tokens: 16700, usage_final: true, usage_scope: 'turn', thread_id: '01a18d79-f396-79c0-8a5c-d0b6030ae8aa' }),
  billable_in: 16742,
  cached_in: 165031,
  out: 3897,
  cost_status: 'unknown',
  usage_complete: true,
};

test('(A) the estimate from the requested model: the observed Terra run priced at its requested row, Standard tier, labelled; status and model stay unknown; missing price or unfinished usage give none with a reason, never 0', () => {
  // (42 plain input x 1 + 16,700 cache writes x 1.25 + 165,031 cached x 0.05 + 3,897 output x 5) / 1e6
  const e = L.requestedModelEstimate(TERRA_ROW, TERRA_ROW);
  assert.equal(e.estimated_from_requested_reason, null);
  assert.deepEqual(
    { ...e.estimated_from_requested, lower_bound_reasons: undefined },
    {
      usd: 0.04865355,
      model: 'gpt-6.1-terra',
      tier: 'standard',
      basis: 'estimated from requested model; provider did not report model/tier',
      price_version: 'openai-pricing-page-2026-10-27',
      pricing_basis: 'openai-pricing-page-2026-10-27+cache-write-reported-1.25x-input-30m+lower-bound',
      bound: 'lower',
      lower_bound_reasons: undefined,
    },
  );
  assert.ok(e.estimated_from_requested.lower_bound_reasons.some((x) => /requested configuration, not reported/.test(x)));
  const missing = L.requestedModelEstimate({ ...TERRA_ROW, model_requested: 'gpt-9-unpriced' }, TERRA_ROW);
  assert.equal(missing.estimated_from_requested, null);
  assert.match(missing.estimated_from_requested_reason, /no Codex price for gpt-9-unpriced/);
  const absent = { ...TERRA_ROW, model_requested: 'gpt-6.1-sol', raw_usage: JSON.stringify(ABSENT), billable_in: null, cached_in: null, out: null, usage_complete: false };
  assert.equal(L.requestedModelEstimate(absent, absent).estimated_from_requested, null, "MAIN's refused row (history: unknown with its allowance) has no estimate");
  assert.match(L.requestedModelEstimate(absent, absent).estimated_from_requested_reason, /not final and complete/);
  assert.equal(L.requestedModelEstimate({ ...TERRA_ROW, model_observed: 'gpt-6.1-terra' }, TERRA_ROW).estimated_from_requested, null, 'a reported model is never replaced by the requested one');
  assert.deepEqual(L.requestedModelEstimate(TERRA_ROW, { ...TERRA_ROW, cost_status: 'estimated' }), { estimated_from_requested: null, estimated_from_requested_reason: null }, 'not wanted where the cost is known');
  assert.match(L.requestedModelEstimate(TERRA_ROW, { ...TERRA_ROW, cost_status: 'provider_refused' }).estimated_from_requested_reason, /refused/);
});

test('(A) carried through the fold, the ledger read and the iteration read, apart from reported_usd and estimated_usd, and not against any limit', async (t) => {
  const { db, create } = scratch(t);
  const p = await create({ prototype_budget_usd_estimated: 0.01 });
  // A completed Codex-shaped invocation whose stream named no model: its row
  // is written by the Codex normalization through a run of backend codex.
  const r = dispatch(db, p.id, 'a');
  makeCodex(db, r.run);
  makeReal(db, r.inv);
  transact(db, ENGINE_ACTOR, (tx) => {
    R.dispatchStarted(tx, { run: r.run, invocation: r.inv });
    R.recordLaunch(tx, { run: r.run, invocation: r.inv, domain: r.dom, pid: 999999, pgid: 999999, startTime: null });
  });
  transact(db, ENGINE_ACTOR, (tx) => R.recordUsage(tx, { run: r.run, generation: 1, invocation: r.inv, semantics: 'cumulative', raw: JSON.parse(TERRA_ROW.raw_usage) }));
  transact(db, ENGINE_ACTOR, (tx) => R.beginEnd(tx, { run: r.run, outcome: 'completed', reason: 'none' }));
  transact(db, ENGINE_ACTOR, (tx) => R.domainTerminated(tx, { domain: r.dom, observed: true }));
  transact(db, ENGINE_ACTOR, (tx) => R.finishRun(tx, { run: r.run, invocations: { [r.inv]: 'ended' }, recovery: null }));
  const row = original(db, r.inv);
  assert.deepEqual([row.provider, row.model_requested, row.model_observed, row.cost_status, row.cost_usd, row.billable_in], ['codex', 'gpt-6.1-terra', null, 'unknown', null, 16742], 'the provider-reported fields stay unknown');
  const acc = L.fold([row]);
  assert.equal(acc.estimated_from_requested?.usd, 0.04865355);
  const view = L.ledgerView(db, { project: p.id, day: null });
  assert.deepEqual([view.totals.reported_usd, view.totals.estimated_usd, view.totals.unknown_cost_invocations], [null, null, 1], 'never counted as reported or estimated');
  assert.deepEqual([view.estimated_from_requested.usd, view.estimated_from_requested.invocations, view.estimated_from_requested.basis], [0.04865355, 1, L.REQUESTED_ESTIMATE_BASIS]);
  assert.equal(view.rows.find((x) => x.invocation === r.inv).estimated_from_requested.usd, 0.04865355);
  const read = readIteration(db, { project: p.id, iteration: p.iteration });
  const inv = read.usage.runs.find((x) => x.id === r.run).invocations[0];
  assert.deepEqual([inv.cost.status, inv.cost.usd, inv.model_observed, inv.cost.estimated_from_requested.usd, inv.cost.estimated_from_requested.tier], ['unknown', null, null, 0.04865355, 'standard']);
  assert.deepEqual([read.usage.totals.cost.estimated_usd, read.usage.totals.cost.estimated_from_requested.usd, read.app_totals.cost.estimated_from_requested.usd], [null, 0.04865355, 0.04865355]);
  // The USD threshold (0.01) is below the estimate, yet the estimate is not
  // counted against it: an unknown cost is not 0 and not this estimate.
  const v = P.iterationVerdict(db, iteration(db, p.iteration), { reservation: 0, repair: false, item_repairs: 0, work_item: null });
  assert.notEqual(v?.limit, 'usd_estimated');
  assert.deepEqual(read.accounting_basis.estimated_cost.fields.filter((f) => f.startsWith('usage.totals.cost.estimated_from_requested')).length, 1, 'classed as an estimated cost on the legend');
});
