#!/usr/bin/env node
// Witness engine for the harness self-check. NOT the engine, not a design for
// it and not a contract: the contract is the acceptance tests and SEAM.md.
//
// It exists for the reason witness-schema.sql does. The slice-2 acceptance
// tests were written before the engine they test, so running them could not
// show they are right. This single-file stand-in does what SEAM.md §§12–18
// ask (with the amendments of §22, made after the slice-2 review), as plainly
// as it can, so that the self-check can show two things:
//   - the tests are satisfiable: every one of them passes against something;
//   - the tests bite: with one defect switched on (WITNESS_MUTANT), the test
//     meant to catch that defect fails.
//
// What it is not: it keeps its store on the main thread, holds no transaction
// discipline worth copying, journals nothing it could recover, and takes its
// legal work transitions from the Verifier's own contract table, so it proves
// nothing about that table. The Builder builds from the sources, not from this.
//
// A run of the acceptance files against it is never an acceptance run: the
// harness adds a failing test to every file when SURETY_WITNESS_ENGINE is set
// (../engine.mjs).

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { newId } from '../ids.mjs';
import { WORK, isLegal, m1Kinds } from '../transitions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACT = JSON.parse(readFileSync(join(here, '..', '..', 'contract', 'config.json'), 'utf8'));
const ENGINE_MIGRATIONS = join(here, '..', '..', '..', '..', 'migrations');

const MUTANT = process.env.WITNESS_MUTANT ?? '';
const mutant = (name) => MUTANT === name;

// ---- command line and configuration ---------------------------------------------

const usage = (message) => {
  process.stderr.write(`witness engine: ${message}\n`);
  process.exit(2);
};
const refuseStart = (status, code, reason, subject) => {
  process.stderr.write(`${JSON.stringify({ code, reason, what_to_do: 'See SEAM.md.', subject })}\n`);
  process.exit(status);
};

const [command, ...flags] = process.argv.slice(2);
if (command !== 'serve') usage('only serve is implemented');
const opt = { harness: false, migrations: null, scripted: null, barriers: new Map() };
for (let i = 0; i < flags.length; i++) {
  const flag = flags[i];
  if (flag === '--harness') opt.harness = true;
  else if (['--harness-migrations', '--harness-scripted', '--harness-barrier'].includes(flag)) {
    const value = flags[++i];
    if (value === undefined) usage(`${flag} needs a value`);
    if (flag === '--harness-migrations') opt.migrations = value;
    else if (flag === '--harness-scripted') opt.scripted = value;
    else {
      const at = value.lastIndexOf('=');
      const action = value.slice(at + 1);
      if (at <= 0 || !['pause', 'kill'].includes(action)) usage(`bad barrier ${value}`);
      opt.barriers.set(value.slice(0, at), { action, state: 'armed', release: null });
    }
  } else usage(`unknown flag ${flag}`);
}
if (!opt.harness && (opt.migrations || opt.scripted || opt.barriers.size > 0)) usage('harness flags need --harness');

const home = process.env.SURETY_HOME;
const paths = {
  config: join(home, 'config.json'),
  lock: join(home, 'engine.lock'),
  token: join(home, 'api.token'),
  store: join(home, 'store.db'),
};
const file = existsSync(paths.config) ? JSON.parse(readFileSync(paths.config, 'utf8')) : {};
const cfg = {};
for (const [key, spec] of Object.entries(CONTRACT.engine)) cfg[key] = key in file ? file[key] : spec.default;
if (!('api_authority' in file)) cfg.api_authority = `127.0.0.1:${cfg.api_port}`;
const policy = {};
for (const [key, spec] of Object.entries(CONTRACT.project)) if (!key.startsWith('$')) policy[key] = spec.default;

// ---- clock, identity ----------------------------------------------------------------

let clockOffset = 0;
const now = () => Date.now() + clockOffset;
const iso = (ms = now()) => new Date(ms).toISOString();
const procStart = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    return null;
  }
};
const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();

// ---- a start that cannot begin (SEAM.md §1, §6) -----------------------------------------

const TOKEN_FORM = /^[\x21-\x7e]{32,}$/;
function readToken() {
  let st;
  try {
    st = lstatSync(paths.token);
  } catch {
    return null;
  }
  const refuse = (reason) => refuseStart(5, 'token_file_refused', reason, { file: 'api.token' });
  if (!st.isFile()) refuse('api.token is not a regular file');
  if ((st.mode & 0o077) !== 0) refuse('api.token is open to group or others');
  const text = readFileSync(paths.token, 'latin1').replace(/\s+$/, '');
  if (!TOKEN_FORM.test(text)) refuse('api.token does not hold a well-formed token');
  return text;
}

let token = readToken();
const isDir = (p) => existsSync(p) && statSync(p).isDirectory();
for (const name of ['engine.lock.guard', 'api.token.tmp']) {
  if (isDir(join(home, name))) refuseStart(6, 'home_unusable', `${name} is a directory`, { path: name });
}
try {
  accessSync(home, constants.W_OK);
} catch {
  refuseStart(6, 'home_unusable', 'the engine home is not writable', { path: '.' });
}
if (existsSync(paths.lock)) {
  const lock = JSON.parse(readFileSync(paths.lock, 'utf8'));
  if (lock.host_boot_id === bootId && procStart(lock.pid) === lock.pid_start_time) {
    refuseStart(3, 'engine_locked', 'another incarnation holds this home', { incarnation_id: lock.incarnation_id });
  }
}
if (token === null) {
  token = randomBytes(32).toString('hex');
  writeFileSync(paths.token, `${token}\n`, { mode: 0o600 });
}
const incarnation = newId('inc_');
const lockRecord = { incarnation_id: incarnation, pid: process.pid, pid_start_time: procStart(process.pid), started_at: iso(Date.now()), host_boot_id: bootId };
writeFileSync(paths.lock, `${JSON.stringify(lockRecord)}\n`, { mode: 0o600 });

const state = { mode: 'restricted', step: 'lock', completed: ['lock'], failed: null };

// ---- store --------------------------------------------------------------------------

let db = null;
const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const exec = (sql, ...p) => db.prepare(sql).run(...p);
const tx = (fn) => db.transaction(fn)();
function insert(table, row) {
  const cols = Object.keys(row);
  exec(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c]));
  return row;
}
const json = (text) => (text === null || text === undefined ? text : JSON.parse(text));

const FIXTURE = { test_fixture: true };
// One-shot `before_event` faults (SEAM.md §7): the transaction about to write
// an event of that type fails after its domain writes and before the event.
const eventFaults = [];
function emit(type, subject, payload = {}, actor = {}) {
  const armed = eventFaults.findIndex((f) => f.event_type === type);
  if (armed >= 0) {
    eventFaults.splice(armed, 1);
    throw new Error(`injected fault before event ${type}`);
  }
  const seq = one('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "events"').n;
  insert('events', {
    id: newId('ev_'),
    created_at: iso(),
    seq,
    at: iso(),
    type,
    subject: JSON.stringify(subject),
    actor_kind: actor.kind ?? 'engine',
    request_id: actor.request_id ?? null,
    payload: JSON.stringify(payload),
    tx: newId('tx_'),
  });
}

const EXTRA_SCHEMA = `
CREATE TABLE IF NOT EXISTS engine_incarnations (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, pid INTEGER NOT NULL, started_at TEXT NOT NULL, host_boot_id TEXT NOT NULL, ended_at TEXT);
CREATE TABLE IF NOT EXISTS schema_migrations (seq INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stages (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, project TEXT NOT NULL, phase_plan TEXT NOT NULL, number INTEGER NOT NULL,
  goal TEXT NOT NULL, modules TEXT NOT NULL, requirement_ids TEXT NOT NULL, implements TEXT NOT NULL, status TEXT NOT NULL, integrated_revision TEXT, work_item TEXT);
`;

