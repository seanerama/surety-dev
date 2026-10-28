// Developer tests for Rapid prototype slice E1 (migration 0044; the owner's
// rulings R4, R7 and R9 of 2026-10-28): the execution mode and its preset
// bootstrap policy, the prototype limit keys, the iteration's durable
// attribution of runs through the dispatch transaction, the iteration read's
// usage (pending, complete, incomplete, cost statuses, unknown never zero),
// the receipt, and a teardown setting a prototype's Alpha back while its
// history stays. A scratch store with the engine's migrations and a scratch
// git repository; the scripted backend of the harness; no engine, process or
// host resource is started.

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
const { configureGit, git, repoContext } = await import(join(dist, 'git', 'exec.js'));
const { prepareNewProject } = await import(join(dist, 'setup', 'projects.js'));
const { bootstrapProject } = await import(join(dist, 'store', 'transitions', 'project.js'));
const R = await import(join(dist, 'store', 'transitions', 'runs.js'));
const { observeTrigger } = await import(join(dist, 'store', 'transitions', 'work.js'));
const { readProject, listProjects } = await import(join(dist, 'store', 'projections.js'));
const { listIterations, readIteration, iterationReceipt, receiptResponse } = await import(join(dist, 'prototype', 'iterations.js'));
const { recordIterationAlpha, withdrawAlpha } = await import(join(dist, 'store', 'transitions', 'prototype.js'));
const { validatePolicySubmission, wideningKeys, projectEffectiveDefaults } = await import(join(dist, 'config', 'project-policy.js'));
const { holdSecret } = await import(join(dist, 'records', 'redact.js'));
const { chargeInvocation } = await import(join(dist, 'store', 'transitions', 'ledger.js'));

setEngineSettings({ lease_ttl: 600, git_deadline: 30, decision_targets: {} });
const HUMAN = { actor_kind: 'human', actor_id: null, request_id: 'req-1' };
const AT = '2026-10-28T00:00:00.000Z';
const PROTO_LIMITS = { prototype_budget_tokens: 1_500_000, prototype_budget_usd_estimated: 15, prototype_runtime_seconds: 2700, prototype_repairs_per_stage: 2, prototype_repairs_per_iteration: 4 };
// The prototype preset's per-run limit (slice E3, the driver's setting), snapshotted with the five keys.
const RUN_LIMIT = 300_000;
const ITERATION_LIMITS = { ...PROTO_LIMITS, budget_run_billable_tokens: RUN_LIMIT };

// A scratch home, store and git configuration, under the harness so that the
// scripted backend is every role's default, as in the kernel lane.
function scratch(t) {
  assert.equal(configureHarness(true, []), null);
  t.after(() => configureHarness(false, []));
  const dir = mkdtempSync(join(tmpdir(), 'surety-rp-'));
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
  // POST /v1/projects/new, prepared and recorded as the route does; then
  // registered and resumed so that it can dispatch.
  const create = async (body = {}) => {
    const prepared = await prepareNewProject(rt, { name: 'Proto', idea: 'A small app.', dev_repo_path: join(dir, `app${++n}`), ...body });
    const made = transact(db, HUMAN, (tx) => bootstrapProject(tx, prepared));
    db.prepare(`UPDATE projects SET registration_state = 'registered', paused = 0 WHERE id = ?`).run(made.project.id);
    return { ...made.project, repo: prepared.repo, commit: prepared.commit };
  };
  return { db, dir, create };
}

// One run of a fix work item, claimed through the dispatch transaction.
function dispatch(db, project, trigger) {
  const wi = transact(db, ENGINE_ACTOR, (tx) => observeTrigger(tx, { project, kind: 'fix', trigger_source: 'test', trigger_id: trigger, trigger_generation: 1 }, {})).work_item.id;
  const claim = transact(db, ENGINE_ACTOR, (tx) => R.claimDispatch(tx, { project, workItem: wi, incarnation: 'inc_1', scripted: 'scripted-1' }));
  assert.ok(claim, 'the work is dispatched');
  const inv = db.prepare('SELECT id FROM invocation_receipts WHERE run = ?').get(claim.run).id;
  const dom = db.prepare('SELECT id FROM execution_domains WHERE run = ?').get(claim.run).id;
  return { run: claim.run, inv, dom };
}
const launch = (db, r) =>
  transact(db, ENGINE_ACTOR, (tx) => {
    R.dispatchStarted(tx, { run: r.run, invocation: r.inv });
    R.recordLaunch(tx, { run: r.run, invocation: r.inv, domain: r.dom, pid: 999999, pgid: 999999, startTime: null });
  });
