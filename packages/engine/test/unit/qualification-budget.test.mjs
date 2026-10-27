// Developer tests for the qualification budget (B2, SETUP-01; Sean's
// approval of 2026-10-27): the upfront admission of a qualification attempt
// at its qualification_approval (charged today + outstanding reservations +
// the attempt's own reservation <= the fixture project's
// budget_day_unknown_tokens, refused with the four numbers and the clearing
// time otherwise), and the reservation's life: converted into the
// cancellation canary's ledger row, released when the attempt ends or the
// canary is refused, and neither lost nor counted twice across a kill and
// restart of the engine mid-canary. Against a scratch store with the
// engine's migrations; the kill is a real SIGKILL of a child process that
// holds the store open mid-canary.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const { answerQueued } = await import(join(dist, 'store', 'transitions', 'queue.js'));
const trust = await import(join(dist, 'store', 'transitions', 'trust.js'));
const { proposeAttempt, canaryItem, startAttemptRun, invalidateAttemptBy, concludeAttempt } = await import(join(dist, 'store', 'transitions', 'qualification.js'));
const { attemptAdmission, outstandingReservation, requestedReservation } = await import(join(dist, 'store', 'transitions', 'qualification-budget.js'));
const { dayUnknownAccount } = await import(join(dist, 'store', 'transitions', 'ledger.js'));
const { beginEnd, finishRun } = await import(join(dist, 'store', 'transitions', 'runs.js'));
const { CANARY_FAILURE_CLASSES } = await import(join(dist, 'trust', 'canaries.js'));
const { exportContract } = await import(join(dist, 'contract', 'document.js'));
const { QUALIFICATION_RUN_BILLABLE_TOKENS } = await import(join(dist, 'trust', 'fixture.js'));
const { hostIdentity } = await import(join(dist, 'trust', 'host.js'));
const { nowIso } = await import(join(dist, 'clock.js'));

const HUMAN = { actor_kind: 'human', actor_id: null, request_id: null };
const AT = '2026-10-27T00:00:00.000Z';
const TODAY = () => nowIso().slice(0, 10);
const Q = 300_000;
const DAY = 2_000_000;

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-qb-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The fixture project, under the qualification profile (its run limit Q) or
// the project defaults (1,500,000), with the day limit DAY.
function setup(db, { runLimit = Q } = {}) {
  setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  run(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_fx', ?, 'surety-qualification-fixture', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
  );
  if (runLimit !== null) {
    run(
      `INSERT INTO policy_revisions (id, created_at, project, revision, git_path, git_blob, changed_by, changed_at, diff_summary, widens_authority, committed, effective)
       VALUES ('pol_1', ?, 'prj_fx', 1, '.surety/policy.json', 'b', 'engine', ?, 'the qualification profile', 0, 1, ?)`,
      AT,
      AT,
      JSON.stringify({ budget_run_billable_tokens: runLimit, budget_day_unknown_tokens: DAY }),
    );
    run(`UPDATE projects SET policy_revision = 'pol_1' WHERE id = 'prj_fx'`);
  }
  run(`INSERT INTO engine_incarnations (id, created_at, pid, started_at, host_boot_id) VALUES ('inc_1', ?, 1, ?, 'boot')`, AT, AT);
  run(`INSERT INTO records (id, created_at, project, kind, path, sha256, bytes, redaction_version, published, post_scan) VALUES ('rec_E1', ?, NULL, 'qualification_evidence', 'rec_E1', ?, 1, 'r1', 1, 'clean')`, AT, 'a'.repeat(64));
  transact(db, ENGINE_ACTOR, (tx) =>
    trust.recordHostQualification(tx, { incarnation: 'inc_1', host_id: hostIdentity(), kernel: 'k', tool_versions: {}, mechanism_fingerprint: 'mech-1', checks: [], probes: [], evidence: 'rec_E1' }),
  );
}