// Migrations are only bookkept here: the witness has its own schema. A file
// that is not valid SQL fails as a migration would.
function openStore() {
  const fresh = !existsSync(paths.store);
  db = new Database(paths.store);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  if (fresh) {
    db.exec(readFileSync(join(here, 'witness-schema.sql'), 'utf8'));
    db.exec(readFileSync(join(here, 'witness-slice2.sql'), 'utf8'));
    db.exec('ALTER TABLE projects ADD COLUMN tier TEXT; ALTER TABLE projects ADD COLUMN dev_repo_path TEXT; ALTER TABLE projects ADD COLUMN integration_branch TEXT;');
    db.exec('ALTER TABLE work_items ADD COLUMN continuation TEXT; ALTER TABLE work_items ADD COLUMN pending_repair INTEGER NOT NULL DEFAULT 0;');
    db.exec(EXTRA_SCHEMA);
  }
  const dir = opt.migrations ?? ENGINE_MIGRATIONS;
  const files = readdirSync(dir).filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n)).sort();
  const applied = new Map(all('SELECT * FROM "schema_migrations"').map((r) => [r.name, r.checksum]));
  for (const [name, checksum] of applied) {
    const present = files.includes(name) && createHash('sha256').update(readFileSync(join(dir, name))).digest('hex') === checksum;
    if (!present) throw Object.assign(new Error('checksum'), { code: 'migration_checksum_mismatch', migration: name });
  }
  const scratch = new Database(':memory:');
  for (const name of files) {
    const text = readFileSync(join(dir, name), 'utf8');
    try {
      scratch.exec(text);
    } catch {
      throw Object.assign(new Error('migration'), { code: 'migration_failed', migration: name });
    }
  }
  scratch.close();
  for (const name of files) {
    if (applied.has(name)) continue;
    insert('schema_migrations', { seq: Number(name.slice(0, 4)), name, checksum: createHash('sha256').update(readFileSync(join(dir, name))).digest('hex'), applied_at: iso() });
  }
  insert('engine_incarnations', { id: incarnation, created_at: iso(), pid: process.pid, started_at: lockRecord.started_at, host_boot_id: bootId });
}

// ---- barriers and faults -------------------------------------------------------------

async function barrier(name) {
  const b = opt.barriers.get(name);
  if (!b || b.state !== 'armed') return;
  if (b.action === 'kill') {
    b.state = 'fired';
    process.kill(process.pid, 'SIGKILL');
    await sleep(60_000);
  }
  b.state = 'waiting';
  await new Promise((resolve) => (b.release = resolve));
  b.state = 'released';
}
const faults = [];
function takeFault(step, project) {
  const i = faults.findIndex((f) => f.step === step && f.project === project);
  return i < 0 ? 0 : faults.splice(i, 1)[0].delay_ms;
}

// ---- the scripted boundary (SEAM.md §14) -------------------------------------------------

const qualified = () => opt.harness && opt.scripted !== null;

// The live processes that carry the domain's marker. A process whose
// environment cannot be read is not counted (SEAM.md §14, "What `auto` does
// not see"): every exiting process is unreadable for a moment, the role
// itself included, and so are some lasting processes of the same user.
function members(domain) {
  const marker = `SURETY_DOMAIN=${domain}`;
  const pids = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (readFileSync(`/proc/${name}/environ`, 'utf8').split('\0').includes(marker)) pids.push(Number(name));
    } catch {
      // gone, going, or not ours to read
    }
  }
  return pids;
}

const firstInstruction = new Map();
function observe(domain) {
  if (!qualified()) return 'terminated';
  let instruction = 'auto';
  const boundaryFile = join(opt.scripted, 'boundary.json');
  if (existsSync(boundaryFile)) {
    const b = JSON.parse(readFileSync(boundaryFile, 'utf8'));
    instruction = b.domains?.[domain] ?? b.default ?? 'auto';
  }
  if (mutant('boundary_read_once')) {
    // The defect: the instruction is cached at the first observation.
    if (!firstInstruction.has(domain)) firstInstruction.set(domain, instruction);
    instruction = firstInstruction.get(domain);
  }
  if (instruction !== 'auto') return instruction;
  return members(domain).length > 0 ? 'running' : 'terminated';
}

function signal(domain, name) {
  // Only processes verified as members by their marker are signalled, never a recorded pid.
  for (const pid of members(domain)) {
    try {
      process.kill(pid, name);
    } catch {
      // gone
    }
  }
  if (mutant('signal_recorded_pid')) {
    for (const own of all('SELECT * FROM "process_ownership" WHERE "domain" = ? AND "pid" IS NOT NULL', domain)) {
      try {
        process.kill(own.pid, name);
      } catch {
        // gone
      }
    }
  }
}

// ---- work items ----------------------------------------------------------------------

const WORK_EVENT = { claimed: 'work.claimed', complete: 'work.complete', held: 'work.held', parked: 'work.parked', cancelled: 'work.cancelled', integrated: 'work.integrated' };
const refusal = (status, code, reason, subject = {}) => Object.assign(new Error(reason), { status, code, subject });

function transition(id, to, payload = {}) {
  const item = one('SELECT * FROM "work_items" WHERE "id" = ?', id);
  if (!item) throw refusal(404, 'not_found', 'no such work item');
  let legal = isLegal(item.kind, item.status, to, { continuation: item.continuation ?? undefined });
  if (mutant('review_integrates') && item.kind === 'review' && item.status === 'executing' && to === 'integrating') legal = true;
  if (!legal) {
    const err = refusal(409, 'illegal_transition', `${item.kind}: ${item.status} → ${to} is not a legal transition`, { work_item: id });
    if (mutant('refused_edge_leaves_a_trace')) err.trace = () => db.prepare('UPDATE "work_items" SET "progress_key" = ? WHERE "id" = ?').run(`tried ${to}`, id);
    throw err;
  }
  exec('UPDATE "work_items" SET "status" = ?, "continuation" = ? WHERE "id" = ?', to, to === 'awaiting_decision' ? item.status : item.status === 'awaiting_decision' ? null : item.continuation, id);
  const type = item.status === 'held' && to === 'eligible' ? 'work.resumed' : (WORK_EVENT[to] ?? 'work.advanced');
  emit(type, { work_item: id, project: item.project }, { from: item.status, to, ...payload });
}

function raiseDecision(project, kind, subjectType, subjectId, options, question, blocked = []) {
  const id = newId('dec_');
  insert('decisions', {
    id,
    created_at: iso(),
    project,
    seq: one('SELECT COUNT(*) + 1 AS n FROM "decisions" WHERE "project" = ?', project).n,
    kind,
    subject_type: subjectType,
    subject_id: subjectId,
    semantic_generation: one('SELECT COUNT(*) + 1 AS n FROM "decisions" WHERE "kind" = ? AND "subject_id" = ?', kind, subjectId).n,
    scope: subjectType,
    question,
    options: JSON.stringify(options.map((key) => ({ key, label: key, effect_plan: {}, plan_hash: key, consequence_text: key }))),
    dependency_manifest: '{}',
    transition_schema_version: 1,
    preview_hash: createHash('sha256').update(`${id}:${options.join(',')}`).digest('hex'),
    evidence: '[]',
    blocked_while_open: JSON.stringify({ work_items: blocked }),
    raised_at: iso(),
    status: 'open',
  });
  emit('decision.raised', { decision: id, project });
  return id;
}

