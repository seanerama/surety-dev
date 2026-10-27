// Developer tests for the workspace assistant's state and usage account (the
// assistant design of 2026-10-27, §§1.3 and 2; Sean's approval of O2(a),
// O4(a) and O7(a)), against a scratch store with the engine's migrations:
//   - the state from real configuration, first failing condition first:
//     unconfigured, credential_missing, qualification_pending, limit_reached,
//     ready; a role template's entry, an entry of another model and a
//     proposed assistant entry never make it ready; project roles never
//     resolve an assistant entry;
//   - admission by reservation in the receipt's transaction: two admissions
//     cannot pass against the same remainder; a refused one writes nothing;
//   - one original row per turn, reported, estimated and unknown apart; an
//     incomplete usage charged its turn limit less what was observed; a
//     provider's own zero is unknown on a real turn; a turn refused before
//     its launch charges nothing; never a duplicate charge;
//   - a kill and restart mid-turn: the reservation is neither lost nor
//     counted twice, and recovery converts it exactly once;
//   - day rollover at 00:00Z;
//   - assistant rows never change any project's ledger read, day budget or
//     exhausted limits, and project rows never change the assistant's day.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const { proposeEntry, proposeAttempt } = await import(join(dist, 'store', 'transitions', 'qualification.js'));
const A = await import(join(dist, 'store', 'transitions', 'assistant.js'));
const { ledgerView, exhaustedLimits } = await import(join(dist, 'store', 'transitions', 'ledger.js'));
const { hostIdentity, ISOLATION_MECHANISM, BOUNDARY_MECHANISM } = await import(join(dist, 'trust', 'host.js'));
const { configureHarness, seamWorkerData } = await import(join(dist, 'testing', 'seam.js'));
const { nowIso } = await import(join(dist, 'clock.js'));

const HUMAN = { actor_kind: 'human', actor_id: null, request_id: 'req-1' };
const AT = '2026-10-27T00:00:00.000Z';
const BLOCK = { backend: 'claude', model: 'sonnet', credential_ref: 'backend/claude/subscription_token', day_limit_billable_tokens: 400_000, turn_limit_billable_tokens: 40_000, turn_deadline_seconds: 120 };
const OK = { manifest_ok: true, loaded: true };
// Claude Code's usage as its adapter observes it (input, cache creation and
// output; final at the result).
const claude = (input, out, extra = {}) => ({ input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: out, ...extra });

