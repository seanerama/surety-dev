// Developer tests for migration 0039 (the workspace assistant's usage
// account; the assistant design's O4(a) as Sean approved it on 2026-10-27):
// on a store that already holds rows in the six rebuilt tables, every row
// and its attribution survive byte for byte (each column compared as SQLite
// quotes it, so its type and bytes both), each gets the account 'project',
// and nothing is lost or added; then the store itself refuses what the
// account rule forbids: a project row without its project (or run, or
// grant), an assistant row with any of them, an assistant ledger row in a
// project role, a row of one account against a receipt of the other, a
// second original row for one invocation.

import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { ledgerView } = await import(join(dist, 'store', 'transitions', 'ledger.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));

const TABLES = ['invocation_receipts', 'invocation_status_observations', 'usage_observations', 'execution_domains', 'ledger_rows', 'process_ownership'];
const AT = '2026-10-27T10:00:00.000Z';

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-acct-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The engine's migrations up to and including `last`.
function migrationsUpTo(dir, last) {
  const out = join(dir, 'migrations');
  mkdirSync(out);
  for (const name of readdirSync(join(root, 'migrations'))) {
    const m = /^(\d{4})_/.exec(name);
    if (m && Number(m[1]) <= last) copyFileSync(join(root, 'migrations', name), join(out, name));
  }
  return out;
}

// A store of 0038 with rows in every rebuilt table: one-shot and session
// receipts, observations with and without exit classes, cumulative and delta
// usage, a role domain and a check domain, an original ledger row and its
// correction (REAL, INTEGER, NULL and TEXT values), and both kinds of process
// ownership.
function seed(db) {
  db.pragma('foreign_keys = OFF');
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  run(`INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management) VALUES ('prj_A', ?, 'a', 'T1', '/r/a', 'main', 'spec_ready', 'registered', '{}')`, AT);
  run(`INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management) VALUES ('prj_B', ?, 'b', 'T2', '/r/b', 'main', 'spec_ready', 'registered', '{}')`, AT);
  run(`INSERT INTO engine_incarnations (id, created_at, pid, started_at, host_boot_id) VALUES ('inc_1', ?, 7, ?, 'boot')`, AT, AT);
  // What the rows below refer to: a qualification attempt and its entry; a
  // check execution with its version, check, lineage and candidate.
  run(
    `INSERT INTO qualification_attempts (id, created_at, backend, version, binary_path, binary_sha256, help_sha256, template, template_version, model, auth_mode, profile_fingerprint, candidate_egress, canary_deadlines, spend, status)
     VALUES ('qa_1', ?, 'claude', '2.1.288', '/b', 'x', 'y', 't', 'claude-one-shot-2', 'claude-sonnet-5-5', 'api_key', 'p', '[]', '{}', '{}', 'succeeded')`,
    AT,
  );
  run(
    `INSERT INTO trust_entries (id, created_at, backend, version, binary_path, binary_sha256, help_sha256, mode, template, template_version, model, auth_mode, capabilities, host_id,
       isolation, boundary, profile_fingerprint, egress_hosts, usage_granularity, cost_reporting, enforceable_boundaries, result_channel, session_qualified, provider_files, qualification_attempt, evidence, evidence_fingerprint, status)
     VALUES ('trust_1', ?, 'claude', '2.1.288', '/b', 'x', 'y', 'one_shot_headless', 't', 'claude-one-shot-2', 'claude-sonnet-5-5', 'api_key', '{}', 'h', 'linux-namespaces-1', 'cgroup2-delegated-scope-1', 'p', '[]', 'invocation', 'reported', '[]', 'file', 0, '{}', 'qa_1', '[]', 'f', 'proposed')`,
    AT,
  );
  run(`INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, roots) VALUES ('pv_1', ?, 'prj_A', 1, 'fp', 'initial', 'engine', 'human', ?, 1, '[]')`, AT, AT);
  run(`INSERT INTO lineages (id, created_at, project, branch, open) VALUES ('lin_1', ?, 'prj_A', 'main', 1)`, AT);
  run(`INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress) VALUES ('cand_1', ?, 'prj_A', 1, 'abc', 'lin_1', ?, 'engine_cadence', 'developing')`, AT, AT);
  run(`INSERT INTO checks (id, created_at, project, key, protected_version, kind, required, gate_kinds, definition_path, definition_hash, runner_class) VALUES ('chk_1', ?, 'prj_A', 'unit', 'pv_1', 'acceptance', 1, '[]', 'p', 'h', 'direct')`, AT);
  run(
    `INSERT INTO check_executions (id, created_at, project, "check", key, candidate, source_revision, protected_version, runner_class, execution_seq, "trigger", trigger_key, status, registered_at)
     VALUES ('cx_1', ?, 'prj_A', 'chk_1', 'unit', 'cand_1', 'abc', 'pv_1', 'direct', 1, 'gate', 'g1', 'interrupted', ?)`,
    AT,
    AT,
  );
  run(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
     VALUES ('wi_1', ?, 'prj_A', 1, 'verification', '{}', 'executing', 'test', 't1', 1, 0, 0, 0, 0)`,
    AT,
  );
  run(
    `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined)
     VALUES ('run_1', ?, 'prj_A', 1, 'wi_1', 'builder', 'one_shot', 'ended', 'claude', '2.1.288', 'claude-sonnet-5-5', 'abc', ?, 0)`,
    AT,
    AT,
  );
  run(
    `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined)
     VALUES ('run_2', ?, 'prj_B', 1, NULL, 'vision', 'session', 'executing', 'scripted', 's1', 'scripted', 'def', ?, 0)`,
    AT,
    AT,
  );
  run(`INSERT INTO capability_grants (id, created_at, project, run, capabilities, env_allowlist, issued_at, expires_at) VALUES ('grant_1', ?, 'prj_A', 'run_1', '[]', '[]', ?, ?)`, AT, AT, AT);
  run(`INSERT INTO capability_grants (id, created_at, project, run, capabilities, env_allowlist, issued_at, expires_at) VALUES ('grant_2', ?, 'prj_B', 'run_2', '[]', '[]', ?, ?)`, AT, AT, AT);
  run(`INSERT INTO turns (id, created_at, project, run, number, invocation, domain, started_at) VALUES ('turn_1', ?, 'prj_B', 'run_2', 1, 'inv_2', 'dom_2', ?)`, AT, AT);
  run(
    `INSERT INTO invocation_receipts (id, created_at, project, run, turn, provider, model_requested, "grant", budget_snapshot, trust_entry, qualification_attempt, provider_session_id, deadline_at)
     VALUES ('inv_1', ?, 'prj_A', 'run_1', NULL, 'claude', 'claude-sonnet-5-5', 'grant_1', '{"budget_run_billable_tokens":1500000}', 'trust_1', NULL, 'sess-1', ?)`,
    AT,
    AT,
  );
  run(
    `INSERT INTO invocation_receipts (id, created_at, project, run, turn, provider, model_requested, "grant", budget_snapshot, trust_entry, qualification_attempt, provider_session_id, deadline_at)
     VALUES ('inv_2', ?, 'prj_B', 'run_2', 'turn_1', 'scripted', 'scripted', 'grant_2', '{}', NULL, 'qa_1', NULL, NULL)`,
    AT,
  );
  for (const [id, inv, seq, status, exitClass] of [
    ['iso_1', 'inv_1', 1, 'dispatch_started', null],
    ['iso_2', 'inv_1', 2, 'launched', null],
    ['iso_3', 'inv_1', 3, 'ended', 'clean'],
    ['iso_4', 'inv_2', 1, 'unknown', 'unknown'],
  ]) {
    run(
      `INSERT INTO invocation_status_observations (id, created_at, project, invocation, seq, status, at, exit_class, exit_evidence, incarnation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      AT,
      inv === 'inv_1' ? 'prj_A' : 'prj_B',
      inv,
      seq,
      status,
      AT,
      exitClass,
      exitClass === null ? null : '{"status":0}',
      seq === 1 ? 'inc_1' : null,
    );
  }
  run(`INSERT INTO usage_observations (id, created_at, project, invocation, seq, semantics, raw, at) VALUES ('uo_1', ?, 'prj_A', 'inv_1', 1, 'delta', '{"input_tokens":12}', ?)`, AT, AT);
  run(`INSERT INTO usage_observations (id, created_at, project, invocation, seq, semantics, raw, at) VALUES ('uo_2', ?, 'prj_A', 'inv_1', 2, 'cumulative', '{"output_tokens":3,"usage_final":true}', ?)`, AT, AT);
  run(
    `INSERT INTO execution_domains (id, created_at, project, run, invocation, status, profile, cgroup_path, launch_state, launch_binding, exit_class, memory_max, memory_peak, peak_recorded_at)
     VALUES ('dom_1', ?, 'prj_A', 'run_1', 'inv_1', 'terminated', 'role', '/sys/fs/cgroup/x/dom_1', 'closed', '{"invocation":"inv_1"}', 'clean', 8589934592, 123456, ?)`,
    AT,
    AT,
  );
  run(`INSERT INTO execution_domains (id, created_at, project, run, invocation, status, profile, launch_state) VALUES ('dom_2', ?, 'prj_B', 'run_2', 'inv_2', 'allocated', 'role', 'authorizable')`, AT);
  run(`INSERT INTO execution_domains (id, created_at, project, run, invocation, status, profile, check_execution, launch_state) VALUES ('dom_3', ?, 'prj_A', NULL, NULL, 'quarantined', 'check', 'cx_1', 'closed')`, AT);
  run(
    `INSERT INTO ledger_rows (id, created_at, project, invocation, run, turn, role, provider, model_requested, model_observed, raw_usage, normalization_version,
       billable_in, cached_in, out, usage_complete, cost_status, cost_usd, day_utc, corrects, correction_seq, unknown_allowance_tokens)
     VALUES ('led_1', ?, 'prj_A', 'inv_1', 'run_1', NULL, 'builder', 'claude', 'claude-sonnet-5-5', 'claude-sonnet-5-5', '{"input_tokens":12}', 'claude-stream-json-1', 12, NULL, 3, 0, 'estimated', 0.123456789, '2026-10-27', NULL, NULL, 1499985)`,
    AT,
  );
  run(
    `INSERT INTO ledger_rows (id, created_at, project, invocation, run, turn, role, provider, model_requested, model_observed, raw_usage, normalization_version,
       billable_in, cached_in, out, usage_complete, cost_status, cost_usd, day_utc, corrects, correction_seq, unknown_allowance_tokens)
     VALUES ('led_2', ?, 'prj_A', 'inv_1', 'run_1', NULL, 'builder', 'claude', 'claude-sonnet-5-5', NULL, '{"cost_usd":0.5}', 'scripted-1', NULL, NULL, NULL, 1, 'reported', 0.5, '2026-10-27', 'led_1', 1, NULL)`,
    AT,
  );
  run(
    `INSERT INTO ledger_rows (id, created_at, project, invocation, run, turn, role, provider, model_requested, model_observed, raw_usage, normalization_version,
       billable_in, cached_in, out, usage_complete, cost_status, cost_usd, day_utc, corrects, correction_seq, unknown_allowance_tokens)
     VALUES ('led_3', ?, 'prj_B', 'inv_2', 'run_2', 'turn_1', 'vision', 'scripted', 'scripted', NULL, '{}', 'scripted-1', NULL, NULL, NULL, 0, 'unknown', NULL, '2026-10-26', NULL, NULL, NULL)`,
    AT,
  );
  run(`INSERT INTO process_ownership (id, created_at, project, domain, invocation, incarnation, pgid, pid, pid_start_time, descendants) VALUES ('proc_1', ?, 'prj_A', 'dom_1', 'inv_1', 'inc_1', 41, 41, '12345', '[]')`, AT);
  run(`INSERT INTO process_ownership (id, created_at, project, domain, invocation, incarnation, check_execution, termination_confirmed_at) VALUES ('proc_3', ?, 'prj_A', 'dom_3', NULL, 'inc_1', 'cx_1', ?)`, AT, AT);
  db.pragma('foreign_keys = ON');
}