function park(id, reason) {
  transition(id, 'parked');
  const item = one('SELECT * FROM "work_items" WHERE "id" = ?', id);
  const decision = raiseDecision(item.project, 'blocker', 'work_item', id, ['retry', 'cancel'], `Work item parked: ${reason}.`, [id]);
  exec('UPDATE "work_items" SET "blocker" = ? WHERE "id" = ?', JSON.stringify({ reason, raised_at: iso(), decision }), id);
}

function observeTrigger(b, label = FIXTURE) {
  const existing = one(
    'SELECT * FROM "work_items" WHERE "project" = ? AND "trigger_source" = ? AND "trigger_id" = ? AND "trigger_generation" = ?',
    b.project,
    b.trigger_source,
    b.trigger_id,
    b.trigger_generation,
  );
  const replay = mutant('trigger_duplicates') && existing && ['complete', 'cancelled'].includes(existing.status);
  if (existing && !replay) return { status: 200, body: { work_item: { id: existing.id }, created: false } };
  if (!(b.kind in WORK.kinds)) throw refusal(400, 'invalid_value', 'not a work kind', { field: 'kind' });
  if (!m1Kinds().includes(b.kind)) throw refusal(501, 'unsupported', `${b.kind} work is outside M1`, { capability: b.kind });
  const id = newId('wi_');
  insert('work_items', {
    id,
    created_at: iso(),
    project: b.project,
    seq: one('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "work_items" WHERE "project" = ?', b.project).n,
    kind: b.kind,
    subject: JSON.stringify(b.subject ?? {}),
    status: 'eligible',
    depends_on: JSON.stringify(b.depends_on ?? []),
    trigger_source: b.trigger_source,
    trigger_id: replay ? `${b.trigger_id}#replayed` : b.trigger_id,
    trigger_generation: b.trigger_generation,
    repair_attempts: 0,
    no_progress_count: 0,
    preflight_refusals: 0,
    dispatch_hold: 0,
  });
  emit('work.created', { work_item: id, project: b.project }, { to: 'eligible', ...label });
  return { status: 201, body: { work_item: { id }, created: true } };
}

// ---- runs: dispatch and launch (SEAM.md §§13, 16) -----------------------------------------------

const ROLE = { stage_build: 'builder', fix: 'builder', verification: 'verifier', review: 'reviewer', replan: 'architect', assessment: 'architect', check_correction: 'verifier' };
const live = new Map(); // run id → what this incarnation knows of it
const runSubject = (r) => ({ run: r.id, project: r.project, work_item: r.work_item });
const getRun = (id) => one('SELECT * FROM "runs" WHERE "id" = ?', id);
const activeRuns = (project) =>
  project === undefined
    ? all(`SELECT * FROM "runs" WHERE "state" <> 'ended'`)
    : all(`SELECT * FROM "runs" WHERE "state" <> 'ended' AND "project" = ?`, project);