const usage = (db, r, raw) => transact(db, ENGINE_ACTOR, (tx) => R.recordUsage(tx, { run: r.run, generation: 1, invocation: r.inv, semantics: 'cumulative', raw }));
function end(db, r, outcome = 'completed', reason = 'none') {
  transact(db, ENGINE_ACTOR, (tx) => R.beginEnd(tx, { run: r.run, outcome, reason }));
  transact(db, ENGINE_ACTOR, (tx) => R.domainTerminated(tx, { domain: r.dom, observed: true }));
  const inv = Object.fromEntries(db.prepare('SELECT id FROM invocation_receipts WHERE run = ?').all(r.run).map((x) => [x.id, 'ended']));
  transact(db, ENGINE_ACTOR, (tx) => R.finishRun(tx, { run: r.run, invocations: inv, recovery: null }));
}
// A run that ran to the end with `raw` as its usage.
function runWith(db, project, trigger, raw, outcome, reason) {
  const r = dispatch(db, project, trigger);
  launch(db, r);
  if (raw) usage(db, r, raw);
  end(db, r, outcome, reason);
  return r;
}
const iterationOf = (db, project) => db.prepare('SELECT * FROM prototype_iterations WHERE project = ? ORDER BY seq').all(project);
// The iteration's recorded limits changed, as a test of what E1 reads needs
// room for several runs: from slice E2 each dispatch reserves its run limit
// (1,500,000 by default) against prototype_budget_tokens (1,500,000 by
// default), so that under the defaults an iteration admits one run at a time
// and one in all once any usage has settled.
const setLimits = (db, iteration, change) => {
  const row = db.prepare('SELECT limits_json FROM prototype_iterations WHERE id = ?').get(iteration);
  db.prepare('UPDATE prototype_iterations SET limits_json = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.limits_json), ...change }), iteration);
};

test('a new app is planned by default: no bootstrap policy, no iteration, mode served, prototype null', async (t) => {
  const { db, create } = scratch(t);
  const p = await create({ tier: 'T2' });
  assert.equal(p.mode, undefined, 'the create answer is as before');
  assert.equal(db.prepare('SELECT mode, policy_revision FROM projects WHERE id = ?').get(p.id).mode, 'planned');
  assert.equal(db.prepare('SELECT policy_revision FROM projects WHERE id = ?').get(p.id).policy_revision, null, 'the schema defaults stay effective');
  assert.deepEqual(iterationOf(db, p.id), []);
  const read = readProject(db, { project: p.id }).project;
  assert.deepEqual([read.mode, read.prototype, read.tier], ['planned', null, 'T2']);
  assert.equal(listProjects(db).projects.find((x) => x.id === p.id).mode, 'planned');
  assert.deepEqual(listIterations(db, { project: p.id }).iterations, []);
  const r = runWith(db, p.id, 'a', { input_tokens: 1, output_tokens: 1 });
  assert.equal(db.prepare('SELECT iteration FROM runs WHERE id = ?').get(r.run).iteration, null, "a planned project's run is no iteration's");
});

test('rapid_prototype: T1, the preset bootstrap policy as revision 1 (no widening), committed; iteration 1 preparing with its limits; prototype.iteration served', async (t) => {
  const { db, create } = scratch(t);
  const p = await create({ mode: 'rapid_prototype' });
  const row = db.prepare('SELECT mode, tier, policy_revision FROM projects WHERE id = ?').get(p.id);
  assert.deepEqual([row.mode, row.tier], ['rapid_prototype', 'T1']);
  const pol = db.prepare('SELECT * FROM policy_revisions WHERE id = ?').get(row.policy_revision);
  assert.deepEqual([pol.revision, pol.widens_authority, pol.committed, pol.decision, pol.git_path], [1, 0, 1, null, '.surety/policy.json']);
  const effective = JSON.parse(pol.effective);
  assert.deepEqual([effective.autonomy, effective.phase_size, effective.design, effective.alpha_deploy], ['phase', { min: 1, max: 2 }, 'off', 'on_phase_complete']);
  assert.deepEqual(JSON.parse(pol.diff_summary), { autonomy: 'phase', phase_size: { min: 1, max: 2 }, design: 'off', alpha_deploy: 'on_phase_complete', budget_run_billable_tokens: RUN_LIMIT });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE kind = 'policy_widening'`).get().n, 0, 'no widening asked for');
  // The policy file is in the bootstrap commit, the recorded blob.
  const ls = await git(repoContext(p.repo), ['ls-tree', p.commit.tree, '.surety/policy.json']);
  assert.match(ls.stdout, new RegExp(`blob ${pol.git_blob}\\t\\.surety/policy\\.json`));

  const its = iterationOf(db, p.id);
  assert.equal(its.length, 1);
  assert.deepEqual([its[0].id, its[0].seq, its[0].status, its[0].mode, its[0].predecessor], [p.iteration, 1, 'preparing', 'rapid_prototype', null]);
  assert.deepEqual(JSON.parse(its[0].limits_json), ITERATION_LIMITS);
  const read = readProject(db, { project: p.id }).project;
  assert.deepEqual([read.mode, read.prototype], ['rapid_prototype', { iteration: p.iteration, status: 'preparing' }]);
  const list = listIterations(db, { project: p.id });
  assert.equal(typeof list.served_at, 'string');
  assert.deepEqual(list.iterations, [
    { id: p.iteration, seq: 1, mode: 'rapid_prototype', status: 'preparing', predecessor: null, brief: { spec_revision: null, decision: null, record: null, version: null }, next_step: 'approve preparation or discard', created_at: its[0].created_at, approved_at: null, alpha_at: null, ended_at: null },
  ]);
  assert.deepEqual(readIteration(db, { project: p.id, iteration: p.iteration }).iteration.limits, ITERATION_LIMITS);
});

test('the new-app route refuses an unknown mode and a prototype at another tier, creating nothing', async (t) => {
  const { db, dir, create } = scratch(t);
  await assert.rejects(create({ mode: 'fast', tier: 'T1' }), (e) => e.status === 400 && e.code === 'invalid_value' && e.subject?.field === 'mode');
  await assert.rejects(create({ mode: 'rapid_prototype', tier: 'T2' }), (e) => e.status === 400 && e.code === 'invalid_value' && e.subject?.field === 'tier');
  await assert.rejects(create({ mode: 'planned' }), (e) => e.code === 'invalid_value' && e.subject?.field === 'tier', 'a planned build still names its tier');
  const p = await create({ mode: 'rapid_prototype', tier: 'T1' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 1);
  assert.ok(p.iteration);
  void dir;
});

test('the prototype keys: defaults, validation, and widening when raised as the budget keys are', () => {
  const d = projectEffectiveDefaults();
  assert.deepEqual(Object.fromEntries(Object.keys(PROTO_LIMITS).map((k) => [k, d[k]])), PROTO_LIMITS);
  assert.deepEqual(validatePolicySubmission(PROTO_LIMITS), PROTO_LIMITS);
  for (const [key, value] of [['prototype_budget_tokens', 9_999], ['prototype_budget_tokens', 1.5], ['prototype_budget_usd_estimated', -1], ['prototype_runtime_seconds', 299], ['prototype_repairs_per_stage', 11], ['prototype_repairs_per_iteration', 41], ['prototype_repairs_per_iteration', '4']]) {
    assert.throws(() => validatePolicySubmission({ [key]: value }), (e) => e.status === 400 && e.code === 'invalid_value' && e.subject?.field === key, `${key} ${value}`);
  }
  assert.deepEqual(validatePolicySubmission({ prototype_budget_usd_estimated: 12.5 }), { prototype_budget_usd_estimated: 12.5 });
  assert.deepEqual(wideningKeys(d, PROTO_LIMITS), [], 'the defaults set again widen nothing');
  assert.deepEqual(wideningKeys(d, { prototype_budget_tokens: 1_000_000, prototype_runtime_seconds: 600 }), [], 'lowering never widens');
  assert.deepEqual(
    wideningKeys(d, { prototype_budget_tokens: 2_000_000, prototype_budget_usd_estimated: 20, prototype_runtime_seconds: 3600, prototype_repairs_per_stage: 3, prototype_repairs_per_iteration: 5 }).sort(),
    Object.keys(PROTO_LIMITS).sort(),
    'raising each widens',
  );
});

test('attribution: three Builder runs are three agent runs of one role, each its iteration’s, fixed at dispatch; usage pending then complete', async (t) => {
  const { db, create } = scratch(t);
  const p = await create({ mode: 'rapid_prototype' });
  setLimits(db, p.iteration, { prototype_budget_tokens: 10_000_000 });
  runWith(db, p.id, 'a', { input_tokens: 100, cache_read_tokens: 20, output_tokens: 30 });
  runWith(db, p.id, 'b', { input_tokens: 10, cache_read_tokens: 0, output_tokens: 5 });
  const third = dispatch(db, p.id, 'c');
  launch(db, third);
  usage(db, third, { input_tokens: 7, cache_read_tokens: 1, output_tokens: 2 });
  assert.deepEqual(db.prepare('SELECT DISTINCT iteration FROM runs WHERE project = ?').all(p.id), [{ iteration: p.iteration }]);

  const during = readIteration(db, { project: p.id, iteration: p.iteration });
  assert.deepEqual([during.usage.totals.agent_runs, during.usage.totals.roles_used, during.usage.totals.invocations], [3, ['builder'], 3]);
  assert.deepEqual(during.usage.totals.completeness, { complete: 2, pending: 1, incomplete: 0, not_launched: 0 });
  const pending = during.usage.runs[2].invocations[0];
  assert.deepEqual([pending.usage.state, pending.usage.billable_in, pending.cost.status, pending.status], ['pending', 7, 'unknown', 'launched']);
  assert.equal(pending.reserved_tokens, RUN_LIMIT - 9, 'it reserves its run limit less what it observed');
  assert.deepEqual([during.usage.totals.tokens.total, during.usage.totals.tokens.total_is], [175, 'lower_bound']);
  assert.equal(during.remaining.tokens, 10_000_000 - (130 + 15) - 9 - (RUN_LIMIT - 9), 'settled usage plus what the run under way observed and still reserves');

  end(db, third);
  const after = readIteration(db, { project: p.id, iteration: p.iteration });
  assert.deepEqual(after.usage.totals.completeness, { complete: 3, pending: 0, incomplete: 0, not_launched: 0 });
  assert.deepEqual([after.usage.totals.tokens.billable_in, after.usage.totals.tokens.cached_in, after.usage.totals.tokens.out, after.usage.totals.tokens.total, after.usage.totals.tokens.total_is], [117, 21, 37, 175, 'complete']);
  assert.equal(after.remaining.tokens, 10_000_000 - (117 + 37));
  assert.deepEqual(after.usage.runs.map((r) => [r.role, r.outcome, r.invocations.length, typeof r.duration_ms]), [['builder', 'completed', 1, 'number'], ['builder', 'completed', 1, 'number'], ['builder', 'completed', 1, 'number']]);
  assert.deepEqual(after.usage.runs[0].invocations[0].usage.raw_categories, { input_tokens: 100, cache_read_tokens: 20, output_tokens: 30 });
  assert.deepEqual(after.usage.totals.preparation, { runs: 0, tokens: 0, usd: 0 }, 'no preparation run exists: zero by count');
  assert.equal(after.remaining.repairs_iteration, 4);
  assert.equal(after.remaining.runtime_seconds, 2700, 'not approved: the runtime has not started');
  assert.equal(after.time.approval_to_alpha_seconds, null);
  // A run dispatched once the iteration has ended is not its. (From slice
  // E3 a `failed` iteration still takes the retried work of its parked item,
  // so the ended status here is alpha_ready.)
  db.prepare(`UPDATE prototype_iterations SET status = 'alpha_ready' WHERE id = ?`).run(p.iteration);
  const later = dispatch(db, p.id, 'd');
  assert.equal(db.prepare('SELECT iteration FROM runs WHERE id = ?').get(later.run).iteration, null);
  assert.equal(readIteration(db, { project: p.id, iteration: p.iteration }).usage.totals.agent_runs, 3, 'nothing joined by time');
});

test('a run with two invocations counts two; an incomplete invocation shows its unknown allowance and no total of 0; cost statuses kept apart', async (t) => {
  const { db, create } = scratch(t);
  const p = await create({ mode: 'rapid_prototype' });
  setLimits(db, p.iteration, { prototype_budget_tokens: 10_000_000 });
  // A session run of two turns: two invocations of one run (a one-shot run
  // has exactly one receipt, store constraint). Its rows written as the
  // session protocol leaves them, its attribution as session.ts sets it;
  // each invocation charged by the ledger's own chargeInvocation.
  const run = 'run_session';
  db.pragma('foreign_keys = OFF');
  db.prepare(
    `INSERT INTO runs (id, created_at, project, seq, role, kind, state, outcome, reason_class, backend, backend_version, model_requested, base_revision, deadline_at, quarantined, "grant", started_at, finished_at, iteration)
     VALUES (?, ?, ?, 1, 'architect', 'session', 'ended', 'completed', 'none', 'scripted', 'scripted-1', 'opus', 'rev', ?, 0, 'grant_s', ?, ?, ?)`,
  ).run(run, AT, p.id, AT, AT, '2026-10-28T00:02:00.000Z', p.iteration);
  const turn = (n, raw) => {
    const inv = `inv_t${n}`;
    db.prepare(`INSERT INTO turns (id, created_at, project, run, number, invocation, domain, started_at) VALUES (?, ?, ?, ?, ?, ?, 'dom_x', ?)`).run(`turn_${n}`, AT, p.id, run, n, inv, AT);
    db.prepare(`INSERT INTO invocation_receipts (id, created_at, project, run, turn, provider, model_requested, "grant", budget_snapshot) VALUES (?, ?, ?, ?, ?, 'scripted', 'opus', 'grant_s', '{}')`).run(inv, AT, p.id, run, `turn_${n}`);
    db.prepare(`INSERT INTO usage_observations (id, created_at, project, invocation, seq, semantics, raw, at) VALUES (?, ?, ?, ?, 1, 'cumulative', ?, ?)`).run(`uo_${n}`, AT, p.id, inv, JSON.stringify(raw), AT);
    transact(db, ENGINE_ACTOR, (tx) => {
      R.observeInvocation(tx, inv, 'ended');
      chargeInvocation(tx, { id: run, project: p.id, role: 'architect', backend: 'scripted', model_requested: 'opus', outcome: 'completed' }, { id: inv, turn: `turn_${n}` });
    });
  };
  turn(1, { input_tokens: 1_000_000, cache_read_tokens: 2_000_000, output_tokens: 500_000, model: 'scripted-priced' });
  turn(2, { input_tokens: 3, cache_read_tokens: 0, output_tokens: 1, cost_usd: 0.5 });
  db.pragma('foreign_keys = ON');
  // A stopped run: the engine ended it after one observation, so its usage
  // is incomplete and it carries the allowance (ledger.ts C4).
  runWith(db, p.id, 'b', { input_tokens: 10 }, 'stopped', 'human_stop');
  // A measured zero.
  runWith(db, p.id, 'd', { input_tokens: 0, cache_read_tokens: 0, output_tokens: 0, cost_usd: 0 });
  // A run with no observation at all and no allowance (the scripted provider
  // that said nothing): its usage unknown. Last: from slice E2 what the
  // iteration committed is unknown after it, and no further run is admitted.
  runWith(db, p.id, 'c', null);

  const read = readIteration(db, { project: p.id, iteration: p.iteration });
  const [two, stopped, zero, silent] = read.usage.runs;
  assert.equal(two.invocations.length, 2);
  assert.equal(read.usage.totals.invocations, 5);
  assert.equal(read.usage.totals.agent_runs, 4);
  const [est, rep] = two.invocations;
  assert.deepEqual([est.turn, rep.turn], ['turn_1', 'turn_2']);
  assert.deepEqual([est.cost.status, est.cost.usd, est.cost.pricing_basis], ['estimated', 7, 'scripted-prices-1']);
  assert.deepEqual([rep.cost.status, rep.cost.usd, rep.cost.pricing_basis], ['reported', 0.5, null]);
  const inc = stopped.invocations[0];
  assert.deepEqual([inc.usage.state, inc.usage.billable_in, inc.usage.out, inc.unknown_allowance_tokens], ['incomplete', 10, null, RUN_LIMIT - 10]);
  const none = silent.invocations[0];
  assert.deepEqual([none.usage.state, none.usage.billable_in, none.unknown_allowance_tokens, none.cost.status], ['incomplete', null, null, 'unknown']);
  assert.deepEqual([zero.invocations[0].cost.status, zero.invocations[0].cost.usd], ['measured_zero', 0]);
  const totals = read.usage.totals;
  assert.deepEqual(totals.completeness, { complete: 3, pending: 0, incomplete: 2, not_launched: 0 });
  assert.equal(totals.unknown_allowance_tokens, RUN_LIMIT - 10, 'the allowance shown apart from observed usage');
  assert.deepEqual([totals.cost.reported_usd, totals.cost.estimated_usd, totals.cost.unknown_invocations], [0.5, 7, 2]);
  assert.deepEqual(totals.roles_used, ['architect', 'builder'], 'distinct roles that ran, in the order they first ran');
  assert.equal(totals.tokens.total_is, 'lower_bound');
  assert.notEqual(totals.tokens.total, 0);
  assert.equal(read.remaining.tokens, null, 'an invocation of unknown usage with no allowance leaves the remainder unknown, never full');
  assert.match(read.remaining.tokens_reason, /unknown billable tokens/);
  assert.equal(read.remaining.usd_estimated, null);

  // A project whose one invocation knows nothing: no total, never 0.
  const q = await create({ mode: 'rapid_prototype' });
  runWith(db, q.id, 'x', null);
  const only = readIteration(db, { project: q.id, iteration: q.iteration }).usage.totals.tokens;
  assert.deepEqual([only.total, only.billable_in], [null, null]);
  assert.match(only.total_reason, /no token count/);
});

test('the receipt: the read with its identity, sent as an attachment, with no grant, key reference or held secret in it', async (t) => {
  const { db, create } = scratch(t);
  const p = await create({ mode: 'rapid_prototype' });
  const r = runWith(db, p.id, 'a', { input_tokens: 5, cache_read_tokens: 0, output_tokens: 1, note: 'sk-held-secret-value' });
  holdSecret('rp-unit', 'sk-held-secret-value');
  const receipt = iterationReceipt(db, { project: p.id, iteration: p.iteration });
  assert.deepEqual([receipt.receipt_version, receipt.project, receipt.iteration_id, receipt.iteration.id, typeof receipt.generated_at], [1, p.id, p.iteration, p.iteration, 'string']);
  const reply = receiptResponse(receipt, p.iteration);
  assert.equal(reply.status, 200);
  assert.equal(reply.headers['content-disposition'], `attachment; filename="surety-receipt-${p.iteration}.json"`);
  const text = JSON.stringify(reply.body);
  assert.ok(!text.includes('sk-held-secret-value'), 'a held secret is redacted');
  const grant = db.prepare('SELECT grant FROM runs WHERE id = ?').get(r.run).grant;
  for (const absent of [grant, 'budget_snapshot', 'credential', 'key_ref', 'API_KEY']) assert.ok(!text.includes(absent), `no ${absent}`);
  assert.throws(() => readIteration(db, { project: p.id, iteration: 'it_none' }), (e) => e.status === 404);
});

test('Alpha: recorded on the iteration as history; current only on a fresh observation; a teardown sets the candidate back and current to null while alpha_at stays', async (t) => {
  const { db, create } = scratch(t);
  const p = await create({ mode: 'rapid_prototype' });
  const planned = await create({ tier: 'T1' });
  db.pragma('foreign_keys = OFF');
  for (const [proj, n] of [[p.id, 1], [planned.id, 2]]) {
    db.prepare(`INSERT INTO environments (id, created_at, project, name, adapter, adapter_config_ref, verify_spec, current_generation) VALUES (?, ?, ?, 'alpha', 'local_service', 'x', '{}', 1)`).run(`env_${n}`, AT, proj);
    db.prepare(`INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress) VALUES (?, ?, ?, 1, 'rev', 'lin', ?, 'engine_cadence', 'alpha_deployed')`).run(`cand_${n}`, AT, proj, AT);
    db.prepare(`INSERT INTO deployment_requests (id, created_at, project, request_key, requested_by, candidate, environment, outcome) VALUES (?, ?, ?, 'k', 'policy', ?, ?, 'deployed')`).run(`dreq_${n}`, AT, proj, `cand_${n}`, `env_${n}`);
  }
  db.pragma('foreign_keys = ON');
  transact(db, ENGINE_ACTOR, (tx) => recordIterationAlpha(tx, { project: p.id, candidate: 'cand_1', request: 'dreq_1', operation: 'op_1' }));
  const it = iterationOf(db, p.id)[0];
  assert.deepEqual([it.status, it.candidate, it.deployment_request, it.outcome_reason, it.next_step, it.alpha_at !== null], ['alpha_ready', 'cand_1', 'dreq_1', 'alpha_complete', 'open_alpha', true]);
  let read = readIteration(db, { project: p.id, iteration: p.iteration });
  assert.deepEqual([read.alpha.candidate, read.alpha.environment, read.alpha.deployed_at, read.alpha.current], ['cand_1', { id: 'env_1', name: 'alpha' }, it.alpha_at, null], 'no observation: not current');
  const observe = (at, generation = 1) =>
    db.prepare(`INSERT INTO observation_history (id, created_at, project, environment, observed_at, source, condition, read_interval, expected_revision, deployment_generation, facts, installed) VALUES (?, ?, ?, 'env_1', ?, 'test', 'healthy', '{}', 1, ?, '{}', 1)`).run(`obs_${at}_${generation}`, at, p.id, at, generation);
  observe('2026-01-01T00:00:00.000Z');
  assert.equal(readIteration(db, { project: p.id, iteration: p.iteration }).alpha.current, null, 'an observation past the freshness bound says nothing of now');
  const fresh = new Date().toISOString();
  observe(fresh);
  read = readIteration(db, { project: p.id, iteration: p.iteration });
  assert.deepEqual(read.alpha.current, { observed_at: fresh, healthy: true, condition: 'healthy' });
  assert.deepEqual(read.outcome, { status: 'alpha_ready', reason: 'alpha_complete', next_step: 'open_alpha' });

  const withdrawn = transact(db, ENGINE_ACTOR, (tx) => withdrawAlpha(tx, { project: p.id, environment: 'env_1', operation: 'op_td' }));
  assert.deepEqual(withdrawn, ['cand_1']);
  assert.equal(db.prepare('SELECT progress FROM candidates WHERE id = ?').get('cand_1').progress, 'developing');
  read = readIteration(db, { project: p.id, iteration: p.iteration });
  assert.equal(read.alpha.current, null, 'a torn-down Alpha is not current, however fresh the last observation');
  assert.deepEqual([read.alpha.deployed_at, read.iteration.alpha_at, read.outcome.status], [it.alpha_at, it.alpha_at, 'alpha_ready'], 'the history is kept');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'candidate.alpha_withdrawn'`).get().n, 1);
  // A planned project's candidate is not changed by its teardown.
  assert.deepEqual(transact(db, ENGINE_ACTOR, (tx) => withdrawAlpha(tx, { project: planned.id, environment: 'env_2', operation: 'op_td2' })), []);
  assert.equal(db.prepare('SELECT progress FROM candidates WHERE id = ?').get('cand_2').progress, 'alpha_deployed');
});