function openStore(t, path, opts) {
  const db = new Database(path);
  t.after(() => db.open && db.close());
  db.pragma('foreign_keys = ON');
  migrate(db, join(root, 'migrations'));
  if (opts) setup(db, opts);
  return db;
}

const store = (t, opts = {}) => openStore(t, join(scratch(t), 'store.db'), opts);

const attemptInput = (hq, over = {}) => ({
  backend: 'claude',
  version: '2.1.288',
  binary_path: '/nowhere/claude',
  binary_sha256: '1'.repeat(64),
  help_sha256: '2'.repeat(64),
  template: 't',
  template_version: '1',
  model: 'claude-sonnet-5-5',
  auth_mode: 'subscription_token',
  host_qualification: hq,
  profile_fingerprint: 'prof-1',
  fixture_project: 'prj_fx',
  candidate_egress: ['api.anthropic.com'],
  canary_deadlines: { positive: 600, cancellation: 600, containment: 600 },
  spend: { cap: null, estimate: null, label: 'estimate', overshoot: 'deadline' },
  ...over,
});

function propose(db, over = {}) {
  const hq = trust.currentHostQualification(db).id;
  return transact(db, ENGINE_ACTOR, (tx) => proposeAttempt(tx, attemptInput(hq, over)));
}
const row = (db, id) => trust.getAttempt(db, id);
const decisionRow = (db, id) => db.prepare('SELECT * FROM decisions WHERE id = ?').get(id);
const answer = (db, decision, option) =>
  transact(db, HUMAN, (tx) => answerQueued(tx, { project: null, decision, option, preview_hash: decisionRow(db, decision).preview_hash, note: null, facts: {} }));
const admitted = (db) => {
  const { attempt, decision } = propose(db);
  answer(db, decision, 'approve');
  assert.equal(row(db, attempt.id).status, 'authorized');
  return attempt.id;
};

// What the fixture project's day holds now, reservations included.
function standing(db, attempt) {
  const a = row(db, attempt);
  const charged = dayUnknownAccount(db, 'prj_fx').charged_tokens;
  const reserved = outstandingReservation(db, a);
  return { charged, reserved, total: charged + reserved };
}

// Charged today without a canary: one invocation's ledger row, its billable
// tokens unknown-cost and its allowance.
let ledgerSeq = 0;
function charge(db, tokens) {
  const n = ++ledgerSeq;
  db.pragma('foreign_keys = OFF');
  db.prepare(
    `INSERT INTO ledger_rows (id, created_at, project, invocation, run, turn, role, provider, model_requested, model_observed, raw_usage, normalization_version,
       billable_in, cached_in, out, usage_complete, cost_status, cost_usd, day_utc, unknown_allowance_tokens)
     VALUES (?, ?, 'prj_fx', ?, ?, NULL, 'verifier', 'claude', 'm', NULL, '{}', 'claude-1', 0, NULL, 0, 0, 'unknown', NULL, ?, ?)`,
  ).run(`led_x${n}`, AT, `inv_x${n}`, `run_x${n}`, TODAY(), tokens);
  db.pragma('foreign_keys = ON');
}