function gitDir(project) {
  return one('SELECT * FROM "projects" WHERE "id" = ?', project);
}
// Engine git runs no code from the repository (SEAM.md §16 "Engine git"):
// hooks are switched off on every call, whatever the repository configures.
const NO_REPOSITORY_CODE = ['-c', 'core.hooksPath=/dev/null'];
const git = (repo, args) =>
  execFileSync('git', [...(mutant('hooks_run') ? [] : NO_REPOSITORY_CODE), '--git-dir', join(repo, '.git'), ...args], {
    env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

function journal(project, runId, kind, eventKinds, status = 'succeeded') {
  const op = newId('op_');
  insert('operations', {
    id: op,
    created_at: iso(),
    project,
    seq: one('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "operations" WHERE "project" = ?', project).n,
    kind: 'git_worktree',
    target: '{}',
    subject: '{}',
    idempotency_key: createHash('sha256').update(`${kind}:${runId}`).digest('hex'),
    semantic_generation: 1,
    status,
    deadline_at: iso(now() + 60_000),
    finalized_at: iso(),
  });
  eventKinds.forEach((eventKind, i) =>
    insert('git_journal_events', { id: newId('gje_'), created_at: iso(), project, operation: op, seq: i + 1, journal_kind: kind, event_kind: eventKind, payload: JSON.stringify({ repo: 'dev', run: runId }) }),
  );
}

function selectWork(project) {
  if (project.paused && !mutant('paused_dispatches')) return null;
  const busy = mutant('quarantine_dispatches') ? activeRuns(project.id).filter((r) => !r.quarantined) : activeRuns(project.id);
  if (!mutant('no_one_run_per_project') && busy.length > 0) return null;
  if (activeRuns().length >= cfg.max_concurrent_runs && !mutant('engine_limit_ignored')) return null;
  for (const item of all('SELECT * FROM "work_items" WHERE "project" = ? ORDER BY "seq"', project.id)) {
    const dispatchable = item.status === 'eligible' || (mutant('dispatch_held') && item.status === 'held');
    if (!dispatchable) continue;
    if (item.dispatch_hold && !mutant('ignore_dispatch_hold')) continue;
    if (!m1Kinds().includes(item.kind) && !mutant('excluded_kind_dispatches')) continue;
    const waiting = json(item.depends_on ?? '[]').some((dep) => one('SELECT "status" FROM "work_items" WHERE "id" = ?', dep)?.status !== 'complete');
    if (waiting && !mutant('depends_on_ignored')) continue;
    return item;
  }
  return null;
}

async function dispatch(item) {
  const project = gitDir(item.project);
  const role = ROLE[item.kind] ?? 'builder';
  const prior = one('SELECT * FROM "runs" WHERE "work_item" = ? ORDER BY "seq" DESC LIMIT 1', item.id);
  const id = newId('run_');
  const base = git(project.dev_repo_path, ['rev-parse', `refs/heads/${project.integration_branch}`]);
  tx(() => {
    insert('runs', {
      id,
      created_at: iso(),
      project: item.project,
      seq: one('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "runs" WHERE "project" = ?', item.project).n,
      work_item: item.id,
      role,
      kind: 'one_shot',
      state: 'created',
      backend: 'scripted',
      backend_version: 'witness',
      model_requested: 'scripted',
      base_revision: base,
      deadline_at: iso(now() + policy[`deadline_${role}`] * 1000),
      parent_run: prior && ['stopped', 'timed_out', 'recovered'].includes(prior.outcome) && !mutant('no_parent_link') ? prior.id : null,
      quarantined: 0,
    });
    emit('run.created', { run: id, project: item.project, work_item: item.id });
    if (item.status === 'held') exec(`UPDATE "work_items" SET "status" = 'eligible' WHERE "id" = ?`, item.id); // dispatch_held mutant only
    exec('UPDATE "work_items" SET "prior_status" = ?, "repair_attempts" = "repair_attempts" + "pending_repair", "pending_repair" = 0 WHERE "id" = ?', 'eligible', item.id);
    transition(item.id, 'claimed');
  });
  live.set(id, { spawned: false, child: null, result: undefined, ending: null });
  await barrier('dispatch.run_created');

  const grant = newId('grant_');
  const receipt = newId('inv_');
  const domain = newId('dom_');
  tx(() => {
    insert('capability_grants', { id: grant, created_at: iso(), project: item.project, run: id, capabilities: '[]', env_allowlist: '[]', issued_at: iso(), expires_at: iso(now() + 3_600_000) });
    insert('leases', {
      id: newId('lease_'),
      created_at: iso(),
      resource_kind: 'run',
      resource_id: id,
      owner_incarnation: incarnation,
      generation: 1,
      acquired_at: iso(),
      renewed_at: iso(),
      expires_at: iso(now() + cfg.lease_ttl * 1000),
      closing: 0,
      cleanup_authority: 1,
    });
    insert('invocation_receipts', { id: receipt, created_at: iso(), project: item.project, run: id, provider: 'scripted', model_requested: 'scripted', grant, budget_snapshot: '{}' });
    insert('execution_domains', { id: domain, created_at: iso(), project: item.project, run: id, invocation: receipt, status: 'allocated' });
    insert('process_ownership', { id: newId('proc_'), created_at: iso(), project: item.project, domain, invocation: receipt, incarnation });
    exec(`UPDATE "runs" SET "state" = 'claimed', "grant" = ? WHERE "id" = ?`, grant, id);
    emit('run.claimed', { run: id, project: item.project, work_item: item.id });
  });
  await barrier('dispatch.domain_allocated');
  await barrier('dispatch.receipt_committed');

  const workspace = join(home, 'workspaces', id);
  mkdirSync(join(home, 'workspaces'), { recursive: true });
  git(project.dev_repo_path, ['worktree', 'add', '--detach', workspace, base]);
  if (mutant('worktree_probe_literal_path')) {
    // The defect: the probe looks for the path as given in a list that git
    // prints with symbolic links resolved, and takes a miss for "not added".
    const listed = git(project.dev_repo_path, ['worktree', 'list', '--porcelain']).split('\n').includes(`worktree ${workspace}`);
    if (!listed) {
      tx(() => journal(item.project, id, 'worktree_add', ['intended', 'failed'], 'failed'));
      live.get(id).spawned = false;
      return void endRun(id, 'failed', 'infra_error');
    }
  }
  tx(() => {
    journal(item.project, id, 'worktree_add', ['intended', 'applied', 'confirmed', 'finalized']);
    const ws = newId('ws_');
    insert('workspaces', { id: ws, created_at: iso(), project: item.project, run: id, path: workspace, base_revision: base, current_base: base, disposition: 'active' });
    exec('UPDATE "runs" SET "workspace" = ? WHERE "id" = ?', ws, id);
    insert('invocation_status_observations', { id: newId('iso_'), created_at: iso(), project: item.project, invocation: receipt, seq: 1, status: 'dispatch_started', at: iso() });
  });
  // The spawn is not waited for by the tick.
  launch(id, { receipt, domain, workspace, role }).catch((err) => process.stderr.write(`launch ${id}: ${err.stack}\n`));
}

const closing = (runId) => one(`SELECT COUNT(*) AS n FROM "leases" WHERE "resource_id" = ? AND "resource_kind" = 'run' AND "released_at" IS NULL AND "closing" = 0`, runId).n === 0;
// D1 §8.3: a callback or a renewal is accepted only on an unexpired lease. Expiry is final.
const activeLease = (runId) => one(`SELECT * FROM "leases" WHERE "resource_id" = ? AND "resource_kind" = 'run' AND "released_at" IS NULL AND "closing" = 0`, runId);
const expired = (lease) => !mutant('expired_lease_accepted') && Date.parse(lease.expires_at) <= now();
const renew = (lease) => exec('UPDATE "leases" SET "renewed_at" = ?, "expires_at" = ? WHERE "id" = ?', iso(), iso(now() + cfg.lease_ttl * 1000), lease.id);

// E25 item 1: the engine renews the lease of every run whose live process it
// supervises, at least every third of the lease's lifetime.
function renewSupervised() {
  if (mutant('no_self_renewal')) return;
  for (const [id, known] of live) {
    if (!known.child || known.child.exitCode !== null || known.child.signalCode !== null) continue;
    const lease = activeLease(id);
    if (!lease || expired(lease)) continue;
    if (now() - Date.parse(lease.renewed_at) >= (cfg.lease_ttl * 1000) / 3) renew(lease);
  }
}
const appendStatus = (project, receipt, status) =>
  insert('invocation_status_observations', {
    id: newId('iso_'),
    created_at: iso(),
    project,
    invocation: receipt,
    seq: one('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "invocation_status_observations" WHERE "invocation" = ?', receipt).n,
    status,
    at: iso(),
  });

async function launch(id, { receipt, domain, workspace, role }) {
  const known = live.get(id);
  await barrier('launch.before_spawn');
  const r = getRun(id);
  if ((r.state !== 'claimed' || closing(id)) && !mutant('spawn_after_stop')) return; // stopped or abandoned while it waited
  if (!qualified()) return void endRun(id, 'refused', 'preflight_refused');

  const child = spawn(process.execPath, [join(opt.scripted, 'child.mjs')], {
    cwd: workspace,
    detached: true,
    env: { PATH: process.env.PATH, SURETY_DOMAIN: domain, SURETY_INVOCATION: receipt, ...(mutant('env_inherited') ? { SURETY_HOME: home } : {}) },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  if (mutant('launch_twice')) {
    const twin = spawn(process.execPath, [join(opt.scripted, 'child.mjs')], { cwd: workspace, detached: true, env: { PATH: process.env.PATH, SURETY_DOMAIN: domain, SURETY_INVOCATION: receipt }, stdio: ['pipe', 'ignore', 'ignore'] });
    twin.stdin.on('error', () => {});
    twin.stdin.end(`${JSON.stringify({ invocation: receipt, domain, run: id, project: r.project, work_item: r.work_item, work_kind: 'verification', role, workspace })}\n`);
  }
  known.spawned = true;
  known.child = child;
  child.stdin.on('error', () => {});
  const work = one('SELECT * FROM "work_items" WHERE "id" = ?', r.work_item);
  child.stdin.end(`${JSON.stringify({ invocation: receipt, domain, run: id, project: r.project, work_item: r.work_item, work_kind: work.kind, role, workspace })}\n`);
  await barrier('launch.before_ownership');
  tx(() => {
    exec('UPDATE "process_ownership" SET "pid" = ?, "pgid" = ?, "pid_start_time" = ? WHERE "domain" = ?', child.pid, child.pid, procStart(child.pid), domain);
    appendStatus(r.project, receipt, 'launched');
    exec(`UPDATE "execution_domains" SET "status" = 'launched' WHERE "id" = ?`, domain);
    if (getRun(id).state === 'claimed') {
      exec(`UPDATE "runs" SET "state" = 'executing', "started_at" = ? WHERE "id" = ?`, iso(), id);
      emit('run.started', runSubject(r));
      transition(r.work_item, 'executing');
    }
  });

  let buffer = '';
  let chain = Promise.resolve();
  const onLine = async (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.type === 'heartbeat') {
      const lease = activeLease(id);
      if (lease && !expired(lease)) renew(lease);
    } else if (message.type === 'usage') {
      insert('usage_observations', {
        id: newId('uo_'),
        created_at: iso(),
        project: r.project,
        invocation: receipt,
        seq: one('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "usage_observations" WHERE "invocation" = ?', receipt).n,
        semantics: message.semantics,
        raw: JSON.stringify(message.raw),
        at: iso(),
      });
    } else if (message.type === 'result') {
      const lease = activeLease(id);
      const fenced = closing(id) || getRun(id).state !== 'executing' || !lease || (expired(lease) && !mutant('expired_result_accepted'));
      if (known.result !== undefined || (fenced && !mutant('late_success_completes'))) return;
      known.result = message.result;
      if (validResult(message.result)) await barrier('run.result_received');
      if (fenced && mutant('late_success_completes')) {
        // The defect: a success that arrives after the lease closed still completes the work.
        const item = one('SELECT * FROM "work_items" WHERE "id" = ?', r.work_item);
        if (item.status === 'executing') transition(r.work_item, 'complete');
      }
    }
  };
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) chain = chain.then(() => onLine(line));
  });
  // The run-end protocol begins when the role exits. What the role wrote
  // before it went is read first; the end of the stream is not waited for,
  // because a descendant that inherited it can hold it open for ever.
  const closed = new Promise((resolve) => child.stdout.once('close', resolve));
  child.on('exit', async () => {
    await (mutant('waits_for_stdout_eof') ? closed : Promise.race([closed, sleep(150)]));
    chain.then(() => {
      if (getRun(id).outcome !== null) return; // already ending for another reason
      endRun(id, ...outcomeOf(known));
    });
  });
}