// Every column of every row, as SQLite quotes it (type and bytes), by id.
function snapshot(db, columns) {
  const out = {};
  for (const t of TABLES) {
    const cols = columns[t];
    out[t] = db.prepare(`SELECT ${cols.map((c) => `quote("${c}") AS "${c}"`).join(', ')} FROM "${t}" ORDER BY "id"`).all();
  }
  return out;
}

const storedColumns = (db) => Object.fromEntries(TABLES.map((t) => [t, db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name)]));

test('migration 0039 keeps every existing row of the six tables and its attribution byte for byte, each now the project account', (t) => {
  const dir = scratch(t);
  const path = join(dir, 'store.db');
  const before = new Database(path);
  migrate(before, migrationsUpTo(dir, 38));
  seed(before);
  const columns = storedColumns(before);
  for (const t of TABLES) assert.ok(!columns[t].includes('account'), `${t} has no account before 0039`);
  const was = snapshot(before, columns);
  const counts = Object.fromEntries(TABLES.map((t) => [t, before.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n]));
  before.close();

  const db = new Database(path);
  t.after(() => db.open && db.close());
  db.pragma('foreign_keys = ON');
  const { applied } = migrate(db, join(root, 'migrations'));
  assert.ok(applied.includes('0039_the_workspace_assistant_account.sql'), `0039 applied (${applied.join(', ')})`);
  assert.deepEqual(snapshot(db, columns), was, 'every column of every row, as SQLite quotes it, unchanged');
  for (const t of TABLES) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n, counts[t], `${t}: no row lost or added`);
    assert.deepEqual(
      db.prepare(`SELECT DISTINCT "account" FROM "${t}"`).all().map((r) => r.account),
      [t === 'invocation_receipts' || counts[t] > 0 ? 'project' : null].filter((x) => x !== null),
      `${t}: every existing row is the project account`,
    );
  }
  assert.deepEqual(db.pragma('foreign_key_check'), [], 'no broken foreign key');
  // The generated `state` of a domain is still its status.
  assert.equal(db.prepare(`SELECT "state" FROM "execution_domains" WHERE "id" = 'dom_1'`).get().state, 'terminated');
  // The indexes and triggers of the rebuilt tables are there again.
  const names = new Set(db.prepare(`SELECT "name" FROM sqlite_master WHERE "type" IN ('index', 'trigger')`).all().map((r) => r.name));
  for (const n of [
    'invocation_receipts_one_per_one_shot_run',
    'invocation_receipts_one_per_turn',
    'invocation_receipts_no_update',
    'invocation_receipts_no_delete',
    'invocation_receipts_session_id_fixed',
    'invocation_receipts_turn_matches_run',
    'invocation_status_observations_no_update',
    'invocation_status_observations_no_delete',
    'usage_observations_no_update',
    'usage_observations_no_delete',
    'execution_domains_by_run',
    'execution_domains_by_check_execution',
    'execution_domains_by_attempt',
    'execution_domains_launch_state',
    'execution_domains_terminated_needs_closure',
    'execution_domains_terminated_final',
    'execution_domains_attempt_fixed',
    'execution_domains_supervision_lost_once',
    'ledger_rows_one_original_per_invocation',
    'ledger_rows_by_project',
    'ledger_rows_no_update',
    'ledger_rows_no_delete',
  ]) {
    assert.ok(names.has(n), `${n} is made again`);
  }
  // Append-only still holds.
  assert.throws(() => db.prepare(`UPDATE "ledger_rows" SET "cost_usd" = 1 WHERE "id" = 'led_1'`).run(), /append-only/);
  assert.throws(() => db.prepare(`DELETE FROM "invocation_receipts" WHERE "id" = 'inv_1'`).run(), /append-only/);
});