// The attempt's cancellation canary dispatched: its work item, its run
// executing, its receipt (the per-canary limit fixed in its snapshot), its
// domain launched, and `observed` tokens observed so far (cost unknown).
let runSeq = 100;
function dispatchCancellation(db, attempt, observed) {
  const a = row(db, attempt);
  if (a.status === 'authorized') transact(db, ENGINE_ACTOR, (tx) => startAttemptRun(tx, { attempt }));
  const item = transact(db, ENGINE_ACTOR, (tx) => canaryItem(tx, { attempt, kind: 'cancellation' }));
  db.pragma('foreign_keys = OFF');
  const run = `run_c_${attempt.slice(-6)}`;
  const inv = `inv_c_${attempt.slice(-6)}`;
  db.prepare(`UPDATE work_items SET status = 'executing' WHERE id = ?`).run(item);
  db.prepare(
    `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined)
     VALUES (?, ?, 'prj_fx', ?, ?, 'verifier', 'one_shot', 'executing', 'claude', '2.1.288', 'claude-sonnet-5-5', ?, ?, 0)`,
  ).run(run, AT, ++runSeq, item, 'a'.repeat(40), '2099-01-01T00:00:00.000Z');
  db.prepare(
    `INSERT INTO invocation_receipts (id, created_at, project, run, provider, model_requested, "grant", budget_snapshot, qualification_attempt) VALUES (?, ?, 'prj_fx', ?, 'claude', 'claude-sonnet-5-5', 'grt_1', ?, ?)`,
  ).run(inv, AT, run, JSON.stringify({ budget_run_billable_tokens: Q, budget_day_unknown_tokens: DAY }), attempt);
  db.prepare(`INSERT INTO execution_domains (id, created_at, project, run, invocation, status, profile) VALUES (?, ?, 'prj_fx', ?, ?, 'launched', 'role')`).run(`dom_c_${attempt.slice(-6)}`, AT, run, inv);
  db.prepare(`INSERT INTO invocation_status_observations (id, created_at, project, invocation, seq, status, at) VALUES (?, ?, 'prj_fx', ?, 1, 'launched', ?)`).run(`iso_c_${attempt.slice(-6)}`, AT, inv, AT);
  if (observed > 0) {
    db.prepare(`INSERT INTO usage_observations (id, created_at, project, invocation, seq, semantics, raw, at) VALUES (?, ?, 'prj_fx', ?, 1, 'cumulative', ?, ?)`).run(
      `uo_c_${attempt.slice(-6)}`,
      AT,
      inv,
      JSON.stringify({ input_tokens: observed - 37, cache_creation_input_tokens: 0, output_tokens: 37, model: 'claude-sonnet-5-5' }),
      AT,
    );
  }
  db.pragma('foreign_keys = ON');
  return { run, inv, domain: `dom_c_${attempt.slice(-6)}` };
}

// The engine ends the canary's run (cancelled at its barrier: `stopped`, or
// `recovered` by a restart), its domain terminated: the run-end protocol's
// own steps, which charge each launched invocation its one original row.
function endCanary(db, c, outcome, recovery = null) {
  db.prepare(`UPDATE execution_domains SET launch_state = 'closed' WHERE id = ? AND launch_state <> 'closed'`).run(c.domain);
  db.prepare(`UPDATE execution_domains SET status = 'terminated' WHERE id = ? AND status <> 'terminated'`).run(c.domain);
  transact(db, ENGINE_ACTOR, (tx) => beginEnd(tx, { run: c.run, outcome, reason: outcome === 'recovered' ? 'recovered' : 'human_stop' }));
  transact(db, ENGINE_ACTOR, (tx) => finishRun(tx, { run: c.run, invocations: {}, recovery }));
}

const ledgerOf = (db, inv) => db.prepare('SELECT * FROM ledger_rows WHERE invocation = ? AND corrects IS NULL').all(inv);

// ---- the profile and the contract --------------------------------------------------------

test('the qualification profile is 300,000 billable tokens per canary, and not_dispatched is a CanaryFailureClass of the published contract', () => {
  assert.equal(QUALIFICATION_RUN_BILLABLE_TOKENS, 300_000);
  assert.ok(CANARY_FAILURE_CLASSES.includes('not_dispatched'));
  for (const c of ['auth_failed', 'invalid_result', 'barrier_not_reached', 'containment_failed', 'continuation_failed', 'model_fallback']) assert.ok(CANARY_FAILURE_CLASSES.includes(c), c);
  assert.deepEqual(exportContract().enums.CanaryFailureClass, [...CANARY_FAILURE_CLASSES]);
});

// ---- admission ---------------------------------------------------------------------------