// What a role that has exited earned (SEAM.md §13); a role that has not
// exited earned nothing yet.
function outcomeOf(known) {
  const exited = known?.child && (known.child.exitCode !== null || known.child.signalCode !== null);
  if (!exited || known.result === undefined) return ['failed', 'infra_error'];
  if (!validResult(known.result)) return ['failed', 'invalid_result'];
  return known.child.exitCode === 0 ? ['completed', 'none'] : ['failed', 'infra_error'];
}

const validResult = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && v.status === 'completed' && typeof v.summary === 'string';

// ---- the run-end protocol (D1 §4.5; SEAM.md §16) ---------------------------------------------

function endRun(id, outcome, reason, { recovery = false } = {}) {
  const known = live.get(id) ?? { spawned: null, child: null, result: undefined, ending: null };
  live.set(id, known);
  if (known.ending) return known.ending;
  known.ending = (async () => {
    const r = getRun(id);
    if (r.state === 'ended') return;
    tx(() => {
      if (r.outcome === null || (recovery && mutant('recovery_overwrites_outcome'))) {
        exec('UPDATE "runs" SET "outcome" = ?, "reason_class" = ? WHERE "id" = ?', outcome, reason, id);
      }
      if (r.state !== 'finalizing') {
        exec(`UPDATE "runs" SET "state" = 'finalizing' WHERE "id" = ?`, id);
        emit('run.finalizing', runSubject(r));
      }
      exec(`UPDATE "leases" SET "closing" = 1 WHERE "resource_id" = ? AND "released_at" IS NULL`, id);
    });
    if (getRun(id).outcome === 'abandoned' && mutant('discard_before_termination')) discardWorkspace(getRun(id));
    const terminated = await establishTermination(id, known, recovery);
    if (!terminated) return void quarantine(id);
    await finishRun(id, known, recovery);
  })().catch((err) => {
    known.failed = true; // nothing retries here; the tick reconciles the lease once it has expired
    process.stderr.write(`endRun ${id}: ${err.stack}\n`);
  });
  return known.ending;
}

// D1 §8.1 step 1: a run lease past its expiry is reconciled through the
// run-end protocol, whether or not this engine is still alive and supervising.
async function reconcileExpiredLeases() {
  if (mutant('expired_lease_not_reconciled')) return;
  for (const lease of all(`SELECT * FROM "leases" WHERE "resource_kind" = 'run' AND "released_at" IS NULL`)) {
    if (Date.parse(lease.expires_at) > now()) continue;
    const r = getRun(lease.resource_id);
    if (!r || r.state === 'ended' || r.quarantined) continue;
    const known = live.get(r.id);
    if (known?.ending && !known.failed) continue; // its end is under way
    if (known) {
      known.ending = null;
      known.failed = false;
    }
    await endRun(r.id, ...(r.outcome !== null ? [r.outcome, r.reason_class] : outcomeOf(known)));
  }
}

// True when every domain of the run is terminated. Also records, for a
// domain whose spawn this incarnation cannot vouch for, whether a member was seen.
async function establishTermination(id, known, recovery) {
  for (const d of all(`SELECT * FROM "execution_domains" WHERE "run" = ? AND "status" <> 'terminated'`, id)) {
    if (known.spawned === false && !recovery) {
      markTerminated(d);
      continue;
    }
    if (mutant('parent_exit_is_termination') && known.child && known.child.exitCode !== null) {
      markTerminated(d);
      continue;
    }
    if (mutant('stop_ends_before_termination') && getRun(id).outcome === 'stopped') {
      signal(d.id, 'SIGKILL');
      markTerminated(d);
      continue;
    }
    if (mutant('timeout_ignores_boundary') && getRun(id).outcome === 'timed_out') {
      signal(d.id, 'SIGKILL');
      markTerminated(d);
      continue;
    }
    const started = Date.now();
    let killed = false;
    let done = false;
    if (members(d.id).length > 0) known.memberSeen = true;
    signal(d.id, 'SIGTERM');
    for (;;) {
      const report = observe(d.id);
      if (report === 'terminated') {
        done = true;
        break;
      }
      if (report === 'unknown' && mutant('unknown_is_terminated')) {
        done = true;
        break;
      }
      // An unknown report is acted on when it is made (SEAM.md §14).
      if (report === 'unknown' && !mutant('unknown_waits_for_grace')) break;
      const waited = Date.now() - started;
      if (waited > (cfg.terminate_grace + cfg.kill_grace) * 1000) break;
      if (!killed && waited > cfg.terminate_grace * 1000) {
        killed = true;
        signal(d.id, 'SIGKILL');
      }
      await sleep(200);
    }
    if (!done) return false;
    markTerminated(d);
  }
  return true;
}

function markTerminated(d) {
  tx(() => {
    exec(`UPDATE "execution_domains" SET "status" = 'terminated' WHERE "id" = ?`, d.id);
    exec('UPDATE "process_ownership" SET "termination_confirmed_at" = ? WHERE "domain" = ?', iso(), d.id);
    emit('domain.terminated', { domain: d.id, run: d.run });
  });
}

function quarantine(id) {
  const r = getRun(id);
  if (r.quarantined) return;
  tx(() => {
    exec('UPDATE "runs" SET "quarantined" = 1 WHERE "id" = ?', id);
    emit('run.quarantined', runSubject(r));
    for (const d of all(`SELECT * FROM "execution_domains" WHERE "run" = ? AND "status" <> 'terminated'`, id)) {
      exec(`UPDATE "execution_domains" SET "status" = 'quarantined' WHERE "id" = ?`, d.id);
      emit('domain.quarantined', { domain: d.id, run: id });
    }
    exec(`UPDATE "workspaces" SET "disposition" = 'quarantined' WHERE "run" = ?`, id);
    exec(`UPDATE "leases" SET "released_at" = ? WHERE "resource_id" = ? AND "resource_kind" = 'run' AND "released_at" IS NULL`, iso(), id);
    exec('UPDATE "capability_grants" SET "revoked_at" = ? WHERE "run" = ? AND "revoked_at" IS NULL', iso(), id);
    if (one(`SELECT COUNT(*) AS n FROM "leases" WHERE "resource_id" = ? AND "resource_kind" = 'quarantine' AND "released_at" IS NULL`, id).n === 0) {
      insert('leases', {
        id: newId('lease_'),
        created_at: iso(),
        resource_kind: 'quarantine',
        resource_id: id,
        owner_incarnation: incarnation,
        generation: 1,
        acquired_at: iso(),
        renewed_at: iso(),
        expires_at: iso(now() + 86_400_000),
        closing: 0,
        cleanup_authority: 1,
      });
    }
    if (one(`SELECT COUNT(*) AS n FROM "decisions" WHERE "kind" = 'blocker' AND "subject_id" = ?`, id).n === 0) {
      raiseDecision(r.project, 'blocker', 'run', id, ['acknowledge'], 'Termination of this run could not be established; its domain may still have a writer.', [r.work_item]);
    }
    emit('engine.quarantine', { run: id, project: r.project });
  });
  const known = live.get(id);
  if (known) known.ending = null; // a later observation may finish it
}

function discardWorkspace(r) {
  const ws = one('SELECT * FROM "workspaces" WHERE "run" = ?', r.id);
  if (!ws || ws.disposition === 'discarded') return;
  const project = gitDir(r.project);
  try {
    git(project.dev_repo_path, ['worktree', 'remove', '--force', ws.path]);
  } catch {
    rmSync(ws.path, { recursive: true, force: true });
    git(project.dev_repo_path, ['worktree', 'prune']);
  }
  tx(() => {
    journal(r.project, r.id, 'worktree_remove', ['intended', 'applied', 'confirmed', 'finalized']);
    exec(`UPDATE "workspaces" SET "disposition" = 'discarded', "disposed_at" = ? WHERE "id" = ?`, iso(), ws.id);
  });
}