function settings(block = BLOCK) {
  setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1', workspace_assistant: block });
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-wa-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seed(db) {
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  run(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
  );
  run(
    `INSERT INTO policy_revisions (id, created_at, project, revision, git_path, git_blob, changed_by, changed_at, diff_summary, widens_authority, committed, effective)
     VALUES ('pol_1', ?, 'prj_1', 1, '.surety/policy.json', 'b', 'engine', ?, 'claude roles', 0, 1, ?)`,
    AT,
    AT,
    JSON.stringify({ backend_builder: 'claude', backend_vision: 'claude', budget_day_unknown_tokens: 2_000_000 }),
  );
  run(`UPDATE projects SET policy_revision = 'pol_1' WHERE id = 'prj_1'`);
  run(`INSERT INTO engine_incarnations (id, created_at, pid, started_at, host_boot_id) VALUES ('inc_1', ?, 1, ?, 'boot')`, AT, AT);
  for (const id of ['rec_E1', 'rec_E2', 'rec_B1']) {
    run(`INSERT INTO records (id, created_at, project, kind, path, sha256, bytes, redaction_version, published, post_scan) VALUES (?, ?, NULL, 'qualification_evidence', ?, ?, 1, 'r1', 1, 'clean')`, id, AT, id, 'a'.repeat(64));
  }
  transact(db, ENGINE_ACTOR, (tx) =>
    trust.recordHostQualification(tx, { incarnation: 'inc_1', host_id: hostIdentity(), kernel: 'k', tool_versions: {}, mechanism_fingerprint: 'mech-1', checks: [], probes: [], evidence: 'rec_E1' }),
  );
}

function openStore(path, { fresh = true } = {}) {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  migrate(db, join(root, 'migrations'));
  if (fresh) seed(db);
  return db;
}

function store(t, block = BLOCK) {
  settings(block);
  const db = openStore(join(scratch(t), 'store.db'));
  t.after(() => db.open && db.close());
  return db;
}

// An entry written proposed by a succeeded attempt, its trust_activation
// raised; `activate` answers it.
function entry(db, { template_version = 'claude-assistant-subscription-1', auth_mode = 'subscription_token', model = 'claude-sonnet-5-5', session_qualified = false, activate = true } = {}) {
  const hq = trust.currentHostQualification(db).id;
  const made = transact(db, ENGINE_ACTOR, (tx) => {
    const { attempt } = proposeAttempt(tx, {
      backend: 'claude',
      version: '2.1.288',
      binary_path: '/opt/claude',
      binary_sha256: '1'.repeat(64),
      help_sha256: '2'.repeat(64),
      template: 't',
      template_version,
      model,
      auth_mode,
      host_qualification: hq,
      profile_fingerprint: 'prof-1',
      fixture_project: 'prj_1',
      candidate_egress: ['api.anthropic.com'],
      canary_deadlines: { positive: 600, cancellation: 600, containment: 600 },
      spend: { cap: null, estimate: null, label: 'estimate', overshoot: 'deadline' },
    });
    if (session_qualified) {
      tx.db.prepare(`UPDATE qualification_attempts SET canaries = ? WHERE id = ?`).run(JSON.stringify([{ kind: 'continuation', passed: true }]), attempt.id);
    }
    return proposeEntry(tx, {
      backend: 'claude',
      version: '2.1.288',
      binary_path: '/opt/claude',
      binary_sha256: '1'.repeat(64),
      help_sha256: '2'.repeat(64),
      mode: 'one_shot_headless',
      template: 't',
      template_version,
      model,
      auth_mode,
      capabilities: { tools: ['Read', 'Write'], denied: ['Agent'], features_disabled: [], delegation_verified: true },
      host_id: hostIdentity(),
      host_qualification: hq,
      isolation: ISOLATION_MECHANISM,
      boundary: BOUNDARY_MECHANISM,
      profile_fingerprint: 'prof-1',
      egress_hosts: ['api.anthropic.com'],
      usage_granularity: 'model_call',
      usage_semantics: 'cumulative',
      cost_reporting: 'reported',
      enforceable_boundaries: [{ boundary: 'invocation', mechanism: 'dispatch_check', evidence: 'rec_B1', overshoot: 'deadline' }],
      result_channel: 'file',
      session_qualified,
      provider_files: { locations: [], persistence_flags: [], excluded: [] },
      term_to_exit_ms: null,
      qualification_attempt: attempt.id,
      evidence: ['rec_E1', 'rec_E2'],
    });
  });
  if (activate) {
    const d = db.prepare('SELECT * FROM decisions WHERE id = ?').get(made.decision);
    transact(db, HUMAN, (tx) => answerQueued(tx, { project: null, decision: d.id, option: 'approve', preview_hash: d.preview_hash, note: null, facts: {} }));
  }
  return made;
}

const state = (db, credential = OK) => A.assistantStateBody(db, { credential });
let conv = 0;
const admit = (db, args = {}) =>
  transact(db, HUMAN, (tx) => A.admitTurn(tx, { conversation: `ac_${++conv}`, intent_id: 'i1', credential: OK, incarnation: 'inc_1', scope: null, ...args }));
const usage = (db, invocation, raw, semantics = 'cumulative') => transact(db, ENGINE_ACTOR, (tx) => A.recordTurnUsage(tx, { invocation, semantics, raw }));
const end = (db, invocation, outcome, reason = outcome, extra = {}) => transact(db, ENGINE_ACTOR, (tx) => A.endTurn(tx, { invocation, outcome, reason, ...extra }));
const launched = (db, claim) => {
  transact(db, ENGINE_ACTOR, (tx) => A.turnDispatched(tx, { invocation: claim.invocation }));
  transact(db, ENGINE_ACTOR, (tx) => A.turnLaunched(tx, { invocation: claim.invocation, domain: claim.domain, pid: 4242, pgid: 4242, startTime: '1' }));
};
const rowsOf = (db, invocation) => db.prepare('SELECT * FROM ledger_rows WHERE invocation = ? ORDER BY rowid').all(invocation);
const account = (db) => A.assistantAccount(db, A.assistantConfig());

test('the state, first failing condition first, from real configuration', (t) => {
  const db = store(t, null);
  let s = state(db);
  assert.equal(s.state, 'unconfigured');
  assert.equal(s.configured, false);
  assert.equal(s.account, null);
  settings();
  s = state(db, { manifest_ok: false, loaded: true });
  assert.deepEqual([s.state, s.configured], ['credential_missing', false]);
  assert.match(s.reason, /credential_manifest_invalid/);
  s = state(db, { manifest_ok: true, loaded: false });
  assert.equal(s.state, 'credential_missing');
  assert.match(s.reason, /backend\/claude\/subscription_token/);
  s = state(db);
  assert.deepEqual([s.state, s.configured, s.qualification.stage, s.qualification.decision], ['qualification_pending', false, 'not_proposed', null]);
  assert.equal(s.account.day_limit, 400_000);
  assert.equal(s.account.remaining, 400_000);
  // A role template's active entry (Vision's, a builder's, a session-qualified
  // one) does not make the assistant ready.
  entry(db, { template_version: 'claude-subscription-1', session_qualified: true });
  entry(db, { template_version: 'claude-subscription-1' });
  assert.equal(state(db).state, 'qualification_pending');
  // An assistant entry of another model does not either.
  entry(db, { model: 'claude-opus-5-5' });
  assert.equal(state(db).state, 'qualification_pending');
  // A proposed one names its open trust_activation.
  const p = entry(db, { activate: false });
  s = state(db);
  assert.deepEqual([s.state, s.qualification.stage, s.qualification.trust_entry, s.qualification.decision?.kind], ['qualification_pending', 'trust_activation', p.entry.id, 'trust_activation']);
  const d = db.prepare('SELECT * FROM decisions WHERE id = ?').get(p.decision);
  transact(db, HUMAN, (tx) => answerQueued(tx, { project: null, decision: d.id, option: 'approve', preview_hash: d.preview_hash, note: null, facts: {} }));
  s = state(db);
  assert.deepEqual([s.state, s.configured, s.trust_entry, s.provider, s.model], ['ready', true, p.entry.id, 'claude', 'sonnet']);
  assert.deepEqual(
    Object.keys(s.account).sort(),
    ['day', 'day_limit', 'estimated_usd', 'fits_one_more_turn', 'id', 'limit_is', 'remaining', 'reported_usd', 'reserved', 'resets_at', 'turn_limit', 'turns_charged', 'turns_under_way', 'unit', 'unknown_allowance_tokens', 'unknown_cost_turns', 'used_known'].sort(),
  );
  assert.equal(s.account.unit, 'billable_tokens');
  // Project roles never resolve the assistant's entry: only the role
  // template's entries are a role's.
  const r = trust.resolveBackend(db, { project: 'prj_1', role: 'builder', scripted: null, model: 'sonnet' });
  assert.equal(r.kind, 'entry');
  assert.equal(r.entry.template_version, 'claude-subscription-1');
  assert.notEqual(r.entry.id, p.entry.id);
});

test("an active assistant entry of another authentication mode leaves the block's credential missing", (t) => {
  const db = store(t);
  entry(db, { template_version: 'claude-assistant-1', auth_mode: 'api_key' });
  const s = state(db);
  assert.equal(s.state, 'credential_missing');
  assert.match(s.reason, /api_key/);
});

test('project roles are refused when only an assistant entry is active', (t) => {
  const db = store(t);
  entry(db);
  const r = trust.resolveBackend(db, { project: 'prj_1', role: 'builder', scripted: null });
  assert.equal(r.kind, 'refused');
  assert.match(r.reason, /no active trust entry|no trust entry/);
});

test('admission reserves the turn limit in the receipt transaction; a second admission cannot pass against the same remainder; a refused one writes nothing', (t) => {
  const db = store(t, { ...BLOCK, day_limit_billable_tokens: 60_000 });
  entry(db);
  const claim = admit(db);
  assert.equal(claim.turn_limit, 40_000);
  const receipt = db.prepare('SELECT * FROM invocation_receipts WHERE id = ?').get(claim.invocation);
  assert.deepEqual([receipt.account, receipt.project, receipt.run, receipt.grant], ['workspace_assistant', null, null, null]);
  const snapshot = JSON.parse(receipt.budget_snapshot);
  assert.deepEqual([snapshot.turn_limit_billable_tokens, snapshot.day_limit_billable_tokens, snapshot.day], [40_000, 60_000, nowIso().slice(0, 10)]);
  assert.equal(db.prepare('SELECT account FROM execution_domains WHERE id = ?').get(claim.domain).account, 'workspace_assistant');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'scheduler.tick_requested' AND json_extract(payload, '$.cause') = 'assistant_turn_admitted'`).get().n, 1, 'the admission asks for a tick');
  let a = account(db);
  assert.deepEqual([a.reserved, a.used_known, a.unknown_allowance_tokens, a.remaining, a.fits_one_more_turn], [40_000, 0, 0, 20_000, false]);
  assert.equal(state(db).state, 'limit_reached');
  const counts = () => ['invocation_receipts', 'assistant_turns', 'execution_domains', 'process_ownership'].map((x) => db.prepare(`SELECT COUNT(*) AS n FROM ${x}`).get().n);
  const before = counts();
  assert.throws(
    () => admit(db),
    (e) =>
      e.code === 'assistant_limit_reached' &&
      e.status === 429 &&
      e.subject.reserved === 40_000 &&
      e.subject.day_limit === 60_000 &&
      e.subject.turn_limit === 40_000 &&
      typeof e.subject.resets_at === 'string',
  );
  assert.deepEqual(counts(), before, 'a refused admission writes no receipt, turn, domain or ownership');
  // The intent names at most one turn: a replay is refused.
  assert.throws(() => transact(db, HUMAN, (tx) => A.admitTurn(tx, { conversation: claim.conversation, intent_id: 'i1', credential: OK, incarnation: 'inc_1', scope: null })), (e) => e.code === 'assistant_intent_conflict');
  // The turn's end releases the reservation and charges its one row.
  launched(db, claim);
  usage(db, claim.invocation, claude(1_000, 200, { usage_final: true, total_cost_usd_estimate: 0.004 }));
  end(db, claim.invocation, 'completed', 'none', { reply: { text: 'ok', cited_evidence: [], links: [] } });
  a = account(db);
  assert.deepEqual([a.reserved, a.used_known, a.unknown_allowance_tokens, a.turns_charged, a.remaining, a.fits_one_more_turn], [0, 1_200, 0, 1, 58_800, true]);
  assert.equal(state(db).state, 'ready');
});

test('concurrency: at most two turns under way, one per conversation, and the state codes refuse in the transaction', (t) => {
  const db = store(t);
  assert.throws(() => admit(db), (e) => e.code === 'assistant_qualification_pending' && e.status === 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invocation_receipts').get().n, 0);
  entry(db);
  assert.throws(() => admit(db, { credential: { manifest_ok: true, loaded: false } }), (e) => e.code === 'assistant_credential_missing');
  admit(db, { conversation: 'ac_x' });
  assert.throws(() => admit(db, { conversation: 'ac_x', intent_id: 'i2' }), (e) => e.code === 'assistant_busy');
  admit(db);
  assert.throws(() => admit(db), (e) => e.code === 'assistant_limit' && e.status === 429);
  settings(null);
  assert.throws(() => admit(db), (e) => e.code === 'assistant_not_configured' && e.status === 503);
});

test('reported, estimated and unknown kept apart; incomplete usage charged the turn limit less what was observed; a provider zero is unknown; a refusal before launch charges nothing; never a duplicate charge', (t) => {
  const db = store(t);
  entry(db);
  // Reported (the scripted normalization: a cost the provider stated).
  const r = admit(db);
  launched(db, r);
  usage(db, r.invocation, claude(100, 10, { usage_final: true, total_cost_usd: 0.25 }));
  end(db, r.invocation, 'completed', 'none');
  // Stopped at its limit with 1,000 observed: unknown allowance 39,000.
  const s = admit(db);
  launched(db, s);
  usage(db, s.invocation, { input_tokens: 1_000, cache_creation_input_tokens: 0 });
  end(db, s.invocation, 'stopped', 'assistant_turn_limit');
  let rows = rowsOf(db, s.invocation);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].account, rows[0].role, rows[0].project, rows[0].run, rows[0].usage_complete, rows[0].unknown_allowance_tokens, rows[0].cost_status], ['workspace_assistant', 'workspace_assistant', null, null, 0, 39_000, 'unknown']);
  // A provider's own zero on a real turn: unknown, the report kept.
  const z = admit(db);
  launched(db, z);
  usage(db, z.invocation, claude(0, 0, { usage_final: true, total_cost_usd: 0 }));
  end(db, z.invocation, 'completed', 'none');
  rows = rowsOf(db, z.invocation);
  assert.deepEqual([rows[0].cost_status, rows[0].cost_usd], ['unknown', null]);
  assert.match(rows[0].normalization_version, /assistant-reported-zero-is-unknown/);
  assert.equal(JSON.parse(rows[0].raw_usage).total_cost_usd, 0);
  // Refused before its launch: no row, the reservation released.
  const q = admit(db);
  transact(db, ENGINE_ACTOR, (tx) => A.turnDispatched(tx, { invocation: q.invocation }));
  end(db, q.invocation, 'refused', 'backend_refused');
  assert.equal(rowsOf(db, q.invocation).length, 0);
  assert.ok(db.prepare(`SELECT 1 FROM invocation_status_observations WHERE invocation = ? AND status = 'refused' AND account = 'workspace_assistant'`).get(q.invocation));
  // Never a duplicate charge: the end again, and the row again.
  assert.deepEqual(end(db, s.invocation, 'stopped', 'assistant_turn_limit'), { ended: false });
  assert.equal(rowsOf(db, s.invocation).length, 1);
  const a = account(db);
  assert.equal(a.reported_usd, 0.25);
  assert.equal(a.estimated_usd, 0);
  assert.equal(a.unknown_cost_turns, 2);
  assert.equal(a.used_known, 110 + 1_000 + 0);
  assert.equal(a.unknown_allowance_tokens, 39_000);
  assert.equal(a.reserved, 0);
  assert.equal(a.turns_charged, 3);
  // The turn as the service reads it.
  const read = A.turnOf(db, { invocation: s.invocation });
  assert.deepEqual([read.status, read.outcome, read.reason, read.usage.cost_status, read.usage.unknown_allowance_tokens], ['ended', 'stopped', 'assistant_turn_limit', 'unknown', 39_000]);
});

test('the in-flight check: the turn limit passed by what is known, and an unknown count never read as zero', (t) => {
  const db = store(t);
  entry(db);
  const c = admit(db);
  launched(db, c);
  usage(db, c.invocation, { input_tokens: 30_000, cache_creation_input_tokens: 0 }, 'delta');
  assert.equal(A.turnLimitCheck(db, { invocation: c.invocation }), 'assistant_usage_unknown', 'output unknown mid-turn: the turn cannot be judged');
  assert.equal(A.turnLimitCheck(db, { invocation: c.invocation, terminal: true }), null);
  usage(db, c.invocation, { output_tokens: 10_001 }, 'delta');
  assert.equal(A.turnLimitCheck(db, { invocation: c.invocation }), 'assistant_turn_limit');
});

test('day rollover at 00:00Z: charged turns stay on their day; a turn under way keeps its reservation on the current day', (t) => {
  assert.equal(configureHarness(true, []), null);
  t.after(() => configureHarness(false, []));
  const clock = new BigInt64Array(seamWorkerData().clock);
  t.after(() => Atomics.store(clock, 0, 0n));
  const db = store(t);
  entry(db);
  const c = admit(db);
  launched(db, c);
  usage(db, c.invocation, claude(500, 500, { usage_final: true }));
  end(db, c.invocation, 'completed', 'none');
  const u = admit(db);
  const today = account(db);
  assert.deepEqual([today.used_known, today.reserved, today.turns_charged], [1_000, 40_000, 1]);
  // To the next UTC day.
  const next = Date.parse(today.resets_at);
  Atomics.store(clock, 0, BigInt(next - Date.now() + 1_000));
  const tomorrow = account(db);
  assert.equal(tomorrow.day, today.resets_at.slice(0, 10));
  assert.equal(tomorrow.resets_at, new Date(next + 86_400_000).toISOString());
  assert.deepEqual([tomorrow.used_known, tomorrow.turns_charged, tomorrow.reserved], [0, 0, 40_000], "yesterday's row stays on yesterday; the turn under way holds today");
  launched(db, u);
  end(db, u.invocation, 'recovered', 'recovered');
  const after = account(db);
  assert.deepEqual([after.reserved, after.unknown_allowance_tokens, after.turns_charged], [0, 40_000, 1], 'charged on the day its row is written');
});

test("assistant rows never change any project's ledger read, day budget or exhausted limits, and project rows never change the assistant's day", (t) => {
  const db = store(t);
  entry(db);
  const project = () => {
    const v = ledgerView(db, { project: 'prj_1', day: null });
    return { rows: v.rows, totals: v.totals, by_role: v.by_role, budget: v.budget, budget_day: v.budget_day, exhausted: exhaustedLimits(db, 'prj_1', { check: false, dispatch: true }) };
  };
  const before = project();
  const c = admit(db);
  launched(db, c);
  usage(db, c.invocation, { input_tokens: 2_000, cache_creation_input_tokens: 0 });
  assert.deepEqual(project(), before, 'a turn under way changes no project read');
  end(db, c.invocation, 'stopped', 'assistant_turn_limit');
  assert.deepEqual(project(), before, 'a charged assistant row changes no project read');
  const mine = account(db);
  // A project row, charged today with an allowance.
  db.pragma('foreign_keys = OFF');
  db.prepare(
    `INSERT INTO ledger_rows (id, created_at, project, invocation, run, turn, role, provider, model_requested, raw_usage, normalization_version, billable_in, out, usage_complete, cost_status, cost_usd, day_utc, unknown_allowance_tokens)
     VALUES ('led_p', ?, 'prj_1', 'inv_p', 'run_p', NULL, 'builder', 'claude', 'm', '{}', 'n', 5000, 5000, 0, 'unknown', NULL, ?, 100000)`,
  ).run(nowIso(), nowIso().slice(0, 10));
  db.pragma('foreign_keys = ON');
  assert.deepEqual(account(db), mine, "a project row changes nothing of the assistant's day");
  assert.notDeepEqual(project(), before, 'and does change its project');
});

// The kill and restart mid-turn: a child process admits a turn, records its
// usage and is killed (SIGKILL, by its own pid) while holding the store; the
// restarted store counts the reservation once, and recovery converts it into
// exactly one row.
test('a kill and restart mid-turn: the reservation is neither lost nor counted twice, and recovery converts it once', async (t) => {
  const dir = scratch(t);
  const path = join(dir, 'store.db');
  settings();
  const db0 = openStore(path);
  entry(db0);
  db0.close();
  const script = join(dir, 'child.mjs');
  writeFileSync(
    script,
    `import Database from ${JSON.stringify(join(root, '..', '..', 'node_modules', 'better-sqlite3', 'lib', 'index.js'))};
const { migrate } = await import(${JSON.stringify(join(dist, 'store', 'migrate.js'))});
const { transact, ENGINE_ACTOR } = await import(${JSON.stringify(join(dist, 'store', 'transitions', 'tx.js'))});
const { setEngineSettings } = await import(${JSON.stringify(join(dist, 'store', 'transitions', 'settings.js'))});
const A = await import(${JSON.stringify(join(dist, 'store', 'transitions', 'assistant.js'))});
setEngineSettings(${JSON.stringify({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1', workspace_assistant: BLOCK })});
const db = new Database(${JSON.stringify(path)});
db.pragma('foreign_keys = ON');
migrate(db, ${JSON.stringify(join(root, 'migrations'))});
const c = transact(db, { actor_kind: 'human', actor_id: null, request_id: null }, (tx) => A.admitTurn(tx, { conversation: 'ac_kill', intent_id: 'i1', credential: { manifest_ok: true, loaded: true }, incarnation: 'inc_1', scope: null }));
transact(db, ENGINE_ACTOR, (tx) => A.turnDispatched(tx, { invocation: c.invocation }));
transact(db, ENGINE_ACTOR, (tx) => A.turnLaunched(tx, { invocation: c.invocation, domain: c.domain, pid: process.pid, pgid: process.pid, startTime: null }));
transact(db, ENGINE_ACTOR, (tx) => A.recordTurnUsage(tx, { invocation: c.invocation, semantics: 'cumulative', raw: { input_tokens: 7000, cache_creation_input_tokens: 0 } }));
db.exec('BEGIN IMMEDIATE');
process.stdout.write(JSON.stringify(c) + '\\n');
setInterval(() => {}, 1000);
`,
  );
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const claim = await new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', (b) => {
      text += b;
      if (text.includes('\n')) resolve(JSON.parse(text.split('\n')[0]));
    });
    child.on('exit', (code) => reject(new Error(`the child exited ${code} before admitting`)));
  });
  // Our own child, by its own pid (never by pattern).
  assert.match(readFileSync(`/proc/${child.pid}/cmdline`, 'utf8'), /child\.mjs/);
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  const db = openStore(path, { fresh: false });
  t.after(() => db.open && db.close());
  let a = account(db);
  assert.deepEqual([a.turns_under_way, a.reserved, a.used_known, a.unknown_allowance_tokens], [1, 33_000, 7_000, 0], 'held once: its limit less what it observed, beside what it observed');
  assert.deepEqual(A.unendedTurns(db).map((x) => x.invocation), [claim.invocation]);
  // Recovery ends it `recovered` (its domain's termination established
  // first, by the engine): exactly one row, charged the turn limit.
  end(db, claim.invocation, 'recovered', 'recovered');
  end(db, claim.invocation, 'recovered', 'recovered');
  const rows = rowsOf(db, claim.invocation);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].billable_in, rows[0].unknown_allowance_tokens, rows[0].usage_complete], [7_000, 33_000, 0]);
  a = account(db);
  assert.deepEqual([a.turns_under_way, a.reserved, a.used_known, a.unknown_allowance_tokens], [0, 0, 7_000, 33_000], 'converted once: the same 40,000, now charged');
  assert.ok(db.prepare(`SELECT 1 FROM invocation_status_observations WHERE invocation = ? AND status = 'unknown'`).get(claim.invocation), 'its end is an explicit unknown');
  assert.equal(A.turnOf(db, { invocation: claim.invocation }).outcome, 'recovered');
});