test('admission: the four numbers are served before the answer, and an approval that fits is accepted, reserving the per-canary limit', (t) => {
  const db = store(t);
  charge(db, 250_000);
  const { attempt, decision } = propose(db);
  const fit = attemptAdmission(db, row(db, attempt.id));
  assert.deepEqual(
    [fit.charged_tokens, fit.outstanding_reserved_tokens, fit.requested_tokens, fit.limit_tokens, fit.fits, fit.limit_key, fit.day],
    [250_000, 0, Q, DAY, true, 'budget_day_unknown_tokens', TODAY()],
  );
  assert.equal(fit.clears_at, new Date(Date.parse(`${TODAY()}T00:00:00.000Z`) + 86_400_000).toISOString(), 'clears at the next 00:00 UTC');
  // GET /v1/engine's attempt carries the same fit.
  const served = trust.trustView(db, { scripted: false }).qualification_attempts.find((x) => x.id === attempt.id);
  assert.deepEqual(served.admission, fit);
  assert.equal(served.reserved_tokens, 0, 'a proposed attempt holds nothing back');
  answer(db, decision, 'approve');
  assert.equal(row(db, attempt.id).status, 'authorized');
  assert.equal(outstandingReservation(db, row(db, attempt.id)), Q, 'admitted: the per-canary limit reserved');
  const after = trust.trustView(db, { scripted: false }).qualification_attempts.find((x) => x.id === attempt.id);
  assert.deepEqual([after.admission, after.reserved_tokens], [null, Q]);
});