async function finishRun(id, known, recovery) {
  await barrier('run_end.before_ended');
  const r = getRun(id);
  if (r.outcome === 'abandoned') discardWorkspace(r);
  tx(() => {
    for (const receipt of all('SELECT * FROM "invocation_receipts" WHERE "run" = ?', id)) {
      const statuses = all('SELECT "status" FROM "invocation_status_observations" WHERE "invocation" = ?', receipt.id).map((s) => s.status);
      if (statuses.some((s) => ['ended', 'unknown', 'refused'].includes(s))) continue;
      const started = statuses.includes('dispatch_started');
      const launchedForSure = statuses.includes('launched') || known.spawned === true || known.memberSeen === true;
      // Never launched: this incarnation dispatched it and did not spawn, or
      // the dispatch had not started. Otherwise, launched, or not known.
      const neverLaunched = !launchedForSure && (!started || known.spawned === false);
      appendStatus(r.project, receipt.id, neverLaunched ? 'refused' : launchedForSure ? 'ended' : 'unknown');
      if ((neverLaunched && !mutant('never_launched_charged')) || mutant('no_ledger_row')) continue;
      insert('ledger_rows', {
        id: newId('led_'),
        created_at: iso(),
        project: r.project,
        invocation: receipt.id,
        run: id,
        role: r.role,
        provider: 'scripted',
        model_requested: 'scripted',
        raw_usage: JSON.stringify(all('SELECT "raw" FROM "usage_observations" WHERE "invocation" = ? ORDER BY "seq"', receipt.id).map((u) => json(u.raw))),
        normalization_version: 'witness-0',
        billable_in: mutant('unknown_usage_zero') ? 0 : null,
        usage_complete: 0,
        cost_status: 'unknown',
        day_utc: iso().slice(0, 10),
      });
      emit('ledger.row', { run: id, project: r.project });
    }
    exec(`UPDATE "workspaces" SET "disposition" = 'retained' WHERE "run" = ? AND "disposition" IN ('active', 'quarantined')`, id);
    if (!mutant('grant_not_revoked')) exec('UPDATE "capability_grants" SET "revoked_at" = ? WHERE "run" = ? AND "revoked_at" IS NULL', iso(), id);
    if (mutant('clearance_revives_grant') && r.quarantined) exec('UPDATE "capability_grants" SET "revoked_at" = NULL WHERE "run" = ?', id);
    if (!mutant('lease_not_released')) exec('UPDATE "leases" SET "released_at" = ? WHERE "resource_id" = ? AND "released_at" IS NULL', iso(), id);
    exec(`UPDATE "decisions" SET "status" = 'invalidated', "invalidated_reason" = 'termination observed' WHERE "kind" = 'blocker' AND "subject_id" = ? AND "status" = 'open'`, id);
    exec(`UPDATE "runs" SET "state" = 'ended', "finished_at" = ?, "quarantined" = 0 WHERE "id" = ?`, iso(), id);
    emit('run.ended', runSubject(r), { outcome: r.outcome, ...(recovery && !mutant('recovery_not_recorded') ? { recovery: { incarnation } } : {}) });
    settleWork(r);
  });
}

// What the run's outcome does to its work item (SEAM.md §15, §16).
function settleWork(r) {
  const item = one('SELECT * FROM "work_items" WHERE "id" = ?', r.work_item);
  if (!['claimed', 'executing'].includes(item.status)) return;
  switch (r.outcome) {
    case 'completed':
      if (WORK.kinds[item.kind].path.at(-2) === 'executing') transition(item.id, 'complete');
      break;
    case 'failed':
      if (item.repair_attempts >= policy.repair_attempts_max && !mutant('repair_unbounded')) park(item.id, 'repair_attempts_max');
      else {
        transition(item.id, 'eligible');
        exec('UPDATE "work_items" SET "pending_repair" = 1 WHERE "id" = ?', item.id);
      }
      break;
    case 'refused':
      exec('UPDATE "work_items" SET "preflight_refusals" = "preflight_refusals" + 1 WHERE "id" = ?', item.id);
      if (item.preflight_refusals + 1 >= policy.preflight_refusals_max && !mutant('preflight_unbounded')) park(item.id, 'preflight_refusals_max');
      else transition(item.id, 'eligible');
      break;
    case 'timed_out':
      park(item.id, 'deadline');
      break;
    case 'stopped':
      transition(item.id, 'held');
      break;
    case 'recovered':
      transition(item.id, mutant('replacement_after_recovery') ? 'eligible' : 'held');
      break;
    case 'abandoned':
      transition(item.id, 'eligible');
      if (!mutant('abandon_no_hold')) exec('UPDATE "work_items" SET "dispatch_hold" = 1 WHERE "id" = ?', item.id);
      break;
    default:
  }
}

// A quarantined run is observed again; observed termination clears it (correction 13).
async function reobserveQuarantined() {
  for (const r of all('SELECT * FROM "runs" WHERE "quarantined" = 1')) {
    const domains = all(`SELECT * FROM "execution_domains" WHERE "run" = ? AND "status" = 'quarantined'`, r.id);
    if (!domains.every((d) => observe(d.id) === 'terminated')) continue;
    for (const d of domains) markTerminated(d);
    const known = live.get(r.id) ?? { spawned: null, child: null, result: undefined, ending: null };
    live.set(r.id, known);
    await finishRun(r.id, known, false);
  }
}

// ---- recovery at startup (D1 §16.1; SEAM.md §16) -----------------------------------------------------

async function recover() {
  if (mutant('restart_forgets_quarantine')) {
    // The defect: a restart takes a quarantined domain to be empty.
    for (const r of all('SELECT * FROM "runs" WHERE "quarantined" = 1')) {
      for (const d of all(`SELECT * FROM "execution_domains" WHERE "run" = ? AND "status" = 'quarantined'`, r.id)) markTerminated(d);
      await finishRun(r.id, { spawned: null }, false);
    }
  }
  await reobserveQuarantined();
  for (const r of all(`SELECT * FROM "runs" WHERE "state" <> 'ended' AND "quarantined" = 0 ORDER BY "seq"`)) {
    if (mutant('signal_recorded_pid')) for (const d of all('SELECT * FROM "execution_domains" WHERE "run" = ?', r.id)) signal(d.id, 'SIGKILL');
    await endRun(r.id, 'recovered', 'recovered', { recovery: true });
  }
}

// ---- the tick (D1 §8.1; SEAM.md §15) ----------------------------------------------------------------

let ticking = false;
let tickAgain = false;
async function tick() {
  if (ticking) return void (tickAgain = true);
  ticking = true;
  const started = Date.now();
  try {
    await reobserveQuarantined();
    await reconcileExpiredLeases();
    if (mutant('cleanup_repeats')) {
      // The defect: every tick finalizes ended runs again.
      for (const receipt of all(`SELECT i.* FROM "invocation_receipts" i JOIN "runs" r ON r."id" = i."run" WHERE r."state" = 'ended' AND r."outcome" = 'stopped'`)) {
        appendStatus(receipt.project, receipt.id, 'ended');
      }
    }
    checkDeadlines();
    const projects = all('SELECT * FROM "projects" ORDER BY "id"');
    const suppressed = new Set();
    for (const p of projects) {
      for (const step of ['recover', 'journal']) {
        const delay = takeFault(step, p.id);
        if (delay === 0) continue;
        const budget = cfg.tick_step_budget * 1000;
        if (delay > budget && !mutant('late_step_dispatches')) {
          suppressed.add(p.id);
          await sleep(budget);
        } else await sleep(Math.min(delay, budget));
      }
    }
    for (const p of projects) {
      if (Date.now() - started > cfg.tick_budget * 1000 && !mutant('tick_budget_ignored')) break;
      if (suppressed.has(p.id)) continue;
      const item = selectWork(one('SELECT * FROM "projects" WHERE "id" = ?', p.id));
      if (item) await dispatch(item);
    }
  } catch (err) {
    process.stderr.write(`tick: ${err.stack}\n`);
  } finally {
    emit('engine.tick', {});
    ticking = false;
    if (tickAgain) {
      tickAgain = false;
      setImmediate(tick);
    }
  }
}