test('the store refuses what the account rule forbids, for both accounts', (t) => {
  const dir = scratch(t);
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.open && db.close());
  migrate(db, migrationsUpTo(dir, 38));
  seed(db);
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = ON');
  const ok = (sql, ...args) => db.prepare(sql).run(...args);
  const refused = (what, sql, ...args) => assert.throws(() => db.prepare(sql).run(...args), /constraint|account|NOT NULL|UNIQUE/i, what);
  db.prepare(`INSERT INTO trust_entries (id, created_at, backend, version, binary_path, binary_sha256, help_sha256, mode, template, template_version, model, auth_mode, capabilities, host_id,
    isolation, boundary, profile_fingerprint, egress_hosts, usage_granularity, cost_reporting, enforceable_boundaries, result_channel, session_qualified, provider_files, qualification_attempt, evidence, evidence_fingerprint, status)
    VALUES ('trust_A', ?, 'claude', '1', '/b', 'x', 'y', 'one_shot_headless', 't', 'claude-assistant-1', 'claude-sonnet-5-5', 'subscription_token', '{}', 'h', 'linux-namespaces-1', 'cgroup2-delegated-scope-1', 'p', '[]', 'invocation', 'reported', '[]', 'file', 0, '{}', 'qa_1', '[]', 'f', 'proposed')`).run(AT);

  // Receipts.
  const receipt = `INSERT INTO invocation_receipts (id, created_at, project, run, turn, provider, model_requested, "grant", budget_snapshot, trust_entry, qualification_attempt, deadline_at, account) VALUES (?, ?, ?, ?, NULL, 'claude', 'claude-sonnet-5-5', ?, '{}', 'trust_A', ?, ?, ?)`;
  refused('an assistant receipt naming a project', receipt, 'inv_x1', AT, 'prj_A', null, null, null, AT, 'workspace_assistant');
  refused('an assistant receipt naming a grant', receipt, 'inv_x2', AT, null, null, 'grant_1', null, AT, 'workspace_assistant');
  refused('an assistant receipt naming a qualification attempt', receipt, 'inv_x3', AT, null, null, null, 'qa_1', AT, 'workspace_assistant');
  refused('a project receipt without a project', receipt, 'inv_x4', AT, null, 'run_1', 'grant_1', null, AT, 'project');
  refused('a project receipt without a grant', receipt, 'inv_x5', AT, 'prj_A', 'run_1', null, null, AT, 'project');
  refused('an account that is not one of the two', receipt, 'inv_x6', AT, null, null, null, null, AT, 'someone_else');
  ok(receipt, 'inv_A', AT, null, null, null, null, AT, 'workspace_assistant');
  ok(receipt, 'inv_A2', AT, null, null, null, null, AT, 'workspace_assistant');

  // Observations.
  const status = `INSERT INTO invocation_status_observations (id, created_at, project, invocation, seq, status, at, account) VALUES (?, ?, ?, ?, 1, 'dispatch_started', ?, ?)`;
  refused('an assistant observation naming a project', status, 'iso_x1', AT, 'prj_A', 'inv_A', AT, 'workspace_assistant');
  refused('a project observation of an assistant receipt', status, 'iso_x2', AT, 'prj_A', 'inv_A', AT, 'project');
  refused('an assistant observation of a project receipt', status, 'iso_x3', AT, null, 'inv_1', AT, 'workspace_assistant');
  ok(status, 'iso_A', AT, null, 'inv_A', AT, 'workspace_assistant');
  const usage = `INSERT INTO usage_observations (id, created_at, project, invocation, seq, semantics, raw, at, account) VALUES (?, ?, ?, ?, 1, 'delta', '{}', ?, ?)`;
  refused('assistant usage naming a project', usage, 'uo_x1', AT, 'prj_A', 'inv_A', AT, 'workspace_assistant');
  refused('project usage of an assistant receipt', usage, 'uo_x2', AT, 'prj_A', 'inv_A', AT, 'project');
  ok(usage, 'uo_A', AT, null, 'inv_A', AT, 'workspace_assistant');

  // Domains and ownership.
  const domain = `INSERT INTO execution_domains (id, created_at, project, run, invocation, status, profile, account) VALUES (?, ?, ?, ?, ?, 'allocated', ?, ?)`;
  refused('an assistant domain with a run', domain, 'dom_x1', AT, null, 'run_1', 'inv_A', 'role', 'workspace_assistant');
  refused('an assistant domain in the probe profile', domain, 'dom_x2', AT, null, null, 'inv_A', 'probe', 'workspace_assistant');
  refused('an assistant domain of a project receipt', domain, 'dom_x3', AT, null, null, 'inv_1', 'role', 'workspace_assistant');
  refused('a project domain without its run', domain, 'dom_x4', AT, 'prj_A', null, 'inv_1', 'role', 'project');
  ok(domain, 'dom_A', AT, null, null, 'inv_A', 'role', 'workspace_assistant');
  const owner = `INSERT INTO process_ownership (id, created_at, project, domain, invocation, incarnation, account) VALUES (?, ?, ?, ?, ?, 'inc_1', ?)`;
  refused('an assistant ownership naming a project', owner, 'proc_x1', AT, 'prj_A', 'dom_A', 'inv_A', 'workspace_assistant');
  refused('a project ownership of an assistant domain', owner, 'proc_x2', AT, 'prj_A', 'dom_A', 'inv_A', 'project');
  ok(owner, 'proc_A', AT, null, 'dom_A', 'inv_A', 'workspace_assistant');

  // Ledger rows.
  const row = `INSERT INTO ledger_rows (id, created_at, project, invocation, run, turn, role, provider, model_requested, raw_usage, normalization_version, usage_complete, cost_status, day_utc, corrects, correction_seq, account)
    VALUES (?, ?, ?, ?, ?, NULL, ?, 'claude', 'claude-sonnet-5-5', '{}', 'n', 0, 'unknown', '2026-10-27', ?, ?, ?)`;
  refused('an assistant row in a project role', row, 'led_x1', AT, null, 'inv_A', null, 'builder', null, null, 'workspace_assistant');
  refused('a project row in the assistant role', row, 'led_x2', AT, 'prj_A', 'inv_1', 'run_1', 'workspace_assistant', null, 5, 'project');
  refused('an assistant row naming a project', row, 'led_x3', AT, 'prj_A', 'inv_A', null, 'workspace_assistant', null, null, 'workspace_assistant');
  refused('a project row of an assistant receipt', row, 'led_x4', AT, 'prj_A', 'inv_A', 'run_1', 'builder', null, null, 'project');
  refused('an assistant row of a project receipt', row, 'led_x5', AT, null, 'inv_1', null, 'workspace_assistant', null, 7, 'workspace_assistant');
  ok(row, 'led_A', AT, null, 'inv_A', null, 'workspace_assistant', null, null, 'workspace_assistant');
  refused('a second original row of one assistant invocation', row, 'led_x6', AT, null, 'inv_A', null, 'workspace_assistant', null, null, 'workspace_assistant');
  ok(row, 'led_A_c1', AT, null, 'inv_A', null, 'workspace_assistant', 'led_A', 1, 'workspace_assistant');
  refused('a second original row of one project invocation', row, 'led_x7', AT, 'prj_A', 'inv_1', 'run_1', 'builder', null, null, 'project');
  assert.deepEqual(db.pragma('foreign_key_check'), [], 'no broken foreign key');
});