test('admission: an approval the day cannot hold is refused budget_exhausted with charged, outstanding, requested, limit and the clearing time; the decision stays open, nothing changes', (t) => {
  const db = store(t);
  // Six admitted attempts' worth at the profile: five charged, one reserved.
  charge(db, 5 * Q);
  const first = admitted(db);
  const { attempt, decision } = propose(db);
  const eventsBefore = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  let refusal;
  assert.throws(
    () => answer(db, decision, 'approve'),
    (err) => {
      refusal = err;
      return err.code === 'budget_exhausted' && err.status === 409;
    },
  );
  assert.deepEqual(
    [refusal.subject.charged_tokens, refusal.subject.outstanding_reserved_tokens, refusal.subject.requested_tokens, refusal.subject.limit_tokens],
    [5 * Q, Q, Q, DAY],
    'the four numbers',
  );
  assert.deepEqual(refusal.subject.reserving_attempts, [{ id: first, tokens: Q }]);
  assert.match(refusal.reason, new RegExp(`${5 * Q} unknown-cost tokens charged.*${Q} reserved by attempts already authorized.*reserves ${Q}.*over budget_day_unknown_tokens \\(${DAY}\\)`));
  assert.match(refusal.whatToDo, /00:00 UTC/);
  assert.equal(refusal.subject.clears_at, new Date(Date.parse(`${TODAY()}T00:00:00.000Z`) + 86_400_000).toISOString());
  assert.equal(decisionRow(db, decision).status, 'open', 'the decision stays open');
  assert.equal(row(db, attempt.id).status, 'proposed', 'the attempt stays proposed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, eventsBefore, 'nothing recorded');
  // Reject is never refused on the budget.
  answer(db, decision, 'reject');
  assert.equal(decisionRow(db, decision).status, 'consumed');
});

test('admission: the boundary is <= (as the dispatch check refuses only above the limit), and a session-only qualification reserves 0', (t) => {
  const db = store(t);
  charge(db, DAY - Q);
  const exact = propose(db);
  assert.equal(attemptAdmission(db, row(db, exact.attempt.id)).fits, true, 'charged + requested == limit fits');
  charge(db, 1);
  assert.equal(attemptAdmission(db, row(db, exact.attempt.id)).fits, false, 'one token over does not');
  // An active entry's session qualification runs the continuation canary
  // alone: it reserves nothing, and is admitted while the day is not past.
  const session = row(db, propose(db, { mode: 'session_headless', session_entry: null }).attempt.id);
  assert.equal(requestedReservation(db, session), Q, 'a session_headless attempt with its three canaries reserves the limit');
  assert.equal(requestedReservation(db, { ...session, session_entry: 'te_x' }), 0, "an entry's session qualification reserves 0");
  assert.equal(attemptAdmission(db, { ...session, session_entry: 'te_x' }).fits, true, 'charged (limit + 1 - Q) + 0 + 0 <= limit');
});

test('admission: existing owner limits stand; the fixture at the old default (1,500,000 per run) reserves 1,500,000', (t) => {
  const db = store(t, { runLimit: null });
  const { attempt } = propose(db);
  const fit = attemptAdmission(db, row(db, attempt.id));
  assert.deepEqual([fit.requested_tokens, fit.limit_tokens, fit.fits], [1_500_000, 2_000_000, true]);
  charge(db, 500_001);
  assert.equal(attemptAdmission(db, row(db, attempt.id)).fits, false, 'the attempt whose containment canary today would be held is refused up front');
});

// ---- conversion and release --------------------------------------------------------------

test('conversion: the cancellation canary under way holds its limit less what it observed; its ledger row replaces the reservation; the day total never moves', (t) => {
  const db = store(t);
  charge(db, 100_000);
  const attempt = admitted(db);
  const before = standing(db, attempt);
  assert.deepEqual(before, { charged: 100_000, reserved: Q, total: 100_000 + Q });
  const c = dispatchCancellation(db, attempt, 2_670);
  const under = standing(db, attempt);
  assert.deepEqual(under, { charged: 100_000 + 2_670, reserved: Q - 2_670, total: 100_000 + Q }, 'under way: observed counted once, the rest reserved');
  endCanary(db, c, 'stopped');
  const rows = ledgerOf(db, c.inv);
  assert.equal(rows.length, 1, 'one original row');
  assert.deepEqual([rows[0].billable_in + rows[0].out, rows[0].unknown_allowance_tokens, rows[0].cost_status, rows[0].usage_complete], [2_670, Q - 2_670, 'unknown', 0], 'C4: observed plus the allowance');
  assert.deepEqual(standing(db, attempt), { charged: 100_000 + Q, reserved: 0, total: 100_000 + Q }, 'converted: the charge replaced the reservation, not added to it');
  // Charged again (a retried end): nothing more.
  endCanary(db, c, 'stopped');
  assert.equal(ledgerOf(db, c.inv).length, 1);
  assert.deepEqual(standing(db, attempt), { charged: 100_000 + Q, reserved: 0, total: 100_000 + Q });
  // The next attempt sees the charge and not the reservation.
  const next = propose(db);
  const fit = attemptAdmission(db, row(db, next.attempt.id));
  assert.deepEqual([fit.charged_tokens, fit.outstanding_reserved_tokens], [100_000 + Q, 0]);
});

test('release: the reservation goes when the attempt ends (failed, succeeded, invalidated) and when its cancellation canary is refused', (t) => {
  const db = store(t);
  // failed at the positive canary: never reaches the cancellation canary.
  const failed = admitted(db);
  transact(db, ENGINE_ACTOR, (tx) => startAttemptRun(tx, { attempt: failed }));
  assert.equal(outstandingReservation(db, row(db, failed)), Q, 'running, cancellation not dispatched: reserved');
  transact(db, ENGINE_ACTOR, (tx) => concludeAttempt(tx, { attempt: failed, canaries: [{ kind: 'positive', run: null, passed: false, failure_class: 'auth_failed', provider_error: 'rec_E1' }] }));
  assert.equal(row(db, failed).status, 'failed');
  assert.equal(outstandingReservation(db, row(db, failed)), 0, 'released at the conclusion');
  // invalidated (a binding changed) before any canary.
  const invalid = admitted(db);
  transact(db, ENGINE_ACTOR, (tx) => invalidateAttemptBy(tx, { attempt: invalid, reason: 'binary_changed' }));
  assert.equal(outstandingReservation(db, row(db, invalid)), 0, 'released at the invalidation');
  // the cancellation canary refused before launch: charged nothing, released.
  const refused = admitted(db);
  const c = dispatchCancellation(db, refused, 0);
  db.prepare(`DELETE FROM usage_observations WHERE invocation = ?`).run(c.inv);
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO invocation_status_observations (id, created_at, project, invocation, seq, status, at) VALUES ('iso_ref', ?, 'prj_fx', ?, 2, 'refused', ?)`).run(AT, c.inv, AT);
  db.pragma('foreign_keys = ON');
  assert.equal(outstandingReservation(db, row(db, refused)), 0, 'a refused canary holds nothing');
  // succeeded: the conversion, then the conclusion.
  const passed = admitted(db);
  const pc = dispatchCancellation(db, passed, 4_000);
  endCanary(db, pc, 'stopped');
  assert.equal(outstandingReservation(db, row(db, passed)), 0, 'converted');
  transact(db, ENGINE_ACTOR, (tx) => trust.invalidateAttempt(tx, row(db, passed), 'test: ended'));
  assert.equal(outstandingReservation(db, row(db, passed)), 0, 'and stays released');
  // Every released attempt leaves the next one's fit with nothing outstanding.
  const next = propose(db);
  assert.equal(attemptAdmission(db, row(db, next.attempt.id)).outstanding_reserved_tokens, 0);
  assert.equal(attemptAdmission(db, row(db, next.attempt.id)).charged_tokens, Q, 'only the converted cancellation canary is charged');
});

// ---- a kill and restart mid-canary -------------------------------------------------------

// A child process opens the store, dispatches the attempt's cancellation
// canary (its receipt and first usage committed) and is killed by SIGKILL
// with the store open: no run end, no ledger row, no conclusion.
function killMidCanary(t, path, attempt, observed) {
  const dir = scratch(t);
  const script = join(dir, 'child.mjs');
  writeFileSync(
    script,
    `import { createRequire } from 'node:module';
const Database = createRequire(${JSON.stringify(join(root, 'package.json'))})('better-sqlite3');
const db = new Database(${JSON.stringify(path)});
db.pragma('foreign_keys = OFF');
const a = ${JSON.stringify(attempt)};
const at = new Date().toISOString();
const item = db.prepare("SELECT id FROM work_items WHERE qualification_attempt = ? AND canary_kind = 'cancellation'").get(a).id;
db.prepare("UPDATE work_items SET status = 'executing' WHERE id = ?").run(item);
db.prepare("INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined) VALUES ('run_k', ?, 'prj_fx', 1, ?, 'verifier', 'one_shot', 'executing', 'claude', '2.1.288', 'claude-sonnet-5-5', ?, '2099-01-01T00:00:00.000Z', 0)").run(at, item, 'a'.repeat(40));
db.prepare("INSERT INTO invocation_receipts (id, created_at, project, run, provider, model_requested, \\"grant\\", budget_snapshot, qualification_attempt) VALUES ('inv_k', ?, 'prj_fx', 'run_k', 'claude', 'claude-sonnet-5-5', 'grt_1', ?, ?)").run(at, JSON.stringify({ budget_run_billable_tokens: ${Q} }), a);
db.prepare("INSERT INTO execution_domains (id, created_at, project, run, invocation, status, profile) VALUES ('dom_k', ?, 'prj_fx', 'run_k', 'inv_k', 'launched', 'role')").run(at);
db.prepare("INSERT INTO invocation_status_observations (id, created_at, project, invocation, seq, status, at) VALUES ('iso_k', ?, 'prj_fx', 'inv_k', 1, 'launched', ?)").run(at, at);
db.prepare("INSERT INTO usage_observations (id, created_at, project, invocation, seq, semantics, raw, at) VALUES ('uo_k', ?, 'prj_fx', 'inv_k', 1, 'cumulative', ?, ?)").run(at, JSON.stringify({ input_tokens: ${observed - 37}, cache_creation_input_tokens: 0, output_tokens: 37, model: 'claude-sonnet-5-5' }), at);
process.stdout.write('in flight\\n');
process.kill(process.pid, 'SIGKILL');
`,
  );
  const done = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(done.signal, 'SIGKILL', `the child was killed mid-canary (status ${done.status}, stderr ${done.stderr})`);
  assert.equal(done.stdout, 'in flight\n');
}

test('restart: killed mid-cancellation-canary, the reservation is held once while the canary is unended, then converted exactly once by the restart\'s recovery; a second restart changes nothing', (t) => {
  const path = join(scratch(t), 'store.db');
  let db = openStore(t, path, {});
  charge(db, 50_000);
  const attempt = admitted(db);
  transact(db, ENGINE_ACTOR, (tx) => startAttemptRun(tx, { attempt }));
  transact(db, ENGINE_ACTOR, (tx) => canaryItem(tx, { attempt, kind: 'cancellation' }));
  db.close();

  killMidCanary(t, path, attempt, 2_633 + 37);

  // The restart: the store reopened.
  db = openStore(t, path);
  const fresh = (d) => attemptAdmission(d, row(d, propose(d).attempt.id));
  const atKill = standing(db, attempt);
  assert.deepEqual(atKill, { charged: 50_000 + 2_670, reserved: Q - 2_670, total: 50_000 + Q }, 'after the kill: observed counted once, the rest still reserved; nothing lost, nothing doubled');
  const probe = fresh(db);
  assert.deepEqual([probe.charged_tokens + probe.outstanding_reserved_tokens], [50_000 + Q], "another attempt's fit counts the killed canary once");

  // The restart's own steps (recovery/startup.ts): the running attempt is
  // invalidated engine_restarted; the unended run is ended `recovered`
  // through the run-end protocol, its domain closed first.
  transact(db, ENGINE_ACTOR, (tx) => invalidateAttemptBy(tx, { attempt, reason: 'engine_restarted' }));
  endCanary(db, { run: 'run_k', inv: 'inv_k', domain: 'dom_k' }, 'recovered', 'inc_2');
  const rows = ledgerOf(db, 'inv_k');
  assert.equal(rows.length, 1, 'one original row');
  assert.deepEqual([rows[0].billable_in + rows[0].out, rows[0].unknown_allowance_tokens], [2_670, Q - 2_670], 'charged C4 once: observed plus the allowance');
  assert.equal(row(db, attempt).status, 'invalidated');
  assert.deepEqual(standing(db, attempt), { charged: 50_000 + Q, reserved: 0, total: 50_000 + Q }, 'converted once: the total is what it was before the kill');

  // A second restart: the same recovery again changes nothing.
  db.close();
  db = openStore(t, path);
  transact(db, ENGINE_ACTOR, (tx) => invalidateAttemptBy(tx, { attempt, reason: 'engine_restarted' }));
  transact(db, ENGINE_ACTOR, (tx) => finishRun(tx, { run: 'run_k', invocations: {}, recovery: 'inc_3' }));
  assert.equal(ledgerOf(db, 'inv_k').length, 1, 'still one row');
  assert.deepEqual(standing(db, attempt), { charged: 50_000 + Q, reserved: 0, total: 50_000 + Q });
});

test('restart: killed before the cancellation canary was dispatched, the reservation is released by the restart and nothing is charged for that canary', (t) => {
  const path = join(scratch(t), 'store.db');
  let db = openStore(t, path, {});
  const attempt = admitted(db);
  transact(db, ENGINE_ACTOR, (tx) => startAttemptRun(tx, { attempt }));
  db.close();
  // Killed (nothing of the cancellation canary written): the store reopened.
  db = openStore(t, path);
  assert.deepEqual(standing(db, attempt), { charged: 0, reserved: Q, total: Q }, 'held across the kill');
  transact(db, ENGINE_ACTOR, (tx) => invalidateAttemptBy(tx, { attempt, reason: 'engine_restarted' }));
  assert.deepEqual(standing(db, attempt), { charged: 0, reserved: 0, total: 0 }, 'released by the restart; nothing charged');
});

// ---- the profile at the fixture's creation, and never after -------------------------------

const { ensureFixtureProject, ensureFixtureRepo } = await import(join(dist, 'trust', 'fixture.js'));
const { configureGit } = await import(join(dist, 'git', 'exec.js'));
const { projectEffectiveDefaults } = await import(join(dist, 'config', 'project-policy.js'));

// A runtime and a store client that answer what the fixture's creation asks
// and record its mutations; nothing else is reached.
function fakeEngine(home, { found = null } = {}) {
  const calls = [];
  const store = {
    calls,
    call: async (kind, req) => {
      calls.push({ kind, ...req });
      if (kind === 'read' && req.name === 'qualification.engine_fixture') return found;
      if (kind === 'read' && req.name === 'qualification.moved_fixtures') return [];
      if (kind === 'mutate' && req.name === 'project.create') return { status: 201, body: {}, effects: [] };
      if (kind === 'mutate' && req.name === 'project.policy_submit') return { status: 200, body: { revision: 1, committed: false } };
      throw new Error(`unexpected ${kind} ${req.name}`);
    },
  };
  const rt = {
    home,
    scratch: home,
    incarnation: 'inc_unit',
    services: null,
    afterCommit: () => {},
    setting: (k) => ({ git_deadline: 60, domain_memory_max: 8 * 1024 ** 3 })[k],
    read: async (name) => (name === 'design.inventory_for_policy' ? null : {}),
    engine: async (name) => {
      if (name !== 'project.policy_facts') throw new Error(`unexpected engine ${name}`);
      const repo = await ensureFixtureRepo(home);
      const head = spawnSync('git', ['-C', repo, 'rev-parse', 'main'], { encoding: 'utf8' }).stdout.trim();
      return { repo, branch: 'main', head, effective: projectEffectiveDefaults(), revision: null, blocking: null };
    },
  };
  return { rt, store };
}

test("the fixture project is created with the qualification profile through the policy route's own path (a lowering, no approval); an existing fixture is left as its owner set it", async (t) => {
  const home = scratch(t);
  configureGit({ deadlineSeconds: 10, outputCap: 1 << 20, home, incarnation: 'inc_unit' });
  const { rt, store } = fakeEngine(home);
  const id = await ensureFixtureProject(rt, store);
  const mutations = store.calls.filter((c) => c.kind === 'mutate');
  assert.deepEqual(mutations.map((m) => m.name), ['project.create', 'project.policy_submit'], 'created, then its policy set');
  const submit = mutations[1];
  assert.equal(submit.args.project, id);
  assert.deepEqual(submit.args.ordinary, { budget_run_billable_tokens: 300_000 }, 'the one key: budget_run_billable_tokens');
  assert.deepEqual(submit.args.widens, [], 'a lowering: no approval asked');
  assert.equal(submit.args.governed, null);
  assert.equal(submit.args.prepared.effective.budget_run_billable_tokens, 300_000);
  assert.equal(submit.args.prepared.effective.budget_day_unknown_tokens, projectEffectiveDefaults().budget_day_unknown_tokens, 'the day limits stay the defaults');
  assert.equal(submit.args.prepared.revision, 1);

  // A home whose fixture project exists (made before B2, at 1,500,000, or
  // changed by its owner): found, and nothing is changed.
  const again = fakeEngine(home, { found: 'proj_existing' });
  assert.equal(await ensureFixtureProject(again.rt, again.store), 'proj_existing');
  assert.deepEqual(again.store.calls.filter((c) => c.kind === 'mutate'), [], 'no policy change, no project made');
});