function checkDeadlines() {
  for (const r of all(`SELECT * FROM "runs" WHERE "state" IN ('claimed', 'executing') AND "outcome" IS NULL`)) {
    if (Date.parse(r.deadline_at) < now()) endRun(r.id, 'timed_out', 'deadline');
  }
}

// ---- the API (SEAM.md §§6, 7, 15, 17, 18) ---------------------------------------------------------------

const decisionFor = (kind, runId) => one(`SELECT * FROM "decisions" WHERE "kind" = ? AND "subject_id" = ? AND "status" = 'open'`, kind, runId);

function confirmCommand(project, runId, kind, outcome, reason, body) {
  const r = getRun(runId);
  if (!r || r.project !== project) throw refusal(404, 'not_found', 'no such run in this project');
  if (r.state === 'ended' || r.state === 'finalizing') throw refusal(409, 'illegal_transition', `run is ${r.state}`);
  let decision = decisionFor(kind, runId);
  if (body.preview_hash === undefined && !mutant('stop_without_confirm')) {
    if (!decision) {
      raiseDecision(project, kind, 'run', runId, ['confirm'], `Confirm ${kind} of run ${runId}.`);
      decision = decisionFor(kind, runId);
    }
    throw refusal(409, 'confirm_required', 'This needs a confirmation.', { decision: decision.id, preview_hash: decision.preview_hash });
  }
  if (!mutant('stop_without_confirm')) {
    if (!decision || decision.preview_hash !== body.preview_hash) throw refusal(409, 'decision_stale', 'The preview hash is not the open decision\'s.');
    exec(`UPDATE "decisions" SET "status" = 'consumed', "consumed_at" = ? WHERE "id" = ?`, iso(), decision.id);
  }
  // The lease is closing before the request is answered.
  exec(`UPDATE "leases" SET "closing" = 1 WHERE "resource_id" = ? AND "released_at" IS NULL`, runId);
  endRun(runId, outcome, reason);
  return { status: 200, body: { run: { id: runId } } };
}

function answer(project, decisionId, body) {
  const d = one('SELECT * FROM "decisions" WHERE "id" = ? AND "project" = ?', decisionId, project);
  if (!d) throw refusal(404, 'not_found', 'no such decision');
  if (d.status !== 'open') throw refusal(409, 'decision_consumed', 'The decision is not open.');
  if (d.preview_hash !== body.preview_hash) throw refusal(409, 'decision_stale', 'The preview hash differs.');
  if (!json(d.options).some((o) => o.key === body.option)) throw refusal(400, 'invalid_value', 'not an option', { field: 'option' });
  tx(() => {
    exec(`UPDATE "decisions" SET "status" = 'consumed', "consumed_at" = ?, "answer" = ? WHERE "id" = ?`, iso(), JSON.stringify({ option: body.option }), d.id);
    if (d.subject_type === 'work_item' && body.option === 'retry') {
      transition(d.subject_id, 'eligible');
      exec('UPDATE "work_items" SET "blocker" = NULL, "repair_attempts" = 0, "preflight_refusals" = 0, "pending_repair" = 0 WHERE "id" = ?', d.subject_id);
    } else if (d.subject_type === 'work_item' && body.option === 'cancel') {
      transition(d.subject_id, 'cancelled');
      exec('UPDATE "work_items" SET "blocker" = NULL WHERE "id" = ?', d.subject_id);
    } else if (body.option === 'acknowledge' && mutant('acknowledge_clears_quarantine')) {
      for (const dom of all(`SELECT * FROM "execution_domains" WHERE "run" = ? AND "status" = 'quarantined'`, d.subject_id)) markTerminated(dom);
      finishRun(d.subject_id, live.get(d.subject_id) ?? { spawned: null }, false);
    }
  });
  return { status: 200, body: { decision: { id: d.id, status: 'consumed' } } };
}

const PUBLIC_CODE = { preflight_refused: 'backend_refused', budget: 'budget_exhausted', diff_violation: 'diff_violation', ref_violation: 'ref_violation', invalid_result: 'invalid_result', integration_conflict: 'integration_conflict' };