test("assistant rows change no project's ledger read, and project rows were never the assistant's", (t) => {
  const dir = scratch(t);
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.open && db.close());
  migrate(db, migrationsUpTo(dir, 38));
  seed(db);
  migrate(db, join(root, 'migrations'));
  setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });
  const read = (project) => {
    const v = ledgerView(db, { project, day: null });
    return { rows: v.rows, totals: v.totals, by_role: v.by_role };
  };
  const a = read('prj_A');
  const b = read('prj_B');
  db.prepare(
    `INSERT INTO invocation_receipts (id, created_at, project, run, turn, provider, model_requested, "grant", budget_snapshot, account) VALUES ('inv_A', ?, NULL, NULL, NULL, 'scripted', 'scripted', NULL, '{}', 'workspace_assistant')`,
  ).run(AT);
  db.prepare(
    `INSERT INTO ledger_rows (id, created_at, project, invocation, run, turn, role, provider, model_requested, raw_usage, normalization_version, billable_in, out, usage_complete, cost_status, cost_usd, day_utc, unknown_allowance_tokens, account)
     VALUES ('led_A', ?, NULL, 'inv_A', NULL, NULL, 'workspace_assistant', 'scripted', 'scripted', '{}', 'n', 900, 100, 0, 'unknown', NULL, '2026-10-27', 39000, 'workspace_assistant')`,
  ).run(AT);
  assert.deepEqual(read('prj_A'), a, "project A's ledger read is unchanged by an assistant row");
  assert.deepEqual(read('prj_B'), b, "project B's ledger read is unchanged by an assistant row");
});