async function route(method, path, body, requestId) {
  const s = path.split('/').slice(1);
  const get = method === 'GET';
  const post = method === 'POST';
  if (s[0] !== 'v1') throw refusal(404, 'not_found', 'no such route');
  const harnessRoute = s[1] === 'harness';
  if (harnessRoute && !opt.harness) throw refusal(404, 'not_found', 'no such route');

  if (get && path === '/v1/health') return { status: 200, body: { mode: state.mode } };
  if (get && path === '/v1/engine') {
    const config = {};
    for (const key of Object.keys(CONTRACT.engine)) config[key] = { value: cfg[key], source: key in file ? 'file' : 'default' };
    return {
      status: 200,
      body: { version: 'witness', incarnation, mode: state.mode, harness: opt.harness, backends: qualified() ? ['scripted'] : [], config, startup: { step: state.step, completed: [...state.completed], failed: state.failed } },
    };
  }
  if (harnessRoute && s[2] === 'barriers') {
    const list = () => [...opt.barriers].map(([name, b]) => ({ name, action: b.action, state: b.state }));
    if (get) return { status: 200, body: { barriers: list() } };
    const b = opt.barriers.get(decodeURIComponent(s[3]));
    if (!b || b.state !== 'waiting') throw refusal(409, 'illegal_transition', 'not a waiting barrier');
    b.release();
    return { status: 200, body: { barriers: list() } };
  }
  if (state.mode !== 'full') throw refusal(503, 'engine_starting', `restricted at ${state.step}`, { step: state.step });

  if (harnessRoute && post) {
    if (path === '/v1/harness/fixtures/project') {
      const id = newId('proj_');
      insert('projects', { id, created_at: iso(), name: body.name, paused: 0, tier: body.tier, dev_repo_path: body.dev_repo_path, integration_branch: body.integration_branch });
      emit('project.created', { project: id }, { ...FIXTURE, ...body });
      return { status: 201, body: { project: { id } } };
    }
    if (path === '/v1/harness/fixtures/trigger') return tx(() => observeTrigger(body));
    if (path === '/v1/harness/fixtures/plan') {
      return tx(() => {
        const plan = newId('plan_');
        const stages = body.stages.map((st) => ({ ...st, id: newId('stage_') }));
        const out = [];
        for (const st of stages) {
          const dependsOn = (st.depends_on ?? []).map((n) => out.find((o) => o.number === n).work_item);
          const made = observeTrigger({ project: body.project, kind: 'stage_build', trigger_source: 'plan', trigger_id: st.id, trigger_generation: 1, subject: { stage: st.id }, depends_on: dependsOn });
          insert('stages', { id: st.id, created_at: iso(), project: body.project, phase_plan: plan, number: st.number, goal: st.goal, modules: '[]', requirement_ids: '[]', implements: '[]', status: 'planned', work_item: made.body.work_item.id });
          out.push({ id: st.id, number: st.number, work_item: made.body.work_item.id });
        }
        return { status: 201, body: { plan: { id: plan }, stages: out } };
      });
    }
    if (s[2] === 'work' && s[4] === 'transition') {
      try {
        tx(() => transition(s[3], body.to, FIXTURE));
      } catch (err) {
        err.trace?.();
        throw err;
      }
      return { status: 200, body: { work_item: { id: s[3], status: body.to } } };
    }
    if (path === '/v1/harness/allocate') {
      if (!getRun(body.run)) throw refusal(404, 'not_found', 'no such run');
      const receipt = one('SELECT "id" FROM "invocation_receipts" WHERE "run" = ? AND "turn" IS NULL', body.run);
      return { status: 200, body: { invocation: mutant('allocate_new_receipt') ? newId('inv_') : receipt.id } };
    }
    if (path === '/v1/harness/clock/advance') {
      clockOffset += body.seconds * 1000;
      checkDeadlines();
      return { status: 200, body: { now: iso() } };
    }
    if (path === '/v1/harness/faults') {
      if (body.point === 'tick_step') faults.push(body);
      else if (body.point === 'before_event') eventFaults.push(body);
      return { status: 200, body: { armed: body } };
    }
  }

  if (s[1] === 'projects' && s.length >= 4) {
    const project = s[2];
    if (!one('SELECT 1 FROM "projects" WHERE "id" = ?', project)) throw refusal(404, 'not_found', 'no such project', { project });
    if (post && s.length === 4 && (s[3] === 'pause' || s[3] === 'resume')) {
      const want = s[3] === 'pause' ? 1 : 0;
      if (one('SELECT "paused" FROM "projects" WHERE "id" = ?', project).paused !== want) {
        exec('UPDATE "projects" SET "paused" = ? WHERE "id" = ?', want, project);
        emit(want ? 'project.paused' : 'project.resumed', { project });
      }
      return { status: 200, body: { project: { id: project, paused: want === 1 } } };
    }
    if (post && s.length === 4 && s[3] === 'tick') {
      setImmediate(tick);
      return { status: 202, body: {} };
    }
    if (post && s[3] === 'runs' && s[5] === 'stop') return confirmCommand(project, s[4], 'stop_confirm', 'stopped', 'human_stop', body);
    if (post && s[3] === 'runs' && s[5] === 'abandon') return confirmCommand(project, s[4], 'abandon_confirm', 'abandoned', 'human_abandon', body);
    if (get && s[3] === 'runs' && s.length === 5) {
      const r = getRun(s[4]);
      if (!r || r.project !== project) throw refusal(404, 'not_found', 'no such run in this project');
      return { status: 200, body: { run: { ...r, code: PUBLIC_CODE[r.reason_class] ?? null } } };
    }
    if (post && s[3] === 'work' && (s[5] === 'resume' || s[5] === 'cancel')) {
      const item = one('SELECT * FROM "work_items" WHERE "id" = ? AND "project" = ?', s[4], project);
      if (!item) throw refusal(404, 'not_found', 'no such work item');
      tx(() => {
        if (s[5] === 'cancel') transition(item.id, 'cancelled');
        else if (item.status === 'held') transition(item.id, 'eligible');
        else if (!(item.status === 'eligible' && item.dispatch_hold)) throw refusal(409, 'illegal_transition', 'the item is neither held nor on dispatch hold');
        if (s[5] === 'resume') exec('UPDATE "work_items" SET "dispatch_hold" = 0 WHERE "id" = ?', item.id);
        // Lifting a dispatch hold changes no status and is still an event, written with the change (SEAM.md §15).
        if (s[5] === 'resume' && item.status === 'eligible' && !mutant('resume_hold_no_event')) {
          emit('work.resumed', { work_item: item.id, project }, { from: 'eligible', to: 'eligible' }, { kind: 'human', request_id: requestId });
        }
      });
      return { status: 200, body: { work_item: { id: item.id } } };
    }
    if (post && s[3] === 'decisions' && s[5] === 'answer') return answer(project, s[4], body);
  }
  throw refusal(404, 'not_found', 'no such route', { path });
}

function createServer() {
  const server = http.createServer();
  const handle = async (req, res, oddExpect, wantsContinue = false) => {
    const requestId = newId('req_');
    const path = (req.url ?? '').split('?')[0].replace(/^http:\/\/[^/]*/i, '');
    const send = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json', 'x-surety-request-id': requestId, connection: 'close' });
      res.end(JSON.stringify(value));
    };
    const fail = (err) => send(err.status ?? 500, { code: err.code ?? 'store_error', reason: err.message, what_to_do: 'See SEAM.md.', subject: err.subject ?? {} });
    const hosts = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === 'host') hosts.push(req.rawHeaders[i + 1]);
    const target = /^http:\/\/([^/]*)/i.exec(req.url ?? '');
    if (hosts.length !== 1 || hosts[0] !== cfg.api_authority || (target && target[1] !== cfg.api_authority)) return fail(refusal(400, 'host_refused', 'not this engine'));
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    const audited = mutating && state.mode === 'full' && !path.startsWith('/v1/harness/');
    const finish = (status, value) => {
      if (audited) emit('api.act', {}, { method: req.method, path, status }, { kind: 'human', request_id: requestId });
      send(status, value);
    };
    const refuse = (err) => {
      if (audited) emit('api.act', {}, { method: req.method, path, status: err.status ?? 500 }, { kind: 'human', request_id: requestId });
      fail(err);
    };
    const given = req.headers['x-surety-token'];
    if (given === undefined) return refuse(refusal(401, 'token_required', 'no token'));
    if (given !== token) return refuse(refusal(401, 'token_invalid', 'wrong token'));
    if (oddExpect) return refuse(refusal(417, 'expect_refused', 'this engine answers only 100-continue', { expect: req.headers.expect }));
    if (wantsContinue) res.writeContinue();
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const reply = await route(req.method, path, text.trim() === '' ? {} : JSON.parse(text), requestId);
        finish(reply.status, reply.body);
      } catch (err) {
        if (err.status === undefined) process.stderr.write(`route ${req.method} ${path}: ${err.stack}\n`);
        refuse(err);
      }
    });
  };
  server.on('request', (req, res) => handle(req, res, false));
  server.on('checkExpectation', (req, res) => handle(req, res, true));
  server.on('checkContinue', (req, res) => handle(req, res, false, true));
  return server;
}

// ---- startup (D1 §1.4) -----------------------------------------------------------------

state.step = 'listen';
const server = createServer();
await new Promise((resolve) => {
  server.once('error', () => refuseStart(6, 'listen_failed', `cannot listen on port ${cfg.api_port}`, { port: cfg.api_port }));
  server.listen(cfg.api_port, '127.0.0.1', resolve);
});
state.completed.push('listen');
process.on('SIGTERM', () => process.exit(0));

state.step = 'store';
try {
  openStore();
  state.completed.push('store');
} catch (err) {
  state.failed = { step: 'store', code: err.code?.startsWith?.('migration') ? err.code : 'store_error', reason: err.message, subject: err.migration ? { migration: err.migration } : {} };
}

if (state.failed === null) {
  const lift = () => {
    state.step = 'full';
    emit('engine.mode_changed', { incarnation }, { from: 'restricted', to: 'full' });
    state.mode = 'full';
    state.completed.push('full');
  };
  state.step = 'recovery';
  if (mutant('recovery_after_full')) {
    state.completed.push('recovery', 'integrity');
    lift();
    await recover();
  } else {
    await recover();
    state.completed.push('recovery');
    state.step = 'integrity';
    state.completed.push('integrity');
    lift();
  }
  state.step = 'scheduler';
  emit('engine.started', { incarnation });
  state.completed.push('scheduler');
  setInterval(tick, cfg.tick_interval * 1000);
  setInterval(checkDeadlines, 500);
  setInterval(renewSupervised, 250);
}
